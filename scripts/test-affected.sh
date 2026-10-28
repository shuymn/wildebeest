#!/usr/bin/env bash
# Runs the vitest suites a change can affect: Kopje's code suites (workerd and streaming), its Node suite, or none.
#
#   scripts/test-affected.sh suites < paths   prints kopje= and kopje_code=<bool> for the changed paths
#   scripts/test-affected.sh [vitest args]     runs the affected suites
#
# The second form takes KOPJE and KOPJE_CODE from the environment when CI has already decided, and otherwise
# compares the working tree with its merge base on origin/main. Paths outside the package (the lockfile, root config,
# workflows) affect every suite, and so does an empty list. The Kopje instance template (deploy/) counts as Kopje.
# Callers list paths with --no-renames, so a move names both its source and its destination.
#
# Markdown counts as what reads it. Kopje's is read only by its Node suite (test-node/), so a Kopje change that is
# all Markdown sets kopje_code=false and runs only that suite, except the OAuth scope table that test/vectors.test.ts
# imports. Markdown outside the package affects no suite.
#
# Without vitest args and on a clean working tree, the second form records the tree it passed in the Git
# directory, and with TEST_AFFECTED_SKIP_PASSED=1 (the pre-push hook) it skips a tree that already passed the
# suites it needs. The whole output is kept in test-affected.log in the Git directory, which a failure names.
set -euo pipefail

suites() {
	local kopje=false kopje_code=false seen=false path
	while IFS= read -r path || [ -n "$path" ]; do
		[ -n "$path" ] || continue
		seen=true
		case $path in
			packages/kopje/docs/mastodon-api-spec/client-api/auth-oauth.md) kopje=true kopje_code=true ;;
			packages/kopje/*.md | deploy/*.md) kopje=true ;;
			*.md) ;;
			*) kopje=true kopje_code=true ;;
		esac
	done
	if [ "$seen" = false ]; then
		kopje=true kopje_code=true
	fi
	printf 'kopje=%s\nkopje_code=%s\n' "$kopje" "$kopje_code"
}

if [ "${1:-}" = suites ]; then
	suites
	exit 0
fi

if [ -z "${KOPJE:-}" ]; then
	if base=$(git merge-base origin/main HEAD 2>/dev/null); then
		result=$(git diff --no-renames --name-only "$base" | suites)
	else
		result=$(suites < /dev/null)
	fi
	KOPJE=$(sed -n 's/^kopje=//p' <<< "$result")
	KOPJE_CODE=$(sed -n 's/^kopje_code=//p' <<< "$result")
fi
# A caller that decides only KOPJE (the release workflow) runs all of Kopje's suites.
KOPJE_CODE=${KOPJE_CODE:-$KOPJE}

projects=()
if [ "$KOPJE" = true ]; then
	if [ "$KOPJE_CODE" = true ]; then
		projects+=(--project kopje --project kopje-streaming)
	fi
	projects+=(--project kopje-cli)
fi
echo "test-affected: kopje=$KOPJE kopje_code=$KOPJE_CODE" >&2
if [ ${#projects[@]} -eq 0 ]; then
	echo 'test-affected: no suite reads the changed paths' >&2
	exit 0
fi

clean() {
	[ -z "$(git status --porcelain --untracked-files=all)" ]
}

# The tree under test, when the working tree is clean and each suite runs whole.
tree=
if [ $# -eq 0 ] && clean; then
	tree=$(git rev-parse 'HEAD^{tree}')
fi
stamp=$(git rev-parse --git-path test-affected-passed)
log=$(git rev-parse --git-path test-affected.log)

# A recorded pass covers this run when it was of the same tree and ran every suite this run needs.
if [ "${TEST_AFFECTED_SKIP_PASSED:-}" = 1 ] && [ -n "$tree" ] && [ -f "$stamp" ]; then
	read -r passed_tree passed_kopje passed_kopje_code < "$stamp" || true
	if [ "${passed_tree:-}" = "$tree" ] &&
		{ [ "$KOPJE" = false ] || [ "${passed_kopje:-}" = true ]; } &&
		{ [ "$KOPJE_CODE" = false ] || [ "${passed_kopje_code:-}" = true ]; }; then
		echo "test-affected: tree $tree already passed these suites" >&2
		exit 0
	fi
fi

rm -f "$stamp"
set +e
pnpm run test "${projects[@]}" "$@" 2>&1 | tee "$log"
statuses=("${PIPESTATUS[@]}")
set -e
tested=${statuses[0]} logged=${statuses[1]}
[ "$logged" -eq 0 ] || echo "test-affected: writing $log failed" >&2
if [ "$tested" -ne 0 ]; then
	[ "$logged" -ne 0 ] || echo "test-affected: failed; the whole output is in $log" >&2
	exit "$tested"
fi
[ "$logged" -eq 0 ] || exit "$logged"
# The tree must not have changed while the suites ran.
if [ -n "$tree" ] && [ "$(git rev-parse 'HEAD^{tree}')" = "$tree" ] && clean; then
	printf '%s %s %s\n' "$tree" "$KOPJE" "$KOPJE_CODE" > "$stamp"
fi
