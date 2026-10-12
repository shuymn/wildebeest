import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { mastodonError } from './errors'
import { type Params, readParams } from './params'
import type { Present } from '../domain/accounts'
import type { AuthFailure, Authorized, Credential, UserCredential } from '../domain/auth'
import type { Resolved } from '../domain/remote-statuses'
import { readConfig } from '../platform/config'
import type { ImageCodec } from '../platform/images'
import { callStore, type StoreResolver, type StoreStub } from '../platform/store-client'
import { vapidPublicKey } from '../platform/vapid'
import type { Scope } from '../security/scopes'
import type { TokenGenerator } from '../security/tokens'

export type ApiDeps = {
	build: (env: Env) => string
	now: () => number
	store: StoreResolver
	// Generates client ids and secrets, codes and access tokens, and media file tokens.
	randomToken: TokenGenerator
	// Re-encodes uploaded images (the Images binding in production).
	images: (env: Env) => ImageCodec
	// Fetches a URL or user@domain for search with resolve=true (federation/resolve.ts); none: answered locally.
	resolve?: (env: Env, query: string) => Promise<Resolved>
}

// The bearer token's digest and the scope the route declares, set by the access middleware (mastodon/access.ts) on
// every API route: null on a public route. It is not validated there; the Store validates it in the operation.
export type RequestCredential = { tokenHash: string; scope: Scope | null }

export type ApiEnv = { Bindings: Env; Variables: { credential: RequestCredential | null } }

export type ApiContext = Context<ApiEnv>

export type ApiHandler = (c: ApiContext, deps: ApiDeps) => Promise<Response>

// One Store RPC with the caller's build; maintenance refusals become StoreUnavailableError (503 in onError).
// Typed by the callback so the RPC result types (unions of promises) come through as their awaited values.
export function storeCall<F extends (store: StoreStub, build: string) => unknown>(
	c: { env: Env },
	deps: Pick<ApiDeps, 'build' | 'store'>,
	call: F
): Promise<Awaited<ReturnType<F>>> {
	type Result = Awaited<ReturnType<F>>
	return callStore(() => Promise.resolve(call(deps.store(c.env), deps.build(c.env))) as Promise<Result>)
}

export function present(c: Context): Present {
	return { origin: new URL(c.req.url).origin }
}

// The credential of a route that declares a token (scope null) or a scope. Its `now` is the time the Store judges
// expiry by, so handlers take it immediately before the Store call, after the request body has been read: a slow
// body must not carry a token past its expiry.
export function credential(c: ApiContext, deps: Pick<ApiDeps, 'now'>): Credential {
	const value = c.get('credential')
	if (value === null) {
		throw new HTTPException(401, { message: AUTH_ERRORS.unauthenticated.message })
	}
	return { ...value, now: deps.now() }
}

// The credential of a route that declares a scope, which a user-bound operation of the Store takes.
export function userCredential(c: ApiContext, deps: Pick<ApiDeps, 'now'>): UserCredential {
	const value = credential(c, deps)
	if (value.scope === null) {
		throw new Error('route declares no scope for a user operation')
	}
	return { ...value, scope: value.scope }
}

// The credential of a route whose token is optional: null when the request sent none.
export function optionalCredential(c: ApiContext, deps: Pick<ApiDeps, 'now'>): UserCredential | null {
	return c.get('credential') === null ? null : userCredential(c, deps)
}

const AUTH_ERRORS: Record<AuthFailure['status'], { status: 401 | 403 | 422; message: string }> = {
	unauthenticated: { status: 401, message: 'The access token is invalid' },
	suspended: { status: 403, message: 'Your login is currently disabled' },
	insufficient_scope: { status: 403, message: 'This action is outside the authorized scopes' },
	user_required: { status: 422, message: 'This method requires an authenticated user' },
}

// The value of an authorized Store operation; an authorization failure becomes Mastodon's error answer.
export function authorized<O>(result: Authorized<O>): O {
	if (result.status !== 'ok') {
		const { status, message } = AUTH_ERRORS[result.status]
		throw new HTTPException(status, { message })
	}
	return result.value
}

// A request error the Worker found before calling the Store. Mastodon authenticates first, so a request with a bad
// token is answered as unauthenticated even when its parameters are wrong too.
export async function refuseAfterAuth(c: ApiContext, deps: ApiDeps, response: Response): Promise<Response> {
	if (c.get('credential') !== null) {
		const value = credential(c, deps)
		authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)))
	}
	return response
}

// The request's parameters, or the error answer for an unreadable body (after authentication, as Mastodon orders it).
export async function requestParams(c: ApiContext, deps: ApiDeps): Promise<Params | Response> {
	const result = await readParams(c.req.raw)
	if (!result.ok) {
		return refuseAfterAuth(
			c,
			deps,
			mastodonError(result.status, result.status === 413 ? 'Request body is too large' : 'Malformed request body')
		)
	}
	return result.params
}

// The Web Push application server key clients subscribe with; empty until VAPID_JWK is set.
export function vapidKey(env: Env): string {
	const config = readConfig(env)
	const jwk = config.ok ? config.config.VAPID_JWK : undefined
	return jwk === undefined ? '' : (vapidPublicKey(jwk) ?? '')
}
