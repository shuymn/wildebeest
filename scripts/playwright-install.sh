#!/usr/bin/env bash
# Downloads Playwright browsers in CI, from the current directory's Playwright: three tries, each cut off after the
# given seconds (and killed 15 s later). A slow mirror has held a download to the job's limit, where a rerun passed;
# the download leaves no system state behind, so it is simply tried again.
#
#   scripts/playwright-install.sh <seconds per try> [playwright install args...]
set -euo pipefail

seconds=$1
shift
for try in 1 2 3; do
	if timeout --kill-after=15 "$seconds" npx playwright install "$@"; then
		exit 0
	fi
	echo "::warning::playwright install failed or timed out (try ${try})"
done
exit 1
