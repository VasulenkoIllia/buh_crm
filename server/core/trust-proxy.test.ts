import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientIp } from "./client-ip.js";
import { loadConfig } from "./config.js";

/**
 * **What `TRUST_PROXY` has to keep true.** The suite never runs with `isProd`, so `trustProxy` is
 * off in every other test, and a setting Fastify stops honouring would go unnoticed: the address on
 * every sign-in becomes Traefik's, the login limit one budget for the whole firm, and the session
 * cookie loses `Secure`. That is what its numeric form did from Fastify 5.12.1 (2026-10-31).
 *
 * The addresses are the production chain: Cloudflare, then Traefik on a private Docker network.
 */
const TRAEFIK = "172.18.0.5";
const EDGE = "104.16.0.1"; // inside Cloudflare's ranges
const CALLER = "203.0.113.7";

const { TRUST_PROXY } = loadConfig({ ...process.env, TRUST_PROXY: undefined });

const app = Fastify({ trustProxy: TRUST_PROXY });
app.get("/who", async (request) => ({
  ip: clientIp(request),
  protocol: request.protocol,
  host: request.host,
}));

async function who(remoteAddress: string, headers: Record<string, string>) {
  const res = await app.inject({ method: "GET", url: "/who", remoteAddress, headers });
  return res.json<{ ip: string; protocol: string; host: string }>();
}

beforeAll(() => app.ready());
afterAll(() => app.close());

describe("the proxy chain, as production sets it", () => {
  const throughCloudflare = {
    host: "app:3000",
    "x-forwarded-for": EDGE,
    "x-forwarded-proto": "https",
    "x-forwarded-host": "crm.example.com",
    "cf-connecting-ip": CALLER,
  };

  it("names the caller, the protocol and the host that came through Traefik", async () => {
    expect(await who(TRAEFIK, throughCloudflare)).toEqual({
      ip: CALLER,
      protocol: "https",
      host: "crm.example.com",
    });
  });

  it("reads a peer written the way a dual-stack socket reports it", async () => {
    expect((await who(`::ffff:${TRAEFIK}`, throughCloudflare)).ip).toBe(CALLER);
  });

  it("believes nothing from a peer that is not the proxy", async () => {
    const stranger = "198.51.100.9";
    expect(await who(stranger, throughCloudflare)).toEqual({
      ip: stranger,
      protocol: "http",
      host: "app:3000",
    });
  });

  it("stops at the edge, however long a chain the caller wrote", async () => {
    const forged = { ...throughCloudflare, "x-forwarded-for": `9.9.9.9, ${EDGE}` };
    expect((await who(TRAEFIK, forged)).ip).toBe(CALLER);
  });
});
