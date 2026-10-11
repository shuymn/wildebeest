import { createMiddleware } from 'hono/factory'

import { callStore, type StoreResolver } from '../platform/store-client'

// Federation endpoints. Until /setup has fixed the domain they answer 503 so nothing is published under a
// provisional host.
export const FEDERATION_PATHS = [
	'/.well-known/webfinger',
	'/.well-known/host-meta',
	'/.well-known/nodeinfo',
	'/nodeinfo/*',
	'/ap/*',
	'/actor',
	'/actor/*',
	'/inbox',
]

export function requireSetup(build: (env: Env) => string, store: StoreResolver) {
	return createMiddleware<{ Bindings: Env }>(async (c, next) => {
		const { complete } = await callStore(() => store(c.env).setupState(build(c.env)))
		if (!complete) {
			return c.json({ error: 'This server has not been set up yet' }, 503)
		}
		await next()
	})
}
