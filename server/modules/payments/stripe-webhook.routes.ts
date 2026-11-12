import type { FastifyInstance, FastifyReply } from "fastify";
import { anonymous } from "../../core/access.js";
import { setActivityActor } from "../../core/activity.js";
import { clientIp } from "../../core/client-ip.js";
import { STRIPE_ACTOR } from "./stripe-webhook.notices.js";
import { handleStripeEvent, type StripeEventAnswer } from "./stripe-webhook.service.js";
import { isSignatureError, stripeGateway, type StripeWebhookEvent } from "./stripe.js";

/** Stripe's events are a few kilobytes; a body this size is not one of them. */
const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

const STRIPE_SIGNATURE_HEADER = "stripe-signature";

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** Our own failure: a 500 whatever it was, so Stripe tries again later. */
const failed = (reply: FastifyReply) =>
  reply.status(500).send({ error: { code: "internal_error", message: "Not processed" } });

/**
 * **`POST /api/stripe/webhook`** (payments.md §11, stage B): Stripe tells the CRM about a payment.
 *
 * `anonymous()`, a security decision (permissions.md): Stripe has no session. The request is
 * authenticated by Stripe's signature over its raw bytes with the endpoint's signing secret, checked
 * before anything in it is read. So the route lives in a `register()` scope of its own whose JSON
 * parser keeps the bytes, as the unsubscribe routes keep theirs, and nothing else in the app loses
 * its parser.
 *
 * Answers: 400 for a request that is not Stripe's (no header, a wrong or stale signature), with no
 * `StripeEvent` written, a line in the server log, and the request's bare activity row, failed,
 * which is what an audit log is read for; 404 while Stripe is not configured; 200 once the event is
 * handled or knowingly ignored, a repeat included; 503 for a dispute that came before the payment it
 * disputes (`UNKNOWN_DISPUTE_RETRY_MS`), logged, so Stripe delivers it again once the payment is in;
 * 500 for a failure of our own, always a 500 and
 * logged with the event's id, so Stripe delivers it again (the app's error handler would turn a
 * database refusal into a 409 or a 400 and log nothing). No Origin check opt-out: Stripe sends no
 * Origin, and a request that carries one is not Stripe's.
 */
export async function registerStripeWebhookRoutes(instance: FastifyInstance) {
  await instance.register(
    async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
        (_request, body, done) => done(null, body),
      );

      scope.post(
        "/webhook",
        { config: anonymous(), bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
        async (request, reply) => {
          const gateway = stripeGateway();
          const signature = request.headers[STRIPE_SIGNATURE_HEADER];
          if (!gateway) {
            // a signed request here is Stripe's: an endpoint left on while the keys are gone
            if (signature) {
              console.error("[stripe] a signed webhook arrived while online payments are off");
            }
            return reply
              .status(404)
              .send({ error: { code: "not_found", message: "Online payments are off" } });
          }
          if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
            console.error(
              `[stripe] webhook without a signature or a JSON body, from ${clientIp(request)}`,
            );
            return reply
              .status(400)
              .send({ error: { code: "bad_signature", message: "Not signed" } });
          }

          let event: StripeWebhookEvent;
          try {
            event = gateway.verifyWebhook(request.body, signature);
          } catch (error) {
            if (!isSignatureError(error)) {
              // signed, so Stripe's, and not a shape we can read: retried, and fixed in stripe.ts
              console.error(`[stripe] a signed webhook could not be read: ${firstLine(error)}`);
              return failed(reply);
            }
            // the library's first line says what failed (no match, too old), never the secret;
            // a wrong `whsec_` in .env shows here, one line per delivery
            console.error(
              `[stripe] webhook signature refused, from ${clientIp(request)}: ${firstLine(error)}`,
            );
            return reply
              .status(400)
              .send({ error: { code: "bad_signature", message: "Signature not valid" } });
          }

          // from here on the request is Stripe's, and its tier-1 row says so
          setActivityActor(STRIPE_ACTOR);
          let answer: StripeEventAnswer;
          try {
            answer = await handleStripeEvent(event, gateway.mode);
          } catch (error) {
            console.error(
              `[stripe] event ${event.id} (${event.type}) failed; Stripe will deliver it again`,
              error,
            );
            return failed(reply);
          }
          if (answer === "too_early") {
            // logged by the service, which knows the payment it waits for
            return reply
              .status(503)
              .send({ error: { code: "too_early", message: "Not processed yet" } });
          }
          return reply.status(200).send({ received: true });
        },
      );
    },
    { prefix: "/api/stripe" },
  );
}
