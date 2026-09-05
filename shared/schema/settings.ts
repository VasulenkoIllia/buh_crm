import { z } from "zod";
import { uuid } from "./common.js";
import { SWEEP_EARLIEST_HOUR } from "../notifications.js";

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
  /**
   * The firm's timezone — read-only here, because it comes from `TZ` in the environment and the
   * scheduler reads the same value at boot. It travels to the browser so that instants (a meeting's
   * start, "created at") are drawn on the FIRM's clock rather than whatever zone the viewer's
   * machine happens to be set to (decision 2026-08-06).
   */
  timezone: z.string().min(1),
  /** when the nightly notification sweep runs, `HH:MM` in the firm's own zone (S9.2) */
  notifySweepAt: z.string(),
  /** how many days ahead `task_deadline_near` warns; 1 = "due tomorrow" */
  notifyDeadlineDays: z.number().int(),
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
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color")
    .optional(),
  order: z.number().int().min(0).optional(),
  /** only true is accepted — the default moves, it can't be turned off */
  isDefault: z.literal(true).optional(),
});
export type UpdatePriorityInput = z.infer<typeof updatePriorityInput>;

/** Reorder: swap two priorities' positions (applied atomically server-side). */
export const swapPrioritiesInput = z.object({ aId: uuid, bId: uuid });
export type SwapPrioritiesInput = z.infer<typeof swapPrioritiesInput>;

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
  /**
   * When the nightly notification sweep runs, `HH:MM` in the firm's own zone.
   *
   * Refused before 04:00, and that is a real constraint rather than a preference: the task sweep
   * runs at 03:05 and the invoice sweep at 03:20, so an earlier notification sweep would scan
   * deadlines before the day's generated work exists and warn nobody about it.
   */
  notifySweepAt: z
    .string()
    .regex(/^([0-9]|[01][0-9]|2[0-3]):[0-5][0-9]$/, "Use HH:MM")
    .refine((v) => Number(v.split(":")[0]) >= SWEEP_EARLIEST_HOUR, {
      message: `Not before ${String(SWEEP_EARLIEST_HOUR).padStart(2, "0")}:00 — the task and invoice sweeps have to run first`,
    })
    .optional(),
  /** how many days ahead `task_deadline_near` warns. 1 = "due tomorrow". */
  notifyDeadlineDays: z.number().int().min(1).max(30).optional(),
});
export type UpdateFirmInput = z.infer<typeof updateFirmInput>;
