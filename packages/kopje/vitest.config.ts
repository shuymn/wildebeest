import { fileURLToPath } from 'node:url'

import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

import { sqlDepthService } from './test-node/sql-depth'
import { webPageFixtures } from './test-node/web-page-fixtures'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) },
			// The suites run on wrangler.jsonc's production compatibility date: workerd accepts any date up to today.
			// The app registration limit (5 per minute per IP in wrangler.jsonc) would throttle the suites, which register
			// apps from one address; test/apps-budget.test.ts injects a limiter of its own. The same for sign-ins.
			miniflare: {
				ratelimits: {
					APP_REGISTRATION_LIMIT: { namespace_id: '4201', simple: { limit: 1_000_000, period: 60 } },
					LOGIN_LIMIT: { namespace_id: '4202', simple: { limit: 1_000_000, period: 60 } },
				},
				// Measures the expression depth of the statements a suite ran, on Node (test/sql-depth-setup.ts).
				// Compressed web pages with exact bytes, fetched through workerd (test-node/web-page-fixtures.ts).
				serviceBindings: { SQL_DEPTH: sqlDepthService, WEB_PAGE_FIXTURES: { node: webPageFixtures } },
			},
		}),
	],
	// As wrangler.jsonc's alias: sanitize-html never reaches postcss (stubs/postcss.cjs).
	resolve: { alias: { postcss: fileURLToPath(new URL('./stubs/postcss.cjs', import.meta.url)) } },
	test: {
		name: 'kopje',
		// Converts a synthetic legacy export on Node for test/cutover-import.test.ts (node:sqlite is not in workerd).
		globalSetup: [fileURLToPath(new URL('./test-node/cutover-global-setup.ts', import.meta.url))],
		include: [fileURLToPath(new URL('./test/**/*.test.ts', import.meta.url))],
		// The streaming suites run in a project of their own, without isolation (vitest.streaming.config.ts).
		exclude: [fileURLToPath(new URL('./test/streaming/**', import.meta.url))],
		setupFiles: [fileURLToPath(new URL('./test/sql-depth-setup.ts', import.meta.url))],
		// The suites drive the real Store through workerd; on a loaded CI runner a heavy test can pass 5 s.
		testTimeout: 20_000,
		// Vitest 5.0.4 caches transformed modules on disk by default; workerd cannot read that cache back, so every file
		// failed to load. The Node suite (vitest.node.config.ts) keeps it.
		fsModuleCache: false,
		// FC_SEED replays a property test's run (test/policy-world.ts).
		provide: { fcSeed: process.env.FC_SEED ?? '' },
	},
})
