#!/usr/bin/env bash
# Smoke-checks a running `docker compose up -d` stack. Never calls the AI provider:
# the only POSTs are empty bodies that the API rejects during validation.
set -euo pipefail
cd "$(dirname "$0")/.."
web=http://127.0.0.1:3000
fail() { echo "FAIL: $*" >&2; exit 1; }

[ "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q api)")" = healthy ] \
  || fail "api container is not healthy"
[ -z "$(docker port "$(docker compose ps -q api)")" ] || fail "api publishes a host port"
echo "ok   api healthy, no published port"

curl -fsS "$web/" | grep -q 'source-a.csv' || fail "GET / missing the sample fixtures"
echo "ok   GET / serves the page with sample fixtures"

curl -fsS "$web/api/capabilities" | grep -q '"provider"' || fail "GET /api/capabilities via proxy"
echo "ok   GET /api/capabilities through the Next.js proxy"

# 400 INVALID_INPUT from schema validation proves the proxied Host/Origin passed the guard.
body=$(curl -sS -X POST -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
  --data '{}' "$web/api/map")
case "$body" in
  *'"INVALID_INPUT"'*'Field required'*) echo "ok   POST /api/map reaches validation (Host/Origin accepted)" ;;
  *) fail "POST /api/map unexpected response: $body" ;;
esac

body=$(curl -sS -X POST -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
  --data '{}' "$web/api/suggest")
case "$body" in
  *'"INVALID_INPUT"'*'Field required'*) echo "ok   POST /api/suggest reaches validation (Host/Origin accepted)" ;;
  *) fail "POST /api/suggest unexpected response: $body" ;;
esac

# Only the three inference routes are proxied. Anything else under /api/ must get Next's HTML 404,
# not FastAPI's JSON {"detail":"Not Found"}: project routes must never reach Python.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
for path in /api/projects /api/projects/example/snapshots /api/random /api/map/unknown; do
  meta=$(curl -sS -o "$tmp" -w '%{http_code} %{content_type}' "$web$path")
  case "$meta" in
    '404 text/html'*) ! grep -q '"detail"' "$tmp" || fail "GET $path returned a FastAPI body" ;;
    *) fail "GET $path expected Next 404 HTML, got: $meta" ;;
  esac
  echo "ok   GET $path is handled by Next, not proxied to FastAPI"
done

# /api/auth/* is Better Auth on Next. Without BETTER_AUTH_SECRET (this stack) it is NOT_CONFIGURED.
meta=$(curl -sS -o "$tmp" -w '%{http_code} %{content_type}' "$web/api/auth/get-session")
case "$meta" in
  '503 application/json'*) grep -q '"NOT_CONFIGURED"' "$tmp" || fail "GET /api/auth/get-session body: $(cat "$tmp")" ;;
  *) fail "GET /api/auth/get-session expected 503 NOT_CONFIGURED, got: $meta" ;;
esac
echo "ok   GET /api/auth/get-session is the unconfigured auth route on Next"
echo "all smoke checks passed"
