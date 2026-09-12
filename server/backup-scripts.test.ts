/**
 * The backup scripts, held to the rules that rot silently.
 *
 * A backup stops being true without anything failing — that is how this firm went two months with
 * three documents describing a backup that did not exist (docs: backups.md §2). So these tests are
 * aimed at rot, not at shell style. Two kinds:
 *
 * - rules read straight from the files: the one `pg_dump`, no `.env`, no storage address in a
 *   public file, the read-only mount, a decision for every data directory;
 * - `backup.sh` itself, run against stand-ins for restic, docker and rclone, so that every way a
 *   night can fail is seen to leave the right status behind for the CRM.
 *
 * `restore.sh` and `drill.sh` run real restores and a throwaway Postgres; they were rehearsed end
 * to end against the development database (docs: backups-plan.md), and here they are held to the
 * flags that could destroy the live database.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./core/config.js";

const read = (p: string) => readFileSync(p, "utf8");
/** the lines a shell runs — comments are where the rules are explained, and may name anything */
const code = (p: string) =>
  read(p)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const BACKUP = "scripts/backup/backup.sh";
const LIB = "scripts/backup/lib.sh";
const DRILL = "scripts/backup/drill.sh";
const RESTORE = "scripts/backup/restore.sh";
const DEPLOY = "scripts/deploy.sh";
const SHELL = readdirSync("scripts/backup")
  .filter((f) => f.endsWith(".sh"))
  .map((f) => `scripts/backup/${f}`);

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}
/** everything that ships in the public repository and could name the storage */
const PUBLIC = [...filesUnder("scripts"), "RESTORE.md", "README.md"];

// ── rules read from the files ────────────────────────────────────────────────

describe("the dump", () => {
  it("gets exactly one set of arguments — so a table list can never creep in", () => {
    // Without a list pg_dump takes every table, including the ones that do not exist yet. The only
    // way to miss a future table is to write one. (A grep for flags could not do this: `-T` is also
    // `docker compose exec -T`.)
    for (const file of [BACKUP, DEPLOY]) {
      const calls = [...code(file).matchAll(/pg_dump([^']*)'/g)].map((m) => m[1]);
      expect(calls.length, file).toBeGreaterThan(0);
      for (const args of calls)
        expect(args, file).toBe(' -U "$POSTGRES_USER" -Fc -Z0 "$POSTGRES_DB"');
    }
  });

  it("is never taken by a script that reads the project's .env", () => {
    // .env holds SECRETS_KEY; with the dump that is plaintext. The nightly scripts do not need it —
    // the database container knows its own user and database.
    for (const file of [BACKUP, LIB, DRILL]) {
      expect(code(file), file).not.toMatch(/(^|[\s"'=/(])\.env\b/m);
    }
  });
});

describe("restoring", () => {
  it("never hands pg_restore --create or --clean, which would write over the live database", () => {
    for (const file of [RESTORE, DRILL]) {
      const calls = [...code(file).matchAll(/pg_restore([^\n]*)/g)].map((m) => m[1]);
      expect(calls.length, file).toBeGreaterThan(0);
      for (const args of calls) {
        const flags = args.split(/\s+/);
        for (const bad of ["-C", "--create", "-c", "--clean"]) {
          expect(flags, `${file}: pg_restore${args}`).not.toContain(bad);
        }
      }
    }
  });
});

describe("the restore test's throwaway database", () => {
  it("is removed with its data volume, not only its container", () => {
    // The postgres image keeps its data in a volume of its own. `--rm` removes it only when the
    // container stops by itself; `docker rm -f` without `-v` left the restored client book behind
    // as an anonymous volume, one more every month (audit, 2026-09-12 — reproduced with the image).
    const removals = [...code(DRILL).matchAll(/docker rm([^\n]*)/g)].map((m) => m[1]);
    expect(removals.length).toBeGreaterThan(0);
    for (const args of removals) expect(args.split(/\s+/), `docker rm${args}`).toContain("-v");
    expect(code(DRILL)).toMatch(/docker run [^\n]*--rm [^\n]*--network none/);
  });
});

describe("restore.sh refuses before it touches anything", () => {
  it("will not swap in PostgreSQL's own databases, even with --yes", () => {
    // `--swap postgres --yes` would rename the maintenance database the script itself connects to
    // (audit, 2026-09-12). The refusal comes before any call to the server — a docker that fails
    // loudly proves it.
    const dir = mkdtempSync(join(tmpdir(), "buh-crm-restore-test-"));
    try {
      const fake = join(dir, "bin");
      mkdirSync(fake);
      writeFileSync(
        join(fake, "docker"),
        '#!/bin/sh\necho "docker was called" >&2\nexit 99\n',
        {
          mode: 0o755,
        },
      );
      for (const db of ["postgres", "template0", "template1"]) {
        const res = spawnSync("bash", [RESTORE, "--swap", db, "--yes"], {
          encoding: "utf8",
          env: { PATH: `${fake}:${process.env.PATH}`, HOME: dir, BACKUP_STATE_DIR: dir },
        });
        expect(res.status, db).toBe(1);
        expect(res.stderr, db).toContain("PostgreSQL's own database");
        expect(res.stderr, db).not.toContain("docker was called");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the public repository", () => {
  it("names no bucket, no key and no project — only placeholders", () => {
    const leaks: string[] = [];
    for (const file of PUBLIC) {
      const text = read(file);
      const found = [
        // a real bucket after the endpoint (a placeholder starts with `<` or `$`)
        ...text.matchAll(/your-objectstorage\.com\/[a-z0-9]/g),
        // a real bucket as a subdomain
        ...text.matchAll(/[a-z0-9][a-z0-9-]*\.(?:fsn1|nbg1|hel1)\.your-objectstorage\.com/g),
        // a key or a password with a value
        ...text.matchAll(
          /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|RESTIC_PASSWORD)=[A-Za-z0-9+/]/g,
        ),
        // a real Hetzner project in a policy principal
        ...text.matchAll(/iam:::user\/p\d/g),
        // where the projects sit on the shared server — reconnaissance for anybody who gets onto it
        // through another one (audit, 2026-09-12)
        ...text.matchAll(/\/var\/www\/[^\s<]+/g),
      ];
      for (const m of found) leaks.push(`${file}: ${m[0]}`);
    }
    expect(leaks).toEqual([]);
  });

  it("shows every repository address ending in /restic, where the bucket policy lets the key in", () => {
    for (const file of ["RESTORE.md", "scripts/backup/backup.env.example"]) {
      const addresses = [...read(file).matchAll(/s3:https?:\/\/[^\s`'")]+/g)].map((m) => m[0]);
      expect(addresses.length, file).toBeGreaterThan(0);
      for (const a of addresses) expect(a, file).toMatch(/\/restic$/);
    }
  });

  it("keeps the storage settings as placeholders, and expires no current version", () => {
    const policy = read("scripts/storage/policy-backups.template.json");
    expect(policy).toContain("<BUCKET>");
    expect(policy).toContain("<KEY_PROJECT>");
    expect(policy).toContain("<KEY_ID>");

    // restic shares data between snapshots: expiring a CURRENT version deletes data a kept
    // snapshot still needs. Hetzner's own example lifecycle does exactly that.
    const lifecycle = JSON.parse(read("scripts/storage/lifecycle-backups.json")) as {
      Rules: Array<{ Expiration?: { Days?: number; Date?: string } }>;
    };
    for (const rule of lifecycle.Rules) {
      expect(rule.Expiration?.Days).toBeUndefined();
      expect(rule.Expiration?.Date).toBeUndefined();
    }
  });
});

describe("where the CRM reads the status", () => {
  const compose = read("docker-compose.yml");

  it("is a read-only mount, and not under the uploads directory the app writes and prunes", () => {
    const line = compose.split("\n").find((l) => l.includes(":/app/backup-status"));
    expect(line).toBeDefined();
    expect(line?.trim()).toMatch(/:ro$/);
    expect(line?.split(":/app/backup-status")[0]).not.toContain("uploads");
    // …and it is where the app looks: `backup-status` beside `uploads`, under /app
    const base = { DATABASE_URL: "postgresql://u:p@h/db", SESSION_SECRET: "0123456789abcdef" };
    expect(loadConfig(base as NodeJS.ProcessEnv).BACKUP_STATUS_DIR).toBe("backup-status");
  });
});

describe("growing with future modules", () => {
  /**
   * Every directory under ./data the compose file mounts, and what the backup does with it. A new
   * module that adds one fails here until somebody decides — which is the point: a table added next
   * spring is in the dump by itself, a directory is not.
   */
  const DATA_MOUNTS: Record<string, string> = {
    postgres:
      "not copied as files: a running database copied file by file is not a database — the " +
      "nightly dump is the copy",
    uploads: "backed up: backup.sh takes BACKUP_UPLOADS_DIR, which defaults to data/uploads",
  };

  it("has decided, for every ./data directory, whether it is backed up", () => {
    const mounts = [...read("docker-compose.yml").matchAll(/\.\/data\/([a-z0-9_-]+):/g)].map(
      (m) => m[1],
    );
    expect(mounts.length).toBeGreaterThan(0);
    expect(mounts.filter((m) => !Object.hasOwn(DATA_MOUNTS, m))).toEqual([]);
    expect(code(LIB)).toContain("BACKUP_UPLOADS_DIR:-$BK_PROJECT/data/uploads");
  });
});

describe("the shell itself", () => {
  it("stays within bash 3.2, because the laptop the scripts are tested on is a Mac", () => {
    for (const file of SHELL) {
      expect(code(file), file).not.toMatch(
        /declare -A|mapfile|readarray|\$\{\w+(,,|\^\^)\}|\|&|&>>/,
      );
    }
  });

  it("never pipes into head — under pipefail the writer's SIGPIPE fails the whole night", () => {
    for (const file of SHELL) expect(code(file), file).not.toMatch(/\|\s*head\b/);
  });

  it("keeps every snapshot in one group, on a fixed path", () => {
    expect(code(BACKUP)).toContain("--host buh-crm");
    expect(code(BACKUP)).toContain("--group-by ''");
    expect(code(BACKUP)).toContain("STAGE=$BACKUP_STATE_DIR/backup-stage");
  });
});

// ── backup.sh, against stand-ins ─────────────────────────────────────────────

const SNAP = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let root = "";
let bin = "";

const STUBS: Record<string, string> = {
  // docker, as far as backup.sh can tell: a dump out, a dump read back in
  docker: `#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG"
case "$*" in
  *pg_dump*) [ "\${STUB_DUMP_EXIT:-0}" = 0 ] || exit "$STUB_DUMP_EXIT"; printf 'PGDMP-stand-in'; exit 0 ;;
  *pg_restore*) cat >/dev/null; exit "\${STUB_VERIFY_EXIT:-0}" ;;
esac
exit 0
`,
  restic: `#!/usr/bin/env bash
echo "restic $*" >>"$STUB_LOG"
case "$1" in
  unlock) exit 0 ;;
  backup)
    # restic's own error text is where the repository's address shows up
    echo "Fatal: unable to save snapshot to $RESTIC_REPOSITORY" >&2
    printf '{"message_type":"summary","data_added":10,"total_files_processed":3,"total_bytes_processed":2048,"snapshot_id":"%s"}\\n' "$STUB_SNAPSHOT"
    exit "\${STUB_BACKUP_EXIT:-0}" ;;
  snapshots)
    printf '['
    i=1
    while [ "$i" -lt "\${STUB_COPIES:-7}" ]; do printf '{"id":"older%s","time":"2026-09-0%sT06:00:00Z"},' "$i" "$i"; i=$((i + 1)); done
    if [ "\${STUB_NOT_LISTED:-0}" = 1 ]; then id=someoneelse; else id=$STUB_SNAPSHOT; fi
    printf '{"id":"%s","time":"2026-09-11T06:00:00Z"}]\\n' "$id"
    exit 0 ;;
  forget) exit 0 ;;
esac
exit 0
`,
  rclone: `#!/usr/bin/env bash
echo "rclone $*" >>"$STUB_LOG"
if [ "$1 $2" = "backend versioning" ]; then printf '"%s"\\n' "\${STUB_VERSIONING:-Enabled}"; exit 0; fi
exit 1
`,
};

interface Run {
  code: number | null;
  stderr: string;
  state: string;
  uploads: string;
  status: Record<string, unknown> | null;
  statusRaw: string;
  calls: string;
}

/** One night. `dir` reuses an earlier night's state, as the server does. */
function night(
  opts: { env?: Record<string, string>; stub?: Record<string, string>; dir?: string } = {},
): Run & { dir: string } {
  const dir = opts.dir ?? mkdtempSync(join(root, "night-"));
  const state = join(dir, "state");
  const uploads = join(dir, "uploads");
  mkdirSync(uploads, { recursive: true });
  writeFileSync(join(uploads, "a-client-document.pdf"), "bytes");
  const vars = {
    RESTIC_REPOSITORY: "/nonexistent/repository-for-tests",
    RESTIC_PASSWORD: "test",
    BACKUP_STATE_DIR: state,
    BACKUP_UPLOADS_DIR: uploads,
    BACKUP_LOCK_DIR: state,
    BACKUP_MIN_FREE_MB: "0",
    ...opts.env,
  };
  const envFile = join(dir, "backup.env");
  writeFileSync(
    envFile,
    `${Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
  );
  const log = join(dir, "calls.log");
  const res = spawnSync("bash", [BACKUP, envFile], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      STUB_LOG: log,
      STUB_SNAPSHOT: SNAP,
      ...opts.stub,
    },
  });
  const statusPath = join(state, "backup-status", "backup-primary.json");
  const statusRaw = existsSync(statusPath) ? read(statusPath) : "";
  return {
    dir,
    code: res.status,
    stderr: res.stderr,
    state,
    uploads,
    status: statusRaw ? (JSON.parse(statusRaw) as Record<string, unknown>) : null,
    statusRaw,
    calls: existsSync(log) ? read(log) : "",
  };
}

describe("backup.sh, night by night", () => {
  beforeAll(() => {
    const flock = spawnSync("sh", ["-c", "command -v flock"]);
    if (flock.status !== 0) {
      throw new Error("flock is needed for the backup scripts — on a Mac: brew install flock");
    }
    root = mkdtempSync(join(tmpdir(), "buh-crm-backup-test-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries(STUBS))
      writeFileSync(join(bin, name), body, { mode: 0o755 });
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("a good night: the snapshot, the copies, the dump first, a readable file and a clean stage", () => {
    const n = night();
    expect(n.code, n.stderr).toBe(0);
    expect(n.status).toMatchObject({
      schema: 1,
      kind: "backup",
      destination: "primary",
      ok: true,
      reason: null,
      running: false,
      copies: 7,
      keep: 7,
      versioning: "not_applicable",
      snapshot: { id: SNAP.slice(0, 8), totalBytes: 2048, files: 3 },
    });
    expect(n.status?.firstOkAt).toBe(n.status?.lastOkAt);
    // THE DUMP FIRST — a file uploaded in between becomes an orphan, not a row pointing at nothing
    expect(n.calls.indexOf("pg_dump")).toBeLessThan(n.calls.indexOf("restic backup"));
    expect(n.calls).toMatch(/restic backup .* \S+\/backup-stage \S+\/uploads\n/);
    expect(n.calls).toMatch(/restic forget .*--keep-daily 7 --prune --max-unused 0/);
    // the app reads it through a read-only mount, possibly as a non-root user
    const file = join(n.state, "backup-status", "backup-primary.json");
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(statSync(join(n.state, "backup-status")).mode & 0o777).toBe(0o755);
    expect(existsSync(join(n.state, "backup-stage", "db.dump"))).toBe(false);
  });

  it("remembers the first good night across the nights after it", () => {
    const first = night();
    const firstOk = first.status?.firstOkAt;
    const second = night({ dir: first.dir });
    expect(second.code).toBe(0);
    expect(second.status?.firstOkAt).toBe(firstOk);
  });

  it("exit 3 — a snapshot with holes in it — is a failed night, and nothing is pruned after it", () => {
    const n = night({ stub: { STUB_BACKUP_EXIT: "3" } });
    expect(n.code).not.toBe(0);
    expect(n.status).toMatchObject({ ok: false, reason: "incomplete" });
    expect(n.calls).not.toContain("restic forget");
  });

  it("a dump that fails stops the night before restic is touched", () => {
    const n = night({ stub: { STUB_DUMP_EXIT: "1" } });
    expect(n.status).toMatchObject({ ok: false, reason: "dump" });
    expect(n.calls).not.toContain("restic backup");
  });

  it("a dump that does not read back in full is a failed night", () => {
    const n = night({ stub: { STUB_VERIFY_EXIT: "1" } });
    expect(n.status).toMatchObject({ ok: false, reason: "verify" });
    expect(n.calls).not.toContain("restic backup");
  });

  it("a snapshot that does not appear in storage is a failed night", () => {
    const n = night({ stub: { STUB_NOT_LISTED: "1" } });
    expect(n.status).toMatchObject({ ok: false, reason: "not_in_storage" });
    expect(n.calls).not.toContain("restic forget");
  });

  it("the bucket's versioning switched off fails the night — before anything is pruned", () => {
    const n = night({
      env: { RESTIC_REPOSITORY: "s3:https://objects.example.invalid/a-bucket/restic" },
      stub: { STUB_VERSIONING: "Suspended" },
    });
    expect(n.status).toMatchObject({ ok: false, reason: "versioning" });
    expect(n.calls).toContain("rclone backend versioning store:a-bucket");
    expect(n.calls).not.toContain("restic forget");
  });

  it("…and reads Enabled on a good night against object storage", () => {
    const n = night({
      env: { RESTIC_REPOSITORY: "s3:https://objects.example.invalid/a-bucket/restic" },
    });
    expect(n.code, n.stderr).toBe(0);
    expect(n.status?.versioning).toBe("Enabled");
  });

  it("never writes the repository's address into the status — it becomes a line on a screen", () => {
    const n = night({
      env: { RESTIC_REPOSITORY: "s3:https://objects.example.invalid/a-bucket/restic" },
      stub: { STUB_BACKUP_EXIT: "1" },
    });
    expect(n.stderr).toContain("objects.example.invalid"); // restic did say it…
    expect(n.statusRaw).not.toContain("example.invalid"); // …and it went to the journal only
    expect(n.status).toMatchObject({ ok: false, reason: "restic" });
  });

  it("no uploads directory is a configuration failure, reported as one", () => {
    const n = night({ env: { BACKUP_UPLOADS_DIR: "/nonexistent/uploads-for-tests" } });
    expect(n.status).toMatchObject({ ok: false, reason: "config" });
  });

  it("not enough room beside the database stops the night before the dump", () => {
    const n = night({ env: { BACKUP_MIN_FREE_MB: "999999999" } });
    expect(n.status).toMatchObject({ ok: false, reason: "disk" });
    expect(n.calls).not.toContain("pg_dump");
  });

  it("an environment file it cannot read writes no status at all — a wrong one would be worse", () => {
    // Until the file is read, which destination this run is for is unknown: a broken second
    // destination must never redden the first (audit, 2026-09-12). The night still shows — no
    // success within 20 hours is red the next morning.
    const dir = mkdtempSync(join(root, "night-"));
    const state = join(dir, "state");
    const res = spawnSync("bash", [BACKUP, join(dir, "missing.env")], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, BACKUP_STATE_DIR: state },
    });
    expect(res.status).toBe(78);
    expect(res.stderr).toContain("no environment file");
    expect(existsSync(join(state, "backup-status"))).toBe(false);
  });

  it("a second run while one holds the lock changes nothing but lastConflictAt", async () => {
    const first = night();
    const before = first.status?.startedAt;
    const lock = join(first.state, "buh_crm-backup-primary.lock");
    const holder = spawn("flock", [lock, "sleep", "5"]);
    await new Promise((r) => setTimeout(r, 400));
    try {
      const second = night({ dir: first.dir });
      expect(second.code).toBe(75);
      expect(second.status?.ok).toBe(true);
      expect(second.status?.startedAt).toBe(before);
      expect(second.status?.lastConflictAt).toEqual(expect.any(String));
    } finally {
      holder.kill();
    }
  });
});
