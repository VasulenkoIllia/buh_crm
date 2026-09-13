import { runWithActivity } from "../server/core/activity.js";
import { config } from "../server/core/config.js";
import { disconnectDb } from "../server/core/db.js";
import { moveFilesToBucket } from "../server/core/file-move.js";

/**
 * Stage A's move (files.md §15.0, step 5): every file still on disk goes into the files bucket, the
 * avatars and the logos too, and its row says so. In the container, after the deploy that gives
 * the server its bucket:
 *
 *   docker compose exec -T app npx tsx scripts/move-files-to-bucket.ts --dry-run
 *   docker compose exec -T app npx tsx scripts/move-files-to-bucket.ts
 *
 * The dry run reads and opens every file on disk and asks the bucket once, and changes nothing. The
 * real run copies each file, proves the copy, and only then repoints its row
 * (`server/core/file-move.ts`); run twice, the second finds nothing, and two runs never overlap:
 * the second refuses at once. It prints ids, never names.
 *
 * Before the nightly mirror of the bucket is installed (step 6), so no half-moved object is ever
 * copied into the backups. The copies on disk stay until step 7 retires the directory — and
 * `scripts/prune-uploads.ts` would count them as orphans and remove them, so it is not run between.
 */
const USAGE = "usage: npx tsx scripts/move-files-to-bucket.ts [--dry-run]";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run")) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const dryRun = args.includes("--dry-run");
  if (config.FILES_STORAGE !== "s3") {
    console.warn(
      "⚠ FILES_STORAGE is local: new files still go to disk, and would need a run of their own.",
    );
  }

  const s = await moveFilesToBucket({ dryRun });
  if (dryRun) {
    console.log(
      `dry run: ${s.found} file(s) on disk, ${s.plain} of them stored before encryption; ` +
        `${s.found - s.unreadable} read and opened, ${s.unreadable} could not be. ` +
        "The bucket answers. Nothing was changed.",
    );
    if (s.unreadable > 0) process.exitCode = 1;
    return;
  }
  if (s.found === 0) {
    console.log("Nothing is on disk: every file is in the bucket already.");
    return;
  }
  console.log(
    `moved ${s.moved} file(s), ${mb(s.bytes)}; left on disk after an error: ${s.failed}; ` +
      `deleted or replaced meanwhile: ${s.changed}.`,
  );
  if (s.failed > 0) process.exitCode = 1;
}

runWithActivity({ actor: { kind: "system", label: "The move into the files bucket" } }, main)
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
