import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ApiHarness, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { ACCOUNT_EMOJIS_FULL, STATUS_EMOJIS_FULL } from './emoji-fixtures'
import { freshStore } from './helpers'
import { runs } from './policy-world'
import {
	plannedSql,
	type PlannedStatement,
	remoteAccounts,
	scansOf,
	staleStatistics,
	watchedCursor,
} from './read-helpers'
import { community } from './status-helpers'
import {
	boundsOf,
	build,
	type Fixture,
	fixture,
	type Item,
	MOVED_KINDS,
	nextId,
	observedPresentation,
	planCounts,
	type Read,
	recordingSql,
	ORIGIN,
	heap,
	rowsOf,
	VIEWER_NOW,
} from './status-row-fixtures'
import { selectSql } from '../src/db/columns'
import { Db, rowHeapBytes, RowMeter } from '../src/db/sql'
import {
	ACCOUNT_COLUMN_MAP,
	MOVED_ACCOUNT_CAPS,
	MOVED_ACCOUNT_COLUMNS,
	PROFILE_URL_LIMIT,
} from '../src/domain/accounts'
import { ADMIN_EMAIL_COLUMNS, LOCAL_EMAIL_COLUMNS } from '../src/domain/admin-authority'
import { type VisibleStatusId, visibleSql } from '../src/domain/audience'
import { listGroupedNotifications } from '../src/domain/notification-groups'
import { OWN_VOTE_COLUMNS, POLL_COLUMN_MAP } from '../src/domain/polls'
import { MAX_REMOTE_OPTIONS, MAX_STATUS_MENTION_ROWS } from '../src/domain/status-bounds'
import {
	type ChunkPlan,
	PAGE_CHUNKS,
	presentation,
	presentStatusesWithin,
	type Quote,
} from '../src/domain/status-presenter'
import { hydrateQueries, PER_ROW_SORTS, STATUS_FROM, statusRowBoundSql } from '../src/domain/status-rows'
import { statusContext } from '../src/domain/statuses'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

// RES-3, "Heap at 8 MiB per answer" in docs/threat-model.md: statusStream reads an answer's statuses in chunks planned
// by R (status-rows.ts), a bound of the heap each status's rows take as RowMeter counts it, generated from the column
// maps of the queries that read them; the meter caps each chunk, and a chunk past it (a fault in R) is read again one
// status at a time.
// The chunks never change the answer.

const TINY: Item = { kind: 'status', text: 10, wide: false, mentions: 0, tags: 0, media: 0, poll: 0, viewer: false }

const itemArb = fc.record({
	kind: fc.constantFrom('status', 'quote', 'boost', 'boostOfQuote'),
	text: fc.integer({ min: 0, max: 40_000 }),
	wide: fc.boolean(),
	mentions: fc.integer({ min: 0, max: MAX_STATUS_MENTION_ROWS }),
	tags: fc.integer({ min: 0, max: 80 }),
	media: fc.integer({ min: 0, max: 5 }),
	poll: fc.integer({ min: 0, max: MAX_REMOTE_OPTIONS }),
	viewer: fc.boolean(),
	// Each status's author drawn apart: a boost's original or a quoted status may be local under a remote top level.
	local: fc.boolean(),
	originalLocal: fc.boolean(),
	quotedLocal: fc.boolean(),
	// Where the item's remote author moved, if anywhere.
	moved: fc.constantFrom(undefined, ...MOVED_KINDS),
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
	it("is at least the meter's count of each status alone and of each chunk, for mixed sizes", async () => {
		// Local authors too, among them the OAuth admin, whose lookup (the Owner role) one chunk of each answer reads, each
		// with its images and statics at their bounds, which authors moved to the first read too.
		const { h, f } = await fixture({ admin: true, statics: true })
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const small: ChunkPlan = { target: 256 * 1024, cap: 256 * 1024 }
		await fc.assert(
			fc.asyncProperty(fc.array(itemArb, { minLength: 1, maxLength: 12 }), async (items) => {
				const result = await runInDurableObject(h.store, (_instance, state) => {
					// Two small statuses first, so each plan reads a chunk of several.
					const ids = [TINY, TINY, ...items].map((item) => build(state.storage.sql, f, item))
					const bounds = boundsOf(state, f.viewer, ids, 1)
					// Each status alone, in a chunk of one.
					const alone = observedPresentation(state, f.viewer, ids, 1)
					const whole = observedPresentation(state, f.viewer, ids, ids.length)
					const planned = [small, PAGE_CHUNKS].map((plan) => ({
						plan,
						...observedPresentation(state, f.viewer, ids, plan),
					}))
					return {
						alone: alone.segments.map((s) => ({ id: s.ids[0]!, heap: heap(rowsOf(s.reads)) })),
						aloneItems: alone.items,
						bounds: [...bounds],
						whole: whole.items,
						planned: planned.map((p) => ({
							plan: p.plan,
							items: p.items,
							segments: p.segments.map((s) => ({
								ids: s.ids,
								heap: heap(rowsOf(s.reads)),
							})),
						})),
					}
				})
				const bounds = new Map(result.bounds)
				for (const { id, heap } of result.alone) {
					expect(heap).toBeLessThanOrEqual(bounds.get(id)!)
				}
				expect(result.aloneItems).toEqual(result.whole)
				for (const { plan, items, segments } of result.planned) {
					expect(items).toEqual(result.whole)
					for (const segment of segments) {
						expect(segment.heap).toBeLessThanOrEqual(segment.ids.reduce((sum, id) => sum + bounds.get(id)!, 0))
					}
					// Chunks of several, each within the plan, so within the cap.
					const several = segments.filter((segment) => segment.ids.length > 1)
					expect(several.length).toBeGreaterThan(0)
					expect(
						several.map((segment) => segment.ids.reduce((sum, id) => sum + bounds.get(id)!, 0) <= plan.target)
					).toEqual(several.map(() => true))
				}
			}),
			runs(8)
		)
		// R missed no term: the backstop never fired.
		expect(warn).not.toHaveBeenCalled()
	}, 600_000)

	it("is at least the meter's count of a 2,048-byte actor id with a short status uri, a NULL and a 2 MiB actor document", async () => {
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
				heap: heap(rowsOf(s.reads)),
				bound: bounds.get(s.ids[0]!)!,
				uri: rowsOf(s.reads).find((row) => 'author_uri' in row)?.author_uri,
			}))
		})
		expect(result.map((r) => (r.uri as string).length)).toEqual([2048, 2048])
		for (const { heap, bound } of result) {
			expect(heap).toBeLessThanOrEqual(bound)
		}
	})
})

describe("the OAuth admin's lookup (RES-3)", () => {
	// A local author's Owner role reads the OAuth admin once per answer (adminAccountIdOnce, keyed on the operation's
	// root Db), in whichever metered chunk first shows an available local author; R counts that read for each item.
	it('is read once per answer, in a later metered chunk, within R and without the backstop', async () => {
		const { h, f } = await fixture({ admin: true })
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const small: ChunkPlan = { target: 64 * 1024, cap: 64 * 1024 }
		const kinds = ['status', 'quote', 'boost', 'boostOfQuote'] as const
		const result = await runInDurableObject(h.store, (_instance, state) => {
			// Remote authors first, so the first chunks read no lookup; then local ones, the admin among them.
			const ids = Array.from({ length: 24 }, (_, i) =>
				build(state.storage.sql, f, {
					kind: kinds[i % 4]!,
					text: 4000,
					wide: false,
					mentions: 0,
					tags: 0,
					media: 0,
					poll: 0,
					viewer: false,
					local: i >= 8,
					originalLocal: i >= 8,
					quotedLocal: i >= 8,
				})
			)
			const bounds = boundsOf(state, f.viewer, ids, 1)
			const planned = observedPresentation(state, f.viewer, ids, small)
			const whole = observedPresentation(state, f.viewer, ids, ids.length)
			const lookup = (read: Read) =>
				read.query.includes(selectSql(ADMIN_EMAIL_COLUMNS)) || read.query.includes(selectSql(LOCAL_EMAIL_COLUMNS))
			return {
				same: JSON.stringify(planned.items) === JSON.stringify(whole.items),
				lookups: planned.reads.filter(lookup).length,
				// The segment each lookup read falls in.
				at: planned.segments.flatMap((segment, i) => (segment.reads.some(lookup) ? [i] : [])),
				chunks: planned.segments.map((segment) => ({
					size: segment.ids.length,
					heap: heap(rowsOf(segment.reads)),
					r: segment.ids.reduce((sum, id) => sum + bounds.get(id)!, 0),
				})),
				roles: planned.items.map((status) => ({ id: status.account.id, roles: status.account.roles })),
			}
		})
		expect(result.same).toBe(true)
		// The setting row and the local scan, once.
		expect(result.lookups).toBe(2)
		expect(result.at).toHaveLength(1)
		expect(result.at[0]).toBeGreaterThan(0)
		expect(result.chunks.filter((chunk) => chunk.size > 1).length).toBeGreaterThan(1)
		for (const chunk of result.chunks) {
			expect(chunk.heap).toBeLessThanOrEqual(chunk.r)
		}
		expect(warn).not.toHaveBeenCalled()
		for (const { id, roles } of result.roles) {
			expect(roles).toEqual(
				id === f.viewer ? [{ id: '3', name: 'Owner', color: '' }] : f.locals.includes(id) ? [] : undefined
			)
		}
		expect(result.roles.some(({ roles }) => roles?.length === 1)).toBe(true)
		expect(result.roles.some(({ roles }) => roles === undefined)).toBe(true)
	}, 120_000)
})

// A local author below a remote top level: a boost's original, a quote's quoted status, a boost's original's quoted
// status. Each case on a cold Db (its own presentation, so a fresh memo), after one small remote status so that the
// chunk of the two is metered: its R must count the lookup the nested local author reads.
describe("the OAuth admin's lookup for a nested local author (RES-3)", () => {
	const cases: [string, Item][] = [
		['a remote boost of a local status', { ...TINY, kind: 'boost', originalLocal: true }],
		['a remote quote of a local status', { ...TINY, kind: 'quote', quotedLocal: true }],
		['a remote boost of a remote quote of a local status', { ...TINY, kind: 'boostOfQuote', quotedLocal: true }],
	]
	it.each(cases)(
		'counts it for %s',
		async (_name, item) => {
			const { h, f } = await fixture({ admin: true })
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const result = await runInDurableObject(h.store, (_instance, state) => {
				const ids = [build(state.storage.sql, f, TINY), build(state.storage.sql, f, item)]
				const bounds = boundsOf(state, f.viewer, ids, 1)
				const planned = observedPresentation(state, f.viewer, ids, PAGE_CHUNKS)
				const [segment] = planned.segments
				const nested = planned.items[1]!
				const shown = item.kind === 'quote' ? nested : nested.reblog!
				const author = item.kind === 'boost' ? shown.account : (shown.quote as Quote).quoted_status!.account
				return {
					segments: planned.segments.map((s) => s.ids.length),
					lookups: segment!.reads.filter((read) => read.query.includes(selectSql(LOCAL_EMAIL_COLUMNS))).length,
					heap: heap(rowsOf(segment!.reads)),
					r: ids.reduce((sum, id) => sum + bounds.get(id)!, 0),
					top: nested.account.roles,
					author: { id: author.id, roles: author.roles },
				}
			})
			// One metered chunk of both, which reads the lookup.
			expect(result.segments).toEqual([2])
			expect(result.lookups).toBe(1)
			expect(result.heap).toBeLessThanOrEqual(result.r)
			expect(warn).not.toHaveBeenCalled()
			expect(result.top).toBeUndefined()
			expect(f.locals).toContain(result.author.id)
			expect(result.author.roles).toEqual(result.author.id === f.viewer ? [{ id: '3', name: 'Owner', color: '' }] : [])
		},
		120_000
	)
})

describe('a page of many small rows (RES-3)', () => {
	it('plans 40 boosts of statuses with 200 mentions and 70 hashtags without the backstop', async () => {
		const { h, f } = await fixture()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const result = await runInDurableObject(h.store, (_instance, state) => {
			const item: Item = {
				kind: 'boost',
				text: 50,
				wide: false,
				mentions: 200,
				tags: 70,
				media: 0,
				poll: 0,
				viewer: false,
			}
			const ids = Array.from({ length: 40 }, () => build(state.storage.sql, f, item))
			const bounds = boundsOf(state, f.viewer, ids, 1)
			const planned = observedPresentation(state, f.viewer, ids, PAGE_CHUNKS)
			const whole = observedPresentation(state, f.viewer, ids, ids.length)
			return {
				same: JSON.stringify(planned.items) === JSON.stringify(whole.items),
				chunks: planned.segments.map((s) => ({
					size: s.ids.length,
					heap: heap(rowsOf(s.reads)),
					r: s.ids.reduce((sum, id) => sum + bounds.get(id)!, 0),
				})),
			}
		})
		expect(result.same).toBe(true)
		expect(result.chunks.length).toBeGreaterThan(1)
		for (const chunk of result.chunks) {
			expect(chunk.heap).toBeLessThanOrEqual(chunk.r)
			expect(chunk.r).toBeLessThanOrEqual(PAGE_CHUNKS.target)
		}
		expect(warn).not.toHaveBeenCalled()
		console.info(`R ÷ meter, many small rows: ${result.chunks.map((c) => (c.r / c.heap).toFixed(3)).join(', ')}`)
	}, 120_000)
})

describe('the hydrate queries (RES-3)', () => {
	// Every kind of row the presenter reads: quotes, boosts, polls with the viewer's votes, filter matches, mentions,
	// hashtags, media, the viewer's flags and the OAuth admin's lookup for a local author.
	async function rich(): Promise<{ h: ApiHarness; f: Fixture; ids: string[] }> {
		const { h, f } = await fixture({ admin: true })
		const base: Item = { kind: 'status', text: 300, wide: true, mentions: 3, tags: 5, media: 2, poll: 3, viewer: true }
		const ids = await runInDurableObject(h.store, (_instance, state) => [
			...(['status', 'quote', 'boost', 'boostOfQuote'] as const).map((kind) =>
				build(state.storage.sql, f, { ...base, kind })
			),
			build(state.storage.sql, f, { ...base, local: true }),
			...MOVED_KINDS.map((moved) => build(state.storage.sql, f, { ...base, moved })),
		])
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

	// The moved-to account of an author, each of its columns past every stored bound (an imported row): what leaves
	// SQLite is within the caps its row heap rests on (MOVED_ACCOUNT_CAPS), in UTF-16 code units as RowMeter counts them.
	it('read a moved-to account within its declared caps, whatever the row stores', async () => {
		const { h, f } = await fixture()
		const measured = await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			const id = build(sql, f, { ...TINY, moved: 'remote' })
			const target = sql
				.exec<{ t: string }>(
					'SELECT a.moved_to_account_id AS t FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?',
					id
				)
				.one().t
			// The largest each column stores: 64 KiB of malformed UTF-8 (F0, then continuation bytes: one character to
			// SQLite's length and substr, so the display name's stored cut keeps it whole), an actor id and username of 64
			// KiB (read-time projections only), URLs at their stored bound and a full emoji snapshot.
			const malformed = new Uint8Array([0xf0, ...new Array<number>(64 * 1024).fill(0x80)]).buffer
			const url = `https://new.example/${'x'.repeat(PROFILE_URL_LIMIT - 'https://new.example/'.length)}`
			sql.exec(
				`UPDATE accounts SET uri = ?2, username = CAST(?3 AS TEXT), display_name = CAST(?3 AS TEXT), url = ?4,
					avatar_url = ?4, header_url = ?4, created_at = CAST(?3 AS TEXT), actor_type = ?5,
					followers_count = 9223372036854775807, emojis = ?6 WHERE id = ?1`,
				target,
				`https://new.example/${'u'.repeat(64 * 1024)}`,
				malformed,
				url,
				'T'.repeat(64 * 1024),
				ACCOUNT_EMOJIS_FULL
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES (?, ?, ?, 'public', '', CAST(? AS TEXT))`,
				nextId(),
				`https://new.example/s/${target}`,
				target,
				malformed
			)
			const read = observedPresentation(state, f.viewer, [id], PAGE_CHUNKS).reads.filter((r) =>
				r.query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns))
			)
			return read.flatMap((r) => r.rows)
		})
		expect(measured).toHaveLength(1)
		const [row] = measured
		for (const [column, value] of Object.entries(row!)) {
			const units = typeof value === 'string' ? value.length : 0
			expect(units, column).toBeLessThanOrEqual(MOVED_ACCOUNT_CAPS[column as keyof typeof MOVED_ACCOUNT_CAPS])
		}
		expect(heap(measured)).toBeLessThanOrEqual(MOVED_ACCOUNT_COLUMNS.rowHeap)
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
				temp.filter(
					(detail) =>
						detail !== 'USE TEMP B-TREE FOR DISTINCT' &&
						// Own votes are sorted by id: ids and choices only, no payload.
						!(detail === 'USE TEMP B-TREE FOR ORDER BY' && query.includes(selectSql(OWN_VOTE_COLUMNS.columns)))
				),
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

	// The ordinary page: 40 short posts, every other one a quote, with a hashtag, a mention and typical emoji (3
	// Misskey-shaped ones per status, 2 per author).
	const ordinary = (emojis: Item['emojis']): Item[] =>
		Array.from({ length: 40 }, (_, i) => ({
			kind: i % 2 === 0 ? 'quote' : 'status',
			text: 200,
			wide: false,
			mentions: 1,
			tags: 1,
			media: 0,
			poll: 0,
			viewer: false,
			emojis,
		}))
	const misskeyShaped = (n: number) =>
		JSON.stringify(
			Array.from({ length: n }, (_, i) => [
				`emoji_${String(i).padStart(10, '0')}`,
				`https://media.misskey.example/files/${crypto.randomUUID()}.webp`,
			])
		)

	it('read an ordinary page of 40 statuses in one chunk of at most 13 queries', async () => {
		const { h, f } = await fixture()
		const counts = await runInDurableObject(h.store, (_instance, state) => {
			const items = ordinary({ status: misskeyShaped(3), author: misskeyShaped(2) })
			const ids = items.map((item) => build(state.storage.sql, f, item))
			const plain = ordinary(undefined).map((item) => build(state.storage.sql, f, item))
			const planned = observedPresentation(state, f.viewer, ids, PAGE_CHUNKS)
			const sum = (of: string[]) => [...boundsOf(state, f.viewer, of, 1).values()].reduce((a, b) => a + b, 0)
			return {
				queries: planned.reads.length,
				chunks: planned.segments.length,
				sum: sum(ids),
				plain: sum(plain),
				shown: planned.items.map((status) => status.emojis.length),
			}
		})
		console.info(`R of the ordinary page: ${counts.sum} for 40 statuses, ${counts.plain} without emoji`)
		expect(counts.shown).toEqual(Array.from({ length: 40 }, () => 3))
		expect(counts.chunks).toBe(1)
		expect(counts.queries).toBeLessThanOrEqual(13)
	})

	// The same page with every status and author at the stored emoji caps: one window of R (40 of R_WINDOW's 80) whose
	// chunks each stay within the target, as few as the target allows, of the ordinary page's kinds of query, with the
	// backstop never fired.
	it('read a saturated page of 40 statuses in planned chunks', async () => {
		const { h, f } = await fixture()
		const warn = vi.spyOn(console, 'warn')
		const result = await runInDurableObject(h.store, (_instance, state) => {
			const plain = ordinary(undefined).map((item) => build(state.storage.sql, f, item))
			const one = observedPresentation(state, f.viewer, plain, PAGE_CHUNKS)
			const items = ordinary({ status: STATUS_EMOJIS_FULL, author: ACCOUNT_EMOJIS_FULL })
			const ids = items.map((item) => build(state.storage.sql, f, item))
			const planned = observedPresentation(state, f.viewer, ids, PAGE_CHUNKS)
			const bounds = boundsOf(state, f.viewer, ids, 1)
			return {
				oneChunk: { queries: one.reads.length, chunks: one.segments.length },
				queries: planned.reads.length,
				windows: planned.reads.filter((read) => read.query === statusRowBoundSql()).length,
				chunks: planned.segments.map((segment) => segment.ids.reduce((sum, id) => sum + bounds.get(id)!, 0)),
				bounds: [...bounds.values()],
				ids: planned.segments.flatMap((segment) => segment.ids),
				expected: ids,
			}
		})
		const { target } = PAGE_CHUNKS
		const max = Math.max(...result.bounds)
		const sum = result.bounds.reduce((a, b) => a + b, 0)
		console.info(
			`R of the saturated page: ${sum} for 40 statuses, at most ${max} each, in ${result.chunks.length} chunks of ${result.chunks.join(', ')}`
		)
		expect(result.ids).toEqual(result.expected)
		expect(result.oneChunk.chunks).toBe(1)
		expect(result.windows).toBe(1)
		expect(max).toBeLessThan(target)
		for (const chunk of result.chunks) {
			expect(chunk).toBeLessThanOrEqual(target)
		}
		// A chunk closes only when the next status would pass the target, so each but the last holds more than
		// target − R_max.
		expect(result.chunks.length).toBeLessThanOrEqual(1 + Math.floor(sum / (target - max)))
		expect(result.queries).toBeLessThanOrEqual(result.windows + result.chunks.length * (result.oneChunk.queries - 1))
		expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.presenter.row-cap-exceeded' }))
	}, 120_000)
})

// The chunk target's cost depends on the workload: a page whose statuses each take a little more than half the target
// pairs no two of them. 80 statuses of R between 352 KiB and 384 KiB (a 111 KB post with 200 mentions) pair at
// 768 KiB, 40 hydrations, and stand alone at PAGE_CHUNKS' 704 KiB, 80 hydrations. Each hydration's statements run in
// the same Store operation (no Store RPC more), and R's one query a window is unchanged; a chunk of one is read without
// a RowMeter. The figures, logged, are what docs/threat-model.md quotes.
describe('the chunk target at its threshold workload (RES-3)', () => {
	const AT_768: ChunkPlan = { target: 768 * 1024, cap: 768 * 1024 }
	const LOW = 352 * 1024
	const HIGH = 384 * 1024

	it('hydrates 80 statuses just past half of 704 KiB one at a time, and in pairs at 768 KiB', async () => {
		const { h, f } = await fixture()
		const warn = vi.spyOn(console, 'warn')
		const result = await runInDurableObject(h.store, (_instance, state) => {
			const item = (text: number): Item => ({
				kind: 'status',
				text,
				wide: false,
				mentions: MAX_STATUS_MENTION_ROWS,
				tags: 0,
				media: 0,
				poll: 0,
				viewer: false,
			})
			const r = (text: number) => {
				const id = build(state.storage.sql, f, item(text))
				return boundsOf(state, f.viewer, [id], 1).get(id)!
			}
			// The longest text whose R is at most the window's middle (R grows with the text).
			const middle = (LOW + HIGH) / 2
			let [low, high] = [0, 120_000]
			while (low < high) {
				const text = Math.ceil((low + high) / 2)
				if (r(text) <= middle) {
					low = text
				} else {
					high = text - 1
				}
			}
			const ids = Array.from({ length: 80 }, () => build(state.storage.sql, f, item(low)))
			const bounds = [...boundsOf(state, f.viewer, ids, 1).values()]
			const visible = ids as VisibleStatusId[]
			const options = { origin: ORIGIN, viewer: { accountId: f.viewer, now: VIEWER_NOW } }
			// The page as an answer presents it, unobserved: its presentation, then its statuses.
			const present = (plan: ChunkPlan) => {
				const db = new Db(state.storage.sql)
				return presentStatusesWithin(db, presentation(db, visible, options), visible, Infinity, true, plan).items
			}
			const counted = (plan: ChunkPlan) => {
				const observed = observedPresentation(state, f.viewer, ids, plan)
				return {
					chunks: observed.segments.length,
					queries: observed.reads.length,
					windows: observed.reads.filter((read) => read.query === statusRowBoundSql()).length,
					items: observed.items.length,
				}
			}
			// Alternate runs, so neither plan gains from the other's warm cache; the mean of each.
			const ms = { at704: 0, at768: 0 }
			const RUNS = 10
			for (let i = 0; i < RUNS; i++) {
				for (const [name, plan] of [
					['at704', PAGE_CHUNKS],
					['at768', AT_768],
				] as const) {
					const start = performance.now()
					expect(present(plan)).toHaveLength(80)
					ms[name] += (performance.now() - start) / RUNS
				}
			}
			return {
				text: low,
				bounds,
				at704: { ...counted(PAGE_CHUNKS), ms: ms.at704 },
				at768: { ...counted(AT_768), ms: ms.at768 },
			}
		})
		for (const bound of result.bounds) {
			expect(bound).toBeGreaterThan(LOW)
			expect(bound).toBeLessThanOrEqual(HIGH)
		}
		expect(PAGE_CHUNKS).toEqual({ target: 704 * 1024, cap: 704 * 1024 })
		expect([result.at704.chunks, result.at768.chunks]).toEqual([80, 40])
		expect([result.at704.items, result.at768.items]).toEqual([80, 80])
		expect([result.at704.windows, result.at768.windows]).toEqual([1, 1])
		// Each hydration runs the same statements: twice the chunks, about twice the statements.
		const perChunk = (r: typeof result.at704) => (r.queries - r.windows) / r.chunks
		expect(perChunk(result.at704)).toBeLessThanOrEqual(perChunk(result.at768))
		expect(result.at704.ms).toBeGreaterThan(0)
		expect(result.at768.ms).toBeGreaterThan(0)
		console.info(
			`Threshold workload: 80 statuses of R ${Math.min(...result.bounds)} to ${Math.max(...result.bounds)} (text ${result.text}); ` +
				`704 KiB: ${result.at704.chunks} chunks, ${result.at704.queries} statements, ${result.at704.ms.toFixed(1)} ms; ` +
				`768 KiB: ${result.at768.chunks} chunks, ${result.at768.queries} statements, ${result.at768.ms.toFixed(1)} ms`
		)
		expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.presenter.row-cap-exceeded' }))
	}, 300_000)
})

describe('the order of the rows of a status (RES-3)', () => {
	it('shows hashtags, attachments, mentions and own votes in the order SQLite gave them', async () => {
		const { h, f } = await fixture()
		const shown = await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			const id = build(sql, f, {
				kind: 'status',
				text: 10,
				wide: false,
				mentions: 0,
				tags: 0,
				media: 0,
				poll: 0,
				viewer: false,
			})
			const author = sql
				.exec<{ account_id: string }>('SELECT account_id FROM statuses WHERE id = ?', id)
				.one().account_id
			// Hashtags by UTF-8 bytes: U+FFE0 before U+20000, which UTF-16 code units order the other way.
			for (const name of ['\u{20000}b', '\uffe0a', 'zc', 'Ab']) {
				sql.exec('INSERT INTO status_tags (status_id, name, public) VALUES (?, ?, 1)', id, name)
			}
			// Attachments by position, then id: two at position 0, written with the higher id first.
			const media = [nextId(), nextId(), nextId()]
			for (const [mediaId, position] of [
				[media[2]!, 0],
				[media[1]!, 1],
				[media[0]!, 0],
			] as const) {
				sql.exec(
					`INSERT INTO media_attachments (id, account_id, status_id, position, type, url)
					VALUES (?, ?, ?, ?, 'image', 'https://remote.example/m.png')`,
					mediaId,
					author,
					id,
					position
				)
			}
			// Mentions by account id, written in another order.
			for (const account of [f.mentioned[2]!, f.mentioned[0]!, f.mentioned[1]!]) {
				sql.exec(
					'INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id) VALUES (?, ?, 0, 0, ?)',
					id,
					account,
					author
				)
			}
			// Own votes in the order they were cast, not by choice.
			sql.exec(
				`INSERT INTO polls (status_id, options, tallies, multiple, votes_count, voters_count, expires_at)
				VALUES (?, '["a","b","c"]', '[1,1,1]', 1, 3, 1, ?)`,
				id,
				new Date(NOW + 86_400_000).toISOString()
			)
			for (const choice of [2, 0, 1]) {
				sql.exec(
					'INSERT INTO poll_votes (poll_id, account_id, choice, generation, created_at) VALUES (?, ?, ?, 0, ?)',
					id,
					f.viewer,
					choice,
					VIEWER_NOW
				)
			}
			const [status] = observedPresentation(state, f.viewer, [id], PAGE_CHUNKS).items
			return {
				tags: status!.tags.map((tag) => tag.name),
				media: status!.media_attachments.map((attachment) => attachment.id),
				mentions: status!.mentions.map((mention) => mention.id),
				votes: status!.poll?.own_votes,
				expected: { media: [media[0], media[2], media[1]], mentions: f.mentioned.slice(0, 3) },
			}
		})
		expect(shown.tags).toEqual(['Ab', 'zc', '\uffe0a', '\u{20000}b'])
		expect(shown.media).toEqual(shown.expected.media)
		expect(shown.mentions).toEqual(shown.expected.mentions)
		expect(shown.votes).toEqual([2, 0, 1])
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

	it("shows no attachments, mentions, hashtags or poll of its own, and its original's in its reblog", async () => {
		const { h, f } = await fixture()
		const item: Item = { kind: 'boost', text: 10, wide: false, mentions: 2, tags: 2, media: 2, poll: 2, viewer: true }
		const shown = await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			const boost = build(sql, f, item)
			const present = () => observedPresentation(state, f.viewer, [boost], PAGE_CHUNKS).items[0]!
			const before = present()
			const bound = () => boundsOf(state, f.viewer, [boost], 1).get(boost)
			const boundBefore = bound()
			// The boost row's own attachment, mention, hashtag and poll, as a converted row may hold them.
			const author = sql.exec<{ a: string }>('SELECT account_id AS a FROM statuses WHERE id = ?', boost).one().a
			sql.exec(
				`INSERT INTO media_attachments (id, account_id, status_id, position, type, url)
				VALUES (?, ?, ?, 0, 'image', 'https://remote.example/own.png')`,
				nextId(),
				author,
				boost
			)
			sql.exec(
				`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
				VALUES (?, ?, 0, 0, ?)`,
				boost,
				f.mentioned[0],
				author
			)
			sql.exec("INSERT INTO status_tags (status_id, name, public) VALUES (?, 'own', 1)", boost)
			sql.exec(
				`INSERT INTO polls (status_id, options, tallies, multiple, votes_count, voters_count, expires_at)
				VALUES (?, '["a","b"]', '[0,0]', 0, 0, 0, ?)`,
				boost,
				new Date(NOW + 86_400_000).toISOString()
			)
			return { before, after: present(), boundBefore, boundAfter: bound() }
		})
		expect(shown.after).toMatchObject({ media_attachments: [], mentions: [], tags: [], poll: null })
		expect(shown.after.reblog).toEqual(shown.before.reblog)
		expect(shown.before.reblog).toMatchObject({ media_attachments: [{}, {}], tags: [{}, {}] })
		expect(shown.after).toEqual(shown.before)
		// R counts no rows the presenter does not read.
		expect(shown.boundAfter).toBe(shown.boundBefore)
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
				abandoned: { ids: abandoned!.ids, heap: heap(rows) },
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

describe('query ceilings of grouped notifications (RES-3)', () => {
	it('a page of 80 groups reads its statuses in planned chunks', async () => {
		const { h, f } = await fixture()
		await sql(h.store, 'DELETE FROM filter_keywords')
		const tokenHash = await sha256Hex(f.token)
		const counted = await runInDurableObject(h.store, (_instance, state) => {
			const real = state.storage.sql
			// 80 favourite groups, each of one of alice's own statuses (a group's status is the owner's), by remote
			// accounts.
			for (let i = 0; i < 80; i++) {
				const id = nextId()
				real.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, 'public', '<p>mine</p>', ?)`,
					id,
					`https://kopje.test/ap/o/${id}`,
					f.viewer,
					VIEWER_NOW
				)
				real.exec(
					`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, group_key)
					VALUES (?, 'favourite', ?, ?, ?, ?)`,
					f.viewer,
					f.mentioned[i]!,
					id,
					VIEWER_NOW,
					`favourite-${id}`
				)
			}
			const { sql: counting, reads } = recordingSql(real)
			const result = listGroupedNotifications.run(counting, {
				credential: { tokenHash, scope: 'read:notifications', now: NOW },
				page: { limit: 80 },
				types: [],
				excludeTypes: [],
				groupedTypes: null,
				includeFiltered: false,
				expandAccounts: 'partial_avatars',
				present: { origin: ORIGIN },
			} as never)
			let answer = result as Record<string, unknown>
			while (answer.status === 'ok' && 'value' in answer) {
				answer = answer.value as Record<string, unknown>
			}
			return {
				groups: (answer.notification_groups as unknown[]).length,
				// The presenter's reads but its authors': R and the hydrate queries, each by its map's select list (the
				// sample accounts of each group are read by the account map too, apart from the statuses).
				queries: reads.filter(
					(query) =>
						query === statusRowBoundSql() ||
						Object.entries(hydrateQueries()).some(
							([name, columns]) => name !== 'accounts' && query.includes(selectSql(columns))
						)
				).length,
				...planCounts(reads),
			}
		})
		expect(counted.groups).toBe(80)
		// One window of R and one chunk of 80 small statuses (LARGE_ITEM_CHUNKS), where a chunk of one read each status
		// apart, about 9 queries each.
		expect(counted.windows).toBe(1)
		expect(counted.chunks).toBe(1)
		expect(counted.queries).toBeLessThanOrEqual(12)
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
		const { sql: counting, reads } = recordingSql(state.storage.sql)
		statusContext.run(counting, {
			credential: { tokenHash, scope: 'read:statuses', now: NOW },
			id: root,
			present: { origin: ORIGIN },
			now: NOW,
		} as never)
		return { queries: reads.length, ...planCounts(reads) }
	})
}

describe('stale statistics (RES-7)', () => {
	// The aliases a presentation's statements give the tables that grow (statuses, accounts, media, polls, votes, filter
	// rules): R names its CTEs t, x and k, which no scan of a table may hide behind, so each list is the statement's own.
	const presentationAliases = (query: string): string[] =>
		query.includes('filter_keywords k')
			? ['k']
			: [
					's',
					'b',
					'w',
					'o',
					'a',
					'au',
					'm',
					'y',
					'v',
					'p',
					'fs',
					'ms',
					// The moved-to accounts' local rows (accounts.ts movedOf).
					'ml',
					// The visibility rule's account lookups (audience.ts).
					'pa',
					'pc',
					'pda',
					'pha',
					'pn',
					...(query.includes('media_attachments x') ? ['x'] : []),
					...(query.includes('statuses t ') ? ['t'] : []),
				]

	// The visibility rule's account lookups whose aliases are also CTE names in the same statements (ps, pv), or not
	// (pa), each by its named index: one search at least wherever the statement reads it.
	function expectVisibilityLookups(query: string, plan: readonly string[]): void {
		for (const [named, search] of [
			['main.accounts pa ', 'SEARCH pa USING INDEX accounts_deleted (id=?)'],
			['main.accounts ps ', 'SEARCH ps USING INDEX accounts_suspended (id=?)'],
			['main.accounts pv ', 'SEARCH pv USING INDEX sqlite_autoindex_accounts_1 (id=?)'],
		] as const) {
			if (query.includes(named)) {
				expect(plan, `${query}\n${plan.join('\n')}`).toContain(search)
			}
		}
	}

	// Every statement a presentation runs (filters, R, the graph, the hydrate queries), with its plan and rows read.
	function plannedPresentation(state: DurableObjectState, viewer: string, ids: readonly string[]) {
		const plans: PlannedStatement[] = []
		const db = new Db(plannedSql(state.storage.sql, /./, plans))
		const options = { origin: ORIGIN, viewer: { accountId: viewer, now: VIEWER_NOW } }
		const visible = ids as VisibleStatusId[]
		const { items } = presentStatusesWithin(
			db,
			presentation(db, visible, options),
			visible,
			Infinity,
			true,
			PAGE_CHUNKS
		)
		return { items, plans }
	}

	// The graph's two arms, read by key, against the one statement they replace (an OR that the planner may only scan):
	// the same rows for any answer, its ids repeated, boosts of one original, originals among the ids, and originals the
	// viewer may not see (from an author they do not follow, or by direct message to someone else).
	it('reads the rows the OR of the statuses and their visible originals read', async () => {
		const h = await community(['alice'])
		const viewer = h.users.alice.id
		const pool = await runInDurableObject(h.store, (_instance, state) => {
			const real = state.storage.sql
			const authors = [nextId(), nextId()]
			for (const [i, author] of authors.entries()) {
				real.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'remote.example')",
					author,
					`https://remote.example/users/a${i}`,
					`a${i}`
				)
			}
			real.exec(
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				viewer,
				authors[0]!
			)
			const ids: string[] = []
			for (const [i, visibility] of ['public', 'private', 'direct', 'unlisted'].entries()) {
				for (const author of authors) {
					const original = nextId()
					real.exec(
						`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
						VALUES (?, ?, ?, ?, '<p>o</p>', ?)`,
						original,
						`https://remote.example/objects/${original}`,
						author,
						visibility,
						VIEWER_NOW
					)
					ids.push(original)
					for (let boost = 0; boost <= i % 2; boost++) {
						const id = nextId()
						real.exec(
							`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
							VALUES (?, ?, ?, ?, 'public', ?)`,
							id,
							`https://remote.example/announces/${id}`,
							authors[(boost + 1) % 2]!,
							original,
							VIEWER_NOW
						)
						ids.push(id)
					}
				}
			}
			return ids
		})
		const oracle = `SELECT s.id FROM ${STATUS_FROM}
			WHERE s.id IN (SELECT value FROM json_each(?1))
			OR (s.id IN (SELECT reblog_of_id FROM statuses WHERE id IN (SELECT value FROM json_each(?1)) AND reblog_of_id IS NOT NULL)
				AND ${visibleSql('s', '?2')})`
		await fc.assert(
			fc.asyncProperty(fc.array(fc.constantFrom(...pool), { minLength: 1, maxLength: 24 }), async (ids) => {
				const { read, expected } = await runInDurableObject(h.store, (_instance, state) => {
					const reads: Read[] = []
					const observed = {
						exec: (query: string, ...params: SqlStorageValue[]) => {
							const read: Read = { query, params, rows: [] }
							reads.push(read)
							return watchedCursor(
								state.storage.sql.exec(query, ...params),
								() => {},
								(rows) => read.rows.push(...rows)
							)
						},
					} as unknown as SqlStorage
					const db = new Db(observed)
					const options = { origin: ORIGIN, viewer: { accountId: viewer, now: VIEWER_NOW } }
					const visible = ids as VisibleStatusId[]
					presentStatusesWithin(db, presentation(db, visible, options), visible, Infinity, true, ids.length)
					const graph = reads.filter((r) => r.query.includes('b.reblog_of_id AS value'))
					expect(graph).toHaveLength(1)
					const [json, account] = graph[0]!.params
					return {
						read: graph[0]!.rows.map((row) => row.id as string),
						expected: state.storage.sql
							.exec<{ id: string }>(oracle, json!, account!)
							.toArray()
							.map((row) => row.id),
					}
				})
				expect(read.toSorted()).toEqual(expected.toSorted())
			}),
			runs(50)
		)
	}, 120_000)

	// Statistics taken while the Store holds one account besides the viewer's and one poll: the author and poll lookups
	// of the presentation and of R still seek by key once thousands of others arrive.
	it('seeks authors and polls by key, statistics taken with one author and one poll', async () => {
		const h = await community(['alice'])
		const viewer = h.users.alice.id
		const f: Fixture = { viewer, token: h.users.alice.token, mentioned: [], filter: nextId(), locals: [viewer] }
		await sql(
			h.store,
			"INSERT INTO filters (id, account_id, title, context, action) VALUES (?, ?, 'f', '[\"public\"]', 'warn')",
			f.filter,
			viewer
		)
		// A boost of a quote: the boost, its original and the quoted status, all by the one author, and one poll.
		const base: Item = {
			kind: 'boostOfQuote',
			text: 10,
			wide: false,
			mentions: 0,
			tags: 0,
			media: 0,
			poll: 2,
			viewer: true,
		}
		const ids = await runInDurableObject(h.store, (_instance, state) => [build(state.storage.sql, f, base)])
		// The original's poll alone (its votes with it): the quoted status's goes.
		await sql(h.store, 'DELETE FROM polls WHERE status_id <> (SELECT reblog_of_id FROM statuses WHERE id = ?)', ids[0]!)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM polls')).toEqual([{ n: 1 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM accounts WHERE id <> ?', viewer)).toEqual([{ n: 1 }])
		const { before, after } = await staleStatistics(h, {
			capture: () => runInDurableObject(h.store, (_instance, state) => plannedPresentation(state, viewer, ids)),
			grow: async () => {
				await remoteAccounts(h, 100, 200)
				// Other accounts' statuses with polls.
				await sql(
					h.store,
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(CAST(id AS INTEGER) + 100000000000000000 AS TEXT), uri || '/s', id, 'public', '', ?1 FROM accounts
					WHERE domain LIKE 'd%.example'`,
					VIEWER_NOW
				)
				await sql(
					h.store,
					`INSERT INTO polls (status_id, options, tallies) SELECT id, '["a","b"]', '[0,0]' FROM statuses WHERE uri LIKE '%/s'`
				)
			},
		})
		expect(after.items).toEqual(before.items)
		const bound = after.plans.find((p) => p.query === statusRowBoundSql())!.plan
		expect(bound).toContain('SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)')
		expect(
			bound.filter((detail) => /^SEARCH p USING INDEX sqlite_autoindex_polls_1 \(status_id=\?\)$/.test(detail))
		).not.toHaveLength(0)
		for (const p of after.plans.filter((p) => p.query.includes('b.reblog_of_id AS value'))) {
			expect(
				p.plan.filter((detail) =>
					/^SEARCH au USING (COVERING )?INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/.test(detail)
				)
			).toHaveLength(1)
		}
		for (const [i, { query, plan, rows }] of after.plans.entries()) {
			expect(scansOf(plan, presentationAliases(query)), `${query}\n${plan.join('\n')}`).toEqual([])
			expectVisibilityLookups(query, plan)
			expect(rows - before.plans[i]!.rows, `${query}\n${plan.join('\n')}`).toBeLessThanOrEqual(1)
		}
	}, 60_000)

	// The OAuth admin's lookup for a local author (oauthAdmin) and its term in R scan only the operator-sized
	// local_accounts, each account sought by key, once accounts outgrow the statistics.
	it("seeks the OAuth admin's accounts by key after the Store grows past its statistics", async () => {
		const { h, f } = await fixture({ admin: true })
		const ids = await runInDurableObject(h.store, (_instance, state) => [
			build(state.storage.sql, f, { ...TINY, local: true }),
			build(state.storage.sql, f, TINY),
		])
		const { before, after } = await staleStatistics(h, {
			capture: () => runInDurableObject(h.store, (_instance, state) => plannedPresentation(state, f.viewer, ids)),
			grow: () => remoteAccounts(h, 100, 200),
		})
		expect(after.items).toEqual(before.items)
		const lookups = after.plans.filter((p) => p.query.includes(selectSql(LOCAL_EMAIL_COLUMNS)))
		expect(lookups).toHaveLength(1)
		const bound = after.plans.find((p) => p.query === statusRowBoundSql())!
		for (const { query, plan } of [...lookups, bound]) {
			expect(plan, `${query}\n${plan.join('\n')}`).toContain('SCAN l')
			expect(plan, `${query}\n${plan.join('\n')}`).toContain('SEARCH a USING INDEX sqlite_autoindex_accounts_1 (id=?)')
			expect(scansOf(plan, ['a', 'i']), `${query}\n${plan.join('\n')}`).toEqual([])
		}
		for (const [i, { query, plan, rows }] of after.plans.entries()) {
			expect(rows - before.plans[i]!.rows, `${query}\n${plan.join('\n')}`).toBeLessThanOrEqual(ids.length)
		}
	}, 120_000)

	it('reads statuses, media, votes and filters by key after the Store grows past its statistics', async () => {
		const { h, f } = await fixture()
		const base: Item = { kind: 'status', text: 300, wide: true, mentions: 3, tags: 5, media: 2, poll: 3, viewer: true }
		// Every kind four times: 16 statuses, past the filter text level's allowance, so its preparation pass runs too;
		// of each kind one by an author moved to a remote account and one moved to a local one.
		const kinds = ['status', 'quote', 'boost', 'boostOfQuote'] as const
		const moves = [{ moved: 'remote' }, { moved: 'local' }, {}, {}] as const
		const ids = await runInDurableObject(h.store, (_instance, state) =>
			kinds.flatMap((kind) => moves.map((moved) => build(state.storage.sql, f, { ...base, kind, ...moved })))
		)
		const other = await seedAccount(h.store, { username: 'bob', email: 'bob@example.com' })
		// Statistics of a small Store, not taken again after it grows.
		const { before, after } = await staleStatistics(h, {
			capture: () => runInDurableObject(h.store, (_instance, state) => plannedPresentation(state, f.viewer, ids)),
			grow: async () => {
				await runInDurableObject(h.store, (_instance, state) => {
					const real = state.storage.sql
					// Unrelated statuses of every kind with their accounts, attachments, mentions, hashtags and polls.
					for (let i = 0; i < 400; i++) {
						build(real, f, { ...base, viewer: false, kind: kinds[i % 4]! })
					}
					// Other voters of the presented polls, and earlier generations of the viewer's own votes.
					real.exec(
						`INSERT INTO poll_votes (poll_id, account_id, choice, generation, created_at)
						SELECT p.status_id, a.id, 0, 0, ?1 FROM polls p CROSS JOIN accounts a
						WHERE p.status_id IN (SELECT value FROM json_each(?2)) AND a.domain IS NOT NULL AND a.id <> ?3`,
						VIEWER_NOW,
						JSON.stringify(ids),
						f.viewer
					)
					real.exec(
						`UPDATE polls SET generation = 1 WHERE status_id IN (SELECT poll_id FROM poll_votes WHERE account_id = ?1)`,
						f.viewer
					)
					real.exec(
						`INSERT INTO poll_votes (poll_id, account_id, choice, generation, created_at)
						SELECT poll_id, account_id, choice, 1, created_at FROM poll_votes WHERE account_id = ?1`,
						f.viewer
					)
					// Another user's filters, with keywords and statuses.
					for (let i = 0; i < 200; i++) {
						const filter = nextId()
						real.exec(
							"INSERT INTO filters (id, account_id, title, context, action) VALUES (?, ?, 'f', '[\"public\"]', 'warn')",
							filter,
							other
						)
						for (let k = 0; k < 5; k++) {
							real.exec(
								"INSERT INTO filter_keywords (id, filter_id, keyword, whole_word) VALUES (?, ?, 'other', 0)",
								nextId(),
								filter
							)
						}
						real.exec(
							`INSERT INTO filter_statuses (id, filter_id, status_id)
							SELECT ?1, ?2, id FROM statuses ORDER BY id DESC LIMIT 1`,
							nextId(),
							filter
						)
					}
				})
			},
		})
		expect(after.items).toEqual(before.items)
		expect(after.plans.map((p) => p.query)).toEqual(before.plans.map((p) => p.query))
		for (const [i, { query, plan, rows }] of after.plans.entries()) {
			expect(scansOf(plan, presentationAliases(query)), `${query}\n${plan.join('\n')}`).toEqual([])
			expectVisibilityLookups(query, plan)
			// Rows read stay flat as the Store grows: at most the entry past a range, where one now follows it.
			expect(rows - before.plans[i]!.rows, `${query}\n${plan.join('\n')}`).toBeLessThanOrEqual(ids.length)
		}
		const graph = after.plans.filter((p) => p.query.includes('b.reblog_of_id AS value'))
		// The presentation's graph and the filter text level's preparation pass.
		expect(graph).toHaveLength(2)
		for (const { plan } of graph) {
			expect(plan).toContain('SEARCH b USING INDEX sqlite_autoindex_statuses_1 (id=?)')
			expect(plan).toContain('SEARCH s USING INDEX sqlite_autoindex_statuses_1 (id=?)')
		}
		const bound = after.plans.find((p) => p.query === statusRowBoundSql())!.plan
		expect(bound).toContain('SEARCH b USING INDEX sqlite_autoindex_statuses_1 (id=?)')
		expect(bound).toContain('SEARCH w USING INDEX sqlite_autoindex_statuses_1 (id=?)')
		// M's moved-to account, sought by its key.
		expect(bound).toContain('SEARCH m USING INDEX sqlite_autoindex_accounts_1 (id=?)')
		const moved = after.plans.filter((p) => p.query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns)))
		expect(moved).toHaveLength(1)
		expect(moved[0]!.plan).toContain('SEARCH m USING INDEX sqlite_autoindex_accounts_1 (id=?)')
		expect(bound).toContain('SEARCH m USING INDEX sqlite_autoindex_media_attachments_1 (id=?)')
		expect(bound).toContain(
			'SEARCH v USING COVERING INDEX sqlite_autoindex_poll_votes_1 (poll_id=? AND generation=? AND account_id=?)'
		)
	}, 120_000)
})
