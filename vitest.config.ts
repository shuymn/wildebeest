import path from 'node:path'

import { defineWorkersProject, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineWorkersProject(async () => {
	// Read all migrations in the `migrations` directory
	const migrationsPath = path.join(__dirname, 'migrations')
	const migrations = await readD1Migrations(migrationsPath)

	return {
		plugins: [tsconfigPaths()],
		test: {
			globals: true,
			testTimeout: 30 * 1000,
			include: ['./backend/{src,test}/**/*.test.ts'],
			includeSource: ['./backend/src/**/*.ts'],
			coverage: {
				provider: 'istanbul',
				reporter: ['json'],
			},
			setupFiles: ['./backend/test/apply-migrations.ts'],
			poolOptions: {
				workers: {
					main: 'backend/src/index.ts',
					singleWorker: true,
					wrangler: { configPath: './wrangler.toml' },
					miniflare: {
						// Add a test-only binding for migrations, so we can apply them in a setup file
						bindings: { TEST_MIGRATIONS: migrations },
					},
				},
			},
		},
	}
})
