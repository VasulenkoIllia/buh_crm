import { Prisma, type StripeEventOutcome } from "../../generated/prisma/client.js";
import { prisma } from "../../core/db.js";
import { insertPaymentLocked, paymentSnapshot, writeAudit } from "./payments.repository.js";

/**
 * What the Stripe webhook reads and writes (payments.md §11). Every write that records an event
 * either commits with the event's row or not at all, so a delivery Stripe repeats finds the row and
 * does nothing, and one that failed half way leaves nothing behind for the retry to trip over.
 */

/** The event's own row, written once per Stripe event id. */
export interface StripeEventRow {
  id: string;
  type: string;
  livemode: boolean;
  objectId: string | null;
  invoiceId: string | null;
  outcome: StripeEventOutcome;
  reason: string | null;
  occurredAt: Date;
}

/** An event already accepted: what was decided about it, so a repeat can tell it again. */
export function findEvent(id: string) {
  return prisma.stripeEvent.findUnique({
    where: { id },
    select: { outcome: true, reason: true, invoiceId: true },
  });
}

export type SeenEvent = NonNullable<Awaited<ReturnType<typeof findEvent>>>;

/**
 * Write the event's row. `false` when the row is already there: another delivery of the same event
 * got here first, and whatever comes after the row is already done or being done.
 */
export async function saveEventOnce(row: StripeEventRow): Promise<boolean> {
  try {
    await prisma.stripeEvent.create({ data: row });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

/** A session this CRM made, by Stripe's id. */
export function findCheckout(sessionId: string) {
  return prisma.stripeCheckout.findUnique({
    where: { sessionId },
    select: { id: true, invoiceId: true },
  });
}

/**
 * The invoice a card payment belongs to, from the PaymentIntent: the session that took it records
 * it when it completes, whether or not the payment could be applied.
 */
export async function findInvoiceIdByPaymentIntent(paymentIntentId: string) {
  const checkout = await prisma.stripeCheckout.findUnique({
    where: { paymentIntentId },
    select: { invoiceId: true },
  });
  return checkout?.invoiceId ?? null;
}

/** Whether a card payment is recorded in the CRM: a refund or a dispute of it has to be corrected. */
export async function hasStripePayment(paymentIntentId: string | null): Promise<boolean> {
  if (!paymentIntentId) return false;
  const payment = await prisma.payment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true },
  });
  return payment !== null;
}

/** What the journal and the notice say about an invoice. */
export function findInvoiceLabel(id: string) {
  return prisma.invoice.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      clientId: true,
      client: { select: { firstName: true, lastName: true } },
    },
  });
}

export type InvoiceLabel = NonNullable<Awaited<ReturnType<typeof findInvoiceLabel>>>;

/** A session that ended unpaid. Never moves a completed one back. */
export function markSessionExpired(sessionId: string) {
  return prisma.stripeCheckout.updateMany({
    where: { sessionId, status: "open" },
    data: { status: "expired" },
  });
}

/** Why a paid session recorded no payment: the invoice's three, and the payment already there. */
export type PaymentRefusal = "cancelled" | "settled" | "over" | "recorded";

export type SessionPaymentResult =
  | { duplicate: true }
  | {
      duplicate: false;
      /** what the event's row says, for whoever is told */
      outcome: StripeEventOutcome;
      reason: string | null;
      /** null when the payment was recorded, or when none was asked for */
      refusal: PaymentRefusal | null;
    };

/**
 * **A completed session, in one transaction** (payments.md §11):
 *
 * 1. the invoice's row lock, so two deliveries of one event, or of two events about one payment,
 *    take turns here, and the second sees what the first wrote;
 * 2. the session marked `completed` FIRST, with the PaymentIntent that paid it: the open sessions
 *    closed after the commit are then everything except this one;
 * 3. the payment, through the same locked check as Add payment, with nobody as its author;
 * 4. its audit row and the event's own row.
 *
 * `payment: null` in the input is a session that cannot be applied at all (not paid, or another
 * currency): the session and the event are still written, as the event's own outcome says.
 */
export function recordCompletedSession(input: {
  event: StripeEventRow;
  invoiceId: string;
  checkoutId: string;
  paymentIntentId: string | null;
  payment: { amount: number; paidAt: Date } | null;
  /** the event's reason when the payment is refused, in the service's words */
  refusalReasons: Record<PaymentRefusal, string>;
}): Promise<SessionPaymentResult> {
  const { event, invoiceId, paymentIntentId } = input;
  return prisma.$transaction(async (tx): Promise<SessionPaymentResult> => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { updatedAt: new Date() }, // the write is what takes the lock
      select: { id: true },
    });
    if (await tx.stripeEvent.findUnique({ where: { id: event.id }, select: { id: true } })) {
      return { duplicate: true };
    }
    await tx.stripeCheckout.update({
      where: { id: input.checkoutId },
      data: { status: "completed", ...(paymentIntentId ? { paymentIntentId } : {}) },
    });

    let isApplied = false;
    let refusal: PaymentRefusal | null = null;
    if (input.payment) {
      const already = paymentIntentId
        ? await tx.payment.findUnique({
            where: { stripePaymentIntentId: paymentIntentId },
            select: { id: true },
          })
        : null;
      if (already) {
        refusal = "recorded";
      } else {
        const inserted = await insertPaymentLocked(tx, {
          invoiceId,
          amount: input.payment.amount,
          paidAt: input.payment.paidAt,
          // the PaymentIntent is what Stripe's Dashboard finds the payment by
          reference: paymentIntentId,
          source: "stripe",
          stripePaymentIntentId: paymentIntentId,
          createdById: null,
        });
        if (inserted.payment) {
          isApplied = true;
          await writeAudit(
            {
              invoiceId,
              paymentId: inserted.payment.id,
              action: "created",
              byUserId: null,
              after: paymentSnapshot(inserted.payment),
            },
            tx,
          );
        } else {
          refusal = inserted.reason;
        }
      }
    }

    const outcome: StripeEventOutcome = isApplied
      ? "applied"
      : refusal === "recorded"
        ? "ignored"
        : event.outcome;
    const reason = refusal ? input.refusalReasons[refusal] : event.reason;
    await tx.stripeEvent.create({ data: { ...event, invoiceId, outcome, reason } });
    return { duplicate: false, outcome, reason, refusal };
  });
}

/** When the newest event arrived with this mode's key, for Settings → System. */
export async function lastEventAt(livemode: boolean): Promise<Date | null> {
  const row = await prisma.stripeEvent.findFirst({
    where: { livemode },
    orderBy: { receivedAt: "desc" },
    select: { receivedAt: true },
  });
  return row?.receivedAt ?? null;
}
