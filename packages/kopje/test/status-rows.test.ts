import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ApiHarness, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { freshStore } from './helpers'
import { runs } from './policy-world'
import { watchedCursor } from './read-helpers'
import {
	boundsOf,
	build,
	type Fixture,
	fixture,
	type Item,
	nextId,
	observedPresentation,
	ORIGIN,
	payload,
	rowsOf,
	VIEWER_NOW,
} from './status-row-fixtures'
import { selectSql } from '../src/db/columns'
import { Db, rowHeapBytes, RowMeter } from '../src/db/sql'
import { ACCOUNT_COLUMN_MAP } from '../src/domain/accounts'
import { POLL_COLUMN_MAP } from '../src/domain/polls'
import { type ChunkPlan, PAGE_CHUNKS } from '../src/domain/status-presenter'
import { hydrateQueries, PER_ROW_SORTS, statusRowBoundSql } from '../src/domain/status-rows'
import { statusContext } from '../src/domain/statuses'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

// RES-3, "Heap at 8 MiB per answer" in docs/threat-model.md: statusStream reads an answer's statuses in chunks planned
// by R (status-rows.ts), the bound of the payload each status's rows take, generated from the column maps of the
// queries that read them; a RowMeter caps each chunk's heap and a chunk past it is read again one status at a time.
// The chunks never change the answer.

const itemArb = fc.record({
	kind: fc.constantFrom('status', 'quote', 'boost', 'boostOfQuote'),
	text: fc.integer({ min: 0, max: 40_000 }),
	wide: fc.boolean(),
	mentions: fc.integer({ min: 0, max: 200 }),
	tags: fc.integer({ min: 0, max: 80 }),
	media: fc.integer({ min: 0, max: 5 }),
	poll: fc.integer({ min: 0, max: 100 }),
	viewer: fc.boolean(),
}) satisfies fc.Arbitrary<Item>

afterEach(() => {
	vi.restoreAllMocks()
})

describe('the cursor (RES-3)', () => {
	it('steps lazily, one row ahead: a meter stops the statement at the row past its cap', async () => {
		const result = await runInDurableObject(freshStore(), (_instance, state) => {
			const sql = state.storage.sql
			sql.exec('CREATE TABLE t (i INTEGER PRIMARY KEY)')
			sql.exec(
				'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000) INSERT INTO t SELECT i FROM n'
			)
			// The 5,000th row fails to evaluate: a cursor that read ahead would fail on the first step. workerd's reads one
			// row ahead of the one it returns (rowsRead is 2 after the first), so the 4,999th step fails.
			const cursor = sql.exec<{ i: number; v: string }>(
				"SELECT i, CASE WHEN i = 5000 THEN json('not json') ELSE 'x' END AS v FROM t ORDER BY i"
			)
			const first = cursor.next()
			const readAfterOne = cursor.rowsRead
			let stepped = 1
			let failure = ''
			try {
				for (const _row of cursor) {
					stepped++
				}
			} catch (error) {
				failure = String(error)
			}
			// And a meter stops a statement at the row past its cap, the rest never read.
			const db = new Db(sql).metered(new RowMeter(10 * rowHeapBytes({ i: 1 })))
			let metered = 0
			try {
				for (const _row of db.iterate('SELECT i FROM t ORDER BY i')) {
					metered++
				}
			} catch {
				// RowCapExceeded
			}
			return { first: first.value, readAfterOne, stepped, failure, metered }
		})
		expect(result.first).toEqual({ i: 1, v: 'x' })
		expect(result.readAfterOne).toBeLessThanOrEqual(2)
		expect(result.stepped).toBe(4_998)
		expect(result.failure).toContain('malformed JSON')
		expect(result.metered).toBe(10)
	})
})

describe('R bounds the rows of a status (RES-3)', () => {
	it('is at least the payload each status reads alone, and each chunk reads, for mixed sizes', async () => {
		const { h, f } = await fixture()
		const small: ChunkPlan = { target: 96 * 1024, cap: 256 * 1024 }
		await fc.assert(
			fc.asyncProperty(fc.array(itemArb, { minLength: 1, maxLength: 12 }), async (items) => {
				const result = await runInDurableObject(h.store, (_instance, state) => {
					const ids = items.map((item) => build(state.storage.sql, f, item))
					const bounds = boundsOf(state, f.viewer, ids, 1)
					// Each status alone, in a chunk of one.
					const alone = observedPresentation(state, f.viewer, ids, 1)
					const whole = observedPresentation(state, f.viewer, ids, ids.length)
					const planned = [small, PAGE_CHUNKS].map((plan) => ({
						plan,
						...observedPresentation(state, f.viewer, ids, plan),
					}))
					return {
						alone: alone.segments.map((s) => ({ id: s.ids[0]!, payload: payload(rowsOf(s.reads)) })),
						bounds: [...bounds],
						whole: whole.items,
						planned: planned.map((p) => ({
							plan: p.plan,
							items: p.items,
							segments: p.segments.map((s) => ({
								ids: s.ids,
								payload: payload(rowsOf(s.reads)),
								heap: rowsOf(s.reads).reduce((sum, row) => sum + rowHeapBytes(row), 0),
								largest: Math.max(0, ...rowsOf(s.reads).map(rowHeapBytes)),
							})),
						})),
					}
				})
				const bounds = new Map(result.bounds)
				for (const { id, payload } of result.alone) {
					expect(payload).toBeLessThanOrEqual(bounds.get(id)!)
				}
				for (const { plan, items, segments } of result.planned) {
					expect(items).toEqual(result.whole)
					for (const segment of segments) {
						const r = segment.ids.reduce((sum, id) => sum + bounds.get(id)!, 0)
						expect(segment.payload).toBeLessThanOrEqual(r)
						if (segment.ids.length > 1) {
							// A chunk of several is within the plan, and its heap within the cap plus the row that passed it.
							expect(r).toBeLessThanOrEqual(plan.target)
							expect(segment.heap).toBeLessThanOrEqual(plan.cap + segment.largest)
						}
					}
				}
			}),
			runs(8)
		)
	}, 600_000)

	it('is at least the payload of a 2,048-byte actor id with a short status uri, a NULL and a 2 MiB actor document', async () => {
		const { h, f } = await fixture()
		const result = await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			const ids: string[] = []
			for (const raw of [null, JSON.stringify({ attachment: [], padding: 'p'.repeat(2 * 1024 * 1024 - 40) })]) {
				const author = nextId()
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain, raw) VALUES (?, ?, 'a', 'remote.example', ?)",
					author,
					`https://remote.example/users/${'u'.repeat(2048 - 29)}`.slice(0, 2048 - author.length) + author,
					raw
				)
				const id = nextId()
				sql.exec(
					"INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES (?, 'u:1' || ?, ?, 'public', '', ?)",
					id,
					id,
					author,
					VIEWER_NOW
				)
				ids.push(id)
			}
			const bounds = boundsOf(state, f.viewer, ids, 0)
			const alone = observedPresentation(state, f.viewer, ids, 1)
			return alone.segments.map((s) => ({
				payload: payload(rowsOf(s.reads)),
				bound: bounds.get(s.ids[0]!)!,
				uri: rowsOf(s.reads).find((row) => 'author_uri' in row)?.author_uri,
			}))
		})
		expect(result.map((r) => (r.uri as string).length)).toEqual([2048, 2048])
		for (const { payload, bound } of result) {
			expect(payload).toBeLessThanOrEqual(bound)
		}
	})
})

describe('the hydrate queries (RES-3)', () => {
	// Every kind of row the presenter reads: quotes, boosts, polls with the viewer's votes, filter matches, mentions,
	// hashtags, media and the viewer's flags.
	async function rich(): Promise<{ h: ApiHarness; f: Fixture; ids: string[] }> {
		const { h, f } = await fixture()
		const base: Item = { kind: 'status', text: 300, wide: true, mentions: 3, tags: 5, media: 2, poll: 3, viewer: true }
		const ids = await runInDurableObject(h.store, (_instance, state) =>
			(['status', 'quote', 'boost', 'boostOfQuote'] as const).map((kind) =>
				build(state.storage.sql, f, { ...base, kind })
			)
		)
		return { h, f, ids }
	}

	it('take their columns from the registered maps (drift)', async () => {
		const { h, f, ids } = await rich()
		const reads = await runInDurableObject(h.store, (_instance, state) =>
			observedPresentation(state, f.viewer, ids, PAGE_CHUNKS).reads.map((read) => ({
				query: read.query,
				columns: [...new Set(read.rows.flatMap((row) => Object.keys(row)))],
			}))
		)
		const used = new Set<string>()
		for (const { query, columns } of reads) {
			if (query === statusRowBoundSql()) {
				continue
			}
			const entry = Object.entries(hydrateQueries()).find(([, map]) => query.includes(selectSql(map)))
			expect(entry, query).toBeDefined()
			used.add(entry![0])
			expect(columns.filter((column) => !(column in entry![1]))).toEqual([])
		}
		expect([...used].toSorted()).toEqual(Object.keys(hydrateQueries()).toSorted())
	})

	it('sort no chunk-wide payload: a temporary B-tree only for ids or one row (plan)', async () => {
		const { h, f, ids } = await rich()
		const plans = await runInDurableObject(h.store, (_instance, state) => {
			const reads = observedPresentation(state, f.viewer, ids, PAGE_CHUNKS).reads
			return reads
				.filter((read) => read.query !== statusRowBoundSql())
				.map((read) => {
					// The per-row aggregates allowed by name are left out; what remains may sort ids only.
					let query = read.query
					for (const { query: name, column } of PER_ROW_SORTS) {
						const expression = (hydrateQueries()[name] as Record<string, string>)[column]!
						query = query.replaceAll(expression, 'NULL')
					}
					const plan = state.storage.sql
						.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...read.params)
						.toArray()
						.map((row) => row.detail)
					return { query, temp: plan.filter((detail) => detail.includes('TEMP B-TREE')) }
				})
		})
		for (const { query, temp } of plans) {
			expect(
				temp.filter((detail) => detail !== 'USE TEMP B-TREE FOR DISTINCT'),
				query
			).toEqual([])
			// A DISTINCT sorts ids (json_each's values), or the two host names of one account (the domain suspension check
			// of the visibility rule, visibleSql).
			for (const match of query.matchAll(
				/DISTINCT\s+(?:value\b|CASE pv\.n WHEN 1 THEN rtrim\(\w+\.domain, '\.'\))?/g
			)) {
				expect(match[0], query).not.toMatch(/^DISTINCT\s+$/)
			}
		}
		// The allowed aggregates do sort, one row's value at a time.
		expect(ACCOUNT_COLUMN_MAP.attachment).toContain('ORDER BY')
		expect(POLL_COLUMN_MAP.options).toContain('ORDER BY')
	})

	it('read an ordinary page of 40 statuses in at most 13 queries', async () => {
		const { h, f } = await fixture()
		const counts = await runInDurableObject(h.store, (_instance, state) => {
			// Short posts with a hashtag and a mention, every other one a quote.
			const ids = Array.from({ length: 40 }, (_, i) =>
				build(state.storage.sql, f, {
					kind: i % 2 === 0 ? 'quote' : 'status',
					text: 200,
					wide: false,
					mentions: 1,
					tags: 1,
					media: 0,
					poll: 0,
					viewer: false,
				})
			)
			const planned = observedPresentation(state, f.viewer, ids, PAGE_CHUNKS)
			return { queries: planned.reads.length, chunks: planned.segments.length }
		})
		expect(counts.chunks).toBe(1)
		expect(counts.queries).toBeLessThanOrEqual(13)
	})
})

describe('a boost (R35)', () => {
	it("shows no quote of its own, and its original's in its reblog", async () => {
		const { h, f } = await fixture()
		const plain: Item = { kind: 'boost', text: 10, wide: false, mentions: 0, tags: 0, media: 0, poll: 0, viewer: false }
		const shown = await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			const own = build(sql, f, plain)
			const ofQuote = build(sql, f, { ...plain, kind: 'boostOfQuote' })
			const target = build(sql, f, { ...plain, kind: 'status' })
			// A quote row attached to the boost itself, as a converted row may hold one.
			sql.exec(
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				SELECT ?1, uri, id, account_id, 'accepted', ?3 FROM statuses WHERE id = ?2`,
				own,
				target,
				VIEWER_NOW
			)
			return observedPresentation(state, f.viewer, [own, ofQuote], PAGE_CHUNKS).items.map((status) => ({
				quote: status.quote,
				reblogQuoted: (status.reblog?.quote as { quoted_status?: { id: string } } | null)?.quoted_status?.id ?? null,
			}))
		})
		expect(shown[0]).toEqual({ quote: null, reblogQuoted: null })
		expect(shown[1]!.quote).toBeNull()
		expect(shown[1]!.reblogQuoted).not.toBeNull()
	})
})

describe('the backstop (RES-3)', () => {
	it('reads a chunk past its cap again one status at a time, with the same answer', async () => {
		const { h, f } = await fixture()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const result = await runInDurableObject(h.store, (_instance, state) => {
			const ids = Array.from({ length: 6 }, (_, i) =>
				build(state.storage.sql, f, {
					kind: i % 2 === 0 ? 'boostOfQuote' : 'status',
					text: 20_000,
					wide: true,
					mentions: 50,
					tags: 10,
					media: 4,
					poll: 10,
					viewer: true,
				})
			)
			// A plan whose target any chunk meets, as a missing term in R would make it: every status in one chunk.
			const cap = 256 * 1024
			const low = observedPresentation(state, f.viewer, ids, { target: Infinity, cap })
			const whole = observedPresentation(state, f.viewer, ids, ids.length)
			const [abandoned, ...after] = low.segments
			const rows = rowsOf(abandoned!.reads)
			return {
				ids,
				cap,
				same: JSON.stringify(low.items) === JSON.stringify(whole.items),
				abandoned: { ids: abandoned!.ids, heap: rows.reduce((sum, row) => sum + rowHeapBytes(row), 0) },
				last: rowHeapBytes(rows.at(-1)!),
				after: after.map((segment) => segment.ids),
			}
		})
		expect(result.same).toBe(true)
		expect(result.abandoned.ids).toEqual(result.ids)
		expect(result.abandoned.heap).toBeGreaterThan(result.cap)
		expect(result.abandoned.heap).toBeLessThanOrEqual(result.cap + result.last)
		expect(result.after).toEqual(result.ids.map((id) => [id]))
		expect(warn).toHaveBeenCalledWith({ event: 'kopje.presenter.row-cap-exceeded', ids: result.ids })
	}, 120_000)
})

describe('query ceilings (RES-3)', () => {
	it('a context of 200 statuses reads its statuses in planned chunks', async () => {
		const { h, f } = await fixture()
		// Without keywords: the filter level's preparation pass reads text 4 statuses at a time (TEXT_CHUNK), apart.
		await sql(h.store, 'DELETE FROM filter_keywords')
		const counted = await countedContext(h.store, f, await sha256Hex(f.token))
		// 200 candidates of a few KB of R each: one window of R per 80, chunks of at most 80, each about 12 queries.
		expect(counted.windows).toBe(3)
		expect(counted.chunks).toBe(3)
		expect(counted.queries).toBeLessThanOrEqual(60)
	}, 120_000)
})

async function countedContext(store: StoreStub, f: Fixture, tokenHash: string) {
	return runInDurableObject(store, (_instance, state) => {
		const sql = state.storage.sql
		const root = build(sql, f, {
			kind: 'status',
			text: 100,
			wide: false,
			mentions: 1,
			tags: 1,
			media: 0,
			poll: 0,
			viewer: false,
		})
		for (let i = 0; i < 200; i++) {
			const reply = build(sql, f, {
				kind: 'status',
				text: 500,
				wide: false,
				mentions: 1,
				tags: 1,
				media: 0,
				poll: 0,
				viewer: false,
			})
			sql.exec("UPDATE statuses SET in_reply_to_id = ?, in_reply_to_uri = 'r' WHERE id = ?", root, reply)
		}
		const reads: string[] = []
		const counting = {
			exec: (query: string, ...params: SqlStorageValue[]) => {
				reads.push(query)
				return watchedCursor(state.storage.sql.exec(query, ...params), () => {})
			},
		} as unknown as SqlStorage
		statusContext.run(counting, {
			credential: { tokenHash, scope: 'read:statuses', now: NOW },
			id: root,
			present: { origin: ORIGIN },
			now: NOW,
		} as never)
		return {
			queries: reads.length,
			windows: reads.filter((query) => query === statusRowBoundSql()).length,
			chunks: reads.filter((query) => query.includes('SELECT reblog_of_id FROM statuses WHERE id IN')).length,
		}
	})
}
