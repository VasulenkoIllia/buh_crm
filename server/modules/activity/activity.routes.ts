import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { activityQuery, setActivityPolicyInput } from "@shared/schema/activity.js";
import { gate } from "../../core/access.js";
import * as service from "./activity.service.js";

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * **The log's own gate** (activity-log.md §12).
   *
   * Not `team`: that gate is `fixedAdmin` and has no states, so reading the log would have required
   * full admin and giving a lead their department's record would have meant giving them roles and
   * invitations with it. Seeded `closed` for `user`, so on the day this ships nothing anybody could
   * see yesterday becomes visible.
   */
  const activity = gate("activity");
  /** Changing what is RECORDED is a different act from reading what was. */
  const activityAdmin = gate("activity", { adminOnly: true });

  app.get(
    "/",
    { config: activity, schema: { querystring: activityQuery } },
    // the caller, not just their query: what they may READ is decided by their own gates (§12)
    async (request) => service.list(request.currentUser!, request.query),
  );

  app.get("/policies", { config: activity }, async () => service.policies());

  app.patch(
    "/policies/:action",
    {
      config: activityAdmin,
      schema: { params: z.object({ action: z.string().max(80) }), body: setActivityPolicyInput },
    },
    async (request) => service.setPolicy(request.params.action, request.body.enabled),
  );
}
