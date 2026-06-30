#!/usr/bin/env bash
set -Eeu -o pipefail

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)
ROOT_DIR="${SCRIPT_DIR}/.."

cd "${ROOT_DIR:?}"

pnpm run build
pnpm run database:migrate
pnpm run pages -- deploy packages/frontend/dist --project-name=wildebeest
