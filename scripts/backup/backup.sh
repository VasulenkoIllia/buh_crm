#!/usr/bin/env bash
#
# The nightly backup: the database, read back in full, and every client file — one encrypted restic
# snapshot. Then the snapshot is confirmed in storage, the history trimmed to the last seven days,
# and the result written where the CRM reads it.
#
#   ./scripts/backup/backup.sh [ENV_FILE]    default: /etc/buh_crm/backup.env (root's setup), else
#                                            ~/.config/buh_crm/backup.env (install.sh --user)
#
# THE DUMP FIRST, then the files (docs: backups.md §6). A file uploaded in between becomes an orphan
# the restore lists; the other order gives a database row pointing at bytes that were never copied,
# which nothing reports until somebody opens the document. It looks like tidying to swap the two —
# don't.
#
# Never in the snapshot: the project's environment file (it holds SECRETS_KEY — with the dump that
# is plaintext), the project directory, or ./data/postgres (a running database copied as files is
# not a database; the dump is the copy). This script does not read the project's environment file
# at all: the database container already knows its own user and database.

set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

bk_init backup
bk_load_env "${1:-}"
bk_defaults
bk_need restic jq docker flock
if ! bk_lock -n; then
  BK_LOCKED_OUT=1
  bk_say "another run holds the lock — nothing done"
  exit 75
fi
bk_start

STAGE=$BACKUP_STATE_DIR/backup-stage
bk_cleanup() { rm -f "$STAGE/db.dump" "$STAGE/manifest.json"; }

[ -d "$BACKUP_UPLOADS_DIR" ] || bk_fail config "no uploads directory at $BACKUP_UPLOADS_DIR"
UPLOADS=$(cd "$BACKUP_UPLOADS_DIR" && pwd)

# ── free space — the stage shares its disk with ./data/postgres ─────────────
prev=$(bk_status_get '.snapshot.dumpBytes // 0')
need=$(( ${prev:-0} * 2 / 1048576 + BACKUP_MIN_FREE_MB ))
free=$(bk_free_mb "$BACKUP_STATE_DIR")
[ "$free" -ge "$need" ] || bk_fail disk "only $free MB free next to the database, $need MB needed"

mkdir -p "$STAGE"
chmod 0700 "$STAGE"
bk_cleanup

# ── 1. the dump, inside the database container, so the tools match the server
BK_REASON=dump
bk_say "dumping the database"
docker exec "$BACKUP_DB_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -Fc -Z0 "$POSTGRES_DB"' >"$STAGE/db.dump"
[ -s "$STAGE/db.dump" ] || bk_fail dump "the dump is empty"

# ── 2. read it back in full — a dump cut off halfway still lists its contents
BK_REASON=verify
docker exec -i "$BACKUP_DB_CONTAINER" pg_restore -f /dev/null <"$STAGE/db.dump"
DUMP_BYTES=$(wc -c <"$STAGE/db.dump" | tr -d ' ')

# ── 3. what a restore needs to find its way around the snapshot ─────────────
jq -n --arg at "$(bk_now)" --arg host "$BK_HOST" --arg uploads "$UPLOADS" --arg stage "$STAGE" \
  --argjson bytes "$DUMP_BYTES" \
  '{schema: 1, takenAt: $at, host: $host, uploadsPath: $uploads, stagePath: $stage, dumpBytes: $bytes}' \
  >"$STAGE/manifest.json"

# ── 4. a lock a crashed run left behind would block every night after it ────
BK_REASON=restic
restic unlock --quiet

# ── 5. one snapshot: the stage (dump first, already written) and the files ──
bk_say "writing the snapshot"
set +e
restic backup --json --quiet --host buh-crm --retry-lock 30m "$STAGE" "$UPLOADS" \
  >"$BK_TMP/backup.json" 2>"$BK_TMP/backup.err"
rc=$?
set -e
cat "$BK_TMP/backup.err" >&2
case $rc in
  0) ;;
  # 3 is the trap: the snapshot WAS made, with holes in it. An incomplete copy that looks like a
  # success is exactly what this script exists to prevent — and `forget` must not run after it.
  3) bk_fail incomplete "restic could not read every file (exit 3)" ;;
  *) bk_fail restic "restic backup exited $rc" ;;
esac
SUMMARY=$(jq -c 'select(.message_type == "summary")' "$BK_TMP/backup.json" | sed -n '$p')
[ -n "$SUMMARY" ] || bk_fail restic "restic printed no summary"
SNAP=$(jq -r '.snapshot_id // empty' <<<"$SUMMARY")
[ -n "$SNAP" ] || bk_fail restic "restic reported no snapshot"

# ── 6. it is really in storage ──────────────────────────────────────────────
BK_REASON=not_in_storage
restic snapshots --json >"$BK_TMP/snapshots.json"
jq -e --arg id "$SNAP" 'any(.[]; .id == $id)' "$BK_TMP/snapshots.json" >/dev/null ||
  bk_fail not_in_storage "the new snapshot is not listed"

# ── 7. versioning still on — without it a delete destroys instead of hiding ─
BK_REASON=versioning
VERSIONING=$(bk_versioning)
case "$VERSIONING" in
  Enabled | not_applicable) ;;
  *) bk_fail versioning "the bucket's versioning reads '$VERSIONING'" ;;
esac

# ── 8. the last seven days; `--group-by ''` so a new path can never freeze old snapshots
BK_REASON=forget
restic forget --quiet --group-by '' --keep-daily "$BACKUP_KEEP_DAILY" --prune --max-unused 0 \
  --retry-lock 30m >&2

# ── 9. what storage holds now ───────────────────────────────────────────────
BK_REASON=restic
restic snapshots --json >"$BK_TMP/snapshots.json"
COPIES=$(jq 'length' "$BK_TMP/snapshots.json")
OLDEST=$(jq -r 'map(.time) | sort | first // empty' "$BK_TMP/snapshots.json")

bk_status_update '.snapshot = {id: $s.snapshot_id[0:8], addedBytes: $s.data_added,
    totalBytes: $s.total_bytes_processed, files: $s.total_files_processed, dumpBytes: $bytes}
  | .copies = $copies | .keep = $keep | .oldestCopyAt = $oldest | .versioning = $versioning' \
  --argjson s "$SUMMARY" --argjson bytes "$DUMP_BYTES" --argjson copies "$COPIES" \
  --argjson keep "$BACKUP_KEEP_DAILY" --arg oldest "$OLDEST" --arg versioning "$VERSIONING"
BK_REASON=

# Optional, and never a reason to fail a good night: a URL that a service expects to hear from
# every day — the one alarm that still works when the whole server is down.
if [ -n "${BACKUP_PING_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_PING_URL" || bk_say "the ping did not go through"
fi
bk_say "done: snapshot ${SNAP:0:8}, $COPIES copies in storage"
