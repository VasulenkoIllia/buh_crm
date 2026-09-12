# shellcheck shell=bash
#
# The frame every backup script stands in. Sourced, never run.
#
# - Every path is an environment variable whose default is the production value, so the same
#   scripts run on the server and — pointed elsewhere by a laptop's environment file — locally.
# - The status file is the only thing the CRM ever learns about a run (docs: backups.md §7). It is
#   written on every exit and carries a reason CODE, never a tool's own words: restic prints the
#   repository's address in its errors, and this file becomes a line on a screen.
# - Bash 3.2 on purpose — the laptop is a Mac: no associative arrays, no `mapfile`, no `${x,,}`.
#   And no `| head` after anything that can outrun it: under `pipefail` the writer's SIGPIPE fails
#   the whole script. `sed -n 1,Np` reads to the end instead.

# One zone for every timestamp this writes and every one restic prints, so they sort as strings.
export TZ=UTC
umask 077

BK_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BK_PROJECT=$(cd "$BK_LIB_DIR/../.." && pwd)
BK_HOST=$(hostname -s 2>/dev/null || hostname)
BK_KIND=
BK_REASON=
BK_STARTED=0
BK_LOCKED_OUT=0
BK_TMP=
BK_STATUS_DIR=

# The newest migration a database has finished — what the drill and the restore compare. It names
# Prisma's own table; the one other table any script here names is "File".
BK_HEAD_SQL="select coalesce(max(migration_name), '') from _prisma_migrations
             where finished_at is not null and rolled_back_at is null;"

bk_say() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
bk_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Fail with a reason code. The code is the only part of a failure that reaches the status file;
# the sentence goes to the journal.
bk_fail() {
  BK_REASON=$1
  shift
  bk_say "✗ $*"
  exit 1
}

bk_need() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || bk_fail config "$tool is not installed"
  done
}

# bk_init <kind> — the trap and a private scratch directory, before anything can fail
bk_init() {
  BK_KIND=$1
  BK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/buh_crm-$BK_KIND.XXXXXX")
  trap bk_on_exit EXIT
}

# bk_load_env <file> — the backup's environment: where the repository is, and the key to it
bk_load_env() {
  local file=${1:-${BACKUP_ENV_FILE:-}}
  if [ -z "$file" ]; then
    # root's setup, or the deploy user's (install.sh --user) — whichever this server has. Root's
    # directory is 0700, so for anybody else it simply does not exist. Root never takes the one under
    # a home: with `sudo -E` that is the deploy user's file, sourced as root (audit, 2026-09-12).
    if [ -e /etc/buh_crm/backup.env ] || [ "$(id -u)" -eq 0 ] ||
      [ ! -e "$HOME/.config/buh_crm/backup.env" ]; then
      file=/etc/buh_crm/backup.env
    else
      file=$HOME/.config/buh_crm/backup.env
    fi
  fi
  # Until the file is read, which destination this run is for cannot be known — so these two
  # failures write NO status rather than a wrong one: a broken second destination must never
  # redden the first. The journal has them, and the night does not go unseen: no success within
  # 20 hours is red the next morning (audit, 2026-09-12).
  if [ ! -f "$file" ]; then
    bk_say "✗ no environment file at $file"
    exit 78
  fi
  if [ ! -r "$file" ]; then
    bk_say "✗ cannot read $file — run it with sudo"
    exit 78
  fi
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
  [ -n "${RESTIC_REPOSITORY:-}" ] || bk_fail config "RESTIC_REPOSITORY is not set in $file"
  [ -n "${RESTIC_PASSWORD_FILE:-}${RESTIC_PASSWORD:-}" ] || bk_fail config "no restic password in $file"
}

# bk_defaults — every path, with the production value unless the environment says otherwise
bk_defaults() {
  BACKUP_STATE_DIR=${BACKUP_STATE_DIR:-/var/lib/buh_crm}
  BACKUP_DESTINATION=${BACKUP_DESTINATION:-primary}
  [[ $BACKUP_DESTINATION =~ ^[a-z0-9-]+$ ]] ||
    bk_fail config "BACKUP_DESTINATION may hold lowercase letters, digits and '-' only"
  BK_STATUS_DIR=$BACKUP_STATE_DIR/backup-status
  if [ -z "${BACKUP_LOCK_DIR:-}" ]; then
    if [ -d /run/lock ]; then BACKUP_LOCK_DIR=/run/lock; else BACKUP_LOCK_DIR=$BACKUP_STATE_DIR; fi
  fi
  BACKUP_UPLOADS_DIR=${BACKUP_UPLOADS_DIR:-$BK_PROJECT/data/uploads}
  BACKUP_DB_CONTAINER=${BACKUP_DB_CONTAINER:-buh_crm-db}
  BACKUP_APP_CONTAINER=${BACKUP_APP_CONTAINER:-buh_crm-app}
  BACKUP_KEEP_DAILY=${BACKUP_KEEP_DAILY:-7}
  BACKUP_MIN_FREE_MB=${BACKUP_MIN_FREE_MB:-500}
  [[ $BACKUP_KEEP_DAILY =~ ^[1-9][0-9]*$ ]] || bk_fail config "BACKUP_KEEP_DAILY must be a whole number"
  [[ $BACKUP_MIN_FREE_MB =~ ^[0-9]+$ ]] || bk_fail config "BACKUP_MIN_FREE_MB must be a whole number"
  BACKUP_RCLONE_REMOTE=${BACKUP_RCLONE_REMOTE:-store}
  export RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-$BACKUP_STATE_DIR/restic-cache}
  # tolerated: a rollback run by the deploy user needs none of it, and could not create it
  mkdir -p "$BACKUP_STATE_DIR" 2>/dev/null || true
}

# ── the status file ──────────────────────────────────────────────────────────

bk_status_file() {
  printf '%s/%s-%s.json' "${BK_STATUS_DIR:-${BACKUP_STATE_DIR:-/var/lib/buh_crm}/backup-status}" \
    "$BK_KIND" "${BACKUP_DESTINATION:-primary}"
}

# bk_status_update <jq filter> [jq args…] — applied to the current document, written atomically.
# 0644 in a 0755 directory: the app reads it from a read-only mount, possibly as a non-root user,
# and nothing in it is secret. Only the backup and the drill report; a restore is a person at a
# terminal.
bk_status_update() {
  case "$BK_KIND" in backup | drill) ;; *) return 0 ;; esac
  local filter=$1 file dir
  shift
  file=$(bk_status_file)
  dir=$(dirname "$file")
  mkdir -p "$dir" && chmod 0755 "$dir" || return 1
  # One writer at a time. A run that finds the backup lock held still records its conflict, and
  # that read-merge-write must not interleave with the holder's own (audit, 2026-09-12).
  (
    # Held for one jq call at a time. If ten seconds ever pass, writing unlocked beats losing this
    # run's own result — a run left "running" for ever reads as hung, which is the worse lie.
    flock -w 10 8 || true
    base='{}'
    if [ -s "$file" ] && jq -e 'type == "object"' "$file" >/dev/null 2>&1; then base=$(cat "$file"); fi
    tmp=$(mktemp "$dir/.tmp.XXXXXX") || exit 1
    if jq --arg _kind "$BK_KIND" --arg _dest "${BACKUP_DESTINATION:-primary}" --arg _host "$BK_HOST" \
      "$@" "(. + {schema: 1, kind: \$_kind, destination: \$_dest, host: \$_host}) | $filter" \
      <<<"$base" >"$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$file"; then
      exit 0
    fi
    rm -f "$tmp"
    exit 1
  ) 8>"$dir/.status.lock"
}

bk_status_get() {
  local file
  file=$(bk_status_file)
  if [ -s "$file" ]; then jq -r "$1" "$file" 2>/dev/null || true; fi
}

# The run has begun: whatever happens next is this attempt's outcome.
bk_start() {
  BK_STARTED=1
  bk_status_update '. + {running: true, startedAt: $now, finishedAt: null, ok: null,
    exitCode: null, reason: null}' --arg now "$(bk_now)"
}

# bk_lock -n | -w <seconds> — one run per destination at a time. The backup and the drill share the
# lock, so a restore test waits for a backup rather than reading a repository mid-write.
bk_lock() {
  mkdir -p "$BACKUP_LOCK_DIR"
  exec 9>"$BACKUP_LOCK_DIR/buh_crm-backup-$BACKUP_DESTINATION.lock"
  flock "$@" 9
}

bk_on_exit() {
  local rc=$?
  set +e
  trap - EXIT
  if [ "$BK_LOCKED_OUT" = 1 ]; then
    # somebody else's run is in progress: its attempt is the one the status describes
    bk_status_update '.lastConflictAt = $now' --arg now "$(bk_now)"
  elif [ "$rc" -eq 0 ]; then
    bk_status_update '. + {running: false, finishedAt: $now, ok: true, exitCode: 0, reason: null,
      lastOkAt: $now} | .firstOkAt //= $now' --arg now "$(bk_now)"
  elif [ "$BK_STARTED" = 1 ] || [ "$BK_REASON" = config ]; then
    bk_status_update '. + {running: false, finishedAt: $now, ok: false, exitCode: $rc,
      reason: $reason} | .startedAt //= $now' \
      --arg now "$(bk_now)" --argjson rc "$rc" --arg reason "${BK_REASON:-unknown}"
  fi
  if declare -F bk_cleanup >/dev/null; then bk_cleanup; fi
  [ -z "$BK_TMP" ] || rm -rf "$BK_TMP"
  exit "$rc"
}

# ── helpers ──────────────────────────────────────────────────────────────────

bk_free_mb() { df -Pk "$1" | awk 'NR == 2 { print int($4 / 1024) }'; }

bk_bucket_of() { printf '%s' "$1" | sed -E 's#^s3:(https?://)?[^/]+/([^/]+).*#\2#'; }

# SQL on stdin, rows out (unaligned, no header). $1 = a database; default the live one.
bk_live() {
  docker exec -i "$BACKUP_DB_CONTAINER" sh -c \
    'psql -U "$POSTGRES_USER" -d "${1:-$POSTGRES_DB}" -v ON_ERROR_STOP=1 -X -q -At' _ "${1:-}"
}

bk_live_name() { docker exec "$BACKUP_DB_CONTAINER" sh -c 'printf %s "$POSTGRES_DB"'; }

# Enabled | Suspended | Unversioned | not_applicable (a local repository) | unreadable
bk_versioning() {
  local bucket state
  case "$RESTIC_REPOSITORY" in
    s3:*)
      bk_need rclone
      bucket=$(bk_bucket_of "$RESTIC_REPOSITORY")
      state=$(rclone backend versioning "$BACKUP_RCLONE_REMOTE:$bucket" 2>/dev/null | tr -d '"[:space:]') ||
        state=
      printf '%s' "${state:-unreadable}"
      ;;
    *) printf 'not_applicable' ;;
  esac
}

# Every table and its row count, "name<TAB>rows", sorted for `join`. Names no table: a list here is
# how a future table would be missed.
BK_ROWS_SQL="select table_name || chr(9) || (xpath('/row/c/text()', query_to_xml(format(
               'select count(*) as c from public.%I', table_name), false, true, '')))[1]::text
             from information_schema.tables
             where table_schema = 'public' and table_type = 'BASE TABLE';"
