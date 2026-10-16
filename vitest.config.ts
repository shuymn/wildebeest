import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: [
			'packages/backend/vitest.config.ts',
			'packages/consumer/vitest.config.mts',
			'packages/kopje/vitest.config.ts',
			'packages/kopje/vitest.streaming.config.ts',
			'packages/kopje/vitest.node.config.ts',
		],
		coverage: {
			provider: 'istanbul',
			reporter: ['lcovonly'],
			include: ['packages/backend/src/**/*.ts', 'packages/consumer/src/**/*.ts'],
		},
	},
})
