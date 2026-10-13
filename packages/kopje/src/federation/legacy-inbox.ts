// The legacy Wildebeest consumer's inbox message (packages/backend/src/types/queue.ts, InboxMessageBody), as the
// legacy inbox route enqueues it (packages/backend/src/routes/ap/users/[id]/inbox.ts): what a cutover rollback hands
// to the legacy Queue for each verified request of Kopje's spool (docs/cutover-runbook.md). The legacy consumer drops a
// message whose activity actor is not its signer, so signerId is the verified key owner, which is the activity actor.
// No imports: the legacy consumer's suite runs this very function.

export const LEGACY_INBOX_MESSAGE_TYPE = 1

export type LegacyInboxMessage = {
	type: typeof LEGACY_INBOX_MESSAGE_TYPE
	actorId: string
	signerId: string
	activity: Record<string, unknown>
	userKEK: string
	vapidKeys: unknown
}

export function legacyInboxMessage(input: {
	activity: Record<string, unknown>
	recipient: string
	signer: string
	userKek: string
	vapidKeys: unknown
}): LegacyInboxMessage {
	return {
		type: LEGACY_INBOX_MESSAGE_TYPE,
		actorId: input.recipient,
		signerId: input.signer,
		activity: input.activity,
		userKEK: input.userKek,
		vapidKeys: input.vapidKeys,
	}
}

const PERSONAL_INBOX = /^\/ap\/users\/([^/]+)\/inbox$/
const LOCAL_ACTOR = /^\/ap\/users\/[^/]+$/

// The local actor the legacy consumer runs the activity for, among the legacy instance's local accounts (`accounts`,
// usernames as stored, from the operator's snapshot; never from the request). Legacy has only personal inboxes, and its
// consumer acknowledges a message whose recipient does not exist without applying it, so an unknown recipient is never
// chosen: a personal inbox must name one of the accounts; a request to Kopje's shared inboxes goes to the first account
// the activity addresses or names as its object or target, else to the operator's fallback account. null: none.
export function legacyRecipient(
	path: string,
	activity: Record<string, unknown>,
	domain: string,
	accounts: ReadonlySet<string>,
	fallback: string | null
): string | null {
	const origin = `https://${domain}`
	const actor = (username: string) => `${origin}/ap/users/${username}`
	const personal = PERSONAL_INBOX.exec(path)?.[1]
	if (personal !== undefined) {
		return accounts.has(personal) ? actor(personal) : null
	}
	const object = activity.object
	const candidates = [
		...['to', 'cc', 'bto', 'bcc', 'audience'].flatMap((field) => listOf(activity[field])),
		...listOf(object),
		...(isObject(object) ? listOf(object.attributedTo) : []),
		...listOf(activity.target),
	]
	for (const candidate of candidates) {
		if (isLocalActor(candidate, origin)) {
			const username = new URL(candidate).pathname.slice('/ap/users/'.length)
			if (accounts.has(username)) {
				return actor(username)
			}
		}
	}
	return fallback !== null && accounts.has(fallback) ? actor(fallback) : null
}

export function isLocalActor(uri: string, origin: string): boolean {
	try {
		const url = new URL(uri)
		return url.origin === origin && LOCAL_ACTOR.test(url.pathname) && url.search === '' && url.hash === ''
	} catch {
		return false
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function listOf(value: unknown): string[] {
	const values = Array.isArray(value) ? value : [value]
	return values.flatMap((item) => {
		if (typeof item === 'string') {
			return [item]
		}
		return isObject(item) && typeof item.id === 'string' ? [item.id] : []
	})
}
