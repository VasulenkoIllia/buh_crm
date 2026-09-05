import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  clientListQuery,
  clientSecretInput,
  createClientInput,
  createSubscriptionInput,
  pauseSubscriptionInput,
  resumeSubscriptionInput,
  unlockSecretsInput,
  updateClientInput,
  updateSubscriptionInput,
} from "@shared/schema/client.js";
import { gate, shared } from "../../core/access.js";
import { ValidationError } from "../../core/errors.js";
import { readFileStream } from "../../core/files.js";
import * as secrets from "./secrets.service.js";
import * as service from "./clients.service.js";

const idParams = z.object({ id: uuid });
const fileParams = z.object({ id: uuid, fileId: uuid });
const secretParams = z.object({ id: uuid, secretId: uuid });

export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * The module-level `preHandler: requireAuth` that used to sit here is gone: every route below
   * declares its own gate, and the one hook in `core/access.ts` enforces it. The two list reads
   * stay `shared()` — Billing, the Calendar, Mail-outs and the Archive all fill their pickers
   * from them, so gating them would blank four screens that are open.
   */
  const clients = gate("clients");
  /**
   * The vault is its OWN gate, not part of `clients`. `clients` can never be fully closed (its
   * list reads are reference data), and portal logins, bank credentials and КЕП passwords are not
   * something to leave behind a switch that does not fully shut. The value itself is still
   * protected the way it has been since 2026-08-14 — the viewer's own password, a five-minute
   * grant and a journal entry for every look and every failed attempt. This switch decides who
   * sees the tab at all.
   */
  const vault = gate("secrets");

  // the reader is passed in because PINS are per-user: the same list, ordered differently for
  // each person who opens it
  app.get("/", { config: shared(), schema: { querystring: clientListQuery } }, async (request) => {
    return service.listClients(request.query, request.currentUser!.id);
  });

  app.get("/:id", { config: shared(), schema: { params: idParams } }, async (request) => {
    return service.getClient(request.params.id, request.currentUser!.id);
  });

  app.post("/", { config: clients, schema: { body: createClientInput } }, async (request, reply) => {
    const client = await service.createClient(request.body);
    return reply.status(201).send(client);
  });

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

  app.post("/:id/archive", { config: clients, schema: { params: idParams } }, async (request) => {
    return service.archiveClient(request.params.id, request.currentUser!);
  });

  app.post("/:id/restore", { config: clients, schema: { params: idParams } }, async (request) => {
    return service.restoreClient(request.params.id);
  });

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

  app.get("/:id/files", { config: clients, schema: { params: idParams } }, async (request) => {
    return service.listFiles(request.params.id);
  });

  app.post("/:id/files", { config: clients, schema: { params: idParams } }, async (request, reply) => {
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
    { config: clients, schema: { params: fileParams } },
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
    { config: clients, schema: { params: fileParams } },
    async (request) => {
      return service.removeFile(request.params.id, request.params.fileId);
    },
  );

  // ── secrets (S7.5) ─────────────────────────────────────────────────────────
  // Labels and descriptions are ordinary client data; the VALUE needs the viewer's OWN password
  // and a five-minute window. Every reveal — and every failed unlock — is journalled.
  //
  // ("needs an ADMIN" stood here until 2026-09-07, describing a rule deliberately dropped on
  // 2026-08-14. Anyone cutting new rules from code comments would have restored it.)

  app.get("/:id/secrets", { config: vault, schema: { params: idParams } }, async (request) =>
    secrets.listSecrets(request.params.id),
  );

  app.get("/:id/secrets/grant", { config: vault, schema: { params: idParams } }, async (request) =>
    secrets.grantStatus(request.params.id, request.currentUser!),
  );

  app.post(
    "/:id/secrets",
    { config: vault, schema: { params: idParams, body: clientSecretInput } },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await secrets.createSecret(request.params.id, request.body, request.currentUser!, request.ip),
        ),
  );

  app.patch(
    "/:id/secrets/:secretId",
    { config: vault, schema: { params: secretParams, body: clientSecretInput } },
    async (request) =>
      secrets.updateSecret(
        request.params.id,
        request.params.secretId,
        request.body,
        request.currentUser!,
        request.ip,
      ),
  );

  app.delete("/:id/secrets/:secretId", { config: vault, schema: { params: secretParams } }, async (request) =>
    secrets.deleteSecret(request.params.id, request.params.secretId, request.currentUser!, request.ip),
  );

  // Its OWN rate limit: this route checks a password, and the app-wide 300/min is far too generous
  // for that. Ten tries a minute is plenty for a typo and useless for guessing.
  app.post(
    "/:id/secrets/unlock",
    {
      schema: { params: idParams, body: unlockSecretsInput },
      config: { ...vault, rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request) =>
      secrets.unlock(request.params.id, request.body, request.currentUser!, request.ip),
  );

  app.post(
    "/:id/secrets/:secretId/reveal",
    { schema: { params: secretParams }, config: { ...vault, rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) =>
      secrets.revealSecret(
        request.params.id,
        request.params.secretId,
        request.currentUser!,
        request.ip,
      ),
  );

  app.get(
    "/:id/secrets/audit",
    { config: vault, schema: { params: idParams, querystring: z.object({ page: z.coerce.number().int().min(1).default(1) }) } },
    async (request) => secrets.listAudit(request.params.id, request.query.page),
  );
}
