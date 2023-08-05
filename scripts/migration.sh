#!/usr/bin/env bash
set -Eeu -o pipefail

echo -n 'input migration file name: '
read -r INPUT

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)

sqlite3def \
  --enable-drop-table \
  --config "${SCRIPT_DIR:?}/../sqldef.yml" \
  --dry-run \
  "${SCRIPT_DIR:?}/../.wrangler/state/v3/d1/83821907-97fd-44b4-8f21-e3d6b736e7ef/db.sqlite" \
  <"${SCRIPT_DIR:?}/../schema.sql" \
  >"${SCRIPT_DIR:?}/../migrations/${INPUT:?}.sql"
