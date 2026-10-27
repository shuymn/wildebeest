import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Locator, type Page, test } from '@playwright/test'

import {
	ASSET_HEADERS,
	ASSET_TYPES,
	EMBED_PAGE_HEADERS,
	ERROR_PAGE_HEADERS,
	FINGERPRINTED_HEADERS,
	HANDOFF_PAGE_HEADERS,
	L1_PAGE_HEADERS,
	PRIVATE_PAGE_HEADERS,
	PUBLIC_PAGE_HEADERS,
	UNAVAILABLE_PAGE_HEADERS,
} from './headers'
import { type FixturePage, ORIGIN, pageNamed, type PageName, PAGES } from './pages'
import { PAGES_DIR } from './render'
import { LOCAL_TIME, rewriteLocalTimes } from '../src/client/local-time'
import { L1_SCRIPT, STYLESHEET } from '../src/web/asset-versions'
import { FakeTime, fakePage } from '../test-node/local-time-dom'

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
	error: ERROR_PAGE_HEADERS,
	unavailable: UNAVAILABLE_PAGE_HEADERS,
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
		// The fixtures' custom emoji image, which only this job serves.
		if (url.pathname === '/fixtures/leaf.svg') {
			return route.fulfill({
				status: 200,
				headers: { ...ASSET_HEADERS, 'content-type': 'image/svg+xml' },
				body: readFileSync(new URL('./fixtures/leaf.svg', import.meta.url)),
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
				// No inline style anywhere (§6.8): the CSP would refuse it, and sizes come from attributes and classes.
				expect(await page.locator('[style]').count()).toBe(0)
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
	// Pagers with each side offered or not (checked by position below): the newer side not offered, both offered, and
	// the older side not offered.
	['profile', '.pager > a.btn', 1],
	['profile', '.pager > a.btn[rel="next"]', 1],
	['thread', '.pager > a.btn[rel="prev"] + a.btn[rel="next"]', 1],
	['followers', '.pager > a.btn', 1],
	['followers', '.pager > a.btn[rel="next"]', 0],
	// A content warning and sensitive media; a content warning on the embed.
	['profile', 'details.cw', 1],
	['profile', 'details.sensitive', 1],
	// The stub's row (a post card without an author block) and the feed's reply-to line.
	['profile', 'article.stub', 1],
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
	['follows-hidden', 'nav.tabs > a', 2],
	['follows-hidden', 'ul.accounts, .pager', 0],
	['follows-hidden', 'main > p.muted', 1],
	// The Featured tab: the current tab, a hashtag linked and one that is not, endorsed accounts and their pager.
	['featured', 'nav.tabs > a[aria-current="page"]', 1],
	['featured', 'ul.hashtags > li > a[href^="/tags/"]', 1],
	['featured', 'ul.hashtags > li > span.name', 1],
	['featured', 'ul.accounts > li .who', 2],
	['featured', '.pager a.btn', 1],
	// The hashtag page: its heading, a stub, the reply-to line and both pager links offered.
	['tag', 'main > h1', 1],
	['tag', 'main > h1 > svg', 0],
	['tag', 'article.stub', 1],
	['tag', '.reply-to', 1],
	['tag', '.pager a.btn', 2],
	['embed', 'details.cw', 1],
	// The embed's warning covers a poll whose counts are hidden (no fills) and a nested quote.
	['embed', 'details.cw .poll', 1],
	['embed', 'details.cw .poll svg.fill', 0],
	['embed', 'details.cw .quote', 1],
	['status', '.reply-to', 1],
	// The status page's thread: its parent above it (no line of its own), its one tab, and no replies.
	['status', 'ol.thread[aria-label] > li > article.post', 1],
	['status', 'nav.tabs > a[aria-current="page"]', 1],
	['status', 'main > p.muted', 1],
	// A later page of a thread's replies: two ancestors, the replies after the stub, both pager links.
	['thread', 'ol.thread[aria-label] > li > article.post', 2],
	['thread', 'ul.feed > li > article.post', 2],
	['thread', 'ul.feed > li > article.stub', 1],
	['thread', '.pager a.btn', 2],
	['thread', 'meta[name="robots"]', 1],
	// A later page of the Boosts tab: the four tabs, the current one marked, the focal post's three counts linked
	// (no quotes), two accounts and both pager links.
	['boosts', 'nav.tabs > a', 4],
	['boosts', 'nav.tabs > a[aria-current="page"][href$="/reblogs"]', 1],
	['boosts', 'article.focal .counts > a', 3],
	['boosts', 'ul.accounts > li .who', 2],
	['boosts', '.pager a.btn', 2],
	// The Quotes tab: the stub's row, two quotes each naming the post in one line, a reply-to line, the newer link not
	// offered.
	['quotes', 'nav.tabs > a[aria-current="page"][href$="/quotes"]', 1],
	['quotes', 'article.focal .counts > a', 4],
	['quotes', 'ul.feed > li > article.post', 2],
	['quotes', 'ul.feed > li > article.stub', 1],
	['quotes', 'ul.feed .quote', 0],
	['quotes', 'ul.feed article.post p.label', 2],
	['quotes', 'ul.feed .reply-to', 1],
	['quotes', 'ul.feed details.cw', 1],
	['quotes', '.pager > a.btn[rel="next"]:only-child', 1],
	// The status page's post: an emoji in its content, the author's in the name, the poll's choice; media of every
	// other type, the video's poster preloaded first; a poll with its fills; a nested quote.
	['status', 'article.focal > .body img.emoji', 1],
	['status', 'h1 img.emoji', 1],
	['status', '.poll img.emoji', 1],
	['status', 'video[preload="none"][controls]', 2],
	['status', 'video[poster]', 1],
	['status', 'video[muted][loop]', 1],
	['status', 'audio[preload="none"][controls]', 2],
	// An ALT badge for each described attachment of the post (two videos, an audio file), none for the audio without.
	['status', 'article.focal .media-item > button.alt[popovertarget]', 3],
	['status', 'article.focal .media-item:has(audio:not([aria-label])) > button.alt', 0],
	['status', 'a.media-file', 1],
	['status', 'link[rel="preload"][as="image"][fetchpriority="high"]', 1],
	['status', '.poll svg.fill rect', 2],
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
	['document', '.body.document > p > a', 1],
	['document', '.body.document > h2', 1],
	['about', '.card > .body.document > a', 1],
	// The look-up field with its hint, and the follow form of what a look-up found.
	['interaction', 'input[name="uri"][aria-describedby]', 1],
	['interaction-result', 'form[action="/authorize_interaction/follow"] button', 1],
	// A post's author's Follow, at the end of the author's row.
	['interaction-post', 'article.focal .who > .end form[action="/authorize_interaction/follow"] button', 1],
	// The follow dialog beside the profile card, and the status's two: each closed, its opener on the page and its
	// copy field's button; the embed code's.
	['profile', '.card.profile button[command="show-modal"][commandfor="follow"]', 1],
	[
		'profile',
		'dialog#follow:not([open]) form[method="get"][action="/@alice/interact"] input[name="server"][autofocus]',
		1,
	],
	['profile', 'dialog#follow .copyfield button[data-copy="@alice@kopje.test"]', 1],
	// The follow dialog's title names alice with her custom emoji (InlineText), as the handoff form's heading does.
	['profile', 'dialog#follow h2 img.emoji', 1],
	['handoff-form', 'main h1 img.emoji', 1],
	['status', 'article.focal button[command="show-modal"][commandfor="interact"]', 1],
	['status', 'article.focal button[command="show-modal"][commandfor="embed"]', 1],
	['status', 'dialog#interact:not([open]) form[action="/@alice/102/interact"]', 1],
	['status', 'dialog#embed:not([open]) .copyfield button[data-copy^="<blockquote"]', 1],
	['status', 'link[rel="alternate"][type="application/json+oembed"]', 1],
	// The handoff pages: the form, the form refusing a server, and the link to the server given.
	['handoff-form', 'form[action="/@alice/interact"] input[name="server"]:not([autofocus])', 1],
	['handoff-refused', '.field > p.error[role="alert"]', 1],
	['handoff-refused', 'input[name="server"][aria-invalid="true"]', 1],
	['handoff', 'a.btn.primary[href^="https://social.example/authorize_interaction?uri="]', 1],
	['handoff', '.copyfield button[data-copy]', 1],
	// The handoff's target before its link: the post's author and the start of its text with its emoji, the account's
	// row (owner feedback).
	['handoff', 'section.card > .who + p.clamp + .group a.btn.primary', 1],
	['handoff', 'p.clamp img.emoji', 1],
	['handoff-long', 'section.card > .who + .group a.btn.primary', 1],
	// The handoff's whole host under its link (design review B3).
	['handoff', 'a.btn.primary + .host, .group > p.actions + p.hint.host', 1],
	// The error pages: Retry (the same URL) only on 500 and 503; the header leads to the site's root without chrome.
	['error-404', 'main .actions', 0],
	['error-500', 'main .actions > a.btn[href=""]', 1],
	['error-503', 'main .actions > a.btn[href=""]', 1],
	['error-500', 'header a.site[href="/"]', 1],
	// Every page's h1 sits outside its cards, directly in main (design review A5).
	['document', 'main > h1', 1],
	['setup-login', 'main > h1', 1],
	['consent', 'main > h1', 1],
	['code', 'main > h1', 1],
	// Setup's step list with a chip each, and the done page's primary sign-in (design review A9).
	['setup', 'nav ol.toc > li > a[href^="#step-"] + .chip', 6],
	['setup', '.toc .chip.ok', 2],
	['setup', '.toc .chip.fail', 1],
	['setup', '.toc .chip.none', 3],
	['setup-done', 'a.btn.primary[href^="/login"]', 1],
	// Every count of a post with a page here links to it (design review B2); another server's post's do not.
	['profile', 'article.post .counts > a[href$="/reblogs"]', 5],
	['profile', 'article.post:has(a.name[href^="https://remote.example"]) .counts > a', 0],
	// The settings page's View profile beside its heading (design review A8).
	['settings', '.titlebar > h1 + a.quiet-link[href="/@alice"]', 1],
	// Every scope an app can ask for, and the out-of-band code alone in its field, with no copy control.
	// Every scope, by group in plain language (read, write, follow, push), and the admin ones in a warning.
	['consent-long', 'ul.scopes > li', 4],
	['consent-long', '.alert.warn', 1],
	['code', '.copy > code.mono:only-child', 1],
	['code', 'button', 0],
]
for (const fixture of PAGES.filter((p) => HOLDS.some(([name]) => name === p.name))) {
	test(`${fixture.name}: the fixture holds what the checks are about`, async ({ page }) => {
		await open(page, fixture)
		for (const [, selector, count] of HOLDS.filter(([name]) => name === fixture.name)) {
			await expect(page.locator(selector), selector).toHaveCount(count)
		}
	})
}

// A modal dialog's lifecycle, declarative (design §8): closed and unrendered at first; its opener opens it as a modal
// with focus on `focus`; Esc, its close button and an outside click (closedby="any", every dialog's) close it, while a
// click inside it (its padding, its field) does not; focus returns to the opener each time it closes.
// `menu`: the dialog's opener is in the focal post's actions menu, opened first by its "Share"; the menu closes as the
// dialog opens, so the opener is hidden when it closes. With script (the L1 bundle) focus returns to "Share"; without
// it, the browser's own behaviour, it only leaves the dialog.
async function checkDialog(
	page: Page,
	{
		dialog: selector,
		opener: invokerSelector,
		focus,
		menu = false,
		script = false,
	}: { dialog: string; opener: string; focus: string; menu?: boolean; script?: boolean }
): Promise<void> {
	const dialog = page.locator(selector)
	const invoker = page.locator(invokerSelector)
	const focused = dialog.locator(focus)
	const more = page.locator(MORE)
	const closed = async () => {
		await expect(dialog).toBeHidden()
		expect(await dialog.boundingBox()).toBeNull()
		if (menu) {
			await expect(page.locator('#actions')).toBeHidden()
			if (script) {
				await expect(more).toBeFocused()
			} else {
				await expect.poll(() => dialog.evaluate((d: Element) => d.contains(document.activeElement))).toBe(false)
			}
		} else {
			await expect(invoker).toBeFocused()
		}
	}
	const click = async () => {
		if (menu) {
			await more.click()
		}
		await invoker.click()
	}
	await expect(dialog).toBeHidden()
	expect(await dialog.boundingBox()).toBeNull()

	// By pointer, then Esc.
	await click()
	await expect(dialog).toBeVisible()
	expect(await dialog.evaluate((d: Element) => d.matches(':modal'))).toBe(true)
	await expect(focused).toBeFocused()
	await page.keyboard.press('Escape')
	await closed()

	// By keyboard, then the close button.
	if (menu) {
		await more.focus()
		await page.keyboard.press('Enter')
		await invoker.focus()
	}
	await page.keyboard.press('Enter')
	await expect(dialog).toBeVisible()
	await expect(focused).toBeFocused()
	await dialog.locator('button[command="close"]').click()
	await closed()

	// A click inside it, on its padding and on its field when it has one, keeps it open; an outside click closes it.
	await click()
	await expect(dialog).toBeVisible()
	const box = (await dialog.boundingBox())!
	await page.mouse.click(box.x + 4, box.y + box.height - 4)
	await expect(dialog).toBeVisible()
	const field = dialog.locator('input[name="server"]')
	if ((await field.count()) > 0) {
		await field.click()
		await expect(dialog).toBeVisible()
	}
	await page.mouse.click(5, 5)
	await closed()
}

// The focal post's "Share", which opens its actions menu (design review B1).
const MORE = 'article.focal button[command="toggle-popover"][commandfor="actions"]'

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
			await checkDialog(page, { dialog: HISTORY, opener: OPENER, focus: '> .dhead' })
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
		...[1, 2].map(() => ({
			tag: 'audio',
			paused: true,
			autoplay: false,
			controls: true,
			preload: 'none',
			loop: false,
			muted: false,
			poster: null,
		})),
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
// UTC and with the clock fixed: against the same page without script, only the content and title of instants marked
// data-local change, to the shapes of src/client/local-time.ts in the viewer's zone; every datetime attribute and the
// rest of the document stay as served. text is what the eye sees (a compact form's aria-hidden span), spoken the text
// of its visually hidden full form (null when the text is already full); the contract below reads the accessibility
// tree itself.
type Shown = {
	datetime: string | null
	local: string | null
	text: string
	spoken: string | null
	title: string | null
}
const shownTimes = (page: Page) =>
	page.locator('time').evaluateAll((times: Element[]) =>
		times.map((time) => ({
			datetime: time.getAttribute('datetime'),
			local: time.getAttribute('data-local'),
			text: time.querySelector(':scope > [aria-hidden="true"]')?.textContent ?? time.textContent ?? '',
			spoken: time.querySelector(':scope > .vh')?.textContent ?? null,
			title: time.getAttribute('title'),
		}))
	)
// The document as rendered, with the content and title of each data-local instant left out: what the rewrite must leave
// alone.
const restOfPage = (page: Page) =>
	page.evaluate(() => {
		const copy = document.documentElement.cloneNode(true) as HTMLElement
		for (const time of copy.querySelectorAll('time[data-local]')) {
			time.textContent = ''
			time.removeAttribute('title')
		}
		// The bundle's other change, left out in both: the copy controls it shows (checked on their own below).
		for (const button of copy.querySelectorAll('.copyfield button[data-copy]')) {
			button.removeAttribute('hidden')
		}
		return copy.outerHTML
	})

// A page that does not load the bundle marks no instant for it: nothing would rewrite one, so each keeps the server's
// full UTC text or is a calendar date (DateTime in src/web/components/basics.tsx).
for (const fixture of PAGES.filter((p) => p.kind !== 'l1')) {
	test(`${fixture.name}: without the bundle, no instant is marked data-local`, async ({ page }) => {
		await open(page, fixture)
		expect(await page.locator(`script[src="${L1_SCRIPT}"]`).count()).toBe(0)
		expect(await page.locator('time[data-local]').count()).toBe(0)
	})
}

// The viewer's now: 00:01 on Oct 24 in Tokyo, 08:01 on Oct 23 in Los Angeles.
const CLOCK = Date.parse('2026-10-23T15:01:00.000Z')

// The same rewrite run in Node over the served times, at CLOCK in the zone: what Chromium's run must agree with.
function rewrittenInNode(served: Shown[], timeZone: string): Pick<Shown, 'text' | 'spoken' | 'title'>[] {
	const times = served.map((time) => {
		const attributes = { datetime: time.datetime, 'data-local': time.local }
		const present = Object.entries(attributes).filter((entry): entry is [string, string] => entry[1] !== null)
		return new FakeTime(Object.fromEntries(present), time.text)
	})
	rewriteLocalTimes(fakePage(times), CLOCK, timeZone)
	return times.map((time, i) => {
		expect(time.writes.every(([name]) => name === 'title')).toBe(true)
		return { text: time.shown, spoken: time.spoken, title: time.writes.at(-1)?.[1] ?? served[i]!.title }
	})
}

for (const timezoneId of ['America/Los_Angeles', 'Asia/Tokyo'] as const) {
	test.describe(`in ${timezoneId}`, () => {
		test.use({ timezoneId })
		const full = new Intl.DateTimeFormat('en', { ...LOCAL_TIME, timeZone: timezoneId })

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

				await page.clock.setFixedTime(CLOCK)
				await open(page, fixture)
				const after: Shown[] = await shownTimes(page)
				expect(await restOfPage(page)).toBe(rest)
				expect(before.filter((time) => time.local !== null).length).toBeGreaterThan(0)
				const inNode = rewrittenInNode(before, timezoneId)
				expect(after).toEqual(before.map((time, i) => ({ ...time, ...inNode[i] })))
				for (const time of after.filter((time) => time.local !== null)) {
					const whole = full.format(Date.parse(time.datetime!))
					expect(time.title).toBe(whole)
					expect(time.spoken ?? time.text).toBe(whole)
					expect(time.text).not.toMatch(/ UTC$/)
				}
			})
		}

		// Selecting a post card copies its compact date once and never the visually hidden full form (time > .vh in
		// src/web/kopje.css).
		test('tag: a selected post copies its date as shown, without the full form', async ({ page }) => {
			await page.clock.setFixedTime(CLOCK)
			await open(page, pageNamed('tag'))
			const card = page
				.locator('article')
				.filter({ has: page.locator('time[data-local] > .vh') })
				.first()
			const time = card.locator('time[data-local]').first()
			const shown = (await time.locator('[aria-hidden="true"]').textContent())!
			const whole = (await time.getAttribute('title'))!
			const copied = await card.evaluate((article) => {
				const selection = window.getSelection()!
				selection.removeAllRanges()
				const range = document.createRange()
				range.selectNodeContents(article)
				selection.addRange(range)
				return selection.toString()
			})
			expect(copied.split(shown).length - 1, copied).toBe(1)
			expect(copied).not.toContain(whole)
		})

		// The contract on hand-written markup at a fixed now: each rule of the compact shape and each exception, the
		// zone boundary, and every value that is not a full UTC instant left alone. Served at a path of its own with
		// the profile's headers.
		test('the bundle compacts each instant by its distance from now in the viewer’s zone', async ({ page }) => {
			const instants: [datetime: string, local: string][] = [
				// 23:59 on Oct 23 in Tokyo, 07:59 in Los Angeles: just past midnight in one, earlier today in the other.
				['2026-10-23T14:59:00.000Z', ''],
				['2026-10-23T23:30Z', ''],
				['2026-10-20T09:30:00.000Z', ''],
				['2025-10-20T09:30:00.000Z', ''],
				['2026-10-20T09:30:00.000Z', 'full'],
				['2026-10-23T12:00:00.000Z', 'deadline'],
				['2026-10-30T12:00:00.000Z', 'deadline'],
				['2027-10-30T12:00:00.000Z', 'deadline'],
			]
			const untouched = [
				'<time datetime="2026-11-01">Nov 1, 2026</time>',
				'<time datetime="2026-11-01" data-local>Nov 1, 2026</time>',
				'<time datetime="2026-10-23T23:30:00+09:00" data-local>as served</time>',
				'<time datetime="2026-10-23T23:30:00.000Z">Oct 23, 2026, 23:30 UTC</time>',
			]
			const markup = [
				...instants.map(([datetime, local]) => `<time datetime="${datetime}" data-local="${local}">served</time>`),
				...untouched,
				// A feed's date: the link to the post's page around a compact time.
				'<a href="/@alice/102"><time datetime="2026-10-20T09:30:00.000Z" data-local>served</time></a>',
			]
			const path = '/time-contract'
			await page.clock.setFixedTime(CLOCK)
			await open(page, { name: 'time-contract', path, status: 200, kind: 'l1' }, (page) =>
				page.route(`${ORIGIN}${path}`, (route) =>
					route.fulfill({
						status: 200,
						headers: { ...L1_PAGE_HEADERS },
						body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><script defer src="${L1_SCRIPT}"></script></head><body><main>${markup.join('')}</main></body></html>`,
					})
				)
			)
			const expected = {
				'America/Los_Angeles': [
					'07:59',
					'16:30',
					'Oct 20',
					'Oct 20, 2025',
					'Oct 20, 2026, 02:30 PDT',
					'05:00',
					'Oct 30, 05:00',
					'Oct 30, 2027, 05:00',
				],
				'Asia/Tokyo': [
					'Oct 23, 23:59',
					'08:30',
					'Oct 20',
					'Oct 20, 2025',
					'Oct 20, 2026, 18:30 GMT+9',
					'Oct 23, 21:00',
					'Oct 30, 21:00',
					'Oct 30, 2027, 21:00',
				],
			}[timezoneId]
			const wholes = instants.map(([datetime]) => full.format(Date.parse(datetime)))
			expect(await shownTimes(page)).toEqual([
				...instants.map(([datetime, local], i) => ({
					datetime,
					local,
					text: expected[i],
					spoken: expected[i] === wholes[i] ? null : wholes[i],
					title: wholes[i],
				})),
				{ datetime: '2026-11-01', local: null, text: 'Nov 1, 2026', spoken: null, title: null },
				{ datetime: '2026-11-01', local: '', text: 'Nov 1, 2026', spoken: null, title: null },
				{ datetime: '2026-10-23T23:30:00+09:00', local: '', text: 'as served', spoken: null, title: null },
				{
					datetime: '2026-10-23T23:30:00.000Z',
					local: null,
					text: 'Oct 23, 2026, 23:30 UTC',
					spoken: null,
					title: null,
				},
				{ datetime: '2026-10-20T09:30:00.000Z', local: '', text: 'Oct 20', spoken: wholes[2], title: wholes[2] },
			])
			// The accessibility tree reads each instant's full form, never a compact one; a link around a compact time is
			// named by the full form, once.
			expect(await page.locator('main').ariaSnapshot()).toBe(
				[
					'- main:',
					...wholes.map((whole) => `  - time: ${whole}`),
					...['Nov 1, 2026', 'Nov 1, 2026', 'as served', 'Oct 23, 2026, 23:30 UTC'].map((text) => `  - time: ${text}`),
					`  - link "${wholes[2]}":`,
					'    - /url: /@alice/102',
					`    - time: ${wholes[2]}`,
				].join('\n')
			)
			// The link's name is the full form, once: the compact text is aria-hidden.
			await expect(page.getByRole('link')).toHaveAccessibleName(wholes[2]!)
			expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
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

test('about: inline content in a rich body stays on one line box', async ({ page }) => {
	await open(page, pageNamed('about'))
	// The body's first three children are text, a link and text: their boxes share a line.
	const boxes = await page.locator('.card > .body').evaluate((body: Element) => {
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

// A heading in rich content belongs to what follows it: more space above it than below (the document's "Logs").
test('document: a heading in rich content sits closer to the text below it', async ({ page }) => {
	await open(page, pageNamed('document'))
	// The document's sanitizer keeps the operator's <h2> a heading.
	const [above, below] = await page.locator('.body.document > h2').evaluate((h2: Element) => {
		const box = h2.getBoundingClientRect()
		return [
			box.top - h2.previousElementSibling!.getBoundingClientRect().bottom,
			h2.nextElementSibling!.getBoundingClientRect().top - box.bottom,
		]
	})
	expect(below).toBeGreaterThan(0)
	expect(above).toBeGreaterThan(below * 2)
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
// dialogs put focus on the server field; the embed code's focuses its heading's row. Each closes by Esc, its button
// and an outside click. Focus returns to the opener.
const REMOTE_DIALOGS = [
	{ page: 'profile', id: 'follow', focus: 'input[name="server"]' },
	{ page: 'status', id: 'interact', focus: 'input[name="server"]' },
	{ page: 'status', id: 'embed', focus: '> .dhead' },
] as const

const opener = (id: string) => `button[command="show-modal"][commandfor="${id}"]`

// Opens a dialog by its opener, through the focal post's actions menu where the opener is in it.
async function openDialog(page: Page, id: string): Promise<void> {
	if ((await page.locator(`#actions ${opener(id)}`).count()) > 0) {
		await page.locator(MORE).click()
	}
	await page.locator(opener(id)).click()
}

for (const javaScriptEnabled of [true, false]) {
	test.describe(`with script ${javaScriptEnabled ? 'on' : 'off'}`, () => {
		test.use({ javaScriptEnabled })

		for (const { page: name, id, focus } of REMOTE_DIALOGS) {
			test(`${name}: the ${id} dialog opens with focus on ${focus}, closes by Esc, its button and outside`, async ({
				page,
			}) => {
				await open(page, pageNamed(name))
				await checkDialog(page, {
					dialog: `dialog#${id}`,
					opener: opener(id),
					focus,
					menu: name === 'status',
					script: javaScriptEnabled,
				})
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
	// The name keeps its custom emoji in the heading, as an image named by its shortcode.
	await expect(page.locator('h1')).toHaveText(/^Follow Alice\s*$/)
	await expect(page.locator('h1 img.emoji[alt=":leaf:"]')).toHaveCount(1)
})

// The copy contract (design §7.7) with the real bundle under the production CSP and Trusted Types: a click copies the
// field's value and its status element says so; a refusal says the failure text; without the Clipboard API (a page not
// in a secure context) the controls stay hidden.
test.describe('the copy control', () => {
	test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

	for (const { page: name, id } of REMOTE_DIALOGS) {
		test(`${name}: the ${id} dialog’s copy button copies its value and says so`, async ({ page }) => {
			await open(page, pageNamed(name))
			await openDialog(page, id)
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

	test.describe('in Asia/Tokyo', () => {
		// A zone other than UTC, so the rewritten times show that the bundle ran.
		test.use({ timezoneId: 'Asia/Tokyo' })

		test('profile: without the Clipboard API the copy buttons stay hidden', async ({ page }) => {
			await page.addInitScript(() => {
				Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined })
			})
			await open(page, pageNamed('profile'))
			expect(await page.locator('time[data-local]').first().textContent()).not.toMatch(/ UTC$/)
			await expect(page.locator('.copyfield button')).toHaveJSProperty('hidden', true)
		})
	})
})

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} scheme, remote dialogs open`, () => {
		test.use({ colorScheme })

		for (const { page: name, id } of REMOTE_DIALOGS) {
			test(`${name}: axe finds nothing with the ${id} dialog open`, async ({ page }) => {
				await open(page, pageNamed(name))
				await openDialog(page, id)
				await expect(page.locator(`dialog#${id}`)).toBeVisible()
				await expectNoViolations(new AxeBuilder({ page }))
			})
		}
	})
}

// Meta lines (docs/web-pages.md, "UI rules"): their items are elements and the separators are the stylesheet's, so
// no text node sits between items and no line ends with one.
for (const fixture of PAGES) {
	test(`${fixture.name}: meta lines hold elements only, separated by the stylesheet`, async ({ page }) => {
		await open(page, fixture)
		const lines = await page.locator('.meta').evaluateAll((metas: Element[]) =>
			metas.map((meta) => ({
				text: [...meta.childNodes]
					.filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== '')
					.map((node) => node.textContent),
				separators: [...meta.children].map((item) => getComputedStyle(item, '::before').content),
			}))
		)
		for (const line of lines) {
			expect(line.text).toEqual([])
			expect(line.separators).toEqual(line.separators.map((_, i) => (i === 0 ? 'none' : '"·"')))
		}
	})
}

// A wrapped meta line begins with no separator (docs/web-pages.md, "UI rules"), at phone widths. The pixels left of
// each item that starts a wrapped line are the same with the separators hidden (through the CSSOM, which the CSP does
// not govern), while those before an item inside a line differ, so the comparison sees a separator where one is drawn.
// A link at a line's start keeps its focus ring in view.
test('status and profile: no wrapped meta line begins with a separator at 320 and 375 px', async ({ page }) => {
	type Item = { x: number; y: number; height: number; start: boolean; link: string | null }
	let starts = 0
	let inside = 0
	for (const width of [320, 375]) {
		await page.setViewportSize({ width, height: 800 })
		for (const name of ['status', 'profile'] as const) {
			await open(page, pageNamed(name))
			const items: Item[] = await page.locator('main .meta').evaluateAll((metas: Element[]) =>
				metas
					// Shown ones only: a closed disclosure's content keeps its boxes but is not painted.
					.filter((meta) => meta.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }))
					.flatMap((meta, m) => {
						const left = meta.getBoundingClientRect().left
						return [...meta.children].slice(1).map((item, i) => {
							const box = item.getBoundingClientRect()
							const link = item.querySelector('a')
							if (link !== null) {
								link.dataset.probe = `${m}-${i}`
							}
							return {
								x: box.left + scrollX,
								y: box.top + scrollY,
								height: box.height,
								start: Math.abs(box.left - left) < 1,
								link: link?.dataset.probe ?? null,
							}
						})
					})
			)
			// Each strip covers the separator's gap before the item (16 px).
			const strip = (item: Item, from: number, to: number) =>
				page.screenshot({
					fullPage: true,
					clip: { x: item.x - from, y: item.y, width: from - to, height: item.height },
				})
			const shown = await Promise.all(items.map((item) => strip(item, 16, 0)))
			const ring = items.find((item) => item.start && item.link !== null)
			if (ring !== undefined) {
				const plain = await strip(ring, 4, 0)
				await page.keyboard.press('Tab')
				await page.locator(`a[data-probe="${ring.link}"]`).focus()
				expect(await page.locator(`a[data-probe="${ring.link}"]`).evaluate((a) => a.matches(':focus-visible'))).toBe(
					true
				)
				expect((await strip(ring, 4, 0)).equals(plain), 'the focus ring is clipped').toBe(false)
				await page.locator(`a[data-probe="${ring.link}"]`).blur()
			}
			await page.evaluate(() => {
				const sheet = document.styleSheets[0]!
				sheet.insertRule('.meta > * + *::before { visibility: hidden }', sheet.cssRules.length)
			})
			const hidden = await Promise.all(items.map((item) => strip(item, 16, 0)))
			items.forEach((item, i) => {
				expect(
					hidden[i]!.equals(shown[i]!),
					`${name} item ${i} ${item.start ? 'starts a line' : 'inside a line'}`
				).toBe(item.start)
			})
			starts += items.filter((item) => item.start).length
			inside += items.filter((item) => !item.start).length
		}
	}
	// Some item starts a wrapped line (at 320 px since dates are compact) and some sits inside one.
	expect(starts).toBeGreaterThan(0)
	expect(inside).toBeGreaterThan(0)
})

// The look-up result's Follow by a post's author: beside the identity where both fit, inset from the card's edge as
// the avatar is from the other and centred on the avatar (not on the name and address, which run lower); below it
// where they do not, starting at the content edge. A long name keeps a column of its own rather than being squeezed
// beside the button.
for (const [width, below] of [
	[1280, false],
	[375, true],
	[320, true],
] as const) {
	test(`interaction-post: the author's Follow ${below ? 'wraps below' : 'sits beside'} the name at ${width} px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 800 })
		await open(page, pageNamed('interaction-post'))
		const boxes = await page.locator('article.focal').evaluate((card: Element) => {
			const who = card.querySelector('.who')!
			const [own, row, avatar, id, button] = [
				card,
				who,
				who.querySelector(':scope > .av')!,
				who.querySelector(':scope > .id')!,
				who.querySelector(':scope > .end button')!,
			].map((e) => e.getBoundingClientRect())
			return {
				below: button!.top >= id!.bottom,
				idWidth: id!.width,
				rem: parseFloat(getComputedStyle(who).fontSize),
				insets: [avatar!.left - own!.left, own!.right - button!.right],
				starts: button!.left - avatar!.left,
				centres: [button!.top + button!.height / 2, avatar!.top + avatar!.height / 2],
				taller: row!.height > avatar!.height,
			}
		})
		expect(boxes.below).toBe(below)
		expect(boxes.idWidth).toBeGreaterThanOrEqual(8 * boxes.rem)
		if (below) {
			expect(Math.abs(boxes.starts)).toBeLessThanOrEqual(1)
		} else {
			expect(Math.abs(boxes.insets[0]! - boxes.insets[1]!)).toBeLessThanOrEqual(1)
			expect(Math.abs(boxes.centres[0]! - boxes.centres[1]!)).toBeLessThanOrEqual(1)
			// The row runs below the avatar (name and address), so centring on the row would differ.
			expect(boxes.taller).toBe(true)
		}
	})
}

// A pager (docs/web-pages.md, "UI rules"): only the sides offered, the back icon before its label and the onward icon
// after it, by their boxes on the page; the older side at the row's end. Narrow, the labels shorten and the full ones
// stay the links' names.
for (const width of [1280, 320]) {
	test(`profile, thread and followers: each pager side's icon and label at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 })
		const sides: { name: string; older: boolean; icon: number[]; label: number[]; shown: string; title: string }[] = []
		for (const name of ['profile', 'thread', 'followers'] as const) {
			await open(page, pageNamed(name))
			const found = await page.locator('.pager > a').evaluateAll((links: Element[]) =>
				links.map((link) => {
					const label = [...link.querySelectorAll('span')].find((span) => span.getClientRects().length > 0)!
					const [icon, text] = [link.querySelector('svg')!, label].map((e) => e.getBoundingClientRect())
					const pager = link.parentElement!.getBoundingClientRect()
					return {
						older: link.getAttribute('rel') === 'next',
						icon: [icon!.left, icon!.right],
						label: [text!.left, text!.right],
						end: Math.abs(link.getBoundingClientRect().right - pager.right) < 1,
						shown: label.textContent ?? '',
						title: link.getAttribute('aria-label') ?? '',
					}
				})
			)
			for (const { end, ...side } of found) {
				expect(end, `${name}: the older side at the row's end`).toBe(side.older)
				sides.push({ name, ...side })
			}
		}
		expect(sides.map(({ name, older }) => [name, older])).toEqual([
			['profile', true],
			['thread', false],
			['thread', true],
			['followers', false],
		])
		for (const { name, older, icon, label, shown, title } of sides) {
			if (older) {
				expect(icon[0]!, name).toBeGreaterThanOrEqual(label[1]!)
			} else {
				expect(icon[1]!, name).toBeLessThanOrEqual(label[0]!)
			}
			expect(title, name).toMatch(/^(Newer|Older|Earlier|Later) (posts|accounts|replies)$/)
			expect(shown, name).toBe(width === 320 ? title.split(' ')[0] : title)
		}
	})
}

// Icon-only buttons (docs/web-pages.md, "UI rules"): every button showing an icon alone is a 44 px square, with each
// dialog open, named by its icon's label; the focal post's "Share" among them.
for (const [name, dialogs] of [
	['profile', ['follow']],
	['status', ['interact', 'embed', 'history']],
	['handoff', []],
] as const) {
	for (const width of [1280, 375]) {
		test(`${name}: every icon-only button is 44 × 44 at ${width} px`, async ({ page }) => {
			await page.setViewportSize({ width, height: 800 })
			await open(page, pageNamed(name))
			const iconOnly = () =>
				page.locator('button, .btn').evaluateAll((buttons: Element[]) =>
					buttons
						.filter((button) => button.checkVisibility())
						.filter((button) => (button as HTMLElement).innerText.trim() === '')
						.map((button) => {
							const box = button.getBoundingClientRect()
							return { button: button.outerHTML.slice(0, 120), width: box.width, height: box.height }
						})
				)
			const seen = await iconOnly()
			for (const id of dialogs) {
				await openDialog(page, id)
				seen.push(...(await iconOnly()))
				await page.keyboard.press('Escape')
			}
			expect(seen.length).toBeGreaterThan(dialogs.length - 1)
			for (const { button, width, height } of seen) {
				expect({ button, width, height }).toEqual({ button, width: 44, height: 44 })
			}
			if (name === 'status') {
				expect(seen.filter(({ button }) => button.includes('toggle-popover')).length).toBeGreaterThan(0)
				await expect(page.locator(MORE)).toHaveAccessibleName('Share')
			}
		})
	}
}

// Icons in one row (docs/web-pages.md, "UI rules"): every icon of a counts row, the focal post's "Share" among them,
// and of a meta line renders at one size, so none looks heavier than its neighbours.
for (const name of ['status', 'profile'] as const) {
	test(`${name}: the icons of each counts row and meta line are one size`, async ({ page }) => {
		await open(page, pageNamed(name))
		const rows = await page.locator('main :is(.counts, .meta)').evaluateAll((rows: Element[]) =>
			rows
				.filter((row) => row.checkVisibility())
				.map((row) =>
					[...row.querySelectorAll('svg.ic')]
						.filter((icon) => !icon.closest('[popover]'))
						.map((icon) => {
							const style = getComputedStyle(icon)
							return `${style.width}×${style.height}`
						})
				)
				.filter((icons) => icons.length > 1)
		)
		expect(rows.length).toBeGreaterThan(0)
		for (const icons of rows) {
			expect(new Set(icons).size, icons.join(' ')).toBe(1)
		}
		if (name === 'status') {
			const share = await page.locator(`${MORE} svg`).evaluate((icon: Element) => getComputedStyle(icon).width)
			const count = await page
				.locator('article.focal .counts > a svg')
				.first()
				.evaluate((icon: Element) => getComputedStyle(icon).width)
			expect(share).toBe(count)
		}
	})
}

// The share menu's rows (design review B1): whole-width rows, inset equally on both sides, in a popover with a small
// padding of its own.
test('status: the share menu’s rows are inset equally on both sides', async ({ page }) => {
	await open(page, pageNamed('status'))
	await page.locator(MORE).click()
	const menu = await page.locator('#actions').evaluate((menu: Element) => {
		const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
		const box = menu.getBoundingClientRect()
		return {
			padding: parseFloat(getComputedStyle(menu).paddingInlineStart) / rem,
			rows: [...menu.querySelectorAll(':scope > .btn')].map((row) => {
				const style = getComputedStyle(row)
				const own = row.getBoundingClientRect()
				return {
					start: style.paddingInlineStart,
					end: style.paddingInlineEnd,
					fill: Math.abs(own.width - (box.width - 2 * parseFloat(getComputedStyle(menu).paddingInlineStart) - 2)),
					height: own.height,
					weight: style.fontWeight,
				}
			}),
		}
	})
	expect(menu.padding).toBeLessThanOrEqual(0.5)
	expect(menu.rows).toHaveLength(2)
	for (const row of menu.rows) {
		expect(row.start).toBe(row.end)
		expect(row.fill).toBeLessThan(1)
		expect(row.height).toBeGreaterThanOrEqual(44)
		expect(row.weight).toBe('400')
	}
})

// One primary action a page (docs/web-pages.md, "UI rules"): no fixture page shows more than one primary button
// outside its closed dialogs and menus.
for (const fixture of PAGES) {
	test(`${fixture.name}: at most one primary button`, async ({ page }) => {
		await open(page, fixture)
		const primaries = await page
			.locator('.primary')
			.evaluateAll((all: Element[]) => all.filter((e) => e.checkVisibility()).map((e) => e.textContent?.trim()))
		expect(primaries.length, primaries.join(', ')).toBeLessThanOrEqual(1)
	})
}

// Settings' controls (design review A8): checkboxes and radios at 20 px in the accent, and the file input's button the
// button box.
test('settings: checkboxes are 20 px in the accent, and the file button has the button box', async ({ page }) => {
	await open(page, pageNamed('settings'))
	const checks = await page.locator('input[type="checkbox"]').evaluateAll((boxes: Element[]) =>
		boxes.map((box) => {
			const rect = box.getBoundingClientRect()
			return [rect.width, rect.height, getComputedStyle(box).accentColor]
		})
	)
	const accent = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--accent'))
	expect(checks.length).toBe(4)
	for (const [width, height, colour] of checks) {
		expect([width, height]).toEqual([20, 20])
		expect(colour).not.toBe('auto')
	}
	expect(accent).not.toBe('')
	const [file, button] = await Promise.all([
		page
			.locator('input[type="file"]')
			.first()
			.evaluate((input: Element) => {
				const style = getComputedStyle(input, '::file-selector-button')
				return [style.minHeight, style.borderRadius, style.fontSize, style.fontWeight, style.paddingInlineStart]
			}),
		page
			.locator('button[type="submit"]')
			.first()
			.evaluate((b: Element) => {
				const style = getComputedStyle(b)
				return [style.minHeight, style.borderRadius, style.fontSize, style.fontWeight, style.paddingInlineStart]
			}),
	])
	expect(file).toEqual(button)
})

// A refused field (design review A10): its error stands in for the hint, and its border takes the fail colour.
test('handoff-refused: the error replaces the hint and the field takes the fail border', async ({ page }) => {
	await open(page, pageNamed('handoff-refused'))
	await expect(page.locator('.field .hint')).toHaveCount(0)
	const [border, danger] = await page
		.locator('input[name="server"]')
		.evaluate((input: Element) => [
			getComputedStyle(input).borderTopColor,
			getComputedStyle(document.querySelector('.error')!).color,
		])
	expect(border).toBe(danger)
})

// A post's author as a page's h1 looks as on a feed card (design review A4).
test('status: the focal author looks like a feed card’s', async ({ page }) => {
	await open(page, pageNamed('status'))
	const look = (selector: string) =>
		page
			.locator(selector)
			.first()
			.evaluate((name: Element) => {
				const style = getComputedStyle(name)
				const avatar = name.closest('.who')!.querySelector('img')!.getBoundingClientRect()
				return [style.fontSize, style.fontWeight, style.lineHeight, avatar.width]
			})
	expect(await look('article.focal h1.name')).toEqual(await look('ol.thread article.post .who .name'))
})

// A post's content is spaced the same behind a content warning as without one (design review): the gaps from the body
// to the poll, within the poll and from the poll to the quote, in the tag page's warned post opened and its unwarned
// twin.
for (const width of [1280, 375]) {
	test(`tag: content behind an open warning is spaced as without one at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 })
		await open(page, pageNamed('tag'))
		const warned = page.locator('article.post:has(details.cw .poll)').first()
		await warned.locator('details.cw > summary').click()
		const gaps = (post: Locator) =>
			post.evaluate((article: Element) => {
				const top = (selector: string) => article.querySelector(selector)!.getBoundingClientRect().top
				const bottom = (selector: string) => article.querySelector(selector)!.getBoundingClientRect().bottom
				return [
					top('.poll') - bottom('.body'),
					top('.poll > .meta') - bottom('.poll > .opts'),
					top('.quote') - bottom('.poll'),
				]
			})
		const unwarned = page.locator('article.post:not(:has(details.cw)):has(.poll):has(.quote)').first()
		const [inside, outside] = [await gaps(warned), await gaps(unwarned)]
		expect(outside.every((gap) => gap > 0)).toBe(true)
		expect(inside).toEqual(outside)
		// The summary to the first revealed block, as between blocks.
		const first = await warned.evaluate(
			(article: Element) =>
				article.querySelector('details.cw .body')!.getBoundingClientRect().top -
				article.querySelector('details.cw > summary')!.getBoundingClientRect().bottom
		)
		expect(first).toBe(outside[0])
	})
}

// A profile's counts (design review): at the text's size, each whole on its line at a phone's width.
for (const width of [1280, 375, 320]) {
	test(`profile: each count is whole at the text's size at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 })
		await open(page, pageNamed('profile'))
		const items = await page.locator('ul.stats > li').evaluateAll((items: Element[]) =>
			items.map((item) => ({
				size: getComputedStyle(item).fontSize,
				// One line: the 44px target's height, not two lines of text.
				oneLine: item.getBoundingClientRect().height <= 44,
			}))
		)
		expect(items).toEqual(items.map(() => ({ size: '16px', oneLine: true })))
	})
}

// An edit-history version's blocks are spaced as a post's (design review): behind its warning, the body, the
// sensitive media's disclosure and the poll are as far apart as the focal post's body and media.
for (const width of [1280, 375]) {
	test(`status: an edit-history version's blocks are spaced as a post's at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 })
		await open(page, pageNamed('status'))
		const post = await page
			.locator('article.focal')
			.evaluate(
				(article: Element) =>
					article.querySelector(':scope > .media-grid')!.getBoundingClientRect().top -
					article.querySelector(':scope > .body')!.getBoundingClientRect().bottom
			)
		await page.locator(OPENER).click()
		const version = page.locator(`${HISTORY} ol.versions > li:has(details.cw)`)
		await version.locator('details.cw > summary').click()
		const gaps = await version.evaluate((li: Element) => {
			const blocks = [...li.querySelector('details.cw > .stack')!.children]
			return blocks
				.slice(1)
				.map((block, i) => block.getBoundingClientRect().top - blocks[i]!.getBoundingClientRect().bottom)
		})
		expect(post).toBeGreaterThan(0)
		expect(gaps.length).toBeGreaterThan(1)
		expect(gaps).toEqual(gaps.map(() => post))
	})
}

// The ALT badge (Mastodon's): each described attachment's opens its description in a popover, by pointer and by
// keyboard, and closes by Esc; an image's sits inside its box, a video's clear of the controls along its bottom, and
// audio's beside its player.
for (const width of [1280, 375]) {
	test(`status and profile: the ALT badges open their descriptions and cover no control at ${width} px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 800 })
		for (const name of ['status', 'profile'] as const) {
			await open(page, pageNamed(name))
			const badges = page.locator('main .media-item > button.alt')
			const count = await badges.count()
			expect(count).toBeGreaterThan(0)
			// Only a described attachment has one.
			expect(
				await page.locator('main .media-item').evaluateAll((items: Element[]) =>
					items.map((item) => {
						const media = item.querySelector('img, video, audio')!
						const described = (media.getAttribute('alt') ?? media.getAttribute('aria-label') ?? '').trim() !== ''
						return described === (item.querySelector(':scope > button.alt') !== null)
					})
				)
			).not.toContain(false)
			for (let i = 0; i < count; i++) {
				const badge = badges.nth(i)
				if (!(await badge.evaluate((button: Element) => button.parentElement!.checkVisibility()))) {
					// Behind a closed disclosure: not shown, so neither placed nor openable.
					continue
				}
				const item = await badge.evaluate((button: Element) => {
					const media = button.parentElement!.querySelector('img, video, audio')!
					const [own, of] = [button.getBoundingClientRect(), media.getBoundingClientRect()]
					return {
						kind: media.tagName.toLowerCase(),
						description: media.getAttribute('alt') ?? media.getAttribute('aria-label'),
						badge: [own.left, own.top, own.right, own.bottom],
						media: [of.left, of.top, of.right, of.bottom],
					}
				})
				const [left, top, right, bottom] = item.badge
				const [mLeft, mTop, mRight, mBottom] = item.media
				if (item.kind === 'img') {
					expect(left! >= mLeft! && right! <= mRight! && top! >= mTop! && bottom! <= mBottom!, 'inside').toBe(true)
				} else if (item.kind === 'video') {
					// Clear of the native controls along the video's bottom (about 44px).
					expect(bottom!, 'above the controls').toBeLessThanOrEqual(mBottom! - 44)
				} else {
					expect(left! >= mRight! || right! <= mLeft! || top! >= mBottom! || bottom! <= mTop!, 'beside').toBe(true)
				}
				const popover = page.locator(`#${await badge.getAttribute('popovertarget')}`)
				await expect(badge).toHaveAccessibleName('ALT Show description')
				expect(item.description?.trim() ?? '').not.toBe('')
				await badge.click()
				await expect(popover).toBeVisible()
				await expect(popover).toHaveText(item.description!)
				// Wide enough to read as text, even for a short description.
				expect((await popover.boundingBox())!.width).toBeGreaterThanOrEqual(160)
				await page.keyboard.press('Escape')
				await expect(popover).toBeHidden()
				await badge.focus()
				await page.keyboard.press('Enter')
				await expect(popover).toBeVisible()
				await page.keyboard.press('Escape')
				await expect(popover).toBeHidden()
			}
		}
	})
}

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} scheme, a description open`, () => {
		test.use({ colorScheme })

		test('status: axe finds nothing with an ALT description open', async ({ page }) => {
			await open(page, pageNamed('status'))
			await page.locator('article.focal .media-item > button.alt').first().click()
			await expect(page.locator('.alt-text:popover-open')).toHaveCount(1)
			await expectNoViolations(new AxeBuilder({ page }))
		})
	})
}

// The copy control's result in place (design review): the button's icon shows the outcome, the result text goes to a
// visually hidden status element, and a failure's note fills space kept for it, so the field's height never changes.
test.describe('the copy control in place', () => {
	test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

	for (const outcome of ['copied', 'failed'] as const) {
		test(`profile: a ${outcome} copy keeps the field's height`, async ({ page }) => {
			if (outcome === 'failed') {
				await page.addInitScript(() => {
					Clipboard.prototype.writeText = () => Promise.reject(new DOMException('refused', 'NotAllowedError'))
				})
			}
			await open(page, pageNamed('profile'))
			await page.locator(opener('follow')).click()
			const field = page.locator('dialog#follow .copyfield')
			const height = () => field.evaluate((f: Element) => f.getBoundingClientRect().height)
			const before = await height()
			const button = field.locator('button[data-copy]')
			await button.click()
			await expect(button).toHaveAttribute('data-state', outcome)
			expect(await height()).toBe(before)
			const status = field.locator('[role="status"]')
			await expect(status).toHaveClass('vh')
			await expect(status).toHaveText(outcome === 'copied' ? 'Copied' : /^Could not copy/)
			await expect(field.locator('.copy-failed')).toBeVisible({ visible: outcome === 'failed' })
			// The button shows the one icon of its state.
			expect(
				await button.evaluate((b: Element) =>
					[...b.children].filter((span) => getComputedStyle(span).display !== 'none').map((span) => span.className)
				)
			).toEqual([outcome])
			// Closing the dialog resets it.
			await page.keyboard.press('Escape')
			await expect(button).not.toHaveAttribute('data-state', /./)
			await expect(status).toHaveText('')
		})
	}
})

// A custom emoji is as high as its text and centred on it (design review): 1em high, in a heading, body text and a
// poll row; and its box's centre within 1.5px of a capital's beside it (the range of that letter), in body text, a feed
// name and the profile's h1, at 1280 and 375 px.
test('handoff-form and status: a custom emoji is as high as its text', async ({ page }) => {
	for (const [name, selector] of [
		['handoff-form', 'main h1 img.emoji'],
		['status', 'article.focal > .body img.emoji'],
		['status', 'article.focal .poll img.emoji'],
	] as const) {
		await open(page, pageNamed(name))
		const [height, size] = await page
			.locator(selector)
			.first()
			.evaluate((img: Element) => [
				img.getBoundingClientRect().height,
				parseFloat(getComputedStyle(img.parentElement!).fontSize),
			])
		expect(Math.abs(height - size), `${name} ${selector}`).toBeLessThanOrEqual(2)
	}
})

for (const width of [1280, 375]) {
	test(`status and profile: a custom emoji is centred on its text at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 })
		for (const [name, selector] of [
			['status', 'article.focal > .body img.emoji'],
			['profile', 'article.post .who a.name img.emoji'],
			['profile', 'h1.pname img.emoji'],
		] as const) {
			await open(page, pageNamed(name))
			const [emoji, letter] = await page
				.locator(selector)
				.first()
				.evaluate((img: Element) => {
					// The nearest capital before the emoji in its block.
					const block = img.closest('p, a, h1')!
					const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
					let cap: { node: Text; at: number } | null = null
					for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
						if (img.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
							break
						}
						const at = node.data.search(/[A-Z]/)
						if (at !== -1) {
							cap = { node, at }
						}
					}
					const range = document.createRange()
					range.setStart(cap!.node, cap!.at)
					range.setEnd(cap!.node, cap!.at + 1)
					const [own, of] = [img.getBoundingClientRect(), range.getBoundingClientRect()]
					return [own.top + own.height / 2, of.top + of.height / 2]
				})
			expect(Math.abs(emoji - letter), `${name} ${selector}`).toBeLessThanOrEqual(1.5)
		}
	})
}

// Page headings by role (docs/web-pages.md, "UI rules"): a page's own h1 at --t5 (--t4 narrow), the profile's name,
// which heads its card, at --t4 at every width.
for (const [width, own] of [
	[1280, '32px'],
	[375, '24px'],
] as const) {
	test(`about, settings and profile: each h1 at its role's size at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 })
		for (const [name, size] of [
			['about', own],
			['settings', own],
			['profile', '24px'],
		] as const) {
			await open(page, pageNamed(name))
			expect(
				await page
					.locator('main h1')
					.first()
					.evaluate((h1: Element) => getComputedStyle(h1).fontSize),
				name
			).toBe(size)
		}
	})
}

// Settings' authorized apps (design review): an app's permissions by group, admin ones in the warning's colour, and a
// row with a long name and every scope that runs out of nothing, its Revoke centred in the row.
for (const width of [1280, 375, 320]) {
	test(`settings: an authorized app with every scope stays inside its row at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 })
		await open(page, pageNamed('settings'))
		const rows = await page.locator('ul.apps > li').evaluateAll((items: Element[]) =>
			items.map((li) => {
				const box = li.getBoundingClientRect()
				const group = li.querySelector('.group')!.getBoundingClientRect()
				const revoke = li.querySelector('button')!.getBoundingClientRect()
				return {
					permissions: li.querySelector('.wraps dd')!.textContent,
					admin: [...li.querySelectorAll('.warn-text')].map((e) => e.textContent),
					outside: [...li.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > box.right + 0.5)
						.length,
					overflow: li.scrollWidth - li.clientWidth,
					// The term "Permissions" on one line, not broken inside.
					termLines: Math.round(
						li.querySelector('.wraps dt')!.getBoundingClientRect().height /
							parseFloat(getComputedStyle(li.querySelector('.wraps dt')!).lineHeight)
					),
					centre: Math.abs(revoke.top + revoke.height / 2 - (box.top + box.height / 2)),
					wrapped: revoke.top >= group.bottom,
				}
			})
		)
		expect(rows.map(({ permissions, admin }) => [permissions, admin])).toEqual([
			['Read, Write', []],
			['Read, Write, Follow, Push, Admin', ['Admin']],
		])
		for (const row of rows) {
			expect([row.outside, row.overflow, row.termLines]).toEqual([0, 0, 1])
		}
		// Beside the name and centred in the row where both fit (1280 and 375 px); below the name where they do not.
		if (width !== 320) {
			for (const row of rows) {
				expect(row.wrapped).toBe(false)
				expect(row.centre).toBeLessThanOrEqual(1)
			}
		}
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
			0
		)
	})
}

// A button's kinds in the markup (docs/web-pages.md, "UI rules"): every button and link button's classes are btn and
// its kinds (primary, quiet, danger, icon), or one of the components that are buttons of their own: the ALT badge and
// a quiet link ("Edited").
const BUTTON_CLASSES = new Set(['btn', 'primary', 'quiet', 'danger', 'icon', 'alt', 'quiet-link'])
for (const fixture of PAGES) {
	test(`${fixture.name}: every button's classes are its kinds`, async ({ page }) => {
		await open(page, fixture)
		const others = await page
			.locator('button, a.btn')
			.evaluateAll((all: Element[]) => all.flatMap((e) => [...e.classList].map((name) => `${e.tagName} ${name}`)))
		expect(others.filter((entry) => !BUTTON_CLASSES.has(entry.split(' ')[1]!))).toEqual([])
	})
}

// The OAuth code page has no script (#1185): one click on the code selects the whole of it.
test('code: one click selects the whole code', async ({ page }) => {
	await open(page, pageNamed('code'))
	const code = page.locator('.copy > code.mono')
	await code.click()
	expect(await page.evaluate(() => getSelection()!.toString())).toBe(await code.textContent())
})

// An address inside a sentence is its content, not muted (design review): the sign-in confirmation's in the ink.
test('consent-first-party: the address in the sentence is in the ink colour', async ({ page }) => {
	await open(page, pageNamed('consent-first-party'))
	const [address, ink] = await page
		.locator('main p strong')
		.evaluate((strong: Element) => [getComputedStyle(strong).color, getComputedStyle(document.body).color])
	expect(address).toBe(ink)
	await expect(page.locator('main p strong')).toHaveText('@alice@kopje.test')
})

// Settings' address (design review): a read-only field named "Address", focusable and copyable, outside the profile
// form, so the form posts what it did; its look not an editable field's, with a lock at its end.
for (const width of [1280, 375]) {
	test(`settings: the address is a read-only field outside the form at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 })
		await open(page, pageNamed('settings'))
		const field = page.getByRole('textbox', { name: 'Address' })
		await expect(field).toHaveValue('@alice@kopje.test')
		await expect(field).not.toBeEditable()
		await expect(field).toHaveAttribute('readonly', '')
		await field.focus()
		await expect(field).toBeFocused()
		expect(await field.evaluate((input: Element) => [input.closest('form'), input.getAttribute('name')])).toEqual([
			null,
			null,
		])
		// The profile form posts exactly its own fields.
		const posted = await page
			.locator('form[action="/settings/profile"]')
			.evaluate((form: Element) => [...new FormData(form as HTMLFormElement).keys()])
		expect(posted).not.toContain('address')
		expect(posted.slice(0, 3)).toEqual(['csrf', 'display_name', 'note'])
		const [own, editable] = await page.evaluate(() =>
			[document.querySelector('.readonly > input')!, document.querySelector('input[name="display_name"]')!].map((e) => {
				const style = getComputedStyle(e)
				return [style.backgroundColor, style.borderTopColor]
			})
		)
		expect(own).not.toEqual(editable)
		await expect(page.locator('.readonly > svg.ic')).toBeVisible()
	})
}

// The handoff's post text: two lines at most, the second cut with an ellipsis, at a phone's width and a desktop's.
for (const width of [1280, 375]) {
	test(`handoff: the post's text shows two lines at most at ${width} px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 })
		await open(page, pageNamed('handoff'))
		const text = await page.locator('p.clamp').evaluate((p: HTMLElement) => ({
			lines: p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight),
			cut: p.scrollHeight > p.clientHeight,
		}))
		expect(text.lines).toBeCloseTo(2, 1)
		expect(text.cut).toBe(true)
	})
}

// The tabs (design review): --s5 apart, and the profile's four on one line at a phone's width (--s4 apart there) with
// nothing scrolling sideways; a hovered tab takes the ink and a thin neutral line, the current one keeps its accent.
test('profile: the tabs fit one line at 375 px, and hover marks a tab neutrally', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'light' })
	await page.setViewportSize({ width: 375, height: 800 })
	await open(page, pageNamed('profile'))
	const tops = await page
		.locator('nav.tabs > a')
		.evaluateAll((tabs: Element[]) => tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)))
	expect(new Set(tops).size).toBe(1)
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
	await page.setViewportSize({ width: 1280, height: 800 })
	const look = (tab: Locator) =>
		tab.evaluate((a: Element) => {
			const style = getComputedStyle(a)
			return {
				colour: style.color,
				line: style.borderBottomColor,
				width: style.borderBottomWidth,
			}
		})
	const other = page.locator('nav.tabs > a:not([aria-current])').first()
	const current = page.locator('nav.tabs > a[aria-current="page"]')
	const [before, resting] = [await look(other), await look(current)]
	await other.hover()
	const hovered = await look(other)
	expect(hovered.colour).toBe(token('ink').light)
	expect(hovered.colour).not.toBe(before.colour)
	expect(hovered.line).toBe(token('control-line').light)
	expect(hovered.width).toBe('1px')
	await current.hover()
	expect(await look(current)).toEqual(resting)
	expect(resting.line).toBe(token('accent').light)
})

// The focal post's actions menu (design review B1): "Share" opens it by pointer and by keyboard, each item opens its
// dialog (the menu closing), Esc and an outside click close it, and nothing in it is an ARIA menu.
for (const javaScriptEnabled of [true, false]) {
	test.describe(`with script ${javaScriptEnabled ? 'on' : 'off'}`, () => {
		test.use({ javaScriptEnabled })

		test('status: the actions menu opens and leads to each dialog', async ({ page }) => {
			await open(page, pageNamed('status'))
			const more = page.locator(MORE)
			const menu = page.locator('#actions')
			await expect(menu).toBeHidden()
			await expect(menu.locator('[role]')).toHaveCount(0)
			// By pointer: open, then an outside click closes it.
			await more.click()
			await expect(menu).toBeVisible()
			expect(await menu.evaluate((m: Element) => m.matches(':popover-open'))).toBe(true)
			// Anchored below "Share", ending at its end.
			const [anchor, panel] = [await more.boundingBox(), await menu.boundingBox()]
			expect(panel!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height - 1)
			expect(Math.abs(panel!.x + panel!.width - (anchor!.x + anchor!.width))).toBeLessThan(1)
			await page.mouse.click(5, 5)
			await expect(menu).toBeHidden()
			// By keyboard: Enter opens it, Tab reaches its items, Esc closes it and keeps focus on "Share".
			await more.focus()
			await page.keyboard.press('Enter')
			await expect(menu).toBeVisible()
			await page.keyboard.press('Tab')
			await expect(menu.locator(opener('interact'))).toBeFocused()
			await page.keyboard.press('Escape')
			await expect(menu).toBeHidden()
			await expect(more).toBeFocused()
			// Each item opens its dialog, which the menu gives way to.
			for (const [id, label] of [
				['interact', 'Open on your server'],
				['embed', 'Embed'],
			] as const) {
				await more.click()
				await expect(menu.locator(opener(id))).toHaveAccessibleName(label)
				await menu.locator(opener(id)).click()
				await expect(page.locator(`dialog#${id}`)).toBeVisible()
				await expect(menu).toBeHidden()
				await page.keyboard.press('Escape')
				await expect(page.locator(`dialog#${id}`)).toBeHidden()
			}
		})
	})
}

for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} scheme, actions menu open`, () => {
		test.use({ colorScheme })

		test('status: axe finds nothing with the actions menu open', async ({ page }) => {
			await open(page, pageNamed('status'))
			await page.locator(MORE).click()
			await expect(page.locator('#actions')).toBeVisible()
			await expectNoViolations(new AxeBuilder({ page }))
		})
	})
}

// The one alert (docs/web-pages.md, "UI rules"): every status has the same box, its status shown by the colour of its
// bar, and its title without a colon.
test('setup and settings: every alert status has the same box', async ({ page }) => {
	const alerts: { status: string; box: Record<string, string>; bar: string; title: string }[] = []
	for (const name of ['setup', 'settings', 'setup-login'] as const) {
		await open(page, pageNamed(name))
		alerts.push(
			...(await page.locator('.alert').evaluateAll((elements: Element[]) =>
				elements.map((alert) => {
					const style = getComputedStyle(alert)
					return {
						status: alert.classList[1]!,
						box: {
							padding: style.padding,
							borderWidth: `${style.borderTopWidth} ${style.borderInlineStartWidth}`,
							radius: style.borderRadius,
							background: style.backgroundColor,
							icon: getComputedStyle(alert.querySelector('svg')!).height,
						},
						bar: style.borderInlineStartColor,
						title: alert.querySelector('strong')!.textContent,
					}
				})
			))
		)
	}
	expect(new Set(alerts.map((alert) => alert.status))).toEqual(new Set(['ok', 'warn', 'fail']))
	for (const alert of alerts) {
		expect(alert.box).toEqual(alerts[0]!.box)
		expect(alert.title).not.toMatch(/:$/)
	}
	const bars = new Map(alerts.map((alert) => [alert.status, alert.bar]))
	expect(new Set(bars.values()).size).toBe(3)
})

// A field's error is not an alert: it sits under its field, and the field names it and is invalid.
test('handoff-refused: the refusal is under its field, tied to the input', async ({ page }) => {
	await open(page, pageNamed('handoff-refused'))
	const input = page.locator('input[name="server"]')
	await expect(input).toHaveAttribute('aria-invalid', 'true')
	const error = page.locator('.field > p.error')
	await expect(error).toHaveCount(1)
	const id = await error.getAttribute('id')
	expect((await input.getAttribute('aria-describedby'))!.split(' ')).toContain(id)
	await expect(input).toHaveAccessibleDescription(/^Enter the domain of your server/)
	await expect(page.locator('.alert')).toHaveCount(0)
})

// A dialog focused on its heading shows the ring only when opened from the keyboard (:focus-visible).
test('status: a dialog’s heading shows the focus ring for the keyboard only', async ({ page }) => {
	await open(page, pageNamed('status'))
	const opener = page.locator('button[command="show-modal"][commandfor="embed"]')
	const more = page.locator(MORE)
	const ring = () =>
		page.evaluate(() => {
			const focused = document.activeElement!
			return { head: focused.classList.contains('dhead'), ring: getComputedStyle(focused).outlineStyle }
		})
	await more.click()
	await opener.click()
	expect(await ring()).toEqual({ head: true, ring: 'none' })
	await page.keyboard.press('Escape')
	await more.focus()
	await page.keyboard.press('Enter')
	await opener.focus()
	await page.keyboard.press('Enter')
	expect(await ring()).toEqual({ head: true, ring: 'solid' })
})

// Reflow at 320 px (§14.11): no page scrolls sideways.
for (const fixture of PAGES) {
	test(`${fixture.name}: nothing overflows the page at 320 px`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 640 })
		await open(page, fixture)
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
			0
		)
	})
}

// One button box (docs/web-pages.md, "UI rules"): a form's button, a link button and the primary and quiet ones, side
// by side under the published stylesheet, differ only in colour and border.
test('a button, .btn, .btn.primary and .btn.quiet have one box', async ({ page }) => {
	const path = '/button-box'
	await open(page, { name: 'button-box', path, status: 200, kind: 'private' }, (page) =>
		page.route(`${ORIGIN}${path}`, (route) =>
			route.fulfill({
				status: 200,
				headers: { ...PRIVATE_PAGE_HEADERS },
				body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><link rel="stylesheet" href="${STYLESHEET}"></head><body><main><p class="actions"><button type="submit">Save</button><a class="btn" href="/">Older</a><a class="btn primary" href="/">Continue</a><button type="button" class="btn quiet">Embed</button></p></main></body></html>`,
			})
		)
	)
	const boxes = await page.locator('.actions > *').evaluateAll((elements: Element[]) =>
		elements.map((element) => {
			const style = getComputedStyle(element)
			return {
				height: element.getBoundingClientRect().height,
				padding: style.padding,
				fontSize: style.fontSize,
				fontWeight: style.fontWeight,
				lineHeight: style.lineHeight,
			}
		})
	)
	expect(boxes).toHaveLength(4)
	expect(boxes[0]!.height).toBeGreaterThanOrEqual(44)
	for (const box of boxes) {
		expect(box).toEqual(boxes[0])
	}
})

// The poll's one shape (docs/web-pages.md, "UI rules"): a choice of one line has the same box counted (the status's
// poll), with its counts hidden (the embed's, behind its warning) and in the edit history; a counted choice's fill is
// its share of the row.
test('status and embed: a poll choice has one box in every state, and its fill is its share', async ({ page }) => {
	const box = (li: Element) => {
		const style = getComputedStyle(li)
		return { height: li.getBoundingClientRect().height, padding: style.padding, border: style.border }
	}
	await open(page, pageNamed('status'))
	const counted = page.locator('article.focal .poll .opts > li')
	await expect(counted).toHaveCount(2)
	const shares = await counted.evaluateAll((items: Element[]) =>
		items.map((li) => ({
			share: Number(li.querySelector('.share')!.textContent.replace('%', '')),
			fill: li.querySelector('svg.fill rect')!.getBoundingClientRect().width,
			row: li.querySelector('svg.fill')!.getBoundingClientRect().width,
		}))
	)
	expect(shares.map(({ share }) => share)).toEqual([75, 25])
	for (const { share, fill, row } of shares) {
		expect(Math.abs(fill - (row * share) / 100)).toBeLessThan(1)
	}
	const shown = await counted.last().evaluate(box)
	expect(shown.height).toBeGreaterThan(0)
	await page.locator(OPENER).click()
	const history = page.locator(`${HISTORY} ul.opts > li`).filter({ hasText: /^The hill$/ })
	await expect(history).toHaveCount(1)
	expect(await history.evaluate(box)).toEqual(shown)

	await open(page, pageNamed('embed'))
	await page.locator('details.cw > summary').first().click()
	const hidden = page.locator('.poll .opts > li').filter({ hasText: /^The hill$/ })
	await expect(hidden).toHaveCount(1)
	await expect(hidden.locator('svg, .share')).toHaveCount(0)
	expect(await hidden.evaluate(box)).toEqual(shown)
})

// A poll choice's text keeps AA contrast over its fill, in both schemes: the text's colour against the rect's.
for (const colorScheme of ['light', 'dark'] as const) {
	test.describe(`${colorScheme} scheme`, () => {
		test.use({ colorScheme })

		test('status: a poll choice’s text keeps 4.5:1 over its fill', async ({ page }) => {
			await open(page, pageNamed('status'))
			const pairs = await page
				.locator('article.focal .poll .opts > li')
				.evaluateAll((items: Element[]) =>
					items.map((li) => [getComputedStyle(li).color, getComputedStyle(li.querySelector('svg.fill rect')!).fill])
				)
			expect(pairs).toHaveLength(2)
			const luminance = (colour: string) => {
				const [r = 0, g = 0, b = 0] = /^rgb\((\d+), (\d+), (\d+)\)$/
					.exec(colour)!
					.slice(1)
					.map((c) =>
						Number(c) / 255 <= 0.04045 ? Number(c) / 255 / 12.92 : ((Number(c) / 255 + 0.055) / 1.055) ** 2.4
					)
				return 0.2126 * r + 0.7152 * g + 0.0722 * b
			}
			for (const [text, fill] of pairs) {
				const [hi, lo] = [luminance(text!), luminance(fill!)].sort((a, b) => b - a)
				expect((hi! + 0.05) / (lo! + 0.05), `${text} on ${fill}`).toBeGreaterThanOrEqual(4.5)
			}
		})
	})
}

// Reflow at 320 px (§14.11): the longest host a handoff accepts stays inside the panel, its heading one line cut with an
// ellipsis.
test('handoff-long: the longest accepted host stays inside the panel at 320 px', async ({ page }) => {
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
	// The heading keeps one line: its text is cut, not wrapped.
	const heading = await page.locator('main h1').evaluate((h) => ({
		lines: Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight)),
		cut: h.scrollWidth > h.clientWidth,
	}))
	expect(heading).toEqual({ lines: 1, cut: true })
})

// Reflow at 320 px (§14.11): the embed code and a status URL wrap inside their dialogs.
test('status: the copy fields wrap inside their dialogs at 320 px', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 640 })
	await open(page, pageNamed('status'))
	for (const id of ['interact', 'embed']) {
		await openDialog(page, id)
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

// Reflow at 320 px (§14.11): the longest app name, website and username, every scope, and the out-of-band code wrap
// inside their card, and the consent form's buttons stay inside it.
for (const name of ['consent-long', 'code'] as const) {
	test(`${name}: the longest values wrap inside the card at 320 px`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 640 })
		await open(page, pageNamed(name))
		const sizes = await page.evaluate(() => {
			const card = document.querySelector('main .card')!
			const right = card.getBoundingClientRect().right
			return {
				page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				card: card.scrollWidth - card.clientWidth,
				outside: [...card.querySelectorAll('h1, dd, li, button, .copy, code')]
					.filter((e) => e.getBoundingClientRect().right > right)
					.map((e) => e.outerHTML.slice(0, 40)),
				// Text that runs past its own box, which the boxes' edges above do not show.
				// A one-line value (the website's host) is cut with an ellipsis, its whole in its title.
				overflowing: [...card.querySelectorAll('h1, dd:not(.oneline), .copy, .copy > code')]
					.filter((e) => e.scrollWidth > e.clientWidth)
					.map((e) => e.outerHTML.slice(0, 40)),
			}
		})
		expect(sizes).toEqual({ page: 0, card: 0, outside: [], overflowing: [] })
	})
}

// The consent form (WEB-1): each decision submits by keyboard, posting the hidden fields with it to /oauth/authorize.
for (const [decision, key] of [
	['approve', 'Enter'],
	['deny', 'Space'],
] as const) {
	test(`consent: ${decision} submits the form by keyboard (${key})`, async ({ page }) => {
		const posted: string[] = []
		await open(page, pageNamed('consent'), (p) =>
			p.route(`${ORIGIN}/oauth/authorize`, async (route) => {
				if (route.request().method() !== 'POST') {
					return route.fallback()
				}
				posted.push(route.request().postData() ?? '')
				return route.fulfill({ status: 204, body: '' })
			})
		)
		const button = page.locator(`button[value="${decision}"]`)
		// The skip link, the header's link to the site's root, then the decisions in order.
		await page.keyboard.press('Tab')
		await page.keyboard.press('Tab')
		await page.keyboard.press('Tab')
		if (decision === 'deny') {
			await page.keyboard.press('Tab')
		}
		await expect(button).toBeFocused()
		expect(await button.evaluate(unseen)).toEqual([])
		await page.keyboard.press(key)
		await expect.poll(() => posted).toHaveLength(1)
		expect(Object.fromEntries(new URLSearchParams(posted[0]))).toEqual({
			client_id: 'k'.repeat(43),
			redirect_uri: 'https://client.example/callback',
			scope: 'read write follow',
			state: 's',
			decision,
		})
	})
}
