// RES-2: the stored bounds of the columns a remote server controls or a converted row may carry. Each column has a
// projection P, the SQL builder below that every read applies, and a writer that ingestion, the local write paths, the
// cutover's conversion and its verification apply. Every writer's output, as SQLite stores it, is a fixed point of
// the column's P, and P(P(x)) = P(x) for any stored string (test/stored-bounds.test.ts).
//
// Text writers replace a lone surrogate with U+FFFD and remove U+0000 (storedText), then cut by code points, as
// SQLite's substr and length count them. JSON-bounded columns (bio, content, content warning, source text) keep the
// writers of security/html.ts, applied to storedText's output.
//
// No relative imports: the cutover runs it from the sources on Node (cli/lib/cutover/kopje-runtime.js). The JSON
// bounds of security/html.ts and the status URI bound of identity-bounds.ts are therefore repeated here;
// test/stored-bounds.test.ts pins them equal.

// Display names, in code points.
export const DISPLAY_NAME_LIMIT = 2048
// Profile URLs (url, avatar, header), in UTF-8 bytes; a serialized URL is ASCII.
export const PROFILE_URL_LIMIT = 2048
// A status's url, in UTF-8 bytes, as identity-bounds.ts STATUS_URI_LIMIT bounds its uri.
export const STATUS_URL_LIMIT = 4096
// A media URL (url, preview_url), in UTF-8 bytes.
export const MEDIA_URL_LIMIT = 2048
// A media row's meta, in UTF-8 bytes: the stored dimensions ({"original":{...},"small":{...}}) take about 80.
export const MEDIA_META_BYTES = 1024
// A media description, in code points, as Mastodon's MAX_DESCRIPTION_HARD_LENGTH_LIMIT.
export const MAX_MEDIA_DESCRIPTION_LENGTH = 10_000
// A poll's choices (RES-4): at most this many, each at most this many code points as read.
export const MAX_REMOTE_OPTIONS = 100
export const MAX_REMOTE_OPTION_LENGTH = 1000
// polls.options as its CHECK bounds it (migration 0013), in UTF-8 bytes; an edit's poll_options past it reads as none.
export const POLL_OPTIONS_BYTES = 655_360
// The JSON-string bounds of security/html.ts (REMOTE_BIO_BYTES, STATUS_CONTENT_BYTES, SPOILER_BYTES), in UTF-8 bytes
// of the escaped string with its quotes.
export const BIO_JSON_BYTES = 64 * 1024
export const CONTENT_JSON_BYTES = 128 * 1024
export const SPOILER_JSON_BYTES = 16 * 1024

// ---- Projections (P)

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

// A NULL past `bytes` UTF-8 bytes.
function byteBoundSql(column: string, bytes: number): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${bytes} THEN ${column} END`
}

// accounts.display_name: cut at DISPLAY_NAME_LIMIT code points.
export function displayNameSql(column: string): string {
	return cutSql(column, DISPLAY_NAME_LIMIT)
}

// accounts.note: '' past BIO_JSON_BYTES as a JSON string.
export function noteSql(column: string): string {
	return jsonBoundSql(column, BIO_JSON_BYTES, "''")
}

// accounts.url, avatar_url and header_url: NULL past PROFILE_URL_LIMIT.
export function profileUrlSql(column: string): string {
	return byteBoundSql(column, PROFILE_URL_LIMIT)
}

// statuses.content and status_edits.content: '' past CONTENT_JSON_BYTES as a JSON string. The status keeps its url,
// which links its original.
export function contentSql(column: string): string {
	return jsonBoundSql(column, CONTENT_JSON_BYTES, "''")
}

// statuses.source_text: '' past CONTENT_JSON_BYTES (a local one is at most 10,000 code units, 60 KB escaped).
export function sourceTextSql(column: string): string {
	return jsonBoundSql(column, CONTENT_JSON_BYTES, "''")
}

// statuses.spoiler_text and status_edits.spoiler_text: past SPOILER_JSON_BYTES, cut to the code points that fit
// however they escape (6 bytes each at most), so the warning stays.
export function spoilerSql(column: string): string {
	return jsonBoundSql(column, SPOILER_JSON_BYTES, `substr(${column}, 1, ${Math.floor((SPOILER_JSON_BYTES - 2) / 6)})`)
}

// statuses.url: NULL past STATUS_URL_LIMIT, so it reads as its uri.
export function statusUrlSql(column: string): string {
	return byteBoundSql(column, STATUS_URL_LIMIT)
}

// media_attachments.url and preview_url: NULL past MEDIA_URL_LIMIT, as an invalid one. url is NOT NULL, so its
// writer stores '' instead, which presentMedia shows as null.
export function mediaUrlSql(column: string): string {
	return byteBoundSql(column, MEDIA_URL_LIMIT)
}

// media_attachments.description: cut at MAX_MEDIA_DESCRIPTION_LENGTH code points.
export function mediaDescriptionSql(column: string): string {
	return cutSql(column, MAX_MEDIA_DESCRIPTION_LENGTH)
}

// media_attachments.meta: NULL past MEDIA_META_BYTES, as no meta.
export function mediaMetaSql(column: string): string {
	return byteBoundSql(column, MEDIA_META_BYTES)
}

// A poll's choices (polls.options, status_edits.poll_options) as a JSON array: the first MAX_REMOTE_OPTIONS, each cut
// at MAX_REMOTE_OPTION_LENGTH (cutSql); NULL (no poll) past POLL_OPTIONS_BYTES. A stored choice is longer only in a
// converted row; a vote names it as stored (polls.ts cut_options). An edit's snapshot stores P of the poll's choices,
// evaluated inside SQLite (statuses.ts recordEdit).
export function pollOptionsSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${POLL_OPTIONS_BYTES} THEN
		(SELECT json_group_array(${cutSql('value', MAX_REMOTE_OPTION_LENGTH)} ORDER BY key) FROM json_each(${column})
			WHERE key < ${MAX_REMOTE_OPTIONS}) END`
}

// ---- Writers

const ENCODER = new TextEncoder()

// `value` when its UTF-8 bytes as SQLite stores it are at most `bytes` (a lone surrogate takes three bytes, as U+FFFD
// or as workerd binds it), else none.
function withinBytes(value: string | null, bytes: number): string | null {
	return value !== null && ENCODER.encode(value).length <= bytes ? value : null
}

// Text as stored: well-formed and without U+0000. workerd binds a lone surrogate as its three-byte surrogate encoding,
// which reads back as three U+FFFD; replaced first, it is one U+FFFD either way. Mastodon's JSON parsing refuses
// invalid UTF-8, so nothing it would keep is lost. PostgreSQL text cannot hold U+0000, so Mastodon never stores one;
// SQLite's substr and length stop at it.
export function storedText(text: string): string {
	const wellFormed = text.toWellFormed()
	return wellFormed.includes('\u0000') ? wellFormed.replaceAll('\u0000', '') : wellFormed
}

// The first `limit` code points of `text`. A string has at least as many code units as code points.
function cutCodePoints(text: string, limit: number): string {
	if (text.length <= limit) {
		return text
	}
	let points = 0
	let end = 0
	for (const char of text) {
		if (points === limit) {
			return text.slice(0, end)
		}
		points++
		end += char.length
	}
	return text
}

// accounts.display_name as stored: storedText's output, at most DISPLAY_NAME_LIMIT code points.
export function storedDisplayName(text: string): string {
	return cutCodePoints(storedText(text), DISPLAY_NAME_LIMIT)
}

// media_attachments.description as stored: storedText's output, at most MAX_MEDIA_DESCRIPTION_LENGTH code points.
export function storedMediaDescription(text: string): string {
	return cutCodePoints(storedText(text), MAX_MEDIA_DESCRIPTION_LENGTH)
}

// accounts.url, avatar_url and header_url as stored: none past PROFILE_URL_LIMIT.
export function storedProfileUrl(url: string | null): string | null {
	return withinBytes(url, PROFILE_URL_LIMIT)
}

// statuses.url as stored: none past STATUS_URL_LIMIT.
export function storedStatusUrl(url: string | null): string | null {
	return withinBytes(url, STATUS_URL_LIMIT)
}

// media_attachments.preview_url as stored, and a media URL where none is a value: none past MEDIA_URL_LIMIT.
export function storedMediaLink(url: string | null): string | null {
	return withinBytes(url, MEDIA_URL_LIMIT)
}

// media_attachments.url as stored (NOT NULL): '' past MEDIA_URL_LIMIT. A row with a file token holds a URL Kopje
// built (platform/media-files.ts mediaUrl), always within it.
export function storedMediaUrl(url: string): string {
	return storedMediaLink(url) ?? ''
}

// media_attachments.meta as stored: none past MEDIA_META_BYTES.
export function storedMediaMeta(meta: string | null): string | null {
	return withinBytes(meta, MEDIA_META_BYTES)
}
