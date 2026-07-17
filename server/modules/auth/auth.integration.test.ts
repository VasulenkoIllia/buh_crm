import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";

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

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.file.deleteMany();

  await prisma.user.create({
    data: {
      firstName: "Admin",
      lastName: "Boss",
      email: "admin@test.local",
      passwordHash: await argon2.hash("admin-pass-123"),
      role: "admin",
      status: "active",
      emailConfirmedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await app.close();
});

describe("auth + users", () => {
  it("rejects a wrong password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@test.local", password: "nope-nope-nope" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("logs in and returns the current user", async () => {
    const cookie = await loginAs("admin@test.local", "admin-pass-123");
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: "admin@test.local", role: "admin" });
  });

  it("runs the full invite → accept → active flow", async () => {
    const adminCookie = await loginAs("admin@test.local", "admin-pass-123");

    const invite = await app.inject({
      method: "POST",
      url: "/api/users/invites",
      headers: { cookie: adminCookie },
      payload: { email: "newbie@test.local", role: "user" },
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json().status).toBe("invited");

    const email = testOutbox.find((m) => m.to === "newbie@test.local");
    expect(email).toBeDefined();
    const token = tokenFromEmail(email!.html);

    const accept = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invite",
      payload: { token, firstName: "New", lastName: "Person", password: "secret-pass-1" },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json()).toMatchObject({ status: "active", firstName: "New" });

    // invite link = email confirmation (decision 2026-07-17)
    const dbUser = await prisma.user.findUnique({ where: { email: "newbie@test.local" } });
    expect(dbUser?.emailConfirmedAt).not.toBeNull();

    // auto-logged-in via the accept response cookie
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieOf(accept) },
    });
    expect(me.statusCode).toBe(200);

    // the token is single-use
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invite",
      payload: { token, firstName: "X", lastName: "Y", password: "secret-pass-2" },
    });
    expect(again.statusCode).toBe(400);
  });

  it("forbids invites for non-admins", async () => {
    const cookie = await loginAs("newbie@test.local", "secret-pass-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/users/invites",
      headers: { cookie },
      payload: { email: "sneaky@test.local", role: "admin" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("blocking kills the user's sessions immediately", async () => {
    const adminCookie = await loginAs("admin@test.local", "admin-pass-123");
    const userCookie = await loginAs("newbie@test.local", "secret-pass-1");
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: "newbie@test.local" },
    });

    const block = await app.inject({
      method: "PATCH",
      url: `/api/users/${user.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "blocked" },
    });
    expect(block.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: userCookie },
    });
    expect(me.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "newbie@test.local", password: "secret-pass-1" },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json().error.message).toMatch(/blocked/i);

    // unblock restores access
    await app.inject({
      method: "PATCH",
      url: `/api/users/${user.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "active" },
    });
    const relogin = await loginAs("newbie@test.local", "secret-pass-1");
    expect(relogin).toContain("sid=");
  });

  it("admins cannot change their own role or status", async () => {
    const adminCookie = await loginAs("admin@test.local", "admin-pass-123");
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: "admin@test.local" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${admin.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "user" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("resets a password and invalidates old sessions", async () => {
    const oldCookie = await loginAs("newbie@test.local", "secret-pass-1");

    const forgot = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "newbie@test.local" },
    });
    expect(forgot.statusCode).toBe(200);

    const email = [...testOutbox]
      .reverse()
      .find((m) => m.to === "newbie@test.local" && m.subject.includes("Reset"));
    const token = tokenFromEmail(email!.html);

    const reset = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, password: "brand-new-pass" },
    });
    expect(reset.statusCode).toBe(200);

    const meOld = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: oldCookie },
    });
    expect(meOld.statusCode).toBe(401);

    await loginAs("newbie@test.local", "brand-new-pass");
  });
});
