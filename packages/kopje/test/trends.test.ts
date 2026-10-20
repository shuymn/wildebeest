import { describe, expect, it } from 'vitest'

import { type ApiHarness, apiHarness, bearer, login, registerApp, seedAccount, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { answer, bigStatus } from './budget-helpers'
import { BUILD } from './helpers'
import { ACCESS, setAccess } from './ops-helpers'
import { appToken, scopedToken } from './read-helpers'
import { block, community, getJson } from './status-helpers'
import { authors, review, round, setTrendSetting, trendStatuses } from './trend-helpers'
import { preferredLanguage } from '../src/mastodon/trends'
import type { StoreStub } from '../src/platform/store-client'

// GET /api/v1/trends/tags (and /api/v1/trends), /statuses and /links (mastodon/trends.ts, domain/trends.ts): Mastodon
// 4.5's lists of allowed trends, R41, the 200-row list bound and offset paging, and the cache headers.

const HOUR = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

// `count` stored hashtags t000… scored from `top` down by 1, each listed (score of 1 or more).
async function listedTags(store: StoreStub, count: number, top = 1000) {
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO trend_tags (name, score, max_score, max_score_at)
		SELECT printf('t%03d', i), ?2 - i, ?2 - i, ?3 FROM n`,
		count,
		top,
		iso(NOW)
	)
}

const names = (body: unknown) => (body as { name: string }[]).map((t) => t.name)
const ids = (body: unknown) => (body as { id: string }[]).map((s) => s.id)

describe('GET /api/v1/trends/tags', () => {
	it('lists the allowed hashtags by score, with their history, at both routes', async () => {
		const h = await apiHarness()
		await listedTags(h.store, 3)
		expect((await getJson(h, '/api/v1/trends/tags')).body).toEqual([])
		await review(h.store, 'tag_trend_reviews', 't001', true)
		await review(h.store, 'tag_trend_reviews', 't002', true)
		const listed = await getJson(h, '/api/v1/trends/tags')
		expect(names(listed.body)).toEqual(['t001', 't002'])
		expect(listed.body).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 't001', url: 'https://kopje.test/tags/t001', history: expect.any(Array) }),
			])
		)
		expect((listed.body as { history: unknown[] }[])[0]!.history).toHaveLength(7)
		expect(await getJson(h, '/api/v1/trends')).toEqual(listed)
		// A rejection takes effect at once; the default lets unreviewed rows through.
		await review(h.store, 'tag_trend_reviews', 't001', false)
		expect(names((await getJson(h, '/api/v1/trends/tags')).body)).toEqual(['t002'])
		await setTrendSetting(h.store, 'trendable_by_default', true)
		expect(names((await getJson(h, '/api/v1/trends/tags')).body)).toEqual(['t000', 't002'])
		await setTrendSetting(h.store, 'trends', false)
		expect(await getJson(h, '/api/v1/trends/tags')).toEqual({ status: 200, body: [] })
	})

	it('caches anonymous answers, shows a viewer their follows, and refuses an invalid token', async () => {
		const h = await community(['alice'])
		await listedTags(h.store, 1)
		await setTrendSetting(h.store, 'trendable_by_default', true)
		const anonymous = await h.request('/api/v1/trends/tags')
		expect(anonymous.headers.get('cache-control')).toBe(
			'public, max-age=15, stale-while-revalidate=30, stale-if-error=86400'
		)
		expect(anonymous.headers.get('vary')).toContain('Authorization')
		expect(anonymous.headers.get('deprecation')).toBeNull()
		const signed = await h.request('/api/v1/trends/tags', bearer(h.users.alice.token))
		expect(signed.headers.get('cache-control')).toBeNull()
		expect(await signed.json()).toEqual([expect.objectContaining({ name: 't000', following: false, featuring: false })])
		expect((await h.request('/api/v1/trends/tags', bearer('nope'))).status).toBe(401)
		expect((await getJson(h, '/api/v1/trends/tags', await appToken(h))).status).toBe(200)
	})

	it('pages by offset with canonical links: limit absent, 0, -5 and 21; offset negative, 199 and 200', async () => {
		const h = await apiHarness()
		await listedTags(h.store, 250)
		await setTrendSetting(h.store, 'trendable_by_default', true)
		const page = (query: string) => answer<{ name: string }[]>(h, `/api/v1/trends${query}`)
		const first = await page('')
		expect(names(first.body)).toHaveLength(10)
		expect(first.next).toBe('/api/v1/trends/tags?offset=10')
		expect(first.prev).toBeNull()
		const none = await page('/tags?limit=0')
		expect(none.body).toEqual([])
		expect(none.link).toBeNull()
		expect(names((await page('/tags?limit=-5')).body)).toEqual(['t000', 't001', 't002', 't003', 't004'])
		const max = await page('/tags?limit=21&offset=-3')
		expect(names(max.body)).toHaveLength(20)
		expect(max.next).toBe('/api/v1/trends/tags?limit=20&offset=20')
		expect(names((await page('/tags?offset=199')).body)).toEqual(['t199'])
		expect((await page('/tags?offset=199')).next).toBeNull()
		expect((await page('/tags?offset=200')).body).toEqual([])
		// prev only past the limit: none at offset == limit, offset - limit at limit + 1.
		expect((await page('/tags?limit=5&offset=5')).prev).toBeNull()
		expect((await page('/tags?limit=5&offset=6')).prev).toBe('/api/v1/trends/tags?limit=5&offset=1')
	})

	// At saturation the list is the top 200 of what is allowed now, whatever the page size, between rounds.
	it('ends at 200 for every traversal when approvals and the default change between rounds', async () => {
		const h = await apiHarness()
		await listedTags(h.store, 250)
		for (let i = 0; i < 200; i++) {
			await review(h.store, 'tag_trend_reviews', `t${String(i + 50).padStart(3, '0')}`, true)
		}
		const walk = async (limit: number, from: number) => {
			const seen: string[] = []
			for (let at: string | null = `/api/v1/trends/tags?limit=${limit}&offset=${from}`; at !== null;) {
				const page: Awaited<ReturnType<typeof answer<{ name: string }[]>>> = await answer(h, at)
				seen.push(...names(page.body))
				at = page.next
			}
			return seen
		}
		const approved = await walk(20, 0)
		expect(approved).toHaveLength(200)
		expect(approved[0]).toBe('t050')
		await setTrendSetting(h.store, 'trendable_by_default', true)
		const all = await walk(20, 0)
		expect(all).toEqual(Array.from({ length: 200 }, (_, i) => `t${String(i).padStart(3, '0')}`))
		expect(await walk(7, 3)).toEqual(all.slice(3))
		expect(await walk(13, 0)).toEqual(all)
	})
})

describe('a Unicode hashtag from listing to review (M4)', () => {
	it('is reviewed and counted under the name it is listed by', async () => {
		const h = await apiHarness()
		await setAccess(h.store)
		await setTrendSetting(h.store, 'trendable_by_default', true)
		const a = await authors(h.store, 5)
		await trendStatuses(
			h.store,
			a.map((author, i) => ({ author, published: NOW + i, tags: ['カフェ'] }))
		)
		await round(h.store, NOW + HOUR)
		const listed = (await getJson(h, '/api/v1/trends/tags')).body as { name: string; history: { uses: string }[] }[]
		expect(listed.map((t) => t.name)).toEqual(['カフェ'])
		expect(listed[0]!.history[0]!.uses).toBe('5')
		const rejected = await h.store.reviewTrendTag(BUILD, {
			authority: ACCESS,
			name: listed[0]!.name,
			trendable: false,
			origin: 'https://kopje.test',
		})
		expect(rejected).toMatchObject({ ok: true, tag: { name: 'カフェ', trendable: false, score: 16 } })
		expect((await getJson(h, '/api/v1/trends/tags')).body).toEqual([])
		const tag = (await getJson(h, `/api/v1/tags/${encodeURIComponent('カフェ')}`)).body as {
			history: { uses: string }[]
		}
		expect(tag.history[0]!.uses).toBe('5')
	})
})

describe('GET /api/v1/trends/statuses', () => {
	async function world() {
		const h = await community(['viewer'])
		const a = await authors(h.store, 6)
		return { h, a }
	}

	it('lists each author’s top status only when it is allowed, the status before the author before the default', async () => {
		const { h, a } = await world()
		const [top, lower, other, third] = await trendStatuses(h.store, [
			{ author: a[0]!, published: NOW - HOUR, seq: 0, favourites: 50 },
			{ author: a[0]!, published: NOW - HOUR, seq: 1, favourites: 20 },
			{ author: a[1]!, published: NOW - HOUR, seq: 2, favourites: 30 },
			{ author: a[2]!, published: NOW - HOUR, seq: 3, favourites: 10 },
		])
		await round(h.store, NOW)
		const listed = async () => ids((await getJson(h, '/api/v1/trends/statuses')).body)
		await review(h.store, 'status_trend_reviews', lower!, true)
		// The author's maximum is unreviewed: none of theirs.
		expect(await listed()).toEqual([])
		await review(h.store, 'account_trend_reviews', a[0]!, true)
		await review(h.store, 'account_trend_reviews', a[1]!, true)
		await review(h.store, 'status_trend_reviews', other!, false)
		expect(await listed()).toEqual([top])
		await setTrendSetting(h.store, 'trendable_by_default', true)
		expect(await listed()).toEqual([top, third])
		// Ineligible since the round: gone on the next read.
		await sql(h.store, 'UPDATE statuses SET sensitive = 1 WHERE id = ?', top!)
		expect(await listed()).toEqual([third])
	})

	it('puts the Accept-Language language first, filters for the viewer, and varies by both', async () => {
		const { h, a } = await world()
		await setTrendSetting(h.store, 'trendable_by_default', true)
		const [en, ja] = await trendStatuses(h.store, [
			{ author: a[0]!, published: NOW - HOUR, seq: 0, favourites: 50 },
			{ author: a[1]!, published: NOW - HOUR, seq: 1, favourites: 20, language: 'ja' },
		])
		await round(h.store, NOW)
		const listed = async (headers: Record<string, string>) => {
			const response = await h.request('/api/v1/trends/statuses', { headers })
			return { ids: ids(await response.json()), vary: response.headers.get('vary') }
		}
		expect(await listed({})).toEqual({ ids: [en, ja], vary: 'Authorization, Accept-Language' })
		expect((await listed({ 'accept-language': 'ja-JP;q=0.9, xx, fr;q=0.1' })).ids).toEqual([ja, en])
		expect((await listed({ 'accept-language': 'fr, ja;q=0.5' })).ids).toEqual([en, ja])
		// q-values outside [0, 1] or not qvalues drop their tag.
		expect((await listed({ 'accept-language': 'ja;q=1.000' })).ids).toEqual([ja, en])
		for (const header of ['ja;q=1.5', 'ja;q=-1', 'ja;q=abc', 'ja;q=0.1234', 'ja;q=0']) {
			expect((await listed({ 'accept-language': header })).ids, header).toEqual([en, ja])
		}
		expect(preferredLanguage('en;q=1.5, ja;q=0.2')).toBe('ja')
		expect(preferredLanguage(undefined)).toBe('en')
		expect((await listed({ 'accept-language': `${'x'.repeat(1100)}, ja` })).ids).toEqual([en, ja])
		await block(h.store, h.users.viewer.id, a[0]!)
		expect(ids((await getJson(h, '/api/v1/trends/statuses', h.users.viewer.token)).body)).toEqual([ja])
		expect(ids((await getJson(h, '/api/v1/trends/statuses')).body)).toEqual([en, ja])
	})

	// At saturation: 250 stored statuses (200 approved, 50 higher-scoring unreviewed), each by its own author; the
	// list is the top 200 allowed now, whatever the page size or offset, before and after the default changes.
	it('ends at 200 for every traversal when the default changes between rounds', async () => {
		const h = await apiHarness()
		const a = await authors(h.store, 250)
		const ids = await trendStatuses(
			h.store,
			a.map((author, i) => ({ author, published: NOW - 1, seq: i, favourites: 1000 - i }))
		)
		for (const author of a.slice(50)) {
			await review(h.store, 'account_trend_reviews', author, true)
		}
		await round(h.store, NOW + HOUR)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM trend_statuses')).toEqual([{ n: 250 }])
		const walk = async (limit: number, from: number) => {
			const seen: string[] = []
			for (let at: string | null = `/api/v1/trends/statuses?limit=${limit}&offset=${from}`; at !== null;) {
				const page: Awaited<ReturnType<typeof answer<{ id: string }[]>>> = await answer(h, at)
				seen.push(...ids_(page.body))
				at = page.next
			}
			return seen
		}
		const ids_ = (body: { id: string }[]) => body.map((s) => s.id)
		expect(await walk(20, 0)).toEqual(ids.slice(50))
		await setTrendSetting(h.store, 'trendable_by_default', true)
		const all = await walk(20, 0)
		expect(all).toEqual(ids.slice(0, 200))
		expect(await walk(7, 3)).toEqual(all.slice(3))
		expect(await walk(13, 0)).toEqual(all)
		expect(ids_((await answer<{ id: string }[]>(h, '/api/v1/trends/statuses?limit=7&offset=199')).body)).toEqual([
			all[199],
		])
	}, 120_000)

	// RES-3: 60 statuses of about 1 MB; pages of 20 are cut at 8 MiB and continue after their last status, a cut page
	// near the end reading fewer than 20; every status is reached once, in order.
	it('reaches every status once by following next, across cut pages', async () => {
		const h = await apiHarness()
		const a = await authors(h.store, 60)
		await setTrendSetting(h.store, 'trendable_by_default', true)
		const expected: string[] = []
		for (const [i, author] of a.entries()) {
			const id = await bigStatus(h, author, NOW - HOUR - i)
			await sql(h.store, "UPDATE statuses SET language = 'en', favourites_count = ? WHERE id = ?", 1000 - i, id)
			expected.push(id)
		}
		await round(h.store, NOW)
		const seen: string[] = []
		const sizes: number[] = []
		for (let at: string | null = '/api/v1/trends/statuses'; at !== null;) {
			const page: Awaited<ReturnType<typeof answer<{ id: string }[]>>> = await answer(h, at)
			expect(page.status).toBe(200)
			seen.push(...ids(page.body))
			sizes.push(page.body.length)
			at = page.next
			expect(sizes.length).toBeLessThan(20)
		}
		expect(seen).toEqual(expected)
		expect(Math.max(...sizes)).toBeLessThan(20)
	}, 300_000)
})

describe('links and the admin lists', () => {
	it('answers no link trends (MD-5), checking a token sent', async () => {
		const h = await apiHarness()
		expect(await getJson(h, '/api/v1/trends/links')).toEqual({ status: 200, body: [] })
		expect((await h.request('/api/v1/trends/links', bearer('nope'))).status).toBe(401)
	})

	it('/api/v1/timelines/link finds no trending link, for anyone a token sent lets through', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		const route = '/api/v1/timelines/link?url=https%3A%2F%2Fnews.example%2Fa'
		const recordNotFound = { status: 404, body: { error: 'Record not found' } }
		expect(await getJson(h, route)).toEqual(recordNotFound)
		expect(await getJson(h, route, await scopedToken(h, 'read:statuses'))).toEqual(recordNotFound)
		// An app token reads as anonymous (authorize_if_got_token!).
		expect(await getJson(h, route, await appToken(h))).toEqual(recordNotFound)
		expect((await h.request(route, bearer('nope'))).status).toBe(401)
		expect(await getJson(h, route, await scopedToken(h, 'write'))).toEqual({
			status: 403,
			body: { error: 'This action is outside the authorized scopes' },
		})
	})

	it('answers the OAuth admin’s trends lists with the public ones, and refuses its reviews', async () => {
		const h: ApiHarness = await apiHarness()
		await seedAccount(h.store, { username: 'owner', email: 'owner@example.com' })
		await setSetting(h.store, 'admin_email', 'owner@example.com')
		const scope = 'read admin:read admin:write'
		const token = (await login(h, { app: await registerApp(h, { scopes: scope }), scope, email: 'owner@example.com' }))
			.token
		await listedTags(h.store, 2)
		await setTrendSetting(h.store, 'trendable_by_default', true)
		expect(await getJson(h, '/api/v1/admin/trends/tags', token)).toEqual(await getJson(h, '/api/v1/trends/tags', token))
		expect(names((await getJson(h, '/api/v1/admin/trends/tags', token)).body)).toEqual(['t000', 't001'])
		expect(await getJson(h, '/api/v1/admin/trends/statuses', token)).toEqual({ status: 200, body: [] })
		expect(await getJson(h, '/api/v1/admin/trends/links', token)).toEqual({ status: 200, body: [] })
		for (const path of ['/api/v1/admin/trends/tags/1/approve', '/api/v1/admin/trends/statuses/1/reject']) {
			expect((await h.request(path, bearer(token, { method: 'POST' }))).status).toBe(403)
		}
	})
})
