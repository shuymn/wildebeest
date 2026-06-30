import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		projects: ['packages/backend/vitest.config.ts'],
		coverage: {
			provider: 'istanbul',
			reporter: ['lcovonly'],
			include: ['packages/backend/src/**/*.ts'],
		},
	},
})
