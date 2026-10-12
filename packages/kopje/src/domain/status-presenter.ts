import {
	type Account,
	ACCOUNT_COLUMNS,
	ACCOUNT_FROM,
	accountUrl,
	acctOf,
	type AccountRow,
	type Present,
	presentAccount,
} from './accounts'
import { apiVisibility, type ApiVisibility, type Visibility } from './audience'
import { htmlToPlainText } from './plain-text'
import type { Db } from '../db/sql'

// The Status entity as Mastodon 4.0.2's REST::StatusSerializer shows it. One presenter for every read path: it takes
// a list of ids and the viewer and reads the related rows kind by kind (statuses and reblogged originals, accounts,
// media, mentions, tags, viewer flags), each in one query over json_each, so the rows read grow with the page only.
// It never checks visibility: callers pass ids that went through the audience rule (domain/audience.ts).

export type MediaAttachment = {
	id: string
	type: string
	url: string
	preview_url: string
	remote_url: string | null
	preview_remote_url: null
	text_url: null
	meta: null
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
	filtered?: []
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

export type PresentOptions = Present & {
	viewerId: string | null
	// DELETE answers with the source text (`text`) in place of `content`, for redrafting: on the deleted status only,
	// never on a boost's original.
	source?: boolean
	// Present a boost without its original (reblog: null), for an original the viewer may no longer see.
	withoutReblog?: boolean
}

type MediaRow = { id: string; status_id: string; type: string; url: string; description: string }
type MentionRow = {
	status_id: string
	id: string
	username: string
	domain: string | null
	url: string | null
	uri: string
}

// Statuses in the order of `ids`; ids with no row are left out.
export function presentStatuses(db: Db, ids: readonly string[], options: PresentOptions): Status[] {
	if (ids.length === 0) {
		return []
	}
	const idList = JSON.stringify(ids)
	const rows = db.all<StatusRow>(
		`SELECT ${STATUS_COLUMNS} FROM ${STATUS_FROM}
		WHERE s.id IN (SELECT value FROM json_each(?1))
			OR s.id IN (SELECT reblog_of_id FROM statuses WHERE id IN (SELECT value FROM json_each(?1)) AND reblog_of_id IS NOT NULL)`,
		idList
	)
	const byId = new Map(rows.map((row) => [row.id, row]))
	const all = JSON.stringify([...byId.keys()])
	const accounts = new Map(
		db
			.all<AccountRow>(
				`SELECT ${ACCOUNT_COLUMNS} FROM ${ACCOUNT_FROM}
				WHERE a.id IN (SELECT DISTINCT account_id FROM statuses WHERE id IN (SELECT value FROM json_each(?1)))`,
				all
			)
			.map((row) => [row.id, presentAccount(row, options)])
	)
	const media = groupBy(
		db.all<MediaRow>(
			`SELECT id, status_id, type, url, description FROM media_attachments
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
	const flags = viewerFlags(db, options.viewerId, all)

	const present = (row: StatusRow, top: boolean): Status | undefined => {
		const account = accounts.get(row.account_id)
		if (account === undefined) {
			return undefined
		}
		let reblog: Status | null = null
		if (row.reblog_of_id !== null && !(top && options.withoutReblog === true)) {
			const original = byId.get(row.reblog_of_id)
			reblog = original === undefined ? null : (present(original, false) ?? null)
			if (reblog === null) {
				return undefined
			}
		}
		const visibility = apiVisibility(row.visibility)
		const viewer =
			options.viewerId === null
				? {}
				: {
						favourited: flags.favourited.has(row.id),
						reblogged: flags.reblogged.has(row.id),
						muted: false,
						bookmarked: flags.bookmarked.has(row.id),
						// Pins come later; an own, pinnable status says it is not pinned.
						...(row.account_id === options.viewerId && row.reblog_of_id === null && visibility !== 'direct'
							? { pinned: false }
							: {}),
						filtered: [] as [],
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
				url: accountUrl(m),
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

	return ids.flatMap((id) => {
		const row = byId.get(id)
		const status = row === undefined ? undefined : present(row, true)
		return status === undefined ? [] : [status]
	})
}

export function presentStatus(db: Db, id: string, options: PresentOptions): Status | null {
	return presentStatuses(db, [id], options)[0] ?? null
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

export function presentMedia(row: { id: string; type: string; url: string; description: string }): MediaAttachment {
	return {
		id: row.id,
		type: row.type,
		url: row.url,
		preview_url: row.url,
		remote_url: null,
		preview_remote_url: null,
		text_url: null,
		meta: null,
		description: row.description === '' ? null : row.description,
		blurhash: null,
	}
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
