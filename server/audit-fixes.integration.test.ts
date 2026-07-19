import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { prisma } from "./core/db.js";
import { testOutbox } from "./core/email.js";

// Regression tests for the 2026-07-19 full-project audit fixes.

let app: Awaited<ReturnType<typeof buildApp>>;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

function tokenFromEmail(html: string): string {
  const match = html.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No token in email: ${html}`);
  return match[1];
}

async function loginAs(email: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

function multipart(filename: string, contentType: string, body: string) {
  const boundary = "----audit-boundary";
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    "",
    body,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.file.deleteMany();
  await prisma.clientPerson.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.user.deleteMany();
  await prisma.priority.deleteMany();
  await prisma.sourceOption.deleteMany();
  await prisma.firmProfile.deleteMany();

  await prisma.user.create({
    data: {
      firstName: "Audit",
      lastName: "Admin",
      email: "audit-admin@test.local",
      passwordHash: await argon2.hash("admin-pass-123"),
      role: "admin",
      status: "active",
      emailConfirmedAt: new Date(),
    },
  });
  await prisma.priority.createMany({
    data: [
      { name: "Low", color: "#6b7280", order: 0 },
      { name: "Normal", color: "#2f4fd6", order: 1, isDefault: true },
      { name: "High", color: "#b5651d", order: 2 },
      { name: "Urgent", color: "#c23434", order: 3 },
    ],
  });
  await prisma.sourceOption.createMany({ data: [{ name: "Referral", order: 0 }] });
  await prisma.firmProfile.create({ data: { id: 1, name: "buh_crm" } });
});

afterAll(async () => {
  // leave no rows behind that would block other suites' cleanup (File → User FK)
  await prisma.file.deleteMany();
  await prisma.clientPerson.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await app.close();
});

describe("email normalization", () => {
  it("stores invited emails lowercased and logs in case-insensitively", async () => {
    const adminCookie = await loginAs("audit-admin@test.local", "admin-pass-123");

    const invite = await app.inject({
      method: "POST",
      url: "/api/users/invites",
      headers: { cookie: adminCookie },
      payload: { email: "MiXeD.Case@Test.Local", role: "user" },
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json().email).toBe("mixed.case@test.local");

    // duplicate invite in a different case is rejected
    const dup = await app.inject({
      method: "POST",
      url: "/api/users/invites",
      headers: { cookie: adminCookie },
      payload: { email: "mixed.CASE@test.local", role: "user" },
    });
    expect(dup.statusCode).toBe(409);

    // accept the invite, then sign in typing the email in yet another case
    const email = [...testOutbox]
      .reverse()
      .find((m) => m.to === "mixed.case@test.local" && m.subject.includes("invited"));
    const token = tokenFromEmail(email!.html);
    const accept = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invite",
      payload: { token, firstName: "Mixed", lastName: "Case", password: "password-123" },
    });
    expect(accept.statusCode).toBe(200);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "MIXED.case@TEST.local", password: "password-123" },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe("password change session invalidation", () => {
  it("signs out other sessions but keeps the changing device signed in", async () => {
    const cookieA = await loginAs("audit-admin@test.local", "admin-pass-123");
    const cookieB = await loginAs("audit-admin@test.local", "admin-pass-123");

    const change = await app.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie: cookieA },
      payload: { currentPassword: "admin-pass-123", newPassword: "admin-pass-456" },
    });
    expect(change.statusCode).toBe(200);
    const freshCookie = cookieOf(change); // re-issued session for this device

    const meB = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieB } });
    expect(meB.statusCode).toBe(401); // other device is signed out

    const meA = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: freshCookie } });
    expect(meA.statusCode).toBe(200); // this device stays signed in

    // restore the password for the rest of the suite
    const restore = await app.inject({
      method: "PATCH",
      url: "/api/users/me",
      headers: { cookie: freshCookie },
      payload: { currentPassword: "admin-pass-456", newPassword: "admin-pass-123" },
    });
    expect(restore.statusCode).toBe(200);
  });
});

describe("firm logo upload", () => {
  it("rejects an SVG logo (raster only — same rule as avatars)", async () => {
    const cookie = await loginAs("audit-admin@test.local", "admin-pass-123");
    const { payload, contentType } = multipart(
      "logo.svg",
      "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/firm/logo",
      headers: { cookie, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("clients", () => {
  it("dedupes company names case-insensitively on the server", async () => {
    const cookie = await loginAs("audit-admin@test.local", "admin-pass-123");
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        type: "individual",
        firstName: "Dedup",
        lastName: "Test",
        companyNames: ["Alpha LLC", "alpha llc", " ALPHA LLC ", "Beta"],
        people: [],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().companies.map((c: { name: string }) => c.name)).toEqual([
      "Alpha LLC",
      "Beta",
    ]);
  });

  it("rejects an invalid person email but tolerates an empty one", async () => {
    const cookie = await loginAs("audit-admin@test.local", "admin-pass-123");
    const bad = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        type: "individual",
        firstName: "Person",
        lastName: "Email",
        companyNames: [],
        people: [{ name: "Contact", email: "not-an-email" }],
      },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: {
        type: "individual",
        firstName: "Person",
        lastName: "Email",
        companyNames: [],
        people: [{ name: "Contact", email: "" }],
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().people[0].email).toBeNull();
  });

  it("hides an archived client's files (download and delete both 404)", async () => {
    const cookie = await loginAs("audit-admin@test.local", "admin-pass-123");
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie },
      payload: { type: "individual", firstName: "Arch", lastName: "Files", companyNames: [], people: [] },
    });
    const clientId = created.json().id;

    const { payload, contentType } = multipart("note.txt", "text/plain", "hello");
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/files`,
      headers: { cookie, "content-type": contentType },
      payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const fileId = uploaded.json().id;

    await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/archive`,
      headers: { cookie },
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/clients/${clientId}/files/${fileId}`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(404);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/clients/${clientId}/files/${fileId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(404);
  });
});

describe("settings", () => {
  it("rejects a duplicate source name in a different case", async () => {
    const cookie = await loginAs("audit-admin@test.local", "admin-pass-123");
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/sources",
      headers: { cookie },
      payload: { name: "referral" }, // "Referral" already exists
    });
    expect(res.statusCode).toBe(409);
  });

  it("swaps two priorities' orders atomically via the swap endpoint", async () => {
    const cookie = await loginAs("audit-admin@test.local", "admin-pass-123");
    const [low, normal] = await Promise.all([
      prisma.priority.findUniqueOrThrow({ where: { name: "Low" } }),
      prisma.priority.findUniqueOrThrow({ where: { name: "Normal" } }),
    ]);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings/priorities/swap",
      headers: { cookie },
      payload: { aId: low.id, bId: normal.id },
    });
    expect(res.statusCode).toBe(200);

    const after = res.json() as Array<{ id: string; order: number }>;
    expect(after.find((p) => p.id === low.id)!.order).toBe(normal.order);
    expect(after.find((p) => p.id === normal.id)!.order).toBe(low.order);
  });
});

describe("one-time token race", () => {
  it("lets exactly one of two concurrent reset-password submissions win", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "audit-admin@test.local" },
    });
    const email = [...testOutbox]
      .reverse()
      .find((m) => m.to === "audit-admin@test.local" && m.subject.includes("Reset"));
    const token = tokenFromEmail(email!.html);

    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/auth/reset-password",
        payload: { token, password: "race-pass-111" },
      }),
      app.inject({
        method: "POST",
        url: "/api/auth/reset-password",
        payload: { token, password: "race-pass-222" },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 400]); // one winner, one loser — never two applied passwords

    // exactly one of the two passwords must work
    const w1 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "audit-admin@test.local", password: "race-pass-111" },
    });
    const w2 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "audit-admin@test.local", password: "race-pass-222" },
    });
    expect([w1.statusCode, w2.statusCode].sort()).toEqual([200, 401]);
  });
});
