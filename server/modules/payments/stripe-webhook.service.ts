import { z } from "zod";
import { fmtMoney } from "@shared/money.js";
import { closeOpenCheckouts } from "./pay-link.service.js";
import * as repo from "./stripe-webhook.repository.js";
import { businessDateOf, tell, type EventOf, type Told } from "./stripe-webhook.notices.js";
import { STRIPE_API_VERSION, type StripeMode, type StripeWebhookEvent } from "./stripe.js";

/**
 * **The Stripe webhook: the payment marks itself** (payments.md §11.1, stage B).
 *
 * What it acts on, and nothing else:
 * - `checkout.session.completed`: a paid session of this CRM's becomes a payment on its invoice;
 * - `checkout.session.expired`: the session's row says so;
 * - `charge.refunded`, `charge.dispute.created`: the journal and a notice, the money untouched.
 *
 * Money that cannot be applied, a refund and a dispute are `needs_attention`: the admins are told,
 * and a person corrects the payment by hand, because nothing changes money on its own (decided
 * 2026-11-04). Events about payments this CRM did not take are ignored without a notice (owner,
 * 2026-11-12): the firm's Stripe account may carry other sales.
 *
 * **Once, and told at least once.** Every event is written to `StripeEvent` once, with what was
 * decided. The journal is written with it, the first time. The notice is keyed by the event, so it
 * is sent again on every delivery Stripe repeats and written only for whoever does not have it yet:
 * a notice lost after the commit (a restart, a failed write, which answers 500) reaches the admins
 * when Stripe delivers again. A failure of our own throws, and the route answers 500.
 */

const NOT_OURS = "not a payment this CRM asked for";

/**
 * How long a dispute about a payment this CRM has no record of is sent back to be delivered again,
 * rather than ignored. Stripe does not keep its events in order: on 2026-11-12 the sandbox's
 * dispute card sent the dispute 150 ms before the payment it disputes, and an answer of "not ours"
 * lost it for good. A dispute older than this is somebody else's sale (owner, 2026-11-12).
 */
export const UNKNOWN_DISPUTE_RETRY_MS = 60 * 60 * 1000;

/** What the route answers: 200, or a retry because the event came before what it is about. */
export type StripeEventAnswer = "handled" | "too_early";

const REFUSAL_REASONS: Record<repo.PaymentRefusal, string> = {
  cancelled: "the invoice was cancelled before the payment arrived",
  settled: "the invoice was already paid in full",
  over: "the payment is more than the invoice still owes",
  recorded: "this card payment is already recorded",
};

const isUuid = (value: string | null): value is string =>
  value !== null && z.uuid().safeParse(value).success;

function eventRow(
  event: StripeWebhookEvent,
  fields: Pick<repo.StripeEventRow, "objectId" | "invoiceId" | "outcome" | "reason">,
): repo.StripeEventRow {
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    occurredAt: event.occurredAt,
    ...fields,
  };
}

// ── the events ───────────────────────────────────────────────────────────────

/**
 * Why a paid session cannot become a payment before the invoice is even asked. Cards only, so
 * `paid` is the money; anything else (ACH switched on behind our back) is not recorded.
 */
function sessionProblem(event: EventOf<"session_completed">): string | null {
  if (event.paymentStatus !== "paid") {
    return `Stripe did not confirm the payment (status ${event.paymentStatus})`;
  }
  if (event.currency?.toLowerCase() !== "usd") {
    return `it was paid in ${event.currency ?? "no currency"}`;
  }
  if (event.amount === null || event.amount <= 0) return "Stripe sent no amount";
  // the PaymentIntent is the lock that keeps one card payment from being recorded twice
  if (!event.paymentIntentId) return "Stripe sent no payment id";
  return null;
}

/**
 * The event's row, then the journal and the notice. `false` when another delivery of the same
 * event wrote the row first.
 */
async function settle(
  event: StripeWebhookEvent,
  objectId: string,
  invoice: repo.InvoiceLabel | null,
  told: Told,
): Promise<boolean> {
  const isNew = await repo.saveEventOnce(
    eventRow(event, { objectId, invoiceId: invoice?.id ?? null, ...told }),
  );
  if (invoice && isNew && told.outcome !== "ignored") await tell(event, invoice, told, true);
  return isNew;
}

/** A completed session of somebody else's: told only when it names an invoice of ours. */
async function onForeignSession(event: EventOf<"session_completed">) {
  const invoice = isUuid(event.invoiceId) ? await repo.findInvoiceLabel(event.invoiceId) : null;
  const told: Told = invoice
    ? {
        outcome: "needs_attention",
        reason: "it was paid on a Stripe page this CRM has no record of",
      }
    : { outcome: "ignored", reason: NOT_OURS };
  return settle(event, event.sessionId, invoice, told);
}

async function onSessionCompleted(event: EventOf<"session_completed">): Promise<boolean> {
  const checkout = await repo.findCheckout(event.sessionId);
  if (!checkout) return onForeignSession(event);
  // read BEFORE the commit, so nothing after it can fail on the database but the notice itself
  const invoice = await repo.findInvoiceLabel(checkout.invoiceId);
  if (!invoice) throw new Error(`invoice ${checkout.invoiceId} of ${event.sessionId} is gone`);

  const problem = sessionProblem(event);
  const result = await repo.recordCompletedSession({
    event: eventRow(event, {
      objectId: event.sessionId,
      invoiceId: checkout.invoiceId,
      outcome: "needs_attention",
      reason: problem,
    }),
    invoiceId: checkout.invoiceId,
    checkoutId: checkout.id,
    paymentIntentId: event.paymentIntentId,
    payment:
      problem || event.amount === null
        ? null
        : { amount: event.amount, paidAt: businessDateOf(event.occurredAt) },
    refusalReasons: REFUSAL_REASONS,
  });
  if (result.duplicate) return false;
  await tellThenClose(event, invoice, result, true);
  return true;
}

/**
 * The balance moved, so any other session still open on the invoice asks for the old one: closed
 * even when the notice fails, because a payer on that page is the second payment.
 */
async function tellThenClose(
  event: EventOf<"session_completed">,
  invoice: repo.InvoiceLabel,
  told: Told,
  isFirst: boolean,
) {
  try {
    await tell(event, invoice, told, isFirst);
  } finally {
    if (told.outcome === "applied") await closeOpenCheckouts([invoice.id]); // never throws
  }
}

async function onSessionExpired(event: EventOf<"session_expired">) {
  const checkout = await repo.findCheckout(event.sessionId);
  const isChanged =
    checkout !== null && (await repo.markSessionExpired(event.sessionId)).count > 0;
  return repo.saveEventOnce(
    eventRow(event, {
      objectId: event.sessionId,
      invoiceId: checkout?.invoiceId ?? null,
      outcome: isChanged ? "applied" : "ignored",
      reason: isChanged ? null : checkout ? "the session was already closed" : NOT_OURS,
    }),
  );
}

/**
 * A refund of a card payment the CRM knows: by the PaymentIntent the completed session recorded,
 * or, for a refund that overtook its own payment's event, by the invoice id Stripe copied from the
 * PaymentIntent onto the charge. Always told: even money the card payment never recorded may have
 * been recorded by hand since (delta review, 2026-11-12).
 */
async function onChargeRefunded(event: EventOf<"charge_refunded">) {
  const known = event.paymentIntentId
    ? await repo.findInvoiceIdByPaymentIntent(event.paymentIntentId)
    : null;
  const invoiceId = known ?? (isUuid(event.invoiceId) ? event.invoiceId : null);
  const invoice = invoiceId ? await repo.findInvoiceLabel(invoiceId) : null;
  const refunded =
    event.refundedAmount >= event.amount
      ? `${fmtMoney(event.amount)} refunded in full in Stripe`
      : `${fmtMoney(event.refundedAmount)} of ${fmtMoney(event.amount)} refunded in Stripe`;
  const told: Told = invoice
    ? { outcome: "needs_attention", reason: refunded }
    : { outcome: "ignored", reason: NOT_OURS };
  return settle(event, event.chargeId, invoice, told);
}

async function onDisputeCreated(event: EventOf<"dispute_created">) {
  const invoiceId = event.paymentIntentId
    ? await repo.findInvoiceIdByPaymentIntent(event.paymentIntentId)
    : null;
  const invoice = invoiceId ? await repo.findInvoiceLabel(invoiceId) : null;
  if (!invoice) {
    // a dispute has a deadline and money: the row alone would not say which payment it named
    console.error(
      `[stripe] dispute ${event.disputeId} (event ${event.id}) ignored: no payment of ours is ` +
        `${event.paymentIntentId ?? "a dispute with no PaymentIntent"}`,
    );
  }
  const told: Told = invoice
    ? {
        outcome: "needs_attention",
        reason: `${fmtMoney(event.amount)} disputed: ${event.reason.replaceAll("_", " ")}`,
      }
    : { outcome: "ignored", reason: NOT_OURS };
  return settle(event, event.disputeId, invoice, told);
}

/**
 * A delivery Stripe repeats, or one that met another delivery of the same event: nothing is
 * written again, but the notice is sent again, which writes only for whoever does not have it.
 * The journal is not: a crash between the commit and the response loses its entry, and the
 * event's row is what is left (payments.md §11.1).
 */
async function retell(event: StripeWebhookEvent, seen: repo.SeenEvent) {
  if (seen.outcome === "ignored" || !seen.invoiceId) return;
  const invoice = await repo.findInvoiceLabel(seen.invoiceId);
  if (!invoice) return;
  if (event.kind === "session_completed") await tellThenClose(event, invoice, seen, false);
  else await tell(event, invoice, seen, false);
}

/**
 * A dispute that may have overtaken its own payment: young, and about a PaymentIntent no session of
 * ours has recorded yet. Nothing is written, so the delivery Stripe sends again is a first one; the
 * log line is written here, where the PaymentIntent and the age are known.
 */
async function isTooEarly(event: StripeWebhookEvent): Promise<boolean> {
  if (event.kind !== "dispute_created" || !event.paymentIntentId) return false;
  const ageMs = Date.now() - event.occurredAt.getTime();
  if (ageMs >= UNKNOWN_DISPUTE_RETRY_MS) return false;
  if ((await repo.findInvoiceIdByPaymentIntent(event.paymentIntentId)) !== null) return false;
  console.error(
    `[stripe] event ${event.id} (${event.type}) is about a payment not recorded yet ` +
      `(${event.paymentIntentId}, ${Math.round(ageMs / 60_000)} min old); ` +
      "Stripe will deliver it again",
  );
  return true;
}

/** The first delivery of an event. `false` when another delivery of it got there first. */
function handleFirst(event: StripeWebhookEvent): Promise<boolean> {
  switch (event.kind) {
    case "session_completed":
      return onSessionCompleted(event);
    case "session_expired":
      return onSessionExpired(event);
    case "charge_refunded":
      return onChargeRefunded(event);
    case "dispute_created":
      return onDisputeCreated(event);
    case "other":
      return repo.saveEventOnce(
        eventRow(event, {
          objectId: event.objectId,
          invoiceId: null,
          outcome: "ignored",
          reason: "not an event this CRM handles",
        }),
      );
  }
}

/**
 * One verified event. Throws only on a failure of our own, which the route answers 500 so that
 * Stripe delivers it again; `too_early` is the same retry, asked for on purpose.
 */
export async function handleStripeEvent(
  event: StripeWebhookEvent,
  mode: StripeMode,
): Promise<StripeEventAnswer> {
  if (event.apiVersion && event.apiVersion !== STRIPE_API_VERSION) {
    // read anyway: the fields used here have kept their shape, but the endpoint should be fixed
    console.error(
      `[stripe] event ${event.id} came in API version ${event.apiVersion}, the code reads ` +
        `${STRIPE_API_VERSION}: set the webhook endpoint's version in Stripe's Dashboard`,
    );
  }
  if (event.livemode !== (mode === "live")) {
    // with one signing secret per mode this cannot pass the signature; written down if it ever does
    await repo.saveEventOnce(
      eventRow(event, {
        objectId: null,
        invoiceId: null,
        outcome: "ignored",
        reason: `a ${event.livemode ? "live" : "sandbox"} event while the CRM runs ${mode}`,
      }),
    );
    return "handled";
  }
  const seen = await repo.findEvent(event.id);
  if (seen) {
    await retell(event, seen);
    return "handled";
  }
  if (await isTooEarly(event)) return "too_early";
  if (await handleFirst(event)) return "handled";
  // the other delivery may still fail after its row: tell what it decided from here too
  const decided = await repo.findEvent(event.id);
  if (decided) await retell(event, decided);
  return "handled";
}
