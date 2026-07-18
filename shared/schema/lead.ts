import { z } from "zod";
import { uuid } from "./common.js";
import { clientType, leadOutcome, leadStage } from "./enums.js";

export const leadSchema = z.object({
  id: uuid,
  type: clientType,
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
const optionalTrimmed = z
  .string()
  .transform((v) => v.trim() || null)
  .nullable()
  .optional();

const leadFields = z.object({
  type: clientType.default("individual"),
  name: z.string().min(1),
  phone: optionalTrimmed,
  email: z.email().nullable().optional(),
  sourceId: uuid.nullable().optional(),
  description: optionalTrimmed,
});

export const createLeadInput = leadFields.refine((v) => v.phone || v.email, contactRule);
export type CreateLeadInput = z.infer<typeof createLeadInput>;

/** Partial edit; stage moves come through here too (kanban drag). */
export const updateLeadInput = leadFields.partial().extend({
  stage: leadStage.optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadInput>;

/**
 * Convert dialog — reviewed by the user before the client is created.
 * type-aware: individual → firstName+lastName; company → companyName + optional contact.
 */
export const convertLeadInput = z
  .object({
    type: clientType,
    firstName: optionalTrimmed,
    lastName: optionalTrimmed,
    companyName: optionalTrimmed,
    phone: optionalTrimmed,
    email: z.email().nullable().optional(),
    address: optionalTrimmed,
    sourceId: uuid.nullable().optional(),
    description: optionalTrimmed,
  })
  .refine(
    (v) => (v.type === "individual" ? !!v.firstName && !!v.lastName : !!v.companyName),
    { message: "Individual needs first and last name; company needs a company name" },
  );
export type ConvertLeadInput = z.infer<typeof convertLeadInput>;
