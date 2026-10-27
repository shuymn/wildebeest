import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import type { Node } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

import { contrast as contrastOf } from './contrast.js'
import { parse, type Source, sources, walk } from './source-scan.js'
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

// A hex colour's channels (#rgb or #rrggbb), for the contrast ratio (contrast.ts).
function channels(hex: string): number[] {
	const digits =
		hex.length === 4 ? [...hex.slice(1)].map((d) => d + d) : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)]
	return digits.map((d) => parseInt(d, 16))
}

function contrast(a: string, b: string): number {
	return contrastOf(channels(a), channels(b))
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
		text.push(
			['on-accent', 'accent'],
			['on-primary', 'primary'],
			['danger', 'ground'],
			['danger', 'surface'],
			['warn', 'surface']
		)
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

	it('animates nothing outside prefers-reduced-motion: no-preference, and has no global override', () => {
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

	it('stays within 16 KiB raw and 5 KiB gzip as served', () => {
		expect(SERVED.byteLength).toBeLessThanOrEqual(16 * 1024)
		expect(gzipSync(SERVED).byteLength).toBeLessThanOrEqual(5 * 1024)
	})
})

// A stylesheet's declarations in source order, each with the selectors it is nested in (`rule` the innermost) and
// whether a comment sits directly above it (after the previous declaration or brace). Custom properties are left out.
type Declaration = { selector: string; rule: string; property: string; value: string; commented: boolean }

// `custom`: the custom-property definitions (`--name: value`) instead of the other declarations.
function declarations(css: string, custom = false): Declaration[] {
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
			if (declaration !== '' && declaration.startsWith('--') === custom) {
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

// `text` split at each character `delimiter` matches outside parentheses, parenthesized runs kept whole, empty pieces
// left out.
function splitOutside(text: string, delimiter: RegExp): string[] {
	const out: string[] = []
	let depth = 0
	let part = ''
	for (const c of text) {
		depth += c === '(' ? 1 : c === ')' ? -1 : 0
		if (depth === 0 && delimiter.test(c)) {
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

// A value's space-separated parts, keeping parenthesized ones whole.
function parts(value: string): string[] {
	return splitOutside(value, /\s/)
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

// The token definitions off their scales (docs/web-pages.md, "UI rules"): a token is defined exactly once, in the
// top-level :root, the scale tokens at their canonical values (the spacing, type and radius scales and --pad as
// docs/web-pages.md gives them), a scheme colour as light-dark() of two hex colours, the font stacks as written; the
// only other definitions are the documented exceptions, --pad as a step in a media query's :root (narrow screens) and
// --tone as a colour token in a status's rule (alerts and chips). No custom property is registered (@property, which
// could give one an initial value of its own). So a component cannot redefine a token (`.who { --s3: 13px }`, a second
// :root) to pass the declaration guards with var(--s3).
const CANONICAL: Record<string, string> = {
	'--s1': '0.25rem',
	'--s2': '0.5rem',
	'--s3': '0.75rem',
	'--s4': '1rem',
	'--s5': '1.5rem',
	'--s6': '2.5rem',
	'--pad': 'var(--s5)',
	'--t1': '0.875rem',
	'--t2': '1rem',
	'--t3': '1.125rem',
	'--t4': '1.5rem',
	'--t5': '2rem',
	'--r-control': '10px',
	'--r-inset': '12px',
	'--r-card': '16px',
	'--r-pill': '999px',
}
const FONT_STACKS = new Set(['--sans', '--mono'])
const SCHEME_COLOUR = /^light-dark\(#[0-9a-f]{3,8},\s*#[0-9a-f]{3,8}\)$/

function offScaleTokens(css: string): string[] {
	const registered = /@property\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')) ? ['@property'] : []
	const defined = declarations(css, true)
	const colours = new Set(
		defined.filter((d) => d.selector === ':root' && SCHEME_COLOUR.test(d.value)).map((d) => d.property)
	)
	const seen = new Set<string>()
	const off = defined
		.filter(({ selector, property, value }) => {
			if (selector === ':root') {
				// A second definition is off whatever its value: the top-level :root defines each token once.
				const again = seen.has(property)
				seen.add(property)
				const canonical = CANONICAL[property]
				const valid =
					canonical !== undefined ? value === canonical : FONT_STACKS.has(property) || SCHEME_COLOUR.test(value)
				return again || !valid
			}
			if (/^@media\b[^{]*:root$/.test(selector)) {
				return !(property === '--pad' && /^var\(--s[1-6]\)$/.test(value))
			}
			const token = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1]
			return !(property === '--tone' && token !== undefined && colours.has(token))
		})
		.map(({ selector, property, value }) => `${selector} { ${property}: ${value} }`)
	return [...registered, ...off]
}

describe('the stylesheet’s tokens (docs/web-pages.md, "UI rules")', () => {
	const SOURCE = readFileSync(new URL('src/web/kopje.css', PACKAGE), 'utf8')

	it('defines each token once at its scale, and redefines only --pad and --tone where documented', () => {
		expect(declarations(SOURCE, true).length).toBeGreaterThan(40)
		expect(offScaleTokens(SOURCE)).toEqual([])
	})

	it('flags a token redefined off its scale or outside the documented exceptions', () => {
		const root = ':root { --ink: light-dark(#000, #fff); --s3: 0.75rem; } '
		const flagged = [
			'.who { --s3: 13px; gap: var(--s3); }',
			'.who { --s3: 0.75rem; }',
			'.x { --t2: 1rem; }',
			'.x { --r-card: 16px; }',
			'.x { --ink: #000; }',
			'.x { --pad: var(--s4); }',
			'.x { & .y { --s1: 1px; } }',
			':root { --s3: 13px; }',
			':root { --t1: 14px; }',
			':root { --r-card: 1rem; }',
			':root { --pad: 1rem; }',
			':root { --accent: #8a5a00; }',
			':root { --accent: light-dark(red, blue); }',
			'@media (width < 44rem) { :root { --pad: 12px; } }',
			'@media (width < 44rem) { :root { --s4: 1rem; } }',
			'.alert { --tone: #f00; }',
			'.alert { --tone: var(--s1); }',
			'.alert { --other: var(--ink); }',
			// A second top-level :root, at the scale or off it, and a value that is a step but not the canonical one.
			':root { --s3: 13rem; }',
			':root { --s3: 0.75rem; }',
			':root { --s2: 0.6rem; }',
			':root { --pad: var(--s4); }',
			// A registered custom property, at any depth.
			'@property --s3 { syntax: "<length>"; inherits: true; initial-value: 13px; }',
			'@media (width < 44rem) { @property --x { syntax: "*"; inherits: false; } }',
			'.x { @supports (display: grid) { @property --y { syntax: "*"; inherits: false; } } }',
		]
		for (const css of flagged) {
			expect(offScaleTokens(root + css), css).toHaveLength(1)
		}
		const passed = [
			':root { --s1: 0.25rem; --t5: 2rem; --r-pill: 999px; --pad: var(--s5); --sans: system-ui, sans-serif; }',
			':root { --ink: light-dark(#22201b, #ece6d8); --scrim: light-dark(#2228, #0009); }',
			'@media (width < 44rem) { :root { --pad: var(--s4); } }',
			':root { --ok: light-dark(#000, #fff); } :where(.alert) { &.ok { --tone: var(--ok); } }',
		]
		for (const css of passed) {
			expect(offScaleTokens(css), css).toEqual([])
		}
	})
})

// Whether a selector is a list (a comma outside any parentheses).
function listed(selector: string): boolean {
	let depth = 0
	for (const c of selector) {
		depth += c === '(' ? 1 : c === ')' ? -1 : 0
		if (c === ',' && depth === 0) {
			return true
		}
	}
	return false
}

// Every rule's full selector, nesting resolved (`&` is its parent, a list of several as :is()), comments left out.
function fullSelectors(css: string): string[] {
	const found: string[] = []
	const stack: string[] = []
	let text = ''
	const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
	for (const c of plain) {
		if (c === '{') {
			const own = text.trim().replace(/\s+/g, ' ')
			const parent = stack.at(-1)
			const full =
				parent === undefined || parent.startsWith('@')
					? own
					: own.includes('&')
						? own.replaceAll('&', listed(parent) ? `:is(${parent})` : parent)
						: `${parent} ${own}`
			stack.push(own.startsWith('@') ? (parent ?? own) : full)
			if (!own.startsWith('@')) {
				found.push(full)
			}
			text = ''
		} else if (c === '}') {
			stack.pop()
			text = ''
		} else if (c === ';') {
			text = ''
		} else {
			text += c
		}
	}
	return found
}

// The classes a stylesheet's selectors name.
function selectorClasses(css: string): string[] {
	return [
		...new Set(
			fullSelectors(css).flatMap((selector) => [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!))
		),
	].sort()
}

// What names a class: a JSX `class` or `className` attribute, a `class:` or `className:` property (a component's
// props), or an explicit class map, a constant a class expression reads (AVATAR_CLASS, ALERT_STATUS).
const CLASS_NAMES = new Set(['class', 'className'])

function classValue(node: Node): Node | null {
	if (node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier' && CLASS_NAMES.has(node.name.name)) {
		return node.value
	}
	if (node.type === 'Property' && !node.computed) {
		const key = node.key.type === 'Identifier' ? node.key.name : node.key.type === 'Literal' ? node.key.value : null
		return typeof key === 'string' && CLASS_NAMES.has(key) ? node.value : null
	}
	return null
}

// The const a node initializes, or is a part of the initializer of (a record's value), or null.
function initializedConstant(parents: readonly Node[]): string | null {
	for (const [i, parent] of parents.entries()) {
		if (parent.type === 'VariableDeclarator') {
			const declaration = parents[i + 1]
			return parent.id.type === 'Identifier' &&
				declaration?.type === 'VariableDeclaration' &&
				declaration.kind === 'const'
				? parent.id.name
				: null
		}
		if (/Function|Class|Program/.test(parent.type)) {
			return null
		}
	}
	return null
}

// The whole tokens of the class-bearing string and template literals of the sources: inside a class expression, or a
// value of a class map. A literal elsewhere (a stray 'ghost') keeps no class alive.
function classTokens(files: readonly Source[]): Set<string> {
	const tokens = new Set<string>()
	for (const source of files) {
		const { program, literals } = parse(source)
		const maps = new Set<string>()
		walk(program, (node) => {
			const value = classValue(node)
			if (value !== null) {
				walk(value, (inner) => {
					if (inner.type === 'Identifier') {
						maps.add(inner.name)
					}
				})
			}
		})
		for (const literal of literals) {
			const constant = initializedConstant(literal.parents)
			if (
				!literal.parents.some((parent) => classValue(parent) !== null) &&
				(constant === null || !maps.has(constant))
			) {
				continue
			}
			// A string joined to another value ('ghost' + '-row') is a fragment, no class.
			if (literal.parents[0]?.type === 'BinaryExpression' && literal.parents[0].operator === '+') {
				continue
			}
			for (const token of wholeTokens(literal.parts)) {
				tokens.add(token)
			}
		}
	}
	return tokens
}

// The whitespace-separated tokens of a literal's text, whole: a token that touches an interpolation (`av${n}`,
// `${a}-row`) is part of a class built from a value, so it is none.
function wholeTokens(parts: readonly ({ text: string } | object)[]): string[] {
	const found: string[] = []
	parts.forEach((part, i) => {
		if (!('text' in part)) {
			return
		}
		const words = part.text.split(/\s+/)
		const from = i > 0 && !/^\s/.test(part.text) ? 1 : 0
		const to = i < parts.length - 1 && !/\s$/.test(part.text) ? words.length - 1 : words.length
		found.push(...words.slice(from, to).filter((word) => word !== ''))
	})
	return found
}

// Sanitized content's own classes, which stored HTML carries and no source writes (src/security/html.ts,
// ALLOWED_CLASS, Mastodon's): the stylesheet hides or marks them.
const CONTENT_CLASSES = new Set(['invisible', 'ellipsis', 'quote-inline'])

// The classes the stylesheet styles that no class-bearing literal of the sources names: rules nothing renders.
function unusedClasses(css: string, files: readonly Source[]): string[] {
	const tokens = classTokens(files)
	return selectorClasses(css).filter((name) => !tokens.has(name) && !CONTENT_CLASSES.has(name))
}

// A button's kinds (docs/web-pages.md, "UI rules"): the modifiers a selector puts on a button or .btn, and the one
// component a button styles of its own (the ALT badge).
const BUTTON_KINDS = new Set(['primary', 'quiet', 'danger', 'icon', 'alt'])

// A selector's compounds: split at its top-level commas and combinators (whitespace, >, +, ~), parentheses kept whole.
function compounds(selector: string): string[] {
	return splitOutside(selector, /[\s,>+~]/)
}

// Every class a compound that is a button puts on it, wherever in the compound it is written (before or after the
// type, after a pseudo-class, inside :is() or :where()): a compound is a button by its type, by .btn, or by an :is()
// or :where() offering either.
function buttonModifiers(css: string): string[] {
	return fullSelectors(css).flatMap((selector) =>
		compounds(selector).flatMap((compound) => {
			const button =
				/^button(?![\w-])/.test(compound) ||
				/\.btn(?![\w-])/.test(compound) ||
				/:(is|where)\((?:[^()]*[\s,])?(button|\.btn)(?![\w-])/.test(compound)
			return button ? [...compound.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!).filter((name) => name !== 'btn') : []
		})
	)
}

describe('the stylesheet’s classes', () => {
	const SOURCE = readFileSync(new URL('src/web/kopje.css', PACKAGE), 'utf8')
	const SRC = sources('src')

	it('styles only classes the source names, each as a literal', () => {
		expect(selectorClasses(SOURCE).length).toBeGreaterThan(80)
		expect(unusedClasses(SOURCE, SRC)).toEqual([])
		// Each content class is one the sanitizer keeps.
		const sanitizer = readFileSync(new URL('src/security/html.ts', PACKAGE), 'utf8')
		for (const name of CONTENT_CLASSES) {
			expect(sanitizer, name).toMatch(new RegExp(`ALLOWED_CLASS = .*\\b${name}\\b`))
		}
	})

	it('flags a rule nothing renders, and a class whose literal is gone', () => {
		expect(unusedClasses('.who { gap: 0; } .unused-x {} .who .id:hover {}', SRC)).toEqual(['unused-x'])
		const without: Source[] = [{ path: 'src/x.tsx', text: 'export const a = <p class="other">{`id ${\'x\'}`}</p>' }]
		expect(unusedClasses('.who {} .other {} .id {}', without)).toEqual(['id', 'who'])
		// A stray string is no class: only a class attribute or property, or a map a class expression reads, names one.
		const stray: Source[] = [
			{
				path: 'src/z.tsx',
				text: [
					"const label = 'ghost'",
					"const MAP = { a: 'mapped' }",
					"const OTHER = { a: 'loose' }",
					'export const z = <p class={MAP.a} title={label} />',
					"export const props = { class: 'prop', title: 'titled' }",
					"export const joined = <p class={'ghost' + '-row'} />",
					'export const built = (n: string) => <p class={`row ${n}-x half${n}`} />',
				].join('\n'),
			},
		]
		expect(
			unusedClasses('.ghost {} .mapped {} .loose {} .prop {} .titled {} .ghost-row {} .row {} .half {}', stray)
		).toEqual(['ghost', 'ghost-row', 'half', 'loose', 'titled'])
		// Not a literal: a class built from a value, or named in a comment.
		const built: Source[] = [{ path: 'src/y.ts', text: '// av40\nexport const c = (n: number) => `av${n}`' }]
		expect(unusedClasses('.av40 {}', built)).toEqual(['av40'])
	})

	it('gives buttons only their kinds: primary, quiet, danger and icon, and the ALT badge', () => {
		const modifiers = buttonModifiers(SOURCE)
		expect(modifiers.length).toBeGreaterThan(3)
		expect(modifiers.filter((name) => !BUTTON_KINDS.has(name))).toEqual([])
		expect(buttonModifiers('.btn.off {}')).toEqual(['off'])
		expect(buttonModifiers(':is(button, .btn) { &.ghost {} } .meta .btn.quiet {} button.x {}')).toEqual([
			'ghost',
			'quiet',
			'x',
		])
		expect(buttonModifiers('.btnish.x {} .button.y {} .card.pad {}')).toEqual([])
		// Wherever the compound writes it: before the button, after a pseudo-class, inside :is().
		for (const css of ['.ghost.btn {}', 'button:hover.ghost {}', '.btn:is(.ghost) {}', ':where(button).ghost {}']) {
			expect(buttonModifiers(css), css).toEqual(['ghost'])
		}
	})
})

describe('the stylesheet’s publication', () => {
	it('names the file holding the stylesheet’s bytes by their hash, and serves the source minified', () => {
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
