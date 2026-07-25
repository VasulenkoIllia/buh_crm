import { z } from "zod";
import { money, uuid } from "./common.js";
import { invoiceTrigger, periodicity, serviceType } from "./enums.js";

export const taskTemplateSchema = z.object({
  id: uuid,
  serviceId: uuid,
  name: z.string().min(1),
  periodicity,
  dayOfPeriod: z.number().int().nullable(),
  monthOfPeriod: z.number().int().nullable(),
  deadlineOffsetDays: z.number().int().nullable(),
  estimatedMinutes: z.number().int().nullable(),
  /** default checklist steps seeded onto tasks made from this template */
  defaultChecklist: z.array(z.string()).default([]),
  /** seeded into the generated task's description */
  description: z.string().nullable().default(null),
  /** default assignees seeded onto generated tasks (used mainly by internal templates) */
  defaultAssigneeIds: z.array(uuid).default([]),
  billable: z.boolean(),
});
export type TaskTemplate = z.infer<typeof taskTemplateSchema>;

export const serviceSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  color: z.string().min(1),
  type: serviceType,
  defaultAmount: money.nullable(),
  invoiceTrigger,
  invoiceDay: z.number().int().nullable(),
  dueDays: z.number().int().nullable(),
  active: z.boolean(),
  /** one-time only, ≤1 across the catalog — auto-added to every new client on create */
  autoAddToNewClients: z.boolean(),
  clientsCount: z.number().int(),
  taskTemplates: z.array(taskTemplateSchema),
});
export type Service = z.infer<typeof serviceSchema>;

/** Client-assignable (subscription / one-time). Internal services are firm-internal only, so they're
 *  excluded from every client/lead service picker. Keep this the single source of that rule. */
export const isClientFacing = (s: { type: z.infer<typeof serviceType> }) => s.type !== "internal";

// ── DTOs ─────────────────────────────────────────────────────────────────────

/**
 * Rhythm semantics (2026-07-20): weekly → dayOfPeriod 1–7 (Mon=1), no month;
 * monthly → day 1–31 or -1 (last day), no month; quarterly → monthOfPeriod 1–3 + day;
 * yearly → monthOfPeriod 1–12 + day; once → neither.
 */
const calendarDayOk = (d: number | null | undefined) =>
  d == null || d === -1 || (d >= 1 && d <= 31);

export function rhythmValid(v: {
  periodicity: z.infer<typeof periodicity>;
  dayOfPeriod?: number | null;
  monthOfPeriod?: number | null;
}) {
  const day = v.dayOfPeriod ?? null;
  const month = v.monthOfPeriod ?? null;
  switch (v.periodicity) {
    case "once":
      return day == null && month == null;
    case "weekly":
      return month == null && (day == null || (day >= 1 && day <= 7));
    case "monthly":
      return month == null && calendarDayOk(day);
    case "quarterly":
      return (month == null || (month >= 1 && month <= 3)) && calendarDayOk(day);
    case "yearly":
      return (month == null || (month >= 1 && month <= 12)) && calendarDayOk(day);
  }
}
const rhythmMsg = {
  path: ["dayOfPeriod"],
  message:
    "Rhythm day/month don't fit the frequency (weekly: Mon–Sun; monthly: day 1–31 or last; quarterly: month 1–3; yearly: month 1–12)",
};

/** A checklist = an ordered list of short step texts (empty steps trimmed out upstream). */
export const checklistSchema = z.array(z.string().trim().min(1).max(200)).max(50);

const taskTemplateFields = z.object({
  name: z.string().trim().min(1).max(80),
  periodicity,
  /** weekly: 1–7 (Mon=1); monthly+: 1–31, or -1 = last day of the period */
  dayOfPeriod: z.number().int().min(-1).max(31).nullable().optional(),
  /** quarterly: 1–3; yearly: 1–12 */
  monthOfPeriod: z.number().int().min(1).max(12).nullable().optional(),
  deadlineOffsetDays: z.number().int().min(0).max(90).nullable().optional(),
  /** planned labor (minutes); per-task override lands with Tasks (S6) */
  estimatedMinutes: z.number().int().min(1).max(60_000).nullable().optional(),
  /** default checklist steps seeded onto tasks made from this template */
  defaultChecklist: checklistSchema.optional(),
  /** seeded into the generated task's description */
  description: z.string().trim().max(2000).nullable().optional(),
  /** default assignees seeded onto generated tasks (internal templates); no duplicates */
  defaultAssigneeIds: z
    .array(uuid)
    .max(20)
    .refine((v) => new Set(v).size === v.length, "Duplicate assignee")
    .optional(),
  billable: z.boolean().default(true),
});

export const createTaskTemplateInput = taskTemplateFields.refine(rhythmValid, rhythmMsg);
export type CreateTaskTemplateInput = z.infer<typeof createTaskTemplateInput>;

export const updateTaskTemplateInput = taskTemplateFields
  .partial()
  .refine((v) => v.periodicity === undefined || rhythmValid(v as never), rhythmMsg);
export type UpdateTaskTemplateInput = z.infer<typeof updateTaskTemplateInput>;

/**
 * Per-client override of ONE service task template (keyed by templateId in
 * Subscription.rhythmOverrides). Absent key = use the service template as-is.
 * Only the fields the client actually changed are stored — everything absent keeps
 * following the template (so later catalog edits still propagate). `enabled:false` =
 * skip this task for this client. Rhythm (periodicity+day+month) travels as one group:
 * a day/month without its periodicity would be meaningless against a changed template.
 */
export const taskOverrideSchema = z
  .object({
    enabled: z.boolean().default(true),
    periodicity: periodicity.optional(),
    dayOfPeriod: z.number().int().min(-1).max(31).nullable().optional(),
    monthOfPeriod: z.number().int().min(1).max(12).nullable().optional(),
    deadlineOffsetDays: z.number().int().min(0).max(90).nullable().optional(),
    estimatedMinutes: z.number().int().min(1).max(60_000).nullable().optional(),
    /** per-client checklist: array = replace the template's, `null` = remove it, absent = inherit */
    checklist: checklistSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.periodicity !== undefined
        ? rhythmValid(v as { periodicity: z.infer<typeof periodicity> })
        : v.dayOfPeriod === undefined && v.monthOfPeriod === undefined,
    rhythmMsg,
  );
export type TaskOverride = z.infer<typeof taskOverrideSchema>;

export const rhythmOverridesSchema = z.record(uuid, taskOverrideSchema);
export type RhythmOverrides = z.infer<typeof rhythmOverridesSchema>;

const serviceFields = z.object({
  name: z.string().trim().min(1).max(60),
  /** omitted on create → the server auto-assigns from the category palette */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color").optional(),
  /** subscription/one-time = client-facing (billable); internal = firm-internal recurring tasks (no billing) */
  type: serviceType,
  defaultAmount: money.nullable().optional(),
  /** omitted → defaults by type: subscription = start of period, one-time = on create */
  invoiceTrigger: invoiceTrigger.optional(),
  invoiceDay: z.number().int().min(1).max(31).nullable().optional(),
  /** invoice counts as overdue N days after issue; null = never */
  dueDays: z.number().int().min(1).max(365).nullable().optional(),
  /** auto-add this service to every new client (one-time services only; ≤1 in the catalog) */
  autoAddToNewClients: z.boolean().optional(),
});

/** the default-for-new-clients flag is only valid on a one-time service */
const defaultServiceValid = (v: {
  type?: z.infer<typeof serviceType>;
  autoAddToNewClients?: boolean;
}) => v.autoAddToNewClients !== true || v.type === "one_time";
const defaultServiceMsg = {
  path: ["autoAddToNewClients"],
  message: "Only a one-time service can be the default for new clients",
};

export function defaultTriggerFor(type: z.infer<typeof serviceType>) {
  // internal never bills — a dummy trigger is stored and never used
  return type === "one_time" ? ("on_create" as const) : ("on_period_start" as const);
}

/** one-time bills on create/complete; subscriptions bill by period; internal never bills. */
export function billingRuleValid(v: {
  type: z.infer<typeof serviceType>;
  invoiceTrigger: z.infer<typeof invoiceTrigger>;
  invoiceDay?: number | null;
}) {
  if (v.type === "internal") return true; // no billing constraints
  if (v.type === "one_time") {
    return (
      (v.invoiceTrigger === "on_create" || v.invoiceTrigger === "on_complete") &&
      v.invoiceDay == null
    );
  }
  return (
    v.invoiceTrigger === "on_period_start" ||
    (v.invoiceTrigger === "on_period_end" && v.invoiceDay == null)
  );
}
const billingMsg = {
  path: ["invoiceTrigger"],
  message: "Invoice rule doesn't fit the service type",
};

export const createServiceInput = serviceFields
  .refine(
    (v) =>
      billingRuleValid({
        type: v.type,
        invoiceTrigger: v.invoiceTrigger ?? defaultTriggerFor(v.type),
        invoiceDay: v.invoiceDay,
      }),
    billingMsg,
  )
  .refine(defaultServiceValid, defaultServiceMsg);
export type CreateServiceInput = z.infer<typeof createServiceInput>;

/** Services are deactivated, never deleted — history references stay intact. */
export const updateServiceInput = serviceFields
  .partial()
  .extend({
    active: z.boolean().optional(),
  })
  // type may be absent on PATCH — the service layer re-checks against the merged row
  .refine((v) => v.type === undefined || defaultServiceValid(v), defaultServiceMsg);
export type UpdateServiceInput = z.infer<typeof updateServiceInput>;
