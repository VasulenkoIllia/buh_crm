import cron, { type ScheduledTask } from "node-cron";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { recordJobRun, type JobRunResult } from "./job-health.js";

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
  /**
   * Returns nothing, or an outcome for the System screen — a one-line note in the firm's language
   * and the count of items it finished without doing. Optional by design: a job that says nothing
   * is still recorded as having run, which is the question that screen mostly answers.
   */
  run: () => Promise<JobRunResult>;
  /** startup catch-up for missed periods; optional for non-generating jobs */
  catchUp?: () => Promise<JobRunResult>;
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

/**
 * Run a job once and record what happened.
 *
 * THE single writer of `JobHealth`, and that is the whole design: a job added next year is on the
 * System screen without anybody remembering to instrument it. Instrumenting each job by hand is
 * what was not done for the first nine, which is how the module ended up unable to say whether its
 * own sweep had run (docs/modules/system.md).
 *
 * A job that throws is still recorded, then re-thrown into the log exactly as before — this
 * wrapper adds a record, it does not change what a failure does.
 */
async function runOnce(job: SchedulerJob, log: FastifyBaseLogger): Promise<void> {
  const started = Date.now();
  try {
    const outcome = await job.run();
    await recordJobRun(job.name, {
      ok: true,
      durationMs: Date.now() - started,
      note: outcome?.note,
      skipped: outcome?.skipped,
      did: outcome?.did,
    });
  } catch (err) {
    await recordJobRun(job.name, {
      ok: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    log.error({ job: job.name, err }, "scheduler job failed");
  }
}

/** One place that turns a job into a running cron task, so start and reschedule cannot diverge. */
function schedule(job: SchedulerJob, log: FastifyBaseLogger): ScheduledTask {
  return cron.schedule(
    job.cronExpr,
    () => {
      void runOnce(job, log);
    },
    // pin the firm timezone explicitly — don't rely on the container's TZ env matching
    { timezone: config.TZ },
  );
}

export async function startScheduler(log: FastifyBaseLogger) {
  logger = log;
  for (const job of jobs) {
    if (job.catchUp) {
      /**
       * A SUCCESSFUL catch-up is deliberately not recorded: it is the boot doing the job's work
       * for it, and stamping `lastOkAt` would make a job that has been dead for a week look
       * healthy for as long as somebody keeps redeploying.
       *
       * A FAILED one is recorded, because it is a real failure of that job and hides nothing —
       * and without it a job that breaks on boot would stay invisible until its next scheduled
       * run, which for a nightly job is up to a day away.
       */
      const started = Date.now();
      try {
        await job.catchUp();
        log.info({ job: job.name }, "scheduler catch-up done");
      } catch (err) {
        await recordJobRun(job.name, {
          ok: false,
          durationMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
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
