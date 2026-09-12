/**
 * **Time-based one-time codes, RFC 6238 — the second factor** (docs/modules/two-factor.md §4).
 *
 * Written here rather than taken from a library: HMAC-SHA1 and base32 are a few dozen lines on
 * `node:crypto`, the RFC's own test vectors pin them (`totp.test.ts`), and the two rules that make a
 * code safe to accept — the drift window and single use — are ours whichever library computes the
 * digits. Nothing in this file knows about users or storage, so the client portal's second step
 * calls it rather than copying it (§4.2).
 *
 * SHA-1, six digits, thirty seconds: not a preference but what every authenticator app actually
 * implements. SHA-1's collision weakness does not reach HMAC.
 */
import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./secrets-crypto.js";

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
/**
 * ±1 step either side — about ninety seconds of usable codes. Phone clocks drift and this is the
 * standard trade; wider is a measurable weakening, and the sort of number that gets widened during a
 * support call and never narrowed again. `totp.test.ts` holds the boundary: one step ago accepted,
 * two refused.
 */
const TOTP_WINDOW = 1;
/** 160 bits — RFC 4226's recommended secret length, and what authenticator apps expect. */
const SECRET_BYTES = 20;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** RFC 4648 base32, unpadded — the form `otpauth://` URIs and typed-in keys use. */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerates lower case, spaces, dashes and padding — what a person copying a key by hand produces. */
export function base32Decode(input: string): Buffer {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of input.toUpperCase().replace(/[\s=-]/g, "")) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error("not a base32 string");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/** The key in groups of four, for a person to type into an app that cannot scan. */
export function formatSecret(base32: string): string {
  return base32.replace(/(.{4})/g, "$1 ").trim();
}

/** RFC 4226: HMAC-SHA1 of the counter, dynamically truncated to `digits`. */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Which thirty-second step an instant falls in. */
export function stepAt(ms: number): number {
  return Math.floor(ms / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The step a six-digit code belongs to — if it is inside the window AND later than the last one
 * accepted — or null.
 *
 * Every step in the window is computed and compared whatever happens, in constant time, so the time
 * taken does not say how close a guess came. The caller must still record the returned step with a
 * CONDITIONAL write (`… WHERE lastStep < :step`): this function can say a code is fresh, only the
 * database can say nobody else spent it in the meantime.
 */
export function matchStep(
  key: Uint8Array,
  code: string,
  nowMs: number,
  lastStep: number | null,
): number | null {
  const typed = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(typed)) return null;
  const current = stepAt(nowMs);
  let found: number | null = null;
  for (let step = current + TOTP_WINDOW; step >= current - TOTP_WINDOW; step--) {
    const matches = safeEqual(hotp(key, step), typed);
    if (matches && found === null && (lastStep === null || step > lastStep)) found = step;
  }
  return found;
}

/**
 * The provisioning URI an authenticator app scans (Google's `Key Uri Format`). The label reads
 * "Firm: person@firm" in the app's list, so somebody with several accounts can tell them apart.
 */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const issuer = encodeURIComponent(input.issuer);
  const label = `${issuer}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
