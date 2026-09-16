import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { uuid } from "@shared/schema/common.js";
import {
  deleteSecretsInput,
  moveSecretsInput,
  secretInput,
  secretSearchQuery,
  unlockVaultInput,
} from "@shared/schema/secrets.js";
import { gate } from "../../core/access.js";
import { sessionIdOf } from "../../core/auth.js";
import { clientIp } from "../../core/client-ip.js";
import * as searching from "./secrets.search.js";
import * as service from "./secrets.service.js";
import * as trash from "./secrets.trash.js";

const secretIdParams = z.object({ secretId: uuid });
const clientParams = z.object({ clientId: uuid });
const clientSecretParams = z.object({ clientId: uuid, secretId: uuid });
const REVEAL_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

/**
 * **The whole vault is behind one gate** (secrets.md §12): the Secrets menu, this module, and the
 * client card's tab, which reads the same routes. `secrets` was split out of `clients` on
 * 2026-09-07 because `clients` can never be fully closed — its list reads are reference data four
 * other screens fill their pickers from — and portal logins are not something to leave behind a
 * switch that does not fully shut.
 *
 * A route declares ONE gate, and a place is decided by the path rather than by a row, so the three
 * places are three groups of routes here. A client's list asks the second gate in the service
 * (`clientPlace`), which is the named exception the library already has.
 */
export async function registerRoutes(instance: FastifyInstance) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const vault = gate("secrets");

  // ── the vault's own window ─────────────────────────────────────────────────
  app.get("/grant", { config: vault }, async (request) =>
    service.grantStatus(sessionIdOf(request)),
  );

  // Its OWN rate limit: this route checks a password, and the app-wide 300 a minute is far too
  // generous for that. Ten tries a minute is plenty for a typo and useless for guessing.
  app.post(
    "/unlock",
    {
      schema: { body: unlockVaultInput },
      config: { ...vault, rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request) =>
      service.unlock(
        sessionIdOf(request),
        request.body,
        request.currentUser!,
        clientIp(request),
      ),
  );

  /** What the tree shows: a number beside each place, and the Trash's own (§4). */
  app.get("/overview", { config: vault }, async (request) =>
    service.overview(request.currentUser!),
  );

  /** Every client with a list, and how much is in it. Needs Clients as well (§4.3). */
  app.get("/clients", { config: vault }, async (request) =>
    service.clientNodes(request.currentUser!),
  );

  /**
   * **One box over everything the reader may see** (§10). The visibility rule is inside the query,
   * so the counts are right; clients show above the secrets, which is the way to one that holds
   * none yet; and each hit carries its path step by step, so a click goes where it says.
   */
  app.get(
    "/search",
    { config: vault, schema: { querystring: secretSearchQuery } },
    async (request) => searching.search(request.currentUser!, request.query),
  );

  /** One secret's own journal (§11), shown to whoever may see the secret. */
  app.get(
    "/history/:secretId",
    { config: vault, schema: { params: secretIdParams } },
    async (request) => searching.history(request.currentUser!, request.params.secretId),
  );

  /**
   * **The Trash** (§9). One list, grouped by the gesture that filled it; each item shows by the
   * rule of the place it came from, so a colleague's My secrets are not in anybody else's Trash.
   * Restoring works on a whole gesture — which is what the cards' Undo takes — or on one secret.
   */
  app.get("/trash", { config: vault }, async (request) =>
    trash.trashList(request.currentUser!),
  );

  app.post(
    "/trash/batches/:batchId/restore",
    { config: vault, schema: { params: z.object({ batchId: uuid }) } },
    async (request) =>
      trash.restoreBatch(request.params.batchId, request.currentUser!, clientIp(request)),
  );

  app.post(
    "/trash/secrets/:secretId/restore",
    { config: vault, schema: { params: secretIdParams } },
    async (request) =>
      trash.restoreSecret(request.params.secretId, request.currentUser!, clientIp(request)),
  );

  /**
   * **My secrets and Company: the same five routes, twice** (§4.2). My secrets is one list per
   * person, private from colleagues and admins while they work here; Company is the firm's own
   * credentials, which anyone with Secrets may read, edit and move. The place comes from the path,
   * so no request can name a place it is not on.
   */
  const fixed = [
    { path: "my", place: service.myPlace },
    { path: "company", place: () => service.companyPlace() },
  ] as const;

  for (const { path, place } of fixed) {
    app.get(`/${path}`, { config: vault }, async (request) =>
      service.listSecrets(place(request.currentUser!)),
    );

    app.post(
      `/${path}`,
      { config: vault, schema: { body: secretInput } },
      async (request, reply) =>
        reply
          .status(201)
          .send(
            await service.createSecret(
              place(request.currentUser!),
              request.body,
              request.currentUser!,
              clientIp(request),
            ),
          ),
    );

    app.patch(
      `/${path}/:secretId`,
      { config: vault, schema: { params: secretIdParams, body: secretInput } },
      async (request) =>
        service.updateSecret(
          place(request.currentUser!),
          request.params.secretId,
          request.body,
          request.currentUser!,
          clientIp(request),
        ),
    );

    app.delete(
      `/${path}/:secretId`,
      { config: vault, schema: { params: secretIdParams } },
      async (request) =>
        service.deleteSecret(
          place(request.currentUser!),
          request.params.secretId,
          request.currentUser!,
          clientIp(request),
        ),
    );

    app.post(
      `/${path}/:secretId/reveal`,
      {
        config: { ...vault, rateLimit: REVEAL_RATE_LIMIT },
        schema: { params: secretIdParams },
      },
      async (request) =>
        service.revealSecret(
          sessionIdOf(request),
          place(request.currentUser!),
          request.params.secretId,
          request.currentUser!,
          clientIp(request),
        ),
    );
  }

  /**
   * **Moving, from the two fixed places** (§7). Anyone with Secrets may move out of My secrets or
   * Company; into a client, the service asks Clients as well. Out of a CLIENT is the admin's route
   * further down, because a route declares one rule and that one is different.
   */
  for (const { path, place } of fixed) {
    app.post(
      `/${path}/delete`,
      { config: vault, schema: { body: deleteSecretsInput } },
      async (request) =>
        service.deleteSecrets(
          place(request.currentUser!),
          request.body,
          request.currentUser!,
          clientIp(request),
        ),
    );

    app.post(
      `/${path}/move`,
      { config: vault, schema: { body: moveSecretsInput } },
      async (request) =>
        service.moveSecrets(
          place(request.currentUser!),
          request.body,
          request.currentUser!,
          clientIp(request),
        ),
    );
  }

  // ── one client's list ──────────────────────────────────────────────────────
  app.get(
    "/clients/:clientId",
    { config: vault, schema: { params: clientParams } },
    async (request) =>
      service.listSecrets(
        await service.clientPlace(request.currentUser!, request.params.clientId, "read"),
      ),
  );

  app.post(
    "/clients/:clientId",
    { config: vault, schema: { params: clientParams, body: secretInput } },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await service.createSecret(
            await service.clientPlace(request.currentUser!, request.params.clientId, "write"),
            request.body,
            request.currentUser!,
            clientIp(request),
          ),
        ),
  );

  app.patch(
    "/clients/:clientId/:secretId",
    { config: vault, schema: { params: clientSecretParams, body: secretInput } },
    async (request) =>
      service.updateSecret(
        await service.clientPlace(request.currentUser!, request.params.clientId, "write"),
        request.params.secretId,
        request.body,
        request.currentUser!,
        clientIp(request),
      ),
  );

  app.delete(
    "/clients/:clientId/:secretId",
    { config: vault, schema: { params: clientSecretParams } },
    async (request) =>
      service.deleteSecret(
        await service.clientPlace(request.currentUser!, request.params.clientId, "write"),
        request.params.secretId,
        request.currentUser!,
        clientIp(request),
      ),
  );

  app.post(
    "/clients/:clientId/:secretId/reveal",
    {
      config: { ...vault, rateLimit: REVEAL_RATE_LIMIT },
      schema: { params: clientSecretParams },
    },
    async (request) =>
      service.revealSecret(
        sessionIdOf(request),
        await service.clientPlace(request.currentUser!, request.params.clientId, "read"),
        request.params.secretId,
        request.currentUser!,
        clientIp(request),
      ),
  );

  // several of a client's secrets into the Trash as one gesture (§9)
  app.post(
    "/clients/:clientId/delete",
    { config: vault, schema: { params: clientParams, body: deleteSecretsInput } },
    async (request) =>
      service.deleteSecrets(
        await service.clientPlace(request.currentUser!, request.params.clientId, "write"),
        request.body,
        request.currentUser!,
        clientIp(request),
      ),
  );

  /**
   * **Out of a client: admins only** (§7, §12). For a secret filed under the wrong client, which is
   * the move that changes whose credential it is. Its own route, so the rule is in the declaration
   * rather than in an `if`, and `secret.refiled` keeps it long.
   */
  app.post(
    "/clients/:clientId/move-out",
    {
      config: gate("secrets", { adminOnly: true }),
      schema: { params: clientParams, body: moveSecretsInput },
    },
    async (request) =>
      service.moveSecrets(
        await service.clientPlace(request.currentUser!, request.params.clientId, "write"),
        request.body,
        request.currentUser!,
        clientIp(request),
      ),
  );

  // the client card's Access log, which reads that client's journal rows (§11)
  app.get(
    "/clients/:clientId/audit",
    {
      config: vault,
      schema: {
        params: clientParams,
        querystring: z.object({ page: z.coerce.number().int().min(1).default(1) }),
      },
    },
    async (request) => {
      await service.clientPlace(request.currentUser!, request.params.clientId, "read");
      return service.listAudit(request.params.clientId, request.query.page);
    },
  );
}
