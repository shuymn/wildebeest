import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { plannedRun, rowsRead, scansOf, staleStatistics } from './read-helpers'
import { act, community, type User } from './status-helpers'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { search } from '../src/domain/search'
import { MAX_TAG_LENGTH, TAG_NAME_BYTES } from '../src/domain/status-bounds'
import { TAG_NAME_JSON_BYTES } from '../src/domain/tag-bounds'
import { featuredTagSuggestions, followedTags, LISTED_HISTORY_ROWS, MAX_FOLLOWED_TAGS } from '../src/domain/tags'
import { sha256Hex } from '../src/security/tokens'

// The bounds of a listed Tag (RES-3) and of the history reads of the lists (RES-7): the per-tag maximum derived from
// the name bounds a list presents (tagNameSql and listedTagName) and the history at LISTED_HISTORY_ROWS, with
// imported-row witnesses through GET /api/v1/followed_tags; and the rows a whole authenticated page reads, flat once
// each hashtag holds more public uses than the cap, with the plan of the production SQL under stale statistics.

const ORIGIN = 'https://kopje.test'
const PRESENT = { origin: ORIGIN }
const C = '\u0001'
const DIGITS = (n: number) => '9'.repeat(n)
const HOUR = 3_600_000
// The request time: noon of NOW's day, so every use below is today.
const AT = NOW + 12 * HOUR
// followed_tags pages at most 200 (FollowedTagsController::TAGS_LIMIT), v2 search 40, suggestions 10.
const FOLLOWED_PAGE = 200
const SEARCH_PAGE = 40
const SUGGESTIONS = 10

// A listed Tag at its widest: a name escaping to TAG_NAME_JSON_BYTES (MAX_TAG_LENGTH control characters), a url of a
// TAG_NAME_BYTES name every byte of which percent-encodes, a 19-digit id, and seven days of LISTED_HISTORY_ROWS.
export const LISTED_TAG_MAX = jsonBytes({
	id: DIGITS(19),
	name: C.repeat(MAX_TAG_LENGTH),
	url: `${ORIGIN}/tags/${'%XX'.repeat(TAG_NAME_BYTES)}`,
	history: Array.from({ length: 7 }, () => ({
		day: DIGITS(10),
		uses: String(LISTED_HISTORY_ROWS),
		accounts: String(LISTED_HISTORY_ROWS),
	})),
	following: false,
	featuring: false,
})

describe('the listed Tag maximum (RES-3)', () => {
	it('derives the maximum from the name bounds and the cap, a full page within an answer', () => {
		// A code point escapes to six bytes at most (\u0001), and a name has MAX_TAG_LENGTH of them.
		expect(jsonBytes(C.repeat(MAX_TAG_LENGTH)) - 2).toBe(TAG_NAME_JSON_BYTES)
		expect(LISTED_TAG_MAX).toBe(5070)
		expect(LISTED_TAG_MAX).toBeLessThanOrEqual(0.85 * ANSWER_BYTES)
		for (const page of [FOLLOWED_PAGE, SEARCH_PAGE, SUGGESTIONS]) {
			expect(page * (LISTED_TAG_MAX + 1) + 1).toBeLessThanOrEqual(ANSWER_BYTES)
		}
	})

	it('presents a page of 200 imported follows, 196 of maximal names, within it, leaving out those past the bounds', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// The follow operation refuses a name past the bound (a 1,000-unit name Tag::HASHTAG_NAME_RE takes).
		const long = await act(h, alice, `/api/v1/tags/${encodeURIComponent('猫'.repeat(1000))}/follow`)
		expect(long.status).toBe(422)
		const wide = (i: number) => String.fromCodePoint(0x20000 + i) + '\u{20001}'.repeat(MAX_TAG_LENGTH - 1)
		const escaping = (i: number) => C.repeat(MAX_TAG_LENGTH - 1) + String.fromCodePoint(0x20000 + i)
		await runInDurableObject(h.store, (_instance, state) => {
			const s = state.storage.sql
			const insert = (name: string | ArrayBuffer) =>
				s.exec('INSERT INTO tag_follows (account_id, name) VALUES (?, CAST(? AS TEXT))', alice.id, name)
			// Past the bounds, as an import may hold them: too many bytes, too many code points, malformed bytes, a NUL.
			insert('x'.repeat(TAG_NAME_BYTES + 1))
			insert('y'.repeat(MAX_TAG_LENGTH + 1))
			insert(new Uint8Array(300).fill(0x80).buffer)
			insert(new Uint8Array([0x61, 0x00, 0x62]).buffer)
			for (let i = 0; i < FOLLOWED_PAGE - 4; i++) {
				insert(i % 2 === 0 ? wide(i) : escaping(i))
			}
			// The newest follow's hashtag has more public uses today than the cap.
			const base = BigInt(NOW + HOUR) << 16n
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT CAST(CAST(?2 AS INTEGER) + i AS TEXT), 'https://kopje.test/ap/o/m' || i, ?3, 'public', ?4 FROM n`,
				LISTED_HISTORY_ROWS + 1,
				String(base),
				alice.id,
				new Date(NOW + HOUR).toISOString()
			)
			s.exec(
				"INSERT INTO status_tags (status_id, name, public) SELECT id, ?, 1 FROM statuses WHERE uri GLOB 'https://kopje.test/ap/o/m*'",
				escaping(FOLLOWED_PAGE - 5)
			)
		})
		const response = await h.request('/api/v1/followed_tags?limit=200', bearer(alice.token))
		expect(response.status).toBe(200)
		const body = (await response.json()) as { name: string; history: { uses: string }[] }[]
		// The page read the 200 follows; the four imported past the bounds are left out, the 196 maximal ones shown.
		expect(body).toHaveLength(FOLLOWED_PAGE - 4)
		expect(body[0]?.history[0]?.uses).toBe(String(LISTED_HISTORY_ROWS))
		const unit = Math.max(...body.map(jsonBytes))
		console.log(JSON.stringify({ event: 'listed-tag-fill', unit, page: jsonBytes(body), max: LISTED_TAG_MAX }))
		expect(unit).toBeLessThanOrEqual(LISTED_TAG_MAX)
		expect(jsonBytes(body)).toBeLessThanOrEqual(FOLLOWED_PAGE * (LISTED_TAG_MAX + 1) + 1)
		// The page read toward its limit by its rows, so it links the next one, which is empty.
		const next = /<([^>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
		expect(next).toBeDefined()
		const rest = await h.request(new URL(next!).pathname + new URL(next!).search, bearer(alice.token))
		expect(await rest.json()).toEqual([])
		const all = (await sql<{ n: number }>(h.store, 'SELECT count(*) AS n FROM tag_follows'))[0]?.n
		expect(all).toBe(FOLLOWED_PAGE)
	}, 60_000)
})

// An adversarial world for the history reads: 100 suspend blocks; 10,000 remote accounts on eight-label domains, each
// actor id on another eight-label host (so an author's coverage walks both); the first 100 are the authors. `mixed`:
// a quarter of them on a blocked domain and a quarter suspended; `available`: all available, the dearest per use.
async function adversarial(h: Pick<ApiHarness, 'store'>, authors: 'mixed' | 'available') {
	await runInDurableObject(h.store, (_instance, state) => {
		const s = state.storage.sql
		const at = '2026-10-01T00:00:00.000Z'
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
			INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
			SELECT 'blocked' || i || '.example', 'suspend', ?1, ?1 FROM n`,
			at
		)
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
			INSERT INTO accounts (id, uri, username, domain, suspended_at, suspension_source)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://h.i.j.k.l.m.n' || i || '.example/users/u', 'u' || i,
				CASE WHEN ?2 AND i < 100 AND i % 4 = 1 THEN 'a.b.c.d.e.f.blocked' || i || '.example'
					ELSE 'a.b.c.d.e.f.g' || i || '.example' END,
				CASE WHEN ?2 AND i < 100 AND i % 4 = 3 THEN ?1 END, CASE WHEN ?2 AND i < 100 AND i % 4 = 3 THEN 'account' END
			FROM n`,
			at,
			authors === 'mixed' ? 1 : 0
		)
	})
}

// `per` public uses today of each of `names`, interleaved (status i carries names[i % names.length]), by the
// adversarial authors or by `author`, a millisecond apart from `from`, received as published.
async function tagUses(
	h: Pick<ApiHarness, 'store'>,
	names: readonly string[],
	per: number,
	options: { from: number; prefix: string; author?: string }
) {
	await runInDurableObject(h.store, (_instance, state) => {
		const s = state.storage.sql
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(CAST(?2 AS INTEGER) + i * 65536 AS TEXT), ?3 || i,
				COALESCE(?4, CAST(500000000000000000 + (i % 100) AS TEXT)), 'public',
				strftime('%Y-%m-%dT%H:%M:%fZ', ?5 / 1000.0 + i / 1000.0, 'unixepoch') FROM n`,
			names.length * per,
			String(BigInt(options.from) << 16n),
			options.prefix,
			options.author ?? null,
			options.from
		)
		s.exec(
			`INSERT INTO status_tags (status_id, name, public)
			SELECT id, ?2 ->> ('$[' || (CAST(substr(uri, length(?1) + 1) AS INTEGER) % CAST(?3 AS INTEGER)) || ']'), 1
			FROM statuses WHERE uri GLOB ?1 || '*'`,
			options.prefix,
			JSON.stringify(names),
			names.length
		)
	})
}

const names = (prefix: string, n: number) =>
	Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)

async function credential(user: User) {
	return { tokenHash: await sha256Hex(user.token), scope: 'read' as const, now: AT }
}

describe('the history reads of the lists (RES-7)', () => {
	it('reads a bounded number of rows per counted use, whatever the authors', async () => {
		const cost = async (authors: 'mixed' | 'available') => {
			const read = async (per: number) => {
				const h = await community(['alice'])
				await adversarial(h, authors)
				await act(h, h.users.alice, '/api/v1/tags/tag000/follow')
				if (per > 0) {
					await tagUses(h, ['tag000'], per, { from: NOW + HOUR, prefix: 'https://w.example/' })
				}
				return rowsRead(h, followedTags, {
					credential: await credential(h.users.alice),
					page: { limit: 40 },
					present: PRESENT,
				})
			}
			const none = await read(0)
			const full = await read(LISTED_HISTORY_ROWS)
			const beyond = await read(LISTED_HISTORY_ROWS * 10)
			return { none, full, beyond, perUse: (full - none) / LISTED_HISTORY_ROWS }
		}
		const mixed = await cost('mixed')
		const available = await cost('available')
		console.log(JSON.stringify({ event: 'tag-history-unit-cost', mixed, available }))
		for (const measured of [mixed, available]) {
			expect(measured.beyond).toBe(measured.full)
			expect(measured.perUse).toBeLessThanOrEqual(25)
		}
	}, 120_000)

	it(`reads within its ceiling for ${FOLLOWED_PAGE} imported follows, the same past the cap`, async () => {
		const read = async (per: number) => {
			const h = await community(['alice'])
			await adversarial(h, 'available')
			const followed = names('tag', FOLLOWED_PAGE)
			await sql(
				h.store,
				'INSERT INTO tag_follows (account_id, name) SELECT ?1, value FROM json_each(?2)',
				h.users.alice.id,
				JSON.stringify(followed)
			)
			await tagUses(h, followed, per, { from: NOW + HOUR, prefix: 'https://w.example/' })
			const input = { credential: await credential(h.users.alice), page: { limit: FOLLOWED_PAGE }, present: PRESENT }
			const result = await runInDurableObject(h.store, (_instance, state) => followedTags.run(state.storage.sql, input))
			expect(result.status === 'ok' && result.value.items.length).toBe(FOLLOWED_PAGE)
			return rowsRead(h, followedTags, input)
		}
		const few = await read(LISTED_HISTORY_ROWS + 1)
		const many = await read(LISTED_HISTORY_ROWS * 10)
		console.log(JSON.stringify({ event: 'followed-tags-cost', few, many }))
		expect(many).toBe(few)
		expect(many).toBeLessThanOrEqual(90_000)
		// More than MAX_FOLLOWED_TAGS, which bounds the follow operation only.
		expect(FOLLOWED_PAGE).toBeGreaterThan(MAX_FOLLOWED_TAGS)
	}, 300_000)

	it(`reads within its ceiling for ${SEARCH_PAGE} hashtags found, its public window full, the same past the cap`, async () => {
		const read = async (per: number) => {
			const h = await community(['alice'])
			await adversarial(h, 'available')
			// Interleaved, so the newest HASHTAG_PUBLIC_WINDOW (2,000) public statuses hold every one of them.
			await tagUses(h, names('tag', SEARCH_PAGE), per, { from: NOW + HOUR, prefix: 'https://w.example/' })
			const input = {
				credential: await credential(h.users.alice),
				query: 'tag',
				types: ['hashtags' as const],
				limit: SEARCH_PAGE,
				offset: 0,
				following: false,
				localDomain: 'kopje.test',
				present: PRESENT,
			}
			const result = await runInDurableObject(h.store, (_instance, state) => search.run(state.storage.sql, input))
			expect(result.status === 'ok' && result.value.hashtags.length).toBe(SEARCH_PAGE)
			return rowsRead(h, search, input)
		}
		// 50 each fills the public window exactly; 500 each holds ten times it.
		const few = await read(50)
		const many = await read(500)
		console.log(JSON.stringify({ event: 'hashtag-search-cost', few, many }))
		expect(many).toBe(few)
		expect(many).toBeLessThanOrEqual(70_000)
	}, 300_000)

	it(`reads within its ceiling for ${SUGGESTIONS} suggestions from 1,000 own statuses, the same past the cap`, async () => {
		const read = async (others: number) => {
			const h = await community(['alice'])
			await adversarial(h, 'available')
			const suggested = names('tag', SUGGESTIONS)
			// The viewer's newest 1,000 statuses (Tag::RECENT_STATUS_LIMIT), 100 for each hashtag; then others' uses.
			await tagUses(h, suggested, 100, {
				from: NOW + HOUR,
				prefix: 'https://kopje.test/ap/o/own',
				author: h.users.alice.id,
			})
			await tagUses(h, suggested, others, { from: NOW + 2 * HOUR, prefix: 'https://w.example/' })
			const input = { credential: await credential(h.users.alice), present: PRESENT }
			const result = await runInDurableObject(h.store, (_instance, state) =>
				featuredTagSuggestions.run(state.storage.sql, input)
			)
			expect(result.status === 'ok' && result.value.length).toBe(SUGGESTIONS)
			return rowsRead(h, featuredTagSuggestions, input)
		}
		const few = await read(LISTED_HISTORY_ROWS + 1)
		const many = await read(LISTED_HISTORY_ROWS * 10)
		console.log(JSON.stringify({ event: 'tag-suggestions-cost', few, many }))
		expect(many).toBe(few)
		expect(many).toBeLessThanOrEqual(9000)
	}, 300_000)

	it('seeks the capped range and each status by id, the Store grown after ANALYZE', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await act(h, alice, '/api/v1/tags/tag000/follow')
		await tagUses(h, ['tag000'], 3, { from: NOW + HOUR, prefix: 'https://kopje.test/ap/o/s', author: alice.id })
		const input = { credential: await credential(alice), page: { limit: 40 }, present: PRESENT }
		const run = () => plannedRun(h, /ORDER BY t\.status_id DESC LIMIT \?3/, followedTags, input)
		const { before, after } = await staleStatistics(h, {
			capture: () => run(),
			grow: async () => {
				// The hashtag past the cap, older uses of it and newer statuses without it.
				await adversarial(h, 'available')
				await tagUses(h, ['tag000'], 2000, { from: NOW + 2 * HOUR, prefix: 'https://w.example/' })
				await tagUses(h, ['tag000'], 5000, { from: NOW - 30 * 24 * HOUR, prefix: 'https://o.example/' })
				await tagUses(h, ['other'], 20_000, { from: NOW + 3 * HOUR, prefix: 'https://u.example/' })
			},
		})
		expect(before.plans).toHaveLength(1)
		expect(after.plans).toHaveLength(1)
		const { plan } = after.plans[0]!
		console.log(JSON.stringify({ event: 'listed-history-plan', plan }))
		expect(plan).toContain('SEARCH t USING COVERING INDEX status_tags_public (name=? AND status_id>?)')
		expect(plan).toContain('SEARCH s USING INDEX sqlite_autoindex_statuses_1 (id=?)')
		expect(scansOf(plan, ['t', 's'])).toEqual([])
	}, 120_000)
})
