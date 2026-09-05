import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import { setPreferenceInput, updatePolicyInput } from "@shared/schema/notification.js";
import { gate, own } from "../../core/access.js";
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
      config: own(),
    },
    async (request) => {
      return service.tray(request.currentUser!.id, request.query.limit);
    },
  );

  app.post(
    "/:id/read",
    { schema: { params: idParams }, config: own() },
    async (request) => {
      return service.dismiss(request.currentUser!.id, request.params.id);
    },
  );

  app.post("/read-all", { config: own() }, async (request) => {
    return service.dismissAll(request.currentUser!.id);
  });

  // ── the personal contour ───────────────────────────────────────────────────
  //
  // `own()`, not a gate: the tray and a person's own preferences are never switchable. An
  // admin-only Team gate that could also silence somebody's bell would be a rule about them
  // rather than about an area of the app.

  app.get("/preferences", { config: own() }, async (request) => {
    return service.myPreferences(request.currentUser!.id);
  });

  app.put(
    "/preferences",
    { schema: { body: setPreferenceInput }, config: own() },
    async (request) => {
      return service.setMyPreferences(request.currentUser!.id, request.body);
    },
  );

  // ── the global contour: the `notification_rules` gate ──────────────────────
  //
  // The firm-wide policy — which triggers fire and who they reach. Admin-only until 2026-09-07,
  // and the seeded policy (`closed` for `user`) reproduces that exactly; from here it is a switch
  // the firm can open rather than a rule buried in this file.

  app.get("/policies", { config: gate("notification_rules") }, async () => {
    return service.policies();
  });

  app.patch(
    "/policies/:trigger",
    { schema: { params: triggerParams, body: updatePolicyInput }, config: gate("notification_rules") },
    async (request) => {
      return service.updatePolicy(request.params.trigger, request.body);
    },
  );
}
