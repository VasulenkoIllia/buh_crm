#!/usr/bin/env bash
#
# Set up the nightly backup on a server. RESTORE.md §7 has the whole order.
#
#   sudo ./scripts/backup/install.sh [--tz <zone>]   as root: /etc/buh_crm, /var/lib/buh_crm and
#                                                    systemd timers
#        ./scripts/backup/install.sh --user [...]    as the deploy user, without sudo: everything
#                                                    under its home, and its crontab
#
#   (nothing else)    directories, the environment file, the restic password, the schedule — off
#   --init            create the encrypted repository in the bucket
#   --enable-timers   switch the schedule on — only after a backup and a restore test have passed
#   --disable-timers  switch it off, e.g. on a server being replaced: storage is not touched
#   --show-cron       (--user) print the crontab lines --enable-timers installs, and nothing else
#   --status          the schedule and the last results
#
# It never asks for a key: the environment file is filled in by hand, from the password manager.
# And it leaves the host's own clock alone — the schedule carries the firm's zone itself, because
# this server runs other projects whose cron and logs a timezone change would move.
#
# --user exists because the deploy user may have no sudo. It is not weaker here: that user is in the
# docker group, which is root in all but name, so a root-only key file would keep nothing from it.

set -euo pipefail
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT=$(cd "$SELF_DIR/../.." && pwd)
TIMERS="buh_crm-backup.timer buh_crm-restore-drill.timer"
CRON_BEGIN="# >>> buh_crm backups (scripts/backup/install.sh --user) >>>"
CRON_END="# <<< buh_crm backups <<<"
APP_CONTAINER=${BACKUP_APP_CONTAINER:-buh_crm-app}

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
die() { echo "✗ $*" >&2; exit 1; }
usage() { sed -n '2,/^$/p' "$SELF_DIR/install.sh" | sed 's/^# \{0,1\}//'; exit 2; }

MODE=setup
USER_MODE=0
FIRM_TZ=
while [ $# -gt 0 ]; do
  case "$1" in
    --tz) [ $# -ge 2 ] || usage; FIRM_TZ=$2; shift ;;
    --user) USER_MODE=1 ;;
    --init) MODE=init ;;
    --enable-timers) MODE=timers ;;
    --disable-timers) MODE=untimers ;;
    --show-cron) MODE=showcron ;;
    --status) MODE=status ;;
    -h | --help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
  shift
done

if [ "$USER_MODE" = 1 ]; then
  [ "$(id -u)" -ne 0 ] || die "--user is for the deploy user; as root, leave it out"
  ETC=$HOME/.config/buh_crm
  STATE=$HOME/.local/state/buh_crm
  export PATH="$HOME/.local/bin:$PATH"
else
  [ "$MODE" != showcron ] || die "--show-cron belongs to --user; as root the schedule is systemd's"
  [ "$(id -u)" -eq 0 ] || die "run it with sudo — or, without sudo, as the deploy user with --user"
  command -v systemctl >/dev/null || die "this needs systemd"
  ETC=/etc/buh_crm
  STATE=/var/lib/buh_crm
fi
ENV_FILE=$ETC/backup.env

# $1 >= $2, dotted numbers
version_at_least() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".");
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'
}

check_tools() {
  local missing= tool v tools="restic rclone jq flock docker curl openssl"
  [ "$USER_MODE" = 1 ] || tools="$tools systemd-analyze"
  for tool in $tools; do
    command -v "$tool" >/dev/null || missing="$missing $tool"
  done
  [ -z "$missing" ] || die "not installed:$missing — RESTORE.md §8"
  v=$(restic version | awk '{ print $2 }')
  version_at_least "$v" 0.19.1 || die "restic $v is too old — 0.19.1 or later (restic self-update)"
  v=$(rclone version | awk 'NR == 1 { sub(/^v/, "", $2); print $2 }')
  version_at_least "$v" 1.60 || die "rclone $v is too old — 1.60 or later"
  echo "   restic $(restic version | awk '{ print $2 }'), rclone $v, $(jq --version)"
}

# The firm's zone: --tz, or the TZ line of the project's .env — only that line; nothing else in that
# file is this script's business, least of all the key.
firm_tz() {
  local tz=$FIRM_TZ
  [ -n "$tz" ] || tz=$(sed -n 's/^TZ=//p' "$PROJECT/.env" 2>/dev/null | tail -n 1 | tr -d "\"'")
  [ -n "$tz" ] || die "no TZ in $PROJECT/.env — pass --tz <zone>"
  [ -f "/usr/share/zoneinfo/$tz" ] || die "'$tz' is not a timezone this system knows"
  printf '%s' "$tz"
}

# --user's schedule. cron knows only the server's clock, and changing that would move every other
# project's jobs; so it wakes the scripts every hour and they run only when the FIRM's clock says so.
# The backup at 01:00, not 02:00: in a zone with daylight saving 02:00 does not exist one night each
# spring, and 01:00 exists every night. On the autumn night 01:00 comes twice, and so does the
# backup — harmless: two snapshots of one day, of which `forget` keeps the later. The restore test on
# the 1st at 05:00, which no change of clock touches.
# `umask 077` first: cron's own shell opens the log before the script sets its umask, and restic's
# errors in that log name the storage (audit, 2026-09-12).
cron_block() {
  local tz=$1 path="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
  cat <<EOF
$CRON_BEGIN
0 * * * * umask 077; [ "\$(TZ=$tz date +\%H)" = 01 ] && PATH=$path $PROJECT/scripts/backup/backup.sh $ENV_FILE >>$STATE/backup.log 2>&1
0 * * * * umask 077; [ "\$(TZ=$tz date +\%d\%H)" = 0105 ] && PATH=$path $PROJECT/scripts/backup/drill.sh $ENV_FILE >>$STATE/drill.log 2>&1
$CRON_END
EOF
}

# the crontab without our block — every other line of it untouched
crontab_without_ours() {
  { crontab -l 2>/dev/null || true; } |
    awk -v b="$CRON_BEGIN" -v e="$CRON_END" '$0 == b { skip = 1 } !skip { print } $0 == e { skip = 0 }'
}

crontab_ours() {
  { crontab -l 2>/dev/null || true; } |
    awk -v b="$CRON_BEGIN" -v e="$CRON_END" '$0 == b { show = 1 } show { print } $0 == e { show = 0 }'
}

# ── status ───────────────────────────────────────────────────────────────────
if [ "$MODE" = status ]; then
  if [ "$USER_MODE" = 1 ]; then
    ours=$(crontab_ours)
    if [ -n "$ours" ]; then printf '%s\n' "$ours"; else echo "   the schedule is not switched on"; fi
  else
    # shellcheck disable=SC2086
    systemctl list-timers --all $TIMERS || true
  fi
  for f in "$STATE"/backup-status/*.json; do
    [ -f "$f" ] || continue
    echo
    echo "$(basename "$f"):"
    jq '{ok, reason, startedAt, finishedAt, lastOkAt, copies, oldestCopyAt, versioning, checks}' "$f"
  done
  exit 0
fi

# ── the cron lines, printed ──────────────────────────────────────────────────
if [ "$MODE" = showcron ]; then
  cron_block "$(firm_tz)"
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
  if grep -q '<' <<<"$RESTIC_REPOSITORY"; then die "RESTIC_REPOSITORY in $ENV_FILE still has a placeholder"; fi
  set +e
  restic cat config >/dev/null 2>&1
  rc=$?
  set -e
  case $rc in
    0) say "The repository already exists — nothing to do." ;;
    10) restic init && say "Repository created. Next: ./scripts/backup/backup.sh" ;;
    12) die "the repository exists and this is not its password" ;;
    *) die "restic could not reach the repository (exit $rc) — check the key and the address" ;;
  esac
  exit 0
fi

# ── the schedule on ──────────────────────────────────────────────────────────
if [ "$MODE" = timers ]; then
  if [ "$USER_MODE" = 1 ]; then
    [ -r "$ENV_FILE" ] || die "no $ENV_FILE — run the setup first"
    tz=$(firm_tz)
    { crontab_without_ours; cron_block "$tz"; } | crontab -
    say "The schedule is on"
    crontab_ours
  else
    [ -f /etc/systemd/system/buh_crm-backup.timer ] || die "the units are not installed — run the setup first"
    # shellcheck disable=SC2086
    systemctl enable --now $TIMERS
    # shellcheck disable=SC2086
    systemctl list-timers --all $TIMERS
  fi
  exit 0
fi

# ── the schedule off ─────────────────────────────────────────────────────────
# For a server that stops being the one that backs up — one being replaced above all. Two servers
# would write the same repository under the same host name, and whichever wrote last each night would
# be "the newest copy" a restore brings back. Nothing in storage is touched.
if [ "$MODE" = untimers ]; then
  if [ "$USER_MODE" = 1 ]; then
    crontab_without_ours | crontab -
  else
    # shellcheck disable=SC2086
    systemctl disable --now $TIMERS
  fi
  say "The schedule is off — nothing in storage was touched"
  exit 0
fi

# ── setup ────────────────────────────────────────────────────────────────────
say "Tools"
check_tools

say "Directories"
if [ "$USER_MODE" = 1 ]; then
  install -d -m 0700 "$ETC"
else
  install -d -m 0700 -o root -g root "$ETC"
fi
install -d -m 0755 "$STATE"
install -d -m 0700 "$STATE/backup-stage" "$STATE/drill-scratch" "$STATE/restic-cache"
# read by the app's container through a read-only mount — nothing secret is ever written here
install -d -m 0755 "$STATE/backup-status"
echo "   $ETC (0700) · $STATE/{backup-stage,drill-scratch,restic-cache} (0700) · $STATE/backup-status (0755)"

say "The environment file"
if [ -f "$ENV_FILE" ]; then
  echo "   $ENV_FILE exists — left as it is"
else
  (
    umask 077
    if [ "$USER_MODE" = 1 ]; then
      # the example names root's places; the deploy user keeps its own
      sed -e "s#^RESTIC_PASSWORD_FILE=.*#RESTIC_PASSWORD_FILE=$ETC/restic.pass#" \
        -e "s#^\# BACKUP_STATE_DIR=.*#BACKUP_STATE_DIR=$STATE#" \
        "$SELF_DIR/backup.env.example" >"$ENV_FILE"
    else
      cp "$SELF_DIR/backup.env.example" "$ENV_FILE"
    fi
  )
  chmod 0600 "$ENV_FILE"
  echo "   wrote $ENV_FILE from the example. Fill it in:  nano $ENV_FILE"
fi

say "The restic password"
if [ -f "$ETC/restic.pass" ]; then
  echo "   $ETC/restic.pass exists — left as it is"
else
  (umask 077 && openssl rand -base64 48 | tr -d '\n' >"$ETC/restic.pass")
  echo "   generated. Put it in the password manager NOW — without it every backup is noise:"
  echo "     cat $ETC/restic.pass"
fi

say "The firm's timezone, for the schedule"
FIRM_TZ=$(firm_tz)
if [ "$USER_MODE" = 1 ]; then
  echo "   $FIRM_TZ — the backup at 01:00, the restore test on the 1st at 05:00, in that zone"
else
  systemd-analyze calendar "*-*-* 02:00:00 $FIRM_TZ" >/dev/null 2>&1 ||
    die "systemd does not know the zone '$FIRM_TZ'"
  echo "   $FIRM_TZ — backups at 02:00, the restore test on the 1st at 05:00, in that zone"
fi

say "The schedule"
if [ "$USER_MODE" = 1 ]; then
  echo "   the crontab lines --enable-timers will install (not installed yet):"
  cron_block "$FIRM_TZ" | sed 's/^/     /'
else
  for tpl in "$SELF_DIR"/systemd/*.in; do
    unit=$(basename "$tpl" .in)
    sed -e "s#@PROJECT@#$PROJECT#g" -e "s#@ENV_FILE@#$ENV_FILE#g" -e "s#@TZ@#$FIRM_TZ#g" "$tpl" \
      >"/etc/systemd/system/$unit"
    chmod 0644 "/etc/systemd/system/$unit"
    echo "   /etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  echo "   timers NOT enabled yet"
fi

# Where the CRM reads the status. As root that is compose's default; for --user it is this home,
# which the project's .env has to name — before the deploy that mounts it, or Docker creates the
# directory itself, as root, and this user can no longer write there.
if [ "$USER_MODE" = 1 ]; then
  say "Where the CRM reads the status"
  mounted=$(docker inspect "$APP_CONTAINER" \
    --format '{{range .Mounts}}{{if eq .Destination "/app/backup-status"}}{{.Source}}{{end}}{{end}}' \
    2>/dev/null || true)
  if [ "$mounted" = "$STATE/backup-status" ]; then
    echo "   ✓ the app reads $mounted"
  else
    echo "   ✗ the app reads '${mounted:-nothing}', not $STATE/backup-status. In $PROJECT/.env:"
    echo "       BACKUP_STATUS_HOST_DIR=$STATE/backup-status"
    echo "     then ./scripts/deploy.sh"
  fi
fi

say "Next, in this order (RESTORE.md §7)"
if [ "$USER_MODE" = 1 ]; then
  cat <<EOF
   1. nano $ENV_FILE                             the bucket address and the backup key
   2. ./scripts/backup/install.sh --user --init  the repository
   3. ./scripts/backup/backup.sh                 a first backup, by hand
   4. ./scripts/backup/drill.sh                  a first restore test, by hand
   5. ./scripts/backup/install.sh --user --enable-timers
   6. docker compose exec -T app npx tsx scripts/backup-check.ts
                                                 Settings → System → Nightly backups, now rather
                                                 than at 03:50
   restic and rclone live in ~/.local/bin: a new login puts it on PATH, or
   export PATH="\$HOME/.local/bin:\$PATH"
   Finish today: the CRM checks by itself at 03:50, and a server without a backup then is red.
EOF
else
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
fi
