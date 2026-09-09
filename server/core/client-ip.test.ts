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
