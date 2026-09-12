/**
 * `install.sh --user`, and the scripts finding a --user setup by themselves.
 *
 * The server this firm runs gives its deploy user no sudo (2026-09-12), so this is the path actually
 * used there: everything under the user's home, the schedule in its crontab. These tests run the
 * installer against a throwaway HOME, with stand-ins for restic, rclone, docker — and crontab, which
 * reads and writes a file the test names, so a real crontab is never touched.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const INSTALL = "scripts/backup/install.sh";
const BACKUP = "scripts/backup/backup.sh";
const SNAP = "feedface".repeat(8);

const STUBS: Record<string, string> = {
  restic: `#!/bin/sh
case "$1" in
  version) echo "restic 0.19.1 compiled with go1.26 on linux/amd64" ;;
  backup) printf '{"message_type":"summary","data_added":1,"total_files_processed":1,"total_bytes_processed":1,"snapshot_id":"${SNAP}"}\\n' ;;
  snapshots) printf '[{"id":"${SNAP}","time":"2026-09-11T05:00:00Z"}]\\n' ;;
esac
exit 0
`,
  rclone: `#!/bin/sh
[ "$1" = version ] && echo "rclone v1.75.1"
exit 0
`,
  docker: `#!/bin/sh
case "$*" in
  *pg_dump*) printf 'PGDMP-stand-in' ;;
  *pg_restore*) cat >/dev/null ;;
esac
exit 0
`,
  // a crontab kept in a file the test names — never the real one
  crontab: `#!/bin/sh
tab=\${CRONTAB_FILE:?no crontab in this test}
case "$1" in
  -l) [ -s "$tab" ] || { echo "no crontab for test" >&2; exit 1; }; cat "$tab" ;;
  -) cat >"$tab.new" && mv "$tab.new" "$tab" ;;
  *) exit 2 ;;
esac
`,
};

let root = "";
let bin = "";

function installer(home: string, ...args: string[]) {
  return spawnSync("bash", [INSTALL, "--user", "--tz", "America/New_York", ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
  });
}

/** the lines of a file a shell would act on — its comments may name anything */
const settings = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .join("\n");

describe("install.sh --user", () => {
  beforeAll(() => {
    if (spawnSync("sh", ["-c", "command -v flock"]).status !== 0) {
      throw new Error("flock is needed for the backup scripts — on a Mac: brew install flock");
    }
    root = mkdtempSync(join(tmpdir(), "buh-crm-install-test-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(bin, name), body, { mode: 0o755 });
    }
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("sets everything up under the deploy user's home, and nothing under /etc or /var/lib", () => {
    const home = mkdtempSync(join(root, "home-"));
    const res = installer(home);
    expect(res.status, res.stderr).toBe(0);

    const etc = join(home, ".config/buh_crm");
    const state = join(home, ".local/state/buh_crm");
    expect(statSync(etc).mode & 0o777).toBe(0o700);
    expect(statSync(join(etc, "backup.env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(etc, "restic.pass")).mode & 0o777).toBe(0o600);
    expect(statSync(join(state, "backup-stage")).mode & 0o777).toBe(0o700);
    expect(statSync(join(state, "backup-status")).mode & 0o777).toBe(0o755);

    const env = settings(readFileSync(join(etc, "backup.env"), "utf8"));
    expect(env).toContain(`RESTIC_PASSWORD_FILE=${etc}/restic.pass`);
    expect(env).toContain(`BACKUP_STATE_DIR=${state}`);
    expect(env).not.toContain("/etc/buh_crm");
    expect(env).not.toContain("/var/lib/buh_crm");

    // the app does not read this home yet, and it says exactly what the .env needs
    expect(res.stdout).toContain(`BACKUP_STATUS_HOST_DIR=${state}/backup-status`);
  });

  it("changes nothing it already made on a second run — above all not the restic password", () => {
    const home = mkdtempSync(join(root, "home-"));
    expect(installer(home).status).toBe(0);
    const pass = readFileSync(join(home, ".config/buh_crm/restic.pass"), "utf8");
    const again = installer(home);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("exists — left as it is");
    expect(readFileSync(join(home, ".config/buh_crm/restic.pass"), "utf8")).toBe(pass);
  });

  it("schedules by the firm's clock — asked every hour, run at 01:00 and on the 1st at 05:00", () => {
    const home = mkdtempSync(join(root, "home-"));
    const res = installer(home, "--show-cron");
    expect(res.status, res.stderr).toBe(0);
    const lines = res.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^# >>> buh_crm backups/);
    expect(lines[lines.length - 1]).toMatch(/^# <<< buh_crm backups/);
    expect(res.stdout).toContain('[ "$(TZ=America/New_York date +\\%H)" = 01 ]');
    expect(res.stdout).toContain('[ "$(TZ=America/New_York date +\\%d\\%H)" = 0105 ]');
    expect(res.stdout).toContain(`PATH=${home}/.local/bin:`);
    expect(res.stdout).toContain(`scripts/backup/backup.sh ${home}/.config/buh_crm/backup.env`);
    expect(res.stdout).toContain(`scripts/backup/drill.sh ${home}/.config/buh_crm/backup.env`);
    // crontab reads a bare % as a line break: every one is escaped
    expect(res.stdout).not.toMatch(/[^\\]%/);
    // cron's shell creates the log before the script's own umask — restic's errors name the storage
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/^0 \* \* \* \* umask 077; /);
  });

  it("switches the schedule on and off without touching another project's cron lines", () => {
    // the server is shared: its crontab holds other projects' jobs, and they must survive every edit
    const home = mkdtempSync(join(root, "home-"));
    expect(installer(home).status).toBe(0);
    const tab = join(home, "crontab");
    const theirs = "15 4 * * * /srv/another-project/nightly.sh\n";
    writeFileSync(tab, theirs);
    const run = (flag: string) =>
      spawnSync("bash", [INSTALL, "--user", "--tz", "America/New_York", flag], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, CRONTAB_FILE: tab },
      });

    for (const attempt of ["first", "again"]) {
      const on = run("--enable-timers");
      expect(on.status, `${attempt}: ${on.stderr}`).toBe(0);
      const text = readFileSync(tab, "utf8");
      expect(text.startsWith(theirs), attempt).toBe(true);
      expect(text.match(/^# >>> buh_crm backups/gm), attempt).toHaveLength(1);
      expect(text, attempt).toContain("scripts/backup/backup.sh");
    }

    const off = run("--disable-timers");
    expect(off.status, off.stderr).toBe(0);
    expect(readFileSync(tab, "utf8")).toBe(theirs);
  });

  it("without --user and without root, says which of the two to use", () => {
    const res = spawnSync("bash", [INSTALL], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--user");
  });

  it("an unknown timezone stops the setup rather than scheduling by the wrong clock", () => {
    const home = mkdtempSync(join(root, "home-"));
    const res = spawnSync("bash", [INSTALL, "--user", "--tz", "Mars/Olympus_Mons"], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("not a timezone");
  });

  it("the scripts find a --user setup's environment file without being told where it is", () => {
    const home = mkdtempSync(join(root, "home-"));
    const etc = join(home, ".config/buh_crm");
    const state = join(home, ".local/state/buh_crm");
    const uploads = join(home, "uploads");
    mkdirSync(etc, { recursive: true });
    mkdirSync(uploads);
    writeFileSync(join(uploads, "a-client-document.pdf"), "bytes");
    writeFileSync(
      join(etc, "backup.env"),
      [
        "RESTIC_REPOSITORY=/nonexistent/repository-for-tests",
        "RESTIC_PASSWORD=test",
        `BACKUP_STATE_DIR=${state}`,
        `BACKUP_UPLOADS_DIR=${uploads}`,
        `BACKUP_LOCK_DIR=${home}`,
        "BACKUP_MIN_FREE_MB=0",
        "",
      ].join("\n"),
    );
    const res = spawnSync("bash", [BACKUP], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
    });
    expect(res.status, res.stderr).toBe(0);
    const status = JSON.parse(
      readFileSync(join(state, "backup-status/backup-primary.json"), "utf8"),
    ) as { ok: boolean };
    expect(status.ok).toBe(true);
  });
});
