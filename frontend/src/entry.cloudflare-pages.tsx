import qwikCityPlan from '@qwik-city-plan'
import { manifest } from '@qwik-client-manifest'
import render from './entry.ssr'
import { qwikHandler, authMiddleware } from './middlewares'
import app from 'wildebeest/routes'
import { PlatformCloudflarePages } from '@builder.io/qwik-city/middleware/cloudflare-pages'
import { HonoEnv } from 'wildebeest/backend/src/types'

declare global {
	type QwikCityPlatform = Omit<PlatformCloudflarePages, 'env'> & {
		env: HonoEnv['Bindings']
	}
}

app.use('*', authMiddleware())
app.get('*', qwikHandler({ render, qwikCityPlan, manifest }))

const fetch = app.fetch

export { fetch }
