import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { community, remoteAccount } from './status-helpers'
import { writeOperation } from '../src/domain/operation'
import { sweepStaleVotes } from '../src/domain/polls'
import { resolveSuspensionReports } from '../src/domain/reports'

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
		resolveSuspensionReports(db, target, Number.MAX_SAFE_INTEGER, 0, null, 0, 100, AT)
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
