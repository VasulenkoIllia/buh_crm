import argon2 from "argon2";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import * as payments from "./index.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let userCookie: string;
let adminId: string;

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

async function wipe() {
  await prisma.invoiceLine.deleteMany();
  await prisma.paymentAuditLog.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.taskAssignee.deleteMany();
  await prisma.task.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.company.deleteMany();
  await prisma.client.deleteMany();
  await prisma.service.deleteMany();
}

beforeAll(async () => {
  app = await buildApp();
  await wipe();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await ensureBaseData();
  const passwordHash = await argon2.hash("password-123");
  await prisma.user.createMany({
    data: [
      {
        firstName: "Job",
        lastName: "Admin",
        email: "job-admin@test.local",
        passwordHash,
        role: "admin",
        status: "active",
      },
      {
        firstName: "Job",
        lastName: "User",
        email: "job-user@test.local",
        passwordHash,
        role: "user",
        status: "active",
      },
    ],
  });
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: "job-admin@test.local" } }))
    .id;
  adminCookie = await login("job-admin@test.local");
  userCookie = await login("job-user@test.local");
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await wipe();
  await app.close();
});

let clients = 0;

/** A client on a one-time service priced at 7000. `on_complete` bills nothing until Done. */
async function terms(trigger: "on_create" | "on_complete" = "on_complete") {
  const name = `Terms ${++clients}`;
  const client = await app.inject({
    method: "POST",
    url: "/api/clients",
    headers: { cookie: adminCookie },
    payload: { firstName: name, lastName: "Job", companies: [], people: [] },
  });
  expect(client.statusCode).toBe(201);
  const clientId: string = client.json().id;
  const service = await app.inject({
    method: "POST",
    url: "/api/catalog",
    headers: { cookie: adminCookie },
    payload: { name, type: "one_time", invoiceTrigger: trigger },
  });
  expect(service.statusCode).toBe(201);
  const sub = await app.inject({
    method: "POST",
    url: `/api/clients/${clientId}/subscriptions`,
    headers: { cookie: adminCookie },
    payload: { serviceId: service.json().id, amount: 7000 },
  });
  const subscriptionId: string = sub
    .json()
    .subscriptions.find((s: { serviceId: string }) => s.serviceId === service.json().id).id;
  return { clientId, subscriptionId, serviceId: service.json().id as string };
}

async function makeJob(
  on: Awaited<ReturnType<typeof terms>>,
  title = "Tax return",
): Promise<string> {
  const job = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers: { cookie: adminCookie },
    payload: {
      title,
      clientId: on.clientId,
      subscriptionId: on.subscriptionId,
      assignees: [adminId],
    },
  });
  expect(job.statusCode).toBe(201);
  return job.json().id;
}

const issue = (payload: Record<string, unknown>, cookie = userCookie) =>
  app.inject({
    method: "POST",
    url: "/api/invoices",
    headers: { cookie },
    payload: { amount: 7000, ...payload },
  });

const attach = (invoiceId: string, taskId: string, cookie = adminCookie) =>
  app.inject({
    method: "POST",
    url: `/api/invoices/${invoiceId}/attach-job`,
    headers: { cookie },
    payload: { taskId },
  });

const jobOf = async (id: string) =>
  (
    await app.inject({
      method: "GET",
      url: `/api/tasks/${id}`,
      headers: { cookie: userCookie },
    })
  ).json();

const setDone = (id: string, done: boolean, cookie = userCookie) =>
  app.inject({
    method: "PATCH",
    url: `/api/tasks/${id}`,
    headers: { cookie },
    payload: { done },
  });

const unbilled = async (clientId: string) =>
  (
    await app.inject({
      method: "GET",
      url: `/api/invoices/unbilled-jobs?clientId=${clientId}`,
      headers: { cookie: userCookie },
    })
  ).json() as { id: string; title: string; amount: number | null }[];

/** The one entry the flush writes after the reply has gone out. */
const logged = (action: string, subjectId: string) =>
  vi.waitFor(
    async () => {
      const row = await prisma.activityEvent.findFirst({ where: { action, subjectId } });
      if (!row) throw new Error("not written yet");
      return row;
    },
    { timeout: 3000 },
  );

describe("an invoice issued by hand for a job", () => {
  it("links the job, so the card has its invoice and the list drops it", async () => {
    const on = await terms();
    const jobId = await makeJob(on);
    expect((await unbilled(on.clientId)).map((j) => j.id)).toEqual([jobId]);

    const issued = await issue({ clientId: on.clientId, taskId: jobId });
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({ taskId: jobId, taskTitle: "Tax return" });

    // the card's `⏳ unbilled` reads exactly this
    const job = await jobOf(jobId);
    expect(job.invoice).toMatchObject({ number: issued.json().number, status: "unpaid" });
    expect(await unbilled(on.clientId)).toEqual([]);

    const entry = await logged("task.invoice_attached", jobId);
    expect(entry.changes).toEqual({ invoice: issued.json().number });
  });

  it("takes service and company from the job, whatever the form had picked", async () => {
    const on = await terms();
    const other = await terms();
    const jobId = await makeJob(on);

    // a service of another client would be refused on a plain invoice; the job decides here
    const issued = await issue({
      clientId: on.clientId,
      taskId: jobId,
      subscriptionId: other.subscriptionId,
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({
      serviceId: on.serviceId,
      subscriptionId: on.subscriptionId,
    });
  });

  it("moves the job's price to the invoice's total, and the log keeps the old one", async () => {
    const on = await terms();
    const jobId = await makeJob(on);

    const issued = await issue({
      clientId: on.clientId,
      taskId: jobId,
      amount: 1,
      lines: [
        { description: "Return", amount: 5000 },
        { description: "Extras", amount: 4000 },
      ],
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().amount).toBe(9000);
    expect(issued.json().lines).toHaveLength(2);
    expect((await jobOf(jobId)).amount).toBe(9000);

    const entry = await logged("task.invoice_attached", jobId);
    expect(entry.changes).toEqual({
      invoice: issued.json().number,
      amount: { from: 7000, to: 9000 },
    });
  });

  it("refuses a second invoice and names the first", async () => {
    const on = await terms();
    const jobId = await makeJob(on);
    const first = await issue({ clientId: on.clientId, taskId: jobId });

    const second = await issue({ clientId: on.clientId, taskId: jobId });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toContain(first.json().number);
    expect(await prisma.invoice.count({ where: { clientId: on.clientId } })).toBe(1);
  });

  it("gives two people pressing at once one invoice", async () => {
    const on = await terms();
    const jobId = await makeJob(on);

    const answers = await Promise.all([
      issue({ clientId: on.clientId, taskId: jobId }),
      issue({ clientId: on.clientId, taskId: jobId }, adminCookie),
    ]);
    expect(answers.map((a) => a.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.invoice.count({ where: { clientId: on.clientId } })).toBe(1);
  });

  it("does not bill an on_complete job again on Done, Reopen and Done", async () => {
    const on = await terms("on_complete");
    const jobId = await makeJob(on);
    await issue({ clientId: on.clientId, taskId: jobId });

    expect((await setDone(jobId, true)).statusCode).toBe(200);
    expect((await setDone(jobId, false)).statusCode).toBe(200);
    expect((await setDone(jobId, true)).statusCode).toBe(200);
    expect(await prisma.invoice.count({ where: { clientId: on.clientId } })).toBe(1);
  });

  it("issues one invoice when Done and the hand-issued one land together", async () => {
    const on = await terms("on_complete");
    const jobId = await makeJob(on);

    const [, byHand] = await Promise.all([
      setDone(jobId, true),
      issue({ clientId: on.clientId, taskId: jobId }),
    ]);
    expect([201, 409]).toContain(byHand.statusCode);
    expect(await prisma.invoice.count({ where: { clientId: on.clientId } })).toBe(1);
    expect((await jobOf(jobId)).invoice).not.toBeNull();
  });

  it("closes the gap the failed invoice left: billed by hand, and billed once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(payments, "issueJobInvoice").mockRejectedValueOnce(new Error("no connection"));
    const on = await terms("on_create");

    const jobId = await makeJob(on);
    expect((await jobOf(jobId)).invoice).toBeNull();
    expect(await prisma.invoice.count({ where: { clientId: on.clientId } })).toBe(0);

    const issued = await issue({ clientId: on.clientId, taskId: jobId });
    expect(issued.statusCode).toBe(201);
    expect((await jobOf(jobId)).invoice.number).toBe(issued.json().number);
    expect(await prisma.invoice.count({ where: { clientId: on.clientId } })).toBe(1);
  });

  it("bills a job again once its invoice is void, and the link moves", async () => {
    const on = await terms();
    const jobId = await makeJob(on);
    const voided = await issue({ clientId: on.clientId, taskId: jobId });
    await app.inject({
      method: "POST",
      url: `/api/invoices/${voided.json().id}/cancel`,
      headers: { cookie: adminCookie },
    });
    expect((await unbilled(on.clientId)).map((j) => j.id)).toEqual([jobId]);

    const issued = await issue({ clientId: on.clientId, taskId: jobId });
    expect(issued.statusCode).toBe(201);
    expect((await jobOf(jobId)).invoiceId).toBe(issued.json().id);
  });

  it("leaves a job with no service without one, whatever the form opened on", async () => {
    const on = await terms();
    const opened = await issue({
      clientId: on.clientId,
      withTask: true,
      taskTitle: "Plain job",
    });
    const jobId: string = opened.json().taskId;
    await app.inject({
      method: "POST",
      url: `/api/invoices/${opened.json().id}/cancel`,
      headers: { cookie: adminCookie },
    });

    const issued = await issue({
      clientId: on.clientId,
      taskId: jobId,
      subscriptionId: on.subscriptionId,
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({ subscriptionId: null, serviceId: null });
  });

  it("refuses a job that cannot take one", async () => {
    const on = await terms();
    const other = await terms();
    const theirs = await makeJob(other);
    const calledOff = await makeJob(on, "Called off");
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${calledOff}`,
      headers: { cookie: adminCookie },
      payload: { cancelled: true },
    });
    const free = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: adminCookie },
      payload: { title: "Internal", internal: true, assignees: [adminId] },
    });
    expect(free.statusCode).toBe(201);

    const taken = (taskId: string) => issue({ clientId: on.clientId, taskId });
    expect((await taken(theirs)).statusCode).toBe(400);
    expect((await taken(calledOff)).statusCode).toBe(409);
    expect((await taken(free.json().id)).statusCode).toBe(400);
    expect((await taken("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect(
      (await issue({ clientId: on.clientId, taskId: theirs, withTask: true, taskTitle: "X" }))
        .statusCode,
    ).toBe(400);
    expect(await prisma.invoice.count({ where: { clientId: on.clientId } })).toBe(0);
    expect((await unbilled(on.clientId)).map((j) => j.title)).not.toContain("Called off");
  });
});

describe("attaching an invoice already issued", () => {
  it("links it, moves the price, and a second invoice is refused", async () => {
    const on = await terms();
    const jobId = await makeJob(on);
    const plain = await issue({ clientId: on.clientId, amount: 7500 });
    expect(plain.json().taskId).toBeNull();

    const attached = await attach(plain.json().id, jobId);
    expect(attached.statusCode).toBe(200);
    expect(attached.json()).toMatchObject({ taskId: jobId, taskTitle: "Tax return" });

    const job = await jobOf(jobId);
    expect(job.invoice.number).toBe(plain.json().number);
    expect(job.amount).toBe(7500);
    const entry = await logged("task.invoice_attached", jobId);
    expect(entry.changes).toEqual({
      invoice: plain.json().number,
      amount: { from: 7000, to: 7500 },
    });

    expect((await issue({ clientId: on.clientId, taskId: jobId })).statusCode).toBe(409);
  });

  it("stops Reopen and Done billing a job somebody billed by hand", async () => {
    const on = await terms("on_complete");
    const jobId = await makeJob(on);
    const plain = await issue({ clientId: on.clientId });
    await attach(plain.json().id, jobId);

    await setDone(jobId, true);
    await setDone(jobId, false);
    await setDone(jobId, true);
    expect(await prisma.invoice.count({ where: { clientId: on.clientId } })).toBe(1);
  });

  it("keeps the job on one invoice when attaching and Done land together", async () => {
    const on = await terms("on_complete");
    const jobId = await makeJob(on);
    const plain = await issue({ clientId: on.clientId });

    const [attached] = await Promise.all([
      attach(plain.json().id, jobId),
      setDone(jobId, true),
    ]);

    // either order is right: attached first and Done bills nothing, or Done first and attaching
    // is refused, and the invoice issued by hand stays as it was
    expect([200, 409]).toContain(attached.statusCode);
    expect(await prisma.invoice.count({ where: { clientId: on.clientId } })).toBe(
      attached.statusCode === 200 ? 1 : 2,
    );
    expect(await prisma.task.count({ where: { invoiceId: plain.json().id } })).toBe(
      attached.statusCode === 200 ? 1 : 0,
    );
    expect((await jobOf(jobId)).invoice).not.toBeNull();
  });

  it("is an admin's act", async () => {
    const on = await terms();
    const jobId = await makeJob(on);
    const plain = await issue({ clientId: on.clientId });

    expect((await attach(plain.json().id, jobId, userCookie)).statusCode).toBe(403);
    expect((await jobOf(jobId)).invoice).toBeNull();
  });

  it("refuses an invoice that cannot bill this job", async () => {
    const on = await terms();
    const other = await terms();
    const jobId = await makeJob(on);
    const billed = await makeJob(on, "Billed");
    const live = await issue({ clientId: on.clientId, taskId: billed });

    const voided = await issue({ clientId: on.clientId });
    await app.inject({
      method: "POST",
      url: `/api/invoices/${voided.json().id}/cancel`,
      headers: { cookie: adminCookie },
    });
    const theirs = await issue({ clientId: other.clientId });
    const period = await issue({ clientId: on.clientId });
    await prisma.invoice.update({
      where: { id: period.json().id },
      data: { subscriptionId: on.subscriptionId, periodKey: "2026-10" },
    });
    const spare = await issue({ clientId: on.clientId });

    expect((await attach(voided.json().id, jobId)).statusCode).toBe(400);
    expect((await attach(period.json().id, jobId)).statusCode).toBe(400);
    expect((await attach(theirs.json().id, jobId)).statusCode).toBe(400);
    // an invoice stays on one job, and a job on one live invoice
    expect((await attach(live.json().id, jobId)).statusCode).toBe(409);
    expect((await attach(spare.json().id, billed)).statusCode).toBe(409);
    expect((await jobOf(jobId)).invoice).toBeNull();
  });

  it("answers 404 for a job or an invoice that is not there", async () => {
    const on = await terms();
    const jobId = await makeJob(on);
    const plain = await issue({ clientId: on.clientId });
    const nothing = "00000000-0000-4000-8000-000000000000";

    expect((await attach(plain.json().id, nothing)).statusCode).toBe(404);
    expect((await attach(nothing, jobId)).statusCode).toBe(404);
  });

  it("puts one invoice on one job when two are attached at once", async () => {
    const on = await terms();
    const first = await makeJob(on, "First");
    const second = await makeJob(on, "Second");
    const plain = await issue({ clientId: on.clientId });

    const answers = await Promise.all([
      attach(plain.json().id, first),
      attach(plain.json().id, second),
    ]);
    expect(answers.map((a) => a.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.task.count({ where: { invoiceId: plain.json().id } })).toBe(1);
  });
});

describe("the list of unbilled jobs", () => {
  it("is open to Billing and shows what the form needs", async () => {
    const on = await terms();
    const jobId = await makeJob(on, "Listed");

    expect(await unbilled(on.clientId)).toEqual([
      {
        id: jobId,
        title: "Listed",
        amount: 7000,
        done: false,
        subscriptionId: on.subscriptionId,
        serviceName: expect.stringContaining("Terms"),
        companyId: null,
        companyName: null,
      },
    ]);
  });
});
