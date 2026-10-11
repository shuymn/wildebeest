import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { classifyRequest, decide, type RequestClass } from './gate'
import { checkHealth } from './health'
import { INBOX_ROUTES, inboxHandler } from '../federation/inbox'
import { FEDERATION_PATHS, requireSetup } from '../federation/setup-gate'
import { spoolInbox } from '../federation/spool'
import { maintenanceError, mastodonError } from '../mastodon/errors'
import { readConfig } from '../platform/config'
import { defaultStore, type StoreResolver } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'

export type AppDeps = {
	// The build identity sent on every Store RPC (the Workers version id in production; tests inject one).
	build: (env: Env) => string
	now: () => number
	store?: StoreResolver
}

type AppEnv = { Bindings: Env; Variables: { requestClass: RequestClass } }

export function createApp({ build, now, store = defaultStore }: AppDeps) {
	const app = new Hono<AppEnv>()

	// Maintenance gate, max(env, Store). The env mode (MAINTENANCE) is applied here. The Store applies its own readonly
	// state to each RPC by operation kind, and a refusal arrives as StoreUnavailableError in onError: inbox requests
	// are spooled, everything else gets 503.
	app.use(async (c, next) => {
		const requestClass = classifyRequest(c.req.method, c.req.path)
		c.set('requestClass', requestClass)
		const config = readConfig(c.env)
		if (!config.ok) {
			if (c.req.path === '/health') {
				return next()
			}
			console.error({ event: 'kopje.config.invalid', issues: config.issues })
			return mastodonError(503, 'This server is misconfigured')
		}
		const decision = decide(requestClass, config.config.MAINTENANCE)
		if (decision === 'unavailable') {
			return maintenanceError()
		}
		if (decision === 'spool') {
			return spoolInbox(c.req.raw, await c.req.arrayBuffer(), c.env.QUEUE, now())
		}
		await next()
	})

	app.get('/health', async (c) => {
		const report = await checkHealth(build(c.env), readConfig(c.env), () => store(c.env))
		return c.json(report, report.ok ? 200 : 503)
	})

	const setupGate = requireSetup(build, store)
	for (const path of FEDERATION_PATHS) {
		app.use(path, setupGate)
	}

	const inbox = inboxHandler(build, store, now)
	for (const path of INBOX_ROUTES) {
		app.post(path, inbox)
	}

	app.notFound((c) => {
		if (c.req.path.startsWith('/api/')) {
			return mastodonError(404, 'Record not found')
		}
		return c.text('Not Found', 404)
	})

	app.onError(async (error, c) => {
		if (error instanceof StoreUnavailableError) {
			if (c.get('requestClass') === 'inbox') {
				return spoolInbox(c.req.raw, await c.req.arrayBuffer(), c.env.QUEUE, now())
			}
			return maintenanceError()
		}
		if (error instanceof HTTPException) {
			return mastodonError(error.status, error.message || 'Error')
		}
		console.error({ event: 'kopje.error', path: c.req.path, error: error.message })
		return mastodonError(500, 'Internal Server Error')
	})

	return app
}
