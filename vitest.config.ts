import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: ['packages/backend/vitest.config.ts', 'packages/consumer/vitest.config.mts'],
		coverage: {
			provider: 'istanbul',
			reporter: ['lcovonly'],
			include: ['packages/backend/src/**/*.ts', 'packages/consumer/src/**/*.ts'],
		},
	},
})
