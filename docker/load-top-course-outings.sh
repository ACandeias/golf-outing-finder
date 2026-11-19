#!/bin/sh
# Appends data/top-course-outings.json to the running Docker site's D1 without
# wiping the volume. Offline apart from Docker itself.
#
#   COURSES_DB=<path to a D1 .sqlite with the full course import> \
#     sh docker/load-top-course-outings.sh
#
# 1. snapshot the container's courses, organizers and outings (ids and slugs)
# 2. build append-only SQL on the host (packages/pipeline/src/top-course-outings.ts)
# 3. copy the SQL into the container and apply it with wrangler d1 execute
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SERVICE="${SERVICE:-site}"
WORK="$ROOT/.cache/top-course-outings"
: "${COURSES_DB:?set COURSES_DB to a D1 .sqlite file that holds the course import}"

cd "$ROOT"
mkdir -p "$WORK"
log() { printf '[top-course-outings] %s\n' "$*"; }

q() {
  docker compose exec -T "$SERVICE" sh -c \
    "cd /app/apps/site && CI=1 wrangler d1 execute gof --local --persist-to \"\${D1_PERSIST_DIR:-/data}\" --json --command \"$1\"" 2>/dev/null
}

log "snapshotting the container's database"
q "SELECT id, slug, osm_ref FROM courses" > "$WORK/courses.json"
q "SELECT id, slug, name FROM organizers" > "$WORK/organizers.json"
q "SELECT slug, course_id, start_date, organizer_id, canonical_source_url FROM outings" > "$WORK/outings.json"
node -e '
const fs = require("node:fs");
const rows = (f) => JSON.parse(fs.readFileSync(f, "utf8"))[0].results;
const d = process.argv[1];
fs.writeFileSync(`${d}/target.json`, JSON.stringify({
  courses: rows(`${d}/courses.json`),
  organizers: rows(`${d}/organizers.json`),
  outings: rows(`${d}/outings.json`),
}));
' "$WORK"

log "building SQL"
PIPELINE_NOW="${PIPELINE_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" \
  pnpm --silent --filter @gof/pipeline start:top-course-outings \
  --courses-db="$COURSES_DB" --target="$WORK/target.json" --sql-out="$WORK/sql"

CID=$(docker compose ps -q "$SERVICE")
docker exec "$CID" rm -rf /tmp/top-course-outings
docker cp "$WORK/sql" "$CID:/tmp/top-course-outings"
for f in "$WORK"/sql/*.sql; do
  [ -e "$f" ] || continue
  log "applying $(basename "$f")"
  docker exec "$CID" sh -c \
    "cd /app/apps/site && CI=1 wrangler d1 execute gof --local --persist-to \"\${D1_PERSIST_DIR:-/data}\" --file /tmp/top-course-outings/$(basename "$f") --yes" >/dev/null
done

log "published outings now: $(q "SELECT count(*) AS n FROM outings WHERE published = 1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results[0].n))')"
