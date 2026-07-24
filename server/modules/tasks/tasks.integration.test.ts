import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { config } from "../../core/config.js";
import { prisma } from "../../core/db.js";
import { generateSubscriptionTasks } from "./tasks.generation.js";

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

async function makeClient(first: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/clients",
    headers: { cookie: adminCookie },
    payload: { type: "individual", firstName: first, lastName: "Tasks", companyNames: [], people: [] },
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
  await prisma.clientServiceCategory.deleteMany();
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

    // a column holding tasks refuses deletion (internal task = no target needed)
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Occupies column", statusColumnId: doingId, assignees: [adminId] },
    });
    expect(task.statusCode).toBe(201);
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
    const priorities = await prisma.priority.findMany();
    expect(task.priorityId).toBe(priorities.find((p) => p.isDefault)!.id);
    const fixedCol = await prisma.taskColumn.findFirstOrThrow({ where: { isFixed: true } });
    expect(task.statusColumnId).toBe(fixedCol.id);

    // lead task → free internal work (no service on leads)
    const lead = await app.inject({
      method: "POST",
      url: "/api/leads",
      headers: { cookie: adminCookie },
      payload: { type: "individual", name: "Task Lead", phone: "+380500000000" },
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
    expect(generated!.plannedMinutes).toBe(120);

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
});
