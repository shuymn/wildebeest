import { MiddlewareHandler } from 'hono'

import type { HonoEnv } from '@wildebeest/backend/types'
import { initSentry } from '@wildebeest/backend/utils/sentry'

import { internalServerError } from '../errors'

/**
 * A Pages middleware function that logs errors to the console and responds with 500 errors and stack-traces.
 */
export const errorMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		const sentry = initSentry(c.req.raw, c.env, c.executionCtx)

		try {
			return await next()
		} catch (err) {
			if (sentry !== null) {
				sentry.captureException(err)
			}
			if (err instanceof Error) {
				console.error(err.stack, err.cause)
			}
			return internalServerError()
		}
	}
}
