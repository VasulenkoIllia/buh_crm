import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import { campaignInput, setCampaignActiveInput } from "@shared/schema/campaigns.js";
import { gate } from "../../core/access.js";
import * as service from "./campaigns.service.js";

const idParams = z.object({ id: uuid });

/**
 * Campaigns live under `/api/mailouts/campaigns` rather than at their own root: a campaign is a
 * planned mailout, it shares the module's templates, mailboxes and consent, and giving it a
 * separate top-level namespace would imply a separateness it does not have.
 */
export async function registerCampaignRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get("/campaigns", { config: gate("mailouts") }, async () => service.list());

  app.get(
    "/campaigns/:id",
    { config: gate("mailouts"), schema: { params: idParams } },
    async (request) => service.detail(request.params.id),
  );

  app.post(
    "/campaigns",
    { config: gate("mailouts"), schema: { body: campaignInput } },
    async (request, reply) =>
      reply.status(201).send(await service.create(request.currentUser!, request.body)),
  );

  app.put(
    "/campaigns/:id",
    { config: gate("mailouts"), schema: { params: idParams, body: campaignInput } },
    async (request) => service.update(request.params.id, request.body),
  );

  /** Stop a campaign, or start a stopped one again. */
  app.post(
    "/campaigns/:id/active",
    { config: gate("mailouts"), schema: { params: idParams, body: setCampaignActiveInput } },
    async (request) => service.setActive(request.params.id, request.body.active),
  );

  app.delete(
    "/campaigns/:id",
    { config: gate("mailouts"), schema: { params: idParams } },
    async (request, reply) => {
      await service.remove(request.params.id);
      return reply.status(204).send();
    },
  );
}
