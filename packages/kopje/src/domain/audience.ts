import type { Db } from '../db/sql'

// Audience and visibility (design §4 "audience and visibility", Mastodon 4.7.3; docs/visibility.md). One module decides
// who may see a status or an account, for every read path, who is notified, whom an author may address, and how an
// audience is written to and read from ActivityPub addressing:
//
//   - the policy (visibleSql, listableSql, homeFilterSql, canView, the account predicates and shownSql): the read rule
//     (Mastodon's StatusPolicy#show? and StatusFilter) and the rules built on it. It exists only as SQL, so feeds
//     filter before LIMIT and no read path keeps a second copy of the rule in TypeScript.
//   - interpretAddressing: inbound to/cc/tag → visibility and silent mentions (B1b).
//   - addressingOf / audienceOf: a local status's to/cc and the accounts that must receive it (B2).
//   - recipientsFor / addresses: whom an outbound activity reaches and names, by what it does (outboundKind).
//
// Visibilities are Mastodon's internal set. limited is Misskey's `specified` (and Mastodon's own limited): addressed
// recipients who are not mentioned in the text. Those recipients are status_mentions rows with silent = 1: they may
// see the status, but they are not shown in `mentions` and are not notified. The API shows limited as private.

export type Visibility = 'public' | 'unlisted' | 'private' | 'direct' | 'limited'

// What the API accepts and shows.
export type ApiVisibility = Exclude<Visibility, 'limited'>

export const API_VISIBILITIES: readonly ApiVisibility[] = ['public', 'unlisted', 'private', 'direct']

export function apiVisibility(visibility: Visibility): ApiVisibility {
	return visibility === 'limited' ? 'private' : visibility
}

// direct and limited are seen by the author and the mentioned (silent included) only.
export function requiresMention(visibility: Visibility): boolean {
	return visibility === 'direct' || visibility === 'limited'
}

// Public and unlisted statuses reach beyond the author's followers (reblogs, reply counts, interactors).
export function isDistributable(visibility: Visibility): boolean {
	return visibility === 'public' || visibility === 'unlisted'
}

// ---------------------------------------------------------------------------------------------------------------
// The policy, as SQL fragments (docs/visibility.md): who may be seen, who sees what, what a viewer filters out, who is
// notified, and whom an author may address. This is the only module that reads blocks, mutes, domain_blocks or
// suspended_at to decide any of that, and the only one that spells a set of visibilities in SQL (test/policy.test.ts).
//
// Fragments take SQL expressions, normally numbered parameters: `s` is the alias of a statuses row, `x` an account id,
// `viewer` the viewer's account id (NULL for an anonymous viewer), and `now` the time the viewer's time-bound choices
// (a mute's expiry) are judged at. An operation binds them from its ViewerContext.
// ---------------------------------------------------------------------------------------------------------------

// Who reads, and when: the viewer's account id (null for an anonymous viewer or an app token) and the request time, as
// an ISO 8601 UTC time like the stored expires_at. Only the auth wrappers (auth.ts) build one, from the credential.
export type ViewerContext = { readonly accountId: string | null; readonly now: string }

// Every visibility, in the order the schema lists them, and the sets the rules use as SQL lists (`visibility IN ...`).
const VISIBILITIES: readonly Visibility[] = ['public', 'unlisted', 'private', 'direct', 'limited']

function visibilitySetSql(member: (visibility: Visibility) => boolean): string {
	return `(${VISIBILITIES.filter(member)
		.map((visibility) => `'${visibility}'`)
		.join(', ')})`
}

// public and unlisted (isDistributable).
export const DISTRIBUTABLE_SQL = visibilitySetSql(isDistributable)
// direct and limited (requiresMention).
export const REQUIRES_MENTION_SQL = visibilitySetSql(requiresMention)
// public, unlisted and private: what reaches the author's followers. The partial index statuses_feed declares this
// list, in this order, and SQLite uses it only for the same list.
export const REACHES_FOLLOWERS_SQL = visibilitySetSql((visibility) => !requiresMention(visibility))

// status_tags.public of a hashtag of the status `id`: whether the status is public, the only visibility hashtag timelines
// and a tag's history count (publicConditions in timelines.ts). A status's visibility is fixed when it is written, so
// the writers of status_tags set it with each row, and the partial index status_tags_public holds just those rows.
export function tagPublicSql(id: string): string {
	return `(SELECT tp.visibility = 'public' FROM main.statuses tp WHERE tp.id = ${id})`
}

// The columns of status_mentions copied from the mention's status, for its writers: requires_mention, whether the
// status is direct or limited (the only statuses home reads from the viewer's mentions), and author_id, the status's
// author. A status never changes author, and its visibility stays in or out of that set once written (a direct status
// gaining a recipient becomes limited), so the writers set both with each row, and the partial index
// status_mentions_requires_mention holds the marked rows by recipient and author.
export const MENTION_STATUS_COLUMNS = 'requires_mention, author_id'

// The values of MENTION_STATUS_COLUMNS for a mention in the status `id`.
export function mentionStatusSql(id: string): string {
	return `(SELECT mr.visibility IN ${REQUIRES_MENTION_SQL} FROM main.statuses mr WHERE mr.id = ${id}),
		(SELECT ma.account_id FROM main.statuses ma WHERE ma.id = ${id})`
}

// ---- Accounts. `x` is an expression for an account id, never a status or edge alias.

// R1 (Account#unavailable?): a suspended local account, and a remote account whose deletion has started
// (accounts.deleted_at, set in the first transaction of its purge), is seen by nobody, and nothing of it is shown or
// delivered. Two seeks: the local_accounts row, and the partial index of the accounts being deleted, which holds no
// entry for any other account (INDEXED BY keeps the plan from reading the account's row instead), so the rule reads
// no row of an available account but its local_accounts row. An unknown id is available.
export function availableSql(x: string): string {
	return `(NOT EXISTS (SELECT 1 FROM main.local_accounts pl WHERE pl.account_id = ${x} AND pl.suspended_at IS NOT NULL
		UNION ALL SELECT 1 FROM main.accounts pa INDEXED BY accounts_deleted WHERE pa.id = ${x} AND pa.deleted_at IS NOT NULL))`
}

// The same rule for a local account whose local_accounts row `l` is already joined, so a query that has the row does
// not look it up again. A local account is never deleted that way (the schema refuses deleted_at on it).
export function availableLocalSql(l: string): string {
	return `${l}.suspended_at IS NULL`
}

// Whether `owner` blocks the account `x`.
export function blocksSql(owner: string, x: string): string {
	return `EXISTS (SELECT 1 FROM main.blocks pb WHERE pb.account_id = ${owner} AND pb.target_account_id = ${x})`
}

// Whether the mute row `m` applies at `now`: an indefinite mute, or one that has not expired yet. An expired mute stops
// applying at its time, whether or not it has been removed yet.
export function activeMuteSql(m: string, now: string): string {
	return `(${m}.expires_at IS NULL OR ${m}.expires_at > ${now})`
}

// The mute of the account `x` by `owner` that applies at `now`, as `m`, LEFT JOINed (its options in a relationship).
export function activeMuteJoinSql(m: string, owner: string, x: string, now: string): string {
	return `LEFT JOIN main.mutes ${m} ON ${m}.account_id = ${owner} AND ${m}.target_account_id = ${x} AND ${activeMuteSql(m, now)}`
}

// Whether `owner` mutes the account `x` at `now`; with `notifications`, only a mute that also hides notifications.
function mutesSql(owner: string, x: string, now: string, notifications = false): string {
	return `EXISTS (SELECT 1 FROM main.mutes pm WHERE pm.account_id = ${owner} AND pm.target_account_id = ${x}
		${notifications ? 'AND pm.hide_notifications = 1' : ''} AND ${activeMuteSql('pm', now)})`
}

// The host of an actor id as hostDomain (platform/domain-name.ts) reads it, in SQL: scheme, path and port dropped,
// lowercased, without a trailing dot. Stored ids are URL hrefs, so an IDN host is already punycode.
function uriHostSql(uri: string): string {
	const rest = `substr(${uri}, instr(${uri}, '://') + 3)`
	const hostPort = `substr(${rest}, 1, instr(${rest} || '/', '/') - 1)`
	return `rtrim(lower(substr(${hostPort}, 1, instr(${hostPort} || ':', ':') - 1)), '.')`
}

// Whether the remote account row `a` lives on `domain`, an expression for a normalized domain (lowercase, punycode, no
// trailing dot: how domain blocks are stored): by its stored domain (its canonical address's) or by the host of its
// actor id, so neither a confirmed domain elsewhere nor another spelling of the host lets an account escape a block of
// the server it lives on. Exactly, without subdomains (Mastodon's AccountDomainBlock). Only the account's side is
// normalized, so a stored domain is compared as it is and found through its index.
export function inDomainSql(a: string, domain: string): string {
	return `(${a}.domain IS NOT NULL AND ${domain} IN (rtrim(${a}.domain, '.'), ${uriHostSql(`${a}.uri`)}))`
}

// Whether `owner` blocks the domain of the account `x`: two seeks of the (account_id, domain) index, however many
// domains the owner blocks.
export function domainBlocksSql(owner: string, x: string): string {
	return `EXISTS (SELECT 1 FROM main.accounts pda
		CROSS JOIN main.domain_blocks pdb ON pdb.account_id = ${owner} AND ${inDomainSql('pda', 'pdb.domain')}
		WHERE pda.id = ${x})`
}

// Whether `owner` blocks the account `x` or its domain. Such an account is never a recipient of the owner's content
// (R17, R23: Mastodon's ProcessMentionsService drops the mention).
export function blockedSql(owner: string, x: string): string {
	return `(${blocksSql(owner, x)} OR ${domainBlocksSql(owner, x)})`
}

// R7 (StatusFilter): whether `viewer` filters the account `x` out of lists at `now`: it blocks or mutes it (while the
// mute applies), or blocks its domain. Nobody filters themselves; an anonymous viewer filters nothing.
export function filteredForSql(x: string, viewer: string, now: string): string {
	return `(${viewer} IS NOT NULL AND ${x} IS NOT ${viewer}
		AND (${blocksSql(viewer, x)} OR ${mutesSql(viewer, x, now)} OR ${domainBlocksSql(viewer, x)}))`
}

// R12: whether the account `x` may be listed to `viewer` among others (who favourited or boosted): it is available,
// the viewer does not filter it, and it does not block the viewer.
export function listedForSql(x: string, viewer: string, now: string): string {
	return `(${availableSql(x)} AND NOT ${filteredForSql(x, viewer, now)} AND NOT ${blocksSql(x, viewer)})`
}

// R17: whether `author` may mention or address the account `x`: it is available, and the author blocks neither it nor
// its domain.
export function mentionableBySql(x: string, author: string): string {
	return `(${availableSql(x)} AND NOT ${blockedSql(author, x)})`
}

// R21 (FollowService): whether `viewer` may follow the account `x`: it is available and someone else, neither blocks
// the other, and the viewer does not block its domain.
export function followableBySql(x: string, viewer: string): string {
	return `(${availableSql(x)} AND ${x} <> ${viewer} AND NOT ${blocksSql(x, viewer)} AND NOT ${blockedSql(viewer, x)})`
}

// R14 (Account::Search): whether `viewer` finds the account `x` by account search or by search resolution: it is
// available, and the viewer does not block its domain. Mastodon's search leaves out suspended accounts only; Kopje
// also leaves out what the viewer's domain block hides everywhere else.
export function findableBySql(x: string, viewer: string): string {
	return `(${availableSql(x)} AND NOT ${domainBlocksSql(viewer, x)})`
}

// Whether the account `x` hides its network (Account#hide_collections): a local account's setting
// (local_accounts.hide_collections), or what Kopje learned of a remote account's (accounts.hide_collections, migration
// 0025_remote_collections; a remote account it has not learned hides nothing). Two key lookups.
export function hidesCollectionsSql(x: string): string {
	return `(EXISTS (SELECT 1 FROM main.local_accounts ph WHERE ph.account_id = ${x} AND ph.hide_collections = 1)
		OR EXISTS (SELECT 1 FROM main.accounts pha WHERE pha.id = ${x} AND pha.hide_collections = 1))`
}

// R13 (FollowerAccountsController#hide_results?): whether `viewer` (NULL: anonymous) is shown the followers and
// following of `owner`: the owner is available and, unless the viewer is the owner, neither hides its network nor
// blocks the viewer.
export function followListsShownSql(owner: string, viewer: string): string {
	return `(${availableSql(owner)}
		AND (${owner} IS ${viewer} OR (NOT ${hidesCollectionsSql(owner)} AND NOT ${blocksSql(owner, viewer)})))`
}

// R13 (Account#excluded_from_timeline_account_ids): whether the account `x` is listed among the followers or following
// of `owner` to `viewer` at `now`. An anonymous viewer and the owner see every entry; anyone else does not see an
// account they block or mute (while the mute applies), or one that blocks them. An unavailable account stays listed
// (and is presented redacted), as Mastodon lists a suspended one, until a purge removes its follows.
export function followListedSql(x: string, owner: string, viewer: string, now: string): string {
	return `(${viewer} IS NULL OR ${viewer} IS ${owner}
		OR NOT (${blocksSql(viewer, x)} OR ${blocksSql(x, viewer)} OR ${mutesSql(viewer, x, now)}))`
}

// R28 (Accounts::EndorsementsController#set_endorsed_accounts): whether the accounts `owner` endorses are listed. They
// are public: to anyone, the owner itself included, while the owner is available (an unavailable one lists none).
export function endorsementsShownSql(owner: string): string {
	return availableSql(owner)
}

// R28 (`endorsed_accounts.without_suspended`): whether the endorsed account `x` is listed: while it is available.
export function endorsementListedSql(x: string): string {
	return availableSql(x)
}

// ---- Statuses. `s` is the alias of a statuses row.

// Whether `viewer` is a remote account (accounts.domain is set). It does not depend on a status, so SQLite evaluates
// it once per query, and a local viewer pays one row for it however many statuses are judged. A rule guards a lookup
// with it in a CASE, which skips the lookup when it is false (an AND may evaluate both operands).
function remoteSql(viewer: string): string {
	return `EXISTS (SELECT 1 FROM main.accounts pv WHERE pv.id = ${viewer} AND pv.domain IS NOT NULL)`
}

// R2 (StatusPolicy#show?): whether `viewer` may see the row itself.
//   - a status of an unavailable author is seen by nobody;
//   - the author sees everything of their own;
//   - an author who blocks the viewer hides everything from them;
//   - public and unlisted are seen by everyone else but a remote account on a domain the author blocks
//     (author_blocking_domain?);
//   - private is seen by accepted followers and the mentioned (silent included);
//   - direct and limited are seen by the mentioned (silent included) only.
// It has no time: nothing the viewer chose changes what they may see.
export function visibleSql(s: string, viewer: string): string {
	return `(${availableSql(`${s}.account_id`)}
		AND (${s}.account_id IS ${viewer}
			OR (NOT ${blocksSql(`${s}.account_id`, viewer)}
				AND (CASE WHEN ${s}.visibility IN ${DISTRIBUTABLE_SQL}
					THEN CASE WHEN ${remoteSql(viewer)} THEN NOT ${domainBlocksSql(`${s}.account_id`, viewer)} ELSE 1 END
					ELSE (${s}.visibility = 'private' AND EXISTS (SELECT 1 FROM main.follows fo
							WHERE fo.account_id IS ${viewer} AND fo.target_account_id = ${s}.account_id AND fo.state = 'accepted'))
						OR EXISTS (SELECT 1 FROM main.status_mentions sm WHERE sm.status_id = ${s}.id AND sm.account_id IS ${viewer})
					END))))`
}

// R3: a status may be shown by itself (GET /statuses/:id): the row is visible and, for a reblog, so is the original.
function viewableSql(s: string, viewer: string): string {
	return `(${visibleSql(s, viewer)} AND (${s}.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM main.statuses ${s}_o
		WHERE ${s}_o.id = ${s}.reblog_of_id AND ${visibleSql(`${s}_o`, viewer)})))`
}

// R8: a status may be listed (feeds, context, bookmarks, favourites, search): viewable, and the viewer filters neither
// its author nor a reblogged original's at `now`.
export function listableSql(s: string, viewer: string, now: string): string {
	return `(${visibleSql(s, viewer)} AND NOT ${filteredForSql(`${s}.account_id`, viewer, now)}
		AND (${s}.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM main.statuses ${s}_o WHERE ${s}_o.id = ${s}.reblog_of_id
			AND ${visibleSql(`${s}_o`, viewer)} AND NOT ${filteredForSql(`${s}_o.account_id`, viewer, now)})))`
}

// R9, what home hides of a status for the viewer's choices (FeedManager#filter_from_home): what the list rule hides,
// and a status or boosted original that mentions (not silently) an account the viewer blocks or mutes at `now`; the
// viewer's own statuses always pass. Home applies it, and so does a post notification: FeedInsertWorker notifies only
// of a status home shows. Home's membership and the follow's options (boosts, replies, languages) are home's own.
// For the public statuses home shows by a followed hashtag, it is FeedManager#filter_from_tags?: the author or an
// active mention blocked or muted by the viewer, an author blocking the viewer and the author's domain blocked by the
// viewer each leave a status out (the viewer's own are home's anyway).
export function homeFilterSql(s: string, viewer: string, now: string): string {
	return `(${listableSql(s, viewer, now)}
		AND (${s}.account_id IS ${viewer} OR NOT EXISTS (SELECT 1 FROM main.status_mentions phm
			WHERE phm.status_id IN (${s}.id, ${s}.reblog_of_id) AND phm.silent = 0
			AND (${blocksSql(viewer, 'phm.account_id')} OR ${mutesSql(viewer, 'phm.account_id', now)}))))`
}

// The rule for one status: whether `viewerId` (null: anonymous) may see it by itself.
export function canView(db: Db, viewerId: string | null, statusId: string): boolean {
	return (
		db.first(
			`SELECT 1 AS ok FROM main.statuses s WHERE s.id = ?2 AND ${viewableSql('s', '?1')}`,
			viewerId,
			statusId
		) !== undefined
	)
}

// ---- Status ids the presenter accepts (status-presenter.ts). Types only: a brand costs nothing at run time, and only
// the functions below make one: from the rows of a query they wrote with the rule in it, or after canView or the
// author's check. test/policy.test.ts keeps every other module from making one (no cast, type argument or type
// predicate names a brand).

declare const visibleStatus: unique symbol
declare const ownStatus: unique symbol

// A status the read rule passed for the viewer: a query statusReads wrote with visibleSql, listableSql, homeFilterSql
// or shownSql, or canView (viewableStatusId). A boost's original is judged again by the presenter.
export type VisibleStatusId = string & { readonly [visibleStatus]: true }

// A status of the viewer's own, for the response to their own write (post, edit, delete, boost): the author sees all of
// their own (R2), but not necessarily a boosted original, which the presenter judges for them.
export type OwnStatusId = string & { readonly [ownStatus]: true }

type Visible<T> = T extends string ? VisibleStatusId : T

// Rows whose column `K` holds the ids (or null) a rule passed, as StatusReads returns them.
export type WithVisibleStatus<Row, K extends keyof Row> = { [P in keyof Row]: P extends K ? Visible<Row[P]> : Row[P] }

// The read rule a status query applies: R2, R8 or R9.
export type StatusRule = 'visible' | 'listable' | 'homeFilter'

// One SELECT of statuses as StatusReads writes it, from the caller's parts:
//   SELECT s.id AS id FROM <from> main.statuses s <join> WHERE (<where>) AND (<rule over s>) AND (<and>) <tail>
// The rule is a conjunct of the SELECT's own WHERE, over the `statuses s` it selects the id of; the caller's conditions
// go before or after it, so the terms keep the order (and the plan) a hand-written query would give them.
export type StatusSelect = {
	// Tables before `statuses s`, ending with the join to it (`bookmarks e JOIN`).
	readonly from?: string
	// What follows `statuses s`: the ON of that join, and further joins.
	readonly join?: string
	// Conditions before the rule, and after it.
	readonly where?: string
	readonly and?: string
	// ORDER BY, LIMIT and OFFSET.
	readonly tail?: string
}

// A window of each author's statuses, for a feed of whole authors (home, a list), as StatusReads writes it:
//   SELECT w.id AS id FROM (SELECT wa.account_id FROM (<authors>) wa WHERE <rule over the author>) a
//     CROSS JOIN main.statuses w ON w.id IN (SELECT s.id FROM <from> main.statuses s <join>
//     WHERE (<author> = a.account_id AND <where>) AND (<rule over s>) AND (<and>) <tail>)
// <author> is s.account_id unless given: a window read from another index (the viewer's mentions by author) names the
// column of the author there, with the tables before statuses in <from> and the join after it in <join>, as a
// StatusSelect has them.
// <authors> selects each author once, as account_id, and <tail> orders each author's statuses by id and cuts them to a
// page: so a status of a merged page is within its author's window, the page is the one a single SELECT over all the
// authors' statuses gives, and an author costs a window however many statuses they have. The rule over the author is
// the part of the rule that holds for all of an author's statuses or none (authorRuleSql): an author it rejects has no
// window, rather than one that walks their whole history finding nothing.
export type AuthorWindows = {
	readonly authors: string
	readonly from?: string
	readonly join?: string
	readonly author?: string
	readonly where?: string
	readonly and?: string
	readonly tail: string
}

// A window of each of a set of hashtags' statuses, for a feed of whole hashtags (home's followed hashtags), as
// StatusReads writes it:
//   SELECT w.id AS id FROM (<tags>) g CROSS JOIN main.statuses w ON w.id IN (SELECT s.id FROM <from> main.statuses s
//     <join> WHERE (<tag> = g.name AND <where>) AND (<rule over s>) AND (<and>) <tail>)
// <tags> selects each hashtag once, as name; <tag> is the column of the hashtag in the index the window reads (in
// <from>), and <tail> orders each hashtag's statuses by id and cuts them to a page, as an AuthorWindows' does: a
// hashtag costs a window however many statuses carry it. A hashtag has no rule of its own, so every status of the
// window is judged by the rule.
export type TagWindows = {
	readonly tags: string
	readonly tag: string
	readonly from: string
	readonly join: string
	readonly where?: string
	readonly and?: string
	readonly tail: string
}

// Further columns, name: expression. A name is a plain identifier, never the id column the reader selects.
type Columns<Extra, Id extends string> = { readonly [K in keyof Extra]: string } & { readonly [K in Id]?: never }

type Row = Record<string, SqlStorageValue>

// The status queries of one viewer. The viewer and the time are the numbered parameters `at.viewer` and `at.now` of
// each query (a viewer with no time, the web pages', has only `viewer` and no rule that takes a time); a query runs only
// with them bound to the viewer's account id and time. Every query is written here: the caller gives the parts of a
// StatusSelect, and the ids it returns are ones the rule passed for the viewer. Nothing is parsed.
export type StatusReads = {
	// One SELECT, after an optional WITH clause its parts may read, with further columns (name: expression) after the id.
	select<Extra extends Row = Record<never, never>>(
		db: Db,
		rule: StatusRule,
		query: StatusSelect & { readonly with?: string; readonly columns?: Columns<Extra, 'id'> },
		...params: SqlStorageValue[]
	): (Extra & { id: VisibleStatusId })[]
	// SELECTs combined, each a StatusSelect, AuthorWindows or TagWindows under the same rule, selecting the id only:
	//   SELECT id FROM (SELECT * FROM (<branch>) UNION [ALL] SELECT * FROM (<branch>) ...) <tail>
	union(
		db: Db,
		rule: StatusRule,
		query: {
			readonly all: boolean
			readonly branches: readonly (StatusSelect | AuthorWindows | TagWindows)[]
			readonly tail: string
		},
		...params: SqlStorageValue[]
	): { id: VisibleStatusId }[]
	// Whether the rule passes the author `author` (an expression over the parameters) as a whole, and `and`: when it
	// does not, no status of theirs passes, so a read of their statuses alone can return nothing without reading them.
	//   SELECT 1 WHERE (<rule over the author>) AND (<and>)
	authorShown(
		db: Db,
		rule: StatusRule,
		query: { readonly author: string; readonly and?: string },
		...params: SqlStorageValue[]
	): boolean
	// The viewer's notifications the notification rule (R15) shows them, which shows a status only if they may view it,
	// and, unless `includeFiltered`, only those the recipient's policy did not filter (Notification.browserable), above
	// the viewer's last clear and their group's last dismissal (keptFloorSql). `range` is the page's cursor, `max` and
	// `min` exclusive (expressions over the parameters, as edgeRangeSql's), and `group` the one group read (an
	// expression over the parameters); the read starts above the clear (and the group's dismissal) whatever the cursor:
	//   SELECT n.status_id AS status_id, <columns> FROM main.notifications n
	//   WHERE (n.account_id = <viewer>) AND (<range above the floor>) AND (<the group, or above its dismissal>)
	//     AND (<where>) [AND (n.filtered = 0)] AND (<rule>) <tail>
	notifications<Extra extends Row>(
		db: Db,
		query: {
			readonly where: string
			readonly tail?: string
			readonly columns: Columns<Extra, 'status_id'>
			readonly includeFiltered: boolean
			readonly range?: { readonly max: string; readonly min: string }
			readonly group?: string
		},
		...params: SqlStorageValue[]
	): (Extra & { status_id: VisibleStatusId | null })[]
}

export function statusReads(
	viewer: ViewerContext | null,
	at: { readonly viewer: string; readonly now?: string }
): StatusReads {
	const now = () => {
		if (viewer === null || at.now === undefined) {
			throw new Error('this rule needs the time of the read')
		}
		return at.now
	}
	const ruleSql = (rule: StatusRule) => {
		switch (rule) {
			case 'visible':
				return visibleSql('s', at.viewer)
			case 'listable':
				return listableSql('s', at.viewer, now())
			case 'homeFilter':
				return homeFilterSql('s', at.viewer, now())
		}
	}
	const where = (...terms: (string | undefined)[]) =>
		terms.flatMap((term) => (term === undefined || term.trim() === '' ? [] : [`(${term})`])).join(' AND ')
	const columns = (extra: Record<string, string> | undefined, id: string) =>
		Object.entries(extra ?? {})
			.map(([name, expression]) => {
				if (!/^[a-z_][a-z0-9_]*$/.test(name) || name === id) {
					throw new Error(`a status query cannot select a column named ${name}`)
				}
				return `, ${expression} AS ${name}`
			})
			.join('')
	const selectSql = (rule: string, q: StatusSelect, extra?: Record<string, string>) =>
		`SELECT s.id AS id${columns(extra, 'id')} FROM ${q.from ?? ''} main.statuses s ${q.join ?? ''}
		WHERE ${where(q.where, rule, q.and)} ${q.tail ?? ''}`
	// The part of the rule over the author `x` alone, which every status of theirs passes if any does: the author is
	// available and, unless the viewer, does not block them; for the list and home rules, the viewer does not filter
	// them either.
	const authorRuleSql = (rule: StatusRule, x: string) => {
		const visible = `${availableSql(x)} AND (${x} IS ${at.viewer} OR NOT ${blocksSql(x, at.viewer)})`
		return rule === 'visible' ? visible : `${visible} AND NOT ${filteredForSql(x, at.viewer, now())}`
	}
	const branchSql = (rule: StatusRule, q: StatusSelect | AuthorWindows | TagWindows) => {
		if ('tags' in q) {
			const window = selectSql(ruleSql(rule), {
				from: q.from,
				join: q.join,
				where: `${q.tag} = g.name${q.where === undefined ? '' : ` AND ${q.where}`}`,
				and: q.and,
				tail: q.tail,
			})
			return `SELECT w.id AS id FROM (${q.tags}) g CROSS JOIN main.statuses w ON w.id IN (${window})`
		}
		if (!('authors' in q)) {
			return selectSql(ruleSql(rule), q)
		}
		const window = selectSql(ruleSql(rule), {
			from: q.from,
			join: q.join,
			where: `${q.author ?? 's.account_id'} = a.account_id${q.where === undefined ? '' : ` AND ${q.where}`}`,
			and: q.and,
			tail: q.tail,
		})
		const authors = `SELECT wa.account_id FROM (${q.authors}) wa WHERE ${authorRuleSql(rule, 'wa.account_id')}`
		return `SELECT w.id AS id FROM (${authors}) a CROSS JOIN main.statuses w ON w.id IN (${window})`
	}
	const run = <T extends Row>(db: Db, query: string, params: SqlStorageValue[]): T[] => {
		const bound = (placeholder: string) => {
			const index = /^\?([1-9]\d*)$/.exec(placeholder)?.[1]
			return index === undefined ? undefined : params[Number(index) - 1]
		}
		if (bound(at.viewer) !== (viewer?.accountId ?? null) || (at.now !== undefined && bound(at.now) !== viewer?.now)) {
			throw new Error("a status query must bind the viewer's account id and time")
		}
		return db.all<T>(query, ...params)
	}
	return {
		select<Extra extends Row = Record<never, never>>(
			db: Db,
			rule: StatusRule,
			query: StatusSelect & { readonly with?: string; readonly columns?: Columns<Extra, 'id'> },
			...params: SqlStorageValue[]
		) {
			const sql = `${query.with ?? ''} ${selectSql(ruleSql(rule), query, query.columns)}`
			return run<Extra & { id: VisibleStatusId }>(db, sql, params)
		},
		union(db, rule, query, ...params) {
			const branches = query.branches.map((branch) => `SELECT * FROM (${branchSql(rule, branch)})`)
			return run<{ id: VisibleStatusId }>(
				db,
				`SELECT id FROM (${branches.join(query.all ? ' UNION ALL ' : ' UNION ')}) ${query.tail}`,
				params
			)
		},
		authorShown(db, rule, query, ...params) {
			return (
				run<{ shown: number }>(
					db,
					`SELECT 1 AS shown WHERE ${where(authorRuleSql(rule, query.author), query.and)}`,
					params
				).length > 0
			)
		},
		notifications<Extra extends Row>(
			db: Db,
			query: {
				readonly where: string
				readonly tail?: string
				readonly columns: Columns<Extra, 'status_id'>
				readonly includeFiltered: boolean
				readonly range?: { readonly max: string; readonly min: string }
				readonly group?: string
			},
			...params: SqlStorageValue[]
		) {
			const rule = shownSql(at.viewer, 'n.type', 'n.from_account_id', 'n.status_id', now())
			// A term of its own, so the plan reads the partial index of unfiltered notifications (notifications_unfiltered).
			const unfiltered = query.includeFiltered ? undefined : UNFILTERED_SQL
			// One lower bound on the id, the cursor's or the floor, whichever is higher, so the index walk starts above
			// what a clear or the group's dismissal hides, and one upper bound, the cursor's, only with a range: a second
			// bound on either side may be the one the plan walks by. A read of every group checks each row's group by its
			// key.
			const floor = keptFloorSql(at.viewer, query.group ?? null)
			const range = `n.id > max(coalesce(CAST(${query.range?.min ?? 'NULL'} AS INTEGER), 0), ${floor})
				${query.range === undefined ? '' : `AND n.id < coalesce(CAST(${query.range.max} AS INTEGER), 1e19)`}`
			const group =
				query.group === undefined ? `n.id > ${dismissedSql(at.viewer, 'n.group_key')}` : `n.group_key = ${query.group}`
			return run<Extra & { status_id: VisibleStatusId | null }>(
				db,
				`SELECT n.status_id AS status_id${columns(query.columns, 'status_id')} FROM main.notifications n
				WHERE ${where(`n.account_id = ${at.viewer}`, range, group, query.where, unfiltered, rule)} ${query.tail ?? ''}`,
				params
			)
		},
	}
}

// The status `statusId`, if `viewerId` (null: anonymous) may see it by itself (canView).
export function viewableStatusId(db: Db, viewerId: string | null, statusId: string): VisibleStatusId | null {
	return canView(db, viewerId, statusId) ? (statusId as VisibleStatusId) : null
}

// The status `statusId`, if it is `authorId`'s own.
export function ownStatusId(db: Db, authorId: string, statusId: string): OwnStatusId | null {
	return db.first('SELECT 1 AS own FROM main.statuses WHERE id = ? AND account_id = ?', statusId, authorId) ===
		undefined
		? null
		: (statusId as OwnStatusId)
}

// R26: a scheduled status (scheduled_statuses row `ss`) is its owner's alone. It is not a status: no other rule
// reads it, nothing lists, notifies or delivers it, and anyone else's is not found, until its publication writes an
// ordinary status, which the rules above then govern.
export function scheduledOwnSql(ss: string, viewer: string): string {
	return `${ss}.account_id = ${viewer}`
}

// R27 (PollPolicy#vote?): whether `voter` may vote in the poll of the status `s`: may see the status by itself (R3),
// and blocks neither its author (an author who blocks the voter hides the status already) nor the author's domain, to
// which a remote poll's vote would not be delivered (R23 leaves such an account out). Votes are their voters'
// own: polls.ts alone reads poll_votes, and shows a poll's counts and a viewer's own votes, never who voted.
export function mayVoteSql(s: string, voter: string): string {
	return `(${viewableSql(s, voter)} AND NOT ${blockedSql(voter, `${s}.account_id`)})`
}

// ---- Notifications.

// Status.without_replies: not a reply, or a reply in the author's own conversation (in_reply_to_account_id carries
// the partner through self-replies, so continuing a reply to someone else is still a reply to them).
export const NOT_A_REPLY_TO_OTHERS = '(s.in_reply_to_uri IS NULL OR s.in_reply_to_account_id = s.account_id)'

// Whether `r` blocks the account `a`, or mutes it with notifications at `now`.
function silencedSql(r: string, a: string, now: string): string {
	return `(${blocksSql(r, a)} OR ${mutesSql(r, a, now, true)})`
}

// R15: whether the recipient `r` is shown a notification of `type` from `from` about `status` at `now`. One rule
// decides whether a notification is written, listed and pushed (notifications.ts, push.ts): the sender is not the
// recipient (but for the end of the recipient's own poll, NotifyService's from_self? exception), is available, is not blocked (either way), muted with notifications or domain-blocked by the recipient,
// and the recipient may see the status. A reblog notification names the original; the boost itself (the sender's one
// boost of it) must be visible to the recipient too, so a followers-only or direct boost is not revealed to an author
// outside its audience. A mention is left out when its status mentions or replies to an account the recipient
// silences (FeedManager#filter_from_mentions), and a post notification (`status`) when its status is a reply other
// than in the author's own conversation (a partner that is someone else or unknown, as FeedInsertWorker#notify?) or
// when home would leave it out (homeFilterSql, which also hides a sender the recipient mutes without notifications).
export function shownSql(r: string, type: string, from: string, status: string, now: string): string {
	return `((${from} <> ${r} OR ${type} = 'poll')
		AND ${availableSql(from)}
		AND NOT ${silencedSql(r, from, now)}
		AND NOT ${blocksSql(from, r)}
		AND NOT ${domainBlocksSql(r, from)}
		AND (${status} IS NULL OR EXISTS (SELECT 1 FROM main.statuses s WHERE s.id = ${status} AND ${viewableSql('s', r)}))
		AND (${type} <> 'reblog' OR EXISTS (SELECT 1 FROM main.statuses nr
			WHERE nr.account_id = ${from} AND nr.reblog_of_id = ${status} AND ${visibleSql('nr', r)}))
		AND (${type} <> 'mention' OR NOT EXISTS (SELECT 1 FROM main.statuses mt WHERE mt.id = ${status}
			AND (EXISTS (SELECT 1 FROM main.status_mentions mm WHERE mm.status_id = mt.id AND mm.silent = 0
					AND ${silencedSql(r, 'mm.account_id', now)})
				OR (mt.in_reply_to_account_id IS NOT NULL AND ${silencedSql(r, 'mt.in_reply_to_account_id', now)}))))
		AND (${type} <> 'status' OR EXISTS (SELECT 1 FROM main.statuses s WHERE s.id = ${status}
			AND ${NOT_A_REPLY_TO_OTHERS} AND ${homeFilterSql('s', r, now)})))`
}

// R31 (Account#muting_conversation?): whether `owner` mutes the conversation `thread`, an expression for a status's
// thread (statuses.thread, Mastodon's conversation_id). A mute is its owner's alone: only this module reads
// conversation_mutes, for the status's `muted` and for notify.
export function conversationMutedSql(owner: string, thread: string): string {
	return `EXISTS (SELECT 1 FROM main.conversation_mutes pcm WHERE pcm.account_id = ${owner} AND pcm.thread = ${thread})`
}

// R15 as notify writes a notification (NotifyService#drop?): what shownSql shows, unless its status is in a
// conversation the recipient mutes (R31, NotifyService::DropCondition#conversation_muted?: a reblog notification
// names the original, whose conversation counts). Mastodon drops only the notifications it would create: one written
// before the mute stays listed and pushed, so listing and pushes apply shownSql alone.
export function notifiedSql(r: string, type: string, from: string, status: string, now: string): string {
	return `((${status} IS NULL OR NOT EXISTS (SELECT 1 FROM main.statuses nc WHERE nc.id = ${status}
			AND ${conversationMutedSql(r, 'nc.thread')}))
		AND ${shownSql(r, type, from, status, now)})`
}

// ---- Notification policies (R15 as notify writes; Mastodon 4.5's NotifyService::DropCondition and FilterCondition).

// A notification the recipient's policy filtered (notifications.filtered) is written but left out of every list, count
// and push unless the request asks for filtered ones (Notification.browserable: include_filtered, or account_id in
// v1). statusReads(...).notifications adds this term unless asked; push.ts adds it to the push target.
export const UNFILTERED_SQL = 'n.filtered = 0'

// ---- Cleared notifications and dismissed groups (R15; migration 0023_notification_clears).

// The id at or below which the notifications of the recipient `r` are hidden: the highest id when they last cleared
// them (POST /api/v1/notifications/clear) and, with `group`, the highest of that group when they last dismissed it
// (POST /api/v2/notifications/:group_key/dismiss); 0 for neither. Each is a key lookup. With `r` and `group` naming no
// column of the notification read (parameters), it is a constant, so `n.id > <floor>` is a lower bound in the
// (account_id, id) and group indexes: a read starts above what is hidden and never walks it. notifications.ts deletes
// the rows hidden in batches, after.
export function keptFloorSql(r: string, group: string | null): string {
	const cleared = `coalesce((SELECT kc.max_id FROM main.notification_clears kc WHERE kc.account_id = ${r}), 0)`
	return group === null ? cleared : `max(${cleared}, ${dismissedSql(r, group)})`
}

// The highest id of the group `group` of the recipient `r` when they last dismissed it (0 for none), a key lookup.
function dismissedSql(r: string, group: string): string {
	return `coalesce((SELECT kd.max_id FROM main.notification_dismissals kd
		WHERE kd.account_id = ${r} AND kd.group_key = ${group}), 0)`
}

// Whether notification `n` (a table alias) is above its recipient's clear and its group's dismissal, by its own
// columns: two key lookups, for a read of single notifications whatever their recipients (the push target, an
// accepted request's job). statusReads(...).notifications applies the same as a bound.
export function keptSql(n: string): string {
	return `(${n}.id > ${keptFloorSql(`${n}.account_id`, null)}
		AND ${n}.id > ${dismissedSql(`${n}.account_id`, `${n}.group_key`)})`
}

// The types a policy may filter or drop (Notification::PROPERTIES, app/models/notification.rb:37-83: `filterable`):
// mention, reblog, follow, follow_request and favourite, and quote, which Kopje never notifies. A post notification
// (`status`), an edit (`update`) and a poll's end are never filtered.
export const FILTERABLE_TYPES: readonly string[] = ['mention', 'reblog', 'follow', 'follow_request', 'favourite']

// A policy's choice for a condition (NotificationPolicy's enums, app/models/notification_policy.rb:34-38).
export type PolicyChoice = 'accept' | 'filter' | 'drop'

// The policy's columns and Mastodon's defaults (the schema's, app/models/notification_policy.rb:11-15), which an
// account without a notification_policies row has.
export const POLICY_DEFAULTS = {
	for_not_following: 'accept',
	for_not_followers: 'accept',
	for_new_accounts: 'accept',
	for_private_mentions: 'filter',
	for_limited_accounts: 'filter',
} as const satisfies Record<string, PolicyChoice>

export type PolicyColumn = keyof typeof POLICY_DEFAULTS

// BaseCondition::NEW_FOLLOWER_THRESHOLD and NEW_ACCOUNT_THRESHOLD (app/services/notify_service.rb:20-22).
const NEW_FOLLOWER_DAYS = 3
const NEW_ACCOUNT_DAYS = 30

// How far up a private mention's thread the reply exemption walks: the parent and this many statuses above it
// (statuses_that_mention_sender's depth_limit, app/services/notify_service.rb:90 and :102).
export const PRIVATE_MENTION_WALK = 100

// The recipient `r`'s choice for `column`, or its default.
function policyChoiceSql(r: string, column: PolicyColumn): string {
	return `coalesce((SELECT pp.${column} FROM main.notification_policies pp WHERE pp.account_id = ${r}), '${POLICY_DEFAULTS[column]}')`
}

// The time `days` days before `now` (an ISO time), in the form the rows' times are stored in.
function daysBeforeSql(now: string, days: number): string {
	return `strftime('%Y-%m-%dT%H:%M:%fZ', ${now}, '-${days} days')`
}

// BaseCondition#not_following? (:47-49): the recipient does not follow the sender (an accepted follow).
function notFollowingSql(r: string, from: string): string {
	return `NOT EXISTS (SELECT 1 FROM main.follows pf WHERE pf.account_id = ${r} AND pf.target_account_id = ${from}
		AND pf.state = 'accepted')`
}

// BaseCondition#not_follower? (:51-54): the sender does not follow the recipient, or has followed for less than
// three days. Kopje keeps a follow's time from its request, so a follow accepted later counts from the request.
function notFollowerSql(r: string, from: string, now: string): string {
	return `NOT EXISTS (SELECT 1 FROM main.follows pr WHERE pr.account_id = ${from} AND pr.target_account_id = ${r}
		AND pr.state = 'accepted' AND pr.created_at <= ${daysBeforeSql(now, NEW_FOLLOWER_DAYS)})`
}

// BaseCondition#new_account? (:56-58): the sender's account was created less than 30 days ago (a remote account's
// time is the actor's `published`, as Mastodon's ProcessAccountService takes it, or when it was first stored).
function newAccountSql(from: string, now: string): string {
	return `EXISTS (SELECT 1 FROM main.accounts pn WHERE pn.id = ${from}
		AND pn.created_at > ${daysBeforeSql(now, NEW_ACCOUNT_DAYS)})`
}

// BaseCondition#private_mention_not_in_response? (:76-109): a mention in a direct status that does not answer a
// private mention of the sender by the recipient. Mastodon's statuses_that_mention_sender walks the thread up from the
// status's parent: the parent counts when it mentions the sender (not silently), whoever wrote it, and an ancestor
// above it when the recipient wrote it and it mentions the sender; the walk stops at the first that counts, or
// PRIVATE_MENTION_WALK statuses above the parent, and the status answers the recipient when what it stopped at is the
// recipient's own direct status. A status whose parent was never stored (no in_reply_to_id) answers nothing, as in
// Mastodon.
function privateMentionNotInResponseSql(r: string, type: string, from: string, status: string): string {
	const mentionsSender = (s: string) => `EXISTS (SELECT 1 FROM main.status_mentions pm WHERE pm.status_id = ${s}.id
		AND pm.account_id = ${from} AND pm.silent = 0)`
	return `(${type} = 'mention' AND EXISTS (SELECT 1 FROM main.statuses pd WHERE pd.id = ${status}
		AND pd.visibility = 'direct' AND NOT (pd.in_reply_to_id IS NOT NULL AND EXISTS (
			WITH RECURSIVE pw(id, parent, hit, depth) AS (
				SELECT ps.id, ps.in_reply_to_id, ${mentionsSender('ps')}, 0 FROM main.statuses ps
				WHERE ps.id = pd.in_reply_to_id
				UNION ALL
				SELECT ps.id, ps.in_reply_to_id, ps.account_id = ${r} AND ${mentionsSender('ps')}, pw.depth + 1
				FROM pw JOIN main.statuses ps ON ps.id = pw.parent
				WHERE pw.hit = 0 AND pw.depth < ${PRIVATE_MENTION_WALK})
			SELECT 1 FROM pw JOIN main.statuses pa ON pa.id = pw.id
			WHERE pw.hit AND pa.account_id = ${r} AND pa.visibility = 'direct'))))`
}

// Whether a condition of the recipient's policy chose `choice` for the notification: Mastodon's
// blocked_by_*_policy? (:154-172) for drop and filtered_by_*_policy? (:190-208) for filter. Kopje has no silenced
// (limited) accounts, so for_limited_accounts is kept and shown but never matches.
function policyMatchesSql(
	choice: Exclude<PolicyChoice, 'accept'>,
	r: string,
	type: string,
	from: string,
	status: string,
	now: string
): string {
	const is = (column: PolicyColumn) => `${policyChoiceSql(r, column)} = '${choice}'`
	return `(${notFollowingSql(r, from)} AND (${is('for_not_following')}
			OR (${is('for_new_accounts')} AND ${newAccountSql(from, now)})
			OR (${is('for_private_mentions')} AND ${privateMentionNotInResponseSql(r, type, from, status)})))
		OR (${is('for_not_followers')} AND ${notFollowerSql(r, from, now)})`
}

// R15, the policy part (NotifyService#drop? and #filter?, app/services/notify_service.rb:113-134 and :176-186): what
// the recipient `r`'s policy makes of a notification of `type` from `from` about `status` at `now`, as 'accept',
// 'filter' or 'drop'. A type that is not filterable, or a sender the recipient accepted a request from
// (override_for_sender?, a notification_permissions row), is accepted; otherwise a condition whose choice is drop
// drops it, else one whose choice is filter filters it. The blocks, mutes, domain blocks and conversation mutes that
// drop a notification are notifiedSql's. Kopje has no staff role that bypasses blocks (from_staff? is false), and
// no silenced accounts (from_limited? is false).
export function notificationPolicySql(r: string, type: string, from: string, status: string, now: string): string {
	return `(CASE WHEN ${type} NOT IN (${FILTERABLE_TYPES.map((t) => `'${t}'`).join(', ')})
			OR EXISTS (SELECT 1 FROM main.notification_permissions pp WHERE pp.account_id = ${r} AND pp.from_account_id = ${from})
		THEN 'accept'
		WHEN ${policyMatchesSql('drop', r, type, from, status, now)} THEN 'drop'
		WHEN ${policyMatchesSql('filter', r, type, from, status, now)} THEN 'filter'
		ELSE 'accept' END)`
}

// ---------------------------------------------------------------------------------------------------------------
// ActivityPub addressing.
// ---------------------------------------------------------------------------------------------------------------

export const PUBLIC_COLLECTION = 'https://www.w3.org/ns/activitystreams#Public'

const PUBLIC_FORMS = new Set([PUBLIC_COLLECTION, 'as:Public', 'Public'])

export function isPublicCollection(uri: string): boolean {
	return PUBLIC_FORMS.has(uri)
}

export type StatusMention = { accountId: string; silent: boolean }

export type InboundAddressing = {
	to: readonly string[]
	cc: readonly string[]
	// The author's followers collection, when known.
	followersUri: string | null
	// hrefs of the object's Mention tags.
	mentionUris: readonly string[]
	// Known accounts by actor URI (local or remote). Unknown recipients are not fetched and are dropped.
	known: ReadonlyMap<string, string>
	// The local account whose personal inbox received the activity, if it came that way.
	deliveredTo?: string | null
}

// How a received status is classified (Mastodon's StatusParser#visibility and ProcessStatus#process_audience):
//   - Public in to → public; Public in cc → unlisted; the author's followers in to → private; otherwise direct.
//   - Mentioned known accounts are mentions. Known accounts in to/cc that are not mentioned, and the owner of the
//     personal inbox it arrived at if not addressed, are silent mentions.
//   - A direct status with silent mentions is limited (Misskey's specified).
export function interpretAddressing(input: InboundAddressing): { visibility: Visibility; mentions: StatusMention[] } {
	let visibility: Visibility
	if (input.to.some(isPublicCollection)) {
		visibility = 'public'
	} else if (input.cc.some(isPublicCollection)) {
		visibility = 'unlisted'
	} else if (input.followersUri !== null && input.to.includes(input.followersUri)) {
		visibility = 'private'
	} else {
		visibility = 'direct'
	}
	const mentions = new Map<string, StatusMention>()
	for (const uri of input.mentionUris) {
		const accountId = input.known.get(uri)
		if (accountId !== undefined) {
			mentions.set(accountId, { accountId, silent: false })
		}
	}
	for (const uri of [...input.to, ...input.cc]) {
		const accountId = input.known.get(uri)
		if (accountId !== undefined && !mentions.has(accountId)) {
			mentions.set(accountId, { accountId, silent: true })
		}
	}
	const deliveredTo = input.deliveredTo ?? null
	if (deliveredTo !== null && !mentions.has(deliveredTo)) {
		mentions.set(deliveredTo, { accountId: deliveredTo, silent: true })
	}
	const list = [...mentions.values()]
	if (visibility === 'direct' && list.some((mention) => mention.silent)) {
		visibility = 'limited'
	}
	return { visibility, mentions: list }
}

export type Recipient = { accountId: string; uri: string; silent: boolean }

// to and cc of a local status (Mastodon's ActivityPub::TagManager#to and #cc). Silent recipients are never written
// into the addressing: they receive the activity through its audience only.
export function addressingOf(
	visibility: Visibility,
	followersUri: string,
	recipients: readonly Recipient[]
): { to: string[]; cc: string[] } {
	const mentioned = recipients.filter((r) => !r.silent).map((r) => r.uri)
	switch (visibility) {
		case 'public':
			return { to: [PUBLIC_COLLECTION], cc: [followersUri, ...mentioned] }
		case 'unlisted':
			return { to: [followersUri], cc: [PUBLIC_COLLECTION, ...mentioned] }
		case 'private':
			return { to: [followersUri], cc: mentioned }
		case 'direct':
		case 'limited':
			return { to: mentioned, cc: [] }
	}
}

// Who must receive an activity about a status: the author's followers (unless only the addressed may see it) and
// the addressed accounts, silent ones included. B2 expands it into inboxes; local accounts are served from the Store.
// followers: the signer's followers; accounts: the addressed accounts; pollVoters: the remote voters of the signer's
// poll on the status with this id (the Update of a poll, DistributePollUpdateWorker), whom recipientsFor reaches only
// for a public or unlisted status.
export type Audience = { followers: boolean; accounts: string[]; pollVoters?: string }

export function audienceOf(visibility: Visibility, recipients: readonly Recipient[], extra: readonly string[] = []) {
	const accounts = new Set([...recipients.map((r) => r.accountId), ...extra])
	return { followers: !requiresMention(visibility), accounts: [...accounts] } satisfies Audience
}

// ---------------------------------------------------------------------------------------------------------------
// Outbound recipients (R22, R23): who an activity of a local signer goes to. deliveries.ts turns them into inboxes
// and personal copies; nothing else selects the followers or the addressed accounts of an activity.
// ---------------------------------------------------------------------------------------------------------------

// What an outbound activity does, which decides whom it may reach:
//   - content carries a status, or a boost of one, to its audience: Create, an Update of a status, Announce. It goes
//     to no unavailable account (R1) and to no one the signer blocks or whose domain it blocks (VIS-13, VIS-15): an
//     addressed account the signer blocks or domain-blocks is neither named nor sent to, and a follower on a domain it
//     blocks (one the domain block's cleanup has not removed yet) is not sent to.
//   - a retraction withdraws what was sent: a Delete, an Undo of anything, a Reject that ends a follow we had accepted
//     (withdraws). It is named to and reaches its whole audience, the blocked included, and every inbox that received
//     what it withdraws (deliveries.ts).
//   - everything else (an Update of the actor, Like, Follow, Accept, a Reject of a request, Block) goes to its whole
//     audience. Mastodon 4.5 filters none of these by block or domain block: FavouriteService, FollowService,
//     BlockService and RejectFollowService send to the account's inbox, and ActivityPub::UpdateDistributionWorker to
//     followers.inboxes (AccountReachFinder); a domain block ends the follows with the domain instead
//     (AfterBlockDomainFromAccountService), as its cleanup does here.
export type OutboundKind = 'content' | 'retraction' | 'other'

const ACTOR_TYPES = new Set(['Person', 'Service', 'Group', 'Application', 'Organization'])

// Whether an activity's object is an actor document (an Update of a profile).
export function isActorObject(object: unknown): boolean {
	return typeof object === 'object' && object !== null && ACTOR_TYPES.has(String((object as { type?: unknown }).type))
}

export function outboundKind(activity: Record<string, unknown>, withdraws = false): OutboundKind {
	switch (activity.type) {
		case 'Create':
		case 'Announce':
			return 'content'
		case 'Update':
			return isActorObject(activity.object) ? 'other' : 'content'
		case 'Delete':
		case 'Undo':
			return 'retraction'
		case 'Reject':
			return withdraws ? 'retraction' : 'other'
		default:
			return 'other'
	}
}

// Whether an activity of `kind` by `signer` leaves out the account `x`: when it is unavailable; as a follower, when
// the signer blocks its domain; as an addressed account, when the signer blocks it or its domain. Only content leaves
// anyone out, so only for content does the fragment name `signer` (a caller binds it then only).
function leavesOutSql(kind: OutboundKind, as: 'follower' | 'addressed', signer: string, x: string): string {
	if (kind !== 'content') {
		return '0'
	}
	return `(NOT ${availableSql(x)} OR ${as === 'follower' ? domainBlocksSql(signer, x) : blockedSql(signer, x)})`
}

// Whether an activity of `kind` by `signer` names and reaches the account `accountId` among its addressed accounts
// (R22): a boost names the original's author through this, so its Announce leaves out an author the booster blocks or
// domain-blocks, and its Undo names them all the same.
export function addresses(db: Db, kind: OutboundKind, signerId: string, accountId: string): boolean {
	return (
		kind !== 'content' ||
		db.first(`SELECT 1 AS x WHERE NOT ${leavesOutSql(kind, 'addressed', '?1', '?2')}`, signerId, accountId) !==
			undefined
	)
}

// R23 for a forwarded report (R34): the accounts its Flag is addressed to, as Mastodon's ReportService chooses them
// (app/services/report_service.rb:53-79) for a remote reported account `target` whose report the reporter asked to
// forward. These are the reported account when its domain is among `domains` (forward_to_origin?), and the remote
// accounts on those domains that the reported statuses `statusIds` reply to (in_reply_to_account_id), less those whose
// inbox is one of the reported account's (forward_to_replied_to!: `inboxes - [inbox_url, shared_inbox_url]`). The
// statuses are read by key, so the work is bounded by the report's statuses.
export function reportForwardees(
	db: Db,
	target: string,
	statusIds: readonly string[],
	domains: readonly string[]
): string[] {
	return db
		.all<{ id: string }>(
			`SELECT t.id FROM main.accounts t
			WHERE t.id = ?1 AND t.domain IS NOT NULL AND t.domain IN (SELECT value FROM json_each(?3))
			UNION
			SELECT a.id FROM main.accounts t CROSS JOIN main.statuses s JOIN main.accounts a ON a.id = s.in_reply_to_account_id
			WHERE t.id = ?1 AND s.id IN (SELECT value FROM json_each(?2))
				AND a.domain IS NOT NULL AND a.domain IN (SELECT value FROM json_each(?3))
				AND COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) IS NOT NULLIF(t.inbox_url, '')
				AND COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) IS NOT NULLIF(t.shared_inbox_url, '')
			ORDER BY 1`,
			target,
			JSON.stringify(statusIds),
			JSON.stringify(domains)
		)
		.map((row) => row.id)
}

// A remote account an activity is addressed to, with its inboxes ('' read as none).
export type AddressedAccount = { uri: string; inbox_url: string | null; shared_inbox_url: string | null }

export type OutboundRecipients = {
	// The inboxes of the signer's accepted remote followers the activity reaches, when its audience has the followers:
	// each one's shared inbox when it has one, else its personal inbox, deduplicated (possibly null or '').
	followerInboxes: (string | null)[]
	// The remote accounts of its audience it reaches, by id.
	accounts: AddressedAccount[]
	// The inboxes of the remote voters of its poll it reaches, when its audience has them, as followerInboxes are.
	voterInboxes: (string | null)[]
}

// R23: whom an activity by `signerId` for `audience` reaches, by its kind (outboundKind). Local accounts are not
// among them: they read the Store. withdraws: a Reject that ends a follow already accepted.
export function recipientsFor(
	db: Db,
	signerId: string,
	activity: Record<string, unknown>,
	audience: Audience,
	withdraws = false
): OutboundRecipients {
	const kind = outboundKind(activity, withdraws)
	const followerInboxes = audience.followers
		? db
				.all<{ inbox: string | null }>(
					`SELECT DISTINCT COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) AS inbox
					FROM main.follows f JOIN main.accounts a ON a.id = f.account_id
					WHERE f.target_account_id = ?1 AND f.state = 'accepted' AND a.domain IS NOT NULL
						AND NOT ${leavesOutSql(kind, 'follower', '?1', 'a.id')}`,
					signerId
				)
				.map((row) => row.inbox)
		: []
	const accounts = db.all<AddressedAccount>(
		`SELECT a.uri, NULLIF(a.inbox_url, '') AS inbox_url, NULLIF(a.shared_inbox_url, '') AS shared_inbox_url
		FROM main.accounts a
		WHERE a.id IN (SELECT value FROM json_each(?1)) AND a.domain IS NOT NULL
			AND NOT ${leavesOutSql(kind, 'addressed', '?2', 'a.id')}
		ORDER BY a.id`,
		JSON.stringify(audience.accounts),
		...(kind === 'content' ? [signerId] : [])
	)
	// The voters of the poll's current generation (polls.ts), of a public or unlisted status of the signer's only (the
	// others reach them as followers or addressed accounts already), without those the signer may not address.
	const voterInboxes =
		audience.pollVoters === undefined
			? []
			: db
					.all<{ inbox: string | null }>(
						`SELECT DISTINCT COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) AS inbox
						FROM main.statuses ps JOIN main.polls pp ON pp.status_id = ps.id AND pp.removed = 0
							JOIN main.poll_votes pv ON pv.poll_id = pp.status_id AND pv.generation = pp.generation
							JOIN main.accounts a ON a.id = pv.account_id
						WHERE ps.id = ?1 AND ps.account_id = ?2 AND ps.visibility IN ${DISTRIBUTABLE_SQL}
							AND a.domain IS NOT NULL AND NOT ${leavesOutSql(kind, 'addressed', '?2', 'a.id')}`,
						audience.pollVoters,
						signerId
					)
					.map((row) => row.inbox)
	return { followerInboxes, accounts, voterInboxes }
}
