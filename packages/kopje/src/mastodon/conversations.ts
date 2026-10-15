import { type ApiHandler, authorized, present, requestParams, storeCall, userCredential } from './context'
import { mastodonError } from './errors'
import { pageQuery, pageResponse } from './pagination'

// Conversations (Mastodon 4.5's Api::V1::ConversationsController); the Store does the work (domain/conversations.ts).
// A conversation that is not the viewer's is not found.

const NOT_FOUND = () => mastodonError(404, 'Record not found')

// ConversationsController::LIMIT: 20 by default, and at most twice that (limit_param).
export const conversations: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const page = pageQuery(p, 20, 40)
	const input = { credential: userCredential(c, deps), page, present: present(c) }
	return pageResponse(c, authorized(await storeCall(c, deps, (s, b) => s.listConversations(b, input))), page.limit)
}

function mark(unread: boolean): ApiHandler {
	return async (c, deps) => {
		const input = { credential: userCredential(c, deps), id: c.req.param('id') ?? '', unread, present: present(c) }
		const conversation = authorized(await storeCall(c, deps, (s, b) => s.markConversation(b, input)))
		return conversation === null ? NOT_FOUND() : c.json(conversation)
	}
}

export const readConversation = mark(false)
export const unreadConversation = mark(true)

export const deleteConversation: ApiHandler = async (c, deps) => {
	const input = { credential: userCredential(c, deps), id: c.req.param('id') ?? '' }
	const deleted = authorized(await storeCall(c, deps, (s, b) => s.deleteConversation(b, input)))
	return deleted ? c.json({}) : NOT_FOUND()
}
