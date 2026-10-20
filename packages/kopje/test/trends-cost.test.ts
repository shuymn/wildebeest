import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { BUILD, migratedStore } from './helpers'
import { watchedCursor } from './read-helpers'
import { AT, DAY, HOUR, TODAY } from './trend-helpers'
import { writeOperation } from '../src/domain/operation'
import { trendsRound } from '../src/domain/trends'
import type { StoreStub } from '../src/platform/store-client'

// The round's cost at saturation (RES-6, RES-7): the rows it reads against its ceiling, flat however many statuses lie
// outside its windows, and the plan of each of its production queries with statistics taken before the data grew.

// The design's estimate was 215,000; with every candidate's quote judged (the quoted author's availability walked
// too), both of each author's keys walked under 100 suspend blocks, full review tables, and the reads of the round's
// own deletes, updates and inserts counted, the round measures 272,587 rows, so the asserted ceiling is 275,000
// (docs/threat-model.md RES-7 quotes the figure).
const ROUND_CEILING = 275_000
const idOf = (ms: number) => BigInt(ms) << 16n

type Saturation = { older: number; hidden: number; repeated: boolean }

// The round's worst inputs: an instance with a suspend block (so every author's coverage walks its 8-label domain), the
// window full of today's public originals (none yesterday) with 2 hashtags each and enough boosts and favourites to be
// candidates, by 4,000 distinct authors or 40 authors × 100, one of them an imported status with 10,000 rejected
// hashtag rows; 250 stored hashtags and 250 stored statuses; `older` public statuses before the window and `hidden`
// unlisted ones inside it.
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
					plans[query] = real
						.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
						.toArray()
						.map((r) => r.detail)
						.join(' | ')
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
			expect(many.read).toBeLessThanOrEqual(ROUND_CEILING)
			expect(Math.abs(many.read - few.read)).toBeLessThanOrEqual(10)
			const plans = Object.entries(many.plans)
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
			expect(plan(/FROM trend_statuses t CROSS JOIN statuses s/)).toMatch(
				/^SCAN t USING COVERING INDEX trend_statuses_account \| SEARCH s USING INDEX statuses_public \(id=\?\)/
			)
		},
		600_000
	)
})
