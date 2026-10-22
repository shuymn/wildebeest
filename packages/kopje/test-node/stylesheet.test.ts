import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { drift } from '../scripts/build-assets.mjs'

// The web stylesheet (design §6, §10.7, §14.10) and its publication (amendment A1). The Workers suites call app.fetch
// directly and never reach Static Assets, so the asset rules are checked here, on the files.

const PACKAGE = new URL('../', import.meta.url)
const CSS = readFileSync(new URL('src/web/kopje.css', PACKAGE), 'utf8')
const VERSIONS = readFileSync(new URL('src/web/asset-versions.ts', PACKAGE), 'utf8')
const HEADERS = readFileSync(new URL('public/_headers', PACKAGE), 'utf8')
const ASSET_NAMES = readdirSync(new URL('public/assets/', PACKAGE))

const constant = (name: string) => new RegExp(`^export const ${name} = '([^']*)'$`, 'm').exec(VERSIONS)?.[1]

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

describe('the stylesheet', () => {
	const TOKENS = tokens(CSS)
	const pair = (name: string) => {
		const token = TOKENS.get(name)
		expect(token, name).toBeDefined()
		return token!
	}

	it('declares both colour schemes and every token for each', () => {
		expect(CSS).toMatch(/:root\s*\{\s*color-scheme: light dark;/)
		for (const name of ['ground', 'surface', 'raised', 'ink', 'muted', 'line', 'accent', 'on-accent', 'soft']) {
			pair(name)
		}
		for (const name of ['control-line', 'danger', 'ok']) {
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
		text.push(['on-accent', 'accent'], ['danger', 'ground'], ['danger', 'surface'])
		const controls: [string, string][] = []
		for (const fg of ['control-line', 'accent']) {
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
		expect(CSS).toMatch(/:focus-visible\s*\{\s*outline: 2px solid var\(--accent\);/)
		expect(CSS).not.toMatch(/outline:\s*(none|0)\b/)
	})

	it('keeps hidden things hidden and closed dialogs unrendered (§6.7)', () => {
		expect(CSS).toMatch(/\[hidden\]\s*\{\s*display: none !important;\s*\}/)
		// Every selector naming a dialog names an open one, so no rule gives a closed dialog a display.
		for (const [selector] of CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/[^{};]*\bdialog\b[^{};]*(?=\{)/g)) {
			expect(selector, selector).toContain('[open]')
		}
	})

	it('has the reduced-motion block (§14.9)', () => {
		expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
	})

	it('stays within 16 KiB raw and 5 KiB gzip (§13)', () => {
		const bytes = Buffer.from(CSS)
		expect(bytes.byteLength).toBeLessThanOrEqual(16 * 1024)
		expect(gzipSync(bytes).byteLength).toBeLessThanOrEqual(5 * 1024)
	})
})

describe('the stylesheet’s publication (amendment A1)', () => {
	it('names the file holding the stylesheet’s bytes by their hash', () => {
		const hash = createHash('sha256').update(CSS).digest('hex').slice(0, 10)
		expect(constant('STYLESHEET')).toBe(`/assets/kopje.${hash}.css`)
		expect(readFileSync(new URL(`public/assets/kopje.${hash}.css`, PACKAGE), 'utf8')).toBe(CSS)
	})

	it('keeps the previous release’s stylesheet and no older one', () => {
		const previous = constant('PREVIOUS_STYLESHEET')
		const kept = ASSET_NAMES.filter((name) => /^kopje(\.[0-9a-f]{10})?\.css$/.test(name)).sort()
		const expected = [constant('STYLESHEET'), previous].map((path) => path?.slice('/assets/'.length))
		expect(kept).toEqual([...new Set(expected)].sort())
	})

	it('is what scripts/build-assets.mjs writes', () => {
		expect(drift()).toEqual([])
	})

	it('serves the fingerprinted assets as immutable, and nothing else', () => {
		const rules = headerRules(HEADERS)
		const headersOf = (path: string) =>
			rules.filter((rule) => matches(rule.pattern, path)).flatMap((rule) => rule.headers)
		for (const name of ASSET_NAMES) {
			const headers = headersOf(`/assets/${name}`)
			expect(headers, name).toContain('X-Content-Type-Options: nosniff')
			const fingerprinted = /^kopje\.[0-9a-f]{10}\.(css|js)$/.test(name)
			expect(headers.includes(IMMUTABLE), name).toBe(fingerprinted)
		}
		for (const path of ['/assets/kopje.0123456789.css', '/assets/kopje.0123456789.js']) {
			expect(headersOf(path), path).toContain(IMMUTABLE)
		}
		for (const path of ['/assets/kopje.css', '/assets/embed.js', '/assets/embed-status.js', '/assets/avatar.png']) {
			expect(headersOf(path), path).not.toContain(IMMUTABLE)
		}
	})
})
