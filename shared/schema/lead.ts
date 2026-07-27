import { z } from "zod";
import { uuid } from "./common.js";
import { leadOutcome, leadStage } from "./enums.js";

export const leadSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  /** informational, mirrors Client.companyName — carried straight over on convert */
  companyName: z.string().nullable(),
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

const optionalTrimmed = z
  .string()
  .transform((v) => v.trim() || null)
  .nullable()
  .optional();

const leadFields = z.object({
  name: z.string().trim().min(1, "Required"),
  companyName: optionalTrimmed,
  phone: optionalTrimmed,
  email: z.email().nullable().optional(),
  /** the catalog service the lead came for (S3) */
  serviceId: uuid.nullable().optional(),
  sourceId: uuid.nullable().optional(),
  description: optionalTrimmed,
});

/**
 * Only the name is required (user, 2026-07-26 — supersedes the S5 "at least one contact" rule).
 * A lead often arrives as nothing but a name and a note; the contacts get filled in later.
 */
export const createLeadInput = leadFields;
export type CreateLeadInput = z.infer<typeof createLeadInput>;

/** Partial edit; stage moves come through here too (kanban drag). */
export const updateLeadInput = leadFields.partial().extend({
  stage: leadStage.optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadInput>;

/**
 * Convert dialog — reviewed by the user before the client is created. Same shape as a
 * hand-created client: a first name identifies it, the last name is optional, and `companyName`
 * rides along as the informational label it already was on the lead.
 */
export const convertLeadInput = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: optionalTrimmed,
  companyName: optionalTrimmed,
  phone: optionalTrimmed,
  email: z.email().nullable().optional(),
  address: optionalTrimmed,
  sourceId: uuid.nullable().optional(),
  description: optionalTrimmed,
});
export type ConvertLeadInput = z.infer<typeof convertLeadInput>;
