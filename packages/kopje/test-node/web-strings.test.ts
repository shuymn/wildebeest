import type { Node } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

import { guardFixtures, lineOf, parse, sources, walk, type Source } from './source-scan.js'

// docs/web-pages.md, "English UI, ready for translation": the web UI's text comes from the catalogue
// (src/web/strings.ts) through useUi(), so a page can be translated. No component or page writes words itself: no
// letters in JSX text, in a string a JSX child renders, or in a literal aria-label, title, alt, placeholder or label.
// The setup wizard is not catalogued.

const EXCEPTIONS = new Set(['src/web/setup-pages.tsx'])
const NAMED_ATTRIBUTES = new Set(['aria-label', 'title', 'alt', 'placeholder', 'label'])
const LETTER = /\p{L}/u

// The words a string-valued expression may render: a literal, a template's text, either branch of a condition and the
// right side of && or ||.
function words(node: Node | null | undefined): string[] {
	if (node === null || node === undefined) {
		return []
	}
	switch (node.type) {
		case 'Literal':
			return typeof node.value === 'string' && LETTER.test(node.value) ? [node.value] : []
		case 'TemplateLiteral':
			return node.quasis.map((q) => q.value.cooked ?? '').filter((text) => LETTER.test(text))
		case 'ConditionalExpression':
			return [...words(node.consequent), ...words(node.alternate)]
		case 'LogicalExpression':
			return words(node.right)
		default:
			return []
	}
}

function uncatalogued(files: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of files) {
		if (!source.path.endsWith('.tsx') || EXCEPTIONS.has(source.path)) {
			continue
		}
		const at = (node: Node, what: string) => found.push(`${source.path}:${lineOf(source.text, node.start)}: ${what}`)
		walk(parse(source).program, (node, parents) => {
			if (node.type === 'JSXText' && LETTER.test(node.value)) {
				at(node, `text ${JSON.stringify(node.value.trim())}`)
			} else if (node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier') {
				const name = node.name.name
				const value = node.value?.type === 'JSXExpressionContainer' ? node.value.expression : node.value
				for (const text of NAMED_ATTRIBUTES.has(name) ? words(value as Node | null) : []) {
					at(node, `${name} ${JSON.stringify(text)}`)
				}
			} else if (
				node.type === 'JSXExpressionContainer' &&
				(parents[0]?.type === 'JSXElement' || parents[0]?.type === 'JSXFragment')
			) {
				for (const text of words(node.expression as Node)) {
					at(node, `child ${JSON.stringify(text)}`)
				}
			}
		})
	}
	return found
}

describe('web UI strings (design §9.7)', () => {
	const SOURCES = sources('src/web')

	it('sees the components and pages', () => {
		const paths = SOURCES.map((s) => s.path)
		expect(paths).toContain('src/web/components/layout.tsx')
		expect(paths).toContain('src/web/pages/profile.tsx')
	})

	it('writes no words outside the catalogue', () => {
		expect(uncatalogued(SOURCES)).toEqual([])
	})

	describe('the finder', () => {
		guardFixtures(
			uncatalogued,
			{
				flagged: {
					'JSX text': ['export const A = () => <p>Hello</p>', 'src/web/pages/probe.tsx:1: text "Hello"'],
					'Japanese JSX text': [
						'export const A = () => <p>こんにちは</p>',
						'src/web/pages/probe.tsx:1: text "こんにちは"',
					],
					'a literal child': ["export const A = () => <p>{'Hello'}</p>", 'src/web/pages/probe.tsx:1: child "Hello"'],
					'a template child': [
						'export const A = (n: number) => <p>{`${n} posts`}</p>',
						'src/web/pages/probe.tsx:1: child " posts"',
					],
					'a conditional child': [
						"export const A = (a: boolean) => <p>{a ? 'Avatar' : 'Header'}</p>",
						'src/web/pages/probe.tsx:1: child "Avatar"',
					],
					'an aria-label': [
						'export const A = () => <a href="/" aria-label="Home">x</a>',
						'src/web/pages/probe.tsx:1: aria-label "Home"',
					],
					'an alt in braces': [
						'export const A = () => <img src="/a.png" alt={\'An image\'} />',
						'src/web/pages/probe.tsx:1: alt "An image"',
					],
					'a placeholder': [
						'export const A = () => <input placeholder="Search" />',
						'src/web/pages/probe.tsx:1: placeholder "Search"',
					],
					'a title': ['export const A = () => <span title="Note" />', 'src/web/pages/probe.tsx:1: title "Note"'],
				},
				passed: {
					'catalogue text': 'export const A = (m: { a: string }) => <p>{m.a}</p>',
					punctuation: "export const A = (t: string) => <p>#{t}{' · '}@</p>",
					'an empty alt': 'export const A = () => <img src="/a.png" alt="" />',
					'a class and an href': 'export const A = () => <a class="btn quiet" href="/about">{1}</a>',
					'a comparison inside an expression': "export const A = (k: string) => <p>{k === 'avatar' ? 1 : 2}</p>",
				},
			},
			{ path: 'src/web/pages/probe.tsx' }
		)
	})
})
