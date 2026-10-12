import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'

import { authorizeRoutes } from './authorize'
import { classifyRequest, decide, type RequestClass } from './gate'
import { publicHealth } from './health'
import { INBOX_ROUTES, inboxHandler } from '../federation/inbox'
import { FEDERATION_GET_ROUTES, federationHandler, type FederationRouteDeps } from '../federation/routes'
import { FEDERATION_PATHS, requireSetup } from '../federation/setup-gate'
import { rescueFromSnapshot } from '../federation/snapshot'
import { INBOX_BODY_LIMIT, spoolInbox } from '../federation/spool'
import { maintenanceError, mastodonError } from '../mastodon/errors'
import { mastodonApi } from '../mastodon/routes'
import { readBoundedBody } from '../platform/body'
import { readConfig } from '../platform/config'
import { errorFields } from '../platform/error-message'
import { defaultStore, type StoreResolver } from '../platform/store-client'
import { StoreUnavailableError } from '../platform/store-errors'
import { generateRsaKeyPair } from '../security/key-wrap'
import { randomToken, type TokenGenerator } from '../security/tokens'

export type AppDeps = {
	// The build identity sent on every Store RPC (the Workers version id in production; tests inject one).
	build: (env: Env) => string
	now: () => number
	store?: StoreResolver
	// Remote fetches and key generation of the federation layer (tests inject both).
	federation?: Partial<Pick<FederationRouteDeps, 'keygen' | 'loader'>>
	// Seams for tests: the Access JWKS fetch and the generator of OAuth values.
	fetch?: typeof fetch
	randomToken?: TokenGenerator
}

const API_CORS_PATHS = ['/api/*', '/oauth/token', '/oauth/revoke']

type AppEnv = { Bindings: Env; Variables: { requestClass: RequestClass; inboxBody: Uint8Array; domain: string } }

// Methods logged as they are; any other is logged as OTHER (DATA-5).
const LOGGED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])

export function createApp({
	build,
	now,
	store = defaultStore,
	fetch = globalThis.fetch,
	federation = {},
	...seams
}: AppDeps) {
	const app = new Hono<AppEnv>()

	// Browser clients call the API and the token endpoints cross-origin; errors and maintenance answers carry the
	// headers too. The consent page (/oauth/authorize) is not opened to other origins.
	const apiCors = cors({ origin: '*', exposeHeaders: ['Link'], maxAge: 86400 })
	for (const path of API_CORS_PATHS) {
		app.use(path, apiCors)
	}

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
	const apiDeps = { build, now, store, randomToken: seams.randomToken ?? randomToken }
	app.route('/', authorizeRoutes({ ...apiDeps, fetch: (input, init) => fetch(input, init) }))
	app.route('/', mastodonApi(apiDeps))

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
		// The route template, not the URL: a path or query can carry a token or content (DATA-5).
		console.error({
			event: 'kopje.error',
			method: LOGGED_METHODS.has(c.req.method) ? c.req.method : 'OTHER',
			route: c.req.routePath,
			status: 500,
			...errorFields(error),
		})
		return mastodonError(500, 'Internal Server Error')
	})

	return app
}
