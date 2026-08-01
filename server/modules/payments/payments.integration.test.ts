import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { config } from "../../core/config.js";
import { prisma } from "../../core/db.js";
import { generatePeriodInvoices } from "./payments.generation.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie: string;
let userCookie: string;
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

/**
 * First day of the current month, "YYYY-MM-DD". A subscription that starts here covers the period
 * from its first day, which is what makes the period billable automatically — one starting
 * mid-month is only PARTLY served and is deliberately left to a human (decision 2026-07-29).
 */
function periodStartIso(): string {
  const { y, m } = today();
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function today() {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: config.TZ }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d, iso: s, monthKey: `${y}-${String(m).padStart(2, "0")}` };
}

async function makeClient(first: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/clients",
    headers: { cookie: adminCookie },
    payload: { firstName: first, lastName: "Pay", companies: [], people: [] },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function makeInvoice(clientId: string, amount: number, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/invoices",
    headers: { cookie: userCookie },
    payload: { clientId, amount, description: "Consulting", ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function wipe() {
  await prisma.paymentAuditLog.deleteMany();
  await prisma.payment.deleteMany();
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
}

beforeAll(async () => {
  app = await buildApp();
  await wipe();
  await prisma.session.deleteMany();
  await prisma.authToken.deleteMany();
  await prisma.file.deleteMany();
  await prisma.user.deleteMany();
  await ensureBaseData();

  const pass = await argon2.hash("password-123");
  await prisma.user.createMany({
    data: [
      { firstName: "Pay", lastName: "Admin", email: "pay-admin@test.local", passwordHash: pass, role: "admin", status: "active" },
      { firstName: "Pay", lastName: "User", email: "pay-user@test.local", passwordHash: pass, role: "user", status: "active" },
    ],
  });
  userId = (await prisma.user.findUniqueOrThrow({ where: { email: "pay-user@test.local" } })).id;
  adminCookie = await login("pay-admin@test.local", "password-123");
  userCookie = await login("pay-user@test.local", "password-123");
});

afterAll(async () => {
  await wipe();
  await app.close();
});

describe("payments", () => {
  it("manual invoice: numbered, partial payment, overpay rejected, debt follows the balance", async () => {
    const clientId = await makeClient("Ihor");
    const invoice = await makeInvoice(clientId, 50_000);

    const year = today().y;
    expect(invoice.number).toMatch(new RegExp(`^[A-Z]+-${year}-\\d{3,6}$`));
    expect(invoice.status).toBe("unpaid");
    expect(invoice.balance).toBe(50_000);

    // any user may register a payment
    const partial = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 20_000, paidAt: today().iso, reference: "bank-771" },
    });
    expect(partial.statusCode).toBe(201);
    expect(partial.json()).toMatchObject({ paid: 20_000, balance: 30_000, status: "partial" });
    expect(partial.json().payments[0].reference).toBe("bank-771");

    // more than what's left is refused
    const over = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 30_001, paidAt: today().iso },
    });
    expect(over.statusCode).toBe(400);

    // debt on the client card = open balance
    const client = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, headers: { cookie: userCookie } });
    expect(client.json().debt).toBe(30_000);

    // settling the rest flips it to paid and clears the debt
    const rest = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 30_000, paidAt: today().iso },
    });
    expect(rest.json().status).toBe("paid");
    const settled = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, headers: { cookie: userCookie } });
    expect(settled.json().debt).toBe(0);
  });

  it("payment edits are admin-only and land in the audit journal", async () => {
    const clientId = await makeClient("Olha");
    const invoice = await makeInvoice(clientId, 40_000);
    const added = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 10_000, paidAt: today().iso },
    });
    const paymentId = added.json().payments[0].id;

    // a regular user can't edit or delete
    const forbidden = await app.inject({
      method: "PATCH",
      url: `/api/invoices/payments/${paymentId}`,
      headers: { cookie: userCookie },
      payload: { amount: 15_000 },
    });
    expect(forbidden.statusCode).toBe(403);

    // an edit may not push the payments past the invoice total
    const tooBig = await app.inject({
      method: "PATCH",
      url: `/api/invoices/payments/${paymentId}`,
      headers: { cookie: adminCookie },
      payload: { amount: 40_001 },
    });
    expect(tooBig.statusCode).toBe(400);

    const fixed = await app.inject({
      method: "PATCH",
      url: `/api/invoices/payments/${paymentId}`,
      headers: { cookie: adminCookie },
      payload: { amount: 15_000, reference: "corrected" },
    });
    expect(fixed.json()).toMatchObject({ paid: 15_000, balance: 25_000 });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/invoices/payments/${paymentId}`,
      headers: { cookie: adminCookie },
    });
    expect(removed.json()).toMatchObject({ paid: 0, status: "unpaid" });

    const audit = await app.inject({
      method: "GET",
      url: `/api/invoices/${invoice.id}/audit`,
      headers: { cookie: adminCookie },
    });
    expect(audit.json().map((a: { action: string }) => a.action)).toEqual([
      "deleted",
      "updated",
      "created",
    ]);
    const update = audit.json().find((a: { action: string }) => a.action === "updated");
    expect(update.before.amount).toBe(10_000);
    expect(update.after.amount).toBe(15_000);
    expect(audit.json()[0].byUserName).toBe("Pay Admin");
  });

  it("cancel: admin-only, blocked while payments exist, then drops out of debt and the list", async () => {
    const clientId = await makeClient("Taras");
    const invoice = await makeInvoice(clientId, 30_000);
    await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 5_000, paidAt: today().iso },
    });

    const asUser = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/cancel`,
      headers: { cookie: userCookie },
    });
    expect(asUser.statusCode).toBe(403);

    const withPayments = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/cancel`,
      headers: { cookie: adminCookie },
    });
    expect(withPayments.statusCode).toBe(400);

    const paymentId = (await app.inject({
      method: "GET",
      url: `/api/invoices/${invoice.id}`,
      headers: { cookie: adminCookie },
    })).json().payments[0].id;
    await app.inject({ method: "DELETE", url: `/api/invoices/payments/${paymentId}`, headers: { cookie: adminCookie } });

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/cancel`,
      headers: { cookie: adminCookie },
    });
    expect(cancelled.json()).toMatchObject({ status: "cancelled", balance: 0, cancelledByName: "Pay Admin" });

    const client = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, headers: { cookie: userCookie } });
    expect(client.json().debt).toBe(0);

    // gone from the default list, present on its own chip
    const all = await app.inject({ method: "GET", url: `/api/invoices?clientId=${clientId}`, headers: { cookie: userCookie } });
    expect(all.json().items).toHaveLength(0);
    const onlyCancelled = await app.inject({
      method: "GET",
      url: `/api/invoices?filter=cancelled&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(onlyCancelled.json().items).toHaveLength(1);
  });

  it("delivery: an invoice is 'created' until it's marked sent, and the task sees it", async () => {
    const clientId = await makeClient("Roman");
    const invoice = await makeInvoice(clientId, 15_000, {
      withTask: true,
      taskTitle: "Send the papers",
    });
    expect(invoice.delivery).toBe("created");
    expect(invoice.sentAt).toBeNull();

    // shows up under the "not sent" filter
    const unsent = await app.inject({
      method: "GET",
      url: `/api/invoices?filter=unsent&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(unsent.json().items).toHaveLength(1);

    // any user may mark it as handed over
    const sent = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/delivery`,
      headers: { cookie: userCookie },
      payload: { sent: true },
    });
    expect(sent.json()).toMatchObject({ delivery: "sent", sentByName: "Pay User" });
    expect(sent.json().sentAt).not.toBeNull();

    // the job carries the settlement + delivery state, so nobody has to open Billing
    const tasks = await app.inject({
      method: "GET",
      url: `/api/tasks?view=board&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    const task = tasks.json().items.find((t: { title: string }) => t.title === "Send the papers");
    expect(task.invoice).toMatchObject({ status: "unpaid", paid: 0, balance: 15_000 });
    expect(task.invoice.sentAt).not.toBeNull();

    // a payment flips the status the task shows
    await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 5_000, paidAt: today().iso },
    });
    const after = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
      headers: { cookie: userCookie },
    });
    expect(after.json().invoice).toMatchObject({ status: "partial", paid: 5_000, balance: 10_000 });

    // and the mark can be taken back (mis-click)
    const undone = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/delivery`,
      headers: { cookie: userCookie },
      payload: { sent: false },
    });
    expect(undone.json()).toMatchObject({ delivery: "created", sentAt: null });
  });

  it("invoice + task opens the job already linked to the invoice", async () => {
    const clientId = await makeClient("Vira");
    const invoice = await makeInvoice(clientId, 25_000, {
      withTask: true,
      taskTitle: "Year-end filing",
      assigneeIds: [userId],
    });
    expect(invoice.taskTitle).toBe("Year-end filing");

    const tasks = await app.inject({
      method: "GET",
      url: `/api/tasks?view=board&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    const task = tasks.json().items.find((t: { title: string }) => t.title === "Year-end filing");
    expect(task.invoice.number).toBe(invoice.number);
    expect(task.amount).toBe(25_000);
    expect(task.assignees).toEqual([userId]);
  });

  it("period sweep: current period only, idempotent, dueDate from dueDays", async () => {
    const clientId = await makeClient("Marta");
    const service = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: {
        name: "Bookkeeping S7",
        type: "subscription",
        invoiceTrigger: "on_period_start",
        dueDays: 5,
        defaultAmount: 100_000,
      },
    });
    expect(service.statusCode).toBe(201);

    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: {
        serviceId: service.json().id,
        amount: 100_000,
        period: "month",
        startsOn: periodStartIso(),
      },
    });
    expect(sub.statusCode).toBe(201);

    // served from the period's first day → the period is whole, so it bills automatically
    const list = await app.inject({ method: "GET", url: `/api/invoices?clientId=${clientId}`, headers: { cookie: userCookie } });
    expect(list.json().items).toHaveLength(1);
    const invoice = list.json().items[0];
    expect(invoice.periodKey).toBe(today().monthKey);
    expect(invoice.amount).toBe(100_000);
    expect(new Date(invoice.dueDate).getTime() - new Date(invoice.issuedAt).getTime()).toBe(
      5 * 86_400_000,
    );

    // an old subscription is NOT back-billed: the window starts at the first day actually SERVED,
    // not at the row's creation date, so ageing the row changes nothing
    await prisma.subscription.updateMany({
      where: { clientId },
      data: { createdAt: new Date(Date.now() - 200 * 86_400_000) },
    });
    expect((await generatePeriodInvoices()).created).toBe(0);
    const after = await app.inject({ method: "GET", url: `/api/invoices?clientId=${clientId}`, headers: { cookie: userCookie } });
    expect(after.json().items).toHaveLength(1);
  });

  it("numbering: concurrent issues get distinct, consecutive numbers", async () => {
    const clientId = await makeClient("Sofia");
    const before = await prisma.firmProfile.findUniqueOrThrow({ where: { id: 1 } });

    const issued = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/api/invoices",
          headers: { cookie: userCookie },
          payload: { clientId, amount: 1_000 },
        }),
      ),
    );
    const numbers = issued.map((r) => r.json().number);
    expect(new Set(numbers).size).toBe(5); // no collisions under concurrency

    const counters = numbers.map((n: string) => Number(n.split("-").at(-1))).sort((a, b) => a - b);
    expect(counters).toEqual([1, 2, 3, 4, 5].map((i) => before.invoiceCounter + i)); // no gaps
  });

  it("period sweep respects the billing rule: end-of-period bills only at the period's end", async () => {
    const clientId = await makeClient("Bohdan");
    const service = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: {
        name: "Payroll S7",
        type: "subscription",
        invoiceTrigger: "on_period_end",
        defaultAmount: 50_000,
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      // from the period's FIRST day: this test is about the trigger day, not about coverage, and a
      // subscription starting today would be part-served and never auto-bill at all. Without this
      // the test only failed on the last day of a month — the one day its `expected` was 1.
      payload: {
        serviceId: service.json().id,
        amount: 50_000,
        period: "month",
        startsOn: periodStartIso(),
      },
    });

    // an end-of-period invoice only exists once the month is actually over
    const { y, m, d } = today();
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const expected = d === lastDay ? 1 : 0;
    const list = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(list.json().items).toHaveLength(expected);
    expect((await generatePeriodInvoices()).created).toBe(0); // still nothing new to bill
  });

  it("a partly served period is reminded about, never invoiced automatically", async () => {
    // LAST month, so its trigger day (the period's end, for postpay) has certainly passed —
    // whatever day of the month this suite happens to run on
    const { y, m } = today();
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    const ym = `${prev.y}-${String(prev.m).padStart(2, "0")}`;

    const clientId = await makeClient("Partial");
    const service = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: {
        name: "Partial S8",
        type: "subscription",
        invoiceTrigger: "on_period_end", // decided at the period's END, so a mid-month pause shows
        defaultAmount: 40_000,
      },
    });
    const sub = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: { serviceId: service.json().id, amount: 40_000, period: "month" },
    });
    const subId = sub.json().subscriptions[0].id;
    // The client joined MID-period, so that month is served only in part. A backdated start can no
    // longer be ENTERED (user, 2026-08-01), but the state is still reachable — a service running
    // since the 10th simply becomes history once the month turns — so the period is set directly.
    await prisma.subscriptionPeriod.updateMany({
      where: { subscriptionId: subId },
      data: { startsOn: new Date(`${ym}-10T00:00:00.000Z`) },
    });

    await generatePeriodInvoices();

    // No invoice for THAT period — half a month's amount is an agreement, not arithmetic. Scoped to
    // the period on purpose: this month is served in full from day one, so on the last day of a
    // month it legitimately bills, and asserting "no invoices at all" failed exactly then.
    const invoices = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(
      invoices.json().items.filter((i: { periodKey: string | null }) => i.periodKey === ym),
    ).toHaveLength(0);

    // …but it IS reported: one reminder task, and re-running the sweep never posts a second
    const reminders = await prisma.task.findMany({
      where: { subscriptionId: subId, systemKind: "partial_period_invoice" },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].clientId).toBe(clientId);
    expect(reminders[0].periodKey).toBe(ym);
    await generatePeriodInvoices();
    expect(
      await prisma.task.count({ where: { subscriptionId: subId, systemKind: { not: null } } }),
    ).toBe(1);

    // the CURRENT month is served in full so far, but its trigger day (the period's end) hasn't
    // arrived — so nothing at all has happened for it yet, neither invoice nor reminder
    const thisMonth = today().monthKey;
    expect(
      await prisma.task.count({ where: { subscriptionId: subId, periodKey: thisMonth } }),
    ).toBe(0);
  });

  it("a cancelled period invoice is never re-issued by the sweep", async () => {
    const clientId = await makeClient("Yulia");
    const service = await app.inject({
      method: "POST",
      url: "/api/catalog",
      headers: { cookie: adminCookie },
      payload: { name: "Reporting S7", type: "subscription", defaultAmount: 30_000 },
    });
    await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/subscriptions`,
      headers: { cookie: adminCookie },
      payload: {
        serviceId: service.json().id,
        amount: 30_000,
        period: "month",
        startsOn: periodStartIso(),
      },
    });
    const list = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    const invoiceId = list.json().items[0].id;

    await app.inject({
      method: "POST",
      url: `/api/invoices/${invoiceId}/cancel`,
      headers: { cookie: adminCookie },
    });
    expect((await generatePeriodInvoices()).created).toBe(0);

    const after = await app.inject({
      method: "GET",
      url: `/api/invoices?filter=all&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(after.json().items).toHaveLength(0); // still only the cancelled one, nothing regenerated
  });

  it("editing an issued invoice: admin-only, never below what's paid, the job's price follows", async () => {
    const clientId = await makeClient("Halyna");
    const invoice = await makeInvoice(clientId, 60_000, { withTask: true, taskTitle: "Audit prep" });

    const asUser = await app.inject({
      method: "PATCH",
      url: `/api/invoices/${invoice.id}`,
      headers: { cookie: userCookie },
      payload: { amount: 50_000 },
    });
    expect(asUser.statusCode).toBe(403);

    await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 40_000, paidAt: today().iso },
    });

    // can't shrink below the money already taken
    const tooLow = await app.inject({
      method: "PATCH",
      url: `/api/invoices/${invoice.id}`,
      headers: { cookie: adminCookie },
      payload: { amount: 30_000 },
    });
    expect(tooLow.statusCode).toBe(400);

    const fixed = await app.inject({
      method: "PATCH",
      url: `/api/invoices/${invoice.id}`,
      headers: { cookie: adminCookie },
      payload: { amount: 45_000, description: "Audit prep — corrected", dueDate: null },
    });
    expect(fixed.json()).toMatchObject({
      amount: 45_000,
      description: "Audit prep — corrected",
      dueDate: null,
      balance: 5_000,
      status: "partial",
    });

    // the linked job shows the corrected price, not the one the client was first billed
    const tasks = await app.inject({
      method: "GET",
      url: `/api/tasks?view=board&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    const task = tasks.json().items.find((t: { title: string }) => t.title === "Audit prep");
    expect(task.amount).toBe(45_000);
    expect(task.invoice.amount).toBe(45_000);

    // and the correction is in the journal
    const audit = await app.inject({
      method: "GET",
      url: `/api/invoices/${invoice.id}/audit`,
      headers: { cookie: adminCookie },
    });
    const edit = audit.json().find((a: { paymentId: string | null }) => a.paymentId === null);
    expect(edit.before.amount).toBe(60_000);
    expect(edit.after.amount).toBe(45_000);
  });

  it("archive: only settled invoices, hidden from the working list, reversible", async () => {
    const clientId = await makeClient("Yaroslav");
    const open = await makeInvoice(clientId, 20_000);
    const settled = await makeInvoice(clientId, 10_000);
    await app.inject({
      method: "POST",
      url: `/api/invoices/${settled.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 10_000, paidAt: today().iso },
    });

    // an unpaid invoice can never be archived — that would hide debt
    const bulk = await app.inject({
      method: "POST",
      url: "/api/invoices/bulk-archive",
      headers: { cookie: userCookie },
      payload: { invoiceIds: [open.id, settled.id], archived: true },
    });
    expect(bulk.json()).toEqual({ changed: 1, skipped: 1 });

    const working = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(working.json().items.map((i: { id: string }) => i.id)).toEqual([open.id]);

    const archived = await app.inject({
      method: "GET",
      url: `/api/invoices?filter=archived&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(archived.json().items).toHaveLength(1);
    expect(archived.json().items[0].archivedByName).toBe("Pay User");

    // restore
    const back = await app.inject({
      method: "POST",
      url: "/api/invoices/bulk-archive",
      headers: { cookie: userCookie },
      payload: { invoiceIds: [settled.id], archived: false },
    });
    expect(back.json()).toEqual({ changed: 1, skipped: 0 });
  });

  it("an archived invoice that becomes owed again comes back to the working list", async () => {
    const clientId = await makeClient("Solomiya");
    const invoice = await makeInvoice(clientId, 12_000);
    const paid = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 12_000, paidAt: today().iso },
    });
    const paymentId = paid.json().payments[0].id;
    await app.inject({
      method: "POST",
      url: "/api/invoices/bulk-archive",
      headers: { cookie: userCookie },
      payload: { invoiceIds: [invoice.id], archived: true },
    });

    // an admin deletes the payment → money is owed again → it must not stay hidden
    const afterDelete = await app.inject({
      method: "DELETE",
      url: `/api/invoices/payments/${paymentId}`,
      headers: { cookie: adminCookie },
    });
    expect(afterDelete.json()).toMatchObject({ archivedAt: null, balance: 12_000 });

    const working = await app.inject({
      method: "GET",
      url: `/api/invoices?filter=unpaid&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(working.json().items).toHaveLength(1);
  });

  it("bulk delivery marks several at once and the company filter narrows a client's list", async () => {
    const clientId = await makeClient("Oksana");
    const a = await makeInvoice(clientId, 5_000);
    const b = await makeInvoice(clientId, 7_000);

    const marked = await app.inject({
      method: "POST",
      url: "/api/invoices/bulk-delivery",
      headers: { cookie: userCookie },
      payload: { invoiceIds: [a.id, b.id], sent: true },
    });
    expect(marked.json()).toEqual({ changed: 2, skipped: 0 });
    // marking already-sent ones again is a no-op, not a double stamp
    const again = await app.inject({
      method: "POST",
      url: "/api/invoices/bulk-delivery",
      headers: { cookie: userCookie },
      payload: { invoiceIds: [a.id, b.id], sent: true },
    });
    expect(again.json()).toEqual({ changed: 0, skipped: 2 });

    const unsent = await app.inject({
      method: "GET",
      url: `/api/invoices?filter=unsent&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(unsent.json().items).toHaveLength(0);

    // both invoices sit on the client root → the "root" company filter finds them
    const root = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${clientId}&companyId=root`,
      headers: { cookie: userCookie },
    });
    expect(root.json().items).toHaveLength(2);
  });

  it("an archived client's invoices stay visible and flagged — money doesn't disappear", async () => {
    const clientId = await makeClient("Bohdana");
    const invoice = await makeInvoice(clientId, 33_000);
    await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/archive`,
      headers: { cookie: adminCookie },
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/invoices?filter=unpaid&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ id: invoice.id, clientArchived: true });
    expect(list.json().totals.receivable).toBe(33_000);
  });

  it("paidTotal never drifts from the payments that make it up", async () => {
    const clientId = await makeClient("Mykola");
    const invoice = await makeInvoice(clientId, 90_000);
    const stored = () => prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const real = async () =>
      (await prisma.payment.aggregate({ where: { invoiceId: invoice.id }, _sum: { amount: true } }))
        ._sum.amount ?? 0;

    const first = await app.inject({
      method: "POST",
      url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 30_000, paidAt: today().iso },
    });
    expect((await stored()).paidTotal).toBe(await real());
    const paymentId = first.json().payments[0].id;

    await app.inject({
      method: "PATCH",
      url: `/api/invoices/payments/${paymentId}`,
      headers: { cookie: adminCookie },
      payload: { amount: 45_000 },
    });
    expect((await stored()).paidTotal).toBe(await real());

    await app.inject({
      method: "POST",
      url: "/api/invoices/mark-paid",
      headers: { cookie: userCookie },
      payload: { invoiceIds: [invoice.id] },
    });
    expect((await stored()).paidTotal).toBe(90_000);
    expect((await stored()).paidTotal).toBe(await real());

    await app.inject({
      method: "DELETE",
      url: `/api/invoices/payments/${paymentId}`,
      headers: { cookie: adminCookie },
    });
    expect((await stored()).paidTotal).toBe(await real());

    // and the list filters — which now read that column — agree with it
    const owed = await app.inject({
      method: "GET",
      url: `/api/invoices?filter=unpaid&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(owed.json().items.map((i: { id: string }) => i.id)).toEqual([invoice.id]);
    expect(owed.json().totals.receivable).toBe(90_000 - (await real()));
  });

  it("mark-paid settles several invoices and skips the ones that don't need it", async () => {
    const clientId = await makeClient("Dmytro");
    const a = await makeInvoice(clientId, 10_000);
    const b = await makeInvoice(clientId, 20_000);
    await app.inject({
      method: "POST",
      url: `/api/invoices/${b.id}/payments`,
      headers: { cookie: userCookie },
      payload: { amount: 20_000, paidAt: today().iso },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/invoices/mark-paid",
      headers: { cookie: userCookie },
      payload: { invoiceIds: [a.id, b.id] },
    });
    expect(res.json()).toEqual({ settled: 1, skipped: 1 });

    const list = await app.inject({
      method: "GET",
      url: `/api/invoices?clientId=${clientId}&filter=paid`,
      headers: { cookie: userCookie },
    });
    expect(list.json().items).toHaveLength(2);
    expect(list.json().totals).toEqual({ receivable: 0, overdue: 0 });
  });

  it("overdue: only once the due DAY has passed, and it shows in the totals", async () => {
    const clientId = await makeClient("Nazar");

    // due today → not overdue yet (the day isn't over)
    const dueToday = await makeInvoice(clientId, 10_000);
    await prisma.invoice.update({
      where: { id: dueToday.id },
      data: { dueDate: new Date(`${today().iso}T00:00:00Z`) },
    });
    const still = await app.inject({
      method: "GET",
      url: `/api/invoices/${dueToday.id}`,
      headers: { cookie: userCookie },
    });
    expect(still.json().status).toBe("unpaid");

    const invoice = await makeInvoice(clientId, 70_000);
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { dueDate: new Date(Date.now() - 3 * 86_400_000) },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/invoices?filter=overdue&clientId=${clientId}`,
      headers: { cookie: userCookie },
    });
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].status).toBe("overdue");
    expect(res.json().totals).toEqual({ receivable: 70_000, overdue: 70_000 });
  });
});
