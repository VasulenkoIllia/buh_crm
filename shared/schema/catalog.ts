import { z } from "zod";
import { money, uuid } from "./common.js";
import { invoiceTrigger, periodicity, serviceType } from "./enums.js";

export const taskTemplateSchema = z.object({
  id: uuid,
  serviceId: uuid,
  name: z.string().min(1),
  periodicity,
  dayOfPeriod: z.number().int().nullable(),
  deadlineOffsetDays: z.number().int().positive().nullable(),
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
  active: z.boolean(),
});
export type Service = z.infer<typeof serviceSchema>;
