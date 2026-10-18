import { ACTOR_URI_LIMIT, REMOTE_USERNAME_LIMIT } from '../platform/identity-bounds'
import { cutSql } from '../platform/stored-bounds'

// RES-2: the bounds of the profile columns a remote server controls, as ACCOUNT_COLUMN_MAP (accounts.ts) and every
// other read that presents them take them. Each bounded column is read through its helper here (test-node/
// bounded-columns.test.ts). It imports only leaves (platform/identity-bounds.ts, platform/stored-bounds.ts), so modules
// that build SQL at load (status-rows.ts) can use it whatever the import order. The stored bounds and their
// projections live in platform/stored-bounds.ts.

export {
	cutSql,
	DISPLAY_NAME_LIMIT,
	displayNameSql,
	noteSql,
	PROFILE_URL_LIMIT,
	profileUrlSql,
} from '../platform/stored-bounds'
// Mastodon's remote usernames are short; Kopje refuses a longer one as stored (federation/remote-actor.ts, RES-1).
export const USERNAME_LIMIT = REMOTE_USERNAME_LIMIT
// Actor ids, as stored (federation/remote-actor.ts, RES-6), in UTF-8 bytes.
export { ACTOR_URI_LIMIT }

// A stored username as every read that presents one, or derives an acct or URL from it, takes it. One the Worker
// stores is ASCII of Mastodon's remote format (federation/remote-actor.ts), so its JSON is its length: cut at
// USERNAME_LIMIT. Any other (a row converted before the cutover refused such usernames) is cut at
// NONCONFORMING_USERNAME_LIMIT code points; a code point escapes to at most six bytes, so its JSON is at most
// USERNAME_LIMIT bytes plus the quotes. The fast path needs every byte to be a character (length counts characters
// up to an embedded NUL, so a NUL or a non-ASCII byte makes the two differ) and none outside the format (GLOB, which
// also stops at a NUL). Lookups compare the whole stored username.
const NONCONFORMING_USERNAME_LIMIT = Math.floor(USERNAME_LIMIT / 6)
export function usernameSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) = length(${column}) AND ${column} NOT GLOB '*[^A-Za-z0-9_.-]*'
	THEN ${cutSql(column, USERNAME_LIMIT)} ELSE substr(${column}, 1, ${NONCONFORMING_USERNAME_LIMIT}) END`
}

// A stored actor id as a presenter reads it: '' past ACTOR_URI_LIMIT. Only a converted row can hold a longer one, and
// the cutover refuses it (docs/cutover.md); it is an identity, so it is never cut into another actor's id. A presenter
// derives only a profile URL's origin from it (accountUrl), which for '' falls back to this instance's /@acct page.
// Lookups, deliveries and ActivityPub documents compare or send the whole stored id.
export function actorUriSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${ACTOR_URI_LIMIT} THEN ${column} ELSE '' END`
}
