import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { __clearGrants } from "./secrets.service.js";

/**
 * Client secrets hold tax-portal and client-bank credentials, so these tests are about who can see
 * what, not about happy paths. Every one of them pins a rule that would be a leak if it broke.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let userCookie: string;
let clientId: string;
let otherClientId: string;

const PASSWORD = "password-123";

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function login(email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.secretAuditLog.deleteMany();
  await prisma.clientSecret.deleteMany();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.client.deleteMany();
  await prisma.user.deleteMany();

  const hash = await argon2.hash(PASSWORD);
  await prisma.user.createMany({
    data: [
      { firstName: "Sec", lastName: "Admin", email: "sec-admin@test.local", passwordHash: hash, role: "admin", status: "active" },
      { firstName: "Sec", lastName: "User", email: "sec-user@test.local", passwordHash: hash, role: "user", status: "active" },
    ],
  });
  adminCookie = await login("sec-admin@test.local");
  userCookie = await login("sec-user@test.local");

  const mk = async (name: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { firstName: name },
    });
    return res.json().id as string;
  };
  clientId = await mk("Secretful");
  otherClientId = await mk("Unrelated");
});

afterAll(async () => {
  await prisma.secretAuditLog.deleteMany();
  await prisma.clientSecret.deleteMany();
  await prisma.client.deleteMany();
  await app.close();
});

describe("client secrets", () => {
  let secretId: string;

  it("stores a value encrypted — the row never holds the plaintext", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets`,
      headers: { cookie: adminCookie },
      payload: {
        label: "Кабінет платника податків",
        description: "Логін і пароль до податкового кабінету",
        value: "login: 1234567890 / pass: super-secret-🔐",
      },
    });
    expect(res.statusCode).toBe(201);
    secretId = res.json()[0].id;

    const row = await prisma.clientSecret.findUniqueOrThrow({ where: { id: secretId } });
    expect(row.ciphertext).not.toBeNull();
    // the plaintext must not survive anywhere in the row, in any encoding
    const blob = Buffer.concat([
      Buffer.from(row.ciphertext!),
      Buffer.from(row.label),
      Buffer.from(row.description ?? ""),
    ]).toString("utf8");
    expect(blob).not.toContain("super-secret");
    expect(blob).not.toContain("1234567890");
  });

  it("lists labels and descriptions but never the value or the ciphertext", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/clients/${clientId}/secrets`,
      headers: { cookie: userCookie }, // a regular colleague may see WHAT exists
    });
    expect(res.statusCode).toBe(200);
    const [entry] = res.json();
    expect(entry.label).toBe("Кабінет платника податків");
    expect(entry.hasValue).toBe(true);
    // the response shape carries no room for the secret at all
    expect(Object.keys(entry).sort()).toEqual(
      ["createdByName", "description", "hasValue", "id", "label", "updatedAt"].sort(),
    );
    expect(JSON.stringify(res.json())).not.toContain("super-secret");
  });

  it("refuses a non-admin: no unlock, no reveal, no writes", async () => {
    const unlock = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets/unlock`,
      headers: { cookie: userCookie },
      payload: { password: PASSWORD },
    });
    expect(unlock.statusCode).toBe(403);

    const reveal = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets/${secretId}/reveal`,
      headers: { cookie: userCookie },
    });
    expect(reveal.statusCode).toBe(403);

    const create = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets`,
      headers: { cookie: userCookie },
      payload: { label: "nope", value: "x" },
    });
    expect(create.statusCode).toBe(403);
  });

  it("refuses to reveal without a grant, and a wrong password is journalled", async () => {
    __clearGrants();
    const cold = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets/${secretId}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(cold.statusCode).toBe(403);

    const wrong = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets/unlock`,
      headers: { cookie: adminCookie },
      payload: { password: "not-my-password" },
    });
    expect(wrong.statusCode).toBe(403);
    // a run of these is the only way a guessing attempt becomes visible
    expect(
      await prisma.secretAuditLog.count({ where: { clientId, action: "unlock_failed" } }),
    ).toBe(1);
  });

  it("reveals after the right password, and writes exactly one audit row per reveal", async () => {
    const unlock = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets/unlock`,
      headers: { cookie: adminCookie },
      payload: { password: PASSWORD },
    });
    expect(unlock.statusCode).toBe(200);
    expect(new Date(unlock.json().expiresAt).getTime()).toBeGreaterThan(Date.now());

    const before = await prisma.secretAuditLog.count({ where: { clientId, action: "revealed" } });
    const reveal = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets/${secretId}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().value).toBe("login: 1234567890 / pass: super-secret-🔐");
    expect(await prisma.secretAuditLog.count({ where: { clientId, action: "revealed" } })).toBe(
      before + 1,
    );
  });

  it("a grant on one client does NOT open another", async () => {
    // still unlocked for `clientId` from the previous test
    const other = await app.inject({
      method: "POST",
      url: `/api/clients/${otherClientId}/secrets`,
      headers: { cookie: adminCookie },
      payload: { label: "Bank", value: "other-client-secret" },
    });
    const otherSecretId = other.json()[0].id;

    const reveal = await app.inject({
      method: "POST",
      url: `/api/clients/${otherClientId}/secrets/${otherSecretId}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(reveal.statusCode).toBe(403);
  });

  it("keeps a pointer-only entry: no value stored, nothing to reveal", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets`,
      headers: { cookie: adminCookie },
      payload: {
        label: "КЕП директора",
        description: "Занадто чутливе — лежить у менеджері паролів, запис «Kvitka КЕП»",
      },
    });
    expect(res.statusCode).toBe(201);
    const pointer = res.json().find((s: { label: string }) => s.label === "КЕП директора");
    expect(pointer.hasValue).toBe(false);

    const row = await prisma.clientSecret.findUniqueOrThrow({ where: { id: pointer.id } });
    expect(row.ciphertext).toBeNull();
    expect(row.iv).toBeNull();
    expect(row.authTag).toBeNull();

    const reveal = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets/${pointer.id}/reveal`,
      headers: { cookie: adminCookie },
    });
    expect(reveal.statusCode).toBe(400); // there is nothing to reveal, and it says so
  });

  // The form now sends the field's contents verbatim, so "cleared the box" must mean "store
  // nothing" — the same rule as creating (user, 2026-08-03).
  it("an edit with an empty value clears it, keeping the entry as a reference", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/secrets/${secretId}`,
      headers: { cookie: adminCookie },
      payload: { label: "Кабінет платника податків", value: null },
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.clientSecret.findUniqueOrThrow({ where: { id: secretId } });
    expect(row.ciphertext).toBeNull();
  });

  it("refuses to delete without a grant — losing a login to a stray click is its own leak", async () => {
    __clearGrants();
    const cold = await app.inject({
      method: "DELETE",
      url: `/api/clients/${clientId}/secrets/${secretId}`,
      headers: { cookie: adminCookie },
    });
    expect(cold.statusCode).toBe(403);
    expect(await prisma.clientSecret.findUnique({ where: { id: secretId } })).not.toBeNull();

    // …and goes through once the password has been entered
    await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/secrets/unlock`,
      headers: { cookie: adminCookie },
      payload: { password: PASSWORD },
    });
  });

  it("collapses repeat looks and pages the log", async () => {
    // reveal the same secret several times in a row — the edit form does this too
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: `/api/clients/${clientId}/secrets/${secretId}/reveal`,
        headers: { cookie: adminCookie },
      });
    }
    // one row per LOOK, not per click
    const reveals = await prisma.secretAuditLog.count({
      where: { clientId, secretId, action: "revealed" },
    });
    expect(reveals).toBe(1);

    const first = await app.inject({
      method: "GET",
      url: `/api/clients/${clientId}/secrets/audit`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.items.length).toBeLessThanOrEqual(10);
    expect(body.total).toBeGreaterThan(0);

    // a page past the end answers empty rather than erroring — the modal can ask for it
    const far = await app.inject({
      method: "GET",
      url: `/api/clients/${clientId}/secrets/audit?page=99`,
      headers: { cookie: adminCookie },
    });
    expect(far.statusCode).toBe(200);
    expect(far.json().items).toHaveLength(0);
  });

  it("the log still says WHAT it was about after the secret is gone", async () => {
    // the FK goes null on delete, so the name is snapshotted onto the row when it is written —
    // a log that cannot say what it was about is not worth keeping (user, 2026-08-03)
    const rows = await prisma.secretAuditLog.findMany({ where: { clientId, action: "revealed" } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.label !== null)).toBe(true);
  });

  it("the audit trail survives the secret it describes", async () => {
    const before = await prisma.secretAuditLog.count({ where: { clientId } });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/clients/${clientId}/secrets/${secretId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(await prisma.clientSecret.findUnique({ where: { id: secretId } })).toBeNull();
    // deleting the secret must not erase who looked at it — the rows stay, `secretId` goes null
    expect(await prisma.secretAuditLog.count({ where: { clientId } })).toBeGreaterThan(before);
  });
});
