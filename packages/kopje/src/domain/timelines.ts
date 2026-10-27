import { edgeRangeSql, type Page, type PageQuery, type Present, resolveAccountId } from './accounts'
import { admit, type Admitted, admittedPage, ARRAY_ANSWER_BYTES } from './answer-budget'
import {
	audienceSql,
	blocksSql,
	DISTRIBUTABLE_SQL,
	filteredForSql,
	NOT_A_REPLY_TO_OTHERS,
	REACHES_FOLLOWERS_SQL,
	REQUIRES_MENTION_SQL,
	type StatusRule,
	statusReads,
	type ViewerContext,
	type VisibleStatusId,
	visibleSql,
} from './audience'
import { optionalUserReadOperation, type UserContext, userReadOperation } from './auth'
import { holdingSql, ownList, type RepliesPolicy } from './lists'
import { presentation, type Status, statusStream } from './status-presenter'
import { statusCursor } from './statuses'
import { normalizeTag } from './tag-name'
import { listedTrendLinkSql, publicCopiesSql, trendSettings } from './trends'
import { mergedWindow, readWindow, singleWindow, streamWindow, type Window, windowJson, windowPage } from './windows'
import { STATUSES_ID_INDEX } from '../db/indexes'
import type { Db } from '../db/sql'
import { CARD_PUBLIC_LINK_INDEX } from '../platform/stored-bounds'

// Timelines (design §6 "timelines"): newest first, paged by status id (18-digit TEXT, compared as TEXT) or, for
// bookmarks and favourites, by the edge's INTEGER id. A page reads a candidate window from its cursor (windows.ts,
// docs/visibility.md "Read bounds") and applies the audience rule to those candidates (statusReads in audience.ts),
// so its ids are ones the presenter accepts and a range the rule hides costs a window, not its length. The feed
// condition is the visibility list the partial index statuses_feed declares (REACHES_FOLLOWERS_SQL). A page is one
// answer within ANSWER_BYTES (RES-3, admittedPage): cut there, it is Page.cut and continues from its last status.

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

function orderOf(cursor: Cursor): 'ASC' | 'DESC' {
	return cursor.ascending ? 'ASC' : 'DESC'
}

function rangeParams(cursor: Cursor): [string, string] {
	return [cursor.max ?? ':', cursor.min ?? '']
}

// How a list read admits its presented statuses, in traversal order (RES-3). An API answer is one JSON array of them,
// admitted with `leading` (answerAdmission); a web page's list shares the page's budget (domain/web-pages/budget.ts).
export type StatusAdmission = (entries: Iterable<Status | undefined>) => Admitted<Status>

export const answerAdmission: StatusAdmission = (entries) => admit(entries, ARRAY_ANSWER_BYTES, true)

// A page of statuses and whether a continuation follows it (design §4): the page was full, or it was cut by its
// candidate window or by bytes.
export type StatusList = { page: Page<Status>; more: boolean }

// The page of a window of status ids: the candidates `rule` passes for the viewer, and `and` (over ?1 the viewer, ?2
// the time, c.o the candidate's stream bits, and `params` from ?4), each a key lookup, presented.
function windowStatuses(
	db: Db,
	viewer: ViewerContext,
	rule: StatusRule,
	window: Window,
	cursor: Cursor,
	present: Present,
	and?: string,
	...params: SqlStorageValue[]
): Page<Status> {
	return windowStatusesWithin(db, viewer, rule, window, cursor, present, answerAdmission, and, ...params).page
}

// windowStatuses, admitted by `admission`.
function windowStatusesWithin(
	db: Db,
	viewer: ViewerContext,
	rule: StatusRule,
	window: Window,
	cursor: Cursor,
	present: Present,
	admission: StatusAdmission,
	and?: string,
	...params: SqlStorageValue[]
): StatusList {
	const passed =
		window.candidates.length === 0
			? []
			: statusReads(viewer, { viewer: '?1', now: '?2' }).select(
					db,
					rule,
					{ from: 'json_each(?3) c CROSS JOIN', join: "ON s.id = json_extract(c.value, '$.id')", and },
					viewer.accountId,
					viewer.now,
					windowJson(window),
					...params
				)
	const page = windowPage(window, passed, (row) => row.id, cursor.limit, cursor.ascending)
	const presented = presentedPage(
		db,
		viewer,
		page,
		page.rows.map((row) => row.id),
		page.rows.map((row) => row.id),
		cursor.ascending,
		present,
		admission
	)
	return { page: presented, more: page.rows.length >= cursor.limit || presented.cut === true }
}

// A page of statuses (`ids`, newest first, and each one's cursor in `keys`) presented within the answer budget,
// admitted in traversal order (admittedPage).
function presentedPage(
	db: Db,
	viewer: ViewerContext,
	page: { newest: string | null; oldest: string | null; cut?: boolean },
	ids: readonly VisibleStatusId[],
	keys: readonly string[],
	ascending: boolean,
	present: Present,
	admission: StatusAdmission = answerAdmission
): Page<Status> {
	const shared = presentation(db, ids, { ...present, viewer })
	return admittedPage(
		{ ...page, rows: ids.map((_, i) => i) },
		ascending,
		(i) => keys[i] ?? '',
		(traversal) =>
			admission(
				statusStream(
					db,
					shared,
					traversal.flatMap((i) => ids[i] ?? [])
				)
			)
	)
}

// The stream bits of home's candidates (Window.o), and what each needs beyond the rule: the viewer's own pass; a
// followed account's need the follow's options; a followed hashtag's must be a public original.
const OWN = 1
const FOLLOWED_STREAM = 2
const TAG_STREAM = 4

function streamBitsSql(options: string): string {
	return `((json_extract(c.value, '$.o') & ${OWN}) <> 0
		OR ((json_extract(c.value, '$.o') & ${FOLLOWED_STREAM}) <> 0 AND ${options})
		OR ((json_extract(c.value, '$.o') & ${TAG_STREAM}) <> 0 AND s.visibility = 'public' AND s.reblog_of_id IS NULL))`
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

// FOLLOWED for home narrowed to the status ?7 (homeStatus): its author, if the viewer follows it (accepted) and it is in
// none of their exclusive lists. The exclusion is read from the viewer's lists (lists_account, at most MAX_LISTS), each
// checked through the (list_id, account_id) key, so it reads neither the members of those lists nor the lists of other
// owners that hold the author.
const FOLLOWED_AUTHOR = `SELECT hf.target_account_id AS account_id FROM follows hf
	WHERE hf.account_id = ?1 AND hf.state = 'accepted'
		AND hf.target_account_id = (SELECT ha.account_id FROM statuses ha WHERE ha.id = ?7)
		AND NOT EXISTS (SELECT 1 FROM lists l WHERE l.exclusive = 1 AND ${holdingSql('?1', 'hf.target_account_id')})`

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
// Home also shows the public statuses, not boosts, that carry a hashtag the viewer follows (tag_follows), as Mastodon's
// FanOutOnWriteService#deliver_to_hashtag_followers! puts a broadcastable status into its followers' home feeds, with
// homeFilterSql as FeedManager#filter_from_tags? (none of the follow's options or exclusive lists apply to them). As
// home is a read, they include those posted before the follow, and leave home when it ends.
// A page reads one merged candidate window (homeWindow) of four kinds of streams, each from the cursor through an
// index, and then applies the rule, the follow's options and homeFilterSql to its candidates: each followed account's
// public, unlisted and private statuses (on statuses_feed); the viewer's own statuses; each followed account's direct
// and limited statuses that mention the viewer, from the viewer's mentions by that account in such statuses
// (status_mentions.requires_mention); and each followed hashtag's public statuses, from its public hashtag rows
// (status_tags_public). An account the rule rejects as a whole (unavailable, blocking the viewer, or filtered by them)
// has no streams. A status in more than one stream is shown once. Mentions by accounts the viewer does not follow, or
// in public, unlisted and private statuses, are never read, and neither are a hashtag's statuses that are not public.
// The followed hashtags are capped (MAX_FOLLOWED_TAGS in tags.ts).
export const homeTimeline = userReadOperation<{ page: PageQuery; present: Present }, Page<Status>>(
	(db, { page, present }, _viewer, viewer) => {
		const cursor = statusPage(page)
		const and = streamBitsSql(followOptionsSql(FOLLOWED_REPLIES_SQL))
		return windowStatuses(db, viewer, 'homeFilter', homeWindow(db, viewer, cursor), cursor, present, and)
	}
)

// Home's candidate window (mergedWindow; docs/visibility.md "Read bounds"): each stream is one index walk from the
// cursor that stops at streamWindow(limit), whatever the rule leaves out, and the merge ends at the highest end of a
// stream that filled, so no candidate below it is passed over. Candidates keep audienceSql; a followed hashtag's are
// public originals, probed by their key, since status_tags.public can trail the status: a remote status's removal
// hides the status in one write and takes its hashtags off the index over its batches (inbox.ts deleteStatusBatch),
// and an imported boost may hold hashtag rows of its own.
function homeWindow(db: Db, viewer: UserContext, cursor: Cursor): Window {
	const order = orderOf(cursor)
	const authors = `SELECT fa.account_id FROM (${FOLLOWED}) fa
		WHERE ${statusReads(viewer, { viewer: '?1', now: '?5' }).authorRule('homeFilter', 'fa.account_id')}`
	return mergedWindow(
		db,
		{
			streams: `SELECT w.id AS id, 'a' || a.account_id AS k, ${FOLLOWED_STREAM} AS o FROM (${authors}) a
					CROSS JOIN statuses w ON w.id IN (SELECT s.id FROM statuses s
						WHERE s.account_id = a.account_id AND ${FEED} AND ${rangeSql('s.id')} AND ${audienceSql('s', '?1')}
						ORDER BY s.id ${order} LIMIT ?4)
				UNION ALL SELECT id, 'own', ${OWN} FROM (SELECT s.id FROM statuses s
					WHERE s.account_id = ?1 AND ${rangeSql('s.id')} ORDER BY s.id ${order} LIMIT ?4)
				UNION ALL SELECT w.id, 'm' || a.account_id, ${FOLLOWED_STREAM} FROM (${authors}) a
					CROSS JOIN statuses w ON w.id IN (SELECT m.status_id FROM status_mentions m
						CROSS JOIN statuses s ON s.id = m.status_id
						WHERE m.account_id = ?1 AND m.author_id = a.account_id AND m.requires_mention = 1
							AND ${rangeSql('m.status_id')} AND ${audienceSql('s', '?1')}
						ORDER BY m.status_id ${order} LIMIT ?4)
				UNION ALL SELECT w.id, 't' || g.name, ${TAG_STREAM} FROM tag_follows g
					CROSS JOIN statuses w ON w.id IN (SELECT t.status_id FROM status_tags t
						WHERE t.name = g.name AND t.public = 1 AND ${rangeSql('t.status_id')}
							AND EXISTS (SELECT 1 FROM statuses x INDEXED BY ${STATUSES_ID_INDEX}
								WHERE x.id = t.status_id AND x.visibility = 'public' AND x.reblog_of_id IS NULL)
						ORDER BY t.status_id ${order} LIMIT ?4)
					WHERE g.account_id = ?1`,
			ascending: cursor.ascending,
			per: streamWindow(cursor.limit),
			size: readWindow(cursor.limit),
		},
		viewer.accountId,
		...rangeParams(cursor),
		streamWindow(cursor.limit),
		viewer.now
	)
}

// R33 for `update` and `status.update` on the `user` stream (streaming.ts): home positioned at the status `statusId`,
// that is the read with max_id just above it and limit 1, narrowed to it (statusReads' `only`): its author's window
// alone, the exclusive-list exclusion for that author alone, and the followed hashtags among its own. From the cursor
// just above it, the status is the first candidate of each of its streams, so it is in the positioned read's window
// whatever the windows' sizes, and the narrowed read returns it exactly when that read does. Each narrowed set is read
// through an index, so the work does not grow with the viewer's follows, lists, followed hashtags or anyone's statuses.
export function homeStatus(db: Db, viewer: UserContext, statusId: string) {
	const cursor = positionedAt(statusId)
	return cursor === null ? null : (homeRows(db, viewer, cursor, statusId)[0]?.id ?? null)
}

// Home's read narrowed to the status `only`, from the cursor positioned at it.
function homeRows(db: Db, viewer: UserContext, cursor: Cursor, only: string) {
	const { accountId, now } = viewer
	const order = orderOf(cursor)
	const read = statusReads(viewer, { viewer: '?1', now: '?5', only: '?7' })
	const options = followOptionsSql(FOLLOWED_REPLIES_SQL)
	const tail = `ORDER BY s.id ${order} LIMIT ?4`
	return read.union(
		db,
		'homeFilter',
		{
			// A status may come from more than one stream (a followed account's, with a followed hashtag).
			all: false,
			branches: [
				// The public, unlisted and private statuses of the accounts home shows, on statuses_feed.
				{ authors: FOLLOWED_AUTHOR, where: `${FEED} AND ${rangeSql('s.id')}`, and: options, tail },
				// The viewer's own, whatever their visibility. No follow's options apply (nobody follows themselves).
				{ where: `s.account_id = ?1 AND ${rangeSql('s.id')}`, tail },
				// Direct and limited statuses of the accounts home shows that address the viewer, from the viewer's mentions
				// by that account in such statuses (status_mentions_requires_mention).
				{
					authors: FOLLOWED_AUTHOR,
					from: 'status_mentions m JOIN',
					join: 'ON s.id = m.status_id',
					author: 'm.author_id',
					where: `m.account_id = ?1 AND m.requires_mention = 1 AND ${rangeSql('m.status_id')}
							AND s.visibility IN ${REQUIRES_MENTION_SQL}`,
					and: options,
					tail: `ORDER BY m.status_id ${order} LIMIT ?4`,
				},
				// The public statuses, not boosts, with a hashtag the viewer follows, among the status's own.
				{
					tags: 'SELECT value AS name FROM json_each(?6)',
					tag: 't.name',
					from: 'status_tags t CROSS JOIN',
					join: 'ON s.id = t.status_id',
					where: `t.public = 1 AND ${rangeSql('t.status_id')}`,
					and: "s.visibility = 'public' AND s.reblog_of_id IS NULL",
					tail: `ORDER BY t.status_id ${order} LIMIT ?4`,
				},
			],
			tail: `ORDER BY id ${order} LIMIT ?4`,
		},
		accountId,
		...rangeParams(cursor),
		cursor.limit,
		now,
		followedTagsOf(db, accountId, only),
		only
	)
}

// The viewer's followed hashtags among the status `only`'s own, each read by its key (tag_follows' (account_id,
// name)): at most MAX_STATUS_TAGS seeks, however many hashtags the viewer follows. As JSON, for homeRows' TagWindows.
function followedTagsOf(db: Db, viewerId: string, only: string): string {
	const rows = db.all<{ name: string }>(
		`SELECT f.name FROM status_tags xt CROSS JOIN tag_follows f ON f.account_id = ?1 AND f.name = xt.name
		WHERE xt.status_id = ?2`,
		viewerId,
		only
	)
	return JSON.stringify(rows.map((row) => row.name))
}

// The rule a list's replies_policy adds for a reply to someone other than its author or the owner (?1), with the list
// at `list` (Mastodon's FeedManager#filter_from_list? and the list's crutches_following): followed, an account the
// owner follows, and any reply of the owner's own; list, a member of the list (pending included); none, nothing more.
function repliesPolicySql(policy: RepliesPolicy, list: string): string {
	switch (policy) {
		case 'followed':
			return FOLLOWED_REPLIES_SQL
		case 'list':
			return `EXISTS (SELECT 1 FROM list_accounts lr WHERE lr.list_id = ${list} AND lr.account_id = s.in_reply_to_account_id)`
		case 'none':
			return '0'
	}
}

// A list's timeline (Mastodon's ListFeed, filled by FanOutOnWriteService#deliver_to_lists and FeedManager#filter with
// timeline_type :list): the public, unlisted and private statuses and boosts of its active members, the owner (when
// a member) and the accounts the owner follows (accepted; a member with a pending request contributes nothing until it
// is accepted). Home's filters apply as filter_from_home applies them to a list (homeFilterSql, and the follow's boosts
// and languages), with the list's replies_policy deciding which replies to others pass; exclusive does not matter here.
// As home, a page reads one merged candidate window of each active member's statuses through statuses_feed
// (listWindow), then applies the rule to it. Null when the list is not the viewer's.
export const listTimeline = userReadOperation<{ id: string; page: PageQuery; present: Present }, Page<Status> | null>(
	(db, { id, page, present }, _viewer, viewer) => {
		const list = ownList(db, viewer.accountId, id)
		if (list === undefined) {
			return null
		}
		const cursor = statusPage(page)
		const and = followOptionsSql(repliesPolicySql(list.replies_policy, '?4'))
		const window = listWindow(db, viewer, list.id, cursor)
		// Only the policy `list` reads the list (?4).
		const params = list.replies_policy === 'list' ? [list.id] : []
		return windowStatuses(db, viewer, 'homeFilter', window, cursor, present, and, ...params)
	}
)

// A list's candidate window, as homeWindow's, with a stream per active member; a member the rule rejects as a whole
// has no stream.
function listWindow(db: Db, viewer: UserContext, listId: string, cursor: Cursor): Window {
	const order = orderOf(cursor)
	const authors = `SELECT la.account_id FROM list_accounts la WHERE la.list_id = ?6
		AND (la.account_id = ?1 OR EXISTS (SELECT 1 FROM follows lf
			WHERE lf.account_id = ?1 AND lf.target_account_id = la.account_id AND lf.state = 'accepted'))
		AND ${statusReads(viewer, { viewer: '?1', now: '?5' }).authorRule('homeFilter', 'la.account_id')}`
	return mergedWindow(
		db,
		{
			streams: `SELECT w.id AS id, a.account_id AS k, 0 AS o FROM (${authors}) a
				CROSS JOIN statuses w ON w.id IN (SELECT s.id FROM statuses s
					WHERE s.account_id = a.account_id AND ${FEED} AND ${rangeSql('s.id')} AND ${audienceSql('s', '?1')}
					ORDER BY s.id ${order} LIMIT ?4)`,
			ascending: cursor.ascending,
			per: streamWindow(cursor.limit),
			size: readWindow(cursor.limit),
		},
		viewer.accountId,
		...rangeParams(cursor),
		streamWindow(cursor.limit),
		viewer.now,
		listId
	)
}

// R33 for `update` and `status.update` on a `list` stream (streaming.ts): the list `listId` positioned at the status
// `statusId`, narrowed to it as homeStatus narrows home: the list must be the viewer's (ownList), and its members are
// cut to the status's author, read through the (list_id, account_id) key, so the work does not grow with the list's
// members or anyone's statuses. The status, if that read returns it.
export function listStatus(db: Db, viewer: UserContext, listId: string, statusId: string) {
	const list = ownList(db, viewer.accountId, listId)
	return list === undefined ? null : ownListStatus(db, viewer, list, statusId)
}

// listStatus for a list already found to be the viewer's (ownList), as a delete's capture reads it for the status and
// each of its boosts.
export function ownListStatus(
	db: Db,
	viewer: UserContext,
	list: { id: string; replies_policy: RepliesPolicy },
	statusId: string
) {
	const cursor = positionedAt(statusId)
	return cursor === null ? null : (listRows(db, viewer, list, cursor, statusId)[0]?.id ?? null)
}

// A list's read narrowed to the status `only`, from the cursor positioned at it.
function listRows(
	db: Db,
	viewer: UserContext,
	list: { id: string; replies_policy: RepliesPolicy },
	cursor: Cursor,
	only: string
) {
	const read = statusReads(viewer, { viewer: '?1', now: '?5', only: '?7' })
	const order = orderOf(cursor)
	return read.union(
		db,
		'homeFilter',
		{
			all: true,
			branches: [
				{
					authors: `SELECT la.account_id FROM list_accounts la WHERE la.list_id = ?6
						AND la.account_id = (SELECT lx.account_id FROM statuses lx WHERE lx.id = ?7)
						AND (la.account_id = ?1 OR EXISTS (SELECT 1 FROM follows lf
							WHERE lf.account_id = ?1 AND lf.target_account_id = la.account_id AND lf.state = 'accepted'))`,
					where: `${FEED} AND ${rangeSql('s.id')}`,
					and: followOptionsSql(repliesPolicySql(list.replies_policy, '?6')),
					tail: `ORDER BY s.id ${order} LIMIT ?4`,
				},
			],
			tail: `ORDER BY id ${order} LIMIT ?4`,
		},
		viewer.accountId,
		...rangeParams(cursor),
		cursor.limit,
		viewer.now,
		list.id,
		only
	)
}

export type PublicTimelineInput = {
	page: PageQuery
	local: boolean
	remote: boolean
	onlyMedia: boolean
	present: Present
}

// Local and remote public statuses that are not boosts, and not replies except to the author's own statuses
// (Mastodon's PublicFeed). Never unlisted, private, direct or limited. The list rule (listableSql) follows these.
// `local` and `remote` together select both, as PublicFeed#local_only? and #remote_only? read them (with Mastodon's
// feed access settings open to everyone, the only setting Kopje has).
function publicConditions(local: boolean, remote: boolean, onlyMedia: boolean): string {
	return `s.visibility = 'public' AND s.reblog_of_id IS NULL
		${local && !remote ? 'AND pa.domain IS NULL' : ''} ${remote && !local ? 'AND pa.domain IS NOT NULL' : ''}
		${onlyMedia ? 'AND EXISTS (SELECT 1 FROM media_attachments pm WHERE pm.status_id = s.id AND pm.shown = 1)' : ''}`
}

// A page reads a window of readWindow(limit) candidates from the cursor (publicConditions and audienceSql, without the
// rest of the rule), then applies the list rule to them.
export const publicTimeline = optionalUserReadOperation<PublicTimelineInput, Page<Status>>((db, input, viewer) => {
	const cursor = statusPage(input.page)
	const size = readWindow(cursor.limit)
	const window = singleWindow(
		db,
		`SELECT s.id FROM statuses s JOIN accounts pa ON pa.id = s.account_id
		WHERE ${publicConditions(input.local, input.remote, input.onlyMedia)} AND ${NOT_A_REPLY_TO_OTHERS}
			AND ${rangeSql('s.id')} AND ${audienceSql('s', '?4')}
		ORDER BY s.id ${orderOf(cursor)} LIMIT ?1`,
		size,
		size,
		...rangeParams(cursor),
		viewer.accountId
	)
	return windowStatuses(db, viewer, 'listable', window, cursor, input.present)
})

// Which public timeline: local, remote or both, and media only (the six `public*` streams).
export type PublicFeed = { local: boolean; remote: boolean; onlyMedia: boolean }

// R33 for `update` and `status.update` on a `public*` stream (streaming.ts): the public timeline `feed` positioned at
// the status `statusId`, narrowed to it (statusReads' `only`, a seek of the status by its key), so the work does not
// grow with anyone's statuses. From the cursor just above it, the status is the window's first candidate, so the
// narrowed read returns it exactly when the positioned read does.
export function publicStatus(db: Db, viewer: UserContext, feed: PublicFeed, statusId: string) {
	const cursor = positionedAt(statusId)
	if (cursor === null) {
		return null
	}
	const read = statusReads(viewer, { viewer: '?1', now: '?5', only: '?6' })
	const rows = read.select(
		db,
		'listable',
		{
			join: 'JOIN accounts pa ON pa.id = s.account_id',
			where: publicConditions(feed.local, feed.remote, feed.onlyMedia),
			and: `${NOT_A_REPLY_TO_OTHERS} AND ${rangeSql('s.id')}`,
			tail: `ORDER BY s.id ${orderOf(cursor)} LIMIT ?4`,
		},
		viewer.accountId,
		...rangeParams(cursor),
		cursor.limit,
		viewer.now,
		statusId
	)
	return rows[0]?.id ?? null
}

// The cursor of a read positioned at the status `statusId` (max_id just above it, limit 1), or null for an id no
// status has.
function positionedAt(statusId: string): Cursor | null {
	return /^\d{18}$/.test(statusId) ? statusPage({ maxId: String(BigInt(statusId) + 1n), limit: 1 }) : null
}

export type TagTimelineInput = PublicTimelineInput & { tag: string; any: string[]; all: string[]; none: string[] }

// The most names a hashtag timeline reads: the tag and `any`, which the API caps at four as Mastodon's TagFeed does.
// Each is a term of one compound SELECT, and the Store's SQLite allows five.
const MAX_TAG_TIMELINE_NAMES = 5

// Public statuses with the tag or any of `any`, all of `all` and none of `none` (Mastodon's TagFeed). Each name is a
// stream of candidates read from the public rows of status_tags (status_tags.public, through the partial index
// status_tags_public) in status id order, with every condition but the rule: so the read never goes through the tag's
// unlisted, private, direct or limited statuses. A page merges the names' streams into one window (tagWindow), as
// home does, and applies the list rule to it.
export const tagTimeline = optionalUserReadOperation<TagTimelineInput, Page<Status>>(
	(db, input, viewer) => tagTimelineWithin(db, input, viewer, answerAdmission).page
)

// tagTimeline's read, its statuses admitted by `admission`: the API's answer, or a web page's list (design §1).
export function tagTimelineWithin(
	db: Db,
	input: TagTimelineInput,
	viewer: ViewerContext,
	admission: StatusAdmission
): StatusList {
	const cursor = statusPage(input.page)
	return windowStatusesWithin(
		db,
		viewer,
		'listable',
		tagWindow(db, viewer, input, cursor),
		cursor,
		input.present,
		admission
	)
}

// R33 for `update` and `status.update` on a `hashtag` or `hashtag:local` stream (streaming.ts): the hashtag `tag`'s
// timeline (local only, or local and remote) positioned at the status `statusId`, narrowed to it: the status's own
// row of the hashtag, found by its key (status_tags' (status_id, name)), so the work does not grow with the hashtag's
// statuses. The status, if that read returns it.
export function tagStatus(db: Db, viewer: UserContext, tag: string, local: boolean, statusId: string) {
	const cursor = positionedAt(statusId)
	if (cursor === null) {
		return null
	}
	// One name, and no `all` or `none`: ?5 and ?6 are empty, ?7 the time, ?8 the name, ?9 the status.
	const input = { local, remote: false, onlyMedia: false }
	const read = statusReads(viewer, { viewer: '?1', now: '?7', only: '?9' })
	return (
		read.select(
			db,
			'listable',
			{
				from: 'status_tags t CROSS JOIN',
				join: 'ON s.id = t.status_id JOIN accounts pa ON pa.id = s.account_id',
				where: `t.public = 1 AND t.name = ?8 AND t.status_id = ?9 AND ${tagConditions(input)}`,
				and: rangeSql('t.status_id'),
				tail: `ORDER BY t.status_id ${orderOf(cursor)} LIMIT ?4`,
			},
			viewer.accountId,
			...rangeParams(cursor),
			cursor.limit,
			'[]',
			'[]',
			viewer.now,
			normalizeTag(tag),
			statusId
		)[0]?.id ?? null
	)
}

function tagNames(input: { tag: string; any: string[] }): string[] {
	return unique([input.tag, ...input.any]).slice(0, MAX_TAG_TIMELINE_NAMES)
}

function unique(names: string[]): string[] {
	return [...new Set(names.map(normalizeTag))]
}

// A hashtag timeline's conditions on the status `s` but the rule, with `all` at ?5 and `none` at ?6.
function tagConditions(input: { local: boolean; remote: boolean; onlyMedia: boolean }): string {
	return `NOT EXISTS (SELECT 1 FROM json_each(?5) a
			WHERE NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id AND st.name = a.value))
		AND NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id
			AND st.name IN (SELECT value FROM json_each(?6)))
		AND ${publicConditions(input.local, input.remote, input.onlyMedia)}`
}

// A hashtag timeline's candidate window, as homeWindow's, with a stream per name. CROSS JOIN keeps status_tags
// outermost, and the cursor is a plain range (rangeSql), so each stream starts in the index at the cursor, walks it in
// order and stops at its cap.
function tagWindow(
	db: Db,
	viewer: ViewerContext,
	input: Omit<TagTimelineInput, 'page' | 'present'>,
	cursor: Cursor
): Window {
	const names = tagNames(input)
	const order = orderOf(cursor)
	// ?1 the viewer, ?4 the cap, ?5 all, ?6 none, then one parameter per name from ?7.
	const stream = (n: number) => `SELECT id, ${n} AS k, 0 AS o FROM (SELECT t.status_id AS id
		FROM status_tags t CROSS JOIN statuses s ON s.id = t.status_id JOIN accounts pa ON pa.id = s.account_id
		WHERE t.public = 1 AND t.name = ?${7 + n} AND ${rangeSql('t.status_id')} AND ${tagConditions(input)}
			AND ${audienceSql('s', '?1')}
		ORDER BY t.status_id ${order} LIMIT ?4)`
	return mergedWindow(
		db,
		{
			streams: names.map((_, n) => stream(n)).join(' UNION ALL '),
			ascending: cursor.ascending,
			per: streamWindow(cursor.limit),
			size: readWindow(cursor.limit),
		},
		viewer.accountId,
		...rangeParams(cursor),
		streamWindow(cursor.limit),
		JSON.stringify(unique(input.all)),
		JSON.stringify(unique(input.none)),
		...names
	)
}

export type LinkTimelineInput = { url: string | null; page: PageQuery; present: Present }

// What the link timeline shows of a link's public copies beyond the list rule (Mastodon's LinkFeed): a public
// original (publicConditions, local and remote alike; the live checks: an import's reblog_of_id is linked after its
// rows) by a discoverable author who has not moved (Account.discoverable).
const LINK_FEED_SQL = `${publicConditions(false, false, false)} AND EXISTS (SELECT 1 FROM accounts da
	WHERE da.id = s.account_id AND da.discoverable = 1 AND da.moved_to_account_id IS NULL)`

// GET /api/v1/timelines/link (Api::V1::Timelines::LinkController): null (404) while trends are off (MD-5), or when the
// link `url` has no timeline now (listedTrendLinkSql); else the statuses holding a public copy of it (Mastodon's
// LinkFeed: replies, content warnings and sensitive posts included), under the list rule (R8; R2 with no viewer) and
// LINK_FEED_SQL. A page reads a window of readWindow(limit) of the link's public copies from the cursor, raw, through
// status_cards_public_link (each a public status's, by the membership the triggers hold, so unlisted copies never
// take its place), then applies the rest to them. A limit of 0 answers no statuses once the link is found.
export const linkTimeline = optionalUserReadOperation<LinkTimelineInput, Page<Status> | null>((db, input, viewer) => {
	if (
		input.url === null ||
		!trendSettings(db).trends ||
		db.first<{ listed: number }>(`SELECT ${listedTrendLinkSql('?1')} AS listed`, input.url)?.listed !== 1
	) {
		return null
	}
	const cursor = statusPage(input.page)
	if (cursor.limit === 0) {
		return { items: [], newest: null, oldest: null }
	}
	const size = readWindow(cursor.limit)
	const window = singleWindow(
		db,
		`SELECT c.status_id AS id FROM status_cards c INDEXED BY ${CARD_PUBLIC_LINK_INDEX}
		WHERE ${publicCopiesSql('c', '?1')} AND ${rangeSql('c.status_id')}
		ORDER BY c.status_id ${orderOf(cursor)} LIMIT ?4`,
		size,
		input.url,
		...rangeParams(cursor),
		size
	)
	return windowStatuses(db, viewer, 'listable', window, cursor, input.present, LINK_FEED_SQL)
})

export type StatusRepliesInput = { id: string; page: PageQuery; present: Present }

// The direct replies of the status `id` that the list rule passes for the viewer, oldest first (a status page's Replies
// tab, design §2 and §4): with no cursor or `min_id`, ascending from the cursor; with `max_id`, descending below it,
// the page returned newest first as every page is. A page reads a readWindow(limit) window of the status's public and
// unlisted replies from the cursor through statuses_public_replies (migration 0082), and applies the rule to it
// (availability, domain policy): a private, direct or limited reply is never a candidate, so it never becomes a
// cursor (RES-7), and a range the rule hides costs a window.
export function statusRepliesWithin(
	db: Db,
	input: StatusRepliesInput,
	viewer: ViewerContext,
	admission: StatusAdmission
): StatusList {
	const cursor: Cursor = {
		max: statusCursor(input.page.maxId),
		min: statusCursor(input.page.minId),
		ascending: input.page.maxId === undefined,
		limit: input.page.limit,
	}
	const size = readWindow(cursor.limit)
	const window = singleWindow(
		db,
		`SELECT s.id FROM statuses s INDEXED BY statuses_public_replies
		WHERE s.in_reply_to_id = ?1 AND s.visibility IN ${DISTRIBUTABLE_SQL} AND ${rangeSql('s.id')}
		ORDER BY s.id ${orderOf(cursor)} LIMIT ?4`,
		size,
		input.id,
		...rangeParams(cursor),
		size
	)
	return windowStatusesWithin(db, viewer, 'listable', window, cursor, input.present, admission)
}

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
// replies to the account itself (threads). pinned=true lists the account's pinned statuses by the same rule
// (AccountStatusesFilter#pinned_scope), newest pin first (Account#pinned_statuses) and with the other filters; a page
// asked by min_id is by status id, as Mastodon's paginate_by_min_id reorders it. An account pins at most a few, read
// through their primary key.
export const accountStatuses = optionalUserReadOperation<AccountStatusesInput, Page<Status> | null>(
	(db, input, viewer) => accountStatusesWithin(db, input, viewer, answerAdmission)?.page ?? null
)

// accountStatuses' read, its statuses admitted by `admission`: the API's answer, or a web page's list (design §1).
// Pinned answers have no continuation (more is false).
export function accountStatusesWithin(
	db: Db,
	input: AccountStatusesInput,
	viewer: ViewerContext,
	admission: StatusAdmission
): StatusList | null {
	const { accountId: viewerId, now } = viewer
	const accountId = resolveAccountId(db, input.account)
	if (accountId === null) {
		return null
	}
	const cursor = statusPage(input.page)
	// An account the rule hides as a whole from the viewer (unavailable, or blocking them), or that they block, shows
	// nothing: decided once, so its history is never read. A mute or a domain block does not hide a profile.
	const author = statusReads(viewer, { viewer: '?1' })
	if (!author.authorShown(db, 'visible', { author: '?2', and: `NOT ${blocksSql('?1', '?2')}` }, viewerId, accountId)) {
		return { page: { items: [], newest: null, oldest: null }, more: false }
	}
	const order = orderOf(cursor)
	const tagged = input.tagged === null ? null : normalizeTag(input.tagged)
	const filters = `${input.onlyMedia ? 'AND EXISTS (SELECT 1 FROM media_attachments um WHERE um.status_id = s.id AND um.shown = 1)' : ''}
		${input.excludeReplies ? `AND ${NOT_A_REPLY_TO_OTHERS}` : ''}
		${input.excludeReblogs ? 'AND s.reblog_of_id IS NULL' : ''}`
	if (input.pinned) {
		// An account pins at most a few statuses, read through their primary key: no window.
		const rows = statusReads(viewer, { viewer: '?1', now: '?7' }).select(
			db,
			'visible',
			{
				from: 'status_pins p CROSS JOIN',
				join: 'ON s.id = p.status_id',
				where: 'p.account_id = ?5 AND s.account_id = ?5',
				and: `NOT ${blocksSql('?1', 's.account_id')} AND ${originalShownSql('?1', '?7')} ${filters}
					AND (?6 IS NULL OR EXISTS (SELECT 1 FROM status_tags ut WHERE ut.status_id = s.id AND ut.name = ?6))
					AND ${rangeSql('s.id')}`,
				tail: `ORDER BY ${cursor.ascending ? '' : 'p.created_at DESC, '}s.id ${order} LIMIT ?4`,
			},
			viewerId,
			...rangeParams(cursor),
			cursor.limit,
			accountId,
			tagged,
			now
		)
		// Pinned answers carry no paging links (RES-3): a status-id cursor cannot follow pin order, so a link would
		// repeat or skip pins, and pins are few and fetched in one request. `limit` caps the count, a client's bounds
		// stay Mastodon's status-id bounds, and the answer budget keeps the pins that fit, in traversal order.
		const ids = rows.map((row) => row.id)
		const shared = presentation(db, ids, { ...input.present, viewer })
		const { items } = admission(statusStream(db, shared, ids))
		return { page: { items: cursor.ascending ? items.toReversed() : items, newest: null, oldest: null }, more: false }
	}
	// A readWindow(limit) window through statuses_account with the request's filters and audienceSql, then R2 and
	// R11 over it (availability and filters of boosted originals). Statuses hidden by their visibility are walked
	// past and never supply a cursor (docs/visibility.md "Read bounds").
	const size = readWindow(cursor.limit)
	const window = singleWindow(
		db,
		`SELECT s.id FROM statuses s WHERE s.account_id = ?1 AND ${rangeSql('s.id')} ${filters}
			AND (?5 IS NULL OR EXISTS (SELECT 1 FROM status_tags ut WHERE ut.status_id = s.id AND ut.name = ?5))
			AND ${audienceSql('s', '?6')}
		ORDER BY s.id ${order} LIMIT ?4`,
		size,
		accountId,
		...rangeParams(cursor),
		size,
		tagged,
		viewerId
	)
	return windowStatusesWithin(
		db,
		viewer,
		'visible',
		window,
		cursor,
		input.present,
		admission,
		originalShownSql('?1', '?2')
	)
}

// R11 for a boost on an account's statuses: the viewer may see its original and does not filter its author
// (AccountStatusesFilter#filtered_reblogs_scope).
function originalShownSql(viewer: string, now: string): string {
	return `(s.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM statuses o WHERE o.id = s.reblog_of_id
		AND ${visibleSql('o', viewer)} AND NOT ${filteredForSql('o.account_id', viewer, now)}))`
}

// The statuses among `ids` that are the account's and that the viewer may see by Mastodon's AccountStatusesFilter
// (R11), with their uris, by id, read by key: the statuses a local account may report (reports.ts,
// ReportService#reported_status_ids, app/services/report_service.rb:82). Unlike the profile read, the viewer's own
// block of the account hides none: AccountStatusesFilter#blocked? (app/lib/account_statuses_filter.rb:106-108) is the
// account's block of the viewer alone, so a reporter who blocked the account may still name its statuses. Kopje keeps
// no deleted status (Mastodon's with_discarded), so a deleted one is not found. The OAuth admin is shown a report's
// statuses only while its reporter may still see them by the same rule (R37): the ids are the presenter's then.
export function accountStatusIds(db: Db, viewer: ViewerContext, accountId: string, ids: readonly string[]) {
	if (
		ids.length === 0 ||
		!statusReads(viewer, { viewer: '?1' }).authorShown(db, 'visible', { author: '?2' }, viewer.accountId, accountId)
	) {
		return []
	}
	return statusReads(viewer, { viewer: '?1', now: '?3' })
		.select<{ uri: string }>(
			db,
			'visible',
			{
				where: 's.id IN (SELECT value FROM json_each(?2)) AND s.account_id = ?4',
				and: originalShownSql('?1', '?3'),
				tail: 'ORDER BY s.id',
				columns: { uri: 's.uri' },
			},
			viewer.accountId,
			JSON.stringify(ids),
			viewer.now,
			accountId
		)
		.map((row) => ({ id: row.id, uri: row.uri }))
}

// Bookmarks and favourites, newest first by the edge's id, through the list rule: a status that is no longer
// visible to the viewer (say, they stopped following a private author) or that they filter is not listed. A page reads
// a window of readWindow(limit) of the viewer's edges from the cursor (bookmarks_account, favourites_account), then
// applies the rule to their statuses.
function edgeList(table: 'bookmarks' | 'favourites') {
	return userReadOperation<{ page: PageQuery; present: Present }, Page<Status>>(
		(db, { page, present }, _viewer, viewer) => {
			const { accountId, now } = viewer
			const ascending = page.minId !== undefined
			const size = readWindow(page.limit)
			const window = singleWindow(
				db,
				`SELECT CAST(e.id AS TEXT) AS id FROM ${table} e WHERE e.account_id = ?1 AND ${edgeRangeSql('e.id', '?2', '?3')}
				ORDER BY e.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`,
				size,
				accountId,
				page.maxId ?? null,
				page.minId ?? page.sinceId ?? null,
				size
			)
			const passed =
				window.candidates.length === 0
					? []
					: statusReads(viewer, { viewer: '?1', now: '?2' }).select<{ cursor: string }>(
							db,
							'listable',
							{
								from: `json_each(?3) c CROSS JOIN ${table} e ON e.id = CAST(json_extract(c.value, '$.id') AS INTEGER) JOIN`,
								join: 'ON s.id = e.status_id',
								where: 'e.account_id = ?1',
								columns: { cursor: 'CAST(e.id AS TEXT)' },
							},
							accountId,
							now,
							windowJson(window)
						)
			const shown = windowPage(window, passed, (row) => row.cursor, page.limit, ascending)
			return presentedPage(
				db,
				viewer,
				shown,
				shown.rows.map((row) => row.id),
				shown.rows.map((row) => row.cursor),
				ascending,
				present
			)
		}
	)
}

export const bookmarks = edgeList('bookmarks')
export const favourites = edgeList('favourites')
