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
  // Clear the POINTERS before wiping the sources. This used to happen by itself: the foreign keys
  // were ON DELETE SET NULL, so deleting a source quietly nulled every reference to it. They are
  // RESTRICT now — deliberately — so the teardown has to say what it was relying on. Deleting the
  // clients instead would be wrong twice over: this suite shares a database with the others, and
  // their invoices reference those rows.
  await prisma.lead.updateMany({ data: { sourceId: null } });
  await prisma.client.updateMany({ data: { sourceId: null } });
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

  it("creates a source, rejects duplicates, and deactivating keeps the row", async () => {
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

/**
 * Deleting a source of origin (user, 2026-08-28).
 *
 * Possible only while NOTHING records it. The archive counts — an archived client is a soft delete
 * and has to come back with the source they arrived by — and that is the case worth pinning,
 * because it is the one a live-records-only count would get wrong.
 */
describe("settings — deleting a source of origin", () => {
  const makeSource = async (name: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/sources",
      headers: { cookie: adminCookie },
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const del = (id: string, cookie = adminCookie) =>
    app.inject({ method: "DELETE", url: `/api/settings/sources/${id}`, headers: { cookie } });

  it("deletes one nothing records", async () => {
    const id = await makeSource("Unused source");
    expect((await del(id)).statusCode).toBe(200);
    expect(await prisma.sourceOption.findUnique({ where: { id } })).toBeNull();
  });

  it("refuses one a client records, and says how many", async () => {
    const id = await makeSource("Client source");
    await prisma.client.create({ data: { firstName: "Sourced", sourceId: id } });
    const res = await del(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/1 client/);
    // and the source is still there, with the client still pointing at it
    expect(await prisma.sourceOption.findUnique({ where: { id } })).not.toBeNull();
    expect(await prisma.client.count({ where: { sourceId: id } })).toBe(1);
  });

  it("refuses one a lead records", async () => {
    const id = await makeSource("Lead source");
    await prisma.lead.create({ data: { name: "Sourced lead", sourceId: id } });
    const res = await del(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/1 lead/);
  });

  it("refuses one only an ARCHIVED client records — they can be restored", async () => {
    const id = await makeSource("Archived source");
    await prisma.client.create({
      data: { firstName: "Gone", sourceId: id, archivedAt: new Date() },
    });
    const res = await del(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/archived included/);
  });

  it("is refused to a non-admin", async () => {
    const id = await makeSource("Not yours");
    expect((await del(id, userCookie)).statusCode).toBe(403);
    expect(await prisma.sourceOption.findUnique({ where: { id } })).not.toBeNull();
  });

  it("404s for a source that is not there", async () => {
    const res = await del("00000000-0000-4000-8000-000000000000");
    expect(res.statusCode).toBe(404);
  });

  // this suite is the only one that creates clients and leads purely to hold a source; take them
  // away again rather than leaving them for the next run to trip over
  afterAll(async () => {
    await prisma.lead.deleteMany({ where: { name: { in: ["Sourced lead"] } } });
    await prisma.client.deleteMany({ where: { firstName: { in: ["Sourced", "Gone"] } } });
  });
});
