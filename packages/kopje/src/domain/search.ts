import { type Account, findAccounts, type Present, resolveAccountId, type SearchInput } from './accounts'
import { listableSql } from './audience'
import { userReadOperation } from './auth'
import { statusQueryTerms } from './search-text'
import { presentStatuses, type Status } from './status-presenter'
import { normalizeTag } from './status-text'
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
// Hashtags are ranked only over statuses the viewer is allowed to see, inside two windows that private statuses cannot
// change: the newest HASHTAG_LIBRARY_LIMIT entries of each library source, and the newest HASHTAG_PUBLIC_WINDOW public
// statuses the instance knows (a partial index holds public originals only). Candidates pass listableSql before tags
// are taken from them, so a tag used only in posts the viewer may not see is never shown, and hidden statuses cannot
// push a visible tag out. Trade-off: a tag found only in older public posts outside the viewer's library is not
// found; blocks, mutes and suspensions can still thin the public window for one viewer, which reveals no content.

export const LIBRARY_SOURCE_LIMIT = 2500
export const HASHTAG_LIBRARY_LIMIT = 500
export const HASHTAG_PUBLIC_WINDOW = 2000

export type Hashtag = { name: string; url: string; history: [] }

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
}

export type SearchResults = { accounts: Account[]; statuses: Status[]; hashtags: Hashtag[] }

export const search = userReadOperation<SearchRequest, SearchResults>((db, input, { accountId: viewerId }) => {
	const accountInput: SearchInput = {
		query: input.query,
		limit: input.limit,
		offset: input.offset,
		following: input.following,
		localDomain: input.localDomain,
		present: input.present,
	}
	return {
		accounts: input.types.includes('accounts') ? findAccounts(db, accountInput, viewerId) : [],
		statuses: input.types.includes('statuses') ? searchStatuses(db, input, viewerId) : [],
		hashtags: input.types.includes('hashtags') ? searchHashtags(db, input, viewerId) : [],
	}
})

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
// index ordered by the id it returns. `cursor` adds max_id and min_id conditions on that id.
function librarySources(limit: string, cursor: (column: string) => string): string {
	return `SELECT id FROM (SELECT id FROM statuses WHERE account_id = ?1 AND reblog_of_id IS NULL ${cursor('id')}
				ORDER BY id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT reblog_of_id AS id FROM statuses
				WHERE account_id = ?1 AND reblog_of_id IS NOT NULL ${cursor('reblog_of_id')}
				ORDER BY reblog_of_id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT status_id AS id FROM favourites WHERE account_id = ?1 ${cursor('status_id')}
				ORDER BY status_id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT status_id AS id FROM bookmarks WHERE account_id = ?1 ${cursor('status_id')}
				ORDER BY status_id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT status_id AS id FROM status_mentions WHERE account_id = ?1 ${cursor('status_id')}
				ORDER BY status_id DESC LIMIT ${limit})`
}

function searchStatuses(db: Db, input: SearchRequest, viewerId: string): Status[] {
	const { include, exclude } = statusQueryTerms(input.query)
	if (include.length === 0) {
		return []
	}
	const p = new Params(viewerId)
	const limit = p.add(LIBRARY_SOURCE_LIMIT)
	const maxId = input.maxId === undefined ? null : p.add(input.maxId)
	const minId = input.minId === undefined ? null : p.add(input.minId)
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
		listableSql('s', '?1'),
	]
	const ids = db
		.all<{ id: string }>(
			`WITH candidates(id) AS (${candidates})
			SELECT s.id FROM candidates c JOIN statuses s ON s.id = c.id
			WHERE ${where.join(' AND ')}
			ORDER BY s.id DESC LIMIT ${p.add(input.limit)} OFFSET ${p.add(input.offset)}`,
			...p.values
		)
		.map((row) => row.id)
	return presentStatuses(db, ids, { ...input.present, viewerId })
}

// The largest code point, as UTF-8 compares: every name with the prefix sorts below prefix + this.
const PREFIX_END = '\u{10FFFF}'

// Tags whose name starts with the query, from the statuses in the two windows that the viewer may see (see above), exact
// match first, then shorter names.
function searchHashtags(db: Db, input: SearchRequest, viewerId: string): Hashtag[] {
	const prefix = normalizeTag(input.query.trim().replace(/^#/, ''))
	if (prefix === '' || /\s/.test(prefix)) {
		return []
	}
	const rows = db.all<{ name: string }>(
		// The Store's SQLite allows five terms per compound SELECT, so the windows are two CTEs. CROSS JOIN keeps the
		// windows on the outside: tags are looked up per visible status, never scanned by name.
		`WITH library(id) AS (${librarySources('?4', () => '')}),
		public(id) AS (SELECT id FROM statuses WHERE visibility = 'public' AND reblog_of_id IS NULL ORDER BY id DESC LIMIT ?5),
		candidates(id) AS (SELECT id FROM library UNION SELECT id FROM public),
		visible(id) AS (SELECT s.id FROM candidates c JOIN statuses s ON s.id = c.id WHERE ${listableSql('s', '?1')})
		SELECT DISTINCT t.name FROM visible v CROSS JOIN status_tags t ON t.status_id = v.id AND t.name >= ?2 AND t.name < ?3
		ORDER BY t.name = ?2 DESC, length(t.name), t.name LIMIT ?6 OFFSET ?7`,
		viewerId,
		prefix,
		`${prefix}${PREFIX_END}`,
		HASHTAG_LIBRARY_LIMIT,
		HASHTAG_PUBLIC_WINDOW,
		input.limit,
		input.offset
	)
	return rows.map(({ name }) => ({
		name,
		url: `${input.present.origin}/tags/${encodeURIComponent(name)}`,
		history: [],
	}))
}
