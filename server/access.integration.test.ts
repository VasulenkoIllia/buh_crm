import argon2 from "argon2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GATE_KEYS, type AccessState, type GateKey } from "@shared/access.js";
import { buildApp } from "./app.js";
import { prisma } from "./core/db.js";
import { invalidateAccessCache } from "./core/access.js";
import { finalizeInventory } from "./core/route-inventory.js";

/**
 * **What the switches actually do.**
 *
 * `access-parity.test.ts` proves the shipped defaults reproduce the old guards. This proves the
 * switches themselves: that `closed` refuses, that `read_only` refuses only changes, that one
 * person's override beats their role in BOTH directions, that the reads the whole app is built on
 * survive every gate being shut, and that a gate is never consulted by a service — completing a
 * billable job still bills it when Billing is closed for whoever pressed the button.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let userCookie: string;
let adminId: string;
let userId: string;

/**
 * What the two seam tests below create, so it can be taken back out.
 *
 * This suite shares one database with every other, and it is the only one that issues a real
 * INVOICE. `Invoice.clientId` is ON DELETE RESTRICT, so a client left behind here breaks the next
 * suite that does a blanket `client.deleteMany()` — which is what happened the first time, three
 * files later and with an error naming neither this suite nor its client.
 */
const createdClients: string[] = [];
const createdServices: string[] = [];

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
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

/** Set a role's state for one gate and drop the request-path cache. */
async function policy(gate: GateKey, state: AccessState, role: "admin" | "user" = "user") {
  await prisma.accessPolicy.upsert({
    where: { gate_role_action: { gate, role, action: "*" } },
    update: { state },
    create: { gate, role, state },
  });
  invalidateAccessCache();
}

async function override(gate: GateKey, state: AccessState, forUserId = userId) {
  await prisma.accessOverride.upsert({
    where: { userId_gate_action: { userId: forUserId, gate, action: "*" } },
    update: { state },
    create: { userId: forUserId, gate, state },
  });
  invalidateAccessCache();
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.accessOverride.deleteMany();
  await prisma.accessPolicy.deleteMany();
  await prisma.userRoleAuditLog.deleteMany();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: "@access.local" } } });

  const passwordHash = await argon2.hash("password-123");
  const admin = await prisma.user.create({
    data: {
      firstName: "Ada",
      lastName: "Admin",
      email: "ada@access.local",
      passwordHash,
      role: "admin",
      status: "active",
    },
  });
  const user = await prisma.user.create({
    data: {
      firstName: "Ulf",
      lastName: "User",
      email: "ulf@access.local",
      passwordHash,
      role: "user",
      status: "active",
    },
  });
  adminId = admin.id;
  userId = user.id;
  adminCookie = await login("ada@access.local");
  userCookie = await login("ulf@access.local");
});

beforeEach(async () => {
  await prisma.accessOverride.deleteMany();
  await prisma.accessPolicy.deleteMany();
  invalidateAccessCache();
});

afterAll(async () => {
  if (createdClients.length > 0) {
    await prisma.invoiceLine.deleteMany({
      where: { invoice: { clientId: { in: createdClients } } },
    });
    await prisma.invoice.deleteMany({ where: { clientId: { in: createdClients } } });
    await prisma.task.deleteMany({ where: { clientId: { in: createdClients } } });
    await prisma.subscriptionPeriod.deleteMany({
      where: { subscription: { clientId: { in: createdClients } } },
    });
    await prisma.subscription.deleteMany({ where: { clientId: { in: createdClients } } });
    await prisma.client.deleteMany({ where: { id: { in: createdClients } } });
  }
  if (createdServices.length > 0) {
    await prisma.taskTemplate.deleteMany({ where: { serviceId: { in: createdServices } } });
    await prisma.service.deleteMany({ where: { id: { in: createdServices } } });
  }
  await prisma.accessOverride.deleteMany();
  await prisma.accessPolicy.deleteMany();
  await prisma.userRoleAuditLog.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: "@access.local" } } });
  await app?.close();
});

/**
 * Names are unique per run. This suite shares a database with the others and cannot wipe the
 * catalog on the way in — an issued invoice holds its service with ON DELETE RESTRICT — so a
 * fixed name would 409 on the second run and fail three steps later with an unreadable error.
 */
const RUN = Math.random().toString(36).slice(2, 8);

const asUser = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: userCookie }, ...(payload ? { payload } : {}) });

describe("the three states", () => {
  it("open allows reading and writing", async () => {
    await policy("leads", "open");
    expect((await asUser("GET", "/api/leads/stages")).statusCode).toBe(200);
    // a write that fails validation still got PAST the gate — 400, not 403
    expect((await asUser("POST", "/api/leads", {})).statusCode).toBe(400);
  });

  it("read_only allows GET and refuses every change", async () => {
    await policy("leads", "read_only");
    expect((await asUser("GET", "/api/leads/stages")).statusCode).toBe(200);
    const write = await asUser("POST", "/api/leads", { name: "Nope" });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toMatchObject({
      code: "module_closed",
      details: { gate: "leads", state: "read_only" },
    });
  });

  it("closed refuses reads as well as writes", async () => {
    await policy("leads", "closed");
    const read = await asUser("GET", "/api/leads/stages");
    expect(read.statusCode).toBe(403);
    expect(read.json().error).toMatchObject({
      code: "module_closed",
      details: { gate: "leads", state: "closed" },
    });
    expect((await asUser("POST", "/api/leads", { name: "Nope" })).statusCode).toBe(403);
  });

  /**
   * A closed area is not the generic forbidden. The SPA has to tell it apart from the Origin-check
   * 403 and from an ownership refusal, so that a person closed out mid-session — the me-query has
   * a five-minute staleTime — meets "this area was closed" rather than "something went wrong".
   */
  it("refuses with module_closed, never the generic forbidden", async () => {
    await policy("billing", "closed");
    expect((await asUser("GET", "/api/invoices")).json().error.code).toBe("module_closed");
  });
});

describe("role, override and the absent row", () => {
  it("follows the role when the person has no override", async () => {
    await policy("billing", "closed");
    expect((await asUser("GET", "/api/invoices")).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/invoices", headers: { cookie: adminCookie } }))
        .statusCode,
    ).toBe(200);
  });

  it("lets one person's override CLOSE what their role opens", async () => {
    await policy("billing", "open");
    await override("billing", "closed");
    expect((await asUser("GET", "/api/invoices")).statusCode).toBe(403);
  });

  /**
   * The request that always arrives second: "everyone else keeps it shut, but she needs it". The
   * override carries a state rather than a closed marker precisely so this costs nothing.
   */
  it("lets one person's override RE-OPEN what their role closes", async () => {
    await policy("billing", "closed");
    await override("billing", "open");
    expect((await asUser("GET", "/api/invoices")).statusCode).toBe(200);
  });

  it("falls back to the registry default when no policy row exists at all", async () => {
    // nothing seeded — `services` defaults to read_only for a user
    expect((await asUser("GET", "/api/catalog")).statusCode).toBe(200);
    expect((await asUser("POST", "/api/catalog", { name: "X", type: "one_time" })).statusCode).toBe(
      403,
    );
  });
});

describe("the reference surface", () => {
  /**
   * The test that stops somebody gating the app shell by accident. Every `shared()` read must
   * answer with every switchable gate closed — `GET /api/settings` feeds the shell itself, and
   * `GET /api/catalog` has 19 call sites in six modules.
   */
  it("answers every shared() read with every gate closed", async () => {
    for (const gate of GATE_KEYS) await policy(gate, "closed");

    const shared = finalizeInventory(app.routeInventory)
      .filter((r) => !r.derived && r.method === "GET" && r.access === "shared")
      .map((r) => r.url)
      // the parameterised ones need a real id; they are covered by their own modules' suites
      .filter((u) => !u.includes(":"));

    expect(shared.length).toBeGreaterThan(3);
    for (const url of shared) {
      const res = await asUser("GET", url);
      expect([200, 404], `${url} answered ${res.statusCode} with every gate closed`).toContain(
        res.statusCode,
      );
    }
  });

  it("never gates a person out of their own profile or their own tray", async () => {
    for (const gate of GATE_KEYS) await policy(gate, "closed");
    expect((await asUser("GET", "/api/auth/me")).statusCode).toBe(200);
    expect((await asUser("GET", "/api/notifications")).statusCode).toBe(200);
    expect((await asUser("GET", "/api/notifications/preferences")).statusCode).toBe(200);
    expect((await asUser("GET", "/api/tasks/timer/active")).statusCode).toBe(200);
  });
});

describe("what the hook does not decide", () => {
  /**
   * **The seam.** The hook is at the boundary and services never read a gate, so money the system
   * decided to bill does not depend on who happened to press the button.
   */
  it("still issues a completed job's invoice when Billing is closed for the person closing it", async () => {
    await policy("billing", "closed");
    await policy("services", "open");
    await policy("clients", "open");
    await policy("tasks", "open");

    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { firstName: `Seam ${RUN}`, lastName: "Access", companies: [], people: [] },
    });
    const clientId = client.json().id;
    createdClients.push(clientId);
    const service = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: `Access Seam Job ${RUN}`, type: "one_time", invoiceTrigger: "on_complete" },
    });
    createdServices.push(service.json().id);
    const subscription = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: service.json().id, amount: 4200 },
    });
    const subscriptionId = subscription
      .json()
      .subscriptions.find((s: { serviceId: string }) => s.serviceId === service.json().id).id;
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: `Seam job ${RUN}`, clientId, subscriptionId, assignees: [userId] },
    });

    // the plain user cannot open Billing at all …
    expect((await asUser("GET", "/api/invoices")).statusCode).toBe(403);
    // … and completing the job still bills it
    const done = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.json().id}`,
      headers: { cookie: userCookie },
      payload: { done: true },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().invoice).toMatchObject({ amount: 4200 });
  });

  /**
   * The single sanctioned place a gate is read outside the hook. Refusing the whole calendar
   * because Tasks is closed would take the meetings down with the overlay, so the overlay is
   * simply not projected — a decision about what to draw, not about who may call.
   */
  it("drops the deadline overlay from the calendar when Tasks is closed, and keeps the meetings", async () => {
    await policy("calendar", "open");
    await policy("clients", "open");
    await policy("tasks", "open");

    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { firstName: `Overlay ${RUN}`, lastName: "Access", companies: [], people: [] },
    });
    createdClients.push(client.json().id);
    const service = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: `Access Overlay ${RUN}`, type: "one_time", invoiceTrigger: "on_create" },
    });
    createdServices.push(service.json().id);
    const subscription = await app.inject({
      method: "POST",
      url: `/api/clients/${client.json().id}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: service.json().id, amount: 100 },
    });
    await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: `Overlay deadline ${RUN}`,
        clientId: client.json().id,
        subscriptionId: subscription
          .json()
          .subscriptions.find((s: { serviceId: string }) => s.serviceId === service.json().id).id,
        assignees: [userId],
        deadline: "2026-07-15",
      },
    });

    const range = "?from=2026-07-01&to=2026-07-31&meetings=true&deadlines=true";
    const open = await asUser("GET", `/api/calendar${range}`);
    expect(open.statusCode).toBe(200);
    expect(open.json().deadlines.length).toBeGreaterThan(0);

    await policy("tasks", "closed");
    const closed = await asUser("GET", `/api/calendar${range}`);
    expect(closed.statusCode).toBe(200); // the calendar itself still opens
    expect(closed.json().deadlines).toEqual([]);
  });
});

describe("the rules that are not switches", () => {
  it("keeps Team admin-only however the policy table is written", async () => {
    // `team` is fixedAdmin: a row for it is ignored rather than obeyed
    await prisma.accessPolicy.create({ data: { gate: "team", role: "user", state: "open" } });
    await override("team", "open");
    invalidateAccessCache();
    expect((await asUser("GET", "/api/users")).statusCode).toBe(403);
  });

  it("refuses an admin-only action inside a gate that is open to everyone", async () => {
    await policy("tasks", "open");
    // the board's shape is admin-managed; the board itself is not
    expect((await asUser("GET", "/api/tasks/columns")).statusCode).toBe(200);
    const write = await asUser("POST", "/api/tasks/columns", { name: "Mine" });
    expect(write.statusCode).toBe(403);
    // a role refusal inside an open area — its own code, distinct from a closed area and from
    // the ownership refusals the services throw
    expect(write.json().error.code).toBe("admin_only");
  });

  it("journals a role change, and only when the role actually moved", async () => {
    const target = await prisma.user.create({
      data: {
        firstName: "Rae",
        lastName: "Role",
        email: "rae@access.local",
        role: "user",
        status: "active",
      },
    });
    const promoted = await app.inject({
      method: "PATCH",
      url: `/api/users/${target.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "admin" },
    });
    expect(promoted.statusCode).toBe(200);
    expect(
      await prisma.userRoleAuditLog.findFirstOrThrow({ where: { userId: target.id } }),
    ).toMatchObject({ byUserId: adminId, fromRole: "user", toRole: "admin" });

    // saving the form with the role untouched is not a role change
    await app.inject({
      method: "PATCH",
      url: `/api/users/${target.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "admin" },
    });
    expect(await prisma.userRoleAuditLog.count({ where: { userId: target.id } })).toBe(1);

    await prisma.userRoleAuditLog.deleteMany({ where: { userId: target.id } });
    await prisma.user.delete({ where: { id: target.id } });
  });
});

describe("the session payload", () => {
  it("carries the caller's answer for every gate", async () => {
    await policy("billing", "closed");
    await policy("services", "read_only");
    const me = (await asUser("GET", "/api/auth/me")).json();
    expect(Object.keys(me.access).sort()).toEqual([...GATE_KEYS].sort());
    expect(me.access.billing).toBe("closed");
    expect(me.access.services).toBe("read_only");
    expect(me.access.team).toBe("closed"); // fixed admin
  });

  /**
   * The Archive owns no routes — it is a view over three modules — so it is derived rather than
   * stored: with all three shut there is nothing behind the screen to open, and a sidebar item
   * promising otherwise would be a lie the app cannot keep.
   */
  it("derives the Archive from Clients, Leads and Tasks", async () => {
    await policy("archive", "open");
    await policy("clients", "closed");
    await policy("leads", "closed");
    await policy("tasks", "open");
    expect((await asUser("GET", "/api/auth/me")).json().access.archive).toBe("open");

    await policy("tasks", "closed");
    expect((await asUser("GET", "/api/auth/me")).json().access.archive).toBe("closed");
  });
});

describe("the access screen's own API", () => {
  it("is admin-only, because it is behind the Team gate", async () => {
    expect((await asUser("GET", "/api/access")).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/access", headers: { cookie: adminCookie } }))
        .statusCode,
    ).toBe(200);
  });

  it("hands back roles, exceptions and the people who could have one", async () => {
    await policy("billing", "closed");
    await override("billing", "open");
    const table = (
      await app.inject({ method: "GET", url: "/api/access", headers: { cookie: adminCookie } })
    ).json();
    expect(table.policies).toContainEqual({ gate: "billing", role: "user", state: "closed" });
    expect(table.overrides).toContainEqual({ userId, gate: "billing", state: "open" });
    expect(table.people.map((p: { id: string }) => p.id)).toContain(userId);
  });

  it("writes a policy, and the very next request obeys it", async () => {
    expect((await asUser("GET", "/api/invoices")).statusCode).toBe(200);
    const res = await app.inject({
      method: "PUT",
      url: "/api/access/policies/billing/user",
      headers: { cookie: adminCookie },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(200);
    // no waiting for a cache to expire — the write drops it
    expect((await asUser("GET", "/api/invoices")).statusCode).toBe(403);
  });

  it("clears an override back to “follow the role”", async () => {
    await policy("billing", "closed");
    await app.inject({
      method: "PUT",
      url: `/api/access/overrides/${userId}/billing`,
      headers: { cookie: adminCookie },
      payload: { state: "open" },
    });
    expect((await asUser("GET", "/api/invoices")).statusCode).toBe(200);

    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/access/overrides/${userId}/billing`,
      headers: { cookie: adminCookie },
    });
    expect(cleared.statusCode).toBe(200);
    expect((await asUser("GET", "/api/invoices")).statusCode).toBe(403);
  });

  /**
   * A state written past the screen would be obeyed by the hook without ever having been offered
   * to anybody. Most gates do not offer `read_only` yet — not because the hook cannot enforce it,
   * but because their screens still draw every write button, and a switch that turns buttons into
   * 403s is worse than no switch.
   */
  it("refuses a state the gate does not offer, and any state at all for Team", async () => {
    const readOnlyTasks = await app.inject({
      method: "PUT",
      url: "/api/access/policies/tasks/user",
      headers: { cookie: adminCookie },
      payload: { state: "read_only" },
    });
    expect(readOnlyTasks.statusCode).toBe(400);

    const team = await app.inject({
      method: "PUT",
      url: "/api/access/policies/team/user",
      headers: { cookie: adminCookie },
      payload: { state: "open" },
    });
    expect(team.statusCode).toBe(400);

    // Services genuinely has a read-only screen, so it takes the state
    const services = await app.inject({
      method: "PUT",
      url: "/api/access/policies/services/user",
      headers: { cookie: adminCookie },
      payload: { state: "read_only" },
    });
    expect(services.statusCode).toBe(200);
  });

  it("refuses a gate the registry has never heard of", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/access/policies/payroll/user",
      headers: { cookie: adminCookie },
      payload: { state: "closed" },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * **The rules that were already there, and are not access rules.**
 *
 * The question this block answers is the one asked before the production deploy: what happened to
 * the old restrictions? Most of them were never about roles at all — "an invoice cannot be cut
 * below what has already been paid" is a fact about money, enforced in `payments.service.ts` for
 * whoever gets that far, and no gate state can turn it off. Confusing the two is the easiest way
 * to read this release as more dangerous than it is, so the distinction is asserted here rather
 * than described in a document.
 *
 * Three layers, and a request passes through them in this order:
 *   1. the gate      — may this person open this area at all (the hook)
 *   2. the role      — inside an open area, is this action admin-only (the hook, `adminOnly`)
 *      or is it theirs (an ownership check in the service)
 *   3. the rule      — is this a thing anybody may do to this record (the service, unchanged)
 */
describe("the rules that were already there", () => {
  let clientId: string;
  let invoiceId: string;

  beforeAll(async () => {
    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      headers: { cookie: adminCookie },
      payload: { firstName: `Rules ${RUN}`, lastName: "Access", companies: [], people: [] },
    });
    clientId = client.json().id;
    createdClients.push(clientId);
    const service = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: `Access Rules ${RUN}`, type: "one_time", invoiceTrigger: "on_create" },
    });
    createdServices.push(service.json().id);
    const invoice = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: adminCookie },
      payload: {
        clientId,
        serviceId: service.json().id,
        amount: 50_000,
        description: "Access rules check",
      },
    });
    expect(invoice.statusCode).toBe(201);
    invoiceId = invoice.json().id;
  });

  /**
   * **Money.** A plain user may still record a payment — that has never been admin-only, and the
   * guardrail was always that only an admin can go back and change one. Both halves survive.
   */
  it("lets a plain user record a payment and refuses them the correction", async () => {
    const paid = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoiceId}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 20_000, paidAt: "2026-07-20" },
    });
    expect(paid.statusCode).toBe(201);
    expect(paid.json()).toMatchObject({ paid: 20_000, balance: 30_000, status: "partial" });

    // editing the invoice, editing the payment, deleting it, cancelling, reading the journal
    const paymentId = paid.json().payments[0].id;
    for (const [method, url] of [
      ["PATCH", `/api/invoices/${invoiceId}`],
      ["POST", `/api/invoices/${invoiceId}/cancel`],
      ["GET", `/api/invoices/${invoiceId}/audit`],
      ["PATCH", `/api/invoices/payments/${paymentId}`],
      ["DELETE", `/api/invoices/payments/${paymentId}`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: userCookie },
        ...(method === "PATCH" ? { payload: { amount: 60_000 } } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      // a ROLE refusal inside an open area — not "this area is closed"
      expect(res.json().error.code, `${method} ${url}`).toBe("admin_only");
    }
  });

  /**
   * **The rule no role can lift.** Not an access rule at all: an admin gets past the hook and is
   * still refused, because the money is already taken.
   */
  it("refuses to cut an invoice below what has already been paid — for an admin too", async () => {
    const tooLow = await app.inject({
      method: "PATCH",
      url: `/api/invoices/${invoiceId}`,
      headers: { cookie: adminCookie },
      payload: { amount: 10_000 },
    });
    expect(tooLow.statusCode).toBe(400);
    expect(tooLow.json().error.message).toMatch(/already been paid/i);

    // and cancelling one that has payments on it is refused the same way
    const cancel = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoiceId}/cancel`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(cancel.statusCode).toBe(400);
    expect(cancel.json().error.message).toMatch(/delete the payments/i);
  });

  /**
   * **Time.** Three different rules that all used to look like "admin", and are now three
   * different things: your own timer is yours, adding time on somebody ELSE'S behalf is admin,
   * and correcting an entry is ownership.
   */
  it("keeps the three time rules apart", async () => {
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: `Rules task ${RUN}`, assignees: [userId] },
    });
    expect(task.statusCode).toBe(201);
    const taskId = task.json().id;

    // 1. a plain user tracks their own time — always could
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tasks/timer/start",
          headers: { cookie: userCookie },
          payload: { taskId },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tasks/timer/stop",
          headers: { cookie: userCookie },
          payload: { comment: "Worked on it" },
        })
      ).statusCode,
    ).toBe(200);

    // 2. writing an entry ON SOMEBODY ELSE'S behalf is still admin
    const forSomeoneElse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/time`,
      headers: { cookie: userCookie },
      payload: { userId: adminId, minutes: 30, comment: "Not mine to write" },
    });
    expect(forSomeoneElse.statusCode).toBe(403);
    expect(forSomeoneElse.json().error.code).toBe("admin_only");

    // 3. correcting an entry: own — yes (new), somebody else's — no
    const mine = await prisma.timeEntry.findFirstOrThrow({ where: { taskId, userId } });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/tasks/time/${mine.id}`,
          headers: { cookie: userCookie },
          payload: { minutes: 15 },
        })
      ).statusCode,
    ).toBe(200);

    const theirs = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/time`,
      headers: { cookie: adminCookie },
      payload: { userId: adminId, minutes: 30, comment: "Admin's own" },
    });
    const adminEntry = theirs
      .json()
      .timeEntries.find((e: { userId: string }) => e.userId === adminId);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/tasks/time/${adminEntry.id}`,
          headers: { cookie: userCookie },
          payload: { minutes: 90 },
        })
      ).statusCode,
    ).toBe(403);

    /**
     * **A running timer must survive its module closing.** Starting one is the `tasks` gate —
     * it writes against a task — but `active` and `stop` are the caller's own, deliberately: the
     * database holds a partial unique index of one running entry per person, so a timer stranded
     * by a gate closing mid-session would block that person from tracking anything ever again,
     * on any task, with no screen able to release it. The shell's timer bar is what stops it.
     */
    await app.inject({
      method: "POST",
      url: "/api/tasks/timer/start",
      headers: { cookie: userCookie },
      payload: { taskId },
    });
    await policy("tasks", "closed");
    expect((await asUser("GET", "/api/tasks/timer/active")).statusCode).toBe(200);
    const startWhileClosed = await asUser("POST", "/api/tasks/timer/start", { taskId });
    expect(startWhileClosed.statusCode).toBe(403);
    expect(startWhileClosed.json().error.code).toBe("module_closed");
    const stopWhileClosed = await asUser("POST", "/api/tasks/timer/stop", {
      comment: "Stopped after my access changed",
    });
    expect(stopWhileClosed.statusCode).toBe(200);
    await policy("tasks", "open");

    // the board's SHAPE stays admin, the board itself does not
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tasks/columns",
          headers: { cookie: userCookie },
          payload: { name: `Mine ${RUN}` },
        })
      ).statusCode,
    ).toBe(403);

    await prisma.timeEntryAuditLog.deleteMany({ where: { taskId } });
    await prisma.task.delete({ where: { id: taskId } });
  });

  /** Deleting a comment was already author-or-admin, and is untouched. */
  it("keeps comment deletion at author-or-admin", async () => {
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: `Rules comment ${RUN}`, assignees: [userId] },
    });
    const taskId = task.json().id;
    const mine = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { cookie: userCookie },
      payload: { body: "Mine" },
    });
    const theirs = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { cookie: adminCookie },
      payload: { body: "The admin's" },
    });
    const idOf = (res: { json: () => { comments: { id: string; body: string }[] } }, body: string) =>
      res.json().comments.find((c) => c.body === body)!.id;

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/tasks/comments/${idOf(theirs, "The admin's")}`,
          headers: { cookie: userCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/tasks/comments/${idOf(mine, "Mine")}`,
          headers: { cookie: userCookie },
        })
      ).statusCode,
    ).toBe(200);

    await prisma.task.delete({ where: { id: taskId } });
  });

  /**
   * **A rule the hook must not shadow.** Closing Billing for the person completing a billable job
   * does not stop the invoice being issued (covered above) — and the LIFECYCLE lock is likewise a
   * rule about the record, not about the person: once an invoice exists, nobody may re-price the
   * job, admin included.
   */
  it("keeps the priced-job lock, which is about the record and not the person", async () => {
    const service = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: `Access Lock ${RUN}`, type: "one_time", invoiceTrigger: "on_create" },
    });
    createdServices.push(service.json().id);
    const subscription = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: service.json().id, amount: 3_000 },
    });
    const job = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: `Locked job ${RUN}`,
        clientId,
        subscriptionId: subscription
          .json()
          .subscriptions.find((s: { serviceId: string }) => s.serviceId === service.json().id).id,
        assignees: [adminId],
      },
    });
    expect(job.json().invoice).not.toBeNull();

    const reprice = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${job.json().id}`,
      headers: { cookie: adminCookie },
      payload: { amount: 9_000 },
    });
    expect(reprice.statusCode).toBe(400);
    expect(reprice.json().error.message).toMatch(/already issued/i);
  });
});
