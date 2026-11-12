import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { ensureBaseData } from "../../core/bootstrap.js";
import { prisma } from "../../core/db.js";
import { createPeople, removePeople, type Person } from "../../test/people.js";

/**
 * **One lock for an invoice's money** (payments.md §9): a payment written, edited or deleted, and
 * the invoice's cancel, each open by taking the invoice's row lock, so two of them at once queue
 * instead of each judging the invoice by rows the other has not committed yet.
 *
 * Each test holds that lock itself until both requests are queued on it, then lets them through in
 * the order they were sent, so the interleaving is a fact rather than a likely timing.
 */

const DOMAIN = "@paylocks.local";
const TAG = `pl${randomUUID().slice(0, 6)}`;
const PAID_AT = "2026-11-02";
let app: Awaited<ReturnType<typeof buildApp>>;
let admin: Person;
let clientId: string;

type Method = "POST" | "PATCH" | "DELETE";
const as = (method: Method, url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: admin.cookie }, payload });

async function makeInvoice(amount: number) {
  const res = await as("POST", "/api/invoices", {
    clientId,
    amount,
    description: "Bookkeeping",
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function pay(invoiceId: string, amount: number) {
  const res = await as("POST", `/api/invoices/${invoiceId}/payments`, {
    amount,
    paidAt: PAID_AT,
  });
  expect(res.statusCode).toBe(201);
  return (await prisma.payment.findFirstOrThrow({ where: { invoiceId, amount } })).id;
}

/**
 * The backends queued on a ROW behind `holder`: the first waits for its transaction to end, the next
 * ones for the first one's turn at the row. Not every lock wait in the database: a short wait of
 * somebody else's (an insert extending a table) would pass for a queued request and let the next
 * one overtake it.
 */
async function queuedBehind(holder: number) {
  const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
    WITH RECURSIVE queue AS (
      SELECT pid FROM pg_stat_activity
      WHERE wait_event IN ('transactionid', 'tuple') AND ${holder}::int = ANY(pg_blocking_pids(pid))
      UNION
      SELECT a.pid FROM pg_stat_activity a JOIN queue q ON q.pid = ANY(pg_blocking_pids(a.pid))
      WHERE a.wait_event IN ('transactionid', 'tuple')
    )
    SELECT count(*)::int AS waiting FROM queue`;
  return row.waiting;
}

/**
 * Send the requests while holding the invoice's row lock, each one only once the one before it is
 * waiting on that lock, then release it: Postgres lets the waiters through in the order they came.
 */
async function queuedOnInvoice(invoiceId: string, requests: (() => ReturnType<typeof as>)[]) {
  const sent: Promise<Awaited<ReturnType<typeof as>>>[] = [];
  await prisma.$transaction(
    async (tx) => {
      await tx.invoice.update({ where: { id: invoiceId }, data: { updatedAt: new Date() } });
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      for (const request of requests) {
        sent.push(Promise.resolve(request()));
        await expect
          .poll(() => queuedBehind(pid), { timeout: 4_000, interval: 25 })
          .toBe(sent.length);
      }
    },
    { timeout: 9_000 },
  );
  return Promise.all(sent);
}

async function stateOf(invoiceId: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { cancelledAt: true, paidTotal: true },
  });
  const payments = await prisma.payment.aggregate({
    where: { invoiceId },
    _sum: { amount: true },
    _count: true,
  });
  return {
    cancelled: invoice.cancelledAt !== null,
    paidTotal: invoice.paidTotal,
    paid: payments._sum.amount ?? 0,
    payments: payments._count,
  };
}

const forInvoices = () => ({ invoice: { clientId } });

beforeAll(async () => {
  app = await buildApp();
  await ensureBaseData();
  await removePeople(DOMAIN);
  [admin] = await createPeople(app, DOMAIN, ["Ada"], "admin");
  const client = await prisma.client.create({
    data: { firstName: `${TAG} Ivan`, lastName: "Locks" },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.paymentAuditLog.deleteMany({ where: forInvoices() });
  await prisma.payment.deleteMany({ where: forInvoices() });
  await prisma.invoiceLine.deleteMany({ where: forInvoices() });
  await prisma.invoice.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await removePeople(DOMAIN);
  await app.close();
});

describe("a payment and a cancel at the same moment", () => {
  it("a payment that lands first stops the cancel, so a cancelled invoice never holds money", async () => {
    const invoiceId = await makeInvoice(50_000);

    const [paid, cancel] = await queuedOnInvoice(invoiceId, [
      () =>
        as("POST", `/api/invoices/${invoiceId}/payments`, { amount: 10_000, paidAt: PAID_AT }),
      () => as("POST", `/api/invoices/${invoiceId}/cancel`),
    ]);

    expect(paid.statusCode).toBe(201);
    expect(cancel.statusCode).toBe(400);
    expect(cancel.json().error.message).toBe(
      "Delete the payments on this invoice before cancelling it",
    );
    expect(await stateOf(invoiceId)).toEqual({
      cancelled: false,
      paidTotal: 10_000,
      paid: 10_000,
      payments: 1,
    });
  });

  it("a cancel that lands first turns the payment away", async () => {
    const invoiceId = await makeInvoice(50_000);

    const [cancel, paid] = await queuedOnInvoice(invoiceId, [
      () => as("POST", `/api/invoices/${invoiceId}/cancel`),
      () =>
        as("POST", `/api/invoices/${invoiceId}/payments`, { amount: 10_000, paidAt: PAID_AT }),
    ]);

    expect(cancel.statusCode).toBe(200);
    expect(paid.statusCode).toBe(400);
    expect(paid.json().error.message).toBe("This invoice is cancelled");
    expect(await stateOf(invoiceId)).toEqual({
      cancelled: true,
      paidTotal: 0,
      paid: 0,
      payments: 0,
    });
  });
});

describe("two changes to one invoice's payments at the same moment", () => {
  /**
   * Whichever request goes second is the one that would write a stale total: it read the payments
   * before the first one committed. So each order checks a different one of the two writes.
   */
  it.each([
    { title: "an edit, then a delete", order: ["edit", "delete"] as const },
    { title: "a delete, then an edit", order: ["delete", "edit"] as const },
  ])("$title leave the invoice's paid total equal to its payments", async ({ order }) => {
    const invoiceId = await makeInvoice(90_000);
    const edited = await pay(invoiceId, 20_000);
    const deleted = await pay(invoiceId, 30_000);
    const send = {
      edit: () => as("PATCH", `/api/invoices/payments/${edited}`, { amount: 25_000 }),
      delete: () => as("DELETE", `/api/invoices/payments/${deleted}`),
    };

    const answers = await queuedOnInvoice(
      invoiceId,
      order.map((step) => send[step]),
    );

    expect(answers.map((a) => a.statusCode)).toEqual([200, 200]);
    expect(await stateOf(invoiceId)).toEqual({
      cancelled: false,
      paidTotal: 25_000,
      paid: 25_000,
      payments: 1,
    });
  });
});

describe("an edit that would take the payments past the invoice's total", () => {
  /**
   * Each request fits on its own; the two together do not. The edit goes second, so it is the one
   * that must see what the first one committed while it waited.
   */
  it.each([
    {
      title: "a new payment, then an edit",
      first: "add" as const,
      expected: { status: 201, paid: 90_000, payments: 3 },
    },
    {
      title: "two edits",
      first: "edit" as const,
      expected: { status: 200, paid: 75_000, payments: 2 },
    },
  ])("$title: the edit is refused", async ({ first, expected }) => {
    const invoiceId = await makeInvoice(90_000);
    const a = await pay(invoiceId, 20_000);
    const b = await pay(invoiceId, 30_000);
    const send = {
      add: () =>
        as("POST", `/api/invoices/${invoiceId}/payments`, { amount: 40_000, paidAt: PAID_AT }),
      edit: () => as("PATCH", `/api/invoices/payments/${b}`, { amount: 55_000 }),
    };

    const [firstAnswer, edit] = await queuedOnInvoice(invoiceId, [
      send[first],
      () => as("PATCH", `/api/invoices/payments/${a}`, { amount: 60_000 }),
    ]);

    expect(firstAnswer.statusCode).toBe(expected.status);
    expect(edit.statusCode).toBe(400);
    expect(edit.json().error.message).toBe("Payments would exceed the invoice total");
    expect(await stateOf(invoiceId)).toEqual({
      cancelled: false,
      paidTotal: expected.paid,
      paid: expected.paid,
      payments: expected.payments,
    });
  });
});
