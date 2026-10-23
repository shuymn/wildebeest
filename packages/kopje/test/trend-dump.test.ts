import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { completeSetup, migratedStore } from './helpers'
import { copyConfig, dumpViaRpc, importViaRpc, setAccess } from './ops-helpers'
import { AT, authors, linkCopies, linkPosts, review, reviewLink, storedLink, trendStatuses } from './trend-helpers'
import { readOperation } from '../src/domain/operation'
import { linkHistory, TREND_LANGUAGES_JSON, trendCopySql } from '../src/domain/trends'
import type { StoreStub } from '../src/platform/store-client'
import { MAX_TREND_REVIEWS } from '../src/platform/stored-bounds'

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

	it('round-trip each review table at 10,000', async () => {
		const store = await source()
		await sql(store, 'DELETE FROM tag_trend_reviews')
		await sql(store, 'DELETE FROM status_trend_reviews')
		await sql(store, 'DELETE FROM account_trend_reviews')
		await authors(store, MAX_TREND_REVIEWS - 84, 600_000_000_000_000_000n)
		await sql(
			store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(117000000000000000 + i AS TEXT), 'https://o.example/' || i, '500000000000000000', 'public', ?2 FROM n`,
			MAX_TREND_REVIEWS - 250,
			PEAK
		)
		await sql(
			store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO tag_trend_reviews (name, trendable, reviewed_at) SELECT 'r' || i, i % 2, ?2 FROM n`,
			MAX_TREND_REVIEWS,
			PEAK
		)
		await sql(
			store,
			'INSERT INTO status_trend_reviews (status_id, trendable, reviewed_at) SELECT id, 1, ?1 FROM statuses',
			PEAK
		)
		await sql(
			store,
			'INSERT INTO account_trend_reviews (account_id, trendable, reviewed_at) SELECT id, 0, ?1 FROM accounts WHERE domain IS NOT NULL',
			PEAK
		)
		expect((await rows(store)).slice(2).map((table) => table.length)).toEqual([
			MAX_TREND_REVIEWS,
			MAX_TREND_REVIEWS,
			MAX_TREND_REVIEWS,
		])
		const { text } = await dumpViaRpc(store)
		const target = await migratedStore()
		await copyConfig(store, target)
		expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] })
		expect(await rows(target)).toEqual(await rows(store))
	}, 300_000)

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

// Link trends in dumps (0071_link_trends, docs/dump-format.md "Stored bounds"): the three tables and the card's new
// columns round-trip; the membership invariant judges each imported card against its parent's visibility (parents
// before children); a card on a boost (reblog_of_id linked after the rows) imports and the live checks keep it out.
describe('link trends in dumps', () => {
	const LINK = 'https://news.example/a'

	// A public post with a public copy of LINK, an unlisted one with its copy (public 0), a boost of the first with a
	// public copy (as an import can hold one), LINK stored and reviewed, and a publisher review.
	async function linkSource() {
		const store = await migratedStore()
		await setAccess(store)
		await completeSetup(store)
		const a = await authors(store, 3)
		const [original] = await linkPosts(store, a.slice(0, 1), LINK, AT)
		const [unlisted] = await linkPosts(store, a.slice(1, 2), LINK, AT + 1, { status: { visibility: 'unlisted' } })
		const [boost] = await trendStatuses(store, [{ author: a[2]!, published: AT + 2, reblogOf: original! }])
		await linkCopies(store, [{ status: boost!, link: LINK }])
		await storedLink(store, LINK, 2, 3, AT)
		await reviewLink(store, 'link', LINK, true)
		await reviewLink(store, 'publisher', 'news.example', false)
		return { store, original: original!, unlisted: unlisted!, boost: boost! }
	}

	const linkRows = (store: StoreStub) =>
		Promise.all([
			sql(store, 'SELECT * FROM trend_links'),
			sql(store, 'SELECT * FROM link_trend_reviews'),
			sql(store, 'SELECT * FROM link_provider_reviews'),
			sql(store, 'SELECT status_id, link_type, final_url, public FROM status_cards ORDER BY status_id'),
		])

	it('round-trip, a card on a boost kept out of every count by the live checks', async () => {
		const { store, original, unlisted, boost } = await linkSource()
		const { text } = await dumpViaRpc(store)
		const target = await migratedStore()
		await copyConfig(store, target)
		expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] })
		expect(await linkRows(target)).toEqual(await linkRows(store))
		expect((await linkRows(target))[3]).toEqual([
			{ status_id: original, link_type: 1, final_url: LINK, public: 1 },
			{ status_id: unlisted, link_type: 1, final_url: LINK, public: 0 },
			{ status_id: boost, link_type: 1, final_url: LINK, public: 1 },
		])
		// A dump holds no card images, so the restored copies are imageless: rows under their image ids stand in for the
		// source's.
		await sql(
			target,
			`INSERT INTO card_images (id, source_url, enqueued_at, token, width, height, stored_at)
			SELECT image_id, image_url, 1, 't' || printf('%042d', CAST(substr(image_id, 2) AS INTEGER)), 640, 360, 1
			FROM status_cards WHERE image_id IS NOT NULL`
		)
		const shown = readOperation<void, { copy: string | null; history: string }>((db) => ({
			copy: db.first<{ id: string | null }>(`SELECT ${trendCopySql('?1', '?2')} AS id`, LINK, TREND_LANGUAGES_JSON)!.id,
			history: linkHistory(db, LINK, AT)[0]!.uses,
		}))
		const read = (s: StoreStub) => runInDurableObject(s, (_instance, state) => shown.run(state.storage.sql, undefined))
		// The boost's copy is the newest public one, but its status is no original: the original's is shown, and the
		// boost counts once, as a boost of it.
		expect(await read(target)).toEqual({ copy: original, history: '2' })
		await sql(target, 'DELETE FROM status_cards WHERE status_id = ?', original)
		expect(await read(target)).toEqual({ copy: null, history: '0' })
	}, 120_000)

	it('are refused on import where a public card is under a status that is not public, its twin imported', async () => {
		const { store, original, unlisted } = await linkSource()
		const { text } = await dumpViaRpc(store)
		const statusLine = (id: string) =>
			text.split('\n').find((l) => l.startsWith('INSERT INTO "statuses"') && l.includes(`'${id}'`))!
		const cardLine = (id: string) =>
			text.split('\n').find((l) => l.startsWith('INSERT INTO "status_cards"') && l.includes(`'${id}'`))!
		const cases: [string, string][] = [
			// The public card's parent made unlisted, then private.
			[statusLine(original), statusLine(original).replace("'public'", "'unlisted'")],
			[statusLine(original), statusLine(original).replace("'public'", "'private'")],
			// The unlisted parent's card made public.
			[cardLine(unlisted), cardLine(unlisted).replace(/,0\);$/, ',1);')],
			// A trend link past its domain bound.
			["'news.example','en',2.0", "'News.example','en',2.0"],
		]
		for (const [from, to] of cases) {
			expect(to, from.slice(0, 60)).not.toBe(from)
			const changed = text.replace(from, to)
			expect(changed).not.toBe(text)
			const target = await migratedStore()
			await copyConfig(store, target)
			await expect(importViaRpc(target, changed), to.slice(0, 80)).rejects.toThrow(
				/status_cards: a value past its stored bound|trend_links: a value past its stored bound/
			)
		}
		const twin = await migratedStore()
		await copyConfig(store, twin)
		expect((await importViaRpc(twin, text)).report).toMatchObject({ ok: true })
	}, 180_000)
})
