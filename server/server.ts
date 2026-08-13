import { buildApp } from "./app.js";
import { ensureBaseData, ensureBootstrapAdmin } from "./core/bootstrap.js";
import { config } from "./core/config.js";
import { disconnectDb } from "./core/db.js";
import { ensureUploadsDir } from "./core/files.js";
import { registerJob, startScheduler, stopScheduler } from "./core/scheduler.js";
import { runDueCampaigns } from "./modules/mailouts/index.js";
import { generatePeriodInvoices } from "./modules/payments/index.js";
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

  // S7 job #2: one invoice per subscription period, issued on the service's billing day.
  // Same idempotent sweep for the daily run and the startup catch-up (unique subscription+period).
  const runBilling = async (label: "run" | "catch-up") => {
    try {
      const { created, failed } = await generatePeriodInvoices();
      if (created > 0) app.log.info({ created, label }, "period invoices issued");
      // per-subscription failures are isolated inside the sweep; surface them so a client
      // that silently stops being billed is visible in the logs
      if (failed > 0) app.log.error({ failed, label }, "period invoice sweep skipped subscriptions");
    } catch (err) {
      app.log.error({ err }, "period invoice sweep failed");
    }
  };
  registerJob({
    name: "period-invoice-generation",
    cronExpr: "20 3 * * *", // daily 03:20 firm time, just after the task sweep
    run: () => runBilling("run"),
    catchUp: () => runBilling("catch-up"),
  });

  // S10.1 job #3: campaigns whose date has come.
  //
  // Late in the morning rather than at 03:00 with the others: these are letters people read, and a
  // newsletter timestamped 03:20 looks like it came from a machine, because it did. The sweep is
  // what makes downtime survivable — a date missed overnight fires on the next boot, once, because
  // `UNIQUE(campaignId, periodKey)` refuses a second run for the same occurrence.
  //
  // Unlike the task and invoice sweeps, this one does NOT catch up every missed date: after a late
  // run the next one is counted from today. A missing invoice is a missing fact worth recovering;
  // six months of newsletters arriving in one morning is not.
  const runCampaigns = async (label: "run" | "catch-up") => {
    try {
      const { fired, failed } = await runDueCampaigns();
      if (fired > 0) app.log.info({ fired, label }, "campaigns sent");
      if (failed > 0) app.log.error({ failed, label }, "campaign runs failed — still due");
    } catch (err) {
      app.log.error({ err }, "campaign sweep failed");
    }
  };
  registerJob({
    name: "campaign-sends",
    // HOURLY, not nightly: each campaign carries the time of day the firm chose, and a sweep that
    // ran once a day could only ever honour one of them. The sweep is cheap when nothing is due —
    // one indexed query on (status, nextRunOn) — and firing is still once per occurrence.
    cronExpr: "0 * * * *",
    run: () => runCampaigns("run"),
    catchUp: () => runCampaigns("catch-up"),
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
