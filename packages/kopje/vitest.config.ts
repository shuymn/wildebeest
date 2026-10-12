import { fileURLToPath } from 'node:url'

import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { supportedCompatibilityDate } from 'miniflare'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) },
			// wrangler.jsonc pins the production date, which can be newer than the local runtime supports.
			// The app registration limit (5 per minute per IP in wrangler.jsonc) would throttle the suites, which register
			// apps from one address; test/apps-budget.test.ts injects a limiter of its own. The same for sign-ins.
			miniflare: {
				compatibilityDate: supportedCompatibilityDate,
				ratelimits: {
					APP_REGISTRATION_LIMIT: { simple: { limit: 1_000_000, period: 60 } },
					LOGIN_LIMIT: { simple: { limit: 1_000_000, period: 60 } },
				},
			},
		}),
	],
	// As wrangler.jsonc's alias: sanitize-html never reaches postcss (stubs/postcss.cjs).
	resolve: { alias: { postcss: fileURLToPath(new URL('./stubs/postcss.cjs', import.meta.url)) } },
	test: {
		name: 'kopje',
		include: [fileURLToPath(new URL('./test/**/*.test.ts', import.meta.url))],
	},
})
