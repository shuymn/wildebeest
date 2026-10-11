#!/usr/bin/env bash
# Verify a backup produced by scripts/backup/backup.sh, on the operator's own
# machine: decrypt it with their age identity, load the dump into a fresh
# sqlite3 database and compare the per-table row counts with the manifest.
#
# Usage:
#   scripts/backup/verify.sh --identity <age-identity-file> \
#     --dump <dump.sql.age> --manifest <manifest.json.age> [--db <out.sqlite>]
#
# Already decrypted .sql / .json inputs are accepted as-is, so the check can be
# re-run without the identity once a backup has been decrypted.
#
# Exits non-zero on any mismatch.

set -euo pipefail

identity=
dump=
manifest=
db=

while [ $# -gt 0 ]; do
	case $1 in
	--identity)
		identity=$2
		shift 2
		;;
	--dump)
		dump=$2
		shift 2
		;;
	--manifest)
		manifest=$2
		shift 2
		;;
	--db)
		db=$2
		shift 2
		;;
	-h | --help)
		sed -n '2,14p' "$0"
		exit 0
		;;
	*)
		echo "unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$dump" ] || [ -z "$manifest" ]; then
	echo "usage: verify.sh --identity <file> --dump <dump.sql[.age]> --manifest <manifest.json[.age]> [--db <out.sqlite>]" >&2
	exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -z "$db" ]; then
	db="$work/verify.sqlite"
fi
if [ -e "$db" ]; then
	echo "refusing to load into an existing database: ${db}" >&2
	exit 2
fi

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

decrypt() {
	local src=$1 dst=$2
	case $src in
	*.age)
		if [ -z "$identity" ]; then
			echo "--identity is required to decrypt ${src}" >&2
			exit 2
		fi
		age -d -i "$identity" -o "$dst" "$src"
		;;
	*)
		cp "$src" "$dst"
		;;
	esac
}

decrypt "$dump" "$work/dump.sql"
decrypt "$manifest" "$work/manifest.json"

actual_sha=$(sha256 "$work/dump.sql")
expected_sha=$(jq -r '.dump_sha256 // empty' "$work/manifest.json")
if [ -n "$expected_sha" ] && [ "$actual_sha" != "$expected_sha" ]; then
	echo "FAIL dump sha256 mismatch: manifest ${expected_sha}, actual ${actual_sha}" >&2
	exit 1
fi

echo "migration level: $(jq -r '.migration_level // "unknown"' "$work/manifest.json")"
sqlite3 "$db" <"$work/dump.sql"

mismatches=0
while IFS=$'\t' read -r table expected; do
	[ -n "$table" ] || continue
	actual=$(sqlite3 "$db" "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo missing)
	if [ "$actual" = "$expected" ]; then
		printf 'ok   %s %s rows\n' "$table" "$actual"
	else
		printf 'FAIL %s expected %s rows, loaded %s\n' "$table" "$expected" "$actual" >&2
		mismatches=$((mismatches + 1))
	fi
done < <(jq -r '.row_counts | to_entries[] | "\(.key)\t\(.value)"' "$work/manifest.json")

if [ "$mismatches" -gt 0 ]; then
	echo "verification failed: ${mismatches} table(s) do not match the manifest" >&2
	exit 1
fi

echo "verification passed: dump matches the manifest"
