#!/usr/bin/env bash
#
# Set up the nightly backup on a server. As root, from the project directory; RESTORE.md has the
# whole order.
#
#   sudo ./scripts/backup/install.sh [--tz <zone>]   directories, the environment file, the restic
#                                                    password, the systemd units — timers left OFF
#   sudo ./scripts/backup/install.sh --init           create the encrypted repository in the bucket
#   sudo ./scripts/backup/install.sh --enable-timers  only after a backup and a restore test have
#                                                    passed by hand
#   sudo ./scripts/backup/install.sh --status         the timers and the last results
#
# It never asks for a key: the environment file is filled in by hand, from the password manager.
# And it leaves the host's own clock alone — the timers carry the firm's zone themselves, because
# this server runs other projects whose cron and logs a timezone change would move.

set -euo pipefail
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT=$(cd "$SELF_DIR/../.." && pwd)
ETC=/etc/buh_crm
STATE=/var/lib/buh_crm
ENV_FILE=$ETC/backup.env
UNITS=/etc/systemd/system
TIMERS="buh_crm-backup.timer buh_crm-restore-drill.timer"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
die() { echo "✗ $*" >&2; exit 1; }
usage() { sed -n '2,/^$/p' "$SELF_DIR/install.sh" | sed 's/^# \{0,1\}//'; exit 2; }

MODE=setup
FIRM_TZ=
while [ $# -gt 0 ]; do
  case "$1" in
    --tz) [ $# -ge 2 ] || usage; FIRM_TZ=$2; shift ;;
    --init) MODE=init ;;
    --enable-timers) MODE=timers ;;
    --status) MODE=status ;;
    -h | --help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "run it with sudo"
command -v systemctl >/dev/null || die "this needs systemd"

# $1 >= $2, dotted numbers
version_at_least() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".");
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'
}

check_tools() {
  local missing= tool v
  for tool in restic rclone jq flock docker curl openssl systemd-analyze; do
    command -v "$tool" >/dev/null || missing="$missing $tool"
  done
  [ -z "$missing" ] || die "not installed:$missing — RESTORE.md, 'Tools'"
  v=$(restic version | awk '{ print $2 }')
  version_at_least "$v" 0.19.1 || die "restic $v is too old — 0.19.1 or later (restic self-update)"
  v=$(rclone version | awk 'NR == 1 { sub(/^v/, "", $2); print $2 }')
  version_at_least "$v" 1.60 || die "rclone $v is too old — 1.60 or later"
  echo "   restic $(restic version | awk '{ print $2 }'), rclone $v, $(jq --version)"
}

# ── status ───────────────────────────────────────────────────────────────────
if [ "$MODE" = status ]; then
  # shellcheck disable=SC2086
  systemctl list-timers --all $TIMERS || true
  for f in "$STATE"/backup-status/*.json; do
    [ -f "$f" ] || continue
    echo
    echo "$(basename "$f"):"
    jq '{ok, reason, startedAt, finishedAt, lastOkAt, copies, oldestCopyAt, versioning, checks}' "$f"
  done
  exit 0
fi

# ── the repository ───────────────────────────────────────────────────────────
if [ "$MODE" = init ]; then
  [ -r "$ENV_FILE" ] || die "no $ENV_FILE — run the setup first"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  export RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-$STATE/restic-cache}
  grep -q '<' <<<"$RESTIC_REPOSITORY" && die "RESTIC_REPOSITORY in $ENV_FILE still has a placeholder"
  set +e
  restic cat config >/dev/null 2>&1
  rc=$?
  set -e
  case $rc in
    0) say "The repository already exists — nothing to do." ;;
    10) restic init && say "Repository created. Next: sudo ./scripts/backup/backup.sh" ;;
    12) die "the repository exists and this is not its password" ;;
    *) die "restic could not reach the repository (exit $rc) — check the key and the address" ;;
  esac
  exit 0
fi

# ── the timers ───────────────────────────────────────────────────────────────
if [ "$MODE" = timers ]; then
  [ -f "$UNITS/buh_crm-backup.timer" ] || die "the units are not installed — run the setup first"
  # shellcheck disable=SC2086
  systemctl enable --now $TIMERS
  # shellcheck disable=SC2086
  systemctl list-timers --all $TIMERS
  exit 0
fi

# ── setup ────────────────────────────────────────────────────────────────────
say "Tools"
check_tools

say "Directories"
install -d -m 0700 -o root -g root "$ETC"
install -d -m 0755 "$STATE"
install -d -m 0700 "$STATE/backup-stage" "$STATE/drill-scratch" "$STATE/restic-cache"
# read by the app's container through a read-only mount — nothing secret is ever written here
install -d -m 0755 "$STATE/backup-status"
echo "   $ETC (0700) · $STATE/{backup-stage,drill-scratch,restic-cache} (0700) · $STATE/backup-status (0755)"

say "The environment file"
if [ -f "$ENV_FILE" ]; then
  echo "   $ENV_FILE exists — left as it is"
else
  install -m 0600 -o root -g root "$SELF_DIR/backup.env.example" "$ENV_FILE"
  echo "   wrote $ENV_FILE from the example. Fill it in:  sudo nano $ENV_FILE"
fi

say "The restic password"
if [ -f "$ETC/restic.pass" ]; then
  echo "   $ETC/restic.pass exists — left as it is"
else
  (umask 077 && openssl rand -base64 48 | tr -d '\n' >"$ETC/restic.pass")
  echo "   generated. Put it in the password manager NOW — without it every backup is noise:"
  echo "     sudo cat $ETC/restic.pass"
fi

say "The firm's timezone, for the timers"
if [ -z "$FIRM_TZ" ]; then
  # Only the TZ line. Nothing else in that file is this script's business — least of all the key.
  FIRM_TZ=$(sed -n 's/^TZ=//p' "$PROJECT/.env" 2>/dev/null | tail -n 1 | tr -d "\"'")
fi
[ -n "$FIRM_TZ" ] || die "no TZ in $PROJECT/.env — pass --tz <zone>"
systemd-analyze calendar "*-*-* 02:00:00 $FIRM_TZ" >/dev/null 2>&1 ||
  die "systemd does not know the zone '$FIRM_TZ'"
echo "   $FIRM_TZ — backups at 02:00, the restore test on the 1st at 05:00, in that zone"

say "systemd units"
for tpl in "$SELF_DIR"/systemd/*.in; do
  unit=$(basename "$tpl" .in)
  sed -e "s#@PROJECT@#$PROJECT#g" -e "s#@ENV_FILE@#$ENV_FILE#g" -e "s#@TZ@#$FIRM_TZ#g" "$tpl" >"$UNITS/$unit"
  chmod 0644 "$UNITS/$unit"
  echo "   $UNITS/$unit"
done
systemctl daemon-reload
echo "   timers NOT enabled yet"

say "Next, in this order (RESTORE.md, 'Setting up a server')"
cat <<EOF
   1. sudo nano $ENV_FILE                        the bucket address and the backup key
   2. sudo ./scripts/backup/install.sh --init    the repository
   3. sudo ./scripts/backup/backup.sh            a first backup, by hand
   4. sudo ./scripts/backup/drill.sh             a first restore test, by hand
   5. sudo ./scripts/backup/install.sh --enable-timers
   6. docker compose exec -T app npx tsx scripts/backup-check.ts
                                                 Settings → System → Nightly backups, now rather
                                                 than at 03:50
   Finish today: the CRM checks by itself at 03:50, and a server without a backup then is red.
EOF
