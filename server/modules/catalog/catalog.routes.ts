import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  createServiceInput,
  moveServiceInput,
  createTaskTemplateInput,
  updateServiceInput,
  updateTaskTemplateInput,
} from "@shared/schema/catalog.js";
import { gate, shared } from "../../core/access.js";
import * as service from "./catalog.service.js";

const idParams = z.object({ id: uuid });
const templateParams = z.object({ id: uuid, templateId: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // the whole team reads the catalog (dropdowns, chips); only admins change it
  app.get("/", { config: shared() }, async () => {
    return service.listServices();
  });

  app.post(
    "/",
    { config: gate("services"), schema: { body: createServiceInput } },
    async (request, reply) => {
      const created = await service.createService(request.body);
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/:id",
    { config: gate("services"), schema: { params: idParams, body: updateServiceInput } },
    async (request) => {
      return service.updateService(request.params.id, request.body);
    },
  );

  /**
   * Dragging a service into place. Its own route, and admin-only like the rest of the catalog:
   * the body carries an ANCHOR ("put me after this one"), which describes a position in a list
   * and not a property of the service.
   */
  app.patch(
    "/:id/position",
    { config: gate("services"), schema: { params: idParams, body: moveServiceInput } },
    async (request) => service.moveService(request.params.id, request.body),
  );

  app.delete(
    "/:id",
    { config: gate("services"), schema: { params: idParams } },
    async (request) => {
      return service.removeService(request.params.id);
    },
  );

  app.post(
    "/:id/tasks",
    { config: gate("services"), schema: { params: idParams, body: createTaskTemplateInput } },
    async (request, reply) => {
      const updated = await service.addTemplate(request.params.id, request.body);
      return reply.status(201).send(updated);
    },
  );

  app.patch(
    "/:id/tasks/:templateId",
    {
      config: gate("services"),
      schema: { params: templateParams, body: updateTaskTemplateInput },
    },
    async (request) => {
      return service.updateTemplate(request.params.id, request.params.templateId, request.body);
    },
  );

  app.delete(
    "/:id/tasks/:templateId",
    { config: gate("services"), schema: { params: templateParams } },
    async (request) => {
      return service.removeTemplate(request.params.id, request.params.templateId);
    },
  );
}
