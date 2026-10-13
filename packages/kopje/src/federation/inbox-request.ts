import { isActivityPubMediaType, parseMediaType } from '../platform/media-type'

// What an inbox request is, before the Store sees it. Shared by the Worker's gate (federation/inbox.ts) and the
// cutover's maintenance worker (src/maintenance-worker.ts), which must refuse and spool exactly the same requests.

export const INBOX_ROUTES = ['/inbox', '/ap/users/:username/inbox', '/actor/inbox']

const PERSONAL_INBOX = /^\/ap\/users\/([^/]+)\/inbox$/

// The username a personal inbox path names, as written (Hono does not decode it either), or null for a shared inbox.
export function inboxRecipient(path: string): string | null {
	return PERSONAL_INBOX.exec(path)?.[1] ?? null
}

export type InboxPrecheck = 'ok' | 'not-found' | 'unsupported-media-type'

// What can be refused before anything is spooled: a body that is not ActivityStreams (415), and a personal inbox that
// does not name a local account with its exact stored username (404, ID-5). ownerExists answers for the username as
// written.
export async function precheckInboxRequest(
	request: Request,
	ownerExists: (username: string) => Promise<boolean>
): Promise<InboxPrecheck> {
	const media = parseMediaType(request.headers.get('content-type') ?? '')
	if (media === null || !isActivityPubMediaType(media)) {
		return 'unsupported-media-type'
	}
	const username = inboxRecipient(new URL(request.url).pathname)
	if (username === null) {
		return 'ok'
	}
	return (await ownerExists(username)) ? 'ok' : 'not-found'
}
