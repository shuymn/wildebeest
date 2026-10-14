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

// ---- Accounts. `x` is an expression for an account id, never a status or edge alias.

// R1 (Account#unavailable?): a suspended local account is seen by nobody, and nothing of it is shown or delivered.
export function availableSql(x: string): string {
	return `(NOT EXISTS (SELECT 1 FROM main.local_accounts pl WHERE pl.account_id = ${x} AND pl.suspended_at IS NOT NULL))`
}

// The same rule for a local_accounts row `l` already joined to the account (a LEFT JOIN's NULL row, a remote account,
// passes), so a query that has the row does not look it up again.
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

// ---- Statuses. `s` is the alias of a statuses row.

// R2 (StatusPolicy#show?): whether `viewer` may see the row itself.
//   - a status of an unavailable author is seen by nobody;
//   - the author sees everything of their own;
//   - an author who blocks the viewer hides everything from them;
//   - public and unlisted are seen by everyone else;
//   - private is seen by accepted followers and the mentioned (silent included);
//   - direct and limited are seen by the mentioned (silent included) only.
// It has no time: nothing the viewer chose changes what they may see.
export function visibleSql(s: string, viewer: string): string {
	return `(${availableSql(`${s}.account_id`)}
		AND (${s}.account_id IS ${viewer}
			OR (NOT ${blocksSql(`${s}.account_id`, viewer)}
				AND (${s}.visibility IN ${DISTRIBUTABLE_SQL}
					OR (${s}.visibility = 'private' AND EXISTS (SELECT 1 FROM main.follows fo
						WHERE fo.account_id IS ${viewer} AND fo.target_account_id = ${s}.account_id AND fo.state = 'accepted'))
					OR EXISTS (SELECT 1 FROM main.status_mentions sm WHERE sm.status_id = ${s}.id AND sm.account_id IS ${viewer})))))`
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

// Further columns, name: expression. A name is a plain identifier, never the id column the reader selects.
type Columns<Extra, Id extends string> = { readonly [K in keyof Extra]: string } & { readonly [K in Id]?: never }

type Row = Record<string, SqlStorageValue>

// The status queries of one viewer. The viewer and the time are the numbered parameters `at.viewer` and `at.now` of
// each query (a viewer with no time, the web pages', has only `viewer` and no rule that takes a time); a query runs only
// with them bound to the viewer's account id and time. Every query is written here: the caller gives the parts of a
// StatusSelect, and the ids it returns are ones the rule passed for the viewer. Nothing is parsed.
export type StatusReads = {
	// One SELECT, after an optional WITH clause its parts may read, with further columns (name: expression) after the id.
	select<Extra extends Row & { id?: never } = Record<never, never>>(
		db: Db,
		rule: StatusRule,
		query: StatusSelect & { readonly with?: string; readonly columns?: Columns<Extra, 'id'> },
		...params: SqlStorageValue[]
	): (Extra & { id: VisibleStatusId })[]
	// SELECTs combined, each a StatusSelect under the same rule, selecting the id only:
	//   SELECT id FROM (SELECT * FROM (<branch>) UNION [ALL] SELECT * FROM (<branch>) ...) <tail>
	union(
		db: Db,
		rule: StatusRule,
		query: { readonly all: boolean; readonly branches: readonly StatusSelect[]; readonly tail: string },
		...params: SqlStorageValue[]
	): { id: VisibleStatusId }[]
	// The viewer's notifications the notification rule (R15) shows them, which shows a status only if they may view it:
	//   SELECT n.status_id AS status_id, <columns> FROM main.notifications n WHERE (<where>) AND (<rule>) <tail>
	notifications<Extra extends Row & { status_id?: never }>(
		db: Db,
		query: { readonly where: string; readonly tail?: string; readonly columns: Columns<Extra, 'status_id'> },
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
		select<Extra extends Row & { id?: never } = Record<never, never>>(
			db: Db,
			rule: StatusRule,
			query: StatusSelect & { readonly with?: string; readonly columns?: Columns<Extra, 'id'> },
			...params: SqlStorageValue[]
		) {
			const sql = `${query.with ?? ''} ${selectSql(ruleSql(rule), query, query.columns)}`
			return run<Extra & { id: VisibleStatusId }>(db, sql, params)
		},
		union(db, rule, query, ...params) {
			const sql = ruleSql(rule)
			const branches = query.branches.map((branch) => `SELECT * FROM (${selectSql(sql, branch)})`)
			return run<{ id: VisibleStatusId }>(
				db,
				`SELECT id FROM (${branches.join(query.all ? ' UNION ALL ' : ' UNION ')}) ${query.tail}`,
				params
			)
		},
		notifications<Extra extends Row & { status_id?: never }>(
			db: Db,
			query: { readonly where: string; readonly tail?: string; readonly columns: Columns<Extra, 'status_id'> },
			...params: SqlStorageValue[]
		) {
			const rule = shownSql(at.viewer, 'n.type', 'n.from_account_id', 'n.status_id', now())
			return run<Extra & { status_id: VisibleStatusId | null }>(
				db,
				`SELECT n.status_id AS status_id${columns(query.columns, 'status_id')} FROM main.notifications n
				WHERE ${where(query.where, rule)} ${query.tail ?? ''}`,
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

// ---- Notifications.

// Whether `r` blocks the account `a`, or mutes it with notifications at `now`.
function silencedSql(r: string, a: string, now: string): string {
	return `(${blocksSql(r, a)} OR ${mutesSql(r, a, now, true)})`
}

// R15: whether the recipient `r` is shown a notification of `type` from `from` about `status` at `now`. One rule
// decides whether a notification is written, listed and pushed (notifications.ts, push.ts): the sender is not the
// recipient, is available, is not blocked (either way), muted with notifications or domain-blocked by the recipient,
// and the recipient may see the status. A reblog notification names the original; the boost itself (the sender's one
// boost of it) must be visible to the recipient too, so a followers-only or direct boost is not revealed to an author
// outside its audience. A mention is left out when its status mentions or replies to an account the recipient
// silences (FeedManager#filter_from_mentions), and a post notification (`status`) when home would leave its status
// out (homeFilterSql, which also hides a sender the recipient mutes without notifications).
export function shownSql(r: string, type: string, from: string, status: string, now: string): string {
	return `(${from} <> ${r}
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
		AND (${type} <> 'status' OR EXISTS (SELECT 1 FROM main.statuses hs WHERE hs.id = ${status}
			AND ${homeFilterSql('hs', r, now)})))`
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
export type Audience = { followers: boolean; accounts: string[] }

export function audienceOf(visibility: Visibility, recipients: readonly Recipient[], extra: readonly string[] = []) {
	const accounts = new Set([...recipients.map((r) => r.accountId), ...extra])
	return { followers: !requiresMention(visibility), accounts: [...accounts] } satisfies Audience
}
