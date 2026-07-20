import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  createServiceInput,
  createTaskTemplateInput,
  updateServiceInput,
  updateTaskTemplateInput,
} from "@shared/schema/catalog.js";
import { requireAdmin, requireAuth } from "../../core/auth.js";
import * as service from "./catalog.service.js";

const idParams = z.object({ id: uuid });
const templateParams = z.object({ id: uuid, templateId: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // the whole team reads the catalog (dropdowns, chips); only admins change it
  app.get("/", { preHandler: requireAuth }, async () => {
    return service.listServices();
  });

  app.post(
    "/",
    { preHandler: requireAdmin, schema: { body: createServiceInput } },
    async (request, reply) => {
      const created = await service.createService(request.body);
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/:id",
    { preHandler: requireAdmin, schema: { params: idParams, body: updateServiceInput } },
    async (request) => {
      return service.updateService(request.params.id, request.body);
    },
  );

  app.post(
    "/:id/tasks",
    { preHandler: requireAdmin, schema: { params: idParams, body: createTaskTemplateInput } },
    async (request, reply) => {
      const updated = await service.addTemplate(request.params.id, request.body);
      return reply.status(201).send(updated);
    },
  );

  app.patch(
    "/:id/tasks/:templateId",
    {
      preHandler: requireAdmin,
      schema: { params: templateParams, body: updateTaskTemplateInput },
    },
    async (request) => {
      return service.updateTemplate(request.params.id, request.params.templateId, request.body);
    },
  );

  app.delete(
    "/:id/tasks/:templateId",
    { preHandler: requireAdmin, schema: { params: templateParams } },
    async (request) => {
      return service.removeTemplate(request.params.id, request.params.templateId);
    },
  );
}
