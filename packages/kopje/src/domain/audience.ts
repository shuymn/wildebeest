import type { Db } from '../db/sql'

// Audience and visibility (design §4 "audience and visibility", Mastodon 4.7.3). One module decides who may see a
// status, for every read path, and how an audience is written to and read from ActivityPub addressing:
//
//   - visibleSql / listableSql / canView: the read rule (Mastodon's StatusPolicy#show? and StatusFilter). It exists
//     only as SQL, so feeds filter before LIMIT and no read path keeps a second copy of the rule in TypeScript.
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
// The read rule, as SQL fragments. `s` is the alias of a statuses row and `viewer` an SQL expression for the viewer's
// account id (NULL for an anonymous viewer), normally a numbered parameter such as '?1'.
// ---------------------------------------------------------------------------------------------------------------

// StatusPolicy#show?: whether `viewer` may see the row itself.
//   - a suspended author's statuses are seen by nobody;
//   - the author sees everything of their own;
//   - an author who blocks the viewer hides everything from them;
//   - public and unlisted are seen by everyone else;
//   - private is seen by accepted followers and the mentioned (silent included);
//   - direct and limited are seen by the mentioned (silent included) only.
export function visibleSql(s: string, viewer: string): string {
	return `(NOT EXISTS (SELECT 1 FROM local_accounts sus WHERE sus.account_id = ${s}.account_id AND sus.suspended_at IS NOT NULL)
		AND (${s}.account_id IS ${viewer}
			OR (NOT EXISTS (SELECT 1 FROM blocks ab WHERE ab.account_id = ${s}.account_id AND ab.target_account_id IS ${viewer})
				AND (${s}.visibility IN ('public', 'unlisted')
					OR (${s}.visibility = 'private' AND EXISTS (SELECT 1 FROM follows fo
						WHERE fo.account_id IS ${viewer} AND fo.target_account_id = ${s}.account_id AND fo.state = 'accepted'))
					OR EXISTS (SELECT 1 FROM status_mentions sm WHERE sm.status_id = ${s}.id AND sm.account_id IS ${viewer})))))`
}

// The host of an actor id (scheme and path dropped), lowercased.
function uriHostSql(uri: string): string {
	return `lower(substr(${uri}, instr(${uri}, '://') + 3, instr(substr(${uri}, instr(${uri}, '://') + 3) || '/', '/') - 1))`
}

// Whether the domain block row `d` matches the remote account `a`: by its stored domain (a WebFinger domain the
// resolver confirmed, or its host) or by the host of its actor id, so a confirmed domain elsewhere never lets an
// account escape a block of the server it lives on.
export function domainBlockMatchSql(d: string, a: string): string {
	return `(${a}.domain IS NOT NULL AND ${d}.domain IN (${a}.domain, ${uriHostSql(`${a}.uri`)}))`
}

// StatusFilter: what the viewer chose not to see in lists (feeds, context, notifications, bookmarks): authors they
// block, mute, or whose domain they block. Their own statuses always pass; an anonymous viewer filters nothing.
export function unfilteredSql(s: string, viewer: string): string {
	return `(${viewer} IS NULL OR ${s}.account_id IS ${viewer} OR NOT (
		EXISTS (SELECT 1 FROM blocks vb WHERE vb.account_id IS ${viewer} AND vb.target_account_id = ${s}.account_id)
		OR EXISTS (SELECT 1 FROM mutes vm WHERE vm.account_id IS ${viewer} AND vm.target_account_id = ${s}.account_id)
		OR EXISTS (SELECT 1 FROM domain_blocks vd JOIN accounts va ON va.id = ${s}.account_id
			WHERE vd.account_id IS ${viewer} AND ${domainBlockMatchSql('vd', 'va')})))`
}

// A status may be shown by itself (GET /statuses/:id): the row is visible and, for a reblog, so is the original.
export function viewableSql(s: string, viewer: string): string {
	return `(${visibleSql(s, viewer)} AND (${s}.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM statuses ${s}_o
		WHERE ${s}_o.id = ${s}.reblog_of_id AND ${visibleSql(`${s}_o`, viewer)})))`
}

// A status may be listed: viewable, and neither it nor a reblogged original is filtered by the viewer.
export function listableSql(s: string, viewer: string): string {
	return `(${visibleSql(s, viewer)} AND ${unfilteredSql(s, viewer)}
		AND (${s}.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM statuses ${s}_o WHERE ${s}_o.id = ${s}.reblog_of_id
			AND ${visibleSql(`${s}_o`, viewer)} AND ${unfilteredSql(`${s}_o`, viewer)})))`
}

// The rule for one status: whether `viewerId` (null: anonymous) may see it by itself.
export function canView(db: Db, viewerId: string | null, statusId: string): boolean {
	return (
		db.first(`SELECT 1 AS ok FROM statuses s WHERE s.id = ?2 AND ${viewableSql('s', '?1')}`, viewerId, statusId) !==
		undefined
	)
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
