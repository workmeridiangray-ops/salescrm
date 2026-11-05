#!/usr/bin/env bash
# Runs the database tests against a throw-away plain-Postgres cluster (no Docker).
# Needs PostgreSQL server binaries; set PG_BIN if they are not on the default path.
# Postgres refuses to run as root, so as root this uses the `pgtest` user.
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}"
PORT="${PGPORT_TEST:-54339}"
DIR="$(mktemp -d)"
run() { if [ "$(id -u)" = 0 ]; then su pgtest -c "$*"; else bash -c "$*"; fi; }
[ "$(id -u)" = 0 ] && { id pgtest >/dev/null 2>&1 || useradd -m pgtest; chown pgtest "$DIR"; }
trap 'run "$PG_BIN/pg_ctl -D $DIR/d stop -m immediate >/dev/null" || true; rm -rf "$DIR"' EXIT
run "$PG_BIN/initdb -D $DIR/d -A trust -U postgres >/dev/null"
run "$PG_BIN/pg_ctl -D $DIR/d -o '-p $PORT -k $DIR' -l $DIR/log -w start >/dev/null"
URL="postgresql://postgres@127.0.0.1:$PORT/postgres"
for f in tests/db/auth-stub.sql supabase/migrations/*.sql; do
  "$PG_BIN/psql" -q -v ON_ERROR_STOP=1 "$URL" -f "$f"
done
SUPABASE_DB_URL="$URL" npx vitest run --project db
