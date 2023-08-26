import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [tsconfigPaths()],
	test: {
		globals: true,
		environment: 'miniflare',
		testTimeout: 30 * 1000,
		include: ['./backend/{src,test}/**/*.test.ts'],
		includeSource: ['./backend/src/**/*.ts'],
	},
})
