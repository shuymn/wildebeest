import { Next } from 'hono'

import type { Env } from 'wildebeest/backend/src/types'
import { initSentry } from 'wildebeest/backend/src/utils/sentry'

import { internalServerError } from '../errors'

/**
 * A Pages middleware function that logs errors to the console and responds with 500 errors and stack-traces.
 */
export async function errorHandling(request: Request, env: Env, context: ExecutionContext, next: Next) {
	const sentry = initSentry(request, env, context)

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
