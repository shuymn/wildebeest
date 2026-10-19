import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { answer, maximalAccounts } from './budget-helpers'
import { migratedStore } from './helpers'
import { observedSql, rowsRead, watchedCursor } from './read-helpers'
import { community, follow } from './status-helpers'
import { numbers, remoteAccountsSql, SUGGESTION_BASE } from './suggestion-fixtures'
import { ANSWER_BYTES } from '../src/domain/answer-budget'
import {
	SUGGESTION_EDGES,
	SUGGESTION_EDGES_PER_SOURCE,
	SUGGESTION_SOURCES,
	suggestions,
	SUGGESTIONS_KEPT,
} from '../src/domain/suggestions'
import type { StoreStub } from '../src/platform/store-client'

// RES-7 and RES-3 for follow suggestions (docs/visibility.md, "Read bounds"): the plan reads each window as a range of
// follows_following whatever the planner's statistics, the rows read grow below each window's bound and stay flat
// once the windows that apply are full, the work of judging every candidate is measured at its maximum, and the answer
// is at most SUGGESTIONS_KEPT accounts within ANSWER_BYTES.

const VIEWER = '900000000000000001'
const TOKEN = 'suggestion-bounds-token'
const credential = { tokenHash: TOKEN, scope: 'read', now: NOW } as const
const INPUT = { credential, version: 1 as const, offset: 0, limit: 80, present: { origin: 'https://kopje.test' } }
// How many rows a read may add where the work is meant to be flat: a few for a planner's choice.
const ALLOWANCE = 10
// The rows a request reads at most: the maximum case below measures 315,844 (docs/visibility.md, "Read bounds").
const SUGGESTION_ROWS = 330_000
// The statement that ranks the candidates.
const RANKING = /edges\(x\) AS/

type Sql = (query: string, ...params: SqlStorageValue[]) => void

// A Store with the viewer (local) and its token, and the accounts and follows `build` writes. Accounts are numbered:
// account i is a remote account (test/suggestion-fixtures.ts).
async function store(build: (run: Sql) => void): Promise<StoreStub> {
	const stub = await migratedStore()
	await runInDurableObject(stub, (_instance, state) => {
		const sql = state.storage.sql
		const run: Sql = (query, ...params) => {
			sql.exec(query, ...params)
		}
		run('INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)', VIEWER, 'https://kopje.test/ap/users/v', 'v')
		run(
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			VALUES (?, 'v@example.com', X'00', X'00', 'test')`,
			VIEWER
		)
		run(
			`INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes)
			VALUES ('bounds', 'secret', 'bounds', 'urn:ietf:wg:oauth:2.0:oob', 'read')`
		)
		run(
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'bounds', ?, 'read')",
			TOKEN,
			VIEWER
		)
		build(run)
	})
	return stub
}

const BASE = SUGGESTION_BASE
const n = numbers

// The viewer follows sources from..from + count - 1, in order. A converted Store holds the follows the cutover
// carried: no activity id and legacy's time, oldest first, as the converter writes them.
function followSources(run: Sql, from: number, count: number, converted = false): void {
	run(
		`${n(count)} INSERT INTO follows (account_id, target_account_id, state, uri, created_at)
		SELECT ?1, CAST(${BASE} + ${from} + i AS TEXT), 'accepted', ${converted ? 'NULL' : "'https://kopje.test/f/' || i"},
			${converted ? "'2023-01-01T00:00:00.000Z'" : "'2026-10-01T00:00:00.000Z'"} FROM n`,
		VIEWER
	)
}

// Each of the sources from..from + count - 1 follows `perSource` targets of its own, source after source: source k
// follows targets + k * perSource + j for j < perSource.
function edges(run: Sql, from: number, count: number, perSource: number, targets: number): void {
	run(
		`${n(count * perSource)} INSERT INTO follows (account_id, target_account_id, state)
		SELECT CAST(${BASE} + ${from} + i / ${perSource} AS TEXT), CAST(${BASE} + ${targets} + i AS TEXT), 'accepted'
		FROM n`
	)
}

// The graph of the growth cases: `older` sources followed first (converted follows, each with an edge to a candidate
// of its own), then `sources` sources, each following `perSource` distinct candidates; every account on `domain`
// with its actor id on `host`.
function graph(older: number, sources: number, perSource: number, where: { domain?: string; host?: string } = {}) {
	return (run: Sql) => {
		const candidates = older + sources
		run(remoteAccountsSql(0, candidates, where))
		run(remoteAccountsSql(candidates, Math.max(sources * perSource, older), where))
		followSources(run, 0, older, true)
		edges(run, 0, older, 1, candidates)
		followSources(run, older, sources)
		edges(run, older, sources, perSource, candidates)
	}
}

async function measure(stub: StoreStub): Promise<{ rows: number; shown: string[] }> {
	const output = await runInDurableObject(stub, (_instance, state) => suggestions.run(state.storage.sql, INPUT))
	const shown = output.status === 'ok' ? (output.value as { id: string }[]).map((a) => a.id) : []
	return { rows: await rowsRead({ store: stub }, suggestions, INPUT), shown }
}

const rowsOf = async (build: (run: Sql) => void) => measure(await store(build))

// The ranking statement's plan, as its rows (id, parent, detail), and the rows it reads.
async function plan(
	stub: StoreStub
): Promise<{ plan: { id: number; parent: number; detail: string }[]; rows: number }> {
	return runInDurableObject(stub, (_instance, state) => {
		const real = state.storage.sql
		const found: { plan: { id: number; parent: number; detail: string }[]; rows: number }[] = []
		const capturing = {
			exec: (query: string, ...params: SqlStorageValue[]) => {
				const cursor = real.exec(query, ...params)
				if (!RANKING.test(query)) {
					return cursor
				}
				const entry = {
					plan: real
						.exec<{ id: number; parent: number; detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
						.toArray(),
					rows: 0,
				}
				found.push(entry)
				return watchedCursor(cursor, () => (entry.rows += cursor.rowsRead))
			},
		} as unknown as SqlStorage
		suggestions.run(capturing, INPUT)
		expect(found).toHaveLength(1)
		return found[0] ?? { plan: [], rows: 0 }
	})
}

// The plan guard: the sources and each source's edges are ranges of follows_following from the bound a scalar lookup
// finds, and nothing below the edges co-routine sorts them (the availability predicate's DISTINCT B-trees are its own).
function expectRanges(rows: { id: number; parent: number; detail: string }[]): void {
	const details = rows.map((row) => row.detail)
	expect(details).toContain('SEARCH f USING INDEX follows_following (account_id=? AND id>?)')
	expect(details).toContain('SEARCH e USING INDEX follows_following (account_id=? AND id>?)')
	expect(details.filter((detail) => /\b(SCAN|SEARCH) (f|e)\b/.test(detail))).toHaveLength(2)
	const root = rows.find((row) => /^(CO-ROUTINE|MATERIALIZE) edges$/.test(row.detail))
	expect(root).toBeDefined()
	const below = new Set([root?.id])
	for (const row of rows) {
		if (below.has(row.parent)) {
			below.add(row.id)
		}
	}
	const sorters = rows.filter((row) => below.has(row.id) && /TEMP B-TREE FOR (ORDER BY|RIGHT PART)/.test(row.detail))
	expect(sorters).toEqual([])
}

describe('suggestions read their windows as ranges (RES-7)', () => {
	it('keeps the plan with fresh statistics and with statistics taken before a source grew', async () => {
		const fresh = await store(graph(0, 3, 5))
		await sql(fresh, 'ANALYZE')
		expectRanges((await plan(fresh)).plan)
		// Statistics of a small Store, then one source grows to 100,001 follows without them being taken again.
		const stale = await store(graph(0, 3, 5))
		await sql(stale, 'ANALYZE')
		expect((await sql(stale, "SELECT stat FROM sqlite_stat1 WHERE idx = 'follows_following'")).length).toBe(1)
		await runInDurableObject(stale, (_instance, state) => {
			const run: Sql = (query, ...params) => void state.storage.sql.exec(query, ...params)
			run(remoteAccountsSql(1_000, 100_001, { discoverable: 0 }))
			edges(run, 0, 1, 100_001, 1_000)
		})
		const grown = await plan(stale)
		expectRanges(grown.plan)
		expect(grown.rows).toBeLessThanOrEqual((await plan(fresh)).rows + 2 * SUGGESTION_EDGES_PER_SOURCE + ALLOWANCE)
	}, 120_000)
})

describe('suggestions read rows within their windows (RES-7)', () => {
	it('read more below each bound', async () => {
		const grows: [string, (run: Sql) => void, (run: Sql) => void][] = [
			['sources', graph(0, 10, 1), graph(0, SUGGESTION_SOURCES, 1)],
			['edges of a source', graph(0, 1, 10), graph(0, 1, SUGGESTION_EDGES_PER_SOURCE)],
			[
				'saturated sources',
				graph(0, 10, SUGGESTION_EDGES_PER_SOURCE),
				graph(0, SUGGESTION_EDGES / SUGGESTION_EDGES_PER_SOURCE, SUGGESTION_EDGES_PER_SOURCE),
			],
		]
		for (const [name, few, many] of grows) {
			const [a, b] = [await rowsOf(few), await rowsOf(many)]
			expect([name, b.rows > a.rows, b.shown.length]).toEqual([name, true, SUGGESTIONS_KEPT])
		}
	}, 300_000)

	it('read the same rows past them, converted follows included', async () => {
		const saturated = SUGGESTION_EDGES / SUGGESTION_EDGES_PER_SOURCE
		const flat: [string, (run: Sql) => void, (run: Sql) => void, number][] = [
			// One source's follows past its edge window.
			['follows of a source', graph(0, 1, SUGGESTION_EDGES_PER_SOURCE), graph(0, 1, 100_000), 0],
			// The viewer's follows past the source window, the newest saturated sources the same.
			[
				'sources',
				graph(SUGGESTION_SOURCES - saturated, saturated, SUGGESTION_EDGES_PER_SOURCE),
				graph(2 * SUGGESTION_SOURCES - saturated, saturated, SUGGESTION_EDGES_PER_SOURCE),
				0,
			],
			// Saturated sources past the global cutoff: the walk stops at the cutoff, and only the lookup of the source
			// window's bound reads more, one index entry per source up to SUGGESTION_SOURCES.
			[
				'saturated sources',
				graph(0, saturated, SUGGESTION_EDGES_PER_SOURCE),
				graph(SUGGESTION_SOURCES - saturated, saturated, SUGGESTION_EDGES_PER_SOURCE),
				SUGGESTION_SOURCES - saturated,
			],
		]
		const grown: string[] = []
		for (const [name, few, many, lookup] of flat) {
			const [a, b] = [await rowsOf(few), await rowsOf(many)]
			expect([name, b.shown.length]).toEqual([name, a.shown.length])
			if (b.rows > a.rows + lookup + ALLOWANCE) {
				grown.push(`${name}: ${a.rows} -> ${b.rows}`)
			}
		}
		expect(grown).toEqual([])
	}, 600_000)

	it('judges every candidate, however many the viewer hides, within the measured maximum', async () => {
		// The graph stays; only how many of its candidates the viewer mutes changes.
		const sources = SUGGESTION_EDGES / 10
		const muted = async (count: number) =>
			rowsOf((run) => {
				graph(0, sources, 10)(run)
				run(
					`${n(count)} INSERT INTO mutes (account_id, target_account_id)
					SELECT ?1, CAST(${BASE} + ${sources} + i AS TEXT) FROM n`,
					VIEWER
				)
			})
		const measured = []
		for (const count of [0, 10, 200, 2_000, SUGGESTION_EDGES]) {
			measured.push({ count, ...(await muted(count)) })
		}
		// Each candidate is judged once, hidden or not: a hidden one reads at most its mute's entry more.
		for (const { count, rows, shown } of measured) {
			expect([count, rows - (measured[0]?.rows ?? 0) <= count * 2 + ALLOWANCE]).toEqual([count, true])
			expect(shown).toHaveLength(Math.min(SUGGESTIONS_KEPT, SUGGESTION_EDGES - count))
		}
		console.log(JSON.stringify({ judged: measured.map(({ count, rows }) => ({ count, rows })) }))
	}, 600_000)

	it('reads at most SUGGESTION_ROWS at its maximum', async () => {
		// Every window full of distinct candidates, each judged through every term of R12 (none hidden, so no term
		// stops early), every account on a domain of the most labels an instance block walks with its actor id on
		// another such host (two keys to walk), and a suspend block on the instance that names neither, so each source
		// and each candidate walks every suffix of both keys; each account keeps a stale domain mark (R38: read by the
		// availability seek, then its row), the viewer's mute of each candidate has expired (read, then passed), and
		// the viewer blocks other domains.
		const sources = SUGGESTION_SOURCES
		const where = { domain: 'a.b.c.d.e.f.g.example', host: 'h.b.c.d.e.f.g.example' }
		const { rows, shown } = await rowsOf((run) => {
			graph(0, sources, SUGGESTION_EDGES / sources, where)(run)
			run(
				`INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
				VALUES ('elsewhere.example', 'suspend', 'x', 'x')`
			)
			run(`${n(100)} INSERT INTO domain_blocks (account_id, domain) SELECT ?1, 'd' || i || '.example' FROM n`, VIEWER)
			run(
				`UPDATE accounts SET suspended_at = '2026-01-01T00:00:00.000Z', suspension_source = 'domain'
				WHERE id >= '${BASE}'`
			)
			run(
				`${n(SUGGESTION_EDGES)} INSERT INTO mutes (account_id, target_account_id, expires_at)
				SELECT ?1, CAST(${BASE} + ${sources} + i AS TEXT), '2026-01-01T00:00:00.000Z' FROM n`,
				VIEWER
			)
		})
		console.log(JSON.stringify({ maximum: rows }))
		expect(shown).toHaveLength(SUGGESTIONS_KEPT)
		expect(rows).toBeLessThanOrEqual(SUGGESTION_ROWS)
	}, 300_000)
})

describe('the answer of suggestions (RES-3)', () => {
	it('returns at most SUGGESTIONS_KEPT ids from the ranking, each one row', async () => {
		const stub = await store(graph(0, 1, 100))
		const returned = await runInDurableObject(stub, (_instance, state) => {
			const rows: Record<string, SqlStorageValue>[][] = []
			const observing = observedSql(state.storage.sql, (seen, query) => {
				if (RANKING.test(query)) {
					rows.push([...seen])
				}
			})
			suggestions.run(observing, INPUT)
			return rows
		})
		expect(returned).toHaveLength(1)
		expect(returned[0]).toHaveLength(SUGGESTIONS_KEPT)
		expect(returned[0]?.every((row) => Object.keys(row).join() === 'id' && typeof row.id === 'string')).toBe(true)
	})

	it('answers SUGGESTIONS_KEPT accounts at their bounds within ANSWER_BYTES, in each version', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const ids = await maximalAccounts(h, 'suggested', SUGGESTIONS_KEPT)
		await sql(
			h.store,
			'UPDATE accounts SET discoverable = 1 WHERE id IN (SELECT value FROM json_each(?))',
			JSON.stringify(ids)
		)
		await follow(h, alice, bob.id)
		await sql(
			h.store,
			`INSERT INTO follows (account_id, target_account_id, state)
			SELECT ?, value, 'accepted' FROM json_each(?) ORDER BY key`,
			bob.id,
			JSON.stringify(ids)
		)
		for (const path of ['/api/v1/suggestions', '/api/v2/suggestions']) {
			const answered = await answer<unknown[]>(h, path, alice.token)
			expect([path, answered.status, answered.body.length]).toEqual([path, 200, SUGGESTIONS_KEPT])
			expect(answered.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		}
	}, 300_000)
})
