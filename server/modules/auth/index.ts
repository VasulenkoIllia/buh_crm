import type { FastifyInstance } from "fastify";
import { plural } from "@shared/text.js";
import { deleteExpiredSessions } from "../../core/auth.js";
import { registerJob } from "../../core/scheduler.js";
import { deleteStaleThrottles } from "../../core/sign-in-throttle.js";
import { deleteStaleChallenges } from "../two-factor/index.js";
import { registerRoutes } from "./auth.routes.js";

export { toPublicUser } from "./auth.schema.js";

export async function authModule(app: FastifyInstance) {
  await registerRoutes(app);
}

// housekeeping: purge expired sessions nightly, the failed-sign-in counters nobody has added to for
// a day, and the second steps of signing in nobody finished (two-factor.md §9, §5.2) — the same
// hour, the same kind of leftover
registerJob({
  name: "sessions:cleanup",
  cronExpr: "0 4 * * *",
  run: async () => {
    const removed = await deleteExpiredSessions();
    const counters = await deleteStaleThrottles();
    const challenges = await deleteStaleChallenges();
    const done = [
      removed > 0 ? `${plural(removed, "expired sign-in")} removed` : null,
      counters > 0 ? `${plural(counters, "old failed-sign-in counter")} cleared` : null,
      challenges > 0 ? `${plural(challenges, "unfinished two-factor sign-in")} cleared` : null,
    ].filter((line): line is string => line !== null);
    return {
      note: done.length > 0 ? done.join(" · ") : "Nothing to clear",
      did: removed + counters + challenges,
    };
  },
});
