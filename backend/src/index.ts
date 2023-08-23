import { Hono } from 'hono'
import { logger } from 'hono/logger'

import { errorMiddleware } from 'wildebeest/backend/src/middleware'
import { HonoEnv } from 'wildebeest/backend/src/types'
import { createApp } from 'wildebeest/backend/src/utils'

const base = new Hono<HonoEnv>()

base.use('*', logger())
base.use('*', errorMiddleware())

const app = createApp({ app: base })

if (import.meta.env.DEV) {
	app.showRoutes()
}

export default app
