import {
	type Account,
	ACCOUNT_COLUMNS,
	type AccountRow,
	accountUrl,
	type Page,
	type PageQuery,
	type Present,
	presentAccount,
} from './accounts'
import {
	announceActivity,
	type AnnounceInput,
	createActivity,
	deleteActivity,
	likeActivity,
	recordOutbound,
	statusFacts,
	undoAnnounceActivity,
	undoLikeActivity,
	updateActivity,
} from './activities'
import { type ApiVisibility, canView, listableSql, requiresMention, type Visibility } from './audience'
import { optionalUserReadOperation, userWriteOperation } from './auth'
import { allocateLocalId } from './ids'
import { notify } from './notifications'
import { normalizeSearchText } from './search-text'
import { type MediaAttachment, presentMedia, presentStatus, presentStatuses, type Status } from './status-presenter'
import { exceedsRawLength, mentionKey, type MentionRef, parseStatusText, renderStatusHtml } from './status-text'
import type { Db } from '../db/sql'

// Statuses (B4a): posting, editing and deleting local statuses, the per-status reads, and favourite, reblog and
// bookmark. Every read goes through the audience rule (audience.ts); every write recomputes the counters it changes
// from the rows, writes its notifications, and records its outbound intent (activities.ts), all in its transaction.

export type Viewed<T> = { status: 'ok'; value: T } | { status: 'not_found' }

export type Acted<T> = Viewed<T> | { status: 'forbidden' } | { status: 'invalid'; error: string }

const MAX_ID_LENGTH = 64

// The Worker checks the counted length; the Store re-checks the raw bound so no caller can make it parse more.
const TOO_LONG = 'Validation failed: Text character limit of 500 exceeded'

// Resolves an API id or a legacy id (statuses.legacy_id) to the API id.
export function resolveStatusId(db: Db, id: string): string | null {
	if (id === '' || id.length > MAX_ID_LENGTH) {
		return null
	}
	const row =
		db.first<{ id: string }>('SELECT id FROM statuses WHERE id = ?', id) ??
		db.first<{ id: string }>('SELECT id FROM statuses WHERE legacy_id = ?', id)
	return row?.id ?? null
}

type Author = {
	id: string
	uri: string
	username: string
	default_visibility: ApiVisibility
	default_sensitive: number
	default_language: string | null
}

function localAuthor(db: Db, accountId: string): Author {
	const author = db.first<Author>(
		`SELECT a.id, a.uri, a.username, l.default_visibility, l.default_sensitive, l.default_language
		FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?`,
		accountId
	)
	if (author === undefined) {
		throw new Error('authorized viewer has no local account')
	}
	return author
}

type ResolvedMention = { id: string; uri: string; url: string | null; username: string; domain: string | null }

// Mentions are resolved against accounts already known; nothing is fetched. A mention of the instance's own host is a
// local mention. Suspended local accounts are not mentioned (their mention stays text).
function resolveMentions(db: Db, refs: readonly MentionRef[], localHost: string): Map<string, ResolvedMention> {
	if (refs.length === 0) {
		return new Map()
	}
	const wanted = refs.map((ref) => ({
		key: mentionKey(ref),
		u: ref.username.toLowerCase(),
		d: ref.domain === null || ref.domain === localHost ? null : ref.domain,
	}))
	const rows = db.all<ResolvedMention & { key: string }>(
		`SELECT json_extract(j.value, '$.key') AS key, a.id, a.uri, a.url, a.username, a.domain
		FROM json_each(?1) j
		JOIN accounts a ON a.domain IS json_extract(j.value, '$.d') AND lower(a.username) = json_extract(j.value, '$.u')
		LEFT JOIN local_accounts l ON l.account_id = a.id
		WHERE l.suspended_at IS NULL`,
		JSON.stringify(wanted)
	)
	return new Map(rows.map(({ key, ...row }) => [key, row]))
}

type Composed = {
	content: string
	source: string
	mentions: ResolvedMention[]
	tags: string[]
}

function compose(db: Db, text: string, author: Author, origin: string): Composed {
	const parsed = parseStatusText(text)
	const localHost = new URL(author.uri).host
	const resolved = resolveMentions(db, parsed.mentions, localHost)
	const content = renderStatusHtml(parsed.segments, {
		mention: (ref) => {
			const account = resolved.get(mentionKey(ref))
			return account === undefined ? undefined : { url: accountUrl(account), username: account.username }
		},
		tagUrl: (name) => `${origin}/tags/${encodeURIComponent(name)}`,
	})
	const unique = new Map([...resolved.values()].map((account) => [account.id, account]))
	return { content, source: text, mentions: [...unique.values()], tags: parsed.tags }
}

// Own media that is not attached yet (or already attached to `statusId`), in the order given.
function attachableMedia(db: Db, accountId: string, mediaIds: readonly string[], statusId: string | null): string[] {
	if (mediaIds.length === 0) {
		return []
	}
	return db
		.all<{ id: string }>(
			`SELECT m.id FROM json_each(?1) j JOIN media_attachments m ON m.id = j.value
			WHERE m.account_id = ?2 AND (m.status_id IS NULL OR m.status_id IS ?3) ORDER BY j.key`,
			JSON.stringify([...new Set(mediaIds)]),
			accountId,
			statusId
		)
		.map((row) => row.id)
}

function attachMedia(db: Db, statusId: string, mediaIds: readonly string[]): void {
	db.run(
		`UPDATE media_attachments SET status_id = NULL, position = 0
		WHERE status_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))`,
		statusId,
		JSON.stringify(mediaIds)
	)
	db.run(
		`UPDATE media_attachments SET status_id = ?1, position = (SELECT j.key FROM json_each(?2) j WHERE j.value = media_attachments.id)
		WHERE id IN (SELECT value FROM json_each(?2))`,
		statusId,
		JSON.stringify(mediaIds)
	)
}

// statuses_count counts what Mastodon counts: everything but direct (and limited) statuses, boosts included. Remote
// accounts keep the count their server reported.
function recountStatuses(db: Db, accountId: string): void {
	db.run(
		`UPDATE accounts SET statuses_count = (SELECT COUNT(*) FROM statuses
			WHERE account_id = ?1 AND visibility IN ('public', 'unlisted', 'private'))
		WHERE id = ?1 AND domain IS NULL`,
		accountId
	)
}

// replies_count counts public and unlisted replies, as Mastodon does.
function recountStatus(db: Db, statusId: string | null): void {
	if (statusId === null) {
		return
	}
	db.run(
		`UPDATE statuses SET
			replies_count = (SELECT COUNT(*) FROM statuses r WHERE r.in_reply_to_id = ?1 AND r.visibility IN ('public', 'unlisted')),
			reblogs_count = (SELECT COUNT(*) FROM statuses r WHERE r.reblog_of_id = ?1),
			favourites_count = (SELECT COUNT(*) FROM favourites f WHERE f.status_id = ?1)
		WHERE id = ?1`,
		statusId
	)
}

function iso(now: number): string {
	return new Date(now).toISOString()
}

function searchText(text: string, spoilerText: string): string {
	return normalizeSearchText(`${spoilerText} ${text}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------------------------

export type CreateStatusInput = {
	text: string
	visibility?: ApiVisibility
	spoilerText: string
	sensitive?: boolean
	inReplyToId?: string
	language?: string
	mediaIds: string[]
	idempotencyKey?: string
	// The local object id (uuid) of the new status's URI, generated by the caller.
	objectId: string
	now: number
	present: Present
}

export type CreateStatusResult =
	| { status: 'ok'; value: Status }
	| { status: 'reply_not_found' }
	| { status: 'invalid'; error: string }

export const createStatus = userWriteOperation<CreateStatusInput, CreateStatusResult>((db, input, { accountId }) => {
	const options = { ...input.present, viewerId: accountId }
	if (input.idempotencyKey !== undefined) {
		// The key is the status's natural key: a repeat answers with the status the first request made.
		const existing = db.first<{ id: string }>(
			'SELECT id FROM statuses WHERE account_id = ? AND client_key = ?',
			accountId,
			input.idempotencyKey
		)
		const status = existing === undefined ? null : presentStatus(db, existing.id, options)
		if (status !== null) {
			return { status: 'ok', value: status }
		}
	}
	if (exceedsRawLength(input.text, input.spoilerText)) {
		return { status: 'invalid', error: TOO_LONG }
	}
	const author = localAuthor(db, accountId)
	let parent: { id: string; uri: string } | null = null
	if (input.inReplyToId !== undefined) {
		parent = replyParent(db, accountId, input.inReplyToId)
		if (parent === null) {
			return { status: 'reply_not_found' }
		}
	}
	const media = attachableMedia(db, accountId, input.mediaIds, null)
	if (input.text.trim() === '' && media.length === 0) {
		return { status: 'invalid', error: "Validation failed: Text can't be blank" }
	}
	const origin = new URL(author.uri).origin
	const composed = compose(db, input.text, author, input.present.origin)
	const visibility = input.visibility ?? author.default_visibility
	const sensitive = (input.sensitive ?? author.default_sensitive === 1) || input.spoilerText !== ''
	const id = allocateLocalId(db, input.now)
	db.run(
		`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, visibility, spoiler_text, content,
			source_text, sensitive, language, published_at, client_key, search_text, created_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?12)`,
		id,
		`${origin}/ap/o/${input.objectId}`,
		accountId,
		parent?.uri ?? null,
		parent?.id ?? null,
		visibility,
		input.spoilerText,
		composed.content,
		composed.source,
		sensitive ? 1 : 0,
		input.language ?? author.default_language,
		iso(input.now),
		input.idempotencyKey ?? null,
		searchText(composed.source, input.spoilerText)
	)
	writeMentions(db, id, composed.mentions, [])
	writeTags(db, id, composed.tags)
	attachMedia(db, id, media)
	recountStatuses(db, accountId)
	recountStatus(db, parent?.id ?? null)
	for (const mention of composed.mentions) {
		notify(db, { recipientId: mention.id, type: 'mention', fromId: accountId, statusId: id, now: input.now })
	}
	const facts = statusFacts(db, id)
	if (facts !== null) {
		recordOutbound(db, accountId, createActivity(facts), input.now)
	}
	const status = presentStatus(db, id, options)
	if (status === null) {
		throw new Error('created status cannot be presented')
	}
	return { status: 'ok', value: status }
})

// The status replied to: visible to the poster; a boost stands for its original.
function replyParent(db: Db, viewerId: string, id: string): { id: string; uri: string } | null {
	const resolved = resolveStatusId(db, id)
	if (resolved === null || !canView(db, viewerId, resolved)) {
		return null
	}
	const row = db.first<{ id: string; uri: string; reblog_of_id: string | null }>(
		'SELECT id, uri, reblog_of_id FROM statuses WHERE id = ?',
		resolved
	)
	if (row === undefined) {
		return null
	}
	if (row.reblog_of_id === null) {
		return { id: row.id, uri: row.uri }
	}
	return db.first<{ id: string; uri: string }>('SELECT id, uri FROM statuses WHERE id = ?', row.reblog_of_id) ?? null
}

// Writes the mention set of a status. Mentions that disappear from the text stay as silent mentions (Mastodon's
// ProcessMentionsService): whoever could see the status keeps seeing it, and nobody is notified again.
function writeMentions(
	db: Db,
	statusId: string,
	mentions: readonly ResolvedMention[],
	previous: readonly string[]
): string[] {
	const current = JSON.stringify(mentions.map((m) => m.id))
	db.run(
		`UPDATE status_mentions SET silent = 1 WHERE status_id = ?1 AND account_id NOT IN (SELECT value FROM json_each(?2))`,
		statusId,
		current
	)
	db.run(
		`INSERT INTO status_mentions (status_id, account_id, silent) SELECT ?1, value, 0 FROM json_each(?2) WHERE true
		ON CONFLICT (status_id, account_id) DO UPDATE SET silent = 0`,
		statusId,
		current
	)
	return mentions.map((m) => m.id).filter((id) => !previous.includes(id))
}

function writeTags(db: Db, statusId: string, tags: readonly string[]): void {
	db.run('DELETE FROM status_tags WHERE status_id = ?', statusId)
	db.run(
		'INSERT INTO status_tags (status_id, name) SELECT ?1, value FROM json_each(?2) WHERE true ON CONFLICT DO NOTHING',
		statusId,
		JSON.stringify(tags)
	)
}

// ---------------------------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------------------------

export type EditStatusInput = {
	id: string
	text: string
	spoilerText: string
	sensitive?: boolean
	language?: string
	mediaIds: string[]
	now: number
	present: Present
}

type OwnStatus = {
	id: string
	account_id: string
	reblog_of_id: string | null
	in_reply_to_id: string | null
	visibility: Visibility
	content: string
	source_text: string | null
	spoiler_text: string
	sensitive: number
	language: string | null
	published_at: string
}

function ownStatus(db: Db, accountId: string, id: string): OwnStatus | null {
	const resolved = resolveStatusId(db, id)
	if (resolved === null) {
		return null
	}
	return (
		db.first<OwnStatus>(
			`SELECT id, account_id, reblog_of_id, in_reply_to_id, visibility, content, source_text, spoiler_text, sensitive,
				language, published_at
			FROM statuses WHERE id = ? AND account_id = ?`,
			resolved,
			accountId
		) ?? null
	)
}

function mediaSnapshot(db: Db, statusId: string): MediaAttachment[] {
	return db
		.all<{
			id: string
			type: string
			url: string
			description: string
		}>('SELECT id, type, url, description FROM media_attachments WHERE status_id = ? ORDER BY position, id', statusId)
		.map(presentMedia)
}

function recordEdit(db: Db, statusId: string, at: string): void {
	const row = db.first<{ content: string; spoiler_text: string; sensitive: number }>(
		'SELECT content, spoiler_text, sensitive FROM statuses WHERE id = ?',
		statusId
	)
	if (row === undefined) {
		return
	}
	db.run(
		`INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		statusId,
		row.content,
		row.spoiler_text,
		row.sensitive,
		JSON.stringify(mediaSnapshot(db, statusId)),
		at
	)
}

// PUT /statuses/:id replaces the text, the spoiler, the sensitive flag and the media as Mastodon's UpdateStatusService
// does (absent media_ids removes the media); an absent language keeps the current one. Visibility cannot change. An
// edit that changes nothing is not recorded. The first edit also records the original as the first history entry.
export const editStatus = userWriteOperation<EditStatusInput, Acted<Status>>((db, input, { accountId }) => {
	const options = { ...input.present, viewerId: accountId }
	const current = ownStatus(db, accountId, input.id)
	if (current === null || current.reblog_of_id !== null) {
		return { status: 'not_found' }
	}
	if (exceedsRawLength(input.text, input.spoilerText)) {
		return { status: 'invalid', error: TOO_LONG }
	}
	const media = attachableMedia(db, accountId, input.mediaIds, current.id)
	if (input.text.trim() === '' && media.length === 0) {
		return { status: 'invalid', error: "Validation failed: Text can't be blank" }
	}
	const sensitive = (input.sensitive ?? false) || input.spoilerText !== ''
	const language = input.language ?? current.language
	const currentMedia = db
		.all<{ id: string }>('SELECT id FROM media_attachments WHERE status_id = ? ORDER BY position, id', current.id)
		.map((row) => row.id)
	const unchanged =
		input.text === (current.source_text ?? '') &&
		input.spoilerText === current.spoiler_text &&
		(sensitive ? 1 : 0) === current.sensitive &&
		language === current.language &&
		JSON.stringify(media) === JSON.stringify(currentMedia)
	const status = (): Acted<Status> => {
		const value = presentStatus(db, current.id, options)
		return value === null ? { status: 'not_found' } : { status: 'ok', value }
	}
	if (unchanged) {
		return status()
	}
	const author = localAuthor(db, accountId)
	const composed = compose(db, input.text, author, input.present.origin)
	const editedAt = iso(input.now)
	if (db.first('SELECT 1 AS yes FROM status_edits WHERE status_id = ? LIMIT 1', current.id) === undefined) {
		recordEdit(db, current.id, current.published_at)
	}
	db.run(
		`UPDATE statuses SET content = ?, source_text = ?, spoiler_text = ?, sensitive = ?, language = ?, edited_at = ?,
			search_text = ?
		WHERE id = ?`,
		composed.content,
		composed.source,
		input.spoilerText,
		sensitive ? 1 : 0,
		language,
		editedAt,
		searchText(composed.source, input.spoilerText),
		current.id
	)
	const previous = db
		.all<{ account_id: string }>('SELECT account_id FROM status_mentions WHERE status_id = ?', current.id)
		.map((row) => row.account_id)
	const added = writeMentions(db, current.id, composed.mentions, previous)
	writeTags(db, current.id, composed.tags)
	attachMedia(db, current.id, media)
	recordEdit(db, current.id, editedAt)
	for (const mentioned of added) {
		notify(db, { recipientId: mentioned, type: 'mention', fromId: accountId, statusId: current.id, now: input.now })
	}
	// Mastodon notifies the local accounts that boosted an edited status.
	const boosters = db.all<{ account_id: string }>(
		'SELECT DISTINCT r.account_id FROM statuses r JOIN local_accounts l ON l.account_id = r.account_id WHERE r.reblog_of_id = ?',
		current.id
	)
	for (const booster of boosters) {
		notify(db, {
			recipientId: booster.account_id,
			type: 'update',
			fromId: accountId,
			statusId: current.id,
			now: input.now,
		})
	}
	const facts = statusFacts(db, current.id)
	if (facts !== null) {
		recordOutbound(db, accountId, updateActivity(facts), input.now)
	}
	return status()
})

// ---------------------------------------------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------------------------------------------

// Deletes an own status (or boost) and answers with it as it was, source text included, for redrafting. Its media
// is detached, not deleted, unless deleteMedia, so a redraft can attach it again.
export const deleteStatus = userWriteOperation<
	{ id: string; deleteMedia: boolean; now: number; present: Present },
	Viewed<Status>
>((db, input, { accountId }) => {
	const current = ownStatus(db, accountId, input.id)
	if (current === null) {
		return { status: 'not_found' }
	}
	const value = presentStatus(db, current.id, { ...input.present, viewerId: accountId, source: true })
	if (value === null) {
		return { status: 'not_found' }
	}
	if (current.reblog_of_id !== null) {
		removeReblog(db, accountId, current.id, current.reblog_of_id, input.now)
		return { status: 'ok', value }
	}
	const facts = statusFacts(db, current.id)
	const boosters = db
		.all<{ account_id: string }>('SELECT DISTINCT account_id FROM statuses WHERE reblog_of_id = ?', current.id)
		.map((row) => row.account_id)
	if (!input.deleteMedia) {
		db.run('UPDATE media_attachments SET status_id = NULL, position = 0 WHERE status_id = ?', current.id)
	}
	// Children cascade (mentions, tags, edits, favourites, bookmarks, notifications, boosts); replies keep their
	// in_reply_to_uri.
	db.run('DELETE FROM statuses WHERE id = ?', current.id)
	recountStatuses(db, accountId)
	for (const booster of boosters) {
		recountStatuses(db, booster)
	}
	recountStatus(db, current.in_reply_to_id)
	if (facts !== null) {
		recordOutbound(db, accountId, deleteActivity(facts), input.now)
	}
	return { status: 'ok', value }
})

// ---------------------------------------------------------------------------------------------------------------
// Per-status reads
// ---------------------------------------------------------------------------------------------------------------

// The status `id` if the viewer may see it.
function viewable(db: Db, viewerId: string | null, id: string): string | null {
	const resolved = resolveStatusId(db, id)
	return resolved !== null && canView(db, viewerId, resolved) ? resolved : null
}

export const getStatus = optionalUserReadOperation<{ id: string; present: Present }, Viewed<Status>>(
	(db, { id, present }, viewerId) => {
		const resolved = viewable(db, viewerId, id)
		const value = resolved === null ? null : presentStatus(db, resolved, { ...present, viewerId })
		return value === null ? { status: 'not_found' } : { status: 'ok', value }
	}
)

const CONTEXT_LIMITS = {
	anonymous: { ancestors: 40, descendants: 60, depth: 20 },
	user: { ancestors: 4096, descendants: 4096, depth: 4096 },
}

export type Context = { ancestors: Status[]; descendants: Status[] }

// Ancestors oldest first and descendants depth first, as Mastodon orders them. Every member passes the list rule
// (visible, and not filtered by the viewer's blocks, mutes and domain blocks); the thread continues past members
// that do not.
export const statusContext = optionalUserReadOperation<{ id: string; present: Present }, Viewed<Context>>(
	(db, { id, present }, viewerId) => {
		const resolved = viewable(db, viewerId, id)
		if (resolved === null) {
			return { status: 'not_found' }
		}
		const limits = viewerId === null ? CONTEXT_LIMITS.anonymous : CONTEXT_LIMITS.user
		const ancestors = db.all<{ id: string }>(
			`WITH RECURSIVE up (id, depth) AS (
				SELECT in_reply_to_id, 1 FROM statuses WHERE id = ?2 AND in_reply_to_id IS NOT NULL
				UNION ALL
				SELECT s.in_reply_to_id, up.depth + 1 FROM statuses s JOIN up ON s.id = up.id
				WHERE s.in_reply_to_id IS NOT NULL AND up.depth < ?3
			)
			SELECT s.id FROM up JOIN statuses s ON s.id = up.id WHERE ${listableSql('s', '?1')} ORDER BY up.depth DESC`,
			viewerId,
			resolved,
			limits.ancestors
		)
		const descendants = db.all<{ id: string }>(
			`WITH RECURSIVE down (id, path, depth) AS (
				SELECT id, id, 1 FROM statuses WHERE in_reply_to_id = ?2
				UNION ALL
				SELECT s.id, down.path || '/' || s.id, down.depth + 1 FROM statuses s JOIN down ON s.in_reply_to_id = down.id
				WHERE down.depth < ?4
			)
			SELECT s.id FROM down JOIN statuses s ON s.id = down.id WHERE ${listableSql('s', '?1')} ORDER BY down.path LIMIT ?3`,
			viewerId,
			resolved,
			limits.descendants,
			limits.depth
		)
		const options = { ...present, viewerId }
		return {
			status: 'ok',
			value: {
				ancestors: presentStatuses(
					db,
					ancestors.map((row) => row.id),
					options
				),
				descendants: presentStatuses(
					db,
					descendants.map((row) => row.id),
					options
				),
			},
		}
	}
)

export type StatusEdit = {
	content: string
	spoiler_text: string
	sensitive: boolean
	created_at: string
	account: Account
	poll: null
	media_attachments: MediaAttachment[]
	emojis: []
}

// Edit history, oldest first. A status never edited has one entry: itself.
export const statusHistory = optionalUserReadOperation<{ id: string; present: Present }, Viewed<StatusEdit[]>>(
	(db, { id, present }, viewerId) => {
		const resolved = viewable(db, viewerId, id)
		const status = resolved === null ? null : presentStatus(db, resolved, { ...present, viewerId })
		if (resolved === null || status === null) {
			return { status: 'not_found' }
		}
		const edits = db.all<{
			content: string
			spoiler_text: string
			sensitive: number
			media_json: string
			created_at: string
		}>(
			'SELECT content, spoiler_text, sensitive, media_json, created_at FROM status_edits WHERE status_id = ? ORDER BY id',
			resolved
		)
		const value: StatusEdit[] =
			edits.length === 0
				? [
						{
							content: status.content ?? '',
							spoiler_text: status.spoiler_text,
							sensitive: status.sensitive,
							created_at: status.created_at,
							account: status.account,
							poll: null,
							media_attachments: status.media_attachments,
							emojis: [],
						},
					]
				: edits.map((edit) => ({
						content: edit.content,
						spoiler_text: edit.spoiler_text,
						sensitive: edit.sensitive === 1,
						created_at: edit.created_at,
						account: status.account,
						poll: null,
						media_attachments: JSON.parse(edit.media_json) as MediaAttachment[],
						emojis: [],
					}))
		return { status: 'ok', value }
	}
)

export type StatusSource = { id: string; text: string; spoiler_text: string }

export const statusSource = optionalUserReadOperation<{ id: string }, Viewed<StatusSource>>((db, { id }, viewerId) => {
	const resolved = viewable(db, viewerId, id)
	const row =
		resolved === null
			? undefined
			: db.first<{ id: string; source_text: string | null; content: string; spoiler_text: string }>(
					'SELECT id, source_text, content, spoiler_text FROM statuses WHERE id = ?',
					resolved
				)
	if (row === undefined) {
		return { status: 'not_found' }
	}
	return { status: 'ok', value: { id: row.id, text: row.source_text ?? row.content, spoiler_text: row.spoiler_text } }
})

// ---------------------------------------------------------------------------------------------------------------
// Favourite, reblog, bookmark
// ---------------------------------------------------------------------------------------------------------------

type Target = { id: string; uri: string; account_id: string; visibility: Visibility; author_uri: string }

// The status an action applies to: visible to the viewer, and the original when given a boost.
function actionTarget(db: Db, viewerId: string, id: string): Target | null {
	const resolved = viewable(db, viewerId, id)
	if (resolved === null) {
		return null
	}
	const row = db.first<Target>(
		`SELECT o.id, o.uri, o.account_id, o.visibility, a.uri AS author_uri
		FROM statuses s JOIN statuses o ON o.id = IFNULL(s.reblog_of_id, s.id) JOIN accounts a ON a.id = o.account_id
		WHERE s.id = ?`,
		resolved
	)
	return row ?? null
}

// The id of the original a boost stands for, without checking visibility.
function originalId(db: Db, id: string): string | null {
	const resolved = resolveStatusId(db, id)
	if (resolved === null) {
		return null
	}
	return (
		db.first<{ id: string }>('SELECT IFNULL(reblog_of_id, id) AS id FROM statuses WHERE id = ?', resolved)?.id ?? null
	)
}

function blocksAuthor(db: Db, viewerId: string, authorId: string): boolean {
	return (
		db.first('SELECT 1 AS yes FROM blocks WHERE account_id = ? AND target_account_id = ?', viewerId, authorId) !==
		undefined
	)
}

function viewerUri(db: Db, accountId: string): string {
	return localAuthor(db, accountId).uri
}

function presented(db: Db, id: string, viewerId: string, present: Present): Viewed<Status> {
	const value = canView(db, viewerId, id) ? presentStatus(db, id, { ...present, viewerId }) : null
	return value === null ? { status: 'not_found' } : { status: 'ok', value }
}

type ActionInput = { id: string; now: number; present: Present }

// StatusPolicy#favourite?: the status is visible and the viewer does not block its author.
export const favourite = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }) => {
	const target = actionTarget(db, accountId, input.id)
	if (target === null) {
		return { status: 'not_found' }
	}
	if (blocksAuthor(db, accountId, target.account_id)) {
		return { status: 'forbidden' }
	}
	const inserted = db.all<{ id: string }>(
		`INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, ?)
		ON CONFLICT DO NOTHING RETURNING CAST(id AS TEXT) AS id`,
		accountId,
		target.id,
		iso(input.now)
	)[0]
	if (inserted !== undefined) {
		const actorUri = viewerUri(db, accountId)
		const likeUri = `${actorUri}#likes/${inserted.id}`
		db.run('UPDATE favourites SET uri = ? WHERE id = CAST(? AS INTEGER)', likeUri, inserted.id)
		recountStatus(db, target.id)
		notify(db, {
			recipientId: target.account_id,
			type: 'favourite',
			fromId: accountId,
			statusId: target.id,
			now: input.now,
		})
		recordOutbound(
			db,
			accountId,
			likeActivity({ likeUri, actorUri, objectUri: target.uri, authorId: target.account_id }),
			input.now
		)
	}
	return presented(db, target.id, accountId, input.present)
})

export const unfavourite = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }) => {
	const id = originalId(db, input.id)
	if (id === null) {
		return { status: 'not_found' }
	}
	const removed = db.all<{ uri: string | null; author_id: string; author_uri: string; object_uri: string }>(
		`DELETE FROM favourites WHERE account_id = ?1 AND status_id = ?2
		RETURNING uri, (SELECT account_id FROM statuses WHERE id = ?2) AS author_id,
			(SELECT a.uri FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?2) AS author_uri,
			(SELECT uri FROM statuses WHERE id = ?2) AS object_uri`,
		accountId,
		id
	)[0]
	if (removed !== undefined) {
		recountStatus(db, id)
		db.run(
			"DELETE FROM notifications WHERE account_id = ? AND type = 'favourite' AND from_account_id = ? AND status_id = ?",
			removed.author_id,
			accountId,
			id
		)
		if (removed.uri !== null) {
			recordOutbound(
				db,
				accountId,
				undoLikeActivity({
					likeUri: removed.uri,
					actorUri: viewerUri(db, accountId),
					objectUri: removed.object_uri,
					authorId: removed.author_id,
				}),
				input.now
			)
		}
	}
	return presented(db, id, accountId, input.present)
})

export const bookmark = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }) => {
	const target = actionTarget(db, accountId, input.id)
	if (target === null) {
		return { status: 'not_found' }
	}
	db.run(
		'INSERT INTO bookmarks (account_id, status_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
		accountId,
		target.id,
		iso(input.now)
	)
	return presented(db, target.id, accountId, input.present)
})

export const unbookmark = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }) => {
	const id = originalId(db, input.id)
	if (id === null) {
		return { status: 'not_found' }
	}
	db.run('DELETE FROM bookmarks WHERE account_id = ? AND status_id = ?', accountId, id)
	return presented(db, id, accountId, input.present)
})

export type ReblogInput = ActionInput & { visibility?: ApiVisibility; objectId: string }

// StatusPolicy#reblog?: visible, not direct or limited, private only by its author, and the viewer does not block
// the author. A private status is boosted as private; otherwise the requested visibility or the viewer's default,
// with direct (which a boost cannot be) read as private.
export const reblog = userWriteOperation<ReblogInput, Acted<Status>>((db, input, { accountId }) => {
	const target = actionTarget(db, accountId, input.id)
	if (target === null) {
		return { status: 'not_found' }
	}
	if (
		requiresMention(target.visibility) ||
		(target.visibility === 'private' && target.account_id !== accountId) ||
		blocksAuthor(db, accountId, target.account_id)
	) {
		return { status: 'forbidden' }
	}
	const options = { ...input.present, viewerId: accountId }
	const existing = db.first<{ id: string }>(
		'SELECT id FROM statuses WHERE account_id = ? AND reblog_of_id = ?',
		accountId,
		target.id
	)
	if (existing !== undefined) {
		const value = presentStatus(db, existing.id, options)
		return value === null ? { status: 'not_found' } : { status: 'ok', value }
	}
	const author = localAuthor(db, accountId)
	const requested = input.visibility ?? author.default_visibility
	const visibility: Visibility =
		target.visibility === 'private' ? 'private' : requested === 'direct' ? 'private' : requested
	const id = allocateLocalId(db, input.now)
	const uri = `${new URL(author.uri).origin}/ap/o/${input.objectId}`
	const publishedAt = iso(input.now)
	db.run(
		`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at, created_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
		id,
		uri,
		accountId,
		target.id,
		visibility,
		publishedAt
	)
	recountStatuses(db, accountId)
	recountStatus(db, target.id)
	notify(db, { recipientId: target.account_id, type: 'reblog', fromId: accountId, statusId: target.id, now: input.now })
	recordOutbound(
		db,
		accountId,
		announceActivity(announceOf(author.uri, uri, visibility, publishedAt, target)),
		input.now
	)
	const value = presentStatus(db, id, options)
	return value === null ? { status: 'not_found' } : { status: 'ok', value }
})

function announceOf(
	actorUri: string,
	uri: string,
	visibility: Visibility,
	publishedAt: string,
	target: Target
): AnnounceInput {
	return {
		announceUri: uri,
		actorUri,
		visibility,
		publishedAt,
		objectUri: target.uri,
		authorUri: target.author_uri,
		authorId: target.account_id,
	}
}

function removeReblog(db: Db, accountId: string, reblogId: string, originalId: string, now: number): void {
	const row = db.first<{ uri: string; visibility: Visibility; published_at: string }>(
		'SELECT uri, visibility, published_at FROM statuses WHERE id = ?',
		reblogId
	)
	const target = db.first<Target>(
		`SELECT o.id, o.uri, o.account_id, o.visibility, a.uri AS author_uri
		FROM statuses o JOIN accounts a ON a.id = o.account_id WHERE o.id = ?`,
		originalId
	)
	db.run('DELETE FROM statuses WHERE id = ?', reblogId)
	recountStatuses(db, accountId)
	recountStatus(db, originalId)
	if (row === undefined || target === undefined) {
		return
	}
	db.run(
		"DELETE FROM notifications WHERE account_id = ? AND type = 'reblog' AND from_account_id = ? AND status_id = ?",
		target.account_id,
		accountId,
		originalId
	)
	recordOutbound(
		db,
		accountId,
		undoAnnounceActivity(announceOf(viewerUri(db, accountId), row.uri, row.visibility, row.published_at, target)),
		now
	)
}

export const unreblog = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }) => {
	const id = originalId(db, input.id)
	if (id === null) {
		return { status: 'not_found' }
	}
	const own = db.first<{ id: string }>(
		'SELECT id FROM statuses WHERE account_id = ? AND reblog_of_id = ?',
		accountId,
		id
	)
	if (own !== undefined) {
		removeReblog(db, accountId, own.id, id, input.now)
	}
	return presented(db, id, accountId, input.present)
})

// ---------------------------------------------------------------------------------------------------------------
// Who favourited or boosted
// ---------------------------------------------------------------------------------------------------------------

export type InteractorsInput = { id: string; kind: 'favourited_by' | 'reblogged_by'; page: PageQuery; present: Present }

// Accounts that favourited or boosted a status the viewer may see, newest first, without accounts the viewer
// blocks, is blocked by or mutes, and without suspended accounts. Favourites page by the favourite's id; boosts by
// the boost's status id.
export const interactors = optionalUserReadOperation<InteractorsInput, Viewed<Page<Account>>>(
	(db, { id, kind, page, present }, viewerId) => {
		const resolved = viewable(db, viewerId, id)
		const target = resolved === null ? null : originalId(db, resolved)
		if (target === null) {
			return { status: 'not_found' }
		}
		const ascending = page.minId !== undefined
		const order = ascending ? 'ASC' : 'DESC'
		const excluded = `(?1 IS NULL OR NOT (
			EXISTS (SELECT 1 FROM blocks WHERE account_id = ?1 AND target_account_id = a.id)
			OR EXISTS (SELECT 1 FROM blocks WHERE account_id = a.id AND target_account_id = ?1)
			OR EXISTS (SELECT 1 FROM mutes WHERE account_id = ?1 AND target_account_id = a.id)))`
		const lower = page.minId ?? page.sinceId ?? null
		const rows =
			kind === 'favourited_by'
				? db.all<AccountRow & { cursor: string }>(
						`SELECT CAST(f.id AS TEXT) AS cursor, ${ACCOUNT_COLUMNS}
						FROM favourites f JOIN accounts a ON a.id = f.account_id LEFT JOIN local_accounts l ON l.account_id = a.id
						WHERE f.status_id = ?2 AND l.suspended_at IS NULL AND ${excluded}
							AND (?3 IS NULL OR f.id < CAST(?3 AS INTEGER)) AND (?4 IS NULL OR f.id > CAST(?4 AS INTEGER))
						ORDER BY f.id ${order} LIMIT ?5`,
						viewerId,
						target,
						page.maxId ?? null,
						lower,
						page.limit
					)
				: db.all<AccountRow & { cursor: string }>(
						`SELECT r.id AS cursor, ${ACCOUNT_COLUMNS}
						FROM statuses r JOIN accounts a ON a.id = r.account_id LEFT JOIN local_accounts l ON l.account_id = a.id
						WHERE r.reblog_of_id = ?2 AND l.suspended_at IS NULL AND ${excluded}
							AND (?3 IS NULL OR r.id < ?3) AND (?4 IS NULL OR r.id > ?4)
						ORDER BY r.id ${order} LIMIT ?5`,
						viewerId,
						target,
						statusCursor(page.maxId),
						statusCursor(lower ?? undefined),
						page.limit
					)
		if (ascending) {
			rows.reverse()
		}
		return {
			status: 'ok',
			value: {
				items: rows.map((row) => presentAccount(row, present)),
				newest: rows[0]?.cursor ?? null,
				oldest: rows.at(-1)?.cursor ?? null,
			},
		}
	}
)

const STATUS_ID_LENGTH = 18
const MAX_STATUS_ID = '9'.repeat(STATUS_ID_LENGTH)

// Status ids are 18-digit TEXT compared as TEXT (the indexes are on the TEXT column). A shorter cursor is padded so
// it compares as the number it is; a longer one is beyond every id.
export function statusCursor(cursor: string | undefined): string | null {
	if (cursor === undefined) {
		return null
	}
	if (cursor.length > STATUS_ID_LENGTH) {
		return MAX_STATUS_ID
	}
	return cursor.padStart(STATUS_ID_LENGTH, '0')
}
