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
	test: {
		name: 'kopje',
		include: [fileURLToPath(new URL('./test/**/*.test.ts', import.meta.url))],
	},
})
