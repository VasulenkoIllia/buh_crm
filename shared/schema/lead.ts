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

/**
 * The two lists the Leads screen shows. The board only ever wants live leads and the archive
 * only closed ones, so each asks the database for its own side instead of pulling the whole
 * table and filtering it in the browser. Both are capped — see `LEAD_LIST_LIMIT`.
 */
export const leadListQuery = z.object({
  /** `in_process` = the pipeline board · `closed` = won + lost (the archive view) */
  scope: z.enum(["in_process", "closed", "all"]).default("all"),
});
export type LeadListQuery = z.infer<typeof leadListQuery>;

/** A sales pipeline this long is a data problem, not a screen — the list says when it's capped. */
export const LEAD_LIST_LIMIT = 500;

export const leadListSchema = z.object({
  items: z.array(leadSchema),
  total: z.number().int(),
  /** more leads match than were returned — narrow the view (mirrors the tasks board) */
  truncated: z.boolean(),
});
export type LeadList = z.infer<typeof leadListSchema>;

// ── DTOs ─────────────────────────────────────────────────────────────────────

const contactRule = { message: "At least one of phone or email is required" };
const optionalTrimmed = z
  .string()
  .transform((v) => v.trim() || null)
  .nullable()
  .optional();

const leadFields = z.object({
  type: clientType.default("individual"),
  name: z.string().trim().min(1, "Required"),
  phone: optionalTrimmed,
  email: z.email().nullable().optional(),
  /** the catalog service the lead came for (S3) */
  serviceId: uuid.nullable().optional(),
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
