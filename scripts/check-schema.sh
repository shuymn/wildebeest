#!/usr/bin/env bash
set -Eeu -o pipefail

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)
ROOT_DIR="${SCRIPT_DIR}/.."

cd "${ROOT_DIR:?}"

SQLITE3DEF=(sqlite3def)
if command -v mise >/dev/null 2>&1; then
  SQLITE3DEF=(mise exec -- sqlite3def)
fi

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

# Drop Cloudflare internal tables to avoid sqlite3def parser errors and drift.
sqlite3 "${DB_FILE:?}" "DROP TABLE IF EXISTS _cf_KV; DROP TABLE IF EXISTS _cf_METADATA; DROP TABLE IF EXISTS _cf_ALARM;"

set +e
DIFF=$(
  "${SQLITE3DEF[@]}" \
    --enable-drop \
    --config sqldef.yml \
    --check \
    "${DB_FILE:?}" <schema.sql 2>&1
)
EXIT_CODE=$?
set -e

if [ "${EXIT_CODE}" -eq 0 ]; then
  echo "schema.sql matches migrations"
  exit 0
fi

if { [ "${EXIT_CODE}" -eq 1 ] || [ "${EXIT_CODE}" -eq 2 ]; } && [[ "${DIFF}" == --\ dry\ run\ --* ]]; then
  echo "error: schema.sql does not match migrations" >&2
  printf '%s\n' "${DIFF}" >&2
  exit 1
fi

echo "error: sqlite3def failed (exit ${EXIT_CODE})" >&2
printf '%s\n' "${DIFF}" >&2
exit "${EXIT_CODE}"
