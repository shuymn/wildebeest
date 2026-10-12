import { createMiddleware } from 'hono/factory'

import type { ApiEnv } from './context'
import { mastodonError } from './errors'
import type { Scope } from '../security/scopes'
import { sha256Hex } from '../security/tokens'

// What a route requires of the caller:
//   public : no token is read (credential null), so a stale token a client still sends does not break the call
//   token  : any valid token, app tokens included
//   scope  : a token covering the scope and bound to a user
export type RouteAccess = 'public' | 'token' | { scope: Scope }

// The one middleware that reads the bearer token and declares the route's scope for every API route. It does not
// validate the token: the Store does, in the transaction of the operation the request performs (domain/auth.ts).
export function requireAccess(access: RouteAccess) {
	return createMiddleware<ApiEnv>(async (c, next) => {
		if (access === 'public') {
			c.set('credential', null)
			return next()
		}
		const token = bearerToken(c.req.header('authorization'))
		if (token === undefined) {
			return mastodonError(401, 'The access token is invalid')
		}
		c.set('credential', { tokenHash: await sha256Hex(token), scope: access === 'token' ? null : access.scope })
		return next()
	})
}

function bearerToken(header: string | undefined): string | undefined {
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
	return match?.[1]
}
