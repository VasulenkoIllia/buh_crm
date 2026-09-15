import { disconnectDb } from "../server/core/db.js";
import { checkFileBytes, filesReport } from "../server/modules/files/index.js";

/**
 * **Where every file is, and whether it belongs there** (files.md §15.3). Run it before and after a
 * deploy that moves files, in the container:
 *
 *   docker compose exec -T app npx tsx scripts/check-files.ts           where each file is
 *   docker compose exec -T app npx tsx scripts/check-files.ts --bytes   and every file opened
 *
 * Locally: `npx tsx --env-file=.env scripts/check-files.ts`. It changes nothing and names files by
 * id alone. It exits 1 when a file is where it cannot be right, or does not open.
 */
const USAGE = "usage: npx tsx scripts/check-files.ts [--bytes]";

const WHY = {
  missing: "missing from its store",
  key: "its key does not open with this server's SECRETS_KEY",
  damaged: "damaged, or not the size its row records",
  unreachable: "its store could not be read",
} as const;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--bytes")) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const r = await filesReport();
  console.log(
    `Files: ${r.files} (${mb(r.bytes)}). On the server's disk: ${r.onDisk}. In the bucket: ` +
      `${r.inBucket}. Stored before encryption: ${r.beforeEncryption}.`,
  );
  console.log(
    `In the Trash: ${r.trashed}. With archived clients, hidden: ${r.withArchivedClients}.`,
  );
  console.log("Where the live files belong:");
  if (r.places.length === 0) console.log("      0  no live files");
  for (const p of r.places) console.log(`  ${String(p.count).padStart(5)}  ${p.label}`);
  for (const [title, items] of [
    ["Problems", r.problems],
    ["Worth a look", r.notes],
  ] as const) {
    console.log(`${title}:${items.length === 0 ? " none" : ""}`);
    for (const i of items) console.log(`  ${i.ids.length}  ${i.what}: ${i.ids.join(", ")}`);
  }

  let unopened = 0;
  if (args.includes("--bytes")) {
    const b = await checkFileBytes();
    unopened = b.failed.length;
    console.log(`Opened and matched their size: ${b.opened} of ${b.opened + unopened}.`);
    for (const f of b.failed) console.log(`  ${f.id} (${f.storage}): ${WHY[f.why]}`);
  }

  const ok = r.problems.length === 0 && unopened === 0;
  console.log(ok ? "All good." : "Something needs a look: see above.");
  if (!ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
