import { cutSql, jsonBoundSql } from './profile-bounds'
import { STATUS_URI_LIMIT } from '../platform/identity-bounds'
import { SPOILER_BYTES, STATUS_CONTENT_BYTES } from '../security/html'

// RES-2: the bounds of one presented status. Each column a remote server controls, or a converted row may carry past
// the ingestion bounds, is bounded where it is stored (federation/remote-status.ts, remote-statuses.ts, statuses.ts)
// and again as a presenter reads it, through its helper here (test-node/bounded-columns.test.ts), so a row stored
// before a bound, or converted at the cutover, leaves SQLite within it too. The resulting maxima of a presented
// status and of the shapes built from it are in docs/threat-model.md (RES-3). Like profile-bounds.ts, it imports only
// leaves, so modules that build SQL at load can use it whatever the import order.

// Attachments of one status, as Mastodon caps them (Status::MEDIA_ATTACHMENTS_LIMIT).
export const MAX_STATUS_MEDIA = 4
// Hashtags of one status, each at most this many code units as stored and code points as read (and 1 KiB).
export const MAX_STATUS_TAGS = 100
// Hashtags one status presents, the first by name (the order they are stored in). Mastodon presents every tag; this
// cap keeps one status within its share of an answer, far above the few a post carries in practice (a 500-character
// Mastodon post names at most about 250). The content's HTML keeps every hashtag link.
export const MAX_PRESENTED_TAGS = 70
export const MAX_TAG_LENGTH = 256
const TAG_NAME_BYTES = 1024
// status_mentions rows of one remote status, and mentions one status presents.
export const MAX_STATUS_MENTION_ROWS = 200
// A media description, as Mastodon's MAX_DESCRIPTION_HARD_LENGTH_LIMIT (code units as stored, code points as read).
export const MAX_MEDIA_DESCRIPTION_LENGTH = 10_000
// A media URL (url, preview_url), as profile URLs; a serialized URL is ASCII.
export const MEDIA_URL_LIMIT = 2048
// A media row's meta: the stored dimensions ({"original":{...},"small":{...}}), about 80 bytes.
const MEDIA_META_BYTES = 1024
// A status's uri and url, as a remote one is stored (status-text.ts MAX_URL_LENGTH).
const STATUS_URL_LIMIT = STATUS_URI_LIMIT
// A remote poll's choices (RES-4), and an edit's: at most this many, each at most this many code units as stored and
// code points as read.
export const MAX_REMOTE_OPTIONS = 100
export const MAX_REMOTE_OPTION_LENGTH = 1000
// polls.options as its CHECK bounds it (migration 0013); an edit's poll_options past it reads as none.
const POLL_OPTIONS_BYTES = 655_360
// An edit's media snapshot (status_edits.media_json, presented media of MAX_STATUS_MEDIA attachments as JSON): each
// at most a 10,000-unit description escaped (60,000 bytes), two URLs of a row stored before MEDIA_URL_LIMIT (4,096
// each), its meta and keys. Past it, the snapshot reads as no media.
const EDIT_MEDIA_BYTES = MAX_STATUS_MEDIA * 72 * 1024

// A status's content (statuses and status_edits): '' past STATUS_CONTENT_BYTES as a JSON string. The status keeps its
// url, which links its original.
export function contentSql(column: string): string {
	return jsonBoundSql(column, STATUS_CONTENT_BYTES, "''")
}

// A local status's source text: '' past STATUS_CONTENT_BYTES (a local one is at most 10,000 code units, 60 KB escaped).
export function sourceTextSql(column: string): string {
	return jsonBoundSql(column, STATUS_CONTENT_BYTES, "''")
}

// A content warning (statuses and status_edits): past SPOILER_BYTES, cut to the code points that fit however they
// escape (6 bytes each at most), so the warning stays.
export function spoilerSql(column: string): string {
	return jsonBoundSql(column, SPOILER_BYTES, `substr(${column}, 1, ${Math.floor((SPOILER_BYTES - 2) / 6)})`)
}

// A status's url: NULL past STATUS_URL_LIMIT, so it reads as its uri.
export function statusUrlSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${STATUS_URL_LIMIT} THEN ${column} END`
}

// A status's uri as a presenter reads it: '' past STATUS_URL_LIMIT. Only a converted row can hold a longer one, and
// the cutover refuses it (docs/cutover.md); it is an identity, so it is never cut into another status's (as
// actorUriSql).
export function statusUriSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${STATUS_URL_LIMIT} THEN ${column} ELSE '' END`
}

// A media URL: NULL past MEDIA_URL_LIMIT, as an invalid one.
export function mediaUrlSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${MEDIA_URL_LIMIT} THEN ${column} END`
}

export function mediaDescriptionSql(column: string): string {
	return cutSql(column, MAX_MEDIA_DESCRIPTION_LENGTH)
}

// A media row's meta: NULL past MEDIA_META_BYTES, as no meta.
export function mediaMetaSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${MEDIA_META_BYTES} THEN ${column} END`
}

// A hashtag name: NULL past MAX_TAG_LENGTH code points or TAG_NAME_BYTES, and such a tag is not presented (a cut name
// would name another tag).
export function tagNameSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${TAG_NAME_BYTES} AND length(${column}) <= ${MAX_TAG_LENGTH}
	THEN ${column} END`
}

// A poll's choices (polls.options, status_edits.poll_options) as a JSON array: the first MAX_REMOTE_OPTIONS, each cut
// at MAX_REMOTE_OPTION_LENGTH (cutSql); NULL (no poll) past POLL_OPTIONS_BYTES. A stored choice is longer only in a
// converted row; a vote names it as stored (polls.ts cut_options).
export function pollOptionsSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${POLL_OPTIONS_BYTES} THEN
		(SELECT json_group_array(${cutSql('value', MAX_REMOTE_OPTION_LENGTH)} ORDER BY key) FROM json_each(${column})
			WHERE key < ${MAX_REMOTE_OPTIONS}) END`
}

// An edit's media snapshot as a JSON array: its first MAX_STATUS_MEDIA entries, each rebuilt as a MediaAttachment
// whose columns are bounded as a stored attachment's are (mediaUrlSql, mediaDescriptionSql, mediaMetaSql; the id and
// type cut at SNAPSHOT_KEY_LIMIT); an entry that is not an object is left out; '[]' past EDIT_MEDIA_BYTES.
const SNAPSHOT_KEY_LIMIT = 32
export function editMediaSql(column: string): string {
	const text = (key: string) => `(CASE WHEN json_type(value, '$.${key}') = 'text' THEN value ->> '$.${key}' END)`
	const meta = `(CASE WHEN json_type(value, '$.meta') = 'object' THEN value -> '$.meta' END)`
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${EDIT_MEDIA_BYTES} THEN
		(SELECT json_group_array(json_object('id', ${cutSql(text('id'), SNAPSHOT_KEY_LIMIT)},
			'type', ${cutSql(text('type'), SNAPSHOT_KEY_LIMIT)}, 'url', ${mediaUrlSql(text('url'))},
			'preview_url', ${mediaUrlSql(text('preview_url'))}, 'remote_url', NULL, 'preview_remote_url', NULL,
			'text_url', NULL, 'meta', json(${mediaMetaSql(meta)}), 'description', ${mediaDescriptionSql(text('description'))},
			'blurhash', NULL) ORDER BY key)
		FROM json_each(${column}) WHERE key < ${MAX_STATUS_MEDIA} AND type = 'object') ELSE '[]' END`
}
