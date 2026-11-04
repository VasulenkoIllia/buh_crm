import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { testOutbox } from "../../core/email.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";

/**
 * **Deleting an invitation** (users.md §2, owner, 2026-11-04): an invitation nobody accepted goes
 * with its row, and anybody who signed in is blocked instead, never deleted.
 */

const TAG = `inv${randomUUID().slice(0, 6)}`;
const DOMAIN = `@${TAG}.local`;
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let colleague: Person;

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

async function loggedDeletion(userId: string) {
  // the log is written after the response
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await prisma.activityEvent.findFirst({
      where: { action: "user.invite_deleted", subjectId: userId },
    });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no user.invite_deleted row");
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  [admin, colleague] = await createPeople(app, DOMAIN, ["Olena", "Taras"], "admin");
});

afterAll(async () => {
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

  it("refuses an account somebody signed in to", async () => {
    const res = await as("DELETE", `/api/users/${colleague.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Only an invitation nobody accepted can be deleted");
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
