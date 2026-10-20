#!/usr/bin/env bash
# Times Kopje's release-range upgrade on the benchmark store (packages/kopje/test/bench/migration-cost.ts).
#
#   scripts/kopje-bench-range.sh <head checkout> [<base checkout>]
#
# The range starts at the first migration the newest release does not carry: the highest kopje-v* tag on main's
# history (origin/main) that is also in the head's, so a tag pushed to a branch never shortens it. Each checkout runs
# its range RUNS times (default 3), alternating head and base, so a slow machine shows in both. A run's own budget
# check is off (KOPJE_BENCH_REPORT_ONLY); the head's median must be within the budget, and any other failure of a run
# fails the script. Each run also reports its foreign-key check ('store' or 'skipped') and a retry estimate
# (retryEstimateMs, which is reported, and warned about past the budget, but not judged: see the bench's header). A
# base that predates those fields counts as 'store' with no estimate ('-'); the head must report them. Writes a
# Markdown table to GITHUB_STEP_SUMMARY when it is set. Fixtures: scripts/kopje-bench-range.test.mjs.
set -euo pipefail

head=$1
base=${2:-}
runs=${RUNS:-3}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT

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

# One run of checkout $1, named $2 (head-N or base-N): prints "<ms> <budget ms> <foreign-key check> <retry estimate
# ms or ->". Fails, showing the run's output, when the run fails or reports no time, or a head run omits a field.
measure() {
	local log=$logs/$2.log line ms budget check retry
	if ! (cd "$1" && KOPJE_BENCH_SCALE=1 KOPJE_BENCH_MIGRATION='' KOPJE_BENCH_FROM="$from" KOPJE_BENCH_REPORT_ONLY=1 \
		pnpm --filter kopje bench:migration) >"$log" 2>&1; then
		echo "::error::$2 failed" >&2
		cat "$log" >&2
		return 1
	fi
	line=$(grep -o '"ms":[0-9]*,"budgetMs":[0-9]*.*' "$log" | tail -n 1 || true)
	if [ -z "$line" ]; then
		echo "::error::$2 reported no time" >&2
		cat "$log" >&2
		return 1
	fi
	ms=$(sed -n 's/^"ms":\([0-9]*\),.*/\1/p' <<<"$line")
	budget=$(sed -n 's/^"ms":[0-9]*,"budgetMs":\([0-9]*\).*/\1/p' <<<"$line")
	check=$(sed -n 's/.*"foreignKeyCheck":"\([a-z]*\)".*/\1/p' <<<"$line")
	retry=$(sed -n 's/.*"retryEstimateMs":\([0-9]*\).*/\1/p' <<<"$line")
	if [ "${2%%-*}" = head ] && { [ -z "$check" ] || [ -z "$retry" ]; }; then
		echo "::error::$2 reported no foreignKeyCheck or retryEstimateMs" >&2
		cat "$log" >&2
		return 1
	fi
	echo "$ms $budget ${check:-store} ${retry:--}"
}

median() {
	sort -n | awk '{ v[NR] = $1 } END { print (NR % 2) ? v[(NR + 1) / 2] : int((v[NR / 2] + v[NR / 2 + 1]) / 2) }'
}

# The median of the arguments, or - when any is -.
median_of() {
	case " $* " in
	*' - '*) echo - ;;
	*) printf '%s\n' "$@" | median ;;
	esac
}

# The distinct foreign-key checks of the arguments.
checks_of() { printf '%s\n' "$@" | sort -u | paste -sd ' ' -; }

head_ms=() head_check=() head_retry=() base_ms=() base_check=() base_retry=() budget=''
for i in $(seq "$runs"); do
	out=$(measure "$head" "head-$i")
	read -r ms budget check retry <<<"$out"
	head_ms+=("$ms") head_check+=("$check") head_retry+=("$retry")
	echo "head run $i: $ms ms, foreign keys $check, retry estimate $retry ms"
	if [ -n "$base" ]; then
		out=$(measure "$base" "base-$i")
		read -r ms _ check retry <<<"$out"
		base_ms+=("$ms") base_check+=("$check") base_retry+=("$retry")
		echo "base run $i: $ms ms, foreign keys $check, retry estimate $retry ms"
	fi
done

cpus=$(nproc 2>/dev/null || sysctl -n hw.ncpu)
model=''
if [ -r /proc/cpuinfo ]; then model=$(sed -n 's/^model name[[:space:]]*: //p' /proc/cpuinfo | head -n 1); fi
head_median=$(median_of "${head_ms[@]}")
head_retry_median=$(median_of "${head_retry[@]}")
{
	echo "### Kopje release-range upgrade"
	echo
	echo "From \`$from\` (the first migration after \`$tag\`), budget $budget ms, $runs runs each," \
		"on $cpus CPUs${model:+ ($model)}."
	echo
	echo "| Checkout | Migrations | Foreign keys | Runs (ms) | Median (ms) | Retry estimate median (ms) |"
	echo "|---|---|---|---|---|---|"
	echo "| head | $(range "$head") | $(checks_of "${head_check[@]}") | ${head_ms[*]} | $head_median | $head_retry_median |"
	if [ ${#base_ms[@]} -gt 0 ]; then
		echo "| base | $(range "$base") | $(checks_of "${base_check[@]}") | ${base_ms[*]} |" \
			"$(median_of "${base_ms[@]}") | $(median_of "${base_retry[@]}") |"
	fi
} | tee -a "$summary"

if [ "$head_retry_median" -gt "$budget" ]; then
	echo "::warning::the head's retry estimate ${head_retry_median} ms is past the ${budget} ms budget"
fi
if [ "$head_median" -gt "$budget" ]; then
	echo "::error::the release-range upgrade's median ${head_median} ms is past the ${budget} ms budget"
	exit 1
fi
