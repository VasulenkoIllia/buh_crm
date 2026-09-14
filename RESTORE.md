# Restoring buh_crm

Written for whoever has to do this without having built it — with the password manager, this
repository, and a bad morning. Commands run in the project directory on the server unless a step
says "from a laptop". Every script here says what it is about to do, and the ones that could replace
something ask first.

What the backups are: every night — at 02:00 the firm's time, or at 01:00 on a server set up without
sudo — the database, read back in full, and every client file go into one encrypted
[restic](https://restic.net) snapshot in the backups bucket, and the last seven daily copies are
kept. On the 1st of each month the newest copy is restored into a throwaway database, checked, and
removed again. Settings → System → **Nightly backups** says whether all of that is still happening.

**Two ways a server can be set up** (§7), and the commands below are written for the first:

- **as root** — `sudo` in front of the scripts, the key in `/etc/buh_crm/`, the logs in the journal;
- **as the deploy user, without sudo** (`install.sh --user`) — leave `sudo` out, read
  `~/.config/buh_crm/` wherever `/etc/buh_crm/` is written, and the logs are
  `~/.local/state/buh_crm/backup.log` and `drill.log`.

`crontab -l` showing a `buh_crm backups` block means the second.

## 1. What you need, and where it is

All of it in the firm's password manager — none of it in this repository, which is public.

| Entry                     | Why it matters                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The production `.env`     | `SECRETS_KEY` in it is **irreplaceable**: it unlocks the client secrets, the mailbox passwords and every two-factor sign-in secret stored in the database — and every client file, each sealed with a key it holds, so without it no file opens, in the bucket or from a backup. `SESSION_SECRET` and `POSTGRES_PASSWORD` can be new (everyone signs in again); `SMTP_PASS` comes from the mail provider. |
| The restic password       | Without it every backup is unreadable noise.                                                                                                                                                                                                                                                                                                                                                              |
| The backup key            | The access key and its secret, the id of the Hetzner project it was minted in, and the names of the two buckets.                                                                                                                                                                                                                                                                                          |
| The CRM's files key       | The access key and its secret, and the id of the Hetzner project it was minted in. Once the files live in the bucket it is on the server too, in the production `.env` (`FILES_S3_*`). Replacing it, or the backup key, is §10.                                                                                                                                                                           |
| The Hetzner Owner login   | To mint a new key when the old one is lost or suspect. Its second factor is kept apart from it.                                                                                                                                                                                                                                                                                                           |
| An admin's recovery codes | The ten codes shown when that admin switched two-factor sign-in on. The way back into the CRM when their phone is gone and no other admin can reset them — and they do not depend on `SECRETS_KEY`.                                                                                                                                                                                                       |

`.env` is never in a backup, on purpose: together with the database dump it would make every client
secret readable.

**Two-factor sign-in after a restore.** If the restored database is paired with a `SECRETS_KEY` that
did not seal it, codes from authenticator apps stop working — the server cannot read the secrets,
says so in its log, and tells the person to use a recovery code. Recovery codes still work. Sign in
with one as an admin, then reset everybody else's two-factor sign-in from Team → Reset 2FA; each of
them sets it up again from Profile → Security.

## 2. If the server may be compromised — before anything else

Whoever holds the server holds the backup key. In the Hetzner Console, open the key's own project →
Security → S3 credentials → delete it. The key cannot destroy the backups — the bucket refuses it —
but it can read them and hide them.

Once the client files live in the bucket, the server holds the CRM's files key as well (`.env`,
`FILES_S3_*`). Delete it too, in its own project. It can read and write the live files, but never
destroy a version, and what it reads opens only with `SECRETS_KEY` — which was on that server too:
treat everything it seals as read. Re-sealing under a new key is not built yet.

Then mint new keys in the same projects and let them into the buckets: the backups bucket names the
backup key, the files bucket both keys (the backup's read-only). From a laptop, with a temporary key
of the buckets' own project, deleted again afterwards:

```bash
./scripts/storage/setup-bucket.sh <backups-bucket> <location> <key-project-id> <new-access-key>
./scripts/storage/setup-bucket.sh --files <files-bucket> <files-location> \
  <crm-project-id> <new-crm-access-key> <key-project-id> <new-access-key>
```

The new CRM key goes into the clean server's `.env` (`FILES_S3_ACCESS_KEY_ID`,
`FILES_S3_SECRET_ACCESS_KEY`) and into the password manager. Before the files have moved, the CRM's
key was never on the server: name its current access key there instead of a new one.

Restore from a clean machine, never from the suspect server.

## 3. What is in storage

```bash
sudo ./scripts/backup/restore.sh --list
```

## 4. The database or the files are wrong, and the server is fine

Restore beside the live database, which is never touched:

```bash
sudo ./scripts/backup/restore.sh --into buh_crm_restore
```

The newest copy by default; `--snapshot <id>` for an older one from the list. Look at it (DataGrip
through the SSH tunnel, database `buh_crm_restore`), and when it is the one you want, make it live:

```bash
./scripts/backup/restore.sh --swap buh_crm_restore
docker compose up -d app
```

`--swap` stops the app, ends every session — an open DataGrip tunnel counts — and swaps the two
names in one transaction, both or neither. The replaced database is kept as
`buh_crm_replaced_<time>` until you drop it.

Nothing here drops a database by itself: `buh_crm_restore`, when it was only looked at, and
`buh_crm_replaced_<time>` stay beside the live one — each a full copy of the client book — until
somebody removes them. When you are done with one, by its exact name, never the live `buh_crm`:

```bash
docker exec buh_crm-db sh -c 'dropdb -U "$POSTGRES_USER" buh_crm_restore'
```

(The monthly restore test is different: its database lives in a container of its own, removed with
its data at the end of every run.)

Client files come back into a directory of their own, and you copy what is needed from there:

```bash
sudo ./scripts/backup/restore.sh --files-to /tmp/files-restore
```

A file the database names but the snapshot lacks — deleted while that night's backup was running —
is fetched from an earlier snapshot. Files no database row names are listed, never deleted.

Once the client files live in the files bucket, the bucket itself usually needs nothing: it keeps
every deleted object for 30 days as a hidden version. When objects are gone from it, the ones the
database keeps there go back from that directory. Only what the bucket lacks goes back; nothing is
overwritten or deleted, and a file kept on disk is never uploaded. It asks for the CRM's key:

```bash
./scripts/backup/put-back-files.sh /tmp/files-restore --dry-run
./scripts/backup/put-back-files.sh /tmp/files-restore
```

## 5. A deploy went wrong

`./scripts/deploy.sh` ends with the line that undoes it:

```bash
./scripts/backup/restore.sh --rollback ~/buh_crm_<date>_<commit>.dump
```

It restores the pre-deploy dump beside the live database, swaps it in as above, and prints how to
bring the app back on the commit the dump was taken from — the container runs the migrations on
every start, so the new image would re-apply the one just undone. Later, once the fix is on `main`:
`git checkout main && ./scripts/deploy.sh`.

## 6. The server is gone

If the old server still runs — a move rather than a loss — switch its schedule off there first:
`sudo ./scripts/backup/install.sh --disable-timers`, or without sudo
`./scripts/backup/install.sh --user --disable-timers`. Two servers would write the same repository,
and whichever wrote last each night would be the copy a restore brings back.

1. A new server with Docker, the compose plugin and git. The app sits behind a Traefik stack that
   lives outside this repository — the external `proxy` network and the `cf` certificate resolver.
   If it is not there yet, `docker network create proxy` lets the app start and answer on the server
   itself.
2. Clone this repository into the project directory, put the `.env` from the password manager in it,
   and `mkdir -p data/postgres data/uploads`. That `.env` carries `SECRETS_KEY` — without it no
   client file opens — and, once the files live in the bucket, the CRM's key to it (`FILES_S3_*`).
3. The tools (§8), then `sudo ./scripts/backup/install.sh` — or, without sudo, §7's first two lines
   (the status directory and its line in `.env`) and `./scripts/backup/install.sh --user`.
   **Replace the restic password it generated with the saved one** —
   `sudo nano /etc/buh_crm/restic.pass` — and fill in `/etc/buh_crm/backup.env` with the backup key
   (a new one, if §2 applies).
4. The database container alone: `docker compose up -d db`. It starts with an empty `buh_crm`.
5. `sudo ./scripts/backup/restore.sh --into buh_crm_restore --files-to ./data/uploads`. Once the
   client files live in the bucket, they were never on that server and the bucket still has them:
   `--into buh_crm_restore` alone brings the database back to them. `--files-to` is then only for
   files the bucket lacks — into an empty directory, and back with `put-back-files.sh` (§4).
6. `./scripts/backup/restore.sh --swap buh_crm_restore` — the empty database is kept as
   `buh_crm_replaced_<time>`; drop it.
7. `./scripts/deploy.sh`, and point the DNS at the new server.
8. The backups again: §7 from its fourth line — a first backup, a first restore test, the timers.
   The repository is the one you just restored from; `--init` would only say so.

## 7. Setting up a server

The scripts and the CRM's read-only mount arrive with the code — on a running server, with
`./scripts/deploy.sh`, which pulls it. Then once, in this order (`install.sh` prints it too).
Finish on the day of that deploy: the CRM checks the backups by itself at 03:50, and from then on a
server without one is — truthfully — a red row and an email to the admin.

**With sudo** — the key readable by root only, systemd timers at 02:00 the firm's time:

```bash
sudo ./scripts/backup/install.sh
sudo nano /etc/buh_crm/backup.env
sudo ./scripts/backup/install.sh --init
sudo ./scripts/backup/backup.sh
sudo ./scripts/backup/drill.sh
sudo ./scripts/backup/install.sh --enable-timers
docker compose exec -T app npx tsx scripts/backup-check.ts
```

**Without sudo**, as the deploy user — everything under its home (`~/.config/buh_crm`,
`~/.local/state/buh_crm`), the schedule in its crontab, the backup at 01:00 the firm's time (the
one small hour a daylight-saving spring night does not skip). Not weaker when that user is in the
docker group, which is root in all but name. The status directory must exist, and the project's
`.env` must name it, **before** the deploy that mounts it — otherwise Docker creates it itself, as
root, and the deploy user can no longer write there:

```bash
mkdir -p ~/.local/state/buh_crm/backup-status
printf '\nBACKUP_STATUS_HOST_DIR=%s\n' "$HOME/.local/state/buh_crm/backup-status" >> .env
./scripts/deploy.sh
./scripts/backup/install.sh --user
nano ~/.config/buh_crm/backup.env
./scripts/backup/install.sh --user --init
./scripts/backup/backup.sh
./scripts/backup/drill.sh
crontab -l > ~/crontab-before-backups.txt 2>/dev/null || true
./scripts/backup/install.sh --user --enable-timers
docker compose exec -T app npx tsx scripts/backup-check.ts
```

The last line of either puts the result on Settings → System → Nightly backups now, rather than at
the next 03:50 — and it is also how a row turned red by a failed night goes green once the failure
is put right. The scripts find their environment file by themselves: root's, or else the deploy
user's. Without sudo the schedule goes into that user's crontab, which on a shared server holds
other projects' jobs too: `--enable-timers` and `--disable-timers` rewrite only the block between
their own markers, and the copy taken just before is the way back —
`crontab ~/crontab-before-backups.txt`.

`install.sh` creates the directories, writes the environment file from
`scripts/backup/backup.env.example`, generates the restic password — **put it in the password
manager at once** — and prepares the schedule, left off until a backup and a restore test have
passed by hand. The schedule carries the firm's timezone (the `TZ` line of `.env`), so the server's
own clock, shared with other projects, is never changed.

The environment file names the repository as

```
RESTIC_REPOSITORY=s3:https://<location>.your-objectstorage.com/<backups-bucket>/restic
```

— under `restic/`, where the bucket's policy lets the backup key in.

Once the client files have moved into the files bucket — never before the move has run — the same
file gains the mirror. Uncomment the six `BACKUP_FILES_REMOTE` and `RCLONE_CONFIG_FILES_*` lines of
the example, with the files bucket's name and location. Then run the setup again for the mirror's
directory (`./scripts/backup/install.sh --user`, or with sudo as above), and one backup and one
restore test by hand. The backup key reads that bucket too: its policy names it, read-only.

## 8. Tools

restic 0.19.1 or later, rclone 1.60 or later, jq, flock (util-linux), curl and openssl. On Ubuntu —
`uname -m` saying `aarch64` means `arm64` in the file names below:

```bash
sudo apt-get install -y jq bzip2 curl
curl -fsSLO https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2
curl -fsSLO https://github.com/restic/restic/releases/download/v0.19.1/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
bunzip2 restic_0.19.1_linux_amd64.bz2 && sudo install -m 0755 restic_0.19.1_linux_amd64 /usr/local/bin/restic
curl -fsSLO https://downloads.rclone.org/rclone-current-linux-amd64.deb && sudo dpkg -i rclone-current-linux-amd64.deb
```

Without sudo, into `~/.local/bin` (a login shell puts it on the PATH once it exists; the schedule
names it itself) — and `jq` only if `command -v jq` finds none:

```bash
mkdir -p ~/.local/bin && cd "$(mktemp -d)"
curl -fsSLO https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2
curl -fsSLO https://github.com/restic/restic/releases/download/v0.19.1/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
python3 -c "import bz2, shutil; shutil.copyfileobj(bz2.open('restic_0.19.1_linux_amd64.bz2'), open('restic_0.19.1_linux_amd64', 'wb'))"
install -m 0755 restic_0.19.1_linux_amd64 ~/.local/bin/restic
curl -fsSLO https://downloads.rclone.org/rclone-current-linux-amd64.zip
python3 -m zipfile -e rclone-current-linux-amd64.zip . && install -m 0755 rclone-*-linux-amd64/rclone ~/.local/bin/rclone
curl -fsSL -o ~/.local/bin/jq https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64 && chmod 0755 ~/.local/bin/jq
export PATH="$HOME/.local/bin:$PATH"
```

Distribution packages of restic are far behind; `restic self-update` keeps the binary current (with
`sudo` for the one in `/usr/local/bin`).

## 9. Older than seven days

The seven copies roll over, but a pruned copy is only _hidden_ in the bucket, and hidden versions
are kept for 90 days. The backup key can read them. From a laptop, the repository as it stood at a
given moment — the time in UTC, with its `Z` written out:

```bash
export RCLONE_CONFIG_OLD_TYPE=s3 RCLONE_CONFIG_OLD_PROVIDER=Other RCLONE_CONFIG_OLD_ENV_AUTH=true
export RCLONE_CONFIG_OLD_ENDPOINT=https://<location>.your-objectstorage.com RCLONE_CONFIG_OLD_REGION=<location>
read -r AWS_ACCESS_KEY_ID; read -rs AWS_SECRET_ACCESS_KEY; export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
rclone copy "old,version_at='2026-09-01T03:00:00Z':<backups-bucket>/restic" /tmp/restic-then
RESTIC_REPOSITORY=/tmp/restic-then restic snapshots
```

Then restore from `/tmp/restic-then` with `restic restore`. _Not yet rehearsed against the real
bucket — rehearse it before relying on it._

## 10. Replacing a key

### The backup key

Mint a new key in its project, let it into both buckets, use it, and only then delete the old one.
Each policy names one backup key, so the old one stops working the moment the new one is let in. The
files bucket's policy names the CRM's key as well: give it the CRM's current one, or the CRM is shut
out of its own files.

```bash
./scripts/storage/setup-bucket.sh <backups-bucket> <location> <key-project-id> <new-access-key>
./scripts/storage/setup-bucket.sh --files <files-bucket> <files-location> \
  <crm-project-id> <crm-access-key> <key-project-id> <new-access-key>
sudo nano /etc/buh_crm/backup.env   # --user: nano ~/.config/buh_crm/backup.env
sudo ./scripts/backup/backup.sh     # --user: ./scripts/backup/backup.sh
```

### The CRM's files key

Once the client files live in the bucket, the server holds it in `.env` (`FILES_S3_ACCESS_KEY_ID`,
`FILES_S3_SECRET_ACCESS_KEY`), and the files bucket's policy names it beside the backup key. The old
key stops working the moment the new one is let in, so the two steps below go together, at a quiet
hour: in between, uploads and downloads are refused. Mint a new key in its own project, then, from a
laptop, with a temporary key of the buckets' project, deleted again afterwards:

```bash
./scripts/storage/setup-bucket.sh --files <files-bucket> <files-location> \
  <crm-project-id> <new-crm-access-key> <backup-project-id> <backup-access-key>
```

Then on the server:

```bash
nano .env          # FILES_S3_ACCESS_KEY_ID and FILES_S3_SECRET_ACCESS_KEY: the new key's
./scripts/deploy.sh
```

Open one client's file and upload another to be sure, put the new key in the password manager, and
only then delete the old one in the Console.

## 11. When something says it failed

- **Settings → System → Nightly backups is red.** Its ⓘ says why. On the server:
  `sudo ./scripts/backup/install.sh --status`, and `journalctl -u buh_crm-backup.service -n 100`;
  without sudo, `./scripts/backup/install.sh --user --status`, and
  `tail -n 100 ~/.local/state/buh_crm/backup.log` (`drill.log` for the restore test). Once the
  cause is put right, `docker compose exec -T app npx tsx scripts/backup-check.ts` turns the row
  green without waiting for the next morning.
- **"The client files could not be copied from their bucket"** (reason `mirror`, once the files
  live in the bucket). The database was copied anyway, and no older copy was cleared. `backup.log`
  says which of three:
  - _"immutable file modified"_: an object in the files bucket changed, which never happens
    legitimately. Find out why first (Settings → Activity; who holds the CRM's key). Once the
    bucket holds the right object again, the next night passes by itself.
  - _"--max-delete"_ (rclone exit 7): more files left the bucket in a day than a night lets
    through. Settings → Activity says who deleted them. If it was meant, run one backup with a
    higher limit, `BACKUP_FILES_MAX_DELETE=5000 ./scripts/backup/backup.sh` — or raise it for one
    night in the environment file, if that file sets it.
  - access or network errors: the backup key cannot read the files bucket. It must be the key the
    bucket's policy names (`setup-bucket.sh --files`, §10).
- **restic exits 11** — the repository is locked by a run that crashed. Every night unlocks it by
  itself; before a command by hand: `sudo sh -c 'set -a; . /etc/buh_crm/backup.env; restic unlock'`
  (without sudo: `sh -c 'set -a; . ~/.config/buh_crm/backup.env; restic unlock'`).
- **"Access Denied" on a restic lock file**, with nothing changed on your side: in 2026 a release of
  the storage engine behind Hetzner's object storage (Ceph 19.2.6 and 20.2.4) was reported to break
  restic's signed requests until the next fix. Check restic's issue tracker before blaming the key.
