import type { Handler } from 'hono'

import { callStore, type StoreResolver } from '../platform/store-client'

export const INBOX_ROUTES = ['/inbox', '/ap/users/:username/inbox', '/actor/inbox']

export type InboxDeps = { build: (env: Env) => string; store: StoreResolver }

// B0 stub of inbox processing, shared by the endpoint and spool replay: hands the request to the Store as a write. A
// maintenance refusal surfaces as StoreUnavailableError (the endpoint spools, replay requeues).
export async function processInbox(env: Env, { build, store }: InboxDeps, receivedAt: number): Promise<void> {
	await callStore(() => store(env).receiveInbox(build(env), { receivedAt }))
}

// TODO(B1b): inbox path canonicality. A personal inbox path must name a stored username exactly (case included);
// differently cased and unknown usernames currently get 202 like any other inbox POST.
export function inboxHandler(deps: InboxDeps, now: () => number): Handler<{ Bindings: Env }> {
	return async (c) => {
		await processInbox(c.env, deps, now())
		return c.body(null, 202)
	}
}
