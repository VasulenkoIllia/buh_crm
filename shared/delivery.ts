import type { z } from "zod";
import type { deliveryStateSchema } from "./schema/enums.js";

/**
 * What to tell somebody about one letter.
 *
 * The database records what HAPPENED — `sent`, `bounced`, an SMTP class, an enhanced code. None of
 * that is an answer to the only question a bookkeeper asks, which is "did they get it?". This is
 * the translation, and it lives in `shared/` because the screen and the server must never disagree
 * about the answer.
 *
 * The hard part is `delivered`. No mail system ever tells us a letter arrived — it only tells us
 * when one did not. So "delivered" here means: the letter was handed over, the mailbox it would
 * have bounced into was READ afterwards, and nothing came back. That is the strongest claim the
 * evidence supports, and it is only available for a mailbox somebody is actually listening to —
 * silence proves nothing when nobody is listening.
 */
/**
 *   sending        still going out
 *   skipped        never sent, deliberately — the reason names the rule that protected the firm
 *   not_sent       could not be handed over at all
 *   sent           handed over; too early, or nobody reads that mailbox, so the outcome is unknown
 *   delivered      handed over, the mailbox was read afterwards, and no report came back
 *   not_delivered  a report came back: this letter did not arrive
 *
 * Defined once, as the zod enum the API is typed against, so the wire and the rule cannot drift.
 */
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  sending: "Sending",
  skipped: "Skipped",
  not_sent: "Not sent",
  sent: "Sent",
  delivered: "Delivered",
  not_delivered: "Not delivered",
};

/**
 * How long after a send the mail system has had its say.
 *
 * A refusal at the far end comes back in seconds to minutes; the window is generous because the
 * cost of the two mistakes is not symmetrical. Calling a letter delivered too early is a confident
 * lie, while leaving it at "Sent" for another hour is merely uninformative.
 */
export const SETTLE_MINUTES = 60;

export interface DeliveryFacts {
  status: "queued" | "sent" | "failed" | "skipped" | "bounced";
  sentAt: string | null;
  /** when the mailbox this letter would have bounced into was last read; null = nobody reads it */
  mailboxCheckedAt: string | null;
}

/**
 * The one place the question is answered. Given the same facts, every screen says the same word.
 */
export function deliveryState(facts: DeliveryFacts, now: number = Date.now()): DeliveryState {
  switch (facts.status) {
    case "queued":
      return "sending";
    case "skipped":
      return "skipped";
    case "failed":
      return "not_sent";
    case "bounced":
      return "not_delivered";
    case "sent":
      break;
  }

  // Handed over. Whether that may be called "delivered" depends on somebody having looked since.
  if (!facts.sentAt || !facts.mailboxCheckedAt) return "sent";
  const settledBy = new Date(facts.sentAt).getTime() + SETTLE_MINUTES * 60_000;
  const looked = new Date(facts.mailboxCheckedAt).getTime();
  // Both conditions, not either: enough time has passed AND the mailbox was read after it did.
  return looked >= settledBy && now >= settledBy ? "delivered" : "sent";
}

/**
 * Why a letter did not arrive, in words that name the fault rather than the protocol.
 *
 * The server's own sentence is kept as the detail underneath; this is the headline, and it is what
 * decides whether the reader should go and fix an address or leave it alone.
 */
export function bounceHeadline(kind: "address" | "system" | "letter" | "transient"): string {
  switch (kind) {
    case "address":
      return "This address does not exist";
    case "system":
      return "A mail server problem — the address itself may be fine";
    case "letter":
      return "The letter was too large for their mailbox";
    case "transient":
      return "Temporarily refused — still being retried";
  }
}
