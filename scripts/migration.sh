#!/usr/bin/env bash
set -Eeu -o pipefail

echo -n 'input migration file name: '
read -r INPUT

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)
sqlite3def --enable-drop-table --config "${SCRIPT_DIR:?}/../sqldef.yml" --dry-run "${SCRIPT_DIR:?}/../.wrangler/state/d1/DATABASE.sqlite3" <"${SCRIPT_DIR:?}/../schema.sql" >"${SCRIPT_DIR:?}/../migrations/${INPUT:?}.sql"
