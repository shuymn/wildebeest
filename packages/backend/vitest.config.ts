import path from 'node:path'

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		tsconfigPaths(),
		cloudflareTest(async () => {
			// Read all migrations in the `migrations` directory.
			const migrationsPath = path.join(__dirname, '../../migrations')
			const migrations = await readD1Migrations(migrationsPath)

			return {
				wrangler: { configPath: path.join(__dirname, '../../wrangler.toml') },
				miniflare: {
					// Add test-only bindings for migrations and shared test configuration.
					bindings: { DOMAIN: 'cloudflare.com', TEST_MIGRATIONS: migrations, userKEK: 'test_kek_follow_requests' },
				},
			}
		}),
	],
	test: {
		coverage: {
			provider: 'istanbul',
		},
		globals: true,
		testTimeout: 30 * 1000,
		include: ['./src/**/*.test.ts'],
		includeSource: ['./src/**/*.ts'],
		setupFiles: ['./src/test/apply-migrations.ts'],
	},
})
