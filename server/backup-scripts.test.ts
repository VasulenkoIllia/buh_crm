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
import { ENVELOPE_OVERHEAD } from "./core/files.js";

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

describe("the restore test's size check", () => {
  it("expects an encrypted file exactly the envelope over the size its row records", () => {
    // S17 stage A: a stored file is its ciphertext plus the format byte, the IV and the tag. If the
    // drill's number and core/files.ts ever part, every restore test fails its sample — or passes a
    // file cut short by exactly the difference.
    const bytes = code(DRILL).match(/^ENVELOPE_BYTES=(\d+)$/m)?.[1];
    expect(Number(bytes)).toBe(ENVELOPE_OVERHEAD);
    // through to_jsonb, so a snapshot from before the column existed is read the same way
    expect(code(DRILL)).toContain("to_jsonb(f) ->> 'wrappedKey'");
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

/**
 * **The one command in the product that deletes the client book** (deployment.md, "How the wipe is
 * confirmed"). None of this can be tested by running the deploy, and every rule here exists because
 * the cheap version of it failed somewhere: a flag that skipped the question, a question whose
 * answer was the same every time, and a paste that answered a question before it was asked.
 */
describe("--reset asks a question that cannot be answered in advance", () => {
  const sh = code(DEPLOY);

  it("is not covered by --yes", () => {
    expect(sh).toMatch(/if \$ASSUME_YES; then[\s\S]{0,200}exit 2/);
  });

  it("refuses without a terminal, so no pipe or script can answer for a person", () => {
    expect(sh).toMatch(/\[ -t 0 \] \|\|/);
  });

  it("asks for a code it invents for this run, and throws queued input away first", () => {
    expect(sh).toMatch(/CODE="\$\(head -c \d+ \/dev\/urandom/);
    expect(sh).toContain('[ "$answer" = "wipe $CODE" ]');
    expect(sh).toMatch(/while IFS= read -r -t [\d.]+ _queued; do :; done/);
    // the database name is what it used to ask for: constant, remembered, pasteable
    expect(sh).not.toContain('[ "$answer" = "$PG_DB" ]');
  });

  it("says what it is about to delete and what it keeps, before it asks", () => {
    expect(sh).toContain('FROM "Client"');
    expect(sh).toContain("keeping ");
    // the vault's place is read through to_jsonb, so this also runs where "space" does not exist yet
    expect(sh).toContain("to_jsonb(s) ->> 'space'");
    expect(sh).toMatch(/restore\.sh --rollback \$DUMP/);
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

  it("gives the files bucket two keys apart: the CRM's reads and writes, the backup's only reads", () => {
    const text = read("scripts/storage/policy-files.template.json");
    for (const placeholder of [
      "<BUCKET>",
      "<APP_PROJECT>",
      "<APP_KEY_ID>",
      "<BACKUP_PROJECT>",
      "<BACKUP_KEY_ID>",
    ]) {
      expect(text).toContain(placeholder);
    }
    type Statement = {
      Effect: "Allow" | "Deny";
      Principal: { AWS: string[] };
      Action: string[];
    };
    const statements = (JSON.parse(text) as { Statement: Statement[] }).Statement;
    const app = "arn:aws:iam:::user/p<APP_PROJECT>:<APP_KEY_ID>";
    const backup = "arn:aws:iam:::user/p<BACKUP_PROJECT>:<BACKUP_KEY_ID>";
    const actions = (effect: Statement["Effect"], who: string) =>
      statements
        .filter((s) => s.Effect === effect && s.Principal.AWS.includes(who))
        .flatMap((s) => s.Action)
        .sort();

    // the CRM stores and removes files; the backup reads them for the nightly copy, and nothing else
    expect(actions("Allow", app)).toEqual([
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]);
    expect(actions("Allow", backup)).toEqual([
      "s3:GetBucketVersioning",
      "s3:GetObject",
      "s3:ListBucket",
    ]);
    // neither destroys history or changes the rules — on Ceph an uploader otherwise counts as the
    // owner of what it uploaded (backups.md §3.2), so these are said, not left to the default
    for (const who of [app, backup]) {
      for (const action of [
        "s3:DeleteObjectVersion",
        "s3:PutBucketPolicy",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketVersioning",
        "s3:DeleteBucket",
      ]) {
        expect(actions("Deny", who), who).toContain(action);
      }
    }
    for (const action of [
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectVersion",
      "s3:ListBucketVersions",
    ]) {
      expect(actions("Deny", backup)).toContain(action);
    }
    // a Deny names keys, never everybody — or the policy could never be changed again
    for (const s of statements) expect(s.Principal.AWS).not.toContain("*");

    // a current file is a client's document: nothing expires it. A deleted one stays recoverable
    // for 30 days as a hidden version (files.md decision 16).
    const lifecycle = JSON.parse(read("scripts/storage/lifecycle-files.json")) as {
      Rules: Array<{
        Expiration?: { Days?: number; Date?: string };
        NoncurrentVersionExpiration?: { NoncurrentDays: number };
      }>;
    };
    for (const rule of lifecycle.Rules) {
      expect(rule.Expiration?.Days).toBeUndefined();
      expect(rule.Expiration?.Date).toBeUndefined();
    }
    const kept = lifecycle.Rules.flatMap((r) =>
      r.NoncurrentVersionExpiration ? [r.NoncurrentVersionExpiration.NoncurrentDays] : [],
    );
    expect(kept).toEqual([30]);
  });
});

describe("setup-bucket.sh", () => {
  const run = (...args: string[]) =>
    spawnSync("bash", ["scripts/storage/setup-bucket.sh", ...args], {
      encoding: "utf8",
      input: "",
    });

  it("keeps its backups form, and refuses a files setup that would mix the two keys", () => {
    expect(run("a-bucket", "fsn1", "1").status).toBe(2); // a backups setup takes four
    expect(run("--files", "a-bucket", "fsn1", "1", "KEY", "2").status).toBe(2); // files take six
    expect(run("a-bucket", "mars", "1", "KEY").stderr).toContain("location must be");

    const oneKey = run("--files", "a-bucket", "fsn1", "1", "SAMEKEY", "2", "SAMEKEY");
    expect(oneKey.status).toBe(2);
    expect(oneKey.stderr).toContain("two different keys");

    // a key opens every bucket of its own project, so the CRM's may not share the backup's
    const oneProject = run("--files", "a-bucket", "fsn1", "7", "APPKEY", "7", "BACKUPKEY");
    expect(oneProject.status).toBe(2);
    expect(oneProject.stderr).toContain("its own project");
  });

  it("ignores public ACLs on the files bucket, which its policy alone could not stop", () => {
    // In fsn1 the policy's x-amz-acl condition is not applied when a multipart upload begins, and
    // a finished public-read multipart upload was readable by anybody (2026-09-13). IgnorePublicAcls
    // alone, as measured one setting at a time: with BlockPublicAcls on as well, the CRM's own key
    // was refused its uploads (2026-09-14).
    const block =
      "BlockPublicAcls=false,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false";
    const setup = code("scripts/storage/setup-bucket.sh");
    expect(setup).toContain("put-public-access-block");
    expect(setup).toContain(block);
    expect(setup).toContain("get-public-access-block");
    // before the policy, so a re-run over a bucket whose block still refuses policies gets through
    expect(setup.indexOf("put-public-access-block")).toBeLessThan(
      setup.indexOf("put-bucket-policy"),
    );
    // the check re-sends the very same block, so a wrongly accepted probe changes nothing
    expect(code("scripts/storage/check-files-bucket.sh")).toContain(block);
  });

  it("tells whoever replaces the backup key to let it into both buckets", () => {
    // The files bucket's policy names the backup key too. RESTORE.md is read on the worst day: were
    // it to re-open only the backups bucket, the nightly copy of the files would fail from then on.
    const restore = code("RESTORE.md");
    // §2, the suspect server, and §10, a planned replacement
    expect(restore.match(/setup-bucket\.sh --files/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("the storage checks", () => {
  it("hand aws-cli a version id with `=`, since one may begin with a dash", () => {
    // written as `--version-id VALUE`, aws-cli reads a leading dash as an option of its own and
    // fails with ParamValidation — which a check then reports as "not a refusal" (2026-09-13)
    for (const file of [
      "scripts/storage/check-files-bucket.sh",
      "scripts/storage/check-backups-bucket.sh",
    ]) {
      expect(code(file), file).not.toMatch(/--version-id\s+"/);
      expect(code(file), file).toMatch(/--version-id="\$VERSION"/);
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
if [ "$1" = sync ]; then
  # the mirror: something lands in the destination, the last argument
  for last; do :; done
  mkdir -p "$last/2026-09" && printf 'an object' >"$last/2026-09/an-object"
  exit "\${STUB_SYNC_EXIT:-0}"
fi
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

  it("with a bucket, mirrors it after the dump and backs up the mirror beside the stage", () => {
    const n = night({ env: { BACKUP_FILES_REMOTE: "files:a-bucket" } });
    expect(n.code, n.stderr).toBe(0);
    const mirror = join(n.state, "files-mirror");
    expect(n.calls).toContain(
      `rclone sync --checksum --immutable --max-delete 1000 files:a-bucket ${mirror}`,
    );
    // the dump first, then the files — here, the mirror
    expect(n.calls.indexOf("pg_dump")).toBeLessThan(n.calls.indexOf("rclone sync"));
    expect(n.calls.indexOf("rclone sync")).toBeLessThan(n.calls.indexOf("restic backup"));
    // and the uploads directory too, while it exists (owner, 2026-09-14)
    expect(n.calls).toMatch(
      /restic backup .* \S+\/backup-stage \S+\/files-mirror \S+\/uploads\n/,
    );
    expect(statSync(mirror).mode & 0o777).toBe(0o700);
    expect(n.status).toMatchObject({ ok: true, reason: null });
  });

  it("a mirror that stops still puts the database in storage, keeps every old copy, and is red", () => {
    const n = night({
      env: { BACKUP_FILES_REMOTE: "files:a-bucket" },
      stub: { STUB_SYNC_EXIT: "7" },
    });
    expect(n.code).not.toBe(0);
    expect(n.status).toMatchObject({ ok: false, reason: "mirror" });
    // files.md decision 19: the database is copied anyway, and confirmed in storage
    expect(n.calls).toMatch(/restic backup .* \S+\/backup-stage /);
    expect(n.calls).toContain("restic snapshots");
    // and nothing older is cleared away after a night that may lack files (owner, 2026-09-14)
    expect(n.calls).not.toContain("restic forget");
  });

  it("with a bucket, an uploads directory that is gone is no failure — it has been retired", () => {
    const n = night({
      env: {
        BACKUP_FILES_REMOTE: "files:a-bucket",
        BACKUP_UPLOADS_DIR: "/nonexistent/uploads-for-tests",
      },
    });
    expect(n.code, n.stderr).toBe(0);
    expect(n.calls).toMatch(/restic backup .* \S+\/backup-stage \S+\/files-mirror\n/);
  });
});

describe("the files bucket, in the backups", () => {
  it("lets through at least three nights of the purge's deletions before the mirror stops", () => {
    // files.md §9: the nightly purge (stage B) removes at most 300 files, so ordinary disposal never
    // trips --max-delete, while a mass deletion does within a night — N ≥ 3 × P
    const NIGHTLY_PURGE_LIMIT = 300;
    const fromLib = Number(/BACKUP_FILES_MAX_DELETE:-(\d+)/.exec(read(LIB))?.[1]);
    const fromExample = Number(
      /BACKUP_FILES_MAX_DELETE=(\d+)/.exec(read("scripts/backup/backup.env.example"))?.[1],
    );
    for (const n of [fromLib, fromExample]) {
      expect(n).toBeGreaterThanOrEqual(3 * NIGHTLY_PURGE_LIMIT);
    }
  });

  it("never reads the CRM's own settings: the two families of keys never meet", () => {
    for (const file of SHELL) expect(code(file), file).not.toContain("FILES_S3_");
  });

  it("puts files back without overwriting, deleting, or uploading one kept on disk", () => {
    const putBack = code("scripts/backup/put-back-files.sh");
    expect(putBack).toContain("--ignore-existing");
    expect(putBack).toContain("RCLONE_CONFIG_PUTBACK_ENV_AUTH=false");
    expect(putBack).toContain(`where storage = 's3'`);
    expect(putBack).toMatch(/read -rs key_secret/);
    expect(putBack).not.toMatch(/rclone (sync|delete|deletefile|purge|move)\b/);
  });

  it("looks for each restored file where its row says it is", () => {
    expect(code(DRILL)).toContain(`coalesce(to_jsonb(f) ->> 'storage', 'local')`);
    for (const file of [DRILL, RESTORE]) expect(code(file), file).toContain(".mirrorPath");
  });

  it("has a sentence in the CRM for every reason a night or a restore test can report", () => {
    const sentences = read("server/core/backup-status.ts");
    const reasons = new Set<string>();
    for (const file of [BACKUP, DRILL, LIB]) {
      for (const m of code(file).matchAll(/\bbk_fail ([a-z_]+)|\bBK_REASON=([a-z_]+)/g)) {
        reasons.add((m[1] ?? m[2])!);
      }
    }
    expect(reasons.size).toBeGreaterThan(10);
    const unsaid = [...reasons].filter((r) => !new RegExp(`^\\s+${r}:`, "m").test(sentences));
    expect(unsaid).toEqual([]);
  });
});
