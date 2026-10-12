import path from 'node:path'

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		tsconfigPaths({ root: path.join(__dirname, '../..') }),
		cloudflareTest(async () => {
			// Read all migrations in the `migrations` directory.
			const migrationsPath = path.join(__dirname, '../../migrations')
			const migrations = await readD1Migrations(migrationsPath)

			return {
				wrangler: { configPath: path.join(__dirname, '../../wrangler.toml') },
				miniflare: {
					// Add test-only bindings for migrations and shared test configuration.
					bindings: { DOMAIN: 'cloudflare.com', TEST_MIGRATIONS: migrations, userKEK: 'test_kek_consumer' },
				},
			}
		}),
	],
	test: {
		name: 'consumer',
		globals: true,
		// The consumer tests replace globalThis.fetch without restoring it.
		fileParallelism: false,
		testTimeout: 30 * 1000,
		include: ['./test/**/*.test.ts'],
		setupFiles: [path.join(__dirname, '../backend/src/test/apply-migrations.ts')],
	},
})
