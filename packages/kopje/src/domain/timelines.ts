import { type Page, type PageQuery, type Present, resolveAccountId } from './accounts'
import {
	blocksSql,
	filteredForSql,
	REACHES_FOLLOWERS_SQL,
	REQUIRES_MENTION_SQL,
	type StatusSelect,
	statusReads,
	type VisibleStatusId,
	visibleSql,
} from './audience'
import { optionalUserReadOperation, userReadOperation } from './auth'
import { presentStatuses, type Status } from './status-presenter'
import { statusCursor } from './statuses'
import { normalizeTag } from './tag-name'
import type { Db } from '../db/sql'

// Timelines (design §6 "timelines"): each is one query over statuses, newest first, paged by status id (18-digit
// TEXT, compared as TEXT) or, for bookmarks and favourites, by the edge's INTEGER id. Every row passes the audience
// rule in the query itself (statusReads in audience.ts), so a page is never filled with statuses the viewer may not
// see, and its ids are ones the presenter accepts. The feed condition is the visibility list the partial index
// statuses_feed declares (REACHES_FOLLOWERS_SQL).

const FEED = `s.visibility IN ${REACHES_FOLLOWERS_SQL}`

// Status.without_replies: not a reply, or a reply in the author's own conversation (in_reply_to_account_id carries
// the partner through self-replies, so continuing a reply to someone else is still a reply to them).
export const NOT_A_REPLY_TO_OTHERS = '(s.in_reply_to_uri IS NULL OR s.in_reply_to_account_id = s.account_id)'

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

function statusesPage(
	db: Db,
	ids: VisibleStatusId[],
	cursor: Cursor,
	viewerId: string | null,
	present: Present
): Page<Status> {
	if (cursor.ascending) {
		ids.reverse()
	}
	return {
		items: presentStatuses(db, ids, { ...present, viewerId }),
		newest: ids[0] ?? null,
		oldest: ids.at(-1) ?? null,
	}
}

function ids<Id>(rows: { id: Id }[]): Id[] {
	return rows.map((row) => row.id)
}

// Home (Mastodon's FeedManager#filter_from_home): the viewer's own statuses and those of accounts they follow,
// public, unlisted and private; direct and limited statuses of their own, and of followed accounts that address
// them. Boosts from follows with show_reblogs off, replies (of others) unless they are to the author, to the viewer or
// to an account the viewer follows, and posts outside a follow's languages are left out, and so is what home hides for
// the viewer's choices (homeFilterSql: blocks, mutes, domain blocks, invisible originals, and a status or boosted
// original that mentions an account the viewer blocks or mutes; the viewer's own statuses always pass, as in
// FeedManager#filter_from_home). A reply whose partner is unknown (in_reply_to_account_id NULL: its parent was never
// stored, or the partner's account was purged) is left out too, so a purge does not bring back a reply home hid. A
// reply whose parent is deleted keeps its partner, and home shows it as before.
export const homeTimeline = userReadOperation<{ page: PageQuery; present: Present }, Page<Status>>(
	(db, { page, present }, _viewer, viewer) => {
		const { accountId, now } = viewer
		const cursor = statusPage(page)
		const order = cursor.ascending ? 'ASC' : 'DESC'
		const read = statusReads(viewer, { viewer: '?1', now: '?5' })
		// After homeFilterSql: the follow's options.
		const options = `(s.reblog_of_id IS NULL OR s.account_id = ?1 OR EXISTS (SELECT 1 FROM follows hf
				WHERE hf.account_id = ?1 AND hf.target_account_id = s.account_id AND hf.show_reblogs = 1))
			AND (s.account_id = ?1 OR s.in_reply_to_uri IS NULL OR s.in_reply_to_account_id IN (?1, s.account_id)
				OR EXISTS (SELECT 1 FROM follows hr
					WHERE hr.account_id = ?1 AND hr.target_account_id = s.in_reply_to_account_id AND hr.state = 'accepted'))
			-- A follow's languages filter its own posts. A boost row has language NULL, so boosts pass whatever the
			-- original's language, as in Mastodon's FeedManager.
			AND NOT EXISTS (SELECT 1 FROM follows hl WHERE hl.account_id = ?1 AND hl.target_account_id = s.account_id
				AND hl.languages IS NOT NULL AND s.language IS NOT NULL
				AND s.language NOT IN (SELECT value FROM json_each(hl.languages)))`
		const tail = `ORDER BY s.id ${order} LIMIT ?4`
		const rows = read.union(
			db,
			'homeFilter',
			{
				all: true,
				branches: [
					{
						where: `s.account_id IN (SELECT ?1 UNION ALL
								SELECT target_account_id FROM follows WHERE account_id = ?1 AND state = 'accepted')
							AND ${FEED} AND ${cursorSql('s.id')}`,
						and: options,
						tail,
					},
					// The viewer's own: no follow's options apply (nobody follows themselves).
					{
						where: `s.account_id = ?1 AND s.visibility IN ${REQUIRES_MENTION_SQL} AND ${cursorSql('s.id')}`,
						tail,
					},
					{
						from: 'status_mentions m JOIN',
						join: 'ON s.id = m.status_id',
						where: `m.account_id = ?1 AND s.account_id <> ?1 AND s.visibility IN ${REQUIRES_MENTION_SQL}
							AND EXISTS (SELECT 1 FROM follows df
								WHERE df.account_id = ?1 AND df.target_account_id = s.account_id AND df.state = 'accepted')
							AND ${cursorSql('s.id')}`,
						and: options,
						tail,
					},
				],
				tail: `ORDER BY id ${order} LIMIT ?4`,
			},
			accountId,
			cursor.max,
			cursor.min,
			cursor.limit,
			now
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
// (Mastodon's PublicFeed). Never unlisted, private, direct or limited. The list rule (listableSql) follows these.
function publicConditions(local: boolean, remote: boolean, onlyMedia: boolean): string {
	return `s.visibility = 'public' AND s.reblog_of_id IS NULL
		${local ? 'AND pa.domain IS NULL' : ''} ${remote ? 'AND pa.domain IS NOT NULL' : ''}
		${onlyMedia ? 'AND EXISTS (SELECT 1 FROM media_attachments pm WHERE pm.status_id = s.id)' : ''}`
}

export const publicTimeline = optionalUserReadOperation<PublicTimelineInput, Page<Status>>((db, input, viewer) => {
	const { accountId: viewerId, now } = viewer
	const cursor = statusPage(input.page)
	const read = statusReads(viewer, { viewer: '?1', now: '?5' })
	const rows = read.select(
		db,
		'listable',
		{
			join: 'JOIN accounts pa ON pa.id = s.account_id',
			where: publicConditions(input.local, input.remote, input.onlyMedia),
			and: `${NOT_A_REPLY_TO_OTHERS} AND ${cursorSql('s.id')}`,
			tail: `ORDER BY s.id ${cursor.ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
		},
		viewerId,
		cursor.max,
		cursor.min,
		cursor.limit,
		now
	)
	return statusesPage(db, ids(rows), cursor, viewerId, input.present)
})

export type TagTimelineInput = PublicTimelineInput & { tag: string; any: string[]; all: string[]; none: string[] }

// The most names a hashtag timeline reads: the tag and `any`, which the API caps at four as Mastodon's TagFeed does.
// Each is a term of one compound SELECT, and the Store's SQLite allows five.
const MAX_TAG_TIMELINE_NAMES = 5

// Public statuses with the tag or any of `any`, all of `all` and none of `none` (Mastodon's TagFeed). Each name is
// read on its own, from the public rows of status_tags (status_tags.public, through the partial index
// status_tags_public) in status id order, with every condition applied, until it has a page: so the read never goes
// through the tag's unlisted, private, direct or limited statuses, and it stops at the page however many statuses the
// tag has. The pages of the names are then merged (a status may carry several) and cut to one page.
export const tagTimeline = optionalUserReadOperation<TagTimelineInput, Page<Status>>((db, input, viewer) => {
	const { accountId: viewerId, now } = viewer
	const cursor = statusPage(input.page)
	const order = cursor.ascending ? 'ASC' : 'DESC'
	const read = statusReads(viewer, { viewer: '?1', now: '?7' })
	const unique = (names: string[]) => [...new Set(names.map(normalizeTag))]
	const names = unique([input.tag, ...input.any]).slice(0, MAX_TAG_TIMELINE_NAMES)
	// ?5 all, ?6 none, ?7 now, then one parameter per name from ?8. CROSS JOIN keeps status_tags outermost, and the
	// cursor is a plain range (no cursor: '' and ':', below and above every id of digits), so each branch starts in
	// the index at the cursor, walks it in order and stops at LIMIT.
	const branch = (n: number): StatusSelect => ({
		from: 'status_tags t CROSS JOIN',
		join: 'ON s.id = t.status_id JOIN accounts pa ON pa.id = s.account_id',
		where: `t.public = 1 AND t.name = ?${8 + n}
			AND NOT EXISTS (SELECT 1 FROM json_each(?5) a
				WHERE NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id AND st.name = a.value))
			AND NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id
				AND st.name IN (SELECT value FROM json_each(?6)))
			AND ${publicConditions(input.local, input.remote, input.onlyMedia)}`,
		and: 't.status_id < ?2 AND t.status_id > ?3',
		tail: `ORDER BY t.status_id ${order} LIMIT ?4`,
	})
	const rows = read.union(
		db,
		'listable',
		{ all: false, branches: names.map((_, n) => branch(n)), tail: `ORDER BY id ${order} LIMIT ?4` },
		viewerId,
		cursor.max ?? ':',
		cursor.min ?? '',
		cursor.limit,
		JSON.stringify(unique(input.all)),
		JSON.stringify(unique(input.none)),
		now,
		...names
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
	(db, input, viewer) => {
		const { accountId: viewerId, now } = viewer
		const accountId = resolveAccountId(db, input.account)
		if (accountId === null) {
			return null
		}
		const cursor = statusPage(input.page)
		if (input.pinned) {
			return { items: [], newest: null, oldest: null }
		}
		const read = statusReads(viewer, { viewer: '?1', now: '?7' })
		const rows = read.select(
			db,
			'visible',
			{
				where: 's.account_id = ?5',
				and: `NOT ${blocksSql('?1', 's.account_id')}
					AND (s.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM statuses o WHERE o.id = s.reblog_of_id
						AND ${visibleSql('o', '?1')} AND NOT ${filteredForSql('o.account_id', '?1', '?7')}))
					${input.onlyMedia ? 'AND EXISTS (SELECT 1 FROM media_attachments um WHERE um.status_id = s.id)' : ''}
					${input.excludeReplies ? `AND ${NOT_A_REPLY_TO_OTHERS}` : ''}
					${input.excludeReblogs ? 'AND s.reblog_of_id IS NULL' : ''}
					AND (?6 IS NULL OR EXISTS (SELECT 1 FROM status_tags ut WHERE ut.status_id = s.id AND ut.name = ?6))
					AND ${cursorSql('s.id')}`,
				tail: `ORDER BY s.id ${cursor.ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			},
			viewerId,
			cursor.max,
			cursor.min,
			cursor.limit,
			accountId,
			input.tagged === null ? null : normalizeTag(input.tagged),
			now
		)
		return statusesPage(db, ids(rows), cursor, viewerId, input.present)
	}
)

// Bookmarks and favourites, newest first by the edge's id, through the list rule: a status that is no longer
// visible to the viewer (say, they stopped following a private author) or that they filter is not listed.
function edgeList(table: 'bookmarks' | 'favourites') {
	return userReadOperation<{ page: PageQuery; present: Present }, Page<Status>>(
		(db, { page, present }, _viewer, viewer) => {
			const { accountId, now } = viewer
			const ascending = page.minId !== undefined
			const read = statusReads(viewer, { viewer: '?1', now: '?5' })
			const rows = read.select<{ cursor: string }>(
				db,
				'listable',
				{
					from: `${table} e JOIN`,
					join: 'ON s.id = e.status_id',
					where: 'e.account_id = ?1',
					and: '(?2 IS NULL OR e.id < CAST(?2 AS INTEGER)) AND (?3 IS NULL OR e.id > CAST(?3 AS INTEGER))',
					tail: `ORDER BY e.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
					columns: { cursor: 'CAST(e.id AS TEXT)' },
				},
				accountId,
				page.maxId ?? null,
				page.minId ?? page.sinceId ?? null,
				page.limit,
				now
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
