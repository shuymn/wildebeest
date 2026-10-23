import { accessAdminRefusal, oauthAdmin } from './admin-authority'
import { admit, ARRAY_ANSWER_BYTES } from './answer-budget'
import { emojiHref, type EmojiTag, emojiTag } from './custom-emojis'
import {
	chargeInstanceTransforms,
	insertReservation,
	mediaTokenTaken,
	TRANSFORMS_PER_UPLOAD,
	WRITE_WINDOW_MS,
} from './media'
import { logAction } from './moderation-log'
import { mediaDeleteOperation, readOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'
import { mediaUrl } from '../platform/media-files'
import type { ImportAuthority } from '../platform/store-admin'
import { MAX_ENABLED_EMOJIS, presentedCategory, storedMediaMeta } from '../platform/stored-bounds'

// Local custom emoji (migration 0055_local_custom_emojis): the Access admin's uploads, changes and listing
// (app/admin.ts /admin/emojis, `kopje-admin emoji`), the public list (GET /api/v1/custom_emojis) and the Emoji object
// (GET /emojis/:id). Snapshots and outbound tags: custom-emojis.ts.
//
// An emoji's image is an upload of the OAuth admin (admin-authority.ts), the account that owns instance data; it is
// refused with `no-oauth-admin` when there is none. The upload goes reserve, re-encode, write, complete
// (mastodon/emoji-upload.ts): reserveEmoji authorizes, checks the shortcode and the cap, charges the transformations
// and inserts the reservation (media.ts insertReservation, processed = 0, so it is never live: liveMediaSql); the
// Worker re-encodes and writes the files; completeEmoji promotes the row in one transaction, kept for good (gc_at
// NULL) with its emoji row, so a completed emoji image never carries a gc_at (MEDIA-2, MEDIA-5). A failure abandons
// the reservation (abandonEmoji), which the sweep then deletes with a tombstone, as any upload's.
//
// Every write checks the Access admin in its transaction (AUTH-5) and logs it (moderation-log.ts, CustomEmoji
// targets). Each runs at the Store's own time (store.ts), so the writer deadline is judged on one clock.

export type AdminEmoji = {
	id: string
	shortcode: string
	url: string
	static_url: string
	// Judged again as decoded (presentedCategory): null when the stored value does not pass.
	category: string | null
	visible_in_picker: boolean
	disabled: boolean
	created_at: string
}

export type EmojiRefusal = {
	ok: false
	code:
		| 'wrong-authority'
		| 'no-oauth-admin'
		| 'shortcode-taken'
		| 'emoji-limit'
		| 'budget-exhausted'
		| 'upload-expired'
		| 'emoji-not-found'
		// The Worker's file token is taken (media.ts mediaTokenTaken): nothing charged or reserved; add it again.
		| 'upload-retry'
	message: string
}

function refusal(code: EmojiRefusal['code'], message: string): EmojiRefusal {
	return { ok: false, code, message }
}

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

const ACCESS_ONLY = 'only an Access admin manages custom emoji'

function authorityRefusal(db: Db, authority: ImportAuthority): EmojiRefusal | null {
	const refused = accessAdminRefusal(db, authority, ACCESS_ONLY)
	return refused === null && authority.kind === 'access' ? null : refusal('wrong-authority', refused ?? ACCESS_ONLY)
}

type EmojiRow = {
	id: string
	shortcode: string
	url: string
	category: string | null
	visible_in_picker: number
	disabled: number
	created_at: string
}

const ADMIN_COLUMNS = `e.id, e.shortcode, m.url, e.category, e.visible_in_picker, e.disabled, e.created_at`

function adminEmoji(row: EmojiRow): AdminEmoji {
	return {
		id: row.id,
		shortcode: row.shortcode,
		url: row.url,
		static_url: row.url,
		category: presentedCategory(row.category),
		visible_in_picker: row.visible_in_picker === 1,
		disabled: row.disabled === 1,
		created_at: row.created_at,
	}
}

function emojiById(db: Db, id: string): AdminEmoji | null {
	const row = db.first<EmojiRow>(
		`SELECT ${ADMIN_COLUMNS} FROM custom_emojis e JOIN media_attachments m ON m.id = e.id WHERE e.id = ?`,
		id
	)
	return row === undefined ? null : adminEmoji(row)
}

function enabledCount(db: Db): number {
	return db.first<{ n: number }>('SELECT count(*) AS n FROM custom_emojis WHERE disabled = 0')?.n ?? 0
}

function enabledId(db: Db, shortcode: string): string | null {
	return (
		db.first<{ id: string }>(
			'SELECT id FROM custom_emojis INDEXED BY custom_emojis_enabled WHERE shortcode = ? AND disabled = 0',
			shortcode
		)?.id ?? null
	)
}

// Whether one more emoji of `shortcode` may be enabled: the shortcode is free (or `replace` disables its holder in the
// same transaction) and the cap holds, net of the row a replace disables.
function placeRefusal(db: Db, shortcode: string, replace: boolean): EmojiRefusal | null {
	const holder = enabledId(db, shortcode)
	if (holder !== null && !replace) {
		return refusal('shortcode-taken', `an enabled emoji is :${shortcode}: (add it with --replace to replace it)`)
	}
	if (enabledCount(db) - (holder === null ? 0 : 1) >= MAX_ENABLED_EMOJIS) {
		return refusal('emoji-limit', `at most ${MAX_ENABLED_EMOJIS} emoji are enabled; disable one first`)
	}
	return null
}

export type EmojiReserved = { ok: true; id: string; deadline: number } | EmojiRefusal

// Step 1 of an upload. `limit` is IMAGES_MONTHLY_TRANSFORMS: the two transformations are charged to the instance's
// budget of the month `now` is in, as the media rebuild charges them (RES-6).
export const reserveEmoji = writeOperation<
	{ authority: ImportAuthority; token: string; shortcode: string; replace: boolean; limit: number; now: number },
	EmojiReserved
>((db, { authority, token, shortcode, replace, limit, now }) => {
	const refused = authorityRefusal(db, authority) ?? placeRefusal(db, shortcode, replace)
	if (refused !== null) {
		return refused
	}
	const owner = oauthAdmin(db)
	if (owner.accountId === null) {
		return refusal('no-oauth-admin', `an emoji's image belongs to the OAuth admin, and there is none (${owner.status})`)
	}
	// The token is judged before the transformations are charged, in this transaction (AM14).
	if (mediaTokenTaken(db, token)) {
		return refusal('upload-retry', 'the upload could not be reserved; add the emoji again')
	}
	if (!chargeInstanceTransforms(db, TRANSFORMS_PER_UPLOAD, limit, now)) {
		return refusal('budget-exhausted', "this server's media processing budget for the month is used up")
	}
	const reserved = insertReservation(db, owner.accountId, token, now)
	if ('retry' in reserved) {
		// Unreachable after the check above, in one transaction; thrown so the charge rolls back with it.
		throw new Error('the reservation token was taken within its transaction')
	}
	return { ok: true, id: reserved.ok, deadline: now + WRITE_WINDOW_MS }
})

type Size = { width: number; height: number }

export type EmojiCompleted = { ok: true; emoji: AdminEmoji } | EmojiRefusal

// Step 3, idempotent: an emoji that exists with this id answers as it is (the first answer may have been lost).
// Otherwise, in one transaction: the reservation is still open (this id and token, processed = 0, within its writer
// deadline at `now`, unattached), the shortcode and cap are judged again, the row is promoted (URLs, type, sizes,
// processed = 1, gc_at NULL), a replaced emoji is disabled, and the emoji row is written and logged. A refusal leaves
// the reservation as it was, for abandonEmoji.
export const completeEmoji = writeOperation<
	{
		authority: ImportAuthority
		id: string
		token: string
		shortcode: string
		category: string | null
		visibleInPicker: boolean
		replace: boolean
		contentType: string
		original: Size
		small: Size
		now: number
	},
	EmojiCompleted
>((db, input) => {
	const refused = authorityRefusal(db, input.authority)
	if (refused !== null) {
		return refused
	}
	const done = emojiById(db, input.id)
	if (done !== null) {
		return { ok: true, emoji: done }
	}
	const row = db.first<{ uri: string }>(
		`SELECT a.uri FROM media_attachments m JOIN accounts a ON a.id = m.account_id
		WHERE m.id = ? AND m.file_token = ? AND m.processed = 0 AND m.created_at > ? AND m.status_id IS NULL
			AND m.scheduled_status_id IS NULL`,
		input.id,
		input.token,
		iso(input.now - WRITE_WINDOW_MS)
	)
	if (row === undefined) {
		return refusal('upload-expired', 'the upload expired before it completed; add the emoji again')
	}
	const placed = placeRefusal(db, input.shortcode, input.replace)
	if (placed !== null) {
		return placed
	}
	const origin = new URL(row.uri).origin
	db.run(
		`UPDATE media_attachments SET url = ?, preview_url = ?, content_type = ?, meta = ?, processed = 1, gc_at = NULL
		WHERE id = ?`,
		mediaUrl(origin, input.token, 'full', input.contentType),
		mediaUrl(origin, input.token, 'small', input.contentType),
		input.contentType,
		storedMediaMeta(JSON.stringify({ original: input.original, small: input.small })),
		input.id
	)
	const actor = input.authority as Extract<ImportAuthority, { kind: 'access' }>
	const replaced = enabledId(db, input.shortcode)
	if (replaced !== null) {
		db.run('UPDATE custom_emojis SET disabled = 1 WHERE id = ?', replaced)
		logAction(db, actor, 'disable', { type: 'CustomEmoji', id: replaced }, { replacedBy: input.id }, input.now)
	}
	db.run(
		`INSERT INTO custom_emojis (id, shortcode, category, visible_in_picker, disabled, created_at)
		VALUES (?, ?, ?, ?, 0, ?)`,
		input.id,
		input.shortcode,
		input.category,
		input.visibleInPicker ? 1 : 0,
		iso(input.now)
	)
	logAction(
		db,
		actor,
		'create',
		{ type: 'CustomEmoji', id: input.id },
		{ shortcode: input.shortcode, ...(replaced === null ? {} : { replaces: replaced }) },
		input.now
	)
	return { ok: true, emoji: emojiById(db, input.id)! }
})

// abandoned: the reservation is doomed (or already was) and its objects may go; kept: the emoji exists or the row
// completed, so its objects stay; gone: no such reservation, so nothing refers to its objects.
export type EmojiAbandoned = 'abandoned' | 'kept' | 'gone' | 'denied'

// A failed emoji upload, as abandonMedia dooms a failed upload: only the reservation of this id and token (the Worker's
// own, so no other upload in flight is touched), refused while the media rebuild holds its lease (a
// mediaDeleteOperation, platform/store-flags.ts).
export const abandonEmoji = mediaDeleteOperation<
	{ authority: ImportAuthority; id: string; token: string; now: number },
	EmojiAbandoned
>((db, { authority, id, token, now }) => {
	if (authorityRefusal(db, authority) !== null) {
		return 'denied'
	}
	const row = db.first<{ processed: number; url: string; emoji: number }>(
		`SELECT processed, url, EXISTS (SELECT 1 FROM custom_emojis e WHERE e.id = m.id) AS emoji
		FROM media_attachments m WHERE id = ? AND file_token = ?`,
		id,
		token
	)
	if (row === undefined) {
		return 'gone'
	}
	if (row.emoji === 1 || (row.processed === 1 && row.url !== '')) {
		return 'kept'
	}
	db.run('UPDATE media_attachments SET processed = 1, gc_at = ? WHERE id = ? AND status_id IS NULL', iso(now), id)
	return 'abandoned'
})

export type EmojiChanges = { category?: string | null; visibleInPicker?: boolean; disabled?: boolean }

export type EmojiUpdated = { ok: true; emoji: AdminEmoji } | EmojiRefusal

// POST /admin/emojis/:id: the category and picker flag (logged `update`), and disabling or enabling (logged `disable`,
// `enable`). Enabling is refused while another emoji of the shortcode is enabled, or at the cap. Changing nothing
// answers the emoji and logs nothing.
export const updateEmoji = writeOperation<
	{ authority: ImportAuthority; id: string; changes: EmojiChanges; now: number },
	EmojiUpdated
>((db, { authority, id, changes, now }) => {
	const refused = authorityRefusal(db, authority)
	if (refused !== null) {
		return refused
	}
	const current = db.first<{ shortcode: string; category: string | null; visible_in_picker: number; disabled: number }>(
		'SELECT shortcode, category, visible_in_picker, disabled FROM custom_emojis WHERE id = ?',
		id
	)
	if (current === undefined) {
		return refusal('emoji-not-found', `no custom emoji has id ${id}`)
	}
	const actor = authority as Extract<ImportAuthority, { kind: 'access' }>
	const target = { type: 'CustomEmoji' as const, id }
	if (changes.disabled === false && current.disabled === 1) {
		const placed = placeRefusal(db, current.shortcode, false)
		if (placed !== null) {
			return placed
		}
		db.run('UPDATE custom_emojis SET disabled = 0 WHERE id = ?', id)
		logAction(db, actor, 'enable', target, { shortcode: current.shortcode }, now)
	} else if (changes.disabled === true && current.disabled === 0) {
		db.run('UPDATE custom_emojis SET disabled = 1 WHERE id = ?', id)
		logAction(db, actor, 'disable', target, { shortcode: current.shortcode }, now)
	}
	// The category is bound only when the change names one: a stored value is kept in SQL, never read into the Worker
	// and bound again (an imported value of malformed UTF-8 would come back as replacement characters, past its CHECK).
	const category = changes.category !== undefined && changes.category !== current.category
	const picker = changes.visibleInPicker === undefined ? current.visible_in_picker : changes.visibleInPicker ? 1 : 0
	if (category || picker !== current.visible_in_picker) {
		db.run(
			`UPDATE custom_emojis SET category = CASE WHEN ?1 THEN ?2 ELSE category END, visible_in_picker = ?3
			WHERE id = ?4`,
			category ? 1 : 0,
			category ? (changes.category ?? null) : null,
			picker,
			id
		)
		logAction(
			db,
			actor,
			'update',
			target,
			{
				shortcode: current.shortcode,
				...(category ? { category: changes.category ?? null } : {}),
				picker: picker === 1,
			},
			now
		)
	}
	return { ok: true, emoji: emojiById(db, id)! }
})

export const ADMIN_EMOJI_PAGE = 100
export const MAX_ADMIN_EMOJI_PAGE = 200

// GET /admin/emojis: every local emoji, enabled and disabled, in id order (oldest first), a primary-key range after
// `after`; next continues it while a page is full.
export const adminEmojis = readOperation<
	{ after?: string; limit?: number },
	{ emojis: AdminEmoji[]; next: string | null }
>((db, { after, limit }) => {
	const size = Math.min(Math.max(limit ?? ADMIN_EMOJI_PAGE, 1), MAX_ADMIN_EMOJI_PAGE)
	const rows = db.all<EmojiRow>(
		`SELECT ${ADMIN_COLUMNS} FROM custom_emojis e JOIN media_attachments m ON m.id = e.id
		WHERE e.id > ?1 ORDER BY e.id LIMIT ?2`,
		after ?? '',
		size
	)
	return { emojis: rows.map(adminEmoji), next: rows.length === size ? (rows.at(-1)?.id ?? null) : null }
})

// REST::CustomEmojiSerializer (app/serializers/rest/custom_emoji_serializer.rb:8-26) of a local emoji: static_url is
// url (Kopje makes no still rendition, an accepted risk), and category only when it passes presentedCategory.
export type ListedEmoji = {
	shortcode: string
	url: string
	static_url: string
	visible_in_picker: true
	category?: string
}

// GET /api/v1/custom_emojis (Mastodon's CustomEmojisController#index: CustomEmoji.listed, local, enabled and visible in
// the picker). In shortcode order, through custom_emojis_enabled (Mastodon's order is unspecified). RES-3: at most
// MAX_ENABLED_EMOJIS rows, each within 1,489 JSON bytes with its separator (docs/threat-model.md), admitted whole
// within ARRAY_ANSWER_BYTES with no continuation; an entry whose url fails emojiHref is left out (HTML-3).
export const customEmojis = readOperation<void, ListedEmoji[]>((db) => {
	const rows = db.all<{ shortcode: string; category: string | null; url: string }>(
		`SELECT e.shortcode, e.category, m.url FROM custom_emojis e INDEXED BY custom_emojis_enabled
		JOIN media_attachments m ON m.id = e.id
		WHERE e.disabled = 0 AND e.visible_in_picker = 1 ORDER BY e.shortcode LIMIT ?`,
		MAX_ENABLED_EMOJIS
	)
	const entries = rows.map((row): ListedEmoji | undefined => {
		const url = emojiHref(row.url)
		if (url === null) {
			return undefined
		}
		const category = presentedCategory(row.category)
		return {
			shortcode: row.shortcode,
			url,
			static_url: url,
			visible_in_picker: true,
			...(category === null ? {} : { category }),
		}
	})
	return admit(entries, ARRAY_ANSWER_BYTES, true).items
})

// GET /emojis/:id (Mastodon's EmojisController#show, CustomEmoji.local.find): any local emoji, disabled ones included,
// as its Emoji object; null for none, or when its url fails emojiHref or its time is not an instant (emojiTag).
export const localEmojiObject = readOperation<{ id: string; origin: string }, EmojiTag | null>((db, { id, origin }) => {
	const row = db.first<{ id: string; shortcode: string; created_at: string; content_type: string; url: string }>(
		`SELECT e.id, e.shortcode, e.created_at, m.content_type, m.url
			FROM custom_emojis e JOIN media_attachments m ON m.id = e.id WHERE e.id = ?`,
		id
	)
	return row === undefined || emojiHref(row.url) !== row.url ? null : emojiTag(origin, row)
})
