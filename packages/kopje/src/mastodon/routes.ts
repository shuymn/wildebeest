import { Hono } from 'hono'

import { requireAccess, type RouteAccess } from './access'
import * as accounts from './accounts'
import type { ApiDeps, ApiEnv, ApiHandler } from './context'
import * as instance from './instance'
import * as oauth from './oauth'

// The explicit API route table (design §4): every route names the access it requires, one middleware (requireAccess)
// declares it, and the Store enforces it in each operation. Routes are matched in order, so fixed paths come before
// their :id siblings.

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export type Route = {
	method: Method
	path: string
	access: RouteAccess
	handler: ApiHandler
}

export const ROUTES: readonly Route[] = [
	{ method: 'POST', path: '/api/v1/apps', access: 'public', handler: oauth.registerApp },
	{ method: 'GET', path: '/api/v1/apps/verify_credentials', access: 'token', handler: oauth.verifyApp },
	{ method: 'POST', path: '/oauth/token', access: 'public', handler: oauth.tokenHandler },
	{ method: 'POST', path: '/oauth/revoke', access: 'public', handler: oauth.revokeHandler },

	{ method: 'GET', path: '/api/v1/instance', access: 'public', handler: instance.instanceV1 },
	{ method: 'GET', path: '/api/v2/instance', access: 'public', handler: instance.instanceV2 },
	{ method: 'GET', path: '/api/v1/custom_emojis', access: 'public', handler: instance.customEmojis },

	{
		method: 'GET',
		path: '/api/v1/accounts/verify_credentials',
		access: { scope: 'read:accounts' },
		handler: accounts.verifyCredentials,
	},
	{
		method: 'PATCH',
		path: '/api/v1/accounts/update_credentials',
		access: { scope: 'write:accounts' },
		handler: accounts.updateCredentials,
	},
	{
		method: 'GET',
		path: '/api/v1/accounts/relationships',
		access: { scope: 'read:follows' },
		handler: accounts.relationships,
	},
	{
		method: 'GET',
		path: '/api/v1/accounts/search',
		access: { scope: 'read:accounts' },
		handler: accounts.searchAccounts,
	},
	{ method: 'GET', path: '/api/v1/accounts/lookup', access: 'public', handler: accounts.lookupAccount },
	{ method: 'GET', path: '/api/v1/accounts/:id', access: 'public', handler: accounts.getAccount },
	{ method: 'POST', path: '/api/v1/accounts/:id/follow', access: { scope: 'write:follows' }, handler: accounts.follow },
	{
		method: 'POST',
		path: '/api/v1/accounts/:id/unfollow',
		access: { scope: 'write:follows' },
		handler: accounts.unfollow,
	},
	{ method: 'GET', path: '/api/v1/accounts/:id/followers', access: 'public', handler: accounts.followers },
	{ method: 'GET', path: '/api/v1/accounts/:id/following', access: 'public', handler: accounts.following },
]

export function mastodonApi(deps: ApiDeps, routes: readonly Route[] = ROUTES): Hono<ApiEnv> {
	const api = new Hono<ApiEnv>()
	for (const route of routes) {
		api.on(route.method, route.path, requireAccess(route.access), (c) => route.handler(c, deps))
	}
	return api
}
