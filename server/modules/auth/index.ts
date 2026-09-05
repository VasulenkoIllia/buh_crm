import type { FastifyInstance } from "fastify";
import { plural } from "@shared/text.js";
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
  run: async () => {
    const removed = await deleteExpiredSessions();
    return {
      note: removed > 0 ? `${plural(removed, "expired sign-in")} removed` : "Nothing to clear",
    };
  },
});
