import { Hono } from 'hono'

import { corsMiddleware } from 'wildebeest/backend/src/middleware'

const app = new Hono()

app.options('*', corsMiddleware(), (c) => c.json({}))

export default app
