import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { completeSetup, migratedStore } from './helpers'
import { copyConfig, dumpViaRpc, importViaRpc, setAccess } from './ops-helpers'
import { AT, authors, review, trendStatuses } from './trend-helpers'
import type { StoreStub } from '../src/platform/store-client'

// Trends in dumps (docs/dump-format.md "Stored bounds"): the five tables round-trip at their trend caps, and an import
// is held to the CHECKs and triggers of 0057_trends (refused with their names).

const PEAK = '2026-10-19T01:02:03.004Z'
const TABLES = ['trend_tags', 'trend_statuses', 'tag_trend_reviews', 'status_trend_reviews', 'account_trend_reviews']

async function rows(store: StoreStub) {
	return Promise.all(TABLES.map((table) => sql(store, `SELECT * FROM ${table} ORDER BY 1`)))
}

// 250 trend tags and 250 trend statuses (84 authors, 3 each but the last), and a review of each kind.
async function source() {
	const store = await migratedStore()
	await setAccess(store)
	await completeSetup(store)
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 249)
		INSERT INTO trend_tags (name, score, max_score, max_score_at) SELECT printf('t%03d', i), 2, 3, ?1 FROM n`,
		PEAK
	)
	const a = await authors(store, 84)
	const ids = await trendStatuses(
		store,
		a.flatMap((author, i) =>
			Array.from({ length: i === 83 ? 1 : 3 }, (_, j) => ({ author, published: AT - 1000 * i, seq: j, favourites: 9 }))
		)
	)
	await sql(store, 'INSERT INTO trend_statuses (status_id, account_id, score) SELECT id, account_id, 0.5 FROM statuses')
	await review(store, 'tag_trend_reviews', 't000', true)
	await review(store, 'status_trend_reviews', ids[0]!, false)
	await review(store, 'account_trend_reviews', a[0]!, true)
	return store
}

describe('trends in dumps', () => {
	it('round-trip at the trend caps', async () => {
		const store = await source()
		const { text } = await dumpViaRpc(store)
		const target = await migratedStore()
		await copyConfig(store, target)
		expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] })
		expect(await rows(target)).toEqual(await rows(store))
		expect((await rows(target)).map((table) => table.length)).toEqual([250, 250, 1, 1, 1])
	}, 120_000)

	it('are refused on import past their bounds, with the constraint’s name', async () => {
		const store = await source()
		const { text } = await dumpViaRpc(store)
		const cases: [string, string, RegExp][] = [
			["'t000'", "'T000'", /trend_tag_name|tag_trend_review_name/],
			["'t001'", "'t 01'", /trend_tag_name/],
			[`'${PEAK}'`, "'2026-10-19T24:02:03.004Z'", /trend_tag_max_score_at_iso/],
		]
		for (const [from, to, refused] of cases) {
			const changed = text.replace(from, to)
			expect(changed, from).not.toBe(text)
			const target = await migratedStore()
			await copyConfig(store, target)
			await expect(importViaRpc(target, changed), from).rejects.toThrow(refused)
		}
	}, 180_000)
})
