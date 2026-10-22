import { fileURLToPath } from 'node:url'

import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Benchmark configuration. The migration benchmark's usage, workload and environment variables:
// test/bench/migration-cost.ts.
// CI acceptance policy: RELEASING.md.
export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) } })],
	resolve: { alias: { postcss: fileURLToPath(new URL('./stubs/postcss.cjs', import.meta.url)) } },
	test: {
		name: 'kopje-bench',
		include: [
			fileURLToPath(new URL('./test/bench/migration-cost.ts', import.meta.url)),
			// The web-page scan benchmark; run it alone by naming its file (test/bench/web-page-scan.bench.ts).
			fileURLToPath(new URL('./test/bench/web-page-scan.bench.ts', import.meta.url)),
		],
		testTimeout: 3_600_000,
		fsModuleCache: false,
		provide: {
			benchMigration: process.env.KOPJE_BENCH_MIGRATION ?? '',
			benchFrom: process.env.KOPJE_BENCH_FROM ?? '',
			benchScale: process.env.KOPJE_BENCH_SCALE ?? '',
			benchReportOnly: Boolean(process.env.KOPJE_BENCH_REPORT_ONLY),
		},
	},
})
