import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { BUILD, migratedStore, testKernel } from './helpers'
import { observedSql } from './read-helpers'
import {
	AT,
	authors,
	boosts,
	DAY,
	HOUR,
	linkCopies,
	linkPosts,
	reviewLink,
	round,
	setTrendSetting,
	storedLink,
	TODAY,
	trendLinkRows,
	trendStatuses,
	YESTERDAY,
} from './trend-helpers'
import { Db } from '../src/db/sql'
import { deleteStatusBatch, PURGE_BATCH } from '../src/domain/inbox'
import { recordCard } from '../src/domain/link-cards'
import { readOperation } from '../src/domain/operation'
import {
	LINK_HISTORY_BOOSTS,
	LINK_HISTORY_BOOSTS_PER_STATUS,
	LINK_HISTORY_ORIGINALS,
	linkCandidates,
	linkHistory,
	TREND_LANGUAGES_JSON,
	TREND_LINK_BOOSTS,
	TREND_LINK_BOOSTS_PER_STATUS,
	TREND_LINK_CANDIDATES,
	TREND_LANGUAGES,
	TREND_LINK_COPIES,
	TREND_LINK_GROUPS,
	TREND_ROW_CAPS,
	TREND_STATUS_CANDIDATES,
	TREND_TAG_GROUPS,
	TREND_WINDOW,
	trendCopySql,
	trendsRound,
} from '../src/domain/trends'
import type { StoreStub } from '../src/platform/store-client'
import {
	CARD_LANGUAGE_BYTES,
	CARD_TEXTS,
	CARD_URL_LIMIT,
	LINK_DOMAIN_BYTES,
	MAX_TREND_LINKS,
	MAX_TREND_STATUSES,
	MAX_TREND_TAGS,
	TREND_ALLOWED_ROWS,
	TREND_REVIEW_POOL,
	TREND_TAG_NAME_BYTES,
} from '../src/platform/stored-bounds'

// The round's link part (domain/trends.ts roundLinks; Trends::Links): who counts (public plain originals and their
// public boosts, by publication day), the qualifying copy, Mastodon's scores and decay, the pools and the
// allowance, each refusal beside its counted twin.

const LINK = 'https://news.example/a'
const iso = (ms: number) => new Date(ms).toISOString()

const candidates = readOperation<{ now: number }, { url: string; today: number; yesterday: number }[]>((db, { now }) =>
	linkCandidates(db, now).map(({ url, today, yesterday }) => ({ url, today, yesterday }))
)
const copyOf = readOperation<{ url: string }, string | null>(
	(db, { url }) =>
		db.first<{ id: string | null }>(`SELECT ${trendCopySql('?1', '?2')} AS id`, url, TREND_LANGUAGES_JSON)?.id ?? null
)
const history = readOperation<{ url: string; now: number }, { uses: string; accounts: string }[]>((db, { url, now }) =>
	linkHistory(db, url, now).map(({ uses, accounts }) => ({ uses, accounts }))
)

const op = <I, O>(store: StoreStub, operation: { run: (sql: SqlStorage, input: I) => O }, input: I) =>
	runInDurableObject(store, (_instance, state) => operation.run(state.storage.sql, input))

async function counted(store: StoreStub, url = LINK) {
	return (await op(store, candidates, { now: AT })).find((c) => c.url === url) ?? null
}

describe('link scores (Trends::Links#calculate_scores)', () => {
	it('scores 5 accounts today and not 4, and a boost by its booster on its own day', async () => {
		const store = await migratedStore()
		const a = await authors(store, 8)
		const [original] = await linkPosts(store, a.slice(0, 1), LINK, TODAY + HOUR)
		await boosts(store, original!, a.slice(1, 4), TODAY + 2 * HOUR)
		// Three accounts by the original's own boosts today, and its author: 4.
		expect(await counted(store)).toBeNull()
		// A boost yesterday counts yesterday only.
		await boosts(store, original!, a.slice(4, 5), YESTERDAY + HOUR, { seq: 1 })
		expect(await counted(store)).toBeNull()
		await boosts(store, original!, a.slice(5, 6), TODAY + 3 * HOUR, { seq: 2 })
		expect(await counted(store)).toEqual({ url: LINK, today: 5, yesterday: 1 })
		await round(store)
		expect(await trendLinkRows(store)).toEqual([
			{ url: LINK, domain: 'news.example', language: 'en', score: 16, max_score: 16, max_score_at: iso(AT) },
		])
	})

	it('decays a peak with an 8 hour half-life, keeps it 2 days, and stores the shown copy’s language', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await linkPosts(store, a, LINK, TODAY + HOUR)
		await round(store)
		await round(store, AT + 8 * HOUR)
		expect(await trendLinkRows(store)).toMatchObject([{ url: LINK, score: 8, max_score: 16, max_score_at: iso(AT) }])
		// Stored links with copies but no posts today: kept within the cooldown, reset after it.
		const [b] = await authors(store, 1, 600_000_000_000_000_000n)
		for (const [url, at] of [
			['https://kept.example/', AT + 8 * HOUR - 2 * DAY],
			['https://reset.example/', AT + 8 * HOUR - 2 * DAY - 1],
		] as const) {
			await linkPosts(store, [b!], url, YESTERDAY - 3 * DAY, { seq: url.length })
			await storedLink(store, url, 0.1, 100, at)
		}
		// A stored link takes its shown copy's language (a copy in another language never qualifies), whatever an
		// import stored; both decay alike.
		await linkPosts(store, [b!], 'https://xx.example/', YESTERDAY - 3 * DAY, { seq: 50 })
		await linkPosts(store, [b!], 'https://en.example/', YESTERDAY - 3 * DAY, { seq: 51 })
		await storedLink(store, 'https://xx.example/', 2, 2, AT - HOUR, { language: 'xx' })
		await storedLink(store, 'https://en.example/', 2, 2, AT - HOUR)
		await round(store, AT + 8 * HOUR)
		const rows = Object.fromEntries((await trendLinkRows(store)).map((r) => [r.url, r]))
		expect(Object.keys(rows).sort()).toEqual(
			['https://en.example/', 'https://kept.example/', 'https://xx.example/', LINK].sort()
		)
		expect(rows['https://kept.example/']).toMatchObject({ max_score: 100, max_score_at: iso(AT + 8 * HOUR - 2 * DAY) })
		expect(rows['https://kept.example/']!.score).toBeCloseTo(100 * 0.5 ** 6, 10)
		expect(rows['https://xx.example/']).toMatchObject({ max_score: 2, language: 'en' })
		for (const url of ['https://xx.example/', 'https://en.example/']) {
			expect(rows[url]!.score, url).toBeCloseTo(2 * 0.5 ** (9 / 8), 10)
		}
	})
})

describe('who counts (VIS-12)', () => {
	type Change = (store: StoreStub, ids: string[], a: string[]) => Promise<unknown>
	// Five originals by five accounts; each case changes one of them, so the link falls to 4.
	it.each<[string, Change]>([
		['an unlisted original', (s, ids) => sql(s, "UPDATE statuses SET visibility = 'unlisted' WHERE id = ?", ids[0]!)],
		['a content warning', (s, ids) => sql(s, "UPDATE statuses SET spoiler_text = 'cw' WHERE id = ?", ids[0]!)],
		['a sensitive original', (s, ids) => sql(s, 'UPDATE statuses SET sensitive = 1 WHERE id = ?', ids[0]!)],
		[
			'an unavailable author',
			(s, _ids, a) => sql(s, "UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", a[0]!),
		],
		[
			'a copy that is not public',
			(s, ids) => sql(s, 'UPDATE status_cards SET public = 0 WHERE status_id = ?', ids[0]!),
		],
	])('drops %s, and counts its twin', async (_name, change) => {
		for (const changed of [false, true]) {
			const store = await migratedStore()
			const a = await authors(store, 5)
			const ids = await linkPosts(store, a, LINK, TODAY + HOUR)
			if (changed) {
				// A public row under a status made unlisted is past the invariant: its copy is dropped with it.
				if (_name === 'an unlisted original') {
					await sql(store, 'UPDATE status_cards SET public = 0 WHERE status_id = ?', ids[0]!)
				}
				await change(store, ids, a)
			}
			expect(await counted(store), `${_name} ${changed}`).toEqual(
				changed ? null : { url: LINK, today: 5, yesterday: 0 }
			)
		}
	})

	it.each<[string, { visibility?: string; unavailable?: boolean }]>([
		['an unlisted boost', { visibility: 'unlisted' }],
		['an unavailable booster', { unavailable: true }],
	])('drops %s, and counts a public boost by an available account', async (_name, { visibility, unavailable }) => {
		for (const changed of [false, true]) {
			const store = await migratedStore()
			const a = await authors(store, 5)
			const [first] = await linkPosts(store, a.slice(0, 4), LINK, TODAY + HOUR)
			await boosts(store, first!, a.slice(4), TODAY + 2 * HOUR, changed && visibility ? { visibility } : {})
			if (changed && unavailable === true) {
				await sql(store, "UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", a[4]!)
			}
			expect(await counted(store), `${_name} ${changed}`).toEqual(
				changed ? null : { url: LINK, today: 5, yesterday: 0 }
			)
		}
	})

	// Every copy changed: the link has no qualifying copy, so nothing of it counts.
	it.each<[string, Parameters<typeof linkPosts>[4]]>([
		['no stored image', { copy: { image: 'pending' } }],
		['no image at all', { copy: { image: 'none' } }],
		['an unknown link type', { copy: { linkType: 0 } }],
		['a video', { copy: { cardType: 2 } }],
		['a blank description', { copy: { description: ' 　\u0085' } }],
		['a blank provider name', { copy: { provider: ' ' } }],
		['a blank title', { copy: { title: ' ' } }],
		['an unsupported language', { copy: { language: 'xx' } }],
		['no language', { copy: { language: null } }],
	])('drops a link whose copies have %s, and counts its twin', async (name, options) => {
		for (const changed of [false, true]) {
			const store = await migratedStore()
			const a = await authors(store, 5)
			await linkPosts(store, a, LINK, TODAY + HOUR, changed ? options : {})
			expect(await counted(store), `${name} ${changed}`).toEqual(changed ? null : { url: LINK, today: 5, yesterday: 0 })
		}
	})

	it('counts every post of a link with a qualifying copy, and none once those copies are gone', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		const qualifying = await linkPosts(store, a.slice(0, 3), LINK, TODAY + HOUR)
		const unknown = await linkPosts(store, a.slice(3), LINK, TODAY + 2 * HOUR, { seq: 1, copy: { linkType: 0 } })
		expect(await counted(store)).toEqual({ url: LINK, today: 5, yesterday: 0 })
		// The copy shown is the newest qualifying one, not the newest copy.
		expect(await op(store, copyOf, { url: LINK })).toBe(qualifying.at(-1))
		expect(unknown.at(-1)! > qualifying.at(-1)!).toBe(true)
		await sql(store, 'DELETE FROM status_cards WHERE status_id IN (?, ?, ?)', ...qualifying)
		expect(await counted(store)).toBeNull()
		expect(await op(store, copyOf, { url: LINK })).toBeNull()
	})
})

describe('allowance and the pools', () => {
	it('keeps a link for review whatever trendable_by_default says, while the hashtag is allowed', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await setTrendSetting(store, 'trendable_by_default', true)
		await trendStatuses(
			store,
			a.map((author, i) => ({ author, published: TODAY + HOUR + i, seq: 9, tags: ['tag'] }))
		)
		await linkPosts(store, a, LINK, TODAY + HOUR)
		await round(store)
		const listed = readOperation<void, { links: number; tags: number }>((db) => ({
			links: db.first<{ n: number }>(
				`SELECT count(*) AS n FROM trend_links t WHERE ${'coalesce((SELECT r.trendable FROM link_trend_reviews r WHERE r.url = t.url), 0) = 1'}`
			)!.n,
			tags: db.first<{ n: number }>('SELECT count(*) AS n FROM trend_tags')!.n,
		}))
		expect(await trendLinkRows(store)).toHaveLength(1)
		expect(await op(store, listed, undefined)).toEqual({ links: 0, tags: 1 })
	})

	it('excludes a stored link without a qualifying copy before the pools, so a lower one is admitted', async () => {
		for (const [name, hasCopy] of [
			['with its copy', 'copy'],
			['without a copy', 'none'],
			['with an import’s copy without image rows', 'imageless'],
		] as const) {
			const store = await migratedStore()
			const [b] = await authors(store, 1, 600_000_000_000_000_000n)
			// 199 allowed stored links with copies, scored above the candidate's 16.
			for (let i = 0; i < 199; i++) {
				const url = `https://s${i}.example/`
				await reviewLink(store, 'link', url, true)
				await storedLink(store, url, 100, 100, AT - HOUR)
			}
			await runInDurableObject(store, (_instance, state) => {
				state.storage.sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 198)
					INSERT INTO statuses (id, uri, account_id, visibility, content, language, published_at)
					SELECT CAST(?1 + i AS TEXT), 'https://remote.example/s' || i, ?2, 'public', 'x', 'en', ?3 FROM n`,
					String(BigInt(YESTERDAY - 3 * DAY) << 16n),
					b!,
					iso(YESTERDAY - 3 * DAY)
				)
			})
			const ids = await sql<{ id: string }>(
				store,
				"SELECT id FROM statuses WHERE uri GLOB 'https://remote.example/s*' ORDER BY id"
			)
			await linkCopies(
				store,
				ids.map(({ id }, i) => ({ status: id, link: `https://s${i}.example/` }))
			)
			// The peak of 1,000 within its cooldown: stored, allowed, and above every other.
			const TOP = 'https://top.example/'
			await reviewLink(store, 'link', TOP, true)
			await storedLink(store, TOP, 1000, 1000, AT - HOUR)
			if (hasCopy !== 'none') {
				const [top] = await linkPosts(store, [b!], TOP, YESTERDAY - 3 * DAY, { seq: 1000 })
				if (hasCopy === 'imageless') {
					await sql(store, 'DELETE FROM card_images WHERE id = ?', `8${top!.slice(1)}`)
				}
			}
			// The candidate: 5 accounts today, allowed.
			const a = await authors(store, 5)
			await reviewLink(store, 'link', LINK, true)
			await linkPosts(store, a, LINK, TODAY + HOUR)
			await round(store)
			const urls = (await trendLinkRows(store)).map((r) => r.url)
			expect(urls.includes(LINK), name).toBe(hasCopy !== 'copy')
			expect(urls.includes(TOP), name).toBe(hasCopy === 'copy')
			expect(urls, name).toHaveLength(200)
		}
	}, 120_000)
})

describe('history', () => {
	it('counts plain public originals and public boosts, by day, the same as the round reads them', async () => {
		const store = await migratedStore()
		const a = await authors(store, 6)
		const [first] = await linkPosts(store, a.slice(0, 2), LINK, TODAY + HOUR)
		await linkPosts(store, a.slice(2, 3), LINK, YESTERDAY + HOUR, { seq: 1 })
		await boosts(store, first!, a.slice(3, 5), TODAY + 2 * HOUR)
		await boosts(store, first!, a.slice(5), TODAY + 2 * HOUR, { seq: 1, visibility: 'unlisted' })
		const days = await op(store, history, { url: LINK, now: AT })
		expect(days.slice(0, 3)).toEqual([
			{ uses: '4', accounts: '4' },
			{ uses: '1', accounts: '1' },
			{ uses: '0', accounts: '0' },
		])
	})
})

// `count` public originals of `by` without a card, ids `first` on at one-ms steps from `at` (seq 0x8000 on, so no
// fixture id is taken), published at `at`.
async function plain(store: StoreStub, by: string, count: number, at: number) {
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, language, published_at)
		SELECT printf('%018d', (?2 + i) * 65536 + 32768), 'https://remote.example/p' || ?2 || '-' || i, ?3, 'public', 'x', 'en',
			strftime('%Y-%m-%dT%H:%M:%fZ', (?2 + i) / 1000.0, 'unixepoch')
		FROM n`,
		count,
		at,
		by
	)
}

// `count` public boosts of `of` by `count` accounts from `base`, ids from `at` on at one-ms steps.
async function boostsOf(store: StoreStub, of: string, count: number, at: number, base: bigint, visibility = 'public') {
	await sql(
		store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
		SELECT printf('%018d', (?2 + i) * 65536 + 40000), 'https://remote.example/b' || ?2 || '-' || ?3 || '-' || i,
			CAST(?4 + i AS TEXT), ?3, ?5, '', strftime('%Y-%m-%dT%H:%M:%fZ', (?2 + i) / 1000.0, 'unixepoch')
		FROM n`,
		count,
		at,
		of,
		String(base),
		visibility
	)
}

describe('the raw caps (RES-7), each at N and N + 1', () => {
	it.each([
		[TREND_WINDOW - 5, true],
		[TREND_WINDOW - 4, false],
	])(
		'counts a link of the 4,000th newest public original and not the 4,001st (%i newer)',
		async (newer, kept) => {
			const store = await migratedStore()
			const a = await authors(store, 6)
			await linkPosts(store, a.slice(0, 5), LINK, TODAY + HOUR)
			await plain(store, a[5]!, newer, TODAY + 2 * HOUR)
			expect((await counted(store)) !== null).toBe(kept)
		},
		60_000
	)

	it.each([
		[TREND_LINK_BOOSTS_PER_STATUS - 1, 1],
		[TREND_LINK_BOOSTS_PER_STATUS, 0],
	])('reads the 100 newest public boosts of an original: %i newer than one of yesterday', async (newer, yesterday) => {
		const store = await migratedStore()
		const a = await authors(store, 1)
		await authors(store, 200, 600_000_000_000_000_000n)
		const [original] = await linkPosts(store, a, LINK, YESTERDAY + HOUR)
		// The oldest boost, yesterday: the 100th with 99 newer, the 101st with 100.
		await boostsOf(store, original!, 1, YESTERDAY + 2 * HOUR, 600_000_000_000_000_150n)
		await boostsOf(store, original!, newer, TODAY + HOUR, 600_000_000_000_000_000n)
		expect(await counted(store)).toEqual({ url: LINK, today: newer, yesterday: 1 + yesterday })
	})

	it.each([
		[TREND_LINK_BOOSTS - 1, true],
		[TREND_LINK_BOOSTS, false],
	])(
		'reads 4,000 public boosts in all: a boost after %i others',
		async (before, kept) => {
			const store = await migratedStore()
			const a = await authors(store, 45)
			await authors(store, 100, 600_000_000_000_000_000n)
			// The link's four originals are the window's oldest; a boost of one of them makes its fifth account.
			const [first] = await linkPosts(store, a.slice(0, 4), LINK, TODAY + HOUR)
			await boostsOf(store, first!, 1, TODAY + 9 * HOUR, BigInt(a[44]!))
			// 40 newer originals of another link with their boosts, read first: 3,999 or 4,000 of them.
			const others = await linkPosts(store, a.slice(4, 44), 'https://other.example/', TODAY + 2 * HOUR, { seq: 1 })
			for (const [i, id] of others.entries()) {
				const n = Math.min(100, before - i * 100)
				if (n > 0) {
					await boostsOf(store, id, n, TODAY + 3 * HOUR + i * 1000, 600_000_000_000_000_000n)
				}
			}
			expect((await counted(store)) !== null).toBe(kept)
		},
		120_000
	)

	it('scores the 400 links with the most accounts today and not a 401st', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		const urls = Array.from(
			{ length: TREND_LINK_CANDIDATES + 1 },
			(_, i) => `https://l${String(i).padStart(3, '0')}.example/`
		)
		for (const [i, url] of urls.entries()) {
			await linkPosts(store, a, url, TODAY + HOUR + i * 10, { seq: i % 50 })
		}
		const returned = (await op(store, candidates, { now: AT })).map((c) => c.url)
		expect(returned).toEqual(urls.slice(0, TREND_LINK_CANDIDATES))
	}, 120_000)

	it.each([
		[TREND_LINK_COPIES - 1, true],
		[TREND_LINK_COPIES, false],
	])('chooses the copy among the 8 newest public copies: %i newer that do not qualify', async (newer, found) => {
		const store = await migratedStore()
		const a = await authors(store, 10)
		const [qualifying] = await linkPosts(store, a.slice(0, 1), LINK, TODAY + HOUR)
		await linkPosts(store, a.slice(1, 1 + newer), LINK, TODAY + 2 * HOUR, { copy: { linkType: 0 } })
		// An unlisted copy is never among them, however new.
		await linkPosts(store, a.slice(9), LINK, TODAY + 3 * HOUR, { status: { visibility: 'unlisted' } })
		expect(await op(store, copyOf, { url: LINK })).toBe(found ? qualifying : null)
	})

	it.each([
		[LINK_HISTORY_ORIGINALS, LINK_HISTORY_ORIGINALS],
		[LINK_HISTORY_ORIGINALS + 1, LINK_HISTORY_ORIGINALS],
	])('counts the newest 200 originals of a history: %i give %i', async (count, uses) => {
		const store = await migratedStore()
		const a = await authors(store, count)
		await linkPosts(store, a, LINK, TODAY + HOUR)
		expect((await op(store, history, { url: LINK, now: AT }))[0]).toEqual({
			uses: String(uses),
			accounts: String(uses),
		})
	})

	it.each([
		[LINK_HISTORY_BOOSTS_PER_STATUS, 1 + LINK_HISTORY_BOOSTS_PER_STATUS],
		[LINK_HISTORY_BOOSTS_PER_STATUS + 1, 1 + LINK_HISTORY_BOOSTS_PER_STATUS],
	])('counts the newest 20 boosts of each original of a history: %i give %i uses', async (count, uses) => {
		const store = await migratedStore()
		const a = await authors(store, 1)
		await authors(store, 30, 600_000_000_000_000_000n)
		const [original] = await linkPosts(store, a, LINK, TODAY + HOUR)
		await boostsOf(store, original!, count, TODAY + 2 * HOUR, 600_000_000_000_000_000n)
		expect((await op(store, history, { url: LINK, now: AT }))[0]?.uses).toBe(String(uses))
	})

	it.each([
		[LINK_HISTORY_BOOSTS, 11 + LINK_HISTORY_BOOSTS],
		[LINK_HISTORY_BOOSTS + 1, 11 + LINK_HISTORY_BOOSTS],
	])('merges the newest 200 boosts of a history: %i give %i uses', async (count, uses) => {
		const store = await migratedStore()
		const a = await authors(store, 11)
		await authors(store, 30, 600_000_000_000_000_000n)
		const originals = await linkPosts(store, a, LINK, TODAY + HOUR)
		// 10 originals with 20 boosts each, and an 11th with the rest (none or one), the oldest boosts.
		if (count > 200) {
			await boostsOf(store, originals[10]!, count - 200, TODAY + 2 * HOUR, 600_000_000_000_000_000n)
		}
		for (const [i, id] of originals.slice(0, 10).entries()) {
			await boostsOf(store, id, 20, TODAY + 3 * HOUR + i * 100, 600_000_000_000_000_000n)
		}
		expect((await op(store, history, { url: LINK, now: AT }))[0]?.uses).toBe(String(uses))
	})

	it.each([
		[TREND_ALLOWED_ROWS, TREND_REVIEW_POOL, TREND_ALLOWED_ROWS + TREND_REVIEW_POOL],
		[TREND_ALLOWED_ROWS + 1, TREND_REVIEW_POOL - 1, TREND_ALLOWED_ROWS + TREND_REVIEW_POOL - 1],
		[TREND_ALLOWED_ROWS - 1, TREND_REVIEW_POOL + 1, TREND_ALLOWED_ROWS + TREND_REVIEW_POOL - 1],
	])(
		'keeps 200 allowed and 50 for review: %i allowed and %i for review keep %i',
		async (allowed, review, kept) => {
			const store = await migratedStore()
			const [b] = await authors(store, 1)
			const urls = Array.from({ length: allowed + review }, (_, i) => `https://s${i}.example/`)
			await plain(store, b!, urls.length, YESTERDAY - 3 * DAY)
			const ids = await sql<{ id: string }>(
				store,
				"SELECT id FROM statuses WHERE uri GLOB 'https://remote.example/p*' ORDER BY id"
			)
			await linkCopies(
				store,
				ids.map(({ id }, i) => ({ status: id, link: urls[i]! }))
			)
			for (const [i, url] of urls.entries()) {
				if (i < allowed) {
					await reviewLink(store, 'link', url, true)
				}
				await storedLink(store, url, 2 + i, 2 + i, AT - HOUR)
			}
			await round(store)
			const rows = (await trendLinkRows(store)).map((r) => r.url)
			expect(rows).toHaveLength(kept)
			// The lowest-scored of the larger pool is the one dropped.
			if (allowed > TREND_ALLOWED_ROWS) {
				expect(rows).not.toContain(urls[0])
			}
			if (review > TREND_REVIEW_POOL) {
				expect(rows).not.toContain(urls[allowed])
			}
		},
		120_000
	)
})

describe('what unlisted activity cannot change (VIS-12)', () => {
	it('leaves scores, admission, the copy and history unchanged under floods of newer unlisted boosts and copies', async () => {
		const observe = async (flood: boolean) => {
			const store = await migratedStore()
			const a = await authors(store, 5)
			await authors(store, 104, 600_000_000_000_000_000n)
			const originals = await linkPosts(store, a, LINK, TODAY + HOUR)
			await boostsOf(store, originals[0]!, 3, TODAY + 2 * HOUR, 600_000_000_000_000_101n)
			if (flood) {
				// 101 newer unlisted boosts of each original (past the round's 100 and history's 20 per original), and
				// 1,000 newer unlisted copies of the link.
				for (const [i, id] of originals.entries()) {
					await boostsOf(store, id, 101, TODAY + 3 * HOUR + i * 1000, 600_000_000_000_000_000n, 'unlisted')
				}
				await linkPosts(
					store,
					Array.from({ length: 1000 }, () => a[0]!),
					LINK,
					TODAY + 4 * HOUR,
					{
						seq: 3,
						status: { visibility: 'unlisted' },
					}
				)
			}
			await reviewLink(store, 'link', LINK, true)
			const seen = {
				candidates: await op(store, candidates, { now: AT }),
				copy: await op(store, copyOf, { url: LINK }),
				history: await op(store, history, { url: LINK, now: AT }),
			}
			await round(store)
			return { ...seen, rows: await trendLinkRows(store) }
		}
		const quiet = await observe(false)
		expect(quiet.candidates).toEqual([{ url: LINK, today: 8, yesterday: 0 }])
		expect(quiet.rows).toHaveLength(1)
		expect(await observe(true)).toEqual(quiet)
	}, 120_000)
})

describe('imported timestamps', () => {
	it('excludes 4,500 boosts with 64 KiB published_at past the 4,000 read, and materializes ids and URLs only', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await authors(store, 100, 600_000_000_000_000_000n)
		// 45 originals of a link at the widest URL, each with 100 boosts: more than TREND_LINK_BOOSTS read.
		const head = 'https://news.example/'
		const wide = head + 'x'.repeat(CARD_URL_LIMIT - head.length)
		const originals: string[] = []
		for (let k = 0; k < 9; k++) {
			originals.push(...(await linkPosts(store, a, wide, TODAY + HOUR + k * 10, { seq: k })))
		}
		for (const [i, id] of originals.entries()) {
			await boostsOf(store, id, 100, TODAY + 2 * HOUR + i * 1000, 600_000_000_000_000_000n)
		}
		expect(originals.length * 100).toBeGreaterThan(TREND_LINK_BOOSTS)
		await sql(
			store,
			`UPDATE statuses SET published_at = '2026-10-20T00:00:00.000Z' || printf('%.*c', 65536, 'x')
			WHERE reblog_of_id IS NOT NULL`
		)
		let query = ''
		await runInDurableObject(store, (_instance, state) => {
			const watched = observedSql(state.storage.sql, (_rows, q) => {
				if (/ob AS MATERIALIZED/.test(q)) {
					query = q
				}
			})
			expect(candidates.run(watched, { now: AT })).toEqual([{ url: wide, today: 5, yesterday: 0 }])
		})
		// Each materialized CTE selects ids and the trigger-bounded URL only, never a time.
		const materialized = [...query.matchAll(/(\w+) AS MATERIALIZED \(\s*SELECT (.*?)\bFROM\b/gs)]
		expect(materialized.map(([, name]) => name)).toEqual(['w', 'o', 'ob', 'q'])
		for (const [, name, columns] of materialized) {
			expect(columns, name).not.toMatch(/published_at|isoTime|strftime/)
		}
	}, 120_000)
})

describe('the round in one transaction', () => {
	it('leaves every trend table as it was when the link part fails, and a fresh kernel rescores from the peaks', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await setTrendSetting(store, 'trendable_by_default', true)
		await trendStatuses(
			store,
			a.map((author, i) => ({ author, published: AT - HOUR + i, seq: 9, tags: ['tag'], favourites: 9 }))
		)
		await linkPosts(store, a, LINK, TODAY + HOUR)
		await round(store)
		const tables = () =>
			sql(
				store,
				`SELECT 'tag' AS kind, name AS key, score, max_score, max_score_at FROM trend_tags
				UNION ALL SELECT 'status', status_id, score, NULL, NULL FROM trend_statuses
				UNION ALL SELECT 'link', url, score, max_score, max_score_at FROM trend_links ORDER BY 1, 2`
			)
		const before = await tables()
		expect(before.map((r) => r.kind)).toEqual(['link', 'status', 'status', 'status', 'status', 'status', 'tag'])
		const failing = await runInDurableObject(store, async (_instance, state) => {
			let reached = false
			const operation = {
				kind: 'write' as const,
				run: (s: SqlStorage, input: { now: number }) =>
					trendsRound.run(
						observedSql(s, (_rows, q) => {
							if (/ob AS MATERIALIZED/.test(q)) {
								reached = true
								throw new Error('link part failed')
							}
						}),
						input
					),
			}
			const error = await testKernel(state)
				.execute(BUILD, operation, { now: AT + 8 * HOUR })
				.then(
					() => null,
					(e: unknown) => e
				)
			return { reached, error: error instanceof Error ? error.message : null }
		})
		expect(failing).toEqual({ reached: true, error: 'link part failed' })
		expect(await tables()).toEqual(before)
		await runInDurableObject(store, (_instance, state) =>
			testKernel(state).execute(BUILD, trendsRound, { now: AT + 8 * HOUR })
		)
		expect(await trendLinkRows(store)).toMatchObject([{ url: LINK, score: 8, max_score: 16, max_score_at: iso(AT) }])
	})

	it('clears the link trends while trends are off, and its twin keeps them', async () => {
		const store = await migratedStore()
		const a = await authors(store, 5)
		await linkPosts(store, a, LINK, TODAY + HOUR)
		await round(store)
		expect(await trendLinkRows(store)).toHaveLength(1)
		await setTrendSetting(store, 'trends', false)
		expect(await round(store)).toEqual({ tags: 0, statuses: 0, links: 0 })
		expect(await trendLinkRows(store)).toEqual([])
	})
})

describe('a remote delete’s hide step (partial-delete boundary)', () => {
	it('drops the hidden status from the counts, the copy and history while its batch is unfinished', async () => {
		const store = await migratedStore()
		const a = await authors(store, 6)
		await authors(store, PURGE_BATCH + 10, 600_000_000_000_000_000n)
		const originals = await linkPosts(store, a.slice(0, 5), LINK, TODAY + HOUR)
		// More remote boosts than one batch removes, so the status outlives the batch that hides it.
		await boostsOf(store, originals[4]!, PURGE_BATCH + 10, TODAY + 2 * HOUR, 600_000_000_000_000_000n)
		// A pending claimed card of another status, outstanding while it is hidden; it outlives its batch too.
		const [claimed] = await trendStatuses(store, [{ author: a[5]!, published: TODAY + 3 * HOUR }])
		await boostsOf(store, claimed!, PURGE_BATCH + 10, TODAY + 4 * HOUR, 600_000_000_000_000_000n)
		await sql(
			store,
			`INSERT INTO status_cards (status_id, url, due_at, enqueued_at, claim, attempts, generation)
			VALUES (?, ?, ?, ?, 1, 1, 7)`,
			claimed!,
			LINK,
			AT + 300_000,
			AT
		)
		expect(await op(store, copyOf, { url: LINK })).toBe(originals[4])
		expect((await op(store, history, { url: LINK, now: AT }))[0]?.uses).toBe(String(5 + 20))
		const more = await runInDurableObject(store, (_instance, state) =>
			state.storage.transactionSync(() => {
				const db = new Db(state.storage.sql)
				return [deleteStatusBatch(db, originals[4]!, AT), deleteStatusBatch(db, claimed!, AT)]
			})
		)
		expect(more).toEqual([true, true])
		expect(await sql(store, 'SELECT visibility FROM statuses WHERE id IN (?, ?)', originals[4]!, claimed!)).toEqual([
			{ visibility: 'direct' },
			{ visibility: 'direct' },
		])
		expect(
			await sql(store, 'SELECT status_id FROM status_cards WHERE status_id IN (?, ?)', originals[4]!, claimed!)
		).toEqual([])
		// Its remaining public boosts count neither in the round nor in history: their original is not public now.
		expect(await counted(store)).toBeNull()
		expect(await op(store, copyOf, { url: LINK })).toBe(originals[3])
		expect((await op(store, history, { url: LINK, now: AT }))[0]?.uses).toBe('4')
		// The outstanding claim is refused by its fence.
		expect(
			await op(store, recordCard, {
				statusId: claimed!,
				token: 1,
				generation: 7,
				now: AT,
				outcome: { kind: 'none' },
			})
		).toEqual({ held: false })
	}, 120_000)
})

describe('admission by the shown copy', () => {
	// 180 bytes of 0x80: within the title's stored bound, past its presented one once decoded (U+FFFD each).
	const MALFORMED = `CAST(x'${'80'.repeat(180)}' AS TEXT)`

	it('drops 200 approved higher links none of whose copies presents, so a lower presentable link is kept and listed', async () => {
		for (const presents of [true, false]) {
			const store = await migratedStore()
			const [b] = await authors(store, 1, 600_000_000_000_000_000n)
			await plain(store, b!, TREND_ALLOWED_ROWS, YESTERDAY - 3 * DAY)
			const ids = await sql<{ id: string }>(
				store,
				"SELECT id FROM statuses WHERE uri GLOB 'https://remote.example/p*' ORDER BY id"
			)
			await linkCopies(
				store,
				ids.map(({ id }, i) => ({ status: id, link: `https://s${i}.example/` }))
			)
			for (let i = 0; i < TREND_ALLOWED_ROWS; i++) {
				await reviewLink(store, 'link', `https://s${i}.example/`, true)
				await storedLink(store, `https://s${i}.example/`, 100, 100, AT - HOUR)
			}
			if (!presents) {
				await sql(store, `UPDATE status_cards SET title = ${MALFORMED} WHERE url GLOB 'https://s*'`)
			}
			const a = await authors(store, 5)
			await reviewLink(store, 'link', LINK, true)
			await linkPosts(store, a, LINK, TODAY + HOUR)
			await round(store)
			const urls = (await trendLinkRows(store)).map((r) => r.url)
			expect(urls.includes(LINK), `presents: ${presents}`).toBe(!presents)
			expect(urls, `presents: ${presents}`).toHaveLength(presents ? TREND_ALLOWED_ROWS : 1)
			const page = await store.trendingLinks(BUILD, {
				credential: null,
				offset: 0,
				limit: 20,
				language: 'en',
				now: AT,
				present: { origin: 'https://kopje.test' },
			})
			if (page.status !== 'ok') {
				throw new Error('refused')
			}
			expect(page.value.items.map((item) => item.url).includes(LINK)).toBe(!presents)
			expect(page.value.items).toHaveLength(presents ? 20 : 1)
		}
	}, 120_000)
})

// SQLite's working memory for the link part's statements, derived (workerd reports no SQLite memory high-water). Each
// intermediate is counted as SQLite stores it in an ephemeral B-tree: a record of a 9-byte header field and the value
// per column (an id or URL as its bytes, an integer at 9 bytes), plus SQLITE_RECORD_OVERHEAD bytes of cell, pointer and
// header, the whole doubled for B-tree page slack (a page at least half full). Every intermediate a statement makes is
// counted live at once, though SQLite frees a sorter once its stage is read.
const SQLITE_RECORD_OVERHEAD = 64
const SQLITE_PAGE_SLACK = 2
// The budget: half of a Durable Object's 128 MB.
const SQLITE_STATEMENT_BUDGET = 64 * 1024 * 1024
// The derived peaks this test pins (docs/threat-model.md RES-7 quotes them).
const LINK_CANDIDATES_SQLITE_PEAK = 39_406_256
const LINK_HISTORY_SQLITE_PEAK = 1_203_600
// The Store's derived peaks by phase of the round's link part (below; docs/threat-model.md RES-7 quotes them).
const LINK_CANDIDATES_PHASE_PEAK = 59_812_006
const LINK_SCORING_PHASE_PEAK = 57_942_827
const ID = 18
const INTEGER = 9
const record = (...values: number[]) =>
	SQLITE_PAGE_SLACK * (SQLITE_RECORD_OVERHEAD + values.reduce((sum, bytes) => sum + 9 + bytes, 0))

describe('SQLite’s working memory for link trends (derived)', () => {
	it('holds the round’s candidate statement and a history within the budget', () => {
		const contributions = TREND_WINDOW + TREND_LINK_BOOSTS
		const candidates = {
			// The window's ids.
			w: TREND_WINDOW * record(ID),
			// Its public copies: an id, a URL and the representative id.
			o: TREND_WINDOW * record(ID, CARD_URL_LIMIT, ID),
			// The boosts read: the parent, the representative and the boost.
			ob: TREND_LINK_BOOSTS * record(ID, ID, ID),
			// g's GROUP BY sorter over r: a representative, an account and a 24-byte time per contribution.
			groupBy: contributions * record(ID, ID, 24),
			// Its two count(DISTINCT) B-trees: an account per contribution each.
			distinct: 2 * contributions * record(ID, ID),
			// q: a URL, two counts and the copy id per group.
			q: TREND_LINK_GROUPS * record(CARD_URL_LIMIT, INTEGER, INTEGER, ID),
			// The final ORDER BY sorter: a URL and two counts per group.
			orderBy: TREND_LINK_GROUPS * record(CARD_URL_LIMIT, INTEGER, INTEGER),
			// A copy check's raw list of TREND_LINK_COPIES ids and its language list (one live at a time).
			copyCheck: TREND_LINK_COPIES * record(ID) + TREND_LANGUAGES.size * record(7),
		}
		const history = {
			o: LINK_HISTORY_ORIGINALS * record(ID),
			b: LINK_HISTORY_ORIGINALS * LINK_HISTORY_BOOSTS_PER_STATUS * record(ID, ID),
			m: LINK_HISTORY_BOOSTS * record(ID, ID),
			groupBy: (LINK_HISTORY_ORIGINALS + LINK_HISTORY_BOOSTS) * record(ID, 10),
			distinct: (LINK_HISTORY_ORIGINALS + LINK_HISTORY_BOOSTS) * record(10, ID),
		}
		const peak = Object.values(candidates).reduce((a, b) => a + b, 0)
		const historyPeak = Object.values(history).reduce((a, b) => a + b, 0)
		console.log(JSON.stringify({ event: 'trend-links-sqlite-memory', candidates, peak, history, historyPeak }))
		expect(peak).toBe(LINK_CANDIDATES_SQLITE_PEAK)
		expect(historyPeak).toBe(LINK_HISTORY_SQLITE_PEAK)
		expect(peak).toBeLessThanOrEqual(SQLITE_STATEMENT_BUDGET)
		expect(historyPeak).toBeLessThanOrEqual(SQLITE_STATEMENT_BUDGET)
	})
})

// The Store isolate's memory while the round's link part runs, by phase (docs/threat-model.md, "Heap at 8 MiB per
// answer": the Store keeps a phase within half of its isolate's 128 MB, as the timelines do). Rows are counted by
// rowHeapBytes' model (64 bytes an object, 32 a value, two a code unit) with the model's 25% headroom; the SQLite figure
// is the candidate statement's derived peak above; OTHER_STORE_WORK is a fixed allowance for whatever else the isolate
// holds meanwhile (the kernel, the module graph, another operation's leftovers).
const STORE_BUDGET = 64_000_000
const ROW_HEADROOM = 1.25
const OTHER_STORE_WORK = 8_000_000
const heap = (values: number, units: number) => 64 + 32 * values + 2 * units

describe('the Store’s memory while the round scores links (derived)', () => {
	it('keeps each phase within half of the Store isolate', () => {
		const url = CARD_URL_LIMIT
		// Phase 1, linkCandidates: the hashtag and status parts' rows (held, conservatively) and the candidates, with
		// the candidate statement's SQLite working memory.
		const before =
			TREND_TAG_GROUPS * heap(4, 2 * TREND_TAG_NAME_BYTES) +
			MAX_TREND_TAGS * heap(4, 2 * TREND_TAG_NAME_BYTES + 24) +
			MAX_TREND_STATUSES * heap(1, 18) +
			(TREND_STATUS_CANDIDATES + MAX_TREND_STATUSES) * heap(6, 18 + 18 + 24)
		const candidateRows = TREND_LINK_CANDIDATES * heap(3, url)
		const candidates = ROW_HEADROOM * (before + candidateRows) + LINK_CANDIDATES_SQLITE_PEAK + OTHER_STORE_WORK
		// Phase 2, choosing the shown copies, scoring and writing: every row the round may read (its RowMeter cap) with
		// headroom; the candidates' map (a candidate with its domain, review and language), the shown languages, the
		// scored rows (a URL, a domain, a time, a language and five numbers); one URL's copies being judged (each text
		// encoded and quoted to measure it); the writes' JSON (the kept keys, the inserted rows), as UTF-16 strings.
		const links = TREND_LINK_CANDIDATES + MAX_TREND_LINKS
		const maps =
			TREND_LINK_CANDIDATES * heap(6, url + LINK_DOMAIN_BYTES + CARD_LANGUAGE_BYTES) +
			links * (heap(1, CARD_LANGUAGE_BYTES) + 64) +
			links * heap(9, url + LINK_DOMAIN_BYTES + 24 + CARD_LANGUAGE_BYTES)
		const texts = CARD_TEXTS.title + CARD_TEXTS.description + CARD_TEXTS.provider_name
		const presentation = TREND_LINK_COPIES * 3 * texts
		const json = 2 * MAX_TREND_LINKS * (url + 3 + (url + LINK_DOMAIN_BYTES + CARD_LANGUAGE_BYTES + 24 + 120))
		const scoring = ROW_HEADROOM * TREND_ROW_CAPS.round + maps + presentation + json + OTHER_STORE_WORK
		console.log(JSON.stringify({ event: 'trend-links-store-memory', candidates, scoring, budget: STORE_BUDGET }))
		expect({ candidates, scoring }).toEqual({
			candidates: LINK_CANDIDATES_PHASE_PEAK,
			scoring: LINK_SCORING_PHASE_PEAK,
		})
		expect(Math.max(candidates, scoring)).toBeLessThanOrEqual(STORE_BUDGET)
	})
})
