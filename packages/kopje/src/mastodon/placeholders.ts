import { type ApiHandler, authorized, credential, present, storeCall } from './context'
import { mastodonError } from './errors'

// Features Kopje has no data for yet (followed and featured tags, endorsements, announcements, trends,
// suggestions), answered truthfully as empty, because clients call them at startup and a 404 can stop a client
// starting. Each is replaced when its feature arrives with its own tables. No write endpoint exists for them.

// A list of the signed-in user: the token is checked (validity, the route's scope if any, suspension) and must belong
// to a user before the empty answer. announcements declares no scope, as Mastodon's (any user token).
export const emptyUserList: ApiHandler = async (c, deps) => {
	const value = credential(c, deps)
	const viewer = authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)))
	if (viewer.accountId === null) {
		authorized({ status: 'user_required' })
	}
	return c.json([])
}

// A public list.
export const emptyList: ApiHandler = (c) => Promise.resolve(c.json([]))

// GET /api/v1/accounts/:id/featured_tags: none, for an account that exists.
export const accountFeaturedTags: ApiHandler = async (c, deps) => {
	const id = c.req.param('id') ?? ''
	const account = await storeCall(c, deps, (s, b) => s.getAccount(b, { id, present: present(c) }))
	return account === null ? mastodonError(404, 'Record not found') : c.json([])
}
