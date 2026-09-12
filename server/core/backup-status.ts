/**
 * What the backups say about themselves — read from files the HOST writes, judged here.
 *
 * The backups are taken outside this app, by `scripts/backup/` under systemd timers, and this app
 * holds no key that reaches them — on purpose: a key in the app's environment is a key in every
 * process that can read it (docs: backups.md §3). What it can do is read the small status files the
 * scripts leave on a READ-ONLY mount, and say — on Settings → System and in the morning's report —
 * whether the backups are still happening. Silence is the failure this exists for: small firms do
 * not lose data to corruption, they lose it to a job that stopped in March while nobody looked.
 *
 * The judgement is a pure function of the files and the clock, so every rule below is a test.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { fmtDayInTz, fmtTimeInTz } from "@shared/dates.js";
import { config, isProd } from "./config.js";

/** Thrown when the backups need a person. The message is what Settings → System shows. */
export class BackupProblem extends Error {}

/** The rules, in one place, so the tests and the words cannot drift apart. */
export const BACKUP_RULES = {
  /** a nightly backup: a success older than this means a night was missed */
  staleHours: 20,
  /** a backup still running after this long has hung */
  backupRunningHours: 3,
  /** a restore test may wait two hours for a backup, then restores and checks */
  drillRunningHours: 6,
  /** monthly: the 1st to the 1st is at most 31 days */
  drillStaleDays: 32,
  /** the copies storage should hold once the first week is over, when a run does not say */
  copies: 7,
} as const;

const HOUR_MS = 3_600_000;

// ── the files ────────────────────────────────────────────────────────────────

const stamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "not a timestamp");

/** What both kinds of run record (scripts/backup/lib.sh, `bk_on_exit`). */
const run = {
  schema: z.literal(1),
  destination: z.string().regex(/^[a-z0-9-]+$/),
  running: z.boolean().nullish(),
  startedAt: stamp.nullish(),
  finishedAt: stamp.nullish(),
  ok: z.boolean().nullish(),
  /** a code from a fixed list — never a tool's own words, which print the storage's address */
  reason: z.string().nullish(),
  lastOkAt: stamp.nullish(),
};

const backupRun = z.object({
  ...run,
  kind: z.literal("backup"),
  firstOkAt: stamp.nullish(),
  snapshot: z.object({ totalBytes: z.number(), files: z.number() }).nullish(),
  copies: z.number().int().nullish(),
  keep: z.number().int().positive().nullish(),
  oldestCopyAt: stamp.nullish(),
  versioning: z.string().nullish(),
});

const drillRun = z.object({
  ...run,
  kind: z.literal("drill"),
  snapshotAt: stamp.nullish(),
});

export type BackupRun = z.infer<typeof backupRun>;
export type DrillRun = z.infer<typeof drillRun>;

export interface StatusFiles {
  backups: BackupRun[];
  drills: DrillRun[];
  /** present, but not a status this build can read */
  unreadable: string[];
}

const STATUS_FILE = /^(backup|drill)-[a-z0-9-]+\.json$/;

/** `null` when the directory is not there at all — the mount never made, or a laptop. */
export async function readStatusDir(dir: string): Promise<StatusFiles | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new BackupProblem(`The backup status cannot be read (${code ?? "unknown error"}).`);
  }
  const files: StatusFiles = { backups: [], drills: [], unreadable: [] };
  for (const name of names.filter((n) => STATUS_FILE.test(n)).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      files.unreadable.push(name);
      continue;
    }
    if (name.startsWith("backup-")) {
      const parsed = backupRun.safeParse(raw);
      if (parsed.success) files.backups.push(parsed.data);
      else files.unreadable.push(name);
    } else {
      const parsed = drillRun.safeParse(raw);
      if (parsed.success) files.drills.push(parsed.data);
      else files.unreadable.push(name);
    }
  }
  return files;
}

// ── the words ────────────────────────────────────────────────────────────────

/** A status file's reason code, as a bookkeeper would want to hear it. */
const REASONS: Record<string, string> = {
  config: "the backup is not set up correctly on the server",
  disk: "the server is running out of disk space",
  dump: "the database could not be copied",
  verify: "the copy of the database was damaged",
  restic: "the encrypted copy could not be written to storage",
  incomplete: "some client files could not be read",
  not_in_storage: "the new copy did not appear in storage",
  versioning: "the storage's version history has been switched off",
  forget: "old copies could not be cleared away",
  lock_timeout: "a backup kept it waiting for hours",
  restore: "the copy could not be restored",
  tables: "tables are missing from the restored copy",
  rows: "the restored copy has far fewer rows than the live database",
  files: "client files the database names are missing from the copy",
  sample: "a restored client file did not match the original",
  check: "the stored data failed its integrity check",
};

function because(reason: string | null | undefined): string {
  if (reason && Object.hasOwn(REASONS, reason)) return REASONS[reason];
  return `it stopped (${reason ?? "no reason recorded"})`;
}

function whenAt(iso: string, now: Date, tz: string): string {
  const at = new Date(iso);
  const day = fmtDayInTz(at, tz);
  const time = fmtTimeInTz(at, tz);
  if (day === fmtDayInTz(now, tz)) return `today at ${time}`;
  if (day === fmtDayInTz(new Date(now.getTime() - 24 * HOUR_MS), tz))
    return `yesterday at ${time}`;
  return `on ${day} at ${time}`;
}

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

// ── the judgement ────────────────────────────────────────────────────────────

export interface Judgement {
  now: Date;
  /** in production a missing file is a problem; on a laptop it is the normal state */
  production: boolean;
  timeZone: string;
}

/**
 * The note for Settings → System when all is well; a `BackupProblem` naming everything that is not.
 *
 * Throwing IS the integration: it paints the row red, writes `system.job_failed`, and puts the
 * night on the morning report through `ops_sweep_failed` — no trigger or event of its own.
 */
export function judgeBackups(files: StatusFiles | null, j: Judgement): string {
  const ageHours = (iso: string) => (j.now.getTime() - Date.parse(iso)) / HOUR_MS;
  const when = (iso: string) => whenAt(iso, j.now, j.timeZone);
  const day = (iso: string) => fmtDayInTz(new Date(iso), j.timeZone);
  const nowIso = j.now.toISOString();

  if (!files || files.backups.length + files.drills.length + files.unreadable.length === 0) {
    if (j.production) {
      throw new BackupProblem(
        "No backup has ever reported here — the nightly backup is not set up on this server.",
      );
    }
    return "No backup runs on this machine.";
  }

  const problems: string[] = [];
  const notes: string[] = [];
  for (const name of files.unreadable) {
    problems.push(`The backup status file ${name} cannot be read.`);
  }
  if (j.production && !files.backups.some((b) => b.destination === "primary")) {
    problems.push("The nightly backup has never reported.");
  }
  if (j.production && !files.drills.some((d) => d.destination === "primary")) {
    problems.push("No restore test has ever run.");
  }

  for (const b of files.backups) {
    const who = b.destination === "primary" ? "" : `${b.destination}: `;
    const inProgress =
      b.running === true &&
      !!b.startedAt &&
      ageHours(b.startedAt) < BACKUP_RULES.backupRunningHours;

    if (b.running === true && b.startedAt && !inProgress) {
      problems.push(`${who}The backup that started ${when(b.startedAt)} has not finished.`);
    }
    if (b.running !== true && b.ok === false) {
      problems.push(
        `${who}The last backup failed ${when(b.finishedAt ?? b.startedAt ?? nowIso)}: ` +
          `${because(b.reason)}.`,
      );
    }
    if (!inProgress) {
      if (!b.lastOkAt) {
        if (b.ok !== false) problems.push(`${who}No backup has succeeded yet.`);
      } else if (ageHours(b.lastOkAt) > BACKUP_RULES.staleHours) {
        problems.push(`${who}No backup has succeeded since ${when(b.lastOkAt)}.`);
      }
    }

    // fewer copies than the retention keeps, once there has been time to make them: a prune gone
    // wrong, or copies being hidden
    const keep = b.keep ?? BACKUP_RULES.copies;
    const settled = !!b.firstOkAt && ageHours(b.firstOkAt) > keep * 24;
    if (b.copies != null && settled && b.copies < keep) {
      problems.push(
        `${who}Only ${count(b.copies, "copy is", "copies are")} in storage — there should be ${keep}.`,
      );
    }

    if (b.versioning === "not_applicable") {
      if (j.production) {
        problems.push(`${who}The backup is writing to a local folder, not to object storage.`);
      }
    } else if (b.versioning && b.versioning !== "Enabled") {
      problems.push(
        `${who}The storage's version history reads "${b.versioning}" — a deleted copy would be ` +
          `gone for good.`,
      );
    }

    if (b.lastOkAt) {
      const parts = [
        b.versioning === "not_applicable" ? "in a local repository" : "in storage",
      ];
      if (b.snapshot) {
        parts.push(size(b.snapshot.totalBytes), count(b.snapshot.files, "file", "files"));
      }
      if (b.copies != null) {
        const oldest = b.oldestCopyAt ? ` (oldest ${day(b.oldestCopyAt)})` : "";
        parts.push(`${count(b.copies, "copy", "copies")} kept${oldest}`);
      }
      const running =
        inProgress && b.startedAt
          ? ` A backup is running now (started ${when(b.startedAt)}).`
          : "";
      notes.push(`${who}Last backup ${when(b.lastOkAt)} — ${parts.join(", ")}.${running}`);
    } else if (inProgress) {
      notes.push(`${who}The first backup is running now.`);
    }
  }

  for (const d of files.drills) {
    const who = d.destination === "primary" ? "" : `${d.destination}: `;
    const inProgress =
      d.running === true &&
      !!d.startedAt &&
      ageHours(d.startedAt) < BACKUP_RULES.drillRunningHours;

    if (d.running === true && d.startedAt && !inProgress) {
      problems.push(
        `${who}The restore test that started ${when(d.startedAt)} has not finished.`,
      );
    }
    if (d.running !== true && d.ok === false) {
      problems.push(
        `${who}The last restore test failed ${when(d.finishedAt ?? d.startedAt ?? nowIso)}: ` +
          `${because(d.reason)}.`,
      );
    }
    if (!d.lastOkAt) {
      if (d.ok !== false && !inProgress) problems.push(`${who}No restore test has passed yet.`);
    } else if (ageHours(d.lastOkAt) > BACKUP_RULES.drillStaleDays * 24) {
      problems.push(
        `${who}The last restore test passed ${when(d.lastOkAt)} — over a month ago.`,
      );
    }
    if (d.lastOkAt) notes.push(`${who}Last restore test ${day(d.lastOkAt)}: passed.`);
  }

  if (problems.length > 0) throw new BackupProblem(problems.join(" "));
  return notes.join(" ");
}

/** The job's body: read the host's files, judge them, return the note or throw the reason. */
export async function checkBackups(now: Date = new Date()): Promise<string> {
  const files = await readStatusDir(resolve(config.BACKUP_STATUS_DIR));
  return judgeBackups(files, { now, production: isProd, timeZone: config.TZ });
}
