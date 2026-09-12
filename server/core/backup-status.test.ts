/**
 * The watchdog's rules — the only thing standing between "the backups stopped in March" and
 * somebody finding out in September. A pure function of the files and the clock, so every rule is
 * pinned here, in the words a bookkeeper will read.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupProblem,
  judgeBackups,
  readStatusDir,
  type BackupRun,
  type DrillRun,
  type Judgement,
  type StatusFiles,
} from "./backup-status.js";
import { loadConfig } from "./config.js";

const TZ = "America/New_York";
/** 04:00 in New York on 12 September — the morning after a 02:00 backup */
const NOW = new Date("2026-09-12T08:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function backup(over: Partial<BackupRun> = {}): BackupRun {
  return {
    schema: 1,
    kind: "backup",
    destination: "primary",
    running: false,
    startedAt: hoursAgo(2),
    finishedAt: hoursAgo(1.9),
    ok: true,
    reason: null,
    lastOkAt: hoursAgo(1.9), // 02:06 in New York
    firstOkAt: hoursAgo(24 * 30),
    snapshot: { totalBytes: 1_400_000_000, files: 1212 },
    copies: 7,
    keep: 7,
    oldestCopyAt: "2026-09-06T06:02:00Z",
    versioning: "Enabled",
    ...over,
  };
}

function drill(over: Partial<DrillRun> = {}): DrillRun {
  return {
    schema: 1,
    kind: "drill",
    destination: "primary",
    running: false,
    startedAt: "2026-09-01T09:00:00Z",
    finishedAt: "2026-09-01T09:05:00Z",
    ok: true,
    reason: null,
    lastOkAt: "2026-09-01T09:05:00Z",
    snapshotAt: "2026-09-01T06:02:00Z",
    ...over,
  };
}

const files = (
  backups: BackupRun[] = [backup()],
  drills: DrillRun[] = [drill()],
  unreadable: string[] = [],
): StatusFiles => ({ backups, drills, unreadable });

const prod: Judgement = { now: NOW, production: true, timeZone: TZ };
const dev: Judgement = { ...prod, production: false };

/** the sentence Settings → System would show — or a failure when there is none */
function problem(f: StatusFiles | null, j: Judgement = prod): string {
  try {
    judgeBackups(f, j);
  } catch (err) {
    if (err instanceof BackupProblem) return err.message;
    throw err;
  }
  throw new Error("expected the backups to need a person, and they did not");
}

describe("a good night", () => {
  it("is described in the words the System tab shows", () => {
    expect(judgeBackups(files(), prod)).toBe(
      "Last backup today at 02:06 — in storage, 1.4 GB, 1,212 files, 7 copies kept " +
        "(oldest 6 Sept). Last restore test 1 Sept: passed.",
    );
  });

  it("is not a missed night while a backup that started recently is still running", () => {
    const note = judgeBackups(
      files([
        backup({ running: true, startedAt: hoursAgo(1), ok: null, lastOkAt: hoursAgo(25) }),
      ]),
      prod,
    );
    expect(note).toContain("A backup is running now");
  });
});

describe("what turns the row red", () => {
  it("nothing ever reported, in production — which is true of every server before setup", () => {
    expect(problem(null)).toMatch(/No backup has ever reported here/);
    expect(problem(files([], [], []))).toMatch(/No backup has ever reported here/);
  });

  it("a failed night, in a bookkeeper's words — never the tool's", () => {
    const text = problem(
      files([backup({ ok: false, reason: "incomplete", lastOkAt: hoursAgo(25.9) })]),
    );
    expect(text).toContain(
      "The last backup failed today at 02:06: some client files could not be read.",
    );
    expect(text).toContain("No backup has succeeded since yesterday at 02:06.");
  });

  it("a reason this build does not know is shown as its code, not dropped", () => {
    expect(problem(files([backup({ ok: false, reason: "new_thing" })]))).toContain(
      "it stopped (new_thing)",
    );
  });

  it("a missed night: the last success more than 20 hours old", () => {
    expect(problem(files([backup({ lastOkAt: hoursAgo(21) })]))).toContain(
      "No backup has succeeded since",
    );
    expect(() => judgeBackups(files([backup({ lastOkAt: hoursAgo(19) })]), prod)).not.toThrow();
  });

  it("a backup that has been running for three hours has hung", () => {
    expect(
      problem(files([backup({ running: true, startedAt: hoursAgo(3.5), ok: null })])),
    ).toContain("has not finished");
  });

  it("copies disappearing once the first week is over — a prune gone wrong, or copies hidden", () => {
    expect(problem(files([backup({ copies: 5 })]))).toContain(
      "Only 5 copies are in storage — there should be 7.",
    );
    // in the first week there cannot be seven yet
    expect(() =>
      judgeBackups(files([backup({ copies: 3, firstOkAt: hoursAgo(72) })]), prod),
    ).not.toThrow();
    // a retention set longer on the server is the number held to
    expect(problem(files([backup({ copies: 7, keep: 10 })]))).toContain("there should be 10");
  });

  it("the bucket's version history switched off — a delete would then destroy, not hide", () => {
    expect(problem(files([backup({ versioning: "Suspended" })]))).toContain(
      'reads "Suspended"',
    );
  });

  it("a production backup writing to a local folder instead of object storage", () => {
    expect(problem(files([backup({ versioning: "not_applicable" })]))).toContain(
      "local folder",
    );
    // …which is exactly what a laptop does
    expect(judgeBackups(files([backup({ versioning: "not_applicable" })]), dev)).toContain(
      "in a local repository",
    );
  });

  it("a restore test that failed, or has not passed for more than a month", () => {
    expect(problem(files(undefined, [drill({ ok: false, reason: "restore" })]))).toContain(
      "the copy could not be restored",
    );
    expect(problem(files(undefined, [drill({ lastOkAt: hoursAgo(24 * 33) })]))).toContain(
      "over a month ago",
    );
  });

  it("a restore test that has never run, in production", () => {
    expect(problem(files(undefined, []))).toContain("No restore test has ever run.");
  });

  it("a status file it cannot read", () => {
    expect(problem(files(undefined, undefined, ["backup-primary.json"]))).toContain(
      "backup-primary.json cannot be read",
    );
  });

  it("a second destination, named — a later provider must not be mistaken for the first", () => {
    const text = problem(
      files([backup(), backup({ destination: "secondary", ok: false, reason: "restic" })]),
    );
    expect(text).toMatch(/^secondary: The last backup failed/);
  });
});

describe("on a laptop", () => {
  it("stays quiet when no backup runs there at all", () => {
    expect(judgeBackups(null, dev)).toBe("No backup runs on this machine.");
  });

  it("does not ask for a restore test that nobody has run", () => {
    expect(() => judgeBackups(files(undefined, []), dev)).not.toThrow();
  });
});

describe("reading the directory the host writes", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("is null when the directory is not there — the mount never made", async () => {
    expect(await readStatusDir(join(tmpdir(), "buh-crm-no-such-status-dir"))).toBeNull();
  });

  it("reads the two kinds, skips anything else, and says which files it cannot read", async () => {
    dir = await mkdtemp(join(tmpdir(), "buh-crm-status-"));
    await writeFile(join(dir, "backup-primary.json"), JSON.stringify(backup()));
    await writeFile(join(dir, "drill-primary.json"), JSON.stringify(drill()));
    await writeFile(join(dir, "backup-broken.json"), "{ half a file");
    await writeFile(join(dir, "drill-future.json"), JSON.stringify({ ...drill(), schema: 2 }));
    await writeFile(join(dir, ".tmp.X1b2"), "a write in progress");
    await writeFile(join(dir, "notes.txt"), "not a status");

    const read = await readStatusDir(dir);
    expect(read?.backups.map((b) => b.destination)).toEqual(["primary"]);
    expect(read?.drills.map((d) => d.destination)).toEqual(["primary"]);
    expect(read?.unreadable).toEqual(["backup-broken.json", "drill-future.json"]);
  });

  it("looks where the read-only mount puts the files, unless told otherwise", () => {
    const base = { DATABASE_URL: "postgresql://u:p@h/db", SESSION_SECRET: "0123456789abcdef" };
    expect(loadConfig(base as NodeJS.ProcessEnv).BACKUP_STATUS_DIR).toBe("backup-status");
  });
});
