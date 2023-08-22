import { logger } from 'hono/logger'

import { errorMiddleware } from 'wildebeest/backend/src/middleware'
import { createApp } from 'wildebeest/backend/src/utils'

const app = createApp()

app.use('*', logger())
app.use('*', errorMiddleware())

app.showRoutes()

export default app
