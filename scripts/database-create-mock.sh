#!/usr/bin/env bash
set -Eeu -o pipefail

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)
ROOT_DIR="${SCRIPT_DIR}/.."

cd "${ROOT_DIR:?}"

rm -f .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite*
CI=true pnpm run database:migrate --local
node ./packages/frontend/mock-db/run.mjs
