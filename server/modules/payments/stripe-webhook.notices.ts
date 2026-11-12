import type { NotificationTriggerKey } from "@shared/notifications.js";
import { fmtMoney } from "@shared/money.js";
import type { StripeEventOutcome } from "../../generated/prisma/client.js";
import { record, type ActivityActor } from "../../core/activity.js";
import { config } from "../../core/config.js";
import { fromDate, toUtc } from "../../core/dates.js";
import { clientLabel } from "../../core/names.js";
import { notify, type NotifyOutcome } from "../../core/notify.js";
import { hasStripePayment, type InvoiceLabel } from "./stripe-webhook.repository.js";
import { STRIPE_LABEL, type StripeWebhookEvent } from "./stripe.js";

/**
 * **What the Stripe webhook writes in the journal and tells the admins** (payments.md §11.1): the
 * journal the first time an event is handled, the notice every time it is delivered and not
 * ignored. The flow that decides is `stripe-webhook.service.ts`.
 */

export const STRIPE_ACTOR: ActivityActor = { kind: "system", label: STRIPE_LABEL };

/** The day the payment was made, in the firm's time zone, stored as UTC midnight like any other. */
export const businessDateOf = (at: Date) => toUtc(fromDate(at, config.TZ));

export type EventOf<K extends StripeWebhookEvent["kind"]> = Extract<
  StripeWebhookEvent,
  { kind: K }
>;

/** What was decided about an event: its row's outcome and reason. */
export type Told = { outcome: StripeEventOutcome; reason: string | null };

/** A notice that could not be written fails the request, so Stripe delivers it again. */
async function sent(
  trigger: NotificationTriggerKey,
  eventId: string,
  told: Promise<NotifyOutcome>,
) {
  if ((await told).failed) {
    throw new Error(`the ${trigger} notice of Stripe event ${eventId} could not be written`);
  }
}

function attention(
  invoice: InvoiceLabel,
  eventId: string,
  words: { problem: string; sub: string },
) {
  return sent(
    "invoice_online_attention",
    eventId,
    notify("invoice_online_attention", {
      dedup: eventId,
      vars: {
        number: invoice.number,
        client: clientLabel(invoice.client),
        problem: words.problem,
      },
      sub: words.sub,
      link: { type: "invoice", id: invoice.id },
    }),
  );
}

/** Dollars, or nothing: a session in another currency is not ours to format as money. */
const usdAmount = (event: EventOf<"session_completed">) =>
  event.currency?.toLowerCase() === "usd" ? event.amount : null;

const subject = (invoice: InvoiceLabel) => ({
  subjectId: invoice.id,
  subjectLabel: invoice.number,
  clientId: invoice.clientId,
  actor: STRIPE_ACTOR,
});

async function tellSession(
  event: EventOf<"session_completed">,
  invoice: InvoiceLabel,
  told: Told,
  isFirst: boolean,
) {
  const amount = usdAmount(event);
  if (told.outcome === "applied" && amount !== null) {
    const paidAt = businessDateOf(event.occurredAt).toISOString();
    if (isFirst)
      record("invoice.paid_online", { ...subject(invoice), changes: { amount, paidAt } });
    await sent(
      "invoice_paid_online",
      event.id,
      notify("invoice_paid_online", {
        dedup: event.id,
        vars: { number: invoice.number, client: clientLabel(invoice.client) },
        sub: `${fmtMoney(amount)} by card through Stripe`,
        link: { type: "invoice", id: invoice.id },
      }),
    );
    return;
  }
  if (told.outcome !== "needs_attention") return;
  const reason = told.reason ?? "unknown";
  if (isFirst) {
    record("invoice.online_payment_unapplied", {
      ...subject(invoice),
      changes: { ...(amount !== null ? { amount } : {}), reason },
    });
  }
  // not paid yet is not money to give back: the bank may still pay it
  const isPaid = event.paymentStatus === "paid";
  await attention(invoice, event.id, {
    problem: isPaid ? "a Stripe payment was not recorded" : "a Stripe payment is not confirmed",
    sub: isPaid
      ? `${amount !== null ? `${fmtMoney(amount)} paid online, ` : ""}not recorded: ${reason}. ` +
        "Refund it in Stripe or record it by hand."
      : `Not recorded: ${reason}. Check it in Stripe before recording anything.`,
  });
}

async function tellRefund(
  event: EventOf<"charge_refunded">,
  invoice: InvoiceLabel,
  told: Told,
  isFirst: boolean,
) {
  if (isFirst) {
    record("invoice.refunded_in_stripe", {
      ...subject(invoice),
      changes: { amount: event.amount, refundedAmount: event.refundedAmount },
    });
  }
  // money the card payment never recorded may have been recorded by hand after the first notice
  const isRecorded = await hasStripePayment(event.paymentIntentId);
  await attention(invoice, event.id, {
    problem: "a payment was refunded in Stripe",
    sub:
      `${told.reason ?? "Refunded"}. ` +
      (isRecorded
        ? "The payment in the CRM stays until you correct it."
        : "No card payment was recorded for it here: check any payment recorded by hand."),
  });
}

async function tellDispute(
  event: EventOf<"dispute_created">,
  invoice: InvoiceLabel,
  isFirst: boolean,
) {
  const reason = event.reason.replaceAll("_", " ");
  if (isFirst) {
    record("invoice.disputed_in_stripe", {
      ...subject(invoice),
      changes: { amount: event.amount, reason },
    });
  }
  const isRecorded = await hasStripePayment(event.paymentIntentId);
  await attention(invoice, event.id, {
    problem: "a payment was disputed in Stripe",
    sub:
      `${fmtMoney(event.amount)} disputed: ${reason}. Answer it in Stripe` +
      (isRecorded ? "; the payment in the CRM stays until you correct it." : "."),
  });
}

/** The journal the first time, and the notice every time the event is not ignored. */
export function tell(
  event: StripeWebhookEvent,
  invoice: InvoiceLabel,
  told: Told,
  isFirst: boolean,
): Promise<void> {
  switch (event.kind) {
    case "session_completed":
      return tellSession(event, invoice, told, isFirst);
    case "charge_refunded":
      return tellRefund(event, invoice, told, isFirst);
    case "dispute_created":
      return tellDispute(event, invoice, isFirst);
    default:
      return Promise.resolve();
  }
}
