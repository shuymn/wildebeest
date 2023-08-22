// This file is based on Sonik https://github.com/yusukebe/sonik by Yusuke Wada, licensed under the MIT license.

import { Context, Hono, MiddlewareHandler, Next } from 'hono'

import { getPayload, generateValidator, getIdentity } from 'wildebeest/backend/src/access'
import { getUserByEmail } from 'wildebeest/backend/src/accounts'
import { getDatabase } from 'wildebeest/backend/src/database'
import { notAuthorized } from 'wildebeest/backend/src/errors'
import { HonoEnv } from 'wildebeest/backend/src/types'
import { unique } from 'wildebeest/backend/src/utils'

import { filePathToPath, groupByDirectory } from './file'

export type Route = {
	method?: '*' | 'GET'
	path: string
	dynamic?: boolean
}

// public routes
const routes = buildRoute([
	{ path: '/.well-known/*', dynamic: true },
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
	{ path: '/api/v1/statuses/:id', dynamic: true, method: 'GET' },
	{ path: '/api/v1/statuses/:id/context', dynamic: true, method: 'GET' },
	{ path: '/api/v1/statuses/:id/history', dynamic: true, method: 'GET' },
	{ path: '/nodeinfo/*', dynamic: true },
	{ path: '/oauth/*', dynamic: true }, // Cloudflare Access runs on /oauth/authorize
	{ path: '/first-login' },
])

const routeGET = routes.get('GET')
const routeALL = routes.get('*')

const root = '../routes'
const regExp = new RegExp(`^${root}`)

export const createApp = (options: { app?: Hono<HonoEnv> }): Hono<HonoEnv> => {
	const ROUTES = import.meta.glob<true, string, { default: Hono }>(
		['../routes/**/[a-z0-9[-][a-z0-9.[_-]*.ts', '../routes/.well-known/[a-z0-9[-][a-z0-9.[_-]*.ts'],
		{
			eager: true,
		}
	)
	const routesMap = groupByDirectory(ROUTES)

	const app = options.app ?? new Hono<HonoEnv>()

	for (const [dir, content] of Object.entries(routesMap)) {
		const subApp = new Hono()
		const rootPath = filePathToPath(dir.replace(regExp, ''))

		for (const [filename, route] of Object.entries(content)) {
			const routeDefault = route.default
			if (!routeDefault) {
				continue
			}

			const subPath = filePathToPath(filename)
			const path = rootPath.replace(/\/$/, '') + subPath

			if (routeGET?.test(path)) {
				subApp.route(
					subPath,
					new Hono<HonoEnv>().use((c, next) => {
						const middleware = c.req.method === 'GET' ? publicMiddleware() : privateMiddleware()
						return middleware(c, next)
					})
				)
			} else if (routeALL?.test(path)) {
				subApp.route(subPath, new Hono<HonoEnv>().use(publicMiddleware()))
			} else if (filename !== 'index.ts') {
				subApp.route(subPath, new Hono<HonoEnv>().use(privateMiddleware()))
			}

			subApp.route(subPath, routeDefault)
		}

		app.route(rootPath, subApp)
	}

	return app
}

const publicMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		const authorization = c.req.headers.get('Authorization') || ''
		const token = authorization.replace('Bearer ', '')
		if (token === '') {
			return next()
		}
		return authorize(c, next, token)
	}
}

const privateMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		const authorization = c.req.headers.get('Authorization') || ''
		const token = authorization.replace('Bearer ', '')
		if (token === '') {
			return notAuthorized('missing authorization')
		}
		return authorize(c, next, token)
	}
}

const authorize = async (c: Context<HonoEnv>, next: Next, token: string) => {
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
		const db = await getDatabase(c.env)
		const actor = await getUserByEmail(db, email)
		if (actor === null) {
			console.warn('person not found')
			return notAuthorized('failed to load context data')
		}

		c.env = {
			...c.env,
			data: {
				connectedActor: actor,
				identity: { email },
				clientId,
			},
		}

		const validate = generateValidator({
			jwt,
			domain: c.env.ACCESS_AUTH_DOMAIN,
			aud: c.env.ACCESS_AUD,
		})
		await validate(c.req.raw)

		const identity = await getIdentity({ jwt, domain: c.env.ACCESS_AUTH_DOMAIN })
		if (!identity) {
			return notAuthorized('failed to load identity')
		}

		return next()
	} catch (err) {
		if (err instanceof Error) {
			console.warn(err.stack)
		}
		return notAuthorized('unknown error occurred')
	}
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
