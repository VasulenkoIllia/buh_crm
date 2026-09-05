import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import { setPreferenceInput, updatePolicyInput } from "@shared/schema/notification.js";
import { requireAdmin, requireAuth } from "../../core/auth.js";
import * as service from "./notifications.service.js";

const idParams = z.object({ id: uuid });
const triggerParams = z.object({ trigger: z.string().min(1) });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // ── the tray: always the signed-in user's own, never anyone else's ──────────
  //
  // There is no `userId` anywhere in this half of the API, by design: a notification is addressed
  // to a person, and an endpoint that could name one would be an endpoint that could read theirs.
  // `limit` is the tray's "Show more": 20 by default, and the service clamps it to 100 so a
  // hand-written query string cannot ask for the whole table.
  app.get(
    "/",
    {
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
      },
      preHandler: requireAuth,
    },
    async (request) => {
      return service.tray(request.currentUser!.id, request.query.limit);
    },
  );

  app.post(
    "/:id/read",
    { schema: { params: idParams }, preHandler: requireAuth },
    async (request) => {
      return service.dismiss(request.currentUser!.id, request.params.id);
    },
  );

  app.post("/read-all", { preHandler: requireAuth }, async (request) => {
    return service.dismissAll(request.currentUser!.id);
  });

  // ── the personal contour ───────────────────────────────────────────────────

  app.get("/preferences", { preHandler: requireAuth }, async (request) => {
    return service.myPreferences(request.currentUser!.id);
  });

  app.put(
    "/preferences",
    { schema: { body: setPreferenceInput }, preHandler: requireAuth },
    async (request) => {
      return service.setMyPreferences(request.currentUser!.id, request.body);
    },
  );

  // ── the global contour (admin) ─────────────────────────────────────────────

  app.get("/policies", { preHandler: requireAdmin }, async () => {
    return service.policies();
  });

  app.patch(
    "/policies/:trigger",
    { schema: { params: triggerParams, body: updatePolicyInput }, preHandler: requireAdmin },
    async (request) => {
      return service.updatePolicy(request.params.trigger, request.body);
    },
  );
}
