import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let userCookie: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function login(email: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.file.deleteMany();
  await prisma.priority.deleteMany();
  await prisma.sourceOption.deleteMany();
  await prisma.firmProfile.deleteMany();

  await prisma.priority.createMany({
    data: [
      { name: "Low", color: "#6b7280", order: 0 },
      { name: "Normal", color: "#2f4fd6", order: 1, isDefault: true },
      { name: "High", color: "#b5651d", order: 2 },
      { name: "Urgent", color: "#c23434", order: 3 },
    ],
  });
  await prisma.sourceOption.createMany({
    data: [
      { name: "Referral", order: 0 },
      { name: "Website", order: 1 },
    ],
  });
  await prisma.firmProfile.create({ data: { id: 1, name: "buh_crm" } });

  const hash = await argon2.hash("password-123");
  await prisma.user.createMany({
    data: [
      {
        firstName: "Admin",
        lastName: "A",
        email: "admin@s2.local",
        passwordHash: hash,
        role: "admin",
        status: "active",
      },
      {
        firstName: "Plain",
        lastName: "U",
        email: "user@s2.local",
        passwordHash: hash,
        role: "user",
        status: "active",
      },
    ],
  });
  adminCookie = await login("admin@s2.local", "password-123");
  userCookie = await login("user@s2.local", "password-123");
});

afterAll(async () => {
  await app.close();
});

describe("settings", () => {
  it("any authed user can read settings", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: userCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.priorities).toHaveLength(4);
    expect(body.sources).toHaveLength(2);
    expect(body.firm).toMatchObject({ invoicePrefix: "INV", invoiceCounterDigits: 4 });
  });

  it("non-admin cannot mutate settings", async () => {
    const priority = await prisma.priority.findFirstOrThrow({ where: { name: "Low" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/settings/priorities/${priority.id}`,
      headers: { cookie: userCookie },
      payload: { name: "Hacked" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin edits a priority's name and color", async () => {
    const priority = await prisma.priority.findFirstOrThrow({ where: { name: "Low" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/settings/priorities/${priority.id}`,
      headers: { cookie: adminCookie },
      payload: { name: "Minor", color: "#aabbcc" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Minor", color: "#aabbcc" });
  });

  it("setting a new default moves it off the old one", async () => {
    const high = await prisma.priority.findFirstOrThrow({ where: { name: "High" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/settings/priorities/${high.id}`,
      headers: { cookie: adminCookie },
      payload: { isDefault: true },
    });
    expect(res.statusCode).toBe(200);
    const defaults = await prisma.priority.findMany({ where: { isDefault: true } });
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("High");
  });

  it("creates a source, rejects duplicates, deactivates instead of deleting", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/settings/sources",
      headers: { cookie: adminCookie },
      payload: { name: "Event" },
    });
    expect(created.statusCode).toBe(201);
    const source = created.json();
    expect(source.order).toBe(2);

    const dup = await app.inject({
      method: "POST",
      url: "/api/settings/sources",
      headers: { cookie: adminCookie },
      payload: { name: "Event" },
    });
    expect(dup.statusCode).toBe(409);

    const deactivated = await app.inject({
      method: "PATCH",
      url: `/api/settings/sources/${source.id}`,
      headers: { cookie: adminCookie },
      payload: { active: false },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json().active).toBe(false);
    // still present — never deleted
    expect(await prisma.sourceOption.count()).toBe(3);
  });

  it("updates invoice numbering (prefix + digits)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings/firm",
      headers: { cookie: adminCookie },
      payload: { invoicePrefix: "ACC", invoiceCounterDigits: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ invoicePrefix: "ACC", invoiceCounterDigits: 5 });
  });
});
