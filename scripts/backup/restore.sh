#!/usr/bin/env bash
#
# Restore — from the backups, or from a pre-deploy dump — and never over the live database.
#
#   sudo ./scripts/backup/restore.sh --list
#   sudo ./scripts/backup/restore.sh --into <new-db> [--files-to <dir>] [--snapshot <id>]
#   sudo ./scripts/backup/restore.sh --files-to <dir> [--snapshot <id>]
#        ./scripts/backup/restore.sh --swap <db>
#        ./scripts/backup/restore.sh --rollback <dump>
#
#   --list        what is in storage
#   --into        the database from a snapshot, into a NEW database beside the live one. Refuses a
#                 name that exists, and the live name itself.
#   --files-to    the client files from a snapshot, into a directory that is missing or empty. A
#                 file the database names but the snapshot lacks is fetched from an earlier
#                 snapshot; files nothing names are listed, never deleted.
#   --swap        make <db> the live database: the app is stopped, sessions are ended, and both
#                 names swapped in one transaction. The old one is kept as <live>_replaced_<time>.
#   --rollback    undo a deploy: the pre-deploy dump into <live>_restore, then --swap. It prints how
#                 to bring the app back on the commit the dump was taken from.
#
#   --env <file>     the backup environment, for --list/--into/--files-to (default /etc/buh_crm/backup.env)
#   --snapshot <id>  default: the newest
#   --yes            do not ask before --swap or --rollback
#
# Overwriting the live database is never a flag on a restore. It is --swap, a separate step a person
# takes with RESTORE.md open — and even that keeps the old database.

set -euo pipefail
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

usage() { sed -n '2,/^$/p' "$SELF_DIR/restore.sh" | sed 's/^# \{0,1\}//'; exit 2; }
need_value() { [ $# -ge 2 ] && [ -n "$2" ] || { echo "$1 needs a value" >&2; usage; }; }

LIST=0
INTO=
FILES_TO=
SNAPSHOT=latest
SWAP=
ROLLBACK=
ENV_FILE=
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=1 ;;
    --into) need_value "$@"; INTO=$2; shift ;;
    --files-to) need_value "$@"; FILES_TO=$2; shift ;;
    --snapshot) need_value "$@"; SNAPSHOT=$2; shift ;;
    --swap) need_value "$@"; SWAP=$2; shift ;;
    --rollback) need_value "$@"; ROLLBACK=$2; shift ;;
    --env) need_value "$@"; ENV_FILE=$2; shift ;;
    --yes | -y) YES=1 ;;
    -h | --help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
  shift
done

modes=0
[ "$LIST" = 0 ] || modes=$((modes + 1))
[ -z "$INTO$FILES_TO" ] || modes=$((modes + 1))
[ -z "$SWAP" ] || modes=$((modes + 1))
[ -z "$ROLLBACK" ] || modes=$((modes + 1))
[ "$modes" -eq 1 ] || usage

bk_init restore
if [ "$LIST" = 1 ] || [ -n "$INTO$FILES_TO" ]; then bk_load_env "$ENV_FILE"; fi
bk_defaults

# ── small pieces ─────────────────────────────────────────────────────────────

valid_db_name() { [[ $1 =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }

db_exists() { [ -n "$(bk_live postgres <<<"select 1 from pg_database where datname = '$1';")" ]; }

confirm() { # <the word a person has to type>
  [ "$YES" = 1 ] && return 0
  local answer
  printf 'Type %s to go ahead: ' "$1" >&2
  read -r answer || true
  [ "$answer" = "$1" ] || bk_fail config "not confirmed — nothing was changed"
}

# ── the database ─────────────────────────────────────────────────────────────

CREATED_DB=
bk_cleanup() {
  # a database this run created and did not finish filling is removed again, so a retry can reuse
  # the name; nothing else is ever dropped here
  if [ -n "$CREATED_DB" ]; then bk_live postgres <<<"drop database if exists \"$CREATED_DB\";" || true; fi
}

restore_db() { # <dump file> <new database>
  local dump=$1 db=$2 live tables head
  valid_db_name "$db" || bk_fail config "not a database name: $db"
  live=$(bk_live_name)
  case "$db" in
    "$live" | postgres | template0 | template1) bk_fail config "refusing to restore into $db" ;;
  esac
  if db_exists "$db"; then bk_fail config "a database named $db already exists — pick another name, or drop it first"; fi

  bk_say "checking the dump reads back in full"
  docker exec -i "$BACKUP_DB_CONTAINER" pg_restore -f /dev/null <"$dump" || bk_fail verify "the dump does not read back"

  bk_live postgres <<<"create database \"$db\";"
  CREATED_DB=$db
  bk_say "restoring into $db"
  docker exec -i "$BACKUP_DB_CONTAINER" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --exit-on-error --single-transaction' _ "$db" <"$dump" ||
    bk_fail restore "the dump did not restore — $db is removed again"
  CREATED_DB=

  tables=$(bk_live "$db" <<<"select count(*) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE';")
  head=$(bk_live "$db" <<<"$BK_HEAD_SQL")
  bk_say "✓ $db: $tables tables, migrated up to ${head:-(none)}"
}

swap_in() { # <database that becomes the live one>
  local db=$1 live old running
  valid_db_name "$db" || bk_fail config "not a database name: $db"
  # PostgreSQL's own databases, before anything is asked of the server: `--swap postgres --yes`
  # would rename the maintenance database this script itself connects to (audit, 2026-09-12)
  case "$db" in
    postgres | template0 | template1) bk_fail config "refusing to swap in $db — it is PostgreSQL's own database" ;;
  esac
  live=$(bk_live_name)
  [ "$db" != "$live" ] || bk_fail config "$db is already the live database"
  db_exists "$db" || bk_fail config "there is no database named $db"
  old="${live}_replaced_$(date -u +%Y%m%d_%H%M)"

  cat >&2 <<EOF

About to make "$db" the live database:
  - the app ($BACKUP_APP_CONTAINER) is stopped, if it is running;
  - every session on "$live" and "$db" is ended — an open DataGrip tunnel counts;
  - "$live" becomes "$old" and "$db" becomes "$live", in one transaction: both or neither.
Nothing is deleted. "$old" stays until you drop it.

EOF
  confirm "$live"

  running=$(docker inspect -f '{{.State.Running}}' "$BACKUP_APP_CONTAINER" 2>/dev/null || true)
  if [ "$running" = true ]; then
    docker stop "$BACKUP_APP_CONTAINER" >/dev/null
    bk_say "app stopped"
  fi
  bk_live postgres >/dev/null <<SQL
select pg_terminate_backend(pid) from pg_stat_activity
where datname in ('$live', '$db') and pid <> pg_backend_pid();
SQL
  docker exec "$BACKUP_DB_CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -X -q -1 -c "alter database \"$1\" rename to \"$2\"" -c "alter database \"$3\" rename to \"$1\""' _ "$live" "$old" "$db" ||
    bk_fail restore "the names were not swapped — nothing changed. Something reconnected in between: run it again"
  bk_say "✓ \"$db\" is now \"$live\"; the previous database is kept as \"$old\""
}

# ── from the backups ─────────────────────────────────────────────────────────

SNAP=
SNAP_AT=
DUMP_IN=
UPLOADS_IN=

resolve_snapshot() {
  local manifest
  restic snapshots --json "$SNAPSHOT" >"$BK_TMP/snap.json" 2>/dev/null ||
    bk_fail restic "no snapshot '$SNAPSHOT' in the repository"
  SNAP=$(jq -r 'sort_by(.time) | last | .id // empty' "$BK_TMP/snap.json")
  [ -n "$SNAP" ] || bk_fail restic "no snapshot '$SNAPSHOT' in the repository"
  SNAP_AT=$(jq -r 'sort_by(.time) | last | .time' "$BK_TMP/snap.json")
  restic ls --json "$SNAP" >"$BK_TMP/ls.json"
  manifest=$(jq -rn 'first(inputs | select(.type == "file") | select(.path | endswith("/backup-stage/manifest.json")) | .path)' "$BK_TMP/ls.json")
  DUMP_IN=$(jq -rn 'first(inputs | select(.type == "file") | select(.path | endswith("/backup-stage/db.dump")) | .path)' "$BK_TMP/ls.json")
  [ -n "$manifest" ] && [ -n "$DUMP_IN" ] || bk_fail restore "snapshot ${SNAP:0:8} holds no database dump"
  UPLOADS_IN=$(restic dump "$SNAP" "$manifest" | jq -r '.uploadsPath // empty')
  [ -n "$UPLOADS_IN" ] || bk_fail restore "snapshot ${SNAP:0:8} does not say where its files were"
  bk_say "snapshot ${SNAP:0:8}, taken $SNAP_AT"
}

restore_files() { # <directory> <database whose File rows are the reference>
  local dir=$1 ref_db=$2 recovered=0 older rel shown
  if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    bk_fail config "$dir is not empty — files are restored only into an empty or a new directory"
  fi
  mkdir -p "$dir"
  bk_say "restoring the client files into $dir"
  restic restore "$SNAP:$UPLOADS_IN" --target "$dir" --quiet

  bk_live "$ref_db" <<<'select path from "File";' | LC_ALL=C sort -u >"$BK_TMP/want"
  (cd "$dir" && find . -type f | sed 's#^\./##' | LC_ALL=C sort -u) >"$BK_TMP/have"
  LC_ALL=C comm -13 "$BK_TMP/have" "$BK_TMP/want" >"$BK_TMP/missing"

  # A file deleted while the backup ran has its row in the dump and no bytes in the same snapshot
  # (docs: backups.md §6). The snapshots before it still hold them — newest first.
  if [ -s "$BK_TMP/missing" ]; then
    restic snapshots --json | jq -r --arg t "$SNAP_AT" '[.[] | select(.time < $t)] | sort_by(.time) | reverse | .[].id' >"$BK_TMP/older"
    while read -r older; do
      [ -s "$BK_TMP/missing" ] || break
      restic ls --json "$older" >"$BK_TMP/older.json" || continue
      : >"$BK_TMP/still"
      while read -r rel; do
        if jq -en --arg p "$UPLOADS_IN/$rel" 'first(inputs | select(.type == "file") | select(.path == $p)) | true' "$BK_TMP/older.json" >/dev/null 2>&1; then
          mkdir -p "$(dirname "$dir/$rel")"
          if restic dump "$older" "$UPLOADS_IN/$rel" >"$dir/$rel"; then
            recovered=$((recovered + 1))
            continue
          fi
          rm -f "$dir/$rel"
        fi
        echo "$rel" >>"$BK_TMP/still"
      done <"$BK_TMP/missing"
      mv "$BK_TMP/still" "$BK_TMP/missing"
    done <"$BK_TMP/older"
  fi

  (cd "$dir" && find . -type f | sed 's#^\./##' | LC_ALL=C sort -u) >"$BK_TMP/have"
  LC_ALL=C comm -23 "$BK_TMP/have" "$BK_TMP/want" >"$BK_TMP/orphans"

  bk_say "✓ $(wc -l <"$BK_TMP/have" | tr -d ' ') files in $dir; $recovered fetched from earlier snapshots"
  if [ -s "$BK_TMP/missing" ]; then
    shown=$(sed -n '1,50p' "$BK_TMP/missing")
    bk_say "✗ $(wc -l <"$BK_TMP/missing" | tr -d ' ') files the database names are in no snapshot:"
    printf '%s\n' "$shown" >&2
  fi
  if [ -s "$BK_TMP/orphans" ]; then
    shown=$(sed -n '1,50p' "$BK_TMP/orphans")
    bk_say "$(wc -l <"$BK_TMP/orphans" | tr -d ' ') files no row names — kept, for somebody to re-attach or delete:"
    printf '%s\n' "$shown" >&2
  fi
}

# ── the modes ────────────────────────────────────────────────────────────────

if [ "$LIST" = 1 ]; then
  bk_need restic
  restic snapshots --compact
  exit 0
fi

if [ -n "$INTO$FILES_TO" ]; then
  bk_need restic jq docker
  resolve_snapshot
  if [ -n "$INTO" ]; then
    restic dump "$SNAP" "$DUMP_IN" >"$BK_TMP/db.dump"
    restore_db "$BK_TMP/db.dump" "$INTO"
  fi
  if [ -n "$FILES_TO" ]; then
    if [ -n "$INTO" ]; then restore_files "$FILES_TO" "$INTO"; else restore_files "$FILES_TO" ""; fi
  fi
  if [ -n "$INTO" ]; then
    echo
    echo "Restored beside the live database, which is untouched. To make it the live one:"
    echo "  ./scripts/backup/restore.sh --swap $INTO"
  fi
  exit 0
fi

if [ -n "$SWAP" ]; then
  bk_need docker
  swap_in "$SWAP"
  echo
  echo "Start the app again when ready:  docker compose up -d app"
  exit 0
fi

# --rollback
bk_need docker
[ -f "$ROLLBACK" ] || bk_fail config "no dump at $ROLLBACK"
LIVE=$(bk_live_name)
COMMIT=$(basename "$ROLLBACK" | sed -nE 's/.*_([0-9a-f]{7,40})\.dump$/\1/p')
restore_db "$ROLLBACK" "${LIVE}_restore"
swap_in "${LIVE}_restore"
cat <<EOF

The database is back to the moment of that dump. Bring the app back on the code it matched — the
container runs the migrations on every start, so the new image would re-apply the one just undone:

  git checkout ${COMMIT:-<the commit deployed before>}
  APP_VERSION=\$(git rev-parse --short HEAD) docker compose up -d --build

Later, once the fix is on main:

  git checkout main && ./scripts/deploy.sh
EOF
