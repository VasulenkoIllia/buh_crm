import Stripe from "stripe";
import { config, isTest } from "../../core/config.js";

/**
 * **The one place this app talks to Stripe** (payments.md §11).
 *
 * Two calls, and the restricted key on the server allows exactly these: create a Checkout Session
 * and expire one (Checkout Sessions: Write). Everything else Stripe has to say arrives in the
 * webhook's payload (stage B), so nothing here reads.
 *
 * The rest of the app sees a `StripeGateway`, never the library, so the suite runs a fake with no
 * network and the real one stays these few lines.
 */

/**
 * The API version this code was written against, pinned rather than left to the account's default:
 * Stripe's answers change shape between versions. The literal is the library's own pin, so a
 * library upgrade that moves it fails the typecheck here instead of changing what Stripe returns.
 */
const STRIPE_API_VERSION = "2026-09-30.endive";

/**
 * Below the library's default of 80 s. A person is waiting on the pay link's redirect, and a cancel
 * or a payment is waiting on the expire after its commit.
 */
const STRIPE_TIMEOUT_MS = 10_000;

/**
 * One retry, with backoff, of what the library judges retryable: a connection failure, or an answer
 * Stripe itself marks as safe to repeat. A create carries our own idempotency key, so a retry
 * returns the session the first attempt made rather than a second one.
 */
const STRIPE_NETWORK_RETRIES = 1;

/**
 * Stripe's smallest card charge in US dollars, in cents. A balance below it cannot go through
 * Checkout at all, so the link is not offered for it.
 */
export const STRIPE_MIN_AMOUNT = 50;

/** `sandbox` while the key is a test one; the mode is read off the key, never set apart from it. */
export type StripeMode = "sandbox" | "live";

export interface CheckoutSessionRequest {
  invoiceId: string;
  invoiceNumber: string;
  /** minor units, the balance at the moment of the click */
  amount: number;
  /** prefilled on Stripe's page; null leaves the field to the payer */
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  idempotencyKey: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: Date;
  livemode: boolean;
}

export interface StripeGateway {
  mode: StripeMode;
  createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSession>;
  expireCheckoutSession(sessionId: string): Promise<void>;
}

export function modeOfKey(key: string): StripeMode {
  return key.includes("_live_") ? "live" : "sandbox";
}

/**
 * What Stripe is asked for, pure so the contract is tested without a network.
 *
 * - **Cards only.** `allowed_payment_method_types` filters what the account offers, so switching
 *   ACH on in the Dashboard changes nothing until the code handles a bank's delayed answer
 *   (owner, 2026-11-12). This API version has no `payment_method_types` on create any more.
 * - **The invoice id twice**: on the session for `checkout.session.completed`, and on the
 *   PaymentIntent, so a refund or a dispute, which only knows the charge, finds its way back.
 * - **`usd`**: the firm's currency is the literal USD (`shared/schema/settings.ts`), and the
 *   amount is already integer cents, which is Stripe's `unit_amount`.
 */
export function checkoutSessionParams(
  request: CheckoutSessionRequest,
): Stripe.Checkout.SessionCreateParams {
  const metadata = { invoiceId: request.invoiceId, invoiceNumber: request.invoiceNumber };
  return {
    mode: "payment",
    allowed_payment_method_types: ["card"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: request.amount,
          product_data: { name: `Invoice ${request.invoiceNumber}` },
        },
      },
    ],
    client_reference_id: request.invoiceId,
    metadata,
    payment_intent_data: { metadata },
    ...(request.customerEmail ? { customer_email: request.customerEmail } : {}),
    expires_at: Math.floor(request.expiresAt.getTime() / 1000),
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
  };
}

function stripeGatewayFor(key: string): StripeGateway {
  const stripe = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: STRIPE_NETWORK_RETRIES,
    // latency figures about our own calls are Stripe's business, not something we owe them
    telemetry: false,
  });
  return {
    mode: modeOfKey(key),
    async createCheckoutSession(request) {
      const session = await stripe.checkout.sessions.create(checkoutSessionParams(request), {
        idempotencyKey: request.idempotencyKey,
      });
      // a hosted session always has both; anything else is not a page we can send somebody to
      if (!session.url?.startsWith("https://") || !Number.isFinite(session.expires_at)) {
        throw new Error(`Stripe returned session ${session.id} with no usable URL or expiry`);
      }
      return {
        id: session.id,
        url: session.url,
        expiresAt: new Date(session.expires_at * 1000),
        livemode: session.livemode,
      };
    },
    async expireCheckoutSession(sessionId) {
      await stripe.checkout.sessions.expire(sessionId);
    },
  };
}

/**
 * What a failed call says in the server's log: Stripe's own classification and its request id,
 * which is what their support asks for. Never the key, never the request's body.
 */
export function describeStripeError(error: unknown): string {
  if (error instanceof Stripe.errors.StripeError) {
    return [
      error.type,
      error.code,
      error.statusCode ? `HTTP ${error.statusCode}` : null,
      error.requestId ? `request ${error.requestId}` : null,
      error.message,
      // a connection failure's own cause (ETIMEDOUT, ENOTFOUND) is what tells the network apart
      error.detail instanceof Error ? error.detail.message : null,
    ]
      .filter(Boolean)
      .join(", ");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * A refusal Stripe will give again for the same request: a bad key, missing permission, a request
 * it rejects (400, 404). Not the network, a rate limit or Stripe's own failure, which a later try
 * can get past. Anything that is not Stripe's (our own check of its answer) counts as lasting.
 */
export function isLastingStripeError(error: unknown): boolean {
  if (!(error instanceof Stripe.errors.StripeError)) return true;
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return false;
  }
  const status = error.statusCode ?? 0;
  return status >= 400 && status < 500 && status !== 409 && status !== 429;
}

/**
 * Stripe read the request and said no to it (400, 404): for an expire, the session is no longer
 * open, most likely because it was just paid. Not a bad key or missing permission (401, 403).
 */
export function isRejectedRequest(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeError &&
    (error.statusCode === 400 || error.statusCode === 404)
  );
}

/** The request field Stripe named in its refusal, e.g. `customer_email`. */
export function stripeErrorParam(error: unknown): string | null {
  return error instanceof Stripe.errors.StripeError ? (error.param ?? null) : null;
}

let fromEnv: StripeGateway | null | undefined;
let forTests: StripeGateway | null | undefined;

/** Stripe, or `null` while the firm has not configured it, which switches every part of it off. */
export function stripeGateway(): StripeGateway | null {
  if (forTests !== undefined) return forTests;
  if (fromEnv === undefined) {
    fromEnv = config.STRIPE_SECRET_KEY ? stripeGatewayFor(config.STRIPE_SECRET_KEY) : null;
  }
  return fromEnv;
}

/** The suite's seam: a fake in Stripe's place, `null` for off, `undefined` for what `.env` says. */
export function setStripeGatewayForTests(gateway: StripeGateway | null | undefined) {
  if (!isTest) throw new Error("setStripeGatewayForTests is for the test suite only");
  forTests = gateway;
}
