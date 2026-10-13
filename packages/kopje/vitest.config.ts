import { fileURLToPath } from 'node:url'

import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

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
			},
		}),
	],
	// As wrangler.jsonc's alias: sanitize-html never reaches postcss (stubs/postcss.cjs).
	resolve: { alias: { postcss: fileURLToPath(new URL('./stubs/postcss.cjs', import.meta.url)) } },
	test: {
		name: 'kopje',
		include: [fileURLToPath(new URL('./test/**/*.test.ts', import.meta.url))],
		// The suites drive the real Store through workerd; on a loaded CI runner a heavy test can pass 5 s.
		testTimeout: 20_000,
	},
})
