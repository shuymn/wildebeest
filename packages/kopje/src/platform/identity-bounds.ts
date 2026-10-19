// RES-2: the bounds of the identities Kopje stores, an actor's id and a status's uri, in UTF-8 bytes as JSON writes
// them (escapes included), which bounds the bytes the projections measure too (profile-bounds.ts actorUriSql,
// status-bounds.ts statusUriSql) and what an identity adds to a presented unit. Ingestion, the cutover's conversion
// and its verification refuse an identity past them with withinIdentityBound; an identity is never cut.
// No relative imports: the cutover runs it from the sources on Node (cli/lib/cutover/kopje-runtime.js).

export const ACTOR_URI_LIMIT = 2048
export const STATUS_URI_LIMIT = 4096
// An activity id Kopje stores: a Like id (favourite_likes.uri, migration 0052_favourite_likes) and a Flag id
// (reports.uri, migration 0054_remote_reports), each held by a CHECK for imports too; bounded as a status's uri is.
// Mastodon sets no bound; the inbox's body bound is 1 MiB.
export const ACTIVITY_ID_LIMIT = 4096

// The accounts a local status addresses at most (its mentions that are not silent, which its Note's to or cc lists
// and its Create repeats): with each actor id within ACTOR_URI_LIMIT, its Create stays within an outbox page's byte
// bound (RES-3, docs/threat-model.md "Maxima of presented units"). A post names at most about 170 within its 500
// characters; the cutover's conversion refuses a legacy status past it rather than drop any of them.
export const MAX_LOCAL_ADDRESSED = 1000

const ENCODER = new TextEncoder()

// A remote username: Mastodon's remote format (Account::USERNAME_ONLY_RE, app/models/account.rb:75,78,115, v4.5.0;
// same language as USERNAME_RE), ASCII, capped at REMOTE_USERNAME_LIMIT (RES-1); Mastodon sets no remote cap.
// Without the m flag, JavaScript's `$` matches only the string end, unlike Ruby's, so a trailing newline fails.
export const REMOTE_USERNAME_LIMIT = 255
const REMOTE_USERNAME = /^[a-z0-9_]+([a-z0-9_.-]+[a-z0-9_]+)?$/i

export function isRemoteUsername(value: string): boolean {
	return value.length <= REMOTE_USERNAME_LIMIT && REMOTE_USERNAME.test(value)
}

export function withinIdentityBound(value: string, limit: number): boolean {
	return value.length <= limit && ENCODER.encode(JSON.stringify(value)).length - 2 <= limit
}

// Whether an actor id is one Kopje stores: a URL whose serialized form (what ingestion reads from the actor document,
// federation/remote-actor.ts) is within ACTOR_URI_LIMIT, and whose spelling as stored is too (the cutover keeps
// legacy's spelling, which the projection measures).
export function isStorableActorId(id: string): boolean {
	let href: string
	try {
		href = new URL(id).href
	} catch {
		return false
	}
	return withinIdentityBound(href, ACTOR_URI_LIMIT) && withinIdentityBound(id, ACTOR_URI_LIMIT)
}
