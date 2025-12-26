import { Hono } from 'hono'
import { cache } from 'hono/cache'

import { WILDEBEEST_VERSION } from '@wildebeest/backend/config/versions'
import { corsMiddleware } from '@wildebeest/backend/middleware'

const app = new Hono()

app.options(corsMiddleware(), (c) => c.json({}))
app.get(
	corsMiddleware(),
	(c, next) => {
		if (import.meta.env.PROD) {
			return cache({ cacheName: 'wildebeest', cacheControl: 'max-age=259200, public' })(c, next)
		}
		return next()
	},
	(c) =>
		c.json({
			version: '2.0',
			software: { name: 'wildebeest', version: WILDEBEEST_VERSION },
			protocols: ['activitypub'],
			services: { outbound: [], inbound: [] },
			usage: { users: {} },
			openRegistrations: false,
			metadata: {},
		})
)

export default app
