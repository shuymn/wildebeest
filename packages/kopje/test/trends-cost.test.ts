import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { BUILD, migratedStore } from './helpers'
import { explainPlan, watchedCursor } from './read-helpers'
import { AT, DAY, HOUR, TODAY } from './trend-helpers'
import { writeOperation } from '../src/domain/operation'
import {
	LINK_THRESHOLD,
	TREND_LANGUAGES_JSON,
	TREND_LINK_CANDIDATES,
	TREND_LINK_GROUPS,
	trendCopySql,
	trendsRound,
} from '../src/domain/trends'
import type { StoreStub } from '../src/platform/store-client'

// The round's cost at saturation (RES-6, RES-7): the rows it reads against its ceiling, flat however many statuses lie
// outside its windows, and the plan of each of its production queries with statistics taken before the data grew.

// With every candidate's quote judged (the quoted author's availability walked too), both of each author's keys walked
// under 100 suspend blocks, full review tables, the link part at saturation (saturateLinks), and the reads of the
// round's own deletes, updates and inserts counted, the round measures 1,199,008 rows; the ceiling is 1,250,000
// (docs/threat-model.md RES-7 quotes the figure).
const ROUND_CEILING = 1_250_000
const idOf = (ms: number) => BigInt(ms) << 16n

type Saturation = { older: number; hidden: number; repeated: boolean }

// The round's worst inputs: an instance with a suspend block (so every author's coverage walks its 8-label domain), the
// window full of today's public originals (none yesterday) with 2 hashtags each and enough boosts and favourites to be
// candidates, by 4,000 distinct authors or 40 authors × 100, one of them an imported status with 10,000 rejected
// hashtag rows; 250 stored hashtags and 250 stored statuses; the link part's (saturateLinks); `older` public statuses
// before the window and `hidden` unlisted ones inside it.
async function saturate(store: StoreStub, { older, hidden, repeated }: Saturation) {
	await runInDurableObject(store, (_instance, state) => {
		const s = state.storage.sql
		const at = '2026-10-01T00:00:00.000Z'
		// 100 active suspend blocks, none covering an author, so each author's coverage walks both of its keys.
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
			INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
			SELECT 'blocked' || i || '.example', 'suspend', ?1, ?1 FROM n`,
			at
		)
		// 10,000 accounts (the first 4,000 the authors), each on its own eight-label domain with its actor id on another
		// eight-label host.
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
			INSERT INTO accounts (id, uri, username, domain, discoverable)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://h.i.j.k.l.m.n' || i || '.example/users/u' || i,
				'u' || i, 'a.b.c.d.e.f.g' || i || '.example', 1 FROM n`
		)
		const today = idOf(TODAY + HOUR)
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3999)
			INSERT INTO statuses (id, uri, account_id, visibility, content, language, published_at, favourites_count)
			SELECT CAST(?1 + i * 65536 AS TEXT), 'https://w.example/' || i,
				CAST(500000000000000000 + (CASE WHEN ?2 THEN i % 40 ELSE i END) AS TEXT), 'public', '<p>x</p>', 'en',
				strftime('%Y-%m-%dT%H:%M:%fZ', ?3 / 1000.0 + i / 1000.0, 'unixepoch'), 5 + i FROM n`,
			String(today),
			repeated ? 1 : 0,
			TODAY + HOUR
		)
		s.exec(
			`INSERT INTO status_tags (status_id, name, public)
			SELECT id, 't' || ((CAST(substr(uri, 19) AS INTEGER)) % 500), 1 FROM statuses WHERE uri GLOB 'https://w.example/*'
			UNION ALL SELECT id, 't' || ((CAST(substr(uri, 19) AS INTEGER) + 1) % 500), 1 FROM statuses
				WHERE uri GLOB 'https://w.example/*'`
		)
		// The imported status of 10,000 rejected rows, the newest of the window.
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
			INSERT INTO status_tags (status_id, name, public)
			SELECT (SELECT max(id) FROM statuses), 'Foo' || i, 1 FROM n`
		)
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 249)
			INSERT INTO trend_tags (name, score, max_score, max_score_at)
			SELECT 'stored' || i, 2, 2, ?1 FROM n`,
			new Date(AT - HOUR).toISOString()
		)
		s.exec(
			`INSERT INTO trend_statuses (status_id, account_id, score)
			SELECT id, account_id, 1 FROM (SELECT id, account_id, row_number() OVER (PARTITION BY account_id ORDER BY id) AS k
				FROM statuses WHERE uri GLOB 'https://w.example/*') WHERE k <= 3 ORDER BY id LIMIT 250`
		)
		// Every window status quotes the next one (accepted), so each candidate's quote is judged.
		s.exec(
			`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
			SELECT q.id, n.uri, n.id, n.account_id, 'accepted', ?1
			FROM statuses q JOIN statuses n ON n.uri = 'https://w.example/' || (CAST(substr(q.uri, 19) AS INTEGER) + 1)
			WHERE q.uri GLOB 'https://w.example/*'`,
			at
		)
		// Each review table at 10,000: the tags' over the stored names and others, the statuses' over the window and
		// older statuses, the accounts' over every account.
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
			INSERT INTO tag_trend_reviews (name, trendable, reviewed_at)
			SELECT CASE WHEN i < 250 THEN 'stored' || i WHEN i < 750 THEN 't' || (i - 250) ELSE 'r' || i END, i % 2, ?1 FROM n`,
			at
		)
		s.exec(
			`INSERT INTO account_trend_reviews (account_id, trendable, reviewed_at)
			SELECT id, CAST(id AS INTEGER) % 2, ?1 FROM accounts`,
			at
		)
		const before = idOf(TODAY - 30 * DAY)
		s.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(?2 + i AS TEXT), 'https://o.example/' || i, '500000000000000000', 'public', '2026-09-20T00:00:00.000Z'
			FROM n`,
			older,
			String(before)
		)
		s.exec(
			`INSERT INTO status_trend_reviews (status_id, trendable, reviewed_at)
			SELECT id, CAST(substr(id, 18) AS INTEGER) % 2, ?1 FROM statuses ORDER BY id DESC LIMIT 10000`,
			at
		)
		saturateLinks(s, today)
		if (hidden > 0) {
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://h.example/' || i, '500000000000000001', 'unlisted', ?3 FROM n`,
				hidden,
				String(idOf(TODAY) + 1n),
				new Date(TODAY).toISOString()
			)
		}
	})
}

// The link part's worst inputs (RES-7): every window status a public copy of one of TREND_LINK_GROUPS links (status i
// of link i mod 1,600), with 4,000 public boosts today (two or three per link, each original's by its own boosters), so
// with distinct authors every link has 5 accounts today. Each link's copies, newest first: the window's (every card
// check passed but the image, which is none), then 4 older originals' that pass every check but their author's
// availability (cards recorded before their authors' domain was suspended: each walk reaches the instance block on the
// nearest suffix of a nine-label domain), then one older qualifying original's by an available author on an
// eight-label domain: 7 or 8 public copies, the qualifying one within the 8 read. Every URL's host has 127 labels (253
// bytes), so each review walk seeks 126 suffixes, against 10,000 publisher and 10,000 link reviews that match none;
// all 250 trend rows are stored and listed.
const LINK_HOST = Array.from({ length: 127 }, () => 'a').join('.')
const linkOf = (k: string) => `'https://${LINK_HOST}/' || ${k}`

function saturateLinks(s: SqlStorage, today: bigint) {
	const at = '2026-10-01T00:00:00.000Z'
	const old = idOf(TODAY - 40 * DAY)
	// Window copies: status i (the i-th of the window) shows link i % 1600, an article without an image.
	s.exec(
		`INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, description, provider_name, language,
			fetched_at, link_type, final_url, public)
		SELECT id, ${linkOf('(CAST(substr(uri, 19) AS INTEGER) % 1600)')}, 1, 1, 't', 'd', 'p', 'en', 1, 1,
			${linkOf('(CAST(substr(uri, 19) AS INTEGER) % 1600)')}, 1
		FROM statuses WHERE uri GLOB 'https://w.example/*'`
	)
	// 4,000 boosts: b < 1,600 of window status b % 800, the others of window status 800 + (b - 1,600) % 800.
	s.exec(
		`WITH RECURSIVE n(b) AS (SELECT 0 UNION ALL SELECT b + 1 FROM n WHERE b < 3999)
		INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
		SELECT CAST(?1 + 4000 * 65536 + b AS TEXT), 'https://bo.example/' || b, CAST(500000000000000000 + 4000 + b AS TEXT),
			CAST(?1 + (CASE WHEN b < 1600 THEN b % 800 ELSE 800 + (b - 1600) % 800 END) * 65536 AS TEXT), 'public', '', ?2
		FROM n`,
		String(today),
		new Date(TODAY + 2 * HOUR).toISOString()
	)
	// Four authors on nine-label domains (and actor hosts) under the active suspend block of blocked0.example (100
	// blocks are active): a longer walk than an eight-label one, whose first suffix is past the sought ones.
	s.exec(
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
		INSERT INTO accounts (id, uri, username, domain, discoverable)
		SELECT CAST(500000000000000000 + 10000 + i AS TEXT), 'https://h.i.j.k.l.m.n' || i || '.blocked0.example/users/c' || i,
			'c' || i, 'a.b.c.d.e.f.g' || i || '.blocked0.example', 1 FROM n`
	)
	// Older copies of each link k, newest first: 4 by those authors (ids 8k + 7 down to 8k + 4), then a qualifying
	// original by an available author (8k + 3).
	s.exec(
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1600 * 5 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, language, published_at)
		SELECT CAST(?1 + (i / 5) * 8 + 7 - (i % 5) AS TEXT), 'https://cp.example/' || i,
			CAST(500000000000000000 + CASE WHEN i % 5 = 4 THEN i % 4000 ELSE 10000 + i % 5 END AS TEXT), 'public', 'x', 'en', ?2
		FROM n`,
		String(old),
		at
	)
	s.exec(
		`INSERT INTO card_images (id, source_url, enqueued_at, token, width, height, stored_at)
		SELECT '8' || substr(id, 2), 'https://img.example/' || id, 1, 't' || printf('%042d', CAST(substr(id, 2) AS INTEGER)),
			640, 360, 1
		FROM statuses WHERE uri GLOB 'https://cp.example/*'`
	)
	s.exec(
		`INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, description, provider_name, language,
			fetched_at, image_url, image_id, link_type, final_url, public)
		SELECT id, ${linkOf('((CAST(id AS INTEGER) - ?1) / 8)')}, 1, 1, 't', 'd', 'p', 'en', 1,
			'https://img.example/' || id, '8' || substr(id, 2), 1, ${linkOf('((CAST(id AS INTEGER) - ?1) / 8)')}, 1
		FROM statuses WHERE uri GLOB 'https://cp.example/*'`,
		String(old)
	)
	s.exec(
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 249)
		INSERT INTO trend_links (url, domain, language, score, max_score, max_score_at)
		SELECT ${linkOf('i')}, ?1, 'en', 2, 2, ?2 FROM n`,
		LINK_HOST,
		new Date(AT - HOUR).toISOString()
	)
	s.exec(
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
		INSERT INTO link_provider_reviews (domain, trendable, reviewed_at) SELECT 'r' || i || '.example', i % 2, ?1 FROM n`,
		at
	)
	s.exec(
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
		INSERT INTO link_trend_reviews (url, trendable, reviewed_at) SELECT 'https://r.example/' || i, i % 2, ?1 FROM n`,
		at
	)
}

class Rollback extends Error {}

// The rows the round reads, in a transaction rolled back after it, so the Store is left as it was.
async function roundRowsRead(store: StoreStub): Promise<{ read: number; plans: Record<string, string> }> {
	return runInDurableObject(store, (_instance, state) => {
		let read = 0
		const plans: Record<string, string> = {}
		const real = state.storage.sql
		const counting = {
			exec: (query: string, ...params: SqlStorageValue[]) => {
				if (/^\s*(WITH|SELECT)/.test(query)) {
					plans[query] = explainPlan(real, query, ...params)
				}
				const cursor = real.exec(query, ...params)
				return watchedCursor(cursor, () => (read += cursor.rowsRead))
			},
		} as unknown as SqlStorage
		try {
			state.storage.transactionSync(() => {
				trendsRound.run(counting, { now: AT })
				throw new Rollback()
			})
		} catch (error) {
			if (!(error instanceof Rollback)) {
				throw error
			}
		}
		return { read, plans }
	})
}

async function timedRound(store: StoreStub): Promise<number> {
	const start = Date.now()
	await store.trendsRound(BUILD, { now: AT })
	return Date.now() - start
}

describe('rows-read accounting', () => {
	// A write's reads (its subqueries and triggers) are counted once, as a read's are: Db.run reads only rowsWritten.
	it('counts the rows a mutation reads', async () => {
		const store = await migratedStore()
		await sql(
			store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 249)
			INSERT INTO trend_tags (name, score, max_score, max_score_at) SELECT 't' || i, 1, 1, ?1 FROM n`,
			new Date(AT).toISOString()
		)
		const deleteAll = writeOperation<void, number>((db) =>
			db.run("DELETE FROM trend_tags WHERE hex(name) NOT IN (SELECT value FROM json_each('[]'))")
		)
		const read = await runInDurableObject(store, (_instance, state) => {
			let total = 0
			let statements = 0
			const real = state.storage.sql
			const counting = {
				exec: (query: string, ...params: SqlStorageValue[]) => {
					const cursor = real.exec(query, ...params)
					return watchedCursor(cursor, () => {
						statements++
						total += cursor.rowsRead
					})
				},
			} as unknown as SqlStorage
			expect(deleteAll.run(counting, undefined)).toBe(250)
			return { total, statements }
		})
		expect(read).toEqual({ total: expect.any(Number), statements: 1 })
		expect(read.total).toBeGreaterThanOrEqual(250)
	})
})

describe('the round at saturation (RES-6, RES-7)', () => {
	it.each([false, true])(
		'reads within its ceiling, flat as statuses outside the windows grow (repeated authors: %s)',
		async (repeated) => {
			const small = await migratedStore()
			await sql(small, 'ANALYZE')
			await saturate(small, { older: 10_000, hidden: 0, repeated })
			const big = await migratedStore()
			await sql(big, 'ANALYZE')
			await saturate(big, { older: 1_000_000, hidden: 100_000, repeated })
			const few = await roundRowsRead(small)
			const many = await roundRowsRead(big)
			const ms = await timedRound(big)
			console.log(JSON.stringify({ event: 'trends-round-cost', repeated, few: few.read, many: many.read, ms }))
			console.log(JSON.stringify({ event: 'trends-round-plans', plans: many.plans }))
			const plans = Object.entries(many.plans)
			expect(many.read).toBeLessThanOrEqual(ROUND_CEILING)
			expect(Math.abs(many.read - few.read)).toBeLessThanOrEqual(10)
			const plan = (pattern: RegExp) => plans.find(([query]) => pattern.test(query))?.[1] ?? ''
			const tags = plan(/WITH w AS MATERIALIZED/)
			expect(tags).toMatch(/MATERIALIZE w/)
			expect(tags).toMatch(/MATERIALIZE r/)
			expect(tags).toMatch(/SEARCH s USING INDEX statuses_public \(id>\?\)/)
			expect(tags).toMatch(/SEARCH t USING PRIMARY KEY \(status_id=\? AND name=\?\)/)
			expect(tags).toMatch(/CORRELATED LIST SUBQUERY/)
			expect(tags).toMatch(/SEARCH x USING PRIMARY KEY \(status_id=\?\)/)
			expect(tags).not.toMatch(/SCAN s\b|SCAN t\b|SCAN x\b/)
			// The review lookups are key seeks of full review tables.
			expect(tags).toMatch(/SEARCH v USING PRIMARY KEY \(name=\?\)/)
			const stored = plan(/FROM trend_tags t$/m)
			expect(stored).toMatch(/SEARCH r USING PRIMARY KEY \(name=\?\)/)
			const candidates = plan(/LIMIT 400\) c/)
			expect(candidates).toMatch(/SEARCH v USING PRIMARY KEY \(status_id=\?\)/)
			expect(candidates).toMatch(/SEARCH v USING PRIMARY KEY \(account_id=\?\)/)
			expect(candidates).toMatch(/SEARCH s_tq USING (?:COVERING )?INDEX sqlite_autoindex_quotes_1 \(status_id=\?\)/)
			expect(candidates).toMatch(/SEARCH statuses USING (?:COVERING )?INDEX statuses_public \(id>\?\)/)
			expect(candidates).not.toMatch(/SCAN statuses\b|SCAN s\b/)
			// The link part: the window, the public copies and boosts by their partial indexes, key seeks otherwise.
			const links = plan(/ob AS MATERIALIZED/)
			expect(links).toMatch(/SEARCH s USING INDEX statuses_public \(id>\?\)/)
			expect(links).toMatch(/SEARCH c USING PRIMARY KEY \(status_id=\?\)/)
			expect(links).toMatch(/SEARCH c4 USING INDEX status_cards_public_link \(final_url=\? AND status_id>\?\)/)
			expect(links).toMatch(/SEARCH x USING COVERING INDEX statuses_public_boosts \(reblog_of_id=\? AND id=\?\)/)
			expect(links).toMatch(/SEARCH y USING COVERING INDEX statuses_public_boosts \(reblog_of_id=\? AND id>\?\)/)
			expect(links).toMatch(/SEARCH c2 USING INDEX status_cards_public_link \(final_url=\?\)/)
			expect(links).toMatch(/SEARCH k USING PRIMARY KEY \(status_id=\?\)/)
			expect(links).not.toMatch(/SCAN (?:s|x|y|c|c2|c3|c4|k|s3|statuses|status_cards)\b|AUTOMATIC/)
			for (const reviews of [
				...(repeated ? [] : [plan(/FROM json_each\(\?1\) j/)]),
				plan(/FROM trend_links t WHERE/),
			]) {
				expect(reviews).toMatch(/SEARCH pn USING PRIMARY KEY \(domain=\?\)/)
				expect(reviews).toMatch(/SEARCH pr USING PRIMARY KEY \(domain=\?\)/)
				expect(reviews).toMatch(/SEARCH r USING PRIMARY KEY \(url=\?\)/)
			}
			expect(plan(/FROM trend_links t WHERE/)).toMatch(
				/SEARCH c2 USING INDEX status_cards_public_link \(final_url=\?\)/
			)
			if (!repeated) {
				// TREND_LINK_GROUPS groups of 5 accounts before the 400 cut: the production statement without its limit.
				const query = plans.find(([q]) => /ob AS MATERIALIZED/.test(q))![0]
				const groups = await runInDurableObject(big, (_instance, state) => {
					const since = String(BigInt(TODAY - DAY) << 16n)
					return state.storage.sql
						.exec(
							query.replace(new RegExp(`LIMIT ${TREND_LINK_CANDIDATES}$`), 'LIMIT 100000'),
							since,
							new Date(AT).toISOString().slice(0, 10),
							new Date(AT - DAY).toISOString().slice(0, 10),
							new Date(AT).toISOString(),
							TREND_LANGUAGES_JSON
						)
						.toArray()
				})
				expect(groups).toHaveLength(TREND_LINK_GROUPS)
				expect(groups.every((g) => g.today === LINK_THRESHOLD)).toBe(true)
				// Each link's copy is its oldest, the qualifying original: the newer ones failed at the image and at the
				// author's availability, as the fixture means.
				const copy = await runInDurableObject(big, (_instance, state) =>
					state.storage.sql
						.exec(`SELECT ${trendCopySql('?1', '?2')} AS id`, `https://${LINK_HOST}/0`, TREND_LANGUAGES_JSON)
						.one()
				)
				expect(copy.id).toBe(String(idOf(TODAY - 40 * DAY) + 3n))
			}
			expect(plan(/FROM trend_statuses t CROSS JOIN statuses s/)).toMatch(
				/^SCAN t USING COVERING INDEX trend_statuses_account \| SEARCH s USING INDEX statuses_public \(id=\?\)/
			)
		},
		600_000
	)
})
