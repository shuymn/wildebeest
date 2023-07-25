import type { Env } from 'wildebeest/backend/src/types'
import { initSentry } from 'wildebeest/backend/src/utils/sentry'

import { internalServerError } from '../errors'

/**
 * A Pages middleware function that logs errors to the console and responds with 500 errors and stack-traces.
 */
export async function errorHandling(context: EventContext<Env, string, unknown>) {
	const sentry = initSentry(context.request, context.env, context)

	try {
		return await context.next()
	} catch (err: any) {
		if (sentry !== null) {
			sentry.captureException(err)
		}
		console.error(err.stack, err.cause)
		return internalServerError()
	}
}
