import { Parser } from 'htmlparser2'
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

// An anchor's attributes as the sanitizer reads them (entity references decoded), before they are filtered: what a
// link card's capture judges (federation/remote-status.ts). Anchors inside the elements dropped with their content
// are not seen.
export type RawAnchor = Readonly<Attributes>

// allowedEmptyAttributes is missing from @types/sanitize-html.
type Options = sanitizeHtml.IOptions & { allowedEmptyAttributes: string[] }

function anchorTag(_: string, attribs: Attributes): sanitizeHtml.Tag {
	const href = httpHref(attribs.href)
	const link = filtered(attribs, { rel: 'nofollow noopener', target: '_blank' })
	return { tagName: 'a', attribs: href === undefined ? link : { href, ...link } }
}

const OPTIONS: Options = {
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
		a: anchorTag,
		p: (_, attribs: Attributes) => ({ tagName: 'p', attribs: filtered(attribs) }),
		span: (_, attribs: Attributes) => ({ tagName: 'span', attribs: filtered(attribs) }),
		...Object.fromEntries(
			['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((tag) => [tag, () => ({ tagName: HEADING, attribs: {} })])
		),
	},
}

// The first `limit` code units of `text`, one fewer where the cut would split a surrogate pair, so well-formed text
// stays well-formed (RES-2: the stored text writers' output is well-formed, platform/stored-bounds.ts storedText).
export function cutCodeUnits(text: string, limit: number): string {
	if (text.length <= limit) {
		return text
	}
	const high = text.charCodeAt(limit - 1)
	const low = text.charCodeAt(limit)
	const splits = limit > 0 && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
	return text.slice(0, splits ? limit - 1 : limit)
}

// OPTIONS with each anchor's raw attributes passed to `onAnchor`, in document order, before it is transformed.
function capturing(onAnchor: (anchor: RawAnchor) => void): Options {
	return {
		...OPTIONS,
		transformTags: {
			...OPTIONS.transformTags,
			a: (tagName: string, attribs: Attributes) => {
				onAnchor(attribs)
				return anchorTag(tagName, attribs)
			},
		},
	}
}

export function sanitizeRemoteHtml(html: string, onAnchor?: (anchor: RawAnchor) => void): string {
	return sanitizedWith(html, onAnchor === undefined ? OPTIONS : capturing(onAnchor))
}

// sanitizeRemoteHtml with `filter` applied to each run of text the sanitizer keeps. sanitize-html (2.18) passes a run
// already escaped (`&`, `<` and `>`) and writes what the filter returns as it is, unescaped (`textFilter`; pinned by
// test/web-emoji.test.ts), so the filter returns markup: it keeps the escaped text it is given and escapes whatever
// it adds. A text node comes in runs split at its character references and tags; text inside the elements dropped
// with their content and attribute values never reach the filter.
export function sanitizeRemoteHtmlFiltered(html: string, filter: (escaped: string) => string): string {
	return sanitizedWith(html, { ...OPTIONS, textFilter: (text) => filter(text) })
}

function sanitizedWith(html: string, options: Options): string {
	return (
		sanitizeHtml(cutCodeUnits(html, REMOTE_HTML_RAW_LIMIT), options)
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
// need not be the longest such prefix); always sanitizer output, so well-formed HTML; '' when none fits. onAnchor sees
// the anchors of the whole input's pass (its first REMOTE_HTML_RAW_LIMIT code units) only.
function sanitizeRemoteWithin(html: string, bytes: number, onAnchor?: (anchor: RawAnchor) => void): string {
	const whole = sanitizeRemoteHtml(html, onAnchor)
	if (jsonStringBytes(whole) <= bytes) {
		return whole
	}
	let [fits, best, over] = [0, '', Math.min(html.length, REMOTE_HTML_RAW_LIMIT)]
	while (over - fits > 1) {
		const middle = Math.floor((fits + over) / 2)
		const cut = sanitizeRemoteHtml(cutCodeUnits(html, middle))
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
export function sanitizeRemoteContent(html: string, onAnchor?: (anchor: RawAnchor) => void): string {
	return sanitizeRemoteWithin(html, STATUS_CONTENT_BYTES, onAnchor)
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

// ---- An oEmbed video's iframe (federation/card-oembed.ts)

// The elements Mastodon's Sanitize::Config::MASTODON_OEMBED keeps (sanitize_config.rb:139-155), and the attributes of
// an iframe a card renders from (its other kept ones, allowfullscreen, frameborder and scrolling, are forced by the
// card's template: domain/status-presenter.ts).
const EMBED_ELEMENTS = new Set(['audio', 'iframe', 'source', 'video'])
const IFRAME_ATTRIBUTES = new Set(['src', 'width', 'height'])
// Decoded UTF-16 code units of a captured attribute: past it, it is captured as refused (null). The longest a card
// keeps (stored-bounds.ts CARD_EMBED_SRC_BYTES; a dimension's five digits are far below it).
const IFRAME_ATTRIBUTE_CHARS = 512

// What an iframe's attributes are captured as: absent (undefined), refused for its length (null), or decoded.
export type IframeAttributes = { src?: string | null; width?: string | null; height?: string | null }

// The decoded src, width and height of the one iframe of `html` (an oEmbed video's), or null unless `html` holds
// exactly one of MASTODON_OEMBED's elements and it is an iframe (AM14). It reads with htmlparser2's streaming Parser,
// the parser sanitize-html uses, with sanitize-html's parser options (entities decoded, names lowercased), so the
// elements it counts are those sanitize-html would see; no sanitized output is built. An attribute's first occurrence
// wins, as sanitize-html's attribs do. The caller judges the src and dimensions (stored-bounds.ts presentedEmbedSrc,
// iframeDimension), as sanitize-html's allowedSchemesByTag (http, https) and allowProtocolRelative false would, more
// strictly. Memory: the input, the parser's transient slices of it (each at most its length) and at most three
// captured values of IFRAME_ATTRIBUTE_CHARS units; text and other attributes are not kept.
export function oembedIframe(html: string): IframeAttributes | null {
	const seen: { elements: number; iframe: IframeAttributes | null; capturing: IframeAttributes | null } = {
		elements: 0,
		iframe: null,
		capturing: null,
	}
	const parser = new Parser(
		{
			onopentagname: (name) => {
				seen.capturing = null
				if (!EMBED_ELEMENTS.has(name)) {
					return
				}
				seen.elements++
				if (name === 'iframe' && seen.elements === 1) {
					seen.iframe = {}
					seen.capturing = seen.iframe
				}
			},
			onattribute: (name, value) => {
				const into = seen.capturing
				if (into !== null && IFRAME_ATTRIBUTES.has(name) && !Object.hasOwn(into, name)) {
					into[name as keyof IframeAttributes] = value.length <= IFRAME_ATTRIBUTE_CHARS ? value : null
				}
			},
		},
		{ decodeEntities: true }
	)
	parser.write(html)
	parser.end()
	return seen.elements === 1 ? seen.iframe : null
}
