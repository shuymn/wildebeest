import { type ApiHandler, authorized, present, storeCall, userCredential } from './context'
import { mastodonError } from './errors'

// Features Kopje has no data for yet (filters, followed and featured tags, endorsements, announcements, trends,
// suggestions), answered truthfully as empty, because clients call them at startup and a 404 can stop a client
// starting. Each is replaced when its feature arrives with its own tables. No write endpoint exists for them.

// A list of the signed-in user: the token is checked (scope, user, suspension) before the empty answer.
export const emptyUserList: ApiHandler = async (c, deps) => {
	const credential = userCredential(c, deps)
	authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, credential)))
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
