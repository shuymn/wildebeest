import { type DefaultTreeAdapterMap, html, parseFragment } from 'parse5'
import { describe, expect, it } from 'vitest'

import { DOMPURIFY_VECTORS } from '../../backend/src/utils/html.vectors.dompurify'
import { HTML5SEC_VECTORS } from '../../backend/src/utils/html.vectors.html5sec'
import { OWASP_VECTORS } from '../../backend/src/utils/html.vectors.owasp'
import { SANITIZE_HTML_VECTORS } from '../../backend/src/utils/html.vectors.sanitize-html'
import { REMOTE_HTML_RAW_LIMIT, sanitizeRemoteHtml } from '../src/security/html'

// HTML-1: remote HTML is sanitized by allowlist. The vector suites are the shared ones in packages/backend (each file
// keeps its source's license); the oracle is parse5, the spec HTML parser, reading the output as a browser would
// inside the <div> a client renders it in. The allowlist is Mastodon's MASTODON_STRICT, with http(s) links only
// (HTML-3) and the rel and target every link gets.

type ChildNode = DefaultTreeAdapterMap['childNode']
type ParentNode = DefaultTreeAdapterMap['parentNode']
type Element = DefaultTreeAdapterMap['element']

const ALLOWED = new Map<string, readonly string[]>([
	['a', ['href', 'class', 'translate', 'rel', 'target']],
	['b', []],
	['blockquote', []],
	['br', []],
	['code', []],
	['del', []],
	['em', []],
	['i', []],
	['li', ['value']],
	['ol', ['start', 'reversed']],
	['p', ['class']],
	['pre', []],
	['rp', []],
	['rt', []],
	['ruby', []],
	['s', []],
	['span', ['class', 'translate']],
	['strong', []],
	['u', []],
	['ul', []],
])

const DIV = parseFragment('<div></div>').childNodes[0] as Element

// Iterative: the worst cases nest deeper than the call stack.
function elements(root: ParentNode | ChildNode): Element[] {
	const found: Element[] = []
	const pending = [root]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if ('tagName' in node) {
			found.push(node)
		}
		if ('childNodes' in node) {
			pending.push(...node.childNodes)
		}
		if ('content' in node) {
			pending.push(node.content)
		}
	}
	return found
}

// Why the markup is not safe as a browser parses it, or an empty list.
function unsafeParts(markup: string): string[] {
	const problems: string[] = []
	for (const element of elements(parseFragment(DIV, markup, {}))) {
		const name = element.tagName
		if (element.namespaceURI !== html.NS.HTML) {
			problems.push(`<${name}> in namespace ${element.namespaceURI}`)
		}
		const allowed = ALLOWED.get(name)
		if (allowed === undefined) {
			problems.push(`<${name}>`)
		}
		for (const { name: attribute, value } of element.attrs) {
			if (!(allowed ?? []).includes(attribute)) {
				problems.push(`${name}@${attribute}`)
			}
			if (attribute === 'href') {
				let protocol: string | null = null
				try {
					protocol = new URL(value).protocol
				} catch {
					// not an absolute URL
				}
				if (protocol !== 'http:' && protocol !== 'https:') {
					problems.push(`href ${JSON.stringify(value)}`)
				}
			}
			if (
				attribute === 'class' &&
				!value.split(' ').every((c) => /^((h|p|u|dt|e)-.|mention$|hashtag$|ellipsis$|invisible$)/.test(c))
			) {
				problems.push(`class ${JSON.stringify(value)}`)
			}
		}
	}
	return problems
}

const SUITES = [
	['DOMPurify', DOMPURIFY_VECTORS],
	['OWASP XSS Filter Evasion Cheat Sheet', OWASP_VECTORS],
	['html5sec.org', HTML5SEC_VECTORS],
	['sanitize-html', SANITIZE_HTML_VECTORS],
] as const

describe('the oracle', () => {
	it('flags unsafe markup', () => {
		expect(unsafeParts('<p>x <a href="https://a.example" rel="nofollow noopener" target="_blank">y</a></p>')).toEqual(
			[]
		)
		expect(unsafeParts('<img src=x onerror=alert(1)>')).not.toEqual([])
		expect(unsafeParts('<a href="jav&#x61;script:alert(1)">x</a>')).not.toEqual([])
		expect(unsafeParts('<p title="x">x</p>')).not.toEqual([])
		expect(unsafeParts('<p><svg><p>x</p></svg></p>')).not.toEqual([])
		expect(unsafeParts('<span class="evil">x</span>')).not.toEqual([])
	})
})

describe.each(SUITES)('HTML-1: XSS vectors from %s', (_, vectors) => {
	it.each(vectors)('%s', (_, payload) => {
		const sanitized = sanitizeRemoteHtml(payload)
		expect(unsafeParts(sanitized), sanitized).toEqual([])
		expect(sanitizeRemoteHtml(sanitized), 'sanitizing again changes the output').toBe(sanitized)
	})
})

describe('HTML-1: Mastodon’s MASTODON_STRICT', () => {
	it.each([
		[
			'keeps the allowlisted tags',
			'<p>a<br>b <b>c</b> <i>d</i> <u>e</u> <s>f</s> <del>g</del> <code>h</code></p><pre>i</pre><blockquote>j</blockquote>',
		],
		['keeps lists and their attributes', '<ol start="3" reversed><li value="5">x</li></ol><ul><li>y</li></ul>'],
		['keeps ruby', '<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby>'],
	])('%s', (_, input) => {
		expect(sanitizeRemoteHtml(input)).toBe(input)
	})

	it.each([
		[
			'filters classes to microformats and the semantic ones',
			'<span class="h-card evil mention">x</span><p class="ellipsis bad">y</p>',
			'<span class="h-card mention">x</span><p class="ellipsis">y</p>',
		],
		[
			'adds rel and target to links and drops other link attributes',
			'<a href="https://a.example/?x=1&amp;y=2" rel="me" target="_self" title="t" translate="no">a</a>',
			'<a href="https://a.example/?x=1&amp;y=2" translate="no" rel="nofollow noopener" target="_blank">a</a>',
		],
		['keeps translate only as "no"', '<span translate="yes">x</span>', '<span>x</span>'],
		['turns headings into strong paragraphs', '<h1>Title</h1>', '<p><strong>Title</strong></p>'],
		['unwraps unknown tags and keeps their text', '<div><article>text</article></div>', 'text'],
		[
			'drops script, style, svg and math with their content',
			'<script>a</script><style>b</style><svg><p>c</p></svg><math>d</math>e',
			'e',
		],
		['removes comments', 'a<!-- b -->c', 'ac'],
		// HTML-3: links are http(s) only; Mastodon would keep some other schemes.
		[
			'drops the href of a non-http(s) link',
			'<a href="gemini://x.example">g</a><a href="/relative">r</a>',
			'<a rel="nofollow noopener" target="_blank">g</a><a rel="nofollow noopener" target="_blank">r</a>',
		],
	])('%s', (_, input, expected) => {
		expect(sanitizeRemoteHtml(input)).toBe(expected)
	})

	// RES-1, RES-2: the input is cut at the raw cap, and the worst cases at the cap finish quickly.
	it.each([
		['nested tags', '<b>'.repeat(REMOTE_HTML_RAW_LIMIT / 3)],
		['unclosed attribute quotes', '<a href="'.repeat(REMOTE_HTML_RAW_LIMIT / 9)],
		['angle brackets', '<'.repeat(REMOTE_HTML_RAW_LIMIT)],
		['dropped tag openers', '<script>'.repeat(REMOTE_HTML_RAW_LIMIT / 8)],
	])('handles %s at the raw cap within a generous time', (_, input) => {
		const started = performance.now()
		const sanitized = sanitizeRemoteHtml(input + input)
		expect(performance.now() - started).toBeLessThan(1000)
		expect(unsafeParts(sanitized)).toEqual([])
	})
})
