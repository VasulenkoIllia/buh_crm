/**
 * What the nightly sweeps could not do, held until somebody is told.
 *
 * The generating sweeps isolate failures per item on purpose — one client's bad row must not stop
 * the firm's billing run — and report the count to `app.log`. That is correct and it is also
 * invisible: nobody reads the log, and a client who quietly stops being billed looks exactly like
 * a client with nothing due.
 *
 * IN MEMORY, and deliberately so. There is no table because there is nothing else to read one:
 * the notification sweep runs at 07:00, takes what has accumulated since it last looked, and
 * clears it. A restart forgetting the record is the same choice the notification sweep already
 * makes by defining no `catchUp` — a missed alert has no value the next morning, and the failure
 * itself is idempotent: whatever failed is retried on the next run and reported again if it fails
 * again (docs/modules/notifications.md §8.1).
 *
 * The cost of that choice, stated plainly: a process that crashes between a failed sweep and 07:00
 * loses the alert. The sweep will fail again the next night and raise it then.
 */

export interface SweepFailure {
  /** the job's own name, as `registerJob` knows it */
  sweep: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
}

const failures = new Map<string, SweepFailure>();

/** Called by a sweep that finished having skipped work it could not do. */
export function recordSweepFailure(sweep: string, count = 1) {
  if (count <= 0) return;
  const now = new Date();
  const existing = failures.get(sweep);
  if (existing) {
    existing.count += count;
    existing.lastAt = now;
    return;
  }
  failures.set(sweep, { sweep, count, firstAt: now, lastAt: now });
}

/**
 * Take everything recorded and forget it.
 *
 * Draining rather than reading is what stops one bad night from being reported every morning
 * afterwards: the next report only happens if the sweep fails again.
 */
export function drainSweepFailures(): SweepFailure[] {
  const out = [...failures.values()];
  failures.clear();
  return out;
}

/** Tests only — the module holds process-wide state, so a suite must be able to start clean. */
export function resetSweepFailures() {
  failures.clear();
}
