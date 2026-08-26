import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../server/core/config.js";
import { prisma, disconnectDb } from "../server/core/db.js";

/**
 * Delete the bytes of every upload the database no longer knows about.
 *
 * Replaces the `rm -rf /app/uploads/*` a `--reset` deploy used to run. That was correct only while
 * the reset wiped the File table whole; now it keeps the team's avatars and the firm's two logos
 * (see `scripts/reset-data.sql`), and a blanket rm would delete the very files those kept rows
 * point at — leaving a FirmProfile with a logo that 404s.
 *
 * Runs AFTER the deploy, not during the reset: the reset executes before the pull, against the
 * image already on the server, so a script added in the same commit would not be there yet.
 *
 * Safe to run any time — it only ever removes what nothing references.
 */
async function main() {
  const root = resolve(config.UPLOADS_DIR);
  const known = new Set(
    (await prisma.file.findMany({ select: { path: true } })).map((f) => f.path),
  );

  let removed = 0;
  let removedBytes = 0;
  let kept = 0;

  // one level of YYYY-MM directories, then the files inside them (see saveFileBytes)
  const months = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const month of months) {
    if (!month.isDirectory()) continue;
    const dir = join(root, month.name);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      // File.path is stored relative to the uploads root, with a POSIX separator
      if (known.has(`${month.name}/${entry.name}`)) {
        kept++;
        continue;
      }
      const abs = join(dir, entry.name);
      removedBytes += (await stat(abs)).size;
      await rm(abs);
      removed++;
    }
    // drop the month directory once it is empty
    if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true });
  }

  const mb = (removedBytes / 1024 / 1024).toFixed(1);
  console.log(`uploads pruned: ${removed} file(s) removed (${mb} MB), ${kept} kept`);

  const orphanRows = [...known].length - kept;
  if (orphanRows > 0) {
    console.warn(
      `⚠ ${orphanRows} File row(s) point at bytes that are not on the volume — ` +
        `they will 404 on download.`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => disconnectDb());
