import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { LEGACY_EMPTY_KEK, seedLocalAccount } from './federation-helpers'
import { BUILD, migratedStore } from './helpers'
import { ACCESS, accessAdminStore } from './ops-helpers'
import { explainPlan, rowsRead } from './read-helpers'
import { AT, authors, DAY, linkCopies, reviewLink, setTrendSetting, storedLink, trendStatuses } from './trend-helpers'
import { ANSWER_BYTES, ARRAY_ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { USERNAME_LIMIT } from '../src/domain/profile-bounds'
import { CARD_JSON_MAX } from '../src/domain/status-presenter'
import { TREND_HISTORY_ROWS } from '../src/domain/tags'
import {
	ADMIN_TREND_LINKS_LIMIT,
	ADMIN_TREND_PUBLISHERS_LIMIT,
	ADMIN_TREND_STATUSES_LIMIT,
	ADMIN_TREND_TAGS_LIMIT,
	EXCERPT_UNITS,
	LINK_HISTORY_BOOSTS,
	LINK_HISTORY_ORIGINALS,
	TREND_LINKS_MAX_LIMIT,
	TREND_TAGS_MAX_LIMIT,
	trendingStatuses,
	trendingTags,
} from '../src/domain/trends'
import { DOMAIN_BYTES } from '../src/platform/identity-bounds'
import {
	CARD_TEXTS,
	CARD_URL_LIMIT,
	LINK_DOMAIN_BYTES,
	STATUS_URL_LIMIT,
	TREND_TAG_NAME_BYTES,
	TREND_TAG_NAME_LENGTH,
} from '../src/platform/stored-bounds'

// RES-3: the presented maxima of the trends shapes, derived from the stored and read bounds at worst JSON escaping
// (a control character escapes to six bytes); the fills below are witnesses, never the bound. RES-7: the rows the
// hashtag list reads, flat as a trending hashtag's statuses grow.

const ORIGIN = 'https://kopje.test'
const VIEWER = '100000000000000001'
const C = '\u0001'
const ESCAPED = 6
const DIGITS = (n: number) => '9'.repeat(n)

// A history day at its widest: a day's epoch seconds and TREND_HISTORY_ROWS uses and accounts at most.
const HISTORY = Array.from({ length: 7 }, () => ({
	day: DIGITS(10),
	uses: String(TREND_HISTORY_ROWS),
	accounts: String(TREND_HISTORY_ROWS),
}))
// A name of TREND_TAG_NAME_BYTES (no ASCII a name may hold escapes; a byte percent-encodes to three in the url).
const NAME = 'x'.repeat(TREND_TAG_NAME_BYTES)
const URL_OF_NAME = `${ORIGIN}/tags/${'%XX'.repeat(TREND_TAG_NAME_BYTES)}`
// The widest JSON number a score is (a double's shortest form).
const SCORE = -1.2345678901234568e-300

export const TAG_MAX = jsonBytes({
	id: DIGITS(19),
	name: NAME,
	url: URL_OF_NAME,
	history: HISTORY,
	following: false,
	featuring: false,
})
export const ADMIN_TAG_MAX = jsonBytes({
	name: NAME,
	url: URL_OF_NAME,
	score: SCORE,
	trendable: false,
	requires_review: false,
	reviewed_at: DIGITS(24),
	history: HISTORY,
})
export const ADMIN_STATUS_MAX = jsonBytes({
	id: DIGITS(18),
	url: C.repeat(STATUS_URL_LIMIT),
	account: { id: DIGITS(18), acct: `${C.repeat(USERNAME_LIMIT)}@${C.repeat(DOMAIN_BYTES)}` },
	published_at: DIGITS(24),
	language: 'mn-Mong',
	score: SCORE,
	trendable: false,
	requires_review: false,
	excerpt: C.repeat(EXCERPT_UNITS),
})

// `n` distinct names of TREND_TAG_NAME_LENGTH four-byte characters, TREND_TAG_NAME_BYTES each.
const names = (n: number) =>
	Array.from({ length: n }, (_, i) => String.fromCodePoint(0x20000 + i) + '\u{20001}'.repeat(TREND_TAG_NAME_LENGTH - 1))

describe('trends maxima (RES-3)', () => {
	it('pins the derived maxima, each within 85% of an answer', () => {
		expect({ TAG_MAX, ADMIN_TAG_MAX, ADMIN_STATUS_MAX }).toEqual({
			TAG_MAX: 4572,
			ADMIN_TAG_MAX: 4625,
			ADMIN_STATUS_MAX: 29_060,
		})
		for (const unit of [TAG_MAX, ADMIN_TAG_MAX, ADMIN_STATUS_MAX]) {
			expect(unit).toBeLessThanOrEqual(0.85 * ANSWER_BYTES)
		}
		expect(TREND_TAGS_MAX_LIMIT * (TAG_MAX + 1) + 1).toBeLessThanOrEqual(ANSWER_BYTES)
		expect(ADMIN_TREND_TAGS_LIMIT * (ADMIN_TAG_MAX + 1)).toBeLessThanOrEqual(ANSWER_BYTES)
		expect(ADMIN_TREND_STATUSES_LIMIT * (ADMIN_STATUS_MAX + 1)).toBeLessThanOrEqual(ANSWER_BYTES)
	})

	it('presents full hashtag pages of maximal names within the maxima, through the Store', async () => {
		const store = await accessAdminStore()
		await setTrendSetting(store, 'trendable_by_default', true)
		await runInDurableObject(store, (_instance, state) => {
			for (const [i, name] of names(20).entries()) {
				state.storage.sql.exec(
					'INSERT INTO trend_tags (name, score, max_score, max_score_at) VALUES (?, ?, ?, ?)',
					name,
					2 + i,
					2 + i,
					new Date(AT).toISOString()
				)
			}
		})
		const page = await store.trendingTags(BUILD, {
			credential: null,
			offset: 0,
			limit: 20,
			now: AT,
			present: { origin: ORIGIN },
		})
		if (page.status !== 'ok') {
			throw new Error('refused')
		}
		expect(page.value.items).toHaveLength(20)
		const unit = Math.max(...page.value.items.map(jsonBytes))
		const admin = await store.adminTrendTags(BUILD, { authority: ACCESS, offset: 0, limit: 20, origin: ORIGIN })
		if (!admin.ok) {
			throw new Error('refused')
		}
		const adminUnit = Math.max(...admin.tags.map(jsonBytes))
		console.log(JSON.stringify({ event: 'trends-tag-fill', unit, page: jsonBytes(page.value.items), adminUnit }))
		expect(unit).toBeLessThanOrEqual(TAG_MAX)
		expect(adminUnit).toBeLessThanOrEqual(ADMIN_TAG_MAX)
		expect(jsonBytes(page.value.items)).toBeLessThanOrEqual(TREND_TAGS_MAX_LIMIT * (TAG_MAX + 1) + 1)
	})

	// 40 imported trend rows whose parents pass every presented bound: a 1 MiB language, a long domain of control
	// characters, an odd published_at, a url of STATUS_URL_LIMIT control characters and content of control characters.
	it('presents 40 imported admin rows with oversized parents within the maximum, through the Store', async () => {
		const store = await accessAdminStore()
		await runInDurableObject(store, (_instance, state) => {
			const s = state.storage.sql
			for (let i = 0; i < 40; i++) {
				const account = String(500_000_000_000_000_000n + BigInt(i))
				const status = String(300_000_000_000_000_000n + BigInt(i))
				s.exec(
					// Even rows: control characters; odd rows: malformed bytes (x'C0' and continuation bytes, one character to
					// SQLite's length), each far past its byte cap.
					`INSERT INTO accounts (id, uri, username, domain)
					VALUES (?1, ?2, CASE WHEN ?5 THEN ?3 ELSE CAST(x'C0' || ?4 AS TEXT) END,
						CASE WHEN ?5 THEN ?3 || ?1 ELSE CAST(x'C0' || ?4 AS TEXT) || ?1 END)`,
					account,
					`https://d${i}.example/u`,
					C.repeat(2000),
					new Uint8Array(100_000).fill(0x80).buffer,
					i % 2 === 0 ? 1 : 0
				)
				s.exec(
					`INSERT INTO statuses (id, uri, url, account_id, visibility, content, language, published_at)
					VALUES (?1, ?2, ?3, ?4, 'public', CASE WHEN ?8 THEN ?5 ELSE CAST(x'C0' || ?9 AS TEXT) END, ?6, ?7)`,
					status,
					`https://d${i}.example/s`,
					C.repeat(STATUS_URL_LIMIT),
					account,
					`<p>${C.repeat(10_000)}</p>`,
					'x'.repeat(1 << 20),
					`2026-10-20 odd ${'x'.repeat(1000)}`,
					i % 2 === 0 ? 1 : 0,
					new Uint8Array(100_000).fill(0x80).buffer
				)
				s.exec(
					'INSERT INTO trend_statuses (status_id, account_id, score) VALUES (?, ?, ?)',
					status,
					account,
					123456789012345.67
				)
			}
		})
		const admin = await store.adminTrendStatuses(BUILD, { authority: ACCESS, offset: 0, limit: 40 })
		if (!admin.ok) {
			throw new Error('refused')
		}
		expect(admin.statuses).toHaveLength(40)
		expect(admin.statuses[0]).toMatchObject({ language: null, published_at: null })
		const unit = Math.max(...admin.statuses.map(jsonBytes))
		console.log(JSON.stringify({ event: 'trends-admin-status-fill', unit, page: jsonBytes(admin.statuses) }))
		expect(unit).toBeLessThanOrEqual(ADMIN_STATUS_MAX)
		expect(jsonBytes(admin.statuses)).toBeLessThanOrEqual(ADMIN_TREND_STATUSES_LIMIT * (ADMIN_STATUS_MAX + 1))
	}, 60_000)
})

// The hashtag list's reads (RES-7): 20 listed hashtags, each with `per` public statuses in the 7 days, half of them by
// authors that are suspended or on a blocked domain, on an instance with a suspend block (so each author's coverage
// walks its 8-label domain).
async function tagListStore(per: number) {
	const store = await migratedStore()
	await sql(store, 'ANALYZE')
	await setTrendSetting(store, 'trendable_by_default', true)
	await runInDurableObject(store, (_instance, state) => {
		const s = state.storage.sql
		const at = '2026-10-01T00:00:00.000Z'
		// 100 suspend blocks; 10,000 accounts on their own eight-label domains, each actor id on another eight-label
		// host; of the 100 authors, a quarter on a blocked domain and a quarter suspended.
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
			INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
			SELECT 'blocked' || i || '.example', 'suspend', ?1, ?1 FROM n`,
			at
		)
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
			INSERT INTO accounts (id, uri, username, domain, suspended_at, suspension_source)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://h.i.j.k.l.m.n' || i || '.example/users/u',
				'u' || i,
				CASE WHEN i < 100 AND i % 4 = 1 THEN 'a.b.c.d.e.f.blocked' || i || '.example'
					ELSE 'a.b.c.d.e.f.g' || i || '.example' END,
				CASE WHEN i < 100 AND i % 4 = 3 THEN ?1 END, CASE WHEN i < 100 AND i % 4 = 3 THEN 'account' END FROM n`,
			at
		)
		// Each review table at 10,000.
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
			INSERT INTO tag_trend_reviews (name, trendable, reviewed_at)
			SELECT CASE WHEN i < 20 THEN 'tag' || i ELSE 'r' || i END, 1, ?1 FROM n`,
			at
		)
		s.exec('INSERT INTO account_trend_reviews (account_id, trendable, reviewed_at) SELECT id, 1, ?1 FROM accounts', at)
		const since = (BigInt(AT - 6 * DAY) << 16n) + 1n
		for (let t = 0; t < 20; t++) {
			s.exec(
				'INSERT INTO trend_tags (name, score, max_score, max_score_at) VALUES (?, ?, ?, ?)',
				`tag${t}`,
				100 - t,
				100 - t,
				new Date(AT).toISOString()
			)
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT CAST(CAST(?2 AS INTEGER) + CAST(?3 AS INTEGER) * 100000000 + i * 1000 AS TEXT), 'https://w.example/' || CAST(?3 AS INTEGER) || '/' || i,
					CAST(500000000000000000 + (i % 100) AS TEXT), 'public', ?4 FROM n`,
				per,
				String(since),
				t,
				new Date(AT - DAY).toISOString()
			)
			s.exec(
				`INSERT INTO status_tags (status_id, name, public) SELECT id, ?1, 1 FROM statuses WHERE uri GLOB ?2`,
				`tag${t}`,
				`https://w.example/${t}/*`
			)
		}
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(117000000000000000 + i AS TEXT), 'https://o.example/' || i, '500000000000000000', 'public', ?1 FROM n`,
			at
		)
		s.exec(
			`INSERT INTO status_trend_reviews (status_id, trendable, reviewed_at)
			SELECT id, 1, ?1 FROM statuses WHERE uri GLOB 'https://o.example/*'`,
			at
		)
	})
	return store
}

describe('the hashtag list’s reads (RES-7)', () => {
	it('reads within its ceiling, the same with 201 and with 10,000 statuses per hashtag', async () => {
		const read = async (per: number) => {
			const store = await tagListStore(per)
			const h = { store }
			// A signed-in viewer, so the page also reads the authentication and the relationships.
			await seedLocalAccount(store, 'kopje.test', { id: VIEWER, username: 'viewer', key: LEGACY_EMPTY_KEK })
			await sql(
				store,
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('trends', 's', 't', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			await sql(
				store,
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('trends-viewer', 'access', 'trends', ?, 'read')",
				VIEWER
			)
			const credential = { tokenHash: 'trends-viewer', scope: 'read' as const, now: AT }
			const input = { credential, offset: 0, limit: 20, now: AT, present: { origin: ORIGIN } }
			const page = await runInDurableObject(store, (_instance, state) => trendingTags.run(state.storage.sql, input))
			if (page.status !== 'ok') {
				throw new Error(page.status)
			}
			// Every hashtag, each counting the available authors' share of its newest TREND_HISTORY_ROWS entries
			// (yesterday's): half of them, by half of the 100 authors.
			expect(page.value.items.map((tag) => [tag.name, tag.following, tag.history[1]])).toEqual(
				Array.from({ length: 20 }, (_, t) => [
					`tag${t}`,
					false,
					{ day: String((AT - (AT % DAY) - DAY) / 1000), uses: String(TREND_HISTORY_ROWS / 2), accounts: '50' },
				])
			)
			const rows = await rowsRead(h, trendingTags, input)
			// The production statements, explained as they run.
			const plans = await runInDurableObject(store, (_instance, state) => {
				const real = state.storage.sql
				const seen: string[] = []
				const capturing = {
					exec: (query: string, ...params: SqlStorageValue[]) => {
						seen.push(`${query.replace(/\s+/g, ' ').slice(0, 40)} => ${explainPlan(real, query, ...params)}`)
						return real.exec(query, ...params)
					},
				} as unknown as SqlStorage
				trendingTags.run(capturing, input)
				return {
					list: seen.find((p) => p.includes('SELECT hex(name) AS key FROM')) ?? '',
					history: seen.find((p) => p.includes('SELECT substr(s.published_at')) ?? '',
				}
			})
			return { rows, plans }
		}
		const few = await read(TREND_HISTORY_ROWS + 1)
		const many = await read(10_000)
		console.log(JSON.stringify({ event: 'trends-tags-cost', few: few.rows, many: many.rows, plans: many.plans }))
		expect(many.rows).toBeLessThanOrEqual(70_000)
		expect(many.rows).toBe(few.rows)
		expect(many.plans.list).toMatch(/SEARCH t USING COVERING INDEX trend_tags_listed \(score>\?\)/)
		expect(many.plans.list).toMatch(/SEARCH r USING PRIMARY KEY \(name=\?\)/)
		expect(many.plans.history).toMatch(/SEARCH t USING COVERING INDEX status_tags_public \(name=\? AND status_id>\?\)/)
		expect(many.plans.history).not.toMatch(/SCAN s\b|SCAN t\b/)
	}, 300_000)
})

describe('the status list’s plan', () => {
	it('reads the stored rows by their author index, with statistics taken before they grew', async () => {
		const store = await migratedStore()
		await sql(store, 'ANALYZE')
		await setTrendSetting(store, 'trendable_by_default', true)
		await runInDurableObject(store, (_instance, state) => {
			const s = state.storage.sql
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
				INSERT INTO accounts (id, uri, username, domain, discoverable)
				SELECT CAST(500000000000000000 + i AS TEXT), 'https://u' || i || '.example/u', 'u' || i, 'u' || i || '.example', 1
				FROM n`
			)
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 249)
				INSERT INTO statuses (id, uri, account_id, visibility, language, published_at, favourites_count)
				SELECT CAST(117474000000000000 + i AS TEXT), 'https://w.example/' || i,
					CAST(500000000000000000 + (i % 100) AS TEXT), 'public', 'en', ?1, 9 FROM n`,
				new Date(AT - 3_600_000).toISOString()
			)
			s.exec(
				'INSERT INTO trend_statuses (status_id, account_id, score) SELECT id, account_id, 1 + (CAST(id AS INTEGER) % 7) FROM statuses'
			)
		})
		const input = { credential: null, offset: 0, limit: 40, language: 'en', now: AT, present: { origin: ORIGIN } }
		const plan = await runInDurableObject(store, (_instance, state) => {
			let found = ''
			const real = state.storage.sql
			const capturing = {
				exec: (query: string, ...params: SqlStorageValue[]) => {
					if (/FROM \(SELECT t\.status_id, t\.score FROM trend_statuses t/.test(query)) {
						found = explainPlan(real, query, ...params)
					}
					return real.exec(query, ...params)
				},
			} as unknown as SqlStorage
			trendingStatuses.run(capturing, input)
			return found
		})
		console.log(JSON.stringify({ event: 'trends-statuses-plan', plan: plan.slice(0, 400) }))
		expect(plan).toMatch(/SCAN t\b/)
		expect(plan).toMatch(/SEARCH x USING COVERING INDEX trend_statuses_account \(account_id=\?\)/)
		expect(plan).toMatch(/SEARCH e USING INDEX (?:statuses_public|sqlite_autoindex_statuses_1) \(id=\?\)/)
	})
})

// A link's history day at its widest: a day's epoch seconds and 400 uses and accounts at most (LINK_HISTORY_ORIGINALS
// + LINK_HISTORY_BOOSTS contributions).
const LINK_HISTORY = Array.from({ length: 7 }, () => ({
	day: DIGITS(10),
	uses: String(LINK_HISTORY_ORIGINALS + LINK_HISTORY_BOOSTS),
	accounts: String(LINK_HISTORY_ORIGINALS + LINK_HISTORY_BOOSTS),
}))
// A TrendsLink: the widest card (status-presenter.ts CARD_JSON_MAX, derived by test/link-cards.test.ts) with its
// history: one comma, `"history":` and the array.
export const TREND_LINK_MAX = CARD_JSON_MAX + jsonBytes({ history: LINK_HISTORY }) - 1
// An admin link: a URL of CARD_URL_LIMIT bytes (printable ASCII, none of them escaped: the stored rule refuses " and
// \\), the title and provider name at their JSON bounds, a domain of LINK_DOMAIN_BYTES, mn-Mong, the widest score, a
// review time and its publisher's, and the history.
const PUBLISHER = { domain: 'a'.repeat(LINK_DOMAIN_BYTES), trendable: false, reviewed_at: DIGITS(24) }
export const ADMIN_LINK_MAX =
	jsonBytes({
		url: 'a'.repeat(CARD_URL_LIMIT),
		title: '',
		provider_name: '',
		domain: 'a'.repeat(LINK_DOMAIN_BYTES),
		language: 'mn-Mong',
		score: SCORE,
		trendable: false,
		requires_review: false,
		reviewed_at: DIGITS(24),
		publisher: PUBLISHER,
		history: LINK_HISTORY,
	}) +
	(CARD_TEXTS.title - 2) +
	(CARD_TEXTS.provider_name - 2)
export const ADMIN_PUBLISHER_MAX = jsonBytes(PUBLISHER)

describe('link trends maxima (RES-3)', () => {
	it('pins the derived maxima, each page within its answer', () => {
		expect({ TREND_LINK_MAX, ADMIN_LINK_MAX, ADMIN_PUBLISHER_MAX }).toEqual({
			TREND_LINK_MAX: 10_268,
			ADMIN_LINK_MAX: 4_217,
			ADMIN_PUBLISHER_MAX: 325,
		})
		const page = 2 + TREND_LINKS_MAX_LIMIT * TREND_LINK_MAX + (TREND_LINKS_MAX_LIMIT - 1)
		expect(page).toBe(205_381)
		expect(page).toBeLessThanOrEqual(ARRAY_ANSWER_BYTES)
		expect(ADMIN_TREND_LINKS_LIMIT * (ADMIN_LINK_MAX + 1) + 1).toBeLessThanOrEqual(ANSWER_BYTES)
		expect(ADMIN_TREND_PUBLISHERS_LIMIT * (ADMIN_PUBLISHER_MAX + 1) + 1).toBeLessThanOrEqual(ANSWER_BYTES)
	})

	it('presents a full page of widest links within the maxima, through the Store', async () => {
		const store = await accessAdminStore()
		const host = Array.from({ length: 127 }, () => 'a').join('.')
		const link = (i: number) => {
			const head = `https://${host}/${String(i).padStart(2, '0')}/`
			return head + 'x'.repeat(CARD_URL_LIMIT - head.length)
		}
		const [a] = await authors(store, 1)
		const ids = await trendStatuses(
			store,
			Array.from({ length: TREND_LINKS_MAX_LIMIT }, (_, i) => ({ author: a!, published: AT - 3 * DAY + i }))
		)
		// Each text at its JSON bound with control characters (six JSON bytes each).
		const text = (bytes: number) => C.repeat(Math.floor((bytes - 2) / ESCAPED))
		await linkCopies(
			store,
			ids.map((status, i) => ({
				status,
				link: link(i),
				title: text(CARD_TEXTS.title),
				description: text(CARD_TEXTS.description),
				provider: text(CARD_TEXTS.provider_name),
				language: 'mn-Mong',
			}))
		)
		for (let i = 0; i < TREND_LINKS_MAX_LIMIT; i++) {
			await storedLink(store, link(i), 100 - i, 100 - i, AT, { domain: host, language: 'mn-Mong' })
			await reviewLink(store, 'link', link(i), true)
		}
		await reviewLink(store, 'publisher', host, true)
		const page = await store.trendingLinks(BUILD, {
			credential: null,
			offset: 0,
			limit: TREND_LINKS_MAX_LIMIT,
			language: 'en',
			now: AT,
			present: { origin: ORIGIN },
		})
		if (page.status !== 'ok') {
			throw new Error('refused')
		}
		expect(page.value.items).toHaveLength(TREND_LINKS_MAX_LIMIT)
		const admin = await store.adminTrendLinks(BUILD, { authority: ACCESS, offset: 0, limit: 20 })
		if (!admin.ok) {
			throw new Error('refused')
		}
		const unit = Math.max(...page.value.items.map(jsonBytes))
		const adminUnit = Math.max(...admin.links.map(jsonBytes))
		console.log(JSON.stringify({ event: 'trends-link-fill', unit, page: jsonBytes(page.value.items), adminUnit }))
		expect(unit).toBeLessThanOrEqual(TREND_LINK_MAX)
		expect(adminUnit).toBeLessThanOrEqual(ADMIN_LINK_MAX)
		expect(jsonBytes(page.value.items)).toBeLessThanOrEqual(205_381)
	}, 60_000)
})
