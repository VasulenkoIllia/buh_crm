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
  defaultAssigneeId: uuid.nullable(),
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
  clientsCount: z.number().int(),
  taskTemplates: z.array(taskTemplateSchema),
});
export type Service = z.infer<typeof serviceSchema>;

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
  type: serviceType.refine((t) => t !== "internal", "Internal services arrive later"),
  defaultAmount: money.nullable().optional(),
  /** omitted → defaults by type: subscription = start of period, one-time = on create */
  invoiceTrigger: invoiceTrigger.optional(),
  invoiceDay: z.number().int().min(1).max(31).nullable().optional(),
  /** invoice counts as overdue N days after issue; null = never */
  dueDays: z.number().int().min(1).max(365).nullable().optional(),
});

export function defaultTriggerFor(type: z.infer<typeof serviceType>) {
  return type === "one_time" ? ("on_create" as const) : ("on_period_start" as const);
}

/** one-time bills on create/complete; subscriptions bill by period (start/end/custom day). */
export function billingRuleValid(v: {
  type: z.infer<typeof serviceType>;
  invoiceTrigger: z.infer<typeof invoiceTrigger>;
  invoiceDay?: number | null;
}) {
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

export const createServiceInput = serviceFields.refine(
  (v) =>
    billingRuleValid({
      type: v.type,
      invoiceTrigger: v.invoiceTrigger ?? defaultTriggerFor(v.type),
      invoiceDay: v.invoiceDay,
    }),
  billingMsg,
);
export type CreateServiceInput = z.infer<typeof createServiceInput>;

/** Services are deactivated, never deleted — history references stay intact. */
export const updateServiceInput = serviceFields.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateServiceInput = z.infer<typeof updateServiceInput>;
