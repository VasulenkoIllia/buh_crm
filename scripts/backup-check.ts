/**
 * Check the backups NOW, instead of at 03:50 — and put the answer on Settings → System.
 *
 *   docker compose exec -T app npx tsx scripts/backup-check.ts
 *
 * The `backup:watchdog` job runs once a day, which is right for a nightly backup and wrong on two
 * days: the day a server is set up, when the row would stay empty until the next morning, and the
 * day a failed night is put right, when it would stay red. This runs the same check once and
 * records it exactly as the scheduler does, so the row and the morning report agree with it.
 *
 * Not from deploy.sh: an evening deploy would read last night's backup as more than 20 hours old
 * and paint a healthy system red — the same reason the job has no catch-up on boot.
 */
import { checkBackups } from "../server/core/backup-status.js";
import { disconnectDb } from "../server/core/db.js";
import { recordJobRun } from "../server/core/job-health.js";

const started = Date.now();
let exitCode = 0;
try {
  const note = await checkBackups();
  await recordJobRun("backup:watchdog", { ok: true, durationMs: Date.now() - started, note });
  console.log(`✓ ${note}`);
} catch (err) {
  // A red answer here is a real one: recorded as a failed run, it is on tomorrow's report too.
  const error = err instanceof Error ? err.message : String(err);
  await recordJobRun("backup:watchdog", { ok: false, durationMs: Date.now() - started, error });
  console.log(`✗ ${error}`);
  exitCode = 1;
} finally {
  await disconnectDb();
}
process.exit(exitCode);
