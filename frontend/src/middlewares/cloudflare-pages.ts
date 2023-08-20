import { createQwikCity } from '@builder.io/qwik-city/middleware/cloudflare-pages'
import { type ServerRenderOptions } from '@builder.io/qwik-city/middleware/request-handler'
import type { Handler } from 'hono'
import { HonoEnv } from 'wildebeest/backend/src/types'

export const qwikHandler = (opts: ServerRenderOptions): Handler<HonoEnv> => {
	const fetch = createQwikCity(opts)
	return (c) => {
		return fetch(c.req.raw, c.env, c.executionCtx)
	}
}
