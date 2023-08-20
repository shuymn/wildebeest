import { Hono } from 'hono'

import { corsMiddleware } from 'wildebeest/backend/src/middleware'
import { HonoEnv } from 'wildebeest/backend/src/types'

import { app as v2 } from './v2'

export const app = new Hono<HonoEnv>()

app.options('*', corsMiddleware(), (c) => c.json({}))

app.route('/v2', v2)
