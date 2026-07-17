import { buildApp } from "./app.js";
import { config } from "./core/config.js";
import { disconnectDb } from "./core/db.js";
import { ensureUploadsDir } from "./core/files.js";
import { startScheduler, stopScheduler } from "./core/scheduler.js";

async function main() {
  const app = await buildApp();

  await ensureUploadsDir();
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
