#!/usr/bin/env bash
#
# Put client files back into the files bucket, from a directory `restore.sh --files-to` filled: the
# ones the live database keeps in the bucket (`storage = 's3'`) and the bucket no longer has. It
# never overwrites an object, never deletes one, and never uploads a file the database keeps on disk
# — those go back into the uploads directory, as before (RESTORE.md §4).
#
#   ./scripts/backup/put-back-files.sh <dir> [--dry-run] [--env <file>]
#
#   --dry-run    say what would go back, and send nothing
#   --env        the backup environment — default: root's /etc/buh_crm/backup.env, else
#                ~/.config/buh_crm/backup.env (install.sh --user)
#
# The bucket's address comes from that file (BACKUP_FILES_REMOTE and its remote), the list of files
# from the live database. The key is the CRM's — the only one the bucket lets write — asked for here
# and kept in memory: the backup's own key cannot put anything back, and the project's .env is never
# read.

set -euo pipefail
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

usage() { sed -n '2,/^$/p' "$SELF_DIR/put-back-files.sh" | sed 's/^# \{0,1\}//'; exit 2; }

DIR=
DRY=0
ENV_FILE=
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --env)
      [ $# -ge 2 ] && [ -n "$2" ] || usage
      ENV_FILE=$2
      shift
      ;;
    -h | --help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *)
      [ -z "$DIR" ] || usage
      DIR=$1
      ;;
  esac
  shift
done
[ -n "$DIR" ] || usage

bk_init put-back
bk_load_env "$ENV_FILE"
bk_defaults
bk_need rclone docker
[ -d "$DIR" ] || bk_fail config "no directory at $DIR"
DIR=$(cd "$DIR" && pwd)
[ -n "$BACKUP_FILES_REMOTE" ] ||
  bk_fail config "BACKUP_FILES_REMOTE is not set: this server keeps no files in a bucket"

# ── where they go, and with which key ────────────────────────────────────────
case "$BACKUP_FILES_REMOTE" in
  /*)
    # a directory, as on a laptop: nothing to sign
    DEST=$BACKUP_FILES_REMOTE
    ;;
  *:*)
    name=${BACKUP_FILES_REMOTE%%:*}
    [[ $name =~ ^[a-z0-9]+$ ]] || bk_fail config "a remote name of lowercase letters and digits: $name"
    upper=$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')
    endpoint_var=RCLONE_CONFIG_${upper}_ENDPOINT
    region_var=RCLONE_CONFIG_${upper}_REGION
    endpoint=${!endpoint_var:-}
    region=${!region_var:-}
    [ -n "$endpoint" ] || bk_fail config "no $endpoint_var in the backup's environment file"
    key_id=
    key_secret=
    # `|| true`: at end of input `read` fails, and `set -e` would end the script without a word
    printf "The CRM's key — the only one the files bucket lets write\n  access key: " >&2
    read -r key_id || true
    printf '  secret (not shown): ' >&2
    read -rs key_secret || true
    printf '\n' >&2
    [ -n "$key_id" ] && [ -n "$key_secret" ] || bk_fail config "no key given"
    # a remote of its own: the key given here, and nothing taken from the environment
    export RCLONE_CONFIG_PUTBACK_TYPE=s3 RCLONE_CONFIG_PUTBACK_PROVIDER=Other
    export RCLONE_CONFIG_PUTBACK_ENV_AUTH=false
    export RCLONE_CONFIG_PUTBACK_ENDPOINT="$endpoint" RCLONE_CONFIG_PUTBACK_REGION="$region"
    export RCLONE_CONFIG_PUTBACK_ACCESS_KEY_ID="$key_id" RCLONE_CONFIG_PUTBACK_SECRET_ACCESS_KEY="$key_secret"
    DEST=putback:${BACKUP_FILES_REMOTE#*:}
    ;;
  *) bk_fail config "BACKUP_FILES_REMOTE is neither a remote nor an absolute directory" ;;
esac

# ── which: what the live database keeps in the bucket, and this directory holds ──
bk_live <<<"select path from \"File\" where storage = 's3';" | LC_ALL=C sort -u >"$BK_TMP/in-bucket"
: >"$BK_TMP/put"
absent=0
while read -r rel; do
  [ -n "$rel" ] || continue
  if [ -f "$DIR/$rel" ]; then echo "$rel" >>"$BK_TMP/put"; else absent=$((absent + 1)); fi
done <"$BK_TMP/in-bucket"
COUNT=$(wc -l <"$BK_TMP/put" | tr -d ' ')
bk_say "$COUNT of $(wc -l <"$BK_TMP/in-bucket" | tr -d ' ') files the database keeps in the bucket are in $DIR; $absent are not"
if [ "$COUNT" = 0 ]; then
  bk_say "nothing to put back"
  exit 0
fi

# ── back into the bucket: only what it lacks — nothing overwritten, nothing deleted ──
BK_REASON=restore
flags=(--files-from "$BK_TMP/put" --ignore-existing --s3-no-check-bucket)
[ "$DRY" = 0 ] || flags+=(--dry-run)
rclone copy "${flags[@]}" "$DIR" "$DEST"
if [ "$DRY" = 1 ]; then
  bk_say "a dry run: nothing was sent"
  exit 0
fi

# ── read back: every one of them is there now, the size it was ───────────────
rclone check --one-way --size-only --files-from "$BK_TMP/put" "$DIR" "$DEST" ||
  bk_fail restore "some files are not in the bucket as they are in $DIR — see above"
bk_say "✓ $COUNT files are in the bucket"
