import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  createFolderInput,
  fileToFolderInput,
  fileZone,
  folderQuery,
  moveInput,
  renameInput,
  searchQuery,
  trashInput,
  trashQuery,
} from "@shared/schema/files.js";
import { gate } from "../../core/access.js";
import { ValidationError } from "../../core/errors.js";
import { sendDownload, sendView } from "./files.serve.js";
import * as service from "./files.service.js";
import * as trash from "./files.trash.js";

const folderParams = z.object({ folderId: uuid });
const fileParams = z.object({ fileId: uuid });
const clientParams = z.object({ clientId: uuid });
const zoneParams = z.object({ clientId: uuid, zone: fileZone });
const clientFolderParams = z.object({ clientId: uuid, folderId: uuid });
const clientFileParams = z.object({ clientId: uuid, fileId: uuid });
const batchParams = z.object({ batchId: uuid });

/**
 * Every upload route, the cards' included, has its own limit and leaves the global 300 a minute:
 * a queue of a few hundred files sends three at a time (files.md §7.1). On a 429 the queue waits
 * for `Retry-After` and carries on.
 */
export const UPLOAD_RATE_LIMIT = { max: 600, timeWindow: "1 minute" };

async function incoming(request: FastifyRequest): Promise<service.Incoming> {
  const part = await request.file();
  if (!part) throw new ValidationError("File is required");
  return { buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
}

/**
 * **A route's gate is static, and a place decides it** (files.md §11.1). My files and Company are
 * `files`, with an ownership check in the service for My files — not `own()`, since the paths name
 * folder and file ids. Every read or write of a client's files is `clients`, wherever it is shown.
 * An admin's move out of a client is a route of its own, `adminOnly`.
 */
export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const files = gate("files");
  const clients = gate("clients");

  // one box over names and details, never inside a file (files.md §13). What each item's own gate
  // allows is decided in the service, as for the tree's totals
  app.get("/search", { config: files, schema: { querystring: searchQuery } }, async (request) =>
    service.search(request.currentUser!, request.query),
  );

  app.get("/overview", { config: files }, async (request) =>
    service.overview(request.currentUser!),
  );

  // ── My files and Company: the same routes over two places ──────────────────
  for (const space of ["my", "company"] as const) {
    const place = (request: FastifyRequest) =>
      space === "my" ? service.myPlace(request.currentUser!) : service.COMPANY;
    const area = (request: FastifyRequest) =>
      space === "my" ? service.myArea(request.currentUser!) : service.COMPANY_AREA;

    app.get(`/${space}/folders`, { config: files }, async (request) =>
      service.folderTree(place(request)),
    );

    app.get(
      `/${space}/list`,
      { config: files, schema: { querystring: folderQuery } },
      async (request) =>
        service.list(place(request), request.query.folderId, request.currentUser!),
    );

    app.post(
      `/${space}/upload`,
      {
        config: { ...files, rateLimit: UPLOAD_RATE_LIMIT },
        schema: { querystring: folderQuery },
      },
      async (request, reply) => {
        const file = await service.upload(
          place(request),
          request.query.folderId,
          request.currentUser!,
          await incoming(request),
        );
        return reply.status(201).send(file);
      },
    );

    app.post(
      `/${space}/folders`,
      { config: files, schema: { body: createFolderInput } },
      async (request, reply) => {
        const folder = await service.createFolder(
          place(request),
          request.body.parentId,
          request.body.name,
          request.currentUser!,
        );
        return reply.status(201).send(folder);
      },
    );

    // a folder upload's one call per directory (§7.2): the folder, found or made. Limited like the
    // uploads it comes before, since a big folder sends one per directory
    app.post(
      `/${space}/folders/ensure`,
      {
        config: { ...files, rateLimit: UPLOAD_RATE_LIMIT },
        schema: { body: createFolderInput },
      },
      async (request, reply) => {
        const folder = await service.ensureFolder(
          place(request),
          request.body.parentId,
          request.body.name,
          request.currentUser!,
        );
        return reply.status(folder.created ? 201 : 200).send(folder);
      },
    );

    app.patch(
      `/${space}/folders/:folderId`,
      { config: files, schema: { params: folderParams, body: renameInput } },
      async (request) =>
        service.renameFolder(area(request), request.params.folderId, request.body.name),
    );

    app.patch(
      `/${space}/files/:fileId`,
      { config: files, schema: { params: fileParams, body: renameInput } },
      async (request) =>
        service.renameFile(area(request), request.params.fileId, request.body.name),
    );

    app.post(
      `/${space}/move`,
      { config: files, schema: { body: moveInput } },
      async (request) => service.move(area(request), request.body, request.currentUser!),
    );

    // no HEAD: fastify would answer one by running this handler, logging a download nobody made
    // and decrypting the file for nothing
    app.get(
      `/${space}/files/:fileId`,
      { config: files, schema: { params: fileParams }, exposeHeadRoute: false },
      async (request, reply) =>
        sendDownload(reply, await service.download(area(request), request.params.fileId)),
    );

    // the same file, opened in the CRM (files.md §12). No HEAD: fastify would answer one by
    // running this handler, and log a view nobody made
    app.get(
      `/${space}/files/:fileId/view`,
      { config: files, schema: { params: fileParams }, exposeHeadRoute: false },
      async (request, reply) =>
        sendView(reply, await service.download(area(request), request.params.fileId, "view")),
    );
  }

  // ── the Trash (files.md §9) ─────────────────────────────────────────────────
  // A selection from one place goes in, each place on its own gate. The Trash itself is inside
  // Files: its list and its restores are `files`, and the service asks each item's own gate too
  // (§11.1), so a client's items need Clients as well. The cards' Undo sits on the cards' gates.
  for (const space of ["my", "company"] as const) {
    const area = (request: FastifyRequest) =>
      space === "my" ? service.myArea(request.currentUser!) : service.COMPANY_AREA;
    app.post(
      `/${space}/delete`,
      { config: files, schema: { body: trashInput } },
      async (request) => trash.trash(area(request), request.body, request.currentUser!),
    );
  }

  app.post(
    "/clients/:clientId/delete",
    { config: clients, schema: { params: clientParams, body: trashInput } },
    async (request) =>
      trash.trash(
        service.clientArea(request.params.clientId),
        request.body,
        request.currentUser!,
      ),
  );

  app.get("/trash", { config: files, schema: { querystring: trashQuery } }, async (request) =>
    trash.trashList(request.currentUser!, request.query.before),
  );

  app.post(
    "/trash/:batchId/restore",
    { config: files, schema: { params: batchParams } },
    async (request) => trash.restoreBatch(request.params.batchId, request.currentUser!),
  );

  app.post(
    "/trash/files/:fileId/restore",
    { config: files, schema: { params: fileParams } },
    async (request) => trash.restoreFile(request.params.fileId, request.currentUser!),
  );

  app.post(
    "/trash/folders/:folderId/restore",
    { config: files, schema: { params: folderParams } },
    async (request) => trash.restoreFolder(request.params.folderId, request.currentUser!),
  );

  // ── Company's Attachments: files on the firm's internal tasks ──────────────
  app.get("/company/attachments", { config: files }, async (request) =>
    service.companyAttachments(request.currentUser!),
  );

  app.post(
    "/company/attachments/:fileId/file",
    { config: files, schema: { params: fileParams, body: fileToFolderInput } },
    async (request) =>
      service.fileCompanyAttachment(
        request.params.fileId,
        request.body.folderId,
        request.currentUser!,
      ),
  );

  // ── a client's files: always the Clients gate ──────────────────────────────
  // A client's file downloads through the client card's own route, `GET /api/clients/:id/files/:fileId`.
  app.get("/clients", { config: clients }, async () => service.clientNodes());

  app.get(
    "/clients/:clientId",
    { config: clients, schema: { params: clientParams } },
    async (request) => service.clientDetail(request.params.clientId),
  );

  app.get(
    "/clients/:clientId/zones/:zone/folders",
    { config: clients, schema: { params: zoneParams } },
    async (request) =>
      service.folderTree(
        await service.clientPlace(request.params.clientId, request.params.zone),
      ),
  );

  app.get(
    "/clients/:clientId/zones/:zone/list",
    { config: clients, schema: { params: zoneParams, querystring: folderQuery } },
    async (request) =>
      service.list(
        await service.clientPlace(request.params.clientId, request.params.zone),
        request.query.folderId,
        request.currentUser!,
      ),
  );

  app.post(
    "/clients/:clientId/zones/:zone/upload",
    {
      config: { ...clients, rateLimit: UPLOAD_RATE_LIMIT },
      schema: { params: zoneParams, querystring: folderQuery },
    },
    async (request, reply) => {
      const file = await service.upload(
        await service.clientPlace(request.params.clientId, request.params.zone),
        request.query.folderId,
        request.currentUser!,
        await incoming(request),
      );
      return reply.status(201).send(file);
    },
  );

  app.post(
    "/clients/:clientId/zones/:zone/folders",
    { config: clients, schema: { params: zoneParams, body: createFolderInput } },
    async (request, reply) => {
      const folder = await service.createFolder(
        await service.clientPlace(request.params.clientId, request.params.zone),
        request.body.parentId,
        request.body.name,
        request.currentUser!,
      );
      return reply.status(201).send(folder);
    },
  );

  app.post(
    "/clients/:clientId/zones/:zone/folders/ensure",
    {
      config: { ...clients, rateLimit: UPLOAD_RATE_LIMIT },
      schema: { params: zoneParams, body: createFolderInput },
    },
    async (request, reply) => {
      const folder = await service.ensureFolder(
        await service.clientPlace(request.params.clientId, request.params.zone),
        request.body.parentId,
        request.body.name,
        request.currentUser!,
      );
      return reply.status(folder.created ? 201 : 200).send(folder);
    },
  );

  app.patch(
    "/clients/:clientId/folders/:folderId",
    { config: clients, schema: { params: clientFolderParams, body: renameInput } },
    async (request) =>
      service.renameFolder(
        service.clientArea(request.params.clientId),
        request.params.folderId,
        request.body.name,
      ),
  );

  app.patch(
    "/clients/:clientId/files/:fileId",
    { config: clients, schema: { params: clientFileParams, body: renameInput } },
    async (request) =>
      service.renameFile(
        service.clientArea(request.params.clientId),
        request.params.fileId,
        request.body.name,
      ),
  );

  app.post(
    "/clients/:clientId/move",
    { config: clients, schema: { params: clientParams, body: moveInput } },
    async (request) =>
      service.move(
        service.clientArea(request.params.clientId),
        request.body,
        request.currentUser!,
      ),
  );

  // for a misfiled document: to another client, Company or My files (files.md §6.2)
  app.post(
    "/clients/:clientId/move-out",
    {
      config: gate("clients", { adminOnly: true }),
      schema: { params: clientParams, body: moveInput },
    },
    async (request) =>
      service.move(
        service.clientArea(request.params.clientId),
        request.body,
        request.currentUser!,
        "out",
      ),
  );

  app.get(
    "/clients/:clientId/attachments",
    { config: clients, schema: { params: clientParams } },
    async (request) => service.clientAttachments(request.params.clientId),
  );

  app.post(
    "/clients/:clientId/attachments/:fileId/file",
    { config: clients, schema: { params: clientFileParams, body: fileToFolderInput } },
    async (request) =>
      service.fileClientAttachment(
        request.params.clientId,
        request.params.fileId,
        request.body.zone,
        request.body.folderId,
      ),
  );
}
