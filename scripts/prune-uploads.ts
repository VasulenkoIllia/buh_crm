import { prisma, disconnectDb } from "../server/core/db.js";
import { record, runWithActivity } from "../server/core/activity.js";
import {
  deleteStoredFile,
  listStoredFiles,
  storageConfigured,
  type FileStorage,
} from "../server/core/files.js";

/**
 * Delete the bytes of every upload the database no longer knows about, in every store this server
 * can reach: the uploads directory, and the files bucket once it is configured.
 *
 * Replaces the `rm -rf /app/uploads/*` a `--reset` deploy used to run. That was correct only while
 * the reset wiped the File table whole; now it keeps the team's avatars and the firm's two logos
 * (see `scripts/reset-data.sql`), and a blanket rm would delete the very files those kept rows
 * point at — leaving a FirmProfile with a logo that 404s.
 *
 * Runs AFTER the deploy, not during the reset: the reset executes before the pull, against the
 * image already on the server, so a script added in the same commit would not be there yet.
 *
 * Through `core/files.ts` only, so it prunes a bucket exactly as it prunes a directory. On the
 * bucket a delete leaves a marker and the hidden version stays 30 days, and the nightly mirror
 * counts these deletions against its `--max-delete` (backups.md §7.9).
 *
 * Safe to run any time — it only ever removes what nothing references.
 */
async function main() {
  const rows = await prisma.file.findMany({ select: { path: true, storage: true } });
  const known = new Set(rows.map((f) => `${f.storage}:${f.path}`));

  let removed = 0;
  let removedBytes = 0;
  let kept = 0;

  const stores: readonly FileStorage[] = ["local", "s3"];
  for (const storage of stores) {
    if (!storageConfigured(storage)) continue;
    for await (const { key, size } of listStoredFiles(storage)) {
      if (known.has(`${storage}:${key}`)) {
        kept++;
        continue;
      }
      await deleteStoredFile({ storage, path: key });
      removed++;
      removedBytes += size;
    }
  }

  const mb = (removedBytes / 1024 / 1024).toFixed(1);
  console.log(`uploads pruned: ${removed} file(s) removed (${mb} MB), ${kept} kept`);
  /**
   * Only when it removed something. This script deletes client documents' bytes — the last trace
   * of a file after its row is gone — which is a disposal record, so it is kept for seven years
   * like the rest of them (activity-log.md §3.3, §11). A run that found nothing to do is not an act.
   */
  if (removed > 0) {
    record("file.bytes_pruned", { changes: { removed, bytes: removedBytes } });
  }

  const orphanRows = rows.length - kept;
  if (orphanRows > 0) {
    console.warn(
      `⚠ ${orphanRows} File row(s) point at bytes that are in no store this server can see — ` +
        `they will fail on download.`,
    );
  }
}

runWithActivity({ actor: { kind: "system", label: "The uploads prune" } }, main)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => disconnectDb());
