/**
 * What each scheduled job did last time, kept where somebody can read it.
 *
 * This replaces `sweep-health.ts`, an in-process Map, and the reason for the change is the caveat
 * that module wrote down about itself: a process that crashed between a failed sweep and the
 * morning run lost the alert entirely. It also could not answer the more basic question — "did the
 * job run at all?" — because a job that never ran recorded nothing, which is exactly what a job
 * that ran perfectly also recorded.
 *
 * ONE WRITER: the scheduler, in `schedule()`. Jobs do not record their own health — they return an
 * outcome and the wrapper stores it. That is what makes the table complete by construction: a job
 * added next year is covered without anybody remembering to instrument it, which is precisely what
 * nobody remembered to do for the first nine (docs/modules/system.md).
 *
 * Failures here are SWALLOWED. This table is the observer, and an observer that can break the
 * thing it observes is worse than no observer: a job must not fail because recording its success
 * failed.
 */
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "./db.js";

/** What a job may tell the scheduler about the run that just finished. */
export interface JobOutcome {
  /**
   * One short line in the firm's language — "12 tasks created", not `{created: 12}`.
   * Shown as-is on the System screen, so it is written for a reader, not a grep.
   */
  note?: string;
  /**
   * Work the run finished WITHOUT doing. A partial failure, not a crash: the generating sweeps
   * isolate per item on purpose, so one client's bad row cannot stop the firm's billing run.
   */
  skipped?: number;
}

/** A job's `run()` may return nothing, as most do, or say what it did. */
export type JobRunResult = void | JobOutcome;

/** Longest error kept. A stack trace is not what this column is for, and rows stay small. */
const MAX_ERROR = 500;

/**
 * Strip credentials out of an error before it is stored.
 *
 * `lastError` is written to a table and rendered on a screen, and Prisma quotes the datasource URL
 * back at you when it cannot reach the database — password included. Admin-only is not an argument
 * for storing a password in a second place; the host and the failure are what a person needs, and
 * they survive this.
 */
export function redactError(message: string): string {
  return message.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//***:***@").slice(0, MAX_ERROR);
}

/** The process's own start, so "has never run" can be told from "is not due yet". */
const bootedAt = new Date();
export function processBootedAt(): Date {
  return bootedAt;
}

/**
 * Record one finished run.
 *
 * `unreported` ACCUMULATES while `lastSkipped` replaces: the first is a debt owed to whoever has
 * not been told yet, the second is a description of the last run. Conflating them would either
 * report the same bad night every morning or lose the nights nobody drained.
 */
export async function recordJobRun(
  name: string,
  result: {
    ok: boolean;
    durationMs: number;
    note?: string | null;
    skipped?: number;
    error?: string | null;
  },
): Promise<void> {
  const now = new Date();
  const skipped = result.skipped ?? 0;
  // a run that threw is a whole failed run, and is worth telling somebody about as one item
  const owed = result.ok ? skipped : Math.max(skipped, 1);

  const shared = {
    lastDurationMs: result.durationMs,
    lastSkipped: skipped,
    lastNote: result.note ?? null,
    lastError: result.error ? redactError(result.error) : null,
  } satisfies Partial<Prisma.JobHealthUncheckedCreateInput>;

  try {
    await prisma.jobHealth.upsert({
      where: { name },
      create: {
        name,
        ...shared,
        ...(result.ok
          ? { lastOkAt: now, failStreak: 0 }
          : { lastFailedAt: now, failStreak: 1 }),
        unreported: owed,
      },
      update: {
        ...shared,
        ...(result.ok
          ? { lastOkAt: now, failStreak: 0 }
          : { lastFailedAt: now, failStreak: { increment: 1 } }),
        ...(owed > 0 ? { unreported: { increment: owed } } : {}),
      },
    });
  } catch (err) {
    // The job itself already succeeded, or already logged its own failure; losing a health row
    // must not turn that into an incident. But total silence would hide the one cause worth
    // knowing about — the table not being there, because a deploy skipped its migration — and
    // the symptom of that is every job on the System tab reading "Waiting for its first run"
    // forever. Once per process: this is called on every tick of a job that runs every minute.
    if (!warnedOnce) {
      warnedOnce = true;
      console.error(
        "[job-health] could not record a job run — the System tab will be blank:",
        err,
      );
    }
  }
}

/** One line per process, not 1 440 a day from the per-minute job. */
let warnedOnce = false;

export interface SweepFailure {
  /** the job's own name, as `registerJob` knows it */
  sweep: string;
  count: number;
  /**
   * When the row was last WRITTEN — successful runs included, not only the failure.
   *
   * The caller buckets the report by this day. That is deliberate and safe in the direction it
   * errs: a debt carried past midnight by a job that has since run gets a LATER day, which is a
   * fresh dedup key and therefore reported rather than swallowed. Not named `lastFailedAt`,
   * because a `skipped` count comes from a run that SUCCEEDED and sets no such stamp.
   */
  lastAt: Date;
}

/**
 * Take every un-reported failure and mark it told.
 *
 * Draining rather than reading is what stops one bad night being reported every morning
 * afterwards: the next report only happens if a job fails again.
 *
 * It **decrements by what it read** rather than setting zero, and that is not fussiness. Reading
 * and clearing are two round trips, and a job that fails in between would have its debt wiped
 * without anybody being told — a lost alert, which is the exact failure this whole table exists to
 * prevent. `decrement` is applied by Postgres as `unreported = unreported - N`, so a failure that
 * lands in the gap survives it and is reported by the next run.
 *
 * The `gte` guard is the other half: if a second process drained first, the row no longer holds
 * what this one read, no rows match, and the count cannot go negative and start masking real
 * failures. A duplicate NOTIFICATION in that case is stopped one layer up, by the dedup key —
 * not here.
 */
export async function drainSweepFailures(): Promise<SweepFailure[]> {
  try {
    const rows = await prisma.jobHealth.findMany({
      where: { unreported: { gt: 0 } },
      select: { name: true, unreported: true, updatedAt: true },
    });
    if (rows.length === 0) return [];
    await prisma.$transaction(
      rows.map((r) =>
        prisma.jobHealth.updateMany({
          where: { name: r.name, unreported: { gte: r.unreported } },
          data: { unreported: { decrement: r.unreported } },
        }),
      ),
    );
    return rows.map((r) => ({ sweep: r.name, count: r.unreported, lastAt: r.updatedAt }));
  } catch {
    return [];
  }
}

/** Everything the System screen shows. Nine rows; no paging, no filter, nothing to scope. */
export function readJobHealth() {
  return prisma.jobHealth.findMany({ orderBy: { name: "asc" } });
}

/** Tests only — the table is process-wide state, so a suite must be able to start clean. */
export async function resetJobHealth(): Promise<void> {
  await prisma.jobHealth.deleteMany({});
}
