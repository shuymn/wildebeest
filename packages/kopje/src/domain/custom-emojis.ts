import type { Db } from '../db/sql'
import { boundedHref } from '../platform/http-url'
import { FILE_TOKEN } from '../platform/media-files'
import {
	EMOJI_ENTRY_BYTES,
	EMOJI_SHORTCODE,
	EMOJI_SHORTCODE_LIMIT,
	EMOJI_URL_LIMIT,
	isEmojiUrl,
	LOCAL_EMOJI_SHORTCODE,
	MAX_EMOJIS,
} from '../platform/stored-bounds'

// Remote custom emoji (RES-2, HTML-3): the snapshot an object's Emoji tags leave in statuses.emojis,
// status_edits.emojis and accounts.emojis, and the CustomEmoji entities presented from it. Bounds, the stored form and
// the triggers that hold it: platform/stored-bounds.ts (EMOJI_COLUMNS, migration 0053_custom_emoji_snapshots).
// Mastodon keeps a global (shortcode, domain) registry (app/models/status.rb, account.rb); Kopje keeps what each
// object tagged instead, and never fetches an image (NET-3).

// An Emoji tag as federation/remote-emoji.ts reads it: a shortcode within EMOJI_SHORTCODE and its normalized url
// (emojiHref).
export type EmojiCandidate = { shortcode: string; url: string }

// REST::CustomEmojiSerializer. static_url is url: Mastodon serves a still image it generates, Kopje links the
// original (an accepted risk). visible_in_picker is the column's default; category is omitted, as Mastodon omits it
// when none is loaded.
export type CustomEmoji = { shortcode: string; url: string; static_url: string; visible_in_picker: true }

// An emoji url as stored and presented: http(s), serialized, within EMOJI_URL_LIMIT bytes and EMOJI_URL_ALPHABET, so
// the stored-bound triggers accept what ingestion writes; else none (the tag, or the stored entry, is dropped).
export function emojiHref(raw: string | null): string | null {
	const href = boundedHref(raw, EMOJI_URL_LIMIT)
	return href !== null && isEmojiUrl(href) ? href : null
}

// Whether `name` is a shortcode a snapshot may hold.
export function isShortcode(name: string): boolean {
	return name.length <= EMOJI_SHORTCODE_LIMIT && EMOJI_SHORTCODE.test(name)
}

// The shortcodes `texts` reference (RES-2: linear, no pattern built from data): every segment strictly between two
// colons of one text that is a shortcode, so a reference never spans two texts. A superset of Mastodon's SCAN_RE
// (app/models/custom_emoji.rb:34-37), which also asks for a boundary outside both colons: `:aa:bb:` references aa and
// bb here, neither there. It can only keep an emoji the author tagged; clients do the replacement.
export function shortcodesIn(texts: readonly string[]): Set<string> {
	const names = new Set<string>()
	for (const text of texts) {
		const segments = text.split(':')
		for (let i = 1; i < segments.length - 1; i++) {
			const segment = segments[i]!
			if (segment !== '' && isShortcode(segment)) {
				names.add(segment)
			}
		}
	}
	return names
}

function entryBytes(shortcode: string, url: string): number {
	return EMOJI_ENTRY_BYTES + shortcode.length + 2 * url.length
}

// The snapshot of `candidates` (in tag order) that `texts` (the object's final stored or presented texts) reference,
// as stored: the first candidate of each referenced name, while there are at most MAX_EMOJIS and their presented JSON
// stays within `bytes`, stopping at the first that does not fit (as remoteFields stops); null when none is kept. Its
// output always passes the column's trigger (emojisValid).
export function emojiSnapshot(
	candidates: readonly EmojiCandidate[],
	texts: readonly string[],
	bytes: number
): string | null {
	const referenced = shortcodesIn(texts)
	const pairs: [string, string][] = []
	const kept = new Set<string>()
	let size = 1
	for (const { shortcode, url } of candidates) {
		if (kept.has(shortcode) || !referenced.has(shortcode)) {
			continue
		}
		size += entryBytes(shortcode, url)
		if (pairs.length === MAX_EMOJIS || size > bytes) {
			break
		}
		kept.add(shortcode)
		pairs.push([shortcode, url])
	}
	return pairs.length === 0 ? null : JSON.stringify(pairs)
}

// The entities of a stored snapshot (HTML-3, RES-3), imported rows included: each url normalized again through
// emojiHref, an entry whose url does not pass dropped and the rest kept, then entries admitted while
// 1 + Σ(67 + n + 2·url) stays within `bytes`, stopping at the first that does not fit (normalizing an imported value
// may grow it). A stored value that is not a JSON array (the triggers refuse one) shows none, so a row never fails
// the request that presents it.
export function presentEmojis(stored: string | null, bytes: number): CustomEmoji[] {
	let entries: unknown
	try {
		entries = stored === null ? [] : JSON.parse(stored)
	} catch {
		entries = []
	}
	const emojis: CustomEmoji[] = []
	let size = 1
	for (const entry of Array.isArray(entries) ? (entries as unknown[]) : []) {
		if (!Array.isArray(entry) || entry.length !== 2) {
			continue
		}
		const [shortcode, raw] = entry as [unknown, unknown]
		if (typeof shortcode !== 'string' || typeof raw !== 'string') {
			continue
		}
		const url = emojiHref(raw)
		if (url === null || !isShortcode(shortcode)) {
			continue
		}
		size += entryBytes(shortcode, url)
		if (emojis.length === MAX_EMOJIS || size > bytes) {
			break
		}
		emojis.push({ shortcode, url, static_url: url, visible_in_picker: true })
	}
	return emojis
}

// Poll#emojis (app/models/poll.rb:69-71): the status's emojis its choices reference, a subset of the status's.
export function pollEmojis(emojis: readonly CustomEmoji[], titles: readonly string[]): CustomEmoji[] {
	const referenced = shortcodesIn(titles)
	return emojis.filter((emoji) => referenced.has(emoji.shortcode))
}

// ---- Local custom emoji (migration 0055_local_custom_emojis, local-emojis.ts)

// Names a local snapshot looks up at most (RES-2): the texts' first distinct shortcodes in the local grammar.
export const MAX_LOCAL_EMOJI_NAMES = 1024

// The snapshot of the enabled local emoji that `texts` reference, as emojiSnapshot stores it (null for none), so its
// output always passes the column's trigger. The names are the texts' shortcodes in the local grammar
// (LOCAL_EMOJI_SHORTCODE) in order of first occurrence, at most MAX_LOCAL_EMOJI_NAMES, looked up in one query through
// custom_emojis_enabled; an emoji whose url fails emojiHref is left out. Unlisted emoji (visible_in_picker 0) are
// used, disabled ones are not, as Mastodon's CustomEmoji.from_text uses every enabled local emoji (status.rb:279-286,
// account.rb:450-451, 486-488). The texts are the stored ones a presenter shows.
export function localEmojiSnapshot(db: Db, texts: readonly string[], bytes: number): string | null {
	const names = [...shortcodesIn(texts)].filter((name) => LOCAL_EMOJI_SHORTCODE.test(name))
	if (names.length === 0) {
		return null
	}
	// json_each drives the join (CROSS JOIN), one index search per name; the rows are put in name order here, so no
	// sort runs in SQLite.
	const rows = db
		.all<{ i: number; shortcode: string; url: string }>(
			`SELECT j.key AS i, e.shortcode, m.url FROM json_each(?1) j
			CROSS JOIN custom_emojis e INDEXED BY custom_emojis_enabled ON e.shortcode = j.value AND e.disabled = 0
			JOIN media_attachments m ON m.id = e.id`,
			JSON.stringify(names.slice(0, MAX_LOCAL_EMOJI_NAMES))
		)
		.sort((a, b) => a.i - b.i)
	const candidates = rows.flatMap((row) => {
		const url = emojiHref(row.url)
		return url === null ? [] : [{ shortcode: row.shortcode, url }]
	})
	return emojiSnapshot(candidates, texts, bytes)
}

// An Emoji tag as ActivityPub::EmojiSerializer writes it (app/serializers/activitypub/emoji_serializer.rb:8-30, its
// icon as ImageSerializer, image_serializer.rb:8-21): id /emojis/<id>, `:shortcode:`, its time and its image.
export type EmojiTag = {
	id: string
	type: 'Emoji'
	name: string
	updated: string
	icon: { type: 'Image'; mediaType: string; url: string }
}

// The local emoji a stored snapshot names (statuses.emojis of a local status, accounts.emojis of a local account), as
// Emoji tags, in snapshot order: each entry presentEmojis keeps (within `bytes`) whose url is a served full image on
// `origin` (/media/<token>/full.png or .webp) of an emoji row with the same url and shortcode. Disabled emoji are
// kept (the object shows what was posted); an entry that resolves to none is left out. One query over at most
// MAX_EMOJIS file tokens, each by the unique index of media_attachments.file_token.
export function localEmojiTags(db: Db, stored: string | null, origin: string, bytes: number): EmojiTag[] {
	const entries = presentEmojis(stored, bytes)
	const prefix = `${origin}/media/`
	const tokens = entries.flatMap(({ url }) => {
		const match = url.startsWith(prefix) ? /^([^/]+)\/full\.(png|webp)$/.exec(url.slice(prefix.length)) : null
		return match !== null && FILE_TOKEN.test(match[1]!) ? [match[1]!] : []
	})
	if (tokens.length === 0) {
		return []
	}
	const rows = db.all<{ url: string; content_type: string; id: string; shortcode: string; created_at: string }>(
		`SELECT m.url, m.content_type, e.id, e.shortcode, e.created_at FROM json_each(?1) j
		CROSS JOIN media_attachments m ON m.file_token = j.value JOIN custom_emojis e ON e.id = m.id`,
		JSON.stringify(tokens.slice(0, MAX_EMOJIS))
	)
	const byUrl = new Map(rows.map((row) => [row.url, row]))
	return entries.flatMap(({ shortcode, url }) => {
		const row = byUrl.get(url)
		const tag = row === undefined || row.shortcode !== shortcode ? null : emojiTag(origin, row)
		return tag === null ? [] : [tag]
	})
}

// An ISO 8601 instant as Kopje writes one (Date#toISOString), hour 00 to 23: what Temporal.Instant.from and peers
// parse.
const INSTANT = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/

// Whether a stored time may be an Emoji's `updated`: an instant that Date reads back as itself. The one check every
// presenter of an Emoji tag goes through (Notes and Questions, the actor, Update(Person), /emojis/:id), so a stored
// value the 0055 CHECK should have refused drops the tag (or answers 404) rather than failing the document.
export function emojiInstant(stored: string): boolean {
	if (!INSTANT.test(stored)) {
		return false
	}
	const ms = Date.parse(stored)
	return Number.isFinite(ms) && new Date(ms).toISOString() === stored
}

// The tag of an emoji row, or null when its time is not an instant (emojiInstant).
export function emojiTag(
	origin: string,
	row: { id: string; shortcode: string; created_at: string; content_type: string; url: string }
): EmojiTag | null {
	if (!emojiInstant(row.created_at)) {
		return null
	}
	return {
		id: `${origin}/emojis/${row.id}`,
		type: 'Emoji',
		name: `:${row.shortcode}:`,
		updated: row.created_at,
		icon: { type: 'Image', mediaType: row.content_type, url: row.url },
	}
}
