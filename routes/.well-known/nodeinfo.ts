import { Hono } from 'hono'
import { cache } from 'hono/cache'
import { corsMiddleware } from 'wildebeest/backend/src/middleware'
import { HonoEnv } from 'wildebeest/backend/src/types'

export const app = new Hono<HonoEnv>()

app.options(corsMiddleware(), (c) => c.json({}))
app.get(corsMiddleware(), cache({ cacheName: 'wildebeest', cacheControl: 'max-age=259200, public' }), (c) => {
	const domain = new URL(c.req.raw.url).hostname

	return c.json({
		links: [
			{
				rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
				href: `https://${domain}/nodeinfo/2.0`,
			},
			{
				rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
				href: `https://${domain}/nodeinfo/2.1`,
			},
		],
	})
})
