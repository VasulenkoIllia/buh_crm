import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./clients.routes.js";

// `createClient` is on the public surface for `scripts/import-clients.ts`, which creates clients
// through the same door the API uses rather than writing rows behind the service layer.
export { toClientDto, applyDefaultClientService, createClient } from "./clients.service.js";

export async function clientsModule(app: FastifyInstance) {
  await registerRoutes(app);
}

// The vault moved out in S18: `createSecret` now lives in `modules/secrets`, and the client card's
// tab reads `/api/secrets/clients/:clientId` (secrets.md §12, §14).
