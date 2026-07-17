import { z } from "zod";
import { money, uuid } from "./common.js";
import { taskKind } from "./enums.js";

export const taskColumnSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  order: z.number().int(),
  isFixed: z.boolean(),
});
export type TaskColumn = z.infer<typeof taskColumnSchema>;

export const subtaskSchema = z.object({
  id: uuid,
  taskId: uuid,
  text: z.string().min(1),
  done: z.boolean(),
  order: z.number().int(),
});
export type Subtask = z.infer<typeof subtaskSchema>;

export const timeEntrySchema = z.object({
  id: uuid,
  taskId: uuid,
  userId: uuid,
  seconds: z.number().int().nonnegative(),
  runningSince: z.iso.datetime().nullable(),
});
export type TimeEntry = z.infer<typeof timeEntrySchema>;

export const taskSchema = z.object({
  id: uuid,
  title: z.string().min(1),
  clientId: uuid.nullable(),
  leadId: uuid.nullable(),
  serviceId: uuid.nullable(),
  kind: taskKind,
  priorityId: uuid,
  statusColumnId: uuid,
  /** independent completion flag — columns are pure workflow */
  done: z.boolean(),
  deadline: z.iso.datetime().nullable(),
  plannedMinutes: z.number().int().nonnegative().nullable(),
  amount: money.nullable(),
  invoiceId: uuid.nullable(),
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});
export type Task = z.infer<typeof taskSchema>;
