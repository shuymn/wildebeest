import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { observedSql, plannedRun, scansOf, staleStatistics } from './read-helpers'
import { act, world, type World } from './remote-suspension-helpers'
import { community, remoteAccount } from './status-helpers'
import { Db } from '../src/db/sql'
import { writeOperation } from '../src/domain/operation'
import { sweepStaleVotes } from '../src/domain/polls'
import { remoteModerationRound } from '../src/domain/remote-suspension'
import { resolveSuspensionReports } from '../src/domain/reports'
import { moderationRound, REPORT_ROUND } from '../src/domain/suspension'

// RES-7: the cron's and the moderation jobs' bounded writes seek what they write by key, with statistics taken before
// the Store grew: the stale-vote sweep (polls.ts) and a suspension's report resolution (reports.ts).

const AT = new Date(NOW).toISOString()

describe('the stale-vote sweep with stale statistics (RES-7)', () => {
	const sweep = writeOperation<{ limit: number }, number>((db, { limit }) => sweepStaleVotes(db, limit))

	// A stale poll of `status` at generation 1 with `old` votes of generation 0 and one current one.
	async function stalePoll(h: Awaited<ReturnType<typeof community>>, status: string, voter: string, old: number) {
		await sql(
			h.store,
			`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'public', '<p>p</p>', ?3)`,
			status,
			voter,
			AT
		)
		await sql(
			h.store,
			`INSERT INTO polls (status_id, options, tallies, generation, stale) VALUES (?, '["x","y"]', '[0,0]', 1, 1)`,
			status
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO poll_votes (poll_id, account_id, choice, generation)
			SELECT ?1, ?2, i % 100, CASE WHEN i = ?3 THEN 1 ELSE 0 END FROM n`,
			status,
			voter,
			old
		)
	}

	it("deletes each poll's old votes by key within the limit, other polls' votes grown after ANALYZE", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await stalePoll(h, '300000000000000001', alice.id, 3)
		await stalePoll(h, '300000000000000002', alice.id, 3)
		const { before, after } = await staleStatistics(h, {
			capture: (phase) => plannedRun(h, /poll_votes/, sweep, { limit: phase === 'before' ? 2 : 4 }),
			grow: async () => {
				// The current votes of many other polls, which are not stale.
				for (let p = 0; p < 200; p++) {
					const status = String(310000000000000000n + BigInt(p))
					await sql(
						h.store,
						`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
						VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'public', '<p>p</p>', ?3)`,
						status,
						alice.id,
						AT
					)
					await sql(h.store, `INSERT INTO polls (status_id, options, tallies) VALUES (?, '["x","y"]', '[0,0]')`, status)
					await sql(
						h.store,
						`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
						INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?1, ?2, i FROM n`,
						status,
						alice.id
					)
				}
			},
		})
		// The limit holds: two of the first poll's three, then its last and the second poll's three.
		expect([before.result, after.result]).toEqual([2, 4])
		expect(
			await sql(
				h.store,
				"SELECT count(*) AS n FROM poll_votes WHERE poll_id LIKE '30000000000000000_' AND generation = 0"
			)
		).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM polls WHERE stale = 1')).toEqual([{ n: 0 }])
		const deletes = after.plans.filter((p) => p.query.startsWith('DELETE'))
		expect(deletes).toHaveLength(4)
		for (const { query, plan, rows } of after.plans) {
			expect(scansOf(plan, ['poll_votes', 'polls']), query).toEqual([])
			// A vote's key, or one entry past the poll's old generation in the key index.
			expect(rows, query).toBeLessThanOrEqual(5)
		}
		for (const { plan } of deletes) {
			expect(plan).toEqual(['SEARCH poll_votes USING INTEGER PRIMARY KEY (rowid=?)'])
		}
	}, 60_000)
})

describe("a suspension's report resolution with stale statistics (RES-7)", () => {
	const resolve = writeOperation<{ target: string }, unknown>((db, { target }) =>
		resolveSuspensionReports(db, target, '999999999999999999', 0, null, '0', 100, AT)
	)

	it("stamps each frozen report by key, other accounts' reports grown after ANALYZE", async () => {
		const h = await community(['alice'])
		const targets = [await remoteAccount(h.store, 'one'), await remoteAccount(h.store, 'two')]
		for (const target of targets) {
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2)
				INSERT INTO reports (account_id, target_account_id, uri, created_at)
				SELECT ?1, ?2, 'https://r.example/' || ?2 || '/' || i, ?3 FROM n`,
				h.users.alice.id,
				target,
				AT
			)
		}
		const other = await remoteAccount(h.store, 'other')
		const { before, after } = await staleStatistics(h, {
			capture: (phase) =>
				plannedRun(h, /^\s*UPDATE reports/, resolve, { target: targets[phase === 'before' ? 0 : 1]! }),
			grow: () =>
				sql(
					h.store,
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 20000 - 1)
					INSERT INTO reports (account_id, target_account_id, uri, created_at)
					SELECT ?1, ?2, 'https://r.example/other/' || i, ?3 FROM n`,
					h.users.alice.id,
					other,
					AT
				),
		})
		expect(after.result).toMatchObject({ read: 3, resolved: 3 })
		expect(before.result).toMatchObject({ read: 3, resolved: 3 })
		expect(
			await sql(h.store, 'SELECT count(*) AS n FROM reports WHERE action_taken_at IS NOT NULL AND last_action_id = 0')
		).toEqual([{ n: 6 }])
		expect(after.plans).toHaveLength(3)
		for (const [i, { plan, rows }] of after.plans.entries()) {
			expect(plan).toEqual(['SEARCH reports USING INTEGER PRIMARY KEY (rowid=?)'])
			expect(rows).toBe(before.plans[i]!.rows)
		}
	}, 60_000)
})

describe('report ids past 2^53 through both suspension jobs (VIS-29)', () => {
	// 2 * REPORT_ROUND + 6 reports of `target` with ids from below 2^53 up, so each round's last report and the bound are
	// past it and odd: as JS numbers 9007199254740995 and 9007199254741095 round up (the next report skipped) and the
	// bound 9007199254741101 rounds down (the newest left out). Every seventh is last stamped after the suspension
	// (fence-excluded).
	const BASE = 9007199254740896n
	const COUNT = 2 * REPORT_ROUND + 6
	async function reportsOf(w: World, target: string) {
		await sql(
			w.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?4 - 1)
			INSERT INTO reports (id, account_id, target_account_id, uri, created_at, last_action_id)
			SELECT CAST(?3 AS INTEGER) + i, ?1, ?2, 'https://r.example/big/' || i, ?5, CASE WHEN i % 7 = 3 THEN 999999999 END
			FROM n`,
			w.bob.id,
			target,
			String(BASE),
			COUNT,
			AT
		)
	}
	// Each report as [id, resolved], in id order, by its decimal id.
	const resolved = (w: World, target: string) =>
		sql<{ id: string; resolved: number }>(
			w.h.store,
			`SELECT CAST(id AS TEXT) AS id, action_taken_at IS NOT NULL AS resolved FROM reports
			WHERE target_account_id = ? ORDER BY reports.id`,
			target
		)
	const expected = Array.from({ length: COUNT }, (_, i) => ({
		id: String(BASE + BigInt(i)),
		resolved: i % 7 === 3 ? 0 : 1,
	}))

	// The jobs a round at a time, each in its own transaction, to their end: the report ids each round read.
	async function run(w: World, round: (db: Db, after: string) => { id: string } | null): Promise<string[]> {
		const read: string[] = []
		for (let after = '0', i = 0; ; i++) {
			expect(i).toBeLessThan(1_000)
			const ran = await runInDurableObject(w.h.store, (_instance, state) => {
				const sql = observedSql(state.storage.sql, (rows, query) => {
					if (query.includes('FROM reports INDEXED BY reports_target_state')) {
						read.push(...rows.map((row) => row.id as string))
					}
				})
				return state.storage.transactionSync(() => round(new Db(sql, (fn) => state.storage.transactionSync(fn)), after))
			})
			if (ran === null) {
				return read
			}
			after = ran.id
		}
	}

	it("resolves a local account's frozen reports, each read once", async () => {
		const w = await world()
		await reportsOf(w, w.alice.id)
		expect((await act(w, w.alice.id, { type: 'suspend' })).status).toBe(200)
		expect(await run(w, (db, after) => moderationRound(db, NOW, after))).toEqual(expected.map((r) => r.id))
		expect(await resolved(w, w.alice.id)).toEqual(expected)
	}, 60_000)

	it("resolves a remote account's frozen reports, each read once", async () => {
		const w = await world()
		const carol = await remoteAccount(w.h.store, 'carol')
		await reportsOf(w, carol)
		expect((await act(w, carol, { type: 'suspend' })).status).toBe(200)
		expect(await run(w, (db, after) => remoteModerationRound(db, NOW, after))).toEqual(expected.map((r) => r.id))
		expect(await resolved(w, carol)).toEqual(expected)
	}, 60_000)
})
