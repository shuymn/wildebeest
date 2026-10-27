import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Locator, type Page, test } from '@playwright/test'

import {
	ASSET_HEADERS,
	ASSET_TYPES,
	EMBED_PAGE_HEADERS,
	FINGERPRINTED_HEADERS,
	HANDOFF_PAGE_HEADERS,
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
	handoff: HANDOFF_PAGE_HEADERS,
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

// Runs a configured axe scan: it checked something, and found nothing, each violation named by its rule and targets.
async function expectNoViolations(axe: AxeBuilder): Promise<void> {
	const results = await axe.analyze()
	expect(results.passes.length).toBeGreaterThan(0)
	expect(
		results.violations.map((v) => ({ rule: v.id, targets: v.nodes.map((node) => node.target.join(' ')) }))
	).toEqual([])
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
				await expectNoViolations(axe)

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

// Each disclosure `disclosures` finds shows only its own state's cue and hides its body until opened.
async function checkDisclosures(disclosures: Locator): Promise<void> {
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
}

for (const fixture of PAGES) {
	test(`${fixture.name}: each disclosure shows only its own state's cue and hides its body until opened`, async ({
		page,
	}) => {
		await open(page, fixture)
		// A closed dialog's disclosures are checked with the dialog open (below).
		await checkDisclosures(page.locator('details:not(dialog details)'))
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
	['profile', 'nav.tabs > a', 4],
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
	// The Featured tab: the current tab, a hashtag linked and one that is not, endorsed accounts and their pager.
	['featured', 'nav.tabs > a[aria-current="page"]', 1],
	['featured', 'ul.hashtags > li > a[href^="/tags/"]', 1],
	['featured', 'ul.hashtags > li > span.name', 1],
	['featured', 'ul.accounts > li .who', 2],
	['featured', '.pager a.btn', 1],
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
	// The status page's thread: its parent above it (no line of its own), its one tab, and no replies.
	['status', 'ol.thread[aria-label] > li > article.post', 1],
	['status', 'nav.tabs > a[aria-current="page"]', 1],
	['status', 'p.empty', 1],
	// A later page of a thread's replies: two ancestors, the replies after the stub, both pager links.
	['thread', 'ol.thread[aria-label] > li > article.post', 2],
	['thread', 'ul.feed > li > article.post', 3],
	['thread', 'ul.feed > li > article.post:not(:has(.who))', 1],
	['thread', '.pager a.btn', 2],
	['thread', 'meta[name="robots"]', 1],
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
	// The history dialog: closed, its opener in the post, two versions (the older behind its warning, with sensitive
	// media and its choices) and the notice of the two left out.
	['status', 'dialog#history:not([open])', 1],
	['status', 'article.focal button[command="show-modal"][commandfor="history"]', 1],
	['status', 'dialog#history ol.versions > li', 2],
	['status', 'dialog#history details.cw details.sensitive img', 1],
	['status', 'dialog#history ul.opts > li', 5],
	['status', 'dialog#history ol + p.muted', 1],
	// The profile's posts: the pinned one's quote awaiting approval, and three polls (ended, open, counts hidden).
	['profile', 'p.gone', 1],
	['profile', '.poll', 3],
	['document', '.body.document > a', 1],
	// The look-up field with its hint, and the follow form of what a look-up found.
	['interaction', 'input[name="uri"][aria-describedby]', 1],
	['interaction-result', 'form[action="/authorize_interaction/follow"] button', 1],
	// The follow dialog beside the profile card, and the status's two: each closed, its opener on the page and its
	// copy field's button; the embed code's.
	['profile', '.card.profile button[command="show-modal"][commandfor="follow"]', 1],
	[
		'profile',
		'dialog#follow:not([open]) form[method="get"][action="/@alice/interact"] input[name="server"][autofocus]',
		1,
	],
	['profile', 'dialog#follow .copyfield button[data-copy="@alice@kopje.test"]', 1],
	['status', 'article.focal button[command="show-modal"][commandfor="interact"]', 1],
	['status', 'article.focal button[command="show-modal"][commandfor="embed"]', 1],
	['status', 'dialog#interact:not([open]) form[action="/@alice/102/interact"]', 1],
	['status', 'dialog#embed:not([open]) .copyfield button[data-copy^="<blockquote"]', 1],
	['status', 'link[rel="alternate"][type="application/json+oembed"]', 1],
	// The handoff pages: the form, the form refusing a server, and the link to the server given.
	['handoff-form', 'form[action="/@alice/interact"] input[name="server"]:not([autofocus])', 1],
	['handoff-refused', 'p.problems[role="alert"]', 1],
	['handoff-refused', 'input[name="server"][aria-invalid="true"]', 1],
	['handoff', 'a.btn.primary[href^="https://social.example/authorize_interaction?uri="]', 1],
	['handoff', '.copyfield button[data-copy]', 1],
]
for (const fixture of PAGES.filter((p) => HOLDS.some(([name]) => name === p.name))) {
	test(`${fixture.name}: the fixture holds what the checks are about`, async ({ page }) => {
		await open(page, fixture)
		for (const [, selector, count] of HOLDS.filter(([name]) => name === fixture.name)) {
			await expect(page.locator(selector), selector).toHaveCount(count)
		}
	})
}

// The status page's history dialog (design §8, amendments A5 and A7), declarative, so the same with script off: closed
// and unrendered until its opener opens it as a modal with focus on its heading's row; Esc, its close button and an
// outside click close it, and focus returns to the opener each time.
const HISTORY = 'dialog#history'
const OPENER = 'article.focal button[commandfor="history"]'

for (const javaScriptEnabled of [true, false]) {
	test.describe(`with script ${javaScriptEnabled ? 'on' : 'off'}`, () => {
		test.use({ javaScriptEnabled })

		test('status: the history dialog opens from Edited and closes by Esc, its button and outside, returning focus', async ({
			page,
		}) => {
			await open(page, pageNamed('status'))
			const dialog = page.locator(HISTORY)
			const opener = page.locator(OPENER)
			const heading = dialog.locator('> .dhead')
			const closed = async () => {
				await expect(dialog).toBeHidden()
				expect(await dialog.boundingBox()).toBeNull()
				await expect(opener).toBeFocused()
			}
			await expect(dialog).toBeHidden()
			expect(await dialog.boundingBox()).toBeNull()

			// By pointer, then Esc.
			await opener.click()
			await expect(dialog).toBeVisible()
			expect(await dialog.evaluate((d: Element) => d.matches(':modal'))).toBe(true)
			await expect(heading).toBeFocused()
			await page.keyboard.press('Escape')
			await closed()

			// By keyboard, then the close button.
			await page.keyboard.press('Enter')
			await expect(dialog).toBeVisible()
			await expect(heading).toBeFocused()
			await dialog.locator('button[command="close"]').click()
			await closed()

			// An outside click closes it too (closedby="any").
			await opener.click()
			await expect(dialog).toBeVisible()
			await page.mouse.click(5, 5)
			await closed()
		})
	})
}

// Reflow at 320 px (§14.11): a version's choice of 50 characters with no break opportunity wraps inside the dialog
// rather than widening it or overflowing its row.
test('status: a long unbroken choice in the history wraps at 320 px', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 640 })
	await open(page, pageNamed('status'))
	await page.locator(OPENER).click()
	const rows = await page.locator(`${HISTORY} ul.opts > li`).evaluateAll((items: Element[]) =>
		items.map((item) => ({
			text: item.textContent ?? '',
			overflow: item.scrollWidth - item.clientWidth,
			lines: Math.round(item.getBoundingClientRect().height / parseFloat(getComputedStyle(item).lineHeight)),
		}))
	)
	expect(rows.find((row) => row.text === 'w'.repeat(50))?.lines).toBeGreaterThan(1)
	expect(rows.map((row) => row.overflow)).toEqual(rows.map(() => 0))
	const dialog = await page
		.locator(HISTORY)
		.evaluate((d: Element) => ({ overflow: d.scrollWidth - d.clientWidth, right: d.getBoundingClientRect().right }))
	expect(dialog.overflow).toBe(0)
	expect(dialog.right).toBeLessThanOrEqual(320)
})

test('status: the history dialog’s disclosures work inside it', async ({ page }) => {
	await open(page, pageNamed('status'))
	await page.locator(OPENER).click()
	await checkDisclosures(page.locator(`${HISTORY} details`))
})

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} scheme, history open`, () => {
		test.use({ colorScheme })

		test('status: axe finds nothing with the history dialog open', async ({ page }) => {
			await open(page, pageNamed('status'))
			await page.locator(OPENER).click()
			await expect(page.locator(HISTORY)).toBeVisible()
			// The versions' disclosures open, so their contents are checked too.
			for (const summary of await page.locator(`${HISTORY} summary`).all()) {
				await summary.click()
			}
			await expectNoViolations(new AxeBuilder({ page }))
			const surface = await page.locator(HISTORY).evaluate((d: Element) => getComputedStyle(d).backgroundColor)
			expect(surface).toBe(token('surface')[colorScheme])
		})
	})
}

// Inline media (design §10.11, §13): video and audio ask for nothing before they are played, and a gifv shows its
// controls and does not play by itself. The watch sees the file requested once a player is played.
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
	// The video's poster is an image request, which the preload makes first; the watch above counted no file. Play is
	// the one step: raising preload and then calling load() aborts the fetch the raise started and requests the file
	// again. The fixture's file is a 404, so play() rejects once the request is made.
	await page
		.locator('video')
		.first()
		.evaluate((video: HTMLVideoElement) => video.play().catch(() => undefined))
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
		// The bundle's other change, left out in both: the copy controls it shows (checked on their own below).
		for (const button of copy.querySelectorAll('.copyfield button[data-copy]')) {
			button.removeAttribute('hidden')
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
	expect(tabs.map((tab) => tab.current)).toEqual(['page', null, null, null])
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

test('featured: each hashtag is a 44px row target, not underlined, its count beside it', async ({ page }) => {
	await open(page, pageNamed('featured'))
	const rows = await page.locator('ul.hashtags > li').evaluateAll((items: Element[]) =>
		items.map((item) => {
			const name = item.firstElementChild!
			const count = item.querySelector('.count')!
			return {
				height: name.getBoundingClientRect().height,
				underline: getComputedStyle(name).textDecorationLine,
				// The count sits on the name's line at this width.
				sameLine: Math.abs(count.getBoundingClientRect().top - name.getBoundingClientRect().top) < 44,
			}
		})
	)
	expect(rows).toHaveLength(2)
	for (const row of rows) {
		expect(row).toEqual({ height: expect.any(Number), underline: 'none', sameLine: true })
		expect(row.height).toBeGreaterThanOrEqual(44)
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

// A stylesheet as Chromium parses it, for comparing a source with its minified form (amendment A12): each rule's
// prelude, declarations and nested rules, in order. Chromium writes most values in a canonical form, compared exactly;
// a value it keeps as written (a custom property, a value using var(), env() or attr(), an @property initial value) is
// compared as tokens: whitespace outside strings is collapsed and dropped after `(`, around `,` and before `)`, and a
// string is compared by its contents, whatever its quotes. A rule type not handled here fails the comparison. Runs in
// the page: `texts` are parsed into constructed sheets, and `href` names a sheet the page loaded.
type ParsedRule = { head: string; declarations: string[]; rules: ParsedRule[] }

function parseSheets({ texts, href }: { texts: string[]; href: string | null }): {
	loaded: ParsedRule[] | null
	parsed: ParsedRule[][]
} {
	// Splits at `stop` characters outside strings and brackets, and normalizes the pieces as tokens when `tokens`.
	const scan = (text: string, stop: string, tokens: boolean): string[] => {
		const pieces: string[] = []
		let out = ''
		let depth = 0
		let space = false
		for (let at = 0; at < text.length;) {
			const c = text[at]!
			if (c === '"' || c === "'") {
				let content = ''
				let end = at + 1
				while (end < text.length && text[end] !== c) {
					content += text[end] === '\\' ? text.slice(end, end + 2) : text[end]
					end += text[end] === '\\' ? 2 : 1
				}
				const string = text.slice(at, end + 1)
				out +=
					(space && out !== '' && !/[(,]$/.test(out) ? ' ' : '') +
					(tokens ? `"${content.replace(/\\([^0-9a-fA-F\n])/g, '$1').replace(/["\\]/g, '\\$&')}"` : string)
				space = false
				at = end + 1
				continue
			}
			if (depth === 0 && stop.includes(c)) {
				pieces.push(out.trim())
				out = ''
				space = false
			} else if (tokens && /\s/.test(c)) {
				space = true
			} else {
				depth += '([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0
				out += (tokens && space && out !== '' && !/[(,]$/.test(out) && !'),'.includes(c) ? ' ' : '') + c
				space = false
			}
			at++
		}
		pieces.push(out.trim())
		return pieces.filter((piece) => piece !== '')
	}
	const value = (text: string) => scan(text, '', true).join('')
	const declarations = (style: CSSStyleDeclaration): string[] =>
		scan(style.cssText, ';', false).map((declaration) => {
			const at = declaration.indexOf(':')
			const [name, raw] = [declaration.slice(0, at).trim(), declaration.slice(at + 1).trim()]
			const asWritten = name.startsWith('--') || /\b(?:var|env|attr)\(/i.test(raw)
			return `${name}: ${asWritten ? value(raw) : raw}`
		})
	const prelude = (rule: CSSRule) => rule.cssText.slice(0, rule.cssText.indexOf('{')).trim()
	const walk = (list: CSSRuleList): ParsedRule[] =>
		[...list].map((rule): ParsedRule => {
			const style = (rule as CSSRule & { style: CSSStyleDeclaration }).style
			const rules = (rule as CSSRule & { cssRules: CSSRuleList }).cssRules
			switch (rule.constructor.name) {
				case 'CSSStyleRule':
					return { head: (rule as CSSStyleRule).selectorText, declarations: declarations(style), rules: walk(rules) }
				case 'CSSNestedDeclarations':
					return { head: '', declarations: declarations(style), rules: [] }
				case 'CSSKeyframeRule':
					return { head: (rule as CSSKeyframeRule).keyText, declarations: declarations(style), rules: [] }
				case 'CSSFontFaceRule':
				case 'CSSPageRule':
					return { head: prelude(rule), declarations: declarations(style), rules: [] }
				case 'CSSMediaRule':
				case 'CSSSupportsRule':
				case 'CSSContainerRule':
				case 'CSSLayerBlockRule':
				case 'CSSStartingStyleRule':
				case 'CSSScopeRule':
				case 'CSSKeyframesRule':
					return { head: prelude(rule), declarations: [], rules: walk(rules) }
				case 'CSSLayerStatementRule':
				case 'CSSImportRule':
				case 'CSSNamespaceRule':
					return { head: rule.cssText, declarations: [], rules: [] }
				case 'CSSPropertyRule': {
					const property = rule as CSSRule & {
						name: string
						syntax: string
						inherits: boolean
						initialValue: string | null
					}
					return {
						head: `@property ${property.name}`,
						declarations: [
							`syntax: ${property.syntax}`,
							`inherits: ${property.inherits}`,
							`initial-value: ${property.initialValue === null ? 'none' : value(property.initialValue)}`,
						],
						rules: [],
					}
				}
				default:
					throw new Error(`the comparison does not handle ${rule.constructor.name}: ${rule.cssText}`)
			}
		})
	const loaded =
		href === null
			? undefined
			: [...document.styleSheets].find((sheet) => sheet.href === new URL(href, location.href).href)
	return {
		loaded: loaded === undefined ? null : walk(loaded.cssRules),
		parsed: texts.map((text) => {
			const sheet = new CSSStyleSheet()
			sheet.replaceSync(text)
			return walk(sheet.cssRules)
		}),
	}
}

// The served stylesheet is minified from src/web/kopje.css (amendment A12): Chromium parses the file the page loaded
// and the source to the same rules (parseSheets).
test('the served stylesheet parses to the same rules as its source (A12)', async ({ page }) => {
	await open(page, pageNamed('profile'))
	const source = readFileSync(new URL('../src/web/kopje.css', import.meta.url), 'utf8')
	const { loaded, parsed } = await page.evaluate(parseSheets, { texts: [source], href: STYLESHEET })
	const authored = parsed[0]!
	expect(loaded).not.toBeNull()
	// The comparison is not vacuous: the source parses to rules, nested ones among them, with declarations.
	const count = (rules: ParsedRule[]): number =>
		rules.reduce((sum, rule) => sum + rule.declarations.length + count(rule.rules), 0)
	expect(authored.length).toBeGreaterThan(50)
	expect(authored.some((rule) => rule.rules.length > 0)).toBe(true)
	expect(count(authored)).toBeGreaterThan(300)
	expect(loaded).toEqual(authored)
})

test('the stylesheet comparison keeps string contents, ignores token spacing and fails on a rule it does not handle', async ({
	page,
}) => {
	await open(page, pageNamed('profile'))
	const compare = async (a: string, b: string) => {
		const { parsed } = await page.evaluate(parseSheets, { texts: [a, b], href: null })
		expect(parsed[0]!.length, a).toBeGreaterThan(0)
		return JSON.stringify(parsed[0]) === JSON.stringify(parsed[1])
	}
	// Strings that differ only in whitespace, in values kept as written and in a canonical one.
	expect(await compare('a{--x:"a  b"}', 'a{--x:"a b"}')).toBe(false)
	expect(await compare('a{--x:"a, b"}', 'a{--x:"a,b"}')).toBe(false)
	expect(await compare('a{font-family:var(--f),"a ( b"}', 'a{font-family:var(--f),"a (b"}')).toBe(false)
	expect(await compare('a{content:"a  b"}', 'a{content:"a b"}')).toBe(false)
	// Spacing between tokens and the quotes of a string are what minifying changes.
	expect(await compare("a{--x: 'a b' , calc( 1px + 2px )}", 'a{--x:"a b",calc(1px + 2px)}')).toBe(true)
	expect(
		await compare(
			'a{background:linear-gradient(1deg, var(--a), red)}',
			'a{background:linear-gradient(1deg,var(--a),red)}'
		)
	).toBe(true)
	expect(
		await compare(
			'a{background:linear-gradient(1deg,var(--a),red)}',
			'a{background:linear-gradient(1deg,var(--a),blue)}'
		)
	).toBe(false)
	// @property is compared by its descriptors.
	const property = (initial: string) => `@property --p{syntax:"<length>";inherits:false;initial-value:${initial}}`
	expect(await compare(property('0px'), property('0px'))).toBe(true)
	expect(await compare(property('0px'), property('1px'))).toBe(false)
	await expect(
		page.evaluate(parseSheets, { texts: ['@counter-style c{system:cyclic;symbols:"*"}'], href: null })
	).rejects.toThrow(/does not handle CSSCounterStyleRule/)
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

// The dialogs to follow or open a post from another server, and the embed code's (design §8, amendments A5 and A7),
// declarative, so the same with script off: closed and unrendered until their opener opens them as modals. The form
// dialogs put focus on the server field and close only by Esc or their button, so an outside click loses nothing
// typed; the embed code's focuses its heading's row and closes on an outside click too. Focus returns to the opener.
const REMOTE_DIALOGS = [
	{ page: 'profile', id: 'follow', focus: 'input[name="server"]', lightDismiss: false },
	{ page: 'status', id: 'interact', focus: 'input[name="server"]', lightDismiss: false },
	{ page: 'status', id: 'embed', focus: '> .dhead', lightDismiss: true },
] as const

const opener = (id: string) => `button[command="show-modal"][commandfor="${id}"]`

for (const javaScriptEnabled of [true, false]) {
	test.describe(`with script ${javaScriptEnabled ? 'on' : 'off'}`, () => {
		test.use({ javaScriptEnabled })

		for (const { page: name, id, focus, lightDismiss } of REMOTE_DIALOGS) {
			test(`${name}: the ${id} dialog opens with focus on ${focus}, closes by Esc and its button${lightDismiss ? ' and outside' : ', not outside'}`, async ({
				page,
			}) => {
				await open(page, pageNamed(name))
				const dialog = page.locator(`dialog#${id}`)
				const invoker = page.locator(opener(id))
				const focused = dialog.locator(focus)
				const closed = async () => {
					await expect(dialog).toBeHidden()
					expect(await dialog.boundingBox()).toBeNull()
					await expect(invoker).toBeFocused()
				}
				await expect(dialog).toBeHidden()
				expect(await dialog.boundingBox()).toBeNull()

				await invoker.click()
				await expect(dialog).toBeVisible()
				expect(await dialog.evaluate((d: Element) => d.matches(':modal'))).toBe(true)
				await expect(focused).toBeFocused()
				await page.keyboard.press('Escape')
				await closed()

				await page.keyboard.press('Enter')
				await expect(focused).toBeFocused()
				await dialog.locator('button[command="close"]').click()
				await closed()

				await invoker.click()
				await page.mouse.click(5, 5)
				if (lightDismiss) {
					await closed()
				} else {
					await expect(dialog).toBeVisible()
					await page.keyboard.press('Escape')
					await closed()
				}
			})
		}

		// The copy controls stay hidden without script, and on the script-free handoff page with it.
		for (const name of ['profile', 'status', 'handoff'] as const) {
			test(`${name}: the copy buttons are shown only by the bundle`, async ({ page }) => {
				await open(page, pageNamed(name))
				const buttons = page.locator('.copyfield button[data-copy]')
				expect(await buttons.count()).toBeGreaterThan(0)
				const shown = javaScriptEnabled && pageNamed(name).kind === 'l1'
				for (const button of await buttons.all()) {
					await expect(button).toHaveJSProperty('hidden', !shown)
				}
				// Their slot is kept either way, so showing them moves nothing (§13).
				for (const slot of await page.locator('.copyfield .slot').all()) {
					expect(await slot.evaluate((s: Element) => getComputedStyle(s).minWidth)).toBe('44px')
				}
			})
		}
	})
}

// The follow dialog's form is a same-origin GET to the handoff page (form-action 'self').
test('profile: the follow dialog’s form goes to the handoff page with the server typed', async ({ page }) => {
	await open(page, pageNamed('profile'))
	await page.locator(opener('follow')).click()
	await page.keyboard.type('social.example')
	await page.keyboard.press('Enter')
	await page.waitForURL(`${ORIGIN}/@alice/interact?server=social.example`)
	await expect(page.locator('h1')).toHaveText('Follow Alice :leaf:')
})

// The copy contract (design §7.7) with the real bundle under the production CSP and Trusted Types: a click copies the
// field's value and its status element says so; a refusal says the failure text; without the Clipboard API (a page not
// in a secure context) the controls stay hidden.
test.describe('the copy control', () => {
	test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

	for (const { page: name, id } of REMOTE_DIALOGS) {
		test(`${name}: the ${id} dialog’s copy button copies its value and says so`, async ({ page }) => {
			await open(page, pageNamed(name))
			await page.locator(opener(id)).click()
			const field = page.locator(`dialog#${id} .copyfield`)
			const button = field.locator('button')
			await expect(button).toBeVisible()
			const box = await button.boundingBox()
			expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44)
			const value = await button.getAttribute('data-copy')
			expect(value).toBe(await field.locator('.mono').textContent())
			await button.click()
			await expect(field.locator('[role="status"]')).toHaveText('Copied')
			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value)
			await expect(page.locator(`dialog#${id}`)).toBeVisible()
		})
	}

	test('profile: a refused copy says the failure text', async ({ page }) => {
		await page.addInitScript(() => {
			Clipboard.prototype.writeText = () => Promise.reject(new DOMException('refused', 'NotAllowedError'))
		})
		await open(page, pageNamed('profile'))
		await page.locator(opener('follow')).click()
		await page.locator('dialog#follow .copyfield button').click()
		await expect(page.locator('dialog#follow [role="status"]')).toHaveText(
			'Could not copy. Select the text and copy it instead.'
		)
	})

	test('profile: without the Clipboard API the copy buttons stay hidden', async ({ page }) => {
		await page.addInitScript(() => {
			Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined })
		})
		await open(page, pageNamed('profile'))
		// The bundle ran: it rewrote the times.
		expect(await page.locator('time[data-local]').first().textContent()).not.toMatch(/ UTC$/)
		await expect(page.locator('.copyfield button')).toHaveJSProperty('hidden', true)
	})
})

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} scheme, remote dialogs open`, () => {
		test.use({ colorScheme })

		for (const { page: name, id } of REMOTE_DIALOGS) {
			test(`${name}: axe finds nothing with the ${id} dialog open`, async ({ page }) => {
				await open(page, pageNamed(name))
				await page.locator(opener(id)).click()
				await expect(page.locator(`dialog#${id}`)).toBeVisible()
				await expectNoViolations(new AxeBuilder({ page }))
			})
		}
	})
}

// Reflow at 320 px (§14.11): the longest host a handoff accepts wraps in the page's heading and link.
test('handoff-long: the longest accepted host wraps inside the panel at 320 px', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 640 })
	await open(page, pageNamed('handoff-long'))
	const link = page.locator('a.btn.primary')
	expect(await link.getAttribute('href')).toMatch(/^https:\/\/a{63}\.b{63}\.c{63}\.d{61}\/authorize_interaction\?uri=/)
	const sizes = await page.evaluate(() => {
		const panel = document.querySelector('main .card')!
		const right = panel.getBoundingClientRect().right
		return {
			page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			panel: panel.scrollWidth - panel.clientWidth,
			outside: [...panel.querySelectorAll('h1, a.btn, .copy')]
				.filter((e) => e.getBoundingClientRect().right > right)
				.map((e) => e.outerHTML.slice(0, 40)),
		}
	})
	expect(sizes).toEqual({ page: 0, panel: 0, outside: [] })
	// The label wraps onto more lines rather than widening the link.
	const box = await link.boundingBox()
	expect(box!.height).toBeGreaterThan(44)
})

// Reflow at 320 px (§14.11): the embed code and a status URL wrap inside their dialogs.
test('status: the copy fields wrap inside their dialogs at 320 px', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 640 })
	await open(page, pageNamed('status'))
	for (const id of ['interact', 'embed']) {
		await page.locator(opener(id)).click()
		const dialog = page.locator(`dialog#${id}`)
		const sizes = await dialog.evaluate((d: Element) => ({
			overflow: d.scrollWidth - d.clientWidth,
			right: d.getBoundingClientRect().right,
			field: [...d.querySelectorAll('.copy')].map((c) => c.scrollWidth - c.clientWidth),
		}))
		expect(sizes, id).toEqual({ overflow: 0, right: sizes.right, field: [0] })
		expect(sizes.right, id).toBeLessThanOrEqual(320)
		await page.keyboard.press('Escape')
	}
})
