import { env } from 'cloudflare:workers'

import { describe, expect, it, vi } from 'vitest'

import { sql } from './api-helpers'
import { BUILD, migratedStore } from './helpers'
import {
	AT,
	authors,
	DAY,
	HOUR,
	idAt,
	review,
	round,
	setTrendSetting,
	TODAY,
	trendRows,
	trendStatuses,
	trendTags,
	uses,
	YESTERDAY,
} from './trend-helpers'
import { handleScheduled } from '../src/jobs/scheduled'
import type { StoreStub } from '../src/platform/store-client'

// The cron's round (domain/trends.ts trendsRound): Mastodon's scores and decay (Trends::Tags, Trends::Statuses), the
// publication-day counts, the pools and caps (RES-4), the raw windows (RES-7) and imported rows.

const iso = (ms: number) => new Date(ms).toISOString()

// A tag row as an import writes it.
async function storedTag(store: StoreStub, name: string, score: number, max: number, at: number | string) {
	await sql(
		store,
		'INSERT INTO trend_tags (name, score, max_score, max_score_at) VALUES (?, ?, ?, ?)',
		name,
		score,
		max,
		typeof at === 'string' ? at : iso(at)
	)
}

describe('hashtag scores (Trends::Tags#calculate_scores)', () => {
	it('scores 5 accounts today and not 4, nor fewer than yesterday', async () => {
		const store = await migratedStore()
		const a = await authors(store, 12)
		await trendStatuses(store, [
			...uses(a.slice(0, 4), ['four'], TODAY + HOUR),
			...uses(a.slice(0, 5), ['five'], TODAY + HOUR, 1),
			...uses(a.slice(0, 5), ['fewer'], TODAY + HOUR, 2),
			...uses(a.slice(0, 6), ['fewer'], YESTERDAY + HOUR, 3),
		])
		await round(store)
		expect(await trendTags(store)).toEqual([{ name: 'five', score: 16, max_score: 16, max_score_at: iso(AT) }])
	})

	// A HAVING on today's count leaking into yesterday's would make each of these 0.
	it.each([
		[1, 16],
		[2, 4.5],
		[3, 4 / 3],
		[4, 0.25],
	])('takes %i accounts yesterday as expected: (5 - e)² / e = %d', async (yesterday, score) => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await trendStatuses(store, [
			...uses(a, ['tag'], TODAY + HOUR),
			...uses(a.slice(0, yesterday), ['tag'], YESTERDAY + HOUR, 1),
		])
		await round(store)
		expect(await trendTags(store)).toEqual([{ name: 'tag', score, max_score: score, max_score_at: iso(AT) }])
	})

	it('decays a peak with a 4 hour half-life, and lists at 1 but not 0.999', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await trendStatuses(store, uses(a, ['tag'], TODAY + HOUR))
		await round(store)
		await round(store, AT + 4 * HOUR)
		expect(await trendTags(store)).toEqual([{ name: 'tag', score: 8, max_score: 16, max_score_at: iso(AT) }])
		await storedTag(store, 'one', 2, 2, AT - 4 * HOUR)
		await storedTag(store, 'under', 1.998, 1.998, AT - 4 * HOUR)
		await round(store)
		const rows = await sql<{ name: string; score: number }>(
			store,
			'SELECT name, score FROM trend_tags INDEXED BY trend_tags_listed WHERE score >= 1 ORDER BY name'
		)
		expect(rows.map((r) => r.name)).toEqual(['one', 'tag'])
		expect(rows[0]!.score).toBe(1)
		// Below 1 a row stays while its peak is within the cooldown, unlisted.
		expect((await trendTags(store)).find((t) => t.name === 'under')?.score).toBeCloseTo(0.999, 10)
	})

	it('keeps a peak for 2 days and resets it after; a re-use below the old peak stays unlisted', async () => {
		const store = await migratedStore()
		await storedTag(store, 'kept', 0.1, 100, AT - 2 * DAY)
		await storedTag(store, 'reset', 0.1, 100, AT - 2 * DAY - 1)
		await storedTag(store, 'reused', 1, 100, AT - 30 * HOUR)
		const a = await authors(store, 5)
		await trendStatuses(store, uses(a, ['reused'], TODAY + HOUR))
		await round(store)
		const rows = await trendTags(store)
		expect(rows.map((r) => r.name)).toEqual(['kept', 'reused'])
		expect(rows[0]).toMatchObject({ max_score: 100, max_score_at: iso(AT - 2 * DAY) })
		expect(rows[0]!.score).toBeCloseTo(100 * 0.5 ** 12, 12)
		expect(rows[1]).toMatchObject({ max_score: 100, max_score_at: iso(AT - 30 * HOUR) })
		expect(rows[1]!.score).toBeCloseTo(100 * 0.5 ** 7.5, 12)
		expect(rows[1]!.score).toBeLessThan(1)
	})
})

describe('publication days', () => {
	it('counts 23:59:59.999 yesterday and 00:00:00.000 today', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await trendStatuses(store, [
			// Five today, one of them at midnight; one yesterday at its last millisecond.
			...uses(a.slice(0, 4), ['tag'], TODAY + HOUR),
			{ author: a[4]!, published: TODAY, tags: ['tag'] },
			{ author: a[0]!, published: TODAY - 1, seq: 1, tags: ['tag'] },
		])
		await round(store)
		expect(await trendTags(store)).toEqual([{ name: 'tag', score: 16, max_score: 16, max_score_at: iso(AT) }])
	})

	it('classifies by published_at, not by id, and leaves out what is published after now', async () => {
		const store = await migratedStore()
		const a = await authors(store, 12)
		await trendStatuses(store, [
			...uses(a.slice(0, 5), ['tag'], TODAY + HOUR),
			// A cutover's preserved id inside today's range, published yesterday: counted yesterday.
			{ author: a[5]!, published: YESTERDAY + HOUR, id: idAt(TODAY + 2 * HOUR, 9), tags: ['tag'] },
			{ author: a[6]!, published: YESTERDAY + HOUR, id: idAt(TODAY + 2 * HOUR, 10), tags: ['tag'] },
			// Published today with an id before yesterday 00:00: not in the window (the approximation of MD-5).
			{ author: a[7]!, published: TODAY + HOUR, id: idAt(YESTERDAY - 1, 0), tags: ['tag'] },
			// Remote statuses with receipt-time ids published later today, tomorrow, and exactly now (T1).
			{ author: a[8]!, published: AT + HOUR, id: idAt(AT - 1, 1), tags: ['tag'] },
			{ author: a[9]!, published: TODAY + DAY + HOUR, id: idAt(AT - 1, 2), tags: ['tag'] },
			{ author: a[10]!, published: AT, id: idAt(AT - 1, 3), tags: ['tag'] },
		])
		await round(store)
		// Today: 5 and the one published exactly now, 6; yesterday 2: (6 - 2)² / 2 = 8.
		expect(await trendTags(store)).toEqual([{ name: 'tag', score: 8, max_score: 8, max_score_at: iso(AT) }])
	})
})

describe('status scores (Trends::Statuses#calculate_scores)', () => {
	it('scores 5 boosts and favourites and not 4, halved every hour, kept at 0.3 and not below', async () => {
		const store = await migratedStore()
		const [a, b, c, d, e] = await authors(store, 5)
		await setTrendSetting(store, 'trendable_by_default', true)
		// 16 · 0.5^(age / 1 h) is 0.3 at log2(16 / 0.3) hours; a millisecond on either side.
		const edge = Math.log2(16 / 0.3) * HOUR
		const [four, five, older, above] = await trendStatuses(store, [
			{ author: a!, published: AT, seq: 1, favourites: 4 },
			{ author: b!, published: AT, seq: 2, reblogs: 2, favourites: 3 },
			{ author: c!, published: AT - HOUR, favourites: 5 },
			{ author: d!, published: AT - Math.floor(edge), favourites: 5 },
			{ author: e!, published: AT - Math.ceil(edge) - 1, favourites: 5 },
		])
		await round(store)
		const rows = await trendRows(store)
		expect(rows.map((r) => r.status_id)).toEqual([five, older, above])
		expect(rows.map((r) => r.score)).toEqual([16, 8, expect.any(Number)])
		expect(rows[2]!.score).toBeGreaterThanOrEqual(0.3)
		expect(rows.some((r) => r.status_id === four)).toBe(false)
	})

	it('drops a stored row once its status is no longer eligible', async () => {
		const store = await migratedStore()
		const [a] = await authors(store, 1)
		await setTrendSetting(store, 'trendable_by_default', true)
		const [id] = await trendStatuses(store, [{ author: a!, published: AT - HOUR, favourites: 9 }])
		await round(store)
		expect((await trendRows(store)).map((r) => r.status_id)).toEqual([id])
		await sql(store, "UPDATE statuses SET spoiler_text = 'cw' WHERE id = ?", id!)
		await round(store)
		expect(await trendRows(store)).toEqual([])
	})
})

describe('retention (RES-4)', () => {
	it('keeps 200 approved listed tags when 600 higher-scoring unreviewed ones come, 50 of them for review', async () => {
		const store = await migratedStore()
		for (let i = 0; i < 200; i++) {
			const name = `ok${String(i).padStart(3, '0')}`
			await storedTag(store, name, 2, 2, AT)
			await review(store, 'tag_trend_reviews', name, true)
		}
		const a = await authors(store, 6)
		const spam = Array.from({ length: 600 }, (_, i) => `spam${String(i).padStart(3, '0')}`)
		const statuses = a.flatMap((author, i) =>
			Array.from({ length: 6 }, (_, j) => ({
				author,
				published: TODAY + HOUR + i,
				seq: j,
				tags: spam.slice(j * 100, j * 100 + 100),
			}))
		)
		await trendStatuses(store, statuses)
		await round(store)
		const rows = await trendTags(store)
		expect(rows.filter((r) => r.name.startsWith('ok'))).toHaveLength(200)
		expect(rows.filter((r) => r.name.startsWith('ok')).every((r) => r.score === 2)).toBe(true)
		// The 400 candidates are the first by key (all have 6 accounts); the review pool holds 50 of them at 25.
		const pool = rows.filter((r) => r.name.startsWith('spam'))
		expect(pool.map((r) => r.name)).toEqual(spam.slice(0, 50))
		expect(pool.every((r) => r.score === 25)).toBe(true)
	})

	it('stores 3 statuses of one author, and other authors keep their places', async () => {
		const store = await migratedStore()
		const [prolific, ...others] = await authors(store, 11)
		await setTrendSetting(store, 'trendable_by_default', true)
		const ids = await trendStatuses(store, [
			...Array.from({ length: 30 }, (_, i) => ({ author: prolific!, published: AT - HOUR, seq: i, favourites: 100 })),
			...others.map((author, i) => ({ author, published: AT - HOUR, seq: 100 + i, favourites: 10 })),
		])
		await round(store)
		const rows = await trendRows(store)
		expect(rows.filter((r) => r.account_id === prolific)).toHaveLength(3)
		expect(rows.filter((r) => r.account_id !== prolific).map((r) => r.status_id)).toEqual(ids.slice(30).reverse())
	})

	it('drops the lower rows of an author whose unreviewed top row does not fit the review pool', async () => {
		const store = await migratedStore()
		const [x, ...others] = await authors(store, 51)
		const [top, lower] = await trendStatuses(store, [
			{ author: x!, published: AT - HOUR, seq: 0, favourites: 50 },
			{ author: x!, published: AT - HOUR, seq: 1, favourites: 20 },
			...others.map((author, i) => ({ author, published: AT - HOUR, seq: 10 + i, favourites: 100 })),
		])
		await review(store, 'status_trend_reviews', lower!, true)
		await round(store)
		const rows = await trendRows(store)
		expect(rows).toHaveLength(50)
		expect(rows.some((r) => r.status_id === top || r.status_id === lower)).toBe(false)
	})

	// T2: the review pool is full of 50 higher rows; the author's newer unreviewed tie cannot enter it, and its older
	// approved tie is still the author's maximum, so it is kept (and listed).
	it('keeps an approved tie at the author’s maximum when the unreviewed tie does not fit', async () => {
		const store = await migratedStore()
		const [x, ...others] = await authors(store, 51)
		const [approved, unreviewed] = await trendStatuses(store, [
			{ author: x!, published: AT - HOUR, seq: 0, favourites: 20 },
			{ author: x!, published: AT - HOUR, seq: 1, favourites: 20 },
			...others.map((author, i) => ({ author, published: AT - HOUR, seq: 10 + i, favourites: 100 })),
		])
		await review(store, 'status_trend_reviews', approved!, true)
		await round(store)
		const rows = await trendRows(store)
		expect(rows).toHaveLength(51)
		expect(rows.some((r) => r.status_id === unreviewed)).toBe(false)
		expect(rows.find((r) => r.status_id === approved)?.score).toBe(19 ** 2 * 0.5)
	})
})

describe('status retention (review round 1)', () => {
	// M2: an older approved row and three newer unreviewed ties of one author: the approved one is the witness, so it
	// stays (and two of the ties with it), whatever the id order.
	it('keeps an approved maximum when three newer unreviewed ties come', async () => {
		const store = await migratedStore()
		const [x] = await authors(store, 1)
		const [approved, ...ties] = await trendStatuses(
			store,
			[0, 1, 2, 3].map((seq) => ({ author: x!, published: AT - HOUR, seq, favourites: 20 }))
		)
		await review(store, 'status_trend_reviews', approved!, true)
		await round(store)
		const rows = (await trendRows(store)).map((r) => r.status_id)
		expect(rows).toHaveLength(3)
		expect(rows).toContain(approved)
		expect(ties.filter((id) => rows.includes(id))).toHaveLength(2)
	})

	// M3: the review pool takes unreviewed rows before rejected ones, as the hashtags' does.
	it('reviews a fresh unreviewed status before 50 higher-scoring rejected ones', async () => {
		const store = await migratedStore()
		const [fresh, ...spam] = await authors(store, 51)
		const ids = await trendStatuses(store, [
			{ author: fresh!, published: AT - HOUR, seq: 0, favourites: 6 },
			...spam.map((author, i) => ({ author, published: AT - HOUR, seq: 10 + i, favourites: 100 })),
		])
		for (const id of ids.slice(1)) {
			await review(store, 'status_trend_reviews', id, false)
		}
		await round(store)
		const rows = (await trendRows(store)).map((r) => r.status_id)
		expect(rows).toHaveLength(50)
		expect(rows).toContain(ids[0])
	})
})

describe('caps (0057_trends)', () => {
	it('updates every score of 250 stored tags whose keys stay', async () => {
		const store = await migratedStore()
		for (let i = 0; i < 250; i++) {
			const name = `t${String(i).padStart(3, '0')}`
			await storedTag(store, name, 10, 10, AT - HOUR)
			if (i < 200) {
				await review(store, 'tag_trend_reviews', name, true)
			}
		}
		await round(store)
		const rows = await trendTags(store)
		expect(rows).toHaveLength(250)
		expect(rows.every((r) => r.score === 10 * 0.5 ** 0.25)).toBe(true)
	})

	it('replaces 100 keys at 250 rows with no cap trigger firing', async () => {
		const store = await migratedStore()
		await setTrendSetting(store, 'trendable_by_default', true)
		for (let i = 0; i < 250; i++) {
			// The first 100 have peaks past the cooldown, so they go; the last 50 are rejected, for the review pool.
			const name = `old${String(i).padStart(3, '0')}`
			await storedTag(store, name, 0.5, 5, i < 100 ? AT - 3 * DAY : AT - HOUR)
			if (i >= 200) {
				await review(store, 'tag_trend_reviews', name, false)
			}
		}
		const a = await authors(store, 5)
		const fresh = Array.from({ length: 100 }, (_, i) => `new${String(i).padStart(3, '0')}`)
		await trendStatuses(store, uses(a, fresh, TODAY + HOUR))
		await round(store)
		const rows = await trendTags(store)
		expect(rows).toHaveLength(250)
		expect(rows.filter((r) => r.name.startsWith('new'))).toHaveLength(100)
		expect(rows.filter((r) => r.name.startsWith('old0')).length).toBe(0)
	})
})

describe('imported rows', () => {
	it('drops a stored name that is not well-formed UTF-8, keeping the round', async () => {
		const store = await migratedStore()
		await sql(
			store,
			"INSERT INTO trend_tags (name, score, max_score, max_score_at) VALUES (CAST(x'C0' || ?1 AS TEXT), 5, 5, ?2)",
			new Uint8Array(1023).fill(0x80).buffer,
			iso(AT)
		)
		await storedTag(store, 'kept', 5, 5, AT)
		await setTrendSetting(store, 'trendable_by_default', true)
		await round(store)
		expect((await trendTags(store)).map((r) => r.name)).toEqual(['kept'])
	})

	it('decays a peak an hour in the future from now', async () => {
		const store = await migratedStore()
		await setTrendSetting(store, 'trendable_by_default', true)
		await storedTag(store, 'ahead', 5, 5, AT + HOUR)
		await round(store)
		expect(await trendTags(store)).toEqual([{ name: 'ahead', score: 5, max_score: 5, max_score_at: iso(AT) }])
	})

	it('skips a status_tags name past the name rule or its bytes', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await trendStatuses(store, uses(a, ['Foo', 'é'.repeat(512) + 'a', 'ok'], TODAY + HOUR))
		await setTrendSetting(store, 'trendable_by_default', true)
		await round(store)
		expect((await trendTags(store)).map((r) => r.name)).toEqual(['ok'])
	})
})

describe('settings', () => {
	it('empties both tables while trends are off', async () => {
		const store = await migratedStore()
		const [a] = await authors(store, 1)
		await setTrendSetting(store, 'trendable_by_default', true)
		await trendStatuses(store, [{ author: a!, published: AT - HOUR, favourites: 9 }])
		await storedTag(store, 'kept', 5, 5, AT)
		await round(store)
		expect(await trendRows(store)).toHaveLength(1)
		await setTrendSetting(store, 'trends', false)
		expect(await round(store)).toEqual({ tags: 0, statuses: 0 })
		expect(await trendTags(store)).toEqual([])
		expect(await trendRows(store)).toEqual([])
		await setTrendSetting(store, 'trends', true)
		await round(store)
		expect(await trendRows(store)).toHaveLength(1)
	})
})

describe('the cron', () => {
	const cron = (store: StoreStub, now: number) =>
		handleScheduled({ ...env, MAINTENANCE: 'off' } as unknown as Env, {
			build: () => BUILD,
			now: () => now,
			store: () => store,
		})

	it('runs the round, and waits while the Store is in maintenance', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await trendStatuses(store, uses(a, ['tag'], TODAY + HOUR))
		await store.setMaintenance(BUILD, true)
		await cron(store, AT)
		expect(await trendTags(store)).toEqual([])
		await store.setMaintenance(BUILD, false)
		await cron(store, AT)
		expect((await trendTags(store)).map((r) => r.name)).toEqual(['tag'])
	})

	it('logs a failed round', async () => {
		const store = await migratedStore()
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const failing = new Proxy(store, {
			get: (target, key) =>
				key === 'trendsRound' ? () => Promise.reject(new Error('boom')) : (Reflect.get(target, key) as unknown),
		})
		await cron(failing, AT)
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.scheduled.trends_round_failed' }))
		error.mockRestore()
	})
})
