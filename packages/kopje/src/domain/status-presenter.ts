import { type Account, accountUrl, acctOf, type Present, presentAccountsById } from './accounts'
import {
	type ApiQuoteState,
	apiVisibility,
	type ApiVisibility,
	conversationMutedSql,
	type OwnStatusId,
	type QuotePolicyFlag,
	quoteApprovalReads,
	quotePolicyFlags,
	quoteReads,
	requiresMention,
	type ViewerContext,
	type Visibility,
	type VisibleStatusId,
	visibleSql,
} from './audience'
import {
	activeFilters,
	applyFilters,
	type FilterResult,
	filterStatusMatches,
	filterTextLimits,
	MAX_FILTER_TEXT,
} from './filters'
import { htmlToPlainText } from './plain-text'
import { type Poll, presentPolls } from './polls'
import { actorUriSql, profileUrlSql, usernameSql } from './profile-bounds'
import {
	contentSql,
	MAX_STATUS_MEDIA,
	MAX_STATUS_MENTION_ROWS,
	MAX_PRESENTED_TAGS,
	mediaDescriptionSql,
	mediaMetaSql,
	mediaUrlSql,
	sourceTextSql,
	spoilerSql,
	statusUriSql,
	statusUrlSql,
	tagNameSql,
} from './status-bounds'
import type { Db } from '../db/sql'
import { httpUrl } from '../platform/http-url'
import { remotePlainText } from '../security/html'

// The Status entity as Mastodon 4.0.2's REST::StatusSerializer shows it. One presenter for every read path: it takes
// a list of ids and the viewer and reads the related rows kind by kind (statuses and reblogged originals, accounts,
// media, mentions, tags, viewer flags, polls), each in one query over json_each, so the rows read grow with the page
// only.
// It takes only ids the policy module (domain/audience.ts) made: VisibleStatusId, which a read rule passed for the
// viewer, or OwnStatusId, the viewer's own, for the response to their write. A boost's original is read through the
// read rule for the same viewer, whichever the boost's id: a boost the viewer may see stands only with an original
// they may see, and their own boost of an original they may no longer see is shown without it (reblog: null).
// A quote (R35, quoteReads in audience.ts) is shown one level deep, as Mastodon's REST::StatusSerializer and
// ShallowStatusSerializer: a status's `quote` embeds the quoted status, when the viewer is shown it, as a full status
// for the same viewer (its flags, filters, media and poll), whose own `quote` is a ShallowQuote (the state and the id
// of the status it quotes). The quotes are read twice, for the statuses and their originals, then for the quoted
// statuses, each one query over json_each, never along a chain. A boost shows its original's quote in its `reblog`.
// For a signed-in viewer every status carries `filtered` (REST::StatusSerializer, StatusRelationshipsPresenter): the
// viewer's active filters that match it, whatever their context and action, as CustomFilter.apply_cached_filters finds
// them (filters.ts); a boost and its original carry the same. Nothing is left out for a filter: the client decides by
// context.

export type MediaSize = { width: number; height: number; size: string; aspect: number }

export type MediaMeta = { original?: MediaSize; small?: MediaSize; focus?: { x: number; y: number } }

export type MediaAttachment = {
	id: string
	type: string
	url: string | null
	preview_url: string | null
	remote_url: string | null
	preview_remote_url: null
	text_url: null
	meta: MediaMeta | null
	description: string | null
	blurhash: null
}

export type Mention = { id: string; username: string; url: string; acct: string }

export type Tag = { name: string; url: string }

// Mastodon's Quote, with the quoted status embedded, and ShallowQuote, with its id.
export type Quote = { state: ApiQuoteState; quoted_status: Status | null }

export type ShallowQuote = { state: ApiQuoteState; quoted_status_id: string | null }

// Mastodon's QuoteApproval (REST::StatusSerializer#quote_approval): the flags of the status's automatic and manual
// policy, and what the policy answers the viewer. Ice Cubes decodes all three fields, and current_user only as one of
// these four values, or drops the whole status.
export type QuoteApproval = {
	automatic: QuotePolicyFlag[]
	manual: QuotePolicyFlag[]
	current_user: 'automatic' | 'manual' | 'unknown' | 'denied'
}

export type Status = {
	id: string
	created_at: string
	in_reply_to_id: string | null
	in_reply_to_account_id: string | null
	sensitive: boolean
	spoiler_text: string
	visibility: ApiVisibility
	language: string | null
	uri: string
	url: string | null
	replies_count: number
	reblogs_count: number
	favourites_count: number
	quotes_count: number
	edited_at: string | null
	favourited?: boolean
	reblogged?: boolean
	muted?: boolean
	bookmarked?: boolean
	pinned?: boolean
	filtered?: FilterResult[]
	content?: string
	text?: string
	reblog: Status | null
	account: Account
	media_attachments: MediaAttachment[]
	mentions: Mention[]
	tags: Tag[]
	emojis: []
	quote: Quote | ShallowQuote | null
	quote_approval: QuoteApproval
	card: null
	poll: Poll | null
}

export type StatusRow = {
	id: string
	uri: string
	url: string | null
	account_id: string
	reblog_of_id: string | null
	in_reply_to_id: string | null
	in_reply_to_account_id: string | null
	visibility: Visibility
	spoiler_text: string
	content: string
	source_text: string | null
	sensitive: number
	language: string | null
	published_at: string
	edited_at: string | null
	replies_count: number
	reblogs_count: number
	favourites_count: number
	quotes_count: number
	quote_policy: number
	author_uri: string
	author_username: string
	author_domain: string | null
}

// in_reply_to_id and in_reply_to_account_id are shown as Mastodon shows them, even when the viewer may not see the
// parent: they belong to the reply, whose ActivityPub object carries inReplyTo to every recipient anyway, and its
// author chose to publish them. The parent itself (content, author profile, context entry) stays behind the audience
// rule. in_reply_to_account_id is the conversation partner carried through self-replies.
// The text and URLs are bounded (status-bounds.ts, RES-2).
export const STATUS_COLUMNS = `s.id, ${statusUriSql('s.uri')} AS uri, ${statusUrlSql('s.url')} AS url, s.account_id,
	s.reblog_of_id, s.in_reply_to_id, s.in_reply_to_account_id, s.visibility, ${spoilerSql('s.spoiler_text')} AS spoiler_text,
	${contentSql('s.content')} AS content, ${sourceTextSql('s.source_text')} AS source_text, s.sensitive,
	s.language, s.published_at, s.edited_at, s.replies_count, s.reblogs_count, s.favourites_count, s.quotes_count,
	s.quote_policy, ${actorUriSql('au.uri')} AS author_uri, ${usernameSql('au.username')} AS author_username,
	au.domain AS author_domain`

export const STATUS_FROM = 'statuses s JOIN accounts au ON au.id = s.account_id'

// viewer: the viewer (accountId null: anonymous) and the request time, which a poll's expiry is judged at.
export type PresentOptions = Present & { viewer: ViewerContext }

export type PresentOwnOptions = PresentOptions & {
	// DELETE answers with the source text (`text`) in place of `content`, for redrafting, and with the quoted status of
	// a quote in any state when the viewer may see it (quoteReads): on the deleted status only, never on a boost's
	// original.
	source?: boolean
}

// The columns presentMedia reads, bounded (status-bounds.ts), for every query that presents media.
export const MEDIA_COLUMNS = `id, type, ${mediaUrlSql('url')} AS url, ${mediaUrlSql('preview_url')} AS preview_url,
	${mediaDescriptionSql('description')} AS description, ${mediaMetaSql('meta')} AS meta, focus_x, focus_y`

export type MediaRow = {
	id: string
	type: string
	url: string | null
	preview_url: string | null
	description: string
	meta: string | null
	focus_x: number
	focus_y: number
}
type MentionRow = {
	status_id: string
	id: string
	username: string
	domain: string | null
	url: string | null
	uri: string
}

// Statuses the read rule passed for the viewer, in the order of `ids`; ids with no row, and boosts whose original the
// viewer may not see, are left out.
export function presentStatuses(db: Db, ids: readonly VisibleStatusId[], options: PresentOptions): Status[] {
	return presented(present(db, ids, options, false))
}

// Two lists of statuses presented as one response (a thread's ancestors and descendants), so their filters' text
// budget is shared by both; each list as presentStatuses would give it.
export function presentStatusPair(
	db: Db,
	first: readonly VisibleStatusId[],
	second: readonly VisibleStatusId[],
	options: PresentOptions
): [Status[], Status[]] {
	const all = present(db, [...first, ...second], options, false)
	return [presented(all.slice(0, first.length)), presented(all.slice(first.length))]
}

function presented(statuses: readonly (Status | undefined)[]): Status[] {
	return statuses.flatMap((status) => (status === undefined ? [] : [status]))
}

export function presentStatus(db: Db, id: VisibleStatusId, options: PresentOptions): Status | null {
	return presentStatuses(db, [id], options)[0] ?? null
}

// The viewer's own status, for the response to their write; a boost of an original they may not see has reblog: null.
export function presentOwnStatus(db: Db, id: OwnStatusId, options: PresentOwnOptions): Status | null {
	return present(db, [id], options, true)[0] ?? null
}

// The statuses in the order of `ids`, undefined for an id with no row or a boost left out.
function present(db: Db, ids: readonly string[], options: PresentOwnOptions, own: boolean): (Status | undefined)[] {
	if (ids.length === 0) {
		return []
	}
	const idList = JSON.stringify(ids)
	const viewerId = options.viewer.accountId
	// The statuses, and the originals of the boosts among them that the viewer may see.
	const rows = db.all<StatusRow>(
		`SELECT ${STATUS_COLUMNS} FROM ${STATUS_FROM}
		WHERE s.id IN (SELECT value FROM json_each(?1))
			OR (s.id IN (SELECT reblog_of_id FROM statuses WHERE id IN (SELECT value FROM json_each(?1)) AND reblog_of_id IS NOT NULL)
				AND ${visibleSql('s', '?2')})`,
		idList,
		viewerId
	)
	const byId = new Map(rows.map((row) => [row.id, row]))
	// The quotes of the statuses and originals (R35), then the quoted statuses the viewer is shown and their own quotes.
	const reads = quoteReads(options.viewer)
	const quotes = new Map(
		reads.of(db, [...byId.keys()], options.source === true ? ids : []).map((quote) => [quote.status_id, quote])
	)
	const quoted = [...new Set([...quotes.values()].flatMap((quote) => quote.quoted_status_id ?? []))]
	const unread = quoted.filter((id) => !byId.has(id))
	if (unread.length > 0) {
		for (const row of db.all<StatusRow>(
			`SELECT ${STATUS_COLUMNS} FROM ${STATUS_FROM} WHERE s.id IN (SELECT value FROM json_each(?1))`,
			JSON.stringify(unread)
		)) {
			byId.set(row.id, row)
		}
		for (const quote of reads.of(db, unread)) {
			quotes.set(quote.status_id, quote)
		}
	}
	const all = JSON.stringify([...byId.keys()])
	// The statuses matched by filters: each status of the response, and each quoted status shown in it.
	const targets = [
		...ids.map((id) => ({ key: id, row: byId.get(id) })),
		...quoted.map((id) => ({ key: quotedKey(id), row: byId.get(id) })),
	]
	const accounts = presentAccountsById(
		db,
		[...byId.values()].map((row) => row.account_id),
		options
	)
	// At most MAX_STATUS_MEDIA attachments, MAX_STATUS_MENTION_ROWS mentions and MAX_PRESENTED_TAGS hashtags of each
	// status, cut in SQL (a converted row may hold more), each read through its index.
	const media = groupBy(
		db.all<MediaRow & { status_id: string }>(
			`SELECT ${MEDIA_COLUMNS}, status_id FROM media_attachments
			WHERE id IN (SELECT x.id FROM json_each(?1) j CROSS JOIN media_attachments x ON x.id IN (SELECT y.id
				FROM media_attachments y WHERE y.status_id = j.value AND y.shown = 1 ORDER BY y.position, y.id
				LIMIT ${MAX_STATUS_MEDIA}))
			ORDER BY status_id, position, id`,
			all
		)
	)
	const mentions = groupBy(
		db.all<MentionRow>(
			`SELECT j.value AS status_id, a.id, ${usernameSql('a.username')} AS username, a.domain,
				${profileUrlSql('a.url')} AS url, ${actorUriSql('a.uri')} AS uri
			FROM json_each(?1) j CROSS JOIN accounts a
			WHERE a.id IN (SELECT m.account_id FROM status_mentions m WHERE m.status_id = j.value AND m.silent = 0
				ORDER BY m.account_id LIMIT ${MAX_STATUS_MENTION_ROWS})
			ORDER BY j.value, a.id`,
			all
		)
	)
	const tags = groupBy(
		db.all<{ status_id: string; name: string }>(
			`SELECT j.value AS status_id, ${tagNameSql('t.name')} AS name FROM json_each(?1) j CROSS JOIN status_tags t
			WHERE t.status_id = j.value AND t.name IN (SELECT ${tagNameSql('n.name')} FROM status_tags n
				WHERE n.status_id = j.value AND ${tagNameSql('n.name')} IS NOT NULL ORDER BY n.name LIMIT ${MAX_PRESENTED_TAGS})
			ORDER BY j.value, t.name`,
			all
		)
	)
	const flags = viewerFlags(db, viewerId, all)
	// R36 for the viewer, of every status presented by its own row (a boost answers denied: its original's is shown).
	const approvals = quoteApprovalReads(options.viewer).of(db, [...byId.keys()])
	const polls = presentPolls(db, [...byId.keys()], viewerId, options.viewer.now)
	const filters = activeFilters(db, options.viewer)
	const statusMatches =
		filters === null ? new Map<string, Set<string>>() : filterStatusMatches(db, filters, [...byId.keys()])
	// Status#searchable_text of a status: its spoiler text, its text (a local status's source, a remote one's HTML as
	// text), its poll's choices and its media descriptions (SearchConcern).
	// A status without a poll has no entry for it (compact), not an empty one.
	const searchableText = (row: StatusRow): string => {
		const poll = polls.get(row.id)
		return [
			row.spoiler_text,
			row.author_domain === null ? (row.source_text ?? htmlToPlainText(row.content)) : remotePlainText(row.content),
			...(poll === undefined ? [] : [poll.options.map((option) => option.title).join('\n\n')]),
			(media.get(row.id) ?? []).map((m) => m.description).join('\n\n'),
		].join('\n\n')
	}
	// The text each status is matched on (filterTextLimits): read only when a filter has keywords.
	const texts = new Map<string, { text: string; cut: number }>()
	if (filters !== null && filters.filters.some((filter) => filter.keywords !== null)) {
		const full = targets.map(({ row }) => {
			const proper = row?.reblog_of_id == null ? row : byId.get(row.reblog_of_id)
			return proper === undefined ? '' : searchableText(proper)
		})
		const limits = filterTextLimits(full.map((text) => Math.min(text.length, MAX_FILTER_TEXT)))
		targets.forEach(({ key }, i) => {
			const text = full[i] ?? ''
			// A cut inside a surrogate pair moves back to the pair's start, so the code point after it is whole.
			const limit = limits[i] ?? 0
			const unit = text.charCodeAt(limit)
			const cut = limit > 0 && limit < text.length && unit >= 0xdc00 && unit <= 0xdfff ? limit - 1 : limit
			// The code point after a cut is kept for the boundary after a match, so the cut is not taken for one.
			const next = cut < text.length ? String.fromCodePoint(text.codePointAt(cut) ?? 0) : ''
			texts.set(key, { text: text.slice(0, cut) + next, cut })
		})
	}

	const presentRow = (
		row: StatusRow,
		kind: 'top' | 'reblog' | 'quoted',
		filtered: FilterResult[] = []
	): Status | undefined => {
		const account = accounts.get(row.account_id)
		if (account === undefined) {
			return undefined
		}
		const top = kind === 'top'
		let reblog: Status | null = null
		if (kind !== 'reblog' && filters !== null) {
			const proper = row.reblog_of_id === null ? row : byId.get(row.reblog_of_id)
			if (proper !== undefined) {
				filtered = applyFilters(filters, statusMatches, {
					...(texts.get(top ? row.id : quotedKey(row.id)) ?? { text: '', cut: 0 }),
					ids: row.reblog_of_id === null ? [row.id] : [row.id, row.reblog_of_id],
				})
			}
		}
		if (row.reblog_of_id !== null) {
			const original = kind === 'quoted' ? undefined : byId.get(row.reblog_of_id)
			if (original !== undefined) {
				reblog = presentRow(original, 'reblog', filtered) ?? null
				if (reblog === null) {
					return undefined
				}
			} else if (!(top && own)) {
				return undefined
			}
		}
		const read = quotes.get(row.id)
		let quote: Quote | ShallowQuote | null = null
		if (read !== undefined) {
			if (kind === 'quoted') {
				quote = { state: read.state, quoted_status_id: read.quoted_status_id }
			} else {
				const target = read.quoted_status_id === null ? undefined : byId.get(read.quoted_status_id)
				quote = {
					state: read.state,
					quoted_status: target === undefined ? null : (presentQuoted(target) ?? null),
				}
			}
		}
		// A boost shows its original's policy (Status#proper); a boost whose original the viewer may not see shows its
		// own row's, which is always 0, and denied.
		const proper = (row.reblog_of_id === null ? row : byId.get(row.reblog_of_id)) ?? row
		const policy = proper.quote_policy
		const visibility = apiVisibility(row.visibility)
		const viewer =
			viewerId === null
				? {}
				: {
						favourited: flags.favourited.has(row.id),
						reblogged: flags.reblogged.has(row.id),
						muted: flags.muted.has(row.id),
						bookmarked: flags.bookmarked.has(row.id),
						// Only on an own status that may be pinned (REST::StatusSerializer#pinnable?: not a boost, and
						// public, unlisted or private).
						...(row.account_id === viewerId && row.reblog_of_id === null && !requiresMention(row.visibility)
							? { pinned: flags.pinned.has(row.id) }
							: {}),
						filtered,
					}
		const body =
			top && options.source === true
				? { text: row.source_text ?? htmlToPlainText(row.content) }
				: { content: row.content }
		return {
			id: row.id,
			created_at: row.published_at,
			in_reply_to_id: row.in_reply_to_id,
			in_reply_to_account_id: row.in_reply_to_account_id,
			sensitive: row.sensitive === 1,
			spoiler_text: row.spoiler_text,
			visibility,
			language: row.language,
			uri: row.uri,
			url: statusUrl(row),
			replies_count: row.replies_count,
			reblogs_count: row.reblogs_count,
			favourites_count: row.favourites_count,
			quotes_count: row.quotes_count,
			edited_at: row.edited_at,
			...viewer,
			...body,
			reblog,
			account,
			media_attachments: (media.get(row.id) ?? []).map(presentMedia),
			mentions: (mentions.get(row.id) ?? []).map((m) => ({
				id: m.id,
				username: m.username,
				url: accountUrl(m, options.origin),
				acct: acctOf(m),
			})),
			tags: (tags.get(row.id) ?? []).map((t) => ({
				name: t.name,
				url: `${options.origin}/tags/${encodeURIComponent(t.name)}`,
			})),
			emojis: [],
			quote,
			quote_approval: {
				automatic: quotePolicyFlags(policy, 'automatic'),
				manual: quotePolicyFlags(policy, 'manual'),
				current_user: approvals.get(proper.id) ?? 'denied',
			},
			card: null,
			poll: polls.get(row.id) ?? null,
		}
	}
	// A quoted status is presented once however many statuses of the response quote it: its presentation depends on its
	// row, the viewer and its own matched text (quotedKey) alone.
	const embedded = new Map<string, Status | undefined>()
	const presentQuoted = (row: StatusRow): Status | undefined => {
		if (!embedded.has(row.id)) {
			embedded.set(row.id, presentRow(row, 'quoted'))
		}
		return embedded.get(row.id)
	}

	return ids.map((id) => {
		const row = byId.get(id)
		return row === undefined ? undefined : presentRow(row, 'top')
	})
}

// The key of a quoted status's matched text, apart from the same status's as a status of the response.
function quotedKey(id: string): string {
	return `quoted:${id}`
}

// A local status's web page is /@user/<id>; a local boost has none of its own and shows its Announce id. A remote
// status keeps the url it came with, or its uri.
function statusUrl(row: StatusRow): string {
	if (row.author_domain !== null) {
		return row.url ?? row.uri
	}
	if (row.reblog_of_id !== null) {
		return row.uri
	}
	return `${new URL(row.author_uri).origin}/@${row.author_username}/${row.id}`
}

// MediaAttachment as REST::MediaAttachmentSerializer shows it. URLs are emitted only when they are http(s) (HTML-3);
// meta carries the stored dimensions (Mastodon's original and small) and the focal point.
export function presentMedia(row: MediaRow): MediaAttachment {
	const url = httpUrl(row.url)?.href ?? null
	const stored = row.meta === null ? {} : (JSON.parse(row.meta) as { original?: Size; small?: Size })
	const meta: MediaMeta = {
		...(stored.original === undefined ? {} : { original: mediaSize(stored.original) }),
		...(stored.small === undefined ? {} : { small: mediaSize(stored.small) }),
		...(row.meta === null ? {} : { focus: { x: row.focus_x, y: row.focus_y } }),
	}
	return {
		id: row.id,
		type: row.type,
		url,
		preview_url: httpUrl(row.preview_url)?.href ?? url,
		remote_url: null,
		preview_remote_url: null,
		text_url: null,
		meta: Object.keys(meta).length === 0 ? null : meta,
		description: row.description === '' ? null : row.description,
		blurhash: null,
	}
}

type Size = { width: number; height: number }

function mediaSize({ width, height }: Size): MediaSize {
	return { width, height, size: `${width}x${height}`, aspect: width / height }
}

type ViewerFlags = Record<'favourited' | 'reblogged' | 'bookmarked' | 'pinned' | 'muted', Set<string>>

// The viewer's own flags of the statuses: favourited, boosted, bookmarked, pinned, and in a conversation they mute
// (each status's own thread, a boost's too, as Mastodon's muted reads the status's conversation).
function viewerFlags(db: Db, viewerId: string | null, ids: string): ViewerFlags {
	if (viewerId === null) {
		return { favourited: new Set(), reblogged: new Set(), bookmarked: new Set(), pinned: new Set(), muted: new Set() }
	}
	const rows = db.all<{ kind: string; status_id: string }>(
		`SELECT 'f' AS kind, status_id FROM favourites WHERE account_id = ?1 AND status_id IN (SELECT value FROM json_each(?2))
		UNION ALL
		SELECT 'r', reblog_of_id FROM statuses WHERE account_id = ?1 AND reblog_of_id IN (SELECT value FROM json_each(?2))
		UNION ALL
		SELECT 'b', status_id FROM bookmarks WHERE account_id = ?1 AND status_id IN (SELECT value FROM json_each(?2))
		UNION ALL
		SELECT 'p', value FROM json_each(?2)
		WHERE EXISTS (SELECT 1 FROM status_pins WHERE account_id = ?1 AND status_id = value)
		UNION ALL
		SELECT 'm', ms.id FROM statuses ms
		WHERE ms.id IN (SELECT value FROM json_each(?2)) AND ${conversationMutedSql('?1', 'ms.thread')}`,
		viewerId,
		ids
	)
	const of = (kind: string) => new Set(rows.filter((row) => row.kind === kind).map((row) => row.status_id))
	return { favourited: of('f'), reblogged: of('r'), bookmarked: of('b'), pinned: of('p'), muted: of('m') }
}

function groupBy<T extends { status_id: string }>(rows: T[]): Map<string, T[]> {
	const groups = new Map<string, T[]>()
	for (const row of rows) {
		const list = groups.get(row.status_id)
		if (list === undefined) {
			groups.set(row.status_id, [row])
		} else {
			list.push(row)
		}
	}
	return groups
}
