import { Hono } from 'hono'
import { logger } from 'hono/logger'

import { errorHandling } from 'wildebeest/backend/src/middleware/error'
import { HonoEnv } from 'wildebeest/backend/src/types'

import { app as firstLogin } from './first-login'

const app = new Hono<HonoEnv>()

app.use('*', logger())
app.use('*', (c, next) => errorHandling(c.req.raw, c.env, c.executionCtx, next))

app.route('/first-login', firstLogin)

export default app
