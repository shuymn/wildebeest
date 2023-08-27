import { Hono } from 'hono'
import { cache } from 'hono/cache'

import { corsMiddleware } from 'wildebeest/backend/src/middleware'
import { WILDEBEEST_VERSION } from 'wildebeest/config/versions'

const app = new Hono()

app.options(corsMiddleware(), (c) => c.json({}))
app.get(corsMiddleware(), cache({ cacheName: 'wildebeest', cacheControl: 'max-age=259200, public' }), (c) =>
	c.json({
		version: '2.1',
		software: {
			name: 'wildebeest',
			version: WILDEBEEST_VERSION,
			repository: 'https://github.com/cloudflare/wildebeest',
		},
		protocols: ['activitypub'],
		services: { outbound: [], inbound: [] },
		usage: { users: {} },
		openRegistrations: false,
		metadata: {},
	})
)

export default app
