import { z } from "zod";

// Mirror of prisma enums — the single source for the client side.

export const userRole = z.enum(["admin", "user"]);
export type UserRole = z.infer<typeof userRole>;

// (2026-07-26: `clientType` is gone — a client is just a client, and the companies it holds are
// real rows. See modules/decisions-log.md.)

export const userStatus = z.enum(["invited", "pending", "active", "blocked"]);
export type UserStatus = z.infer<typeof userStatus>;

export const serviceType = z.enum(["subscription", "one_time", "internal"]);
export type ServiceType = z.infer<typeof serviceType>;

export const invoiceTrigger = z.enum(["on_create", "on_complete", "on_period_start", "on_period_end"]);
export type InvoiceTrigger = z.infer<typeof invoiceTrigger>;

export const billingPeriod = z.enum(["month", "quarter", "year"]);
export type BillingPeriod = z.infer<typeof billingPeriod>;

export const periodicity = z.enum(["weekly", "monthly", "quarterly", "yearly", "once"]);
export type Periodicity = z.infer<typeof periodicity>;

export const taskKind = z.enum(["once", "sub", "free"]);
export type TaskKind = z.infer<typeof taskKind>;

export const timeEntrySource = z.enum(["timer", "manual"]);
export type TimeEntrySource = z.infer<typeof timeEntrySource>;

export const leadStage = z.enum([
  "first_contact",
  "no_answer",
  "set_up_meeting",
  "thinking",
  "on_hold",
  "next_time",
]);
export type LeadStage = z.infer<typeof leadStage>;

export const leadOutcome = z.enum(["in_process", "won", "lost"]);
export type LeadOutcome = z.infer<typeof leadOutcome>;

/** derived, never stored: cancelled > paid > overdue > partial > unpaid */
export const invoiceStatus = z.enum(["unpaid", "partial", "paid", "overdue", "cancelled"]);
export type InvoiceStatus = z.infer<typeof invoiceStatus>;

/** Where the invoice is in getting to the client — independent of whether it's been paid.
 *  Derived from `Invoice.sentAt`; email/PDF delivery (S10) will extend this, not replace it. */
export const invoiceDelivery = z.enum(["created", "sent"]);
export type InvoiceDelivery = z.infer<typeof invoiceDelivery>;

export const notificationKind = z.enum(["task", "meeting", "invoice", "system"]);
export type NotificationKind = z.infer<typeof notificationKind>;

/**
 * The CAN-SPAM line (S10). `commercial` mail honours unsubscribe and must carry the firm's postal
 * address; `transactional` mail — an invoice, a document request — does neither, because a client
 * who unsubscribed from news still has to receive their bill.
 */
export const mailoutKind = z.enum(["commercial", "transactional"]);
export type MailoutKind = z.infer<typeof mailoutKind>;

/** What became of one recipient of one send. `skipped` is recorded, never a silent drop. */
export const mailoutStatus = z.enum(["queued", "sent", "failed", "skipped"]);
export type MailoutStatus = z.infer<typeof mailoutStatus>;
