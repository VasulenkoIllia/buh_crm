#!/usr/bin/env bash
#
# The restore test — the 1st of every month, and by hand after the first backup. It restores the
# newest snapshot FROM STORAGE into a throwaway database with no network, removed afterwards, and
# checks what came back:
#
#   - the same tables as the live database, when both are at the same migration (otherwise it says
#     which migration the snapshot predates — right after a deploy that is normal, not a failure);
#   - every table's rows within reach of the live count — no table is named: a list here is how a
#     future table would be missed;
#   - every file the restored database names is in the snapshot, where its row says it is — the
#     uploads directory or the files bucket's mirror — allowing a handful deleted while the backup
#     ran (docs: backups.md §6), and a sample restored and its size compared;
#   - `restic check --read-data-subset=5%`: a sample of what is stored, downloaded and verified.
#
#   ./scripts/backup/drill.sh [ENV_FILE]     default: /etc/buh_crm/backup.env (root's setup), else
#                                            ~/.config/buh_crm/backup.env (install.sh --user)
#
# It waits for a running backup rather than skipping. The live database is only ever read: its
# table list, its row counts and its newest migration.

set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

bk_init drill
bk_load_env "${1:-}"
bk_defaults
bk_need restic jq docker flock awk
DRILL=buh_crm-drill-$BACKUP_DESTINATION
SCRATCH=$BACKUP_STATE_DIR/drill-scratch
# `-v` every time: the image keeps its data in a volume of its own, and `--rm` removes that only when
# the container stops by itself. `docker rm -f` without `-v` left the restored database behind as an
# anonymous volume — a full copy of the client book, one more every month (audit, 2026-09-12).
bk_cleanup() {
  docker rm -f -v "$DRILL" >/dev/null 2>&1
  rm -rf "$SCRATCH"
}
bk_start
bk_lock -w "${BACKUP_DRILL_WAIT_SECONDS:-7200}" || bk_fail lock_timeout "a backup held the lock for two hours"

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
chmod 0700 "$SCRATCH"
docker rm -f -v "$DRILL" >/dev/null 2>&1 || true

drill_sql() { docker exec -i "$DRILL" psql -U postgres -d drill -v ON_ERROR_STOP=1 -X -q -At; }

# ── the newest snapshot, from storage ────────────────────────────────────────
BK_REASON=restic
restic unlock --quiet
restic snapshots --json latest >"$BK_TMP/snap.json"
SNAP=$(jq -r 'sort_by(.time) | last | .id // empty' "$BK_TMP/snap.json")
[ -n "$SNAP" ] || bk_fail restic "the repository holds no snapshot"
SNAP_AT=$(jq -r 'sort_by(.time) | last | .time' "$BK_TMP/snap.json")
restic ls --json "$SNAP" >"$BK_TMP/ls.json"
MANIFEST=$(jq -rn 'first(inputs | select(.type == "file") | select(.path | endswith("/backup-stage/manifest.json")) | .path)' "$BK_TMP/ls.json")
DUMP=$(jq -rn 'first(inputs | select(.type == "file") | select(.path | endswith("/backup-stage/db.dump")) | .path)' "$BK_TMP/ls.json")
[ -n "$MANIFEST" ] && [ -n "$DUMP" ] || bk_fail restore "snapshot ${SNAP:0:8} holds no database dump"
restic dump "$SNAP" "$MANIFEST" >"$BK_TMP/manifest.json"
# where the files were: the uploads directory, the files bucket's mirror (backups.md §7.9), or both
UPLOADS=$(jq -r '.uploadsPath // empty' "$BK_TMP/manifest.json")
MIRROR=$(jq -r '.mirrorPath // empty' "$BK_TMP/manifest.json")
[ -n "$UPLOADS$MIRROR" ] || bk_fail restore "snapshot ${SNAP:0:8} does not say where its files were"
DUMP_BYTES=$(jq -rn --arg p "$DUMP" 'first(inputs | select(.path == $p) | .size) // 0' "$BK_TMP/ls.json")

need=$(( DUMP_BYTES * 2 / 1048576 + BACKUP_MIN_FREE_MB ))
free=$(bk_free_mb "$SCRATCH")
[ "$free" -ge "$need" ] || bk_fail disk "only $free MB free for the restore test, $need MB needed"

# ── into a throwaway database, never the live one ────────────────────────────
BK_REASON=restore
bk_say "restoring snapshot ${SNAP:0:8} ($SNAP_AT) into a throwaway database"
restic dump "$SNAP" "$DUMP" >"$SCRATCH/db.dump"
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$BACKUP_DB_CONTAINER")
# `trust` is safe only because this container has no network at all: every query is `docker exec`
docker run -d --rm --name "$DRILL" --network none -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
# Over TCP: while the image initialises, a temporary server answers on the socket only, and a
# restore started against it fails at random.
ready=0
for _ in $(seq 1 120); do
  if docker exec "$DRILL" pg_isready -q -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || bk_fail restore "the throwaway database did not start"
docker exec "$DRILL" createdb -U postgres drill
docker exec -i "$DRILL" pg_restore -U postgres -d drill --no-owner --exit-on-error --single-transaction <"$SCRATCH/db.dump"

# ── the same tables ──────────────────────────────────────────────────────────
BK_REASON=tables
LIVE_HEAD=$(bk_live <<<"$BK_HEAD_SQL")
BACK_HEAD=$(drill_sql <<<"$BK_HEAD_SQL")
bk_live <<<"$BK_ROWS_SQL" | LC_ALL=C sort >"$BK_TMP/live.tsv"
drill_sql <<<"$BK_ROWS_SQL" | LC_ALL=C sort >"$BK_TMP/back.tsv"
cut -f1 "$BK_TMP/live.tsv" >"$BK_TMP/live.tables"
cut -f1 "$BK_TMP/back.tsv" >"$BK_TMP/back.tables"
if [ "$LIVE_HEAD" = "$BACK_HEAD" ]; then
  if ! cmp -s "$BK_TMP/live.tables" "$BK_TMP/back.tables"; then
    lost=$(LC_ALL=C comm -3 "$BK_TMP/live.tables" "$BK_TMP/back.tables" | tr -d '\t' | tr '\n' ' ')
    bk_fail tables "the restored tables differ from the live ones: $lost"
  fi
  TABLES=same
else
  TABLES="predates $LIVE_HEAD"
  bk_say "the snapshot predates migration $LIVE_HEAD — table sets not compared"
fi

# ── the rows ─────────────────────────────────────────────────────────────────
BK_REASON=rows
short=$(LC_ALL=C join -t "$(printf '\t')" "$BK_TMP/live.tsv" "$BK_TMP/back.tsv" |
  awk -F '\t' '$2 >= 20 && $3 < $2 / 2 { printf "%s (%s live, %s restored) ", $1, $2, $3 }')
[ -z "$short" ] || bk_fail rows "far fewer rows than the live database: $short"

# ── every file the database names ────────────────────────────────────────────
BK_REASON=files
# An encrypted file (S17 stage A) is stored this many bytes over the size its row records: the
# format byte, the IV and the tag — ENVELOPE_OVERHEAD in server/core/files.ts, and
# server/backup-scripts.test.ts holds the two together. Read through to_jsonb, so a snapshot from
# before the column existed is read the same way.
ENVELOPE_BYTES=29
# Each row says where its bytes are (files.md §14.1): `s3` in the files bucket's mirror, anything
# else — or a snapshot from before the column existed — in the uploads directory. Compared as whole
# paths in the snapshot, `<root>/<File.path>`, with the size each should have.
FILES_SQL="select coalesce(to_jsonb(f) ->> 'storage', 'local') || chr(9) || path || chr(9) || (size + case when to_jsonb(f) ->> 'wrappedKey' is null then 0 else $ENVELOPE_BYTES end) from \"File\" f;"
drill_sql <<<"$FILES_SQL" |
  awk -F '\t' -v uploads="$UPLOADS" -v mirror="$MIRROR" '{
    root = ($1 == "s3") ? mirror : uploads
    # a row whose place this snapshot did not keep is looked for where nothing is: it counts missing
    if (root == "") root = "/(no " $1 " files in this snapshot)"
    printf "%s/%s\t%s\n", root, $2, $3
  }' | LC_ALL=C sort >"$BK_TMP/files.tsv"
cut -f1 "$BK_TMP/files.tsv" | LC_ALL=C sort -u >"$BK_TMP/referenced"
jq -r 'select(.type == "file") | .path' "$BK_TMP/ls.json" | LC_ALL=C sort -u >"$BK_TMP/in-snapshot"
LC_ALL=C comm -23 "$BK_TMP/referenced" "$BK_TMP/in-snapshot" >"$BK_TMP/missing"
REFERENCED=$(wc -l <"$BK_TMP/referenced" | tr -d ' ')
MISSING=$(wc -l <"$BK_TMP/missing" | tr -d ' ')
if [ "$MISSING" -gt "${BACKUP_DRILL_MISSING_MAX:-3}" ]; then
  sed -n '1,20p' "$BK_TMP/missing" >&2
  bk_fail files "$MISSING of $REFERENCED files the database names are not in the snapshot"
fi

# ── a sample, restored and compared ──────────────────────────────────────────
BK_REASON=sample
SAMPLED=0
awk -F '\t' 'NR == FNR { have[$0] = 1; next } ($1 in have)' "$BK_TMP/in-snapshot" "$BK_TMP/files.tsv" |
  awk 'BEGIN { srand() } { printf "%.8f\t%s\n", rand(), $0 }' | LC_ALL=C sort | cut -f2- |
  sed -n "1,${BACKUP_DRILL_SAMPLE:-5}p" >"$BK_TMP/sample.tsv"
while IFS="$(printf '\t')" read -r path size; do
  [ -n "$path" ] || continue
  got=$(restic dump "$SNAP" "$path" | wc -c | tr -d ' ')
  [ "$got" = "$size" ] || bk_fail sample "$path came back as $got bytes, $size recorded"
  SAMPLED=$((SAMPLED + 1))
done <"$BK_TMP/sample.tsv"

# ── what is stored, read back ────────────────────────────────────────────────
BK_REASON=check
bk_say "verifying a sample of what is stored"
restic check --quiet --read-data-subset=5% --retry-lock 10m >&2

bk_status_update '. + {snapshotId: $snap, snapshotAt: $at, checks: {tables: $tables,
    filesReferenced: $ref, filesMissing: $miss, sampled: $sampled}}' \
  --arg snap "${SNAP:0:8}" --arg at "$SNAP_AT" --arg tables "$TABLES" \
  --argjson ref "$REFERENCED" --argjson miss "$MISSING" --argjson sampled "$SAMPLED"
BK_REASON=

if [ -n "${BACKUP_DRILL_PING_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_DRILL_PING_URL" || bk_say "the ping did not go through"
fi
bk_say "done: snapshot ${SNAP:0:8} restores — tables $TABLES, $REFERENCED files named, $MISSING missing, $SAMPLED compared"
