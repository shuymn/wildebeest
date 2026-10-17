// RES-2: the bounds of the profile columns a remote server controls, as ACCOUNT_COLUMNS (accounts.ts) and every other
// read that presents them take them. No imports, so modules that build SQL at load (status-presenter.ts) can use it
// whatever the import order.

// The display name, in code points as read (code units as stored, federation/remote-actor.ts).
export const DISPLAY_NAME_LIMIT = 2048
// Mastodon's remote usernames are short; Kopje refuses a longer one as stored (federation/remote-actor.ts, RES-1).
export const USERNAME_LIMIT = 255
// Profile URLs (url, avatar, header), as ACTOR_URI_LIMIT bounds actor ids; a serialized URL is ASCII.
export const PROFILE_URL_LIMIT = 2048

// SQLite's substr and length stop at an embedded NUL, so a string is cut only when its UTF-8 bytes pass the limit
// (a code point is never longer than its bytes). A string containing a NUL is kept whole while its UTF-8 bytes fit
// the limit; otherwise it may come out shorter than a cut in code units would be, never longer.
export function cutSql(column: string, limit: number): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${limit} THEN ${column} ELSE substr(${column}, 1, ${limit}) END`
}

// A stored username as every read that presents one, or derives an acct or URL from it, takes it: cut at
// USERNAME_LIMIT (a converted row may keep legacy's, of any length). Lookups compare the whole stored username.
export function usernameSql(column: string): string {
	return cutSql(column, USERNAME_LIMIT)
}

// A stored profile URL as every read that presents one takes it (ACCOUNT_COLUMNS, mentions): NULL past the bound.
export function profileUrlSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${PROFILE_URL_LIMIT} THEN ${column} END`
}
