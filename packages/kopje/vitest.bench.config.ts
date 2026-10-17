import { fileURLToPath } from 'node:url'

import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// The migration cost benchmark (test/bench/migration-cost.ts): not part of `test`, run by hand before a migration's
// PR merges and before a release is tagged (`pnpm --filter kopje bench:migration`). KOPJE_BENCH_MIGRATION names the
// file (default: the newest), KOPJE_BENCH_FROM the first of a release's files, KOPJE_BENCH_SCALE scales the store
// (default 1, the measured size). Otherwise as vitest.config.ts.
export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) } })],
	resolve: { alias: { postcss: fileURLToPath(new URL('./stubs/postcss.cjs', import.meta.url)) } },
	test: {
		name: 'kopje-bench',
		include: [fileURLToPath(new URL('./test/bench/migration-cost.ts', import.meta.url))],
		testTimeout: 3_600_000,
		fsModuleCache: false,
		provide: {
			benchMigration: process.env.KOPJE_BENCH_MIGRATION ?? '',
			benchFrom: process.env.KOPJE_BENCH_FROM ?? '',
			benchScale: process.env.KOPJE_BENCH_SCALE ?? '',
		},
	},
})
