#!/usr/bin/env bash
# Print a non-secret fingerprint of a VAPID JWK: the sha256 of the public key
# parts (x and y) only. The private part (d) is never read, hashed or printed.
#
# Usage: scripts/ops/vapid-fingerprint.sh <label> <path-to-vapid_jwk>

set -euo pipefail

label=${1:?usage: vapid-fingerprint.sh <label> <jwk-file>}
file=${2:?usage: vapid-fingerprint.sh <label> <jwk-file>}

if [ ! -s "$file" ]; then
	echo "VAPID fingerprint (${label}): <none>"
	exit 0
fi

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum
	else
		shasum -a 256
	fi
}

hash_part() {
	local part=$1 value
	value=$(jq -r --arg p "$part" '.[$p] // empty' "$file")
	if [ -z "$value" ]; then
		echo "<missing>"
		return
	fi
	printf '%s' "$value" | sha256 | cut -d' ' -f1
}

echo "VAPID fingerprint (${label}): x=$(hash_part x) y=$(hash_part y)"
