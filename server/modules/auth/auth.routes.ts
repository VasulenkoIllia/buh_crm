import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  acceptInviteInput,
  forgotPasswordInput,
  loginInput,
  resetPasswordInput,
} from "@shared/schema/user.js";
import { createSession, destroySession } from "../../core/auth.js";
import { anonymous, own } from "../../core/access.js";
import { isTest } from "../../core/config.js";
import { toSessionUser } from "./auth.schema.js";
import * as service from "./auth.service.js";

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // stricter limit on credential endpoints
  const authLimit = { rateLimit: { max: isTest ? 1000 : 10, timeWindow: "1 minute" } };

  app.post("/login", { config: { ...authLimit, ...anonymous() }, schema: { body: loginInput } }, async (request, reply) => {
    const user = await service.login(request.body);
    await createSession(request, reply, user.id);
    return toSessionUser(user);
  });

  app.post("/logout", { config: anonymous() }, async (request, reply) => {
    await destroySession(request, reply);
    return { ok: true };
  });

  app.get("/me", { config: own() }, async (request) => {
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
