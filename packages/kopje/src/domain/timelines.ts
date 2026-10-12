import { type Page, type PageQuery, type Present, resolveAccountId } from './accounts'
import { listableSql, unfilteredSql, visibleSql } from './audience'
import { optionalUserReadOperation, userReadOperation } from './auth'
import { presentStatuses, type Status } from './status-presenter'
import { normalizeTag } from './status-text'
import { statusCursor } from './statuses'
import type { Db } from '../db/sql'

// Timelines (design §6 "timelines"): each is one query over statuses, newest first, paged by status id (18-digit
// TEXT, compared as TEXT) or, for bookmarks and favourites, by the edge's INTEGER id. Every row passes the audience
// rule in the query itself (audience.ts), so a page is never filled with statuses the viewer may not see. The
// feed condition `visibility IN ('public', 'unlisted', 'private')` is written exactly as the partial index
// statuses_feed declares it.

const FEED = "s.visibility IN ('public', 'unlisted', 'private')"

type Cursor = { max: string | null; min: string | null; ascending: boolean; limit: number }

function statusPage(page: PageQuery): Cursor {
	return {
		max: statusCursor(page.maxId),
		min: statusCursor(page.minId ?? page.sinceId),
		ascending: page.minId !== undefined,
		limit: page.limit,
	}
}

// The cursor condition on a status id column, with the cursor parameters at ?2 (max) and ?3 (min).
function cursorSql(column: string): string {
	return `(?2 IS NULL OR ${column} < ?2) AND (?3 IS NULL OR ${column} > ?3)`
}

function statusesPage(db: Db, ids: string[], cursor: Cursor, viewerId: string | null, present: Present): Page<Status> {
	if (cursor.ascending) {
		ids.reverse()
	}
	return {
		items: presentStatuses(db, ids, { ...present, viewerId }),
		newest: ids[0] ?? null,
		oldest: ids.at(-1) ?? null,
	}
}

function ids(rows: { id: string }[]): string[] {
	return rows.map((row) => row.id)
}

// Home (Mastodon's FeedManager#filter_from_home): the viewer's own statuses and those of accounts they follow,
// public, unlisted and private; direct and limited statuses of their own, and of followed accounts that address
// them. Boosts from follows with show_reblogs off and replies to accounts the viewer does not follow are left out,
// and so is anything the list rule hides (blocks, mutes, domain blocks, invisible originals).
export const homeTimeline = userReadOperation<{ page: PageQuery; present: Present }, Page<Status>>(
	(db, { page, present }, { accountId }) => {
		const cursor = statusPage(page)
		const order = cursor.ascending ? 'ASC' : 'DESC'
		const home = `${listableSql('s', '?1')}
			AND (s.reblog_of_id IS NULL OR s.account_id = ?1 OR EXISTS (SELECT 1 FROM follows hf
				WHERE hf.account_id = ?1 AND hf.target_account_id = s.account_id AND hf.show_reblogs = 1))
			AND (s.in_reply_to_id IS NULL OR EXISTS (SELECT 1 FROM statuses hp WHERE hp.id = s.in_reply_to_id
				AND (hp.account_id IN (?1, s.account_id) OR EXISTS (SELECT 1 FROM follows hr
					WHERE hr.account_id = ?1 AND hr.target_account_id = hp.account_id AND hr.state = 'accepted'))))`
		const rows = db.all<{ id: string }>(
			`SELECT id FROM (
				SELECT * FROM (SELECT s.id FROM statuses s
					WHERE s.account_id IN (SELECT ?1 UNION ALL
						SELECT target_account_id FROM follows WHERE account_id = ?1 AND state = 'accepted')
						AND ${FEED} AND ${cursorSql('s.id')} AND ${home}
					ORDER BY s.id ${order} LIMIT ?4)
				UNION ALL
				SELECT * FROM (SELECT s.id FROM statuses s
					WHERE s.account_id = ?1 AND s.visibility IN ('direct', 'limited') AND ${cursorSql('s.id')}
					ORDER BY s.id ${order} LIMIT ?4)
				UNION ALL
				SELECT * FROM (SELECT s.id FROM status_mentions m JOIN statuses s ON s.id = m.status_id
					WHERE m.account_id = ?1 AND s.account_id <> ?1 AND s.visibility IN ('direct', 'limited')
						AND EXISTS (SELECT 1 FROM follows df
							WHERE df.account_id = ?1 AND df.target_account_id = s.account_id AND df.state = 'accepted')
						AND ${cursorSql('s.id')} AND ${home}
					ORDER BY s.id ${order} LIMIT ?4)
			) ORDER BY id ${order} LIMIT ?4`,
			accountId,
			cursor.max,
			cursor.min,
			cursor.limit
		)
		return statusesPage(db, ids(rows), cursor, accountId, present)
	}
)

export type PublicTimelineInput = {
	page: PageQuery
	local: boolean
	remote: boolean
	onlyMedia: boolean
	present: Present
}

// Local and remote public statuses that are not boosts, and not replies except to the author's own statuses
// (Mastodon's PublicFeed). Never unlisted, private, direct or limited.
function publicConditions(local: boolean, remote: boolean, onlyMedia: boolean): string {
	return `s.visibility = 'public' AND s.reblog_of_id IS NULL
		${local ? 'AND pa.domain IS NULL' : ''} ${remote ? 'AND pa.domain IS NOT NULL' : ''}
		${onlyMedia ? 'AND EXISTS (SELECT 1 FROM media_attachments pm WHERE pm.status_id = s.id)' : ''}
		AND ${listableSql('s', '?1')}`
}

export const publicTimeline = optionalUserReadOperation<PublicTimelineInput, Page<Status>>((db, input, viewerId) => {
	const cursor = statusPage(input.page)
	const rows = db.all<{ id: string }>(
		`SELECT s.id FROM statuses s JOIN accounts pa ON pa.id = s.account_id
			WHERE ${publicConditions(input.local, input.remote, input.onlyMedia)}
				AND (s.in_reply_to_uri IS NULL OR EXISTS (SELECT 1 FROM statuses pp
					WHERE pp.id = s.in_reply_to_id AND pp.account_id = s.account_id))
				AND ${cursorSql('s.id')}
			ORDER BY s.id ${cursor.ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
		viewerId,
		cursor.max,
		cursor.min,
		cursor.limit
	)
	return statusesPage(db, ids(rows), cursor, viewerId, input.present)
})

export type TagTimelineInput = PublicTimelineInput & { tag: string; any: string[]; all: string[]; none: string[] }

// Public statuses with the tag or any of `any`, all of `all` and none of `none` (Mastodon's TagFeed).
export const tagTimeline = optionalUserReadOperation<TagTimelineInput, Page<Status>>((db, input, viewerId) => {
	const cursor = statusPage(input.page)
	const tags = (names: string[]) => JSON.stringify([...new Set(names.map(normalizeTag))])
	const rows = db.all<{ id: string }>(
		`SELECT s.id FROM statuses s JOIN accounts pa ON pa.id = s.account_id
		WHERE s.id IN (SELECT status_id FROM status_tags WHERE name IN (SELECT value FROM json_each(?5)))
			AND NOT EXISTS (SELECT 1 FROM json_each(?6) t
				WHERE NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id AND st.name = t.value))
			AND NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id AND st.name IN (SELECT value FROM json_each(?7)))
			AND ${publicConditions(input.local, input.remote, input.onlyMedia)}
			AND ${cursorSql('s.id')}
		ORDER BY s.id ${cursor.ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
		viewerId,
		cursor.max,
		cursor.min,
		cursor.limit,
		tags([input.tag, ...input.any]),
		tags(input.all),
		tags(input.none)
	)
	return statusesPage(db, ids(rows), cursor, viewerId, input.present)
})

export type AccountStatusesInput = {
	account: string
	page: PageQuery
	onlyMedia: boolean
	excludeReplies: boolean
	excludeReblogs: boolean
	pinned: boolean
	tagged: string | null
	present: Present
}

// An account's statuses as the viewer may see them (Mastodon's Status.permitted_for): nothing when either blocks the
// other; boosts of accounts the viewer blocks, mutes or domain-blocks, and of originals they may not see, are left
// out. The account's own statuses are shown even if the viewer mutes it, as on its profile. exclude_replies keeps
// replies to the account itself (threads). Pins do not exist yet: pinned=true is an empty list.
export const accountStatuses = optionalUserReadOperation<AccountStatusesInput, Page<Status> | null>(
	(db, input, viewerId) => {
		const accountId = resolveAccountId(db, input.account)
		if (accountId === null) {
			return null
		}
		const cursor = statusPage(input.page)
		if (input.pinned) {
			return { items: [], newest: null, oldest: null }
		}
		const rows = db.all<{ id: string }>(
			`SELECT s.id FROM statuses s
			WHERE s.account_id = ?5 AND ${visibleSql('s', '?1')}
				AND NOT EXISTS (SELECT 1 FROM blocks ub WHERE ub.account_id IS ?1 AND ub.target_account_id = s.account_id)
				AND (s.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM statuses o WHERE o.id = s.reblog_of_id
					AND ${visibleSql('o', '?1')} AND ${unfilteredSql('o', '?1')}))
				${input.onlyMedia ? 'AND EXISTS (SELECT 1 FROM media_attachments um WHERE um.status_id = s.id)' : ''}
				${
					input.excludeReplies
						? `AND (s.in_reply_to_uri IS NULL OR EXISTS (SELECT 1 FROM statuses up
							WHERE up.id = s.in_reply_to_id AND up.account_id = s.account_id))`
						: ''
				}
				${input.excludeReblogs ? 'AND s.reblog_of_id IS NULL' : ''}
				AND (?6 IS NULL OR EXISTS (SELECT 1 FROM status_tags ut WHERE ut.status_id = s.id AND ut.name = ?6))
				AND ${cursorSql('s.id')}
			ORDER BY s.id ${cursor.ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			viewerId,
			cursor.max,
			cursor.min,
			cursor.limit,
			accountId,
			input.tagged === null ? null : normalizeTag(input.tagged)
		)
		return statusesPage(db, ids(rows), cursor, viewerId, input.present)
	}
)

// Bookmarks and favourites, newest first by the edge's id, through the list rule: a status that is no longer
// visible to the viewer (say, they stopped following a private author) or that they filter is not listed.
function edgeList(table: 'bookmarks' | 'favourites') {
	return userReadOperation<{ page: PageQuery; present: Present }, Page<Status>>(
		(db, { page, present }, { accountId }) => {
			const ascending = page.minId !== undefined
			const rows = db.all<{ cursor: string; id: string }>(
				`SELECT CAST(e.id AS TEXT) AS cursor, e.status_id AS id FROM ${table} e JOIN statuses s ON s.id = e.status_id
			WHERE e.account_id = ?1 AND ${listableSql('s', '?1')}
				AND (?2 IS NULL OR e.id < CAST(?2 AS INTEGER)) AND (?3 IS NULL OR e.id > CAST(?3 AS INTEGER))
			ORDER BY e.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
				accountId,
				page.maxId ?? null,
				page.minId ?? page.sinceId ?? null,
				page.limit
			)
			if (ascending) {
				rows.reverse()
			}
			return {
				items: presentStatuses(db, ids(rows), { ...present, viewerId: accountId }),
				newest: rows[0]?.cursor ?? null,
				oldest: rows.at(-1)?.cursor ?? null,
			}
		}
	)
}

export const bookmarks = edgeList('bookmarks')
export const favourites = edgeList('favourites')
