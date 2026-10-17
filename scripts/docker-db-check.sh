#!/usr/bin/env bash
# Rehearses the account database lifecycle with synthetic rows: migrate, persist across a
# container restart, re-migrate, no published port, pg_dump/pg_restore into a scratch database.
# Runs as its own Compose project (accord-dbcheck) with a throwaway password, so it never touches
# your local `accord` database. Its own volume is removed on exit. No web, api or AI calls.
set -euo pipefail
cd "$(dirname "$0")/.."
export POSTGRES_PASSWORD; POSTGRES_PASSWORD=$(openssl rand -hex 16)
dc() { docker compose -p accord-dbcheck -f compose.yaml -f compose.db.yaml "$@"; }
sql() { dc exec -T db psql -U accord -d "${2:-accord}" -v ON_ERROR_STOP=1 -Atc "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# Deletes only this script's disposable project volume (accord-dbcheck_accord-db).
trap 'dc --profile migrate down --volumes --remove-orphans >/dev/null 2>&1 || true' EXIT

dc --profile migrate build migrate >/dev/null
dc up -d --wait db
out=$(dc run --rm migrate 2>&1) || fail "first migrate: $out"
grep -q "successfully applied" <<<"$out" || fail "first migrate applied nothing: $out"
echo "ok   migrate deploy applies the committed migration to an empty database"

[ -z "$(docker port "$(dc ps -q db)")" ] || fail "db publishes a host port"
echo "ok   db publishes no host port"

sql "INSERT INTO \"user\" (id, name, email, \"updatedAt\") VALUES ('dbcheck-user', 'Synthetic', 'dbcheck@example.test', now());
     INSERT INTO workspace (id, \"ownerId\", name, \"updatedAt\") VALUES ('00000000-0000-7000-8000-000000000001', 'dbcheck-user', 'Personal', now());
     INSERT INTO project (id, \"workspaceId\", name, version, \"updatedAt\") VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'Synthetic', 1, now());
     INSERT INTO reconciliation_snapshot (id, \"projectId\", version, \"idempotencyKey\", audit, \"auditSchemaVersion\", \"configurationHash\", \"domainRevision\")
       VALUES ('00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000002', 1, '00000000-0000-4000-8000-000000000004', '{\"schemaVersion\":1,\"synthetic\":true}', 1, 'synthetic', 0);" >/dev/null
counts="SELECT (SELECT count(*) FROM \"user\") || ' ' || (SELECT count(*) FROM workspace) || ' ' || (SELECT count(*) FROM project) || ' ' || (SELECT count(*) FROM reconciliation_snapshot)"
[ "$(sql "$counts")" = "1 1 1 1" ] || fail "synthetic rows not inserted"
echo "ok   synthetic user, workspace, project and snapshot inserted"

dc down   # containers only; the named volume stays
dc up -d --wait db
[ "$(sql "$counts")" = "1 1 1 1" ] || fail "rows lost across down/up"
[ "$(sql "SELECT audit->>'synthetic' FROM reconciliation_snapshot")" = "true" ] || fail "audit JSON changed"
echo "ok   rows survive docker compose down/up with the volume kept"

out=$(dc run --rm migrate 2>&1) || fail "second migrate: $out"
grep -q "No pending migrations" <<<"$out" || fail "second migrate was not a no-op: $out"
echo "ok   migrate deploy again is a no-op"

dc exec -T db sh -c 'pg_dump -U accord -d accord -Fc -f /tmp/accord.dump'
sql "CREATE DATABASE accord_restore_check" >/dev/null
dc exec -T db pg_restore -U accord -d accord_restore_check --no-owner --exit-on-error /tmp/accord.dump
[ "$(sql "$counts" accord_restore_check)" = "1 1 1 1" ] || fail "restored database differs"
sql "DROP DATABASE accord_restore_check" >/dev/null
dc exec -T db rm -f /tmp/accord.dump
echo "ok   pg_dump/pg_restore round-trips into a scratch database"
echo "all database checks passed"
