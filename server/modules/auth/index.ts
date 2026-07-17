import type { FastifyInstance } from "fastify";
import { deleteExpiredSessions } from "../../core/auth.js";
import { registerJob } from "../../core/scheduler.js";
import { registerRoutes } from "./auth.routes.js";

export { toPublicUser } from "./auth.schema.js";

export async function authModule(app: FastifyInstance) {
  await registerRoutes(app);
}

// housekeeping: purge expired sessions nightly
registerJob({
  name: "sessions:cleanup",
  cronExpr: "0 4 * * *",
  run: deleteExpiredSessions,
});
