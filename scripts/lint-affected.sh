#!/usr/bin/env bash
# Runs kopje's lint when the staged change can affect its code, as scripts/test-affected.sh decides the suites (a path
# outside the package directories, or nothing staged, runs it). ESLint reads no Markdown, so a change that is all
# Markdown runs none.
set -euo pipefail

result=$(git diff --cached --no-renames --name-only | bash scripts/test-affected.sh suites)
if ! grep -qx 'kopje_code=true' <<< "$result"; then
	echo 'lint-affected: none' >&2
	exit 0
fi
echo 'lint-affected: lint:kopje' >&2
exec pnpm run lint:kopje
