import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ApiHarness, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { freshStore } from './helpers'
import { runs } from './policy-world'
import {
	boundsOf,
	build,
	type Fixture,
	fixture,
	type Item,
	nextId,
	observedPresentation,
	planCounts,
	recordingSql,
	ORIGIN,
	heap,
	rowsOf,
	VIEWER_NOW,
} from './status-row-fixtures'
import { selectSql } from '../src/db/columns'
import { Db, rowHeapBytes, RowMeter } from '../src/db/sql'
import { ACCOUNT_COLUMN_MAP } from '../src/domain/accounts'
import { listGroupedNotifications } from '../src/domain/notification-groups'
import { OWN_VOTE_COLUMNS, POLL_COLUMN_MAP } from '../src/domain/polls'
import { MAX_REMOTE_OPTIONS, MAX_STATUS_MENTION_ROWS } from '../src/domain/status-bounds'
import { type ChunkPlan, PAGE_CHUNKS } from '../src/domain/status-presenter'
import { hydrateQueries, PER_ROW_SORTS, statusRowBoundSql } from '../src/domain/status-rows'
import { statusContext } from '../src/domain/statuses'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

// RES-3, "Heap at 8 MiB per answer" in docs/threat-model.md: statusStream reads an answer's statuses in chunks planned
// by R (status-rows.ts), a bound of the heap each status's rows take as RowMeter counts it, generated from the column
// maps of the queries that read them; the meter caps each chunk, and a chunk past it (a fault in R) is read again one
// status at a time.
// The chunks never change the answer.

const itemArb = fc.record({
	kind: fc.constantFrom('status', 'quote', 'boost', 'boostOfQuote'),
	text: fc.integer({ min: 0, max: 40_000 }),
	wide: fc.boolean(),
	mentions: fc.integer({ min: 0, max: MAX_STATUS_MENTION_ROWS }),
	tags: fc.integer({ min: 0, max: 80 }),
	media: fc.integer({ min: 0, max: 5 }),
	poll: fc.integer({ min: 0, max: MAX_REMOTE_OPTIONS }),
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
	it("is at least the meter's count of each status alone and of each chunk, for mixed sizes", async () => {
		const { h, f } = await fixture()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const small: ChunkPlan = { target: 256 * 1024, cap: 256 * 1024 }
		await fc.assert(
			fc.asyncProperty(fc.array(itemArb, { minLength: 1, maxLength: 12 }), async (items) => {
				const result = await runInDurableObject(h.store, (_instance, state) => {
					// Two small statuses first, so each plan reads a chunk of several.
					const tiny: Item = {
						kind: 'status',
						text: 10,
						wide: false,
						mentions: 0,
						tags: 0,
						media: 0,
						poll: 0,
						viewer: false,
					}
					const ids = [tiny, tiny, ...items].map((item) => build(state.storage.sql, f, item))
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
