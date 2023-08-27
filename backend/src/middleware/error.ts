import { MiddlewareHandler } from 'hono'

import type { HonoEnv } from 'wildebeest/backend/src/types'
import { initSentry } from 'wildebeest/backend/src/utils/sentry'

import { internalServerError } from '../errors'

class MockContext implements ExecutionContext {
	passThroughOnException(): void {
		throw new Error('Method not implemented.')
	}
	async waitUntil(promise: Promise<unknown>): Promise<void> {
		await promise
	}
}

/**
 * A Pages middleware function that logs errors to the console and responds with 500 errors and stack-traces.
 */
export const errorMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		let hasExecutionContext = true
		try {
			c.executionCtx
		} catch {
			hasExecutionContext = false
		}

		const sentry = initSentry(c.req.raw, c.env, hasExecutionContext ? c.executionCtx : new MockContext())

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
