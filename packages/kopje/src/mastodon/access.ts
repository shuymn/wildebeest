import { createMiddleware } from 'hono/factory'

import { type ApiDeps, type ApiEnv, storeCall } from './context'
import { mastodonError } from './errors'
import { grants, type Scope } from '../security/scopes'
import { sha256Hex } from '../security/tokens'

// What a route requires of the caller:
//   public : no token is read (viewer null), so a stale token a client still sends does not break the call
//   token  : any valid token, app tokens included
//   scope  : a token covering the scope and bound to a user
export type RouteAccess = 'public' | 'token' | { scope: Scope }

// The one middleware that checks tokens and scopes for every API route. A token is looked up by its sha256 in one
// Store read; there is no external fetch.
export function requireAccess(access: RouteAccess, deps: ApiDeps) {
	return createMiddleware<ApiEnv>(async (c, next) => {
		if (access === 'public') {
			c.set('viewer', null)
			return next()
		}
		const token = bearerToken(c.req.header('authorization'))
		if (token === undefined) {
			return mastodonError(401, 'The access token is invalid')
		}
		const tokenHash = await sha256Hex(token)
		const result = await storeCall(c, deps, (store, build) => store.authenticate(build, { tokenHash, now: deps.now() }))
		if (result.status === 'invalid') {
			return mastodonError(401, 'The access token is invalid')
		}
		if (result.status === 'suspended') {
			return mastodonError(403, 'Your login is currently disabled')
		}
		const { viewer } = result
		if (typeof access === 'object') {
			if (!grants(viewer.scopes, access.scope)) {
				return mastodonError(403, 'This action is outside the authorized scopes')
			}
			if (viewer.accountId === null) {
				return mastodonError(422, 'This method requires an authenticated user')
			}
		}
		c.set('viewer', viewer)
		return next()
	})
}

function bearerToken(header: string | undefined): string | undefined {
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
	return match?.[1]
}
