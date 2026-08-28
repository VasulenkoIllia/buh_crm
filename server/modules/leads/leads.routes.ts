import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  convertLeadInput,
  createLeadInput,
  leadListQuery,
  moveLeadInput,
  updateLeadInput,
} from "@shared/schema/lead.js";
import { requireAuth } from "../../core/auth.js";
import * as service from "./leads.service.js";

const idParams = z.object({ id: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", requireAuth);

  app.get("/", { schema: { querystring: leadListQuery } }, async (request) => {
    return service.listLeads(request.query);
  });

  app.get("/:id", { schema: { params: idParams } }, async (request) =>
    service.getLead(request.params.id),
  );

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

  /** dragging on the board: a stage AND a neighbour, which an edit does not carry */
  app.patch(
    "/:id/position",
    { schema: { params: idParams, body: moveLeadInput } },
    async (request) => {
      return service.moveLead(request.params.id, request.body);
    },
  );

  app.post("/:id/archive", { schema: { params: idParams } }, async (request) => {
    return service.archiveLead(request.params.id, request.currentUser!);
  });

  app.post("/:id/restore", { schema: { params: idParams } }, async (request) => {
    return service.restoreLead(request.params.id);
  });

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
