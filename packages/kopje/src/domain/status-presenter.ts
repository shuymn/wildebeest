import { type Account, accountsOf, accountUrl, acctOf, type Present } from './accounts'
import { admit, type Admitted, jsonBytes } from './answer-budget'
import {
	type ApiQuoteState,
	apiVisibility,
	type ApiVisibility,
	conversationMutedSql,
	type OwnStatusId,
	type QuotePolicyFlag,
	quoteApprovalReads,
	quotePolicyFlags,
	type QuoteRead,
	quoteReads,
	requiresMention,
	type ViewerContext,
	type Visibility,
	type VisibleStatusId,
	visibleSql,
} from './audience'
import { type CustomEmoji, presentEmojis } from './custom-emojis'
import {
	type ActiveFilters,
	activeFilters,
	applyFilters,
	type FilterResult,
	filterStatusMatches,
	filterTextLevel,
	MAX_FILTER_REQUEST_TEXT,
	MAX_FILTER_TEXT,
} from './filters'
import { htmlToPlainText } from './plain-text'
import { type Poll, presentPolls, withStatusEmojis } from './polls'
import { MEDIA_URL_JSON_BYTES, MEDIA_URL_LIMIT } from './status-bounds'
import {
	CARD_COLUMN_MAP,
	MENTION_COLUMN_MAP,
	SHOWN_CARD_JOIN,
	SHOWN_CARD_SQL,
	SHOWN_MENTIONS_SQL,
	SHOWN_TAGS_SQL,
	shownMediaSql,
	STATUS_COLUMN_MAP,
	statusesOfSql,
	STATUS_MEDIA_COLUMN_MAP,
	statusRowBoundSql,
	TAG_COLUMN_MAP,
	VIEWER_FLAG_COLUMNS,
} from './status-rows'
import { TREND_LANGUAGES } from './trends'
import { selectSql } from '../db/columns'
import { ACCOUNTS_ID_INDEX, MEDIA_ID_INDEX, STATUSES_ID_INDEX } from '../db/indexes'
import { type Db, RowCapExceeded, RowMeter } from '../db/sql'
import { boundedHref } from '../platform/http-url'
import { FILE_TOKEN, mediaUrl } from '../platform/media-files'
import { railsBlank } from '../platform/rails-blank'
import {
	CARD_IMAGE_DESCRIPTION_JSON_BYTES,
	CARD_IMAGE_URL_BYTES,
	CARD_OPTIONAL_URL_LIMIT,
	CARD_TEXTS,
	CARD_TYPES,
	embedSrcAttribute,
	isAppWebsite,
	isIsoTime,
	presentedAppName,
	presentedCardText,
	presentedCardUrl,
	presentedEmbedSrc,
	STATUS_EMOJIS_BYTES,
	storedBlurhash,
} from '../platform/stored-bounds'
import { remotePlainText } from '../security/html'

// The Status entity as Mastodon 4.0.2's REST::StatusSerializer shows it. One presenter for every read path: it takes
// a list of ids and the viewer and reads the related rows kind by kind (statuses and reblogged originals, accounts,
// media, mentions, tags, viewer flags, polls), each in one query over json_each, so the rows read grow with the page
// only.
// It takes only ids the policy module (domain/audience.ts) made: VisibleStatusId, which a read rule passed for the
// viewer, or OwnStatusId, the viewer's own, for the response to their write. A boost's original is read through the
// read rule for the same viewer, whichever the boost's id: a boost the viewer may see stands only with an original
// they may see, and their own boost of an original they may no longer see is shown without it (reblog: null).
// A quote (R35, quoteReads in audience.ts) is shown one level deep, as Mastodon's REST::StatusSerializer and
// ShallowStatusSerializer: a status's `quote` embeds the quoted status, when the viewer is shown it, as a full status
// for the same viewer (its flags, filters, media and poll), whose own `quote` is a ShallowQuote (the state and the id
// of the status it quotes). The quotes are read twice, for the statuses and their originals, then for the quoted
// statuses, each one query over json_each, never along a chain. A boost shows its original's quote in its `reblog`
// and has none of its own, as Mastodon never gives a reblog a quote (a quote row attached to a boost row is not read).
// For a signed-in viewer every status carries `filtered` (REST::StatusSerializer, StatusRelationshipsPresenter): the
// viewer's active filters that match it, whatever their context and action, as CustomFilter.apply_cached_filters finds
// them (filters.ts); a boost and its original carry the same. Nothing is left out for a filter: the client decides by
// context.

export type MediaSize = { width: number; height: number; size: string; aspect: number }

export type MediaMeta = { original?: MediaSize; small?: MediaSize; focus?: { x: number; y: number } }

export type MediaAttachment = {
	id: string
	type: string
	url: string | null
	preview_url: string | null
	remote_url: string | null
	preview_remote_url: string | null
	text_url: null
	meta: MediaMeta | null
	description: string | null
	blurhash: string | null
}

export type Mention = { id: string; username: string; url: string; acct: string }

export type Tag = { name: string; url: string }

// Mastodon's Quote, with the quoted status embedded, and ShallowQuote, with its id.
export type Quote = { state: ApiQuoteState; quoted_status: Status | null }

export type ShallowQuote = { state: ApiQuoteState; quoted_status_id: string | null }

// Mastodon's QuoteApproval (REST::StatusSerializer#quote_approval): the flags of the status's automatic and manual
// policy, and what the policy answers the viewer. Ice Cubes decodes all three fields, and current_user only as one of
// these four values, or drops the whole status.
export type QuoteApproval = {
	automatic: QuotePolicyFlag[]
	manual: QuotePolicyFlag[]
	current_user: 'automatic' | 'manual' | 'unknown' | 'denied'
}

// Mastodon's REST::PreviewCardSerializer (v4.5.11) (domain/link-cards.ts): its type, dimensions and, for a video, the
// iframe html (CARD_IFRAME); its stored image (domain/card-images.ts) on the instance origin, with its blurhash and
// alt text; no embed_url (AM2: '', which Mastodon's web client never reads); its authors (PreviewCard#authors: one
// when the name or the URL is not blank) without an account.
export type PreviewCard = {
	url: string
	title: string
	description: string
	language: string | null
	type: 'link' | 'photo' | 'video'
	author_name: string
	author_url: string
	provider_name: string
	provider_url: string
	html: string
	width: number
	height: number
	image: string | null
	image_description: string
	embed_url: ''
	blurhash: string | null
	published_at: string | null
	authors: { name: string; url: string; account: null }[]
}

// The most JSON a presented card takes (RES-3), from the bounds of stored-bounds.ts at the worst escaping: every text
// at its JSON bound, the url at CARD_URL_LIMIT, the author's and provider's URLs at CARD_OPTIONAL_URL_LIMIT (the
// author's twice, in authors), mn-Mong and a time, "video", both dimensions at CARD_DIMENSION_MAX, the iframe html
// at its src's escaped bound and both dimensions, the image URL at CARD_IMAGE_URL_BYTES, a blurhash at BLURHASH_BYTES
// and the alt text at CARD_IMAGE_DESCRIPTION_JSON_BYTES (test/link-cards.test.ts derives it). A status shows at most one (its
// own, or its boost's original's), in place of null: a quoted status shows none, where Mastodon's
// ShallowStatusSerializer shows its card (docs/mastodon-deviations.md, "Link previews"), so a status with its quote
// stays within RES-3's budgets.
export const CARD_JSON_MAX = 9_899

// Mastodon's REST::StatusSerializer application (ApplicationSerializer): the app a local status was posted through.
export type StatusApplication = { name: string; website: string | null }

export type Status = {
	id: string
	created_at: string
	in_reply_to_id: string | null
	in_reply_to_account_id: string | null
	sensitive: boolean
	spoiler_text: string
	visibility: ApiVisibility
	language: string | null
	uri: string
	url: string | null
	replies_count: number
	reblogs_count: number
	favourites_count: number
	quotes_count: number
	edited_at: string | null
	favourited?: boolean
	reblogged?: boolean
	muted?: boolean
	bookmarked?: boolean
	pinned?: boolean
	filtered?: FilterResult[]
	content?: string
	text?: string
	reblog: Status | null
	application?: StatusApplication | null
	account: Account
	media_attachments: MediaAttachment[]
	mentions: Mention[]
	tags: Tag[]
	emojis: CustomEmoji[]
	quote: Quote | ShallowQuote | null
	quote_approval: QuoteApproval
	card: PreviewCard | null
	poll: Poll | null
}

export type StatusRow = {
	id: string
	uri: string
	url: string | null
	account_id: string
	reblog_of_id: string | null
	in_reply_to_id: string | null
	in_reply_to_account_id: string | null
	visibility: Visibility
	spoiler_text: string
	content: string
	source_text: string | null
	sensitive: number
	language: string | null
	published_at: string
	edited_at: string | null
	replies_count: number
	reblogs_count: number
	favourites_count: number
	quotes_count: number
	quote_policy: number
	emojis: string | null
	author_uri: string
	author_username: string
	author_domain: string | null
	application_name: string | null
	application_website: string | null
}

// viewer: the viewer (accountId null: anonymous) and the request time, which a poll's expiry is judged at.
export type PresentOptions = Present & { viewer: ViewerContext }

export type PresentOwnOptions = PresentOptions & {
	// DELETE answers with the source text (`text`) in place of `content`, for redrafting, and with the quoted status of
	// a quote in any state when the viewer may see it (quoteReads): on the deleted status only, never on a boost's
	// original.
	source?: boolean
}

export type MediaRow = {
	id: string
	type: string
	url: string | null
	preview_url: string | null
	description: string
	meta: string | null
	focus_x: number
	focus_y: number
	blurhash: string | null
	// 1 when the attachment's account is remote (MEDIA_COLUMN_MAP).
	remote: number
}
type MentionRow = {
	status_id: string
	id: string
	username: string
	domain: string | null
	url: string | null
	uri: string
}

// One presentation per answer (RES-3): the viewer's active filters, compiled once, and the level the shared filter text
// allowance (MAX_FILTER_REQUEST_TEXT, filterTextLimits) cuts each matched text at, computed once over the answer's
// candidates, so an answer presented in chunks matches each status as one presented whole would. When the
// presentation is cut by the answer budget, the level is the candidates', a superset of what is shown.
export type Presentation = {
	readonly options: PresentOwnOptions
	readonly filters: ActiveFilters | null
	readonly level: number
	// The filter results of each quoted status matched so far, by its id: a quoted status counts once in the level's
	// allowance however many statuses of the answer quote it, so it is matched once (results only, no rows, are kept).
	readonly quoted: Map<string, FilterResult[]>
	// The same for each status of the answer, by its id: an answer that presents a status again (a grouped page's
	// re-admission pass) matches it once.
	readonly top: Map<string, FilterResult[]>
	// The code units of text matched against the keywords so far, at most MAX_FILTER_REQUEST_TEXT.
	readonly matched: { units: number }
}

// The presentation of an answer whose statuses are among `candidates` (top-level ids, boosts and quotes are followed
// as the presenter follows them).
export function presentation(db: Db, candidates: readonly VisibleStatusId[], options: PresentOptions): Presentation {
	return presentationOf(db, candidates, options)
}

function presentationOf(db: Db, candidates: readonly string[], options: PresentOwnOptions): Presentation {
	const filters = activeFilters(db, options.viewer)
	const keywords = filters !== null && filters.filters.some((filter) => filter.keywords !== null)
	return {
		options,
		filters,
		level: keywords ? textLevel(db, candidates, options) : Infinity,
		quoted: new Map(),
		top: new Map(),
		matched: { units: 0 },
	}
}

// The preparation pass of the filter text level over present()'s targets: each status (its original for a boost) and
// each quoted status, read as ids first when they may pass the allowance. With keyword filters, their searchable text
// (content, source, poll choices, media descriptions) is read in chunks of TEXT_CHUNK statuses, each dropped once
// measured: SQL cannot measure searchableText's plain text, and the level must be the one presenting all at once
// gives. Memory is one chunk; work is bounded by the candidate caps (a context's 8,192), not by the answer budget.
const TEXT_CHUNK = 4

function textLevel(db: Db, ids: readonly string[], options: PresentOwnOptions): number {
	// A status adds at most two targets: its quoted status and its boosted original's.
	if (3 * ids.length * MAX_FILTER_TEXT <= MAX_FILTER_REQUEST_TEXT) {
		return Infinity
	}
	const { byId, quoted } = statusGraph(db, ids, options, idRows)
	const proper = (id: string): string | undefined => {
		const row = byId.get(id)
		return row?.reblog_of_id == null ? row?.id : byId.get(row.reblog_of_id)?.id
	}
	const targets = [...ids, ...quoted].map(proper)
	if (targets.length * MAX_FILTER_TEXT <= MAX_FILTER_REQUEST_TEXT) {
		return Infinity
	}
	const unique = [...new Set(targets.flatMap((id) => id ?? []))]
	const lengths = new Map<string, number>()
	for (let next = 0; next < unique.length; next += TEXT_CHUNK) {
		const chunk = unique.slice(next, next + TEXT_CHUNK)
		const json = JSON.stringify(chunk)
		const polls = presentPolls(db, chunk, null, options.viewer.now)
		const media = mediaOf(db, json)
		for (const row of db.all<TextRow & { id: string }>(
			`SELECT s.id, s.spoiler_text, s.content, s.source_text, au.domain AS author_domain
			FROM ${statusesOfSql(STATUS_KEYS)}`,
			json
		)) {
			lengths.set(row.id, searchableText(row, polls.get(row.id), media.get(row.id) ?? []).length)
		}
	}
	return filterTextLevel(targets.map((id) => (id === undefined ? 0 : Math.min(lengths.get(id) ?? 0, MAX_FILTER_TEXT))))
}

type GraphRow = { id: string; reblog_of_id: string | null }

// The ids of ?1 (a JSON list), each once, as `id`.
const STATUS_KEYS = 'SELECT DISTINCT value AS id FROM json_each(?1)'

// The statuses of `keys` (statusesOfSql) with their columns, those for which `where` holds.
function statusRows(db: Db, keys: string, where: string, ...params: SqlStorageValue[]): StatusRow[] {
	return db.all<StatusRow>(
		`SELECT ${selectSql(STATUS_COLUMN_MAP)} FROM ${statusesOfSql(keys)} WHERE ${where}`,
		...params
	)
}

function idRows(db: Db, keys: string, where: string, ...params: SqlStorageValue[]): GraphRow[] {
	return db.all<GraphRow>(`SELECT s.id, s.reblog_of_id FROM ${statusesOfSql(keys)} WHERE ${where}`, ...params)
}

// The rows an answer of `ids` presents, read by `rows`: the statuses, the originals of the boosts among them that the
// viewer may see, and the quoted statuses of both that the viewer is shown (R35), with the quotes of all of them.
// The originals are looked up through their boosts' rows, by key, each once and apart from `ids` (own = 0), so the
// visibility rule applies to them alone.
function statusGraph<R extends GraphRow>(
	db: Db,
	ids: readonly string[],
	options: PresentOwnOptions,
	rows: (db: Db, keys: string, where: string, ...params: SqlStorageValue[]) => R[]
): { byId: Map<string, R>; quotes: Map<string, QuoteRead>; quoted: string[] } {
	const byId = new Map(
		rows(
			db,
			`SELECT DISTINCT value AS id, 1 AS own FROM json_each(?1)
			UNION ALL SELECT DISTINCT value, 0 FROM (SELECT b.reblog_of_id AS value FROM json_each(?1) j
				CROSS JOIN statuses b INDEXED BY ${STATUSES_ID_INDEX} ON b.id = j.value WHERE b.reblog_of_id IS NOT NULL)
			WHERE value NOT IN (SELECT value FROM json_each(?1))`,
			`g.own = 1 OR ${visibleSql('s', '?2')}`,
			JSON.stringify(ids),
			options.viewer.accountId
		).map((row) => [row.id, row])
	)
	// A boost has no quote of its own (R35: its original's is shown in `reblog`), so only other statuses' are read.
	const quoting = (from: Iterable<R>) => [...from].flatMap((row) => (row.reblog_of_id === null ? [row.id] : []))
	const reads = quoteReads(options.viewer)
	const quotes = new Map(
		reads.of(db, quoting(byId.values()), options.source === true ? ids : []).map((quote) => [quote.status_id, quote])
	)
	const quoted = [...new Set([...quotes.values()].flatMap((quote) => quote.quoted_status_id ?? []))]
	const unread = quoted.filter((id) => !byId.has(id))
	if (unread.length > 0) {
		const added = rows(db, STATUS_KEYS, 'true', JSON.stringify(unread))
		for (const row of added) {
			byId.set(row.id, row)
		}
		for (const quote of reads.of(db, quoting(added))) {
			quotes.set(quote.status_id, quote)
		}
	}
	return { byId, quotes, quoted }
}

// statusStream's chunk target and RowMeter cap, in bytes of row heap. R (status-rows.ts), R_WINDOW, the fallback of a
// chunk of several past its cap and the uncapped single status: "Heap at 8 MiB per answer" in docs/threat-model.md.
export type ChunkPlan = { readonly target: number; readonly cap: number }

// Pages, contexts, search, histories and lookups: 448 KiB of heap, so a timeline's peak with the backstop fired stays
// within half of the Store isolate (docs/threat-model.md, the peaks table, which test/status-bounds.test.ts computes).
// Target and cap are equal: a chunk planned within the target never fires the backstop.
export const PAGE_CHUNKS: ChunkPlan = { target: 448 * 1024, cap: 448 * 1024 }
// Grouped notifications and admin reports, which keep the most besides their statuses: 1 MiB.
export const LARGE_ITEM_CHUNKS: ChunkPlan = { target: 1024 * 1024, cap: 1024 * 1024 }

// R is read for at most this many statuses at a time (a page's limit), and a chunk lies within one window.
const R_WINDOW = 80

// RES-3: admit over statusStream; each status is one atomic item with its boosted original and quoted status. An id
// with nothing to show is consumed.
export function presentStatusesWithin(
	db: Db,
	shared: Presentation,
	ids: readonly VisibleStatusId[],
	budget: number,
	leading: boolean,
	chunks: ChunkPlan | number = PAGE_CHUNKS
): Admitted<Status> {
	return admit(statusStream(db, shared, ids, chunks), budget, leading)
}

// The statuses of `ids` in order, each presented when reached under one presentation, undefined for an id with nothing
// to show; past what its consumer kept it holds one chunk of rows. A ChunkPlan is metered; a number (a test comparing
// chunked with whole presentation) reads that many at a time unmetered. Chunks do not change what is presented.
export function* statusStream(
	db: Db,
	shared: Presentation,
	ids: readonly VisibleStatusId[],
	chunks: ChunkPlan | number = PAGE_CHUNKS
): Generator<Status | undefined, undefined> {
	const planned = typeof chunks === 'number' ? fixedChunks(ids, chunks) : plannedChunks(db, shared, ids, chunks.target)
	for (const chunk of planned) {
		let at: ((id: string) => Status | undefined) | null = null
		if (typeof chunks === 'number' || chunk.length === 1) {
			at = hydrate(db, chunk, shared, false)
		} else {
			try {
				at = hydrate(db.metered(new RowMeter(chunks.cap)), chunk, shared, false)
			} catch (error) {
				if (!(error instanceof RowCapExceeded)) {
					throw error
				}
				console.warn({ event: 'kopje.presenter.row-cap-exceeded', ids: chunk })
			}
		}
		for (const id of chunk) {
			yield at === null ? hydrate(db, [id], shared, false)(id) : at(id)
		}
	}
}

function* fixedChunks(ids: readonly string[], size: number): Generator<string[]> {
	for (let next = 0; next < ids.length; next += size) {
		yield ids.slice(next, next + size)
	}
}

// Consecutive statuses of `ids` whose R sums to at most `target`, at least one, R read a window of R_WINDOW statuses at
// a time as the stream reaches it; a chunk never spans two windows.
function* plannedChunks(db: Db, shared: Presentation, ids: readonly string[], target: number): Generator<string[]> {
	const filterRows = shared.filters?.filters.filter((filter) => filter.hasStatuses).length ?? 0
	for (let next = 0; next < ids.length; next += R_WINDOW) {
		const window = ids.slice(next, next + R_WINDOW)
		const bounds = statusRowBounds(db, window, shared.options.viewer.accountId, filterRows)
		let chunk: string[] = []
		let sum = 0
		for (const [i, id] of window.entries()) {
			const bytes = bounds[i] ?? 0
			if (chunk.length > 0 && sum + bytes > target) {
				yield chunk
				chunk = []
				sum = 0
			}
			chunk.push(id)
			sum += bytes
		}
		if (chunk.length > 0) {
			yield chunk
		}
	}
}

function statusRowBounds(db: Db, ids: readonly string[], viewer: string | null, filterRows: number): number[] {
	const bounds = Array.from(ids, () => 0)
	for (const row of db.all<{ k: number; bytes: number }>(
		statusRowBoundSql(),
		JSON.stringify(ids),
		viewer,
		filterRows
	)) {
		bounds[row.k] = row.bytes
	}
	return bounds
}

// One status, bounded as a unit (RES-3, "Maxima of presented units").
export function presentStatus(db: Db, id: VisibleStatusId, options: PresentOptions): Status | null {
	return present(db, [id], presentationOf(db, [id], options), false)[0] ?? null
}

// The viewer's own status, for the response to their write; a boost of an original they may not see has reblog: null.
export function presentOwnStatus(db: Db, id: OwnStatusId, options: PresentOwnOptions): Status | null {
	return present(db, [id], presentationOf(db, [id], options), true)[0] ?? null
}

const STATUS_IDS = 'SELECT DISTINCT value FROM json_each(?1)'

// The shown attachments of each status of `ids` (a JSON list), at most MAX_STATUS_MEDIA, through
// media_attachments_status (see present()), each status's by position, then each read by its key (RES-7).
function mediaOf(db: Db, ids: string): Map<string, MediaRow[]> {
	const rows = db.all<MediaRow & { status_id: string; position: number }>(
		`SELECT ${selectSql(STATUS_MEDIA_COLUMN_MAP)} FROM media_attachments m INDEXED BY ${MEDIA_ID_INDEX}
		WHERE m.id IN (SELECT x.id FROM (${STATUS_IDS}) j CROSS JOIN media_attachments x ON x.id IN (${shownMediaSql('j.value')}))`,
		ids
	)
	return groupBy(rows.sort((a, b) => a.position - b.position || byCodePoints(a.id, b.id)))
}

type TextRow = Pick<StatusRow, 'spoiler_text' | 'content' | 'source_text' | 'author_domain'>

// Status#searchable_text of a status: its spoiler text, its text (a local status's source, a remote one's HTML as
// text), its poll's choices and its media descriptions (SearchConcern).
// A status without a poll has no entry for it (compact), not an empty one.
function searchableText(row: TextRow, poll: Poll | undefined, media: readonly MediaRow[]): string {
	return [
		row.spoiler_text,
		row.author_domain === null ? (row.source_text ?? htmlToPlainText(row.content)) : remotePlainText(row.content),
		...(poll === undefined ? [] : [poll.options.map((option) => option.title).join('\n\n')]),
		media.map((m) => m.description).join('\n\n'),
	].join('\n\n')
}

// The statuses in the order of `ids`, undefined for an id with no row or a boost left out.
function present(db: Db, ids: readonly string[], shared: Presentation, own: boolean): (Status | undefined)[] {
	if (ids.length === 0) {
		return []
	}
	const at = hydrate(db, ids, shared, own)
	return ids.map(at)
}

// The rows of the statuses of `ids`, read kind by kind, and the presenter of each of them: a status is presented (and
// matched against the filters) only when asked for.
function hydrate(
	db: Db,
	ids: readonly string[],
	shared: Presentation,
	own: boolean
): (id: string) => Status | undefined {
	const { options, filters } = shared
	const viewerId = options.viewer.accountId
	// The statuses, the originals of the boosts among them that the viewer may see, the quotes of both (R35), and the
	// quoted statuses the viewer is shown with their own quotes.
	const { byId, quotes, quoted } = statusGraph(db, ids, options, statusRows)
	const all = JSON.stringify([...byId.keys()])
	// A boost shows no attachments, mentions, hashtags or poll of its own, as Mastodon's reblog wrapper (its original's
	// are in `reblog`), so they are read for the other statuses only; a legacy boost row may hold some.
	const notBoosts = [...byId.values()].filter((row) => row.reblog_of_id === null).map((row) => row.id)
	const notBoostsJson = JSON.stringify(notBoosts)
	// The statuses matched by filters: each status of the response, and each quoted status shown in it.
	const targets = [
		...ids.map((id) => ({ key: id, row: byId.get(id), matched: shared.top.has(id) })),
		...quoted.map((id) => ({ key: quotedKey(id), row: byId.get(id), matched: shared.quoted.has(id) })),
	]
	// The authors of the chunk's statuses, their originals and quoted statuses.
	const authors = [...new Set([...byId.values()].map((row) => row.account_id))]
	const presented = accountsOf(db, authors, options, Math.max(authors.length, 1))
	const accounts = new Map(
		authors.flatMap((id) => presented.next().value ?? []).map((account) => [account.id, account])
	)
	// At most MAX_STATUS_MEDIA attachments, MAX_STATUS_MENTION_ROWS mentions and MAX_PRESENTED_TAGS hashtags of each
	// status (each status once), cut in SQL: a converted row may hold more. Each cap reads at most that many rows of
	// the status through an index that holds only the rows it shows: media_attachments_status (shown attachments by
	// position), status_mentions_shown (mentions that are not silent, migration 0047) and status_tags (names). A
	// hashtag name past its bound (tagNameSql) among the first ones read is left out rather than replaced by a later
	// one, so a status holding one shows one fewer: a remote status stores none, and a local one (a name over 256 code
	// units, which Mastodon also records) only when it sorts before more than MAX_PRESENTED_TAGS others. Each status's
	// rows are put in order in JavaScript (by position, account id and name), so no query sorts the chunk's payload.
	const media = mediaOf(db, notBoostsJson)
	const mentions = groupBy(
		db
			.all<MentionRow>(
				`SELECT ${selectSql(MENTION_COLUMN_MAP)} FROM (${STATUS_IDS}) j
				CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE a.id IN (${SHOWN_MENTIONS_SQL})`,
				notBoostsJson
			)
			.sort((a, b) => byCodePoints(a.id, b.id))
	)
	// The attached card of each status but a boost (one row at most, by its key).
	// A quoted status shows none (presentCard), so only the statuses and the boosts' originals are read.
	const carded = new Set(ids.flatMap((id) => [id, byId.get(id)?.reblog_of_id ?? []].flat()))
	const cards = new Map(
		db
			.all<CardRow>(
				`SELECT ${selectSql(CARD_COLUMN_MAP)} FROM (${STATUS_IDS}) j ${SHOWN_CARD_JOIN} WHERE ${SHOWN_CARD_SQL}`,
				JSON.stringify(notBoosts.filter((id) => carded.has(id)))
			)
			.map((card) => [card.status_id, card])
	)
	const tags = groupBy(
		db
			.all<{ status_id: string; name: string }>(
				`SELECT ${selectSql(TAG_COLUMN_MAP)} FROM (${STATUS_IDS}) j CROSS JOIN status_tags t WHERE ${SHOWN_TAGS_SQL}`,
				notBoostsJson
			)
			.sort((a, b) => byCodePoints(a.name, b.name))
	)
	const flags = viewerFlags(db, viewerId, all)
	// R36 for the viewer, of every status presented by its own row (a boost answers denied: its original's is shown).
	const approvals = quoteApprovalReads(options.viewer).of(db, [...byId.keys()])
	const polls = presentPolls(db, notBoosts, viewerId, options.viewer.now)
	const statusMatches =
		filters === null ? new Map<string, Set<string>>() : filterStatusMatches(db, filters, [...byId.keys()])
	// The text each status is matched on, cut at the presentation's level (filterTextLimits): read only when a filter
	// has keywords.
	const texts = new Map<string, { text: string; cut: number }>()
	if (filters !== null && filters.filters.some((filter) => filter.keywords !== null)) {
		targets.forEach(({ key, row, matched }) => {
			if (matched) {
				return
			}
			const proper = row?.reblog_of_id == null ? row : byId.get(row.reblog_of_id)
			const text = proper === undefined ? '' : searchableText(proper, polls.get(proper.id), media.get(proper.id) ?? [])
			// A cut inside a surrogate pair moves back to the pair's start, so the code point after it is whole.
			const limit = Math.min(text.length, MAX_FILTER_TEXT, shared.level)
			const unit = text.charCodeAt(limit)
			const cut = limit > 0 && limit < text.length && unit >= 0xdc00 && unit <= 0xdfff ? limit - 1 : limit
			// The code point after a cut is kept for the boundary after a match, so the cut is not taken for one.
			const next = cut < text.length ? String.fromCodePoint(text.codePointAt(cut) ?? 0) : ''
			texts.set(key, { text: text.slice(0, cut) + next, cut })
		})
	}

	const presentRow = (
		row: StatusRow,
		kind: 'top' | 'reblog' | 'quoted',
		filtered: FilterResult[] = []
	): Status | undefined => {
		const account = accounts.get(row.account_id)
		if (account === undefined) {
			return undefined
		}
		const top = kind === 'top'
		let reblog: Status | null = null
		const cached = kind === 'quoted' ? shared.quoted.get(row.id) : top ? shared.top.get(row.id) : undefined
		if (cached !== undefined) {
			filtered = cached
		} else if (kind !== 'reblog' && filters !== null) {
			const proper = row.reblog_of_id === null ? row : byId.get(row.reblog_of_id)
			if (proper !== undefined) {
				const text = texts.get(top ? row.id : quotedKey(row.id)) ?? { text: '', cut: 0 }
				shared.matched.units += text.cut
				filtered = applyFilters(filters, statusMatches, {
					...text,
					ids: row.reblog_of_id === null ? [row.id] : [row.id, row.reblog_of_id],
				})
			}
			if (kind === 'quoted') {
				shared.quoted.set(row.id, filtered)
			} else if (top) {
				shared.top.set(row.id, filtered)
			}
		}
		if (row.reblog_of_id !== null) {
			const original = kind === 'quoted' ? undefined : byId.get(row.reblog_of_id)
			if (original !== undefined) {
				reblog = presentRow(original, 'reblog', filtered) ?? null
				if (reblog === null) {
					return undefined
				}
			} else if (!(top && own)) {
				return undefined
			}
		}
		const read = quotes.get(row.id)
		let quote: Quote | ShallowQuote | null = null
		if (read !== undefined) {
			if (kind === 'quoted') {
				quote = { state: read.state, quoted_status_id: read.quoted_status_id }
			} else {
				const target = read.quoted_status_id === null ? undefined : byId.get(read.quoted_status_id)
				quote = {
					state: read.state,
					quoted_status: target === undefined ? null : (presentQuoted(target) ?? null),
				}
			}
		}
		// A boost shows its original's policy (Status#proper); a boost whose original the viewer may not see shows its
		// own row's, which is always 0, and denied.
		const proper = (row.reblog_of_id === null ? row : byId.get(row.reblog_of_id)) ?? row
		const policy = proper.quote_policy
		const visibility = apiVisibility(row.visibility)
		const viewer =
			viewerId === null
				? {}
				: {
						favourited: flags.favourited.has(row.id),
						reblogged: flags.reblogged.has(row.id),
						muted: flags.muted.has(row.id),
						bookmarked: flags.bookmarked.has(row.id),
						// Only on an own status that may be pinned (REST::StatusSerializer#pinnable?: not a boost, and
						// public, unlisted or private).
						...(row.account_id === viewerId && row.reblog_of_id === null && !requiresMention(row.visibility)
							? { pinned: flags.pinned.has(row.id) }
							: {}),
						filtered,
					}
		const emojis = presentEmojis(row.emojis, STATUS_EMOJIS_BYTES)
		const poll = polls.get(row.id)
		const body =
			top && options.source === true
				? { text: row.source_text ?? htmlToPlainText(row.content) }
				: { content: row.content }
		return {
			id: row.id,
			created_at: row.published_at,
			in_reply_to_id: row.in_reply_to_id,
			in_reply_to_account_id: row.in_reply_to_account_id,
			sensitive: row.sensitive === 1,
			spoiler_text: row.spoiler_text,
			visibility,
			language: row.language,
			uri: row.uri,
			url: statusUrl(row),
			replies_count: row.replies_count,
			reblogs_count: row.reblogs_count,
			favourites_count: row.favourites_count,
			quotes_count: row.quotes_count,
			edited_at: row.edited_at,
			...viewer,
			...body,
			reblog,
			...(row.author_domain === null ? { application: presentApplication(row) } : {}),
			account,
			media_attachments: (media.get(row.id) ?? []).map(presentMedia),
			mentions: (mentions.get(row.id) ?? []).map((m) => ({
				id: m.id,
				username: m.username,
				url: accountUrl(m, options.origin),
				acct: acctOf(m),
			})),
			tags: (tags.get(row.id) ?? []).map((t) => ({
				name: t.name,
				url: `${options.origin}/tags/${encodeURIComponent(t.name)}`,
			})),
			emojis,
			quote,
			quote_approval: {
				automatic: quotePolicyFlags(policy, 'automatic'),
				manual: quotePolicyFlags(policy, 'manual'),
				current_user: approvals.get(proper.id) ?? 'denied',
			},
			card: row.reblog_of_id === null && kind !== 'quoted' ? presentCard(row, cards.get(row.id), options.origin) : null,
			poll: poll === undefined ? null : withStatusEmojis(poll, emojis),
		}
	}
	// A quoted status is presented once however many statuses of the response quote it: its presentation depends on its
	// row, the viewer and its own matched text (quotedKey) alone.
	const embedded = new Map<string, Status | undefined>()
	const presentQuoted = (row: StatusRow): Status | undefined => {
		if (!embedded.has(row.id)) {
			embedded.set(row.id, presentRow(row, 'quoted'))
		}
		return embedded.get(row.id)
	}

	return (id) => {
		const row = byId.get(id)
		return row === undefined ? undefined : presentRow(row, 'top')
	}
}

// A local status's application, as Mastodon shows it for an author at its default show_application (Kopje has no such
// setting, docs/mastodon-deviations.md): null when its id names no app Kopje keeps (a boost, a status posted before
// 0064_status_applications or through a removed app) or the app's name does not pass presentedAppName; the website
// as stored when isAppWebsite accepts it as decoded, else null. Viewer-independent.
function presentApplication(row: StatusRow): StatusApplication | null {
	const name = presentedAppName(row.application_name)
	const website = row.application_website
	return name === null ? null : { name, website: website !== null && isAppWebsite(website) ? website : null }
}

// A card row as CARD_COLUMN_MAP reads it: texts and integers, each NULL past its bound.
export type CardRow = {
	status_id: string
	url: string | null
	title: string | null
	description: string | null
	author_name: string | null
	author_url: string | null
	provider_name: string | null
	provider_url: string | null
	language: string | null
	published_at: string | null
	card_type: number | null
	width: number | null
	height: number | null
	embed_src: string | null
	iframe_width: number | null
	iframe_height: number | null
	image_description: string | null
	image_token: string | null
	image_width: number | null
	image_height: number | null
	blurhash: string | null
} & { [K in Exclude<keyof typeof CARD_COLUMN_MAP, 'status_id'>]: unknown }

// A card image's URL as presented (HTML-3): the served file of a stored token (media-files.ts mediaUrl) on the
// instance origin, through presentedMediaUrl, within CARD_IMAGE_URL_BYTES and that plus 2 as a JSON string; else null.
export function presentedCardImageUrl(origin: string, token: unknown): string | null {
	if (typeof token !== 'string' || !FILE_TOKEN.test(token)) {
		return null
	}
	const url = presentedMediaUrl(mediaUrl(origin, token, 'full', 'image/webp'))
	return url !== null &&
		ENCODER.encode(url).length <= CARD_IMAGE_URL_BYTES &&
		ENCODER.encode(JSON.stringify(url)).length <= CARD_IMAGE_URL_BYTES + 2
		? url
		: null
}

// Mastodon's twitter:player iframe (link_details_extractor.rb:147-149) as its serializer's MASTODON_OEMBED sanitizing
// leaves it (rest/preview_card_serializer.rb:26-28, sanitize_config.rb:137-155): the src escaped once (& as &amp;,
// stored-bounds.ts embedSrcAttribute), a width or height omitted when the iframe had none, allowtransparency dropped
// and the fixed sandbox added. The one html a card presents (HTML-3): an oEmbed video's iframe is rendered from the
// same template, never from its markup.
export const CARD_IFRAME_SANDBOX =
	'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms'
export function cardIframe(src: string, width: number | null, height: number | null): string {
	const size = `${width === null ? '' : ` width="${width}"`}${height === null ? '' : ` height="${height}"`}`
	return `<iframe src="${embedSrcAttribute(src)}"${size} allowfullscreen="true" scrolling="no" frameborder="0" sandbox="${CARD_IFRAME_SANDBOX}"></iframe>`
}

const CARD_TYPE_NAMES = { [CARD_TYPES.link]: 'link', [CARD_TYPES.photo]: 'photo', [CARD_TYPES.video]: 'video' } as const

// A status's card as presented (not a quoted status's: see CARD_JSON_MAX): none on a status that is not public or
// unlisted (AM8), without a URL, or whose title is blank; each text and URL judged as decoded (presentedCardText,
// presentedCardUrl), an optional URL refused shown as '' (AM21), a language outside Mastodon's locales and a time not
// in the ISO form as null. Its type and dimensions as read (link and 0 past their bounds); a video's iframe from its
// src as decoded (presentedEmbedSrc), else a link without html. Viewer-independent.
export function presentCard(
	row: Pick<StatusRow, 'visibility'>,
	card: CardRow | undefined,
	origin: string
): PreviewCard | null {
	if (card === undefined || (row.visibility !== 'public' && row.visibility !== 'unlisted')) {
		return null
	}
	const url = presentedCardUrl(card.url)
	const title = presentedCardText(card.title, CARD_TEXTS.title)
	if (url === null || railsBlank(title)) {
		return null
	}
	const authorName = presentedCardText(card.author_name, CARD_TEXTS.author_name)
	const authorUrl = presentedCardUrl(card.author_url, CARD_OPTIONAL_URL_LIMIT) ?? ''
	const stored = CARD_TYPE_NAMES[card.card_type as keyof typeof CARD_TYPE_NAMES] ?? 'link'
	const src = stored === 'video' ? presentedEmbedSrc(card.embed_src) : null
	const dimension = (value: unknown) => (typeof value === 'number' ? value : null)
	const [imageWidth, imageHeight] = [dimension(card.image_width), dimension(card.image_height)]
	const image =
		imageWidth !== null && imageHeight !== null && imageWidth > 0 && imageHeight > 0
			? presentedCardImageUrl(origin, card.image_token)
			: null
	const type = stored === 'video' && src === null ? 'link' : stored
	// A link card with an image takes the image's size (preview_card.rb:178-189); a photo or video keeps its own.
	const sized = type === 'link' && image !== null
	return {
		url,
		title,
		description: presentedCardText(card.description, CARD_TEXTS.description),
		language: card.language !== null && TREND_LANGUAGES.has(card.language) ? card.language : null,
		type,
		author_name: authorName,
		author_url: authorUrl,
		provider_name: presentedCardText(card.provider_name, CARD_TEXTS.provider_name),
		provider_url: presentedCardUrl(card.provider_url, CARD_OPTIONAL_URL_LIMIT) ?? '',
		html: src === null ? '' : cardIframe(src, dimension(card.iframe_width), dimension(card.iframe_height)),
		width: (sized ? imageWidth : dimension(card.width)) ?? 0,
		height: (sized ? imageHeight : dimension(card.height)) ?? 0,
		image,
		image_description: presentedCardText(card.image_description, CARD_IMAGE_DESCRIPTION_JSON_BYTES),
		embed_url: '',
		blurhash: image === null ? null : storedBlurhash(card.blurhash),
		published_at: card.published_at !== null && isIsoTime(card.published_at) ? card.published_at : null,
		authors:
			railsBlank(authorName) && railsBlank(authorUrl) ? [] : [{ name: authorName, url: authorUrl, account: null }],
	}
}

// The key of a quoted status's matched text, apart from the same status's as a status of the response.
function quotedKey(id: string): string {
	return `quoted:${id}`
}

// A local status's web page is /@user/<id>; a local boost has none of its own and shows its Announce id. A remote
// status keeps the url it came with, or its uri.
function statusUrl(row: StatusRow): string {
	if (row.author_domain !== null) {
		return row.url ?? row.uri
	}
	if (row.reblog_of_id !== null) {
		return row.uri
	}
	return `${new URL(row.author_uri).origin}/@${row.author_username}/${row.id}`
}

// MediaAttachment as REST::MediaAttachmentSerializer shows it. URLs are emitted only when they are http(s) (HTML-3);
// meta carries the stored dimensions (Mastodon's original and small) and the focal point. A remote attachment's url
// and preview_url are its remote URLs (Mastodon proxies uncached ones through its media_proxy), so its remote_url is
// its url and its preview_remote_url its icon, or null without one; a local one's are null, as Mastodon's local? media.
// text_url is always null (MD-6). blurhash: what storedBlurhash keeps of the stored value (a local upload has none).
export function presentMedia(row: MediaRow): MediaAttachment {
	// URLs within MEDIA_URL_LIMIT as serialized, as stored (STORED_COLUMNS in platform/stored-bounds.ts).
	const url = presentedMediaUrl(row.url)
	const preview = presentedMediaUrl(row.preview_url)
	const stored = storedMeta(row.meta)
	const meta: MediaMeta = {
		...(isSize(stored.original) ? { original: mediaSize(stored.original) } : {}),
		...(isSize(stored.small) ? { small: mediaSize(stored.small) } : {}),
		...(row.meta === null ? {} : { focus: { x: row.focus_x, y: row.focus_y } }),
	}
	const remote = row.remote === 1
	return {
		id: row.id,
		type: row.type,
		url,
		preview_url: preview ?? url,
		remote_url: remote ? url : null,
		preview_remote_url: remote ? preview : null,
		text_url: null,
		meta: Object.keys(meta).length === 0 ? null : meta,
		description: row.description === '' ? null : row.description,
		blurhash: storedBlurhash(row.blurhash),
	}
}

const ENCODER = new TextEncoder()
// What no presented media URL holds as decoded: C0 controls (NUL included), DEL, and U+FFFD, which a stored value that
// is not well-formed UTF-8 decodes to.
// eslint-disable-next-line no-control-regex
const MEDIA_URL_REFUSED = /[\u0000-\u001f\u007f\ufffd]/

// A media URL as presented, live or from an edit's snapshot (HTML-3, RES-2), judged in order: as decoded, within
// MEDIA_URL_LIMIT UTF-8 bytes, well-formed and without a refused character; then normalized, an http(s) URL within
// MEDIA_URL_LIMIT bytes as serialized and MEDIA_URL_JSON_BYTES as a JSON string. Else null.
export function presentedMediaUrl(value: unknown): string | null {
	if (
		typeof value !== 'string' ||
		value.length > MEDIA_URL_LIMIT ||
		!value.isWellFormed() ||
		MEDIA_URL_REFUSED.test(value) ||
		ENCODER.encode(value).length > MEDIA_URL_LIMIT
	) {
		return null
	}
	const href = boundedHref(value, MEDIA_URL_LIMIT)
	return href !== null && jsonBytes(href) <= MEDIA_URL_JSON_BYTES ? href : null
}

type Size = { width: number; height: number }

// A stored meta's keys, or none when it is not a JSON object (an imported value may be any text).
function storedMeta(text: string | null): Record<string, unknown> {
	if (text === null) {
		return {}
	}
	try {
		const parsed: unknown = JSON.parse(text)
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

// Dimensions a presented size may show: positive finite width and height.
function isSize(value: unknown): value is Size {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const { width, height } = value as Record<string, unknown>
	const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0
	return positive(width) && positive(height)
}

function mediaSize({ width, height }: Size): MediaSize {
	return { width, height, size: `${width}x${height}`, aspect: width / height }
}

type ViewerFlags = Record<'favourited' | 'reblogged' | 'bookmarked' | 'pinned' | 'muted', Set<string>>

// The viewer's own flags of the statuses: favourited, boosted, bookmarked, pinned, and in a conversation they mute
// (each status's own thread, a boost's too, as Mastodon's muted reads the status's conversation).
function viewerFlags(db: Db, viewerId: string | null, ids: string): ViewerFlags {
	if (viewerId === null) {
		return { favourited: new Set(), reblogged: new Set(), bookmarked: new Set(), pinned: new Set(), muted: new Set() }
	}
	const rows = db.all<{ kind: string; status_id: string }>(
		`SELECT ${selectSql(VIEWER_FLAG_COLUMNS.columns)} FROM (
			SELECT 'f' AS kind, status_id FROM favourites WHERE account_id = ?1 AND status_id IN (SELECT value FROM json_each(?2))
			UNION ALL
			SELECT 'r', reblog_of_id FROM statuses WHERE account_id = ?1 AND reblog_of_id IN (SELECT value FROM json_each(?2))
			UNION ALL
			SELECT 'b', status_id FROM bookmarks WHERE account_id = ?1 AND status_id IN (SELECT value FROM json_each(?2))
			UNION ALL
			SELECT 'p', value FROM json_each(?2)
			WHERE EXISTS (SELECT 1 FROM status_pins WHERE account_id = ?1 AND status_id = value)
			UNION ALL
			SELECT 'm', ms.id FROM statuses ms INDEXED BY ${STATUSES_ID_INDEX}
			WHERE ms.id IN (SELECT value FROM json_each(?2)) AND ${conversationMutedSql('?1', 'ms.thread')}) f`,
		viewerId,
		ids
	)
	const of = (kind: string) => new Set(rows.filter((row) => row.kind === kind).map((row) => row.status_id))
	return { favourited: of('f'), reblogged: of('r'), bookmarked: of('b'), pinned: of('p'), muted: of('m') }
}

// SQLite's BINARY order of two strings: their UTF-8 bytes, which is their code points' order (JavaScript's `<`, by
// UTF-16 code units, orders a character past U+FFFF before U+E000 to U+FFFF).
function byCodePoints(a: string, b: string): number {
	for (let i = 0, j = 0; i < a.length && j < b.length;) {
		const x = a.codePointAt(i)!
		const y = b.codePointAt(j)!
		if (x !== y) {
			return x - y
		}
		i += x > 0xffff ? 2 : 1
		j += y > 0xffff ? 2 : 1
	}
	return a.length - b.length
}

function groupBy<T extends { status_id: string }>(rows: T[]): Map<string, T[]> {
	const groups = new Map<string, T[]>()
	for (const row of rows) {
		const list = groups.get(row.status_id)
		if (list === undefined) {
			groups.set(row.status_id, [row])
		} else {
			list.push(row)
		}
	}
	return groups
}
