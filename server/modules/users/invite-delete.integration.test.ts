import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";

/**
 * **Deleting somebody from the team** (users.md §2, owner, 2026-11-04): an invitation nobody
 * accepted goes with its row; a blocked colleague is deleted for good, their row kept for what they
 * did and their address free again; an active one is blocked first.
 */

const TAG = `inv${randomUUID().slice(0, 6)}`;
const DOMAIN = `@${TAG}.local`;
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let colleague: Person;
let leaver: Person;

const as = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: admin.cookie }, payload });

const invite = (email: string) => as("POST", "/api/users/invites", { email, role: "user" });

async function inviteToken(email: string) {
  // the letter is sent after the response
  for (let attempt = 0; attempt < 50; attempt++) {
    const letter = testOutbox.find((m) => m.to === email);
    const token = letter?.html.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no invitation letter");
}

async function loggedDeletion(userId: string, action = "user.invite_deleted") {
  // the log is written after the response
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action, subjectId: userId },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no ${action} row`);
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  [admin, colleague, leaver] = await createPeople(
    app,
    DOMAIN,
    ["Olena", "Taras", "Ivan"],
    "admin",
  );
});

afterAll(async () => {
  // a deleted colleague's address is no longer under the test's domain
  await prisma.user.deleteMany({ where: { id: leaver.id } });
  await removePeople(DOMAIN);
  await app.close();
});

describe("deleting an invitation", () => {
  it("deletes one nobody accepted, logs it, and frees the address", async () => {
    const email = `new${DOMAIN}`;
    const invited = await invite(email);
    expect(invited.statusCode).toBe(201);
    const { id } = invited.json<{ id: string }>();
    const token = await inviteToken(email);

    expect((await as("DELETE", `/api/users/${id}`)).statusCode).toBe(204);
    // the link in the letter stops working: its token went with the row
    const accepted = await app.inject({
      method: "POST",
      url: "/api/auth/accept-invite",
      payload: { token, firstName: "Late", lastName: "Comer", password: "secret-pass-1" },
    });
    expect(accepted.statusCode).toBe(400);
    expect(await prisma.user.findUnique({ where: { id } })).toBeNull();
    expect((await loggedDeletion(id)).changes).toEqual({ email, role: "user" });

    expect((await invite(email)).statusCode).toBe(201);
  });

  it("refuses an active colleague until they are blocked", async () => {
    const res = await as("DELETE", `/api/users/${colleague.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Block them first, then delete");
    expect(await prisma.user.findUnique({ where: { id: colleague.id } })).not.toBeNull();
  });

  it("answers 404 for nobody", async () => {
    expect((await as("DELETE", `/api/users/${randomUUID()}`)).statusCode).toBe(404);
  });
});

describe("inviting a blocked colleague's address", () => {
  it("says to unblock them, since a new invite cannot reuse the address", async () => {
    const blocked = await as("PATCH", `/api/users/${colleague.id}`, { status: "blocked" });
    expect(blocked.statusCode).toBe(200);
    const res = await invite(colleague.email.toUpperCase());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe("This person is blocked. Unblock them in the list");
  });
});

describe("deleting a blocked colleague for good", () => {
  it("takes them out of the team, frees the address, and keeps the row for what they did", async () => {
    expect(
      (await as("PATCH", `/api/users/${leaver.id}`, { status: "blocked" })).statusCode,
    ).toBe(200);
    // every way back in, planted after the block, so the delete is what has to remove it
    const userId = leaver.id;
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.session.create({ data: { id: `${TAG}-session`, userId, expiresAt: later } });
    await prisma.authToken.create({
      data: { userId, type: "password_reset", tokenHash: `${TAG}-reset`, expiresAt: later },
    });
    const bytes = Buffer.from("x");
    await prisma.twoFactorCredential.create({
      data: { userId, ciphertext: bytes, iv: bytes, authTag: bytes, keyVersion: 1 },
    });
    await prisma.accessOverride.create({ data: { userId, gate: "tasks", state: "open" } });

    expect((await as("DELETE", `/api/users/${userId}`)).statusCode).toBe(204);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row).toMatchObject({ status: "deleted", passwordHash: null, firstName: "Ivan" });
    expect(row.email).not.toBe(leaver.email);
    const left = await Promise.all([
      prisma.session.count({ where: { userId } }),
      prisma.authToken.count({ where: { userId } }),
      prisma.twoFactorCredential.count({ where: { userId } }),
      prisma.accessOverride.count({ where: { userId } }),
    ]);
    expect(left).toEqual([0, 0, 0, 0]);
    expect((await loggedDeletion(leaver.id, "user.deleted")).changes).toEqual({
      email: leaver.email,
    });

    const team = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: admin.cookie },
    });
    expect(team.json<{ id: string }[]>().some((u) => u.id === leaver.id)).toBe(false);

    const again = await invite(leaver.email);
    expect(again.statusCode).toBe(201);
    expect(again.json<{ id: string }>().id).not.toBe(leaver.id);
    // the old password opens nothing: the address now belongs to an invitation with none
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: leaver.email, password: "password-123" }, // test/people.ts
    });
    expect(signIn.statusCode).toBe(401);
  });

  it("is gone for good: no unblock, no second delete", async () => {
    const unblock = await as("PATCH", `/api/users/${leaver.id}`, { status: "active" });
    expect(unblock.statusCode).toBe(404);
    expect((await as("DELETE", `/api/users/${leaver.id}`)).statusCode).toBe(404);
  });
});
