#!/usr/bin/env bash
# Rehearses the account database lifecycle with synthetic rows: migrate, persist across a
# container restart, re-migrate, no published port, pg_dump/pg_restore into a scratch database;
# then the account flow on the real web image (bootstrap, sign-in, cookies, Origin, sign-out).
# Runs as its own Compose project (accord-dbcheck) with throwaway secrets, so it never touches
# your local `accord` database. Its own volume is removed on exit. No AI calls.
set -euo pipefail
cd "$(dirname "$0")/.."
export POSTGRES_PASSWORD BETTER_AUTH_SECRET
POSTGRES_PASSWORD=$(openssl rand -hex 16)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# No published web port, so this can run next to a stack already bound to 127.0.0.1:3000.
override=$(mktemp)
printf 'services:\n  web:\n    ports: !reset []\n' >"$override"
dc() { docker compose -p accord-dbcheck -f compose.yaml -f compose.db.yaml -f "$override" "$@"; }
sql() { dc exec -T db psql -U accord -d "${2:-accord}" -v ON_ERROR_STOP=1 -Atc "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# Deletes only this script's disposable project volume (accord-dbcheck_accord-db).
trap 'dc --profile migrate down --volumes --remove-orphans >/dev/null 2>&1 || true; rm -f "$override"' EXIT

dc --profile migrate build migrate web api >/dev/null
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

# Accounts on the real web image. Requests run inside the web container (no published port);
# cookies and passwords stay in this script's variables and are never printed.
email=operator@example.test
password=$(openssl rand -hex 16)
out=$(printf '%s\n' "$password" | dc run --rm -T migrate node scripts/create-account.mjs --email "$email" 2>&1) \
  || fail "bootstrap: $out"
[ "$(tail -1 <<<"$out")" = "created $email" ] || fail "bootstrap printed unexpected output"
echo "ok   create-account.mjs bootstraps an account through Better Auth with signup disabled"

dc up -d --wait --wait-timeout 120 web
# Prints "<status> <Set-Cookie session attributes, or ->" then the body.
auth() { # method path origin cookie body
  # Values pass through the environment (-e NAME), not argv, so they never show in a process list.
  M="$1" P="$2" O="$3" C="$4" B="$5" dc exec -T -e M -e P -e O -e C -e B web node -e '
    const e = process.env;
    fetch(`http://127.0.0.1:3000/api/auth${e.P}`, { method: e.M, headers: { origin: e.O, cookie: e.C,
      ...(e.B ? { "content-type": "application/json" } : {}) }, body: e.B || undefined })
      .then(async (r) => { const c = r.headers.getSetCookie().find((s) => s.startsWith("better-auth.session_token=")) || "-";
        console.log(r.status, c.split(";").slice(1).map((s) => s.trim()).join(";") || "-"); console.log(await r.text()); })'
}
cookie_of() { # sign-in and print the session cookie pair
  B="$1" dc exec -T -e B web node -e '
    fetch("http://127.0.0.1:3000/api/auth/sign-in/email", { method: "POST", headers: { origin: "http://localhost:3000",
      "content-type": "application/json" }, body: process.env.B })
      .then((r) => { if (r.status !== 200) process.exit(1);
        console.log(r.headers.getSetCookie().find((s) => s.startsWith("better-auth.session_token=")).split(";")[0]); })'
}
creds=$(printf '{"email":"%s","password":"%s"}' "$email" "$password")
site=http://localhost:3000

res=$(auth POST /sign-up/email "$site" "" '{"email":"new@example.test","password":"synthetic-password-1","name":"x"}')
[ "${res%% *}" = 400 ] && grep -q EMAIL_PASSWORD_SIGN_UP_DISABLED <<<"$res" || fail "signup not rejected: ${res%%$'\n'*}"
echo "ok   POST /api/auth/sign-up/email is rejected (signup disabled by default)"

res=$(auth POST /sign-in/email https://evil.example.test "" "$creds")
[ "${res%% *}" = 403 ] || fail "foreign Origin sign-in: ${res%%$'\n'*}"
echo "ok   sign-in from a foreign Origin is rejected"

res=$(auth POST /sign-in/email "$site" "" '{"email":"operator@example.test","password":"wrong-password-123"}')
[ "${res%% *}" = 401 ] || fail "wrong password: ${res%%$'\n'*}"
echo "ok   a wrong password is denied"

res=$(auth POST /sign-in/email "$site" "" "$creds")
head=${res%%$'\n'*}
case "$head" in
  "200 Max-Age="*";Path=/;HttpOnly;SameSite=Lax") ;;
  *) fail "sign-in cookie attributes: $head" ;;
esac
echo "ok   sign-in sets an HttpOnly, SameSite=Lax, host-only session cookie (http: no Secure)"

cookie=$(cookie_of "$creds") || fail "sign-in failed"
auth GET /get-session "$site" "$cookie" "" | grep -q "\"email\":\"$email\"" || fail "session not recognised"
echo "ok   GET /api/auth/get-session returns the signed-in user"
[ "$(sql "SELECT count(*) FROM session")" -ge 1 ] || fail "no session row in PostgreSQL"
echo "ok   the session is stored in PostgreSQL"

res=$(auth POST /sign-out https://evil.example.test "$cookie" '{}')
[ "${res%% *}" = 403 ] || fail "foreign Origin sign-out: ${res%%$'\n'*}"
auth GET /get-session "$site" "$cookie" "" | grep -q "\"email\"" || fail "session lost after rejected sign-out"
res=$(auth POST /sign-out "$site" "$cookie" '{}')
[ "${res%% *}" = 200 ] || fail "sign-out: ${res%%$'\n'*}"
[ "$(auth GET /get-session "$site" "$cookie" "" | tail -1)" = null ] || fail "revoked cookie still authenticates"
echo "ok   sign-out revokes the session; replaying the old cookie gets null"

dc logs --no-color web 2>&1 | grep -qF -e "$password" -e "$BETTER_AUTH_SECRET" -e "$POSTGRES_PASSWORD" && fail "secret in web logs"
echo "ok   web logs contain no password or secret"
echo "all database checks passed"
