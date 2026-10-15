import {
	type Account,
	ACCOUNT_COLUMNS,
	type AccountRow,
	accountUrl,
	type Page,
	type PageQuery,
	type Present,
	presentAccount,
	resolveApiId,
} from './accounts'
import {
	announceActivity,
	boostAnnounce,
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
import {
	type ApiVisibility,
	blockedSql,
	blocksSql,
	canView,
	DISTRIBUTABLE_SQL,
	isDistributable,
	listedForSql,
	mentionableBySql,
	MENTION_STATUS_COLUMNS,
	mentionStatusSql,
	ownStatusId,
	REACHES_FOLLOWERS_SQL,
	requiresMention,
	statusReads,
	tagPublicSql,
	type Visibility,
	viewableStatusId,
} from './audience'
import {
	optionalUserReadOperation,
	type UserContext,
	userMediaDeleteOperation,
	userReadOperation,
	userWriteOperation,
} from './auth'
import { addToConversation } from './conversations'
import { beginRetraction } from './deliveries'
import { countFeaturedTags, featuredOfStatus, uncountFeaturedTags } from './featured-tags'
import { allocateLocalId } from './ids'
import { DETACHED_GRACE_MS, DOOMED_AT, liveMediaSql } from './media'
import { notify } from './notifications'
import { editPoll, type PollInput, pollOptionsJson, writePoll } from './polls'
import { normalizeSearchText } from './search-text'
import {
	MEDIA_COLUMNS,
	type MediaAttachment,
	type MediaRow,
	presentMedia,
	presentOwnStatus,
	type PresentOwnOptions,
	presentStatus,
	presentStatusPair,
	type Status,
} from './status-presenter'
import { exceedsRawLength, mentionKey, type MentionRef, parseStatusText, renderStatusHtml } from './status-text'
import type { Db } from '../db/sql'

// Statuses (B4a): posting, editing and deleting local statuses, the per-status reads, and favourite, reblog and
// bookmark. Every read goes through the audience rule (audience.ts); every write recomputes the counters it changes
// from the rows, writes its notifications, and records its outbound intent (activities.ts), all in its transaction.

export type Viewed<T> = { status: 'ok'; value: T } | { status: 'not_found' }

export type Acted<T> = Viewed<T> | { status: 'forbidden' } | { status: 'invalid'; error: string }

// The Worker checks the counted length; the Store re-checks the raw bound so no caller can make it parse more.
const TOO_LONG = 'Validation failed: Text character limit of 500 exceeded'

// Mastodon's media_attachments.validations.too_many, which it also answers for media sent with a poll.
export const TOO_MANY_FILES = 'Cannot attach more than 4 files'

export function resolveStatusId(db: Db, id: string): string | null {
	return resolveApiId(db, 'statuses', id)
}

function viewed<T>(value: T | null): Viewed<T> {
	return value === null ? { status: 'not_found' } : { status: 'ok', value }
}

// The status `id`, if it is the viewer's own, as the response to their write about it.
function presentOwn(db: Db, viewerId: string, id: string, options: PresentOwnOptions): Status | null {
	const own = ownStatusId(db, viewerId, id)
	return own === null ? null : presentOwnStatus(db, own, options)
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
// local mention. Suspended local accounts, and accounts the author blocks or whose domain it blocks, are not mentioned
// (their mention stays text, as Mastodon's ProcessMentionsService drops it).
function resolveMentions(
	db: Db,
	refs: readonly MentionRef[],
	localHost: string,
	authorId: string
): Map<string, ResolvedMention> {
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
		WHERE ${mentionableBySql('a.id', '?2')}`,
		JSON.stringify(wanted),
		authorId
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
	const resolved = resolveMentions(db, parsed.mentions, localHost, author.id)
	const content = renderStatusHtml(parsed.segments, {
		mention: (ref) => {
			const account = resolved.get(mentionKey(ref))
			return account === undefined ? undefined : { url: accountUrl(account, origin), username: account.username }
		},
		tagUrl: (name) => `${origin}/tags/${encodeURIComponent(name)}`,
	})
	const unique = new Map([...resolved.values()].map((account) => [account.id, account]))
	return { content, source: text, mentions: [...unique.values()], tags: parsed.tags }
}

// Own media that is already attached to `statusId` (shown, or dropped by an earlier edit, as Mastodon's
// `status_id: [nil, @status.id]`), or unattached, processed and not doomed, in the order given (MEDIA-1). Media of
// other accounts, still processing, or past its grace period is left out, as Mastodon leaves out what
// `current_account.media_attachments.where(status_id: nil)` does not find. Media a scheduled status holds is
// attachable only by that scheduled status's publication (`scheduledId`).
function attachableMedia(
	db: Db,
	accountId: string,
	mediaIds: readonly string[],
	statusId: string | null,
	now: number,
	scheduledId: string | null = null
): string[] {
	if (mediaIds.length === 0) {
		return []
	}
	return db
		.all<{ id: string }>(
			`SELECT m.id FROM json_each(?1) j JOIN media_attachments m ON m.id = j.value
			WHERE m.account_id = ?2 AND (m.status_id = ?3
				OR (m.status_id IS NULL AND m.scheduled_status_id IS ?5 AND ${liveMediaSql('m', '?4')}))
			ORDER BY j.key`,
			JSON.stringify([...new Set(mediaIds)]),
			accountId,
			statusId,
			iso(now),
			scheduledId
		)
		.map((row) => row.id)
}

// Attaches `mediaIds` in order (from a scheduled status too). Media the status stops using stays attached but no
// longer shown (migration 0015_media_shown), as Mastodon keeps it attached and leaves it out of
// ordered_media_attachment_ids: earlier versions still show it, and a later edit may show it again.
function attachMedia(db: Db, statusId: string, mediaIds: readonly string[]): void {
	db.run(
		`UPDATE media_attachments SET shown = 0
		WHERE status_id = ?1 AND shown = 1 AND id NOT IN (SELECT value FROM json_each(?2))`,
		statusId,
		JSON.stringify(mediaIds)
	)
	db.run(
		`UPDATE media_attachments SET status_id = ?1, scheduled_status_id = NULL, gc_at = NULL, shown = 1,
			position = (SELECT j.key FROM json_each(?2) j WHERE j.value = media_attachments.id)
		WHERE id IN (SELECT value FROM json_each(?2))`,
		statusId,
		JSON.stringify(mediaIds)
	)
}

// statuses_count counts what Mastodon counts: everything but direct (and limited) statuses, boosts included. Remote
// accounts keep the count their server reported.
export function recountStatuses(db: Db, accountId: string): void {
	db.run(
		`UPDATE accounts SET statuses_count = (SELECT COUNT(*) FROM statuses
			WHERE account_id = ?1 AND visibility IN ${REACHES_FOLLOWERS_SQL})
		WHERE id = ?1 AND domain IS NULL`,
		accountId
	)
}

// replies_count counts public and unlisted replies, as Mastodon does.
export function recountStatus(db: Db, statusId: string | null): void {
	if (statusId === null) {
		return
	}
	db.run(
		`UPDATE statuses SET
			replies_count = (SELECT COUNT(*) FROM statuses r WHERE r.in_reply_to_id = ?1 AND r.visibility IN ${DISTRIBUTABLE_SQL}),
			reblogs_count = (SELECT COUNT(*) FROM statuses r WHERE r.reblog_of_id = ?1),
			favourites_count = (SELECT COUNT(*) FROM favourites f WHERE f.status_id = ?1)
		WHERE id = ?1`,
		statusId
	)
}

export function iso(now: number): string {
	return new Date(now).toISOString()
}

function searchText(text: string, spoilerText: string): string {
	return normalizeSearchText(`${spoilerText} ${text}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------------------------

export type MediaAttributes = { id: string; description?: string; focus?: { x: number; y: number } }

export type CreateStatusInput = {
	text: string
	visibility?: ApiVisibility
	spoilerText: string
	sensitive?: boolean
	inReplyToId?: string
	language?: string
	mediaIds: string[]
	// A poll the Worker checked (polls.ts, checkPoll); it ends its duration after the post is written.
	poll?: PollInput
	idempotencyKey?: string
	// The local object id (uuid) of the new status's URI, generated by the caller.
	objectId: string
	now: number
	present: Present
}

export type CreateStatusResult =
	{ status: 'ok'; value: Status } | { status: 'reply_not_found' } | { status: 'invalid'; error: string }

// A post as the poster sent it, checked and ready to write: by an immediate post, a scheduled one when it is
// scheduled (scheduled-statuses.ts), and its publication.
export type PostInput = Omit<CreateStatusInput, 'present' | 'idempotencyKey' | 'objectId'>

export type PreparedPost = { author: Author; parent: ReplyParent | null; media: string[] }

export type Prepared = PreparedPost | { status: 'reply_not_found' } | { status: 'invalid'; error: string }

// PostStatusService's checks of a post, before anything is written: the raw bound, the status replied to, the media
// and a blank text. `scheduledId` is the scheduled status being published, whose media it attaches (null: none).
export function preparePost(db: Db, accountId: string, input: PostInput, scheduledId: string | null): Prepared {
	if (exceedsRawLength(input.text, input.spoilerText)) {
		return { status: 'invalid', error: TOO_LONG }
	}
	const author = localAuthor(db, accountId)
	let parent: ReplyParent | null = null
	if (input.inReplyToId !== undefined) {
		parent = replyParent(db, accountId, input.inReplyToId)
		if (parent === null) {
			return { status: 'reply_not_found' }
		}
	}
	const media = attachableMedia(db, accountId, input.mediaIds, null, input.now, scheduledId)
	// PostStatusService#validate_media!: a poll takes the place of media.
	if (input.poll !== undefined && input.mediaIds.length > 0) {
		return { status: 'invalid', error: TOO_MANY_FILES }
	}
	if (input.text.trim() === '' && media.length === 0) {
		return { status: 'invalid', error: "Validation failed: Text can't be blank" }
	}
	return { author, parent, media }
}

export function isPrepared(prepared: Prepared): prepared is PreparedPost {
	return 'author' in prepared
}

// Writes a prepared post: the status, its mentions, tags and media, its notifications and its Create (activities.ts),
// all in the caller's transaction. The new status's id.
export function writePost(
	db: Db,
	accountId: string,
	input: PostInput & { idempotencyKey?: string; objectId: string; origin: string },
	{ author, parent, media }: PreparedPost
): string {
	const origin = new URL(author.uri).origin
	const composed = compose(db, input.text, author, input.origin)
	const visibility = input.visibility ?? author.default_visibility
	const sensitive = (input.sensitive ?? author.default_sensitive === 1) || input.spoilerText !== ''
	const language = input.language ?? author.default_language
	// Status#carried_over_reply_to_account_id: continuing one's own reply keeps the conversation partner.
	const replyTarget =
		parent === null
			? null
			: parent.account_id === accountId && parent.in_reply_to_uri !== null
				? parent.in_reply_to_account_id
				: parent.account_id
	const id = allocateLocalId(db, input.now)
	db.run(
		`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, visibility, spoiler_text, content,
			source_text, sensitive, language, published_at, client_key, search_text, in_reply_to_account_id, created_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?12)`,
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
		language,
		iso(input.now),
		input.idempotencyKey ?? null,
		searchText(composed.source, input.spoilerText),
		replyTarget
	)
	writeMentions(db, id, composed.mentions, [])
	writeTags(db, id, composed.tags)
	attachMedia(db, id, media)
	if (input.poll !== undefined) {
		writePoll(db, id, input.poll, input.now)
	}
	recountStatuses(db, accountId)
	recountStatus(db, parent?.id ?? null)
	for (const mention of composed.mentions) {
		notify(db, { recipientId: mention.id, type: 'mention', fromId: accountId, statusId: id, now: input.now })
	}
	// FanOutOnWriteService#deliver_to_conversation!: the author's own direct status joins their conversation.
	addToConversation(db, accountId, id)
	// FeedInsertWorker#notify?: followers who asked to be notified hear of a post that is not a reply to someone else
	// (or to an unknown partner) and that their home would show (the follow's languages); notify() applies the audience
	// rule.
	if (parent === null || replyTarget === accountId) {
		const subscribers = db.all<{ account_id: string }>(
			`SELECT account_id FROM follows WHERE target_account_id = ?1 AND state = 'accepted' AND notify = 1
				AND (languages IS NULL OR ?2 IS NULL OR ?2 IN (SELECT value FROM json_each(languages)))`,
			accountId,
			language
		)
		for (const subscriber of subscribers) {
			notify(db, {
				recipientId: subscriber.account_id,
				type: 'status',
				fromId: accountId,
				statusId: id,
				now: input.now,
			})
		}
	}
	const facts = statusFacts(db, id)
	if (facts !== null) {
		recordOutbound(db, accountId, createActivity(facts), input.now)
	}
	return id
}

// The status the Idempotency-Key `key` made for the account, as its own: a repeat answers with it.
export function ownStatusByKey(db: Db, viewer: UserContext, key: string, present: Present): Status | null {
	const existing = db.first<{ id: string }>(
		'SELECT id FROM statuses WHERE account_id = ? AND client_key = ?',
		viewer.accountId,
		key
	)
	return existing === undefined ? null : presentOwn(db, viewer.accountId, existing.id, { ...present, viewer })
}

// Posts at once: the checks, then the write, answered with the new status.
export function postNow(db: Db, viewer: UserContext, input: CreateStatusInput): CreateStatusResult {
	const { accountId } = viewer
	const prepared = preparePost(db, accountId, input, null)
	if (!isPrepared(prepared)) {
		return prepared
	}
	const id = writePost(db, accountId, { ...input, origin: input.present.origin }, prepared)
	const status = presentOwn(db, accountId, id, { ...input.present, viewer })
	if (status === null) {
		throw new Error('created status cannot be presented')
	}
	return { status: 'ok', value: status }
}

export const createStatus = userWriteOperation<CreateStatusInput, CreateStatusResult>(
	(db, input, { accountId }, viewer) => {
		if (input.idempotencyKey !== undefined) {
			// The key is the status's natural key: a repeat answers with the status the first request made.
			const status = ownStatusByKey(db, viewer, input.idempotencyKey, input.present)
			if (status !== null) {
				return { status: 'ok', value: status }
			}
		}
		return postNow(db, viewer, input)
	}
)

type ReplyParent = {
	id: string
	uri: string
	account_id: string
	in_reply_to_uri: string | null
	in_reply_to_account_id: string | null
}

// The status replied to: visible to the poster; a boost stands for its original.
function replyParent(db: Db, viewerId: string, id: string): ReplyParent | null {
	const resolved = resolveStatusId(db, id)
	if (resolved === null || !canView(db, viewerId, resolved)) {
		return null
	}
	return (
		db.first<ReplyParent>(
			`SELECT o.id, o.uri, o.account_id, o.in_reply_to_uri, o.in_reply_to_account_id
			FROM statuses s JOIN statuses o ON o.id = IFNULL(s.reblog_of_id, s.id) WHERE s.id = ?`,
			resolved
		) ?? null
	)
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
		`INSERT INTO status_mentions (status_id, account_id, silent, ${MENTION_STATUS_COLUMNS})
		SELECT ?1, value, 0, ${mentionStatusSql('?1')} FROM json_each(?2) WHERE true
		ON CONFLICT (status_id, account_id) DO UPDATE SET silent = 0`,
		statusId,
		current
	)
	return mentions.map((m) => m.id).filter((id) => !previous.includes(id))
}

// The status's hashtags, and the counts of its author's featured hashtags that it gains or loses (featured-tags.ts).
export function writeTags(db: Db, statusId: string, tags: readonly string[]): void {
	const featured = featuredOfStatus(db, statusId)
	db.run('DELETE FROM status_tags WHERE status_id = ?', statusId)
	db.run(
		`INSERT INTO status_tags (status_id, name, public)
		SELECT ?1, value, ${tagPublicSql('?1')} FROM json_each(?2) WHERE true ON CONFLICT DO NOTHING`,
		statusId,
		JSON.stringify(tags)
	)
	countFeaturedTags(db, statusId, featured)
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
	// media_attributes[]: new descriptions and focal points of attached media, as UpdateStatusService applies them.
	// Entries for media the edit does not attach are ignored.
	mediaAttributes: MediaAttributes[]
	// The poll the edit leaves on the status (checked by the Worker); none removes the status's poll.
	poll?: PollInput
	now: number
	present: Present
}

// Edit history is bounded when it is written: a status keeps at most this many versions (the original and 99
// edits); a further edit is refused. Mastodon has no limit; this one keeps /history bounded (RES-3).
export const MAX_STATUS_EDITS = 100

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
		.all<MediaRow>(
			`SELECT ${MEDIA_COLUMNS} FROM media_attachments WHERE status_id = ? AND shown = 1 ORDER BY position, id`,
			statusId
		)
		.map(presentMedia)
}

// Records the status as it is now as a history entry and returns the entry's id (unique per edit; the Update
// activity is named after it).
export function recordEdit(db: Db, statusId: string, at: string): string {
	const row = db.all<{ id: string }>(
		`INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, poll_options, created_at)
		SELECT id, content, spoiler_text, sensitive, ?2, ?4, ?3 FROM statuses WHERE id = ?1
		RETURNING CAST(id AS TEXT) AS id`,
		statusId,
		JSON.stringify(mediaSnapshot(db, statusId)),
		at,
		pollOptionsJson(db, statusId)
	)[0]
	if (row === undefined) {
		throw new Error('edited status disappeared')
	}
	return row.id
}

// PUT /statuses/:id replaces the text, the spoiler, the sensitive flag, the media and their descriptions as Mastodon's
// UpdateStatusService does (absent media_ids removes the media); an absent language keeps the current one.
// Visibility cannot change. An edit that changes nothing is not recorded. The first edit also records the original
// as the first history entry.
//
// Deliberate difference from Mastodon: the audience of a private, direct or limited status never widens. A mention
// added by an edit is linked in the text but adds no recipient, notification or delivery, so neither the status nor
// its history reaches anyone who could not see the original. Public and unlisted statuses follow Mastodon: a new
// mention is a mention and is notified. Either way, a mention removed by an edit stays as a silent mention.
export const editStatus = userWriteOperation<EditStatusInput, Acted<Status>>((db, input, { accountId }, viewer) => {
	const options = { ...input.present, viewer }
	const current = ownStatus(db, accountId, input.id)
	if (current === null || current.reblog_of_id !== null) {
		return { status: 'not_found' }
	}
	if (exceedsRawLength(input.text, input.spoilerText)) {
		return { status: 'invalid', error: TOO_LONG }
	}
	const media = attachableMedia(db, accountId, input.mediaIds, current.id, input.now)
	if (input.poll !== undefined && input.mediaIds.length > 0) {
		return { status: 'invalid', error: TOO_MANY_FILES }
	}
	if (input.text.trim() === '' && media.length === 0) {
		return { status: 'invalid', error: "Validation failed: Text can't be blank" }
	}
	const sensitive = (input.sensitive ?? false) || input.spoilerText !== ''
	const language = input.language ?? current.language
	const currentMedia = db.all<{ id: string; description: string; focus_x: number; focus_y: number }>(
		'SELECT id, description, focus_x, focus_y FROM media_attachments WHERE status_id = ? AND shown = 1 ORDER BY position, id',
		current.id
	)
	// Only attributes of media this edit attaches (own media, checked by attachableMedia) are applied.
	const attributes = input.mediaAttributes.filter((a) => media.includes(a.id))
	const before = new Map(currentMedia.map((m) => [m.id, m]))
	const changesMedia = (a: MediaAttributes): boolean => {
		const old = before.get(a.id)
		return (
			old === undefined ||
			(a.description !== undefined && a.description !== old.description) ||
			(a.focus !== undefined && (a.focus.x !== old.focus_x || a.focus.y !== old.focus_y))
		)
	}
	const unchanged =
		input.text === (current.source_text ?? '') &&
		input.spoilerText === current.spoiler_text &&
		(sensitive ? 1 : 0) === current.sensitive &&
		language === current.language &&
		JSON.stringify(media) === JSON.stringify(currentMedia.map((m) => m.id)) &&
		!attributes.some(changesMedia) &&
		// A poll sent always moves its end (expires_in counts from the edit), so it always changes the status.
		input.poll === undefined &&
		pollOptionsJson(db, current.id) === null
	const status = (): Acted<Status> => {
		return viewed(presentOwn(db, accountId, current.id, options))
	}
	if (unchanged) {
		return status()
	}
	const versions =
		db.first<{ n: number }>('SELECT COUNT(*) AS n FROM status_edits WHERE status_id = ?', current.id)?.n ?? 0
	if (versions + (versions === 0 ? 2 : 1) > MAX_STATUS_EDITS) {
		return { status: 'invalid', error: 'Validation failed: This status has been edited too many times' }
	}
	const author = localAuthor(db, accountId)
	const composed = compose(db, input.text, author, input.present.origin)
	const editedAt = iso(input.now)
	if (versions === 0) {
		recordEdit(db, current.id, current.published_at)
	}
	editPoll(db, current.id, input.poll ?? null, input.now)
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
	const mentions = isDistributable(current.visibility)
		? composed.mentions
		: composed.mentions.filter((mention) => previous.includes(mention.id))
	const added = writeMentions(db, current.id, mentions, previous)
	// A mention of an account the author has blocked since goes, rather than staying silent (ProcessMentionsService).
	db.run(
		`DELETE FROM status_mentions WHERE status_id = ?1 AND ${blockedSql('?2', 'status_mentions.account_id')}`,
		current.id,
		accountId
	)
	writeTags(db, current.id, composed.tags)
	attachMedia(db, current.id, media)
	for (const a of attributes) {
		db.run(
			`UPDATE media_attachments SET description = COALESCE(?, description), focus_x = COALESCE(?, focus_x),
				focus_y = COALESCE(?, focus_y)
			WHERE id = ? AND account_id = ? AND status_id = ?`,
			a.description ?? null,
			a.focus?.x ?? null,
			a.focus?.y ?? null,
			a.id,
			accountId,
			current.id
		)
	}
	const editId = recordEdit(db, current.id, editedAt)
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
		recordOutbound(db, accountId, updateActivity(facts, editId), input.now)
	}
	return status()
})

// ---------------------------------------------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------------------------------------------

// Deletes an own status (or boost) and answers with it as it was, source text included, for redrafting. Its media, also
// what earlier edits dropped (as Mastodon nullifies every media of the status), is detached, so a redraft can attach it
// again within the grace period; with deleteMedia it is doomed at once and the media sweep deletes it and its R2
// objects (the Worker starts a sweep after the call). Only the deleted status itself carries its source; a boost's
// original is shown only if the viewer may still see it (presentOwnStatus), and never with its source.
export const deleteStatus = userMediaDeleteOperation<
	{ id: string; deleteMedia: boolean; now: number; present: Present },
	Viewed<Status>
>((db, input, { accountId }, viewer) => {
	const current = ownStatus(db, accountId, input.id)
	if (current === null) {
		return { status: 'not_found' }
	}
	const value = presentOwn(db, accountId, current.id, { ...input.present, viewer, source: true })
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
	// Detached before the delete, so the rows (and the R2 keys they name) do not cascade away before the sweep.
	db.run(
		'UPDATE media_attachments SET status_id = NULL, position = 0, shown = 1, gc_at = ? WHERE status_id = ?',
		input.deleteMedia ? DOOMED_AT : iso(input.now + DETACHED_GRACE_MS),
		current.id
	)
	// Recorded while the status, its boosts and their receipts still exist, so the Delete reaches every inbox that
	// received the status, and each local boost's Undo every inbox that received the boost or may still: a booster's
	// followers may never have received the original, so its Delete would not reach them.
	if (facts !== null) {
		recordOutbound(db, accountId, deleteActivity(facts), input.now)
	}
	undoLocalBoosts(db, current.id, input.now)
	uncountFeaturedTags(db, current.id)
	// Children cascade (mentions, tags, edits, favourites, bookmarks, notifications, boosts and their receipts);
	// replies keep their in_reply_to_uri.
	db.run('DELETE FROM statuses WHERE id = ?', current.id)
	recountStatuses(db, accountId)
	for (const booster of boosters) {
		recountStatuses(db, booster)
	}
	recountStatus(db, current.in_reply_to_id)
	return { status: 'ok', value }
})

// ---------------------------------------------------------------------------------------------------------------
// Per-status reads
// ---------------------------------------------------------------------------------------------------------------

// The status `id` if the viewer may see it.
function viewable(db: Db, viewerId: string | null, id: string) {
	const resolved = resolveStatusId(db, id)
	return resolved === null ? null : viewableStatusId(db, viewerId, resolved)
}

export const getStatus = optionalUserReadOperation<{ id: string; present: Present }, Viewed<Status>>(
	(db, { id, present }, viewer) => {
		const resolved = viewable(db, viewer.accountId, id)
		return viewed(resolved === null ? null : presentStatus(db, resolved, { ...present, viewer }))
	}
)

// traversal bounds the reply-tree rows read before the list rule and the order apply, not only the rows returned:
// a broad tree is cut, breadth first, after that many replies.
const CONTEXT_LIMITS = {
	anonymous: { ancestors: 40, descendants: 60, depth: 20, traversal: 240 },
	user: { ancestors: 4096, descendants: 4096, depth: 4096, traversal: 8192 },
}

export type Context = { ancestors: Status[]; descendants: Status[] }

// Ancestors oldest first and descendants depth first, as Mastodon orders them. Every member passes the list rule
// (visible, and not filtered by the viewer's blocks, mutes and domain blocks); the thread continues past members
// that do not.
export const statusContext = optionalUserReadOperation<{ id: string; present: Present }, Viewed<Context>>(
	(db, { id, present }, viewer) => {
		const { accountId: viewerId, now } = viewer
		const resolved = viewable(db, viewerId, id)
		if (resolved === null) {
			return { status: 'not_found' }
		}
		const limits = viewerId === null ? CONTEXT_LIMITS.anonymous : CONTEXT_LIMITS.user
		const read = statusReads(viewer, { viewer: '?1', now: '?4' })
		const ancestors = read.select(
			db,
			'listable',
			{
				with: `WITH RECURSIVE up (id, depth) AS (
					SELECT in_reply_to_id, 1 FROM statuses WHERE id = ?2 AND in_reply_to_id IS NOT NULL
					UNION ALL
					SELECT s.in_reply_to_id, up.depth + 1 FROM statuses s JOIN up ON s.id = up.id
					WHERE s.in_reply_to_id IS NOT NULL AND up.depth < ?3
				)`,
				from: 'up JOIN',
				join: 'ON s.id = up.id',
				tail: 'ORDER BY up.depth DESC',
			},
			viewerId,
			resolved,
			limits.ancestors,
			now
		)
		const tree = descendantTree(db, resolved, limits.depth, limits.traversal)
		const descendants = read.select(
			db,
			'listable',
			{ from: 'json_each(?2) j JOIN', join: 'ON s.id = j.value', tail: 'ORDER BY j.key LIMIT ?3' },
			viewerId,
			JSON.stringify(tree),
			limits.descendants,
			now
		)
		// Presented as one response, so the filters' text budget is shared by both lists.
		const [presentedAncestors, presentedDescendants] = presentStatusPair(
			db,
			ancestors.map((row) => row.id),
			descendants.map((row) => row.id),
			{ ...present, viewer }
		)
		return { status: 'ok', value: { ancestors: presentedAncestors, descendants: presentedDescendants } }
	}
)

// The replies under `rootId`, depth first with siblings in id order, read level by level: each level fetches the
// children of the current frontier through the in_reply_to index with LIMIT set to the budget that remains, so the
// rows read stay within the budget however wide or deep the tree is (a recursive CTE would queue every child before
// its LIMIT applies). Only the bounded result is ordered. A cycle in remote data is cut at the first repeat.
function descendantTree(db: Db, rootId: string, maxDepth: number, budget: number): string[] {
	const children = new Map<string, string[]>()
	const seen = new Set([rootId])
	let frontier = [rootId]
	let remaining = budget
	for (let depth = 0; depth < maxDepth && frontier.length > 0 && remaining > 0; depth++) {
		const rows = db.all<{ id: string; parent: string }>(
			`SELECT s.id, s.in_reply_to_id AS parent FROM json_each(?1) f CROSS JOIN statuses s
			WHERE s.in_reply_to_id = f.value LIMIT ?2`,
			JSON.stringify(frontier),
			remaining
		)
		remaining -= rows.length
		frontier = []
		for (const row of rows) {
			if (seen.has(row.id)) {
				continue
			}
			seen.add(row.id)
			frontier.push(row.id)
			const siblings = children.get(row.parent)
			if (siblings === undefined) {
				children.set(row.parent, [row.id])
			} else {
				siblings.push(row.id)
			}
		}
	}
	const ordered: string[] = []
	const visit = (id: string): void => {
		for (const child of (children.get(id) ?? []).sort()) {
			ordered.push(child)
			visit(child)
		}
	}
	visit(rootId)
	return ordered
}

export type StatusEdit = {
	content: string
	spoiler_text: string
	sensitive: boolean
	created_at: string
	account: Account
	poll: { options: { title: string }[] } | null
	media_attachments: MediaAttachment[]
	emojis: []
}

// StatusEdit's poll as REST::StatusEditSerializer shows it: the choices' titles a version had.
function editPollOf(options: string | null): StatusEdit['poll'] {
	return options === null ? null : { options: (JSON.parse(options) as string[]).map((title) => ({ title })) }
}

// Edit history, oldest first. A status never edited has one entry: itself.
export const statusHistory = optionalUserReadOperation<{ id: string; present: Present }, Viewed<StatusEdit[]>>(
	(db, { id, present }, viewer) => {
		const { accountId: viewerId } = viewer
		const resolved = viewable(db, viewerId, id)
		const status = resolved === null ? null : presentStatus(db, resolved, { ...present, viewer })
		if (resolved === null || status === null) {
			return { status: 'not_found' }
		}
		const edits = db.all<{
			content: string
			spoiler_text: string
			sensitive: number
			media_json: string
			poll_options: string | null
			created_at: string
		}>(
			`SELECT content, spoiler_text, sensitive, media_json, poll_options, created_at FROM status_edits
			WHERE status_id = ? ORDER BY id`,
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
							poll: status.poll === null ? null : { options: status.poll.options.map(({ title }) => ({ title })) },
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
						poll: editPollOf(edit.poll_options),
						media_attachments: JSON.parse(edit.media_json) as MediaAttachment[],
						emojis: [],
					}))
		return { status: 'ok', value }
	}
)

export type StatusSource = { id: string; text: string; spoiler_text: string }

// The source is the author's only (Mastodon authorizes /source with StatusPolicy#update?): anyone else, even someone
// who may see the status, gets not_found.
export const statusSource = userReadOperation<{ id: string }, Viewed<StatusSource>>((db, { id }, { accountId }) => {
	const resolved = resolveStatusId(db, id)
	const row =
		resolved === null
			? undefined
			: db.first<{ id: string; source_text: string | null; content: string; spoiler_text: string }>(
					'SELECT id, source_text, content, spoiler_text FROM statuses WHERE id = ? AND account_id = ? AND reblog_of_id IS NULL',
					resolved,
					accountId
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
	return db.first(`SELECT 1 AS yes WHERE ${blocksSql('?1', '?2')}`, viewerId, authorId) !== undefined
}

function viewerUri(db: Db, accountId: string): string {
	return localAuthor(db, accountId).uri
}

function presented(db: Db, id: string, viewer: UserContext, present: Present): Viewed<Status> {
	const visible = viewableStatusId(db, viewer.accountId, id)
	return viewed(visible === null ? null : presentStatus(db, visible, { ...present, viewer }))
}

type ActionInput = { id: string; now: number; present: Present }

// StatusPolicy#favourite?: the status is visible and the viewer does not block its author.
export const favourite = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }, viewer) => {
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
	return presented(db, target.id, viewer, input.present)
})

export const unfavourite = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }, viewer) => {
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
	return presented(db, id, viewer, input.present)
})

export const bookmark = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }, viewer) => {
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
	return presented(db, target.id, viewer, input.present)
})

export const unbookmark = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }, viewer) => {
	const id = originalId(db, input.id)
	if (id === null) {
		return { status: 'not_found' }
	}
	db.run('DELETE FROM bookmarks WHERE account_id = ? AND status_id = ?', accountId, id)
	return presented(db, id, viewer, input.present)
})

export type ReblogInput = ActionInput & { visibility?: ApiVisibility; objectId: string }

// StatusPolicy#reblog?: visible, not direct or limited, private only by its author, and the viewer does not block
// the author. A private status is boosted as private; otherwise the requested visibility or the viewer's default,
// with direct (which a boost cannot be) read as private.
export const reblog = userWriteOperation<ReblogInput, Acted<Status>>((db, input, { accountId }, viewer) => {
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
	const options = { ...input.present, viewer }
	const existing = db.first<{ id: string }>(
		'SELECT id FROM statuses WHERE account_id = ? AND reblog_of_id = ?',
		accountId,
		target.id
	)
	if (existing !== undefined) {
		return viewed(presentOwn(db, accountId, existing.id, options))
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
		announceActivity(announceOf(db, accountId, author.uri, uri, visibility, publishedAt, target, 'content')),
		input.now
	)
	return viewed(presentOwn(db, accountId, id, options))
})

// The Announce of a boost by `boosterId`, for the Announce (content) or its Undo (retraction); boostAnnounce in
// activities.ts decides what it names.
function announceOf(
	db: Db,
	boosterId: string,
	actorUri: string,
	uri: string,
	visibility: Visibility,
	publishedAt: string,
	target: Target,
	kind: 'content' | 'retraction'
): AnnounceInput {
	return boostAnnounce(
		db,
		boosterId,
		{ announceUri: uri, actorUri, visibility, publishedAt, objectUri: target.uri },
		{ id: target.account_id, uri: target.author_uri },
		kind
	)
}

// Records an Undo(Announce) for every local boost of a status about to be deleted.
function undoLocalBoosts(db: Db, originalId: string, now: number): void {
	const target = db.first<Target>(
		`SELECT o.id, o.uri, o.account_id, o.visibility, a.uri AS author_uri
		FROM statuses o JOIN accounts a ON a.id = o.account_id WHERE o.id = ?`,
		originalId
	)
	if (target === undefined) {
		return
	}
	const boosts = db.all<{ account_id: string; uri: string; visibility: Visibility; published_at: string }>(
		`SELECT r.account_id, r.uri, r.visibility, r.published_at FROM statuses r
		JOIN local_accounts l ON l.account_id = r.account_id WHERE r.reblog_of_id = ? ORDER BY r.id`,
		originalId
	)
	for (const boost of boosts) {
		const announce = announceOf(
			db,
			boost.account_id,
			viewerUri(db, boost.account_id),
			boost.uri,
			boost.visibility,
			boost.published_at,
			target,
			'retraction'
		)
		recordOutbound(db, boost.account_id, undoAnnounceActivity(announce), now)
	}
}

// Records the Undo of one local boost through the boost's own path (its receipts say where it went), without deleting
// it: a purge of the original's author withdraws local boosts this way, then deletes them in bounded batches. Only
// the intent is recorded here, in at most maxRows rows (false, recording nothing, when they do not fit); the purge
// then stages its targets (stageRetraction in domain/deliveries.ts) before it deletes the receipts.
export function withdrawLocalBoost(db: Db, boostId: string, now: number, maxRows: number): boolean {
	const boost = db.first<{
		account_id: string
		uri: string
		visibility: Visibility
		published_at: string
		original: string
	}>(
		`SELECT r.account_id, r.uri, r.visibility, r.published_at, r.reblog_of_id AS original FROM statuses r
		JOIN local_accounts l ON l.account_id = r.account_id WHERE r.id = ? AND r.reblog_of_id IS NOT NULL`,
		boostId
	)
	const target =
		boost === undefined
			? undefined
			: db.first<Target>(
					`SELECT o.id, o.uri, o.account_id, o.visibility, a.uri AS author_uri
					FROM statuses o JOIN accounts a ON a.id = o.account_id WHERE o.id = ?`,
					boost.original
				)
	if (boost === undefined || target === undefined) {
		return true
	}
	const announce = announceOf(
		db,
		boost.account_id,
		viewerUri(db, boost.account_id),
		boost.uri,
		boost.visibility,
		boost.published_at,
		target,
		'retraction'
	)
	return beginRetraction(db, boost.account_id, undoAnnounceActivity(announce), now, maxRows)
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
	// The Undo is recorded while the boost and its receipts still exist.
	if (row !== undefined && target !== undefined) {
		recordOutbound(
			db,
			accountId,
			undoAnnounceActivity(
				announceOf(
					db,
					accountId,
					viewerUri(db, accountId),
					row.uri,
					row.visibility,
					row.published_at,
					target,
					'retraction'
				)
			),
			now
		)
	}
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
}

export const unreblog = userWriteOperation<ActionInput, Acted<Status>>((db, input, { accountId }, viewer) => {
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
	return presented(db, id, viewer, input.present)
})

// ---------------------------------------------------------------------------------------------------------------
// Who favourited or boosted
// ---------------------------------------------------------------------------------------------------------------

export type InteractorsInput = { id: string; kind: 'favourited_by' | 'reblogged_by'; page: PageQuery; present: Present }

// Accounts that favourited or boosted a status the viewer may see, newest first, without accounts the viewer
// blocks, is blocked by, mutes or domain-blocks, and without suspended accounts. Only public and unlisted boosts are
// listed (Mastodon's RebloggedByAccountsController); reblogs_count still counts every boost, as Mastodon's does. Favourites page by the favourite's id; boosts by
// the boost's status id.
export const interactors = optionalUserReadOperation<InteractorsInput, Viewed<Page<Account>>>(
	(db, { id, kind, page, present }, { accountId: viewerId, now }) => {
		const resolved = viewable(db, viewerId, id)
		const target = resolved === null ? null : originalId(db, resolved)
		if (target === null) {
			return { status: 'not_found' }
		}
		const ascending = page.minId !== undefined
		const order = ascending ? 'ASC' : 'DESC'
		const listed = listedForSql('a.id', '?1', '?6')
		const lower = page.minId ?? page.sinceId ?? null
		const rows =
			kind === 'favourited_by'
				? db.all<AccountRow & { cursor: string }>(
						`SELECT CAST(f.id AS TEXT) AS cursor, ${ACCOUNT_COLUMNS}
						FROM favourites f JOIN accounts a ON a.id = f.account_id LEFT JOIN local_accounts l ON l.account_id = a.id
						WHERE f.status_id = ?2 AND ${listed}
							AND (?3 IS NULL OR f.id < CAST(?3 AS INTEGER)) AND (?4 IS NULL OR f.id > CAST(?4 AS INTEGER))
						ORDER BY f.id ${order} LIMIT ?5`,
						viewerId,
						target,
						page.maxId ?? null,
						lower,
						page.limit,
						now
					)
				: db.all<AccountRow & { cursor: string }>(
						`SELECT r.id AS cursor, ${ACCOUNT_COLUMNS}
						FROM statuses r JOIN accounts a ON a.id = r.account_id LEFT JOIN local_accounts l ON l.account_id = a.id
						WHERE r.reblog_of_id = ?2 AND r.visibility IN ${DISTRIBUTABLE_SQL} AND ${listed}
							AND (?3 IS NULL OR r.id < ?3) AND (?4 IS NULL OR r.id > ?4)
						ORDER BY r.id ${order} LIMIT ?5`,
						viewerId,
						target,
						statusCursor(page.maxId),
						statusCursor(lower ?? undefined),
						page.limit,
						now
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
	cursor = cursor.replace(/^0+(?=\d)/, '')
	if (cursor.length > STATUS_ID_LENGTH) {
		return MAX_STATUS_ID
	}
	return cursor.padStart(STATUS_ID_LENGTH, '0')
}

// Bounds beyond every 18-digit id, for a cursor that is absent: with them a range is always a plain one, read through
// the index from the cursor rather than filtered from the newest.
export const ABOVE_EVERY_ID = ':'
export const BELOW_EVERY_ID = ''
