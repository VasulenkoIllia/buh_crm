import { z } from "zod";
import { uuid } from "./common.js";
import { SWEEP_EARLIEST_HOUR, isValidSweepAt } from "../notifications.js";
import { REMINDER_CHOICES } from "./calendar.js";

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
  /** what a NEW meeting is booked with. null = no reminder unless somebody picks one. */
  meetingRemindMinutes: z.number().int().nullable(),
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
  /**
   * When the nightly notification sweep runs, `HH:MM` in the firm's own zone.
   *
   * Refused before 04:00, and that is a real constraint rather than a preference: the task sweep
   * runs at 03:05 and the invoice sweep at 03:20, so an earlier notification sweep would scan
   * deadlines before the day's generated work exists and warn nobody about it.
   *
   * Asked of `isValidSweepAt` rather than a second regex written out here. The rule belongs beside
   * `sweepCron`, which is what actually runs; two copies of it could disagree about a value the
   * scheduler would then silently fall back on (audit, 2026-09-09).
   */
  notifySweepAt: z
    .string()
    .refine(isValidSweepAt, {
      message: `Use HH:MM, not before ${String(SWEEP_EARLIEST_HOUR).padStart(2, "0")}:00 — the task and invoice sweeps have to run first`,
    })
    .optional(),
  /** how many days ahead `task_deadline_near` warns. 1 = "due tomorrow". */
  notifyDeadlineDays: z.number().int().min(1).max(30).optional(),
  /**
   * The reminder a NEW meeting is booked with. `null` is Off, and is a real value here rather than
   * "unchanged" — which is why it is `.nullish()`: absent means the caller is not touching it.
   *
   * Constrained to the same choices the meeting form offers, because a number the pills cannot
   * show would prefill a control that then silently disagrees with it.
   */
  meetingRemindMinutes: z
    .union([
      z.literal(null),
      z
        .number()
        .int()
        .refine((v) => (REMINDER_CHOICES as readonly number[]).includes(v), {
          message: `Pick one of ${REMINDER_CHOICES.join(", ")} minutes, or none`,
        }),
    ])
    .optional(),
});
export type UpdateFirmInput = z.infer<typeof updateFirmInput>;

/**
 * **Invoice numbering is saved on its own, and stays admin-only whoever holds Settings.**
 *
 * The prefix is frozen into `Invoice.number` the moment an invoice is issued, and no route can
 * edit that field afterwards — so one careless change mid-year leaves the accounting year split
 * across two series with nothing able to repair it (recorded as an open question in
 * `modules/permissions.md` §16, answered here on 2026-09-06).
 *
 * While it rode on `updateFirmInput`, opening the Settings gate to a bookkeeper meant handing over
 * the firm's name, its option lists AND that one irreversible field together. Splitting the route
 * is what makes that switch usable: everything else on Settings follows the gate, this does not.
 */
export const updateNumberingInput = z.object({
  invoicePrefix: z.string().min(1).max(10).optional(),
  invoiceCounterDigits: z.number().int().min(3).max(6).optional(),
});
export type UpdateNumberingInput = z.infer<typeof updateNumberingInput>;

/**
 * **Who an invoice is from**, as the PDF prints it (payments.md §10). How to pay it is a set of
 * payment details since 2026-11-02 (`./payment-details.ts`), copied onto each invoice at issue;
 * this block stays live, so a new address reaches every paper.
 *
 * Its own read rather than fields on `firmProfileSchema`: `GET /api/settings` is `shared()`, open
 * to the whole firm for ever. Its own write for the reason numbering has one: what an invoice says
 * about the firm is an admin's to change whoever holds Settings, and it is kept in the log for years.
 *
 * `name` and `address` are read with their fallback (`invoiceIssuer` in `core/firm.ts`), so the form
 * shows what the next PDF will print rather than an empty box.
 */
export const invoiceDetailsSchema = z.object({
  name: z.string(),
  address: z.string().nullable(),
  website: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  /** the letterhead, which an invoice shares with letters. Not `printable` = WebP or GIF. */
  logo: z.object({ name: z.string(), printable: z.boolean() }).nullable(),
});
export type InvoiceDetails = z.infer<typeof invoiceDetailsSchema>;

/**
 * What changed, and nothing else: omitted leaves a field alone, `null` empties it. Saving the whole
 * block would write back whatever the form read, a colleague's newer bank details or the firm's
 * name that an empty field only falls back on (review, 2026-10-31).
 */
export const updateInvoiceDetailsInput = z
  .object({
    name: z.string().trim().min(1).max(120).nullable(),
    address: z.string().trim().min(1).max(300).nullable(),
    website: z.string().trim().min(1).max(120).nullable(),
    email: z.email().max(120).nullable(),
    phone: z.string().trim().min(1).max(40).nullable(),
  })
  .partial();
export type UpdateInvoiceDetailsInput = z.infer<typeof updateInvoiceDetailsInput>;
