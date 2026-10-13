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

const KEY_ID_LIMIT = 2048
const CAVAGE_KEY_ID = /(?:^|,)\s*keyId\s*=\s*"([^"]*)"/i
const RFC9421_KEY_ID = /;\s*keyid\s*=\s*"([^"]*)"/i

// Whether the request carries an HTTP signature naming an https key: a draft-cavage `Signature` header with keyId, or
// RFC 9421 `Signature-Input` and `Signature` with keyid. Only the shape: replay verifies the signature itself.
export function hasSignatureShape(headers: Headers): boolean {
	const signature = headers.get('signature')
	if (signature === null) {
		return false
	}
	const input = headers.get('signature-input')
	const keyId = (input === null ? CAVAGE_KEY_ID.exec(signature) : RFC9421_KEY_ID.exec(input))?.[1]
	if (keyId === undefined || keyId.length === 0 || keyId.length > KEY_ID_LIMIT) {
		return false
	}
	try {
		return new URL(keyId).protocol === 'https:'
	} catch {
		return false
	}
}
