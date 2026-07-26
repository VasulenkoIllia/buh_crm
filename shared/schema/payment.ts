import { z } from "zod";
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
  archivedAt: z.iso.datetime().nullable(),
  archivedByName: z.string().nullable(),
  /** the owner client is archived — the money is still owed, so the row stays visible + flagged */
  clientArchived: z.boolean(),
  /** the job this invoice was issued for (one-time task), if any */
  taskId: uuid.nullable(),
  taskTitle: z.string().nullable(),
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
    archived: z.number().int(),
  }),
});
export type InvoiceList = z.infer<typeof invoiceListSchema>;

// ── derived status (shared rule) ─────────────────────────────────────────────

/**
 * cancelled > paid > overdue > partial > unpaid. `now` is injectable for tests.
 *
 * Overdue starts once the whole due DAY has passed — due dates are business dates in the UI
 * ("due 08/08/2026"), and the stored value is a midnight date for period invoices but a real
 * timestamp for job invoices (issue + N days). Comparing against the end of the due day keeps
 * both kinds honest: an invoice due today is never already late.
 */
export function deriveStatus(
  invoice: { amount: number; paid: number; dueDate: Date | string | null; cancelledAt: Date | string | null },
  now: Date = new Date(),
): z.infer<typeof invoiceStatus> {
  if (invoice.cancelledAt) return "cancelled";
  if (invoice.paid >= invoice.amount) return "paid";
  const due = invoice.dueDate == null ? null : new Date(invoice.dueDate);
  if (due) {
    const endOfDueDay =
      Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()) + 86_400_000;
    if (now.getTime() >= endOfDueDay) return "overdue";
  }
  return invoice.paid > 0 ? "partial" : "unpaid";
}

// ── inputs ───────────────────────────────────────────────────────────────────

export const invoiceListQuery = z.object({
  /** the Billing screen's filter chips; "all" hides nothing but cancelled invoices */
  filter: z
    .enum(["all", "unpaid", "overdue", "paid", "unsent", "cancelled", "archived"])
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
export const createInvoiceInput = z
  .object({
    clientId: uuid,
    subscriptionId: uuid.nullable().optional(),
    description: z.string().trim().max(500).optional(),
    amount: money.min(1, "Amount is required"),
    /** a date sets it · `null` = explicitly no due date · omitted = inherit the service's dueDays */
    dueDate: z.iso.date().nullable().optional(),
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

export const bulkArchiveInput = z.object({
  invoiceIds: z.array(uuid).min(1).max(100),
  archived: z.boolean(),
});
export type BulkArchiveInput = z.infer<typeof bulkArchiveInput>;

/** What a bulk mark actually did — the UI reports skips instead of silently doing less. */
export const bulkResultSchema = z.object({
  changed: z.number().int(),
  skipped: z.number().int(),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;
