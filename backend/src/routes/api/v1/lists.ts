import { Hono } from 'hono'

import { HonoEnv } from 'wildebeest/backend/src/types'

const app = new Hono<HonoEnv>()

// TODO: implement
app.get((c) => c.json([]))

export default app
