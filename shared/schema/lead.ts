import { z } from "zod";
import { uuid } from "./common.js";
import { leadOutcome, leadStage } from "./enums.js";

export const leadSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  phone: z.string().nullable(),
  email: z.email().nullable(),
  serviceId: uuid.nullable(),
  sourceId: uuid.nullable(),
  description: z.string().nullable(),
  stage: leadStage,
  outcome: leadOutcome,
  convertedClientId: uuid.nullable(),
  createdAt: z.iso.datetime(),
});
export type Lead = z.infer<typeof leadSchema>;

// ── DTOs ─────────────────────────────────────────────────────────────────────

const contactRule = { message: "At least one of phone or email is required" };

const leadFields = z.object({
  name: z.string().min(1),
  phone: z
    .string()
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
  email: z.email().nullable().optional(),
  sourceId: uuid.nullable().optional(),
  description: z
    .string()
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
});

export const createLeadInput = leadFields.refine((v) => v.phone || v.email, contactRule);
export type CreateLeadInput = z.infer<typeof createLeadInput>;

/** Partial edit; stage moves come through here too (kanban drag). */
export const updateLeadInput = leadFields.partial().extend({
  stage: leadStage.optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadInput>;

/** Convert dialog — reviewed by the user before the client is created. */
export const convertLeadInput = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z
    .string()
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
  email: z.email().nullable().optional(),
  address: z
    .string()
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
  sourceId: uuid.nullable().optional(),
  description: z
    .string()
    .transform((v) => v.trim() || null)
    .nullable()
    .optional(),
});
export type ConvertLeadInput = z.infer<typeof convertLeadInput>;
