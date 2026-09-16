import type { FastifyInstance } from "fastify";
import { registerRoutes } from "./secrets.routes.js";

// used by `scripts/import-contacts.ts`: an SSN in a contacts export belongs in the encrypted
// store, never in a plain field
export { createSecret } from "./secrets.service.js";
// the nightly job `server.ts` schedules: thirty days in the Trash, then gone (secrets.md §9)
export { purgeTrash } from "./secrets.trash.js";
// blocking a person moves their My secrets into Company, as it moves their My files (§8)
export {
  movePersonalSecrets,
  personalSecretsCount,
  recordPersonalSecretsMove,
} from "./secrets.handover.js";

export async function secretsModule(app: FastifyInstance) {
  await registerRoutes(app);
}
