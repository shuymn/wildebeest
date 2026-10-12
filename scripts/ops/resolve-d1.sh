#!/usr/bin/env bash
# Resolve which D1 database an existing instance uses.
#
# An instance that already has a Pages project MUST keep using the D1 database
# bound to that project's production environment as "DATABASE". Looking the
# database up by its expected name instead would silently attach a brand new,
# empty database to an instance whose database is named differently (e.g. an
# instance derived from upstream), which splits the actor identity and key pair
# on the next login.
#
# Required environment:
#   CF_ACCOUNT_ID, CF_API_TOKEN, NAME_SUFFIX
#
# Prints `key=value` lines on stdout (safe to append to $GITHUB_ENV):
#   pages_project_exists=true|false
#   d1_id=<uuid>     (only when the Pages project exists)
#   d1_name=<name>   (only when the Pages project exists)
#
# Exits non-zero when the Pages project exists but has no DATABASE binding, or
# when the Cloudflare API cannot be queried.

set -euo pipefail

: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID not defined}"
: "${CF_API_TOKEN:?CF_API_TOKEN not defined}"
: "${NAME_SUFFIX:?NAME_SUFFIX not defined}"

api="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}"
project="wildebeest-${NAME_SUFFIX}"

body=$(mktemp)
trap 'rm -f "$body"' EXIT

status=$(curl -sS -o "$body" -w '%{http_code}' \
	-H "Authorization: Bearer ${CF_API_TOKEN}" \
	"${api}/pages/projects/${project}")

if [ "$status" = "404" ]; then
	# First install: no Pages project yet, the caller may create a D1 database.
	echo "pages_project_exists=false"
	exit 0
fi

if [ "$status" != "200" ]; then
	echo "failed to read Pages project ${project} (HTTP ${status})" >&2
	jq -r '.errors // empty | .[]?.message' "$body" >&2 || true
	exit 1
fi

d1_id=$(jq -r '.result.deployment_configs.production.d1_databases.DATABASE.id // empty' "$body")

if [ -z "$d1_id" ]; then
	cat >&2 <<-EOF
		Pages project ${project} exists but has no production D1 binding named DATABASE.

		Refusing to continue: creating or guessing a database here would attach an
		empty database to an existing instance and split its identity. Bind the
		instance's existing D1 database as DATABASE on the production environment
		of the Pages project, then re-run the deploy.
	EOF
	exit 1
fi

status=$(curl -sS -o "$body" -w '%{http_code}' \
	-H "Authorization: Bearer ${CF_API_TOKEN}" \
	"${api}/d1/database/${d1_id}")

if [ "$status" != "200" ]; then
	echo "failed to look up D1 database ${d1_id} (HTTP ${status})" >&2
	jq -r '.errors // empty | .[]?.message' "$body" >&2 || true
	exit 1
fi

d1_name=$(jq -r '.result.name // empty' "$body")
if [ -z "$d1_name" ]; then
	echo "D1 database ${d1_id} has no name in the API response" >&2
	exit 1
fi

echo "pages_project_exists=true"
echo "d1_id=${d1_id}"
echo "d1_name=${d1_name}"
