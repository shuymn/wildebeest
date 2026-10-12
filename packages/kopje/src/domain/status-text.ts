import { LinkifyIt } from 'linkify-it'

import { escapeHtml } from './plain-text'

// Plain status text to safe HTML, as Mastodon 4's TextFormatter does: everything is escaped; http(s) URLs, mentions
// of known accounts and hashtags become links; blank lines separate paragraphs and single newlines become <br />.
// URLs are found by linkify-it (no hand-written URL pattern); mentions and hashtags use Mastodon's own patterns. The
// source text is kept separately (statuses.source_text) for /source and editing.

// Only absolute http(s) links, as Mastodon (extract_url_without_protocol: false). No fuzzy links, emails, ftp or //.
const linkify = new LinkifyIt({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false })
	.add('ftp:', null)
	.add('mailto:', null)
	.add('//', null)

// Ruby's [[:word:]] and [[:alpha:]] under Unicode.
const WORD = '\\p{L}\\p{M}\\p{Nd}\\p{Pc}'
const ALPHA = '\\p{L}\\p{M}'
const TAG_SEPARATORS = '_\\u00B7\\u30FB\\u200C'

// Account::MENTION_RE: @user or @user@domain, not preceded by a word character, = or /.
const MENTION = `(?<![=/${WORD}])@([a-z0-9_]+(?:[a-z0-9_.-]+[a-z0-9_]+)?)(?:@([${WORD}.-]+[${WORD}]+))?`
// Tag::HASHTAG_RE: #name, not preceded by a word character, =, / or ).
const HASHTAG = `(?<![=/)${WORD}])#([${WORD}_][${WORD}${TAG_SEPARATORS}]*[${ALPHA}${TAG_SEPARATORS}][${WORD}${TAG_SEPARATORS}]*[${WORD}_]|[${WORD}_]*[${ALPHA}][${WORD}_]*)`
const ENTITY = new RegExp(`${MENTION}|${HASHTAG}`, 'giu')

// Bounds on the raw input, checked before anything is parsed. statusLength counts a URL as 23 characters and a remote
// mention by its username, so the counted 500 characters say nothing about the size of the raw text: without a bound,
// a status padded with long URLs or mention domains could be as large as the request body. Every path that takes
// status text (posting, editing) refuses text and spoiler longer than this together, with Mastodon's length error.
// 20 UTF-16 code units per counted character leaves room for 500 graphemes of long emoji sequences.
export const MAX_RAW_LENGTH = 10_000
// twitter-text's maximum URL length: a longer run is not a link (and is counted as text).
export const MAX_URL_LENGTH = 4096

export function exceedsRawLength(text: string, spoilerText: string): boolean {
	return text.length + spoilerText.length > MAX_RAW_LENGTH
}

export type MentionRef = { username: string; domain: string | null }

export type Segment =
	| { kind: 'text'; text: string }
	| { kind: 'url'; url: string; text: string }
	| { kind: 'mention'; username: string; domain: string | null; text: string }
	| { kind: 'tag'; name: string; text: string }

export type ParsedText = { segments: Segment[]; mentions: MentionRef[]; tags: string[] }

// Throws on text over MAX_RAW_LENGTH: callers check exceedsRawLength first, so nothing unbounded is ever parsed.
export function parseStatusText(source: string): ParsedText {
	if (source.length > MAX_RAW_LENGTH) {
		throw new RangeError(`status text over ${MAX_RAW_LENGTH} code units`)
	}
	const text = source.replace(/\r\n?/g, '\n')
	const segments: Segment[] = []
	let at = 0
	for (const match of linkify.match(text) ?? []) {
		if (match.raw.length > MAX_URL_LENGTH) {
			continue
		}
		pushEntities(text.slice(at, match.index), segments)
		segments.push({ kind: 'url', url: match.url, text: match.raw })
		at = match.lastIndex
	}
	pushEntities(text.slice(at), segments)
	const mentions = new Map<string, MentionRef>()
	const tags = new Set<string>()
	for (const segment of segments) {
		if (segment.kind === 'mention') {
			mentions.set(mentionKey(segment), { username: segment.username, domain: segment.domain })
		} else if (segment.kind === 'tag') {
			tags.add(normalizeTag(segment.name))
		}
	}
	return { segments, mentions: [...mentions.values()], tags: [...tags] }
}

function pushEntities(text: string, out: Segment[]): void {
	let at = 0
	for (const match of text.matchAll(ENTITY)) {
		const [raw, username, domain, tag] = match
		if (match.index > at) {
			out.push({ kind: 'text', text: text.slice(at, match.index) })
		}
		if (username !== undefined) {
			out.push({ kind: 'mention', username, domain: domain === undefined ? null : normalizeDomain(domain), text: raw })
		} else if (tag !== undefined) {
			out.push({ kind: 'tag', name: tag, text: raw })
		}
		at = match.index + raw.length
	}
	if (at < text.length) {
		out.push({ kind: 'text', text: text.slice(at) })
	}
}

// IDN domains compare in their ASCII form; anything the URL parser rejects stays lowercased as written.
function normalizeDomain(domain: string): string {
	try {
		return new URL(`https://${domain}`).hostname
	} catch {
		return domain.toLowerCase()
	}
}

// The key two mentions of the same account share.
export function mentionKey(mention: MentionRef): string {
	return `${mention.username.toLowerCase()}@${mention.domain ?? ''}`
}

// status_tags.name: NFKC, lowercase.
export function normalizeTag(name: string): string {
	return name.normalize('NFKC').toLowerCase()
}

// A resolved mention: the account's profile URL and username. Unresolved mentions stay text.
export type MentionTarget = { url: string; username: string }

export type RenderOptions = {
	// The account a mention resolved to, by mentionKey, or undefined.
	mention: (mention: MentionRef) => MentionTarget | undefined
	tagUrl: (name: string) => string
}

export function renderStatusHtml(segments: readonly Segment[], options: RenderOptions): string {
	const inline = segments
		.map((segment) => {
			switch (segment.kind) {
				case 'text':
					return escapeHtml(segment.text)
				case 'url':
					return linkHtml(segment.url)
				case 'mention': {
					const target = options.mention(segment)
					return target === undefined
						? escapeHtml(segment.text)
						: `<span class="h-card"><a href="${escapeHtml(target.url)}" class="u-url mention">@<span>${escapeHtml(target.username)}</span></a></span>`
				}
				case 'tag':
					return `<a href="${escapeHtml(options.tagUrl(normalizeTag(segment.name)))}" class="mention hashtag" rel="tag">#<span>${escapeHtml(segment.name)}</span></a>`
			}
		})
		.join('')
	// Every newline left in the output comes from text segments, so paragraphs can be cut on the rendered HTML.
	return inline
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== '')
		.map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`)
		.join('')
}

// A local profile field value (HTML-2): escaped, with absolute http(s) URLs linked as in statuses. Mentions and
// hashtags stay text. Values are short (MAX_FIELD_VALUE), so this never reaches the raw bound.
export function renderFieldValue(value: string): string {
	return parseStatusText(value.slice(0, MAX_RAW_LENGTH))
		.segments.map((segment) => (segment.kind === 'url' ? linkHtml(segment.url) : escapeHtml(segment.text)))
		.join('')
}

const DISPLAY_LIMIT = 30

// Mastodon's link display: the scheme (and www.) hidden, the rest cut with an ellipsis after 30 characters.
function linkHtml(url: string): string {
	const prefix = /^https?:\/\/(?:www\.)?/i.exec(url)?.[0] ?? ''
	const rest = url.slice(prefix.length)
	const shown = rest.length > DISPLAY_LIMIT ? rest.slice(0, DISPLAY_LIMIT) : rest
	const hidden = rest.slice(shown.length)
	const display =
		`<span class="invisible">${escapeHtml(prefix)}</span>` +
		`<span class="${hidden === '' ? '' : 'ellipsis'}">${escapeHtml(shown)}</span>` +
		`<span class="invisible">${escapeHtml(hidden)}</span>`
	return `<a href="${escapeHtml(url)}" target="_blank" rel="nofollow noopener noreferrer">${display}</a>`
}

const URL_PLACEHOLDER_LENGTH = 23

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemeLength(text: string): number {
	let count = 0
	for (const _ of graphemes.segment(text)) {
		count++
	}
	return count
}

// StatusLengthValidator (for text within MAX_RAW_LENGTH): grapheme count of the text and the spoiler, where a URL counts as 23 characters and a
// remote mention as its local part only.
export function statusLength(text: string, spoilerText: string): number {
	const countable = parseStatusText(text)
		.segments.map((segment) => {
			switch (segment.kind) {
				case 'url':
					return 'x'.repeat(URL_PLACEHOLDER_LENGTH)
				case 'mention':
					return `@${segment.username}`
				default:
					return segment.text
			}
		})
		.join('')
	return graphemeLength(countable) + graphemeLength(spoilerText)
}
