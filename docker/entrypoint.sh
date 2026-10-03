#!/bin/sh
# Runs inside the `runner` image (and works on a host for testing):
#   1. apply D1 migrations to the local database persisted under $D1_PERSIST_DIR
#   2. load the seed when the outings table is empty (SQL files prebuilt by the
#      builder stage with `seed.ts --sql-out`, applied with `wrangler d1 execute`)
#   3. start `wrangler dev --local` on 0.0.0.0:8787
set -eu

APP_DIR="${APP_DIR:-/app}"
SITE_DIR="$APP_DIR/apps/site"
PERSIST="${D1_PERSIST_DIR:-/data}"
PORT="${PORT:-8787}"
WRANGLER="${WRANGLER:-wrangler}"

cd "$SITE_DIR"
mkdir -p "$PERSIST"

log() { printf '[gof] %s\n' "$*"; }

log "applying D1 migrations (local, persisted to $PERSIST)"
CI=1 $WRANGLER d1 migrations apply gof --local --persist-to "$PERSIST"

count=$($WRANGLER d1 execute gof --local --persist-to "$PERSIST" --json \
  --command "SELECT count(*) AS n FROM outings" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0].results[0].n)}catch{console.log("unknown")}})')
log "outings in local D1: $count"

SEED_SQL="${SEED_SQL_DIR:-$APP_DIR/seed-sql}"
if [ "$count" = "0" ]; then
  if ls "$SEED_SQL"/*.sql >/dev/null 2>&1; then
    log "loading the seed from $SEED_SQL"
    for f in "$SEED_SQL"/*.sql; do
      log "  $(basename "$f")"
      CI=1 $WRANGLER d1 execute gof --local --persist-to "$PERSIST" --file "$f" --yes >/dev/null
    done
    seeded=$($WRANGLER d1 execute gof --local --persist-to "$PERSIST" --json \
      --command "SELECT count(*) AS n FROM outings WHERE published = 1" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0].results[0].n)}catch{console.log("unknown")}})')
    log "published outings after seeding: $seeded"
  else
    log "no seed SQL in $SEED_SQL, skipping"
  fi
fi

set -- --local --ip 0.0.0.0 --port "$PORT" --persist-to "$PERSIST" \
  --show-interactive-dev-session=false \
  --var "NODE_ENV:${NODE_ENV:-development}" \
  --var "PUBLIC_SITE_URL:${PUBLIC_SITE_URL:-http://localhost:$PORT}"
if [ -n "${SITE_NOW:-}" ]; then
  set -- "$@" --var "SITE_NOW:$SITE_NOW"
fi

log "starting wrangler dev on 0.0.0.0:$PORT"
exec $WRANGLER dev "$@"
