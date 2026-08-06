import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { config } from "../../core/config.js";
import { prisma } from "../../core/db.js";
import { generatePeriodInvoices } from "../payments/index.js";
import { generateSubscriptionTasks } from "../tasks/index.js";

/**
 * What archiving actually does — and, more to the point, what un-archiving does.
 *
 * The question this file answers came from the user (2026-08-03): archive a client with services,
 * tasks and invoices, leave them there for months, bring them back — what returns, and from what
 * date? A throwaway probe answered it before any of this was written, and the answer was bad: a
 * client archived six months came back with 6 tasks, every one of them already overdue, plus 2
 * auto-issued invoices and 5 reminders, for work nobody had done. The cause was that archiving
 * touched only `Client.archivedAt`; the subscription periods stayed open, so for the whole
 * archived stretch the database still said "we are serving this client", and both nightly sweeps
 * dutifully back-filled everything they had missed.
 *
 * So these tests pin the fix from both ends: the clock stops on archive, and restoring does not
 * start it again by itself.
 */

/** "YYYY-MM-DD" n days from today in the FIRM's timezone — the same day the server calls today. */
function dayIso(offset: number): string {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
}
const utcDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

const post = (url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

async function wipe() {
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.timeEntry.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.task.deleteMany();
  await prisma.taskTemplate.deleteMany();
  await prisma.subscriptionPeriod.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.clientPerson.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.service.deleteMany();
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await wipe();
  await prisma.user.deleteMany();

  await prisma.user.create({
    data: {
      firstName: "Archive",
      lastName: "Tester",
      email: "user@archive.local",
      passwordHash: await argon2.hash("password-123"),
      // admin so the catalog fixtures below can be created through the API
      role: "admin",
      status: "active",
    },
  });
  cookie = cookieOf(
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@archive.local", password: "password-123" },
    }),
  );
});

afterAll(async () => {
  await wipe();
  await app.close();
});

/** A subscription service whose template falls due every single day — the sweep's worst case. */
async function dailyService(name: string) {
  const svc = await post("/api/catalog", { name, type: "subscription" });
  const serviceId = svc.json().id as string;
  await post(`/api/catalog/${serviceId}/tasks`, {
    name: `${name} check`,
    periodicity: "weekly",
    dayOfPeriod: 1,
    deadlineOffsetDays: 0,
  });
  return serviceId;
}

/**
 * Move a client's archive and its subscription's period back by `days`, without inventing any
 * dates. A relative shift is the point: `NULL - interval` stays NULL, so a period archiving left
 * open stays open and the sweeps see months of coverage to catch up on.
 */
async function rewind(clientId: string, subscriptionId: string, days: number) {
  await prisma.$executeRawUnsafe(
    `UPDATE "Client" SET "archivedAt" = "archivedAt" - interval '${days} days' WHERE id = $1::uuid`,
    clientId,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "SubscriptionPeriod"
        SET "startsOn"   = "startsOn"   - interval '${days + 20} days',
            "endsBefore" = "endsBefore" - interval '${days} days'
      WHERE "subscriptionId" = $1::uuid`,
    subscriptionId,
  );
}

async function makeClient(firstName: string) {
  const res = await post("/api/clients", { firstName, companies: [], people: [] });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("archive — the clock stops", () => {
  it("archiving a client closes its subscription periods, last day served = the archive day", async () => {
    const serviceId = await dailyService("Archive stop");
    const clientId = await makeClient("Stopwatch");
    const sub = await post(`/api/clients/${clientId}/subscriptions`, {
      serviceId,
      amount: 10_000,
      period: "month",
    });
    expect(sub.statusCode).toBe(201);
    const subId = sub.json().subscriptions[0].id as string;
    expect(await prisma.subscriptionPeriod.findFirst({ where: { subscriptionId: subId } })).toMatchObject({
      endsBefore: null,
    });

    expect((await post(`/api/clients/${clientId}/archive`)).statusCode).toBe(200);

    const period = await prisma.subscriptionPeriod.findFirstOrThrow({ where: { subscriptionId: subId } });
    // exclusive end — "ends before tomorrow" is "served through today"
    expect(period.endsBefore?.toISOString().slice(0, 10)).toBe(dayIso(1));
    expect(period.endNote).toBe("Client archived");
  });

  it("drops a start agreed for later rather than leaving a period that ends before it begins", async () => {
    const serviceId = await dailyService("Archive scheduled");
    const clientId = await makeClient("Notyet");
    const sub = await post(`/api/clients/${clientId}/subscriptions`, {
      serviceId,
      amount: 10_000,
      period: "month",
      startsOn: dayIso(30),
    });
    const subId = sub.json().subscriptions[0].id as string;

    await post(`/api/clients/${clientId}/archive`);

    expect(await prisma.subscriptionPeriod.count({ where: { subscriptionId: subId } })).toBe(0);
  });

  // The back-fill itself is pinned by "leaves the services paused" below — WHILE archived, both
  // sweeps skip the client outright, so nothing here could tell a closed period from an open one.
  // This case guards the outer door; that one guards the door the probe actually found open.
  it("is invisible to both sweeps while archived", async () => {
    const serviceId = await dailyService("Archive backfill");
    const clientId = await makeClient("Backfill");
    const sub = await post(`/api/clients/${clientId}/subscriptions`, {
      serviceId,
      amount: 10_000,
      period: "month",
      invoiceTrigger: "on_period_start",
      invoiceDay: 1,
      dueDays: 7,
    });
    const subId = sub.json().subscriptions[0].id as string;
    await post(`/api/clients/${clientId}/archive`);

    // Rewind six months: same state, reached six months ago. Only the stored dates move, and the
    // sweeps read nothing else, so this is exactly equivalent to time having passed.
    //
    // The shift is relative and never writes an end date of its own — `NULL - interval` is still
    // NULL. That is deliberate: if archiving failed to close the period, this rewind leaves it
    // open and the sweeps below back-fill six months, which is the failure being pinned.
    await rewind(clientId, subId, 180);
    await prisma.taskTemplate.updateMany({ data: { createdAt: utcDay(dayIso(-300)) } });

    const tasksBefore = await prisma.task.count();
    const invoicesBefore = await prisma.invoice.count();
    await generateSubscriptionTasks();
    await generatePeriodInvoices();
    expect(await prisma.task.count()).toBe(tasksBefore);
    expect(await prisma.invoice.count()).toBe(invoicesBefore);
  });
});

describe("restore — history comes back, the clock does not restart", () => {
  let clientId: string;
  let subId: string;
  let taskId: string;

  it("sets the story up: a client with a task and an invoice, then archived", async () => {
    const serviceId = await dailyService("Restore me");
    clientId = await makeClient("Comeback");
    const sub = await post(`/api/clients/${clientId}/subscriptions`, {
      serviceId,
      amount: 10_000,
      period: "month",
    });
    subId = sub.json().subscriptions[0].id;

    const task = await post("/api/tasks", {
      title: "Work done before the archive",
      clientId,
      subscriptionId: subId,
      amount: 10_000,
      assignees: [],
    });
    expect(task.statusCode).toBe(201);
    taskId = task.json().id;

    await post(`/api/clients/${clientId}/archive`);
    // rewind, so the restore below has an archived stretch to (not) back-fill
    await rewind(clientId, subId, 180);
  });

  it("gives back exactly the tasks that were there — not one more", async () => {
    const before = await prisma.task.count({ where: { clientId } });

    const restored = await post(`/api/clients/${clientId}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().archivedAt).toBeNull();

    expect(await prisma.task.count({ where: { clientId } })).toBe(before);
    const board = await get("/api/tasks?view=board");
    expect(board.json().items.map((t: { id: string }) => t.id)).toContain(taskId);
  });

  it("leaves the services paused — resuming is a decision with a date on it", async () => {
    const client = await get(`/api/clients/${clientId}`);
    const service = client.json().subscriptions.find((s: { id: string }) => s.id === subId);
    expect(service).toMatchObject({ active: false, state: "paused" });

    // and no sweep quietly restarts it either
    const tasksBefore = await prisma.task.count();
    const invoicesBefore = await prisma.invoice.count();
    await generateSubscriptionTasks();
    await generatePeriodInvoices();
    expect(await prisma.task.count()).toBe(tasksBefore);
    expect(await prisma.invoice.count()).toBe(invoicesBefore);
  });

  it("starts generating again only from the day the service is resumed", async () => {
    const resumed = await post(`/api/clients/${clientId}/subscriptions/${subId}/resume`, {});
    expect(resumed.statusCode).toBe(200);
    const period = await prisma.subscriptionPeriod.findFirstOrThrow({
      where: { subscriptionId: subId, endsBefore: null },
    });
    expect(period.startsOn.toISOString().slice(0, 10)).toBe(dayIso(0));

    // nothing is dated before that day — no catching up on the months in the archive
    const generated = await prisma.task.findMany({
      where: { subscriptionId: subId, kind: "sub" },
      select: { deadline: true },
    });
    for (const t of generated) {
      expect(t.deadline == null || t.deadline >= utcDay(dayIso(-1))).toBe(true);
    }
  });

  it("refuses to restore a client who is not archived", async () => {
    const res = await post(`/api/clients/${clientId}/restore`);
    expect(res.statusCode).toBe(409);
  });
});

describe("archive — what each list shows", () => {
  it("archived clients appear only under tab=archived", async () => {
    const clientId = await makeClient("Listed");
    await post(`/api/clients/${clientId}/archive`);

    const live = await get("/api/clients?tab=all");
    expect(live.json().items.map((c: { id: string }) => c.id)).not.toContain(clientId);

    const archived = await get("/api/clients?tab=archived");
    const ids = archived.json().items.map((c: { id: string }) => c.id);
    expect(ids).toContain(clientId);
    expect(archived.json().items.every((c: { archivedAt: string | null }) => c.archivedAt)).toBe(true);
  });

  it("archived tasks appear only under archived=true, including an archived client's", async () => {
    const clientId = await makeClient("TaskOwner");
    // attribution-only internal work: names the client, goes through no service
    const own = await post("/api/tasks", {
      title: "Archive me",
      clientId,
      internal: true,
      assignees: [],
    });
    expect(own.statusCode).toBe(201);
    const taskId = own.json().id as string;
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
      payload: { done: true },
    });
    expect((await post(`/api/tasks/${taskId}/archive`)).statusCode).toBe(200);

    const board = await get("/api/tasks?view=board&status=all");
    expect(board.json().items.map((t: { id: string }) => t.id)).not.toContain(taskId);

    const archived = await get("/api/tasks?view=table&archived=true");
    expect(archived.json().items.map((t: { id: string }) => t.id)).toContain(taskId);

    // now archive the client too — the task must still be findable in the Archive
    await post(`/api/clients/${clientId}/archive`);
    const stillThere = await get("/api/tasks?view=table&archived=true");
    expect(stillThere.json().items.map((t: { id: string }) => t.id)).toContain(taskId);

    // …but it cannot come back on its own, into a client nobody can open
    const restore = await post(`/api/tasks/${taskId}/restore`);
    expect(restore.statusCode).toBe(409);
    expect(restore.json().error.message).toContain("restore the client");

    // restore the client and the task can follow
    await post(`/api/clients/${clientId}/restore`);
    expect((await post(`/api/tasks/${taskId}/restore`)).statusCode).toBe(200);
    const back = await get("/api/tasks?view=board&status=all");
    expect(back.json().items.map((t: { id: string }) => t.id)).toContain(taskId);
  });
});

describe("archive — a lead's work goes with it", () => {
  /**
   * Leads only became archivable in S11. Until then `Lead.archivedAt` was a column nothing wrote,
   * so the board's filter — which excluded an archived CLIENT's tasks but never a lead's — was
   * dormant and harmless. Making leads archivable turned it into a visible card that answers 404
   * when clicked: the exact broken state the client-side fix exists to prevent.
   */
  it("takes the lead's tasks off the board, and out of the deadline projection", async () => {
    const lead = await post("/api/leads", { name: "Talks then vanishes" });
    const leadId = lead.json().id as string;
    const task = await post("/api/tasks", {
      title: "Prep for the lead call",
      leadId,
      deadline: dayIso(2),
      assignees: [],
    });
    expect(task.statusCode).toBe(201);
    const taskId = task.json().id as string;

    const onBoard = async () =>
      (await get("/api/tasks?view=board&status=all")).json().items.map((t: { id: string }) => t.id);
    const onCalendar = async () =>
      (await get(`/api/calendar?from=${dayIso(2)}&to=${dayIso(3)}`)).json().deadlines.map(
        (d: { taskId: string }) => d.taskId,
      );

    expect(await onBoard()).toContain(taskId);
    expect(await onCalendar()).toContain(taskId);

    expect((await post(`/api/leads/${leadId}/archive`)).statusCode).toBe(200);

    // the card must not be visible if opening it 404s — those two answers have to agree
    expect(await onBoard()).not.toContain(taskId);
    expect(await onCalendar()).not.toContain(taskId);
    expect((await get(`/api/tasks/${taskId}`)).statusCode).toBe(404);

    // and it all comes back with the lead
    await post(`/api/leads/${leadId}/restore`);
    expect(await onBoard()).toContain(taskId);
    expect((await get(`/api/tasks/${taskId}`)).statusCode).toBe(200);
  });
});

describe("archive — leads", () => {
  async function makeLead(name: string) {
    const res = await post("/api/leads", { name });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("archiving a lead is not the same as closing it", async () => {
    const closed = await makeLead("Lost deal");
    await post(`/api/leads/${closed}/mark-lost`);
    const archived = await makeLead("Duplicate row");
    expect((await post(`/api/leads/${archived}/archive`)).statusCode).toBe(200);

    // "Closed" is an outcome and still on the screen; archived is gone from it
    const closedTab = await get("/api/leads?scope=closed");
    const closedIds = closedTab.json().items.map((l: { id: string }) => l.id);
    expect(closedIds).toContain(closed);
    expect(closedIds).not.toContain(archived);

    const archiveTab = await get("/api/leads?scope=archived");
    const archiveIds = archiveTab.json().items.map((l: { id: string }) => l.id);
    expect(archiveIds).toEqual([archived]);
  });

  it("restores a lead back onto whichever tab its outcome puts it on", async () => {
    const id = await makeLead("Back again");
    await post(`/api/leads/${id}/archive`);
    expect((await post(`/api/leads/${id}/restore`)).statusCode).toBe(200);

    const board = await get("/api/leads?scope=in_process");
    expect(board.json().items.map((l: { id: string }) => l.id)).toContain(id);
    expect((await post(`/api/leads/${id}/restore`)).statusCode).toBe(409);
  });

  it("won't archive a converted lead — it's the record of where a client came from", async () => {
    const id = await makeLead("Real deal");
    const converted = await post(`/api/leads/${id}/convert`, { firstName: "New", lastName: "Client" });
    expect(converted.statusCode).toBe(200);

    const res = await post(`/api/leads/${id}/archive`);
    expect(res.statusCode).toBe(409);
  });
});
