import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./two-factor.routes.js";

/**
 * What `auth` needs to sign somebody in with a second factor, and to tidy up after it. Nothing else
 * reaches into this module; the pieces other callers — the client portal among them — will share
 * are in core (docs/modules/two-factor.md §4.2).
 */
export { completeSignIn, deleteStaleChallenges, startChallenge } from "./two-factor.service.js";

export async function twoFactorModule(app: FastifyInstance) {
  await registerRoutes(app);
}
