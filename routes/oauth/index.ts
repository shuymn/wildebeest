import { Hono } from 'hono'

import { HonoEnv } from 'wildebeest/backend/src/types'

import { app as authorize } from './authorize'
import { app as token } from './token'

export const app = new Hono<HonoEnv>()

app.route('/authorize', authorize)
app.route('/token', token)
