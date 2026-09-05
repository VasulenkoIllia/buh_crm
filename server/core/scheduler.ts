import cron, { type ScheduledTask } from "node-cron";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";

// In-process scheduler skeleton (S0). Jobs land per stage:
//   S6 — subscription task generation · S7 — per-period invoices
//   S9 — notification triggers. (S10 shipped without a job: mailouts are sent by a person,
//   never on a timer — scheduled campaigns are a later round.)
//
// Contract (decision 2026-07-17):
//   - every job is IDEMPOTENT (unique keys in the DB, insert-or-skip);
//   - `catchUp` runs once on startup and generates ALL missed periods
//     (nothing is lost to downtime);
//   - jobs are isolated functions so they can move to a worker container later.

export interface SchedulerJob {
  name: string;
  /** cron expression, evaluated in the firm timezone (config.TZ). Mutable: see `rescheduleJob`. */
  cronExpr: string;
  run: () => Promise<void>;
  /** startup catch-up for missed periods; optional for non-generating jobs */
  catchUp?: () => Promise<void>;
}

const jobs: SchedulerJob[] = [];
/**
 * Keyed by NAME, not a bare list.
 *
 * It was an array, which was enough while every schedule was a constant in `server.ts`. Since the
 * firm can choose when the notification sweep runs (S9.2), one job has to be found and replaced
 * while the process keeps running — and a list of anonymous handles cannot say which one.
 */
const scheduled = new Map<string, ScheduledTask>();
let logger: FastifyBaseLogger | null = null;

export function registerJob(job: SchedulerJob) {
  jobs.push(job);
}

/** One place that turns a job into a running cron task, so start and reschedule cannot diverge. */
function schedule(job: SchedulerJob, log: FastifyBaseLogger): ScheduledTask {
  return cron.schedule(
    job.cronExpr,
    () => {
      job.run().catch((err) => log.error({ job: job.name, err }, "scheduler job failed"));
    },
    // pin the firm timezone explicitly — don't rely on the container's TZ env matching
    { timezone: config.TZ },
  );
}

export async function startScheduler(log: FastifyBaseLogger) {
  logger = log;
  for (const job of jobs) {
    if (job.catchUp) {
      try {
        await job.catchUp();
        log.info({ job: job.name }, "scheduler catch-up done");
      } catch (err) {
        log.error({ job: job.name, err }, "scheduler catch-up failed");
      }
    }
    scheduled.set(job.name, schedule(job, log));
    log.info({ job: job.name, cron: job.cronExpr }, "scheduler job registered");
  }
}

/**
 * Move a running job to a new time, without a restart.
 *
 * The order is the whole of it: **validate, then start the new one, then stop the old**. Stopping
 * first and failing to start would leave the job simply gone — silently, until somebody noticed
 * that nothing had been notified for a week. `node-cron` throws on a malformed expression rather
 * than returning anything, so the validation has to happen before the old task is touched.
 *
 * Returns false when the expression is refused; the caller decides whether that is an error worth
 * showing. A job the scheduler has never started is not rescheduled either — on a test process
 * that never called `startScheduler`, there is nothing running to move.
 */
export function rescheduleJob(name: string, cronExpr: string): boolean {
  const job = jobs.find((j) => j.name === name);
  if (!job) return false;
  if (!cron.validate(cronExpr)) return false;

  job.cronExpr = cronExpr;
  const running = scheduled.get(name);
  if (!running || !logger) return true; // registered but not started (tests) — the new value stands

  const replacement = schedule(job, logger);
  scheduled.set(name, replacement);
  void running.stop();
  logger.info({ job: name, cron: cronExpr }, "scheduler job rescheduled");
  return true;
}

export async function stopScheduler() {
  for (const task of scheduled.values()) {
    await task.stop();
  }
  scheduled.clear();
  logger = null;
}
