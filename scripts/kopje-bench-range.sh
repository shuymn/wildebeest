#!/usr/bin/env bash
# Times Kopje's release-range upgrade on the benchmark store (packages/kopje/test/bench/migration-cost.ts).
#
#   scripts/kopje-bench-range.sh <head checkout> [<base checkout>]
#
# The range starts at the first migration the newest release does not carry: the highest kopje-v* tag on main's
# history (origin/main) that is also in the head's, so a tag pushed to a branch never shortens it. Each checkout runs
# its range RUNS times (default 3), alternating head and base, so a slow machine shows in both. A run's own budget
# check is off (KOPJE_BENCH_REPORT_ONLY); the head's median must be within the budget, and any other failure of a run
# fails the script. Writes a Markdown table to GITHUB_STEP_SUMMARY when it is set.
set -euo pipefail

head=$1
base=${2:-}
runs=${RUNS:-3}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
logs=$(mktemp -d)

migrations() {
	git -C "$1" ls-tree --name-only "$2" packages/kopje/migrations/ \
		| sed -n 's#^packages/kopje/migrations/\([0-9]\{4\}_[a-z0-9_]*\)\.sql$#\1#p'
}

tag=''
while IFS= read -r candidate; do
	if git -C "$head" merge-base --is-ancestor "$candidate" HEAD; then
		tag=$candidate
		break
	fi
done < <(git -C "$head" tag --list 'kopje-v*' --merged origin/main --sort=-v:refname)
if [ -z "$tag" ]; then
	echo "::error::no kopje-v* tag on main's history is in the head's"
	exit 1
fi
from=$(comm -13 <(migrations "$head" "$tag" | sort) <(migrations "$head" HEAD | sort) | head -n 1)
if [ -z "$from" ]; then
	echo "every migration is in $tag: nothing to measure" | tee -a "$summary"
	exit 0
fi

range() { migrations "$1" HEAD | sort | awk -v from="$from" '$0 >= from' | paste -sd ' ' -; }
echo "head range: $(range "$head")"
if [ -n "$base" ]; then
	if migrations "$base" HEAD | grep -qx "$from"; then
		echo "base range: $(range "$base")"
	else
		echo "base has no $from: measuring the head only"
		base=''
	fi
fi

# One run: prints "<ms> <budget ms>". Fails, showing the run's output, when the run fails or reports no time.
measure() {
	local log=$logs/$2.log line
	if ! (cd "$1" && KOPJE_BENCH_SCALE=1 KOPJE_BENCH_MIGRATION='' KOPJE_BENCH_FROM="$from" KOPJE_BENCH_REPORT_ONLY=1 \
		pnpm --filter kopje bench:migration) >"$log" 2>&1; then
		echo "::error::$2 failed" >&2
		cat "$log" >&2
		return 1
	fi
	line=$(grep -o '"ms":[0-9]*,"budgetMs":[0-9]*' "$log" | tail -n 1 || true)
	if [ -z "$line" ]; then
		echo "::error::$2 reported no time" >&2
		cat "$log" >&2
		return 1
	fi
	line=${line#\"ms\":}
	echo "${line%%,*} ${line##*:}"
}

median() {
	sort -n | awk '{ v[NR] = $1 } END { print (NR % 2) ? v[(NR + 1) / 2] : int((v[NR / 2] + v[NR / 2 + 1]) / 2) }'
}

head_ms=() base_ms=() budget=''
for i in $(seq "$runs"); do
	out=$(measure "$head" "head-$i")
	read -r ms budget <<<"$out"
	head_ms+=("$ms")
	echo "head run $i: $ms ms"
	if [ -n "$base" ]; then
		out=$(measure "$base" "base-$i")
		read -r ms _ <<<"$out"
		base_ms+=("$ms")
		echo "base run $i: $ms ms"
	fi
done

cpus=$(nproc 2>/dev/null || sysctl -n hw.ncpu)
model=''
if [ -r /proc/cpuinfo ]; then model=$(sed -n 's/^model name[[:space:]]*: //p' /proc/cpuinfo | head -n 1); fi
head_median=$(printf '%s\n' "${head_ms[@]}" | median)
{
	echo "### Kopje release-range upgrade"
	echo
	echo "From \`$from\` (the first migration after \`$tag\`), budget $budget ms, $runs runs each," \
		"on $cpus CPUs${model:+ ($model)}."
	echo
	echo "| Checkout | Migrations | Runs (ms) | Median (ms) |"
	echo "|---|---|---|---|"
	echo "| head | $(range "$head") | ${head_ms[*]} | $head_median |"
	if [ ${#base_ms[@]} -gt 0 ]; then
		echo "| base | $(range "$base") | ${base_ms[*]} | $(printf '%s\n' "${base_ms[@]}" | median) |"
	fi
} | tee -a "$summary"

if [ "$head_median" -gt "$budget" ]; then
	echo "::error::the release-range upgrade's median ${head_median} ms is past the ${budget} ms budget"
	exit 1
fi
