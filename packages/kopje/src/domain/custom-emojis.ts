import { boundedHref } from '../platform/http-url'
import {
	EMOJI_ENTRY_BYTES,
	EMOJI_SHORTCODE,
	EMOJI_SHORTCODE_LIMIT,
	EMOJI_URL_LIMIT,
	isEmojiUrl,
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
