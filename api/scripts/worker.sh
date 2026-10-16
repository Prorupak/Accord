#!/usr/bin/env sh
# Runs pywrangler for the private Python Worker with a fresh copy of app/ in its module root.
# Usage (from api/): scripts/worker.sh deploy --env staging | scripts/worker.sh dev
set -eu
# wrangler dev would otherwise load api/.env (the real OpenRouter key) and make paid/quota calls.
export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
cd "$(dirname "$0")/.."
rm -rf worker/app
rsync -a --exclude __pycache__ app/ worker/app/
exec uv run pywrangler "$@"
