import { createMiddleware } from 'hono/factory'

import type { ApiEnv } from './context'
import { invalidTokenError } from './errors'
import type { RequiredScope } from '../security/scopes'
import { sha256Hex } from '../security/tokens'

// What a route requires of the caller:
//   public : no token is read (credential null), so a stale token a client still sends does not break the call
//   token  : any valid token, app tokens included
//   scope  : a token covering the scope (any one of them if several) and bound to a user
//   scope, optional : no token reads as anonymous; a token sent must be valid and cover the scope, and an app token
//                     reads as anonymous (Mastodon's authorize_if_got_token!)
//   optional        : the same with no scope: a token sent must be valid, whatever its scopes (Mastodon's reads that
//                     declare no doorkeeper scope but use the current user)
export type RouteAccess =
	'public' | 'token' | { scope: RequiredScope; optional?: true } | { scope?: never; optional: true }

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
			if (typeof access === 'object' && access.optional === true) {
				c.set('credential', null)
				return next()
			}
			return invalidTokenError()
		}
		c.set('credential', {
			tokenHash: await sha256Hex(token),
			scope: access === 'token' ? null : (access.scope ?? null),
		})
		return next()
	})
}

export function bearerToken(header: string | undefined): string | undefined {
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
	return match?.[1]
}
