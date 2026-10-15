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

// Mastodon's CLASS_WHITELIST_TRANSFORMER: microformats prefixes and a few semantic classes.
const ALLOWED_CLASS = /^(?:(?:h|p|u|dt|e)-.|(?:mention|hashtag|ellipsis|invisible)$)/

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
