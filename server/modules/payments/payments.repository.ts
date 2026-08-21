import type { Prisma } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { inForceTodayWhere } from "../../core/coverage.js";
import { prisma } from "../../core/db.js";

const invoiceInclude = {
  client: {
    select: { firstName: true, lastName: true, archivedAt: true },
  },
  company: { select: { name: true } },
  service: { select: { name: true } },
  sentBy: { select: { firstName: true, lastName: true } },
  cancelledBy: { select: { firstName: true, lastName: true } },
  tidiedBy: { select: { firstName: true, lastName: true } },
  payments: {
    orderBy: { paidAt: "asc" },
    include: { createdBy: { select: { firstName: true, lastName: true } } },
  },
  tasks: { select: { id: true, title: true }, take: 1 },
  lines: { orderBy: { order: "asc" } },
} satisfies Prisma.InvoiceInclude;

export type InvoiceRecord = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

const LIST_ORDER = [{ issuedAt: "desc" as const }, { number: "desc" as const }];

/**
 * Settlement as SQL. `paidTotal` is stored, so "still owed" / "settled" are field-to-field
 * comparisons the database can index and count — the service composes these into its filter
 * chips instead of reading invoices to decide. (Field references are a Prisma construct, so
 * they live here rather than in the service.)
 */
export const OWED: Prisma.InvoiceWhereInput = { paidTotal: { lt: prisma.invoice.fields.amount } };
export const SETTLED: Prisma.InvoiceWhereInput = {
  paidTotal: { gte: prisma.invoice.fields.amount },
};

/**
 * One page of the list. Every filter — including settlement — is expressible in SQL now that
 * `paidTotal` is stored, so the database does the paging; nothing is scanned in memory.
 */
export function listInvoicePage(where: Prisma.InvoiceWhereInput, skip: number, take: number) {
  return prisma.invoice.findMany({ where, include: invoiceInclude, orderBy: LIST_ORDER, skip, take });
}

/** Receivable / overdue across the WHOLE filtered set (not just the page). */
export async function sumInvoices(where: Prisma.InvoiceWhereInput) {
  const agg = await prisma.invoice.aggregate({ where, _sum: { amount: true, paidTotal: true } });
  return (agg._sum.amount ?? 0) - (agg._sum.paidTotal ?? 0);
}

export function countInvoices(where: Prisma.InvoiceWhereInput) {
  return prisma.invoice.count({ where });
}

export function findInvoice(id: string) {
  return prisma.invoice.findUnique({ where: { id }, include: invoiceInclude });
}

export function findInvoices(ids: string[]) {
  return prisma.invoice.findMany({ where: { id: { in: ids } }, include: invoiceInclude });
}

/** Stamp (or clear) the "handed to the client" mark. */
export function setInvoiceDelivery(id: string, sent: boolean, userId: string) {
  return prisma.invoice.update({
    where: { id },
    data: sent ? { sentAt: new Date(), sentById: userId } : { sentAt: null, sentById: null },
    include: invoiceInclude,
  });
}

export function updateInvoice(id: string, data: Prisma.InvoiceUncheckedUpdateInput) {
  return prisma.invoice.update({ where: { id }, data, include: invoiceInclude });
}

/** Keep a linked job's price in step with its invoice (the task price is locked to it). */
export function syncTaskAmounts(invoiceId: string, amount: number) {
  return prisma.task.updateMany({ where: { invoiceId }, data: { amount } });
}

/** Archive / restore a set of invoices in one statement (callers pre-check the rules). */
export function setTidied(ids: string[], archived: boolean, userId: string) {
  return prisma.invoice.updateMany({
    where: { id: { in: ids } },
    data: archived
      ? { tidiedAt: new Date(), tidiedById: userId }
      : { tidiedAt: null, tidiedById: null },
  });
}

/** Restore without an actor — used when a correction puts money back on the invoice. */
export function clearArchived(ids: string[]) {
  return prisma.invoice.updateMany({
    where: { id: { in: ids } },
    data: { tidiedAt: null, tidiedById: null },
  });
}

export function setDeliveryMany(ids: string[], sent: boolean, userId: string) {
  return prisma.invoice.updateMany({
    where: { id: { in: ids } },
    data: sent ? { sentAt: new Date(), sentById: userId } : { sentAt: null, sentById: null },
  });
}

export function cancelInvoice(id: string, userId: string) {
  return prisma.invoice.update({
    where: { id },
    data: { cancelledAt: new Date(), cancelledById: userId },
    include: invoiceInclude,
  });
}

/** Per-period invoices already issued for these subscriptions (idempotency pre-check). */
export function listPeriodKeys(subscriptionIds: string[]) {
  return prisma.invoice.findMany({
    where: { subscriptionId: { in: subscriptionIds } },
    select: { subscriptionId: true, periodKey: true },
  });
}

// ── the per-period billing sweep (scheduler job #2) ──────────────────────────

/**
 * What the sweep bills: ACTIVE subscriptions of subscription-type services belonging to a live
 * client, with the fields the billing rule needs (per-client override + the service preset).
 */
// A FUNCTION, not a const: `inForceTodayWhere` resolves "today", and a module-level object would
// freeze it at import time — i.e. at server boot. The daily sweeps would then ask about the day the
// container started, forever (found in the 2026-07-29 audit).
const billableSubscription = () =>
  ({
  where: {
    ...inForceTodayWhere(config.TZ),
    service: { type: "subscription" as const },
    client: { archivedAt: null },
  },
  select: {
    id: true,
    clientId: true,
    companyId: true,
    serviceId: true,
    amount: true,
    period: true,
    invoiceTrigger: true,
    invoiceDay: true,
    dueDays: true,
    createdAt: true,
    // the served periods ARE the billing window now — a period is invoiced only when the
    // subscription was in force continuously from its first day through the trigger day
    periods: { select: { startsOn: true, endsBefore: true }, orderBy: { startsOn: "asc" } },
    service: { select: { invoiceTrigger: true, invoiceDay: true, dueDays: true } },
  },
  }) satisfies Prisma.SubscriptionFindManyArgs;

export type BillableSubscription = Prisma.SubscriptionGetPayload<
  ReturnType<typeof billableSubscription>
>;

export function listBillableSubscriptions(): Promise<BillableSubscription[]> {
  return prisma.subscription.findMany(billableSubscription());
}

/** The same row for one subscription — instant feedback when it's added or reactivated. */
export function findBillableSubscription(id: string): Promise<BillableSubscription | null> {
  return prisma.subscription.findFirst({
    ...billableSubscription(),
    where: { ...billableSubscription().where, id },
  });
}

// ── issuing (numbering + insert, in one transaction) ─────────────────────────

/**
 * Bump and read the firm's invoice counter. The `update` takes a row lock, so concurrent
 * issues serialize on it and a rolled-back transaction gives the number back.
 */
async function allocateNumber(tx: Prisma.TransactionClient, year: number): Promise<string> {
  // roll the year over first (no-op for everyone but the first caller of the new year)
  await tx.firmProfile.updateMany({
    where: { id: 1, OR: [{ invoiceCounterYear: null }, { invoiceCounterYear: { not: year } }] },
    data: { invoiceCounterYear: year, invoiceCounter: 0 },
  });
  const firm = await tx.firmProfile.update({
    where: { id: 1 },
    data: { invoiceCounter: { increment: 1 } },
  });
  return `${firm.invoicePrefix}-${year}-${String(firm.invoiceCounter).padStart(firm.invoiceCounterDigits, "0")}`;
}

/** Allocate a number and insert the invoice. Runs in `tx` so both succeed or neither does. */
export async function insertInvoice(
  tx: Prisma.TransactionClient,
  year: number,
  data: Omit<Prisma.InvoiceUncheckedCreateInput, "number">,
  taskId?: string | null,
) {
  const number = await allocateNumber(tx, year);
  return tx.invoice.create({
    data: { ...data, number, ...(taskId ? { tasks: { connect: { id: taskId } } } : {}) },
  });
}

/**
 * Update an invoice AND its positions in one transaction.
 *
 * One call because they are one fact: the amount is derived from the rows, so a reader must never
 * be able to catch the two disagreeing. `lines === null` leaves the existing rows alone.
 */
export function updateInvoiceWithLines(
  id: string,
  data: Prisma.InvoiceUpdateInput,
  lines: StoredLineRow[] | null,
) {
  return prisma.$transaction(async (tx) => {
    if (lines !== null) await replaceLines(tx, id, lines);
    return tx.invoice.update({ where: { id }, data, include: invoiceInclude });
  });
}

export interface StoredLineRow {
  order: number;
  description: string;
  quantity: number | null;
  unitRate: number | null;
  amount: number;
}

/**
 * Replace an invoice's positions wholesale.
 *
 * Delete-then-insert rather than a diff: a position has no identity worth preserving — nothing
 * points at one, and it carries no state of its own — so a diff would be more code for the same
 * result. Always called inside the caller's transaction, so the invoice's amount and the rows it
 * is derived from can never be seen apart.
 */
export async function replaceLines(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  lines: StoredLineRow[],
) {
  await tx.invoiceLine.deleteMany({ where: { invoiceId } });
  if (lines.length > 0) {
    await tx.invoiceLine.createMany({ data: lines.map((l) => ({ ...l, invoiceId })) });
  }
}

/** Run `fn` in a transaction — used by the issuer to wrap numbering + insert. */
export function inTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}

/**
 * Take the row lock on a task and hand back what billing needs to decide. Used so two
 * concurrent "mark done" requests on the same one-time job can't both pass the
 * "no invoice yet" check and bill the client twice.
 */
export async function lockTaskForInvoicing(tx: Prisma.TransactionClient, taskId: string) {
  return tx.task.update({
    where: { id: taskId },
    data: { updatedAt: new Date() }, // the write is what takes the lock
    select: { id: true, invoiceId: true, amount: true },
  });
}

// ── payments ─────────────────────────────────────────────────────────────────

export type PaymentRecord = Prisma.PaymentGetPayload<{
  include: { invoice: { select: { id: true; amount: true; cancelledAt: true } } };
}>;

export function findPayment(id: string): Promise<PaymentRecord | null> {
  return prisma.payment.findUnique({
    where: { id },
    include: { invoice: { select: { id: true, amount: true, cancelledAt: true } } },
  });
}

/** Σ of the OTHER payments on this invoice — the headroom an edit must respect. */
export async function sumOtherPayments(invoiceId: string, exceptPaymentId?: string) {
  const agg = await prisma.payment.aggregate({
    where: { invoiceId, ...(exceptPaymentId ? { id: { not: exceptPaymentId } } : {}) },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0;
}

/**
 * Register a payment with the balance re-checked under a row lock: the invoice row is
 * touched first, so two payments racing on the same invoice serialize instead of both
 * seeing the old balance and together overshooting the total.
 */
export async function createPaymentChecked(data: Prisma.PaymentUncheckedCreateInput) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.update({
      where: { id: data.invoiceId as string },
      data: { updatedAt: new Date() }, // takes the row lock for the rest of this transaction
      select: { amount: true, cancelledAt: true },
    });
    if (invoice.cancelledAt) return { payment: null, reason: "cancelled" as const };
    const paid = await tx.payment.aggregate({
      where: { invoiceId: data.invoiceId as string },
      _sum: { amount: true },
    });
    const balance = invoice.amount - (paid._sum.amount ?? 0);
    if (balance <= 0) return { payment: null, reason: "settled" as const };
    if ((data.amount as number) > balance) return { payment: null, reason: "over" as const, balance };
    const payment = await tx.payment.create({ data });
    await syncPaidTotal(tx, data.invoiceId as string);
    return { payment, reason: null };
  });
}

/**
 * Re-derive `Invoice.paidTotal` from the payments — always recompute rather than nudge a delta,
 * so the stored figure can never drift from the rows it summarises. Runs inside the caller's
 * transaction, which already holds the invoice row lock.
 */
async function syncPaidTotal(tx: Prisma.TransactionClient, invoiceId: string) {
  const agg = await tx.payment.aggregate({ where: { invoiceId }, _sum: { amount: true } });
  await tx.invoice.update({
    where: { id: invoiceId },
    data: { paidTotal: agg._sum.amount ?? 0 },
  });
}

export function updatePayment(id: string, invoiceId: string, data: Prisma.PaymentUncheckedUpdateInput) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.update({ where: { id }, data });
    await syncPaidTotal(tx, invoiceId);
    return payment;
  });
}

export function deletePayment(id: string, invoiceId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.payment.delete({ where: { id } });
    await syncPaidTotal(tx, invoiceId);
  });
}

// ── audit journal (who / when / before → after) ───────────────────────────────

export function writeAudit(entry: Prisma.PaymentAuditLogUncheckedCreateInput) {
  return prisma.paymentAuditLog.create({ data: entry });
}

export function listAudit(invoiceId: string) {
  return prisma.paymentAuditLog.findMany({
    where: { invoiceId },
    orderBy: { createdAt: "desc" },
    include: { byUser: { select: { firstName: true, lastName: true } } },
  });
}

// ── debt (Σ open balance per client) ──────────────────────────────────────────

/** Σ (amount − paidTotal) per client, computed by the database. */
export function groupOpenBalances(clientIds: string[]) {
  return prisma.invoice.groupBy({
    by: ["clientId"],
    where: { clientId: { in: clientIds }, cancelledAt: null },
    _sum: { amount: true, paidTotal: true },
  });
}

// ── manual invoice targets ───────────────────────────────────────────────────

export function findClient(id: string) {
  return prisma.client.findUnique({
    where: { id },
    select: { id: true, archivedAt: true },
  });
}

export function findSubscription(id: string) {
  return prisma.subscription.findUnique({
    where: { id },
    select: {
      id: true,
      clientId: true,
      companyId: true,
      serviceId: true,
      dueDays: true,
      service: { select: { name: true, dueDays: true, type: true } },
    },
  });
}

export function countActiveUsers(ids: string[]) {
  return prisma.user.count({ where: { id: { in: ids }, status: "active" } });
}

/**
 * The task an "invoice + task" manual issue opens. Written here rather than through the
 * Tasks module on purpose: Tasks depends on Payments (job billing), so the reverse import
 * would be a cycle. The billing fields are already resolved above, so no derivation is lost.
 */
export async function createInvoiceTask(data: {
  title: string;
  clientId: string;
  companyId: string | null;
  serviceId: string | null;
  subscriptionId: string | null;
  amount: number;
  invoiceId: string;
  description: string | null;
  createdById: string;
  assigneeIds: string[];
}) {
  const [priority, column] = await Promise.all([
    prisma.priority.findFirst({ where: { isDefault: true } }),
    prisma.taskColumn.findFirst({ where: { isFixed: true } }),
  ]);
  if (!priority || !column) return null; // bootstrap hasn't run — the invoice still stands
  const { assigneeIds, ...task } = data;
  return prisma.task.create({
    data: {
      ...task,
      kind: "once",
      priorityId: priority.id,
      statusColumnId: column.id,
      assignees: assigneeIds.length
        ? { create: [...new Set(assigneeIds)].map((userId) => ({ userId })) }
        : undefined,
    },
  });
}
