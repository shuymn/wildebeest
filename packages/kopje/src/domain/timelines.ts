import { edgeRangeSql, type Page, type PageQuery, type Present, resolveAccountId } from './accounts'
import {
	blocksSql,
	filteredForSql,
	NOT_A_REPLY_TO_OTHERS,
	REACHES_FOLLOWERS_SQL,
	REQUIRES_MENTION_SQL,
	type StatusSelect,
	statusReads,
	type VisibleStatusId,
	visibleSql,
} from './audience'
import { optionalUserReadOperation, userReadOperation } from './auth'
import { ownList, type RepliesPolicy } from './lists'
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

type Cursor = { max: string | null; min: string | null; ascending: boolean; limit: number }

function statusPage(page: PageQuery): Cursor {
	return {
		max: statusCursor(page.maxId),
		min: statusCursor(page.minId ?? page.sinceId),
		ascending: page.minId !== undefined,
		limit: page.limit,
	}
}

// The cursor as a plain range, with ?2 and ?3 bound by rangeParams: no cursor is '' or ':', below and above every id of
// digits. A read in an index ending in the column then starts at the cursor, not at the newest.
function rangeSql(column: string): string {
	return `${column} < ?2 AND ${column} > ?3`
}

function rangeParams(cursor: Cursor): [string, string] {
	return [cursor.max ?? ':', cursor.min ?? '']
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

// The reply rule home applies, and a list whose replies_policy is followed (?1 the viewer): a reply to an account the
// viewer follows (accepted), and any reply of the viewer's own.
const FOLLOWED_REPLIES_SQL = `s.account_id = ?1 OR EXISTS (SELECT 1 FROM follows hr
	WHERE hr.account_id = ?1 AND hr.target_account_id = s.in_reply_to_account_id AND hr.state = 'accepted')`

// The follow's options that home and a list timeline apply to others' statuses, after homeFilterSql (?1 the viewer):
// a boost needs the follow's show_reblogs; a reply passes when its partner is known and is the author or the viewer, or
// when `partner` (the feed's own rule) passes; and a follow's languages filter its own posts. A boost row has language
// NULL, so boosts pass whatever the original's language, as in Mastodon's FeedManager. The viewer's own statuses pass
// the boost and language terms (nobody follows themselves).
function followOptionsSql(partner: string): string {
	return `(s.reblog_of_id IS NULL OR s.account_id = ?1 OR EXISTS (SELECT 1 FROM follows hf
			WHERE hf.account_id = ?1 AND hf.target_account_id = s.account_id AND hf.show_reblogs = 1))
		AND (s.in_reply_to_uri IS NULL OR s.in_reply_to_account_id IN (?1, s.account_id) OR ${partner})
		AND NOT EXISTS (SELECT 1 FROM follows hl WHERE hl.account_id = ?1 AND hl.target_account_id = s.account_id
			AND hl.languages IS NOT NULL AND s.language IS NOT NULL
			AND s.language NOT IN (SELECT value FROM json_each(hl.languages)))`
}

// The members of the viewer's (?1) exclusive lists, pending ones included (Mastodon's
// FeedManager#crutches_exclusive_list_users): home leaves out their statuses and boosts (filter_from_home's
// :skip_home), and shows them in those lists only. A non-correlated subquery, read once per query: the viewer's lists
// and their members. Only home applies it: a post notification still follows homeFilterSql (shownSql), as
// FeedInsertWorker#notify? lets :skip_home through.
const EXCLUSIVE_MEMBERS = `(SELECT ela.account_id FROM lists el JOIN list_accounts ela ON ela.list_id = el.id
	WHERE el.account_id = ?1 AND el.exclusive = 1)`

// The accounts home shows (?1 the viewer): those the viewer follows (accepted), but for members of their exclusive lists.
const FOLLOWED = `SELECT target_account_id AS account_id FROM follows WHERE account_id = ?1 AND state = 'accepted'
	AND target_account_id NOT IN ${EXCLUSIVE_MEMBERS}`

// Home (Mastodon's FeedManager#filter_from_home): the viewer's own statuses and those of accounts they follow,
// public, unlisted and private; direct and limited statuses of their own, and of followed accounts that address
// them. Boosts from follows with show_reblogs off, replies (of others) unless they are to the author, to the viewer or
// to an account the viewer follows, and posts outside a follow's languages are left out, and so is what home hides for
// the viewer's choices (homeFilterSql: blocks, mutes, domain blocks, invisible originals, and a status or boosted
// original that mentions an account the viewer blocks or mutes; the viewer's own statuses always pass, as in
// FeedManager#filter_from_home). A reply whose partner is unknown (in_reply_to_account_id NULL: its parent was never
// stored, or the partner's account was purged) is left out too, so a purge does not bring back a reply home hid. A
// reply whose parent is deleted keeps its partner. Others' statuses leave home when their author is in one of the
// viewer's exclusive lists (EXCLUSIVE_MEMBERS); the viewer's own never do.
// It reads three streams, each from the cursor through an index, and merges them: a window of each followed account's
// public, unlisted and private statuses (AuthorWindows, on statuses_feed) with every filter inside the window; the
// viewer's own statuses; and a window of each followed account's direct and limited statuses that mention the viewer,
// from the viewer's mentions by that account in such statuses (status_mentions.requires_mention). A page reads at most
// a page of statuses per followed account in each window, and those a follow's options or homeFilterSql leave out on
// the way, however long their history; the viewer's own statuses cost a page, and mentions by accounts the viewer does
// not follow, or in public, unlisted and private statuses, are never read.
export const homeTimeline = userReadOperation<{ page: PageQuery; present: Present }, Page<Status>>(
	(db, { page, present }, _viewer, viewer) => {
		const { accountId, now } = viewer
		const cursor = statusPage(page)
		const order = cursor.ascending ? 'ASC' : 'DESC'
		const read = statusReads(viewer, { viewer: '?1', now: '?5' })
		const options = followOptionsSql(FOLLOWED_REPLIES_SQL)
		const tail = `ORDER BY s.id ${order} LIMIT ?4`
		const rows = read.union(
			db,
			'homeFilter',
			{
				all: true,
				branches: [
					// The public, unlisted and private statuses of the accounts home shows: a window of each, on statuses_feed.
					{
						authors: FOLLOWED,
						where: `${FEED} AND ${rangeSql('s.id')}`,
						and: options,
						tail,
					},
					// The viewer's own, whatever their visibility: the rule shows them all, so this reads at most a page. No
					// follow's options apply (nobody follows themselves).
					{ where: `s.account_id = ?1 AND ${rangeSql('s.id')}`, tail },
					// Direct and limited statuses of the accounts home shows that address the viewer: a window of each, from
					// the viewer's mentions by that account in such statuses (status_mentions_requires_mention).
					{
						authors: FOLLOWED,
						from: 'status_mentions m JOIN',
						join: 'ON s.id = m.status_id',
						author: 'm.author_id',
						where: `m.account_id = ?1 AND m.requires_mention = 1 AND ${rangeSql('m.status_id')}
							AND s.visibility IN ${REQUIRES_MENTION_SQL}`,
						and: options,
						tail: `ORDER BY m.status_id ${order} LIMIT ?4`,
					},
				],
				tail: `ORDER BY id ${order} LIMIT ?4`,
			},
			accountId,
			...rangeParams(cursor),
			cursor.limit,
			now
		)
		return statusesPage(db, ids(rows), cursor, accountId, present)
	}
)

// The rule a list's replies_policy adds for a reply to someone other than its author or the owner (?1), with the list
// at ?6 (Mastodon's FeedManager#filter_from_list? and the list's crutches_following): followed, an account the owner
// follows, and any reply of the owner's own; list, a member of the list (pending included); none, nothing more.
function repliesPolicySql(policy: RepliesPolicy): string {
	switch (policy) {
		case 'followed':
			return FOLLOWED_REPLIES_SQL
		case 'list':
			return 'EXISTS (SELECT 1 FROM list_accounts lr WHERE lr.list_id = ?6 AND lr.account_id = s.in_reply_to_account_id)'
		case 'none':
			return '0'
	}
}

// A list's timeline (Mastodon's ListFeed, filled by FanOutOnWriteService#deliver_to_lists and FeedManager#filter with
// timeline_type :list): the public, unlisted and private statuses and boosts of its active members, the owner (when
// a member) and the accounts the owner follows (accepted; a member with a pending request contributes nothing until it
// is accepted). Home's filters apply as filter_from_home applies them to a list (homeFilterSql, and the follow's boosts
// and languages), with the list's replies_policy deciding which replies to others pass; exclusive does not matter here.
// As home, it reads a window of each member's statuses (AuthorWindows), through statuses_feed. Null when the list is not
// the viewer's.
export const listTimeline = userReadOperation<{ id: string; page: PageQuery; present: Present }, Page<Status> | null>(
	(db, { id, page, present }, _viewer, viewer) => {
		const { accountId, now } = viewer
		const list = ownList(db, accountId, id)
		if (list === undefined) {
			return null
		}
		const cursor = statusPage(page)
		const read = statusReads(viewer, { viewer: '?1', now: '?5' })
		const order = cursor.ascending ? 'ASC' : 'DESC'
		const rows = read.union(
			db,
			'homeFilter',
			{
				all: true,
				branches: [
					{
						authors: `SELECT la.account_id FROM list_accounts la WHERE la.list_id = ?6
							AND (la.account_id = ?1 OR EXISTS (SELECT 1 FROM follows lf
								WHERE lf.account_id = ?1 AND lf.target_account_id = la.account_id AND lf.state = 'accepted'))`,
						where: `${FEED} AND ${rangeSql('s.id')}`,
						and: followOptionsSql(repliesPolicySql(list.replies_policy)),
						tail: `ORDER BY s.id ${order} LIMIT ?4`,
					},
				],
				tail: `ORDER BY id ${order} LIMIT ?4`,
			},
			accountId,
			...rangeParams(cursor),
			cursor.limit,
			now,
			list.id
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
			and: `${NOT_A_REPLY_TO_OTHERS} AND ${rangeSql('s.id')}`,
			tail: `ORDER BY s.id ${cursor.ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
		},
		viewerId,
		...rangeParams(cursor),
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
	// cursor is a plain range (rangeSql), so each branch starts in the index at the cursor, walks it in order and stops
	// at LIMIT.
	const branch = (n: number): StatusSelect => ({
		from: 'status_tags t CROSS JOIN',
		join: 'ON s.id = t.status_id JOIN accounts pa ON pa.id = s.account_id',
		where: `t.public = 1 AND t.name = ?${8 + n}
			AND NOT EXISTS (SELECT 1 FROM json_each(?5) a
				WHERE NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id AND st.name = a.value))
			AND NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id
				AND st.name IN (SELECT value FROM json_each(?6)))
			AND ${publicConditions(input.local, input.remote, input.onlyMedia)}`,
		and: rangeSql('t.status_id'),
		tail: `ORDER BY t.status_id ${order} LIMIT ?4`,
	})
	const rows = read.union(
		db,
		'listable',
		{ all: false, branches: names.map((_, n) => branch(n)), tail: `ORDER BY id ${order} LIMIT ?4` },
		viewerId,
		...rangeParams(cursor),
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
					AND ${rangeSql('s.id')}`,
				tail: `ORDER BY s.id ${cursor.ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
			},
			viewerId,
			...rangeParams(cursor),
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
					and: edgeRangeSql('e.id', '?2', '?3'),
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
