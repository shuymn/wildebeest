import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { qwikVite } from '@builder.io/qwik/optimizer'
import { qwikCity } from '@builder.io/qwik-city/vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const commitHash = process.env['COMMIT_HASH']?.slice(0, 7)

export default defineConfig(() => {
	return {
		define: {
			COMMIT_INFO: JSON.stringify({ hash: commitHash }),
			'import.meta.vitest': false,
		},
		plugins: [
			qwikCity({
				trailingSlash: false,
			}),
			qwikVite(),
			tsconfigPaths(),
		],
		build: {
			sourcemap: process.env.NODE_ENV === 'dev',
			rollupOptions: {
				external: [
					fileURLToPath(new URL('../backend/test/utils.ts', import.meta.url)),
					fileURLToPath(new URL('../backend/test/test-data.ts', import.meta.url)),
				],
			},
		},
		preview: {
			headers: {
				'Cache-Control': 'public, max-age=600',
			},
		},
	}
})
