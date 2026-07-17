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
  /** numbering = PREFIX-YEAR-NNNN, counter resets yearly (decision 2026-07-17) */
  invoicePrefix: z.string().min(1).max(10),
  invoiceCounterDigits: z.number().int().min(3).max(6),
  currency: z.literal("USD"),
});
export type FirmProfile = z.infer<typeof firmProfileSchema>;

export const settingsResponse = z.object({
  priorities: z.array(prioritySchema),
  sources: z.array(sourceOptionSchema),
  firm: firmProfileSchema,
});
export type SettingsResponse = z.infer<typeof settingsResponse>;

// ── DTOs ─────────────────────────────────────────────────────────────────────

/** Priorities are a fixed set of 4 — editable, not addable/removable. */
export const updatePriorityInput = z.object({
  name: z.string().min(1).max(30).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color").optional(),
  order: z.number().int().min(0).optional(),
  /** only true is accepted — the default moves, it can't be turned off */
  isDefault: z.literal(true).optional(),
});
export type UpdatePriorityInput = z.infer<typeof updatePriorityInput>;

export const createSourceInput = z.object({
  name: z.string().min(1).max(40),
});
export type CreateSourceInput = z.infer<typeof createSourceInput>;

/** Sources are never deleted — only deactivated (history stays intact). */
export const updateSourceInput = z.object({
  name: z.string().min(1).max(40).optional(),
  active: z.boolean().optional(),
  order: z.number().int().min(0).optional(),
});
export type UpdateSourceInput = z.infer<typeof updateSourceInput>;

export const updateFirmInput = z.object({
  name: z.string().min(1).max(80).optional(),
  invoicePrefix: z.string().min(1).max(10).optional(),
  invoiceCounterDigits: z.number().int().min(3).max(6).optional(),
});
export type UpdateFirmInput = z.infer<typeof updateFirmInput>;