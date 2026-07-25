import { buildApp } from "./app.js";
import { ensureBaseData, ensureBootstrapAdmin } from "./core/bootstrap.js";
import { config } from "./core/config.js";
import { disconnectDb } from "./core/db.js";
import { ensureUploadsDir } from "./core/files.js";
import { registerJob, startScheduler, stopScheduler } from "./core/scheduler.js";
import { generateInternalTasks, generateSubscriptionTasks } from "./modules/tasks/index.js";

async function main() {
  const app = await buildApp();

  await ensureUploadsDir();
  await ensureBaseData();
  await ensureBootstrapAdmin(app.log);

  // S6 job #1: subscription + internal templates → tasks on the rhythm day; catch-up = same sweep.
  // Each sweep is fault-isolated — one failing (e.g. a transient DB error) must not skip the other;
  // both are idempotent and self-heal on the next successful run.
  const runGeneration = async (label: "run" | "catch-up") => {
    let created = 0;
    for (const gen of [generateSubscriptionTasks, generateInternalTasks]) {
      try {
        created += (await gen()).created;
      } catch (err) {
        app.log.error({ err, sweep: gen.name }, "task generation sweep failed");
      }
    }
    if (label === "catch-up" && created > 0) app.log.info({ created }, "scheduled tasks caught up");
  };
  registerJob({
    name: "subscription-task-generation",
    cronExpr: "5 3 * * *", // daily 03:05 firm time
    run: () => runGeneration("run"),
    catchUp: () => runGeneration("catch-up"),
  });

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  await startScheduler(app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await stopScheduler();
    await app.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
