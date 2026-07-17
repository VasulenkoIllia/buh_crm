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
});
