import { type EmojiCandidate, emojiHref, isShortcode } from '../domain/custom-emojis'
import { MAX_URL_LENGTH } from '../domain/status-text'
import { MAX_EMOJI_TAGS } from '../platform/stored-bounds'

// Emoji tags of a remote object (a Note, a Question, a converted object or an actor), as Mastodon 4.5.11 reads them
// (ActivityPub::Parser::CustomEmojiParser) and Misskey 2026.10 renders them (ApRendererService#renderEmoji):
// { type: 'Emoji', name: ':name:', icon: { type: 'Image', url } }. Which of them a snapshot keeps is the Store's to
// decide (domain/custom-emojis.ts emojiSnapshot). A tag's id, updated and host confer nothing.

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeIs(value: unknown, type: string): boolean {
	return (Array.isArray(value) ? value : [value]).includes(type)
}

// The candidates of an object's `tag`, in order: the first MAX_EMOJI_TAGS Emoji tags are examined (RES-1), and one
// that does not parse is dropped alone.
//   - name: a string, every ':' deleted (CustomEmojiParser#shortcode; Misskey's ApNoteService#extractEmojis), within
//     EMOJI_SHORTCODE.
//   - icon: an object, or the first of an array (Misskey's toSingle accepts one; its renderer emits an object).
//   - icon.url: a string, or a Link's href, at most MAX_URL_LENGTH as received (the parse bound), then normalized by
//     emojiHref: one that does not pass (past EMOJI_URL_LIMIT once normalized, or keeping '"' or '\') is dropped.
export function emojiCandidates(tag: unknown): EmojiCandidate[] {
	const tags = tag === undefined || tag === null ? [] : Array.isArray(tag) ? tag : [tag]
	const candidates: EmojiCandidate[] = []
	let examined = 0
	for (const entry of tags) {
		if (!isObject(entry) || !typeIs(entry.type, 'Emoji')) {
			continue
		}
		if (examined++ === MAX_EMOJI_TAGS) {
			break
		}
		const shortcode = typeof entry.name === 'string' ? entry.name.replaceAll(':', '') : null
		if (shortcode === null || !isShortcode(shortcode)) {
			continue
		}
		const icon = Array.isArray(entry.icon) ? (entry.icon as unknown[])[0] : entry.icon
		const link = isObject(icon) ? icon.url : undefined
		const raw = typeof link === 'string' ? link : isObject(link) && typeof link.href === 'string' ? link.href : null
		const url = raw === null || raw.length > MAX_URL_LENGTH ? null : emojiHref(raw)
		if (url !== null) {
			candidates.push({ shortcode, url })
		}
	}
	return candidates
}
