import { type Account, findAccounts, type Present, resolveAccountId, type SearchInput } from './accounts'
import { listableSql } from './audience'
import { userReadOperation } from './auth'
import { statusQueryTerms } from './search-text'
import { presentStatuses, type Status } from './status-presenter'
import { normalizeTag } from './status-text'
import type { Db } from '../db/sql'

// GET /api/v2/search (design §6, "search"): local data only, matched with instr on search_text (NFKC); no virtual
// table. Accounts: every known account (domain/accounts.ts). Hashtags: by prefix. Statuses: the viewer's library (own
// statuses and boosts, favourites, bookmarks, mentions), or one account's statuses with account_id. Every status passes
// listableSql (VIS-1 and the viewer's filters) in the query, before LIMIT (RES-7).
//
// Work is bounded (RES-3, RES-7): each library source contributes at most LIBRARY_SOURCE_LIMIT of its newest rows, so a
// query matches against at most 4 x LIBRARY_SOURCE_LIMIT candidates; hashtags look at most HASHTAG_CANDIDATES names
// and, for each, the newest HASHTAG_VISIBILITY_PROBE statuses that carry it. Statuses older than the window are not
// found; a client pages with max_id, which moves the window for own statuses and mentions.

export const LIBRARY_SOURCE_LIMIT = 2500
export const HASHTAG_CANDIDATES = 100
export const HASHTAG_VISIBILITY_PROBE = 50

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

function searchStatuses(db: Db, input: SearchRequest, viewerId: string): Status[] {
	const { include, exclude } = statusQueryTerms(input.query)
	if (include.length === 0) {
		return []
	}
	const p = new Params(viewerId)
	const limit = p.add(LIBRARY_SOURCE_LIMIT)
	const below = input.maxId === undefined ? '' : `AND id < ${p.add(input.maxId)}`
	let candidates: string
	if (input.accountId !== undefined) {
		// One account's statuses (the viewer's library is not required; listableSql still decides).
		const accountId = resolveAccountId(db, input.accountId)
		if (accountId === null) {
			return []
		}
		candidates = `SELECT id FROM (SELECT id FROM statuses WHERE account_id = ${p.add(accountId)}
			AND reblog_of_id IS NULL ${below} ORDER BY id DESC LIMIT ${limit})`
	} else {
		// The viewer's library, each source by its own index, newest first.
		candidates = `SELECT id FROM (SELECT IFNULL(reblog_of_id, id) AS id FROM statuses WHERE account_id = ?1 ${below}
				ORDER BY id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT status_id AS id FROM favourites WHERE account_id = ?1 ORDER BY id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT status_id AS id FROM bookmarks WHERE account_id = ?1 ORDER BY id DESC LIMIT ${limit})
			UNION SELECT id FROM (SELECT status_id AS id FROM status_mentions WHERE account_id = ?1
				${below.replace('id <', 'status_id <')} ORDER BY status_id DESC LIMIT ${limit})`
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
	if (input.maxId !== undefined) {
		where.push(`s.id < ${p.add(input.maxId)}`)
	}
	if (input.minId !== undefined) {
		where.push(`s.id > ${p.add(input.minId)}`)
	}
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

// Tags whose name starts with the query, that the viewer can see on at least one status: a tag used only in posts the
// viewer may not see is not revealed. Distinct names are walked by the index one at a time (bounded), exact match
// first, then shorter names.
function searchHashtags(db: Db, input: SearchRequest, viewerId: string): Hashtag[] {
	const prefix = normalizeTag(input.query.trim().replace(/^#/, ''))
	if (prefix === '' || /\s/.test(prefix)) {
		return []
	}
	const rows = db.all<{ name: string }>(
		`WITH RECURSIVE names(name, n) AS (
			SELECT (SELECT min(name) FROM status_tags WHERE name >= ?2 AND name < ?3), 1
			UNION ALL
			SELECT (SELECT min(name) FROM status_tags WHERE name > names.name AND name < ?3), n + 1
			FROM names WHERE names.name IS NOT NULL AND n < ?4
		)
		SELECT name FROM names
		WHERE name IS NOT NULL AND EXISTS (
			SELECT 1 FROM (SELECT status_id FROM status_tags t WHERE t.name = names.name ORDER BY status_id DESC LIMIT ?5) t
			JOIN statuses s ON s.id = t.status_id WHERE ${listableSql('s', '?1')})
		ORDER BY name = ?2 DESC, length(name), name LIMIT ?6 OFFSET ?7`,
		viewerId,
		prefix,
		`${prefix}${PREFIX_END}`,
		HASHTAG_CANDIDATES,
		HASHTAG_VISIBILITY_PROBE,
		input.limit,
		input.offset
	)
	return rows.map(({ name }) => ({
		name,
		url: `${input.present.origin}/tags/${encodeURIComponent(name)}`,
		history: [],
	}))
}
