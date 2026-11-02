import { z } from "zod";
import { uuid } from "./common.js";

/**
 * **Sets of payment details** (payments.md §10, 2026-11-02): where a client sends the money, as
 * the invoice prints it. Several, because clients inside the US and outside it pay to different
 * accounts; one live set is the default for every client who names none.
 *
 * The text travels on Settings' own read only. Whoever can read it sees the firm's bank accounts,
 * so it is never on a `shared()` read: the client card's select gets names from the options below.
 */
export const paymentDetailsSchema = z.object({
  id: uuid,
  name: z.string(),
  details: z.string(),
  isDefault: z.boolean(),
  archivedAt: z.iso.datetime().nullable(),
  /** live clients who name this set: archiving waits until it is 0 */
  clients: z.number().int(),
});
export type PaymentDetails = z.infer<typeof paymentDetailsSchema>;

/** What a screen that is not Settings may know about a set: never its text. Live sets only. */
export const paymentDetailsOptionSchema = paymentDetailsSchema.pick({
  id: true,
  name: true,
  isDefault: true,
});
export type PaymentDetailsOption = z.infer<typeof paymentDetailsOptionSchema>;

/** The width of the old Payment information box, which the Default set inherited. */
export const PAYMENT_DETAILS_MAX = 2000;

export const createPaymentDetailsInput = z.object({
  name: z.string().trim().min(1).max(60),
  details: z.string().trim().min(1).max(PAYMENT_DETAILS_MAX),
});
export type CreatePaymentDetailsInput = z.infer<typeof createPaymentDetailsInput>;

/** What changed: omitted leaves it alone, so a stale form cannot undo a colleague's edit. */
export const updatePaymentDetailsInput = createPaymentDetailsInput.partial();
export type UpdatePaymentDetailsInput = z.infer<typeof updatePaymentDetailsInput>;

/**
 * What a client with no set of their own is shown and logged as. Not "Default": the set carried
 * over from before is named that, and "Default → International" would not say which was meant.
 */
export const FIRM_DEFAULT_LABEL = "Firm default";

/** The client card's select. `null` = the firm's default, whichever set that is at issue. */
export const setClientPaymentDetailsInput = z.object({ paymentDetailsId: uuid.nullable() });
export type SetClientPaymentDetailsInput = z.infer<typeof setClientPaymentDetailsInput>;
