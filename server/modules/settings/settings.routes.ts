import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  createSourceInput,
  updateFirmInput,
  updatePriorityInput,
  updateSourceInput,
} from "@shared/schema/settings.js";
import { requireAdmin, requireAuth } from "../../core/auth.js";
import { ValidationError } from "../../core/errors.js";
import { readFileStream } from "../../core/files.js";
import * as service from "./settings.service.js";

const idParams = z.object({ id: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // everyone (forms elsewhere read priorities/sources/firm from here)
  app.get("/", { preHandler: requireAuth }, async () => {
    return service.getSettings();
  });

  app.get("/firm/logo", { preHandler: requireAuth }, async (_request, reply) => {
    const file = await service.getLogoFile();
    reply.header("Content-Type", file.mime);
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(readFileStream(file.path));
  });

  // ── admin-only mutations ──────────────────────────────────────────────────

  app.patch(
    "/priorities/:id",
    { preHandler: requireAdmin, schema: { params: idParams, body: updatePriorityInput } },
    async (request) => {
      return service.updatePriority(request.params.id, request.body);
    },
  );

  app.post(
    "/sources",
    { preHandler: requireAdmin, schema: { body: createSourceInput } },
    async (request, reply) => {
      const source = await service.createSource(request.body);
      return reply.status(201).send(source);
    },
  );

  app.patch(
    "/sources/:id",
    { preHandler: requireAdmin, schema: { params: idParams, body: updateSourceInput } },
    async (request) => {
      return service.updateSource(request.params.id, request.body);
    },
  );

  app.patch(
    "/firm",
    { preHandler: requireAdmin, schema: { body: updateFirmInput } },
    async (request) => {
      return service.updateFirm(request.body);
    },
  );

  app.put("/firm/logo", { preHandler: requireAdmin }, async (request) => {
    const part = await request.file();
    if (!part) throw new ValidationError("Logo file is required");
    const buffer = await part.toBuffer();
    return service.setLogo(request.currentUser!, {
      buffer,
      filename: part.filename,
      mimetype: part.mimetype,
    });
  });
}
