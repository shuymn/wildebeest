import sanitizeHtml from 'sanitize-html'

// Remote HTML (bios, status content and profile field values) as Kopje stores and serves it (HTML-1): allowlisted by sanitize-html
// with Mastodon's Sanitize::Config::MASTODON_STRICT as the reference. Kept: p br span a del s pre blockquote code b
// strong u i em ul ol li ruby rt rp, with a@href (http and https only, HTML-3; Mastodon also allows dat, ipfs, gemini
// and the like), a@class, span@class, p@class (Mastodon's class allowlist), a@translate and span@translate (only
// "no"), ol@start, ol@reversed and li@value. Styles are never allowed. Every link gets rel="nofollow noopener" and
// target="_blank", as Mastodon adds them. h1-h6 become <p><strong>, as Mastodon's transformer does. Other tags are
// unwrapped (their text is kept), except the ones in DROPPED_WITH_CONTENT, which go with everything inside them;
// comments are removed. A link whose href is not http(s) keeps its text without the href (Mastodon replaces it with
// its text).
//
// sanitize-html reads with htmlparser2, a tokenizer rather than an HTML5 tree builder. Its output is safe however a
// browser parses it because it only ever emits allowlisted tags with double-quoted, escaped attribute values and
// escapes all other text; the vector suites (test/html.test.ts) check that with parse5, the spec parser.

// Raw cap before sanitizing (RES-1). A longer input is cut first; the sanitizer copes with the cut markup.
export const REMOTE_HTML_RAW_LIMIT = 50_000

const DROPPED_WITH_CONTENT = [
	'applet',
	'embed',
	'frame',
	'frameset',
	'iframe',
	'math',
	'noembed',
	'noframes',
	'noscript',
	'object',
	'plaintext',
	'script',
	'select',
	'style',
	'svg',
	'template',
	'textarea',
	'title',
	'xmp',
]

// Mastodon's CLASS_WHITELIST_TRANSFORMER: microformats prefixes, a few semantic classes, and quote-inline, the class
// of a quote's fallback paragraph (`RE: <link>`), which clients that embed the quote hide.
const ALLOWED_CLASS = /^(?:(?:h|p|u|dt|e)-.|(?:mention|hashtag|ellipsis|invisible|quote-inline)$)/

// A heading is renamed to this placeholder, which becomes <p><strong> once the output is complete: a transform can
// rename a tag but not wrap it. Text cannot produce it, since sanitize-html escapes every '<' it does not emit itself.
const HEADING = 'kopje-heading'

type Attributes = Record<string, string>

function httpHref(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined
	}
	try {
		const url = new URL(value)
		return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined
	} catch {
		return undefined
	}
}

// Only the attributes a tag keeps, filtered as Mastodon filters them, in a fixed order.
function filtered(attribs: Attributes, extra: Attributes = {}): Attributes {
	const kept: Attributes = {}
	const classes = (attribs.class ?? '').split(/[\t\n\f\r ]+/).filter((c) => ALLOWED_CLASS.test(c))
	if (classes.length > 0) {
		kept.class = classes.join(' ')
	}
	if (attribs.translate === 'no') {
		kept.translate = 'no'
	}
	return { ...kept, ...extra }
}

// allowedEmptyAttributes is missing from @types/sanitize-html.
const OPTIONS: sanitizeHtml.IOptions & { allowedEmptyAttributes: string[] } = {
	allowedTags: [
		'a',
		'b',
		'blockquote',
		'br',
		'code',
		'del',
		'em',
		'i',
		'li',
		'ol',
		'p',
		'pre',
		'rp',
		'rt',
		'ruby',
		's',
		'span',
		'strong',
		'u',
		'ul',
		HEADING,
	],
	allowedAttributes: {
		a: ['href', 'class', 'translate', 'rel', 'target'],
		li: ['value'],
		ol: ['start', 'reversed'],
		p: ['class'],
		span: ['class', 'translate'],
	},
	allowedEmptyAttributes: ['reversed'],
	allowedStyles: {},
	allowedSchemes: ['http', 'https'],
	allowedSchemesByTag: {},
	allowedSchemesAppliedToAttributes: ['href'],
	allowProtocolRelative: false,
	allowVulnerableTags: false,
	disallowedTagsMode: 'discard',
	nonTextTags: DROPPED_WITH_CONTENT,
	transformTags: {
		a: (_, attribs: Attributes) => {
			const href = httpHref(attribs.href)
			const link = filtered(attribs, { rel: 'nofollow noopener', target: '_blank' })
			return { tagName: 'a', attribs: href === undefined ? link : { href, ...link } }
		},
		p: (_, attribs: Attributes) => ({ tagName: 'p', attribs: filtered(attribs) }),
		span: (_, attribs: Attributes) => ({ tagName: 'span', attribs: filtered(attribs) }),
		...Object.fromEntries(
			['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((tag) => [tag, () => ({ tagName: HEADING, attribs: {} })])
		),
	},
}

export function sanitizeRemoteHtml(html: string): string {
	return (
		sanitizeHtml(html.slice(0, REMOTE_HTML_RAW_LIMIT), OPTIONS)
			.replaceAll(`<${HEADING}>`, '<p><strong>')
			.replaceAll(`</${HEADING}>`, '</strong></p>')
			// sanitize-html writes void tags XHTML-style and empty attributes with ="" ; Mastodon writes <br> and reversed.
			.replaceAll('<br />', '<br>')
			.replace(/<ol\b([^>]*) reversed=""/g, '<ol$1 reversed')
	)
}

// RES-2: a remote account's bio, as stored and shown, is at most this many UTF-8 bytes as a JSON string (escapes and
// quotes included), so one presented account has a known size (accounts.ts ACCOUNT_COLUMN_MAP). Realistic bios stay far
// below it: Mastodon's 500 characters, Misskey's 1,500 and Pleroma's or GoToSocial's 5,000 characters of Japanese
// with a link and a hashtag every 100 render to at most about 28 KB (test/account-answer-bytes.test.ts).
export const REMOTE_BIO_BYTES = 64 * 1024

const ENCODER = new TextEncoder()

// The UTF-8 bytes of `text` as JSON.stringify writes it. Not dump-format's utf8Length: the cutover loads this module
// from the sources on Node, which resolves no extensionless import, so it has none (cli/lib/cutover/kopje-runtime.js).
export function jsonStringBytes(text: string): number {
	return ENCODER.encode(JSON.stringify(text)).length
}

// RES-2: a status's content (a remote status's sanitized HTML, a local one's rendered text), as stored and shown, is
// at most this many UTF-8 bytes as a JSON string, and its content warning at most SPOILER_BYTES, so one presented
// status has a known size (domain/status-bounds.ts). Realistic posts stay far below them: Misskey's 3,000 characters
// and Pleroma's, Akkoma's or GoToSocial's 5,000 of Japanese with links, mentions and hashtags take at most about 35 KB
// (test/status-bounds.test.ts).
export const STATUS_CONTENT_BYTES = 128 * 1024
export const SPOILER_BYTES = 16 * 1024

// Sanitized remote HTML (HTML-1) within `bytes` as a JSON string: sanitizeRemoteHtml's output when it fits, else the
// sanitized form of a raw prefix whose output fits, found by halving (sanitizing can shrink as well as grow, so it
// need not be the longest such prefix); always sanitizer output, so well-formed HTML; '' when none fits.
function sanitizeRemoteWithin(html: string, bytes: number): string {
	const whole = sanitizeRemoteHtml(html)
	if (jsonStringBytes(whole) <= bytes) {
		return whole
	}
	let [fits, best, over] = [0, '', Math.min(html.length, REMOTE_HTML_RAW_LIMIT)]
	while (over - fits > 1) {
		const middle = Math.floor((fits + over) / 2)
		const cut = sanitizeRemoteHtml(html.slice(0, middle))
		if (jsonStringBytes(cut) <= bytes) {
			;[fits, best] = [middle, cut]
		} else {
			over = middle
		}
	}
	return best
}

// RES-2: a remote bio within REMOTE_BIO_BYTES; shared with the cutover's conversion and verification.
export function sanitizeRemoteBio(html: string): string {
	return sanitizeRemoteWithin(html, REMOTE_BIO_BYTES)
}

// RES-2: remote status content within STATUS_CONTENT_BYTES; shared with the cutover's conversion and verification.
export function sanitizeRemoteContent(html: string): string {
	return sanitizeRemoteWithin(html, STATUS_CONTENT_BYTES)
}

// The UTF-8 bytes one code point takes in a JSON string, as JSON.stringify escapes it (a lone surrogate as \uXXXX).
function jsonCodePointBytes(point: number): number {
	if ([0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x22, 0x5c].includes(point)) {
		return 2
	}
	if (point < 0x20 || (point >= 0xd800 && point <= 0xdfff)) {
		return 6
	}
	return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
}

// Plain text (a content warning) within `bytes` as a JSON string: the text when it fits, else its longest prefix of
// whole code points that does.
export function cutJsonString(text: string, bytes: number): string {
	if (jsonStringBytes(text) <= bytes) {
		return text
	}
	let used = 2
	let end = 0
	for (const char of text) {
		used += jsonCodePointBytes(char.codePointAt(0) ?? 0)
		if (used > bytes) {
			break
		}
		end += char.length
	}
	return text.slice(0, end)
}

// The text of sanitized remote HTML, for search_text: tags dropped, line and paragraph breaks kept as spaces, the
// entities sanitize-html writes decoded. Its input is sanitizeRemoteHtml's output, so the breaks have one spelling.
const TEXT_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [],
	allowedAttributes: {},
	disallowedTagsMode: 'discard',
	nonTextTags: DROPPED_WITH_CONTENT,
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

// sanitizeHtml's text with TEXT_OPTIONS, its entities decoded.
function htmlText(html: string): string {
	return sanitizeHtml(html, TEXT_OPTIONS).replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
}

export function remoteHtmlText(html: string): string {
	return htmlText(html.replace(/<br>|<\/p>/g, ' $&'))
}

// The text of sanitized remote HTML as Mastodon's PlainTextFormatter extracts it for a remote status (what filters
// match): a newline after each run of <br> and </p>, tags dropped (with the content of those Mastodon drops whole),
// the entities sanitize-html writes decoded, and one trailing newline removed (Ruby's chomp).
export function remotePlainText(html: string): string {
	return htmlText(html.replace(/(?:<br \/>|<br>|<\/p>)+/g, '$&\n')).replace(/(?:\r\n|\r|\n)$/, '')
}
