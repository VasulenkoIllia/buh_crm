import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  confirmTwoFactorInput,
  disableTwoFactorInput,
  passwordConfirmInput,
  setTwoFactorPolicyInput,
} from "@shared/schema/two-factor.js";
import { createSession, destroyAllUserSessions } from "../../core/auth.js";
import { gate, own } from "../../core/access.js";
import { clientIp } from "../../core/client-ip.js";
import { isTest } from "../../core/config.js";
import * as service from "./two-factor.service.js";

const idParams = z.object({ id: uuid });

/** Where an attempt came from — for the counters and the letters (`clientIp`, never `request.ip`). */
function origin(request: FastifyRequest) {
  return { ip: clientIp(request), userAgent: request.headers["user-agent"] ?? null };
}

/**
 * Two-factor sign-in (docs/modules/two-factor.md §13). No gate of its own: the person's own second
 * factor is `own()` — no route here names anybody but the caller — and the firm's view of it is
 * the Team gate's. The second step of signing in lives with the other credential routes in `auth`.
 *
 * The three routes a person needs to ENROL answer them even while the firm's rule is holding them
 * back (`beforeTwoFactor`, §6.4); nothing else here does, and nothing else in the product.
 */
export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // the routes that re-ask for a password are held as tight as the sign-in route itself
  const stepUpLimit = { rateLimit: { max: isTest ? 1000 : 10, timeWindow: "1 minute" } };
  const enrolment = own({ beforeTwoFactor: true });

  // ── the caller's own second factor ─────────────────────────────────────────

  app.get("/me", { config: enrolment }, async (request) =>
    service.statusFor(request.currentUser!),
  );

  app.post(
    "/me/setup",
    { config: { ...stepUpLimit, ...enrolment }, schema: { body: passwordConfirmInput } },
    async (request) =>
      service.beginSetup(request.currentUser!, request.body.password, origin(request)),
  );

  app.post(
    "/me/confirm",
    { config: { ...stepUpLimit, ...enrolment }, schema: { body: confirmTwoFactorInput } },
    async (request, reply) => {
      const recoveryCodes = await service.confirmSetup(request.currentUser!, request.body.code);
      // every other session ends and this one is re-issued — the move a password change makes, and
      // for the same reason: whoever already held a session must not keep it through the very act
      // meant to shut them out (§6.1)
      await destroyAllUserSessions(request.currentUser!.id);
      await createSession(request, reply, request.currentUser!.id);
      return { recoveryCodes };
    },
  );

  app.post(
    "/me/recovery-codes",
    { config: { ...stepUpLimit, ...own() }, schema: { body: passwordConfirmInput } },
    async (request) => ({
      recoveryCodes: await service.regenerateRecoveryCodes(
        request.currentUser!,
        request.body.password,
        origin(request),
      ),
    }),
  );

  app.post(
    "/me/disable",
    { config: { ...stepUpLimit, ...own() }, schema: { body: disableTwoFactorInput } },
    async (request, reply) => {
      await service.disable(
        request.currentUser!,
        request.body.password,
        request.body.code,
        origin(request),
      );
      await destroyAllUserSessions(request.currentUser!.id);
      await createSession(request, reply, request.currentUser!.id);
      return service.statusFor(request.currentUser!);
    },
  );

  // ── the firm's view: who has it, the rule, and an admin's reset ────────────

  app.get("/team", { config: gate("team") }, async () => service.teamOverview());

  app.put(
    "/policy",
    { config: gate("team"), schema: { body: setTwoFactorPolicyInput } },
    async (request) => service.setPolicy(request.body.policy),
  );

  app.post(
    "/users/:id/reset",
    {
      config: { ...stepUpLimit, ...gate("team") },
      schema: { params: idParams, body: passwordConfirmInput },
    },
    async (request) => {
      await service.adminReset(
        request.currentUser!,
        request.params.id,
        request.body.password,
        origin(request),
      );
      return service.teamOverview();
    },
  );
}
