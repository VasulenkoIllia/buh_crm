import { createHash } from "node:crypto";
import { z } from "zod";
import { record } from "../../core/activity.js";
import { webOrigin } from "../../core/email.js";
import * as repo from "./pay-link.repository.js";
import { lastEventAt } from "./stripe-webhook.repository.js";
import {
  describeStripeError,
  isLastingStripeError,
  isRejectedRequest,
  STRIPE_MIN_AMOUNT,
  stripeErrorParam,
  stripeGateway,
  type CheckoutSessionRequest,
  type StripeGateway,
} from "./stripe.js";

/**
 * **The pay link** (payments.md §11): `https://<APP_DOMAIN>/pay/<token>` on the invoice card and
 * on the PDF, answered with a 303 to a Stripe Checkout Session for the balance at the moment of the
 * click. A session lives at most a day, so its own URL can never be printed; ours is permanent and
 * every click asks Stripe for the current amount.
 *
 * The money itself is decided by the webhook (stage B). Nothing here records a payment.
 */

export const PAY_PATH = "/pay";

/**
 * Stripe refuses a session that expires sooner than 30 minutes after it reaches them, so the
 * minute on top is for the clocks and the trip between us.
 */
const CHECKOUT_LIFETIME_MS = 31 * 60_000;

/**
 * Clicks inside one five-minute window that find nothing to reuse send Stripe the SAME request,
 * expiry included, under the same idempotency key, so two tabs opened at once get one session and
 * not two. The expiry is counted from the window's end, so it is 31 to 36 minutes away.
 */
const CHECKOUT_WINDOW_MS = 5 * 60_000;

/**
 * An open session is reused only while this much of it is left: sending somebody to a page that
 * closes before they have typed a card number is worse than making a new one.
 */
const REUSE_MIN_REMAINING_MS = 10 * 60_000;

/** A token is 43 base64url characters; anything else is not one, and is not looked up. */
const PAY_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function payLinkUrl(payToken: string): string {
  return `${webOrigin()}${PAY_PATH}/${payToken}`;
}

/**
 * The link the invoice card copies: while Stripe is on, and only while the invoice owes at least
 * Stripe's smallest card charge and is not cancelled. Null otherwise, so the button is not there.
 */
export function payUrlFor(invoice: {
  payToken: string;
  amount: number;
  paidTotal: number;
  cancelledAt: Date | null;
}): string | null {
  if (!stripeGateway() || invoice.cancelledAt) return null;
  return invoice.amount - invoice.paidTotal >= STRIPE_MIN_AMOUNT
    ? payLinkUrl(invoice.payToken)
    : null;
}

/**
 * For Settings → System: off is `null`, and then nothing about Stripe shows anywhere. The last
 * webhook is the newest event accepted with this mode's key: a long silence while clients pay is
 * how a broken endpoint shows (a new domain, Cloudflare, a wrong secret).
 */
export async function stripeStatus(): Promise<{
  mode: StripeGateway["mode"];
  lastWebhookAt: string | null;
} | null> {
  const gateway = stripeGateway();
  if (!gateway) return null;
  const lastAt = await lastEventAt(gateway.mode === "live");
  return { mode: gateway.mode, lastWebhookAt: lastAt?.toISOString() ?? null };
}

// ── a click on the link ──────────────────────────────────────────────────────

/** Which page the link answers with when it does not send the payer to Stripe. */
export type PayPageKind =
  | "unknown"
  | "cancelled"
  | "settled"
  | "unavailable"
  | "failed"
  | "returned_paid"
  | "returned_cancelled";

export type PayLinkAnswer =
  | { kind: "redirect"; url: string }
  | {
      kind: "page";
      page: PayPageKind;
      status: number;
      invoiceNumber: string | null;
      isSandbox: boolean;
    };

const isEmail = (value: string | null | undefined): value is string =>
  !!value && z.email().safeParse(value).success;

function page(
  pageKind: PayPageKind,
  status: number,
  invoice: { number: string } | null,
): PayLinkAnswer {
  return {
    kind: "page",
    page: pageKind,
    status,
    invoiceNumber: invoice?.number ?? null,
    isSandbox: stripeGateway()?.mode === "sandbox",
  };
}

async function findByToken(token: string) {
  return PAY_TOKEN_SHAPE.test(token) ? repo.findInvoiceByPayToken(token) : null;
}

/**
 * Where Stripe sends the payer back. For show only: Stripe returns to `paid` after a successful
 * card payment, and the webhook, not this page, is what records it.
 */
export async function payLinkReturn(
  token: string,
  back: "paid" | "cancelled",
): Promise<PayLinkAnswer> {
  const invoice = await findByToken(token);
  if (!invoice) return page("unknown", 404, null);
  return page(back === "paid" ? "returned_paid" : "returned_cancelled", 200, invoice);
}

/**
 * Same request in the same window → same key → Stripe hands back the session it already made.
 * The invoice's `updatedAt` is in it, so after any change to the invoice the next request is a
 * new one rather than a replay of a session that may have been closed since.
 */
function idempotencyKey(
  invoice: repo.PayLinkInvoice,
  request: Omit<CheckoutSessionRequest, "idempotencyKey">,
) {
  const content = JSON.stringify({ ...request, version: invoice.updatedAt.toISOString() });
  return `crm-pay-${createHash("sha256").update(content).digest("hex").slice(0, 48)}`;
}

function sessionRequest(
  invoice: repo.PayLinkInvoice,
  token: string,
  balance: number,
  now: Date,
  withEmail: boolean,
) {
  const windowEnd = Math.floor(now.getTime() / CHECKOUT_WINDOW_MS + 1) * CHECKOUT_WINDOW_MS;
  const back = `${payLinkUrl(token)}?back=`;
  // the paper's addressee: the company's invoice address, else the client's own
  const email = invoice.company?.email ?? invoice.client.email;
  const request = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    amount: balance,
    customerEmail: withEmail && isEmail(email) ? email : null,
    successUrl: `${back}paid`,
    cancelUrl: `${back}cancelled`,
    expiresAt: new Date(windowEnd + CHECKOUT_LIFETIME_MS),
  };
  return { ...request, idempotencyKey: idempotencyKey(invoice, request) };
}

const balanceOf = (invoice: repo.PayLinkInvoice) => invoice.amount - invoice.paidTotal;

/**
 * A cancelled or settled invoice says so, and closes whatever session is still open on it: an
 * expire that failed when the invoice was cancelled or paid is tried again here, by the next visit.
 */
async function closedInvoicePage(invoice: repo.PayLinkInvoice): Promise<PayLinkAnswer | null> {
  const pageKind = invoice.cancelledAt
    ? "cancelled"
    : balanceOf(invoice) <= 0
      ? "settled"
      : null;
  if (!pageKind) return null;
  await closeOpenCheckouts([invoice.id]);
  return page(pageKind, 200, invoice);
}

type MadeSession =
  | { ok: true; url: string; sessionId: string; createdAt: Date }
  | { ok: false; isLasting: boolean };

/**
 * A new session for the balance, kept. A refusal Stripe will repeat (a bad key, a bad request) is
 * told apart from one worth retrying (the network, Stripe's own trouble), so the payer is not sent
 * back again and again to a page that cannot open. An email Stripe will not take is dropped once,
 * because the payer types their own on Stripe's page anyway.
 */
async function makeSession(
  gateway: StripeGateway,
  invoice: repo.PayLinkInvoice,
  token: string,
  now: Date,
): Promise<MadeSession> {
  const balance = balanceOf(invoice);
  let request = sessionRequest(invoice, token, balance, now, true);
  let session;
  try {
    try {
      session = await gateway.createCheckoutSession(request);
    } catch (error) {
      if (!request.customerEmail || stripeErrorParam(error) !== "customer_email") throw error;
      console.error(
        `[stripe] Stripe refused the email on invoice ${invoice.number}; the payer types one`,
      );
      request = sessionRequest(invoice, token, balance, now, false);
      session = await gateway.createCheckoutSession(request);
    }
  } catch (error) {
    console.error(
      `[stripe] a Checkout Session for invoice ${invoice.number} could not be made: ` +
        describeStripeError(error),
    );
    return { ok: false, isLasting: isLastingStripeError(error) };
  }
  const saved = await repo.saveCheckout({
    sessionId: session.id,
    invoiceId: invoice.id,
    amount: balance,
    url: session.url,
    expiresAt: session.expiresAt,
    livemode: session.livemode,
  });
  return { ok: true, url: session.url, sessionId: session.id, createdAt: saved.createdAt };
}

/**
 * A click: the open session for this balance if there is one, else a new one, and the older ones
 * closed so that only the newest can be paid. A settled or cancelled invoice says so instead.
 */
export async function openPayLink(
  token: string,
  now = new Date(),
  isRetry = false,
): Promise<PayLinkAnswer> {
  const invoice = await findByToken(token);
  if (!invoice) return page("unknown", 404, null);
  const closed = await closedInvoicePage(invoice);
  if (closed) return closed;
  const balance = balanceOf(invoice);

  const gateway = stripeGateway();
  // below Stripe's smallest card charge the link is not offered, and an old one says so
  if (!gateway || balance < STRIPE_MIN_AMOUNT) {
    // a session still open here is for an older, larger balance: a failed expire is tried again
    await closeOpenCheckouts([invoice.id]);
    return page("unavailable", 200, invoice);
  }

  const open = await repo.findReusableCheckout({
    invoiceId: invoice.id,
    amount: balance,
    livemode: gateway.mode === "live",
    openUntilAfter: new Date(now.getTime() + REUSE_MIN_REMAINING_MS),
  });
  if (open) return { kind: "redirect", url: open.url };

  const made = await makeSession(gateway, invoice, token, now);
  if (!made.ok) return page(made.isLasting ? "unavailable" : "failed", 503, invoice);

  /**
   * **The invoice may have moved while Stripe was answering.** A cancel or a payment committed in
   * that second closed the open sessions it could see, and this one was not saved yet. Read again,
   * now that the row exists: if anything moved, close every open session that no longer matches
   * what is owed, this one included, and answer from the invoice as it is now. A session another
   * click has just made for the NEW balance stays open for its payer. Once only, so a busy invoice
   * cannot loop.
   */
  const fresh = await findByToken(token);
  if (!fresh || fresh.cancelledAt || balanceOf(fresh) !== balance) {
    await expireOpen(gateway, {
      invoiceIds: [invoice.id],
      now: new Date(),
      // a cancelled invoice keeps nothing open
      amountOtherThan: fresh && !fresh.cancelledAt ? balanceOf(fresh) : undefined,
    });
    return isRetry ? page("failed", 503, invoice) : openPayLink(token, new Date(), true);
  }
  await expireOpen(gateway, { invoiceIds: [invoice.id], createdBefore: made.createdAt, now });

  /**
   * Whoever opened it is not known: the client, somebody they forwarded the link to, or a mail
   * scanner that fetches every link in a letter. So the actor is the link itself, never a person.
   * Only a NEW session is recorded; a later click that reuses it adds nothing.
   */
  record("invoice.pay_link_opened", {
    subjectId: invoice.id,
    subjectLabel: invoice.number,
    clientId: invoice.clientId,
    changes: { amount: balance },
    actor: { kind: "system", label: "Pay link" },
  });
  return { kind: "redirect", url: made.url };
}

// ── closing a session the balance has moved away from ───────────────────────

async function expireOne(gateway: StripeGateway, row: repo.OpenCheckout) {
  try {
    await gateway.expireCheckoutSession(row.sessionId);
  } catch (error) {
    // Left `open` on purpose: the next visit to the link, or the next change to the invoice, tries
    // again, and Stripe's own clock ends the session within 36 minutes of its making.
    const notOpen = isRejectedRequest(error)
      ? " Stripe says it is no longer open: if it was PAID, this invoice may now be paid twice " +
        "(check the payment in Stripe)."
      : "";
    console.error(
      `[stripe] session ${row.sessionId} of invoice ${row.invoiceId} could not be expired: ` +
        `${describeStripeError(error)}.${notOpen}`,
    );
    return;
  }
  try {
    await repo.markCheckoutExpired(row.id);
  } catch (error) {
    console.error(
      `[stripe] session ${row.sessionId} of invoice ${row.invoiceId} was expired in Stripe, ` +
        "but its row could not be marked",
      error,
    );
  }
}

/**
 * Close the open sessions on these invoices, in parallel, each failure logged on its own. Never
 * throws: every caller has already committed what it did.
 */
async function expireOpen(
  gateway: StripeGateway,
  where: { invoiceIds: string[]; now: Date; createdBefore?: Date; amountOtherThan?: number },
) {
  let rows: repo.OpenCheckout[];
  try {
    rows = await repo.findOpenCheckouts({ ...where, livemode: gateway.mode === "live" });
  } catch (error) {
    console.error(
      `[stripe] the open sessions of invoices ${where.invoiceIds.join(", ")} could not be read ` +
        "to close them",
      error,
    );
    return;
  }
  await Promise.allSettled(rows.map((row) => expireOne(gateway, row)));
}

/**
 * **A change to what an invoice owes closes its open session**: a cancel, a correction of the
 * amount, and any payment recorded, edited or deleted by hand. Otherwise a payer already on
 * Stripe's page would pay the old amount, and money more than the balance cannot be applied.
 *
 * Called by the service right AFTER its transaction returned, never inside one: it talks to
 * Stripe. It never throws, because the act that called it has committed and must not answer as
 * failed.
 */
export async function closeOpenCheckouts(invoiceIds: string[]): Promise<void> {
  const gateway = stripeGateway();
  if (!gateway || invoiceIds.length === 0) return;
  await expireOpen(gateway, { invoiceIds, now: new Date() });
}
