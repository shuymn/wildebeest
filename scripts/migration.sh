#!/usr/bin/env bash
set -Eeu -o pipefail

echo -n 'input migration file name: '
read -r INPUT

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)
ROOT_DIR="${SCRIPT_DIR}/.."

DB_FILE=$(
  find "${ROOT_DIR}/.wrangler/state/v3/d1/miniflare-D1DatabaseObject" -name "*.sqlite" -type f 2>/dev/null | head -n 1
)
if [ -z "${DB_FILE}" ]; then
  DB_FILE="${ROOT_DIR}/.wrangler/state/v3/d1/83821907-97fd-44b4-8f21-e3d6b736e7ef/db.sqlite"
fi
if [ ! -f "${DB_FILE}" ]; then
  echo "error: local D1 database file not found (run pnpm run database:migrate -- --local first)" >&2
  exit 1
fi

# Drop Cloudflare internal tables to avoid sqlite3def parser errors.
sqlite3 "${DB_FILE:?}" "DROP TABLE IF EXISTS _cf_KV; DROP TABLE IF EXISTS _cf_METADATA;"

mise exec -- sqlite3def \
  --enable-drop-table \
  --config "${ROOT_DIR}/sqldef.yml" \
  --dry-run \
  "${DB_FILE:?}" \
  <"${ROOT_DIR}/schema.sql" \
  >"${ROOT_DIR}/migrations/${INPUT:?}.sql"

echo "wrote migrations/${INPUT}.sql"
