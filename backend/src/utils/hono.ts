// This file is based on Sonik https://github.com/yusukebe/sonik by Yusuke Wada, licensed under the MIT license.

import { Context, Hono, MiddlewareHandler, Next } from 'hono'

import { getPayload, generateValidator, getIdentity } from 'wildebeest/backend/src/access'
import { getUserByEmail } from 'wildebeest/backend/src/accounts'
import { getDatabase } from 'wildebeest/backend/src/database'
import { notAuthorized } from 'wildebeest/backend/src/errors'
import { HonoEnv } from 'wildebeest/backend/src/types'

import { filePathToPath, groupByDirectory } from './file'

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
		[
			'../routes/**/[a-z0-9[-][a-z0-9.[_-]*.ts',
			'../routes/.well-known/[a-z0-9[-][a-z0-9.[_-]*.ts',
			'!../routes/**/*.test.ts',
		],
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

			// Create a wrapped Hono app with middleware and route handler together
			// This is necessary because in Hono v4+, a middleware-only Hono app
			// mounted via .route() will not have its middleware invoked if it has no handlers
			const wrappedApp = new Hono<HonoEnv>()

			if (routeGET?.test(path)) {
				wrappedApp.use((c, next) => {
					const middleware = c.req.method === 'GET' ? publicMiddleware() : privateMiddleware()
					return middleware(c, next)
				})
			} else if (routeALL?.test(path)) {
				wrappedApp.use(publicMiddleware())
			} else if (filename !== 'index.ts') {
				wrappedApp.use(privateMiddleware())
			}

			// Mount the route handler inside the wrapped app
			// With correct directory ordering (child directories first), the path stripping works correctly
			wrappedApp.route('/', routeDefault)
			subApp.route(subPath, wrappedApp)
		}

		app.route(rootPath, subApp)
	}

	return app
}

const publicMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		if (import.meta.env.MODE === 'test') {
			if (!(c as { env?: { data?: { connectedActor?: unknown } } }).env?.data?.connectedActor) {
				c.env = {
					...c.env,
					data: {
						connectedActor: null,
					},
				}
			}
			return next()
		}

		const authorization = c.req.header('Authorization') || ''
		const token = authorization.replace('Bearer ', '')
		if (token === '') {
			c.env = {
				...c.env,
				data: {
					connectedActor: null,
				},
			}
			return next()
		}
		return authorize(c, next, token)
	}
}

const privateMiddleware = (): MiddlewareHandler<HonoEnv> => {
	return async (c, next) => {
		if (import.meta.env.MODE === 'test') {
			if ((c as { env?: { data?: { connectedActor?: unknown } } }).env?.data?.connectedActor) {
				return next()
			}
			return notAuthorized('missing authorization')
		}

		const authorization = c.req.header('Authorization') || ''
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
		const db = getDatabase(c.env)
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

type Route = {
	method?: '*' | 'GET'
	path: string
	dynamic?: boolean
}

function buildRoute(routes: Route[]): Map<Required<Route>['method'], RegExp> {
	const smap = new Map<Required<Route>['method'], string[]>()

	const methods = [...new Set(routes.map((route) => route.method ?? '*'))]
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

if (import.meta.vitest) {
	const { ACCESS_CERTS, TEST_JWT } = await import('wildebeest/backend/test/test-data')
	const { assertStatus, makeDB, createTestUser, isUrlValid } = await import('wildebeest/backend/test/utils')

	describe('buildRoute', () => {
		test.each([
			{
				title: 'static path, all methods',
				input: { path: '/foo/bar' } satisfies Route,
				expect: { key: '*', ok: ['/foo/bar'], ng: ['/', '/foo', '/foo/barbar', '/foo/bar/', '/foo/bar/piyo'] } as const,
			},
			{
				title: 'static path, GET',
				input: { method: 'GET', path: '/foo/bar' } satisfies Route,
				expect: {
					key: 'GET',
					ok: ['/foo/bar'],
					ng: ['/', '/foo', '/foo/barbar', '/foo/bar/', '/foo/bar/piyo'],
				} as const,
			},
			{
				title: 'dynamic path, prefix, all methods',
				input: { path: '/foo/bar/*', dynamic: true } satisfies Route,
				expect: {
					key: '*',
					ok: ['/foo/bar/piyo', '/foo/bar/a/b/c/d/e/f/g/h'],
					ng: ['/', '/foo', '/foo/barbar', '/foo/bar/', '/foo/piyo/bar'],
				} as const,
			},
			{
				title: 'dynamic path, prefix, GET',
				input: { method: 'GET', path: '/foo/bar/*', dynamic: true } satisfies Route,
				expect: {
					key: 'GET',
					ok: ['/foo/bar/piyo', '/foo/bar/a/b/c/d/e/f/g/h'],
					ng: ['/', '/foo', '/foo/barbar', '/foo/bar/', '/foo/piyo/bar'],
				} as const,
			},
			{
				title: 'dynamic path, param, all methods',
				input: { path: '/foo/bar/:id/piyo', dynamic: true } satisfies Route,
				expect: {
					key: '*',
					ok: ['/foo/bar/a-b-c-d/piyo', '/foo/bar/123/piyo'],
					ng: [
						'/',
						'/foo',
						'/foo/barbar',
						'/foo/bar/',
						'/foo/piyo/bar',
						'/foo/bar/a/b/c/d/e/f/g/h',
						'/foo/bar',
						'/foo/bar/piyo',
					],
				} as const,
			},
			{
				title: 'dynamic path, param, GET',
				input: { method: 'GET', path: '/foo/bar/:id/piyo', dynamic: true } satisfies Route,
				expect: {
					key: 'GET',
					ok: ['/foo/bar/a-b-c-d/piyo', '/foo/bar/123/piyo'],
					ng: [
						'/',
						'/foo',
						'/foo/barbar',
						'/foo/bar/',
						'/foo/piyo/bar',
						'/foo/bar/a/b/c/d/e/f/g/h',
						'/foo/bar',
						'/foo/bar/piyo',
					],
				} as const,
			},
			{
				title: 'dynamic path, end with param, all methods',
				input: { path: '/foo/bar/:id', dynamic: true } satisfies Route,
				expect: {
					key: '*',
					ok: ['/foo/bar/p-i-y-o', '/foo/bar/123'],
					ng: [
						'/',
						'/foo',
						'/foo/barbar',
						'/foo/bar/',
						'/foo/piyo/bar',
						'/foo/bar/a/b/c/d/e/f/g/h',
						'/foo/bar/piyo/piyo',
					],
				} as const,
			},
			{
				title: 'dynamic path, end with param, GET',
				input: { method: 'GET', path: '/foo/bar/:id', dynamic: true } satisfies Route,
				expect: {
					key: 'GET',
					ok: ['/foo/bar/p-i-y-o', '/foo/bar/123'],
					ng: [
						'/',
						'/foo',
						'/foo/barbar',
						'/foo/bar/',
						'/foo/piyo/bar',
						'/foo/bar/a/b/c/d/e/f/g/h',
						'/foo/bar/piyo/piyo',
					],
				} as const,
			},
		])('$title', ({ input, expect: { key, ok, ng } }) => {
			const routes = buildRoute([input])
			const actual = routes.get(key)
			expect(actual).toBeDefined()
			for (const path of ok) {
				expect(actual!.test(path), String(actual)).toBe(true)
			}
			for (const path of ng) {
				expect(actual!.test(path), path).toBe(false)
			}
		})
	})

	describe('middleware', () => {
		const userKEK = 'test_kek12'
		const domain = 'cloudflare.com'
		const accessDomain = 'access.com'
		const accessAud = 'abcd'

		test('test no identity', async () => {
			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/certs') {
						return Promise.resolve(new Response(JSON.stringify(ACCESS_CERTS)))
					}

					if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/get-identity') {
						return Promise.resolve(new Response('', { status: 404 }))
					}
				}

				if (input instanceof URL || typeof input === 'string') {
					return Promise.reject(new Error('unexpected request to ' + input.toString()))
				} else {
					return Promise.reject(new Error('unexpected request to ' + input.url))
				}
			}

			const db = makeDB()

			const app = new Hono<HonoEnv>()
			app.use(privateMiddleware())
			app.get('/foo', (c) => c.text('foo'))

			const headers = { authorization: 'Bearer APPID.' + TEST_JWT }
			const request = new Request('https://example.com/foo', { headers })

			const res = await app.fetch(request, { DATABASE: db })
			await assertStatus(res, 401)
		})

		test('test user not found', async () => {
			globalThis.fetch = (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/certs') {
						return Promise.resolve(new Response(JSON.stringify(ACCESS_CERTS)))
					}

					if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/get-identity') {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									email: 'some@cloudflare.com',
								})
							)
						)
					}
				}

				if (input instanceof URL || typeof input === 'string') {
					return Promise.reject(new Error('unexpected request to ' + input.toString()))
				} else {
					return Promise.reject(new Error('unexpected request to ' + input.url))
				}
			}

			const db = makeDB()

			const app = new Hono<HonoEnv>()
			app.use(privateMiddleware())

			const headers = { authorization: 'Bearer APPID.' + TEST_JWT }
			const request = new Request('https://example.com', { headers })

			const res = await app.fetch(request, { DATABASE: db })
			await assertStatus(res, 401)
		})

		test('success passes data and calls next', async () => {
			globalThis.fetch = (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/certs') {
						return Promise.resolve(new Response(JSON.stringify(ACCESS_CERTS)))
					}

					if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/get-identity') {
						return Promise.resolve(
							new Response(
								JSON.stringify({
									email: 'sven@cloudflare.com',
								})
							)
						)
					}
				}

				if (input instanceof URL || typeof input === 'string') {
					return Promise.reject(new Error('unexpected request to ' + input.toString()))
				} else {
					return Promise.reject(new Error('unexpected request to ' + input.url))
				}
			}

			const db = makeDB()
			await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const app = new Hono<HonoEnv>()
			app.get(privateMiddleware(), (c) => {
				expect(c.env.data.connectedActor).toBeDefined()
				expect(isUrlValid(c.env.data.connectedActor!.id.toString())).toBe(true)
				expect(c.env.data.identity).toStrictEqual({ email: 'sven@cloudflare.com' })
				expect(c.env.data.clientId).toBe('APPID')
				return c.text('')
			})
			app.get('/foo', (c) => c.text('foo'))

			const headers = { authorization: 'Bearer APPID.' + TEST_JWT }
			const request = new Request('https://example.com/foo', { headers })

			vi.stubEnv('MODE', 'not-test')
			const res = await app.fetch(request, { DATABASE: db, ACCESS_AUD: accessAud, ACCESS_AUTH_DOMAIN: accessDomain })
			vi.unstubAllEnvs()

			await assertStatus(res, 200)
		})
	})
}
