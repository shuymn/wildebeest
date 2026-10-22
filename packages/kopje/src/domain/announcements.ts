import { accountUrl, acctOf } from './accounts'
import { accessAdminRefusal } from './admin-authority'
import { admit, ARRAY_ANSWER_BYTES, jsonBytes, unitJsonBytes } from './answer-budget'
import { announcementShownSql, availableSql } from './audience'
import { tokenUserReadOperation, userWriteOperation } from './auth'
import {
	type CustomEmoji,
	emojiHref,
	// A time as the CHECKs of 0056 accept it (24 bytes, hour 00 to 23, read back by Date as itself), which the Worker
	// makes with parseScheduledAt and toISOString.
	emojiInstant,
	localEmojiSnapshot,
	MAX_LOCAL_EMOJI_NAMES,
	presentEmojis,
} from './custom-emojis'
import { allocateLocalId } from './ids'
import { logAction, MODERATION_LOG_PRUNE } from './moderation-log'
import { readOperation, writeOperation } from './operation'
import { ACTOR_URI_LIMIT, actorUriSql, PROFILE_URL_LIMIT, USERNAME_LIMIT, usernameSql } from './profile-bounds'
import { instanceOrigin } from './push'
import { MAX_TAG_LENGTH, TAG_NAME_BYTES } from './status-bounds'
import {
	isHashtagName,
	MAX_RAW_LENGTH,
	mentionKey,
	type MentionRef,
	type MentionTarget,
	parseStatusText,
	renderSegmentHtml,
	renderStatusHtml,
	type Segment,
} from './status-text'
import { streamAnnouncement } from './streaming'
import { type Db, ROW_OBJECT_BYTES, RowCapExceeded, RowMeter, VALUE_BYTES } from '../db/sql'
import { isUnicodeEmoji } from '../platform/emoji-names'
import { railsBlank } from '../platform/rails-blank'
import type { ImportAuthority } from '../platform/store-admin'
import {
	ANNOUNCEMENT_TEXT_BYTES,
	EMOJI_SHORTCODE_LIMIT,
	LOCAL_EMOJI_SHORTCODE,
	MAX_ANNOUNCEMENTS,
	MAX_LIVE_ANNOUNCEMENTS,
	MAX_REACTION_NAMES,
	MEDIA_URL_LIMIT,
	REACTION_NAME_BYTES,
	STATUS_EMOJIS_BYTES,
	storedAnnouncementText,
} from '../platform/stored-bounds'
import { cutCodeUnits } from '../security/html'

// Announcements (migration 0056_announcements), as Mastodon 4.5 serves them. The only module that reads or writes
// announcements, announcement_reactions and announcement_dismissals (test-node/policy-boundary.test.ts).
// Rules: R40 (docs/visibility.md), AUTH-5, HTML-2 and RES-3 (docs/threat-model.md), MD-4 (docs/mastodon-deviations.md).

// The content's JSON, quotes included, in UTF-8 bytes. An admin write whose rendering passes it is refused; a stored
// row whose rendering passes it later (a mentioned account's url grew) presents its text escaped, with no link.
export const ANNOUNCEMENT_CONTENT_BYTES = 65_536
// Distinct mention references looked up per announcement, and resolved accounts kept (and linked).
export const MAX_MENTION_REFS = 64
export const MAX_ANNOUNCEMENT_MENTIONS = 16
// Accounts of one handle (domain and lowercased username) a reference judges at most, and the longest domain looked up
// (an actor id of ACTOR_URI_LIMIT bytes, less "https://").
export const MENTION_CANDIDATES = 8
export const MENTION_DOMAIN_BYTES = ACTOR_URI_LIMIT - 'https://'.length
// Row heap derived from stored column caps (RES-3), verified by test/announcement-bounds.test.ts.
const ROW = (values: number, units: number) => ROW_OBJECT_BYTES + VALUE_BYTES * values + 2 * units
const LIST_ROWS_HEAP =
	MAX_LIVE_ANNOUNCEMENTS * ROW(10, 18 + ANNOUNCEMENT_TEXT_BYTES + 6 * 24) + MAX_LIVE_ANNOUNCEMENTS * ROW(1, 18)
const PRESENTATION_ROWS_HEAP =
	MAX_MENTION_REFS * ROW(6, 18 + USERNAME_LIMIT + MENTION_DOMAIN_BYTES + PROFILE_URL_LIMIT + ACTOR_URI_LIMIT) +
	MAX_LOCAL_EMOJI_NAMES * ROW(3, EMOJI_SHORTCODE_LIMIT + MEDIA_URL_LIMIT) +
	MAX_REACTION_NAMES * ROW(4, REACTION_NAME_BYTES + MEDIA_URL_LIMIT)
// The RowMeter caps of the list's reads and of one presentation's; tests lower them to see the backstop act.
export const ANNOUNCEMENT_ROW_CAPS = { list: LIST_ROWS_HEAP, presentation: PRESENTATION_ROWS_HEAP }
// Hashtags an announcement presents; the content links every one.
export const MAX_ANNOUNCEMENT_TAGS = 16
// A hashtag name presented: at most MAX_TAG_LENGTH code units and TAG_NAME_BYTES UTF-8 bytes (as status-bounds.ts
// reads a status's).
const ENCODER = new TextEncoder()

export type AnnouncementMention = { id: string; username: string; url: string; acct: string }

// REST::ReactionSerializer: `me` only with a viewer, `url` and `static_url` only for a custom emoji.
export type Reaction = { name: string; count: number; me?: boolean; url?: string; static_url?: string }

export type AnnouncementTag = { name: string; url: string }

// REST::AnnouncementSerializer (app/serializers/rest/announcement_serializer.rb), in its key order; `read` only with a
// viewer. `statuses` is always empty (MD-4).
export type Announcement = {
	id: string
	content: string
	starts_at: string | null
	ends_at: string | null
	all_day: boolean
	published_at: string
	updated_at: string
	read?: boolean
	mentions: AnnouncementMention[]
	statuses: never[]
	tags: AnnouncementTag[]
	emojis: CustomEmoji[]
	reactions: Reaction[]
}

// The Access admin's view of an announcement, published or not.
export type AdminAnnouncement = {
	id: string
	text: string
	published: boolean
	published_at: string | null
	scheduled_at: string | null
	starts_at: string | null
	ends_at: string | null
	all_day: boolean
	created_at: string
	updated_at: string
}

type AnnouncementRow = {
	id: string
	text: string
	starts_at: string | null
	ends_at: string | null
	all_day: number
	published: number
	published_at: string | null
	scheduled_at: string | null
	created_at: string
	updated_at: string
}

const COLUMNS = 'id, text, starts_at, ends_at, all_day, published, published_at, scheduled_at, created_at, updated_at'

type MentionRow = { i: number; id: string; username: string; domain: string | null; url: string | null; uri: string }

// The accounts of the first MAX_MENTION_REFS distinct references, each the first available account (R1) of its
// username and domain (none: the instance's own host, as statuses.ts resolves mentions), in reference order, at most
// MAX_ANNOUNCEMENT_MENTIONS accounts. One query: each reference reads at most MENTION_CANDIDATES rows of
// accounts_domain_username (the lowest rowids of its handle; the row past them bounds the seek), and only those are
// judged by R1, so a handle shared by any number of unavailable accounts costs the same; when all of them are
// unavailable it stays text. Its account is read by rowid. A domain past MENTION_DOMAIN_BYTES names no account (an
// actor id holds at most ACTOR_URI_LIMIT bytes), so it is not looked up.
function resolveMentions(db: Db, refs: readonly MentionRef[], origin: string): Map<string, MentionRow> {
	const host = new URL(origin).host
	const wanted = refs
		.slice(0, MAX_MENTION_REFS)
		.flatMap((ref, i) =>
			ref.domain !== null && ENCODER.encode(ref.domain).length > MENTION_DOMAIN_BYTES
				? []
				: [{ i, u: ref.username.toLowerCase(), d: ref.domain === null || ref.domain === host ? null : ref.domain }]
		)
	if (wanted.length === 0) {
		return new Map()
	}
	const handle = (t: string) =>
		`${t}.domain IS json_extract(j.value, '$.d') AND lower(${t}.username) = json_extract(j.value, '$.u')`
	const rows = db
		.all<MentionRow>(
			`SELECT json_extract(j.value, '$.i') AS i, a.id, ${usernameSql('a.username')} AS username, a.domain, a.url,
				${actorUriSql('a.uri')} AS uri
			FROM json_each(?1) j CROSS JOIN accounts a
			ON a.rowid = (SELECT b.rowid FROM accounts b INDEXED BY accounts_domain_username
				WHERE ${handle('b')} AND b.rowid < coalesce((SELECT c.rowid FROM accounts c INDEXED BY accounts_domain_username
						WHERE ${handle('c')} ORDER BY c.rowid LIMIT 1 OFFSET ${MENTION_CANDIDATES}), 9223372036854775807)
					AND ${availableSql('b.id')}
				ORDER BY b.rowid LIMIT 1)`,
			JSON.stringify(wanted)
		)
		.sort((a, b) => a.i - b.i)
	// Two references may name one account (@alice and @alice@<this host>): it is linked for both, counted once.
	const kept = new Map<string, MentionRow>()
	const accounts = new Set<string>()
	for (const row of rows) {
		if (!accounts.has(row.id) && accounts.size === MAX_ANNOUNCEMENT_MENTIONS) {
			continue
		}
		accounts.add(row.id)
		kept.set(mentionKey(refs[row.i]!), row)
	}
	return kept
}

// Incremental JSON size of renderStatusHtml output, matching its paragraph and trimming semantics.
// The bound grows monotonically and is exact after the final piece, without joining the pieces.
class ContentMeter {
	#kept = 2
	#begun = false
	#trailing = 0
	#newlines = 0

	get bound(): number {
		return this.#kept + (this.#begun ? 7 : 0)
	}

	feed(piece: string): void {
		for (let i = 0; i < piece.length; i++) {
			const c = piece.charCodeAt(i)
			if (c === 0x0a) {
				this.#newlines++
				if (this.#newlines === 2) {
					this.#kept += this.#begun ? 7 : 0
					this.#begun = false
					this.#trailing = 0
				} else if (this.#newlines === 1 && this.#begun) {
					this.#trailing += 6
				}
				continue
			}
			this.#newlines = 0
			const pair = c >= 0xd800 && c <= 0xdbff && (piece.charCodeAt(i + 1) & 0xfc00) === 0xdc00
			const bytes = pair ? 4 : unitJsonBytes(c)
			if (pair) {
				i++
			} else if (WHITE.test(piece[i]!)) {
				if (this.#begun) {
					this.#trailing += bytes
				}
				continue
			}
			this.#begun = true
			this.#kept += this.#trailing + bytes
			this.#trailing = 0
		}
	}
}

// JavaScript's trim set (WhiteSpace and LineTerminator), one code unit.
const WHITE = /^\s$/

// The content of a text's segments within ANNOUNCEMENT_CONTENT_BYTES as JSON, and whether it is the linked rendering
// (renderStatusHtml). Each segment's inline HTML is built and measured on its own (ContentMeter), and the rendering
// stops at the first segment that passes the budget, so what is built past the budget is at most one segment (the
// largest, a hashtag of 3,333 U+FDFA, is 310,064 bytes of JSON). Within the budget the content is built whole, at most
// the budget once trimmed; past it the text is escaped instead, at most 60,009 bytes.
function renderContent(
	segments: readonly Segment[],
	options: Parameters<typeof renderStatusHtml>[1]
): { content: string; linked: boolean } {
	const fallback = () => renderStatusHtml([{ kind: 'text', text: segments.map((s) => s.text).join('') }], options)
	const meter = new ContentMeter()
	for (const segment of segments) {
		meter.feed(renderSegmentHtml(segment, options))
		if (meter.bound > ANNOUNCEMENT_CONTENT_BYTES) {
			return { content: fallback(), linked: false }
		}
	}
	const content = renderStatusHtml(segments, options)
	return jsonBytes(content) <= ANNOUNCEMENT_CONTENT_BYTES
		? { content, linked: true }
		: { content: fallback(), linked: false }
}

// The JSON size ContentMeter gives a text's linked rendering with no mention resolved (tests compare it with
// renderStatusHtml's).
export function meteredContentBytes(segments: readonly Segment[], options: Parameters<typeof renderStatusHtml>[1]) {
	const meter = new ContentMeter()
	for (const segment of segments) {
		meter.feed(renderSegmentHtml(segment, options))
	}
	return meter.bound
}

type Rendered = { content: string; linked: boolean; mentions: AnnouncementMention[]; tags: AnnouncementTag[] }

// The text's content, mentions and hashtags as presented on `origin`. The text is within MAX_RAW_LENGTH as stored
// (ANNOUNCEMENT_TEXT_BYTES); the cut only keeps the presenter from throwing on anything else.
function render(db: Db, text: string, origin: string): Rendered {
	const parsed = parseStatusText(cutCodeUnits(text, MAX_RAW_LENGTH))
	const resolved = resolveMentions(db, parsed.mentions, origin)
	const tagUrl = (name: string) => `${origin}/tags/${encodeURIComponent(name)}`
	const { content, linked } = renderContent(parsed.segments, {
		mention: (ref): MentionTarget | undefined => {
			const row = resolved.get(mentionKey(ref))
			return row === undefined ? undefined : { url: accountUrl(row, origin), username: row.username }
		},
		tagUrl,
	})
	const tags = parsed.tags
		.filter(
			(name) => name.length <= MAX_TAG_LENGTH && ENCODER.encode(name).length <= TAG_NAME_BYTES && isHashtagName(name)
		)
		.slice(0, MAX_ANNOUNCEMENT_TAGS)
		.map((name) => ({ name, url: tagUrl(name) }))
	const mentions = [...new Map([...resolved.values()].map((row) => [row.id, row])).values()].map((row) => ({
		id: row.id,
		username: row.username,
		url: accountUrl(row, origin),
		acct: acctOf(row),
	}))
	return { content, linked, mentions, tags }
}

type ReactionRow = { name: string; count: number; me: number | null; url: string | null }

// The reactions of an announcement grouped by name (Mastodon groups by name and emoji; a replaced emoji's reactions
// keep one entry here), in order of each name's first reaction, with the first reaction's emoji image (a disabled
// emoji's included). Ids and the image stay in SQL, so an imported id past 2^53 keeps its order and image. One seek
// of announcement_reactions_name, at most MAX_REACTION_NAMES groups. `name` narrows it to one name.
function reactionRows(db: Db, announcementId: string, viewer: string | null, name?: string): ReactionRow[] {
	return db.all<ReactionRow>(
		`SELECT g.name, g.count, g.me, m.url FROM
			(SELECT name, count(*) AS count, max(account_id = ?2) AS me, min(id) AS first
				FROM announcement_reactions INDEXED BY announcement_reactions_name
				WHERE announcement_id = ?1${name === undefined ? '' : ' AND name = ?3'} GROUP BY name) g
		JOIN announcement_reactions r ON r.id = g.first
		LEFT JOIN media_attachments m ON m.id = r.custom_emoji_id
		ORDER BY g.first LIMIT ${MAX_REACTION_NAMES}`,
		announcementId,
		viewer,
		...(name === undefined ? [] : [name])
	)
}

function reactionOf(row: ReactionRow, viewer: string | null): Reaction {
	const url = emojiHref(row.url)
	return {
		name: row.name,
		count: row.count,
		...(viewer === null ? {} : { me: row.me === 1 }),
		...(url === null ? {} : { url, static_url: url }),
	}
}

// An announcement as presented to `viewer` (null: the streaming payload, with no `read` or `me`). Never throws on a
// stored row: every part is bounded as presented, whatever was imported.
function presentAnnouncement(
	db: Db,
	row: AnnouncementRow,
	options: { origin: string; viewer: string | null; read?: boolean }
): Announcement {
	const entity = (content: string, parts: Pick<Announcement, 'mentions' | 'tags' | 'emojis' | 'reactions'>) => ({
		id: row.id,
		content,
		starts_at: row.starts_at,
		ends_at: row.ends_at,
		all_day: row.all_day === 1,
		published_at: row.published_at ?? row.created_at,
		updated_at: row.updated_at,
		...(options.viewer === null ? {} : { read: options.read === true }),
		mentions: parts.mentions,
		statuses: [],
		tags: parts.tags,
		emojis: parts.emojis,
		reactions: parts.reactions,
	})
	// The reads' runtime backstop: their row heap is at most ANNOUNCEMENT_ROW_CAPS.presentation by the per-column
	// maxima; past it (only a bound broken elsewhere could), the announcement is shown escaped with nothing read for it.
	const metered = db.metered(new RowMeter(ANNOUNCEMENT_ROW_CAPS.presentation))
	try {
		const { content, mentions, tags } = render(metered, row.text, options.origin)
		return entity(content, {
			mentions,
			tags,
			emojis: presentEmojis(localEmojiSnapshot(metered, [row.text], STATUS_EMOJIS_BYTES), STATUS_EMOJIS_BYTES),
			reactions: reactionRows(metered, row.id, options.viewer).map((r) => reactionOf(r, options.viewer)),
		})
	} catch (error) {
		if (!(error instanceof RowCapExceeded)) {
			throw error
		}
		console.warn({ event: 'kopje.announcements.row-cap-exceeded', id: row.id })
		const text = cutCodeUnits(row.text, MAX_RAW_LENGTH)
		const escaped = renderStatusHtml([{ kind: 'text', text }], { mention: () => undefined, tagUrl: () => '' })
		return entity(escaped, { mentions: [], tags: [], emojis: [], reactions: [] })
	}
}

// Mastodon's Announcement.chronological: coalesce(starts_at, scheduled_at, published_at, created_at), then the id.
function chronological(a: AnnouncementRow, b: AnnouncementRow): number {
	const key = (row: AnnouncementRow) => row.starts_at ?? row.scheduled_at ?? row.published_at ?? row.created_at
	const [x, y] = [key(a), key(b)]
	return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function publishedRow(db: Db, id: string): AnnouncementRow | undefined {
	return /^\d{18}$/.test(id)
		? db.first<AnnouncementRow>(
				`SELECT ${COLUMNS} FROM announcements a WHERE a.id = ? AND ${announcementShownSql('a')}`,
				id
			)
		: undefined
}

// GET /api/v1/announcements: every published announcement (at most MAX_LIVE_ANNOUNCEMENTS, through
// announcements_published), oldest first, each with the viewer's `read` (one query for all) and `me`. Admitted within
// ARRAY_ANSWER_BYTES (a backstop: the maxima of RES-3 never reach it) with no continuation. `with_dismissed` is not
// read, as Mastodon 4.5 reads it no more.
export const listAnnouncements = tokenUserReadOperation<{ origin: string }, Announcement[]>(
	(db, { origin }, viewer) => {
		// The runtime backstop of ANNOUNCEMENT_ROW_CAPS.list: it throws past it, which only a broken stored bound could
		// reach.
		const listing = db.metered(new RowMeter(ANNOUNCEMENT_ROW_CAPS.list))
		const rows = listing
			.all<AnnouncementRow>(
				`SELECT ${COLUMNS} FROM announcements a INDEXED BY announcements_published WHERE ${announcementShownSql('a')}
				LIMIT ${MAX_LIVE_ANNOUNCEMENTS}`
			)
			.sort(chronological)
		const read = new Set(
			listing
				.all<{ id: string }>(
					`SELECT d.announcement_id AS id FROM json_each(?1) j CROSS JOIN announcement_dismissals d
					ON d.account_id = ?2 AND d.announcement_id = j.value`,
					JSON.stringify(rows.map((row) => row.id)),
					viewer.accountId
				)
				.map((row) => row.id)
		)
		function* entries() {
			for (const row of rows) {
				yield presentAnnouncement(db, row, { origin, viewer: viewer.accountId, read: read.has(row.id) })
			}
		}
		return admit(entries(), ARRAY_ANSWER_BYTES, true).items
	}
)

// POST /api/v1/announcements/:id/dismiss (AnnouncementMute.find_or_create_by!): idempotent; not-found unless the
// announcement is published.
export const dismissAnnouncement = userWriteOperation<{ id: string }, 'ok' | 'not-found'>((db, { id }, viewer) => {
	if (publishedRow(db, id) === undefined) {
		return 'not-found'
	}
	db.run(
		'INSERT OR IGNORE INTO announcement_dismissals (account_id, announcement_id) VALUES (?, ?)',
		viewer.accountId,
		id
	)
	return 'ok'
})

export type Reacted = 'ok' | 'not-found' | 'duplicate' | { status: 'invalid'; errors: string[] }

// PUT /api/v1/announcements/:announcement_id/reactions/:name, in Mastodon's order: the published announcement (404),
// presence (a blank name stops there: AnnouncementReaction's presence validation, and ReactionValidator returns early),
// the emoji (an enabled local custom emoji of that shortcode, else a Unicode emoji: isUnicodeEmoji) and the limit of
// MAX_REACTION_NAMES names (a new name past it), both reported together, then the account's repeat of the name
// (the unique index: "Duplicate record"). The `user` stream's announcement.reaction is journaled.
export const reactToAnnouncement = userWriteOperation<{ id: string; name: string }, Reacted>(
	(db, { id, name }, viewer) => {
		if (publishedRow(db, id) === undefined) {
			return 'not-found'
		}
		if (railsBlank(name)) {
			return { status: 'invalid', errors: ["Name can't be blank"] }
		}
		const emoji = LOCAL_EMOJI_SHORTCODE.test(name)
			? db.first<{ id: string }>(
					'SELECT id FROM custom_emojis INDEXED BY custom_emojis_enabled WHERE shortcode = ? AND disabled = 0',
					name
				)
			: undefined
		const errors: string[] = []
		if (emoji === undefined && !isUnicodeEmoji(name)) {
			errors.push('Name is not a recognized emoji')
		}
		const names = db.first<{ known: number; others: number }>(
			`SELECT EXISTS (SELECT 1 FROM announcement_reactions WHERE announcement_id = ?1 AND name = ?2) AS known,
				(SELECT count(DISTINCT name) FROM announcement_reactions WHERE announcement_id = ?1 AND name <> ?2) AS others`,
			id,
			name
		)
		if (names?.known !== 1 && (names?.others ?? 0) >= MAX_REACTION_NAMES) {
			errors.push('Limit of different reactions reached')
		}
		if (errors.length > 0) {
			return { status: 'invalid', errors }
		}
		const repeat = db.first(
			'SELECT 1 AS x FROM announcement_reactions WHERE announcement_id = ? AND name = ? AND account_id = ?',
			id,
			name,
			viewer.accountId
		)
		if (repeat !== undefined) {
			return 'duplicate'
		}
		db.run(
			'INSERT INTO announcement_reactions (announcement_id, account_id, name, custom_emoji_id) VALUES (?, ?, ?, ?)',
			id,
			viewer.accountId,
			name,
			emoji?.id ?? null
		)
		streamAnnouncement(db, 'announcement_reaction', JSON.stringify([id, name]), iso(viewer.now))
		return 'ok'
	}
)

// DELETE /api/v1/announcements/:announcement_id/reactions/:name: the account's reaction of that name on the published
// announcement, else not-found.
export const unreactToAnnouncement = userWriteOperation<{ id: string; name: string }, 'ok' | 'not-found'>(
	(db, { id, name }, viewer) => {
		if (publishedRow(db, id) === undefined) {
			return 'not-found'
		}
		const deleted = db.first(
			'DELETE FROM announcement_reactions WHERE announcement_id = ? AND name = ? AND account_id = ? RETURNING 1 AS x',
			id,
			name,
			viewer.accountId
		)
		if (deleted === undefined) {
			return 'not-found'
		}
		streamAnnouncement(db, 'announcement_reaction', JSON.stringify([id, name]), iso(viewer.now))
		return 'ok'
	}
)

// ---- Streaming (streaming.ts streamUnit): presented with no viewer, as Mastodon's workers render them.

// The `announcement` event of a published announcement; `announcement.delete` (its id) for any other, so the state
// when sent decides (R33, R40).
export function streamedAnnouncement(
	db: Db,
	id: string,
	origin: string
): { event: 'announcement'; payload: Announcement } | { event: 'announcement.delete'; payload: string } {
	const row = publishedRow(db, id)
	return row === undefined
		? { event: 'announcement.delete', payload: id }
		: { event: 'announcement', payload: presentAnnouncement(db, row, { origin, viewer: null }) }
}

export type StreamedReaction = {
	name: string
	count: number
	url?: string
	static_url?: string
	announcement_id: string
}

// The `announcement.reaction` payload of the subject `["<id>","<name>"]` while its announcement is published, with a
// count of 0 and no image once no reaction of the name is left (PublishAnnouncementReactionWorker); null otherwise.
export function streamedAnnouncementReaction(db: Db, subject: string): StreamedReaction | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(subject)
	} catch {
		return null
	}
	if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
		return null
	}
	const [id, name] = parsed as [string, string]
	if (publishedRow(db, id) === undefined) {
		return null
	}
	const [row] = reactionRows(db, id, null, name)
	const reaction = row === undefined ? { name, count: 0 } : reactionOf(row, null)
	return { ...reaction, announcement_id: id }
}

// ---- The Access admin (app/admin.ts): every write checks the admin in its transaction (AUTH-5) and is logged
// (moderation-log.ts, Announcement targets), at the Store's own time (store.ts).

export type AnnouncementRefusal = {
	ok: false
	code:
		| 'wrong-authority'
		| 'invalid-text'
		| 'invalid-times'
		| 'content-too-large'
		| 'announcement-limit'
		| 'announcement-published'
		| 'announcement-not-found'
		| 'announcement-too-large'
	message: string
}

export type AnnouncementWritten = { ok: true; announcement: AdminAnnouncement } | AnnouncementRefusal

function refusal(code: AnnouncementRefusal['code'], message: string): AnnouncementRefusal {
	return { ok: false, code, message }
}

const ACCESS_ONLY = 'only an Access admin manages announcements'

function authorityRefusal(db: Db, authority: ImportAuthority): AnnouncementRefusal | null {
	const refused = accessAdminRefusal(db, authority, ACCESS_ONLY)
	return refused === null && authority.kind === 'access' ? null : refusal('wrong-authority', refused ?? ACCESS_ONLY)
}

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

const TEXT_RULE = 'the text is 1 to 10,000 UTF-8 bytes, not blank, with no NUL'
const TIMES_RULE = 'times are ISO 8601; starts and ends are both set or both unset, and the end is not before the start'

function excerpt(text: string): string {
	return cutCodeUnits(text, 200)
}

function adminAnnouncement(row: AnnouncementRow): AdminAnnouncement {
	return {
		id: row.id,
		text: row.text,
		published: row.published === 1,
		published_at: row.published_at,
		scheduled_at: row.scheduled_at,
		starts_at: row.starts_at,
		ends_at: row.ends_at,
		all_day: row.all_day === 1,
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

function rowById(db: Db, id: string): AnnouncementRow | undefined {
	return db.first<AnnouncementRow>(`SELECT ${COLUMNS} FROM announcements WHERE id = ?`, id)
}

// Published plus scheduled: disjoint (announcement_publication), each a covering scan of its partial index, as the
// triggers count them.
function liveCount(db: Db): number {
	return (
		db.first<{ n: number }>(
			`SELECT (SELECT count(*) FROM announcements WHERE published = 1)
				+ (SELECT count(*) FROM announcements WHERE scheduled_at IS NOT NULL) AS n`
		)?.n ?? 0
	)
}

const LIVE_LIMIT = `at most ${MAX_LIVE_ANNOUNCEMENTS} announcements are published or scheduled; unpublish one first`

function rangeRefusal(startsAt: string | null, endsAt: string | null): AnnouncementRefusal | null {
	const times = [startsAt, endsAt].filter((t): t is string => t !== null)
	if (!times.every(emojiInstant) || (startsAt === null) !== (endsAt === null)) {
		return refusal('invalid-times', TIMES_RULE)
	}
	return startsAt !== null && endsAt !== null && endsAt < startsAt ? refusal('invalid-times', TIMES_RULE) : null
}

// Whether the text renders within ANNOUNCEMENT_CONTENT_BYTES on the instance's origin (none set: not judged).
function contentRefusal(db: Db, text: string): AnnouncementRefusal | null {
	const origin = instanceOrigin(db)
	return origin === null || render(db, text, origin).linked
		? null
		: refusal('content-too-large', `the text renders past ${ANNOUNCEMENT_CONTENT_BYTES} bytes of HTML; shorten it`)
}

export type AnnouncementInput = {
	text: string
	startsAt: string | null
	endsAt: string | null
	allDay: boolean
	scheduledAt: string | null
}

// POST /admin/announcements (Admin::AnnouncementsController#create): published now unless scheduledAt is after `now`
// (Announcement#set_published; a past one is cleared), at most MAX_ANNOUNCEMENTS in all and MAX_LIVE_ANNOUNCEMENTS
// live.
export const createAnnouncement = writeOperation<
	AnnouncementInput & { authority: ImportAuthority; now: number },
	AnnouncementWritten
>((db, input) => {
	const refused = authorityRefusal(db, input.authority)
	if (refused !== null) {
		return refused
	}
	const text = storedAnnouncementText(input.text)
	if (text === null) {
		return refusal('invalid-text', TEXT_RULE)
	}
	const ranged = rangeRefusal(input.startsAt, input.endsAt)
	if (ranged !== null || (input.scheduledAt !== null && !emojiInstant(input.scheduledAt))) {
		return ranged ?? refusal('invalid-times', TIMES_RULE)
	}
	if ((db.first<{ n: number }>('SELECT count(*) AS n FROM announcements')?.n ?? 0) >= MAX_ANNOUNCEMENTS) {
		return refusal('announcement-limit', `at most ${MAX_ANNOUNCEMENTS} announcements are kept; delete one first`)
	}
	if (liveCount(db) >= MAX_LIVE_ANNOUNCEMENTS) {
		return refusal('announcement-limit', LIVE_LIMIT)
	}
	const contented = contentRefusal(db, text)
	if (contented !== null) {
		return contented
	}
	const now = iso(input.now)
	const publish = input.scheduledAt === null || input.scheduledAt <= now
	const id = allocateLocalId(db, input.now)
	db.run(
		`INSERT INTO announcements (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		text,
		input.startsAt,
		input.endsAt,
		input.allDay ? 1 : 0,
		publish ? 1 : 0,
		publish ? now : null,
		publish ? null : input.scheduledAt,
		now,
		now
	)
	const actor = input.authority as Extract<ImportAuthority, { kind: 'access' }>
	logAction(db, actor, 'create', { type: 'Announcement', id }, { excerpt: excerpt(text) }, input.now)
	if (publish) {
		streamAnnouncement(db, 'announcement', id, now)
	}
	return { ok: true, announcement: adminAnnouncement(rowById(db, id)!) }
})

// What an update changes: undefined leaves a field as it is, null clears a time.
export type AnnouncementChanges = Partial<AnnouncementInput>

// POST /admin/announcements/:id (Admin::AnnouncementsController#update): the text, the range (judged as it results),
// all-day and, while unpublished, the schedule (a row that becomes scheduled is counted live). published_at is kept;
// updated_at is set. Changing nothing answers the row and logs nothing. A published row's change is streamed.
export const updateAnnouncement = writeOperation<
	{ authority: ImportAuthority; id: string; changes: AnnouncementChanges; now: number },
	AnnouncementWritten
>((db, { authority, id, changes, now }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const row = rowById(db, id)
	if (row === undefined) {
		return refusal('announcement-not-found', `no announcement has id ${id}`)
	}
	const text = changes.text === undefined ? undefined : storedAnnouncementText(changes.text)
	if (text === null) {
		return refusal('invalid-text', TEXT_RULE)
	}
	const startsAt = changes.startsAt === undefined ? row.starts_at : changes.startsAt
	const endsAt = changes.endsAt === undefined ? row.ends_at : changes.endsAt
	const ranged = rangeRefusal(startsAt, endsAt)
	if (ranged !== null) {
		return ranged
	}
	const scheduledAt = changes.scheduledAt === undefined ? row.scheduled_at : changes.scheduledAt
	if (scheduledAt !== null && !emojiInstant(scheduledAt)) {
		return refusal('invalid-times', TIMES_RULE)
	}
	const changed = [
		text !== undefined && text !== row.text ? 'text' : null,
		startsAt !== row.starts_at ? 'startsAt' : null,
		endsAt !== row.ends_at ? 'endsAt' : null,
		changes.allDay !== undefined && changes.allDay !== (row.all_day === 1) ? 'allDay' : null,
		scheduledAt !== row.scheduled_at ? 'scheduledAt' : null,
	].filter((name): name is string => name !== null)
	if (changed.length === 0) {
		return { ok: true, announcement: adminAnnouncement(row) }
	}
	if (changed.includes('scheduledAt')) {
		if (row.published === 1) {
			return refusal('announcement-published', 'a published announcement has no schedule; unpublish it first')
		}
		if (row.scheduled_at === null && liveCount(db) >= MAX_LIVE_ANNOUNCEMENTS) {
			return refusal('announcement-limit', LIVE_LIMIT)
		}
	}
	if (text !== undefined && text !== row.text) {
		const contented = contentRefusal(db, text)
		if (contented !== null) {
			return contented
		}
	}
	// The text is bound only when the change names one: a stored value is kept in SQL, never read and bound again.
	const at = iso(now)
	db.run(
		`UPDATE announcements SET text = CASE WHEN ?1 THEN ?2 ELSE text END, starts_at = ?3, ends_at = ?4,
			all_day = coalesce(?5, all_day), scheduled_at = ?6, updated_at = ?7
		WHERE id = ?8`,
		changed.includes('text') ? 1 : 0,
		changed.includes('text') ? (text ?? null) : null,
		startsAt,
		endsAt,
		changes.allDay === undefined ? null : changes.allDay ? 1 : 0,
		scheduledAt,
		at,
		id
	)
	const actor = authority as Extract<ImportAuthority, { kind: 'access' }>
	logAction(db, actor, 'update', { type: 'Announcement', id }, { excerpt: excerpt(text ?? row.text), changed }, now)
	if (row.published === 1) {
		streamAnnouncement(db, 'announcement', id, at)
	}
	return { ok: true, announcement: adminAnnouncement(rowById(db, id)!) }
})

// POST /admin/announcements/:id/publish (Announcement#publish!): published now, its schedule cleared, even when it
// was published already; counted live when it was not.
export const publishAnnouncement = writeOperation<
	{ authority: ImportAuthority; id: string; now: number },
	AnnouncementWritten
>((db, { authority, id, now }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const row = rowById(db, id)
	if (row === undefined) {
		return refusal('announcement-not-found', `no announcement has id ${id}`)
	}
	if (row.published === 0 && row.scheduled_at === null && liveCount(db) >= MAX_LIVE_ANNOUNCEMENTS) {
		return refusal('announcement-limit', LIVE_LIMIT)
	}
	const at = iso(now)
	db.run(
		'UPDATE announcements SET published = 1, published_at = ?1, scheduled_at = NULL, updated_at = ?1 WHERE id = ?2',
		at,
		id
	)
	const actor = authority as Extract<ImportAuthority, { kind: 'access' }>
	logAction(db, actor, 'publish', { type: 'Announcement', id }, { excerpt: excerpt(row.text) }, now)
	streamAnnouncement(db, 'announcement', id, at)
	return { ok: true, announcement: adminAnnouncement(rowById(db, id)!) }
})

// POST /admin/announcements/:id/unpublish (Announcement#unpublish!): unpublished, its schedule cleared; streamed as
// announcement.delete when it was published.
export const unpublishAnnouncement = writeOperation<
	{ authority: ImportAuthority; id: string; now: number },
	AnnouncementWritten
>((db, { authority, id, now }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const row = rowById(db, id)
	if (row === undefined) {
		return refusal('announcement-not-found', `no announcement has id ${id}`)
	}
	const at = iso(now)
	db.run('UPDATE announcements SET published = 0, scheduled_at = NULL, updated_at = ? WHERE id = ?', at, id)
	const actor = authority as Extract<ImportAuthority, { kind: 'access' }>
	logAction(db, actor, 'unpublish', { type: 'Announcement', id }, { excerpt: excerpt(row.text) }, now)
	if (row.published === 1) {
		streamAnnouncement(db, 'announcement', id, at)
	}
	return { ok: true, announcement: adminAnnouncement(rowById(db, id)!) }
})

export type AnnouncementDeleted = { ok: true; deleted: string } | AnnouncementRefusal

// The rows one delete writes at most (RES-6), counted with total_changes() as a batched delete counts its own: the
// reactions and dismissals (deleted first, so the row's own delete cascades nothing), the row, its log row with the
// rows the log prunes, and its journal row. MAX_REACTION_NAMES + 1 rows per local account: 4,096 holds 453 accounts
// that all reacted with every name; past it the delete is refused before it writes (unpublish it instead).
export const ANNOUNCEMENT_DELETE_ROWS = 4096
const DELETE_ANCILLARY = 1 + 1 + MODERATION_LOG_PRUNE + 1

function totalChanges(db: Db): number {
	return db.first<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0
}

// POST /admin/announcements/:id/delete (Admin::AnnouncementsController#destroy): the row with its reactions and
// dismissals; the log keeps the text's first 200 code units. Streamed as announcement.delete when it was published.
export const deleteAnnouncement = writeOperation<
	{ authority: ImportAuthority; id: string; now: number },
	AnnouncementDeleted
>((db, { authority, id, now }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const row = db.first<{ text: string; published: number }>(
		'SELECT text, published FROM announcements WHERE id = ?',
		id
	)
	if (row === undefined) {
		return refusal('announcement-not-found', `no announcement has id ${id}`)
	}
	// The children, counted up to one past what the budget leaves them, each a seek of its announcement's index.
	const room = ANNOUNCEMENT_DELETE_ROWS - DELETE_ANCILLARY
	const children =
		db.first<{ n: number }>(
			`SELECT (SELECT count(*) FROM (SELECT 1 FROM announcement_reactions INDEXED BY announcement_reactions_name
					WHERE announcement_id = ?1 LIMIT ?2))
				+ (SELECT count(*) FROM (SELECT 1 FROM announcement_dismissals INDEXED BY announcement_dismissals_announcement
					WHERE announcement_id = ?1 LIMIT ?2)) AS n`,
			id,
			room + 1
		)?.n ?? 0
	if (children > room) {
		return refusal(
			'announcement-too-large',
			`it has more reactions and dismissals than one delete removes (${room}); unpublish it instead`
		)
	}
	const start = totalChanges(db)
	db.run('DELETE FROM announcement_reactions WHERE announcement_id = ?', id)
	db.run('DELETE FROM announcement_dismissals WHERE announcement_id = ?', id)
	db.run('DELETE FROM announcements WHERE id = ?', id)
	const actor = authority as Extract<ImportAuthority, { kind: 'access' }>
	logAction(db, actor, 'delete', { type: 'Announcement', id }, { excerpt: excerpt(row.text) }, now)
	if (row.published === 1) {
		streamAnnouncement(db, 'announcement', id, iso(now))
	}
	const written = totalChanges(db) - start
	if (written > ANNOUNCEMENT_DELETE_ROWS) {
		throw new Error(`an announcement delete wrote ${written} rows, past ${ANNOUNCEMENT_DELETE_ROWS}`)
	}
	return { ok: true, deleted: id }
})

export const ADMIN_ANNOUNCEMENT_PAGE = 20
export const MAX_ADMIN_ANNOUNCEMENT_PAGE = 50

// GET /admin/announcements: every announcement, published or not, newest first by id, a primary-key range below
// `before` (none: below ':', which sorts after every digit); next continues it while a page is full.
export const adminAnnouncements = readOperation<
	{ before?: string; limit?: number },
	{ announcements: AdminAnnouncement[]; next: string | null }
>((db, { before, limit }) => {
	const size = Math.min(Math.max(limit ?? ADMIN_ANNOUNCEMENT_PAGE, 1), MAX_ADMIN_ANNOUNCEMENT_PAGE)
	const rows = db.all<AnnouncementRow>(
		`SELECT ${COLUMNS} FROM announcements WHERE id < ?1 ORDER BY id DESC LIMIT ?2`,
		before ?? ':',
		size
	)
	return {
		announcements: rows.map(adminAnnouncement),
		next: rows.length === size ? (rows.at(-1)?.id ?? null) : null,
	}
})

// ---- The cron's round (jobs/scheduled.ts), in one transaction, bounded by the live cap (RES-6).

// Publishes the scheduled announcements due at `now` (published_at = scheduled_at, as Mastodon's 5-minute scheduler
// makes it about; streamed), then takes down the published ones whose ends_at has passed (Mastodon's
// ScheduledStatusesScheduler#unpublish_expired_announcements!: update_all, so updated_at is kept and nothing is
// streamed). Each is at most MAX_LIVE_ANNOUNCEMENTS rows, all that can be live, so one round does all that is due.
export const announcementRound = writeOperation<{ now: number }, { published: number; expired: number }>(
	(db, { now }) => {
		const at = iso(now)
		const due = db.all<{ id: string }>(
			`SELECT id FROM announcements INDEXED BY announcements_scheduled WHERE scheduled_at <= ?1
			ORDER BY scheduled_at, id LIMIT ${MAX_LIVE_ANNOUNCEMENTS}`,
			at
		)
		for (const { id } of due) {
			db.run(
				`UPDATE announcements SET published = 1, published_at = scheduled_at, scheduled_at = NULL, updated_at = ?
				WHERE id = ?`,
				at,
				id
			)
			streamAnnouncement(db, 'announcement', id, at)
		}
		const expired = db.all<{ id: string }>(
			`UPDATE announcements SET published = 0, scheduled_at = NULL
			WHERE id IN (SELECT id FROM announcements INDEXED BY announcements_published
				WHERE published = 1 AND ends_at <= ?1 LIMIT ${MAX_LIVE_ANNOUNCEMENTS})
			RETURNING id`,
			at
		)
		return { published: due.length, expired: expired.length }
	}
)
