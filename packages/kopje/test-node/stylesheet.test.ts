import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { ASSET_HEADERS, FINGERPRINTED_HEADERS } from '../browser/headers.js'
import { drift, releaseForCheck, stylesheet } from '../scripts/build-assets.mjs'
import { L1_SCRIPT, PREVIOUS_STYLESHEET, STYLESHEET } from '../src/web/asset-versions.js'

// The web stylesheet (design §6, §10.7, §14.10) and its publication (amendments A1, A12). The Workers suites call
// app.fetch directly and never reach Static Assets, so the asset rules are checked here, on the files. The rules are
// checked on the served file, minified from src/web/kopje.css, so the patterns allow any whitespace.

const PACKAGE = new URL('../', import.meta.url)
const SERVED = readFileSync(new URL(`public${STYLESHEET}`, PACKAGE))
const CSS = SERVED.toString('utf8')
const HEADERS = readFileSync(new URL('public/_headers', PACKAGE), 'utf8')
const ASSET_NAMES = readdirSync(new URL('public/assets/', PACKAGE))

// The light and dark value of each token: `--name: light-dark(#light, #dark)`.
function tokens(css: string): Map<string, { light: string; dark: string }> {
	const found = new Map<string, { light: string; dark: string }>()
	for (const [, name, light, dark] of css.matchAll(
		/--([a-z0-9-]+):\s*light-dark\((#[0-9a-f]{3,6}),\s*(#[0-9a-f]{3,6})\)/g
	)) {
		found.set(name!, { light: light!, dark: dark! })
	}
	return found
}

// WCAG 2.2 relative luminance and contrast ratio.
function luminance(hex: string): number {
	const digits =
		hex.length === 4 ? [...hex.slice(1)].map((d) => d + d) : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)]
	const [r = 0, g = 0, b = 0] = digits.map((d) => {
		const c = parseInt(d, 16) / 255
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
	return (hi! + 0.05) / (lo! + 0.05)
}

// public/_headers as rules: the path pattern and its header lines.
function headerRules(text: string): { pattern: string; headers: string[] }[] {
	const rules: { pattern: string; headers: string[] }[] = []
	for (const line of text.split('\n')) {
		if (line.trim() === '' || line.startsWith('#')) {
			continue
		}
		if (/^\s/.test(line)) {
			rules.at(-1)?.headers.push(line.trim())
		} else {
			rules.push({ pattern: line.trim(), headers: [] })
		}
	}
	return rules
}

// A _headers path pattern: `*` matches any run of characters.
const matches = (pattern: string, path: string) =>
	new RegExp(
		`^${pattern
			.split('*')
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*')}$`
	).test(path)

const IMMUTABLE = 'Cache-Control: public, max-age=31536000, immutable'

// The header lines public/_headers gives a path.
const HEADER_RULES = headerRules(HEADERS)
const headerLinesOf = (path: string) =>
	HEADER_RULES.filter((rule) => matches(rule.pattern, path)).flatMap((rule) => rule.headers)

describe('the stylesheet', () => {
	const TOKENS = tokens(CSS)
	const pair = (name: string) => {
		const token = TOKENS.get(name)
		expect(token, name).toBeDefined()
		return token!
	}

	it('declares both colour schemes and every token for each', () => {
		expect(CSS).toMatch(/:root\s*\{\s*color-scheme:\s*light dark;/)
		for (const name of ['ground', 'surface', 'raised', 'ink', 'muted', 'line', 'accent', 'on-accent', 'soft']) {
			pair(name)
		}
		for (const name of [
			'control-line',
			'danger',
			'ok',
			'warn',
			'scrim',
			'share',
			'share-lead',
			'primary',
			'on-primary',
		]) {
			pair(name)
		}
	})

	it('keeps text at 4.5:1 and controls and the focus ring at 3:1 in both schemes (WCAG 1.4.3, 1.4.11)', () => {
		const text: [string, string][] = []
		for (const fg of ['ink', 'muted', 'accent']) {
			for (const bg of ['ground', 'surface', 'raised', 'soft']) {
				text.push([fg, bg])
			}
		}
		text.push(['on-accent', 'accent'], ['on-primary', 'primary'], ['danger', 'ground'], ['danger', 'surface'])
		// A poll choice's text over its share's fill.
		text.push(['ink', 'share'], ['ink', 'share-lead'])
		const controls: [string, string][] = []
		// Controls, the focus ring, and an alert's bar and icon.
		for (const fg of ['control-line', 'accent', 'ok', 'warn', 'danger']) {
			for (const bg of ['ground', 'surface', 'raised']) {
				controls.push([fg, bg])
			}
		}
		for (const scheme of ['light', 'dark'] as const) {
			for (const [fg, bg] of text) {
				expect(contrast(pair(fg)[scheme], pair(bg)[scheme]), `${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
			}
			for (const [fg, bg] of controls) {
				expect(contrast(pair(fg)[scheme], pair(bg)[scheme]), `${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(3)
			}
		}
	})

	it('loads nothing else and shows focus with an outline', () => {
		expect(CSS).not.toMatch(/@import|@font-face/)
		expect(CSS).not.toMatch(/url\(/)
		expect(CSS).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent\);/)
		expect(CSS).not.toMatch(/outline:\s*(none|0)\b/)
	})

	it('keeps hidden things hidden and closed dialogs unrendered (§6.7)', () => {
		expect(CSS).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/)
		// Every selector naming a dialog names an open one, so no rule gives a closed dialog a display.
		for (const [selector] of CSS.matchAll(/[^{};]*\bdialog\b[^{};]*(?=\{)/g)) {
			expect(selector, selector).toContain('[open]')
		}
	})

	it('animates nothing outside prefers-reduced-motion: no-preference, and has no global override (§14.9, A7)', () => {
		expect(CSS).not.toMatch(/prefers-reduced-motion:\s*reduce/)
		// Each no-preference block, by its braces, is the only place an animation or transition may be.
		let outside = CSS
		const NO_PREFERENCE = /@media\s*\(prefers-reduced-motion:\s*no-preference\)/
		for (let at = outside.search(NO_PREFERENCE); at !== -1;) {
			let depth = 0
			let end = outside.indexOf('{', at)
			do {
				const c = outside[end]
				depth += c === '{' ? 1 : c === '}' ? -1 : 0
				end++
			} while (depth > 0 && end < outside.length)
			outside = outside.slice(0, at) + outside.slice(end)
			at = outside.search(NO_PREFERENCE)
		}
		expect(outside).not.toMatch(/\b(animation|transition)(-[a-z-]+)?\s*:/)
	})

	it('declares color-scheme in the order the pages’ meta tags use', () => {
		expect(CSS).toMatch(/color-scheme:\s*light dark;/)
		for (const file of ['src/web/components/layout.tsx', 'src/web/pages/embed.tsx']) {
			expect(readFileSync(new URL(file, PACKAGE), 'utf8'), file).toContain(
				'<meta name="color-scheme" content="light dark" />'
			)
		}
	})

	it('stays within 16 KiB raw and 5 KiB gzip as served (§13, A12)', () => {
		expect(SERVED.byteLength).toBeLessThanOrEqual(16 * 1024)
		expect(gzipSync(SERVED).byteLength).toBeLessThanOrEqual(5 * 1024)
	})
})

// A stylesheet's declarations in source order, each with the selectors it is nested in (`rule` the innermost) and
// whether a comment sits directly above it (after the previous declaration or brace). Custom properties are left out.
type Declaration = { selector: string; rule: string; property: string; value: string; commented: boolean }

function declarations(css: string): Declaration[] {
	const found: Declaration[] = []
	const selectors: string[] = []
	let text = ''
	let commented = false
	for (let at = 0; at < css.length;) {
		if (css.startsWith('/*', at)) {
			commented ||= text.trim() === ''
			at = css.indexOf('*/', at + 2) + 2
			continue
		}
		const c = css[at]!
		if (c === "'" || c === '"') {
			const end = css.indexOf(c, at + 1)
			text += css.slice(at, end + 1)
			at = end + 1
			continue
		}
		if (c === '{') {
			selectors.push(text.trim())
		} else if (c === ';' || c === '}') {
			const declaration = text.trim()
			const colon = declaration.indexOf(':')
			if (declaration !== '' && !declaration.startsWith('--')) {
				found.push({
					selector: selectors.join(' '),
					rule: selectors.at(-1) ?? '',
					property: declaration.slice(0, colon).trim(),
					value: declaration.slice(colon + 1).trim(),
					commented,
				})
			}
			if (c === '}') {
				selectors.pop()
			}
		} else {
			text += c
			at++
			continue
		}
		text = ''
		commented = false
		at++
	}
	return found
}

// A value's space-separated parts, keeping parenthesized ones whole.
function parts(value: string): string[] {
	const out: string[] = []
	let depth = 0
	let part = ''
	for (const c of value) {
		depth += c === '(' ? 1 : c === ')' ? -1 : 0
		if (/\s/.test(c) && depth === 0) {
			if (part !== '') {
				out.push(part)
			}
			part = ''
		} else {
			part += c
		}
	}
	return part === '' ? out : [...out, part]
}

const SPACING = /^(margin|padding)(-|$)|^(row-|column-)?gap$/
const GEOMETRY = /^(top|right|bottom|left|inset)(-|$)/
const RADIUS = /^border(-[a-z]+)*-radius$/
const STEP = /^var\(--(s[1-6]|pad)\)$/
const NEGATIVE_STEP = /^calc\(-1 \* var\(--(s[1-6]|pad)\)\)$/
const COLOUR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|device-cmyk)\(/i
// Properties whose values name things other than colours.
const NOT_COLOURS = /^(font-family|content|counter-|container|grid-|animation|transition|will-change)/
// CSS Color 4's named colours (https://www.w3.org/TR/css-color-4/#named-colors), which a token stands for here.
const NAMED_COLOURS = new Set([
	'aliceblue',
	'antiquewhite',
	'aqua',
	'aquamarine',
	'azure',
	'beige',
	'bisque',
	'black',
	'blanchedalmond',
	'blue',
	'blueviolet',
	'brown',
	'burlywood',
	'cadetblue',
	'chartreuse',
	'chocolate',
	'coral',
	'cornflowerblue',
	'cornsilk',
	'crimson',
	'cyan',
	'darkblue',
	'darkcyan',
	'darkgoldenrod',
	'darkgray',
	'darkgreen',
	'darkgrey',
	'darkkhaki',
	'darkmagenta',
	'darkolivegreen',
	'darkorange',
	'darkorchid',
	'darkred',
	'darksalmon',
	'darkseagreen',
	'darkslateblue',
	'darkslategray',
	'darkslategrey',
	'darkturquoise',
	'darkviolet',
	'deeppink',
	'deepskyblue',
	'dimgray',
	'dimgrey',
	'dodgerblue',
	'firebrick',
	'floralwhite',
	'forestgreen',
	'fuchsia',
	'gainsboro',
	'ghostwhite',
	'gold',
	'goldenrod',
	'gray',
	'green',
	'greenyellow',
	'grey',
	'honeydew',
	'hotpink',
	'indianred',
	'indigo',
	'ivory',
	'khaki',
	'lavender',
	'lavenderblush',
	'lawngreen',
	'lemonchiffon',
	'lightblue',
	'lightcoral',
	'lightcyan',
	'lightgoldenrodyellow',
	'lightgray',
	'lightgreen',
	'lightgrey',
	'lightpink',
	'lightsalmon',
	'lightseagreen',
	'lightskyblue',
	'lightslategray',
	'lightslategrey',
	'lightsteelblue',
	'lightyellow',
	'lime',
	'limegreen',
	'linen',
	'magenta',
	'maroon',
	'mediumaquamarine',
	'mediumblue',
	'mediumorchid',
	'mediumpurple',
	'mediumseagreen',
	'mediumslateblue',
	'mediumspringgreen',
	'mediumturquoise',
	'mediumvioletred',
	'midnightblue',
	'mintcream',
	'mistyrose',
	'moccasin',
	'navajowhite',
	'navy',
	'oldlace',
	'olive',
	'olivedrab',
	'orange',
	'orangered',
	'orchid',
	'palegoldenrod',
	'palegreen',
	'paleturquoise',
	'palevioletred',
	'papayawhip',
	'peachpuff',
	'peru',
	'pink',
	'plum',
	'powderblue',
	'purple',
	'rebeccapurple',
	'red',
	'rosybrown',
	'royalblue',
	'saddlebrown',
	'salmon',
	'sandybrown',
	'seagreen',
	'seashell',
	'sienna',
	'silver',
	'skyblue',
	'slateblue',
	'slategray',
	'slategrey',
	'snow',
	'springgreen',
	'steelblue',
	'tan',
	'teal',
	'thistle',
	'tomato',
	'turquoise',
	'violet',
	'wheat',
	'white',
	'whitesmoke',
	'yellow',
	'yellowgreen',
])

// Whether a value writes a colour: a hex, a colour function or a named colour.
function writesColour(value: string): boolean {
	return (
		/#[0-9a-f]{3,8}\b/i.test(value) ||
		COLOUR_FUNCTION.test(value) ||
		value
			.toLowerCase()
			.split(/[\s,()/]+/)
			.some((word) => NAMED_COLOURS.has(word))
	)
}

// Whether every selector of a rule ends at a heading element (h1.oneline, not h1 span).
const headingRule = (rule: string) =>
	rule
		.split(',')
		.map((part) =>
			part
				.trim()
				.split(/[\s>+~]+/)
				.at(-1)!
				.replace(/^&/, '')
		)
		.every((compound) => /^h[1-6](?![\w-])/.test(compound))

// Every margin, padding and gap declaration outside the spacing scale, and every font size, weight and line height
// outside the type scale (kopje.css's header, docs/web-pages.md "UI rules"). A spacing part is a step, 0 or auto; a
// negative step, a negative length (a bleed) or an em length (rich content) only with a comment directly above. A
// size is a --t token or inherit; a weight 400 or 600, or 700 on a heading; a line height 1, 1.25 or 1.6, another
// only commented. A radius (and each corner's) is a --r token. An offset (top, inset and their kin) is 0, auto, a
// percentage or a step; any other length, a calc() of one included, only commented. A colour is a token: none is
// written outside :root, as a hex, a function or a name.
function offScale(css: string): string[] {
	const off: string[] = []
	for (const { selector, rule, property, value, commented } of declarations(css)) {
		const allowed = (() => {
			if (SPACING.test(property)) {
				return parts(value).every(
					(part) =>
						part === '0' ||
						part === 'auto' ||
						STEP.test(part) ||
						(commented && (NEGATIVE_STEP.test(part) || /^-[\d.]+(px|rem)$/.test(part) || /^[\d.]+em$/.test(part)))
				)
			}
			if (GEOMETRY.test(property)) {
				return (
					commented ||
					parts(value).every((part) => part === '0' || part === 'auto' || /^-?[\d.]+%$/.test(part) || STEP.test(part))
				)
			}
			if (RADIUS.test(property)) {
				return parts(value).every((part) => /^var\(--r-(control|inset|card|pill)\)$/.test(part))
			}
			if (!NOT_COLOURS.test(property) && selector !== ':root' && writesColour(value)) {
				return false
			}
			switch (property) {
				case 'font-size':
					return /^var\(--t[1-5]\)$/.test(value) || value === 'inherit'
				case 'font-weight':
					return value === '400' || value === '600' || (value === '700' && headingRule(rule))
				case 'line-height':
					return ['1', '1.25', '1.6'].includes(value) || commented
				case 'font':
					return value === 'inherit'
				default:
					// An em length (rich content's spacing, an emoji's size) is a commented exception wherever it is.
					return commented || !/(^|[^\w.])[\d.]+em\b/.test(value)
			}
		})()
		if (!allowed) {
			off.push(`${selector} { ${property}: ${value} }`)
		}
	}
	return off
}

describe('the stylesheet’s scales (docs/web-pages.md, "UI rules")', () => {
	const SOURCE = readFileSync(new URL('src/web/kopje.css', PACKAGE), 'utf8')

	it('defines the spacing and type scales on :root', () => {
		const root = /:root\s*\{([^}]*)\}/.exec(SOURCE)![1]!
		const value = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(root)?.[1]
		expect(['s1', 's2', 's3', 's4', 's5', 's6', 'pad'].map(value)).toEqual([
			'0.25rem',
			'0.5rem',
			'0.75rem',
			'1rem',
			'1.5rem',
			'2.5rem',
			'var(--s5)',
		])
		expect(['t1', 't2', 't3', 't4', 't5'].map(value)).toEqual(['0.875rem', '1rem', '1.125rem', '1.5rem', '2rem'])
	})

	it('spaces, sets type, rounds and colours only by the tokens, its exceptions commented', () => {
		expect(declarations(SOURCE).length).toBeGreaterThan(300)
		expect(offScale(SOURCE)).toEqual([])
	})

	it('flags each kind of declaration off the scales, and passes the scales and commented exceptions', () => {
		const flagged = [
			'a { margin: 0.6rem; }',
			'a { padding: 0 1.25rem; }',
			'a { gap: 12px; }',
			'a { column-gap: var(--t1); }',
			'a { margin-top: -1px; }',
			'a { margin: calc(-1 * var(--s3)); }',
			'a { margin-top: 0.75em; }',
			'/* a comment */ a { padding: 0.4rem; }',
			'a { font-size: 0.9375rem; }',
			'a { font-size: 0.92em; }',
			'a { font-weight: 700; }',
			'a { font-weight: 500; }',
			'a { line-height: 1.45; }',
			'a { font: 600 1rem sans-serif; }',
			'a { & b { gap: 1rem; } }',
			'a { border-radius: 8px; }',
			'a { color: #fff; }',
			'a { background: light-dark(#2228, #0009); }',
			'a { border-color: rgb(0 0 0); }',
			'a { border-top-left-radius: 8px; }',
			'a { border-start-end-radius: var(--r-pill) 4px; }',
			'a { color: red; }',
			'a { outline: 2px solid RebeccaPurple; }',
			'a { color: oklch(0.5 0.1 200); }',
			'a { background: hsl(0 0% 0%); }',
			'a { fill: color-mix(in srgb, var(--ink), white); }',
			'a { top: calc(100% + 3px); }',
			'a { inset-inline-start: 1rem; }',
			'a { left: -10rem; }',
			'h1 span { font-weight: 700; }',
			'a { block-size: 1.2em; }',
			'.x { & h2 a { font-weight: 700; } }',
		]
		for (const css of flagged) {
			expect(offScale(css), css).toHaveLength(1)
		}
		const passed = [
			'a { margin: 0 auto; padding: var(--s2) var(--pad); gap: 0 var(--s3); row-gap: var(--s6); }',
			'a {\n\t/* Bleed: over the banner. */\n\tmargin-top: -1.75rem;\n}',
			'a { /* Bleed. */ margin: calc(-1 * var(--s3)); }',
			'a { /* Rich content. */ margin-top: 0.75em; }',
			'a { font-size: var(--t1); font-weight: 600; line-height: 1.6; font: inherit; }',
			'h1, h2 { font-weight: 700; line-height: 1.25; } .x > h2 { font-weight: 700; }',
			'a { /* A control. */ line-height: 1.1; } a { --s9: 3px; }',
			"a::before { content: '; gap: 9px'; }",
			'a { border-radius: var(--r-pill); color: var(--ink); } :root { --x: #fff; color: light-dark(#000, #fff); }',
			'a { border-top-left-radius: var(--r-card); color: transparent; border-color: currentColor; }',
			"a { font-family: 'Red Hat', Tan; content: 'red'; }",
			'a { inset: 0; top: 100%; left: var(--s4); inset-block-start: -50%; }',
			'a {\n\t/* Geometry: past the avatar. */\n\tinset-inline-start: calc(var(--pad) + 21px);\n}',
			'h1.oneline, h2 { font-weight: 700; } .x { & > h3 { font-weight: 700; } }',
			'a {\n\t/* Em: an emoji. */\n\tblock-size: 1.2em;\n\tinline-size: 2rem;\n}',
		]
		for (const css of passed) {
			expect(offScale(css), css).toEqual([])
		}
	})
})

describe('the stylesheet’s publication (amendment A1)', () => {
	it('names the file holding the stylesheet’s bytes by their hash, and serves the source minified (A12)', () => {
		const hash = createHash('sha256').update(SERVED).digest('hex').slice(0, 10)
		expect(STYLESHEET).toBe(`/assets/kopje.${hash}.css`)
		expect(SERVED.equals(stylesheet(fileURLToPath(PACKAGE)))).toBe(true)
		expect(SERVED.byteLength).toBeLessThan(readFileSync(new URL('src/web/kopje.css', PACKAGE)).byteLength)
		expect(CSS).not.toContain('/*')
	})

	it('keeps the previous release’s stylesheet and no older one', () => {
		const kept = ASSET_NAMES.filter((name) => /^kopje(\.[0-9a-f]{10})?\.css$/.test(name)).sort()
		const expected = [STYLESHEET, PREVIOUS_STYLESHEET].map((path) => path.slice('/assets/'.length))
		expect(kept).toEqual([...new Set(expected)].sort())
	})

	it('is what scripts/build-assets.mjs writes', () => {
		// Against the latest release tag when the history has it; a shallow clone falls back to the recorded file
		// (scripts/build-assets.mjs), and the packing job, with the whole history, requires the tags.
		const root = fileURLToPath(PACKAGE)
		expect(drift(root, releaseForCheck(root).released)).toEqual([])
	})

	it('serves the fingerprinted assets as immutable, and nothing else', () => {
		for (const name of ASSET_NAMES) {
			const headers = headerLinesOf(`/assets/${name}`)
			expect(headers, name).toContain('X-Content-Type-Options: nosniff')
			const fingerprinted = /^kopje\.[0-9a-f]{10}\.(css|js)$/.test(name)
			expect(headers.includes(IMMUTABLE), name).toBe(fingerprinted)
		}
		for (const path of ['/assets/kopje.0123456789.css', '/assets/kopje.0123456789.js']) {
			expect(headerLinesOf(path), path).toContain(IMMUTABLE)
		}
		for (const path of ['/assets/kopje.css', '/assets/embed.js', '/assets/embed-status.js', '/assets/avatar.png']) {
			expect(headerLinesOf(path), path).not.toContain(IMMUTABLE)
		}
	})

	it('gives each asset the headers the browser job serves it with (design §10.11)', () => {
		const headersOf = (path: string) =>
			Object.fromEntries(
				headerLinesOf(path).map((line) => {
					const at = line.indexOf(':')
					return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]
				})
			)
		expect(headersOf(STYLESHEET)).toEqual(FINGERPRINTED_HEADERS)
		expect(headersOf(L1_SCRIPT)).toEqual(FINGERPRINTED_HEADERS)
		for (const path of ['/assets/embed-status.js', '/assets/avatar.png']) {
			expect(headersOf(path), path).toEqual(ASSET_HEADERS)
		}
	})
})
