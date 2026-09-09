import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { prisma } from "./core/db.js";
import { invalidateAccessCache } from "./core/access.js";
import {
  currentActivityStore,
  diff,
  flushActivity,
  invalidateActivityPolicy,
  purgeOldActivity,
  record,
  runWithActivity,
} from "./core/activity.js";
import { finalizeInventory } from "./core/route-inventory.js";

/**
 * **That the log is WIDE, and that it never lies.**
 *
 * The owner's three requirements were wide, searchable and extensible by hand (activity-log.md §1).
 * Only the first can be proved by a test, and this is it: every mutating route the app answers
 * writes a row, established by walking the committed inventory rather than by a list somebody
 * maintains here. A route added next year is covered on the day it ships, and the day somebody
 * removes the hook this file says so.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let userCookie: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

/**
 * **The log is written AFTER the response**, which is the point of it (core/activity.ts) and the
 * reason every assertion here has to wait rather than read straight after `inject`. A test that
 * read immediately would be asserting on a race, and would pass or fail by machine speed.
 */
async function waitFor<T>(find: () => Promise<T | null>, what: string): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const found = await find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`activity row never arrived: ${what}`);
}

async function login(email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "password-123" },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.activityEvent.deleteMany();
  await prisma.accessOverride.deleteMany();
  await prisma.accessPolicy.deleteMany();
  invalidateAccessCache();
  invalidateActivityPolicy();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: "@activity.local" } } });

  const passwordHash = await argon2.hash("password-123");
  await prisma.user.create({
    data: {
      firstName: "Ada",
      lastName: "Admin",
      email: "ada@activity.local",
      passwordHash,
      role: "admin",
      status: "active",
    },
  });
  await prisma.user.create({
    data: {
      firstName: "Ulf",
      lastName: "User",
      email: "ulf@activity.local",
      passwordHash,
      role: "user",
      status: "active",
    },
  });
  adminCookie = await login("ada@activity.local");
  userCookie = await login("ulf@activity.local");
});

afterAll(async () => {
  await prisma.activityEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: "@activity.local" } } });
  await app?.close();
});

describe("tier 1 — every mutation, automatically", () => {
  /**
   * **The test that makes "wide" true rather than claimed.**
   *
   * It fires each mutating route with an empty body and a random id, so most answer 400 or 404 —
   * and that is the point. The row is written because the REQUEST happened, not because the handler
   * succeeded, which is exactly the property a log of "who tried what" needs and the property an
   * enrichment-only design cannot have.
   */
  it("writes a row for every mutating route in the committed inventory", async () => {
    const routes = finalizeInventory(app.routeInventory)
      .filter((r) => !r.derived && !["GET", "HEAD", "OPTIONS"].includes(r.method))
      // last, or every route after it answers 401 with a cleared cookie
      .sort((a, b) => Number(a.url.endsWith("/logout")) - Number(b.url.endsWith("/logout")));
    expect(routes.length).toBeGreaterThan(100);

    const missing: string[] = [];
    for (const route of routes) {
      const url = route.url.replace(/:[A-Za-z]+/g, () => randomUUID());
      const before = new Date();
      await app.inject({
        method: route.method as "POST",
        url,
        headers: { cookie: adminCookie },
        payload: {},
      });
      const row = await waitFor(
        () =>
          prisma.activityEvent.findFirst({
            where: { route: route.url, method: route.method, occurredAt: { gte: before } },
          }),
        `${route.method} ${route.url}`,
      ).catch(() => null);
      if (!row) missing.push(`${route.method} ${route.url}`);
    }

    expect(
      missing,
      "these mutating routes wrote no activity row. Either the hook has stopped covering them, or " +
        "a route was registered outside the app's root context where the hook does not reach.",
    ).toEqual([]);

    // the walk ends on POST /api/auth/logout, which does exactly what it says
    adminCookie = await login("ada@activity.local");
    userCookie = await login("ulf@activity.local");
  });

  it("records the route pattern, not the filled-in url", async () => {
    const id = randomUUID();
    await app.inject({
      method: "DELETE",
      url: `/api/clients/${id}/pin`,
      headers: { cookie: adminCookie },
    });
    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { route: "/api/clients/:id/pin" },
          orderBy: { occurredAt: "desc" },
        }),
      "the pin route",
    );
    // a column a screen reads must group, and it must not become a second place record ids live
    expect(row?.route).toBe("/api/clients/:id/pin");
    expect(row?.route).not.toContain(id);
  });

  it("leaves ordinary reads alone", async () => {
    const before = new Date();
    const res = await app.inject({
      method: "GET",
      url: "/api/clients",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    // long enough that a row WOULD have arrived — asserting an absence immediately would pass
    // even if reads were logged
    await new Promise((resolve) => setTimeout(resolve, 100));
    // an open board polls every minute; a log of that answers nothing (§3.2).
    //
    // Scoped to this route rather than counting every row since `before`: flushes from the
    // previous test's sign-ins are still landing, and a count of everything would be asserting on
    // whichever of them got there first. Scoped to GET rather than to the whole route because the
    // four sensitive reads (§3.2) will one day record on a GET, and this test should survive that.
    expect(
      await prisma.activityEvent.count({
        where: { occurredAt: { gte: before }, method: "GET", route: "/api/clients" },
      }),
    ).toBe(0);
  });
});

describe("refusals, which the permissions module never recorded", () => {
  it("records a closed gate as a refusal, with the code the caller was given", async () => {
    await prisma.accessPolicy.upsert({
      where: { gate_role_action: { gate: "clients", role: "user", action: "*" } },
      update: { state: "closed" },
      create: { gate: "clients", role: "user", state: "closed" },
    });
    invalidateAccessCache();
    const before = new Date();
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: userCookie },
      payload: { firstName: "Nope" },
    });
    expect(res.statusCode).toBe(403);

    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { occurredAt: { gte: before }, route: "/api/clients" },
        }),
      "the refused client create",
    );
    expect(row?.action).toBe("session.gate_refused");
    expect(row?.outcome).toBe("refused");
    // three different 403s reach the SPA and they mean three different things — the log has to
    // keep them apart too (`permissions.md` §20.3)
    expect(row?.refusalCode).toBe("module_closed");
    expect(row?.gate).toBe("clients");
    expect(row?.actorLabel).toBe("Ulf User");

    await prisma.accessPolicy.deleteMany();
    invalidateAccessCache();
  });

  it("records an admin-only route refused inside an open gate", async () => {
    const before = new Date();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/invoices/${randomUUID()}`,
      headers: { cookie: userCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { occurredAt: { gte: before }, route: "/api/invoices/:id" },
        }),
      "the admin-only invoice patch",
    );
    expect(row?.refusalCode).toBe("admin_only");
    expect(row?.outcome).toBe("refused");
  });

  /**
   * **A refused READ is the shape most refusals take, and it was the one never written.**
   *
   * The tier-1 block was gated on `MUTATING_METHODS`, so a refused `PATCH` was recorded and
   * somebody being turned away from a SCREEN — a `GET`, which is what almost every refusal is —
   * left no trace at all. "A lead was refused Billing" is the sentence the whole `session.gate_refused`
   * event exists for (audit, 2026-09-09).
   */
  it("records a refused GET, which is the shape almost every refusal takes", async () => {
    await prisma.accessPolicy.upsert({
      where: { gate_role_action: { gate: "billing", role: "user", action: "*" } },
      update: { state: "closed" },
      create: { gate: "billing", role: "user", state: "closed" },
    });
    invalidateAccessCache();
    const before = new Date();
    const res = await app.inject({
      method: "GET",
      url: "/api/invoices",
      headers: { cookie: userCookie },
    });
    expect(res.statusCode).toBe(403);

    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { occurredAt: { gte: before }, method: "GET", gate: "billing" },
        }),
      "the refused invoice list",
    );
    expect(row?.action).toBe("session.gate_refused");
    expect(row?.refusalCode).toBe("module_closed");
    expect(row?.outcome).toBe("refused");

    await prisma.accessPolicy.deleteMany({ where: { gate: "billing" } });
    invalidateAccessCache();
  });

  /**
   * **Switching one event off must not switch the REQUEST off with it.**
   *
   * The tier-1 fallback asked "did a service buffer anything", not "will anything be written". So a
   * firm that silenced `client.created` from Settings → Activity got NOTHING for `POST
   * /api/clients` — the enriched row dropped by the policy filter, the bare row never synthesised
   * because a service had spoken. The screen's own blurb promises the opposite, and the firm's
   * obligation under (c)(8) rests on the promise (audit, 2026-09-09).
   */
  it("still records the request when the event a service raised is switched off", async () => {
    await prisma.activityPolicy.upsert({
      where: { action: "client.created" },
      update: { enabled: false },
      create: { action: "client.created", enabled: false },
    });
    invalidateActivityPolicy();
    const before = new Date();
    const res = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { firstName: "Silenced", lastName: "Client" },
    });
    expect(res.statusCode).toBe(201);

    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { occurredAt: { gte: before }, route: "/api/clients", method: "POST" },
        }),
      "the tier-1 row for a silenced event",
    );
    expect(row?.action).toBe("system.request");
    expect(
      await prisma.activityEvent.count({
        where: { occurredAt: { gte: before }, action: "client.created" },
      }),
      "the event itself stays silenced — that is what the switch is for",
    ).toBe(0);

    await prisma.activityPolicy.update({
      where: { action: "client.created" },
      data: { enabled: true },
    });
    invalidateActivityPolicy();
  });

  it("records a failure as failed, not as a refusal", async () => {
    const before = new Date();
    await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: {}, // no name — a validation error
    });
    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { occurredAt: { gte: before }, route: "/api/clients" },
        }),
      "the failed client create",
    );
    // one is a permissions question and the other is an incident; a column that blurred them
    // would answer neither
    expect(row?.outcome).toBe("failed");
    expect(row?.action).toBe("system.request");
  });
});

describe("one gesture, one entry", () => {
  it("gives every row written under one context the same correlation id", async () => {
    await runWithActivity(
      { actor: { kind: "user", userId: null, label: "Olena" } },
      async () => {
        record("client.created", { subjectLabel: "Petrenko" });
        record("company.deleted", { subjectLabel: "Petrenko LLC", changes: { name: "x" } });
      },
    );
    const rows = await prisma.activityEvent.findMany({
      where: { actorLabel: "Olena" },
      orderBy: { occurredAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    // saving a client edits the client and reconciles its companies; the screen must show that as
    // one thing a person did, not as two rows (§6)
    expect(rows[0].correlationId).toBe(rows[1].correlationId);
    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Olena" } });
  });

  it("does not add a bare request row beside a gesture a service described", async () => {
    await runWithActivity({ actor: { kind: "system", label: "The scheduler" } }, async () => {
      record("invoice.issued", { subjectLabel: "INV-1", changes: { amount: 100 } });
    });
    const rows = await prisma.activityEvent.findMany({
      where: { actorLabel: "The scheduler" },
    });
    expect(rows.map((r) => r.action)).toEqual(["invoice.issued"]);
    await prisma.activityEvent.deleteMany({ where: { actorLabel: "The scheduler" } });
  });
});

describe("what `changes` may hold", () => {
  /**
   * **The guard that makes an unreadable diff impossible rather than unlikely.**
   *
   * Production, 2026-09-09: `stage f83779ae-… → f0ec3a90-…` under a lead that had just moved, and
   * `client 7ddc79e9-…` under a task that had just been created. Thirteen of the hundred and
   * forty-nine events carried an id somewhere in their diff, written by hand over two days by
   * somebody who knew the rule. Remembering is what failed, so it is checked instead.
   */
  it("refuses a raw id, however deeply it is buried", async () => {
    const id = randomUUID();
    // bare
    expect(() => record("lead.stage_changed", { changes: { stage: id } })).toThrow(/raw id/);
    // inside a from/to pair
    expect(() =>
      record("lead.stage_changed", { changes: { stage: { from: id, to: id } } }),
    ).toThrow(/raw id/);
    /**
     * And inside a LIST inside a pair, which is the shape that slipped past the first version of
     * this check — `task.assigned` and `meeting.participants_changed` were both writing arrays of
     * user ids, and neither was found by reading them again.
     */
    expect(() =>
      record("task.assigned", { changes: { assignees: { from: [], to: [id] } } }),
    ).toThrow(/raw id/);
  });

  it("lets through the words those ids stand for", () => {
    expect(() =>
      record("lead.stage_changed", { changes: { stage: { from: "New", to: "Qualified" } } }),
    ).not.toThrow();
    expect(() =>
      record("task.assigned", { changes: { assignees: { from: ["Olena"], to: ["Serhii"] } } }),
    ).not.toThrow();
  });

  it("writes nothing when the diff is empty", async () => {
    await runWithActivity({ actor: { kind: "user", label: "Empty" } }, async () => {
      // a client save carrying only `{companies}` still reaches `updateClient`; presence is not
      // change, and six sites would otherwise fire on it (§4.2)
      record("client.imported", { changes: {} });
    });
    expect(await prisma.activityEvent.count({ where: { actorLabel: "Empty" } })).toBe(0);
  });

  it("refuses a field the event never declared", async () => {
    await expect(
      runWithActivity({ actor: { kind: "user", label: "Stray" } }, async () => {
        record("client.imported", { changes: { passwordHash: "leaked" } });
      }),
    ).rejects.toThrow(/may not carry passwordHash/);
    expect(await prisma.activityEvent.count({ where: { actorLabel: "Stray" } })).toBe(0);
  });

  it("diffs only what moved, and reports nothing when nothing did", () => {
    const before = { phone: "+380 1", email: "a@b.c" };
    expect(diff(before, { phone: "+380 2" }, ["phone", "email"])).toEqual({
      phone: { from: "+380 1", to: "+380 2" },
    });
    // never the whole record: a log of full snapshots is a second copy of the client book (§5.1)
    expect(diff(before, { phone: "+380 1" }, ["phone", "email"])).toBeNull();
    expect(diff(before, { email: undefined }, ["email"])).toEqual({
      email: { from: "a@b.c", to: null },
    });
  });
});

describe("the firm's switch, and retention", () => {
  it("stops recording an event the firm switched off", async () => {
    await prisma.activityPolicy.upsert({
      where: { action: "client.created" },
      update: { enabled: false },
      create: { action: "client.created", enabled: false },
    });
    invalidateActivityPolicy();
    await runWithActivity({ actor: { kind: "user", label: "Muted" } }, async () => {
      record("client.created", { subjectLabel: "Nobody" });
    });
    expect(await prisma.activityEvent.count({ where: { actorLabel: "Muted" } })).toBe(0);

    await prisma.activityPolicy.update({
      where: { action: "client.created" },
      data: { enabled: true },
    });
    invalidateActivityPolicy();
  });

  it("purges a two-year-old ordinary event and keeps a two-year-old access change", async () => {
    const old = new Date();
    old.setFullYear(old.getFullYear() - 3);
    const base = {
      actorKind: "user" as const,
      actorLabel: "Long ago",
      subjectId: null,
      correlationId: randomUUID(),
      occurredAt: old,
    };
    await prisma.activityEvent.createMany({
      data: [
        { ...base, action: "client.updated", subject: "client" },
        { ...base, action: "access.policy_changed", subject: "access" },
      ],
    });

    const { purged } = await purgeOldActivity();
    expect(purged).toBe(1);
    const left = await prisma.activityEvent.findMany({ where: { actorLabel: "Long ago" } });
    // the log outlives what it describes: it is the evidence that disposal happened, and these are
    // the rows an examination asks about (§11)
    expect(left.map((r) => r.action)).toEqual(["access.policy_changed"]);
    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Long ago" } });
  });
});

describe("reading it back", () => {
  it("groups rows into gestures and refuses a user the log by default", async () => {
    const refused = await app.inject({
      method: "GET",
      url: "/api/activity",
      headers: { cookie: userCookie },
    });
    // seeded closed for `user`, which reproduces the draft's admin-only behaviour on day one (§12)
    expect(refused.statusCode).toBe(403);

    await runWithActivity({ actor: { kind: "user", label: "Reader" } }, async () => {
      record("client.created", { subjectLabel: "Petrenko", clientId: null });
      record("company.deleted", { subjectLabel: "Petrenko LLC", changes: { name: "gone" } });
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/activity?q=Petrenko",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as { entries: { actorLabel: string; rows: unknown[] }[] };
    const entry = page.entries.find((e) => e.actorLabel === "Reader");
    // one entry that expands into its individual changes, not two rows in a wall of rows
    expect(entry?.rows).toHaveLength(2);
    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Reader" } });
  });
});

/**
 * **A3 — the acts the product could not reconstruct at all.**
 *
 * Three of the first events exist because nothing in this codebase recorded them: a failed sign-in
 * left no trace anywhere, the permissions module decided and logged nothing, and the secrets
 * journal recorded failures and reveals but never a success (activity-log.md §4.5). These are the
 * tests that make each of them true rather than intended.
 */
describe("enrichment — who is in the system, and what they were allowed to reach", () => {
  it("records a sign-in against the person, not against Anonymous", async () => {
    const before = new Date();
    await login("ada@activity.local");
    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { action: "session.signed_in", occurredAt: { gte: before } },
        }),
      "the sign-in",
    );
    /**
     * `/login` is an anonymous route, so the request never resolves a `currentUser` and the flush
     * has nobody to attribute this to. `createSession` pins the actor instead — without that this
     * row would read "Anonymous signed in", which is the one thing a sign-in log must never say.
     */
    expect(row.actorLabel).toBe("Ada Admin");
    expect(row.actorKind).toBe("user");
    expect(row.actorUserId).toBe(row.subjectId);

    // A1's other half: the session itself now knows where it was opened from
    const session = await prisma.session.findFirst({
      where: { userId: row.actorUserId! },
      orderBy: { createdAt: "desc" },
    });
    expect(session?.ip).toBeTruthy();
  });

  it("records a failed sign-in, its reason, and does not blame the account holder", async () => {
    const before = new Date();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ada@activity.local", password: "wrong-one" },
    });
    expect(res.statusCode).toBe(401);

    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { action: "session.sign_in_failed", occurredAt: { gte: before } },
        }),
      "the failed sign-in",
    );
    expect(row.changes).toEqual({ email: "ada@activity.local", reason: "wrong_password" });
    // nobody is signed in when a sign-in fails, and attributing the attempt to the account it
    // named would say the account holder did it — which is exactly the thing in doubt
    expect(row.actorKind).toBe("system");
  });

  it("records an attempt on an address that has no account, and says it had none", async () => {
    const before = new Date();
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@activity.local", password: "whatever" },
    });
    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { action: "session.sign_in_failed", occurredAt: { gte: before } },
        }),
      "the unknown-address attempt",
    );
    // the shape a probe leaves behind, and the reason this is recorded at all
    expect(row.changes).toEqual({ email: "nobody@activity.local", reason: "unknown_email" });
  });

  it("writes the journal row AND the mirror when a role changes", async () => {
    const target = await prisma.user.create({
      data: {
        firstName: "Rex",
        lastName: "Role",
        email: "rex@activity.local",
        role: "user",
        status: "active",
      },
    });
    const before = new Date();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${target.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(200);

    /**
     * §9's rule, tested: the specialised journal keeps the detail and the log says it happened, so
     * somebody looking for "what has been done to this account" finds it without already knowing
     * which journal to ask. The failure this guards against is one of the two being forgotten —
     * a log that lies by omission.
     */
    const journal = await prisma.userRoleAuditLog.findFirst({ where: { userId: target.id } });
    expect(journal?.fromRole).toBe("user");
    expect(journal?.toRole).toBe("admin");

    const mirror = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { action: "user.role_changed", occurredAt: { gte: before } },
        }),
      "the role-change mirror",
    );
    expect(mirror.subjectId).toBe(target.id);
    expect(mirror.changes).toEqual({ role: { from: "user", to: "admin" } });
    expect(mirror.actorLabel).toBe("Ada Admin");
  });

  it("records blocking, and records nothing when the status did not move", async () => {
    const target = await prisma.user.findFirstOrThrow({
      where: { email: "rex@activity.local" },
    });
    const before = new Date();
    await app.inject({
      method: "PATCH",
      url: `/api/users/${target.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "blocked" },
    });
    const blocked = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { action: "user.blocked", occurredAt: { gte: before } },
        }),
      "the block",
    );
    expect(blocked.changes).toEqual({ status: { from: "active", to: "blocked" } });

    // saving the form again with the status untouched is not a blocking and must not read like one
    const second = new Date();
    await app.inject({
      method: "PATCH",
      url: `/api/users/${target.id}`,
      headers: { cookie: adminCookie },
      payload: { status: "blocked" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await prisma.activityEvent.count({
        where: { action: "user.blocked", occurredAt: { gte: second } },
      }),
    ).toBe(0);

    await prisma.user.delete({ where: { id: target.id } });
  });

  it("records an access change with the state it moved FROM", async () => {
    const before = new Date();
    const res = await app.inject({
      method: "PUT",
      url: "/api/access/policies/billing/user",
      headers: { cookie: adminCookie },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(200);

    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { action: "access.policy_changed", occurredAt: { gte: before } },
        }),
      "the access change",
    );
    /**
     * "Who took this away from me, and when" is the question, and the `from` is half of it. The
     * repository upserts in place, so the prior state has to be read before the write or it is
     * gone — which is why this assertion is on `from` and not merely on the row existing.
     */
    expect(row.changes).toEqual({ state: { from: null, to: "closed" } });
    expect(row.subjectLabel).toContain("user");

    // and nothing at all when the same state is written twice
    const second = new Date();
    await app.inject({
      method: "PUT",
      url: "/api/access/policies/billing/user",
      headers: { cookie: adminCookie },
      payload: { state: "closed" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await prisma.activityEvent.count({
        where: { action: "access.policy_changed", occurredAt: { gte: second } },
      }),
    ).toBe(0);

    await prisma.accessPolicy.deleteMany();
    invalidateAccessCache();
  });

  it("records a sign-out, from the session rather than from a currentUser it never has", async () => {
    const cookie = await login("ulf@activity.local");
    const before = new Date();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: { action: "session.signed_out", occurredAt: { gte: before } },
        }),
      "the sign-out",
    );
    // `/logout` is anonymous — it has to be, or an expired session could not clear its own cookie
    expect(row.actorLabel).toBe("Ulf User");
  });
});

describe("the three shapes a bulk or late write takes", () => {
  /**
   * **"What has happened to this client" crosses subjects**, which is the question §1 opens with
   * and the reason `clientId` exists as a column. An invoice issued for Petrenko is
   * `subject: "invoice"`; a downloaded document is `subject: "file"`. Without this the client card's
   * Activity tab would find the client's own events and nothing else.
   */
  it("finds a client's events whose subject is not the client", async () => {
    const clientId = randomUUID();
    await runWithActivity({ actor: { kind: "user", label: "Cross" } }, async () => {
      record("client.updated", {
        subjectId: clientId,
        clientId,
        changes: { phone: { from: "1", to: "2" } },
      });
      record("invoice.issued", {
        subjectLabel: "INV-9",
        clientId,
        changes: { amount: 100 },
      });
      record("file.downloaded", { subjectLabel: "statement.pdf", clientId });
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/activity?clientId=${clientId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as { entries: { rows: { action: string }[] }[] };
    const actions = page.entries.flatMap((e) => e.rows.map((r) => r.action)).sort();
    expect(actions).toEqual(["client.updated", "file.downloaded", "invoice.issued"]);
    await prisma.activityEvent.deleteMany({ where: { clientId } });
  });

  /**
   * §3.3: an import records "one event with a count and the source file, not a row per client".
   * The script's own service layer records `client.created` 177 times; the context is what drops
   * them, because the SERVICE is right to record what it did and only the caller knows this is a
   * bulk run.
   */
  it("drops the item rows inside a summary-only run and keeps the summary", async () => {
    await runWithActivity(
      { actor: { kind: "system", label: "The import script" }, summaryOnly: true },
      async () => {
        record("client.created", { subjectLabel: "One" });
        record("client.created", { subjectLabel: "Two" });
        record("client.imported", {
          subjectLabel: "clients.csv",
          changes: { file: "clients.csv", created: 2, updated: 0, skipped: 0 },
        });
      },
    );
    const rows = await prisma.activityEvent.findMany({
      where: { actorLabel: "The import script" },
    });
    expect(rows.map((r) => r.action)).toEqual(["client.imported"]);
    expect(rows[0].changes).toMatchObject({ file: "clients.csv", created: 2 });
    await prisma.activityEvent.deleteMany({ where: { actorLabel: "The import script" } });
  });

  /**
   * **Work that outlives its request.** Mail-out delivery runs after the response returns on
   * purpose — a hundred SMTP round-trips cannot live inside a request — so by the time a run knows
   * it failed, the flush has already happened. Appending to that store would put the row in a list
   * nothing will ever insert.
   */
  it("still records an event raised after the context was flushed, under the same gesture", async () => {
    let correlationId = "";
    await runWithActivity({ actor: { kind: "user", label: "Late" } }, async () => {
      correlationId = currentActivityStore()!.correlationId;
      record("client.created", { subjectLabel: "Before the flush" });
      // what `onResponse` does for a request
      await flushActivity({ outcome: "ok", tier1: false });
      record("client.archived", { subjectLabel: "After the flush" });
    });

    // the late write is fire-and-forget by design — recording must never make a caller wait, and
    // this one has no request left to hold anyway
    const rows = await waitFor(async () => {
      const found = await prisma.activityEvent.findMany({
        where: { actorLabel: "Late" },
        orderBy: { occurredAt: "asc" },
      });
      return found.length === 2 ? found : null;
    }, "the row written after the flush");
    expect(rows.map((r) => r.action)).toEqual(["client.created", "client.archived"]);
    // the late row keeps the gesture it belongs to, so the screen still shows one entry
    expect(rows[1].correlationId).toBe(correlationId);
    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Late" } });
  });
});

/**
 * **The lifecycle split, which is the one thing the second wave could get subtly wrong.**
 *
 * Sixteen task events came out of one `updateTask`, and the risk is not that a row is missing — the
 * producer test catches that — but that the WRONG one fires: an edit recorded as a completion, or a
 * completion recorded twice because it also moved a field. Each of these is one save.
 *
 * The wider guarantee is already load-bearing and needs no test of its own: `record()` throws under
 * test when a service passes a key the registry does not declare, so every module suite passing is
 * the assertion that every declaration matches the code that writes them.
 */
describe("one save, one lifecycle event", () => {
  let taskId: string;
  let columnId: string;

  beforeAll(async () => {
    const column = await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } });
    columnId = column.id;
    const priority = await prisma.priority.findFirstOrThrow();
    const task = await prisma.task.create({
      data: {
        title: "Activity lifecycle",
        kind: "free",
        priorityId: priority.id,
        statusColumnId: column.id,
      },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    await prisma.task.deleteMany({ where: { id: taskId } });
  });

  const actionsSince = async (since: Date) =>
    (
      await prisma.activityEvent.findMany({
        where: { subjectId: taskId, occurredAt: { gte: since } },
        orderBy: { occurredAt: "asc" },
      })
    ).map((r) => r.action);

  it("records a field edit as an edit and nothing else", async () => {
    const before = new Date();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { title: "Activity lifecycle, renamed" },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(async () => {
      const rows = await actionsSince(before);
      return rows.length > 0 ? rows : null;
    }, "the task edit");
    expect(await actionsSince(before)).toEqual(["task.updated"]);
  });

  it("records completing as a completion, with no empty edit beside it", async () => {
    const before = new Date();
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { done: true },
    });
    const rows = await waitFor(async () => {
      const found = await actionsSince(before);
      return found.length > 0 ? found : null;
    }, "the completion");
    // `task.updated` carries a diff of the ordinary fields and none of them moved, so §4.2's
    // empty-diff rule drops it — leaving exactly the fact a person was looking for
    expect(rows).toEqual(["task.completed"]);
  });

  it("records reopening, and a column move only when the column actually changed", async () => {
    const before = new Date();
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { done: false, statusColumnId: columnId },
    });
    const rows = await waitFor(async () => {
      const found = await actionsSince(before);
      return found.length > 0 ? found : null;
    }, "the reopen");
    // the column was sent but is the one it was already in — a save is not a move
    expect(rows).toEqual(["task.reopened"]);
  });
});

/**
 * **What the audit of 2026-09-08 found, held so it cannot come back.**
 *
 * Each of these is a defect that shipped, passed every test in this file, and was invisible from
 * the outside — which is the only kind worth writing a test for after the fact.
 */
describe("the three the audit caught", () => {
  it("records a job's own failure as a failure, not as a success", async () => {
    /**
     * `runWithActivity` flushed with a hard-coded `outcome: "ok"`, and the scheduler catches its
     * own errors INSIDE that wrapper — so `system.job_failed`, `mailbox.read_failed` and
     * `campaign.fire_failed` were all written as successful. The screen marks a problem row from
     * `outcome`, so the one column that says "look at this" said there was nothing to look at.
     */
    await runWithActivity({ actor: { kind: "system", label: "The scheduler" } }, async () => {
      record("system.job_failed", {
        outcome: "failed",
        subjectLabel: "nightly-thing",
        changes: { job: "nightly-thing", error: "boom" },
      });
    });
    const row = await prisma.activityEvent.findFirstOrThrow({
      where: { action: "system.job_failed" },
      orderBy: { occurredAt: "desc" },
    });
    expect(row.outcome).toBe("failed");
    await prisma.activityEvent.deleteMany({ where: { action: "system.job_failed" } });
  });

  it("captures a change of lead source, which the diff could never see", async () => {
    /**
     * `client.updated` declared `sourceId`, but the diff was taken over `toClientFields(input)`,
     * which turns that field into a Prisma relation write (`source: { connect }`). The key was
     * never `in` the object being diffed, so a source change produced no row — silently, for every
     * such edit, with the registry test passing because it only checks static shape.
     */
    const source = await prisma.sourceOption.findFirstOrThrow();
    const client = await prisma.client.create({
      data: { firstName: "Source", lastName: "Probe" },
    });
    const before = new Date();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clients/${client.id}`,
      headers: { cookie: adminCookie },
      payload: { sourceId: source.id },
    });
    expect(res.statusCode).toBe(200);

    const row = await waitFor(
      () =>
        prisma.activityEvent.findFirst({
          where: {
            action: "client.updated",
            subjectId: client.id,
            occurredAt: { gte: before },
          },
        }),
      "the source change",
    );
    // the NAME, not the id: a diff reading `sourceId … → 1f2e…` told a reader that something
    // changed and nothing about what, which is what production showed on 2026-09-09
    expect(row.changes).toEqual({ source: { from: null, to: source.name } });

    await prisma.activityEvent.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  });

  /**
   * §12 rule 1 — "it must not become a way to read what a gate closed" — was true only because the
   * `activity` gate ships shut for everyone but an admin. The moment a firm opens it to a lead,
   * which is the entire reason the gate exists, every client name in the log was readable by
   * somebody whose client list is closed.
   */
  it("hides the subjects a reader's own gates close", async () => {
    await runWithActivity({ actor: { kind: "user", label: "Gated" } }, async () => {
      record("client.created", { subjectLabel: "A client name" });
      record("user.blocked", {
        subjectLabel: "A colleague",
        changes: { status: { from: "active", to: "blocked" } },
      });
    });

    // open the log for a plain user, and leave their clients gate shut
    for (const [gate, state] of [
      ["activity", "open"],
      ["clients", "closed"],
    ] as const) {
      await prisma.accessPolicy.upsert({
        where: { gate_role_action: { gate, role: "user", action: "*" } },
        update: { state },
        create: { gate, role: "user", state },
      });
    }
    invalidateAccessCache();

    const res = await app.inject({
      method: "GET",
      url: "/api/activity?q=A ",
      headers: { cookie: userCookie },
    });
    expect(res.statusCode).toBe(200);
    const seen = (res.json() as { entries: { rows: { action: string }[] }[] }).entries
      .flatMap((e) => e.rows.map((r) => r.action))
      .filter((a) => a === "client.created" || a === "user.blocked");

    // `team` is admin-fixed, so a user cannot see `user.*` either — what is left is nothing
    expect(seen).toEqual([]);

    // and an admin, whose gates are open, sees both
    const asAdmin = await app.inject({
      method: "GET",
      url: "/api/activity?q=A ",
      headers: { cookie: adminCookie },
    });
    const adminSees = (
      asAdmin.json() as { entries: { rows: { action: string }[] }[] }
    ).entries.flatMap((e) => e.rows.map((r) => r.action));
    expect(adminSees).toContain("client.created");

    await prisma.accessPolicy.deleteMany();
    invalidateAccessCache();
    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Gated" } });
  });
});

describe("what the second review caught", () => {
  /**
   * The pager's total is capped on purpose — an exact count of a two-year log costs a scan of every
   * matching gesture on every page load. Deriving "is there more" from that ceiling made the Next
   * button die AT the ceiling: page 80 of a log with ten thousand gestures, and everything older
   * unreachable on the one screen built to reach it.
   *
   * Proved with three gestures and a page size of one, which tests the mechanism rather than the
   * number: `hasMore` has to come from the page, so it stays true past the last page only when the
   * page itself says so.
   */
  it("knows there is another page from the page, not from the capped total", async () => {
    for (const name of ["Pager one", "Pager two", "Pager three"]) {
      await runWithActivity({ actor: { kind: "user", label: "Pager" } }, async () => {
        record("client.created", { subjectLabel: name });
      });
    }
    const page = async (n: number) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/activity?q=Pager&pageSize=1&page=${n}`,
        headers: { cookie: adminCookie },
      });
      return res.json() as { entries: unknown[]; hasMore: boolean };
    };
    expect((await page(1)).hasMore).toBe(true);
    expect((await page(2)).hasMore).toBe(true);
    expect((await page(3)).hasMore).toBe(false);
    expect((await page(3)).entries).toHaveLength(1);

    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Pager" } });
  });

  /**
   * `subject` and `group` are independent query params. The group branch used to assign over the
   * subject narrowing instead of intersecting with it, so "just `client` events, within the clients
   * group" quietly returned every subject in the group.
   */
  it("lets a group narrow a chosen subject rather than replace it", async () => {
    /**
     * Two SEPARATE gestures. A filter selects gestures and a selected gesture comes back whole
     * (§6), so putting both records in one would prove nothing about the subject filter — it would
     * only re-prove that an entry is not shown half of itself.
     */
    await runWithActivity({ actor: { kind: "user", label: "Narrow" } }, async () => {
      record("client.created", { subjectLabel: "A client" });
    });
    await runWithActivity({ actor: { kind: "user", label: "Narrow" } }, async () => {
      record("company.deleted", { subjectLabel: "A company", changes: { name: "A company" } });
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/activity?q=Narrow&group=clients&subject=company",
      headers: { cookie: adminCookie },
    });
    const seen = (res.json() as { entries: { rows: { subject: string }[] }[] }).entries.flatMap(
      (e) => e.rows.map((r) => r.subject),
    );
    // both subjects are in the `clients` group; only the one asked for may come back
    expect([...new Set(seen)]).toEqual(["company"]);

    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Narrow" } });
  });

  /** The client's name is snapshotted at write time, so it survives the client being wiped. */
  it("keeps the client's name after the client is gone", async () => {
    const client = await prisma.client.create({
      data: { firstName: "Ghost", lastName: "Client" },
    });
    await runWithActivity({ actor: { kind: "user", label: "Snapshot" } }, async () => {
      record("invoice.issued", {
        subjectLabel: "INV-GHOST",
        clientId: client.id,
        changes: { amount: 1 },
      });
    });
    await prisma.client.delete({ where: { id: client.id } });

    const row = await prisma.activityEvent.findFirstOrThrow({
      where: { actorLabel: "Snapshot" },
    });
    // the client no longer exists; the row still says whose invoice it was
    expect(row.clientLabel).toBe("Ghost Client");
    expect(row.clientId).toBe(client.id);

    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Snapshot" } });
  });
});

describe("what the third audit caught (2026-09-09)", () => {
  /**
   * **§12 rule 1 was enforced on the SUBJECT and nowhere else.**
   *
   * `clientId`/`clientLabel` are denormalised onto rows of every subject — a task, an invoice, a
   * downloaded file all carry whose they were, which is what makes the client card's tab one query.
   * So a reader with `tasks` open and `clients` closed met no `client.*` event and read the client
   * book anyway, one name per task row. It only became reachable when the log got a gate of its own,
   * which is the case that gate exists for.
   */
  it("withholds the client's name from a reader whose Clients gate is shut", async () => {
    const client = await prisma.client.create({
      data: { firstName: "Hidden", lastName: "Person" },
    });
    await runWithActivity({ actor: { kind: "user", label: "Containment" } }, async () => {
      // a TASK event, deliberately: the subject filter lets this reader see it
      record("task.created", {
        subjectLabel: "Prepare the return",
        clientId: client.id,
        // `task.created` declares changeKeys, and an event that declares them writes nothing
        // without a diff — the rule that suppresses a save which moved nothing
        changes: { kind: "once" },
      });
    });

    // the log is theirs to read; the client book is not
    // upsert, not createMany: `ensureBaseData` has already seeded `activity` closed for a user, and
    // skipDuplicates would leave it that way
    for (const [gate, state] of [
      ["activity", "open"],
      ["clients", "closed"],
    ] as const) {
      await prisma.accessPolicy.upsert({
        where: { gate_role_action: { gate, role: "user", action: "*" } },
        update: { state },
        create: { gate, role: "user", state },
      });
    }
    invalidateAccessCache();

    const res = await app.inject({
      method: "GET",
      url: "/api/activity?q=Containment",
      headers: { cookie: userCookie },
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as {
      entries: { rows: { action: string; clientLabel: string | null }[] }[];
    };
    const rows = page.entries.flatMap((e) => e.rows);
    expect(rows.some((r) => r.action === "task.created")).toBe(true);
    expect(
      rows.map((r) => r.clientLabel),
      "a closed Clients gate must not be readable one task row at a time",
    ).not.toContain("Hidden Person");

    // an admin, whose gate is open, still sees whose it was
    const asAdmin = await app.inject({
      method: "GET",
      url: "/api/activity?q=Containment",
      headers: { cookie: adminCookie },
    });
    const adminRows = (
      asAdmin.json() as { entries: { rows: { clientLabel: string | null }[] }[] }
    ).entries.flatMap((e) => e.rows);
    expect(adminRows.map((r) => r.clientLabel)).toContain("Hidden Person");

    await prisma.accessPolicy.deleteMany({ where: { gate: { in: ["activity", "clients"] } } });
    invalidateAccessCache();
    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Containment" } });
    await prisma.client.delete({ where: { id: client.id } });
  });

  /**
   * **The dedupe window is keyed by the row's own identity, not by a second field beside it.**
   *
   * It used to match a caller-supplied `dedupeValue` against the `subjectLabel` COLUMN. Four call
   * sites passed the same string twice; `subscription.generation_failed` passed the subscription's
   * id while writing the service's name as its label, so the lookup asked for a row that could not
   * exist and the window never matched — a subscription failing to bill wrote a fresh row every
   * single run.
   */
  it("dedupes two failures of the same thing, and not of different things", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const write = (subjectId: string, label: string) =>
      runWithActivity({ actor: { kind: "system", label: "Dedupe" } }, async () => {
        record("subscription.generation_failed", {
          outcome: "failed",
          subjectId,
          // the label is the SERVICE's name — deliberately not the identity, which is the shape
          // that broke the old keying
          subjectLabel: label,
          changes: { error: "boom" },
        });
      });

    await write(a, "Payroll");
    await write(a, "Payroll");
    await write(b, "Payroll");

    const rows = await prisma.activityEvent.findMany({
      where: { actorLabel: "Dedupe", action: "subscription.generation_failed" },
      select: { subjectId: true },
    });
    expect(rows.map((r) => r.subjectId).sort()).toEqual([a, b].sort());

    await prisma.activityEvent.deleteMany({ where: { actorLabel: "Dedupe" } });
  });
});
