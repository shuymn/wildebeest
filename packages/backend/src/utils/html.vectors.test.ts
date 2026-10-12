import { strict as assert } from 'node:assert/strict'

import { type DefaultTreeAdapterMap, html, parseFragment } from 'parse5'

import { htmlToText, sanitizeHtml } from '@wildebeest/backend/utils/html'
import { DOMPURIFY_VECTORS } from '@wildebeest/backend/utils/html.vectors.dompurify'
import { HTML5SEC_VECTORS } from '@wildebeest/backend/utils/html.vectors.html5sec'
import { OWASP_VECTORS } from '@wildebeest/backend/utils/html.vectors.owasp'
import { SANITIZE_HTML_VECTORS } from '@wildebeest/backend/utils/html.vectors.sanitize-html'

// Each vector source lives in its own file under the source's license; see the header of each file.
type Vector = readonly [name: string, payload: string]

type ParentNode = DefaultTreeAdapterMap['parentNode']
type ChildNode = DefaultTreeAdapterMap['childNode']
type Element = DefaultTreeAdapterMap['element']

// The DOM that sanitized HTML may produce: the sanitizer allowlist, plus the `target` it adds to links.
const ALLOWED_DOM = new Map<string, readonly string[]>([
	['a', ['href', 'rel', 'class', 'target']],
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

const FORBIDDEN_ELEMENTS = new Set([
	'base',
	'embed',
	'form',
	'iframe',
	'math',
	'meta',
	'object',
	'script',
	'style',
	'svg',
])

const VECTORS: readonly (readonly [source: string, vectors: readonly Vector[]])[] = [
	['DOMPurify', DOMPURIFY_VECTORS],
	['OWASP XSS Filter Evasion Cheat Sheet', OWASP_VECTORS],
	['html5sec.org', HTML5SEC_VECTORS],
	['sanitize-html', SANITIZE_HTML_VECTORS],
]

// Sanitized HTML is rendered inside a `<div>` by the frontend, so it is parsed in that context.
const DIV = parseFragment('<div></div>').childNodes[0] as Element

function elements(node: ParentNode | ChildNode): Element[] {
	const found: Element[] = []
	const visit = (current: ParentNode | ChildNode): void => {
		if ('tagName' in current) {
			found.push(current)
		}
		if ('childNodes' in current) {
			current.childNodes.forEach(visit)
		}
		if ('content' in current) {
			visit(current.content)
		}
	}
	visit(node)
	return found
}

/** Returns why `html` is not safe according to the spec-compliant parse5 parser, or an empty list. */
function unsafeParts(markup: string): string[] {
	const problems: string[] = []
	for (const element of elements(parseFragment(DIV, markup, {}))) {
		const name = element.tagName
		if (element.namespaceURI !== html.NS.HTML) {
			problems.push(`<${name}> in namespace ${element.namespaceURI}`)
		}
		if (FORBIDDEN_ELEMENTS.has(name)) {
			problems.push(`forbidden <${name}>`)
		}
		const allowed = ALLOWED_DOM.get(name)
		if (allowed === undefined) {
			problems.push(`unknown <${name}>`)
		}
		for (const { name: attribute, value } of element.attrs) {
			if (attribute.startsWith('on')) {
				problems.push(`event handler ${name}@${attribute}`)
			}
			if (!(allowed ?? []).includes(attribute)) {
				problems.push(`unknown attribute ${name}@${attribute}`)
			}
			// parse5 already decoded the entities of `value`; the URL parser applies the browser's scheme rules
			if (attribute === 'href') {
				let protocol = null
				try {
					protocol = new URL(value, 'https://example.com/').protocol
				} catch {
					// not a valid URL
				}
				if (protocol !== 'http:' && protocol !== 'https:') {
					problems.push(`href ${JSON.stringify(value)}`)
				}
			}
		}
	}
	return problems
}

/**
 * The escaping of Qwik SSR for text and attribute values (`ESCAPE_HTML = /[&<>'"]/g` in
 * `@builder.io/qwik/dist/core.mjs`), where the frontend renders plain text such as `display_name`
 * and `spoiler_text`. It is reproduced here so that the check does not depend on our own escaping.
 */
function qwikEscape(text: string): string {
	return text.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]!)
}

describe('vector oracle', () => {
	test('flags unsafe HTML', () => {
		assert.deepEqual(unsafeParts('<p>x <a href="https://a.example" rel="nofollow" target="_blank">y</a></p>'), [])
		assert.notDeepEqual(unsafeParts('<img src=x onerror=alert(1)>'), [])
		assert.notDeepEqual(unsafeParts('<a href="jav&#x61;script:alert(1)">x</a>'), [])
		assert.notDeepEqual(unsafeParts('<a href=" java\tscript:alert(1)">x</a>'), [])
		assert.notDeepEqual(unsafeParts('<p title="x">x</p>'), [])
		assert.notDeepEqual(unsafeParts('<p><svg><p>x</p></svg></p>'), [])
		assert.notDeepEqual(unsafeParts('<a/onclick="x">x</a>'), [])
	})
})

describe.each(VECTORS)('XSS vectors from %s', (_, vectors) => {
	test.each(vectors)('sanitizeHtml: %s', (_, payload) => {
		const sanitized = sanitizeHtml(payload)
		assert.deepEqual(unsafeParts(sanitized), [], sanitized)
		assert.equal(sanitizeHtml(sanitized), sanitized, 'sanitizing again changes the output')
	})

	test.each(vectors)('htmlToText: %s', (_, payload) => {
		const text = htmlToText(payload)
		// the HTML input stream preprocessing normalizes newlines, and NUL characters are dropped from text
		// and replaced in attribute values
		const normalized = text.replace(/\r\n?/g, '\n')

		const inText = parseFragment(DIV, `<span>${qwikEscape(text)}</span>`, {})
		assert.deepEqual(
			elements(inText).map((element) => element.tagName),
			['span']
		)
		const [span] = inText.childNodes as Element[]
		assert.equal(
			span.childNodes.map((node) => (node as DefaultTreeAdapterMap['textNode']).value).join(''),
			normalized.replaceAll('\0', '')
		)

		const inAttribute = parseFragment(DIV, `<img alt="${qwikEscape(text)}">`, {})
		assert.deepEqual(
			elements(inAttribute).map((element) => element.tagName),
			['img']
		)
		assert.deepEqual((inAttribute.childNodes[0] as Element).attrs, [
			{ name: 'alt', value: normalized.replaceAll('\0', '\ufffd') },
		])
	})
})
