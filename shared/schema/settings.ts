import { z } from "zod";
import { uuid } from "./common.js";

export const prioritySchema = z.object({
  id: uuid,
  name: z.string().min(1),
  color: z.string().min(1),
  order: z.number().int(),
  isDefault: z.boolean(),
});
export type Priority = z.infer<typeof prioritySchema>;

export const sourceOptionSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  order: z.number().int(),
  active: z.boolean(),
});
export type SourceOption = z.infer<typeof sourceOptionSchema>;

export const firmProfileSchema = z.object({
  name: z.string().min(1),
  logoFileId: uuid.nullable(),
  invoiceNumberFormat: z.string().min(1),
  currency: z.literal("USD"),
});
export type FirmProfile = z.infer<typeof firmProfileSchema>;
