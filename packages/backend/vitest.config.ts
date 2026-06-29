import path from 'node:path'

import { defineWorkersProject, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineWorkersProject(async () => {
	// Read all migrations in the `migrations` directory
	const migrationsPath = path.join(__dirname, '../../migrations')
	const migrations = await readD1Migrations(migrationsPath)

	return {
		plugins: [tsconfigPaths()],
		test: {
			globals: true,
			testTimeout: 30 * 1000,
			include: ['./src/**/*.test.ts'],
			includeSource: ['./src/**/*.ts'],
			setupFiles: ['./src/test/apply-migrations.ts'],
			poolOptions: {
				workers: {
					singleWorker: true,
					wrangler: { configPath: path.join(__dirname, '../../wrangler.toml') },
					miniflare: {
						// Add test-only bindings for migrations and shared test configuration.
						bindings: { DOMAIN: 'cloudflare.com', TEST_MIGRATIONS: migrations, userKEK: 'test_kek_follow_requests' },
					},
				},
			},
		},
	}
})
