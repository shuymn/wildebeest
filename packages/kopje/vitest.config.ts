import { fileURLToPath } from 'node:url'

import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { supportedCompatibilityDate } from 'miniflare'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) },
			// wrangler.jsonc pins the production date, which can be newer than the local runtime supports.
			miniflare: { compatibilityDate: supportedCompatibilityDate },
		}),
	],
	// As wrangler.jsonc's alias: sanitize-html never reaches postcss (stubs/postcss.cjs).
	resolve: { alias: { postcss: fileURLToPath(new URL('./stubs/postcss.cjs', import.meta.url)) } },
	test: {
		name: 'kopje',
		include: [fileURLToPath(new URL('./test/**/*.test.ts', import.meta.url))],
	},
})
