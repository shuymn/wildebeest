// https://docs.joinmastodon.org/methods/accounts/#lists

import { Hono } from 'hono'

import { corsMiddleware } from 'wildebeest/backend/src/middleware'
import { HonoEnv } from 'wildebeest/backend/src/types'

const app = new Hono<HonoEnv>()

// TODO: implement
app.get<'/:id/lists'>(corsMiddleware(), (c) => c.json([]))

export default app
