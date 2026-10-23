import { describe, expect, it } from 'vitest'

import { type ApiHarness, apiHarness, bearer, login, registerApp, seedAccount, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { answer } from './budget-helpers'
import { getJson } from './status-helpers'
import { authors, linkCopies, reviewLink, setTrendSetting, storedLink, trendStatuses } from './trend-helpers'
import { railsBlank, railsBlankSql, WHITE_SPACE } from '../src/platform/rails-blank'
import type { StoreStub } from '../src/platform/store-client'

// GET /api/v1/trends/links and GET /api/v1/admin/trends/links (mastodon/trends.ts trendLinks, domain/trends.ts
// trendingLinks): Mastodon 4.5's list of allowed trending links, each its qualifying copy's card with its
// history (R41), the 200-row list bound and offset paging, Accept-Language, and the cache headers.

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()
const url = (i: number) => `https://l${String(i).padStart(3, '0')}.example/a`

// `count` stored links l000… scored from `top` down by 1 (listed), each with a qualifying copy on a public post of
// three days ago (so history is empty), in `languages` in turn; `allowed` reviews each.
async function listedLinks(
	store: StoreStub,
	count: number,
	{ top = 1000, allowed = true, languages = ['en'] }: { top?: number; allowed?: boolean; languages?: string[] } = {}
) {
	const [author] = await authors(store, 1, 700_000_000_000_000_000n)
	const ids = await trendStatuses(
		store,
		Array.from({ length: count }, (_, i) => ({ author: author!, published: NOW - 3 * DAY + i }))
	)
	await linkCopies(
		store,
		ids.map((id, i) => ({ status: id, link: url(i), language: languages[i % languages.length]! }))
	)
	for (let i = 0; i < count; i++) {
		await storedLink(store, url(i), top - i, top - i, NOW, { language: languages[i % languages.length]! })
		if (allowed) {
			await reviewLink(store, 'link', url(i), true)
		}
	}
	return ids
}

const urls = (body: unknown) => (body as { url: string }[]).map((l) => l.url)

describe('GET /api/v1/trends/links', () => {
	it('lists the allowed links by score, each its copy’s card with history, at both routes for anyone', async () => {
		const h = await apiHarness()
		const [first] = await listedLinks(h.store, 3, { allowed: false })
		expect((await getJson(h, '/api/v1/trends/links')).body).toEqual([])
		await reviewLink(h.store, 'link', url(0), true)
		await reviewLink(h.store, 'link', url(2), true)
		const listed = await getJson(h, '/api/v1/trends/links')
		expect(urls(listed.body)).toEqual([url(0), url(2)])
		const [card] = listed.body as Record<string, unknown>[]
		expect(card).toMatchObject({
			url: url(0),
			title: 'A title',
			description: 'A description',
			provider_name: 'A publisher',
			language: 'en',
			type: 'link',
			image: expect.stringMatching(/^https:\/\/kopje\.test\/media\/t0+/),
			width: 640,
			height: 360,
		})
		expect(Object.keys(card!).at(-1)).toBe('history')
		expect(card!.history).toHaveLength(7)
		// The card is the copy's, its url the final URL even where the post linked another.
		await sql(h.store, "UPDATE status_cards SET url = 'https://short.example/x' WHERE status_id = ?", first!)
		expect(urls((await getJson(h, '/api/v1/trends/links')).body)).toEqual([url(0), url(2)])
		// A rejection takes effect at once; trendable_by_default lets no link through.
		await reviewLink(h.store, 'link', url(0), false)
		await setTrendSetting(h.store, 'trendable_by_default', true)
		expect(urls((await getJson(h, '/api/v1/trends/links')).body)).toEqual([url(2)])
		await setTrendSetting(h.store, 'trends', false)
		expect(await getJson(h, '/api/v1/trends/links')).toEqual({ status: 200, body: [] })
		await setTrendSetting(h.store, 'trends', true)
		expect(urls((await getJson(h, '/api/v1/trends/links')).body)).toEqual([url(2)])
	})

	it('takes the longest reviewed publisher suffix, a link review over it, and skips a row without a copy', async () => {
		const h = await apiHarness()
		const [author] = await authors(h.store, 1, 700_000_000_000_000_000n)
		const links = ['https://a.news.example/1', 'https://b.a.news.example/2', 'https://c.news.example/3']
		const ids = await trendStatuses(
			h.store,
			links.map((_l, i) => ({ author: author!, published: NOW - 3 * DAY + i }))
		)
		await linkCopies(
			h.store,
			ids.map((id, i) => ({ status: id, link: links[i]! }))
		)
		for (const [i, link] of links.entries()) {
			await storedLink(h.store, link, 10 - i, 10 - i, NOW)
		}
		await reviewLink(h.store, 'publisher', 'news.example', true)
		await reviewLink(h.store, 'publisher', 'a.news.example', false)
		expect(urls((await getJson(h, '/api/v1/trends/links')).body)).toEqual([links[2]])
		await reviewLink(h.store, 'link', links[1]!, true)
		expect(urls((await getJson(h, '/api/v1/trends/links')).body)).toEqual([links[1], links[2]])
		// A listed row without a qualifying copy now is skipped, and read toward the page: next continues after it.
		await sql(h.store, 'UPDATE status_cards SET link_type = 0 WHERE status_id = ?', ids[1]!)
		const page = await answer<{ url: string }[]>(h, '/api/v1/trends/links?limit=1')
		expect(page.body).toEqual([])
		expect(page.next).toBe('/api/v1/trends/links?limit=1&offset=1')
		expect(urls((await answer(h, page.next!)).body)).toEqual([links[2]])
	})

	it('pages by offset with canonical links: limit absent, 0 and 21; offset 199 and 200', async () => {
		const h = await apiHarness()
		await listedLinks(h.store, 250)
		const page = (query: string) => answer<{ url: string }[]>(h, `/api/v1/trends/links${query}`)
		const first = await page('')
		expect(urls(first.body)).toHaveLength(10)
		expect(first.next).toBe('/api/v1/trends/links?offset=10')
		const none = await page('?limit=0')
		expect(none.body).toEqual([])
		expect(none.link).toBeNull()
		const max = await page('?limit=21')
		expect(urls(max.body)).toHaveLength(20)
		expect(max.next).toBe('/api/v1/trends/links?limit=20&offset=20')
		expect(urls((await page('?offset=199')).body)).toEqual([url(199)])
		expect((await page('?offset=199')).next).toBeNull()
		expect((await page('?offset=200')).body).toEqual([])
		expect((await page('?limit=5&offset=6')).prev).toBe('/api/v1/trends/links?limit=5&offset=1')
	}, 120_000)

	it('puts the Accept-Language language first, caches anonymous answers by Authorization and Accept-Language', async () => {
		const h = await apiHarness()
		await listedLinks(h.store, 4, { languages: ['en', 'ja'] })
		const ja = await h.request('/api/v1/trends/links', { headers: { 'accept-language': 'ja-JP, en;q=0.5' } })
		expect(urls(await ja.json())).toEqual([url(1), url(3), url(0), url(2)])
		expect(ja.headers.get('cache-control')).toBe('public, max-age=15, stale-while-revalidate=30, stale-if-error=86400')
		expect(ja.headers.get('vary')).toBe('Authorization, Accept-Language')
		expect(urls((await getJson(h, '/api/v1/trends/links')).body)).toEqual([url(0), url(2), url(1), url(3)])
		expect((await h.request('/api/v1/trends/links', bearer('nope'))).status).toBe(401)
	})

	it('answers the OAuth admin’s list with the public one, and refuses its link and publisher reviews', async () => {
		const h: ApiHarness = await apiHarness()
		await seedAccount(h.store, { username: 'owner', email: 'owner@example.com' })
		await setSetting(h.store, 'admin_email', 'owner@example.com')
		const scope = 'read admin:read admin:write'
		const token = (await login(h, { app: await registerApp(h, { scopes: scope }), scope, email: 'owner@example.com' }))
			.token
		await listedLinks(h.store, 2)
		const signed = await h.request('/api/v1/admin/trends/links', bearer(token))
		expect(signed.headers.get('cache-control')).toBeNull()
		const body = await signed.json()
		expect(urls(body)).toEqual([url(0), url(1)])
		expect((await getJson(h, '/api/v1/trends/links', token)).body).toEqual(body)
		for (const [method, path] of [
			['POST', '/api/v1/admin/trends/links/1/approve'],
			['POST', '/api/v1/admin/trends/links/1/reject'],
			['GET', '/api/v1/admin/trends/links/publishers'],
			['POST', '/api/v1/admin/trends/links/publishers/1/approve'],
			['POST', '/api/v1/admin/trends/links/publishers/1/reject'],
		] as const) {
			expect((await h.request(path, bearer(token, { method }))).status, path).toBe(403)
		}
	})
})

describe('railsBlankSql', () => {
	it('agrees with railsBlank on every code point of the BMP and an astral one, alone and around a letter', async () => {
		const h = await apiHarness()
		const points = [
			...Array.from({ length: 0xd800 }, (_, i) => i),
			...Array.from({ length: 0x2000 }, (_, i) => 0xe000 + i),
			0x1f600,
		]
		const texts = points.flatMap((p) => {
			const c = String.fromCodePoint(p)
			return p === 0 ? [] : [c, `${c}${c}`, `a${c}`]
		})
		const rows = await sql<{ i: number; blank: number }>(
			h.store,
			`SELECT CAST(key AS INTEGER) AS i, ${railsBlankSql('value')} AS blank FROM json_each(?1)`,
			JSON.stringify(texts)
		)
		const disagree = rows.filter((row) => Boolean(row.blank) !== railsBlank(texts[row.i]!))
		expect(disagree.map((row) => texts[row.i])).toEqual([])
		expect(rows.filter((row) => row.blank === 1)).toHaveLength(2 * WHITE_SPACE.length)
		expect(railsBlank('')).toBe(true)
	})
})
