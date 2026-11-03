import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";

/**
 * **Bill to, and positions counted in hours or in items** (payments-plan-2026-11.md, R1): the
 * client's requests of 2026-11-02, through the real route.
 */

const TAG = `r1${randomUUID().slice(0, 6)}`;
const DOMAIN = `@${TAG}.local`;
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;

let clientId: string;
let companyA: string;
let companyB: string;
/** the client's service, held on company A */
let onA: string;

const post = (url: string, payload: object) =>
  app.inject({ method: "POST", url, headers: { cookie: admin.cookie }, payload });

async function issue(payload: object) {
  return post("/api/invoices", { clientId, amount: 10_000, ...payload });
}

async function issued(payload: object) {
  const res = await issue(payload);
  expect(res.statusCode).toBe(201);
  return res.json<{
    id: string;
    companyId: string | null;
    amount: number;
    lines: { quantity: number | null; unitRate: number | null; amount: number; unit: string }[];
  }>();
}

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  [admin] = await createPeople(app, DOMAIN, ["Olena"], "admin");

  const client = await post("/api/clients", {
    firstName: `${TAG} Taylor`,
    companies: [{ name: `${TAG} Alpha LLC` }, { name: `${TAG} Beta LLC` }],
    people: [],
  });
  expect(client.statusCode).toBe(201);
  clientId = client.json().id;
  const companies = client.json<{ companies: { id: string; name: string }[] }>().companies;
  companyA = companies.find((c) => c.name.endsWith("Alpha LLC"))!.id;
  companyB = companies.find((c) => c.name.endsWith("Beta LLC"))!.id;

  const service = await post("/api/catalog", {
    name: `${TAG} Tax return`,
    type: "one_time",
    defaultAmount: 0,
  });
  expect(service.statusCode).toBe(201);
  const subscribed = await post(`/api/clients/${clientId}/subscriptions`, {
    serviceId: service.json().id,
    amount: 10_000,
    companyId: companyA,
  });
  expect(subscribed.statusCode).toBe(201);
  onA = subscribed
    .json<{ subscriptions: { id: string; companyId: string | null }[] }>()
    .subscriptions.find((s) => s.companyId === companyA)!.id;
});

afterAll(async () => {
  const mine = { client: { firstName: { startsWith: TAG } } };
  await prisma.invoiceLine.deleteMany({ where: { invoice: mine } });
  await prisma.taskAssignee.deleteMany({ where: { task: mine } });
  await prisma.task.deleteMany({ where: mine });
  await prisma.invoice.deleteMany({ where: mine });
  await prisma.subscription.deleteMany({ where: mine });
  await prisma.company.deleteMany({ where: mine });
  await prisma.client.deleteMany({ where: { firstName: { startsWith: TAG } } });
  await prisma.service.deleteMany({ where: { name: { startsWith: TAG } } });
  await removePeople(DOMAIN);
  await app.close();
});

describe("Bill to", () => {
  it("follows the service's company when nobody picks one, as before it existed", async () => {
    expect((await issued({ subscriptionId: onA })).companyId).toBe(companyA);
  });

  it("puts a service held on one company on another, and a plain charge on a company", async () => {
    expect((await issued({ subscriptionId: onA, companyId: companyB })).companyId).toBe(
      companyB,
    );
    expect((await issued({ companyId: companyB })).companyId).toBe(companyB);
  });

  it("addresses the client itself when told null, whatever the service's company", async () => {
    expect((await issued({ subscriptionId: onA, companyId: null })).companyId).toBeNull();
  });

  it("refuses another client's company", async () => {
    const other = await post("/api/clients", {
      firstName: `${TAG} Other`,
      companies: [{ name: `${TAG} Gamma LLC` }],
      people: [],
    });
    const foreign = other.json<{ companies: { id: string }[] }>().companies[0].id;
    const res = await issue({ companyId: foreign });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("That company isn't one of this client's");
  });

  it("gives the job it opens the invoice's company", async () => {
    const invoice = await issued({
      subscriptionId: onA,
      companyId: companyB,
      withTask: true,
      taskTitle: "Prepare the return",
    });
    const task = await prisma.task.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(task.companyId).toBe(companyB);
  });
});

describe("Bill to in the log", () => {
  it("names the company the invoice was issued to", async () => {
    const invoice = await issued({ subscriptionId: onA, companyId: companyB });
    // the log is written after the response
    let row = null;
    for (let attempt = 0; attempt < 50 && !row; attempt++) {
      row = await prisma.activityEvent.findFirst({
        where: { action: "invoice.issued", subjectId: invoice.id },
      });
      if (!row) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(row?.changes).toEqual({ amount: 10_000, company: `${TAG} Beta LLC` });
  });
});

describe("Bill to in a correction (owner, 2026-11-03)", () => {
  const correct = (id: string, payload: object) =>
    app.inject({
      method: "PATCH",
      url: `/api/invoices/${id}`,
      headers: { cookie: admin.cookie },
      payload,
    });

  async function lastCorrection(invoiceId: string, count: number) {
    // the log is written after the response
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await prisma.activityEvent.findMany({
        where: { action: "invoice.updated", subjectId: invoiceId },
        orderBy: { occurredAt: "desc" },
      });
      if (rows.length >= count) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("no invoice.updated row");
  }

  it("moves the invoice to another company or to the client, and logs it in words", async () => {
    const invoice = await issued({ subscriptionId: onA });
    const toB = await correct(invoice.id, { companyId: companyB });
    expect(toB.statusCode).toBe(200);
    expect(toB.json().companyId).toBe(companyB);
    expect((await lastCorrection(invoice.id, 1)).changes).toEqual({
      billTo: { from: `${TAG} Alpha LLC`, to: `${TAG} Beta LLC` },
    });

    const toClient = await correct(invoice.id, { companyId: null });
    expect(toClient.json().companyId).toBeNull();
    expect((await lastCorrection(invoice.id, 2)).changes).toEqual({
      billTo: { from: `${TAG} Beta LLC`, to: `${TAG} Taylor` },
    });
  });

  it("logs a move between a client and their company of the same name", async () => {
    const sole = await post("/api/clients", {
      firstName: `${TAG} Sole`,
      companies: [{ name: `${TAG} Sole` }],
      people: [],
    });
    const company = sole.json<{ companies: { id: string }[] }>().companies[0].id;
    const issuedRes = await post("/api/invoices", { clientId: sole.json().id, amount: 10_000 });
    const invoiceId = issuedRes.json<{ id: string }>().id;

    expect((await correct(invoiceId, { companyId: company })).json().companyId).toBe(company);
    expect((await lastCorrection(invoiceId, 1)).changes).toEqual({
      billTo: { from: `${TAG} Sole`, to: `${TAG} Sole` },
    });
    const audit = await prisma.paymentAuditLog.findFirstOrThrow({
      where: { invoiceId, action: "updated" },
    });
    expect(audit.before).toMatchObject({ companyId: null });
    expect(audit.after).toMatchObject({ companyId: company });
  });

  it("leaves Bill to alone when the correction does not name it", async () => {
    const invoice = await issued({ subscriptionId: onA });
    const res = await correct(invoice.id, { dueDate: "2026-12-31" });
    expect(res.json().companyId).toBe(companyA);
  });

  it("refuses another client's company", async () => {
    const other = await post("/api/clients", {
      firstName: `${TAG} Stranger`,
      companies: [{ name: `${TAG} Delta LLC` }],
      people: [],
    });
    const foreign = other.json<{ companies: { id: string }[] }>().companies[0].id;
    const invoice = await issued({ subscriptionId: onA });
    const res = await correct(invoice.id, { companyId: foreign });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("That company isn't one of this client's");
  });

  it("moves a job's invoice too, and the job keeps its own company", async () => {
    const invoice = await issued({
      subscriptionId: onA,
      companyId: companyB,
      withTask: true,
      taskTitle: "Bookkeeping",
    });
    expect((await correct(invoice.id, { companyId: companyA })).json().companyId).toBe(
      companyA,
    );
    const task = await prisma.task.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(task.companyId).toBe(companyB);
  });
});

describe("Bill to beside a job", () => {
  it("leaves the job's own company standing, whatever Bill to says", async () => {
    // a job opened on the client itself, then freed by cancelling its invoice
    const first = await issued({ companyId: null, withTask: true, taskTitle: "Year-end" });
    const task = await prisma.task.findFirstOrThrow({ where: { invoiceId: first.id } });
    expect((await post(`/api/invoices/${first.id}/cancel`, {})).statusCode).toBe(200);

    expect((await issued({ taskId: task.id, companyId: companyA })).companyId).toBeNull();
  });
});

describe("positions counted in items", () => {
  it("multiplies a count of items by their price on the server", async () => {
    const invoice = await issued({
      lines: [
        { description: "W-2 form", quantity: 200, unitRate: 50_00, amount: 1, unit: "item" },
      ],
    });
    expect(invoice.amount).toBe(100_00);
    expect(invoice.lines[0]).toMatchObject({ quantity: 200, unitRate: 50_00, unit: "item" });
  });

  it("counts items in whole numbers only", async () => {
    const res = await issue({
      lines: [
        { description: "W-2 form", quantity: 250, unitRate: 50_00, amount: 1, unit: "item" },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it("stores no unit for a caller that sends none, which reads as hours", async () => {
    const invoice = await issued({
      lines: [{ description: "Consultation", quantity: 150, unitRate: 200_00, amount: 1 }],
    });
    expect(invoice.amount).toBe(300_00);
    expect(invoice.lines[0].unit).toBeNull();
  });

  it("keeps a unit only beside a quantity", async () => {
    const invoice = await issued({
      lines: [{ description: "Filing fee", amount: 35_00, unit: "item" }],
    });
    expect(invoice.lines[0]).toMatchObject({ quantity: null, unit: null, amount: 35_00 });
  });
});
