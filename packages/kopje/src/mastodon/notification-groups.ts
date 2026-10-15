import {
	type ApiHandler,
	authorized,
	present,
	refuseAfterAuth,
	requestParams,
	storeCall,
	userCredential,
} from './context'
import { mastodonError } from './errors'
import { linkHeader, pageQuery, pageResponse } from './pagination'
import type { Params } from './params'
import { DEFAULT_UNREAD_LIMIT, type ExpandAccounts, MAX_UNREAD_LIMIT } from '../domain/notification-groups'

// Grouped notifications (Mastodon 4.5's /api/v2/notifications) and the unread counts of /api/v1 and /api/v2; the Store
// does the work (domain/notification-groups.ts).

const types = (p: Params, name: string) => p.getAll(name).filter((type) => type !== '')

// grouped_types[]: null when not sent (every groupable type), else the types sent.
const groupedTypes = (p: Params) => (p.has('grouped_types') ? p.getAll('grouped_types') : null)

// Ruby's String#to_i: the leading integer, 0 without one.
function rubyInteger(value: string): number {
	const match = /^\s*([+-]?\d+)/.exec(value)
	return match?.[1] === undefined ? 0 : Number(match[1])
}

// Api::BaseController#limit_param(DEFAULT_NOTIFICATIONS_COUNT_LIMIT, MAX_NOTIFICATIONS_COUNT_LIMIT).
function unreadLimit(p: Params): number {
	const limit = p.get('limit')
	return limit === undefined ? DEFAULT_UNREAD_LIMIT : Math.min(Math.abs(rubyInteger(limit)), MAX_UNREAD_LIMIT)
}

// GET /api/v2/notifications: types[], exclude_types[], grouped_types[], expand_accounts, and the page (40 groups by
// default, at most 80). Mastodon's v2 reads no account_id.
export const listGroupedNotifications: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const expand = p.get('expand_accounts')
	if (expand !== undefined && expand !== 'full' && expand !== 'partial_avatars') {
		return refuseAfterAuth(
			c,
			deps,
			mastodonError(
				400,
				`Invalid value for 'expand_accounts': '${expand}', allowed values are 'full' and 'partial_avatars'`
			)
		)
	}
	const page = pageQuery(p)
	const credential = userCredential(c, deps)
	const { next, prev, ...grouped } = authorized(
		await storeCall(c, deps, (s, b) =>
			s.listGroupedNotifications(b, {
				credential,
				page,
				types: types(p, 'types'),
				excludeTypes: types(p, 'exclude_types'),
				groupedTypes: groupedTypes(p),
				expandAccounts: (expand ?? 'full') as ExpandAccounts,
				present: present(c),
			})
		)
	)
	// Both links whenever the page found a group: as a full page, so next is offered.
	const link = linkHeader(c.req.url, { newest: prev, oldest: next, count: page.limit }, page.limit)
	if (link !== undefined) {
		c.header('Link', link)
	}
	return c.json(grouped)
}

export const getNotificationGroup: ApiHandler = async (c, deps) => {
	const groupKey = c.req.param('group_key') ?? ''
	const credential = userCredential(c, deps)
	const group = authorized(
		await storeCall(c, deps, (s, b) => s.getNotificationGroup(b, { credential, groupKey, present: present(c) }))
	)
	return group === null ? mastodonError(404, 'Record not found') : c.json(group)
}

// GET /api/v2/notifications/:group_key/accounts: 40 by default, at most 80, by max_id and since_id.
export const notificationGroupAccounts: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const groupKey = c.req.param('group_key') ?? ''
	const { minId: _ignored, ...page } = pageQuery(p)
	const credential = userCredential(c, deps)
	const result = authorized(
		await storeCall(c, deps, (s, b) =>
			s.notificationGroupAccounts(b, { credential, groupKey, page, present: present(c) })
		)
	)
	return pageResponse(c, result, page.limit)
}

export const dismissNotificationGroup: ApiHandler = async (c, deps) => {
	const groupKey = c.req.param('group_key') ?? ''
	const credential = userCredential(c, deps)
	authorized(await storeCall(c, deps, (s, b) => s.dismissNotificationGroup(b, { credential, groupKey })))
	return c.json({})
}

// GET /api/v1/notifications/unread_count: types[], exclude_types[], account_id and limit (100 by default, at most
// 1,000).
export const unreadCount: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const accountId = p.get('account_id')
	const credential = userCredential(c, deps)
	const input = {
		credential,
		limit: unreadLimit(p),
		types: types(p, 'types'),
		excludeTypes: types(p, 'exclude_types'),
		accountId: accountId === undefined || accountId === '' ? null : accountId,
		groupedTypes: null,
	}
	return c.json(authorized(await storeCall(c, deps, (s, b) => s.unreadNotificationCount(b, input))))
}

// GET /api/v2/notifications/unread_count: types[], exclude_types[], grouped_types[] and limit (100 by default, at most
// 1,000).
export const unreadGroupCount: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const credential = userCredential(c, deps)
	const input = {
		credential,
		limit: unreadLimit(p),
		types: types(p, 'types'),
		excludeTypes: types(p, 'exclude_types'),
		accountId: null,
		groupedTypes: groupedTypes(p),
	}
	return c.json(authorized(await storeCall(c, deps, (s, b) => s.unreadNotificationGroupCount(b, input))))
}
