import {
	type Account,
	accountPage,
	accountUrl,
	edgeRangeSql,
	type Page,
	type PageQuery,
	type Present,
	presentAccountById,
	resolveApiId,
} from './accounts'
import {
	announceActivity,
	boostAnnounce,
	type AnnounceInput,
	createActivity,
	deleteActivity,
	likeActivity,
	quoteRequestActivity,
	recordOutbound,
	revocationRejectActivity,
	stampDeleteActivity,
	stampUri,
	statusFacts,
	statusReach,
	undoAnnounceActivity,
	undoLikeActivity,
	updateActivity,
} from './activities'
import { accountKey, type StoredKey } from './actors'
import { admit, admittedPage, ANSWER_BYTES, ARRAY_ANSWER_BYTES, jsonBytes } from './answer-budget'
import {
	type ApiVisibility,
	apiVisibility,
	blockedSql,
	blocksSql,
	canView,
	DISTRIBUTABLE_SQL,
	isDistributable,
	listedForSql,
	mayQuoteSql,
	mentionableBySql,
	MENTION_STATUS_COLUMNS,
	mentionStatusSql,
	ownStatusId,
	type QuotePolicyName,
	REACHES_FOLLOWERS_SQL,
	requiresMention,
	statusReads,
	storedQuotePolicy,
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
import { type CustomEmoji, localEmojiSnapshot, presentEmojis } from './custom-emojis'
import { beginRetraction } from './deliveries'
import { countFeaturedTags, featuredOfStatus, uncountFeaturedTags } from './featured-tags'
import { allocateLocalId, requestedId } from './ids'
import { DETACHED_GRACE_MS, DOOMED_AT, liveMediaSql } from './media'
import { notify } from './notifications'
import { editPoll, type PollInput, pollOptionsJson, writePoll } from './polls'
import { actorUriSql, usernameSql } from './profile-bounds'
import {
	acceptedQuoteWindow,
	answeredRequests,
	detachQuotes,
	ensureQuotedAccess,
	localQuoteOf,
	type QuotedForPost,
	quotedUpdates,
	type QuoteState,
	recordLocalQuote,
	revocableQuote,
	revokeQuoteRow,
} from './quotes'
import { normalizeSearchText } from './search-text'
import { editMediaSql, pollOptionsSql, statusUriSql } from './status-bounds'
import {
	type MediaAttachment,
	type MediaRow,
	presentMedia,
	presentOwnStatus,
	type PresentOwnOptions,
	presentation,
	presentStatus,
	presentStatusesWithin,
	type Status,
} from './status-presenter'
import { MEDIA_COLUMN_MAP } from './status-rows'
import {
	exceedsRawLength,
	linksAny,
	mentionKey,
	type MentionRef,
	parseStatusText,
	quoteFallbackHtml,
	renderStatusHtml,
} from './status-text'
import { streamDelete } from './streaming'
import { readWindow, singleWindow, windowJson, windowPage } from './windows'
import { selectSql } from '../db/columns'
import type { Db } from '../db/sql'
import { isoTimeSql, STATUS_EMOJIS_BYTES, storedMediaDescription, storedText } from '../platform/stored-bounds'
import { jsonStringBytes, SPOILER_BYTES, STATUS_CONTENT_BYTES } from '../security/html'

// Statuses (B4a): posting, editing and deleting local statuses, the per-status reads, and favourite, reblog and
// bookmark. Every read goes through the audience rule (audience.ts); every write recomputes the counters it changes
// from the rows, writes its notifications, and records its outbound intent (activities.ts), all in its transaction.

export type Viewed<T> = { status: 'ok'; value: T } | { status: 'not_found' }

export type Acted<T> = Viewed<T> | { status: 'forbidden' } | { status: 'invalid'; error: string }

// The Worker checks the counted length; the Store re-checks the raw bound so no caller can make it parse more.
const TOO_LONG = 'Validation failed: Text character limit of 500 exceeded'

// RES-2: a local status's content and content warning stay within the bounds a presented status has (status-bounds.ts),
// as a remote one's do. Text within MAX_RAW_LENGTH renders past STATUS_CONTENT_BYTES only through hundreds of
// mentions of accounts with long profile URLs; such a post is refused as too long.
function exceedsStatusBounds(content: string, spoilerText: string): boolean {
	return jsonStringBytes(content) > STATUS_CONTENT_BYTES || jsonStringBytes(spoilerText) > SPOILER_BYTES
}

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
	default_quote_policy: QuotePolicyName
}

function localAuthor(db: Db, accountId: string): Author {
	const author = db.first<Author>(
		`SELECT a.id, a.uri, a.username, l.default_visibility, l.default_sensitive, l.default_language,
			l.default_quote_policy
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
		`SELECT json_extract(j.value, '$.key') AS key, a.id, ${actorUriSql('a.uri')} AS uri, a.url, ${usernameSql('a.username')} AS username, a.domain
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

// The status a quote's RE: line links (TextFormatter#add_quote_fallback): its url (a local status's web page), and its
// uri, which the text may link instead.
type QuoteLink = { url: string; uri: string }

// `quoted`: the status the post quotes, while it is there (fallback line: status-text.ts quoteFallbackHtml, linksAny).
function compose(db: Db, text: string, author: Author, origin: string, quoted: QuoteLink | null = null): Composed {
	const parsed = parseStatusText(text)
	const localHost = new URL(author.uri).host
	const resolved = resolveMentions(db, parsed.mentions, localHost, author.id)
	const rendered = renderStatusHtml(parsed.segments, {
		mention: (ref) => {
			const account = resolved.get(mentionKey(ref))
			return account === undefined ? undefined : { url: accountUrl(account, origin), username: account.username }
		},
		tagUrl: (name) => `${origin}/tags/${encodeURIComponent(name)}`,
	})
	const content =
		quoted === null || linksAny(parsed.segments, [quoted.url, quoted.uri])
			? rendered
			: quoteFallbackHtml(quoted.url) + rendered
	const unique = new Map([...resolved.values()].map((account) => [account.id, account]))
	return { content, source: text, mentions: [...unique.values()], tags: parsed.tags }
}

// The web page of the status `id` (Mastodon's url_for): a local status's /@user/<id>, a remote one's url or uri.
function quoteLink(db: Db, id: string): QuoteLink | null {
	const row = db.first<{
		uri: string
		url: string | null
		username: string
		domain: string | null
		author_uri: string
	}>(
		`SELECT ${statusUriSql('s.uri')} AS uri, s.url, ${usernameSql('a.username')} AS username,
			a.domain, ${actorUriSql('a.uri')} AS author_uri
		FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?`,
		id
	)
	if (row === undefined) {
		return null
	}
	const url = row.domain === null ? `${new URL(row.author_uri).origin}/@${row.username}/${id}` : (row.url ?? row.uri)
	return { url, uri: row.uri }
}

// The media a post or an edit attaches, in the order given, each once (MEDIA-1): own media already attached to
// `statusId` (shown, or dropped by an earlier edit, as Mastodon's `status_id: [nil, @status.id]`), or unattached,
// processed and not doomed. Media a scheduled status holds is attachable only by that scheduled status's publication
// (`scheduledId`). Anything else, another account's media, media still processing or past its grace period included,
// refuses the whole request as PostStatusService#validate_media! does, with one message for every reason: each id is
// read as Ruby's to_i reads it (requestedId), and every one not found is listed in the order sent, repeats included.
function mediaToAttach(
	db: Db,
	accountId: string,
	mediaIds: readonly string[],
	statusId: string | null,
	now: number,
	scheduledId: string | null = null
): string[] | { status: 'invalid'; error: string } {
	if (mediaIds.length === 0) {
		return []
	}
	const rows = db.all<{ requested: string; id: string | null }>(
		`SELECT j.value AS requested, m.id FROM json_each(?1) j
		LEFT JOIN media_attachments m ON m.id = j.value AND m.account_id = ?2 AND (m.status_id = ?3
			OR (m.status_id IS NULL AND m.scheduled_status_id IS ?5 AND ${liveMediaSql('m', '?4')}))
		ORDER BY j.key`,
		JSON.stringify(mediaIds.map(requestedId)),
		accountId,
		statusId,
		iso(now),
		scheduledId
	)
	const missing = rows.filter((row) => row.id === null).map((row) => row.requested)
	if (missing.length > 0) {
		return { status: 'invalid', error: `Media ${missing.join(', ')} not found or already attached to another post` }
	}
	return [...new Set(rows.map((row) => row.id ?? ''))]
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
	// quote_approval_policy; none is the author's default_quote_policy.
	quotePolicy?: QuotePolicyName
	// quoted_status_id: the status the post quotes (a boost stands for its original).
	quotedStatusId?: string
	idempotencyKey?: string
	// The local object id (uuid) of the new status's URI, generated by the caller.
	objectId: string
	now: number
	present: Present
}

export type CreateStatusResult =
	| { status: 'ok'; value: Status }
	| { status: 'reply_not_found' }
	| { status: 'quote_not_found' }
	| { status: 'invalid'; error: string }

// A post as the poster sent it, checked and ready to write: by an immediate post, a scheduled one when it is
// scheduled (scheduled-statuses.ts), and its publication.
export type PostInput = Omit<CreateStatusInput, 'present' | 'idempotencyKey' | 'objectId'>

// visibility: as the post is written, a quote's rule applied (quoting a private status makes a public or unlisted
// post private).
export type PreparedPost = {
	author: Author
	parent: ReplyParent | null
	media: string[]
	visibility: ApiVisibility
	quoted: Quotable | null
}

export type Prepared =
	PreparedPost | { status: 'reply_not_found' } | { status: 'quote_not_found' } | { status: 'invalid'; error: string }

// Mastodon's statuses.errors.quoted_user_not_mentioned, as ActiveRecord::RecordInvalid words it.
export const QUOTED_USER_NOT_MENTIONED =
	'Validation failed: Cannot quote a non-mentioned user in a Private Mention post.'

// PostStatusService's checks, before any write, including the raw bound; a quote permits blank text. `scheduledId` is
// the scheduled status being published, whose media it attaches (null: none). R36 is checked in the writing
// transaction at posting, scheduling and publication (test/quote-authoring.test.ts concurrency table, row 1).
export function preparePost(db: Db, accountId: string, input: PostInput, scheduledId: string | null): Prepared {
	// Checked as writePost stores them, so text of only U+0000 is blank, as an edit's is.
	const text = storedText(input.text)
	const spoilerText = storedText(input.spoilerText)
	if (exceedsRawLength(text, spoilerText)) {
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
	let quoted: Quotable | null = null
	if (input.quotedStatusId !== undefined) {
		quoted = quotable(db, accountId, input.quotedStatusId)
		if (quoted === null) {
			return { status: 'quote_not_found' }
		}
	}
	// PostStatusService#validate_media! checks a poll with media before the ids; the Worker does (composition), so this
	// order only decides for a Store caller that skips it.
	const media = mediaToAttach(db, accountId, input.mediaIds, null, input.now, scheduledId)
	if (!Array.isArray(media)) {
		return media
	}
	// A poll takes the place of media.
	if (input.poll !== undefined && input.mediaIds.length > 0) {
		return { status: 'invalid', error: TOO_MANY_FILES }
	}
	const requested = input.visibility ?? author.default_visibility
	// PostStatusService#preprocess_attributes!: a quote of a private status (the poster's own: R36) is private.
	const visibility =
		quoted?.visibility === 'private' && (requested === 'public' || requested === 'unlisted') ? 'private' : requested
	// PostStatusService#safeguard_private_mention_quote!: a direct quote of someone else's status names its author.
	if (
		quoted !== null &&
		visibility === 'direct' &&
		quoted.account_id !== accountId &&
		!mentions(db, text, author, quoted.account_id)
	) {
		return { status: 'invalid', error: QUOTED_USER_NOT_MENTIONED }
	}
	if (text.trim() === '' && media.length === 0 && quoted === null) {
		return { status: 'invalid', error: "Validation failed: Text can't be blank" }
	}
	const origin = new URL(author.uri).origin
	const composed = compose(db, text, author, origin, quoted === null ? null : quoteLink(db, quoted.id))
	if (exceedsStatusBounds(composed.content, spoilerText)) {
		return { status: 'invalid', error: TOO_LONG }
	}
	return { author, parent, media, visibility, quoted }
}

// StatusesController#set_thread then #set_quoted_status return 404 before create validation. This read preserves
// error precedence only; preparePost rechecks both in the writing transaction and alone authorizes.
export const postTargets = userReadOperation<
	{ inReplyToId?: string; quotedStatusId?: string },
	'ok' | 'reply_not_found' | 'quote_not_found'
>((db, input, { accountId }) => {
	if (input.inReplyToId !== undefined && replyParent(db, accountId, input.inReplyToId) === null) {
		return 'reply_not_found'
	}
	if (input.quotedStatusId !== undefined && quotable(db, accountId, input.quotedStatusId) === null) {
		return 'quote_not_found'
	}
	return 'ok'
})

// A status a post may quote, as R36 found it.
type Quotable = QuotedForPost & { visibility: Visibility }

// The status `id` quotes (a boost stands for its original, Status#proper), if R36 lets the poster quote it
// (mayQuoteSql); null otherwise, which the poster is told as a status that does not exist.
function quotable(db: Db, accountId: string, id: string): Quotable | null {
	const resolved = resolveStatusId(db, id)
	if (resolved === null) {
		return null
	}
	return (
		db.first<Quotable>(
			`SELECT t.id, t.uri, t.account_id, t.visibility, a.domain IS NULL AS local
			FROM statuses s JOIN statuses t ON t.id = IFNULL(s.reblog_of_id, s.id) JOIN accounts a ON a.id = t.account_id
			WHERE s.id = ?1 AND ${mayQuoteSql('t', '?2')}`,
			resolved,
			accountId
		) ?? null
	)
}

// Whether `text` mentions the account `accountId` (as a mention the post would write, not a silent one).
function mentions(db: Db, text: string, author: Author, accountId: string): boolean {
	const resolved = resolveMentions(db, parseStatusText(text).mentions, new URL(author.uri).host, author.id)
	return [...resolved.values()].some((account) => account.id === accountId)
}

export function isPrepared(prepared: Prepared): prepared is PreparedPost {
	return 'author' in prepared
}

// The texts a local status's emoji snapshot reads (custom-emojis.ts localEmojiSnapshot), as Mastodon's
// Status#emojis: the content warning, the text and the poll's choices (app/models/status.rb:279-286).
function emojiTexts(spoilerText: string, source: string, poll: PollInput | undefined): string[] {
	return [spoilerText, source, ...(poll?.options ?? [])]
}

// Writes a prepared post: the status, its mentions, tags and media, its notifications and its Create (activities.ts),
// all in the caller's transaction. The new status's id.
export function writePost(
	db: Db,
	accountId: string,
	input: PostInput & { idempotencyKey?: string; objectId: string; origin: string },
	{ author, parent, media, visibility, quoted }: PreparedPost
): string {
	const origin = new URL(author.uri).origin
	const text = storedText(input.text)
	const spoilerText = storedText(input.spoilerText)
	const composed = compose(db, text, author, input.origin, quoted === null ? null : quoteLink(db, quoted.id))
	const sensitive = (input.sensitive ?? author.default_sensitive === 1) || spoilerText !== ''
	const language = input.language ?? author.default_language
	const quotePolicy = storedQuotePolicy(input.quotePolicy ?? author.default_quote_policy, visibility)
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
			source_text, sensitive, language, published_at, client_key, search_text, in_reply_to_account_id, created_at,
			quote_policy, emojis)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?12, ?16, ?17)`,
		id,
		`${origin}/ap/o/${input.objectId}`,
		accountId,
		parent?.uri ?? null,
		parent?.id ?? null,
		visibility,
		spoilerText,
		composed.content,
		composed.source,
		sensitive ? 1 : 0,
		language,
		iso(input.now),
		input.idempotencyKey ?? null,
		searchText(composed.source, spoilerText),
		replyTarget,
		quotePolicy,
		localEmojiSnapshot(db, emojiTexts(spoilerText, composed.source, input.poll), STATUS_EMOJIS_BYTES)
	)
	writeMentions(db, id, composed.mentions, [])
	if (quoted !== null) {
		writeQuote(db, { id, uri: `${origin}/ap/o/${input.objectId}`, authorId: accountId }, quoted, input.now)
	}
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
		// PostStatusService#postprocess_status!: the QuoteRequest follows the Create, to the quoted author alone.
		if (quoted !== null && quoted.local !== 1) {
			recordOutbound(
				db,
				accountId,
				quoteRequestActivity(facts, { uri: quoted.uri, authorId: quoted.account_id }),
				input.now
			)
		}
	}
	return id
}

// PostStatusService#attach_quote!: the row (quotes.ts recordLocalQuote), silent access (ensureQuotedAccess), and for
// an accepted quote of someone else's status its `quote` notification (FanOutOnWriteService#notify_quoted_account!).
function writeQuote(
	db: Db,
	quoting: { id: string; uri: string; authorId: string },
	quoted: Quotable,
	now: number
): void {
	if (quoted.account_id !== quoting.authorId) {
		ensureQuotedAccess(db, quoting.id, quoted.account_id)
	}
	const state = recordLocalQuote(db, quoting, quoted, now)
	if (state === 'accepted' && quoted.account_id !== quoting.authorId) {
		notify(db, { recipientId: quoted.account_id, type: 'quote', fromId: quoting.authorId, statusId: quoting.id, now })
	}
}

// An Idempotency-Key answers for an hour after the post it made (PostStatusService: `redis.setex(key, 3_600, ...)`).
export const IDEMPOTENCY_MS = 60 * 60 * 1000

// Whether the row's `createdAt` is within the key's hour before the time whose cutoff `cutoff` binds (keyCutoff). The
// time is read as the ISO form Kopje writes (isoTimeSql), so an imported value that is not one, SQLite's 'now'
// included, has expired.
export function keyFreshSql(createdAt: string, cutoff: string): string {
	return `${isoTimeSql(createdAt)} > ${cutoff}`
}

export function keyCutoff(now: number): string {
	return iso(now - IDEMPOTENCY_MS)
}

// The status the Idempotency-Key `key` made for the account within its hour, as its own: a repeat answers with it.
export function ownStatusByKey(db: Db, viewer: UserContext, key: string, present: Present, now: number): Status | null {
	const existing = db.first<{ id: string }>(
		`SELECT id FROM statuses WHERE account_id = ?1 AND client_key = ?2 AND ${keyFreshSql('created_at', '?3')}`,
		viewer.accountId,
		key,
		keyCutoff(now)
	)
	return existing === undefined ? null : presentOwn(db, viewer.accountId, existing.id, { ...present, viewer })
}

// Frees an expired key for a new post (statuses_client_key is unique per account): the older status keeps no key.
export function releaseStatusKey(db: Db, accountId: string, key: string): void {
	db.run('UPDATE statuses SET client_key = NULL WHERE account_id = ?1 AND client_key = ?2', accountId, key)
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
	// quote_approval_policy, only when the request sent one: none keeps the status's policy.
	quotePolicy?: QuotePolicyName
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
			`SELECT ${selectSql(MEDIA_COLUMN_MAP)} FROM media_attachments m WHERE m.status_id = ? AND m.shown = 1 ORDER BY m.position, m.id`,
			statusId
		)
		.map(presentMedia)
}

// Records the status as it is now as a history entry and returns the entry's id (unique per edit; the Update
// activity is named after it).
export function recordEdit(db: Db, statusId: string, at: string): string {
	// The poll's choices are copied as P projects them (pollOptionsSql) inside SQLite: read into the Worker and bound
	// again, a lone surrogate stored by an earlier version would come back as three U+FFFD (RES-2). The emoji snapshot
	// is copied as stored: both columns have the same bound (EMOJI_COLUMNS).
	const row = db.all<{ id: string }>(
		`INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, poll_options, created_at, emojis)
		SELECT id, content, spoiler_text, sensitive, ?2,
			(SELECT ${pollOptionsSql('p.options')} FROM polls p WHERE p.status_id = ?1 AND p.removed = 0), ?3, emojis
		FROM statuses WHERE id = ?1
		RETURNING CAST(id AS TEXT) AS id`,
		statusId,
		JSON.stringify(mediaSnapshot(db, statusId)),
		at
	)[0]
	if (row === undefined) {
		throw new Error('edited status disappeared')
	}
	return row.id
}

// PUT /statuses/:id replaces the text, the spoiler, the sensitive flag, the media and their descriptions as Mastodon's
// UpdateStatusService does (absent media_ids removes the media); an absent language keeps the current one.
// Visibility cannot change. An edit that changes nothing is not recorded. The first edit also records the original
// as the first history entry. A quote policy sent with the edit is stored (Mastodon 4.5.5: only when one is sent),
// nobody for a status that is not public or unlisted. Where Kopje differs from Mastodon, which counts a changed policy
// as an edit: the policy is not part of the history, so a change of the policy alone is stored as
// PUT .../interaction_policy stores it, with an Update but no history entry or edited_at (setQuotePolicy).
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
	const text = storedText(input.text)
	const spoilerText = storedText(input.spoilerText)
	if (exceedsRawLength(text, spoilerText)) {
		return { status: 'invalid', error: TOO_LONG }
	}
	// Before the "unchanged" test: UpdateStatusService validates the media before NoChangesSubmittedError.
	const media = mediaToAttach(db, accountId, input.mediaIds, current.id, input.now)
	if (!Array.isArray(media)) {
		return media
	}
	if (input.poll !== undefined && input.mediaIds.length > 0) {
		return { status: 'invalid', error: TOO_MANY_FILES }
	}
	// An edit keeps the status's quote (Mastodon takes no quoted_status_id on an edit), and its RE: line while the
	// quoted status is there.
	const quote = localQuoteOf(db, current.id)
	if (text.trim() === '' && media.length === 0 && quote === undefined) {
		return { status: 'invalid', error: "Validation failed: Text can't be blank" }
	}
	const sensitive = (input.sensitive ?? false) || spoilerText !== ''
	const language = input.language ?? current.language
	const currentMedia = db.all<{ id: string; description: string; focus_x: number; focus_y: number }>(
		'SELECT id, description, focus_x, focus_y FROM media_attachments WHERE status_id = ? AND shown = 1 ORDER BY position, id',
		current.id
	)
	// Only attributes of media this edit attaches (own media, checked by mediaToAttach) are applied.
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
		text === (current.source_text ?? '') &&
		spoilerText === current.spoiler_text &&
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
	const policy = input.quotePolicy === undefined ? null : storedQuotePolicy(input.quotePolicy, current.visibility)
	if (unchanged) {
		if (policy !== null) {
			setQuotePolicy(db, accountId, current.id, policy, input.now)
		}
		return status()
	}
	const versions =
		db.first<{ n: number }>('SELECT COUNT(*) AS n FROM status_edits WHERE status_id = ?', current.id)?.n ?? 0
	if (versions + (versions === 0 ? 2 : 1) > MAX_STATUS_EDITS) {
		return { status: 'invalid', error: 'Validation failed: This status has been edited too many times' }
	}
	const author = localAuthor(db, accountId)
	const quotedId = quote?.quotedStatusId ?? null
	const composed = compose(db, text, author, input.present.origin, quotedId === null ? null : quoteLink(db, quotedId))
	if (exceedsStatusBounds(composed.content, spoilerText)) {
		return { status: 'invalid', error: TOO_LONG }
	}
	const editedAt = iso(input.now)
	if (versions === 0) {
		recordEdit(db, current.id, current.published_at)
	}
	editPoll(db, current.id, input.poll ?? null, input.now)
	db.run(
		`UPDATE statuses SET content = ?, source_text = ?, spoiler_text = ?, sensitive = ?, language = ?, edited_at = ?,
			search_text = ?, quote_policy = COALESCE(?, quote_policy), emojis = ?
		WHERE id = ?`,
		composed.content,
		composed.source,
		spoilerText,
		sensitive ? 1 : 0,
		language,
		editedAt,
		searchText(composed.source, spoilerText),
		policy,
		localEmojiSnapshot(db, emojiTexts(spoilerText, composed.source, input.poll), STATUS_EMOJIS_BYTES),
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
			a.description === undefined ? null : storedMediaDescription(a.description),
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
	notifyQuotedUpdate(db, current.id, accountId, input.now)
	const facts = statusFacts(db, current.id)
	if (facts !== null) {
		recordOutbound(db, accountId, updateActivity(facts, editId), input.now)
	}
	return status()
})

// FanOutOnWriteService#notify_about_update!'s quoted_update: each local quoter (quotes.ts quotedUpdates) about their
// own quoting status, from the quoted author; a later one replaces the earlier (notify).
export function notifyQuotedUpdate(db: Db, quotedId: string, fromId: string, now: number): void {
	for (const quote of quotedUpdates(db, quotedId)) {
		notify(db, { recipientId: quote.account_id, type: 'quoted_update', fromId, statusId: quote.status_id, now })
	}
}

// A policy-only change sends an Update without a history entry or edited_at; receivers apply it as an implicit update
// (Notes carry the policy: activities.ts noteOf). Each Update snapshots its commit and supersedes waiting ones.
function setQuotePolicy(db: Db, accountId: string, id: string, policy: number, now: number): void {
	if (db.run('UPDATE statuses SET quote_policy = ?1 WHERE id = ?2 AND quote_policy <> ?1', policy, id) === 0) {
		return
	}
	const facts = statusFacts(db, id)
	if (facts !== null) {
		recordOutbound(db, accountId, updateActivity(facts, `quote-policy-${crypto.randomUUID()}`), now)
	}
}

// quotePolicy: the policy sent; none is the author's default, and 'invalid' one the Worker could not read.
export type InteractionPolicyInput = {
	id: string
	quotePolicy?: QuotePolicyName | 'invalid'
	present: Present
}

// PUT and PATCH /api/v1/statuses/:id/interaction_policy (Statuses::InteractionPoliciesController#update): the status
// must be one the viewer may see by itself (R3, else not found) and their own (else forbidden), then the policy must be
// one of the three (else "Record invalid"). The policy sent, or the author's default_quote_policy when none is, is
// stored as on posting (storedQuotePolicy). A boost has no policy of its own (its original's is shown): it is answered
// unchanged. A change writes no history entry and leaves edited_at, and sends an Update (setQuotePolicy).
export const updateInteractionPolicy = userWriteOperation<InteractionPolicyInput, Acted<Status>>(
	(db, input, { accountId }, viewer) => {
		const visible = viewable(db, accountId, input.id)
		if (visible === null) {
			return { status: 'not_found' }
		}
		const row = db.first<{ account_id: string; reblog_of_id: string | null; visibility: Visibility }>(
			'SELECT account_id, reblog_of_id, visibility FROM statuses WHERE id = ?',
			visible
		)
		if (row === undefined) {
			return { status: 'not_found' }
		}
		if (row.account_id !== accountId) {
			return { status: 'forbidden' }
		}
		if (input.quotePolicy === 'invalid') {
			return { status: 'invalid', error: 'Record invalid' }
		}
		if (row.reblog_of_id === null) {
			const name = input.quotePolicy ?? localAuthor(db, accountId).default_quote_policy
			setQuotePolicy(db, accountId, visible, storedQuotePolicy(name, row.visibility), Date.parse(viewer.now))
		}
		return viewed(presentStatus(db, visible, { ...input.present, viewer }))
	}
)

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
	// R32: the streaming delete is captured before anything changes the status's audience.
	streamDelete(db, current.id, input.now)
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
	// Quotes of it are detached, accepted ones becoming deleted, and its own quote goes (quotes.ts).
	detachQuotes(db, current.id, input.now)
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
export function viewable(db: Db, viewerId: string | null, id: string) {
	const resolved = resolveStatusId(db, id)
	return resolved === null ? null : viewableStatusId(db, viewerId, resolved)
}

export const getStatus = optionalUserReadOperation<{ id: string; present: Present }, Viewed<Status>>(
	(db, { id, present }, viewer) => {
		const resolved = viewable(db, viewer.accountId, id)
		return viewed(resolved === null ? null : presentStatus(db, resolved, { ...present, viewer }))
	}
)

// GET /api/v1/statuses?id[]= takes at most this many distinct ids (Api::V1::StatusesController#check_statuses_limit,
// DEFAULT_STATUSES_LIMIT); more answer 422.
export const MAX_STATUSES_BY_ID = 20

// GET /api/v1/statuses?id[]= (StatusesController#index, Status.permitted_statuses_from_ids): of the statuses with the
// ids, those the list rule passes for the viewer (R8, StatusFilter: viewable, and the viewer filters neither the
// author nor a boosted original's), each as getStatus shows it, in one read, in the order of the ids; an id with no
// status, or with one the rule refuses, is left out. Within ANSWER_BYTES (RES-3), the ids past the first status that
// does not fit are left out as unknown ones are.
export const getStatuses = optionalUserReadOperation<{ ids: readonly string[]; present: Present }, Status[]>(
	(db, { ids, present }, viewer) => {
		const resolved = [...new Set(ids.slice(0, MAX_STATUSES_BY_ID).flatMap((id) => resolveStatusId(db, id) ?? []))]
		if (resolved.length === 0) {
			return []
		}
		const order = new Map(resolved.map((id, i) => [id, i]))
		const rows = statusReads(viewer, { viewer: '?1', now: '?3' }).select(
			db,
			'listable',
			{ where: 's.id IN (SELECT value FROM json_each(?2))' },
			viewer.accountId,
			JSON.stringify(resolved),
			viewer.now
		)
		const visible = rows.map((row) => row.id).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
		const options = { ...present, viewer }
		return presentStatusesWithin(db, presentation(db, visible, options), visible, ARRAY_ANSWER_BYTES, true).items
	}
)

// traversal bounds the reply-tree rows read before the list rule and the order apply, not only the rows returned:
// a broad tree is cut, breadth first, after that many replies.
const CONTEXT_LIMITS = {
	anonymous: { ancestors: 40, descendants: 60, depth: 20, traversal: 240 },
	user: { ancestors: 4096, descendants: 4096, depth: 4096, traversal: 8192 },
}

export type Context = { ancestors: Status[]; descendants: Status[] }

// The JSON of an empty context: each list's items are counted with a separator, one more than they take.
const CONTEXT_FRAME_BYTES = jsonBytes({ ancestors: [], descendants: [] } satisfies Context)

// Ancestors oldest first and descendants depth first, as Mastodon orders them. Every member passes the list rule
// (visible, and not filtered by the viewer's blocks, mutes and domain blocks); the thread continues past members
// that do not. One answer within ANSWER_BYTES (RES-3), under one presentation: the ancestors take half of it, nearest
// first, and the descendants the rest with what the ancestors left, in their order; each list keeps its order, and
// the farthest ancestors and the last descendants past it are left out (no paging, as Mastodon's context has none).
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
		const up = ancestors.map((row) => row.id)
		const down = descendants.map((row) => row.id)
		const shared = presentation(db, [...up, ...down], { ...present, viewer })
		const budget = ANSWER_BYTES - CONTEXT_FRAME_BYTES
		const near = presentStatusesWithin(db, shared, up.toReversed(), Math.floor(budget / 2), true)
		const after = presentStatusesWithin(db, shared, down, budget - near.bytes, near.items.length === 0)
		return { status: 'ok', value: { ancestors: near.items.toReversed(), descendants: after.items } }
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
	emojis: CustomEmoji[]
}

// StatusEdit's poll as REST::StatusEditSerializer shows it: the choices' titles a version had.
function editPollOf(options: string | null): StatusEdit['poll'] {
	return options === null ? null : { options: (JSON.parse(options) as string[]).map((title) => ({ title })) }
}

// Edit history, oldest first. A status never edited has one entry: itself. Within ANSWER_BYTES (RES-3): versions are
// admitted newest first, each read when it is reached, and the older ones past the first that does not fit are left
// out.
export const statusHistory = optionalUserReadOperation<{ id: string; present: Present }, Viewed<StatusEdit[]>>(
	(db, { id, present }, viewer) => {
		const { accountId: viewerId } = viewer
		const resolved = viewable(db, viewerId, id)
		const status = resolved === null ? null : presentStatus(db, resolved, { ...present, viewer })
		if (resolved === null || status === null) {
			return { status: 'not_found' }
		}
		const edits = db.all<{ id: string }>(
			'SELECT CAST(e.id AS TEXT) AS id FROM status_edits e WHERE e.status_id = ? ORDER BY e.id DESC',
			resolved
		)
		if (edits.length === 0) {
			return {
				status: 'ok',
				value: [
					{
						content: status.content ?? '',
						spoiler_text: status.spoiler_text,
						sensitive: status.sensitive,
						created_at: status.created_at,
						account: status.account,
						poll: status.poll === null ? null : { options: status.poll.options.map(({ title }) => ({ title })) },
						media_attachments: status.media_attachments,
						emojis: status.emojis,
					},
				],
			}
		}
		const { account } = status
		function* newestFirst(): Generator<StatusEdit | undefined> {
			for (const { id: editId } of edits) {
				const edit = db.first<{
					content: string
					spoiler_text: string
					sensitive: number
					media_json: string
					poll_options: string | null
					created_at: string
					emojis: string | null
				}>(
					`SELECT content, spoiler_text, sensitive, ${editMediaSql('media_json')} AS media_json, poll_options, created_at,
						emojis
					FROM status_edits WHERE id = CAST(? AS INTEGER)`,
					editId
				)
				yield edit === undefined
					? undefined
					: {
							content: edit.content,
							spoiler_text: edit.spoiler_text,
							sensitive: edit.sensitive === 1,
							created_at: edit.created_at,
							account,
							poll: editPollOf(edit.poll_options),
							media_attachments: JSON.parse(edit.media_json) as MediaAttachment[],
							emojis: presentEmojis(edit.emojis, STATUS_EMOJIS_BYTES),
						}
			}
		}
		return { status: 'ok', value: admit(newestFirst(), ARRAY_ANSWER_BYTES, true).items.toReversed() }
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
					`SELECT id, source_text, content, spoiler_text
					FROM statuses WHERE id = ? AND account_id = ? AND reblog_of_id IS NULL`,
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

// The status `id` as the response to the viewer's action on it, if they may see it.
export function presented(db: Db, id: string, viewer: UserContext, present: Present): Viewed<Status> {
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
		// A local favourite's own Like id (favourites.uri: docs/dump-format.md).
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
	// The local favourite's own Like id (favourites.uri; see favourite), for its Undo.
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
		// R32: the streaming delete of the boost, captured before it goes.
		streamDelete(db, own.id, input.now)
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
// listed (Mastodon's RebloggedByAccountsController); reblogs_count still counts every boost, as Mastodon's does.
// Favourites page by the favourite's id; boosts by the boost's status id. A page applies R12 to a window of
// readWindow(limit) of the status's favourites or public and unlisted boosts from the cursor (windows.ts), through
// favourites_status and statuses_reblogged_by (migration 0043). An account that blocks the viewer is never a
// candidate (docs/visibility.md "Read bounds").
export const interactors = optionalUserReadOperation<InteractorsInput, Viewed<Page<Account>>>(
	(db, { id, kind, page, present }, { accountId: viewerId, now }) => {
		const resolved = viewable(db, viewerId, id)
		const target = resolved === null ? null : originalId(db, resolved)
		if (target === null) {
			return { status: 'not_found' }
		}
		const ascending = page.minId !== undefined
		const order = ascending ? 'ASC' : 'DESC'
		const lower = page.minId ?? page.sinceId ?? null
		const size = readWindow(page.limit)
		const window =
			kind === 'favourited_by'
				? singleWindow(
						db,
						`SELECT CAST(f.id AS TEXT) AS id FROM favourites f WHERE f.status_id = ?1 AND ${edgeRangeSql('f.id', '?2', '?3')}
							AND NOT ${blocksSql('f.account_id', '?5')}
						ORDER BY f.id ${order} LIMIT ?4`,
						size,
						target,
						page.maxId ?? null,
						lower,
						size,
						viewerId
					)
				: singleWindow(
						db,
						`SELECT r.id FROM statuses r WHERE r.reblog_of_id = ?1 AND r.visibility IN ${DISTRIBUTABLE_SQL}
							AND r.id < ?2 AND r.id > ?3 AND NOT ${blocksSql('r.account_id', '?5')}
						ORDER BY r.id ${order} LIMIT ?4`,
						size,
						target,
						statusCursor(page.maxId) ?? ':',
						statusCursor(lower ?? undefined) ?? '',
						size,
						viewerId
					)
		const edge =
			kind === 'favourited_by'
				? `favourites e ON e.id = CAST(json_extract(c.value, '$.id') AS INTEGER)`
				: `statuses e ON e.id = json_extract(c.value, '$.id')`
		const rows =
			window.candidates.length === 0
				? []
				: db.all<{ cursor: string; id: string }>(
						`SELECT CAST(e.id AS TEXT) AS cursor, a.id
						FROM json_each(?3) c CROSS JOIN ${edge}
							JOIN accounts a ON a.id = e.account_id
						WHERE ${listedForSql('a.id', '?1', '?2')}`,
						viewerId,
						now,
						windowJson(window)
					)
		const shown = windowPage(window, rows, (row) => row.cursor, page.limit, ascending)
		return {
			status: 'ok',
			value: accountPage(db, shown, ascending, (row) => row.cursor, present),
		}
	}
)

// ---------------------------------------------------------------------------------------------------------------
// Quotes of a status
// ---------------------------------------------------------------------------------------------------------------

export type StatusQuotesInput = { id: string; page: PageQuery; present: Present }

// A page of the quotes list, and how many candidates its window held: the next page is offered when the window was
// full, whatever the rule left of it.
export type QuotesPage = Page<Status> & { candidates: number }

// GET /api/v1/statuses/:id/quotes (Api::V1::Statuses::QuotesController#index, R35): app tokens read as anonymous,
// as Mastodon requires no user. R3 guards the target. Accepted quotes, newest first, paged by the quoting status's id
// (Kopje's quote key), not Mastodon's quote id. One acceptedQuoteWindow seek reads at most `limit` candidates, then R8
// applies, or R2 for the quoted author, quotes of accounts they block or mute included (Mastodon skips StatusFilter for
// them). Bounds are the window's, so short or empty pages still advance. For anyone but the quoted author, a quoting
// status their audience hides is never a candidate, so its id is never a cursor: Kopje's rule, stricter than
// Mastodon's QuotesController, which paginates every accepted quote before StatusFilter. A page is one answer within
// ANSWER_BYTES (RES-3, admittedPage).
export const statusQuotes = optionalUserReadOperation<StatusQuotesInput, Viewed<QuotesPage>>(
	(db, { id, page, present }, viewer) => {
		const { accountId } = viewer
		const resolved = viewable(db, accountId, id)
		const quoted =
			resolved === null
				? undefined
				: db.first<{ account_id: string }>('SELECT account_id FROM statuses WHERE id = ?', resolved)
		if (resolved === null || quoted === undefined) {
			return { status: 'not_found' }
		}
		const ascending = page.minId !== undefined
		const window = acceptedQuoteWindow(
			db,
			resolved,
			{ max: statusCursor(page.maxId), min: statusCursor(page.minId ?? page.sinceId), ascending },
			page.limit,
			...(accountId !== null && quoted.account_id === accountId ? [] : [accountId])
		)
		if (ascending) {
			window.reverse()
		}
		const select = { where: 's.id IN (SELECT value FROM json_each(?2))', tail: 'ORDER BY s.id DESC' }
		const rows =
			accountId !== null && quoted.account_id === accountId
				? statusReads(viewer, { viewer: '?1' }).select(db, 'visible', select, accountId, JSON.stringify(window))
				: statusReads(viewer, { viewer: '?1', now: '?3' }).select(
						db,
						'listable',
						select,
						accountId,
						JSON.stringify(window),
						viewer.now
					)
		const shared = presentation(
			db,
			rows.map((row) => row.id),
			{ ...present, viewer }
		)
		const shown = admittedPage(
			{ rows, newest: window[0] ?? null, oldest: window.at(-1) ?? null },
			ascending,
			(row) => row.id,
			(traversal) =>
				presentStatusesWithin(
					db,
					shared,
					traversal.map((row) => row.id),
					ARRAY_ANSWER_BYTES,
					true
				)
		)
		// A page cut by the answer budget offers next whatever it holds (pageResponse's count).
		return {
			status: 'ok',
			value: { ...shown, candidates: shown.cut === true ? page.limit : window.length },
		}
	}
)

// ---------------------------------------------------------------------------------------------------------------
// Revoking a quote (Api::V1::Statuses::QuotesController#revoke, RevokeQuoteService; design §5.5, VIS-28)
// ---------------------------------------------------------------------------------------------------------------

export type RevokeTarget = { id: string; quotingId: string }

// What the Worker signs before the revoke is recorded; a null authorization means no stamp Delete to sign.
export type RevokePreparation = {
	authorization: string | null
	sign: { activity: Record<string, unknown>; keyId: string; key: StoredKey } | null
}

// The quote of `quotingId` on the viewer's own status `id`: R3 on `id` (else not found), a quote of it by that status
// (else not found), the viewer's own (else forbidden), as QuotesController checks them.
function ownQuote(db: Db, accountId: string, target: RevokeTarget) {
	const visible = viewable(db, accountId, target.id)
	const quote = visible === null ? undefined : revocableQuote(db, visible, target.quotingId)
	if (visible === null || quote === undefined) {
		return { status: 'not_found' } as const
	}
	const author = db.first<{ account_id: string; uri: string }>(
		'SELECT s.account_id, a.uri FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?',
		visible
	)
	if (author === undefined || author.account_id !== accountId) {
		return { status: 'forbidden' } as const
	}
	return { status: 'ok', quoted: visible, authorUri: author.uri, quote } as const
}

// The first step of a revoke, a read: the authorization to retire and, for one, the stamp Delete the Worker LD-signs
// with the author's key (federation/ld-sign.ts) before the second step records it. Signing once, before recording,
// keeps the Store free of keys (DATA-1) and gives every destination one body.
export const prepareRevoke = userReadOperation<RevokeTarget, Acted<RevokePreparation>>((db, target, { accountId }) => {
	const own = ownQuote(db, accountId, target)
	if (own.status !== 'ok') {
		return own
	}
	const authorization = own.quote.state === 'accepted' ? own.quote.authorizationId : null
	const key = authorization === null ? null : accountKey(db, accountId)
	return {
		status: 'ok',
		value: {
			authorization,
			sign:
				authorization === null || key === null
					? null
					: {
							activity: stampDeleteActivity(own.authorUri, stampUri(own.authorUri, authorization)),
							keyId: `${own.authorUri}#main-key`,
							key,
						},
		},
	}
})

// A Status as the revoke answers it to a revoker who may not see the quoting status (its author blocks them): only
// what the request and the revoker's own quotes list already named (id, uri, created_at), the author as the account
// presenter shows them, the visibility as the API spells it, the quote's new state, and nothing else (design §5.5:
// every field Android's Status.postprocess requires is present, every other empty, zero, false or null).
export type RedactedStatus = Omit<Status, 'quote_approval' | 'quote'> & {
	quote: { state: QuoteState; quoted_status: null }
	quote_approval: null
}

function redactedStatus(db: Db, quotingId: string, state: QuoteState, present: Present): RedactedStatus | null {
	const row = db.first<{ id: string; uri: string; account_id: string; visibility: Visibility; published_at: string }>(
		`SELECT id, ${statusUriSql('uri')} AS uri, account_id, visibility, published_at FROM statuses WHERE id = ?`,
		quotingId
	)
	const account = row === undefined ? undefined : presentAccountById(db, row.account_id, present)
	if (row === undefined || account === undefined) {
		return null
	}
	return {
		id: row.id,
		created_at: row.published_at,
		in_reply_to_id: null,
		in_reply_to_account_id: null,
		sensitive: false,
		spoiler_text: '',
		visibility: apiVisibility(row.visibility),
		language: null,
		uri: row.uri,
		url: row.uri,
		replies_count: 0,
		reblogs_count: 0,
		favourites_count: 0,
		quotes_count: 0,
		edited_at: null,
		favourited: false,
		reblogged: false,
		muted: false,
		bookmarked: false,
		filtered: [],
		content: '',
		reblog: null,
		account,
		media_attachments: [],
		mentions: [],
		tags: [],
		emojis: [],
		quote: { state, quoted_status: null },
		quote_approval: null,
		card: null,
		poll: null,
	}
}

export type RevokeInput = RevokeTarget & {
	// The authorization the preparation saw, and the stamp Delete the Worker signed for it (null with none).
	expected: string | null
	signed: Record<string, unknown> | null
	now: number
	present: Present
}

// stale: the authorization changed since preparation; the Worker prepares again.
export type RevokeResult = Acted<Status | RedactedStatus> | { status: 'stale' }

// The second step of a revoke, one transaction (Quote#reject!, RevokeQuoteService): accepted becomes revoked and
// pending rejected only while the quote still holds the prepared authorization (the trigger retires it), so of two
// concurrent revokes one changes it and the other answers as a repeated revoke does, recording nothing. The one that
// changes it records, for an authorization, the signed Delete as an immutable envelope from the quoted author to the
// quoting author, reaching the receipts and current audience of the quoted status (its quoters included) and, when the
// quoting status is local, of that status too, each resolved under its own owner (RevokeQuoteService sends to the
// reach of both); then a Reject of every request answered for the quote, by id, in the same lane after the Delete, so
// a receiver that applies the Delete before an earlier Accept still ends rejected (design, Concurrency: changes 2 and
// 6). Always answered 200 once applied: the quoting status as presented, or redacted when the revoker may not see it.
export const revokeQuote = userWriteOperation<RevokeInput, RevokeResult>((db, input, { accountId }, viewer) => {
	const own = ownQuote(db, accountId, input)
	if (own.status !== 'ok') {
		return own
	}
	const { quote, quoted, authorUri } = own
	let state = quote.state
	const revocable = quote.state === 'accepted' || quote.state === 'pending'
	if (revocable && quote.authorizationId !== input.expected) {
		return { status: 'stale' }
	}
	if (revocable) {
		const stamp = input.expected === null ? null : stampUri(authorUri, input.expected)
		const signed = input.signed
		if (
			stamp !== null &&
			(signed === null ||
				signed.type !== 'Delete' ||
				signed.id !== `${stamp}#delete` ||
				signed.actor !== authorUri ||
				signed.object !== stamp)
		) {
			return { status: 'invalid', error: 'The revocation could not be signed' }
		}
		state = revokeQuoteRow(db, input.quotingId, quoted, input.expected, input.now) ?? state
		if (signed !== null) {
			const reach = [statusReach(db, quoted), statusReach(db, input.quotingId)].filter((r) => r !== null)
			recordOutbound(
				db,
				accountId,
				{
					activity: signed,
					audience: { followers: false, accounts: [quote.quotingAuthorId] },
					immutable: true,
					reachOf: reach,
				},
				input.now
			)
		}
		for (const request of answeredRequests(db, quote.quotingUri, quoted, quote.quotingAuthorUri, input.now)) {
			recordOutbound(
				db,
				accountId,
				revocationRejectActivity(authorUri, { id: request, actorId: quote.quotingAuthorId }),
				input.now,
				{ withdraws: true }
			)
		}
	}
	const visible = viewableStatusId(db, accountId, input.quotingId)
	const value =
		visible === null
			? redactedStatus(db, input.quotingId, state, input.present)
			: presentStatus(db, visible, { ...input.present, viewer })
	return viewed<Status | RedactedStatus>(value)
})

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
