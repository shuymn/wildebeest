import { Hono } from 'hono'

import { requireAccess, type RouteAccess } from './access'
import * as accounts from './accounts'
import type { ApiDeps, ApiEnv, ApiHandler } from './context'
import * as instance from './instance'
import * as media from './media'
import * as notifications from './notifications'
import * as oauth from './oauth'
import * as statuses from './statuses'
import * as timelines from './timelines'

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
	{
		method: 'GET',
		path: '/api/v1/accounts/:id/statuses',
		access: { scope: 'read:statuses', optional: true },
		handler: timelines.accountStatuses,
	},

	{ method: 'POST', path: '/api/v1/statuses', access: { scope: 'write:statuses' }, handler: statuses.createStatus },
	{
		method: 'GET',
		path: '/api/v1/statuses/:id',
		access: { scope: 'read:statuses', optional: true },
		handler: statuses.getStatus,
	},
	{ method: 'PUT', path: '/api/v1/statuses/:id', access: { scope: 'write:statuses' }, handler: statuses.editStatus },
	{
		method: 'DELETE',
		path: '/api/v1/statuses/:id',
		access: { scope: 'write:statuses' },
		handler: statuses.deleteStatus,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/context',
		access: { scope: 'read:statuses', optional: true },
		handler: statuses.statusContext,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/history',
		access: { scope: 'read:statuses', optional: true },
		handler: statuses.statusHistory,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/source',
		access: { scope: 'read:statuses' },
		handler: statuses.statusSource,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/favourited_by',
		access: { scope: 'read:accounts', optional: true },
		handler: statuses.favouritedBy,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/reblogged_by',
		access: { scope: 'read:accounts', optional: true },
		handler: statuses.rebloggedBy,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/favourite',
		access: { scope: 'write:favourites' },
		handler: statuses.favourite,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/unfavourite',
		access: { scope: 'write:favourites' },
		handler: statuses.unfavourite,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/reblog',
		access: { scope: 'write:statuses' },
		handler: statuses.reblog,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/unreblog',
		access: { scope: 'write:statuses' },
		handler: statuses.unreblog,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/bookmark',
		access: { scope: 'write:bookmarks' },
		handler: statuses.bookmark,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/unbookmark',
		access: { scope: 'write:bookmarks' },
		handler: statuses.unbookmark,
	},

	{ method: 'GET', path: '/api/v1/timelines/home', access: { scope: 'read:statuses' }, handler: timelines.home },
	{
		method: 'GET',
		path: '/api/v1/timelines/public',
		access: { scope: 'read:statuses', optional: true },
		handler: timelines.publicTimeline,
	},
	{
		method: 'GET',
		path: '/api/v1/timelines/tag/:hashtag',
		access: { scope: 'read:statuses', optional: true },
		handler: timelines.tagTimeline,
	},
	{ method: 'GET', path: '/api/v1/bookmarks', access: { scope: 'read:bookmarks' }, handler: timelines.bookmarks },
	{ method: 'GET', path: '/api/v1/favourites', access: { scope: 'read:favourites' }, handler: timelines.favourites },

	{ method: 'POST', path: '/api/v1/media', access: { scope: 'write:media' }, handler: media.uploadMedia },
	{ method: 'POST', path: '/api/v2/media', access: { scope: 'write:media' }, handler: media.uploadMedia },
	{ method: 'GET', path: '/api/v1/media/:id', access: { scope: 'write:media' }, handler: media.getMedia },
	{ method: 'PUT', path: '/api/v1/media/:id', access: { scope: 'write:media' }, handler: media.updateMedia },

	{
		method: 'GET',
		path: '/api/v1/notifications',
		access: { scope: 'read:notifications' },
		handler: notifications.listNotifications,
	},
	{
		method: 'POST',
		path: '/api/v1/notifications/clear',
		access: { scope: 'write:notifications' },
		handler: notifications.clearNotifications,
	},
	{
		method: 'GET',
		path: '/api/v1/notifications/:id',
		access: { scope: 'read:notifications' },
		handler: notifications.getNotification,
	},
	{
		method: 'POST',
		path: '/api/v1/notifications/:id/dismiss',
		access: { scope: 'write:notifications' },
		handler: notifications.dismissNotification,
	},
]

export function mastodonApi(deps: ApiDeps, routes: readonly Route[] = ROUTES): Hono<ApiEnv> {
	const api = new Hono<ApiEnv>()
	for (const route of routes) {
		api.on(route.method, route.path, requireAccess(route.access), (c) => route.handler(c, deps))
	}
	return api
}
