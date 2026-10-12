#!/usr/bin/env bash
# Daily off-Cloudflare backup of the instance's D1 database and the originals of
# its Cloudflare Images.
#
# Nothing in here prints row data, image data, keys or tokens, and `set -x` is
# deliberately never enabled: the runner log is not a trusted place.
#
# Required environment:
#   CF_ACCOUNT_ID, CF_API_TOKEN, NAME_SUFFIX
#   BACKUP_AGE_RECIPIENT            age public recipient (age1... or ssh-...)
#   BACKUP_S3_ENDPOINT              S3-compatible endpoint URL (not Cloudflare)
#   BACKUP_S3_REGION, BACKUP_S3_BUCKET
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# Optional:
#   BACKUP_S3_PREFIX                key prefix inside the bucket (default: none)

set -euo pipefail

: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID not defined}"
: "${CF_API_TOKEN:?CF_API_TOKEN not defined}"
: "${NAME_SUFFIX:?NAME_SUFFIX not defined}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT not defined}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT not defined}"
: "${BACKUP_S3_REGION:?BACKUP_S3_REGION not defined}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET not defined}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID not defined}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY not defined}"

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
cd "$repo" # so `npx --no-install wrangler` resolves the pinned local wrangler

prefix=${BACKUP_S3_PREFIX:-}
prefix=${prefix%/}
api="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stamp=$(date -u +%Y/%m/%d/%H%M%SZ)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

cf_api() {
	curl -sS --fail-with-body -H "Authorization: Bearer ${CF_API_TOKEN}" "$@"
}

s3_key() {
	if [ -n "$prefix" ]; then printf '%s/%s' "$prefix" "$1"; else printf '%s' "$1"; fi
}

s3_cp() {
	aws s3 cp --only-show-errors \
		--endpoint-url "$BACKUP_S3_ENDPOINT" --region "$BACKUP_S3_REGION" \
		"$1" "s3://${BACKUP_S3_BUCKET}/$(s3_key "$2")"
}

encrypt() {
	age -r "$BACKUP_AGE_RECIPIENT" -o "$2" "$1"
}

# --- resolve the database exactly like the deploy workflow does ---------------

eval_resolve=$(CF_ACCOUNT_ID="$CF_ACCOUNT_ID" CF_API_TOKEN="$CF_API_TOKEN" \
	NAME_SUFFIX="$NAME_SUFFIX" "$repo/scripts/ops/resolve-d1.sh")

pages_project_exists=false
d1_id=
d1_name=
while IFS='=' read -r key value; do
	case $key in
	pages_project_exists) pages_project_exists=$value ;;
	d1_id) d1_id=$value ;;
	d1_name) d1_name=$value ;;
	esac
done <<<"$eval_resolve"

if [ "$pages_project_exists" != "true" ] || [ -z "$d1_name" ]; then
	echo "no deployed instance found for suffix ${NAME_SUFFIX}; nothing to back up" >&2
	exit 1
fi
echo "backing up D1 database ${d1_name}"

d1_query() {
	npx --no-install wrangler d1 execute "$d1_name" --remote --json --command "$1"
}

# --- table list --------------------------------------------------------------
#
# A whole-database export fails when FTS5 virtual tables exist, so tables are
# exported one by one. Virtual tables and their shadow tables are rebuilt from
# the schema on restore, and _cf_* / sqlite_* are not ours.

schema_json="$work/schema.json"
d1_query "SELECT name, type, sql FROM sqlite_master WHERE type = 'table' ORDER BY name;" >"$schema_json"

mapfile -t virtual_tables < <(jq -r '
	.[0].results[]
	| select((.sql // "") | test("CREATE +VIRTUAL +TABLE"; "i"))
	| .name' "$schema_json")

is_shadow() {
	local name=$1 v
	for v in "${virtual_tables[@]}"; do
		case $name in "${v}_"*) return 0 ;; esac
	done
	return 1
}

tables=()
while read -r name; do
	[ -n "$name" ] || continue
	case $name in
	sqlite_* | _cf_*) continue ;;
	esac
	if is_shadow "$name"; then continue; fi
	tables+=("$name")
done < <(jq -r '
	.[0].results[]
	| select(((.sql // "") | test("CREATE +VIRTUAL +TABLE"; "i")) | not)
	| .name' "$schema_json")

if [ ${#tables[@]} -eq 0 ]; then
	echo "no tables to export" >&2
	exit 1
fi
echo "exporting ${#tables[@]} table(s)"

# --- export + row counts -----------------------------------------------------

dump="$work/dump.sql"
: >"$dump"
counts="$work/counts.json"
echo '{}' >"$counts"
failures=0

for table in "${tables[@]}"; do
	part="$work/part.sql"
	if npx --no-install wrangler d1 export "$d1_name" --remote -y \
		--table "$table" --output "$part" >/dev/null; then
		cat "$part" >>"$dump"
		printf '\n' >>"$dump"
		rm -f "$part"
	else
		echo "export failed for table ${table}" >&2
		failures=$((failures + 1))
		continue
	fi

	count=$(d1_query "SELECT COUNT(*) AS n FROM \"${table}\";" | jq -r '.[0].results[0].n')
	jq --arg t "$table" --argjson n "$count" '.[$t] = $n' "$counts" >"$counts.new"
	mv "$counts.new" "$counts"
done

if [ "$failures" -gt 0 ]; then
	echo "${failures} table(s) failed to export; not uploading a partial backup" >&2
	exit 1
fi

migration_level=$(d1_query "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1;" |
	jq -r '.[0].results[0].name // "unknown"')

manifest="$work/manifest.json"
jq -n \
	--arg instance "wildebeest-${NAME_SUFFIX}" \
	--arg database_name "$d1_name" \
	--arg database_id "$d1_id" \
	--arg exported_at "$started_at" \
	--arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	--arg migration_level "$migration_level" \
	--arg dump_sha256 "$(sha256 "$dump")" \
	--argjson row_counts "$(cat "$counts")" \
	'{
		instance: $instance,
		database_name: $database_name,
		database_id: $database_id,
		exported_at: $exported_at,
		finished_at: $finished_at,
		migration_level: $migration_level,
		dump_sha256: $dump_sha256,
		tables: ($row_counts | keys),
		row_counts: $row_counts
	}' >"$manifest"

encrypt "$dump" "$work/dump.sql.age"
encrypt "$manifest" "$work/manifest.json.age"

s3_cp "$work/dump.sql.age" "d1/${stamp}/dump.sql.age"
s3_cp "$work/manifest.json.age" "d1/${stamp}/manifest.json.age"
echo "uploaded database backup to d1/${stamp}/"

rm -f "$dump" "$work/dump.sql.age"

# --- Cloudflare Images originals, incrementally ------------------------------

existing="$work/existing.txt"
: >"$existing"
if keys=$(aws s3api list-objects-v2 \
	--endpoint-url "$BACKUP_S3_ENDPOINT" --region "$BACKUP_S3_REGION" \
	--bucket "$BACKUP_S3_BUCKET" --prefix "$(s3_key images/)" \
	--query 'Contents[].Key' --output text); then
	printf '%s\n' "$keys" | tr '\t' '\n' |
		sed -e 's#.*/##' -e 's#\.age$##' |
		grep -v -e '^None$' -e '^$' | sort -u >"$existing" || : >"$existing"
else
	echo "could not list existing image backups" >&2
	exit 1
fi

ids="$work/ids.txt"
: >"$ids"
page=1
per_page=100
while :; do
	body="$work/images.json"
	cf_api "${api}/images/v1?page=${page}&per_page=${per_page}" >"$body"
	got=$(jq -r '.result.images | length' "$body")
	jq -r '.result.images[].id' "$body" >>"$ids"
	if [ "$got" -lt "$per_page" ]; then
		break
	fi
	page=$((page + 1))
done

total=$(wc -l <"$ids" | tr -d ' ')
new=0
for id in $(comm -23 <(sort -u "$ids") "$existing"); do
	blob="$work/blob"
	if ! cf_api "${api}/images/v1/${id}/blob" --output "$blob"; then
		# On failure the body is the API's error JSON (codes and messages only, no image data).
		echo "download failed for image ${id}: $(jq -c '[.errors[]? | {code, message}]' "$blob" 2>/dev/null)" >&2
		failures=$((failures + 1))
		continue
	fi
	if ! encrypt "$blob" "$blob.age" || ! s3_cp "$blob.age" "images/${id}.age"; then
		echo "upload failed for image ${id}" >&2
		failures=$((failures + 1))
	else
		new=$((new + 1))
	fi
	rm -f "$blob" "$blob.age"
done

echo "images: ${total} listed, ${new} newly uploaded"

if [ "$failures" -gt 0 ]; then
	echo "backup incomplete: ${failures} failure(s)" >&2
	exit 1
fi

echo "backup complete"
