import { createMiddleware } from 'hono/factory'

import { callStore, type StoreResolver } from '../platform/store-client'

// Federation endpoints. Until /setup has fixed the domain they answer 503 so nothing is published under a
// provisional host. Once it has, the domain is handed to the handlers as c.var.domain.
export const FEDERATION_PATHS = [
	'/.well-known/webfinger',
	'/.well-known/host-meta',
	'/.well-known/nodeinfo',
	'/nodeinfo/*',
	'/ap/*',
	'/actor',
	'/actor/*',
	'/inbox',
	'/emojis/*',
]

export function requireSetup(build: (env: Env) => string, store: StoreResolver) {
	return createMiddleware<{ Bindings: Env; Variables: { domain: string } }>(async (c, next) => {
		const domain = await callStore(() => store(c.env).instanceDomain(build(c.env)))
		if (domain === null) {
			return c.json({ error: 'This server has not been set up yet' }, 503)
		}
		c.set('domain', domain)
		await next()
	})
}
