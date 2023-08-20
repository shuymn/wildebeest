import { Hono } from 'hono'
import { cache } from 'hono/cache'

import { corsMiddleware } from 'wildebeest/backend/src/middleware'
import { HonoEnv } from 'wildebeest/backend/src/types'
import { WILDEBEEST_VERSION } from 'wildebeest/config/versions'

export const app = new Hono<HonoEnv>()

app.options('/2.0', corsMiddleware(), (c) => c.json({}))
app.get('/2.0', corsMiddleware(), cache({ cacheName: 'wildebeest', cacheControl: 'max-age=259200, public' }), (c) =>
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

app.options('/2.1', corsMiddleware(), (c) => c.json({}))
app.get('/2.1', corsMiddleware(), cache({ cacheName: 'wildebeest', cacheControl: 'max-age=259200, public' }), (c) =>
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
