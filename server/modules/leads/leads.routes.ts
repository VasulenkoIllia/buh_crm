import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import { convertLeadInput, createLeadInput, updateLeadInput } from "@shared/schema/lead.js";
import { requireAuth } from "../../core/auth.js";
import * as service from "./leads.service.js";

const idParams = z.object({ id: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", requireAuth);

  app.get("/", async () => {
    return service.listLeads();
  });

  app.post("/", { schema: { body: createLeadInput } }, async (request, reply) => {
    const lead = await service.createLead(request.body);
    return reply.status(201).send(lead);
  });

  app.patch(
    "/:id",
    { schema: { params: idParams, body: updateLeadInput } },
    async (request) => {
      return service.updateLead(request.params.id, request.body);
    },
  );

  app.post("/:id/mark-lost", { schema: { params: idParams } }, async (request) => {
    return service.markLost(request.params.id);
  });

  app.post("/:id/reopen", { schema: { params: idParams } }, async (request) => {
    return service.reopen(request.params.id);
  });

  app.post(
    "/:id/convert",
    { schema: { params: idParams, body: convertLeadInput } },
    async (request) => {
      return service.convert(request.params.id, request.body);
    },
  );
}
