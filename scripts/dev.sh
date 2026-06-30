#!/usr/bin/env bash
set -Eeu -o pipefail

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)
ROOT_DIR="${SCRIPT_DIR}/.."

cd "${ROOT_DIR:?}"

export COMMIT_HASH
COMMIT_HASH=$(git rev-parse HEAD)

pnpm run build
pnpm run database:migrate -- --local
pnpm run pages -- dev packages/frontend/dist --compatibility-date=2022-12-20
