import { REACTION_NAME_BYTES } from './stored-bounds'

// Unicode emoji names of announcement reactions (domain/announcements.ts). Mastodon accepts a key of its emoji_map.json
// (app/validators/reaction_validator.rb:4, 11: 5,035 names, fully qualified and their unqualified forms); Kopje accepts
// an RGI emoji (Unicode's recommended set, `\p{RGI_Emoji}`) or a name that is one once fully qualified, a superset of
// that map (every key passes) that also takes emoji newer than it. Which new emoji pass is workerd's ICU's to decide
// (an accepted risk, docs/threat-model.md). The name is stored as sent, as Mastodon stores it.

const RGI = /^\p{RGI_Emoji}$/v
const EMOJI = /\p{Emoji}/u
const PRESENTATION = /\p{Emoji_Presentation}/u
const MODIFIER = /\p{Emoji_Modifier}/u
const ZWJ = 0x200d
const VS16 = 0xfe0f
const KEYCAP = 0x20e3
const ENCODER = new TextEncoder()

// Whether `point` takes no U+FE0F of its own when the sequence is fully qualified: it is not an emoji, is one shown as
// an emoji already, or is a joiner, the selector, the keycap mark, a modifier or a tag character.
function presented(point: string, code: number): boolean {
	return (
		!EMOJI.test(point) ||
		PRESENTATION.test(point) ||
		MODIFIER.test(point) ||
		code === ZWJ ||
		code === VS16 ||
		code === KEYCAP ||
		(code >= 0xe0020 && code <= 0xe007f)
	)
}

// The fully qualified form of `name`: U+FE0F after every emoji code point that needs one and is not followed by it or
// by a modifier. A digit, `#` and `*` (emoji only as keycap bases) take it only before U+20E3.
function qualified(name: string): string {
	const points = [...name]
	let out = ''
	for (const [i, point] of points.entries()) {
		out += point
		const code = point.codePointAt(0) ?? 0
		if (presented(point, code)) {
			continue
		}
		const next = points[i + 1]
		const nextCode = next?.codePointAt(0)
		if (nextCode === VS16 || (next !== undefined && MODIFIER.test(next))) {
			continue
		}
		const keycapBase = (code >= 0x30 && code <= 0x39) || code === 0x23 || code === 0x2a
		if (keycapBase && nextCode !== KEYCAP) {
			continue
		}
		out += String.fromCodePoint(VS16)
	}
	return out
}

// Whether `name` is a Unicode emoji a reaction may be named by. Judged within REACTION_NAME_BYTES UTF-8 bytes before
// any pattern runs (RES-2); every accepted name holds a code point past ASCII, as the CHECK of
// announcement_reactions.name requires of a name without a custom emoji (0056_announcements).
export function isUnicodeEmoji(name: string): boolean {
	if (name === '' || name.length > REACTION_NAME_BYTES || ENCODER.encode(name).length > REACTION_NAME_BYTES) {
		return false
	}
	return RGI.test(name) || RGI.test(qualified(name))
}
