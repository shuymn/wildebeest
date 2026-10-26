import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

import { ASSET_HEADERS, ASSET_TYPES, EMBED_PAGE_HEADERS, PUBLIC_PAGE_HEADERS, STYLESHEET_HEADERS } from './headers'
import { type FixturePage, ORIGIN, pageNamed, type PageName, PAGES } from './pages'
import { PAGES_DIR } from './render'
import { STYLESHEET } from '../src/web/asset-versions'

// The browser job (design §10.11, amendment A1): every fixture page in Chromium, served with the published stylesheet
// and the headers production sends, so the CSP is enforced as on a real instance. A new component's rendered check is
// one more case here, and a new page type one more fixture.

const PUBLIC = new URL('../public/', import.meta.url)
const CSS = readFileSync(new URL(`.${STYLESHEET}`, PUBLIC), 'utf8')

// The light and dark value of a token of the published stylesheet, as getComputedStyle writes a colour.
function token(name: string): { light: string; dark: string } {
	const match = new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`).exec(CSS)
	if (match === null) {
		throw new Error(`the stylesheet has no --${name} pair`)
	}
	const rgb = (hex: string) => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`
	return { light: rgb(match[1]!), dark: rgb(match[2]!) }
}

// Serves the instance origin from the rendered fixtures and public/: nothing reaches the network.
async function serve(page: Page): Promise<void> {
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url())
		if (url.origin !== ORIGIN) {
			return route.abort('blockedbyclient')
		}
		const fixture = PAGES.find((p) => p.path === url.pathname)
		if (fixture !== undefined) {
			return route.fulfill({
				status: fixture.status,
				headers: { ...(fixture.kind === 'embed' ? EMBED_PAGE_HEADERS : PUBLIC_PAGE_HEADERS) },
				body: readFileSync(new URL(`${fixture.name}.html`, PAGES_DIR)),
			})
		}
		const asset = /^\/assets\/([a-z0-9.-]+)\.(css|js|png)$/.exec(url.pathname)
		if (asset !== null) {
			const extension = asset[2]!
			return route.fulfill({
				status: 200,
				headers: {
					...(url.pathname === STYLESHEET ? STYLESHEET_HEADERS : ASSET_HEADERS),
					'content-type': ASSET_TYPES[extension]!,
				},
				body: readFileSync(new URL(`.${url.pathname}`, PUBLIC)),
			})
		}
		return route.fulfill({ status: 404, headers: { ...ASSET_HEADERS }, body: '' })
	})
}

// Opens a fixture and collects every CSP violation the page reports, as an event or on the console.
async function open(page: Page, fixture: FixturePage): Promise<() => Promise<string[]>> {
	const logged: string[] = []
	page.on('console', (message) => {
		if (message.text().includes('Content Security Policy')) {
			logged.push(message.text())
		}
	})
	await page.addInitScript(() => {
		const seen: string[] = []
		Object.defineProperty(window, '__cspViolations', { value: seen })
		document.addEventListener('securitypolicyviolation', (event) => {
			seen.push(`${event.effectiveDirective} blocked ${event.blockedURI}`)
		})
	})
	await serve(page)
	const response = await page.goto(`${ORIGIN}${fixture.path}`, { waitUntil: 'load' })
	expect(response?.status()).toBe(fixture.status)
	return async () => [
		...(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)),
		...logged,
	]
}

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} scheme`, () => {
		test.use({ colorScheme })

		for (const fixture of PAGES) {
			test(`${fixture.name}: axe finds nothing, no CSP violation, and the ${colorScheme} tokens apply`, async ({
				page,
			}) => {
				const violations = await open(page, fixture)
				// Standards mode: a page without its doctype lays out in quirks mode.
				expect(await page.evaluate(() => document.compatMode)).toBe('CSS1Compat')
				const axe = new AxeBuilder({ page })
				// The embed is shown inside the host page's landmarks, with no landmarks or h1 of its own (design §14.1):
				// these best-practice rules ask a whole page for them.
				if (fixture.kind === 'embed') {
					axe.disableRules(['landmark-one-main', 'page-has-heading-one', 'region'])
				}
				const results = await axe.analyze()
				expect(results.passes.length).toBeGreaterThan(0)
				expect(
					results.violations.map((v) => ({ rule: v.id, targets: v.nodes.map((node) => node.target.join(' ')) }))
				).toEqual([])

				// The scheme the browser reports is the one rendered: the body's colours are that scheme's tokens. The
				// embed's ground is transparent, so the frame shows the embedding page's.
				const body = await page.evaluate(() => {
					const style = getComputedStyle(document.body)
					return { color: style.color, background: style.backgroundColor }
				})
				expect(body.color).toBe(token('ink')[colorScheme])
				expect(body.background).toBe(fixture.kind === 'embed' ? 'rgba(0, 0, 0, 0)' : token('ground')[colorScheme])

				expect(await violations()).toEqual([])
			})
		}
	})
}

for (const fixture of PAGES.filter((p) => p.kind !== 'embed')) {
	test(`${fixture.name}: the skip link is the first stop, shows on focus and moves focus to main`, async ({ page }) => {
		await open(page, fixture)
		const skip = page.locator('a.skip')
		await page.keyboard.press('Tab')
		await expect(skip).toBeFocused()
		await expect(skip).toBeInViewport({ ratio: 1 })
		await page.keyboard.press('Enter')
		await expect(page.locator('main#content')).toBeFocused()
	})
}

for (const fixture of PAGES) {
	test(`${fixture.name}: each disclosure shows only its own state's cue and hides its body until opened`, async ({
		page,
	}) => {
		await open(page, fixture)
		const disclosures = page.locator('details')
		for (let i = 0; i < (await disclosures.count()); i++) {
			const details = disclosures.nth(i)
			const summary = details.locator('> summary')
			const show = summary.locator('.show')
			const hide = summary.locator('.hide')
			const content = details.locator('> :not(summary)')
			await expect(content.first()).toBeAttached()

			await expect(show).toBeVisible()
			await expect(hide).toBeHidden()
			for (const part of await content.all()) {
				await expect(part).toBeHidden()
			}
			await expect(summary).toHaveAccessibleName(/\bShow$/)
			await expect(summary).not.toHaveAccessibleName(/Hide/)

			await summary.click()
			await expect(details).toHaveJSProperty('open', true)
			await expect(show).toBeHidden()
			await expect(hide).toBeVisible()
			for (const part of await content.all()) {
				await expect(part).toBeVisible()
			}
			await expect(summary).toHaveAccessibleName(/\bHide$/)
			await expect(summary).not.toHaveAccessibleName(/Show/)
		}
	})
}

// What each fixture must hold for the checks above to be about something.
const HOLDS: [page: PageName, selector: string, count: number][] = [
	// The pager's not-offered button, whose contrast axe checks.
	['profile', '.pager .btn.off', 1],
	// A content warning and sensitive media; a content warning on the embed.
	['profile', 'details.cw', 1],
	['profile', 'details.sensitive', 1],
	['embed', 'details.cw', 1],
	['status', '.reply-to', 1],
	['document', '.body.document > a', 1],
]
for (const fixture of PAGES.filter((p) => HOLDS.some(([name]) => name === p.name))) {
	test(`${fixture.name}: the fixture holds what the checks are about`, async ({ page }) => {
		await open(page, fixture)
		for (const [, selector, count] of HOLDS.filter(([name]) => name === fixture.name)) {
			await expect(page.locator(selector), selector).toHaveCount(count)
		}
	})
}

test('document: inline content in a rich body stays on one line box', async ({ page }) => {
	await open(page, pageNamed('document'))
	// The body's first three children are text, a link and text: their boxes share a line.
	const boxes = await page.locator('.body.document').evaluate((body: Element) => {
		const nodes = [...body.childNodes].slice(0, 3)
		return nodes.map((node) => {
			const range = document.createRange()
			range.selectNodeContents(node)
			const rects = [...range.getClientRects()]
			const first = rects[0]
			return {
				kind: node.nodeName,
				lines: new Set(rects.map((rect) => Math.round(rect.bottom))).size,
				left: first?.left ?? NaN,
				right: first?.right ?? NaN,
				bottom: first?.bottom ?? NaN,
			}
		})
	})
	expect(boxes.map((box) => box.kind)).toEqual(['#text', 'A', '#text'])
	for (const box of boxes) {
		expect(box.lines, box.kind).toBe(1)
		expect(Math.abs(box.bottom - boxes[0]!.bottom), box.kind).toBeLessThan(1)
	}
	expect(boxes[1]!.left).toBeGreaterThanOrEqual(boxes[0]!.right - 1)
	expect(boxes[2]!.left).toBeGreaterThanOrEqual(boxes[1]!.right - 1)
})

test('the CSP watch reports a blocked inline style', async ({ page }) => {
	const violations = await open(page, pageNamed('not-found'))
	await page.evaluate(() => document.body.setAttribute('style', 'color: red'))
	await expect.poll(violations).toContainEqual(expect.stringMatching(/^style-src-attr blocked inline$/))
})
