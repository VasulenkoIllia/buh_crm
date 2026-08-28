import { z } from "zod";
import { isPastBusinessDate, localBusinessTodayMs } from "../dates.js";
import { money, paginated, uuid } from "./common.js";
import { invoiceDelivery, invoiceStatus } from "./enums.js";

// S7 Payments. Invoices originate from tasks (one-time jobs), from the per-period
// subscription sweep, or are issued manually. Money is USD minor units; paid/balance/
// status are DERIVED (never stored) — see `deriveStatus` below, the single source of
// that rule for both sides.

// ── DTOs ─────────────────────────────────────────────────────────────────────

export const paymentSchema = z.object({
  id: uuid,
  invoiceId: uuid,
  amount: money,
  paidAt: z.iso.datetime(),
  /** external reconcile number (bank statement / accounting system) */
  reference: z.string().nullable(),
  createdById: uuid,
  createdByName: z.string(),
  createdAt: z.iso.datetime(),
});
export type Payment = z.infer<typeof paymentSchema>;

/**
 * One position on an invoice.
 *
 * `quantity` is HUNDREDTHS OF AN HOUR — 2.50 h = 250 — so hours are integers for the same reason
 * money is: a float hour times a rate is where the last cent goes missing. Both it and `unitRate`
 * are optional, so one shape covers "Consultation — 500" and "3.50 × 200 = 700".
 */
export const invoiceLineSchema = z.object({
  id: uuid,
  order: z.number().int(),
  description: z.string(),
  quantity: z.number().int().nullable(),
  unitRate: money.nullable(),
  amount: money,
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

/** Hours × rate, in minor units — the ONE place the arithmetic lives, so both sides agree. */
export function lineAmount(quantity: number | null, unitRate: number | null): number | null {
  if (quantity == null || unitRate == null) return null;
  return Math.round((quantity * unitRate) / 100);
}

/** What an invoice's amount must be, given its lines. Empty list = the amount stands on its own. */
export const linesTotal = (lines: { amount: number }[]) =>
  lines.reduce((sum, l) => sum + l.amount, 0);

export const invoiceSchema = z.object({
  id: uuid,
  number: z.string().min(1),
  clientId: uuid,
  clientName: z.string(),
  companyId: uuid.nullable(),
  companyName: z.string().nullable(),
  serviceId: uuid.nullable(),
  serviceName: z.string().nullable(),
  subscriptionId: uuid.nullable(),
  /** set for per-period invoices (e.g. "2026-07", "2026-Q3") */
  periodKey: z.string().nullable(),
  description: z.string().nullable(),
  amount: money,
  /** derived: Σ payments */
  paid: money,
  /** derived: amount − paid (0 once cancelled) */
  balance: money,
  /** derived from paid/dueDate/cancelledAt */
  status: invoiceStatus,
  dueDate: z.iso.datetime().nullable(),
  issuedAt: z.iso.datetime(),
  cancelledAt: z.iso.datetime().nullable(),
  cancelledByName: z.string().nullable(),
  /** delivery state, orthogonal to payment: "created" until it goes out, then "sent" */
  delivery: invoiceDelivery,
  sentAt: z.iso.datetime().nullable(),
  sentByName: z.string().nullable(),
  /** settled business tidied out of the working lists (never deleted) */
  tidiedAt: z.iso.datetime().nullable(),
  tidiedByName: z.string().nullable(),
  /** the owner client is archived — the money is still owed, so the row stays visible + flagged */
  clientArchived: z.boolean(),
  /** the job this invoice was issued for (one-time task), if any */
  taskId: uuid.nullable(),
  taskTitle: z.string().nullable(),
  /** the breakdown; empty = a single amount, which is how every invoice looked before lines */
  lines: z.array(invoiceLineSchema),
  payments: z.array(paymentSchema),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const invoiceListSchema = paginated(invoiceSchema).extend({
  /** totals across the WHOLE filtered set (not just this page) */
  totals: z.object({ receivable: money, overdue: money }),
  /** how many invoices each filter chip would show, in the current client/search scope */
  counts: z.object({
    all: z.number().int(),
    unpaid: z.number().int(),
    overdue: z.number().int(),
    paid: z.number().int(),
    unsent: z.number().int(),
    cancelled: z.number().int(),
    settled: z.number().int(),
  }),
});
export type InvoiceList = z.infer<typeof invoiceListSchema>;

// ── derived status (shared rule) ─────────────────────────────────────────────

/**
 * cancelled > paid > overdue > partial > unpaid.
 *
 * Overdue starts once the whole due DAY has passed — due dates are business dates in the UI
 * ("due 08/08/2026"), and the stored value is a midnight date for period invoices but a real
 * timestamp for job invoices (issue + N days). Both are compared as calendar days by the shared
 * `isPastBusinessDate`, so an invoice due today is never already late. The SAME rule decides an
 * overdue TASK (`isTaskOverdue`) and the Billing overdue filter in SQL — one definition, one answer.
 *
 * `todayMs` is today as a business date (see shared/dates.ts) — injectable for tests, and passed
 * explicitly by the server so the firm timezone decides the day, not the process timezone.
 */
/**
 * Is this job billed by an invoice that still COUNTS?
 *
 * A cancelled invoice is void — no balance, out of the debt, out of the unpaid list — so a job
 * pointing at one is not billed. Reading `invoiceId` alone strands such a job: it cannot be
 * re-invoiced (the billing guard sees a link), its price cannot be corrected, and it cannot be
 * called off either, which is how a user found the last of those on 2026-08-28.
 *
 * Here rather than in either module because BOTH ask it — Tasks before locking a price or calling
 * a job off, Payments before issuing a second invoice for the same work. It was written out twice,
 * and the two copies agreeing was luck rather than design (audit, 2026-08-28).
 */
export function hasLiveInvoice(job: {
  invoiceId: string | null;
  invoice?: { cancelledAt: Date | null } | null;
}): boolean {
  return !!job.invoiceId && !job.invoice?.cancelledAt;
}

export function deriveStatus(
  invoice: { amount: number; paid: number; dueDate: Date | string | null; cancelledAt: Date | string | null },
  todayMs: number = localBusinessTodayMs(),
): z.infer<typeof invoiceStatus> {
  if (invoice.cancelledAt) return "cancelled";
  if (invoice.paid >= invoice.amount) return "paid";
  if (isPastBusinessDate(invoice.dueDate, todayMs)) return "overdue";
  return invoice.paid > 0 ? "partial" : "unpaid";
}

// ── inputs ───────────────────────────────────────────────────────────────────

export const invoiceListQuery = z.object({
  /** the Billing screen's filter chips; "all" hides nothing but cancelled invoices */
  filter: z
    .enum(["all", "unpaid", "overdue", "paid", "unsent", "cancelled", "settled"])
    .default("all"),
  clientId: uuid.optional(),
  /** which of the client's companies the invoice concerns; "root" = the client itself */
  companyId: z.union([uuid, z.literal("root")]).optional(),
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuery>;

/**
 * Manual invoice (design: "+ New invoice"). A subscription pins the service + company
 * target exactly like a task does; without one the invoice is a bare client charge.
 * `withTask` additionally opens a job for it, already linked to this invoice.
 */
/**
 * A position as the form sends it. `amount` is sent so the browser can show a live total, and is
 * RECOMPUTED on the server whenever hours and a rate are both present — the total a client types
 * is never the total that gets stored.
 */
export const invoiceLineInput = z.object({
  description: z.string().trim().min(1, "Name the position").max(200),
  /** hundredths of an hour; null = a flat position with no hours */
  quantity: z.number().int().min(1).max(1_000_00).nullable().optional(),
  unitRate: money.nullable().optional(),
  amount: money.min(0),
});
export type InvoiceLineInput = z.infer<typeof invoiceLineInput>;

export const createInvoiceInput = z
  .object({
    clientId: uuid,
    subscriptionId: uuid.nullable().optional(),
    description: z.string().trim().max(500).optional(),
    amount: money.min(1, "Amount is required"),
    /** a date sets it · `null` = explicitly no due date · omitted = inherit the service's dueDays */
    dueDate: z.iso.date().nullable().optional(),
    /** positions; when given, the invoice's amount is their sum and `amount` above is ignored */
    lines: z.array(invoiceLineInput).max(50).optional(),
    withTask: z.boolean().default(false),
    taskTitle: z.string().trim().max(200).optional(),
    assigneeIds: z.array(uuid).default([]),
  })
  .refine((v) => !v.withTask || !!(v.taskTitle || v.description), {
    path: ["taskTitle"],
    message: "Name the task (or fill the description)",
  });
export type CreateInvoiceInput = z.infer<typeof createInvoiceInput>;

/**
 * Correcting an issued invoice (admin). Amount may never drop below what's already been
 * paid, and a cancelled invoice is frozen. A linked job's price follows the invoice.
 */
export const updateInvoiceInput = z.object({
  amount: money.min(1).optional(),
  /**
   * Omitted = the positions are left alone (every caller before this one).
   * `[]` = cleared, and then `amount` decides the total again.
   * Non-empty = replaced wholesale, and the total is their sum.
   */
  lines: z.array(invoiceLineInput).max(50).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  /** a date sets it · `null` clears it · omitted keeps the current one */
  dueDate: z.iso.date().nullable().optional(),
});
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceInput>;

export const addPaymentInput = z.object({
  amount: money.min(1, "Amount is required"),
  paidAt: z.iso.date(),
  reference: z.string().trim().max(120).nullable().optional(),
});
export type AddPaymentInput = z.infer<typeof addPaymentInput>;

export const updatePaymentInput = z.object({
  amount: money.min(1).optional(),
  paidAt: z.iso.date().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
});
export type UpdatePaymentInput = z.infer<typeof updatePaymentInput>;

/**
 * Mark an invoice as handed to the client (or take the mark back). Manual today; when
 * invoice-by-email / PDF land (S10) the same field is stamped by the sender.
 */
export const setDeliveryInput = z.object({ sent: z.boolean() });
export type SetDeliveryInput = z.infer<typeof setDeliveryInput>;

/** Billing footer: settle several invoices at once (records the remaining balance on each). */
export const markPaidInput = z.object({
  invoiceIds: z.array(uuid).min(1).max(100),
  paidAt: z.iso.date().optional(),
});
export type MarkPaidInput = z.infer<typeof markPaidInput>;

/** Same footer, for the other two bulk marks — no money moves, so both are reversible. */
export const bulkDeliveryInput = z.object({
  invoiceIds: z.array(uuid).min(1).max(100),
  sent: z.boolean(),
});
export type BulkDeliveryInput = z.infer<typeof bulkDeliveryInput>;

export const bulkTidyInput = z.object({
  invoiceIds: z.array(uuid).min(1).max(100),
  tidied: z.boolean(),
});
export type BulkTidyInput = z.infer<typeof bulkTidyInput>;

/** What a bulk mark actually did — the UI reports skips instead of silently doing less. */
export const bulkResultSchema = z.object({
  changed: z.number().int(),
  skipped: z.number().int(),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;
