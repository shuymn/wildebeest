import { afterEach, describe, expect, it, vi } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain, setSeverity, unblockDomain } from './domain-block-helpers'
import { BUILD } from './helpers'
import { writtenBy } from './inbox-store-helpers'
import { act, world } from './remote-suspension-helpers'
import { community, remoteAccount } from './status-helpers'
import { DOMAIN_BLOCK_BATCHES_PER_RUN, DOMAIN_BLOCK_WINDOW } from '../src/domain/blocks'
import {
	DOMAIN_BLOCK_CLEANUPS,
	type JobTable,
	JOB_RETRY_DELAYS_MS,
	JOB_TABLES,
	MAX_JOB_ATTEMPTS,
	MODERATION_JOBS,
	NOTIFICATION_CLEARS,
	NOTIFICATION_DISMISSALS,
	NOTIFICATION_REQUEST_JOBS,
	QUOTE_REVOCATIONS,
	REMOTE_MODERATION_JOBS,
	RETRY_JOBS_LIMIT,
	SAFE_MS,
} from '../src/domain/job-attempts'
import { remoteModerationRound } from '../src/domain/remote-suspension'
import type { StoreStub } from '../src/platform/store-client'

// RES-5, RES-6 (D5 of the job-round isolation): in every family besides the inbound jobs, each item's batch or round
// runs in its own savepoint, and one that throws is recorded on its row (job-attempts.ts runJobItem), which backs off
// and parks after MAX_JOB_ATTEMPTS, so it holds back no other item of its family.

const FAIL = 'test: the item fails'

type Key = readonly SqlStorageValue[]
type World = Awaited<ReturnType<typeof community<'alice'>>>

// A family's table, its Store call, and its items as their writers leave them: `seed` inserts `n` items in the order
// the round takes them and returns their keys; `finished` tells whether an item's work is done; `state` reads what an
// item holds besides its retry state (its row and what it staged), which a failed batch leaves as it was.
type Family = {
	t: JobTable
	run: (store: StoreStub, now: number) => Promise<unknown>
	seed: (w: World, n: number) => Promise<Key[]>
	finished: (store: StoreStub, key: Key) => Promise<boolean>
	state: (store: StoreStub, key: Key) => Promise<unknown>
}

const match = (t: JobTable, alias = '') => t.key.map((column) => `${alias}${column} = ?`).join(' AND ')

const literal = (value: SqlStorageValue) => (typeof value === 'number' ? String(value) : `'${value as string}'`)

const rowOf = async (store: StoreStub, t: JobTable, key: Key) =>
	(await sql<Record<string, SqlStorageValue>>(store, `SELECT * FROM ${t.table} WHERE ${match(t)}`, ...key))[0]

const gone = (t: JobTable) => async (store: StoreStub, key: Key) => (await rowOf(store, t, key)) === undefined

// The row without its retry state.
const rowState = (t: JobTable) => async (store: StoreStub, key: Key) => {
	const row = await rowOf(store, t, key)
	if (row === undefined) {
		return undefined
	}
	return Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'attempts' && column !== 'due_at'))
}

async function retryState(store: StoreStub, t: JobTable, key: Key): Promise<[number, number | null]> {
	const [row] = await sql<{ attempts: number; due_at: number | null }>(
		store,
		`SELECT attempts, due_at FROM ${t.table} WHERE ${match(t)}`,
		...key
	)
	return [row!.attempts, row!.due_at]
}

const setRetry = (store: StoreStub, t: JobTable, key: Key, attempts: SqlStorageValue, due: SqlStorageValue) =>
	sql(store, `UPDATE ${t.table} SET attempts = ?, due_at = ? WHERE ${match(t)}`, attempts, due, ...key)

// Makes every batch or round of the item `key` fail at its own row's write (each writes its row: a cursor, a phase, the
// end of a revocation, or its deletion), after its other writes; the retry state's writes pass.
async function failOn(store: StoreStub, t: JobTable, key: Key, name: string): Promise<void> {
	const old = t.key.map((column, i) => `OLD.${column} = ${literal(key[i]!)}`).join(' AND ')
	await sql(
		store,
		`CREATE TRIGGER ${name}_u BEFORE UPDATE ON ${t.table} WHEN ${old} AND NEW.attempts = OLD.attempts
		BEGIN SELECT RAISE(ABORT, '${FAIL}'); END`
	)
	await sql(
		store,
		`CREATE TRIGGER ${name}_d BEFORE DELETE ON ${t.table} WHEN ${old} BEGIN SELECT RAISE(ABORT, '${FAIL}'); END`
	)
}

// `n` more local accounts (the first is alice), for the tables keyed by a local account.
async function localAccounts(w: World, n: number): Promise<string[]> {
	const ids = [w.users.alice.id]
	for (let i = 1; i < n; i++) {
		const id = `1${String(900 + i).padStart(17, '0')}`
		await sql(
			w.store,
			"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/l' || ?2, 'l' || ?2, NULL)",
			id,
			i
		)
		await sql(
			w.store,
			"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'l' || ?2 || '@example.com', X'00', X'00', 'k')",
			id,
			i
		)
		ids.push(id)
	}
	return ids
}

const STAGED = 3

const FAMILIES: Record<string, Family> = {
	local_moderation: {
		t: MODERATION_JOBS,
		run: (store, now) => store.runModerationJobs(BUILD, { now }),
		// Suspension jobs of generations that ended, each with STAGED inboxes: a round drops them and ends the job.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const [row] = await sql<{ id: number }>(
					w.store,
					`INSERT INTO moderation_jobs (kind, account_id, generation, phase) VALUES ('suspension', ?, ?, 'write')
					RETURNING id`,
					w.users.alice.id,
					100 + i
				)
				for (let j = 0; j < STAGED; j++) {
					await sql(
						w.store,
						'INSERT INTO moderation_reach (job_id, inbox) VALUES (?, ?)',
						row!.id,
						`https://r${j}.example/inbox`
					)
				}
				keys.push([row!.id])
			}
			return keys
		},
		finished: gone(MODERATION_JOBS),
		state: async (store, key) => ({
			row: await rowState(MODERATION_JOBS)(store, key),
			staged: await sql(store, 'SELECT inbox FROM moderation_reach WHERE job_id = ? ORDER BY inbox', ...key),
		}),
	},
	remote_moderation: {
		t: REMOTE_MODERATION_JOBS,
		run: (store, now) => store.runModerationJobs(BUILD, { now }),
		// Account jobs of accounts no longer stored: a round ends each.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const [row] = await sql<{ id: number }>(
					w.store,
					`INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, phase)
					VALUES ('account', ?, 'account', 0, 'follows') RETURNING id`,
					`9${String(i).padStart(17, '0')}`
				)
				keys.push([row!.id])
			}
			return keys
		},
		finished: gone(REMOTE_MODERATION_JOBS),
		state: rowState(REMOTE_MODERATION_JOBS),
	},
	revocations: {
		t: QUOTE_REVOCATIONS,
		run: (store, now) => store.runInboundJobs(BUILD, { now }),
		// Revocations by an actor Kopje does not store: a batch ends each.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const key = [`https://gone.example/stamps/${i}`, 'https://gone.example/users/y'] as const
				await sql(
					w.store,
					'INSERT INTO quote_revocations (authorization, actor_uri, revoked_at, pending) VALUES (?, ?, ?, 1)',
					...key,
					NOW - 1000 + i
				)
				keys.push(key)
			}
			return keys
		},
		finished: async (store, key) => (await rowOf(store, QUOTE_REVOCATIONS, key))?.pending === 0,
		state: rowState(QUOTE_REVOCATIONS),
	},
	domain_block_cleanups: {
		t: DOMAIN_BLOCK_CLEANUPS,
		run: (store, now) => store.runDomainBlockCleanups(BUILD, { now }),
		// Cleanups of alice's domain blocks with no follow to scan: a batch ends each.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const [block] = await sql<{ id: number }>(
					w.store,
					'INSERT INTO domain_blocks (account_id, domain, created_at) VALUES (?, ?, ?) RETURNING id',
					w.users.alice.id,
					`d${i}.example`,
					new Date(NOW).toISOString()
				)
				await sql(
					w.store,
					'INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at) VALUES (?, 0, ?)',
					block!.id,
					NOW - 1000 + i
				)
				keys.push([block!.id])
			}
			return keys
		},
		finished: gone(DOMAIN_BLOCK_CLEANUPS),
		state: rowState(DOMAIN_BLOCK_CLEANUPS),
	},
	notification_requests: {
		t: NOTIFICATION_REQUEST_JOBS,
		run: (store, now) => store.runNotificationRequestJobs(BUILD, { now }),
		// Dismissed requests of alice's with nothing left to dismiss: a batch ends each.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const from = await remoteAccount(w.store, `n${i}`, 'n.example')
				const [row] = await sql<{ id: number }>(
					w.store,
					`INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor)
					VALUES (?, ?, 'dismiss', 0) RETURNING id`,
					w.users.alice.id,
					from
				)
				keys.push([row!.id])
			}
			return keys
		},
		finished: gone(NOTIFICATION_REQUEST_JOBS),
		state: rowState(NOTIFICATION_REQUEST_JOBS),
	},
	notification_clears: {
		t: NOTIFICATION_CLEARS,
		run: (store, now) => store.runNotificationRequestJobs(BUILD, { now }),
		// Clears with nothing left at or below them: a batch ends each.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (const id of await localAccounts(w, n)) {
				await sql(w.store, 'INSERT INTO notification_clears (account_id, max_id) VALUES (?, 0)', id)
				keys.push([id])
			}
			return keys
		},
		finished: gone(NOTIFICATION_CLEARS),
		state: rowState(NOTIFICATION_CLEARS),
	},
	notification_dismissals: {
		t: NOTIFICATION_DISMISSALS,
		run: (store, now) => store.runNotificationRequestJobs(BUILD, { now }),
		// Dismissals of alice's groups with nothing left at or below them: a batch ends each.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const key = [w.users.alice.id, `g${i}`] as const
				await sql(
					w.store,
					'INSERT INTO notification_dismissals (account_id, group_key, max_id) VALUES (?, ?, 0)',
					...key
				)
				keys.push(key)
			}
			return keys
		},
		finished: gone(NOTIFICATION_DISMISSALS),
		state: rowState(NOTIFICATION_DISMISSALS),
	},
}

const NAMES = Object.keys(FAMILIES)

// The fields an item's log carries (job-attempts.ts recordJobAttempt; errorFields' class).
const LOGGED = new Set(['event', 'family', 'outcome', 'attempts', 'parked', 'error', 'name', 'reason'])
// Ten years on: past every retry delay.
const LATER = NOW + 10 * 365 * 86_400_000

// The kopje.jobs.item.* events logged, and everything logged.
function itemLogs() {
	const error = vi.spyOn(console, 'error').mockImplementation(() => {})
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const entries = () =>
		[...error.mock.calls, ...warn.mock.calls]
			.map((args) => args[0] as { event?: string; family?: string; parked?: boolean })
			.filter((entry) => typeof entry?.event === 'string' && entry.event.startsWith('kopje.jobs.item.'))
	const everything = () => JSON.stringify([...error.mock.calls, ...warn.mock.calls])
	return { entries, everything }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe.each(NAMES)('%s (D5)', (name) => {
	const f = FAMILIES[name]!

	it('parks a permanently failing first item after MAX_JOB_ATTEMPTS while the item behind it finishes', async () => {
		const w = await community(['alice'])
		const [failing, other] = await f.seed(w, 2)
		await failOn(w.store, f.t, failing!, 'test_fail')
		const before = await f.state(w.store, failing!)
		const logs = itemLogs()
		const seen: [number, number | null][] = []
		let at = NOW
		for (let i = 0; i < MAX_JOB_ATTEMPTS; i++) {
			await f.run(w.store, at)
			if (i === 0) {
				// The item behind the failing one ran in the same call.
				expect(await f.finished(w.store, other!)).toBe(true)
			}
			const state = await retryState(w.store, f.t, failing!)
			seen.push([state[0], state[1] === null ? null : state[1] - at])
			at = state[1] ?? at
		}
		// Each failure waits its delay, the last parks it.
		expect(seen).toEqual([...JOB_RETRY_DELAYS_MS.map((ms, i) => [i + 1, ms]), [MAX_JOB_ATTEMPTS, null]])
		// Each failed batch was rolled back: the item holds what it held (its row, and what it staged).
		expect(await f.state(w.store, failing!)).toEqual(before)
		expect(await f.finished(w.store, failing!)).toBe(false)
		expect(logs.entries()).toEqual([
			...Array.from({ length: MAX_JOB_ATTEMPTS }, (_, i): unknown =>
				expect.objectContaining({
					event: 'kopje.jobs.item.failed',
					family: f.t.family,
					outcome: 'error',
					attempts: i + 1,
					parked: i + 1 === MAX_JOB_ATTEMPTS,
				})
			),
			{ event: 'kopje.jobs.item.parked', family: f.t.family },
		])
		// DATA-5: the logs name the family, the outcome and the error's class, never the item.
		for (const entry of logs.entries()) {
			expect(
				Object.keys(entry).every((field) => LOGGED.has(field)),
				JSON.stringify(entry)
			).toBe(true)
		}
		for (const value of failing!.filter((v) => typeof v === 'string')) {
			expect(logs.everything()).not.toContain(value)
		}
		// Parked: no later call selects it (its trigger would fail it again), nor asks for another round.
		expect(await f.run(w.store, LATER)).toMatchObject({ pending: false })
		expect(await retryState(w.store, f.t, failing!)).toEqual([MAX_JOB_ATTEMPTS, null])
		expect(logs.entries()).toHaveLength(MAX_JOB_ATTEMPTS + 1)
	})

	it('runs imported retry states as stored, and the CHECKs refuse every other pair', async () => {
		const w = await community(['alice'])
		const keys = await f.seed(w, 4)
		const states: [number, number | null][] = [
			[5, NOW - 1],
			[6, null],
			[0, null],
			[3, SAFE_MS],
		]
		for (const [i, key] of keys.entries()) {
			await setRetry(w.store, f.t, key, ...states[i]!)
			await failOn(w.store, f.t, key, `test_fail_${i}`)
		}
		itemLogs()
		await f.run(w.store, NOW)
		expect(await Promise.all(keys.map((key) => retryState(w.store, f.t, key)))).toEqual([
			// The 5th failure was due: its 6th parks it.
			[6, null],
			[6, null],
			[1, NOW + JOB_RETRY_DELAYS_MS[0]!],
			[3, SAFE_MS],
		])
		// The CHECKs, with the failing triggers (which would refuse first) gone.
		for (const i of keys.keys()) {
			await sql(w.store, `DROP TRIGGER test_fail_${i}_u`)
			await sql(w.store, `DROP TRIGGER test_fail_${i}_d`)
		}
		const fresh = keys[2]!
		for (const [attempts, due] of [
			[6, NOW],
			[0, NOW],
			[3, null],
			[1, 1.5],
			[1, -1],
			[1, SAFE_MS + 1],
			[1, 'soon'],
			[7, null],
			[-1, null],
			[1.5, NOW],
			['x', null],
		] as [SqlStorageValue, SqlStorageValue][]) {
			await expect(setRetry(w.store, f.t, fresh, attempts, due), JSON.stringify([attempts, due])).rejects.toThrow(
				/CHECK constraint failed/
			)
		}
		await expect(setRetry(w.store, f.t, fresh, null, null)).rejects.toThrow(/NOT NULL constraint failed/)
		// The guarded branch: the accepted pairs.
		for (const [attempts, due] of [
			[0, null],
			[1, 0],
			[5, SAFE_MS],
			[6, null],
		] as [number, number | null][]) {
			await setRetry(w.store, f.t, fresh, attempts, due)
		}
	})
})

describe('a new decision on a parked job (G-5)', () => {
	const remoteJob = async (store: StoreStub, subject: string) =>
		(
			await sql<{ phase: string; attempts: number; due_at: number | null }>(
				store,
				'SELECT phase, attempts, due_at FROM remote_moderation_jobs WHERE subject = ?',
				subject
			)
		)[0]

	// Rounds until the moderation jobs ask for none.
	async function drain(store: StoreStub): Promise<void> {
		for (let i = 0; i < 20; i++) {
			if (!(await store.runModerationJobs(BUILD, { now: NOW })).pending) {
				return
			}
		}
		throw new Error('the moderation jobs did not finish')
	}

	it('makes a parked account job fresh when the admin suspends the account again', async () => {
		const w = await world()
		const store = w.h.store
		const r = await remoteAccount(store, 'r', 'r.example')
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		await sql(store, 'UPDATE remote_moderation_jobs SET attempts = 6, due_at = NULL WHERE subject = ?', r)
		// Parked: a round leaves it, and asks for none.
		expect(await store.runModerationJobs(BUILD, { now: NOW })).toMatchObject({ pending: false })
		expect(await remoteJob(store, r)).toEqual({ phase: 'reports', attempts: 6, due_at: null })
		// The admin's new decision resets the job, its retry state included; its rounds then run it through.
		expect(await act(w, r, { type: 'suspend' })).toMatchObject({ status: 200 })
		expect(await remoteJob(store, r)).toEqual({ phase: 'reports', attempts: 0, due_at: null })
		await drain(store)
		expect(await remoteJob(store, r)).toBeUndefined()
	})

	it('makes a parked domain job fresh at a transition, and keeps it parked through a change that is none', async () => {
		const w = await world()
		const store = w.h.store
		const block = await blockDomain(store, 'd.example')
		await sql(store, "UPDATE remote_moderation_jobs SET attempts = 6, due_at = NULL WHERE kind = 'domain'")
		// The block set to suspend again changes no host's coverage: the job stays parked (the guarded branch).
		await setSeverity(store, block.id, 'suspend')
		expect(await remoteJob(store, '')).toEqual({ phase: 'clear', attempts: 6, due_at: null })
		expect(await store.runModerationJobs(BUILD, { now: NOW })).toMatchObject({ pending: false })
		// Lifting the block is a transition: the job starts again, fresh, and its rounds run it through.
		await unblockDomain(store, block.id)
		expect(await remoteJob(store, '')).toEqual({ phase: 'clear', attempts: 0, due_at: null })
		await drain(store)
		expect(await remoteJob(store, '')).toBeUndefined()
	})
})

describe('a due retry that runs through (RES-5)', () => {
	// A failing item that is due, whose next batch succeeds and leaves work: it is fresh again, so its next failure is
	// its first.
	it.each([
		[
			'remote_moderation',
			async (w: World) => {
				const r = await remoteAccount(w.store, 'r', 'r.example')
				await sql(w.store, "UPDATE accounts SET suspended_at = ?, suspension_source = 'account' WHERE id = ?", 'x', r)
				const [row] = await sql<{ id: number }>(
					w.store,
					`INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, phase)
					VALUES ('account', ?, 'account', 0, 'reports') RETURNING id`,
					r
				)
				return [row!.id] as Key
			},
			// One round (remoteModerationRound, as runModerationJobs runs it): a call's next round would end the job.
			(store: StoreStub) => writtenBy(store, (db) => remoteModerationRound(db, NOW)),
		],
		[
			'domain_block_cleanups',
			async (w: World) => {
				const [block] = await sql<{ id: number }>(
					w.store,
					"INSERT INTO domain_blocks (account_id, domain, created_at) VALUES (?, 'd.example', '') RETURNING id",
					w.users.alice.id
				)
				// More follows than a call's batches scan: they move the cursor and leave the cleanup.
				await sql(
					w.store,
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain)
					SELECT printf('5%017d', i), 'https://o.example/u/' || i, 'o' || i, 'o.example' FROM n`,
					DOMAIN_BLOCK_BATCHES_PER_RUN * DOMAIN_BLOCK_WINDOW + 1
				)
				await sql(
					w.store,
					"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE domain = 'o.example'",
					w.users.alice.id
				)
				await sql(
					w.store,
					'INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at) SELECT ?, max(id), 0 FROM follows',
					block!.id
				)
				return [block!.id] as Key
			},
			(store: StoreStub) => FAMILIES.domain_block_cleanups!.run(store, NOW),
		],
	] as const)('%s', async (name, seed, run) => {
		const f = FAMILIES[name]!
		const w = await community(['alice'])
		const key = await seed(w)
		await setRetry(w.store, f.t, key, 3, NOW - 1)
		const before = await f.state(w.store, key)
		await run(w.store)
		expect(await f.state(w.store, key)).not.toEqual(before)
		expect(await retryState(w.store, f.t, key)).toEqual([0, null])
	})
})

describe('retry-all over every job table (D8, RES-5)', () => {
	it('makes the failing rows of every table fresh, RETRY_JOBS_LIMIT a call in JOB_TABLES order, keeping their state', async () => {
		const w = await community(['alice'])
		const PER = 15
		const keys = new Map<JobTable, Key[]>()
		for (const name of NAMES) {
			keys.set(FAMILIES[name]!.t, await FAMILIES[name]!.seed(w, PER))
		}
		await sql(
			w.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) SELECT 'delete', printf('9%017d', i), 'https://x.example/u', i FROM n`,
			PER
		)
		// Half of each table's rows parked, the rest backing off (by rowid, or a revocation's time: no rowid).
		const tables = JOB_TABLES.map((t) => t.table)
		for (const table of tables) {
			const n = table === 'quote_revocations' ? 'revoked_at' : table === 'inbound_jobs' ? 'created_at' : 'rowid'
			await sql(
				w.store,
				`UPDATE ${table} SET attempts = CASE WHEN ${n} % 2 = 0 THEN 6 ELSE 2 END,
					due_at = CASE WHEN ${n} % 2 = 0 THEN NULL ELSE ?1 + ${n} % 1000 END`,
				NOW + 3_600_000
			)
		}
		const counts = async () =>
			Object.fromEntries(
				await Promise.all(
					tables.map(
						async (table) =>
							[
								table,
								(await sql<{ n: number }>(w.store, `SELECT count(*) AS n FROM ${table} WHERE attempts > 0`))[0]!.n,
							] as const
					)
				)
			)
		const before = await Promise.all(
			NAMES.map(async (name) => {
				const f = FAMILIES[name]!
				return Promise.all(keys.get(f.t)!.map((key) => f.state(w.store, key)))
			})
		)
		expect(Object.values(await counts())).toEqual(tables.map(() => PER))
		expect(await w.store.retryParkedJobs(BUILD, {})).toEqual({ reset: RETRY_JOBS_LIMIT, more: true })
		// The first tables in order, up to the limit: 6 whole tables and 10 rows of the seventh.
		expect(Object.values(await counts())).toEqual([0, 0, 0, 0, 0, 0, PER - (RETRY_JOBS_LIMIT - 6 * PER), PER])
		expect(await w.store.retryParkedJobs(BUILD, {})).toEqual({ reset: 8 * PER - RETRY_JOBS_LIMIT, more: false })
		expect(Object.values(await counts())).toEqual(tables.map(() => 0))
		expect(await w.store.retryParkedJobs(BUILD, {})).toEqual({ reset: 0, more: false })
		// Nothing but the retry state changed.
		expect(
			await Promise.all(
				NAMES.map(async (name) => {
					const f = FAMILIES[name]!
					return Promise.all(keys.get(f.t)!.map((key) => f.state(w.store, key)))
				})
			)
		).toEqual(before)
	})
})
