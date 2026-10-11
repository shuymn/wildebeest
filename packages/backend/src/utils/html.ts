/**
 * Allowlist based HTML sanitization, close to Mastodon's.
 *
 * See https://docs.joinmastodon.org/spec/activitypub/#sanitization
 *
 * Everything that is not explicitly allowed is removed: unknown attributes (including event handlers,
 * `style` and `srcset`), unknown classes, non `http(s)` URLs and the `script`, `style`, `svg`, `math`
 * and `iframe` elements together with their contents.
 *
 * These functions are synchronous on purpose: they are used both at ingest time and at output time,
 * in the API serializers and during frontend rendering.
 */

// Tags allowed in sanitized HTML, with the attributes allowed on them.
const ALLOWED_TAGS = new Map<string, readonly string[]>([
	['a', ['href', 'rel', 'class']],
	['b', []],
	['blockquote', []],
	['br', []],
	['code', []],
	['del', []],
	['em', []],
	['i', []],
	['li', ['value']],
	['ol', ['start', 'reversed']],
	['p', []],
	['pre', []],
	['s', []],
	['span', ['class']],
	['strong', []],
	['u', []],
	['ul', []],
])

// Tags that are dropped together with their contents.
const DROPPED_WITH_CONTENT = new Set([
	'applet',
	'base',
	'embed',
	'form',
	'frame',
	'frameset',
	'iframe',
	'link',
	'math',
	'meta',
	'noembed',
	'noframes',
	'noscript',
	'object',
	'script',
	'style',
	'svg',
	'template',
	'textarea',
	'title',
	'xmp',
])

// Unknown block level tags become `<p>`, like in Mastodon. Any other unknown tag is unwrapped.
const BLOCK_TAGS = new Set([
	'article',
	'aside',
	'dd',
	'div',
	'dl',
	'dt',
	'footer',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'header',
	'main',
	'nav',
	'section',
])

const VOID_TAGS = new Set(['br'])

// Micro-formats and semantic classes, as used by Mastodon, Misskey, GoToSocial and Pleroma.
const ALLOWED_CLASS = /^(?:(?:h|p|u|dt|e)-[a-zA-Z0-9-]+|mention|hashtag|ellipsis|invisible)$/

// Mastodon only allows `http(s)` and relative links; `mailto:` is deliberately not allowed.
const ALLOWED_SCHEMES = new Set(['http', 'https'])

const TAG_START = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const NAMED_ENTITIES = new Map([
	['amp', '&'],
	['apos', "'"],
	['gt', '>'],
	['lt', '<'],
	['nbsp', ' '],
	['quot', '"'],
])

/** Escapes `text` so that it can safely be used as HTML content or as a quoted attribute value. */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/** Renders plain text as HTML, like Mastodon does for local account notes. */
export function textToHtml(text: string): string {
	const paragraphs = text
		.replace(/\r\n?/g, '\n')
		.split(/\n{2,}/)
		.filter((paragraph) => paragraph.trim() !== '')
	return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`).join('')
}

/** Decodes the HTML entities of `value` once, like a browser does before resolving a URL. */
export function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, entity: string) => {
		if (entity.startsWith('#')) {
			const code =
				entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
				return match
			}
			try {
				return String.fromCodePoint(code)
			} catch {
				return match
			}
		}
		return NAMED_ENTITIES.get(entity.toLowerCase()) ?? match
	})
}

/** Sanitizes `unsafe` HTML, keeping only the allowed tags, attributes, classes and URLs. */
export function sanitizeHtml(unsafe: string): string {
	if (unsafe === '') {
		return ''
	}

	let out = ''
	const open: string[] = []

	const close = (name: string): void => {
		const index = open.lastIndexOf(name)
		if (index === -1) {
			return
		}
		for (let i = open.length - 1; i >= index; i--) {
			out += `</${open[i]}>`
		}
		open.length = index
	}

	let i = 0
	while (i < unsafe.length) {
		const start = unsafe.indexOf('<', i)
		if (start === -1) {
			out += escapeTextNode(unsafe.slice(i))
			break
		}
		if (start > i) {
			out += escapeTextNode(unsafe.slice(i, start))
		}
		if (unsafe.startsWith('<!--', start)) {
			const end = unsafe.indexOf('-->', start + 4)
			i = end === -1 ? unsafe.length : end + 3
			continue
		}
		if (unsafe.startsWith('<!', start) || unsafe.startsWith('<?', start)) {
			const end = unsafe.indexOf('>', start)
			i = end === -1 ? unsafe.length : end + 1
			continue
		}

		const tag = TAG_START.exec(unsafe.slice(start))
		if (tag === null) {
			out += '&lt;'
			i = start + 1
			continue
		}
		i = start + tag[0].length

		const closing = tag[1] === '/'
		const raw = tag[2].toLowerCase()
		if (DROPPED_WITH_CONTENT.has(raw)) {
			if (!closing) {
				i = skipContent(unsafe, i, raw)
			}
			continue
		}

		const name = ALLOWED_TAGS.has(raw) ? raw : BLOCK_TAGS.has(raw) ? 'p' : null
		if (name === null) {
			// unwrap: the tag is dropped but its contents are kept
			continue
		}
		if (closing) {
			close(name)
			continue
		}
		if (VOID_TAGS.has(name)) {
			out += `<${name} />`
			continue
		}
		if (name === 'p') {
			// `<p>` cannot contain a `<p>`
			close('p')
		}
		out += `<${name}${sanitizeAttributes(name, tag[3])}>`
		open.push(name)
	}

	for (let j = open.length - 1; j >= 0; j--) {
		out += `</${open[j]}>`
	}
	return out
}

/** Removes all HTML from `unsafe`, leaving only its text content. */
export function htmlToText(unsafe: string): string {
	if (unsafe === '') {
		return ''
	}

	let out = ''
	let i = 0
	while (i < unsafe.length) {
		const start = unsafe.indexOf('<', i)
		if (start === -1) {
			out += decodeHtmlEntities(unsafe.slice(i))
			break
		}
		if (start > i) {
			out += decodeHtmlEntities(unsafe.slice(i, start))
		}
		if (unsafe.startsWith('<!--', start)) {
			const end = unsafe.indexOf('-->', start + 4)
			i = end === -1 ? unsafe.length : end + 3
			continue
		}
		if (unsafe.startsWith('<!', start) || unsafe.startsWith('<?', start)) {
			const end = unsafe.indexOf('>', start)
			i = end === -1 ? unsafe.length : end + 1
			continue
		}

		const tag = TAG_START.exec(unsafe.slice(start))
		if (tag === null) {
			out += '<'
			i = start + 1
			continue
		}
		i = start + tag[0].length

		const name = tag[2].toLowerCase()
		if (DROPPED_WITH_CONTENT.has(name)) {
			if (tag[1] !== '/') {
				i = skipContent(unsafe, i, name)
			}
			continue
		}
		if (name === 'br' || name === 'p' || BLOCK_TAGS.has(name)) {
			out += ' '
		}
	}
	return out.trim()
}

/** Returns the index right after the closing tag of `name`, dropping the element contents. */
function skipContent(unsafe: string, from: number, name: string): number {
	const end = new RegExp(`</${name}\\s*>`, 'i').exec(unsafe.slice(from))
	if (end === null) {
		return unsafe.length
	}
	return from + end.index + end[0].length
}

function sanitizeAttributes(name: string, raw: string): string {
	const allowed = ALLOWED_TAGS.get(name)!
	let out = ''

	ATTRIBUTE.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = ATTRIBUTE.exec(raw)) !== null) {
		const attribute = match[1].toLowerCase()
		if (!allowed.includes(attribute) || attribute === 'rel') {
			continue
		}
		const value = match[2] ?? match[3] ?? match[4] ?? ''

		if (attribute === 'class') {
			const classes = value
				.split(/\s+/)
				.map((c) => decodeHtmlEntities(c))
				.filter((c) => ALLOWED_CLASS.test(c))
			if (classes.length > 0) {
				out += ` class="${escapeHtml(classes.join(' '))}"`
			}
			continue
		}
		if (attribute === 'href') {
			const url = sanitizeUrl(value)
			if (url !== null) {
				out += ` href="${escapeHtml(url)}"`
			}
			continue
		}
		out += ` ${attribute}="${escapeHtml(decodeHtmlEntities(value))}"`
	}

	if (name === 'a') {
		out += ' rel="nofollow noopener noreferrer" target="_blank"'
	}
	return out
}

/** Returns the URL to use, or `null` when its scheme is not allowed. */
function sanitizeUrl(value: string): string | null {
	// browsers ignore whitespace and control characters when resolving the scheme
	// eslint-disable-next-line no-control-regex -- control characters are what is being stripped
	const url = decodeHtmlEntities(value).replace(/[\u0000- \u007f]/g, '')
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)
	if (scheme === null) {
		// relative URL
		return url
	}
	return ALLOWED_SCHEMES.has(scheme[1].toLowerCase()) ? url : null
}

/** Escapes a text node, leaving the existing entities of `text` alone. */
function escapeTextNode(text: string): string {
	return text
		.replace(/&(?![#a-zA-Z0-9]+;)/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}
