#!/usr/bin/env bash
set -Eeu -o pipefail

SCRIPT_DIR=$(
  cd "$(dirname "$0")" || exit
  pwd
)
ROOT_DIR="${SCRIPT_DIR}/.."

cd "${ROOT_DIR:?}"

pnpm run build
pnpm run database:create-mock
pnpm run pages dev packages/frontend/dist \
  --port 8788 \
  --binding "DOMAIN=0.0.0.0" \
  --binding "INSTANCE_TITLE=Test Wildebeest" \
  --binding "INSTANCE_DESCR=My Wildebeest Instance" \
  --binding "ACCESS_AUTH_DOMAIN=0.0.0.0.cloudflareaccess.com" \
  --binding "ACCESS_AUD=DEV_AUD" \
  --binding "ADMIN_EMAIL=george@test.email" \
  --binding "userKEK=test-kek" \
  --compatibility-date=2022-12-20
