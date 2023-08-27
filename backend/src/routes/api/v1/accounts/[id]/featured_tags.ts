// https://docs.joinmastodon.org/methods/accounts/#featured_tags

import { Hono } from 'hono'

import { corsMiddleware } from 'wildebeest/backend/src/middleware'
import { HonoEnv } from 'wildebeest/backend/src/types'

const app = new Hono<HonoEnv>()

// TODO: implement
app.get<'/:id/featured_tags'>(corsMiddleware(), (c) => c.json([]))

export default app
