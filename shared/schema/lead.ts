import { z } from "zod";
import { uuid } from "./common.js";
import { leadOutcome } from "./enums.js";

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
  stageId: uuid,
  /** resolved server-side, so a board never has to hold the stage list to draw a card */
  stageName: z.string(),
  /** where it sits inside its stage on the board — the firm's own order, dragged by hand */
  boardOrder: z.number().int(),
  outcome: leadOutcome,
  convertedClientId: uuid.nullable(),
  createdAt: z.iso.datetime(),
  /** soft delete — set means the lead only appears in Archive */
  archivedAt: z.iso.datetime().nullable(),
});
export type Lead = z.infer<typeof leadSchema>;

/**
 * The two lists the Leads screen shows. The board only ever wants live leads and the archive
 * only closed ones, so each asks the database for its own side instead of pulling the whole
 * table and filtering it in the browser. Both are capped — see `LEAD_LIST_LIMIT`.
 */
export const leadListQuery = z.object({
  /**
   * `in_process` = the pipeline board · `closed` = won + lost (the screen's "Closed" tab).
   *
   * `archived` is a different axis entirely: closed is an OUTCOME, archived is a soft delete.
   * A lead can be closed-won and still live on the screen; an archived one is gone from every
   * view but the Archive. Every other scope excludes archived leads.
   */
  scope: z.enum(["in_process", "closed", "all", "archived"]).default("all"),
  /**
   * Free text over the person, their company and their contacts.
   *
   * It has to be answered by the DATABASE, not by filtering the loaded rows: this list is capped
   * at `LEAD_LIST_LIMIT`, so a browser-side filter would quietly search the first 500 leads and
   * report "nothing found" for the rest — the same failure the client picker had at a hundred.
   */
  search: z.string().trim().optional(),
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

/**
 * Partial edit. NOT the board: dragging carries a position as well as a column and goes through
 * `moveLeadInput`, which is why nothing about the stage appears here (2026-08-28).
 */
export const updateLeadInput = leadFields.partial();
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

/**
 * Dragging a lead across the pipeline board.
 *
 * An ANCHOR — "put me after this one" — not an index, the same shape the tasks board, the service
 * catalog and the board columns all use: an index is a claim about a list that may have moved on,
 * and two people dragging at once with indices produce duplicates and gaps. `null` is the top of
 * the stage.
 */
export const moveLeadInput = z.object({
  stageId: uuid,
  afterLeadId: uuid.nullable(),
});
export type MoveLeadInput = z.infer<typeof moveLeadInput>;

// ── the pipeline's columns ───────────────────────────────────────────────────

/**
 * A stage of the pipeline. A TABLE since 2026-08-28, where it was a Prisma enum before: a firm
 * cannot reorder, rename or add to an enum, so the board could not be dragged and every change to
 * the pipeline was a migration. Same shape as a task board column, so both boards are one idea.
 */
export const leadStageSchema = z.object({
  id: uuid,
  name: z.string().min(1),
  order: z.number().int(),
});
export type LeadStageOption = z.infer<typeof leadStageSchema>;

export const createLeadStageInput = z.object({ name: z.string().trim().min(1).max(40) });
export type CreateLeadStageInput = z.infer<typeof createLeadStageInput>;

export const updateLeadStageInput = z.object({ name: z.string().trim().min(1).max(40) });
export type UpdateLeadStageInput = z.infer<typeof updateLeadStageInput>;

/** an ANCHOR, like every other order in this app: "put me after this one", null being the front */
export const moveLeadStageInput = z.object({ afterStageId: uuid.nullable() });
export type MoveLeadStageInput = z.infer<typeof moveLeadStageInput>;
