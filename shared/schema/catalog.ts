import { z } from "zod";
import { money, uuid } from "./common.js";
import { invoiceTrigger, periodicity, serviceType } from "./enums.js";

export const taskTemplateSchema = z.object({
  id: uuid,
  serviceId: uuid,
  name: z.string().min(1),
  periodicity,
  dayOfPeriod: z.number().int().nullable(),
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
  active: z.boolean(),
  clientsCount: z.number().int(),
  taskTemplates: z.array(taskTemplateSchema),
});
export type Service = z.infer<typeof serviceSchema>;

// ── DTOs ─────────────────────────────────────────────────────────────────────

/** day-of-period must fit the rhythm: weekly 1–7, monthly 1–31, quarterly 1–92, yearly 1–366; none for `once`. */
const DAY_MAX: Partial<Record<z.infer<typeof periodicity>, number>> = {
  weekly: 7,
  monthly: 31,
  quarterly: 92,
  yearly: 366,
};
function rhythmValid(v: {
  periodicity: z.infer<typeof periodicity>;
  dayOfPeriod?: number | null;
}) {
  if (v.dayOfPeriod == null) return true;
  const max = DAY_MAX[v.periodicity];
  return max !== undefined && v.dayOfPeriod >= 1 && v.dayOfPeriod <= max;
}
const rhythmMsg = {
  path: ["dayOfPeriod"],
  message:
    "Day of period must fit the rhythm (weekly 1–7, monthly 1–31, quarterly 1–92, yearly 1–366; none for once)",
};

const taskTemplateFields = z.object({
  name: z.string().trim().min(1).max(80),
  periodicity,
  dayOfPeriod: z.number().int().nullable().optional(),
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

const serviceFields = z.object({
  name: z.string().trim().min(1).max(60),
  /** omitted on create → the server auto-assigns from the category palette */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color").optional(),
  type: serviceType.refine((t) => t !== "internal", "Internal services arrive later"),
  defaultAmount: money.nullable().optional(),
  invoiceTrigger: invoiceTrigger.default("on_create"),
  invoiceDay: z.number().int().min(1).max(31).nullable().optional(),
});

export const createServiceInput = serviceFields;
export type CreateServiceInput = z.infer<typeof createServiceInput>;

/** Services are deactivated, never deleted — history references stay intact. */
export const updateServiceInput = serviceFields.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateServiceInput = z.infer<typeof updateServiceInput>;
