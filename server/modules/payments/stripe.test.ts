import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  checkoutSessionParams,
  describeStripeError,
  isLastingStripeError,
  isRejectedRequest,
  modeOfKey,
  stripeErrorParam,
} from "./stripe.js";

/** What Stripe is asked for (payments.md §11), checked without a network. */

const request = {
  invoiceId: "4f3c1a52-0d55-4a3e-9d1e-9b7d0c2f6a10",
  invoiceNumber: "INV-2026-0123",
  amount: 12550,
  customerEmail: "olena@client.test",
  successUrl: "https://crm.example.test/pay/tok?back=paid",
  cancelUrl: "https://crm.example.test/pay/tok?back=cancelled",
  expiresAt: new Date("2026-11-12T15:36:00.000Z"),
  idempotencyKey: "crm-pay-abc",
};

describe("a Checkout Session's request", () => {
  it("is one card payment of the balance, named after the invoice", () => {
    const params = checkoutSessionParams(request);
    expect(params).toMatchObject({
      mode: "payment",
      allowed_payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 12550,
            product_data: { name: "Invoice INV-2026-0123" },
          },
        },
      ],
      customer_email: "olena@client.test",
      expires_at: Date.parse("2026-11-12T15:36:00.000Z") / 1000,
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
    });
  });

  it("carries the invoice on the session and on the PaymentIntent, for a refund to find", () => {
    const params = checkoutSessionParams(request);
    const metadata = { invoiceId: request.invoiceId, invoiceNumber: "INV-2026-0123" };
    expect(params.client_reference_id).toBe(request.invoiceId);
    expect(params.metadata).toEqual(metadata);
    expect(params.payment_intent_data?.metadata).toEqual(metadata);
  });

  it("leaves the email to the payer when the invoice has none", () => {
    expect(checkoutSessionParams({ ...request, customerEmail: null })).not.toHaveProperty(
      "customer_email",
    );
  });
});

describe("the key", () => {
  it("decides the mode", () => {
    expect(modeOfKey("rk_live_abc")).toBe("live");
    expect(modeOfKey("sk_live_abc")).toBe("live");
    expect(modeOfKey("rk_test_abc")).toBe("sandbox");
  });

  it("never reaches the log when a call fails", () => {
    const error = new Stripe.errors.StripeAuthenticationError({
      message: "Invalid API Key provided: rk_test_****abcd",
      type: "invalid_request_error",
      statusCode: 401,
      requestId: "req_123",
    } as never);
    const said = describeStripeError(error);
    expect(said).toContain("HTTP 401");
    expect(said).toContain("request req_123");
    expect(said).not.toMatch(/rk_test_[A-Za-z0-9]{6,}/);
  });
});

describe("a failed call", () => {
  const refused = (statusCode: number, param?: string) =>
    new Stripe.errors.StripeInvalidRequestError({
      message: "refused",
      type: "invalid_request_error",
      statusCode,
      param,
    } as never);
  const network = new Stripe.errors.StripeConnectionError({ message: "ETIMEDOUT" } as never);

  it("tells a refusal Stripe will repeat from one a later try can pass", () => {
    expect(isLastingStripeError(refused(400))).toBe(true);
    expect(isLastingStripeError(refused(403))).toBe(true);
    expect(isLastingStripeError(refused(409))).toBe(false);
    expect(isLastingStripeError(network)).toBe(false);
    // our own check of Stripe's answer: trying again gets the same answer
    expect(isLastingStripeError(new Error("no usable URL"))).toBe(true);
  });

  it("calls only a 400 or a 404 a rejected request, never a refused key", () => {
    expect(isRejectedRequest(refused(400))).toBe(true);
    expect(isRejectedRequest(refused(404))).toBe(true);
    expect(isRejectedRequest(refused(401))).toBe(false);
    expect(isRejectedRequest(refused(403))).toBe(false);
    expect(isRejectedRequest(network)).toBe(false);
  });

  it("names the field Stripe refused", () => {
    expect(stripeErrorParam(refused(400, "customer_email"))).toBe("customer_email");
    expect(stripeErrorParam(network)).toBeNull();
  });
});
