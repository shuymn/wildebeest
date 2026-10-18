import { ACCOUNT_COLUMN_MAP } from './accounts'
import { QUOTE_APPROVAL_COLUMNS, QUOTE_READ_COLUMNS } from './audience'
import { FILTER_MATCH_COLUMNS } from './filters'
import { OWN_VOTE_COLUMNS, POLL_COLUMN_MAP, POLL_FROM } from './polls'
import { actorUriSql, profileUrlSql, usernameSql } from './profile-bounds'
import {
	contentSql,
	MAX_PRESENTED_TAGS,
	MAX_STATUS_MEDIA,
	MAX_STATUS_MENTION_ROWS,
	mediaDescriptionSql,
	mediaMetaSql,
	mediaUrlSql,
	sourceTextSql,
	spoilerSql,
	statusUriSql,
	statusUrlSql,
	tagNameSql,
} from './status-bounds'
import { balancedSum, type ColumnMap, fixedColumns, type FixedColumns, rowBytesSql } from '../db/columns'

// The rows the status presenter reads (hydrate in status-presenter.ts), each query's result columns as one column map
// (src/db/columns.ts), and R: an upper bound on the payload, in SQLite bytes, that the rows of one status of an answer
// take, generated from the same maps, which statusStream plans its chunks by (RES-3, "Heap at 8 MiB per answer" in
// docs/threat-model.md).

// in_reply_to_id and in_reply_to_account_id are shown as Mastodon shows them, even when the viewer may not see the
// parent: they belong to the reply, whose ActivityPub object carries inReplyTo to every recipient anyway, and its
// author chose to publish them. The parent itself (content, author profile, context entry) stays behind the audience
// rule. in_reply_to_account_id is the conversation partner carried through self-replies.
// The text and URLs are bounded (status-bounds.ts, RES-2).
export const STATUS_COLUMN_MAP = {
	id: 's.id',
	uri: statusUriSql('s.uri'),
	url: statusUrlSql('s.url'),
	account_id: 's.account_id',
	reblog_of_id: 's.reblog_of_id',
	in_reply_to_id: 's.in_reply_to_id',
	in_reply_to_account_id: 's.in_reply_to_account_id',
	visibility: 's.visibility',
	spoiler_text: spoilerSql('s.spoiler_text'),
	content: contentSql('s.content'),
	source_text: sourceTextSql('s.source_text'),
	sensitive: 's.sensitive',
	language: 's.language',
	published_at: 's.published_at',
	edited_at: 's.edited_at',
	replies_count: 's.replies_count',
	reblogs_count: 's.reblogs_count',
	favourites_count: 's.favourites_count',
	quotes_count: 's.quotes_count',
	quote_policy: 's.quote_policy',
	author_uri: actorUriSql('au.uri'),
	author_username: usernameSql('au.username'),
	author_domain: 'au.domain',
} as const satisfies ColumnMap

export const STATUS_FROM = 'statuses s JOIN accounts au ON au.id = s.account_id'

// The columns presentMedia reads, bounded (status-bounds.ts), for every query that presents media, over
// media_attachments as `m`.
export const MEDIA_COLUMN_MAP = {
	id: 'm.id',
	type: 'm.type',
	url: mediaUrlSql('m.url'),
	preview_url: mediaUrlSql('m.preview_url'),
	description: mediaDescriptionSql('m.description'),
	meta: mediaMetaSql('m.meta'),
	focus_x: 'm.focus_x',
	focus_y: 'm.focus_y',
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

// A mention of the status `j.value`: the mentioned account's id, username, domain and URLs.
export const MENTION_COLUMN_MAP = {
	status_id: 'j.value',
	id: 'a.id',
	username: usernameSql('a.username'),
	domain: 'a.domain',
	url: profileUrlSql('a.url'),
	uri: actorUriSql('a.uri'),
} as const satisfies ColumnMap

// The accounts the status `j.value` shows as mentions, at most MAX_STATUS_MENTION_ROWS, through status_mentions_shown.
export const SHOWN_MENTIONS_SQL = `SELECT m.account_id FROM status_mentions m INDEXED BY status_mentions_shown
	WHERE m.status_id = j.value AND m.silent = 0 ORDER BY m.account_id LIMIT ${MAX_STATUS_MENTION_ROWS}`

// A hashtag of the status `j.value`.
export const TAG_COLUMN_MAP = { status_id: 'j.value', name: tagNameSql('t.name') } as const satisfies ColumnMap

// The hashtags the status `j.value` shows, at most MAX_PRESENTED_TAGS, first by name (status_tags' order).
export const SHOWN_TAGS_SQL = `t.status_id = j.value AND t.name IN (SELECT n.name FROM (SELECT ${tagNameSql('name')} AS name
	FROM status_tags WHERE status_id = j.value ORDER BY status_tags.name LIMIT ${MAX_PRESENTED_TAGS}) n
	WHERE n.name IS NOT NULL)`

// A viewer flag: its kind (one letter) and the status's id. A status has at most one of each kind but `r` (the
// viewer's boosts of it, which nothing makes unique).
export const VIEWER_FLAG_COLUMNS = fixedColumns(
	{ kind: 'f.kind', status_id: 'f.status_id' },
	{ kind: 1, status_id: 18 }
)
const SINGLE_FLAGS = 4

// Every query the presenter runs for a chunk, by the map its result columns come from (test/status-rows.test.ts
// fails on a query without one, or a column outside it).
export const HYDRATE_QUERIES: Readonly<Record<string, ColumnMap>> = {
	statuses: STATUS_COLUMN_MAP,
	quotes: QUOTE_READ_COLUMNS.columns,
	accounts: ACCOUNT_COLUMN_MAP,
	media: STATUS_MEDIA_COLUMN_MAP,
	mentions: MENTION_COLUMN_MAP,
	tags: TAG_COLUMN_MAP,
	flags: VIEWER_FLAG_COLUMNS.columns,
	approvals: QUOTE_APPROVAL_COLUMNS.columns,
	polls: POLL_COLUMN_MAP,
	votes: OWN_VOTE_COLUMNS.columns,
	filters: FILTER_MATCH_COLUMNS.columns,
}

// Per-row aggregates a hydrate query may sort in a temporary B-tree, by map and column: each sorts within one stored
// value, at most one row at a time (an actor document's attachment entries, at most 2 MiB fetched and
// MAX_REMOTE_FIELDS kept; a poll's at most MAX_REMOTE_OPTIONS choices).
export const PER_ROW_SORTS: readonly { query: keyof typeof HYDRATE_QUERIES; column: string }[] = [
	{ query: 'accounts', column: 'attachment' },
	{ query: 'polls', column: 'options' },
]

// The payload of every row read for the status `x.id` (one status row of an item), summed: what each query of
// HYDRATE_QUERIES returns for it, each row by its map (rowBytesSql), or a FixedColumns constant times the rows. Its
// author's account counts once per status row, though a chunk reads it once.
function statusRowTerms(viewer: string, filterRows: string): string {
	const fixed = (columns: FixedColumns, rows: string) => `(${rows}) * ${columns.rowBytes}`
	const one = (sql: string) => `coalesce((${sql}), 0)`
	return balancedSum([
		one(`SELECT ${rowBytesSql(STATUS_COLUMN_MAP)} FROM ${STATUS_FROM} WHERE s.id = x.id`),
		fixed(QUOTE_READ_COLUMNS, '1'),
		one(`SELECT ${rowBytesSql(ACCOUNT_COLUMN_MAP)} FROM statuses w JOIN accounts a ON a.id = w.account_id
			LEFT JOIN local_accounts l ON l.account_id = a.id WHERE w.id = x.id`),
		one(
			`SELECT sum(${rowBytesSql(STATUS_MEDIA_COLUMN_MAP)}) FROM media_attachments m WHERE m.id IN (${shownMediaSql('x.id')})`
		),
		one(`SELECT sum(${rowBytesSql(MENTION_COLUMN_MAP)}) FROM (SELECT x.id AS value) j CROSS JOIN accounts a
			WHERE a.id IN (${SHOWN_MENTIONS_SQL})`),
		one(`SELECT sum(${rowBytesSql(TAG_COLUMN_MAP)}) FROM (SELECT x.id AS value) j CROSS JOIN status_tags t
			WHERE ${SHOWN_TAGS_SQL}`),
		one(`SELECT ${rowBytesSql(POLL_COLUMN_MAP)} FROM ${POLL_FROM} WHERE p.status_id = x.id AND p.removed = 0`),
		fixed(FILTER_MATCH_COLUMNS, filterRows),
		`CASE WHEN ${viewer} IS NULL THEN 0 ELSE ${balancedSum([
			fixed(
				VIEWER_FLAG_COLUMNS,
				`${SINGLE_FLAGS} + (SELECT count(*) FROM statuses WHERE account_id = ${viewer} AND reblog_of_id = x.id)`
			),
			fixed(QUOTE_APPROVAL_COLUMNS, '1'),
			fixed(
				OWN_VOTE_COLUMNS,
				`SELECT count(*) FROM polls p JOIN poll_votes v ON v.poll_id = p.status_id AND v.generation = p.generation
					AND v.account_id = ${viewer} WHERE p.status_id = x.id`
			),
		])} END`,
	])
}

let boundSql: string | undefined

// R of each status of ?1 (a JSON list of top-level ids, one item each), for the viewer ?2 (NULL: anonymous) whose
// active filters naming statuses are ?3: one row per position (`k`, json_each's key) with `bytes`. An item reads at
// most these status rows: the status, its boosted original, and the quoted status of the status or, for a boost, of
// its original (a boost has no quote of its own: R35); each counted whether or not the viewer is shown it. Every
// subquery is a search by key or through the index the presenter's query uses.
export function statusRowBoundSql(): string {
	// Built on first use: the maps come from modules that import this one's importers.
	boundSql ??= `WITH t AS (SELECT key AS k, value AS id FROM json_each(?1)),
		x(k, id) AS (SELECT k, id FROM t
			UNION ALL SELECT t.k, b.reblog_of_id FROM t JOIN statuses b ON b.id = t.id WHERE b.reblog_of_id IS NOT NULL
			UNION ALL SELECT t.k, q.quoted_status_id FROM t JOIN statuses b ON b.id = t.id
				JOIN quotes q ON q.status_id = coalesce(b.reblog_of_id, b.id) WHERE q.quoted_status_id IS NOT NULL)
		SELECT x.k, sum(${statusRowTerms('?2', '?3')}) AS bytes FROM x GROUP BY x.k`
	return boundSql
}
