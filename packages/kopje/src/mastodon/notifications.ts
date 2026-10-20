import { type ApiHandler, authorized, present, requestParams, storeCall, userCredential } from './context'
import { mastodonError } from './errors'
import { pageQuery, pageResponse } from './pagination'
import { parseBoolean } from './params'

// /api/v1/notifications (B4a, Mastodon 4.0.2 v1): the list with types[], exclude_types[], account_id and
// include_filtered (Mastodon 4.5), one notification, dismiss and clear.

const NOT_FOUND = () => mastodonError(404, 'Record not found')

export const listNotifications: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p)
	const accountId = p.get('account_id')
	const credential = userCredential(c, deps)
	const result = authorized(
		await storeCall(c, deps, (s, b) =>
			s.listNotifications(b, {
				credential,
				page,
				types: p.list('types') ?? [],
				excludeTypes: p.list('exclude_types') ?? [],
				accountId: accountId === undefined || accountId === '' ? null : accountId,
				includeFiltered: parseBoolean(p.get('include_filtered')) === true,
				present: present(c),
			})
		)
	)
	return pageResponse(c, result, page.limit)
}

export const getNotification: ApiHandler = async (c, deps) => {
	const id = c.req.param('id') ?? ''
	const credential = userCredential(c, deps)
	const notification = authorized(
		await storeCall(c, deps, (s, b) => s.getNotification(b, { credential, id, present: present(c) }))
	)
	return notification === null ? NOT_FOUND() : c.json(notification)
}

export const dismissNotification: ApiHandler = async (c, deps) => {
	const id = c.req.param('id') ?? ''
	const credential = userCredential(c, deps)
	const dismissed = authorized(await storeCall(c, deps, (s, b) => s.dismissNotification(b, { credential, id })))
	return dismissed ? c.json({}) : NOT_FOUND()
}

export const clearNotifications: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	authorized(await storeCall(c, deps, (s, b) => s.clearNotifications(b, { credential })))
	return c.json({})
}
