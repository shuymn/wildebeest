import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { migratedStore } from './helpers'
import { type SqlRow, observedSql } from './read-helpers'
import {
	AT,
	authors,
	HOUR,
	round,
	setTrendSetting,
	TODAY,
	type TrendStatus,
	trendStatuses,
	trendTags,
	uses,
} from './trend-helpers'
import { rowHeapBytes } from '../src/db/sql'
import { readOperation } from '../src/domain/operation'
import {
	candidateTags,
	TREND_ROW_CAPS,
	TREND_TAG_GROUPS,
	TREND_STATUS_CANDIDATES,
	TREND_TAG_CANDIDATES,
	TREND_TAG_ROWS,
	TREND_WINDOW,
	trendsRound,
} from '../src/domain/trends'
import type { StoreStub } from '../src/platform/store-client'

// The round's raw windows (RES-7): each cut is crossed by one row, and the rows it returns are measured (RES-3).

const candidates = readOperation<{ now: number }, string[]>((db, { now }) => candidateTags(db, now).map((c) => c.key))

// A round run inside the Store over a SqlStorage that hands every statement's rows to `seen`.
async function observedRound(store: StoreStub, seen: (rows: readonly SqlRow[], query: string) => void, now = AT) {
	return runInDurableObject(store, (_instance, state) => trendsRound.run(observedSql(state.storage.sql, seen), { now }))
}

const CANDIDATES = /WITH w AS MATERIALIZED/

// `count` statuses with no hashtag, newer than everything else (published from today 06:00).
function filler(by: string, count: number, tags: (i: number) => readonly string[] = () => []): TrendStatus[] {
	return Array.from({ length: count }, (_, i) => ({
		author: by,
		published: TODAY + 6 * HOUR + Math.floor(i / 1000),
		seq: (i % 1000) + 1,
		tags: tags(i),
	}))
}

describe('the round’s windows (RES-7)', () => {
	it.each([
		[TREND_WINDOW - 5, true],
		[TREND_WINDOW - 4, false],
	])(
		'counts the 4,000th newest public original and not the 4,001st (%i newer)',
		async (newer, counted) => {
			const store = await migratedStore()
			const a = await authors(store, 6)
			await setTrendSetting(store, 'trendable_by_default', true)
			await trendStatuses(store, [...uses(a.slice(0, 5), ['tag'], TODAY + HOUR), ...filler(a[5]!, newer)])
			await round(store)
			expect((await trendTags(store)).map((t) => t.name)).toEqual(counted ? ['tag'] : [])
		},
		60_000
	)

	it('reads the 100th hashtag of a status by name and not the 101st', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await setTrendSetting(store, 'trendable_by_default', true)
		const names = Array.from({ length: 101 }, (_, i) => `a${String(i).padStart(3, '0')}`)
		await trendStatuses(store, uses(a, names, TODAY + HOUR))
		await round(store)
		const stored = (await trendTags(store)).map((t) => t.name)
		expect(stored).toContain('a099')
		expect(stored).not.toContain('a100')
	})

	// The raw rows are cut at 8,000 in window order (newest first): 7,995 or 7,996 filler rows come before the five
	// uses, so the fifth is the 8,000th row or the 8,001st.
	it.each([
		[TREND_TAG_ROWS - 5, true],
		[TREND_TAG_ROWS - 4, false],
	])(
		'reads the 8,000th raw hashtag row and not the 8,001st (%i before)',
		async (before, counted) => {
			const store = await migratedStore()
			const a = await authors(store, 6)
			await setTrendSetting(store, 'trendable_by_default', true)
			const full = Math.floor(before / 100)
			const rest = before - full * 100
			await trendStatuses(store, [
				...uses(a.slice(0, 5), ['cut'], TODAY + HOUR),
				...filler(a[5]!, full + 1, (i) =>
					Array.from({ length: i < full ? 100 : rest }, (_, j) => `f${String(i * 100 + j).padStart(5, '0')}`)
				),
			])
			await round(store)
			expect((await trendTags(store)).some((t) => t.name === 'cut')).toBe(counted)
		},
		60_000
	)

	// An imported status with 10,000 rejected rows takes 100 raw places: with it newest, 7,895 filler rows and the
	// five uses make 8,000.
	it('lets one imported status crowd at most 100 raw places', async () => {
		const store = await migratedStore()
		const a = await authors(store, 6)
		await setTrendSetting(store, 'trendable_by_default', true)
		const [big] = await trendStatuses(store, [{ author: a[5]!, published: TODAY + 7 * HOUR }])
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
				INSERT INTO status_tags (status_id, name, public) SELECT ?1, 'Foo' || i, 1 FROM n`,
				big!
			)
		})
		await trendStatuses(store, [
			...uses(a.slice(0, 5), ['cut'], TODAY + HOUR),
			...filler(a[5]!, 79, (i) =>
				Array.from({ length: i < 78 ? 100 : 95 }, (_, j) => `f${String(i * 100 + j).padStart(5, '0')}`)
			),
		])
		await round(store)
		expect((await trendTags(store)).some((t) => t.name === 'cut')).toBe(true)
	}, 60_000)

	it('scores the 400 hashtags with the most accounts today and not a 401st', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		const names = Array.from({ length: TREND_TAG_CANDIDATES + 1 }, (_, i) => `t${String(i).padStart(3, '0')}`)
		const statuses = a.flatMap((author, i) =>
			Array.from({ length: 5 }, (_, j) => ({
				author,
				published: TODAY + HOUR + i,
				seq: j,
				tags: names.slice(j * 100, j * 100 + 100),
			}))
		)
		await trendStatuses(store, statuses)
		const returned = await runInDurableObject(store, (_instance, state) =>
			candidates.run(state.storage.sql, { now: AT })
		)
		const hex = (name: string) =>
			[...new TextEncoder().encode(name)]
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')
				.toUpperCase()
		expect(returned).toEqual(names.slice(0, TREND_TAG_CANDIDATES).map(hex))
	}, 60_000)

	// M5: 400 keys that are not well-formed UTF-8, each with 6 accounts, do not starve a valid key with 5. M4: a name not
	// in its own normalized form (é, which normalizeTag folds to e) never trends; one that is (カフェ) does.
	it('keeps unrepresentable keys out of the candidates', async () => {
		const store = await migratedStore()
		const a = await authors(store, 6)
		await setTrendSetting(store, 'trendable_by_default', true)
		const ids = await trendStatuses(store, [
			...uses(a.slice(0, 5), ['ok', '\u00e9', 'e\u0301', 'カフェ'], TODAY + HOUR),
			// 4 statuses of each of 6 authors, each with 100 of the 400 malformed keys (a status's first 100 are read).
			...a.flatMap((author, i) => [0, 1, 2, 3].map((j) => ({ author, published: TODAY + 2 * HOUR + i, seq: 1 + j }))),
		])
		await runInDurableObject(store, (_instance, state) => {
			for (const [k, id] of ids.slice(5).entries()) {
				state.storage.sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
					INSERT INTO status_tags (status_id, name, public)
					SELECT ?1, CAST(x'C0' || printf('%03d', ?2 * 100 + i) AS TEXT), 1 FROM n`,
					id,
					k % 4
				)
			}
		})
		// The statement returns every group of 5 or more: the 400 malformed ones, then the four of five accounts.
		let groups = 0
		await runInDurableObject(store, (_instance, state) => {
			const watched = observedSql(state.storage.sql, (rows, query) => {
				if (CANDIDATES.test(query)) {
					groups = rows.length
				}
			})
			candidates.run(watched, { now: AT })
		})
		expect(groups).toBe(404)
		const returned = await runInDurableObject(store, (_instance, state) =>
			candidates.run(state.storage.sql, { now: AT })
		)
		expect(returned).toHaveLength(2)
		await round(store)
		expect((await trendTags(store)).map((t) => t.name).sort()).toEqual(['ok', 'カフェ'].sort())
	}, 60_000)

	it('scores the 400 statuses with the most boosts and favourites and not a 401st', async () => {
		const store = await migratedStore()
		const a = await authors(store, TREND_STATUS_CANDIDATES + 1)
		await setTrendSetting(store, 'trendable_by_default', true)
		const ids = await trendStatuses(
			store,
			a.map((author, i) => ({ author, published: AT - HOUR, seq: i, favourites: 1000 - i }))
		)
		let window: string[] = []
		await observedRound(store, (rows, query) => {
			if (/LIMIT 400\) c/.test(query)) {
				window = rows.map((r) => r.id as string)
			}
		})
		expect(window).toHaveLength(TREND_STATUS_CANDIDATES)
		expect(window).not.toContain(ids.at(-1))
	}, 60_000)
})

describe('what the round holds (RES-3)', () => {
	// T5: 4,000 statuses with 2 distinct one-use names of 1,024 bytes each are 8,000 groups, none of 5 accounts, so the
	// statement returns none of them (it returns at most TREND_TAG_GROUPS).
	it('returns no group of one-use names when every name is distinct and maximal', async () => {
		const store = await migratedStore()
		const [a] = await authors(store, 1)
		const name = (i: number) => String.fromCodePoint(0x20000 + i) + '\u{20001}'.repeat(255)
		expect(new TextEncoder().encode(name(0)).length).toBe(1024)
		await trendStatuses(
			store,
			Array.from({ length: TREND_WINDOW }, (_, i) => ({
				author: a!,
				published: TODAY + HOUR + Math.floor(i / 1000),
				seq: i % 1000,
				tags: [name(2 * i), name(2 * i + 1)],
			}))
		)
		let returned = -1
		await observedRound(store, (rows, query) => {
			if (CANDIDATES.test(query)) {
				returned = rows.length
			}
		})
		expect(returned).toBe(0)
	}, 120_000)

	// The heaviest rows each read can return: TREND_TAG_GROUPS (1,600) hashtag groups and 250 stored hashtags of
	// 1,024-byte names, 250 stored statuses and 400 + 250 status candidates. Their measured heap is within the cap; a
	// cap one byte below stops the round.
	it('meters the round’s rows within TREND_ROW_CAPS.round', async () => {
		const store = await migratedStore()
		const a = await authors(store, 650)
		await setTrendSetting(store, 'trendable_by_default', true)
		const name = (i: number) => String.fromCodePoint(0x20000 + i) + '\u{20001}'.repeat(255)
		// TREND_TAG_GROUPS (1,600) groups, each used by 5 accounts today: every one of the 8,000 raw rows.
		const tags = Array.from({ length: TREND_TAG_GROUPS }, (_, i) => name(i))
		await trendStatuses(
			store,
			a.slice(0, 5).flatMap((author, i) =>
				Array.from({ length: TREND_TAG_GROUPS / 100 }, (_, j) => ({
					author,
					published: TODAY + HOUR + i,
					seq: j,
					tags: tags.slice(j * 100, j * 100 + 100),
				}))
			)
		)
		// 250 stored hashtags of their own, within their cooldown.
		await runInDurableObject(store, (_instance, state) => {
			for (let i = 0; i < 250; i++) {
				state.storage.sql.exec(
					'INSERT INTO trend_tags (name, score, max_score, max_score_at) VALUES (?, 0.5, 0.5, ?)',
					name(2000 + i),
					new Date(AT - HOUR).toISOString()
				)
			}
		})
		// 650 eligible statuses with 10 favourites, one per author, 250 of them stored.
		const ids = await trendStatuses(
			store,
			a.map((author, i) => ({ author, published: AT - HOUR, seq: 100 + i, favourites: 10 }))
		)
		await runInDurableObject(store, (_instance, state) => {
			for (const [i, id] of ids.slice(0, 250).entries()) {
				state.storage.sql.exec('INSERT INTO trend_statuses (status_id, account_id, score) VALUES (?, ?, 1)', id, a[i]!)
			}
		})
		// The cap one byte below the fill stops the round (its transaction rolls back), then the round at the cap runs.
		const cap = TREND_ROW_CAPS.round
		TREND_ROW_CAPS.round = cap - 1
		const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			await expect(round(store)).rejects.toThrow(/passed/)
		} finally {
			TREND_ROW_CAPS.round = cap
			warn.mockRestore()
		}
		let heap = 0
		await observedRound(store, (rows, query) => {
			if (/^\s*(WITH|SELECT)/.test(query) && !/instance_settings/.test(query)) {
				heap += rows.reduce((sum, row) => sum + rowHeapBytes(row), 0)
			}
		})
		console.log(JSON.stringify({ event: 'trends-round-heap', heap, cap }))
		// Every row at its column's maximum: the fill is the cap.
		expect(heap).toBe(cap)
	}, 120_000)
})
