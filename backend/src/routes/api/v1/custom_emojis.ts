import { Hono } from 'hono'

import { HonoEnv } from 'wildebeest/backend/src/types'
import { cors } from 'wildebeest/backend/src/utils'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
	'cache-control': 'max-age=300, public',
}

const app = new Hono<HonoEnv>()

// TODO: implement
app.get((c) => c.json([], 200, headers))

export default app
