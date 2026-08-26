import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

describe("app", () => {
  it("GET /health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", app: "buh_crm" });
  });

  it("unknown route returns 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects mutating requests from a foreign origin (CSRF)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/health",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  // The dev allowance was widened on 2026-08-26 from two exact ports to any loopback origin,
  // because Vite takes the next free port when 5173 is busy and an exact list then 403s every
  // write while GETs keep working. These pin what that must NOT change.

  it("guards every mutating method, PUT and DELETE included", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: "/health",
        headers: { origin: "https://evil.example.com" },
      });
      expect(res.statusCode, method).toBe(403);
    }
  });

  it("never blocks a read, whatever the origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("keeps the loopback allowance OUT of non-dev — this suite runs as NODE_ENV=test", async () => {
    // the whole point of gating it on `isDev`: outside development a localhost origin is just
    // another cross-origin request, and must be refused like any other
    const res = await app.inject({
      method: "PUT",
      url: "/health",
      headers: { origin: "http://localhost:5174" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows same-origin, and refuses an Origin that is not a URL at all", async () => {
    const same = await app.inject({
      method: "POST",
      url: "/health",
      headers: { origin: "http://localhost:3000", host: "localhost:3000" },
    });
    expect(same.statusCode).not.toBe(403);

    const malformed = await app.inject({
      method: "POST",
      url: "/health",
      headers: { origin: "not-a-url" },
    });
    expect(malformed.statusCode).toBe(403);
  });
});
