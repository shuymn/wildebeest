import {
	type Account,
	findAccountIds,
	type Present,
	presentAccountsWithin,
	resolveAccountId,
	type SearchInput,
} from './accounts'
import { admit, ANSWER_BYTES, jsonBytes } from './answer-budget'
import { findableBySql, listableSql, statusReads, type VisibleStatusId } from './audience'
import { type UserContext, userReadOperation } from './auth'
import { statusQueryTerms } from './search-text'
import { tagNameSql } from './status-bounds'
import { presentation, presentStatusesWithin, type Status } from './status-presenter'
import { statusCursor } from './statuses'
import { normalizeTag } from './tag-name'
import { presentTags, type Tag } from './tags'
import type { Db } from '../db/sql'

// GET /api/v2/search (design §6, "search"): local data only, matched with instr on search_text (NFKC); no virtual
// table. Accounts: domain/accounts.ts. Statuses: the viewer's library (own statuses, boosted originals, favourites,
// bookmarks, mentions), or one account's statuses with account_id. Hashtags: by prefix, from statuses the viewer may see.
// Every status passes listableSql (VIS-1 and the viewer's filters) in the query, before LIMIT (RES-7).
//
// Work is bounded (RES-3, RES-7). Each library source reads at most LIBRARY_SOURCE_LIMIT rows through an index whose
// order is the returned status id, with max_id and min_id applied inside the source, so a query matches at most
// 5 x LIBRARY_SOURCE_LIMIT candidates and a client paging with max_id reaches every older entry of every source.
//
// Hashtag search is recent autocomplete, not a catalogue of every tag. Tags are taken only from statuses the viewer may
// see, inside two windows: the newest HASHTAG_LIBRARY_LIMIT entries of each library source the viewer writes (own
// statuses, boosts, favourites, bookmarks), and the newest HASHTAG_PUBLIC_WINDOW public statuses the instance knows (a
// partial index holds public originals only). Candidates pass listableSql before tags are taken from them, so a tag
// used only in posts the viewer may not see is never shown. Mentions are not a window source: others write them, and
// a hidden mention (from an author who blocks the viewer) could push a visible entry out. Limitations: a tag used only
// outside the windows is not found, even by its exact name; a status the viewer saved that later became hidden (its
// author blocked them) still takes a slot of the viewer's own windows, which reveals that something changed, not what.
//
// The whole answer, accounts, statuses and hashtags, is one answer within ANSWER_BYTES (RES-3), admitted in that order
// with the account resolve=true found first among the accounts. Search pages by offset, so an answer cut there holds
// fewer results: a client advancing its offset by the number received continues after them, while Mastodon's web
// client, which takes a short answer for the last one, shows no more (docs/response-inventory.md).

export const LIBRARY_SOURCE_LIMIT = 2500
export const HASHTAG_LIBRARY_LIMIT = 500
export const HASHTAG_PUBLIC_WINDOW = 2000

// A Tag entity (tags.ts), with no history, and the viewer's following and featuring.
export type Hashtag = Tag

export type SearchType = 'accounts' | 'statuses' | 'hashtags'

export type SearchRequest = {
	query: string
	types: readonly SearchType[]
	limit: number
	offset: number
	following: boolean
	accountId?: string
	maxId?: string
	minId?: string
	localDomain: string
	present: Present
	// The account resolve=true found (remote-statuses.ts resolveSearch), shown first among the accounts, as Mastodon's
	// AccountSearchService puts the exact match first, when the viewer may find it.
	resolvedAccountId?: string
}

export type SearchResults = { accounts: Account[]; statuses: Status[]; hashtags: Hashtag[] }

// The JSON of an empty answer: each list's items are counted with a separator, one more than they take.
const SEARCH_FRAME_BYTES = jsonBytes({ accounts: [], statuses: [], hashtags: [] } satisfies SearchResults)

export const search = userReadOperation<SearchRequest, SearchResults>((db, input, _viewer, context) => {
	const accountInput: SearchInput = {
		query: input.query,
		limit: input.limit,
		offset: input.offset,
		following: input.following,
		localDomain: input.localDomain,
		present: input.present,
	}
	let left = ANSWER_BYTES - SEARCH_FRAME_BYTES
	let leading = true
	const accounts = input.types.includes('accounts')
		? presentAccountsWithin(db, accountIds(db, input, accountInput, context), input.present, left, leading)
		: { items: [], bytes: 0 }
	left -= accounts.bytes
	leading &&= accounts.items.length === 0
	const statusIds = input.types.includes('statuses') ? searchStatuses(db, input, context) : []
	const options = { ...input.present, viewer: context }
	const statuses = presentStatusesWithin(db, presentation(db, statusIds, options), statusIds, left, leading)
	left -= statuses.bytes
	leading &&= statuses.items.length === 0
	const hashtags = input.types.includes('hashtags') ? searchHashtags(db, input, context) : []
	return { accounts: accounts.items, statuses: statuses.items, hashtags: admit(hashtags, left, leading).items }
})

// The accounts' ids: the account resolve=true found, when the viewer may find it (findableBySql, R14), then the
// search's own, within the limit.
function accountIds(db: Db, input: SearchRequest, accountInput: SearchInput, viewer: UserContext): string[] {
	const found = findAccountIds(db, accountInput, viewer.accountId)
	const resolved = input.resolvedAccountId
	if (
		resolved === undefined ||
		db.first(`SELECT 1 AS found WHERE ${findableBySql('?2', '?1')}`, viewer.accountId, resolved) === undefined
	) {
		return found
	}
	return [resolved, ...found.filter((id) => id !== resolved)].slice(0, input.limit)
}

// Numbered parameters, so fragments that use ?1 (the viewer) can be combined with any number of terms.
class Params {
	readonly values: SqlStorageValue[]
	constructor(first: SqlStorageValue) {
		this.values = [first]
	}
	add(value: SqlStorageValue): string {
		this.values.push(value)
		return `?${this.values.length}`
	}
}

// The viewer's library as one candidate list of status ids, newest first per source, each source read through an
// index ordered by the id it returns. `cursor` adds max_id and min_id conditions on that id. Mentions are a source of
// status search only (`mentions`): others write them, so they are left out of the hashtag window (see above).
function librarySources(limit: string, cursor: (column: string) => string, mentions = true): string {
	const mentioned = mentions
		? `UNION SELECT id FROM (SELECT status_id AS id FROM status_mentions WHERE account_id = ?1 ${cursor('status_id')}
				ORDER BY status_id DESC LIMIT ${limit})`
		: ''
	return `SELECT id FROM (SELECT id FROM statuses WHERE account_id = ?1 AND reblog_of_id IS NULL ${cursor('id')}
				ORDER BY id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT reblog_of_id AS id FROM statuses
				WHERE account_id = ?1 AND reblog_of_id IS NOT NULL ${cursor('reblog_of_id')}
				ORDER BY reblog_of_id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT status_id AS id FROM favourites WHERE account_id = ?1 ${cursor('status_id')}
				ORDER BY status_id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT status_id AS id FROM bookmarks WHERE account_id = ?1 ${cursor('status_id')}
				ORDER BY status_id DESC LIMIT ${limit})
			${mentioned}`
}

function searchStatuses(db: Db, input: SearchRequest, viewer: UserContext): VisibleStatusId[] {
	const { accountId: viewerId, now } = viewer
	const { include, exclude } = statusQueryTerms(input.query)
	if (include.length === 0) {
		return []
	}
	const p = new Params(viewerId)
	const read = statusReads(viewer, { viewer: '?1', now: p.add(now) })
	const limit = p.add(LIBRARY_SOURCE_LIMIT)
	// Cursors compare as numbers: statusCursor pads a short one and caps an over-long one (ids are 18-digit TEXT).
	const maxCursor = statusCursor(input.maxId)
	const minCursor = statusCursor(input.minId)
	const maxId = maxCursor === null ? null : p.add(maxCursor)
	const minId = minCursor === null ? null : p.add(minCursor)
	const cursor = (column: string) =>
		`${maxId === null ? '' : `AND ${column} < ${maxId}`} ${minId === null ? '' : `AND ${column} > ${minId}`}`
	let candidates: string
	if (input.accountId !== undefined) {
		// One account's statuses (the viewer's library is not required; listableSql still decides).
		const accountId = resolveAccountId(db, input.accountId)
		if (accountId === null) {
			return []
		}
		candidates = `SELECT id FROM (SELECT id FROM statuses WHERE account_id = ${p.add(accountId)}
			AND reblog_of_id IS NULL ${cursor('id')} ORDER BY id DESC LIMIT ${limit})`
	} else {
		candidates = librarySources(limit, cursor)
	}
	const matches = (variants: string[]) =>
		`(${variants.map((variant) => `instr(s.search_text, ${p.add(variant)}) > 0`).join(' OR ')})`
	const where = [
		's.reblog_of_id IS NULL',
		's.search_text IS NOT NULL',
		...include.map(matches),
		...exclude.map((variants) => `NOT ${matches(variants)}`),
	]
	return read
		.select(
			db,
			'listable',
			{
				with: `WITH candidates(id) AS (${candidates})`,
				from: 'candidates c JOIN',
				join: 'ON s.id = c.id',
				where: where.join(' AND '),
				tail: `ORDER BY s.id DESC LIMIT ${p.add(input.limit)} OFFSET ${p.add(input.offset)}`,
			},
			...p.values
		)
		.map((row) => row.id)
}

// The largest code point, as UTF-8 compares: every name with the prefix sorts below prefix + this.
const PREFIX_END = '\u{10FFFF}'

// Tags whose name starts with the query, from the statuses in the two windows that the viewer may see (see above), exact
// match first, then shorter names.
function searchHashtags(db: Db, input: SearchRequest, { accountId: viewerId, now }: UserContext): Hashtag[] {
	// Tag.matches_name: the query normalized as a hashtag name, so spaces and other characters a hashtag cannot hold
	// are dropped from it.
	const prefix = normalizeTag(input.query.trim().replace(/^#/, ''))
	if (prefix === '') {
		return []
	}
	const rows = db.all<{ name: string }>(
		// The Store's SQLite allows five terms per compound SELECT, so the windows are two CTEs. CROSS JOIN keeps the
		// windows on the outside: tags are looked up per visible status, never scanned by name.
		`WITH library(id) AS (${librarySources('?4', () => '', false)}),
		public(id) AS (SELECT id FROM statuses WHERE visibility = 'public' AND reblog_of_id IS NULL ORDER BY id DESC LIMIT ?5),
		candidates(id) AS (SELECT id FROM library UNION SELECT id FROM public),
		visible(id) AS (SELECT s.id FROM candidates c JOIN statuses s ON s.id = c.id WHERE ${listableSql('s', '?1', '?8')})
		SELECT DISTINCT ${tagNameSql('t.name')} AS name FROM visible v
			CROSS JOIN status_tags t ON t.status_id = v.id AND t.name >= ?2 AND t.name < ?3
		WHERE ${tagNameSql('t.name')} IS NOT NULL
		ORDER BY t.name = ?2 DESC, length(t.name), t.name LIMIT ?6 OFFSET ?7`,
		viewerId,
		prefix,
		`${prefix}${PREFIX_END}`,
		HASHTAG_LIBRARY_LIMIT,
		HASHTAG_PUBLIC_WINDOW,
		input.limit,
		input.offset,
		now
	)
	return presentTags(
		db,
		rows.map(({ name }) => name),
		viewerId,
		input.present,
		null
	)
}
