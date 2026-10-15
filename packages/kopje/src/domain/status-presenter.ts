import { type Account, accountUrl, acctOf, type Present, presentAccountsById } from './accounts'
import {
	apiVisibility,
	type ApiVisibility,
	type OwnStatusId,
	type ViewerContext,
	type Visibility,
	type VisibleStatusId,
	visibleSql,
} from './audience'
import {
	type ActiveFilters,
	activeFilters,
	applyFilters,
	type FilterResult,
	filterStatusMatches,
	filterTextLimits,
	MAX_FILTER_TEXT,
} from './filters'
import { htmlToPlainText } from './plain-text'
import type { Db } from '../db/sql'
import { httpUrl } from '../platform/http-url'
import { remotePlainText } from '../security/html'

// The Status entity as Mastodon 4.0.2's REST::StatusSerializer shows it. One presenter for every read path: it takes
// a list of ids and the viewer and reads the related rows kind by kind (statuses and reblogged originals, accounts,
// media, mentions, tags, viewer flags), each in one query over json_each, so the rows read grow with the page only.
// It takes only ids the policy module (domain/audience.ts) made: VisibleStatusId, which a read rule passed for the
// viewer, or OwnStatusId, the viewer's own, for the response to their write. A boost's original is read through the
// read rule for the same viewer, whichever the boost's id: a boost the viewer may see stands only with an original
// they may see, and their own boost of an original they may no longer see is shown without it (reblog: null).
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
	card: null
	poll: null
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
	author_uri: string
	author_username: string
	author_domain: string | null
}

// in_reply_to_id and in_reply_to_account_id are shown as Mastodon shows them, even when the viewer may not see the
// parent: they belong to the reply, whose ActivityPub object carries inReplyTo to every recipient anyway, and its
// author chose to publish them. The parent itself (content, author profile, context entry) stays behind the audience
// rule. in_reply_to_account_id is the conversation partner carried through self-replies.
export const STATUS_COLUMNS = `s.id, s.uri, s.url, s.account_id, s.reblog_of_id, s.in_reply_to_id,
	s.in_reply_to_account_id, s.visibility, s.spoiler_text, s.content, s.source_text, s.sensitive,
	s.language, s.published_at, s.edited_at, s.replies_count, s.reblogs_count, s.favourites_count,
	au.uri AS author_uri, au.username AS author_username, au.domain AS author_domain`

export const STATUS_FROM = 'statuses s JOIN accounts au ON au.id = s.account_id'

// viewer: the viewer and the request time (null for none). filters: the viewer's active filters, when the caller read
// them once for several presentations; otherwise the presenter reads them.
export type PresentOptions = Present & { viewer: ViewerContext | null; filters?: ActiveFilters | null }

export type PresentOwnOptions = PresentOptions & {
	// DELETE answers with the source text (`text`) in place of `content`, for redrafting: on the deleted status only,
	// never on a boost's original.
	source?: boolean
}

// The columns presentMedia reads, for every query that presents media.
export const MEDIA_COLUMNS = 'id, type, url, preview_url, description, meta, focus_x, focus_y'

export type MediaRow = {
	id: string
	type: string
	url: string
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
	return present(db, ids, options, false).flatMap((status) => (status === undefined ? [] : [status]))
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
	const kept = (part: (Status | undefined)[]) => part.flatMap((status) => (status === undefined ? [] : [status]))
	return [kept(all.slice(0, first.length)), kept(all.slice(first.length))]
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
	const viewerId = options.viewer?.accountId ?? null
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
	const all = JSON.stringify([...byId.keys()])
	const accounts = presentAccountsById(
		db,
		rows.map((row) => row.account_id),
		options
	)
	const media = groupBy(
		db.all<MediaRow & { status_id: string }>(
			`SELECT ${MEDIA_COLUMNS}, status_id FROM media_attachments
			WHERE status_id IN (SELECT value FROM json_each(?1)) ORDER BY status_id, position, id`,
			all
		)
	)
	const mentions = groupBy(
		db.all<MentionRow>(
			`SELECT m.status_id, a.id, a.username, a.domain, a.url, a.uri
			FROM status_mentions m JOIN accounts a ON a.id = m.account_id
			WHERE m.status_id IN (SELECT value FROM json_each(?1)) AND m.silent = 0 ORDER BY m.status_id, a.id`,
			all
		)
	)
	const tags = groupBy(
		db.all<{ status_id: string; name: string }>(
			'SELECT status_id, name FROM status_tags WHERE status_id IN (SELECT value FROM json_each(?1)) ORDER BY status_id, name',
			all
		)
	)
	const flags = viewerFlags(db, viewerId, all)
	const filters =
		options.filters !== undefined ? options.filters : options.viewer === null ? null : activeFilters(db, options.viewer)
	const statusMatches =
		filters === null ? new Map<string, Set<string>>() : filterStatusMatches(db, filters, [...byId.keys()])
	// Status#searchable_text of a status: its spoiler text, its text (a local status's source, a remote one's HTML as
	// text) and its media descriptions. Kopje has no polls.
	const searchableText = (row: StatusRow): string =>
		[
			row.spoiler_text,
			row.author_domain === null ? (row.source_text ?? htmlToPlainText(row.content)) : remotePlainText(row.content),
			(media.get(row.id) ?? []).map((m) => m.description).join('\n\n'),
		].join('\n\n')
	// The text each status is matched on (filterTextLimits): read only when a filter has keywords.
	const texts = new Map<string, { text: string; cut: number }>()
	if (filters !== null && filters.filters.some((filter) => filter.keywords !== null)) {
		const full = ids.map((id) => {
			const row = byId.get(id)
			const proper = row?.reblog_of_id == null ? row : byId.get(row.reblog_of_id)
			return proper === undefined ? '' : searchableText(proper)
		})
		const limits = filterTextLimits(full.map((text) => Math.min(text.length, MAX_FILTER_TEXT)))
		ids.forEach((id, i) => {
			const text = full[i] ?? ''
			const cut = limits[i] ?? 0
			// The code point after a cut is kept for the boundary after a match, so the cut is not taken for one.
			const next = cut < text.length ? String.fromCodePoint(text.codePointAt(cut) ?? 0) : ''
			texts.set(id, { text: text.slice(0, cut) + next, cut })
		})
	}

	const presentRow = (row: StatusRow, top: boolean, filtered: FilterResult[] = []): Status | undefined => {
		const account = accounts.get(row.account_id)
		if (account === undefined) {
			return undefined
		}
		let reblog: Status | null = null
		if (top && filters !== null) {
			const proper = row.reblog_of_id === null ? row : byId.get(row.reblog_of_id)
			if (proper !== undefined) {
				filtered = applyFilters(filters, statusMatches, {
					...(texts.get(row.id) ?? { text: '', cut: 0 }),
					ids: row.reblog_of_id === null ? [row.id] : [row.id, row.reblog_of_id],
				})
			}
		}
		if (row.reblog_of_id !== null) {
			const original = byId.get(row.reblog_of_id)
			if (original !== undefined) {
				reblog = presentRow(original, false, filtered) ?? null
				if (reblog === null) {
					return undefined
				}
			} else if (!(top && own)) {
				return undefined
			}
		}
		const visibility = apiVisibility(row.visibility)
		const viewer =
			viewerId === null
				? {}
				: {
						favourited: flags.favourited.has(row.id),
						reblogged: flags.reblogged.has(row.id),
						muted: false,
						bookmarked: flags.bookmarked.has(row.id),
						// Pins come later; an own, pinnable status says it is not pinned.
						...(row.account_id === viewerId && row.reblog_of_id === null && visibility !== 'direct'
							? { pinned: false }
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
			card: null,
			poll: null,
		}
	}

	return ids.map((id) => {
		const row = byId.get(id)
		return row === undefined ? undefined : presentRow(row, true)
	})
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

function viewerFlags(
	db: Db,
	viewerId: string | null,
	ids: string
): { favourited: Set<string>; reblogged: Set<string>; bookmarked: Set<string> } {
	if (viewerId === null) {
		return { favourited: new Set(), reblogged: new Set(), bookmarked: new Set() }
	}
	const rows = db.all<{ kind: string; status_id: string }>(
		`SELECT 'f' AS kind, status_id FROM favourites WHERE account_id = ?1 AND status_id IN (SELECT value FROM json_each(?2))
		UNION ALL
		SELECT 'r', reblog_of_id FROM statuses WHERE account_id = ?1 AND reblog_of_id IN (SELECT value FROM json_each(?2))
		UNION ALL
		SELECT 'b', status_id FROM bookmarks WHERE account_id = ?1 AND status_id IN (SELECT value FROM json_each(?2))`,
		viewerId,
		ids
	)
	const of = (kind: string) => new Set(rows.filter((row) => row.kind === kind).map((row) => row.status_id))
	return { favourited: of('f'), reblogged: of('r'), bookmarked: of('b') }
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
