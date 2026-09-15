import { readStoredFile } from "../../core/files.js";
import * as repo from "./files.repository.js";
import { sniff } from "./files.types.js";

/**
 * **Stage C's one-off: the type of every file stored before types were read** (files.md §12.2,
 * §15.1). Each file is read through `core/files.ts`, so decrypted, and its bytes are looked at with
 * the rules an upload uses. Nothing is refused here: the file is already kept, and what its type
 * decides is only whether it may open in the CRM. A file whose bytes name nothing the CRM shows
 * stays null, a download, and is looked at again on a later run; within one run each file is read
 * once, by id.
 */
export async function detectStoredTypes(
  options: { dryRun?: boolean; log?: (line: string) => void } = {},
) {
  const log = options.log ?? console.error;
  const counts = { read: 0, typed: 0, downloads: 0, failed: 0 };
  let after: string | null = null;
  for (;;) {
    const page = await repo.untypedFiles(after, 100);
    if (page.length === 0) break;
    for (const file of page) {
      after = file.id;
      counts.read++;
      try {
        const { mime } = await sniff(await readStoredFile(file), file.name);
        if (!mime) {
          counts.downloads++;
          continue;
        }
        counts.typed++;
        if (!options.dryRun) await repo.setDetectedMime(file.id, mime);
      } catch (error) {
        counts.failed++;
        log(
          `could not read ${file.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return counts;
}
