#!/usr/bin/env bash
# Runs the vitest suites a change can affect: kopje, legacy (backend and consumer), or both.
#
#   scripts/test-affected.sh suites < paths   prints kopje=<bool> and legacy=<bool> for the changed paths
#   scripts/test-affected.sh [vitest args]     runs the affected suites
#
# The second form takes KOPJE and LEGACY from the environment when CI has already decided, and otherwise
# compares the working tree with its merge base on origin/main. Paths outside the package directories (the
# lockfile, root config, migrations, workflows) affect both suites, and so does an empty list.
set -euo pipefail

suites() {
	local kopje=false legacy=false path
	while IFS= read -r path || [ -n "$path" ]; do
		case $path in
			'') ;;
			packages/kopje/*) kopje=true ;;
			packages/backend/* | packages/consumer/* | packages/do/* | packages/frontend/*) legacy=true ;;
			*) kopje=true legacy=true ;;
		esac
	done
	if [ "$kopje" = false ] && [ "$legacy" = false ]; then
		kopje=true legacy=true
	fi
	printf 'kopje=%s\nlegacy=%s\n' "$kopje" "$legacy"
}

if [ "${1:-}" = suites ]; then
	suites
	exit 0
fi

if [ -z "${KOPJE:-}" ] || [ -z "${LEGACY:-}" ]; then
	if base=$(git merge-base origin/main HEAD 2>/dev/null); then
		result=$(git diff --name-only "$base" | suites)
	else
		result=$(suites < /dev/null)
	fi
	KOPJE=$(sed -n 's/^kopje=//p' <<< "$result")
	LEGACY=$(sed -n 's/^legacy=//p' <<< "$result")
fi

projects=()
if [ "$KOPJE" = true ]; then
	projects+=(--project kopje --project kopje-cli)
fi
if [ "$LEGACY" = true ]; then
	projects+=(--project @wildebeest/backend --project consumer)
fi
echo "test-affected: kopje=$KOPJE legacy=$LEGACY" >&2
exec pnpm run test "${projects[@]}" "$@"
