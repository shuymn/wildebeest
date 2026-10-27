import { expect, type Page, type Request, test } from '@playwright/test'

import { remoteMediaHeaders } from './headers'
import { ORIGIN } from './pages'
import { POLYGLOT, RAN_PATH } from './polyglot'

// The inertness of a cached remote file (MEDIA-4): a GIF that is also an HTML document with a script,
// served at /media/r/<token>/<file> with the headers the Worker sends for it (headers.ts, which
// test/browser-headers.test.ts compares with the route's), whole or as a range. Opened directly, in an iframe and in an
// <object>, and fetched with a Range request, it never renders as HTML and its script never runs: the script would
// fetch RAN_PATH, which every test watches for.

const FILE = `/media/r/${'G'.repeat(43)}/full.gif`
const HOST = '/host'

// What the route answers for FILE: the whole file, or a satisfiable `bytes=a-` / `bytes=a-b` range as 206.
function fileResponse(request: Request): { status: number; headers: Record<string, string>; body: Buffer } {
	const headers: Record<string, string> = { ...remoteMediaHeaders('image/gif'), etag: '"polyglot"' }
	const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '')
	const size = POLYGLOT.length
	if (range === null) {
		return { status: 200, headers: { ...headers, 'content-length': String(size) }, body: Buffer.from(POLYGLOT) }
	}
	const start = Number(range[1])
	const end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)
	return {
		status: 206,
		headers: {
			...headers,
			'content-length': String(end - start + 1),
			'content-range': `bytes ${start}-${end}/${size}`,
		},
		body: Buffer.from(POLYGLOT.subarray(start, end + 1)),
	}
}

// Serves the instance origin: FILE, a host page that embeds `embed` (no CSP of its own, so only the file's headers
// keep it inert), and a 404 for anything else; every request is recorded.
async function serve(page: Page, embed = ''): Promise<{ requests: string[]; ranges: number[] }> {
	const requests: string[] = []
	const ranges: number[] = []
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url())
		if (url.origin !== ORIGIN) {
			return route.abort('blockedbyclient')
		}
		requests.push(url.pathname)
		if (url.pathname === FILE) {
			const response = fileResponse(route.request())
			ranges.push(response.status)
			return route.fulfill(response)
		}
		if (url.pathname === HOST) {
			return route.fulfill({
				status: 200,
				headers: { 'content-type': 'text/html; charset=UTF-8' },
				body: `<!doctype html><html><head><title>host</title></head><body>${embed}</body></html>`,
			})
		}
		return route.fulfill({ status: 404, body: '' })
	})
	return { requests, ranges }
}

// Whether any frame of the page shows the polyglot's markup.
async function rendered(page: Page): Promise<boolean> {
	for (const frame of page.frames()) {
		if ((await frame.locator('#rendered').count()) > 0) {
			return true
		}
	}
	return false
}

// A moment for a script that would run to have run (its fetch is routed at once).
const settled = (page: Page) => page.waitForTimeout(500)

test.describe('a cached remote file that is also a document', () => {
	test('opened directly, shows no markup and runs no script', async ({ page }) => {
		const { requests } = await serve(page)
		const response = await page.goto(`${ORIGIN}${FILE}`, { waitUntil: 'load' })
		expect(response?.status()).toBe(200)
		expect(response?.headers()).toMatchObject({
			'content-type': 'image/gif',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
		})
		await settled(page)
		expect(requests).not.toContain(RAN_PATH)
		expect(await rendered(page)).toBe(false)
		expect(await page.title()).not.toBe('ran')
	})

	test('in an iframe, shows no markup and runs no script', async ({ page }) => {
		const { requests } = await serve(page, `<iframe src="${FILE}"></iframe>`)
		await page.goto(`${ORIGIN}${HOST}`, { waitUntil: 'load' })
		await settled(page)
		expect(requests).toContain(FILE)
		expect(requests).not.toContain(RAN_PATH)
		expect(await rendered(page)).toBe(false)
	})

	test('in an <object>, typed as HTML or not, shows no markup and runs no script', async ({ page }) => {
		const { requests } = await serve(
			page,
			`<object data="${FILE}" type="text/html"></object><object data="${FILE}?untyped"></object>`
		)
		await page.goto(`${ORIGIN}${HOST}`, { waitUntil: 'load' })
		await settled(page)
		expect(requests.filter((path) => path === FILE).length).toBeGreaterThanOrEqual(1)
		expect(requests).not.toContain(RAN_PATH)
		expect(await rendered(page)).toBe(false)
	})

	test('as a range response, opened directly, shows no markup and runs no script', async ({ page }) => {
		const { requests, ranges } = await serve(page)
		await page.setExtraHTTPHeaders({ range: 'bytes=0-' })
		const response = await page.goto(`${ORIGIN}${FILE}`, { waitUntil: 'load' })
		expect(response?.status()).toBe(206)
		expect(response?.headers()['content-range']).toBe(`bytes 0-${POLYGLOT.length - 1}/${POLYGLOT.length}`)
		expect(ranges).toContain(206)
		await settled(page)
		expect(requests).not.toContain(RAN_PATH)
		expect(await rendered(page)).toBe(false)
	})

	// The control: the same bytes served as HTML without those headers do render and run, so the checks above can see a
	// document that renders and a script that runs.
	test('served as HTML without the route headers, renders and runs (the control)', async ({ page }) => {
		const requests: string[] = []
		await page.route('**/*', async (route) => {
			const url = new URL(route.request().url())
			requests.push(url.pathname)
			if (url.pathname === FILE) {
				return route.fulfill({
					status: 200,
					headers: { 'content-type': 'text/html' },
					body: Buffer.from(POLYGLOT),
				})
			}
			return route.fulfill({ status: 404, body: '' })
		})
		await page.goto(`${ORIGIN}${FILE}`, { waitUntil: 'load' })
		await settled(page)
		expect(await rendered(page)).toBe(true)
		expect(requests).toContain(RAN_PATH)
	})
})
