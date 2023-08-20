import { errorHandling } from 'wildebeest/backend/src/middleware/error'
import { logger } from 'wildebeest/backend/src/middleware/logger'

export const onRequest = [logger, errorHandling]
