import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  clientListQuery,
  createClientInput,
  updateClientInput,
} from "@shared/schema/client.js";
import { requireAuth } from "../../core/auth.js";
import { ValidationError } from "../../core/errors.js";
import { readFileStream } from "../../core/files.js";
import * as service from "./clients.service.js";

const idParams = z.object({ id: uuid });
const fileParams = z.object({ id: uuid, fileId: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", requireAuth);

  app.get("/", { schema: { querystring: clientListQuery } }, async (request) => {
    return service.listClients(request.query);
  });

  app.get(
    "/companies",
    { schema: { querystring: z.object({ search: z.string().default("") }) } },
    async (request) => {
      return service.searchCompanies(request.query.search);
    },
  );

  app.get("/:id", { schema: { params: idParams } }, async (request) => {
    return service.getClient(request.params.id);
  });

  app.post("/", { schema: { body: createClientInput } }, async (request, reply) => {
    const client = await service.createClient(request.body);
    return reply.status(201).send(client);
  });

  app.patch(
    "/:id",
    { schema: { params: idParams, body: updateClientInput } },
    async (request) => {
      return service.updateClient(request.params.id, request.body);
    },
  );

  app.post("/:id/archive", { schema: { params: idParams } }, async (request) => {
    return service.archiveClient(request.params.id, request.currentUser!);
  });

  // ── files ─────────────────────────────────────────────────────────────────

  app.get("/:id/files", { schema: { params: idParams } }, async (request) => {
    return service.listFiles(request.params.id);
  });

  app.post("/:id/files", { schema: { params: idParams } }, async (request, reply) => {
    const part = await request.file();
    if (!part) throw new ValidationError("File is required");
    const buffer = await part.toBuffer();
    const file = await service.addFile(request.params.id, request.currentUser!, {
      buffer,
      filename: part.filename,
      mimetype: part.mimetype,
    });
    return reply.status(201).send(file);
  });

  app.get(
    "/:id/files/:fileId",
    { schema: { params: fileParams } },
    async (request, reply) => {
      const file = await service.getFile(request.params.id, request.params.fileId);
      reply.header("Content-Type", file.mime);
      reply.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      return reply.send(readFileStream(file.path));
    },
  );

  app.delete(
    "/:id/files/:fileId",
    { schema: { params: fileParams } },
    async (request) => {
      return service.removeFile(request.params.id, request.params.fileId);
    },
  );
}
