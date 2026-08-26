import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { config } from "../../core/config.js";
import { addDays } from "../../core/dates.js";
import { prisma } from "../../core/db.js";
import { generateInternalTasks, generateSubscriptionTasks } from "./tasks.generation.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let userCookie: string;
let adminId: string;
let userId: string;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  return raw.split(";")[0];
}

async function login(email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

/** Today's calendar parts in the firm timezone (mirrors the generator). */
function todayParts() {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  const weekday = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7) as number); // Mon=1
  return { y, m, d, weekday, monthKey: `${y}-${String(m).padStart(2, "0")}` };
}

/**
 * A calendar day `offset` days from the firm's today, as "YYYY-MM-DD" — the shape a deadline
 * travels in. Counted in the FIRM's timezone, the same way the overdue rule counts: built from
 * the UTC calendar instead, "due today" was a day early for the three hours after 21:00 UTC (the
 * firm is already on the next day then) and the overdue assertions failed every night.
 */
function firmDay(offset: number): string {
  const { y, m, d } = todayParts();
  const day = addDays({ y, m, d }, offset);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${day.y}-${pad(day.m)}-${pad(day.d)}`;
}

async function makeClient(first: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/clients",
    headers: { cookie: adminCookie },
    payload: { firstName: first, lastName: "Tasks", companies: [], people: [] },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

beforeAll(async () => {
  app = await buildApp();
  await prisma.timeEntry.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.task.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.taskTemplate.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.clientPerson.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.file.deleteMany();
  await prisma.service.deleteMany();
  await prisma.user.deleteMany();
  await ensureBaseData(); // priorities + the fixed "New" column

  const pass = await argon2.hash("password-123");
  await prisma.user.createMany({
    data: [
      { firstName: "Task", lastName: "Admin", email: "task-admin@test.local", passwordHash: pass, role: "admin", status: "active" },
      { firstName: "Task", lastName: "User", email: "task-user@test.local", passwordHash: pass, role: "user", status: "active" },
    ],
  });
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: "task-admin@test.local" } })).id;
  userId = (await prisma.user.findUniqueOrThrow({ where: { email: "task-user@test.local" } })).id;
  adminCookie = await login("task-admin@test.local", "password-123");
  userCookie = await login("task-user@test.local", "password-123");
});

afterAll(async () => {
  await prisma.timeEntry.deleteMany();
  await prisma.subtask.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.task.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.taskTemplate.deleteMany();
  await prisma.clientPerson.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.service.deleteMany();
  await app.close();
});

describe("tasks", () => {
  it("columns: fixed New protected; admin manages; non-empty delete blocked", async () => {
    const list = await app.inject({ method: "GET", url: "/api/tasks/columns", headers: { cookie: userCookie } });
    expect(list.statusCode).toBe(200);
    const fixed = list.json().find((c: { isFixed: boolean }) => c.isFixed);
    expect(fixed.name).toBe("New");

    // fixed column can't be renamed or deleted
    const rename = await app.inject({
      method: "PATCH",
      url: `/api/tasks/columns/${fixed.id}`,
      headers: { cookie: adminCookie },
      payload: { name: "Inbox" },
    });
    expect(rename.statusCode).toBe(400);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/tasks/columns/${fixed.id}`,
      headers: { cookie: adminCookie },
    });
    expect(del.statusCode).toBe(400);

    // non-admin can't manage the structure
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/tasks/columns",
      headers: { cookie: userCookie },
      payload: { name: "Doing" },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks/columns",
      headers: { cookie: adminCookie },
      payload: { name: "Doing" },
    });
    expect(created.statusCode).toBe(201);
    const doingId = created.json().id;

    // a task can be created directly into a chosen column (the column "+" button)
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Occupies column", statusColumnId: doingId, assignees: [adminId] },
    });
    expect(task.statusCode).toBe(201);
    expect(task.json().statusColumnId).toBe(doingId);
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/tasks/columns/${doingId}`,
      headers: { cookie: adminCookie },
    });
    expect(blocked.statusCode).toBe(409);

    // move the task out → delete succeeds
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.json().id}`,
      headers: { cookie: adminCookie },
      payload: { statusColumnId: fixed.id },
    });
    const gone = await app.inject({
      method: "DELETE",
      url: `/api/tasks/columns/${doingId}`,
      headers: { cookie: adminCookie },
    });
    expect(gone.statusCode).toBe(200);
  });

  it("targeting rules: client needs a service, lead is free, internal has no target", async () => {
    const clientId = await makeClient("Rules");

    // a client task without a subscription is refused (Zod refine)
    const noSub = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Orphan client task", clientId, assignees: [adminId] },
    });
    expect(noSub.statusCode).toBe(400);

    // assignees are optional now — a task can be created with nobody assigned
    const nobody = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Nobody's job", assignees: [] },
    });
    expect(nobody.statusCode).toBe(201);
    expect(nobody.json().assignees).toHaveLength(0);

    // internal task: no target, kind=free, defaults land
    const internal = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: userCookie },
      payload: { title: "Team standup", plannedMinutes: 15, assignees: [userId] },
    });
    expect(internal.statusCode).toBe(201);
    const task = internal.json();
    expect(task.kind).toBe("free");
    expect(task.clientId).toBeNull();
    expect(task.createdById).toBe(userId); // manual task records its creator
    const priorities = await prisma.priority.findMany();
    expect(task.priorityId).toBe(priorities.find((p) => p.isDefault)!.id);
    const fixedCol = await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } });
    expect(task.statusColumnId).toBe(fixedCol.id);

    // INTERNAL work may still name a client — attribution for reporting, not belonging. It goes
    // through no service, so it bills nothing and never counts as "included in their plan"
    // (user, 2026-08-01). The same payload without `internal` is the 400 asserted above.
    const attributed = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Sort out their paperwork", clientId, internal: true, assignees: [adminId] },
    });
    expect(attributed.statusCode).toBe(201);
    expect(attributed.json().clientId).toBe(clientId);
    expect(attributed.json().kind).toBe("free");
    expect(attributed.json().subscriptionId).toBeNull(); // no service → nothing to bill
    expect(attributed.json().serviceId).toBeNull();
    expect(attributed.json().companyId).toBeNull();

    // it shows up on that client's rollup — the whole point of allowing the attribution
    const clientRollup = await app.inject({
      method: "GET",
      url: `/api/tasks?view=board&clientId=${clientId}`,
      headers: { cookie: adminCookie },
    });
    expect(clientRollup.json().items.map((t: { id: string }) => t.id)).toContain(
      attributed.json().id,
    );

    // …but internal work must not be smuggled through a service
    const contradiction = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: "Internal but billed?",
        clientId,
        internal: true,
        subscriptionId: "00000000-0000-0000-0000-000000000000",
        assignees: [adminId],
      },
    });
    expect(contradiction.statusCode).toBe(400);

    // lead task → free internal work (no service on leads)
    const lead = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie: adminCookie },
      payload: { name: "Task Lead", phone: "+380500000000" },
    });
    const leadTask = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Call the lead back", leadId: lead.json().id, assignees: [adminId] },
    });
    expect(leadTask.statusCode).toBe(201);
    expect(leadTask.json().kind).toBe("free");
    expect(leadTask.json().leadId).toBe(lead.json().id);

    // the lead's rollup list filters by leadId (client card / lead detail surfaces)
    const byLead = await app.inject({
      method: "GET",
      url: `/api/tasks?view=board&leadId=${lead.json().id}`,
      headers: { cookie: adminCookie },
    });
    expect(byLead.json().items).toHaveLength(1);
    expect(byLead.json().items[0].id).toBe(leadTask.json().id);
    // …and it does NOT bleed into an unrelated client's rollup
    const byClientEmpty = await app.inject({
      method: "GET",
      url: `/api/tasks?view=board&clientId=${lead.json().id}`, // a lead id → no client tasks
      headers: { cookie: adminCookie },
    });
    expect(byClientEmpty.json().items).toHaveLength(0);

    // the assignee directory is what every task surface renders people from — it has to carry the
    // avatar, or the board can only ever draw initials however many faces are uploaded (2026-07-28)
    const assignees = await app.inject({
      method: "GET",
      url: "/api/tasks/assignees",
      headers: { cookie: adminCookie },
    });
    expect(assignees.statusCode).toBe(200);
    expect(assignees.json().length).toBeGreaterThan(0);
    for (const u of assignees.json()) {
      expect(u).toHaveProperty("avatarFileId");
      expect(u).toMatchObject({
        id: expect.any(String),
        firstName: expect.any(String),
        status: expect.any(String),
      });
    }

    // the board's target picker offers that lead too — filtering work by prospect (2026-07-27)
    const targets = await app.inject({
      method: "GET",
      url: "/api/tasks/targets",
      headers: { cookie: adminCookie },
    });
    expect(targets.json()).toContainEqual({
      id: lead.json().id,
      name: "Task Lead",
      kind: "lead",
    });

    // and the task's Lead link resolves through GET /api/leads/:id
    const linked = await app.inject({
      method: "GET",
      url: `/api/leads/${lead.json().id}`,
      headers: { cookie: adminCookie },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().name).toBe("Task Lead");

    // done is an independent flag; subtasks replace as a list
    const done = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      headers: { cookie: userCookie },
      payload: { done: true },
    });
    expect(done.json().done).toBe(true);
    expect(done.json().statusColumnId).toBe(fixedCol.id);

    const subtasks = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/subtasks`,
      headers: { cookie: userCookie },
      payload: { subtasks: [{ text: "Collect statements" }, { text: "File the report", done: true }] },
    });
    expect(subtasks.json().subtasks).toHaveLength(2);
    expect(subtasks.json().subtasks[1]).toMatchObject({ text: "File the report", done: true, order: 1 });
  });

  it("client tasks bill by service type: one-time → invoice, subscription → free", async () => {
    const clientId = await makeClient("Billing");

    // subscription service → free extra work, no invoice
    const subSvc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Bill Subscription", type: "subscription" },
    });
    const subSub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: subSvc.json().id, amount: 20000 },
    });
    const extra = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: "Extra reconciliation",
        clientId,
        subscriptionId: subSub.json().subscriptions[0].id,
        amount: 9999, // ignored — subscription work is free
        assignees: [adminId],
      },
    });
    expect(extra.statusCode).toBe(201);
    expect(extra.json().kind).toBe("free");
    expect(extra.json().amount).toBeNull();
    expect(extra.json().invoice).toBeNull();

    // one-time service (on_create) → billable job with an invoice at creation
    const otSvc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Bill One-time", type: "one_time", invoiceTrigger: "on_create", dueDays: 14 },
    });
    const otSub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: otSvc.json().id, amount: 5000 },
    });
    const otSubId = otSub
      .json()
      .subscriptions.find((s: { serviceId: string }) => s.serviceId === otSvc.json().id).id;
    const job = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: "Register the company",
        clientId,
        subscriptionId: otSubId,
        amount: 12000, // overrides the default job price
        assignees: [adminId],
      },
    });
    expect(job.statusCode).toBe(201);
    expect(job.json().kind).toBe("once");
    expect(job.json().amount).toBe(12000);
    expect(job.json().invoice).toMatchObject({ amount: 12000 });
    expect(job.json().invoice.number).toMatch(/^[A-Z]+-\d{4}-\d+$/); // PREFIX-YEAR-NNNN
    expect(job.json().invoice.dueDate).not.toBeNull();

    // price is locked once invoiced
    const relock = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${job.json().id}`,
      headers: { cookie: adminCookie },
      payload: { amount: 100 },
    });
    expect(relock.statusCode).toBe(400);

    // one-time service billed on_complete → invoice appears only when marked done
    const compSvc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Bill On Complete", type: "one_time", invoiceTrigger: "on_complete" },
    });
    const compSub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: compSvc.json().id, amount: 8000 },
    });
    const compSubId = compSub
      .json()
      .subscriptions.find((s: { serviceId: string }) => s.serviceId === compSvc.json().id).id;
    const compJob = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: "Deliver the filing",
        clientId,
        subscriptionId: compSubId,
        assignees: [adminId],
      },
    });
    expect(compJob.json().invoice).toBeNull(); // not billed yet
    const completed = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${compJob.json().id}`,
      headers: { cookie: adminCookie },
      payload: { done: true },
    });
    expect(completed.json().invoice).toMatchObject({ amount: 8000 });
  });

  it("two people completing the same job at once bill the client only once", async () => {
    const clientId = await makeClient("Race");
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Race On Complete", type: "one_time", invoiceTrigger: "on_complete" },
    });
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: svc.json().id, amount: 7000 },
    });
    const subId = sub
      .json()
      .subscriptions.find((s: { serviceId: string }) => s.serviceId === svc.json().id).id;
    const job = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Race job", clientId, subscriptionId: subId, assignees: [adminId] },
    });
    const jobId = job.json().id;

    // both requests read "not billed yet" before either writes — the task row lock inside
    // issueJobInvoice is what stops the client getting two invoices for one job
    await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/tasks/${jobId}`,
        headers: { cookie: adminCookie },
        payload: { done: true },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/tasks/${jobId}`,
        headers: { cookie: userCookie },
        payload: { done: true },
      }),
    ]);

    const invoices = await prisma.invoice.count({ where: { clientId } });
    expect(invoices).toBe(1);
  });

  it("filters and pages on the server: overdue, assignee and client are SQL, the table pages", async () => {
    const clientId = await makeClient("Filters");
    const other = await makeClient("Unfiltered");
    const yesterday = firmDay(-1);
    const tomorrow = firmDay(1);
    const today = firmDay(0);

    const make = (title: string, extra: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { cookie: adminCookie },
        payload: { title, assignees: [], ...extra },
      });

    const late = await make("Late filing", { deadline: yesterday });
    // due TODAY is not late — the whole deadline day has to pass first
    await make("Due today", { deadline: today });
    await make("Later", { deadline: tomorrow });
    await make("Mine", { assignees: [userId] });

    // a client task always goes through one of that client's services
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Filter Service", type: "subscription" },
    });
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: svc.json().id, amount: 1000 },
    });
    const subId = sub
      .json()
      .subscriptions.find((s: { serviceId: string }) => s.serviceId === svc.json().id).id;
    await make("Client work", { clientId, subscriptionId: subId });

    const list = async (qs: string) => {
      const res = await app.inject({ method: "GET", url: `/api/tasks?${qs}`, headers: { cookie: adminCookie } });
      expect(res.statusCode).toBe(200);
      return res.json();
    };

    const overdue = await list("view=board&status=open&overdue=true");
    const overdueTitles = overdue.items.map((t: { title: string }) => t.title);
    expect(overdueTitles).toContain("Late filing");
    expect(overdueTitles).not.toContain("Due today");
    expect(overdueTitles).not.toContain("Later");

    // filters NARROW each other — they never overwrite. "Overdue" is open work by definition,
    // so combining it with status=done must return nothing rather than quietly listing open
    // tasks under a "Done" heading.
    const contradiction = await list("view=board&status=done&overdue=true");
    expect(contradiction.items).toHaveLength(0);
    expect(contradiction.total).toBe(0);

    const mine = await list(`view=board&status=open&assigneeId=${userId}`);
    expect(mine.items.map((t: { title: string }) => t.title)).toEqual(["Mine"]);

    const byClient = await list(`view=board&status=open&clientId=${clientId}`);
    expect(byClient.items).toHaveLength(1);
    expect(byClient.items[0].title).toBe("Client work");

    // the table pages through the whole result set instead of slicing a board payload
    const page1 = await list("view=table&status=open&pageSize=2&page=1");
    const page2 = await list("view=table&status=open&pageSize=2&page=2");
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBeGreaterThan(2);
    expect(page1.page).toBe(1);
    expect(page2.page).toBe(2);
    const overlap = page1.items.filter((a: { id: string }) =>
      page2.items.some((b: { id: string }) => b.id === a.id),
    );
    expect(overlap).toHaveLength(0);

    // the target filter's option list covers every client with work, not just a loaded page
    const targets = await app.inject({ method: "GET", url: "/api/tasks/targets", headers: { cookie: adminCookie } });
    const names = targets.json().map((c: { name: string }) => c.name);
    expect(names).toContain("Filters Tasks");
    expect(names).not.toContain("Unfiltered Tasks"); // no tasks → not offered as a filter
    expect(other).toBeTruthy();
    expect(late.statusCode).toBe(201);
  });

  // the Done view is a WINDOW over completed work, not the whole history
  it("stamps completedAt and windows the Done view by it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: {
        title: "Finished today",
        clientId: null,
        leadId: null,
        subscriptionId: null,
        assignees: [adminId],
      },
    });
    const taskId = created.json().id;
    expect(created.json().completedAt).toBeNull(); // open work carries no stamp

    const done = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { done: true },
    });
    expect(done.json().completedAt).not.toBeNull();
    // closing a task must not touch WHO did it — the record of who is answerable for the work
    // is most of what makes a finished task worth keeping (user report, 2026-08-01)
    expect(done.json().assignees).toEqual([adminId]);

    // a COMPLETED task still answers by id — that is what a `?task=<id>` link falls back to when
    // the Active board (open work only) can't hold it, e.g. the header timer bar left pointing at
    // a task somebody finished while the timer was running (2026-07-28)
    const byId = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toMatchObject({ id: taskId, done: true });

    expect(byId.json().assignees).toEqual([adminId]); // …and by id, which is what a ?task= link reads

    const inWindow = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board&status=done&withinDays=7",
      headers: { cookie: adminCookie },
    });
    expect(inWindow.json().items.map((t: { id: string }) => t.id)).toContain(taskId);
    // the Done board is the surface where a lost assignee would show as "Unassigned"
    expect(
      inWindow.json().items.find((t: { id: string }) => t.id === taskId).assignees,
    ).toEqual([adminId]);

    // backdate it beyond the window — same task, now out of view
    await prisma.task.update({
      where: { id: taskId },
      data: { completedAt: new Date(Date.now() - 30 * 86_400_000) },
    });
    const stillWeek = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board&status=done&withinDays=7",
      headers: { cookie: adminCookie },
    });
    expect(stillWeek.json().items.map((t: { id: string }) => t.id)).not.toContain(taskId);
    const allTime = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board&status=done",
      headers: { cookie: adminCookie },
    });
    expect(allTime.json().items.map((t: { id: string }) => t.id)).toContain(taskId);

    // reopening clears the stamp — it must never describe an old completion
    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { done: false },
    });
    expect(reopened.json().completedAt).toBeNull();

    // Archiving is tidying FINISHED work away, never a way to make open work disappear
    // (user, 2026-08-01) — the task was just reopened, so it is refused now.
    const tooEarly = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: { cookie: adminCookie },
    });
    expect(tooEarly.statusCode).toBe(409);

    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { done: true },
    });
    const archived = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: { cookie: adminCookie },
    });
    expect(archived.statusCode).toBe(200);
  });

  // Cancelling = raised by mistake, or called off. It leaves the board like a completed task but
  // is never deleted (user, 2026-08-01).
  it("cancels a task: off the board, its own list, restorable, archivable, never re-generated", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Raised by mistake", assignees: [adminId] },
    });
    const taskId = created.json().id;
    expect(created.json().cancelledAt).toBeNull();

    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { cancelled: true },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().cancelledAt).not.toBeNull();
    expect(cancelled.json().cancelledByName).toBe("Task Admin"); // WHO called it off is the point
    expect(cancelled.json().assignees).toEqual([adminId]); // and it keeps its people

    // gone from the open board…
    const open = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board&status=open",
      headers: { cookie: adminCookie },
    });
    expect(open.json().items.map((t: { id: string }) => t.id)).not.toContain(taskId);
    // …and it is NOT "done" either — different answers about the same work
    const doneList = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board&status=done",
      headers: { cookie: adminCookie },
    });
    expect(doneList.json().items.map((t: { id: string }) => t.id)).not.toContain(taskId);
    // it has its own list
    const cancelledList = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board&status=cancelled",
      headers: { cookie: adminCookie },
    });
    expect(cancelledList.json().items.map((t: { id: string }) => t.id)).toContain(taskId);

    // The client/lead ROLLUP asks without a status (it wants their whole history), so a cancelled
    // task rides along in that response — the card must be able to tell it apart, or called-off
    // work reads as live work on the client's page (2026-08-01 audit).
    const rollup = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board",
      headers: { cookie: adminCookie },
    });
    const inRollup = rollup
      .json()
      .items.find((t: { id: string }) => t.id === taskId);
    expect(inRollup).toBeDefined();
    expect(inRollup.cancelledAt).not.toBeNull(); // …which is only possible because the DTO says so

    // a cancelled task is closed work, so it may be archived
    const archived = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/archive`,
      headers: { cookie: adminCookie },
    });
    expect(archived.statusCode).toBe(200);

    // an INVOICED job can't be called off while the client stays billed — void the invoice first
    const billed = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board&status=open&pageSize=100",
      headers: { cookie: adminCookie },
    });
    const withInvoice = billed.json().items.find((t: { invoice: unknown }) => t.invoice);
    if (withInvoice) {
      const refused = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${withInvoice.id}`,
        headers: { cookie: adminCookie },
        payload: { cancelled: true },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toMatch(/already invoiced/i);
    }

    // …and one raised by mistake can be taken back
    const other = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Called off then restored", assignees: [adminId] },
    });
    const otherId = other.json().id;
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${otherId}`,
      headers: { cookie: adminCookie },
      payload: { cancelled: true },
    });
    // marking a cancelled task done is refused — restore it first, so no invoice can fire from it
    const doneWhileCancelled = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${otherId}`,
      headers: { cookie: adminCookie },
      payload: { done: true },
    });
    expect(doneWhileCancelled.statusCode).toBe(409);

    const restored = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${otherId}`,
      headers: { cookie: adminCookie },
      payload: { cancelled: false },
    });
    expect(restored.json().cancelledAt).toBeNull();
    expect(restored.json().cancelledByName).toBeNull();
    const backOnBoard = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board&status=open",
      headers: { cookie: adminCookie },
    });
    expect(backOnBoard.json().items.map((t: { id: string }) => t.id)).toContain(otherId);
  });

  // Archiving a client takes their work off every board — but a task was still fully reachable BY
  // ID, and an invoice links straight to one ("Job: …"). So the work vanished from the board while
  // a timer could still be started on it (user, 2026-08-03). A task is as gone as its client.
  it("a task of an archived client is unreachable by id, not just hidden from lists", async () => {
    const clientId = await makeClient("ToArchive");
    const svc = await prisma.service.create({
      data: { name: "Archive probe", color: "#000", type: "one_time", defaultAmount: 1000 },
    });
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: svc.id, amount: 1000, period: "month" },
    });
    const subscriptionId = sub.json().subscriptions.find(
      (x: { serviceId: string }) => x.serviceId === svc.id,
    ).id;
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Work for a client we dropped", clientId, subscriptionId, assignees: [adminId] },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id;

    await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/archive`,
      headers: { cookie: adminCookie },
    });

    // gone from the board — this already worked
    const board = await app.inject({
      method: "GET",
      url: "/api/tasks?view=board&status=open&pageSize=100",
      headers: { cookie: adminCookie },
    });
    expect(board.json().items.map((t: { id: string }) => t.id)).not.toContain(taskId);

    // …and gone by id too, on every door into it
    const byId = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
    });
    expect(byId.statusCode).toBe(404);

    const timer = await app.inject({
      method: "POST",
      url: "/api/tasks/timer/start",
      headers: { cookie: adminCookie },
      payload: { taskId },
    });
    expect(timer.statusCode).toBe(404);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { done: true },
    });
    expect(patch.statusCode).toBe(404);

    const comment = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { cookie: adminCookie },
      payload: { body: "still here?" },
    });
    expect(comment.statusCode).toBe(404);
  });

  it("filters by service, and 'none' finds the internal work no service covers", async () => {
    const svc = await app.inject({
      method: "POST", url: "/api/catalog", headers: { cookie: adminCookie },
      payload: { name: "Filterable service", type: "one_time", defaultAmount: 1000 },
    });
    const serviceId = svc.json().id as string;
    const clientId = await makeClient("FilterByService");
    const sub = await app.inject({
      method: "POST", url: `/api/clients/${clientId}/subscriptions`, headers: { cookie: adminCookie },
      payload: { serviceId, amount: 1000, period: "month" },
    });
    const subscriptionId = sub.json().subscriptions.find(
      (x: { serviceId: string }) => x.serviceId === serviceId,
    ).id;

    const throughService = await app.inject({
      method: "POST", url: "/api/tasks", headers: { cookie: adminCookie },
      payload: { title: "Billable via service", clientId, subscriptionId, assignees: [] },
    });
    const internal = await app.inject({
      method: "POST", url: "/api/tasks", headers: { cookie: adminCookie },
      payload: { title: "Firm's own time", clientId, internal: true, assignees: [] },
    });
    expect(internal.statusCode).toBe(201);

    const ids = async (q: string) =>
      (await app.inject({ method: "GET", url: `/api/tasks?view=board&status=all&${q}`, headers: { cookie: adminCookie } }))
        .json().items.map((t: { id: string }) => t.id);

    expect(await ids(`serviceId=${serviceId}`)).toContain(throughService.json().id);
    expect(await ids(`serviceId=${serviceId}`)).not.toContain(internal.json().id);

    // "none" is the whole point of the option: internal work belongs to no service, and without
    // it there is no way to reach it through this filter at all
    expect(await ids("serviceId=none")).toContain(internal.json().id);
    expect(await ids("serviceId=none")).not.toContain(throughService.json().id);
  });

  it("windows Done by when it was FINISHED and Cancelled by when it was CALLED OFF", async () => {
    const clientId = await makeClient("Windowed");
    const mk = async (title: string) =>
      (await app.inject({
        method: "POST", url: "/api/tasks", headers: { cookie: adminCookie },
        payload: { title, clientId, internal: true, assignees: [] },
      })).json().id as string;

    const doneId = await mk("Finished long ago");
    const cancelledId = await mk("Called off long ago");
    await app.inject({ method: "PATCH", url: `/api/tasks/${doneId}`, headers: { cookie: adminCookie }, payload: { done: true } });
    await app.inject({ method: "PATCH", url: `/api/tasks/${cancelledId}`, headers: { cookie: adminCookie }, payload: { cancelled: true } });

    // push both stamps back beyond a 7-day window
    const old = new Date(Date.now() - 30 * 86_400_000);
    await prisma.task.update({ where: { id: doneId }, data: { completedAt: old } });
    await prisma.task.update({ where: { id: cancelledId }, data: { cancelledAt: old } });

    const ids = async (status: string, q = "") =>
      (await app.inject({ method: "GET", url: `/api/tasks?view=board&status=${status}${q}`, headers: { cookie: adminCookie } }))
        .json().items.map((t: { id: string }) => t.id);

    // no window → everything ever, which is what Cancelled defaults to (user, 2026-08-08)
    expect(await ids("done")).toContain(doneId);
    expect(await ids("cancelled")).toContain(cancelledId);

    // Cancelled counts from `cancelledAt`, NOT `completedAt` — called-off work is never completed,
    // so reusing the Done column would have quietly returned nothing here
    expect(await ids("done", "&withinDays=7")).not.toContain(doneId);
    expect(await ids("cancelled", "&withinDays=7")).not.toContain(cancelledId);

    await prisma.task.update({ where: { id: cancelledId }, data: { cancelledAt: new Date() } });
    expect(await ids("cancelled", "&withinDays=7")).toContain(cancelledId);
  });

  it("archives many at once, and says how many it would not touch", async () => {
    const clientId = await makeClient("BulkArchive");
    const mk = async (title: string) =>
      (await app.inject({
        method: "POST", url: "/api/tasks", headers: { cookie: adminCookie },
        payload: { title, clientId, internal: true, assignees: [] },
      })).json().id as string;

    const done = await mk("Finished");
    const cancelled = await mk("Called off");
    const open = await mk("Still open");
    await app.inject({ method: "PATCH", url: `/api/tasks/${done}`, headers: { cookie: adminCookie }, payload: { done: true } });
    await app.inject({ method: "PATCH", url: `/api/tasks/${cancelled}`, headers: { cookie: adminCookie }, payload: { cancelled: true } });

    const res = await app.inject({
      method: "POST", url: "/api/tasks/bulk-archive", headers: { cookie: adminCookie },
      payload: { taskIds: [done, cancelled, open] },
    });
    expect(res.statusCode).toBe(200);
    // open work must never vanish in a bulk action — and the caller is TOLD it was skipped
    expect(res.json()).toEqual({ changed: 2, skipped: 1 });

    const archived = await prisma.task.findMany({
      where: { id: { in: [done, cancelled, open] }, archivedAt: { not: null } },
      select: { id: true },
    });
    expect(archived.map((t) => t.id).sort()).toEqual([done, cancelled].sort());

    // running it again changes nothing: already-archived rows are not eligible twice
    const again = await app.inject({
      method: "POST", url: "/api/tasks/bulk-archive", headers: { cookie: adminCookie },
      payload: { taskIds: [done, cancelled] },
    });
    expect(again.json()).toEqual({ changed: 0, skipped: 2 });
  });

  it("refuses to bulk-archive a task whose client is archived", async () => {
    const clientId = await makeClient("GoneBulk");
    const task = (await app.inject({
      method: "POST", url: "/api/tasks", headers: { cookie: adminCookie },
      payload: { title: "Closed then orphaned", clientId, internal: true, assignees: [] },
    })).json().id as string;
    await app.inject({ method: "PATCH", url: `/api/tasks/${task}`, headers: { cookie: adminCookie }, payload: { done: true } });
    await app.inject({ method: "POST", url: `/api/clients/${clientId}/archive`, headers: { cookie: adminCookie } });

    // it is already invisible; archiving would bury it a level deeper, out of reach of the
    // client's own restore
    const res = await app.inject({
      method: "POST", url: "/api/tasks/bulk-archive", headers: { cookie: adminCookie },
      payload: { taskIds: [task] },
    });
    expect(res.json()).toEqual({ changed: 0, skipped: 1 });
  });

  it("generates tasks on the rhythm day, idempotently, honoring per-client overrides", async () => {
    const { d, weekday, monthKey } = todayParts();

    // subscription-type service with a monthly template due TODAY
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Gen Bookkeeping", type: "subscription" },
    });
    const serviceId = svc.json().id;
    const tpl = await app.inject({
      method: "POST",
      url: `/api/catalog/${serviceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Monthly close", periodicity: "monthly", dayOfPeriod: d, deadlineOffsetDays: 5, estimatedMinutes: 120 },
    });
    const templateId = tpl.json().taskTemplates[0].id;

    // adding the subscription generates today's task instantly (kind=sub, unassigned, in New)
    const clientId = await makeClient("GenClient");
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 20000 },
    });
    expect(sub.statusCode).toBe(201);
    const subId = sub.json().subscriptions[0].id;

    const generated = await prisma.task.findFirst({
      where: { subscriptionId: subId, taskTemplateId: templateId },
      include: { assignees: true },
    });
    expect(generated).not.toBeNull();
    expect(generated!.kind).toBe("sub");
    expect(generated!.periodKey).toBe(monthKey);
    expect(generated!.assignees).toHaveLength(0);
    expect(generated!.createdById).toBeNull(); // scheduler-generated → no human creator ("Auto")
    expect(generated!.plannedMinutes).toBe(120);
    // composed title: client · service · template · date (no company on this client)
    expect(generated!.title).toContain("GenClient Tasks");
    expect(generated!.title).toContain("Gen Bookkeeping");
    expect(generated!.title).toContain("Monthly close");
    expect(generated!.title).toMatch(/\d{2}\.\d{2}\.\d{4}$/);

    // double sweep creates nothing new (unique key + skipDuplicates)
    const before = await prisma.task.count();
    await generateSubscriptionTasks();
    await generateSubscriptionTasks();
    expect(await prisma.task.count()).toBe(before);

    // per-client override: another client disables the task → the sweep skips them
    const client2 = await makeClient("GenSkip");
    const sub2 = await app.inject({
      method: "POST",
      url: `/api/clients/${client2}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 10000 },
    });
    const sub2Id = sub2.json().subscriptions[0].id;
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${client2}/subscriptions/${sub2Id}`,
      headers: { cookie: adminCookie },
      payload: { rhythmOverrides: { [templateId]: { enabled: false } } },
    });
    await prisma.task.deleteMany({ where: { subscriptionId: sub2Id } });
    await generateSubscriptionTasks();
    expect(await prisma.task.count({ where: { subscriptionId: sub2Id } })).toBe(0);

    // a weekly override reshapes generation for that client only
    const client3 = await makeClient("GenWeekly");
    const sub3 = await app.inject({
      method: "POST",
      url: `/api/clients/${client3}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 10000 },
    });
    const sub3Id = sub3.json().subscriptions[0].id;
    await prisma.task.deleteMany({ where: { subscriptionId: sub3Id } });
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${client3}/subscriptions/${sub3Id}`,
      headers: { cookie: adminCookie },
      payload: {
        rhythmOverrides: {
          [templateId]: { enabled: true, periodicity: "weekly", dayOfPeriod: weekday, monthOfPeriod: null },
        },
      },
    });
    const weeklyTask = await prisma.task.findFirst({ where: { subscriptionId: sub3Id } });
    expect(weeklyTask).not.toBeNull();
    expect(weeklyTask!.periodKey).toMatch(/^\d{4}-W\d{2}$/);

    // one-time services never generate
    const oneTime = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Gen One-off", type: "one_time" },
    });
    await app.inject({
      method: "POST",
      url: `/api/catalog/${oneTime.json().id}/tasks`,
      headers: { cookie: adminCookie },
      payload: { name: "Job preset", periodicity: "once" },
    });
    const otSub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: oneTime.json().id, amount: 5000 },
    });
    await generateSubscriptionTasks();
    expect(
      await prisma.task.count({ where: { subscriptionId: otSub.json().subscriptions.at(-1).id } }),
    ).toBe(0);
  });

  // The reason a cancelled task is kept rather than deleted: the sweep dedups on the stored
  // (subscription, template, period) key, so the row is what stops it coming back tomorrow.
  it("a cancelled generated task is not re-created by the next sweep", async () => {
    const generated = await prisma.task.findFirst({
      where: { kind: "sub", taskTemplateId: { not: null }, archivedAt: null },
    });
    if (!generated) return; // nothing generated in this suite's data — nothing to assert
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${generated.id}`,
      headers: { cookie: adminCookie },
      payload: { cancelled: true },
    });
    const before = await prisma.task.count({
      where: {
        subscriptionId: generated.subscriptionId,
        taskTemplateId: generated.taskTemplateId,
        periodKey: generated.periodKey,
      },
    });
    await generateSubscriptionTasks();
    const after = await prisma.task.count({
      where: {
        subscriptionId: generated.subscriptionId,
        taskTemplateId: generated.taskTemplateId,
        periodKey: generated.periodKey,
      },
    });
    expect(after).toBe(before); // the cancelled row still holds the key
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${generated.id}`,
      headers: { cookie: adminCookie },
      payload: { cancelled: false },
    });
  });

  it("template default checklist seeds generated tasks; per-client override replaces/removes it; manual create seeds too", async () => {
    const { d } = todayParts();
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Checklist svc", type: "subscription" },
    });
    const serviceId = svc.json().id;
    const tpl = await app.inject({
      method: "POST",
      url: `/api/catalog/${serviceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: {
        name: "With steps",
        periodicity: "monthly",
        dayOfPeriod: d,
        defaultChecklist: ["Collect statements", "Reconcile", "File"],
      },
    });
    expect(tpl.json().taskTemplates[0].defaultChecklist).toEqual([
      "Collect statements",
      "Reconcile",
      "File",
    ]);
    const templateId = tpl.json().taskTemplates[0].id;

    // default: generated task gets the template's checklist, in order, all undone
    const c1 = await makeClient("ChkDefault");
    const s1 = await app.inject({
      method: "POST",
      url: `/api/clients/${c1}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 10000 },
    });
    const t1 = await prisma.task.findFirst({
      where: { subscriptionId: s1.json().subscriptions[0].id },
      include: { subtasks: { orderBy: { order: "asc" } } },
    });
    expect(t1!.subtasks.map((x) => x.text)).toEqual(["Collect statements", "Reconcile", "File"]);
    expect(t1!.subtasks.every((x) => !x.done)).toBe(true);

    // a second sweep must NOT duplicate or rewrite the checklist
    await generateSubscriptionTasks();
    const t1again = await prisma.task.findFirst({
      where: { subscriptionId: s1.json().subscriptions[0].id },
      include: { subtasks: true },
    });
    expect(t1again!.subtasks).toHaveLength(3);

    // per-client override: replace the checklist for this client only
    const c2 = await makeClient("ChkCustom");
    const s2 = await app.inject({
      method: "POST",
      url: `/api/clients/${c2}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 10000 },
    });
    const s2Id = s2.json().subscriptions[0].id;
    await prisma.task.deleteMany({ where: { subscriptionId: s2Id } });
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${c2}/subscriptions/${s2Id}`,
      headers: { cookie: adminCookie },
      payload: { rhythmOverrides: { [templateId]: { checklist: ["Just this one"] } } },
    });
    const t2 = await prisma.task.findFirst({
      where: { subscriptionId: s2Id },
      include: { subtasks: true },
    });
    expect(t2!.subtasks.map((x) => x.text)).toEqual(["Just this one"]);

    // per-client override: checklist=null removes it for this client
    const c3 = await makeClient("ChkNone");
    const s3 = await app.inject({
      method: "POST",
      url: `/api/clients/${c3}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 10000 },
    });
    const s3Id = s3.json().subscriptions[0].id;
    await prisma.task.deleteMany({ where: { subscriptionId: s3Id } });
    await app.inject({
      method: "PATCH",
      url: `/api/clients/${c3}/subscriptions/${s3Id}`,
      headers: { cookie: adminCookie },
      payload: { rhythmOverrides: { [templateId]: { checklist: null } } },
    });
    const t3 = await prisma.task.findFirst({
      where: { subscriptionId: s3Id },
      include: { subtasks: true },
    });
    expect(t3!.subtasks).toHaveLength(0);

    // manual create can seed its own checklist
    const manual = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Manual with steps", assignees: [adminId], subtasks: ["A", "B"] },
    });
    expect(manual.statusCode).toBe(201);
    expect(manual.json().subtasks.map((x: { text: string }) => x.text)).toEqual(["A", "B"]);
  });

  it("internal templates generate firm-internal tasks (no client; with assignees, checklist, description); idempotent; not client-assignable", async () => {
    const { d } = todayParts();
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Compliance", type: "internal" },
    });
    expect(svc.statusCode).toBe(201);
    expect(svc.json().type).toBe("internal");
    const serviceId = svc.json().id as string;

    const tpl = await app.inject({
      method: "POST",
      url: `/api/catalog/${serviceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: {
        name: "Monthly review",
        periodicity: "monthly",
        dayOfPeriod: d,
        deadlineOffsetDays: 3,
        estimatedMinutes: 60,
        description: "Review the tax law changes",
        defaultChecklist: ["Read updates", "Note impacts"],
        defaultAssigneeIds: [adminId, userId],
      },
    });
    const t0 = tpl.json().taskTemplates[0];
    expect(t0.description).toBe("Review the tax law changes");
    expect([...t0.defaultAssigneeIds].sort()).toEqual([adminId, userId].sort());
    const templateId = t0.id as string;

    await generateInternalTasks();
    const task = await prisma.task.findFirst({
      where: { taskTemplateId: templateId, subscriptionId: null },
      include: { assignees: true, subtasks: { orderBy: { order: "asc" } } },
    });
    expect(task).not.toBeNull();
    expect(task!.kind).toBe("free");
    expect(task!.clientId).toBeNull();
    expect(task!.serviceId).toBe(serviceId);
    expect(task!.description).toBe("Review the tax law changes");
    expect(task!.plannedMinutes).toBe(60);
    expect(task!.assignees.map((a) => a.userId).sort()).toEqual([adminId, userId].sort());
    expect(task!.subtasks.map((s) => s.text)).toEqual(["Read updates", "Note impacts"]);
    expect(task!.title).toContain("Compliance");
    expect(task!.title).toContain("Monthly review");

    // idempotent — a second sweep creates nothing new
    await generateInternalTasks();
    expect(
      await prisma.task.count({ where: { taskTemplateId: templateId, subscriptionId: null } }),
    ).toBe(1);

    // internal services can't be assigned to a client
    const clientId = await makeClient("IntClient");
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId, amount: 10000 },
    });
    expect(sub.statusCode).toBe(400);

    // it has generated tasks now → deleting is blocked (history); deactivate instead
    const del = await app.inject({
      method: "DELETE",
      url: `/api/catalog/${serviceId}`,
      headers: { cookie: adminCookie },
    });
    expect(del.statusCode).toBe(409);
  });

  it("internal templates: duplicate assignees rejected on save + generation dedupes defensively", async () => {
    const { d } = todayParts();
    const svc = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Dedup dept", type: "internal" },
    });
    const serviceId = svc.json().id as string;

    // the API refuses a template that lists the same assignee twice
    const dup = await app.inject({
      method: "POST",
      url: `/api/catalog/${serviceId}/tasks`,
      headers: { cookie: adminCookie },
      payload: {
        name: "Dup",
        periodicity: "monthly",
        dayOfPeriod: d,
        defaultAssigneeIds: [adminId, adminId],
      },
    });
    expect(dup.statusCode).toBe(400);

    // a row that somehow carries duplicate ids (bypassing the API) must still generate one
    // clean task — TaskAssignee is unique per (task,user), so generation dedupes before insert
    const tpl = await prisma.taskTemplate.create({
      data: {
        serviceId,
        name: "Raw dup",
        periodicity: "monthly",
        dayOfPeriod: d,
        billable: false,
        defaultAssigneeIds: [adminId, adminId, userId],
      },
    });
    await generateInternalTasks();
    const task = await prisma.task.findFirst({
      where: { taskTemplateId: tpl.id, subscriptionId: null },
      include: { assignees: true },
    });
    expect(task).not.toBeNull();
    expect(task!.assignees.map((a) => a.userId).sort()).toEqual([adminId, userId].sort());
  });

  it("task comments: anyone posts; delete own or (admin) anyone; empty body rejected", async () => {
    const t = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: userCookie },
      payload: { title: "Commented task", assignees: [userId] },
    });
    const taskId = t.json().id as string;

    const c1 = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { cookie: userCookie },
      payload: { body: "  Started the reconciliation  " },
    });
    expect(c1.statusCode).toBe(201);
    expect(c1.json().comments).toHaveLength(1);
    expect(c1.json().comments[0]).toMatchObject({
      body: "Started the reconciliation",
      authorId: userId,
    });

    const bad = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { cookie: userCookie },
      payload: { body: "   " },
    });
    expect(bad.statusCode).toBe(400);

    const c2 = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/comments`,
      headers: { cookie: adminCookie },
      payload: { body: "Looks good" },
    });
    const comments = c2.json().comments as { id: string; authorId: string }[];
    expect(comments).toHaveLength(2);
    const own = comments.find((c) => c.authorId === userId)!;
    const adminComment = comments.find((c) => c.authorId === adminId)!;

    // a non-author, non-admin can't delete someone else's comment
    const forbidden = await app.inject({
      method: "DELETE",
      url: `/api/tasks/comments/${adminComment.id}`,
      headers: { cookie: userCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    // delete your own
    const delOwn = await app.inject({
      method: "DELETE",
      url: `/api/tasks/comments/${own.id}`,
      headers: { cookie: userCookie },
    });
    expect(delOwn.statusCode).toBe(200);
    expect(delOwn.json().comments).toHaveLength(1);

    // admin deletes anyone's
    const delAdmin = await app.inject({
      method: "DELETE",
      url: `/api/tasks/comments/${adminComment.id}`,
      headers: { cookie: adminCookie },
    });
    expect(delAdmin.statusCode).toBe(200);
    expect(delAdmin.json().comments).toHaveLength(0);
  });

  it("a completed task rejects starting a timer (reopen first)", async () => {
    const t = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Done timer guard", assignees: [adminId] },
    });
    const taskId = t.json().id as string;
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      headers: { cookie: adminCookie },
      payload: { done: true },
    });
    // the done-check precedes the running-timer check, so this is state-independent
    const start = await app.inject({
      method: "POST",
      url: "/api/tasks/timer/start",
      headers: { cookie: adminCookie },
      payload: { taskId },
    });
    expect(start.statusCode).toBe(400);
  });

  it("timer: one per user, switch closes with a comment, admin manages time", async () => {
    const mk = async (title: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { cookie: adminCookie },
        payload: { title, assignees: [adminId] }, // internal tasks — target-agnostic timer test
      });
      return res.json().id as string;
    };
    const taskA = await mk("Timer A");
    const taskB = await mk("Timer B");

    // start A — the tracker joins the crew automatically
    const startA = await app.inject({
      method: "POST",
      url: "/api/tasks/timer/start",
      headers: { cookie: userCookie },
      payload: { taskId: taskA },
    });
    expect(startA.statusCode).toBe(200);
    expect(startA.json().taskId).toBe(taskA);
    const aDto = await app.inject({ method: "GET", url: `/api/tasks/${taskA}`, headers: { cookie: userCookie } });
    expect(aDto.json().assignees).toContain(userId);

    const active = await app.inject({
      method: "GET",
      url: "/api/tasks/timer/active",
      headers: { cookie: userCookie },
    });
    expect(active.json().taskId).toBe(taskA);

    // switching without a comment is refused; with one it closes A and starts B
    const noComment = await app.inject({
      method: "POST",
      url: "/api/tasks/timer/start",
      headers: { cookie: userCookie },
      payload: { taskId: taskB },
    });
    expect(noComment.statusCode).toBe(409);

    const switched = await app.inject({
      method: "POST",
      url: "/api/tasks/timer/start",
      headers: { cookie: userCookie },
      payload: { taskId: taskB, closeComment: "Reconciled the bank feed" },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().taskId).toBe(taskB);

    const closedA = await prisma.timeEntry.findFirstOrThrow({ where: { taskId: taskA, userId } });
    expect(closedA.stoppedAt).not.toBeNull();
    expect(closedA.seconds).toBeGreaterThanOrEqual(1);
    expect(closedA.comment).toBe("Reconciled the bank feed");

    // a second user's timer coexists (the rule is per person)
    const adminStart = await app.inject({
      method: "POST",
      url: "/api/tasks/timer/start",
      headers: { cookie: adminCookie },
      payload: { taskId: taskA },
    });
    expect(adminStart.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: "/api/tasks/timer/stop",
      headers: { cookie: adminCookie },
      payload: { comment: "Reviewed the numbers" },
    });

    // stop needs a comment (Zod) and then closes B
    const silentStop = await app.inject({
      method: "POST",
      url: "/api/tasks/timer/stop",
      headers: { cookie: userCookie },
      payload: {},
    });
    expect(silentStop.statusCode).toBe(400);
    const stop = await app.inject({
      method: "POST",
      url: "/api/tasks/timer/stop",
      headers: { cookie: userCookie },
      payload: { comment: "Drafted the invoice list" },
    });
    expect(stop.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/tasks/timer/active", headers: { cookie: userCookie } })).json()).toBeNull();

    // plain users can't touch entries; admin has full management
    const entry = await prisma.timeEntry.findFirstOrThrow({ where: { taskId: taskB, userId } });
    const userEdit = await app.inject({
      method: "PATCH",
      url: `/api/tasks/time/${entry.id}`,
      headers: { cookie: userCookie },
      payload: { minutes: 30 },
    });
    expect(userEdit.statusCode).toBe(403);

    const adminEdit = await app.inject({
      method: "PATCH",
      url: `/api/tasks/time/${entry.id}`,
      headers: { cookie: adminCookie },
      payload: { minutes: 30, comment: "Corrected after review" },
    });
    expect(adminEdit.statusCode).toBe(200);
    const edited = adminEdit.json().timeEntries.find((e: { id: string }) => e.id === entry.id);
    expect(edited.seconds).toBe(1800);

    const manual = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskB}/time`,
      headers: { cookie: adminCookie },
      payload: { userId, minutes: 45, comment: "Forgot to track the call", date: "2026-07-20" },
    });
    expect(manual.statusCode).toBe(201);
    const manualEntry = manual.json().timeEntries.find((e: { source: string }) => e.source === "manual");
    expect(manualEntry).toMatchObject({ seconds: 2700, createdById: adminId, userId });
    expect(manual.json().trackedSeconds).toBe(1800 + 2700);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/tasks/time/${manualEntry.id}`,
      headers: { cookie: adminCookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().trackedSeconds).toBe(1800);
  });

  // ── dragging a card up and down inside its column (2026-08-26) ────────────

  describe("board order", () => {
    let columnId: string;
    let clientId: string;
    let ids: string[] = [];

    const board = async (query = "") => {
      const res = await app.inject({
        method: "GET",
        url: `/api/tasks?view=board${query}`,
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(200);
      return (res.json().items as { id: string; statusColumnId: string; title: string }[])
        .filter((t) => t.statusColumnId === columnId)
        .map((t) => t.title);
    };

    const move = (id: string, afterTaskId: string | null, into = columnId) =>
      app.inject({
        method: "PATCH",
        url: `/api/tasks/${id}/position`,
        headers: { cookie: adminCookie },
        payload: { statusColumnId: into, afterTaskId },
      });

    beforeAll(async () => {
      const client = await app.inject({
        method: "POST",
        url: "/api/clients",
        headers: { cookie: adminCookie },
        payload: { firstName: "Board", lastName: "Order", companies: [], people: [] },
      });
      clientId = client.json().id;
      const col = await app.inject({
        method: "POST",
        url: "/api/tasks/columns",
        headers: { cookie: adminCookie },
        payload: { name: "Ordering" },
      });
      columnId = col.json().id;
      ids = [];
      // created A, B, C — each lands on TOP, so the board reads C, B, A
      for (const title of ["A", "B", "C"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/tasks",
          headers: { cookie: adminCookie },
          payload: {
            title,
            statusColumnId: columnId,
            clientId,
            internal: true, // attribution only — no service, nothing to bill
            assignees: [adminId],
          },
        });
        expect(res.statusCode).toBe(201);
        ids.push(res.json().id);
      }
    });

    afterAll(async () => {
      await prisma.taskAssignee.deleteMany({ where: { taskId: { in: ids } } });
      await prisma.task.deleteMany({ where: { statusColumnId: columnId } });
      await prisma.taskColumn.deleteMany({ where: { id: columnId } });
      await prisma.client.deleteMany({ where: { id: clientId } });
    });

    const [A, B, C] = [0, 1, 2];

    it("new work lands on top, which is where the old ordering put it", async () => {
      expect(await board()).toEqual(["C", "B", "A"]);
    });

    it("moves a card DOWN inside its column", async () => {
      // C, B, A → put C after B
      expect((await move(ids[C], ids[B])).statusCode).toBe(200);
      expect(await board()).toEqual(["B", "C", "A"]);
    });

    it("moves a card UP inside its column", async () => {
      // B, C, A → put A after B
      expect((await move(ids[A], ids[B])).statusCode).toBe(200);
      expect(await board()).toEqual(["B", "A", "C"]);
    });

    it("a null anchor means the very top", async () => {
      expect((await move(ids[C], null)).statusCode).toBe(200);
      expect(await board()).toEqual(["C", "B", "A"]);
    });

    it("refuses to drop a card after itself", async () => {
      const res = await move(ids[C], ids[C]);
      expect(res.statusCode).toBe(400);
    });

    it("keeps the order when the card comes from ANOTHER column", async () => {
      const other = await app.inject({
        method: "POST",
        url: "/api/tasks/columns",
        headers: { cookie: adminCookie },
        payload: { name: "Elsewhere" },
      });
      const otherId = other.json().id;
      const made = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { cookie: adminCookie },
        payload: { title: "D", statusColumnId: otherId, assignees: [adminId] },
      });
      const d = made.json().id;
      ids.push(d);

      // C, B, A  →  drop D between C and B
      expect((await move(d, ids[C])).statusCode).toBe(200);
      expect(await board()).toEqual(["C", "D", "B", "A"]);

      await prisma.taskAssignee.deleteMany({ where: { taskId: d } });
      await prisma.task.deleteMany({ where: { id: d } });
      await prisma.taskColumn.deleteMany({ where: { id: otherId } });
    });

    it("the board's order stays on the BOARD — a card rollup and the table read newest-first", async () => {
      // The regression this pins: making board order the repository's default silently re-sorted
      // the table and every client/lead card rollup by a number that only means anything inside
      // one column — including their FINISHED work (2026-08-26 audit).
      const drag = await board();
      expect(drag[0]).not.toBe("A"); // the board is in dragged order, not creation order

      const rollup = await app.inject({
        method: "GET",
        url: `/api/tasks?view=entity&clientId=${clientId}`,
        headers: { cookie: adminCookie },
      });
      expect(rollup.statusCode).toBe(200);
      const mine = (rollup.json().items as { id: string; title: string }[]).filter((t) =>
        ids.includes(t.id),
      );
      // newest first, whatever the board says — C was created last
      expect(mine.map((t) => t.title)).toEqual(["C", "B", "A"]);

      const table = await app.inject({
        method: "GET",
        url: `/api/tasks?view=table&clientId=${clientId}`,
        headers: { cookie: adminCookie },
      });
      const rows = (table.json().items as { id: string; title: string }[]).filter((t) =>
        ids.includes(t.id),
      );
      expect(rows.map((t) => t.title)).toEqual(["C", "B", "A"]);
    });

    it("a move on a FILTERED board leaves the hidden cards where they were", async () => {
      // This is the case a naive "renumber what you can see" implementation gets wrong. B is
      // reassigned to the other user, so an assignee-filtered board shows only C and A — and
      // dragging A above C there must not move B out of the middle of the real column.
      await prisma.taskAssignee.deleteMany({ where: { taskId: ids[B] } });
      await prisma.taskAssignee.create({ data: { taskId: ids[B], userId: userId } });

      const filtered = await board(`&assigneeId=${adminId}`);
      expect(filtered).toEqual(["C", "A"]); // B is hidden

      // on that filtered board, drag A to the top — the anchor is "nothing above me"
      expect((await move(ids[A], null)).statusCode).toBe(200);

      expect(await board(`&assigneeId=${adminId}`)).toEqual(["A", "C"]);
      // and the full board still holds B between them, exactly where it was
      expect(await board()).toEqual(["A", "C", "B"]);
    });
  });
});
