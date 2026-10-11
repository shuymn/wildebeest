import type { Handler } from 'hono'

import { callStore, type StoreResolver } from '../platform/store-client'

export const INBOX_ROUTES = ['/inbox', '/ap/users/:username/inbox', '/actor/inbox']

// B0 stub of the inbox endpoint: hands the request to the Store as a write. A maintenance refusal surfaces as
// StoreUnavailableError, which the app turns into a spool.
export function inboxHandler(
	build: (env: Env) => string,
	store: StoreResolver,
	now: () => number
): Handler<{ Bindings: Env }> {
	return async (c) => {
		await callStore(() => store(c.env).receiveInbox(build(c.env), { receivedAt: now() }))
		return c.body(null, 202)
	}
}
