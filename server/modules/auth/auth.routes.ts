import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  acceptInviteInput,
  forgotPasswordInput,
  loginInput,
  resetPasswordInput,
} from "@shared/schema/user.js";
import {
  loginSecondFactorInput,
  type TwoFactorChallengeResult,
} from "@shared/schema/two-factor.js";
import { createSession, destroySession } from "../../core/auth.js";
import { anonymous, own } from "../../core/access.js";
import { clientIp } from "../../core/client-ip.js";
import { isTest } from "../../core/config.js";
import { completeSignIn } from "../two-factor/index.js";
import { toSessionUser } from "./auth.schema.js";
import * as service from "./auth.service.js";

/** Where an attempt came from — `clientIp`, never `request.ip`, which is Cloudflare's edge. */
function origin(request: FastifyRequest) {
  return { ip: clientIp(request), userAgent: request.headers["user-agent"] ?? null };
}

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // stricter limit on credential endpoints
  const authLimit = { rateLimit: { max: isTest ? 1000 : 10, timeWindow: "1 minute" } };

  app.post(
    "/login",
    { config: { ...authLimit, ...anonymous() }, schema: { body: loginInput } },
    async (request, reply) => {
      // per-ACCOUNT counters live in the service (two-factor.md §9); the limit above only ever
      // sees the network address, because it runs before the body is parsed
      const outcome = await service.login(request.body, origin(request));
      if (outcome.kind === "second_factor") {
        // no session yet: the code is owed first (two-factor.md §5.1)
        const owed: TwoFactorChallengeResult = {
          twoFactorRequired: true,
          challenge: outcome.challenge,
        };
        return owed;
      }
      await createSession(request, reply, outcome.user.id);
      return toSessionUser(outcome.user);
    },
  );

  /**
   * **The ninth anonymous route — decided, not merely added** (two-factor.md §5.4).
   *
   * Nobody is signed in at this moment, so it cannot be anything else. What keeps it from being a
   * door of its own: it takes only an opaque challenge — issued by step one after the password and
   * the account's status were checked, five minutes old at most, five tries — and a code; it is
   * limited here by address and counted in the service per account.
   */
  app.post(
    "/login/2fa",
    { config: { ...authLimit, ...anonymous() }, schema: { body: loginSecondFactorInput } },
    async (request, reply) => {
      const user = await completeSignIn(request.body, origin(request));
      await createSession(request, reply, user.id);
      return toSessionUser(user);
    },
  );

  app.post("/logout", { config: anonymous() }, async (request, reply) => {
    await destroySession(request, reply);
    return { ok: true };
  });

  // who am I — answered even while the firm's two-factor rule holds somebody back, because it is
  // what tells the screen to send them to enrolment (two-factor.md §6.4)
  app.get("/me", { config: own({ beforeTwoFactor: true }) }, async (request) => {
    return toSessionUser(request.currentUser!);
  });

  app.post(
    "/accept-invite",
    { config: { ...authLimit, ...anonymous() }, schema: { body: acceptInviteInput } },
    async (request, reply) => {
      const user = await service.acceptInvite(request.body);
      await createSession(request, reply, user.id); // auto-login after activation
      return toSessionUser(user);
    },
  );

  app.post(
    "/forgot-password",
    { config: { ...authLimit, ...anonymous() }, schema: { body: forgotPasswordInput } },
    async (request) => {
      await service.requestPasswordReset(request.body.email);
      return { ok: true };
    },
  );

  app.post(
    "/reset-password",
    { config: { ...authLimit, ...anonymous() }, schema: { body: resetPasswordInput } },
    async (request) => {
      await service.resetPassword(request.body);
      return { ok: true };
    },
  );
}
