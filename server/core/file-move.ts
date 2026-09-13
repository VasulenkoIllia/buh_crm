import { record } from "./activity.js";
import { prisma } from "./db.js";
import {
  copyFileToBucket,
  deleteStoredFile,
  listStoredFiles,
  readStoredFile,
  storageConfigured,
  type FileStore,
} from "./files.js";
import { secretsConfigured } from "./secrets-crypto.js";

/**
 * Stage A's move (files.md §15.0, step 5): every file still on disk goes into the files bucket, row
 * by row, while the CRM runs.
 *
 * - **A copy is proven before anything points at it** (`copyToBucket`: read back from the bucket,
 *   opened, compared by SHA-256), and only then does the row say `s3`. Until that moment the row
 *   points at the disk, so a reader never meets a file that is in neither place.
 * - **A row changes only if it is still the one that was copied.** A file deleted or replaced while
 *   its copy was made keeps nothing, and the copy is removed again.
 * - **Two runs never overlap.** Each would seal a legacy file with a key of its own under the same
 *   object key, and the later one could leave a row naming one key over the other's object, or over
 *   no object at all (code review, 2026-09-14). A real run holds a Postgres advisory lock from
 *   before it reads the rows to its last update, and a second one refuses at once.
 * - **Idempotent.** A moved row says `s3`, so a second run finds nothing. A run cut short leaves each
 *   row either moved or on disk; the next one copies the rest, and rewrites any object the cut-short
 *   run had put but not yet recorded — which is why it runs before the nightly mirror of the bucket
 *   is installed (§15.0, step 6), whose `--immutable` refuses a changed object.
 * - **The copies on disk stay** until the directory is retired (§15.0, step 7).
 */

/** What the move uses of the file store: the production one, or a test's with a fake bucket. */
export type MoveStore = Pick<FileStore, "copyToBucket" | "remove" | "read" | "has" | "list">;

const productionStore: MoveStore = {
  copyToBucket: copyFileToBucket,
  remove: deleteStoredFile,
  read: readStoredFile,
  has: storageConfigured,
  list: listStoredFiles,
};

/** The advisory lock's name. A transaction holds it, so it ends with the transaction or the process. */
export const MOVE_LOCK = "buh_crm/files/move";
/** Far longer than a run takes; past it the transaction ends, and the lock with it. */
const RUN_LIMIT_MS = 2 * 60 * 60 * 1000;

export interface MoveOptions {
  /** Reads and opens every file on disk and asks the bucket once; changes nothing. */
  dryRun: boolean;
  store?: MoveStore;
  /** The rows to consider, all of them when absent. The tests share one database with others. */
  only?: readonly string[];
  /** One line a file, by id — never by name. */
  log?: (line: string) => void;
}

export interface MoveSummary {
  /** rows on disk when the run began */
  found: number;
  /** of them, stored before encryption: these are sealed on the way */
  plain: number;
  /** a dry run's: files on disk that could not be read or opened */
  unreadable: number;
  moved: number;
  /** the moved files' own size, as their rows record it */
  bytes: number;
  /** left on disk: the copy could not be made, or failed its proof */
  failed: number;
  /** deleted or replaced while their copy was made */
  changed: number;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

function rowsOnDisk(only: readonly string[] | undefined) {
  return prisma.file.findMany({
    where: { storage: "local", ...(only ? { id: { in: [...only] } } : {}) },
    select: {
      id: true,
      path: true,
      storage: true,
      wrappedKey: true,
      keyVersion: true,
      size: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

function summaryOf(rows: Awaited<ReturnType<typeof rowsOnDisk>>): MoveSummary {
  return {
    found: rows.length,
    plain: rows.filter((row) => row.wrappedKey === null).length,
    unreadable: 0,
    moved: 0,
    bytes: 0,
    failed: 0,
    changed: 0,
  };
}

async function whileHoldingTheMoveLock<T>(fn: () => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      const taken = await tx.$queryRaw<{ locked: boolean }[]>`
        select pg_try_advisory_xact_lock(hashtext(${MOVE_LOCK})) as locked`;
      if (!taken[0]?.locked) throw new Error("Another move is running: this one did nothing");
      return fn();
    },
    { timeout: RUN_LIMIT_MS },
  );
}

export async function moveFilesToBucket(options: MoveOptions): Promise<MoveSummary> {
  const { dryRun, store = productionStore, only, log = console.log } = options;
  if (!store.has("s3")) {
    throw new Error("This server has no files bucket: the FILES_S3_* settings are missing");
  }

  if (dryRun) {
    const rows = await rowsOnDisk(only);
    const summary = summaryOf(rows);
    for (const row of rows) {
      try {
        await store.read(row);
      } catch (err) {
        summary.unreadable++;
        log(`✗ ${row.id} (${row.path}): ${reason(err)}`);
      }
    }
    // one listing request: the key is accepted, and may list the bucket
    const listing = store.list("s3")[Symbol.asyncIterator]();
    try {
      await listing.next();
    } finally {
      await listing.return?.();
    }
    return summary;
  }

  // an object, not a variable: what the run gets to is read after it, whatever became of it
  const progress: { summary?: MoveSummary } = {};
  try {
    return await whileHoldingTheMoveLock(async () => {
      // read under the lock, so a run never works from a list another run has since moved
      const rows = await rowsOnDisk(only);
      const summary = summaryOf(rows);
      progress.summary = summary;
      if (summary.plain > 0 && !secretsConfigured()) {
        throw new Error(
          "SECRETS_KEY is not configured, and a file stored before it must be sealed",
        );
      }

      for (const row of rows) {
        const copy = await store.copyToBucket(row).catch((err: unknown) => {
          summary.failed++;
          log(`✗ ${row.id}: left on disk — ${reason(err)}`);
          return null;
        });
        if (!copy) continue;

        const { count } = await prisma.file.updateMany({
          where: { id: row.id, storage: "local", path: row.path },
          data: {
            storage: "s3",
            path: copy.path,
            wrappedKey: copy.wrappedKey,
            keyVersion: copy.keyVersion,
          },
        });
        if (count === 0) {
          summary.changed++;
          await store.remove({ storage: "s3", path: copy.path }).catch(() => {});
          log(`… ${row.id}: deleted or replaced while it was copied; the copy is removed`);
          continue;
        }
        summary.moved++;
        summary.bytes += row.size;
        log(`✓ ${row.id} → ${copy.path}`);
      }
      return summary;
    });
  } finally {
    /**
     * After the lock's transaction has returned, and whatever became of the run: what it moved or
     * failed is recorded even when something unexpected ended it (files.md §10.1). A run that found
     * nothing to do is not an act, as with `file.bytes_pruned`; a failure is, because a file left
     * behind is exactly what a later reader asks about.
     */
    const done = progress.summary;
    if (done && (done.moved > 0 || done.failed > 0)) {
      record("file.bytes_moved", {
        changes: { moved: done.moved, bytes: done.bytes, failed: done.failed },
      });
    }
  }
}
