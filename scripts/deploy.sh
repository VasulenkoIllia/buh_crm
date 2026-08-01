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
  say "Wiping client data (the team is kept)"
  if ! $ASSUME_YES; then
    echo "   This deletes every client, task, invoice and file in \"$PG_DB\"."
    printf '   Type the database name to confirm: '
    read -r answer
    [ "$answer" = "$PG_DB" ] || { echo "   not confirmed — nothing was changed"; exit 1; }
  fi
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U "$PG_USER" -d "$PG_DB" < scripts/reset-data.sql
  rm -rf ./data/uploads/*   # the rows are gone; drop the files they pointed at
  echo "   done"
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
          (select count(*) from "Priority") priorities, (select count(*) from "TaskColumn") columns;'

say "Done — $(git log -1 --format='%h %s')"
echo "   rollback, if needed:"
echo "     docker compose exec -T db psql -U $PG_USER -d $PG_DB < $DUMP"
