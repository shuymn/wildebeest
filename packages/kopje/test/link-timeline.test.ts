import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { type Answer, answer, bigStatus } from './budget-helpers'
import { migratedStore } from './helpers'
import { plannedRun, rowsRead } from './read-helpers'
import { block, community, domainBlock, mute } from './status-helpers'
import {
	author,
	authors,
	linkCopies,
	linkPageProblems,
	linkPosts,
	reviewLink,
	setTrendSetting,
	storedLink,
} from './trend-helpers'
import type { Page } from '../src/domain/accounts'
import { ANSWER_BYTES } from '../src/domain/answer-budget'
import type { Status } from '../src/domain/status-presenter'
import { linkTimeline } from '../src/domain/timelines'

// GET /api/v1/timelines/link (mastodon/timelines.ts linkTimeline, domain/timelines.ts linkTimeline): Mastodon 4.5's
// LinkFeed of a trending link, R8 over a raw window of the link's public copies (status_cards_public_link), its 404s,
// paging and Link headers, the cache headers and the answer budget (RES-3).

const DAY = 86_400_000
const LINK = 'https://news.example/a'
const route = (query = '', link = LINK) => `/api/v1/timelines/link?url=${encodeURIComponent(link)}${query}`
const ids = (page: Answer<{ id: string }[]>) => page.body.map((item) => item.id)
const notFound = { error: 'Record not found' }

// The link listed (score 5) and approved by its own review.
async function trending(h: ApiHarness, link = LINK) {
	await storedLink(h.store, link, 5, 5, NOW)
	await reviewLink(h.store, 'link', link, true)
}

// `count` public posts of the link by a discoverable author, a millisecond apart from `at` (a day ago), oldest first.
async function posts(h: ApiHarness, count: number, { seq = 0, at = NOW - DAY } = {}) {
	const [writer] = await authors(h.store, 1, 700_000_000_000_000_000n + BigInt(seq))
	return linkPosts(
		h.store,
		Array.from({ length: count }, () => writer!),
		LINK,
		at,
		{ seq }
	)
}

// What disagrees with `expected` when the Store's link timeline is walked, anonymously, by the ends its pages return
// (linkPageProblems).
async function storePageProblems(h: ApiHarness, expected: readonly string[], limit: number) {
	return runInDurableObject(h.store, (_instance, state) =>
		linkPageProblems(
			(page) => {
				const result = linkTimeline.run(state.storage.sql, {
					credential: null,
					now: NOW,
					url: LINK,
					page,
					present: { origin: 'https://kopje.test' },
				})
				if (result.status !== 'ok') {
					throw new Error(result.status)
				}
				return result.value
			},
			expected,
			limit
		)
	)
}

describe('GET /api/v1/timelines/link', () => {
	it('answers 404 for each condition alone, its twin answering the posts', async () => {
		const h = await community(['alice'])
		await trending(h)
		const shown = await posts(h, 2)
		const expectShown = async (why: string) => {
			const page = await answer(h, route())
			expect([why, page.status, ids(page)]).toEqual([why, 200, shown.toReversed()])
		}
		const expectNotFound = async (why: string, path = route()) => {
			const page = await answer(h, path)
			expect([why, page.status, page.body]).toEqual([why, 404, notFound])
			const signed = await answer(h, path, h.users.alice.token)
			expect([why, signed.status, signed.body]).toEqual([why, 404, notFound])
		}
		await expectShown('listed and approved')
		await expectNotFound('no url', '/api/v1/timelines/link')
		await expectNotFound('an empty url', '/api/v1/timelines/link?url=')
		await expectNotFound('unknown', route('', 'https://news.example/b'))
		await sql(h.store, 'UPDATE trend_links SET score = 0.9')
		await expectNotFound('score 0.9')
		await sql(h.store, 'UPDATE trend_links SET score = 1')
		await expectShown('score 1')
		await sql(h.store, 'DELETE FROM link_trend_reviews')
		await expectNotFound('unreviewed')
		await reviewLink(h.store, 'publisher', 'news.example', true)
		await expectShown('approved by its publisher')
		await reviewLink(h.store, 'link', LINK, false)
		await expectNotFound('rejected by its own review over its publisher’s approval')
		await sql(h.store, 'DELETE FROM link_trend_reviews')
		await expectShown('approved by its publisher again')
		await reviewLink(h.store, 'publisher', 'news.example', false)
		await expectNotFound('rejected by its publisher')
		await reviewLink(h.store, 'link', LINK, true)
		await expectShown('its own review over its publisher’s')
		// Trends off, with no round between: the stored row is still there.
		await setTrendSetting(h.store, 'trends', false)
		await expectNotFound('trends off')
		expect(await sql(h.store, 'SELECT url FROM trend_links')).toEqual([{ url: LINK }])
		await setTrendSetting(h.store, 'trends', true)
		await expectShown('trends on')
	})

	it('shows public originals only, replies and sensitive posts included, past floods of hidden copies', async () => {
		const h = await community(['alice'])
		await trending(h)
		const [older, reply, sensitive] = await posts(h, 3)
		await sql(
			h.store,
			"UPDATE statuses SET in_reply_to_uri = 'https://remote.example/objects/parent' WHERE id = ?",
			reply!
		)
		await sql(h.store, "UPDATE statuses SET sensitive = 1, spoiler_text = 'cw' WHERE id = ?", sensitive!)
		const expected = [sensitive!, reply!, older!]
		// Newer than all of them: 1,000 unlisted, 10 private and 10 direct copies of the link (never public members),
		// public posts of another link, a public boost of each shown post (one with a public copy of the link, as an
		// import may hold before it links reblog_of_id), and a public post whose copy is held out (public = 0, which
		// the invariant allows).
		const [hider] = await authors(h.store, 1, 710_000_000_000_000_000n)
		for (const [visibility, count, seq] of [
			['unlisted', 1000, 1],
			['private', 10, 2],
			['direct', 10, 3],
		] as const) {
			await linkPosts(
				h.store,
				Array.from({ length: count }, () => hider!),
				LINK,
				NOW - DAY + 10_000,
				{
					seq,
					status: { visibility },
				}
			)
		}
		expect(await sql(h.store, 'SELECT count(*) AS n FROM status_cards WHERE public = 1')).toEqual([{ n: 3 }])
		await linkPosts(h.store, [hider!, hider!], 'https://news.example/other', NOW - DAY + 20_000, { seq: 4 })
		await linkPosts(h.store, [hider!], LINK, NOW - DAY + 30_000, { seq: 5, copy: { public: 0 } })
		await sql(
			h.store,
			`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
			SELECT CAST(CAST(id AS INTEGER) + 9 AS TEXT), uri || '/boost', ?1, id, 'public', '', published_at
			FROM statuses WHERE id IN (?2, ?3, ?4)`,
			hider!,
			...expected
		)
		const [boost] = await sql<{ id: string }>(h.store, 'SELECT id FROM statuses WHERE reblog_of_id = ?', older!)
		await linkCopies(h.store, [{ status: boost!.id, link: LINK }])
		expect(
			await sql(h.store, 'SELECT count(*) AS n FROM status_cards WHERE public = 1 AND final_url = ?', LINK)
		).toEqual([{ n: 4 }])
		for (const token of [undefined, h.users.alice.token]) {
			const page = await answer(h, route('&limit=40'), token)
			expect(ids(page)).toEqual(expected)
		}
		// Anyone sees what R2 lets through: the posts of an author being deleted are gone for everyone.
		await sql(
			h.store,
			'UPDATE accounts SET deleted_at = ? WHERE id = (SELECT account_id FROM statuses WHERE id = ?)',
			new Date(NOW).toISOString(),
			older!
		)
		expect(ids(await answer(h, route()))).toEqual([])
	})

	it('pages both ways past 500 newer posts of non-discoverable or moved authors', async () => {
		const h = await community(['alice'])
		await trending(h)
		const [oldest] = await posts(h, 1)
		const hidden = await authors(h.store, 500, 720_000_000_000_000_000n)
		await sql(
			h.store,
			`UPDATE accounts SET discoverable = CASE CAST(substr(id, 16) AS INTEGER) % 3 WHEN 0 THEN 0 WHEN 1 THEN NULL ELSE 1 END,
				moved_to_account_id = CASE WHEN CAST(substr(id, 16) AS INTEGER) % 3 = 2 THEN ?1 END
			WHERE id >= '720000000000000000' AND id < '730000000000000000'`,
			hidden[0]!
		)
		await linkPosts(h.store, hidden, LINK, NOW - DAY + 60_000, { seq: 1 })
		const [newest] = await posts(h, 1, { seq: 2, at: NOW - DAY + 120_000 })
		const walk = async (first: string, rel: 'next' | 'prev') => {
			const seen: string[] = []
			let pages = 0
			for (let at: string | null = first; at !== null; pages++) {
				expect(pages).toBeLessThan(30)
				const page: Answer<{ id: string }[]> = await answer(h, at, h.users.alice.token)
				expect(page.status).toBe(200)
				seen.push(...ids(page))
				at = page[rel]
				if (at !== null) {
					expect([...new URLSearchParams(at.split('?')[1]).keys()].sort()).toEqual(
						['limit', rel === 'next' ? 'max_id' : 'min_id', 'url'].sort()
					)
				}
			}
			return { seen, pages }
		}
		const down = await walk(route('&limit=2'), 'next')
		expect(down.seen).toEqual([newest!, oldest!])
		// Each page's window is readWindow(2) = 40 candidates: the 500 hidden posts take about 13 pages.
		expect(down.pages).toBeGreaterThan(12)
		const up = await walk(route('&limit=2&min_id=0'), 'prev')
		expect(up.seen).toEqual([oldest!, newest!])
		// The Store's pages, walked by the ends each returns: empty windows the rule rejects whole are cut, and each
		// bounds exactly what it consumed.
		expect(await storePageProblems(h, [newest!, oldest!], 2)).toEqual([])
	}, 60_000)

	it('hides what R8 hides from a viewer: blocks either way, mutes, a domain block', async () => {
		const h = await community(['alice'])
		await trending(h)
		const alice = h.users.alice.id
		const plain = await author(h.store, 'plain')
		const blocked = await author(h.store, 'blocked')
		const muted = await author(h.store, 'muted')
		const blocking = await author(h.store, 'blocking', { domain: 'one.example' })
		const domained = await author(h.store, 'domained', { domain: 'two.example' })
		const shown = await linkPosts(h.store, [plain, blocked, muted, blocking, domained], LINK, NOW - DAY)
		await block(h.store, alice, blocked)
		await mute(h.store, alice, muted)
		await block(h.store, blocking, alice)
		await domainBlock(h.store, alice, 'two.example')
		expect(ids(await answer(h, route()))).toEqual(shown.toReversed())
		expect(ids(await answer(h, route(), h.users.alice.token))).toEqual([shown[0]!])
	})

	it('pages by cursors with next and prev on every page that shows a post, keeping url and limit', async () => {
		const h = await community(['alice'])
		await trending(h)
		const all = (await posts(h, 41)).toReversed()
		const page = (query: string, token?: string) => answer(h, route(query), token)
		const link = (cursor: 'max_id' | 'min_id', id: string, limit = '2') =>
			`/api/v1/timelines/link?url=${encodeURIComponent(LINK)}&limit=${limit}&${cursor}=${id}`
		// Other parameters are dropped from the links; a short page links both ways.
		const first = await page('&limit=2&local=true&foo=bar')
		expect([ids(first), first.next, first.prev]).toEqual([
			all.slice(0, 2),
			link('max_id', all[1]!),
			link('min_id', all[0]!),
		])
		const short = await page(`&limit=2&max_id=${all[39]!}`)
		expect([ids(short), short.next, short.prev]).toEqual([
			[all[40]!],
			link('max_id', all[40]!),
			link('min_id', all[40]!),
		])
		const end = await page(`&limit=2&max_id=${all[40]!}`)
		expect([end.body, end.link]).toEqual([[], null])
		const up = await page(`&limit=2&min_id=${all[10]!}`)
		expect([ids(up), up.next, up.prev]).toEqual([all.slice(8, 10), link('max_id', all[9]!), link('min_id', all[8]!)])
		expect(ids(await page(`&limit=2&since_id=${all[10]!}`))).toEqual(all.slice(0, 2))
		expect(ids(await page(`&limit=5&max_id=${all[3]!}&since_id=${all[6]!}`))).toEqual(all.slice(4, 6))
		// limit as limit_param reads it: 20 by default, at most 40, its absolute value; 0 or unreadable answers [] alone.
		expect(ids(await page(''))).toEqual(all.slice(0, 20))
		expect(ids(await page('&limit=41'))).toEqual(all.slice(0, 40))
		expect(ids(await page('&limit=-3'))).toEqual(all.slice(0, 3))
		for (const limit of ['0', 'abc']) {
			const none = await page(`&limit=${limit}`)
			expect([limit, none.status, none.body, none.link]).toEqual([limit, 200, [], null])
		}
		const empty = await page('&limit=0', h.users.alice.token)
		expect([empty.status, empty.body, empty.link]).toEqual([200, [], null])
		// limit=0 is still refused for a link without a timeline.
		expect((await answer(h, route('&limit=0', 'https://news.example/b'))).status).toBe(404)
		// Anonymous answers may be cached for 15 seconds, varying by Authorization; signed-in ones are not.
		const anonymous = await h.request(route())
		expect(anonymous.headers.get('cache-control')).toBe(
			'public, max-age=15, stale-while-revalidate=30, stale-if-error=86400'
		)
		expect(anonymous.headers.get('vary')).toBe('Authorization')
		const signed = await h.request(route(), { headers: { authorization: `Bearer ${h.users.alice.token}` } })
		expect(signed.headers.get('cache-control')).toBeNull()
		expect((await h.request(route(), { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
	}, 60_000)

	it('cuts a page at its byte budget, links on from its last post, and the next page reaches the rest', async () => {
		const h = await community(['alice'])
		await trending(h)
		const writer = await author(h.store, 'writer', { domain: 'remote.example' })
		const big: string[] = []
		for (let i = 0; i < 10; i++) {
			big.push(await bigStatus(h, writer, NOW - DAY + i * 60_000))
		}
		await linkCopies(
			h.store,
			big.map((status) => ({ status, link: LINK }))
		)
		const expected = big.toReversed()
		const one = await answer(h, route('&limit=1'))
		const size = one.bytes - 2
		const first = await answer(h, route('&limit=40'))
		expect(first.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		const shown = ids(first)
		expect(shown).toEqual(expected.slice(0, shown.length))
		expect([shown.length < expected.length, first.bytes + size + 1 > ANSWER_BYTES]).toEqual([true, true])
		expect(first.next).toBe(`/api/v1/timelines/link?url=${encodeURIComponent(LINK)}&limit=40&max_id=${shown.at(-1)!}`)
		const rest = await answer(h, first.next!)
		expect([...shown, ...ids(rest)]).toEqual(expected)
		// The Store's page says it was cut.
		const page = await runInDurableObject(h.store, (_instance, state) =>
			linkTimeline.run(state.storage.sql, {
				credential: null,
				now: NOW,
				url: LINK,
				page: { limit: 40 },
				present: { origin: 'https://kopje.test' },
			})
		)
		if (page.status !== 'ok' || page.value === null) {
			throw new Error('no page')
		}
		const value: Page<Status> = page.value
		expect([value.cut, value.items.length, value.oldest]).toEqual([true, shown.length, shown.at(-1)!])
		expect(await storePageProblems(h, expected, 40)).toEqual([])
	}, 120_000)
})

// The link timeline's ceiling: the rows its own reads take before presentation (the token, the trends setting, the
// gate, the window and the rule over it): 3,256 measured below, with some margin (docs/threat-model.md RES-7 quotes
// it). Presentation is the presenter's, shared with every status list and bounded there (RES-3, RES-7).
const LINK_TIMELINE_CEILING = 3_500

const VIEWER = '900000000000000001'
const TOKEN = 'link-timeline-token'
const HOST = Array.from({ length: 127 }, () => 'a').join('.')
const WIDE = `https://${HOST}/x`

// The link timeline's worst reads (RES-7): its link on a 127-label host, allowed by a review of the host's two-label
// suffix among 10,000 publisher reviews (so the gate walks 126 suffixes); a signed-in viewer with blocks, mutes and
// domain blocks; authors on their own eight-label domains with actor ids on other eight-label hosts, under 100 active
// suspend blocks that cover none of them (so each availability walks both keys); the window's `shown` newest public
// copies by discoverable authors, below them `rejected` by non-discoverable ones, and `older` older public copies;
// `unlisted` unlisted copies newer than all of them. Statistics are taken before the data grew.
async function timelineStore(shape: { shown: number; rejected: number; older: number; unlisted: number }) {
	const store = await migratedStore()
	await sql(store, 'ANALYZE')
	await runInDurableObject(store, (_instance, state) => {
		const s = state.storage.sql
		const at = '2026-10-01T00:00:00.000Z'
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
			INSERT INTO accounts (id, uri, username, domain, discoverable)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://h.i.j.k.l.m.n' || i || '.example/users/u' || i, 'u' || i,
				'a.b.c.d.e.f.g' || i || '.example', CASE WHEN i < 500 THEN 1 ELSE 0 END FROM n`
		)
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
			INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
			SELECT 'blocked' || i || '.example', 'suspend', ?1, ?1 FROM n`,
			at
		)
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9998)
			INSERT INTO link_provider_reviews (domain, trendable, reviewed_at) SELECT 'r' || i || '.example', 1, ?1 FROM n`,
			at
		)
		s.exec("INSERT INTO link_provider_reviews (domain, trendable, reviewed_at) VALUES ('a.a', 1, ?1)", at)
		s.exec(
			"INSERT INTO trend_links (url, domain, language, score, max_score, max_score_at) VALUES (?1, ?2, 'en', 5, 5, ?3)",
			WIDE,
			HOST,
			at
		)
		s.exec(
			"INSERT INTO accounts (id, uri, username) VALUES (?1, 'https://kopje.test/ap/users/viewer', 'viewer')",
			VIEWER
		)
		s.exec(
			"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
			VIEWER
		)
		s.exec(
			"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('lt', 'secret', 'lt', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
		)
		s.exec(
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'lt', ?, 'read')",
			TOKEN,
			VIEWER
		)
		for (let i = 0; i < 20; i++) {
			s.exec(
				'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)',
				VIEWER,
				String(500000000000000900n + BigInt(i))
			)
			s.exec(
				'INSERT INTO mutes (account_id, target_account_id) VALUES (?, ?)',
				VIEWER,
				String(500000000000000950n + BigInt(i))
			)
			s.exec('INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)', VIEWER, `d${i}.example`)
		}
		// Posts from the newest down: unlisted, shown, rejected, older; each a public or unlisted original with a copy.
		const ranges = [
			{ count: shape.unlisted, visibility: 'unlisted', author: 'i % 500' },
			{ count: shape.shown, visibility: 'public', author: 'i % 500' },
			{ count: shape.rejected, visibility: 'public', author: '500 + i % 400' },
			{ count: shape.older, visibility: 'public', author: 'i % 500' },
		]
		let top = BigInt(NOW) << 16n
		for (const [r, range] of ranges.entries()) {
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, language, published_at)
				SELECT CAST(?2 - i AS TEXT), 'https://p.example/' || ?3 || '/' || i,
					CAST(500000000000000000 + ${range.author} AS TEXT), ?4, 'x', 'en', ?5 FROM n WHERE ?1 > 0`,
				range.count,
				String(top),
				r,
				range.visibility,
				at
			)
			top -= BigInt(range.count)
		}
		s.exec(
			`INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, description, provider_name, language,
				fetched_at, link_type, final_url, public)
			SELECT id, ?1, 1, 1, 't', 'd', 'p', 'en', 1, 1, ?1, visibility = 'public' FROM statuses WHERE uri GLOB 'https://p.example/*'`,
			WIDE
		)
	})
	return store
}

describe('the link timeline’s reads (RES-7)', () => {
	it('reads within its ceiling before presentation, flat past the window, by its index with stale statistics', async () => {
		const credential = { tokenHash: TOKEN, scope: 'read', now: NOW } as const
		const input = { credential, now: NOW, url: WIDE, page: { limit: 40 }, present: { origin: 'https://kopje.test' } }
		const read = async (shape: Parameters<typeof timelineStore>[0]) => {
			const store = await timelineStore(shape)
			const page = await runInDurableObject(store, (_instance, state) => linkTimeline.run(state.storage.sql, input))
			if (page.status !== 'ok' || page.value === null) {
				throw new Error('no page')
			}
			// Every statement in order: those up to the rule's over the window are the timeline's own, the rest the
			// presenter's.
			const statements = (await plannedRun({ store }, /./, linkTimeline, input)).plans
			const rule = statements.findIndex((statement) => /json_each\(\?3\) c CROSS JOIN/.test(statement.query))
			expect(rule).toBeGreaterThan(0)
			const own = statements.slice(0, rule + 1)
			const presenting = statements.slice(rule + 1)
			expect(presenting.filter((statement) => /trend_links|status_cards c INDEXED BY/.test(statement.query))).toEqual(
				[]
			)
			const rows = own.reduce((sum, statement) => sum + statement.rows, 0)
			const total = await rowsRead({ store }, linkTimeline, input)
			const window = own.find((statement) => /status_cards c INDEXED BY/.test(statement.query))
			const gate = own.find((statement) => /FROM trend_links t WHERE/.test(statement.query))
			return {
				rows,
				total,
				items: page.value.items.length,
				cut: page.value.cut === true,
				window: window?.plan.join(' | ') ?? '',
				gate: gate?.plan.join(' | ') ?? '',
			}
		}
		// A full page of 40 from a window of 120; the same with 10,000 older public copies and 10,000 newer unlisted
		// ones; and a window of 120 that the rule rejects whole, above as many older copies.
		const few = await read({ shown: 120, rejected: 0, older: 0, unlisted: 0 })
		const many = await read({ shown: 120, rejected: 0, older: 10_000, unlisted: 10_000 })
		const rejected = await read({ shown: 0, rejected: 120, older: 10_000, unlisted: 10_000 })
		console.log(
			JSON.stringify({
				event: 'link-timeline-cost',
				own: { few: few.rows, many: many.rows, rejected: rejected.rows },
				total: { few: few.total, many: many.total, rejected: rejected.total },
			})
		)
		expect([few.items, many.items, rejected.items, rejected.cut]).toEqual([40, 40, 0, true])
		expect(Math.abs(many.rows - few.rows)).toBeLessThanOrEqual(10)
		expect(Math.abs(many.total - few.total)).toBeLessThanOrEqual(10)
		for (const variant of [few, many, rejected]) {
			expect(variant.rows).toBeLessThanOrEqual(LINK_TIMELINE_CEILING)
			expect(variant.window).toMatch(
				/SEARCH c USING (?:COVERING )?INDEX status_cards_public_link \(final_url=\? AND status_id>\? AND status_id<\?\)/
			)
			expect(variant.gate).toMatch(/SEARCH t USING PRIMARY KEY \(url=\?\)/)
			expect(variant.gate).toMatch(/SEARCH pn USING PRIMARY KEY \(domain=\?\)/)
		}
	}, 300_000)
})
