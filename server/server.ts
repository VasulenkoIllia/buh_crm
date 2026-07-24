import { buildApp } from "./app.js";
import { ensureBaseData, ensureBootstrapAdmin } from "./core/bootstrap.js";
import { config } from "./core/config.js";
import { disconnectDb } from "./core/db.js";
import { ensureUploadsDir } from "./core/files.js";
import { registerJob, startScheduler, stopScheduler } from "./core/scheduler.js";
import { generateSubscriptionTasks } from "./modules/tasks/index.js";

async function main() {
  const app = await buildApp();

  await ensureUploadsDir();
  await ensureBaseData();
  await ensureBootstrapAdmin(app.log);

  // S6 job #1: subscription → tasks on the rhythm day; catch-up = the same idempotent sweep
  registerJob({
    name: "subscription-task-generation",
    cronExpr: "5 3 * * *", // daily 03:05 firm time
    run: async () => {
      await generateSubscriptionTasks();
    },
    catchUp: async () => {
      const { created } = await generateSubscriptionTasks();
      if (created > 0) app.log.info({ created }, "subscription tasks caught up");
    },
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
