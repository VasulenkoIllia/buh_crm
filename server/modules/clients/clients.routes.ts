import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  clientListQuery,
  createClientInput,
  createSubscriptionInput,
  pauseSubscriptionInput,
  resumeSubscriptionInput,
  updateClientInput,
  updateSubscriptionInput,
} from "@shared/schema/client.js";
import { undoInput } from "@shared/schema/files.js";
import { gate, shared } from "../../core/access.js";
import { sendDownload, sendView } from "../files/index.js";
import * as service from "./clients.service.js";

const idParams = z.object({ id: uuid });
const fileParams = z.object({ id: uuid, fileId: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * The module-level `preHandler: requireAuth` that used to sit here is gone: every route below
   * declares its own gate, and the one hook in `core/access.ts` enforces it. The two list reads
   * stay `shared()` — Billing, the Calendar, Mail-outs and the Archive all fill their pickers
   * from them, so gating them would blank four screens that are open.
   */
  const clients = gate("clients");

  // the reader is passed in because PINS are per-user: the same list, ordered differently for
  // each person who opens it
  app.get(
    "/",
    { config: shared(), schema: { querystring: clientListQuery } },
    async (request) => {
      return service.listClients(request.query, request.currentUser!.id);
    },
  );

  app.get("/:id", { config: shared(), schema: { params: idParams } }, async (request) => {
    // `viewClient`, not `getClient`: opening a card is a recordable act (off by default), and the
    // dozen mutations that call `getClient` to build their response are not
    return service.viewClient(request.params.id, request.currentUser!.id);
  });

  /**
   * **One client, named for a link to it** (chat.md §5.6). `shared()` like the card above it, and
   * for the same reason: a client's name is what Billing, the Calendar and Mail-outs already show
   * to everyone. It records nothing — a card drawn by scrolling past a message is not somebody
   * opening a client (audit, 2026-09-20).
   */
  app.get("/:id/card", { config: shared(), schema: { params: idParams } }, async (request) =>
    service.cardOf(request.params.id),
  );

  app.post(
    "/",
    { config: clients, schema: { body: createClientInput } },
    async (request, reply) => {
      const client = await service.createClient(request.body);
      return reply.status(201).send(client);
    },
  );

  app.patch(
    "/:id",
    { config: clients, schema: { params: idParams, body: updateClientInput } },
    async (request) => {
      return service.updateClient(request.params.id, request.body);
    },
  );

  /**
   * Keep a client at the top of MY list. PUT/DELETE rather than a PATCH on the client, because a
   * pin is not a property OF the client — the same row is pinned for one reader and not another.
   */
  app.put("/:id/pin", { config: clients, schema: { params: idParams } }, async (request) => {
    await service.setClientPinned(request.currentUser!.id, request.params.id, true);
    return { ok: true as const };
  });

  app.delete("/:id/pin", { config: clients, schema: { params: idParams } }, async (request) => {
    await service.setClientPinned(request.currentUser!.id, request.params.id, false);
    return { ok: true as const };
  });

  app.post(
    "/:id/archive",
    { config: clients, schema: { params: idParams } },
    async (request) => {
      return service.archiveClient(request.params.id, request.currentUser!);
    },
  );

  app.post(
    "/:id/restore",
    { config: clients, schema: { params: idParams } },
    async (request) => {
      return service.restoreClient(request.params.id);
    },
  );

  // ── subscriptions (S3) — a client's categories follow from these, nothing to set ──

  app.post(
    "/:id/subscriptions",
    { config: clients, schema: { params: idParams, body: createSubscriptionInput } },
    async (request, reply) => {
      const client = await service.addSubscription(request.params.id, request.body);
      return reply.status(201).send(client);
    },
  );

  // pause / resume carry a DATE, so they are their own actions rather than an `active` flag —
  // that date is what lets the app still answer "was this client served on the 1st" later
  app.post(
    "/:id/subscriptions/:subId/pause",
    {
      config: clients,
      schema: { params: z.object({ id: uuid, subId: uuid }), body: pauseSubscriptionInput },
    },
    async (request) =>
      service.pauseSubscription(
        request.params.id,
        request.params.subId,
        request.body,
        request.currentUser!,
      ),
  );

  app.post(
    "/:id/subscriptions/:subId/resume",
    {
      config: clients,
      schema: { params: z.object({ id: uuid, subId: uuid }), body: resumeSubscriptionInput },
    },
    async (request) =>
      service.resumeSubscription(
        request.params.id,
        request.params.subId,
        request.body,
        request.currentUser!,
      ),
  );

  app.patch(
    "/:id/subscriptions/:subId",
    {
      config: clients,
      schema: {
        params: z.object({ id: uuid, subId: uuid }),
        body: updateSubscriptionInput,
      },
    },
    async (request) => {
      return service.updateSubscription(request.params.id, request.params.subId, request.body);
    },
  );

  // ── files ─────────────────────────────────────────────────────────────────
  // The card's list and Upload are the library's own routes (files.md §4.2). What stays here is a
  // file's download, view, delete and Undo, on the card's own gate.

  // no HEAD, as on the view below: fastify would run the handler and log a download nobody made
  app.get(
    "/:id/files/:fileId",
    { config: clients, schema: { params: fileParams }, exposeHeadRoute: false },
    async (request, reply) =>
      sendDownload(reply, await service.getFile(request.params.id, request.params.fileId)),
  );

  // the same file, opened in the CRM (files.md §12); no HEAD, which would log a view nobody made
  app.get(
    "/:id/files/:fileId/view",
    { config: clients, schema: { params: fileParams }, exposeHeadRoute: false },
    async (request, reply) =>
      sendView(reply, await service.getFile(request.params.id, request.params.fileId, "view")),
  );

  // into the Trash, never destroyed: the answer carries the gesture the card's Undo takes back
  app.delete(
    "/:id/files/:fileId",
    { config: clients, schema: { params: fileParams } },
    async (request) => {
      return service.removeFile(request.params.id, request.params.fileId, request.currentUser!);
    },
  );

  app.post(
    "/:id/files/undo",
    { config: clients, schema: { params: idParams, body: undoInput } },
    async (request) =>
      service.undoRemoveFile(request.params.id, request.body.batchId, request.currentUser!),
  );
}
