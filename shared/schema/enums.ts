import { z } from "zod";

// Mirror of prisma enums — the single source for the client side.

export const userRole = z.enum(["admin", "user"]);
export type UserRole = z.infer<typeof userRole>;

export const clientType = z.enum(["individual", "company"]);
export type ClientType = z.infer<typeof clientType>;

export const userStatus = z.enum(["invited", "pending", "active", "blocked"]);
export type UserStatus = z.infer<typeof userStatus>;

export const serviceType = z.enum(["subscription", "one_time", "internal"]);
export type ServiceType = z.infer<typeof serviceType>;

export const invoiceTrigger = z.enum(["on_create", "on_complete", "on_period_start"]);
export type InvoiceTrigger = z.infer<typeof invoiceTrigger>;

export const billingPeriod = z.enum(["month", "quarter", "year"]);
export type BillingPeriod = z.infer<typeof billingPeriod>;

export const periodicity = z.enum(["weekly", "monthly", "quarterly", "yearly", "once"]);
export type Periodicity = z.infer<typeof periodicity>;

export const taskKind = z.enum(["once", "sub", "free"]);
export type TaskKind = z.infer<typeof taskKind>;

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

/** Derived, never stored. */
export const invoiceStatus = z.enum(["unpaid", "partial", "paid", "overdue"]);
export type InvoiceStatus = z.infer<typeof invoiceStatus>;

export const notificationKind = z.enum(["task", "meeting", "invoice", "system"]);
export type NotificationKind = z.infer<typeof notificationKind>;

export const campaignAudience = z.enum(["all", "by_service", "by_debt", "manual"]);
export type CampaignAudience = z.infer<typeof campaignAudience>;

export const campaignSchedule = z.enum(["one_off", "recurring"]);
export type CampaignSchedule = z.infer<typeof campaignSchedule>;
