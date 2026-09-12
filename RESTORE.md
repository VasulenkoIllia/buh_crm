# Restoring buh_crm

Written for whoever has to do this without having built it — with the password manager, this
repository, and a bad morning. Commands run in the project directory on the server unless a step
says "from a laptop". Every script here says what it is about to do, and the ones that could replace
something ask first.

What the backups are: every night at 02:00, the firm's time, the database — read back in full — and
every client file go into one encrypted [restic](https://restic.net) snapshot in the backups bucket,
and the last seven daily copies are kept. On the 1st of each month the newest copy is restored into
a throwaway database and checked. Settings → System → **Nightly backups** says whether all of that
is still happening.

## 1. What you need, and where it is

All of it in the firm's password manager — none of it in this repository, which is public.

| Entry                   | Why it matters                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The production `.env`   | `SECRETS_KEY` in it is **irreplaceable**: it unlocks the client secrets and the mailbox passwords stored in the database. `SESSION_SECRET` and `POSTGRES_PASSWORD` can be new (everyone signs in again); `SMTP_PASS` comes from the mail provider. |
| The restic password     | Without it every backup is unreadable noise.                                                                                                                                                                                                       |
| The backup key          | The access key and its secret, the id of the Hetzner project it was minted in, and the names of the two buckets.                                                                                                                                   |
| The Hetzner Owner login | To mint a new key when the old one is lost or suspect. Its second factor is kept apart from it.                                                                                                                                                    |

`.env` is never in a backup, on purpose: together with the database dump it would make every client
secret readable.

## 2. If the server may be compromised — before anything else

Whoever holds the server holds the backup key. In the Hetzner Console, open the key's own project →
Security → S3 credentials → delete it. The key cannot destroy the backups — the bucket refuses it —
but it can read them and hide them.

Then mint a new key in the same project and let it into the bucket. From a laptop, with a temporary
key of the bucket's own project, deleted again afterwards:

```bash
./scripts/storage/setup-bucket.sh <backups-bucket> <location> <key-project-id> <new-access-key>
```

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

Client files come back into a directory of their own, and you copy what is needed from there:

```bash
sudo ./scripts/backup/restore.sh --files-to /tmp/files-restore
```

A file the database names but the snapshot lacks — deleted while that night's backup was running —
is fetched from an earlier snapshot. Files no database row names are listed, never deleted.

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

1. A new server with Docker, the compose plugin and git. The app sits behind a Traefik stack that
   lives outside this repository — the external `proxy` network and the `cf` certificate resolver.
   If it is not there yet, `docker network create proxy` lets the app start and answer on the server
   itself.
2. Clone this repository into the project directory, put the `.env` from the password manager in it,
   and `mkdir -p data/postgres data/uploads`.
3. The tools (§8), then `sudo ./scripts/backup/install.sh`. **Replace the restic password it
   generated with the saved one** — `sudo nano /etc/buh_crm/restic.pass` — and fill in
   `/etc/buh_crm/backup.env` with the backup key (a new one, if §2 applies).
4. The database container alone: `docker compose up -d db`. It starts with an empty `buh_crm`.
5. `sudo ./scripts/backup/restore.sh --into buh_crm_restore --files-to ./data/uploads`
6. `./scripts/backup/restore.sh --swap buh_crm_restore` — the empty database is kept as
   `buh_crm_replaced_<time>`; drop it.
7. `./scripts/deploy.sh`, and point the DNS at the new server.
8. The backups again: §7 from its fourth line — a first backup, a first restore test, the timers.
   The repository is the one you just restored from; `--init` would only say so.

## 7. Setting up a server

The scripts and the CRM's read-only mount arrive with the code — on a running server, with
`./scripts/deploy.sh`, which pulls it. Then once, as root, in this order (`install.sh` prints it
too):

```bash
sudo ./scripts/backup/install.sh
sudo nano /etc/buh_crm/backup.env
sudo ./scripts/backup/install.sh --init
sudo ./scripts/backup/backup.sh
sudo ./scripts/backup/drill.sh
sudo ./scripts/backup/install.sh --enable-timers
docker compose exec -T app npx tsx scripts/backup-check.ts
```

The last line puts the result on Settings → System → Nightly backups now, rather than at the next
03:50 — and it is also how a row turned red by a failed night goes green once the failure is put
right. Finish on the day of that deploy: the CRM checks the backups by itself at 03:50, and from
then on a server without one is — truthfully — a red row and an email to the admin.

`install.sh` creates `/etc/buh_crm` (root only) and `/var/lib/buh_crm`, writes the environment file
from `scripts/backup/backup.env.example`, generates the restic password — **put it in the password
manager at once** — and installs two systemd timers, left off until a backup and a restore test have
passed by hand. The timers carry the firm's timezone (the `TZ` line of `.env`), so the server's own
clock, shared with other projects, is never changed.

The environment file names the repository as

```
RESTIC_REPOSITORY=s3:https://<location>.your-objectstorage.com/<backups-bucket>/restic
```

— under `restic/`, where the bucket's policy lets the backup key in.

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

Distribution packages of restic are far behind; `sudo restic self-update` keeps the binary current.

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

## 10. Replacing the backup key

Mint a new key in its project, let it in, use it, and only then delete the old one. The policy names
one key, so the old one stops working the moment the new one is let in:

```bash
./scripts/storage/setup-bucket.sh <backups-bucket> <location> <key-project-id> <new-access-key>
sudo nano /etc/buh_crm/backup.env
sudo ./scripts/backup/backup.sh
```

## 11. When something says it failed

- **Settings → System → Nightly backups is red.** Its ⓘ says why. On the server:
  `sudo ./scripts/backup/install.sh --status`, and `journalctl -u buh_crm-backup.service -n 100`.
- **restic exits 11** — the repository is locked by a run that crashed. Every night unlocks it by
  itself; before a command by hand: `sudo sh -c 'set -a; . /etc/buh_crm/backup.env; restic unlock'`.
- **"Access Denied" on a restic lock file**, with nothing changed on your side: in 2026 a release of
  the storage engine behind Hetzner's object storage (Ceph 19.2.6 and 20.2.4) was reported to break
  restic's signed requests until the next fix. Check restic's issue tracker before blaming the key.
