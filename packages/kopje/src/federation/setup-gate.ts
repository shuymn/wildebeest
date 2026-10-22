import type { Context } from 'hono'
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

// The answer before setup, shared with the inbox, which reads the domain in its own gate (federation/inbox.ts).
export function notSetUp(c: Context): Response {
	return c.json({ error: 'This server has not been set up yet' }, 503)
}

// skip: requests whose handler reads the domain itself (the inbox POSTs), which pass without a Store call here.
export function requireSetup(build: (env: Env) => string, store: StoreResolver, skip?: (c: Context) => boolean) {
	return createMiddleware<{ Bindings: Env; Variables: { domain: string } }>(async (c, next) => {
		if (skip?.(c) === true) {
			return next()
		}
		const domain = await callStore(() => store(c.env).instanceDomain(build(c.env)))
		if (domain === null) {
			return notSetUp(c)
		}
		c.set('domain', domain)
		await next()
	})
}
