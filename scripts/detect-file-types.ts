import { disconnectDb } from "../server/core/db.js";
import { detectStoredTypes } from "../server/modules/files/index.js";

/**
 * Stage C's one-off (files.md §12.2, §15.1): read the type of every file stored before stage C from
 * its bytes, so what may open in the CRM is decided by what each file is. Run once after the deploy
 * that brings stage C, in the container:
 *
 *   docker compose exec -T app npx tsx scripts/detect-file-types.ts --dry-run
 *   docker compose exec -T app npx tsx scripts/detect-file-types.ts
 *
 * Locally: `npx tsx --env-file=.env scripts/detect-file-types.ts`. It reads each file, decrypted,
 * and writes only its type. A second run finds nothing new to write. It prints ids, never names.
 * Until it has run, the files stored before simply download, as they always did.
 */
const USAGE = "usage: npx tsx scripts/detect-file-types.ts [--dry-run]";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run")) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const dryRun = args.includes("--dry-run");
  const r = await detectStoredTypes({ dryRun });
  console.log(
    `${r.read} file(s) read: ${r.typed} typed${dryRun ? " (a dry run: nothing written)" : ""}, ` +
      `${r.downloads} left as downloads, ${r.failed} could not be read.`,
  );
  if (r.failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
