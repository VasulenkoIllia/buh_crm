import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import {
  verifyStripeEvent,
  type CheckoutSession,
  type CheckoutSessionRequest,
  type StripeGateway,
  type StripeMode,
} from "./stripe.js";

/**
 * The fake's webhook secret. Its signature is checked by the library's real code, so the suite
 * proves the check itself, not a stand-in for it.
 */
export const FAKE_WEBHOOK_SECRET = "whsec_fake_suite_secret";

/** The `Stripe-Signature` header Stripe would send for this body, signed now or at `timestamp`. */
export function signWebhook(
  payload: string,
  options: { secret?: string; timestamp?: number } = {},
): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: options.secret ?? FAKE_WEBHOOK_SECRET,
    ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
  });
}

/**
 * Stripe in memory: it answers the two calls the pay link makes, and remembers them.
 *
 * A create with an idempotency key it has seen returns the same session, as Stripe does, so two
 * clicks in one window can be shown to get one session. `failCreate` / `failExpire` make the next
 * calls throw, the way a network failure or a refusal would; `failCreateOnce` only the next one.
 * `whileCreating` runs once, while the next create is in flight: what somebody else does in the CRM
 * during the second Stripe takes to answer.
 */
export function fakeStripe(mode: StripeMode = "sandbox") {
  const created: CheckoutSessionRequest[] = [];
  const expired: string[] = [];
  const byKey = new Map<string, CheckoutSession>();
  const failures = { create: null as Error | null, expire: null as Error | null };
  let failOnce: Error | null = null;
  let meanwhile: (() => Promise<unknown>) | null = null;

  const gateway: StripeGateway = {
    mode,
    async createCheckoutSession(request) {
      if (failures.create) throw failures.create;
      const once = failOnce;
      failOnce = null;
      created.push(request);
      if (once) throw once;
      const during = meanwhile;
      meanwhile = null;
      await during?.();
      const known = byKey.get(request.idempotencyKey);
      if (known) return known;
      const id = `cs_${mode === "live" ? "live" : "test"}_${randomUUID().replaceAll("-", "")}`;
      const session = {
        id,
        url: `https://checkout.stripe.test/c/pay/${id}`,
        expiresAt: request.expiresAt,
        livemode: mode === "live",
      };
      byKey.set(request.idempotencyKey, session);
      return session;
    },
    async expireCheckoutSession(sessionId) {
      if (failures.expire) throw failures.expire;
      expired.push(sessionId);
    },
    verifyWebhook(payload, signature) {
      return verifyStripeEvent(payload, signature, FAKE_WEBHOOK_SECRET);
    },
  };

  return {
    gateway,
    created,
    expired,
    failCreate(error: Error | null) {
      failures.create = error;
    },
    failExpire(error: Error | null) {
      failures.expire = error;
    },
    failCreateOnce(error: Error) {
      failOnce = error;
    },
    whileCreating(act: () => Promise<unknown>) {
      meanwhile = act;
    },
  };
}
