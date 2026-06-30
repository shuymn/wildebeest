#!/usr/bin/env bash
set -Eeu -o pipefail

echo -n 'input migration file name: '
read -r INPUT
if [[ ! "${INPUT}" =~ ^[0-9]{4}_[a-z0-9_]+$ ]]; then
  echo "error: invalid migration file name format (expected: NNNN_description)" >&2
  exit 1
fi

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)
ROOT_DIR="${SCRIPT_DIR}/.."

find_migrated_d1_database() {
  local database_dir="$1"
  local candidate
  local matches=()

  while IFS= read -r -d '' candidate; do
    if sqlite3 "${candidate}" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actors' LIMIT 1;" | grep -qx 1; then
      matches+=("${candidate}")
    fi
  done < <(find "${database_dir}" -name "*.sqlite" -type f -print0 2>/dev/null)

  if [ "${#matches[@]}" -eq 1 ]; then
    printf '%s\n' "${matches[0]}"
    return 0
  fi

  if [ "${#matches[@]}" -gt 1 ]; then
    echo "error: multiple migrated local D1 database files found; please clean .wrangler/state" >&2
    printf '  %s\n' "${matches[@]}" >&2
  else
    echo "error: migrated local D1 database file not found (run pnpm run database:migrate --local first)" >&2
  fi

  return 1
}

DB_FILES=()
while IFS= read -r -d '' file; do
  DB_FILES+=("$file")
done < <(find "${ROOT_DIR}/.wrangler/state/v3/d1/miniflare-D1DatabaseObject" -name "*.sqlite" -type f -print0 2>/dev/null)

if [ "${#DB_FILES[@]}" -eq 0 ]; then
  DB_FILE="${ROOT_DIR}/.wrangler/state/v3/d1/83821907-97fd-44b4-8f21-e3d6b736e7ef/db.sqlite"
elif [ "${#DB_FILES[@]}" -eq 1 ]; then
  DB_FILE="${DB_FILES[0]}"
else
  DB_FILE=$(find_migrated_d1_database "${ROOT_DIR}/.wrangler/state/v3/d1/miniflare-D1DatabaseObject")
fi
if [ ! -f "${DB_FILE}" ]; then
  echo "error: migrated local D1 database file not found (run pnpm run database:migrate --local first)" >&2
  exit 1
fi

# Drop Cloudflare internal tables to avoid sqlite3def parser errors and drift.
sqlite3 "${DB_FILE:?}" "DROP TABLE IF EXISTS _cf_KV; DROP TABLE IF EXISTS _cf_METADATA; DROP TABLE IF EXISTS _cf_ALARM;"

mise exec -- sqlite3def \
  --enable-drop \
  --config "${ROOT_DIR}/sqldef.yml" \
  --dry-run \
  "${DB_FILE:?}" \
  <"${ROOT_DIR}/schema.sql" \
  >"${ROOT_DIR}/migrations/${INPUT}.sql"

echo "wrote migrations/${INPUT}.sql"
