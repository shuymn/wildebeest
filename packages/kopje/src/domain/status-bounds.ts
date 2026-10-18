import { STATUS_URI_LIMIT } from '../platform/identity-bounds'
import { cutSql, mediaDescriptionSql, mediaMetaSql, mediaUrlSql } from '../platform/stored-bounds'

// RES-2: the bounds of one presented status. Columns a remote server controls, or a converted row may carry, are
// bounded where stored (federation/remote-status.ts, remote-statuses.ts, statuses.ts) and again on every read through
// these helpers (test-node/bounded-columns.test.ts). Maxima: docs/threat-model.md, RES-3. Like profile-bounds.ts, this
// imports only leaves, so modules that build SQL at load can use it whatever the import order. The stored bounds and
// their projections live in platform/stored-bounds.ts.

export {
	contentSql,
	MAX_MEDIA_DESCRIPTION_LENGTH,
	MAX_REMOTE_OPTION_LENGTH,
	MAX_REMOTE_OPTIONS,
	MEDIA_URL_LIMIT,
	mediaDescriptionSql,
	mediaMetaSql,
	mediaUrlSql,
	pollOptionsSql,
	sourceTextSql,
	spoilerSql,
	statusUrlSql,
} from '../platform/stored-bounds'

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
// An edit's media snapshot (status_edits.media_json, presented media of MAX_STATUS_MEDIA attachments as JSON): each
// at most a 10,000-unit description escaped (60,000 bytes), two URLs of a row stored before MEDIA_URL_LIMIT (4,096
// each), its meta and keys. Past it, the snapshot reads as no media.
const EDIT_MEDIA_BYTES = MAX_STATUS_MEDIA * 72 * 1024

// A status's uri as a presenter reads it: '' past STATUS_URI_LIMIT. Only a converted row can hold a longer one, and
// the cutover refuses it (docs/cutover.md); it is an identity, so it is never cut into another status's (as
// actorUriSql).
export function statusUriSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${STATUS_URI_LIMIT} THEN ${column} ELSE '' END`
}

// A hashtag name: NULL past MAX_TAG_LENGTH code points or TAG_NAME_BYTES, and such a tag is not presented (a cut name
// would name another tag).
export function tagNameSql(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${TAG_NAME_BYTES} AND length(${column}) <= ${MAX_TAG_LENGTH}
	THEN ${column} END`
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
