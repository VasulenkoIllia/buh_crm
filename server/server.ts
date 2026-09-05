import { buildApp } from "./app.js";
import { ensureBaseData, ensureBootstrapAdmin } from "./core/bootstrap.js";
import { config } from "./core/config.js";
import { disconnectDb } from "./core/db.js";
import { ensureUploadsDir } from "./core/files.js";
import { sweepCron } from "@shared/notifications.js";
import { prisma } from "./core/db.js";
import { registerJob, startScheduler, stopScheduler } from "./core/scheduler.js";
import { recordSweepFailure } from "./core/sweep-health.js";
import { runDueCampaigns, sweepBounces, sweepStalledSends } from "./modules/mailouts/index.js";
import {
  purgeOldNotifications,
  runMeetingReminders,
  runNotificationSweep,
} from "./modules/notifications/index.js";
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
        // ALSO recorded, not only logged: nobody reads the log, and a subscription that quietly
        // stops producing tasks looks exactly like a subscription with nothing due (S9).
        recordSweepFailure("subscription-task-generation");
      }
    }
    if (label === "catch-up" && created > 0)
      app.log.info({ created }, "scheduled tasks caught up");
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
      if (failed > 0) {
        app.log.error({ failed, label }, "period invoice sweep skipped subscriptions");
        recordSweepFailure("period-invoice-generation", failed);
      }
    } catch (err) {
      app.log.error({ err }, "period invoice sweep failed");
      recordSweepFailure("period-invoice-generation");
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
      if (failed > 0) {
        app.log.error({ failed, label }, "campaign runs failed — still due");
        recordSweepFailure("campaign-sends", failed);
      }
    } catch (err) {
      app.log.error({ err }, "campaign sweep failed");
      recordSweepFailure("campaign-sends");
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

  /**
   * Reading every mailbox back for delivery reports.
   *
   * Every fifteen minutes rather than hourly: a refusal comes back in seconds, and the sooner a
   * dead address is known the fewer letters are sent into it. Cheap when there is nothing new —
   * one IMAP connection per configured mailbox, fetching only UIDs above the last bookmark — and
   * a mailbox with no IMAP configured is not visited at all.
   *
   * No catch-up on boot: a sweep IS its own catch-up, because the bookmark is where it left off.
   */
  registerJob({
    name: "read-bounces",
    cronExpr: "*/15 * * * *",
    run: async () => {
      const results = await sweepBounces();
      for (const r of results) {
        if (r.error) app.log.error({ mailbox: r.mailbox, err: r.error }, "mailbox unreadable");
        else if (r.matched || r.retired) app.log.info({ ...r }, "delivery reports applied");
      }
    },
  });

  /**
   * Close out sends that died mid-flight.
   *
   * Delivery runs in the background after the response returns, so a restart leaves whatever it
   * had not reached at `queued` — reading as still in flight, forever. This is the sweep that
   * turns that into a definite `failed` a person can act on. It runs on BOOT as well as on a
   * timer, because the commonest way a send dies is the deploy that just restarted this process.
   */
  const closeStalledSends = async (label: string) => {
    const { closed } = await sweepStalledSends();
    if (closed > 0) app.log.warn({ closed, label }, "abandoned mailout rows closed as failed");
  };
  registerJob({
    name: "stalled-send-sweep",
    cronExpr: "*/10 * * * *",
    run: () => closeStalledSends("run"),
    catchUp: () => closeStalledSends("boot"),
  });

  /**
   * S9 job: the five triggers that are facts about the PASSAGE OF TIME rather than about somebody
   * doing something — a deadline arriving, a meeting being today, an invoice going past its due
   * day, a timer nobody stopped, a mailbox that stopped answering.
   *
   * After the working day starts, and AFTER the 03:05 task sweep and the 03:20 invoice sweep, so
   * the day's generated work already exists when deadlines are scanned — which is why the setting
   * refuses anything before 04:00. It is also when the night's sweep failures are reported, which is the only reason a
   * person hears about one.
   *
   * `catchUp` is deliberately NOT defined, and this is the only job in the app that has none.
   * Unlike an invoice, a missed notification has no value the next morning: "your meeting is
   * today" is wrong by then, and `task_overdue` is raised by the next ordinary run anyway. Every
   * other job here defines `catchUp`; this one states why it does not.
   *
   * Note for the day a second app container exists: the in-process jobs have no leader election,
   * so this would double-run. Its writes are idempotent through `dedupKey`, so the cost is
   * duplicated queries and not duplicated mail — but it is one more entry on that list.
   */
  /**
   * The hour comes from the FIRM now, not from this file. Read once at boot; the settings screen
   * reschedules the job when somebody changes it, so a restart is never needed for it to take.
   */
  const firmSweepAt = (
    await prisma.firmProfile.findUnique({
      where: { id: 1 },
      select: { notifySweepAt: true },
    })
  )?.notifySweepAt;

  registerJob({
    name: "notification-sweep",
    cronExpr: sweepCron(firmSweepAt),
    run: async () => {
      try {
        const { raised, skipped } = await runNotificationSweep();
        if (raised > 0) app.log.info({ raised }, "notifications raised");
        if (skipped > 0) app.log.error({ skipped }, "notification sweep skipped items");
      } catch (err) {
        app.log.error({ err }, "notification sweep failed");
      }
    },
  });

  /**
   * The module's second job, and the only frequent one: a reminder a few minutes before a meeting
   * that was booked with one.
   *
   * EVERY MINUTE, and it has to be. A five-minute reminder cannot be honoured by a job that wakes
   * every five — it would fire between five and ten minutes early, or miss entirely. The cost is
   * one indexed query over an hour-wide window, which is a handful of rows here.
   *
   * No `catchUp`, for the same reason the nightly sweep has none: a reminder for a meeting that
   * has already started is not a reminder. The pass itself skips anything past its start.
   *
   * One more entry on the "no leader election" list for the day a second container exists — but
   * the writes are idempotent through `dedupKey`, so a double run costs queries, not two chimes.
   */
  registerJob({
    name: "meeting-reminders",
    cronExpr: "* * * * *",
    run: async () => {
      try {
        const { raised, skipped } = await runMeetingReminders();
        if (raised > 0) app.log.info({ raised }, "meeting reminders raised");
        if (skipped > 0) app.log.error({ skipped }, "meeting reminder pass skipped items");
      } catch (err) {
        app.log.error({ err }, "meeting reminder pass failed");
      }
    },
  });

  /**
   * Housekeeping, in the shape `sessions:cleanup` already uses: read notifications older than 90
   * days go. Unread rows are never purged at any age — a notification nobody has seen has not
   * done its job yet. This is the first retention rule in the product (S9 §8.2).
   */
  registerJob({
    name: "notifications:retention",
    cronExpr: "10 4 * * *", // just after the session purge, on the same quiet hour
    run: async () => {
      const { purged } = await purgeOldNotifications();
      if (purged > 0) app.log.info({ purged }, "read notifications purged");
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
