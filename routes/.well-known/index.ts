import { Hono } from 'hono'

import { HonoEnv } from 'wildebeest/backend/src/types'

import { app as nodeinfo } from './nodeinfo'
import { app as webfinger } from './webfinger'

export const app = new Hono<HonoEnv>()

app.route('/nodeinfo', nodeinfo)
app.route('/webfinger', webfinger)
