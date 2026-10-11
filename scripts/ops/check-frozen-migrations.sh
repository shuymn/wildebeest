#!/usr/bin/env bash
# The legacy migration line is frozen at 0039: 0040 and above belong to the next
# release line and must never ship through this deploy workflow.
#
# Usage: scripts/ops/check-frozen-migrations.sh [migrations-dir]

set -euo pipefail

dir=${1:-migrations}
max=39

offenders=()
for path in "$dir"/*.sql; do
	[ -e "$path" ] || continue
	file=$(basename "$path")
	number=${file%%_*}
	case $number in
	[0-9][0-9][0-9][0-9]) ;;
	*)
		echo "migration ${file} does not start with a 4-digit number" >&2
		exit 1
		;;
	esac
	if [ "$((10#$number))" -gt "$max" ]; then
		offenders+=("$file")
	fi
done

if [ ${#offenders[@]} -gt 0 ]; then
	echo "the legacy migration line is frozen at $(printf '%04d' "$max"); refusing to deploy:" >&2
	printf '  %s\n' "${offenders[@]}" >&2
	exit 1
fi

echo "migrations are within the frozen legacy line (<= $(printf '%04d' "$max"))"
