/**
 * **Who actually made this request.**
 *
 * The origin sits behind two proxies — Cloudflare, then Traefik — and until 2026-09-09 every
 * address the product stored was Cloudflare's. Found by reading the activity log on production:
 * `108.162.237.159`, `172.71.30.128`, `104.22.1.164`, all inside Cloudflare's published ranges, on
 * a screen whose whole point is "who did this, and from where".
 *
 * **Why `TRUST_PROXY_HOPS` cannot fix it.** Fastify counts hops backwards through
 * `X-Forwarded-For`, so it can only return an address that is IN that header. Traefik does not
 * trust the `X-Forwarded-For` it receives unless its entrypoint names the sender in
 * `forwardedHeaders.trustedIPs`, and ours does not — so it REPLACES the header with the address it
 * saw, which is the Cloudflare edge. The caller's address never reaches the origin in that header
 * at all, and no hop count can find what is not there.
 *
 * **What does carry it.** Cloudflare sets `CF-Connecting-IP` on every request and overwrites any
 * value a caller supplies, so it is trustworthy exactly when the request really came through
 * Cloudflare — and the symptom above is the proof of that: if the address Fastify resolved is a
 * Cloudflare one, Cloudflare is who we are talking to.
 *
 * That check is also why this keeps working if the ingress is fixed later. Point Traefik's
 * `trustedIPs` at Cloudflare and `request.ip` becomes the caller's own address, which is not in a
 * Cloudflare range, so this falls through and returns it. Neither configuration needs the other.
 *
 * **The threat it closes.** Without the range check, anyone who can reach the origin directly could
 * send `CF-Connecting-IP: 1.2.3.4` and choose what the log records about them. With it, a request
 * that did not come through Cloudflare is answered by its real peer and the header is ignored.
 */

/**
 * Cloudflare's published ranges — https://www.cloudflare.com/ips-v4 and /ips-v6, read 2026-09-09.
 *
 * Hard-coded rather than fetched: a network call at boot is a way for the product to fail to start
 * because somebody else's website is down, and these change perhaps once every few years.
 * `client-ip.test.ts` pins the shape; when Cloudflare publishes a change, this list and that test
 * move together.
 */
const CLOUDFLARE = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/** An address as one number, so a prefix comparison is a shift. `null` when it is not an address. */
function toBits(address: string): { value: bigint; width: 32 | 128 } | null {
  const plain = address
    .trim()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]; // strip brackets, zone id
  // `::ffff:1.2.3.4` — how a dual-stack socket reports an IPv4 peer
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain);
  const candidate = mapped ? mapped[1] : plain;

  if (candidate.includes(".") && !candidate.includes(":")) {
    const parts = candidate.split(".");
    if (parts.length !== 4) return null;
    let value = 0n;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const octet = Number(part);
      if (octet > 255) return null;
      value = (value << 8n) | BigInt(octet);
    }
    return { value, width: 32 };
  }

  if (!candidate.includes(":")) return null;
  const halves = candidate.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(fill).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return { value, width: 128 };
}

/**
 * Each range parsed ONCE, when the module loads. This runs on every request, up to twice, and the
 * first version re-parsed the address and all 22 ranges on every call — 44 parses to answer one
 * yes-or-no (security review, 2026-09-10). A range that does not parse fails at import, which the
 * test suite reaches long before a deploy does.
 */
const RANGES = CLOUDFLARE.map((cidr) => {
  const [network, bits] = cidr.split("/");
  const parsed = toBits(network);
  if (!parsed) throw new Error(`client-ip: unparseable Cloudflare range ${cidr}`);
  const host = BigInt(parsed.width - Number(bits));
  return { width: parsed.width, host, network: parsed.value >> host };
});

/** Whether this address is one of Cloudflare's edges — i.e. whether we are behind it right now. */
export function isCloudflare(address: string): boolean {
  const one = toBits(address);
  if (!one) return false;
  return RANGES.some((r) => r.width === one.width && one.value >> r.host === r.network);
}

/** Digits, hex, colons and dots — every character an address in this header can contain. */
const ADDRESS_ONLY = /^[0-9a-f:.]+$/i;

/**
 * Whether a string is an address and NOTHING ELSE, so a forged header cannot put prose in the column.
 *
 * Checked on the characters first, then on the structure. The first version checked only the
 * structure — of a copy with any IPv6 zone id (`%…`) and brackets cut off — and the caller returned
 * the original, so `1.2.3.4%<anything>` was an "address" and the whole string was stored (security
 * review, 2026-09-10). Cloudflare never sends a zone id or brackets in `CF-Connecting-IP`; one of
 * them means somebody else wrote the header.
 */
export function isAddress(value: string): boolean {
  const trimmed = value.trim();
  return ADDRESS_ONLY.test(trimmed) && toBits(trimmed) !== null;
}

/**
 * The caller's address, for the activity log, the session record and the rate limiter.
 *
 * The rate limiter matters as much as the log here: its key falls back to the address for requests
 * with no session, which is every sign-in attempt. While that address was Cloudflare's, everybody
 * arriving through one Cloudflare edge shared a single login budget — so one caller could spend
 * another's, and a spread-out attempt looked like many callers rather than one.
 */
export function clientIp(request: {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const direct = request.ip;
  if (!isCloudflare(direct)) return direct;
  const claimed = request.headers["cf-connecting-ip"];
  const value = Array.isArray(claimed) ? claimed[0] : claimed;
  return value && isAddress(value) ? value.trim() : direct;
}
