import { REMOTE_BIO_BYTES } from '../security/html'

// RES-2: the bounds of the profile columns a remote server controls, as ACCOUNT_COLUMNS (accounts.ts) and every other
// read that presents them take them. Each bounded column is read through its helper here (test-node/
// bounded-columns.test.ts). It imports only the leaf security/html.ts, so modules that build SQL at load
// (status-presenter.ts) can use it whatever the import order.

// The display name, in code points as read (code units as stored, federation/remote-actor.ts).
export const DISPLAY_NAME_LIMIT = 2048
// Mastodon's remote usernames are short; Kopje refuses a longer one as stored (federation/remote-actor.ts, RES-1).
export const USERNAME_LIMIT = 255
// Profile URLs (url, avatar, header), as ACTOR_URI_LIMIT bounds actor ids; a serialized URL is ASCII.
export const PROFILE_URL_LIMIT = 2048
// Actor ids, as stored (federation/remote-actor.ts, RES-6).
export const ACTOR_URI_LIMIT = 2048

// SQLite's substr and length stop at an embedded NUL, so a string is cut only when its UTF-8 bytes pass the limit
// (a code point is never longer than its bytes). A string containing a NUL is kept whole while its UTF-8 bytes fit
// the limit; otherwise it may come out shorter than a cut in code units would be, never longer.
export function cutSql(column: string, limit: number): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${limit} THEN ${column} ELSE substr(${column}, 1, ${limit}) END`
}

// `column` when its JSON string (json_quote: quotes and escapes, as JSON.stringify writes them) is at most `bytes`
// UTF-8 bytes, else `over`. json_quote measures it only below the raw bound, so its escaped copy stays far below
// SQLite's largest string.
export function jsonBoundSql(column: string, bytes: number, over: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) > ${bytes} THEN ${over}
	WHEN length(CAST(json_quote(${column}) AS BLOB)) > ${bytes} THEN ${over} ELSE ${column} END`
}

// A stored username as every read that presents one, or derives an acct or URL from it, takes it: cut at
// USERNAME_LIMIT (a converted row may keep legacy's, of any length). Lookups compare the whole stored username.
export function usernameSql(column: string): string {
	return cutSql(column, USERNAME_LIMIT)
}

// A stored display name, cut at DISPLAY_NAME_LIMIT code points.
export function displayNameSql(column: string): string {
	return cutSql(column, DISPLAY_NAME_LIMIT)
}

// A stored bio: '' when it is over REMOTE_BIO_BYTES as a JSON string (a row stored before the bound or converted).
export function noteSql(column: string): string {
	return jsonBoundSql(column, REMOTE_BIO_BYTES, "''")
}

// A stored profile URL as every read that presents one takes it (ACCOUNT_COLUMNS, mentions): NULL past the bound.
export function profileUrlSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${PROFILE_URL_LIMIT} THEN ${column} END`
}

// A stored actor id as a presenter reads it: '' past ACTOR_URI_LIMIT. Only a converted row can hold a longer one, and
// the cutover refuses it (docs/cutover.md); it is an identity, so it is never cut into another actor's id. A presenter
// derives only a profile URL's origin from it (accountUrl), which for '' falls back to this instance's /@acct page.
// Lookups, deliveries and ActivityPub documents compare or send the whole stored id.
export function actorUriSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${ACTOR_URI_LIMIT} THEN ${column} ELSE '' END`
}
