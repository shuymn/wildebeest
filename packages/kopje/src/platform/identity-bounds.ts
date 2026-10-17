// RES-2: the bounds of the identities Kopje stores, an actor's id and a status's uri, in UTF-8 bytes, as the
// projections measure them (profile-bounds.ts actorUriSql, status-bounds.ts statusUriSql). Ingestion, the cutover's
// conversion and its verification refuse an identity past them with withinIdentityBound; an identity is never cut.
// No relative imports: the cutover runs it from the sources on Node (cli/lib/cutover/kopje-runtime.js).

export const ACTOR_URI_LIMIT = 2048
export const STATUS_URI_LIMIT = 4096

const ENCODER = new TextEncoder()

// A remote username: Mastodon's remote rule (Account::USERNAME_ONLY_RE, app/models/account.rb lines 75, 78 and 115 at
// v4.5.0; the same language as USERNAME_RE there), ASCII, at most REMOTE_USERNAME_LIMIT characters, a bound Mastodon
// does not set for remote accounts (RES-1). JavaScript's `$` without the m flag matches only at the end, unlike Ruby's,
// so a trailing newline fails as any other character outside the rule.
export const REMOTE_USERNAME_LIMIT = 255
const REMOTE_USERNAME = /^[a-z0-9_]+([a-z0-9_.-]+[a-z0-9_]+)?$/i

export function isRemoteUsername(value: string): boolean {
	return value.length <= REMOTE_USERNAME_LIMIT && REMOTE_USERNAME.test(value)
}

export function withinIdentityBound(value: string, limit: number): boolean {
	return value.length <= limit && ENCODER.encode(value).length <= limit
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
