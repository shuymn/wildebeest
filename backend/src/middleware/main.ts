import { generateValidator, getIdentity, getPayload } from 'wildebeest/backend/src/access'
import { getUserByEmail } from 'wildebeest/backend/src/accounts'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { notAuthorized } from 'wildebeest/backend/src/errors'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { unique } from 'wildebeest/backend/src/utils'
import { cors } from 'wildebeest/backend/src/utils/cors'

async function loadContextData(
	db: Database,
	clientId: string,
	email: string,
	ctx: { data: Partial<ContextData> }
): Promise<boolean> {
	const actor = await getUserByEmail(db, email)
	if (actor === null) {
		console.warn('person not found')
		return false
	}

	ctx.data.connectedActor = actor
	ctx.data.identity = { email }
	ctx.data.clientId = clientId

	return true
}

async function authorize(
	context: EventContext<Env, string, Partial<ContextData>>,
	request: Request,
	token: string
): Promise<Response> {
	const parts = token.split('.')
	if (parts.length !== 4) {
		return notAuthorized(`invalid token. expected 4 parts, got ${parts.length}`)
	}

	const [clientId, ...jwtParts] = parts
	const jwt = jwtParts.join('.')

	try {
		const { email } = getPayload(jwt)
		if (!email) {
			return notAuthorized('missing email')
		}

		// Load the user associated with the email in the payload *before*
		// verifying the JWT validity.
		// This is because loading the context will also load the access
		// configuration, which are used to verify the JWT.
		// TODO: since we don't load the instance configuration anymore, we
		// don't need to load the user before anymore.
		const db = await getDatabase(context.env)
		const ok = await loadContextData(db, clientId, email, context)
		if (!ok) {
			return notAuthorized('failed to load context data')
		}

		const validate = generateValidator({
			jwt,
			domain: context.env.ACCESS_AUTH_DOMAIN,
			aud: context.env.ACCESS_AUD,
		})
		await validate(request)

		const identity = await getIdentity({ jwt, domain: context.env.ACCESS_AUTH_DOMAIN })
		if (!identity) {
			return notAuthorized('failed to load identity')
		}

		return context.next()
	} catch (err) {
		if (err instanceof Error) {
			console.warn(err.stack)
		}
		return notAuthorized('unknown error occurred')
	}
}

export type Route = {
	method?: '*' | 'GET'
	path: string
	dynamic?: boolean
}

export function buildRoute(routes: Route[]): Map<Required<Route>['method'], RegExp> {
	const smap = new Map<Required<Route>['method'], string[]>()

	const methods = unique(routes.map((route) => route.method ?? '*'))
	for (const method of methods) {
		smap.set(method, [])
	}

	for (const route of routes) {
		const method = route.method ?? '*'
		const dynamic = route.dynamic ?? false

		const path = dynamic ? route.path.replace(/:[a-zA-Z]+/g, '[^/]+').replace(/\*$/g, '.+') : route.path
		smap.get(method)?.push(`^${path}$`)
	}

	const remap = new Map<Required<Route>['method'], RegExp>()
	for (const [method, ss] of smap) {
		if (ss.length === 0) {
			continue
		}
		remap.set(method, new RegExp(ss.join('|')))
	}
	return remap
}

// public routes
const routes = buildRoute([
	{ path: '/oauth/token' },
	{ path: '/oauth/authorize' }, // Cloudflare Access runs on /oauth/authorize
	{ path: '/.well-known/webfinger' },
	{ path: '/ap/*', dynamic: true }, // all ActivityPub endpoints
	{ path: '/api/v2/instance' },
	{ path: '/api/v1/instance' },
	{ path: '/api/v1/instance/peers' },
	{ path: '/api/v1/apps' },
	{ path: '/api/v1/timelines/public' },
	{ path: '/api/v1/timelines/tag/:tag', dynamic: true },
	{ path: '/api/v1/custom_emojis' },
	{ path: '/api/v1/trends/statuses' },
	{ path: '/api/v1/trends/links' },
	{ path: '/api/v1/accounts/lookup' },
	{ path: '/api/v1/accounts/:id/statuses', dynamic: true },
	{ path: '/api/v1/tags/:tag', dynamic: true },
	{ method: 'GET', path: '/api/v1/statuses/:id', dynamic: true },
	{ method: 'GET', path: '/api/v1/statuses/:id/context', dynamic: true },
	{ method: 'GET', path: '/api/v1/statuses/:id/history', dynamic: true },
])

const routeGET = routes.get('GET')
const routeALL = routes.get('*')

export async function main(context: EventContext<Env, string, Partial<ContextData>>): Promise<Response> {
	const request = context.request
	const url = new URL(request.url)

	if (request.method === 'OPTIONS') {
		return new Response('', {
			headers: {
				...cors(),
				'content-type': 'application/json',
			},
		})
	}

	const authorization = request.headers.get('Authorization') || ''
	const token = authorization.replace('Bearer ', '')

	if (routeALL && routeALL.test(url.pathname)) {
		if (token === '') {
			return context.next()
		}
		return authorize(context, request, token)
	}

	if (routeGET && request.method === 'GET' && routeGET.test(url.pathname)) {
		if (token === '') {
			return context.next()
		}
		return authorize(context, request, token)
	}

	if (token === '') {
		return notAuthorized('missing authorization')
	}
	return authorize(context, request, token)
}
