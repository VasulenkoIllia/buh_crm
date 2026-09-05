#!/usr/bin/env bash
#
# Deploy buh_crm on the server.
#
#   ./scripts/deploy.sh            pull, rebuild, verify   (data untouched)
#   ./scripts/deploy.sh --reset    …and wipe every client record first, keeping the team
#
# A database dump is always taken first, before anything else can go wrong.
#
# Why --reset runs BEFORE the pull: migrations apply automatically when the container starts
# (Dockerfile CMD is `prisma migrate deploy && npm run start`). Wiping first means they land on an
# empty database — nothing to back-fill, and a migration that drops columns clears an empty table.
# The other order would migrate every live row and then throw it away.

set -euo pipefail

cd "$(dirname "$0")/.."

RESET=false
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=true ;;
    --yes|-y) ASSUME_YES=true ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

[ -f .env ] || { echo "no .env in $(pwd) — are you in the project directory?" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; . ./.env; set +a
PG_USER="${POSTGRES_USER:?POSTGRES_USER missing from .env}"
PG_DB="${POSTGRES_DB:?POSTGRES_DB missing from .env}"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# ── 1. dump ──────────────────────────────────────────────────────────────────
say "Backing up the database"
DUMP=~/"${PG_DB}_$(date +%F_%H%M).sql"
docker compose exec -T db pg_dump -U "$PG_USER" "$PG_DB" > "$DUMP"
[ -s "$DUMP" ] || { echo "the dump is empty — stopping" >&2; exit 1; }
echo "   $DUMP ($(du -h "$DUMP" | cut -f1))"

# ── 2. optional data reset ───────────────────────────────────────────────────
if $RESET; then
  # The reset runs BEFORE the pull (see the header), which means it uses the reset SQL ALREADY ON
  # DISK — not the one arriving with this deploy. When a migration drops a table the old file still
  # names, that file fails, the transaction rolls back, and the deploy stops with a fresh dump, the
  # old code and untouched data. Exactly what a stale `DELETE FROM "Reminder"` was about to do.
  #
  # So: check the file against the branch first, and say what to do rather than finding out after
  # the database is the only thing that moved.
  say "Checking the reset script is current"
  if git fetch --quiet origin 2>/dev/null &&
     ! git diff --quiet FETCH_HEAD -- scripts/reset-data.sql 2>/dev/null; then
    echo "   ✗ scripts/reset-data.sql on disk differs from the branch." >&2
    echo "     --reset would run the OLD one, before this deploy pulls the new." >&2
    echo "     Pull first, then reset:" >&2
    echo "       git pull --ff-only && ./scripts/deploy.sh --reset" >&2
    exit 1
  fi
  echo "   up to date"

  say "Wiping client data (the team is kept)"
  if ! $ASSUME_YES; then
    echo "   This deletes every client, task, invoice and file in \"$PG_DB\"."
    printf '   Type the database name to confirm: '
    read -r answer
    [ "$answer" = "$PG_DB" ] || { echo "   not confirmed — nothing was changed"; exit 1; }
  fi
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U "$PG_USER" -d "$PG_DB" < scripts/reset-data.sql
  echo "   database cleared"
  # The files the deleted rows pointed at are pruned AFTER the rebuild — see step 5. Not here:
  # the reset keeps the team's avatars and the firm's logos now, so the old blanket
  # `rm -rf /app/uploads/*` would delete the bytes those surviving rows point at.
fi

# ── 3. deploy ────────────────────────────────────────────────────────────────
say "Pulling"
git pull --ff-only

say "Rebuilding and restarting (migrations run on start)"
docker compose up -d --build

# ── 4. verify ────────────────────────────────────────────────────────────────
say "Waiting for the app to answer"
for i in $(seq 1 60); do
  if docker compose exec -T app node -e 'fetch(`http://127.0.0.1:${process.env.PORT||3000}/api/auth/me`).then(()=>process.exit(0)).catch(()=>process.exit(1))' 2>/dev/null; then
    echo "   up after ${i}s"; break
  fi
  [ "$i" = 60 ] && { echo "   still not answering — check: docker compose logs app" >&2; exit 1; }
  sleep 1
done

say "Migration state"
docker compose exec -T app npx prisma migrate deploy 2>&1 | tail -3

say "Row counts"
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DB" -c \
  'select (select count(*) from "User") users, (select count(*) from "Client") clients,
          (select count(*) from "Task") tasks, (select count(*) from "Invoice") invoices,
          (select count(*) from "Service") services, (select count(*) from "SourceOption") sources,
          (select count(*) from "Priority") priorities, (select count(*) from "TaskColumn") columns;'

# Mailouts (S10/S10.1). Worth its own line: `mailboxes 0` after a deploy means no letter can go
# out at all, and a campaign due today would record a run with every row skipped rather than say so.
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DB" -c \
  'select (select count(*) from "MailSenderAccount") mailboxes,
          (select count(*) from "EmailTemplate") templates,
          (select count(*) from "Campaign" where status = '"'"'scheduled'"'"') scheduled_campaigns,
          (select count(*) from "Mailout") mailouts,
          (select count(*) from "ClientMailPreference" where "unsubscribedAt" is not null) unsubscribed;'

# Notifications (S9). The same reason the mailbox line above exists: `policies 0` means not one
# notification can ever fire, and the app would look perfectly healthy while nobody hears about
# anything. The rows are seeded by `ensureBaseData()` on boot, so a zero here means the boot
# seeding did not run — check `docker compose logs app`.
#
# `off` is shown beside it because a firm that has deliberately silenced triggers and a module
# that is quietly broken look identical from the outside, and only this number tells them apart.
docker compose exec -T db psql -U "$PG_USER" -d "$PG_DB" -c \
  'select (select count(*) from "NotificationPolicy") policies,
          (select count(*) from "NotificationPolicy" where not enabled) off,
          (select count(*) from "NotificationPolicy" where "defaultEmail") mail_by_default,
          (select count(*) from "Notification" where "readAt" is null) unread,
          (select count(*) from "NotificationPreference") personal_choices;'

# ── 5. prune orphaned uploads (reset only) ───────────────────────────────────
# After the rebuild, so the container is running the image that HAS the script. The APP wrote
# those files, so they belong to the container's user and a host-side `rm` gets Permission denied
# — let the container delete its own. Never fatal: the deploy has already succeeded by here, and
# aborting would report failure for a server that is up and correct.
if $RESET; then
  say "Pruning uploads nothing references any more"
  docker compose exec -T app npx tsx scripts/prune-uploads.ts || {
    echo "   ⚠ prune failed — harmless, only stale bytes remain. Retry:"
    echo "     docker compose exec -T app npx tsx scripts/prune-uploads.ts"
  }
fi

# Notifications raise NOTHING on a deploy: the event triggers wait for somebody to act, and the
# 07:00 sweep defines no catch-up, so it does not run on boot. The first burst is at the next
# 07:00 — and it is the largest this module will produce, because that sweep meets every overdue
# task the firm has ever accumulated. This says how big it will be while there is still time to
# turn a channel off.
say "What the first 07:00 sweep will raise"
docker compose exec -T app npx tsx scripts/notification-forecast.ts 2>&1 | sed -n '2,12p' || \
  echo "   (forecast unavailable — harmless, the deploy has already succeeded)"

say "Done — $(git log -1 --format='%h %s')"
echo "   rollback, if needed:"
echo "     docker compose exec -T db psql -U $PG_USER -d $PG_DB < $DUMP"
