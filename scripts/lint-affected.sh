#!/usr/bin/env bash
# Runs the lints the staged change can affect: kopje's, the legacy packages', or both, as scripts/test-affected.sh
# decides the suites (a path outside the package directories, or nothing staged, runs them all). ESLint reads no
# Markdown, so a change that is all Markdown runs none.
set -euo pipefail

result=$(git diff --cached --no-renames --name-only | bash scripts/test-affected.sh suites)
lints=()
if grep -qx 'kopje_code=true' <<< "$result"; then
	lints+=(lint:kopje)
fi
if grep -qx 'legacy=true' <<< "$result"; then
	lints+=(lint:backend lint:consumer lint:do lint:frontend)
fi
if [ ${#lints[@]} -eq 0 ]; then
	echo 'lint-affected: none' >&2
	exit 0
fi
echo "lint-affected: ${lints[*]}" >&2
exec pnpm exec run-p --print-label "${lints[@]}"
