import { cloudflarePagesAdapter } from '@builder.io/qwik-city/adapters/cloudflare-pages/vite'
import { extendConfig } from '@builder.io/qwik-city/vite'
import baseConfig from '../../vite.config'

export default extendConfig(baseConfig, () => {
	return {
		build: {
			sourcemap: process.env.NODE_ENV === 'dev',
			ssr: true,
			rollupOptions: {
				input: ['src/entry.cloudflare-pages.tsx', '@qwik-city-plan'],
			},
		},
		plugins: [cloudflarePagesAdapter()],
	}
})
