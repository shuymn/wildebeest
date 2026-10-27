import { ACCOUNT_COLUMN_MAP, MOVED_ACCOUNT_COLUMNS } from './accounts'
import { ADMIN_EMAIL_COLUMNS, LOCAL_EMAIL_COLUMNS, OAUTH_ADMIN_HEAP_SQL } from './admin-authority'
import { QUOTE_APPROVAL_COLUMNS, QUOTE_READ_COLUMNS, quotedStatusIdSql } from './audience'
import { FILTER_MATCH_COLUMNS } from './filters'
import { OWN_VOTE_COLUMNS, ownVoteCountSql, POLL_COLUMN_MAP, POLL_FROM } from './polls'
import { actorUriSql, usernameSql } from './profile-bounds'
import { CACHED_IMAGE_COLUMNS, CACHED_IMAGE_KINDS } from './remote-media'
import {
	MAX_PRESENTED_TAGS,
	MAX_STATUS_MEDIA,
	MAX_STATUS_MENTION_ROWS,
	statusUriSql,
	tagNameSql,
} from './status-bounds'
import { balancedSum, type ColumnMap, fixedColumns, type FixedColumns, rowHeapSql } from '../db/columns'
import { ACCOUNTS_ID_INDEX, MEDIA_ID_INDEX, OAUTH_CLIENTS_ID_INDEX, STATUSES_ID_INDEX } from '../db/indexes'
import {
	appNameSql,
	appWebsiteSql,
	BLURHASH_BYTES,
	byteBoundSql,
	CARD_DIMENSION_MAX,
	CARD_EMBED_SRC_BYTES,
	CARD_IMAGE_DESCRIPTION_JSON_BYTES,
	CARD_IMAGE_EDGE_MAX,
	CARD_IMAGE_TOKEN_BYTES,
	CARD_LANGUAGE_BYTES,
	CARD_OPTIONAL_URL_LIMIT,
	CARD_TEXTS,
	CARD_TYPES,
	CARD_URL_LIMIT,
	isoTimeSql,
	storedCountSql,
} from '../platform/stored-bounds'

// hydrate's queries (status-presenter.ts) and R, statusStream's bound on one status's row heap, share these column maps
// (src/db/columns.ts), so R cannot drift from what is read (RES-3, "Heap at 8 MiB per answer" in docs/threat-model.md).

// in_reply_to_id and in_reply_to_account_id are shown as Mastodon shows them, even when the viewer may not see the
// parent: they belong to the reply, whose ActivityPub object carries inReplyTo to every recipient anyway, and its
// author chose to publish them. The parent itself (content, author profile, context entry) stays behind the audience
// rule. in_reply_to_account_id is the conversation partner carried through self-replies.
// The text and URLs are bounded as stored (platform/stored-bounds.ts), the uri and author as read (RES-2).
export const STATUS_COLUMN_MAP = {
	id: 's.id',
	uri: statusUriSql('s.uri'),
	url: 's.url',
	account_id: 's.account_id',
	reblog_of_id: 's.reblog_of_id',
	in_reply_to_id: 's.in_reply_to_id',
	in_reply_to_account_id: 's.in_reply_to_account_id',
	visibility: 's.visibility',
	spoiler_text: 's.spoiler_text',
	content: 's.content',
	source_text: 's.source_text',
	sensitive: 's.sensitive',
	language: 's.language',
	published_at: 's.published_at',
	edited_at: 's.edited_at',
	replies_count: 's.replies_count',
	reblogs_count: 's.reblogs_count',
	favourites_count: 's.favourites_count',
	quotes_count: 's.quotes_count',
	quote_policy: 's.quote_policy',
	// A boost shows no emoji of its own (its original's are in `reblog`), whatever its row holds.
	emojis: 'CASE WHEN s.reblog_of_id IS NULL THEN s.emojis END',
	author_uri: actorUriSql('au.uri'),
	author_username: usernameSql('au.username'),
	author_domain: 'au.domain',
	// The app a local status was posted through (statuses.application_id, migration 0064_status_applications), within
	// its raw bounds (stored-bounds.ts appNameSql, appWebsiteSql); none for a remote author's, whose key is absent.
	application_name: `CASE WHEN au.domain IS NULL THEN ${appNameSql('ap.name')} END`,
	application_website: `CASE WHEN au.domain IS NULL THEN ${appWebsiteSql('ap.website')} END`,
} as const satisfies ColumnMap

// Each status's app, by key: a status whose id names no app (none, or one removed) reads none.
const APPLICATION_JOIN = `LEFT JOIN oauth_clients ap INDEXED BY ${OAUTH_CLIENTS_ID_INDEX} ON ap.id = s.application_id`

// Each status, its author and its app by key (the indexes named, so statistics older than the Store's growth cannot
// turn any into a scan: RES-7).
export const STATUS_FROM = `statuses s INDEXED BY ${STATUSES_ID_INDEX}
	CROSS JOIN accounts au INDEXED BY ${ACCOUNTS_ID_INDEX} ON au.id = s.account_id
	${APPLICATION_JOIN}`

// STATUS_FROM over the ids of `keys`, a subquery whose `id` column holds each id once: each status is sought by its
// key (the index named, so statistics older than the Store's growth cannot turn the read into a scan: RES-7).
export function statusesOfSql(keys: string): string {
	return `(${keys}) g CROSS JOIN statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = g.id
		CROSS JOIN accounts au INDEXED BY ${ACCOUNTS_ID_INDEX} ON au.id = s.account_id
		${APPLICATION_JOIN}`
}

// The columns presentMedia reads, bounded as stored (platform/stored-bounds.ts), for every query that presents media,
// over media_attachments as `m`. remote: whether the attachment's account is remote, by key (the index named: RES-7);
// a file token does not say, as media kept by the cutover may have none.
export const MEDIA_COLUMN_MAP = {
	id: 'm.id',
	type: 'm.type',
	url: 'm.url',
	preview_url: 'm.preview_url',
	description: 'm.description',
	meta: 'm.meta',
	focus_x: 'm.focus_x',
	focus_y: 'm.focus_y',
	blurhash: 'm.blurhash',
	remote: `(SELECT md.domain IS NOT NULL FROM accounts md INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE md.id = m.account_id)`,
} as const satisfies ColumnMap

// The presenter's media: each attachment with its status and position, which order a status's at most
// MAX_STATUS_MEDIA attachments in JavaScript (no sort over the chunk's payload in SQLite).
export const STATUS_MEDIA_COLUMN_MAP = {
	...MEDIA_COLUMN_MAP,
	status_id: 'm.status_id',
	position: 'm.position',
} as const satisfies ColumnMap

// The shown attachments of the status `id`, at most MAX_STATUS_MEDIA, through media_attachments_status.
export function shownMediaSql(id: string): string {
	return `SELECT y.id FROM media_attachments y WHERE y.status_id = ${id} AND y.shown = 1 ORDER BY y.position
		LIMIT ${MAX_STATUS_MEDIA}`
}

export const MENTION_COLUMN_MAP = {
	status_id: 'j.value',
	id: 'a.id',
	username: usernameSql('a.username'),
	domain: 'a.domain',
	url: 'a.url',
	uri: actorUriSql('a.uri'),
} as const satisfies ColumnMap

// The accounts the status `j.value` shows as mentions, at most MAX_STATUS_MENTION_ROWS, through status_mentions_shown.
export const SHOWN_MENTIONS_SQL = `SELECT m.account_id FROM status_mentions m INDEXED BY status_mentions_shown
	WHERE m.status_id = j.value AND m.silent = 0 ORDER BY m.account_id LIMIT ${MAX_STATUS_MENTION_ROWS}`

export const TAG_COLUMN_MAP = { status_id: 'j.value', name: tagNameSql('t.name') } as const satisfies ColumnMap

// The hashtags the status `j.value` shows, at most MAX_PRESENTED_TAGS, first by name (status_tags' order).
export const SHOWN_TAGS_SQL = `t.status_id = j.value AND t.name IN (SELECT n.name FROM (SELECT ${tagNameSql('name')} AS name
	FROM status_tags WHERE status_id = j.value ORDER BY status_tags.name LIMIT ${MAX_PRESENTED_TAGS}) n
	WHERE n.name IS NOT NULL)`

// A status's attached card (status_cards, migrations 0067_status_cards and 0069_card_embeds), each column as read: text
// only (no JSON function sees a BLOB) within its raw bound, an integer only within its range (storedCountSql), so a
// row reads at most its bounds whatever was imported; the presenter judges each value again as decoded
// (stored-bounds.ts presentedCardText, presentedCardUrl, presentedEmbedSrc).
const cardText = (column: string, bytes: number) =>
	`CASE WHEN typeof(${column}) = 'text' THEN ${byteBoundSql(column, bytes)} END`
export const CARD_COLUMN_MAP = {
	status_id: 'j.value',
	url: cardText('c.url', CARD_URL_LIMIT),
	title: cardText('c.title', CARD_TEXTS.title - 2),
	description: cardText('c.description', CARD_TEXTS.description - 2),
	author_name: cardText('c.author_name', CARD_TEXTS.author_name - 2),
	author_url: cardText('c.author_url', CARD_OPTIONAL_URL_LIMIT),
	provider_name: cardText('c.provider_name', CARD_TEXTS.provider_name - 2),
	provider_url: cardText('c.provider_url', CARD_OPTIONAL_URL_LIMIT),
	language: cardText('c.language', CARD_LANGUAGE_BYTES),
	published_at: isoTimeSql('c.published_at'),
	card_type: storedCountSql('c.card_type', CARD_TYPES.video),
	width: storedCountSql('c.width', CARD_DIMENSION_MAX),
	height: storedCountSql('c.height', CARD_DIMENSION_MAX),
	embed_src: cardText('c.embed_src', CARD_EMBED_SRC_BYTES),
	iframe_width: storedCountSql('c.iframe_width', CARD_DIMENSION_MAX),
	iframe_height: storedCountSql('c.iframe_height', CARD_DIMENSION_MAX),
	// 0070_card_images: the alt text, and the stored image the card names (SHOWN_CARD_JOIN); image_url and image_id
	// are never read.
	image_description: cardText('c.image_description', CARD_IMAGE_DESCRIPTION_JSON_BYTES - 2),
	image_token: cardText('i.token', CARD_IMAGE_TOKEN_BYTES),
	image_width: storedCountSql('i.width', CARD_IMAGE_EDGE_MAX),
	image_height: storedCountSql('i.height', CARD_IMAGE_EDGE_MAX),
	blurhash: cardText('i.blurhash', BLURHASH_BYTES),
} as const satisfies ColumnMap

// The join of a card and its stored image to `j` (card_images, by its key; none while pending or gone), as `c` and
// `i`: the presenter's card query and R's term share it.
export const SHOWN_CARD_JOIN =
	'CROSS JOIN status_cards c LEFT JOIN card_images i ON i.id = c.image_id AND i.stored_at IS NOT NULL'

// The attached card of the status `j.value`, by its key: one row at most.
export const SHOWN_CARD_SQL = 'c.status_id = j.value AND c.fetched_at IS NOT NULL'

// A viewer flag: its kind (one letter) and the status's id. A status has at most one of each of the five kinds (a
// viewer keeps one boost of an original: the unique index statuses_account_reblogs_kept, which the flag reads).
export const VIEWER_FLAG_COLUMNS = fixedColumns(
	{ kind: 'f.kind', status_id: 'f.status_id' },
	{ kind: 1, status_id: 18 }
)
const VIEWER_FLAGS = 5

// Every query the presenter runs for a chunk, by the map its result columns come from (test/status-rows.test.ts
// fails on a query without one, or a column outside it). Built on first use, as statusRowBoundSql. moved: the authors'
// moved-to accounts (accounts.ts movedOf). adminEmail and localEmails: the OAuth admin's lookup for a local author's,
// or a local moved-to account's, Owner role (oauthAdmin), once per operation.
export function hydrateQueries(): Readonly<Record<HydrateQuery, ColumnMap>> {
	return {
		statuses: STATUS_COLUMN_MAP,
		cachedImages: CACHED_IMAGE_COLUMNS.columns,
		quotes: QUOTE_READ_COLUMNS.columns,
		accounts: ACCOUNT_COLUMN_MAP,
		moved: MOVED_ACCOUNT_COLUMNS.columns,
		media: STATUS_MEDIA_COLUMN_MAP,
		cards: CARD_COLUMN_MAP,
		mentions: MENTION_COLUMN_MAP,
		tags: TAG_COLUMN_MAP,
		flags: VIEWER_FLAG_COLUMNS.columns,
		approvals: QUOTE_APPROVAL_COLUMNS.columns,
		polls: POLL_COLUMN_MAP,
		votes: OWN_VOTE_COLUMNS.columns,
		filters: FILTER_MATCH_COLUMNS.columns,
		adminEmail: ADMIN_EMAIL_COLUMNS,
		localEmails: LOCAL_EMAIL_COLUMNS,
	}
}

export type HydrateQuery =
	| 'statuses'
	| 'cachedImages'
	| 'quotes'
	| 'accounts'
	| 'moved'
	| 'media'
	| 'cards'
	| 'mentions'
	| 'tags'
	| 'flags'
	| 'approvals'
	| 'polls'
	| 'votes'
	| 'filters'
	| 'adminEmail'
	| 'localEmails'

// Per-row aggregates a hydrate query may sort in a temporary B-tree, by map and column: each sorts within one stored
// value, at most one row at a time (an actor document's attachment entries, at most 2 MiB fetched and
// MAX_REMOTE_FIELDS kept; a remote account's verification times, at most REMOTE_VERIFIED_SHOWN; a poll's at most
// MAX_REMOTE_OPTIONS choices).
export const PER_ROW_SORTS: readonly { query: HydrateQuery; column: string }[] = [
	{ query: 'accounts', column: 'attachment' },
	{ query: 'accounts', column: 'remote_verified' },
	{ query: 'polls', column: 'options' },
]

// The heap of every row read for the status `x.id` (one status row of an item), summed: what each query of
// hydrateQueries() returns for it, each row by its map (rowHeapSql), or a FixedColumns constant times the rows. Its
// author's account counts once per status row, though a chunk reads it once, and so does the account it moved to
// (MOVED_ACCOUNT_COLUMNS), whether or not the author is available. A boost's own attachments, mentions,
// hashtags, poll, votes and card are not read (hydrate in status-presenter.ts), so they count for another status only.
function statusRowTerms(viewer: string, filterRows: string): string {
	const cachedImage = CACHED_IMAGE_COLUMNS.rowHeap
	const movedHeap = MOVED_ACCOUNT_COLUMNS.rowHeap + CACHED_IMAGE_KINDS.length * cachedImage
	const fixed = (columns: FixedColumns, rows: string) => `(${rows}) * ${columns.rowHeap}`
	const one = (sql: string) => `coalesce((${sql}), 0)`
	const children = balancedSum([
		one(
			`SELECT sum(${rowHeapSql(STATUS_MEDIA_COLUMN_MAP)}) FROM media_attachments m INDEXED BY ${MEDIA_ID_INDEX}
				WHERE m.id IN (${shownMediaSql('x.id')})`
		),
		one(`SELECT sum(${rowHeapSql(MENTION_COLUMN_MAP)}) FROM (SELECT x.id AS value) j
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX}
			WHERE a.id IN (${SHOWN_MENTIONS_SQL})`),
		one(`SELECT sum(${rowHeapSql(TAG_COLUMN_MAP)}) FROM (SELECT x.id AS value) j CROSS JOIN status_tags t
			WHERE ${SHOWN_TAGS_SQL}`),
		one(`SELECT ${rowHeapSql(POLL_COLUMN_MAP)} FROM ${POLL_FROM} WHERE p.status_id = x.id AND p.removed = 0`),
		one(`SELECT ${rowHeapSql(CARD_COLUMN_MAP)} FROM (SELECT x.id AS value) j ${SHOWN_CARD_JOIN}
			WHERE ${SHOWN_CARD_SQL}`),
		`CASE WHEN ${viewer} IS NULL THEN 0 ELSE ${fixed(OWN_VOTE_COLUMNS, ownVoteCountSql('x.id', viewer))} END`,
	])
	return balancedSum([
		one(`SELECT ${rowHeapSql(STATUS_COLUMN_MAP)} FROM ${STATUS_FROM} WHERE s.id = x.id`),
		fixed(QUOTE_READ_COLUMNS, '1'),
		// The author's row, and its moved-to account's at its caps, read with it; and for each remote one the cached
		// profile images the chunk reads (remote-media.ts cachedImagesOf), one row at its caps for each image URL it shows
		// (a slot matches only its account's current URL), every kind for the moved-to account.
		one(`SELECT ${rowHeapSql(ACCOUNT_COLUMN_MAP)}
				+ CASE WHEN a.domain IS NULL OR a.avatar_url IS NULL THEN 0 ELSE ${cachedImage} END
				+ CASE WHEN a.domain IS NULL OR a.header_url IS NULL THEN 0 ELSE ${cachedImage} END
				+ CASE WHEN a.moved_to_account_id IS NULL THEN 0 ELSE ${movedHeap} END
			FROM statuses w INDEXED BY ${STATUSES_ID_INDEX}
			CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = w.account_id LEFT JOIN local_accounts l ON l.account_id = a.id WHERE w.id = x.id`),
		`CASE WHEN (SELECT o.reblog_of_id FROM statuses o WHERE o.id = x.id) IS NULL THEN ${children} ELSE 0 END`,
		fixed(FILTER_MATCH_COLUMNS, filterRows),
		`CASE WHEN ${viewer} IS NULL THEN 0 ELSE ${balancedSum([
			fixed(VIEWER_FLAG_COLUMNS, String(VIEWER_FLAGS)),
			fixed(QUOTE_APPROVAL_COLUMNS, '1'),
		])} END`,
	])
}

let boundSql: string | undefined

// R of each status of ?1 (a JSON list of top-level ids, one item each), for the viewer ?2 (NULL: anonymous), ?3 of
// whose active filters name statuses: one row per position (`k`, json_each's key) with `bytes`. An item reads at
// most these status rows: the status, its boosted original, and the quoted status of the status or, for a boost, of
// its original (a boost has no quote of its own: R35); each counted whether or not the viewer is shown it. Every
// subquery is a search by key or through the index the presenter's query uses, but M: an item with a local author, or
// an author moved to a local account, also counts the OAuth admin's lookup whole (OAUTH_ADMIN_HEAP_SQL, a scan of the
// operator-sized local_accounts, evaluated once per statement and only when such an item is read), which an operation
// reads at most once, in whichever chunk first shows an available local account.
export function statusRowBoundSql(): string {
	// Built on first use: the maps come from modules that import this one's importers.
	boundSql ??= `WITH t AS (SELECT key AS k, value AS id FROM json_each(?1)),
		x(k, id) AS (SELECT k, id FROM t
			UNION ALL SELECT t.k, b.reblog_of_id FROM t CROSS JOIN statuses b INDEXED BY ${STATUSES_ID_INDEX} ON b.id = t.id
				WHERE b.reblog_of_id IS NOT NULL
			UNION ALL SELECT k, id FROM (SELECT t.k, ${quotedStatusIdSql('coalesce(b.reblog_of_id, b.id)')} AS id
				FROM t CROSS JOIN statuses b INDEXED BY ${STATUSES_ID_INDEX} ON b.id = t.id) WHERE id IS NOT NULL)
		SELECT x.k, sum(${statusRowTerms('?2', '?3')})
			+ max(CASE WHEN (SELECT a.domain IS NULL OR coalesce((SELECT m.domain IS NULL
						FROM accounts m INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE m.id = a.moved_to_account_id), 0)
					FROM statuses w INDEXED BY ${STATUSES_ID_INDEX}
					CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = w.account_id WHERE w.id = x.id)
				THEN ${OAUTH_ADMIN_HEAP_SQL} ELSE 0 END) AS bytes
		FROM x GROUP BY x.k`
	return boundSql
}
