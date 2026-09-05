import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  convertLeadInput,
  createLeadInput,
  createLeadStageInput,
  leadListQuery,
  moveLeadInput,
  moveLeadStageInput,
  updateLeadInput,
  updateLeadStageInput,
} from "@shared/schema/lead.js";
import { gate, shared } from "../../core/access.js";
import * as service from "./leads.service.js";

const idParams = z.object({ id: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * The module-level `preHandler: requireAuth` is gone — each route declares its own gate and the
   * hook in `core/access.ts` enforces it. The list and the single lead stay `shared()`: the Tasks
   * board, the Calendar's meeting form and the Archive all read lead names, and gating them would
   * blank three screens that are open.
   */
  const leads = gate("leads");
  /**
   * Shaping the pipeline is admin-only, and no gate state can say that: `leads` has to stay open
   * for the people who work it. Three states govern SCREENS; this is a per-ACTION rule, which is
   * stage 2 — carried here so the one hook still decides everything, and so it becomes a row with
   * a real `action` value rather than a rewrite when that day comes.
   */
  const pipeline = gate("leads", { adminOnly: true });

  app.get("/", { config: shared(), schema: { querystring: leadListQuery } }, async (request) => {
    return service.listLeads(request.query);
  });

  /**
   * The pipeline's own columns. Before `/:id`, or Fastify would read "stages" as a lead id.
   * Reading is for everyone; changing the board's shape is admin-only, like the task columns.
   */
  app.get("/stages", { config: leads }, async () => service.listStages());

  app.post(
    "/stages",
    { config: pipeline, schema: { body: createLeadStageInput } },
    async (request, reply) => reply.status(201).send(await service.addStage(request.body)),
  );

  app.patch(
    "/stages/:id",
    { config: pipeline, schema: { params: idParams, body: updateLeadStageInput } },
    async (request) => service.renameStage(request.params.id, request.body),
  );

  app.patch(
    "/stages/:id/position",
    { config: pipeline, schema: { params: idParams, body: moveLeadStageInput } },
    async (request) => service.moveStage(request.params.id, request.body),
  );

  app.delete(
    "/stages/:id",
    { config: pipeline, schema: { params: idParams } },
    async (request) => service.removeStage(request.params.id),
  );

  app.get("/:id", { config: shared(), schema: { params: idParams } }, async (request) =>
    service.getLead(request.params.id),
  );

  app.post("/", { config: leads, schema: { body: createLeadInput } }, async (request, reply) => {
    const lead = await service.createLead(request.body);
    return reply.status(201).send(lead);
  });

  app.patch(
    "/:id",
    { config: leads, schema: { params: idParams, body: updateLeadInput } },
    async (request) => {
      return service.updateLead(request.params.id, request.body);
    },
  );

  /** dragging on the board: a stage AND a neighbour, which an edit does not carry */
  app.patch(
    "/:id/position",
    { config: leads, schema: { params: idParams, body: moveLeadInput } },
    async (request) => {
      return service.moveLead(request.params.id, request.body);
    },
  );

  app.post("/:id/archive", { config: leads, schema: { params: idParams } }, async (request) => {
    return service.archiveLead(request.params.id, request.currentUser!);
  });

  app.post("/:id/restore", { config: leads, schema: { params: idParams } }, async (request) => {
    return service.restoreLead(request.params.id);
  });

  app.post("/:id/mark-lost", { config: leads, schema: { params: idParams } }, async (request) => {
    return service.markLost(request.params.id);
  });

  app.post("/:id/reopen", { config: leads, schema: { params: idParams } }, async (request) => {
    return service.reopen(request.params.id);
  });

  app.post(
    "/:id/convert",
    { config: leads, schema: { params: idParams, body: convertLeadInput } },
    async (request) => {
      return service.convert(request.params.id, request.body);
    },
  );
}
