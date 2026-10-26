import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

import {
	ASSET_HEADERS,
	ASSET_TYPES,
	EMBED_PAGE_HEADERS,
	FINGERPRINTED_HEADERS,
	L1_PAGE_HEADERS,
	PRIVATE_PAGE_HEADERS,
	PUBLIC_PAGE_HEADERS,
} from './headers'
import { type FixturePage, ORIGIN, pageNamed, type PageName, PAGES } from './pages'
import { PAGES_DIR } from './render'
import { LOCAL_TIME } from '../src/client/local-time'
import { L1_SCRIPT, STYLESHEET } from '../src/web/asset-versions'

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

const PAGE_HEADERS = {
	public: PUBLIC_PAGE_HEADERS,
	l1: L1_PAGE_HEADERS,
	private: PRIVATE_PAGE_HEADERS,
	embed: EMBED_PAGE_HEADERS,
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
				headers: { ...PAGE_HEADERS[fixture.kind] },
				body: readFileSync(new URL(`${fixture.name}.html`, PAGES_DIR)),
			})
		}
		const asset = /^\/assets\/([a-z0-9.-]+)\.(css|js|png)$/.exec(url.pathname)
		if (asset !== null) {
			const extension = asset[2]!
			return route.fulfill({
				status: 200,
				headers: {
					...(url.pathname === STYLESHEET || url.pathname === L1_SCRIPT ? FINGERPRINTED_HEADERS : ASSET_HEADERS),
					'content-type': ASSET_TYPES[extension]!,
				},
				body: readFileSync(new URL(`.${url.pathname}`, PUBLIC)),
			})
		}
		return route.fulfill({ status: 404, headers: { ...ASSET_HEADERS }, body: '' })
	})
}

// The CSP violations each open page has reported; every test ends with none (afterEach), so a check that interacts
// with a page also shows that the interaction stays within the policy. A test that opens no page through open(), and
// so has no watch, fails unless it opts out (cspOptOut).
const cspWatches = new WeakMap<Page, () => Promise<string[]>>()
const cspOptOut = new WeakSet<Page>()

test.afterEach(async ({ page }) => {
	if (cspOptOut.has(page)) {
		return
	}
	const violations = cspWatches.get(page)
	expect(violations, 'a CSP watch (open the page with open())').toBeDefined()
	expect(await violations!(), 'CSP violations').toEqual([])
})

// Opens a fixture and collects every CSP violation the page reports, as an event or on the console. `extra` adds
// routes over the fixtures' (the later route wins).
async function open(
	page: Page,
	fixture: FixturePage,
	extra?: (page: Page) => Promise<unknown>
): Promise<() => Promise<string[]>> {
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
	await extra?.(page)
	const response = await page.goto(`${ORIGIN}${fixture.path}`, { waitUntil: 'load' })
	expect(response?.status()).toBe(fixture.status)
	const violations = async () => [
		...(await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)),
		...logged,
	]
	cspWatches.set(page, violations)
	return violations
}

// Why an element would not be seen where it is: its opacity with its ancestors', its visibility, a clip, a box outside
// the viewport, another element over its centre, or text below 4.5:1 against its own opaque background.
function unseen(element: Element): string[] {
	const problems: string[] = []
	let opacity = 1
	for (let e: Element | null = element; e !== null; e = e.parentElement) {
		const style = getComputedStyle(e)
		opacity *= Number(style.opacity)
		if (style.clipPath !== 'none' || (style.clip !== 'auto' && style.clip !== '')) {
			problems.push(`<${e.tagName.toLowerCase()}> is clipped`)
		}
	}
	if (opacity < 1) {
		problems.push(`opacity ${opacity}`)
	}
	const style = getComputedStyle(element)
	if (style.visibility !== 'visible') {
		problems.push(`visibility ${style.visibility}`)
	}
	const box = element.getBoundingClientRect()
	if (
		box.width < 1 ||
		box.height < 1 ||
		box.top < 0 ||
		box.left < 0 ||
		box.bottom > innerHeight ||
		box.right > innerWidth
	) {
		problems.push('not wholly in the viewport')
	}
	const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
	if (hit === null || !element.contains(hit)) {
		problems.push('covered at its centre')
	}
	// Only the sRGB rgb()/rgba() serializations, with 0-255 channels, are read; any other form (color(srgb …), lab(), …)
	// is reported rather than converted.
	const rgba = (colour: string): number[] | null => {
		const match = /^rgba?\(([^)]*)\)$/.exec(colour)
		const parts =
			match?.[1]
				?.split(/[\s,/]+/)
				.filter((part) => part !== '')
				.map(Number) ?? []
		return match !== null && (parts.length === 3 || parts.length === 4) && parts.every(Number.isFinite) ? parts : null
	}
	const luminance = ([r = 0, g = 0, b = 0]: number[]) => {
		const [lr, lg, lb] = [r, g, b].map((c) =>
			c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4
		)
		return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!
	}
	const [fg, bg] = [rgba(style.color), rgba(style.backgroundColor)]
	if (fg === null || bg === null) {
		problems.push(`unsupported colour: ${style.color} on ${style.backgroundColor}`)
	} else if (bg.length === 4 && bg[3]! < 1) {
		problems.push('no opaque background of its own')
	} else {
		const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
		const ratio = (hi! + 0.05) / (lo! + 0.05)
		if (ratio < 4.5 || (fg.length === 4 && fg[3]! < 1)) {
			problems.push(`text contrast ${ratio.toFixed(2)}`)
		}
	}
	return problems
}

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} scheme`, () => {
		test.use({ colorScheme })

		for (const fixture of PAGES) {
			test(`${fixture.name}: axe finds nothing, no CSP violation, and the ${colorScheme} tokens apply`, async ({
				page,
			}) => {
				await open(page, fixture)
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
		expect(await skip.evaluate(unseen)).toEqual([])
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
	// The stub's row (a post card without an author block) and the feed's reply-to line.
	['profile', 'article.post:not(:has(.who))', 1],
	['profile', '.reply-to', 1],
	// The tabs, the current one marked; the pinned post's and the boost's labels.
	['profile', 'nav.tabs > a', 3],
	['profile', 'nav.tabs > a[aria-current="page"]', 1],
	['profile', 'article.post > .label', 2],
	// The profile's following and followers counts, links to their lists.
	['profile', '.stats a', 2],
	// The follow lists' tabs, the rows of a list and its pager; none of them but the tabs when the network is hidden.
	['followers', 'nav.tabs > a[aria-current="page"]', 1],
	['followers', 'ul.accounts > li .who', 2],
	['followers', '.pager .btn.off', 1],
	['follows-hidden', 'nav.tabs > a', 2],
	['follows-hidden', 'ul.accounts, .pager, .empty', 0],
	// The hashtag page: its heading, a stub, the reply-to line and both pager links offered.
	['tag', 'main > h1', 1],
	['tag', 'main > h1 > svg.ic[aria-hidden="true"]', 1],
	['tag', 'article.post:not(:has(.who))', 1],
	['tag', '.reply-to', 1],
	['tag', '.pager a.btn', 2],
	['embed', 'details.cw', 1],
	// The embed's warning covers a poll whose counts are hidden (no bars) and a nested quote.
	['embed', 'details.cw .poll', 1],
	['embed', 'details.cw .poll svg.track', 0],
	['embed', 'details.cw .quote', 1],
	['status', '.reply-to', 1],
	// The status page's post: an emoji in its content, the author's in the name, the poll's choice; media of every
	// other type, the video's poster preloaded first; a poll with its bars; a nested quote.
	['status', 'article.focal > .body img.emoji', 1],
	['status', 'h1 img.emoji', 1],
	['status', '.poll img.emoji', 1],
	['status', 'video[preload="none"][controls]', 2],
	['status', 'video[poster]', 1],
	['status', 'video[muted][loop]', 1],
	['status', 'audio[preload="none"][controls]', 1],
	['status', 'a.media-file', 1],
	['status', 'link[rel="preload"][as="image"][fetchpriority="high"]', 1],
	['status', '.poll svg.track rect', 2],
	['status', '.quote .who', 1],
	// The profile's posts: the pinned one's quote awaiting approval, and three polls (ended, open, counts hidden).
	['profile', 'p.gone', 1],
	['profile', '.poll', 3],
	['document', '.body.document > a', 1],
	// The look-up field with its hint, and the follow form of what a look-up found.
	['interaction', 'input[name="uri"][aria-describedby]', 1],
	['interaction-result', 'form[action="/authorize_interaction/follow"] button', 1],
]
for (const fixture of PAGES.filter((p) => HOLDS.some(([name]) => name === p.name))) {
	test(`${fixture.name}: the fixture holds what the checks are about`, async ({ page }) => {
		await open(page, fixture)
		for (const [, selector, count] of HOLDS.filter(([name]) => name === fixture.name)) {
			await expect(page.locator(selector), selector).toHaveCount(count)
		}
	})
}

// Inline media (design §10.11, §13): video and audio ask for nothing before they are played, and a gifv shows its
// controls and does not play by itself. The watch sees a request once a player is let to load.
test('status: video and audio load nothing before play, and gifv shows controls without autoplay', async ({ page }) => {
	const media: string[] = []
	page.on('request', (request) => {
		if (new URL(request.url()).pathname.startsWith('/media/')) {
			media.push(request.url())
		}
	})
	await open(page, pageNamed('status'))
	await page.waitForLoadState('networkidle')
	expect(media).toEqual([])
	const players = await page.locator('video, audio').evaluateAll((elements: Element[]) =>
		(elements as HTMLMediaElement[]).map((player) => ({
			tag: player.tagName.toLowerCase(),
			paused: player.paused,
			autoplay: player.autoplay,
			controls: player.controls,
			preload: player.preload,
			loop: player.loop,
			muted: player.muted,
			poster: player instanceof HTMLVideoElement ? player.poster : null,
		}))
	)
	expect(players).toEqual([
		{
			tag: 'video',
			paused: true,
			autoplay: false,
			controls: true,
			preload: 'none',
			loop: false,
			muted: false,
			poster: `${ORIGIN}/assets/thumbnail.png`,
		},
		{
			tag: 'video',
			paused: true,
			autoplay: false,
			controls: true,
			preload: 'none',
			loop: true,
			muted: true,
			poster: '',
		},
		{
			tag: 'audio',
			paused: true,
			autoplay: false,
			controls: true,
			preload: 'none',
			loop: false,
			muted: false,
			poster: null,
		},
	])
	// The video's poster is an image request, which the preload makes first; the watch above counted no file.
	await page
		.locator('video')
		.first()
		.evaluate((video: HTMLVideoElement) => {
			video.preload = 'auto'
			video.load()
		})
	await expect.poll(() => media).toEqual([`${ORIGIN}/media/51/full.bin`])
})

// The local-time rewrite (design §7.6) by the real bundle under the production CSP, in two zones on either side of
// UTC: against the same page without script, only the text of instants marked data-local changes, to the viewer's
// zone; every datetime attribute and the rest of the document stay as served.
type Shown = { datetime: string | null; local: boolean; text: string }
const shownTimes = (page: Page) =>
	page.locator('time').evaluateAll((times: Element[]) =>
		times.map((time) => ({
			datetime: time.getAttribute('datetime'),
			local: time.hasAttribute('data-local'),
			text: time.textContent ?? '',
		}))
	)
// The document as rendered, with the text of each data-local instant left out: what the rewrite must leave alone.
const restOfPage = (page: Page) =>
	page.evaluate(() => {
		const copy = document.documentElement.cloneNode(true) as HTMLElement
		for (const time of copy.querySelectorAll('time[data-local]')) {
			time.textContent = ''
		}
		return copy.outerHTML
	})

for (const timezoneId of ['America/Los_Angeles', 'Asia/Tokyo'] as const) {
	test.describe(`in ${timezoneId}`, () => {
		test.use({ timezoneId })
		const format = new Intl.DateTimeFormat('en', { ...LOCAL_TIME, timeZone: timezoneId })

		for (const fixture of PAGES.filter((p) => p.kind === 'l1')) {
			test(`${fixture.name}: the bundle shows each instant in the viewer's zone and changes nothing else`, async ({
				page,
				browser,
			}) => {
				const served = await browser.newContext({ javaScriptEnabled: false, timezoneId })
				const plain = await served.newPage()
				await serve(plain)
				await plain.goto(`${ORIGIN}${fixture.path}`)
				const before: Shown[] = await shownTimes(plain)
				const rest = await restOfPage(plain)
				await served.close()

				await open(page, fixture)
				const after: Shown[] = await shownTimes(page)
				expect(await restOfPage(page)).toBe(rest)
				expect(before.filter((time) => time.local).length).toBeGreaterThan(0)
				expect(after).toEqual(
					before.map((time) => ({
						...time,
						text: time.local ? format.format(Date.parse(time.datetime!)) : time.text,
					}))
				)
				expect(after.filter((time) => time.local).every((time) => !time.text.endsWith(' UTC'))).toBe(true)
			})
		}

		// The contract on hand-written markup: the zone boundary at 23:30 UTC, and every value that is not a full UTC
		// instant left alone. Served at a path of its own with the profile's headers.
		test('the bundle moves 23:30 UTC across the date line and leaves dates and other forms alone', async ({ page }) => {
			const times = [
				'<time datetime="2026-10-23T23:30:00.000Z" data-local>Oct 23, 2026, 23:30 UTC</time>',
				'<time datetime="2026-10-23T23:30Z" data-local>Oct 23, 2026, 23:30 UTC</time>',
				'<time datetime="2026-11-01">Nov 1, 2026</time>',
				'<time datetime="2026-11-01" data-local>Nov 1, 2026</time>',
				'<time datetime="2026-10-23T23:30:00+09:00" data-local>as served</time>',
				'<time datetime="2026-10-23T23:30:00.000Z">Oct 23, 2026, 23:30 UTC</time>',
			]
			const path = '/time-contract'
			await open(page, { name: 'time-contract', path, status: 200, kind: 'l1' }, (page) =>
				page.route(`${ORIGIN}${path}`, (route) =>
					route.fulfill({
						status: 200,
						headers: { ...L1_PAGE_HEADERS },
						body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><script defer src="${L1_SCRIPT}"></script></head><body><main>${times.join('')}</main></body></html>`,
					})
				)
			)
			const expected = {
				'America/Los_Angeles': 'Oct 23, 2026, 16:30 PDT',
				'Asia/Tokyo': 'Oct 24, 2026, 08:30 GMT+9',
			}[timezoneId]
			expect(await shownTimes(page)).toEqual([
				{ datetime: '2026-10-23T23:30:00.000Z', local: true, text: expected },
				{ datetime: '2026-10-23T23:30Z', local: true, text: expected },
				{ datetime: '2026-11-01', local: false, text: 'Nov 1, 2026' },
				{ datetime: '2026-11-01', local: true, text: 'Nov 1, 2026' },
				{ datetime: '2026-10-23T23:30:00+09:00', local: true, text: 'as served' },
				{ datetime: '2026-10-23T23:30:00.000Z', local: false, text: 'Oct 23, 2026, 23:30 UTC' },
			])
		})
	})
}

test('profile: each tab is a 44px target, and the current one is marked by weight and a bar, not colour alone', async ({
	page,
}) => {
	await open(page, pageNamed('profile'))
	const tabs = await page.locator('nav.tabs > a').evaluateAll((links: Element[]) =>
		links.map((link) => {
			const style = getComputedStyle(link)
			return {
				current: link.getAttribute('aria-current'),
				height: link.getBoundingClientRect().height,
				weight: Number(style.fontWeight),
				bar: style.borderBlockEndColor,
				underline: style.textDecorationLine,
			}
		})
	)
	expect(tabs.map((tab) => tab.current)).toEqual(['page', null, null])
	for (const tab of tabs) {
		expect(tab.height).toBeGreaterThanOrEqual(44)
		expect(tab.underline).toBe('none')
	}
	const [current, ...others] = tabs
	expect(current!.bar).not.toBe('rgba(0, 0, 0, 0)')
	for (const other of others) {
		expect(other.weight).toBeLessThan(current!.weight)
		expect(other.bar).toBe('rgba(0, 0, 0, 0)')
	}
})

test('profile and follow lists: the count links and the list tabs are 44px targets, not underlined', async ({
	page,
}) => {
	for (const [name, selector] of [
		['profile', '.stats a'],
		['followers', 'nav.tabs > a'],
	] as const) {
		await open(page, pageNamed(name))
		const links = await page.locator(selector).evaluateAll((elements: Element[]) =>
			elements.map((link) => ({
				height: link.getBoundingClientRect().height,
				underline: getComputedStyle(link).textDecorationLine,
			}))
		)
		expect(links.length, name).toBe(2)
		for (const link of links) {
			expect(link.height, name).toBeGreaterThanOrEqual(44)
			expect(link.underline, name).toBe('none')
		}
	}
})

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
	// The violation is this test's subject, not a failure.
	cspOptOut.add(page)
})

// The pages that load the bundle enforce Trusted Types with no policy allowed: a string written to an HTML sink is
// refused and reported, and no policy can be made to wrap one.
test('profile: an HTML sink refuses a string, and no Trusted Types policy can be made', async ({ page }) => {
	const violations = await open(page, pageNamed('profile'))
	const refused = await page.evaluate(() => {
		const outcomes: string[] = []
		try {
			document.body.insertAdjacentHTML('beforeend', '<b>x</b>')
			outcomes.push('html written')
		} catch (error) {
			outcomes.push((error as Error).name)
		}
		try {
			// Trusted Types is not in TypeScript's DOM library.
			const types = (window as unknown as { trustedTypes: { createPolicy: (name: string, rules: object) => unknown } })
				.trustedTypes
			types.createPolicy('p', { createHTML: (s: string) => s })
			outcomes.push('policy made')
		} catch (error) {
			outcomes.push((error as Error).name)
		}
		return outcomes
	})
	expect(refused).toEqual(['TypeError', 'TypeError'])
	await expect
		.poll(violations)
		.toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^require-trusted-types-for blocked trusted-types-sink$/),
				expect.stringMatching(/^trusted-types blocked trusted-types-policy$/),
			])
		)
	// The violations are this test's subject, not a failure.
	cspOptOut.add(page)
})

// The skip link's visibility check flags a focused link that cannot be seen. The changes go through the CSSOM, which
// the CSP does not restrict (it governs style attributes and elements, not element.style).
test('the visibility check flags a focused skip link that cannot be seen', async ({ page }) => {
	await open(page, pageNamed('not-found'))
	const skip = page.locator('a.skip')
	await page.keyboard.press('Tab')
	await expect(skip).toBeFocused()
	expect(await skip.evaluate(unseen)).toEqual([])
	// [element, property, value, problem, and a second declaration]; the value 'background' is the link's own
	// background colour.
	const cases: [on: 'link' | 'body', property: string, value: string, problem: RegExp, also?: [string, string]][] = [
		['link', 'opacity', '0', /^opacity 0$/],
		['body', 'opacity', '0.5', /^opacity 0.5$/],
		['link', 'visibility', 'hidden', /^visibility hidden$/],
		['link', 'clip-path', 'inset(50%)', /^<a> is clipped$/],
		['link', 'top', '-10rem', /^not wholly in the viewport$/],
		['link', 'color', 'background', /^text contrast 1.00$/],
		// White on white in a form the check does not read: reported, not converted and passed.
		[
			'link',
			'color',
			'color(srgb 1 1 1)',
			/^unsupported colour: color\(srgb 1 1 1\) on rgb\(255, 255, 255\)$/,
			['background', 'white'],
		],
		['link', 'background', 'transparent', /^no opaque background of its own$/],
	]
	for (const [on, property, value, problem, also] of cases) {
		const change = `${on} ${property}: ${value}`
		// A hidden link loses focus; each case starts from the focused, visible link.
		await skip.focus()
		expect(await skip.evaluate(unseen), change).toEqual([])
		await skip.evaluate(
			(link: HTMLElement, [on, property, value, also]) => {
				const target = on === 'body' ? document.body : link
				target.style.setProperty(property, value === 'background' ? getComputedStyle(link).backgroundColor : value)
				if (also !== null) {
					target.style.setProperty(also[0], also[1])
				}
			},
			[on, property, value, also ?? null] as const
		)
		expect(await skip.evaluate(unseen), change).toContainEqual(expect.stringMatching(problem))
		await skip.evaluate((link: HTMLElement) => {
			link.removeAttribute('style')
			document.body.removeAttribute('style')
		})
	}
})
