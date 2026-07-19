import cron, { type ScheduledTask } from "node-cron";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";

// In-process scheduler skeleton (S0). Jobs land per stage:
//   S6 — subscription task generation · S7 — per-period invoices
//   S9 — notification triggers · S10 — campaigns/reminders
//
// Contract (decision 2026-07-17):
//   - every job is IDEMPOTENT (unique keys in the DB, insert-or-skip);
//   - `catchUp` runs once on startup and generates ALL missed periods
//     (nothing is lost to downtime);
//   - jobs are isolated functions so they can move to a worker container later.

export interface SchedulerJob {
  name: string;
  /** cron expression, evaluated in the firm timezone (config.TZ) */
  cronExpr: string;
  run: () => Promise<void>;
  /** startup catch-up for missed periods; optional for non-generating jobs */
  catchUp?: () => Promise<void>;
}

const jobs: SchedulerJob[] = [];
const scheduled: ScheduledTask[] = [];

export function registerJob(job: SchedulerJob) {
  jobs.push(job);
}

export async function startScheduler(log: FastifyBaseLogger) {
  for (const job of jobs) {
    if (job.catchUp) {
      try {
        await job.catchUp();
        log.info({ job: job.name }, "scheduler catch-up done");
      } catch (err) {
        log.error({ job: job.name, err }, "scheduler catch-up failed");
      }
    }
    const task = cron.schedule(
      job.cronExpr,
      () => {
        job.run().catch((err) => log.error({ job: job.name, err }, "scheduler job failed"));
      },
      // pin the firm timezone explicitly — don't rely on the container's TZ env matching
      { timezone: config.TZ },
    );
    scheduled.push(task);
    log.info({ job: job.name, cron: job.cronExpr }, "scheduler job registered");
  }
}

export async function stopScheduler() {
  for (const task of scheduled) {
    await task.stop();
  }
  scheduled.length = 0;
}
