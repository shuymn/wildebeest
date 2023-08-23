// https://docs.joinmastodon.org/methods/accounts/#familiar_followers

import { Hono } from 'hono'

import { corsMiddleware } from 'wildebeest/backend/src/middleware'
import { HonoEnv } from 'wildebeest/backend/src/types'

const app = new Hono<HonoEnv>()

// TODO: implement
app.get<'/:id/familiar_followers'>(corsMiddleware(), (c) => c.json([]))

export default app
