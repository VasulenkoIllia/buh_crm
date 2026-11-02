import type { InvoiceLineUnit, Prisma } from "../../generated/prisma/client.js";
import { config } from "../../core/config.js";
import { inForceTodayWhere } from "../../core/coverage.js";
import { prisma } from "../../core/db.js";

const invoiceInclude = {
  client: {
    select: { firstName: true, lastName: true, archivedAt: true, email: true },
  },
  company: { select: { name: true, email: true } },
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
  // the name only: the text the invoice keeps is its own `paymentInfo`
  paymentDetails: { select: { name: true } },
} satisfies Prisma.InvoiceInclude;

export type InvoiceRecord = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

const LIST_ORDER = [{ issuedAt: "desc" as const }, { number: "desc" as const }];

/**
 * Settlement as SQL. `paidTotal` is stored, so "still owed" / "settled" are field-to-field
 * comparisons the database can index and count — the service composes these into its filter
 * chips instead of reading invoices to decide. (Field references are a Prisma construct, so
 * they live here rather than in the service.)
 */
export const OWED: Prisma.InvoiceWhereInput = {
  paidTotal: { lt: prisma.invoice.fields.amount },
};
export const SETTLED: Prisma.InvoiceWhereInput = {
  paidTotal: { gte: prisma.invoice.fields.amount },
};

/**
 * One page of the list. Every filter — including settlement — is expressible in SQL now that
 * `paidTotal` is stored, so the database does the paging; nothing is scanned in memory.
 */
export function listInvoicePage(where: Prisma.InvoiceWhereInput, skip: number, take: number) {
  return prisma.invoice.findMany({
    where,
    include: invoiceInclude,
    orderBy: LIST_ORDER,
    skip,
    take,
  });
}

/** Receivable / overdue across the WHOLE filtered set (not just the page). */
export async function sumInvoices(where: Prisma.InvoiceWhereInput) {
  const agg = await prisma.invoice.aggregate({
    where,
    _sum: { amount: true, paidTotal: true },
  });
  return (agg._sum.amount ?? 0) - (agg._sum.paidTotal ?? 0);
}

export function countInvoices(where: Prisma.InvoiceWhereInput) {
  return prisma.invoice.count({ where });
}

/**
 * Unsettled invoices on one client — the number on the card's Invoices tab.
 *
 * `OWED` is the same predicate Billing's chips and the debt rollup use, so the badge cannot
 * disagree with the money shown elsewhere. Voided and tidied invoices are out: neither is
 * something anyone still has to chase.
 */
export function countOwedInvoicesForClient(clientId: string) {
  return prisma.invoice.count({
    where: { clientId, cancelledAt: null, tidiedAt: null, ...OWED },
  });
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
/**
 * Carry the invoice's total onto the job it bills, so the client is never shown two numbers.
 *
 * Only when there is exactly ONE job on it. Writing the invoice total onto several would give each
 * of them the whole amount — three jobs on a 1 320 invoice would report 3 960 of work — and it
 * would do it silently, in money. That situation cannot arise today (an invoice carries one task,
 * the one `withTask` creates), and this is what keeps it from becoming a quiet corruption on the
 * day it can: nothing is written, and the log says so.
 */
export async function syncTaskAmounts(invoiceId: string, amount: number) {
  // the title and the previous price come back with the id: a job's price moving without anybody
  // touching the job is exactly the kind of thing that looks like a bug six months later, and the
  // activity log is where it stops looking like one
  const tasks = await prisma.task.findMany({
    where: { invoiceId },
    select: { id: true, title: true, amount: true, clientId: true },
  });
  if (tasks.length === 0) return { updated: 0, task: null };
  if (tasks.length > 1) {
    console.warn(
      `[payments] invoice=${invoiceId} bills ${tasks.length} jobs — their prices were left alone. ` +
        `A per-job amount needs a line per job (see the hourly-billing backlog).`,
    );
    return { updated: 0, task: null };
  }
  await prisma.task.update({ where: { id: tasks[0].id }, data: { amount } });
  return { updated: 1, task: tasks[0] };
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
    select: { subscriptionId: true, periodKey: true, cancelledAt: true },
  });
}

/** Whether this subscription's period already holds an invoice, cancelled or not. */
export async function hasPeriodInvoice(subscriptionId: string, periodKey: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { subscriptionId_periodKey: { subscriptionId, periodKey } },
    select: { id: true },
  });
  return invoice !== null;
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
      // the day the current rhythm took over: earlier periods are a person's call (dueInvoices)
      periodSince: true,
      // the served periods ARE the billing window now — a period is invoiced only when the
      // subscription was in force continuously from its first day through the trigger day
      periods: { select: { startsOn: true, endsBefore: true }, orderBy: { startsOn: "asc" } },
      // `name` rides along for the activity log: a sweep that fails on one subscription records
      // WHICH one, and "8f3a… could not be billed" is not a sentence anybody can act on
      service: {
        select: { name: true, invoiceTrigger: true, invoiceDay: true, dueDays: true },
      },
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

/** How many taken numbers in a row are stepped over one by one before the series itself is read. */
export const MAX_TAKEN_NUMBERS = 50;

/**
 * The firm's next free number for an invoice dated in `year`. The counter's row lock serializes
 * concurrent issues, and a rolled-back transaction gives the number back.
 *
 * A number that already has an invoice is stepped over here, under that lock, rather than left for
 * the insert to refuse: a failed insert rolls the transaction back, the counter with it, and every
 * retry would then meet the same number (owner, 2026-11-01). The counter stays past what it skipped.
 *
 * A counter further behind its rows than `MAX_TAKEN_NUMBERS` goes past the highest of them. Refusing
 * instead would stop every invoice the firm issues, and no screen moves the counter.
 */
async function allocateNumber(tx: Prisma.TransactionClient, year: number): Promise<string> {
  // roll the year over first (no-op for everyone but the first caller of the new year). Forward
  // only: going back for a late invoice would restart the series at a number already issued
  await tx.firmProfile.updateMany({
    where: { id: 1, OR: [{ invoiceCounterYear: null }, { invoiceCounterYear: { lt: year } }] },
    data: { invoiceCounterYear: year, invoiceCounter: 0 },
  });
  // the write is what takes the lock: nobody else can hand out a number until this one commits
  const firm = await tx.firmProfile.update({
    where: { id: 1 },
    data: { invoiceCounter: { increment: 0 } },
  });
  const series = `${firm.invoicePrefix}-${year}-`;
  const numbered = (n: number) => series + String(n).padStart(firm.invoiceCounterDigits, "0");

  // dated before the counter's year (the sweep catching up over New Year): the counter holds one
  // year, so the late invoice continues its own year's series from the rows and leaves it alone
  if (firm.invoiceCounterYear !== year)
    return numbered((await highestInSeries(tx, series)) + 1);

  let next = firm.invoiceCounter + 1;
  const lastTried = firm.invoiceCounter + MAX_TAKEN_NUMBERS;
  while (next <= lastTried && (await isNumberTaken(tx, numbered(next)))) next++;
  if (next > lastTried) next = (await highestInSeries(tx, series)) + 1;
  await tx.firmProfile.update({ where: { id: 1 }, data: { invoiceCounter: next } });
  return numbered(next);
}

async function isNumberTaken(tx: Prisma.TransactionClient, number: string) {
  const invoice = await tx.invoice.findUnique({ where: { number }, select: { id: true } });
  return invoice !== null;
}

/**
 * The highest number a series has reached, read as a number: the digits setting can change, so
 * `0099` and `00100` sit in one series and sort the wrong way round as strings.
 */
async function highestInSeries(tx: Prisma.TransactionClient, series: string) {
  const [row] = await tx.$queryRaw<{ highest: number | null }[]>`
    SELECT max(substring("number" FROM char_length(${series}::text) + 1)::int) AS highest
    FROM "Invoice"
    WHERE starts_with("number", ${series}::text)
      AND substring("number" FROM char_length(${series}::text) + 1) ~ '^[0-9]{1,9}$'`;
  return row.highest ?? 0;
}

/**
 * The payment details a client's invoices carry (payments.md §10): the client's own set while it
 * is live, else the firm's default. Null when the firm has no set at all. A live client is never
 * on an archived set (`setClientPaymentDetails`), but an archived one may be, and restored, the
 * account they would print is the one the firm stopped using.
 */
export async function findPaymentDetailsFor(
  clientId: string,
  db: Prisma.TransactionClient = prisma,
) {
  const select = { id: true, name: true, details: true } as const;
  const client = await db.client.findUnique({
    where: { id: clientId },
    select: { paymentDetails: { select: { ...select, archivedAt: true } } },
  });
  const own = client?.paymentDetails;
  if (own && !own.archivedAt) return own;
  return db.paymentDetails.findFirst({ where: { isDefault: true, archivedAt: null }, select });
}

/**
 * Allocate a number and insert the invoice. Runs in `tx` so both succeed or neither does.
 *
 * **The one place every issue path reaches** (by hand, a job's, the 03:20 sweep), so the copy of
 * the payment details is taken here and nowhere else: the set and its text as they are now. The
 * paper prints that text from then on, whatever happens to the set (owner, 2026-11-02).
 */
export async function insertInvoice(
  tx: Prisma.TransactionClient,
  year: number,
  data: Omit<Prisma.InvoiceUncheckedCreateInput, "number">,
  taskId?: string | null,
) {
  const paymentDetails = await findPaymentDetailsFor(data.clientId, tx);
  const number = await allocateNumber(tx, year);
  return tx.invoice.create({
    data: {
      ...data,
      number,
      paymentDetailsId: paymentDetails?.id ?? null,
      paymentInfo: paymentDetails?.details ?? null,
      ...(taskId ? { tasks: { connect: { id: taskId } } } : {}),
    },
    // the company's and the set's names, for the log's line about the invoice
    include: {
      company: { select: { name: true } },
      paymentDetails: { select: { name: true } },
    },
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

/**
 * The rate of the first hourly position on this client's newest live invoice that has one. An
 * item's price is no hourly rate, so item lines are skipped; a line from before units counted hours.
 */
export async function findLastRate(clientId: string) {
  const line = await prisma.invoiceLine.findFirst({
    where: {
      quantity: { not: null },
      unitRate: { not: null },
      OR: [{ unit: null }, { unit: "hour" }],
      invoice: { clientId, cancelledAt: null },
    },
    orderBy: [
      { invoice: { issuedAt: "desc" } },
      { invoice: { number: "desc" } },
      { order: "asc" },
    ],
    select: { unitRate: true },
  });
  return line?.unitRate ?? null;
}

export interface StoredLineRow {
  order: number;
  description: string;
  quantity: number | null;
  unitRate: number | null;
  amount: number;
  unit: InvoiceLineUnit | null;
  itemId: string | null;
}

/** How many of these invoice items exist, active or not. */
export function countInvoiceItems(ids: string[]) {
  return prisma.invoiceItem.count({ where: { id: { in: ids } } });
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

const jobForBillingSelect = {
  id: true,
  title: true,
  kind: true,
  clientId: true,
  companyId: true,
  serviceId: true,
  subscriptionId: true,
  amount: true,
  archivedAt: true,
  cancelledAt: true,
  invoiceId: true,
  client: { select: { archivedAt: true } },
  // `cancelledAt` rides along because "already billed" has to mean billed by an invoice that
  // still counts — a voided one must not keep the job hostage forever
  invoice: { select: { number: true, cancelledAt: true } },
} satisfies Prisma.TaskSelect;

export type JobForBilling = Prisma.TaskGetPayload<{ select: typeof jobForBillingSelect }>;

export function findJobForBilling(taskId: string) {
  return prisma.task.findUnique({ where: { id: taskId }, select: jobForBillingSelect });
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
    select: jobForBillingSelect,
  });
}

/**
 * The invoice's row lock, for the same reason: two people attaching one invoice to two jobs would
 * each see it free, and an invoice stays on one job (payments.md, "One job per invoice").
 */
export function lockInvoiceForAttaching(tx: Prisma.TransactionClient, invoiceId: string) {
  return tx.invoice.update({
    where: { id: invoiceId },
    data: { updatedAt: new Date() }, // the write is what takes the lock
    select: {
      id: true,
      number: true,
      amount: true,
      clientId: true,
      periodKey: true,
      cancelledAt: true,
      tasks: { select: { title: true }, take: 1 },
    },
  });
}

/** Point a job at its invoice. The invoice owns the number, so the job's price becomes its total. */
export function linkJobToInvoice(
  tx: Prisma.TransactionClient,
  taskId: string,
  invoiceId: string,
  amount: number,
) {
  return tx.task.update({ where: { id: taskId }, data: { invoiceId, amount } });
}

/** A form's list, so a client's whole history of jobs is never read for it. */
const UNBILLED_JOBS_LIMIT = 100;

export function listUnbilledJobs(clientId: string) {
  return prisma.task.findMany({
    where: {
      clientId,
      kind: "once",
      archivedAt: null,
      cancelledAt: null,
      client: { archivedAt: null },
      OR: [{ invoiceId: null }, { invoice: { cancelledAt: { not: null } } }],
    },
    orderBy: { createdAt: "desc" },
    take: UNBILLED_JOBS_LIMIT,
    select: {
      id: true,
      title: true,
      amount: true,
      done: true,
      subscriptionId: true,
      companyId: true,
      service: { select: { name: true } },
      company: { select: { name: true } },
    },
  });
}

// ── payments ─────────────────────────────────────────────────────────────────

export type PaymentRecord = Prisma.PaymentGetPayload<{
  include: {
    invoice: {
      select: { id: true; amount: true; cancelledAt: true; number: true; clientId: true };
    };
  };
}>;

export function findPayment(id: string): Promise<PaymentRecord | null> {
  return prisma.payment.findUnique({
    where: { id },
    // `number` and `clientId` ride along for the activity log: a deleted payment is recorded
    // against its invoice and its client, and neither is worth a second query here
    include: {
      invoice: {
        select: { id: true, amount: true, cancelledAt: true, number: true, clientId: true },
      },
    },
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
    if ((data.amount as number) > balance)
      return { payment: null, reason: "over" as const, balance };
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

export function updatePayment(
  id: string,
  invoiceId: string,
  data: Prisma.PaymentUncheckedUpdateInput,
) {
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

/** One of this client's companies, or null when the id names another client's or none. */
export function findClientCompany(clientId: string, companyId: string) {
  return prisma.company.findFirst({
    where: { id: companyId, clientId },
    select: { id: true },
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
