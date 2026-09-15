import { prisma } from "./db.js";
import { readStoredFile, StoredFileError, type FileBytes } from "./files.js";

/**
 * `files:storage-check`, every night at 03:40 (files.md §14.4): a few stored files are read back,
 * opened with this server's key, and measured against the size their rows record.
 *
 * It is the one check that the store and SECRETS_KEY still work together, and the backups cannot
 * make it: their scripts never read `.env` (backups.md §7.9), so they copy files they could never
 * open. A throw is the whole alarm — the scheduler paints Settings → System red with it and puts the
 * night on the morning's `ops_sweep_failed` report. It changes nothing, so it records nothing.
 *
 * The newest files and a few at random. The newest say whether what was stored today still opens —
 * a key changed without its files is found the next morning, not when a client asks for a document
 * — and the random ones walk, night by night, through everything older.
 */

const NEWEST = 2;
const AT_RANDOM = 3;

export interface CheckedFile extends FileBytes {
  size: number;
}

const columns = {
  id: true,
  path: true,
  storage: true,
  wrappedKey: true,
  keyVersion: true,
  size: true,
} as const;

/** Tonight's files: the newest, and a few more at random from the rest. */
export async function filesToCheck(): Promise<CheckedFile[]> {
  const newest = await prisma.file.findMany({
    select: columns,
    orderBy: { createdAt: "desc" },
    take: NEWEST,
  });
  const taken = newest.map((file) => file.id);
  // one sort of the ids a night — nothing, at the tens of thousands of rows a firm this size keeps
  const random = await prisma.$queryRaw<{ id: string }[]>`
    select id from "File" where not (id = any(${taken}::uuid[])) order by random() limit ${AT_RANDOM}`;
  const others =
    random.length > 0
      ? await prisma.file.findMany({
          select: columns,
          where: { id: { in: random.map((row) => row.id) } },
        })
      : [];
  return [...newest, ...others];
}

export type Failure = "missing" | "key" | "damaged" | "unreachable";

/** Why a stored file would not open; the files check (files.check.ts) reads it the same way. */
export function failureOf(err: unknown): Failure {
  if (err instanceof StoredFileError) return err.reason;
  const e = err as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: number } };
  if (e?.code === "ENOENT" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) {
    return "missing";
  }
  return "unreachable";
}

const PLACE = {
  s3: { name: "the bucket", on: "in" },
  local: { name: "the server's disk", on: "on" },
} as const;

/** What went wrong, in words a person can act on — how many and why, never which. */
const WORDS: Record<Failure, (place: (typeof PLACE)[keyof typeof PLACE]) => string> = {
  missing: (p) => `missing from ${p.name}`,
  key: () => "not opened by this server's key",
  damaged: (p) => `damaged ${p.on} ${p.name}`,
  unreachable: (p) => `unreadable ${p.on} ${p.name}`,
};

const files_ = (n: number) => `${n} stored ${n === 1 ? "file" : "files"}`;

/**
 * The job's body: the note, or a throw saying how many failed and why. Never which: a file's name is
 * a client's, and the job's words reach a screen and an email. The ids go to the server's log.
 */
export async function checkStoredFiles(
  options: {
    pick?: () => Promise<CheckedFile[]>;
    read?: (file: FileBytes) => Promise<Buffer>;
    log?: (line: string) => void;
  } = {},
): Promise<string> {
  const {
    pick = filesToCheck,
    read = readStoredFile,
    log = (line: string) => console.error(line),
  } = options;
  const files = await pick();
  if (files.length === 0) return "No files are stored yet.";

  const failures = new Map<string, number>();
  for (const file of files) {
    let failure: Failure | null = null;
    try {
      const bytes = await read(file);
      if (bytes.length !== file.size) failure = "damaged";
    } catch (err) {
      failure = failureOf(err);
      log(
        `[files:storage-check] ${file.id} (${file.storage}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    if (failure) {
      const words = WORDS[failure](PLACE[file.storage]);
      failures.set(words, (failures.get(words) ?? 0) + 1);
    }
  }

  const failed = [...failures.values()].reduce((sum, n) => sum + n, 0);
  if (failed > 0) {
    const parts = [...failures.entries()].map(([words, n]) => `${n} ${words}`);
    const hint = failures.has(WORDS.key(PLACE.local))
      ? " Is SECRETS_KEY the one they were stored with?"
      : "";
    throw new Error(
      `${failed} of ${files_(files.length)} could not be opened: ${parts.join(", ")}.${hint}`,
    );
  }

  const inBucket = files.filter((file) => file.storage === "s3").length;
  const onDisk = files.length - inBucket;
  const where = [
    inBucket > 0 ? `${inBucket} in the bucket` : "",
    onDisk > 0 ? `${onDisk} on the server's disk` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const plain = files.filter((file) => file.wrappedKey === null).length;
  return (
    `${files_(files.length)} opened and matched ${files.length === 1 ? "its" : "their"} size ` +
    `(${where})` +
    (plain > 0
      ? `; ${plain} stored before encryption, read as ${plain === 1 ? "it was" : "they were"}.`
      : ".")
  );
}
