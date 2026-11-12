import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { anonymous } from "../../core/access.js";
import { firmName } from "../../core/firm.js";
import { payLinkPage } from "./pay-link.page.js";
import { openPayLink, payLinkReturn, PAY_PATH } from "./pay-link.service.js";

/**
 * Tighter than the app's 300 a minute per address. Each click that finds no open session asks
 * Stripe for one, and a person paying an invoice clicks a handful of times at most. Not raised under
 * test, so the suite can see it.
 */
const PAY_LINK_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

/** Checked in the service, so a mangled token answers the page and not a JSON error. */
const tokenParams = z.object({ token: z.string() });
/** Where Stripe sends the payer back. Forgiving: anything else is an ordinary click. */
const backQuery = z.object({ back: z.enum(["paid", "cancelled"]).optional().catch(undefined) });

/**
 * The payer gets a page whatever happens, never the API's JSON error: a failure of our own (the
 * database, say) is logged with the token's place in it masked, and answered "try again".
 */
async function answerFor(token: string, back: "paid" | "cancelled" | undefined) {
  try {
    return back ? await payLinkReturn(token, back) : await openPayLink(token);
  } catch (error) {
    console.error(`[pay-link] ${PAY_PATH}/… failed on our side`, error);
    return {
      kind: "page",
      page: "failed",
      status: 503,
      invoiceNumber: null,
      isSandbox: false,
    } as const;
  }
}

/**
 * **`GET /pay/:token`, the pay link** (payments.md §11): beside `/health` rather than under `/api`,
 * so the printed link is short.
 *
 * `anonymous()`, a security decision (permissions.md): the token is the credential, 43 random
 * characters, and the route only ever sends its holder to Stripe for the balance or says why not.
 * A plain GET answered with a 303 rather than a form posted to us: Helmet's `form-action 'self'`
 * would stop a form's redirect to Stripe.
 *
 * No HEAD twin: Fastify would answer a HEAD by running the handler, and a mail scanner sending one
 * would open a Checkout Session nobody asked for.
 */
export async function registerPayLinkRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    `${PAY_PATH}/:token`,
    {
      config: { ...anonymous(), rateLimit: PAY_LINK_RATE_LIMIT },
      exposeHeadRoute: false,
      schema: { params: tokenParams, querystring: backQuery },
    },
    async (request, reply) => {
      const { token } = request.params;
      const answer = await answerFor(token, request.query.back);
      // a cached redirect would send somebody to a session that has since closed
      reply.header("Cache-Control", "no-store");
      reply.header("X-Robots-Tag", "noindex");
      if (answer.kind === "redirect") return reply.redirect(answer.url, 303);
      reply.status(answer.status).type("text/html; charset=utf-8");
      return reply.send(
        payLinkPage({
          kind: answer.page,
          invoiceNumber: answer.invoiceNumber,
          firmName: firmName(),
          isSandbox: answer.isSandbox,
          // relative: the page is already on the link's own origin
          retryUrl: `${PAY_PATH}/${encodeURIComponent(token)}`,
        }),
      );
    },
  );
}
