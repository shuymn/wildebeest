import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

import type { Present } from '../domain/accounts'
import type { Viewer } from '../domain/oauth'
import { readConfig } from '../platform/config'
import { callStore, type StoreResolver, type StoreStub } from '../platform/store-client'
import { vapidPublicKey } from '../platform/vapid'
import type { TokenGenerator } from '../security/tokens'

export type ApiDeps = {
	build: (env: Env) => string
	now: () => number
	store: StoreResolver
	// Generates client ids and secrets, codes and access tokens.
	randomToken: TokenGenerator
}

// The viewer is set by the access middleware (mastodon/access.ts) on every API route: null on a public route called
// without a token.
export type ApiEnv = { Bindings: Env; Variables: { viewer: Viewer | null } }

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

// The viewer's account on a route whose access requires a user (the middleware has already refused app tokens).
export function viewerAccount(c: ApiContext): string {
	const accountId = c.get('viewer')?.accountId
	if (accountId === null || accountId === undefined) {
		throw new HTTPException(422, { message: 'This method requires an authenticated user' })
	}
	return accountId
}

// The Web Push application server key clients subscribe with; empty until VAPID_JWK is set.
export function vapidKey(env: Env): string {
	const config = readConfig(env)
	const jwk = config.ok ? config.config.VAPID_JWK : undefined
	return jwk === undefined ? '' : (vapidPublicKey(jwk) ?? '')
}
