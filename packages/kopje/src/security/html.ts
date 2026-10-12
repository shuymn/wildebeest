import xss from 'xss'

// js-xss is CommonJS: its helpers hang off the default export, which its typings declare as the bare function.
const { escapeAttrValue, FilterXSS, friendlyAttrValue } = xss as unknown as typeof import('xss')

// Remote HTML (bios now, post content in B1b-2) as Kopje stores and serves it (HTML-1): allowlisted by js-xss with
// Mastodon's Sanitize::Config::MASTODON_STRICT as the reference. Kept: p br span a del s pre blockquote code b strong u
// i em ul ol li ruby rt rp, with a@href (http and https only, HTML-3; Mastodon also allows dat, ipfs, gemini and the
// like), a@class, span@class, p@class (Mastodon's class allowlist), a@translate and span@translate (only "no"),
// ol@start, ol@reversed and li@value. Every link gets rel="nofollow noopener" and target="_blank", as Mastodon adds
// them. h1-h6 become <p><strong>, as Mastodon's transformer does. Other tags are unwrapped (their text is kept),
// except the ones in DROPPED_WITH_CONTENT, which go with everything inside them; comments are removed. A link whose
// href is not http(s) keeps its text without the href (Mastodon replaces it with its text).
//
// js-xss is a tokenizer, not an HTML5 tree builder. Its output is safe however a browser parses it because it only
// ever emits allowlisted tags with double-quoted, escaped attribute values and escapes every other '<' and '>'; the
// vector suites (test/html.test.ts) check that with parse5, the spec parser.

// Raw cap before sanitizing (RES-1). A longer input is cut first; the sanitizer copes with the cut markup.
export const REMOTE_HTML_RAW_LIMIT = 50_000

const ALLOWED: Record<string, string[]> = {
	a: ['href', 'class', 'translate'],
	b: [],
	blockquote: [],
	br: [],
	code: [],
	del: [],
	em: [],
	i: [],
	li: ['value'],
	ol: ['start', 'reversed'],
	p: ['class'],
	pre: [],
	rp: [],
	rt: [],
	ruby: [],
	s: [],
	span: ['class', 'translate'],
	strong: [],
	u: [],
	ul: [],
}

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

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

// Mastodon's CLASS_WHITELIST_TRANSFORMER: microformats prefixes and a few semantic classes.
const ALLOWED_CLASS = /^(?:(?:h|p|u|dt|e)-.|(?:mention|hashtag|ellipsis|invisible)$)/

// An absolute http(s) URL, else null. js-xss decodes numeric entities (friendlyAttrValue) but not named ones; a named
// entity cannot appear in a scheme ('&' is not a scheme character), so a value that parses as http(s) here is http(s)
// for the browser too.
function httpHref(value: string): string | null {
	const decoded = friendlyAttrValue(value)
	try {
		const url = new URL(decoded)
		return url.protocol === 'http:' || url.protocol === 'https:' ? decoded : null
	} catch {
		return null
	}
}

const filter = new FilterXSS({
	whiteList: ALLOWED,
	stripIgnoreTagBody: DROPPED_WITH_CONTENT,
	allowCommentTag: false,
	onIgnoreTag(tag, _html, { isClosing }) {
		if (HEADINGS.has(tag)) {
			return isClosing === true ? '</strong></p>' : '<p><strong>'
		}
		return ''
	},
	onTagAttr(tag, name, value) {
		if (tag === 'a' && name === 'href') {
			const href = httpHref(value)
			return href === null ? '' : `href="${escapeAttrValue(href)}"`
		}
		if (name === 'class') {
			const kept = value.split(/[\t\n\f\r ]+/).filter((c) => ALLOWED_CLASS.test(c))
			return kept.length === 0 ? '' : `class="${escapeAttrValue(kept.join(' '))}"`
		}
		if (name === 'translate') {
			return value === 'no' ? 'translate="no"' : ''
		}
		if (name === 'reversed') {
			return 'reversed'
		}
		return undefined
	},
})

// Every <a ...> in the filter's output is a tag it wrote: other '<' are escaped, and attribute values have '>' escaped.
const LINK_OPEN = /<a(\s[^>]*)?>/g

export function sanitizeRemoteHtml(html: string): string {
	const sanitized = filter.process(html.slice(0, REMOTE_HTML_RAW_LIMIT))
	return sanitized.replace(LINK_OPEN, (_, attributes: string | undefined) => {
		// js-xss keeps a self-closing slash ('<a />'); it means nothing on <a> and would move behind the added attributes.
		return `<a${(attributes ?? '').replace(/\s*\/$/, '')} rel="nofollow noopener" target="_blank">`
	})
}
