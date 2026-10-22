import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import {
	followed,
	followersOn,
	localAccounts,
	type Measure,
	measure,
	measureInput,
	remoteAccountsOn,
	reportsOf,
} from './admin-measure-helpers'
import { sql } from './api-helpers'
import { longestString, observedSql, plannedRun, rowsRead, scansOf, type SqlRow, staleStatistics } from './read-helpers'
import { world, type World } from './remote-suspension-helpers'
import { dashboardGranted } from '../src/domain/admin-domain-blocks'
import {
	adminMeasure,
	dayNumber,
	MEASURE_DAYS,
	MEASURE_DOMAINS,
	MEASURE_ROWS,
	type MeasureInput,
	measurePeriod,
	type MeasurePeriod,
	SERVED_MEASURES,
	type ServedMeasure,
	walkOf,
	type WalkedMeasure,
	walkSql,
} from '../src/domain/admin-measures'

// The measure walks' bounds (RES-7; domain/admin-measures.ts): each walk's cap on raw candidates (AM1), its plan
// under statistics older than the Store's growth, with no Bloom filter on follows (AM9), and the rows a measure and a
// whole request read at saturation against the approved budget (AM10).

const WALK = new RegExp(`LIMIT ${MEASURE_ROWS + 1}\\)`)
const DAY_NS = 86_400_000_000_000n

const at = (date: string) => ({ date: dayNumber(date), ns: BigInt(dayNumber(date)) * DAY_NS })

function periodOf(start: string, end: string): MeasurePeriod {
	const period = measurePeriod(at(start), at(end))
	if (period === 'too_long') {
		throw new Error('too long')
	}
	return period
}

const WALKED = SERVED_MEASURES.filter((key): key is WalkedMeasure => key !== 'instance_media_attachments')

// The walk's statement as SQLite compiles it: its plan and the opcodes of a Bloom filter (FilterAdd, Filter).
async function compiled(w: World, key: WalkedMeasure, includeSubdomains: boolean) {
	return runInDurableObject(w.h.store, (_instance, state) => {
		const query = walkSql(walkOf(key, includeSubdomains))
		const params = ['d.example', includeSubdomains ? 1 : 0, '2026-10-01', '2026-10-02', 1]
		return {
			plan: state.storage.sql
				.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
				.toArray()
				.map((row) => row.detail),
			bloom: state.storage.sql
				.exec<{ opcode: string }>(`EXPLAIN ${query}`, ...params)
				.toArray()
				.filter((row) => row.opcode === 'FilterAdd' || row.opcode === 'Filter').length,
		}
	})
}

async function input(w: World, key: ServedMeasure, extra: Partial<MeasureInput> = {}) {
	return measureInput(w, { key, domain: 'd.example', includeSubdomains: false, period: null, ...extra })
}

// The walk statement's rows read and the result.
async function walked(w: World, key: ServedMeasure, extra: Partial<MeasureInput> = {}) {
	const run = await plannedRun(w.h, WALK, adminMeasure, await input(w, key, extra))
	expect(run.plans).toHaveLength(1)
	return { result: run.result, rows: run.plans[0]!.rows, plan: run.plans[0]!.plan }
}

const tooMany = (rows: string) => ({ status: 'ok', value: { status: 'too_many', rows } })

describe('the walks under stale statistics (RES-7, AM9)', () => {
	it('plan every walk by its index with no Bloom filter, its reads flat as unrelated rows grow', async () => {
		const w = await world()
		await localAccounts(w, 5, '2026-10-01T00:00:00.000Z')
		await followed(w, w.alice.id, 1, 'd.example')
		await followersOn(w, w.alice.id, 1, 'd.example')
		const base = await remoteAccountsOn(w, 1, 'sub.d.example')
		await reportsOf(w, 1, w.alice.id, String(base + 1).padStart(18, '0'), '2026-10-01T00:00:00.000Z')
		const capture = async () => {
			const out: Record<string, { rows: number; plan: string[]; bloom: number }> = {}
			for (const key of WALKED) {
				for (const includeSubdomains of [false, true]) {
					const run = await walked(w, key, { includeSubdomains, period: periodOf('2026-10-01', '2026-10-02') })
					out[`${key} ${includeSubdomains}`] = {
						rows: run.rows,
						plan: run.plan,
						bloom: (await compiled(w, key, includeSubdomains)).bloom,
					}
				}
			}
			return out
		}
		const { before, after } = await staleStatistics(w.h, {
			capture,
			// Rows no walk reads: remote accounts' follows of each other's domain (stored by an import), accounts on
			// another domain, and remote reporters' reports are not grown here (every report is a candidate).
			grow: async () => {
				const far = await remoteAccountsOn(w, 100_001, 'far.example')
				await sql(
					w.h.store,
					`INSERT INTO follows (account_id, target_account_id, state)
					SELECT a.id, b.id, 'accepted' FROM accounts a CROSS JOIN accounts b ON b.id = printf('%018d', CAST(a.id AS INTEGER) + 1)
					WHERE a.domain = 'far.example' AND a.id > printf('%018d', ?1) AND a.id < printf('%018d', ?1 + 100001)`,
					far
				)
			},
		})
		for (const [name, run] of Object.entries(after)) {
			expect(run.bloom, name).toBe(0)
			expect(run.plan.join(' | '), name).not.toContain('BLOOM')
			// The tables are searched by key or by an index range; only the candidates' own roots are scanned.
			expect(scansOf(run.plan, ['f', 'a', 'follows', 'accounts', 'k']), name).toEqual([])
			// Each statement reads what it read before the growth, give or take the peers' one more domain.
			expect(run.rows, name).toBeLessThanOrEqual(before[name]!.rows + 4)
		}
	}, 120_000)

	it('cap instance_follows and instance_followers after a store grown past ANALYZE, which a Bloom filter would not', async () => {
		const w = await world()
		await localAccounts(w, 995, '2026-10-01T00:00:00.000Z')
		await followed(w, w.alice.id, 1, 'd.example')
		await followersOn(w, w.alice.id, 1, 'd.example')
		await sql(w.h.store, 'ANALYZE')
		await followed(w, w.bob.id, 100_001, 'big.example')
		await followersOn(w, w.bob.id, 100_001, 'fans.example')
		// The walk this PR replaced (follows_accepted with its state term) builds a Bloom filter on follows here: a loop
		// over every follow before the cap.
		const replaced = await runInDurableObject(w.h.store, (_instance, state) => {
			const query = `SELECT count(*) FROM (SELECT f.created_at FROM local_accounts l
				CROSS JOIN follows f INDEXED BY follows_accepted ON f.account_id = l.account_id AND f.state = 'accepted'
				CROSS JOIN accounts a ON a.id = f.target_account_id LIMIT ${MEASURE_ROWS + 1})`
			const cursor = state.storage.sql.exec(query)
			cursor.toArray()
			const plan = state.storage.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`).toArray()
			return { rows: cursor.rowsRead, plan: plan.map((row) => row.detail).join(' | ') }
		})
		expect(replaced.plan).toContain('BLOOM FILTER ON f')
		expect(replaced.rows).toBeGreaterThan(200_000)
		for (const key of ['instance_follows', 'instance_followers'] as const) {
			const run = await walked(w, key)
			expect(run.result).toEqual(tooMany('follows'))
			expect(run.plan.join(' | ')).not.toContain('BLOOM')
			expect((await compiled(w, key, false)).bloom).toBe(0)
			// Each local account's probe, then three rows per candidate (index entry and row, the other side by key,
			// the co-routine's row).
			expect(run.rows).toBeLessThanOrEqual(1_000 + 3 * (MEASURE_ROWS + 1))
		}
	}, 120_000)
})

describe('the walks stop at MEASURE_ROWS raw candidates (AM1)', () => {
	it('new_users: the local accounts', async () => {
		const w = await world()
		await localAccounts(w, MEASURE_ROWS - 5, '2026-10-01T12:00:00.000Z')
		const period = periodOf('2026-10-01', '2026-10-02')
		expect((await walked(w, 'new_users', { period })).result).toMatchObject({
			value: { status: 'ok', measure: { total: MEASURE_ROWS - 5 } },
		})
		await localAccounts(w, 1, '2026-10-01T12:00:00.000Z')
		const beyond = await walked(w, 'new_users', { period })
		expect(beyond.result).toEqual(tooMany('accounts'))
		await localAccounts(w, 5_000, '2026-10-01T12:00:00.000Z')
		expect((await walked(w, 'new_users', { period })).rows).toBe(beyond.rows)
		expect(beyond.rows).toBeLessThanOrEqual(2 * (MEASURE_ROWS + 1))
	}, 120_000)

	it('reports: unresolved reports count toward resolved_reports, other domains toward instance_reports', async () => {
		const w = await world()
		const base = await remoteAccountsOn(w, 2, 'd.example')
		const other = await remoteAccountsOn(w, 1, 'other.example')
		const id = (n: number) => String(n).padStart(18, '0')
		await reportsOf(w, MEASURE_ROWS - 2, w.alice.id, id(other + 1), '2026-10-01T12:00:00.000Z')
		await reportsOf(w, 2, w.alice.id, id(base + 1), '2026-10-01T12:00:00.000Z', '2026-10-01T13:00:00.000Z')
		const period = periodOf('2026-10-01', '2026-10-02')
		const totals = async () =>
			Promise.all(
				(['opened_reports', 'resolved_reports', 'instance_reports'] as const).map(
					async (key) => (await walked(w, key, { period })).result
				)
			)
		expect(await totals()).toMatchObject([
			{ value: { measure: { total: MEASURE_ROWS } } },
			{ value: { measure: { total: 2 } } },
			{ value: { measure: { total: 2 } } },
		])
		await reportsOf(w, 1, w.alice.id, w.bob.id, '2026-10-01T12:00:00.000Z')
		expect(await totals()).toEqual([tooMany('reports'), tooMany('reports'), tooMany('reports')])
		const rows = (await walked(w, 'instance_reports', { period })).rows
		await reportsOf(w, 5_000, w.alice.id, w.bob.id, '2026-10-01T12:00:00.000Z')
		expect((await walked(w, 'instance_reports', { period })).rows).toBe(rows)
		expect(rows).toBeLessThanOrEqual(3 * (MEASURE_ROWS + 1))
	}, 120_000)

	it('instance_accounts: deleted accounts are candidates; subdomains share one cap', async () => {
		const w = await world()
		const base = await remoteAccountsOn(w, MEASURE_ROWS, 'd.example')
		await sql(
			w.h.store,
			"UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE domain = 'd.example' AND id <> ?",
			String(base + 1).padStart(18, '0')
		)
		expect((await walked(w, 'instance_accounts')).result).toMatchObject({ value: { measure: { total: 1 } } })
		await remoteAccountsOn(w, 1, 'd.example')
		await sql(
			w.h.store,
			"UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE domain = 'd.example' AND deleted_at IS NULL AND id <> ?",
			String(base + 1).padStart(18, '0')
		)
		expect((await walked(w, 'instance_accounts')).result).toEqual(tooMany('accounts'))
		// Under several domains: each under the cap, together past it.
		await remoteAccountsOn(w, MEASURE_ROWS / 2, 'a.e.example')
		await remoteAccountsOn(w, MEASURE_ROWS / 2, 'b.e.example')
		const e = { domain: 'e.example', includeSubdomains: true }
		expect((await walked(w, 'instance_accounts', e)).result).toMatchObject({
			value: { measure: { total: MEASURE_ROWS } },
		})
		expect((await walked(w, 'instance_accounts', { domain: 'a.e.example' })).result).toMatchObject({
			value: { measure: { total: MEASURE_ROWS / 2 } },
		})
		await remoteAccountsOn(w, 1, 'c.e.example')
		expect((await walked(w, 'instance_accounts', e)).result).toEqual(tooMany('accounts'))
	}, 120_000)

	it(`instance_accounts: the skip-scan visits at most ${MEASURE_DOMAINS} domains, matching or not`, async () => {
		const w = await world()
		await remoteAccountsOn(w, 1, 'd.example')
		const known = async () =>
			(
				await sql<{ n: number }>(w.h.store, 'SELECT count(DISTINCT domain) AS n FROM accounts WHERE domain IS NOT NULL')
			)[0]!.n
		const pad = async (n: number) =>
			sql(
				w.h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT printf('%018d', 8000000000000 + ?2 + i), 'https://p' || (?2 + i) || '.example/u', 'u', 'p' || (?2 + i) || '.example' FROM n`,
				n,
				await known()
			)
		await pad(MEASURE_DOMAINS - (await known()))
		expect(await known()).toBe(MEASURE_DOMAINS)
		const sub = { includeSubdomains: true }
		const atCap = await walked(w, 'instance_accounts', sub)
		expect(atCap.result).toMatchObject({ value: { measure: { total: 1 } } })
		await pad(1)
		const beyond = await walked(w, 'instance_accounts', sub)
		expect(beyond.result).toEqual(tooMany('domains'))
		expect(
			await measure(w, {
				keys: ['instance_accounts'],
				instance_accounts: { domain: 'd.example', include_subdomains: true },
			})
		).toEqual({
			status: 422,
			body: { error: `too many domains to search (more than ${MEASURE_DOMAINS}); the total is not known` },
		})
		await pad(5_000)
		expect((await walked(w, 'instance_accounts', sub)).rows).toBe(beyond.rows)
		// The exact domain reads its own range only.
		expect((await walked(w, 'instance_accounts')).rows).toBeLessThan(10)
	}, 120_000)

	it('instance_followers: pending requests are candidates', async () => {
		const w = await world()
		await followersOn(w, w.alice.id, MEASURE_ROWS - 1, 'd.example')
		await followersOn(w, w.bob.id, 1, 'd.example', 'pending')
		expect((await walked(w, 'instance_followers')).result).toMatchObject({
			value: { measure: { total: MEASURE_ROWS - 1 } },
		})
		await followersOn(w, w.carol.id, 1, 'other.example', 'pending')
		expect((await walked(w, 'instance_followers')).result).toEqual(tooMany('follows'))
		expect(await measure(w, { keys: ['instance_followers'], instance_followers: { domain: 'd.example' } })).toEqual({
			status: 422,
			body: { error: `too many follows to count (more than ${MEASURE_ROWS}); the total is not known` },
		})
	}, 120_000)
})

// ---- AM10: the rows a measure and a request read at saturation.

// The deployment assumption the OAuth admin's match rests on (admin-authority.ts oauthAdmin), approved for this bound.
const LOCALS = 1_000
// AM10's approved budgets, orchestrator 2026-10-22.
const KEY_BUDGET = 4 * (MEASURE_ROWS + 1) + MEASURE_DOMAINS + 2_000
const REQUEST_BUDGET = 700_000

// The rows each key reads at most, from the constants: the handler's authorization and the operation's (each the
// token, the admin_email row and every local account with its account by key: AUTH), and the walk: per candidate the
// co-routine's row and each row it reads (a follow walk's follow and other side, a report's target); a follow walk
// also reads each local account and its probe, empty or not; the skip-scan reads each domain's index entry and queue
// row, and the queue twice more (the matched domains and the domain count). The grouped buckets are not rows read.
// Each MEASURE_ROWS + 1: a walk reads one candidate past its cap.
const AUTH = 2 * LOCALS + 8
const R = MEASURE_ROWS + 1
const D = MEASURE_DOMAINS + 1
const WALK_ROWS: Record<ServedMeasure, number> = {
	new_users: 2 * Math.min(LOCALS, R),
	opened_reports: 2 * R,
	resolved_reports: 2 * R,
	instance_reports: 3 * R,
	instance_accounts: 2 * R + 4 * D,
	instance_follows: 2 * LOCALS + 3 * R,
	instance_followers: 2 * LOCALS + 3 * R,
	instance_media_attachments: 0,
}
const keyMaximum = (key: ServedMeasure) => 2 * AUTH + WALK_ROWS[key]
// A request of all eight keys: the handler's authorization once, each operation's own and its walk.
const requestMaximum = AUTH + SERVED_MEASURES.reduce((sum, key) => sum + AUTH + WALK_ROWS[key], 0)

describe('the rows a measure reads (AM6, AM10)', () => {
	it('derive each maximum from the constants within the approved budgets', () => {
		for (const key of SERVED_MEASURES) {
			expect(keyMaximum(key), key).toBeLessThanOrEqual(KEY_BUDGET)
		}
		expect(requestMaximum).toBeLessThanOrEqual(REQUEST_BUDGET)
	})

	it(`read at most each key's maximum with ${LOCALS} local accounts and every walk saturated, and the request too`, async () => {
		const w = await world()
		await localAccounts(w, LOCALS - 5, '2026-10-01T00:00:00.000Z')
		// The walks' candidates, each at MEASURE_ROWS: accounts on m.example and its subdomain, follows of
		// targets.example, followers on fans.example, reports of reported.example, dated over 800 days so every
		// bucket day is used.
		await remoteAccountsOn(w, MEASURE_ROWS / 2, 'm.example')
		await remoteAccountsOn(w, MEASURE_ROWS / 2, 'sub.m.example')
		const locals = (await sql<{ id: string }>(w.h.store, 'SELECT account_id AS id FROM local_accounts')).map(
			(r) => r.id
		)
		const share = Math.ceil(MEASURE_ROWS / locals.length)
		let left = MEASURE_ROWS
		for (const local of locals) {
			const n = Math.min(share, left)
			if (n === 0) {
				break
			}
			await followed(w, local, n, 'targets.example')
			await followersOn(w, local, n, 'fans.example')
			left -= n
		}
		const reported = await remoteAccountsOn(w, 1, 'reported.example')
		await reportsOf(w, MEASURE_ROWS, w.alice.id, String(reported + 1).padStart(18, '0'), '2026-01-01T00:00:00.000Z')
		const spread = (table: string, column: string, where = '1') =>
			sql(
				w.h.store,
				`UPDATE ${table} SET ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', '2025-01-01', '+' || (rowid % 800) || ' days')
					WHERE ${where}`
			)
		await spread('reports', 'created_at')
		await spread('reports', 'action_taken_at', 'rowid % 2 = 0')
		await spread('follows', 'created_at')
		await spread('accounts', 'created_at', 'domain IS NOT NULL')
		await spread('local_accounts', 'created_at')
		// The domains the skip-scan visits, matching or not: MEASURE_DOMAINS in all.
		const known = (
			await sql<{ n: number }>(w.h.store, 'SELECT count(DISTINCT domain) AS n FROM accounts WHERE domain IS NOT NULL')
		)[0]!.n
		await sql(
			w.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT printf('%018d', 8000000000000 + i), 'https://p' || i || '.example/u', 'u', 'p' || i || '.example' FROM n`,
			MEASURE_DOMAINS - known
		)
		await sql(w.h.store, 'ANALYZE')
		const start = '2025-10-01'
		const end = '2026-10-01'
		const period = periodOf(start, end)
		expect(period.axis).toHaveLength(MEASURE_DAYS)
		const domains: Record<string, string> = {
			instance_accounts: 'm.example',
			instance_follows: 'targets.example',
			instance_followers: 'fans.example',
			instance_reports: 'reported.example',
			instance_media_attachments: 'm.example',
		}
		const inputOf = async (key: ServedMeasure) =>
			input(w, key, { domain: domains[key] ?? null, includeSubdomains: true, period })
		const credential = (await inputOf('new_users')).credential
		const handlerAuth = await rowsRead(w.h, dashboardGranted, { credential })
		expect(handlerAuth).toBeGreaterThan(2 * LOCALS)
		expect(handlerAuth).toBeLessThanOrEqual(AUTH)
		const figures: Record<string, number> = {}
		let request = handlerAuth
		for (const key of SERVED_MEASURES) {
			const operation = await rowsRead(w.h, adminMeasure, await inputOf(key))
			// The buckets that leave SQLite: at most the days between the windows' ends and four more, each at most
			// 10 bytes and two integers.
			const buckets = await runInDurableObject(w.h.store, async (_instance, state) => {
				const rows: SqlRow[] = []
				const result = adminMeasure.run(
					observedSql(state.storage.sql, (seen, query) => {
						if (WALK.test(query)) {
							rows.push(...seen)
						}
					}),
					await inputOf(key)
				)
				return { rows, result }
			})
			expect(buckets.result, key).toMatchObject({ status: 'ok', value: { status: 'ok' } })
			expect(buckets.rows.length, key).toBeLessThanOrEqual(2 * MEASURE_DAYS + 8)
			expect(longestString(buckets.rows), key).toBeLessThanOrEqual(10)
			figures[key] = handlerAuth + operation
			request += operation
			expect(figures[key], key).toBeLessThanOrEqual(keyMaximum(key))
		}
		// The saturated walks read their maxima but the one candidate past the cap: the fixture is at the bound.
		for (const key of SERVED_MEASURES.filter((key) => key !== 'new_users')) {
			expect(figures[key], key).toBeGreaterThan(keyMaximum(key) - 100)
		}
		expect(request).toBeLessThanOrEqual(requestMaximum)
		expect(request).toBeGreaterThan(requestMaximum - 1_000)
		// The request itself: all eight keys, each computed once.
		const body: Record<string, unknown> = { keys: [...SERVED_MEASURES], start_at: start, end_at: end }
		for (const [key, domain] of Object.entries(domains)) {
			body[key] = { domain, include_subdomains: true }
		}
		const answer = await measure(w, body)
		expect(answer.status, JSON.stringify(answer.body).slice(0, 200)).toBe(200)
		expect((answer.body as Measure[]).map((m) => [m.key, m.data.length])).toEqual(
			SERVED_MEASURES.map((key) => [key, MEASURE_DAYS])
		)
	}, 300_000)
})
