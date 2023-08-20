import { Hono } from 'hono'

import { HonoEnv } from 'wildebeest/backend/src/types'

import { app as instances } from './instance'
import { app as media } from './media'
import { app as media_id } from './media/[id]'
import { app as search } from './search'

export const app = new Hono<HonoEnv>()

app.route('/instances', instances)
app.route('/media/:id', media_id)
app.route('/media', media)
app.route('/search', search)
