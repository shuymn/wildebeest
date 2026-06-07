#!/usr/bin/env bash
set -Eeu -o pipefail

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)
ROOT_DIR="${SCRIPT_DIR}/.."

cd "${ROOT_DIR:?}"

echo "Applying migrations to a fresh local D1 database..."
rm -f .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite*
CI=true pnpm run database:migrate -- --local

DB_FILE=$(
  find .wrangler/state/v3/d1/miniflare-D1DatabaseObject -name "*.sqlite" -type f | head -n 1
)
if [ -z "${DB_FILE}" ]; then
  echo "error: local D1 database file not found" >&2
  exit 1
fi

# Drop Cloudflare internal tables to avoid sqlite3def parser errors.
sqlite3 "${DB_FILE:?}" "DROP TABLE IF EXISTS _cf_KV; DROP TABLE IF EXISTS _cf_METADATA;"

DIFF=$(
  mise exec -- sqlite3def \
    --enable-drop \
    --config sqldef.yml \
    --dry-run \
    "${DB_FILE:?}" <schema.sql
)

FIRST_LINE=$(printf '%s\n' "${DIFF}" | head -n 1)
if [ "${FIRST_LINE}" = "-- Nothing is modified --" ]; then
  echo "schema.sql matches migrations"
  exit 0
fi

echo "error: schema.sql does not match migrations" >&2
printf '%s\n' "${DIFF}" >&2
exit 1
