import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientIp, isAddress, isCloudflare } from "./client-ip.js";

/**
 * The addresses in the first block are the ones the owner actually saw in the production activity
 * log on 2026-09-09 — every entry in it was one of these, which is what started this.
 */
describe("recognising Cloudflare", () => {
  it("knows the edges that were being recorded as callers", () => {
    for (const seen of [
      "108.162.237.159",
      "108.162.237.158",
      "172.71.30.128",
      "172.64.200.155",
      "104.22.1.164",
      "104.22.56.20",
      "104.23.245.69",
    ]) {
      expect(isCloudflare(seen), seen).toBe(true);
    }
  });

  it("does not mistake an ordinary address for one", () => {
    for (const ordinary of [
      "8.8.8.8",
      "1.1.1.1",
      "91.202.128.5",
      "192.168.1.10",
      "127.0.0.1",
    ]) {
      expect(isCloudflare(ordinary), ordinary).toBe(false);
    }
  });

  it("gets the edges of a range right, in both directions", () => {
    // 104.16.0.0/13 covers 104.16.0.0 – 104.23.255.255
    expect(isCloudflare("104.16.0.0")).toBe(true);
    expect(isCloudflare("104.23.255.255")).toBe(true);
    expect(isCloudflare("104.15.255.255")).toBe(false);
    // …and 104.24.0.0/14 picks up where it stops
    expect(isCloudflare("104.24.0.0")).toBe(true);
    expect(isCloudflare("104.28.0.0")).toBe(false);
  });

  it("handles IPv6, including how a dual-stack socket reports IPv4", () => {
    expect(isCloudflare("2606:4700::1111")).toBe(true);
    expect(isCloudflare("2a06:98c0::1")).toBe(true);
    expect(isCloudflare("2001:4860:4860::8888")).toBe(false);
    expect(isCloudflare("::ffff:104.22.1.164")).toBe(true);
    expect(isCloudflare("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("what an address is", () => {
  it("accepts real ones and refuses everything else", () => {
    expect(isAddress("91.202.128.5")).toBe(true);
    expect(isAddress("2606:4700::1")).toBe(true);
    expect(isAddress("::1")).toBe(true);
    expect(isAddress("256.1.1.1")).toBe(false);
    expect(isAddress("1.2.3")).toBe(false);
    expect(isAddress("not an address")).toBe(false);
    expect(isAddress("")).toBe(false);
    // the shape a header injection would take
    expect(isAddress("1.2.3.4, 5.6.7.8")).toBe(false);
  });
});

describe("the caller's address", () => {
  const ask = (ip: string, headers: Record<string, string | string[] | undefined> = {}) =>
    clientIp({ ip, headers });

  it("takes Cloudflare's word when Cloudflare is who we are talking to", () => {
    expect(ask("108.162.237.159", { "cf-connecting-ip": "91.202.128.5" })).toBe("91.202.128.5");
  });

  it("ignores the header when the request did NOT come through Cloudflare", () => {
    // somebody reaching the origin directly and choosing what the log says about them
    expect(ask("203.0.113.7", { "cf-connecting-ip": "91.202.128.5" })).toBe("203.0.113.7");
  });

  it("falls back to the peer when the header is missing or is not an address", () => {
    expect(ask("108.162.237.159")).toBe("108.162.237.159");
    expect(ask("108.162.237.159", { "cf-connecting-ip": "" })).toBe("108.162.237.159");
    expect(ask("108.162.237.159", { "cf-connecting-ip": "<script>" })).toBe("108.162.237.159");
    // a list, which is `X-Forwarded-For`'s shape and never this header's
    expect(ask("108.162.237.159", { "cf-connecting-ip": "1.2.3.4, 5.6.7.8" })).toBe(
      "108.162.237.159",
    );
  });

  it("takes the first value if the header somehow arrives twice", () => {
    expect(ask("108.162.237.159", { "cf-connecting-ip": ["91.202.128.5", "1.2.3.4"] })).toBe(
      "91.202.128.5",
    );
  });

  it("keeps working if the ingress is fixed later", () => {
    // once Traefik trusts Cloudflare, `request.ip` IS the caller and is not a Cloudflare address,
    // so this returns it and the header is not consulted — neither fix needs the other
    expect(ask("91.202.128.5", { "cf-connecting-ip": "91.202.128.5" })).toBe("91.202.128.5");
  });

  it("is unchanged in development, where there is no proxy at all", () => {
    expect(ask("127.0.0.1")).toBe("127.0.0.1");
  });
});

/**
 * **Nothing on the server reads the raw address except the resolver.**
 *
 * The first version of this fix rewired the activity log, the session and the rate limiter, and
 * missed the five secret-vault routes — which passed `request.ip` straight into `SecretAuditLog`,
 * the one journal built to answer "who tried to open this client's secrets, and from where". It
 * would have gone on recording Cloudflare's edge after the deploy that was meant to stop that.
 * Found by the pre-deploy review, 2026-09-10; missed because the search for call sites looked in
 * `server/core` and not in the modules. So it is not searched for any more — it is checked.
 */
describe("the one way to read an address", () => {
  it("is `clientIp()` — a raw `request.ip` anywhere else fails", () => {
    const root = new URL("..", import.meta.url).pathname; // server/
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "generated" && name !== "node_modules") walk(path);
          continue;
        }
        if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name) || name === "client-ip.ts")
          continue;
        // comments may talk about `request.ip`; code may not use it
        const code = readFileSync(path, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        code.split("\n").forEach((line, i) => {
          if (/\b(request|req)\.ip\b/.test(line))
            offenders.push(`${path.slice(root.length)}:${i + 1}`);
        });
      }
    };
    walk(root);
    expect(
      offenders,
      "read the address through clientIp(request) — see core/client-ip.ts",
    ).toEqual([]);
  });
});
