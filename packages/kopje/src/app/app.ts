import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { classifyRequest, decide, type RequestClass } from './gate'
import { publicHealth } from './health'
import { INBOX_ROUTES, inboxHandler } from '../federation/inbox'
import { FEDERATION_GET_ROUTES, federationHandler, type FederationRouteDeps } from '../federation/routes'
import { FEDERATION_PATHS, requireSetup } from '../federation/setup-gate'
import { rescueFromSnapshot } from '../federation/snapshot'
import { INBOX_BODY_LIMIT, spoolInbox } from '../federation/spool'
import { maintenanceError, mastodonError } from '../mastodon/errors'
import { readBoundedBody } from '../platform/body'
import { readConfig } from '../platform/config'
import { defaultStore, type StoreResolver } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'
import { generateRsaKeyPair } from '../security/key-wrap'

export type AppDeps = {
	// The build identity sent on every Store RPC (the Workers version id in production; tests inject one).
	build: (env: Env) => string
	now: () => number
	store?: StoreResolver
	// Remote fetches and key generation of the federation layer (tests inject both).
	federation?: Partial<Pick<FederationRouteDeps, 'keygen' | 'loader'>>
}

type AppEnv = { Bindings: Env; Variables: { requestClass: RequestClass; inboxBody: Uint8Array; domain: string } }

export function createApp({ build, now, store = defaultStore, federation = {} }: AppDeps) {
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
		if (requestClass === 'inbox') {
			// Read once, bounded, before anything else: both the handler and a later spool use these bytes.
			const body = await readBoundedBody(c.req.raw, INBOX_BODY_LIMIT)
			if (body === 'too-large') {
				return new Response(null, { status: 413 })
			}
			c.set('inboxBody', body)
			if (decision === 'spool') {
				return spoolInbox(c.req.raw, body, c.env.QUEUE, now())
			}
		}
		await next()
	})

	app.get('/health', (c) => publicHealth(build(c.env), readConfig(c.env), () => store(c.env)))

	const setupGate = requireSetup(build, store)
	for (const path of FEDERATION_PATHS) {
		app.use(path, setupGate)
	}

	const inbox = inboxHandler({ build, store }, now)
	for (const path of INBOX_ROUTES) {
		app.post(path, inbox)
	}

	const federationGet = federationHandler({
		build,
		now,
		store,
		keygen: federation.keygen ?? generateRsaKeyPair,
		loader: federation.loader ?? { fetch: (input, init) => fetch(input, init) },
	})
	for (const path of FEDERATION_GET_ROUTES) {
		app.get(path, federationGet)
	}

	app.notFound((c) => {
		if (c.req.path.startsWith('/api/')) {
			return mastodonError(404, 'Record not found')
		}
		return c.text('Not Found', 404)
	})

	app.onError(async (error, c) => {
		if (error instanceof StoreUnavailableError) {
			const body = c.get('requestClass') === 'inbox' ? c.get('inboxBody') : undefined
			if (body !== undefined) {
				return spoolInbox(c.req.raw, body, c.env.QUEUE, now())
			}
			// Actor documents, WebFinger and NodeInfo stay up from the last good snapshot.
			if (c.get('requestClass') === 'always') {
				const rescued = await rescueFromSnapshot(c.req.raw, store(c.env), build(c.env))
				if (rescued !== null) {
					return rescued
				}
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
