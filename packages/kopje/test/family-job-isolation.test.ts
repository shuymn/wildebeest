import { afterEach, describe, expect, it, vi } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain, setSeverity, unblockDomain } from './domain-block-helpers'
import { BUILD } from './helpers'
import { writtenBy } from './inbox-store-helpers'
import { failItem } from './job-item-helpers'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { act, world } from './remote-suspension-helpers'
import { community, remoteAccount } from './status-helpers'
import { DOMAIN_BLOCK_BATCHES_PER_RUN, DOMAIN_BLOCK_WINDOW, runDomainBlockCleanups } from '../src/domain/blocks'
import { runInboundJobs } from '../src/domain/inbox'
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
	retryParkedJobs,
	SAFE_MS,
} from '../src/domain/job-attempts'
import { dismissNotificationGroup } from '../src/domain/notification-groups'
import { acceptNotificationRequests, runNotificationRequestJobs } from '../src/domain/notification-requests'
import { clearNotifications } from '../src/domain/notifications'
import { remoteModerationRound } from '../src/domain/remote-suspension'
import { moderationRound, REACH_ROUND, runModerationJobs } from '../src/domain/suspension'
import type { StoreStub } from '../src/platform/store-client'
import type { StoreOperation } from '../src/platform/store-kernel'
import { sha256Hex } from '../src/security/tokens'

// RES-5, RES-6 (D5 of the job-round isolation): in every family besides the inbound jobs, each item's batch or round
// runs in its own savepoint, and one that throws is recorded on its row (job-attempts.ts runJobItem), which backs off
// and parks after MAX_JOB_ATTEMPTS, so it holds back no other item of its family.

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
const failOn = (store: StoreStub, t: JobTable, key: Key, name: string) =>
	failItem(store, t.table, Object.fromEntries(t.key.map((column, i) => [column, key[i]!])), name)

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

// `n` staged inboxes of the moderation job `id`.
const stage = (store: StoreStub, id: string | number, n: number) =>
	sql(
		store,
		`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?2)
		INSERT INTO moderation_reach (job_id, inbox) SELECT CAST(?1 AS INTEGER), 'https://r' || i || '.example/inbox' FROM k`,
		String(id),
		n
	)

const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
	(await sql(store, query, ...params)).length

// Two notifications of `recipient` from `from` (a follow and a follow request), in `group` (null: none), filtered or
// not.
async function notifications(
	store: StoreStub,
	recipient: string,
	from: string,
	group: string | null,
	filtered: number
): Promise<void> {
	for (const type of ['follow', 'follow_request']) {
		await sql(
			store,
			'INSERT INTO notifications (account_id, type, from_account_id, group_key, filtered) VALUES (?, ?, ?, ?, ?)',
			recipient,
			type,
			from,
			group,
			filtered
		)
	}
}

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
		// Account jobs of individually suspended remote accounts, each following alice: a round ends the follow with a
		// Reject, then ends the job.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const r = await remoteAccount(w.store, `r${i}`, 'r.example')
				await sql(
					w.store,
					`UPDATE accounts SET suspended_at = '2026-10-01T00:00:00.000Z', suspension_source = 'account',
						inbox_url = uri || '/inbox' WHERE id = ?`,
					r
				)
				await sql(
					w.store,
					"INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'accepted', ?)",
					r,
					w.users.alice.id,
					`https://r.example/follows/${i}`
				)
				const [row] = await sql<{ id: number }>(
					w.store,
					`INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, phase)
					VALUES ('account', ?, 'account', (SELECT max(id) FROM follows), 'follows') RETURNING id`,
					r
				)
				keys.push([row!.id])
			}
			return keys
		},
		finished: gone(REMOTE_MODERATION_JOBS),
		state: async (store, key) => {
			const row = await rowState(REMOTE_MODERATION_JOBS)(store, key)
			return {
				row,
				follows: await sql(
					store,
					'SELECT target_account_id, state FROM follows WHERE account_id = ?',
					row?.subject ?? ''
				),
			}
		},
	},
	revocations: {
		t: QUOTE_REVOCATIONS,
		run: (store, now) => store.runInboundJobs(BUILD, { now }),
		// Revocations of a stamp a stored quote names, by the quoted author: a batch rejects the quote, then ends the
		// revocation.
		seed: async (w, n) => {
			const keys: Key[] = []
			const quoter = await remoteAccount(w.store, 'quoter', 'q.example')
			for (let i = 0; i < n; i++) {
				const author = await remoteAccount(w.store, `a${i}`, 'q.example')
				const [{ uri }] = (await sql<{ uri: string }>(w.store, 'SELECT uri FROM accounts WHERE id = ?', author)) as [
					{ uri: string },
				]
				const quoted = `7${String(2 * i).padStart(17, '0')}`
				const quoting = `7${String(2 * i + 1).padStart(17, '0')}`
				for (const [id, by] of [
					[quoted, author],
					[quoting, quoter],
				] as const) {
					await sql(
						w.store,
						`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
						VALUES (?1, 'https://q.example/s/' || ?1, ?2, 'public', '', '2026-10-01T00:00:00.000Z')`,
						id,
						by
					)
				}
				const stamp = `https://q.example/stamps/${i}`
				await sql(
					w.store,
					`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, approval_uri, updated_at)
					VALUES (?1, 'https://q.example/s/' || ?2, ?2, ?3, 'pending', ?4, '2026-10-01T00:00:00.000Z')`,
					quoting,
					quoted,
					author,
					stamp
				)
				await sql(
					w.store,
					'INSERT INTO quote_revocations (authorization, actor_uri, revoked_at, pending) VALUES (?, ?, ?, 1)',
					stamp,
					uri,
					NOW - 1000 + i
				)
				keys.push([stamp, uri])
			}
			return keys
		},
		finished: async (store, key) => (await rowOf(store, QUOTE_REVOCATIONS, key))?.pending === 0,
		state: async (store, key) => ({
			row: await rowState(QUOTE_REVOCATIONS)(store, key),
			quotes: await sql(store, 'SELECT status_id, state FROM quotes WHERE approval_uri = ?', key[0]!),
		}),
	},
	domain_block_cleanups: {
		t: DOMAIN_BLOCK_CLEANUPS,
		run: (store, now) => store.runDomainBlockCleanups(BUILD, { now }),
		// Cleanups of alice's blocks of domains she follows an account of: a batch ends the follow with an Undo, then
		// ends the cleanup.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const domain = `d${i}.example`
				const other = await remoteAccount(w.store, 'u', domain)
				await sql(w.store, "UPDATE accounts SET inbox_url = uri || '/inbox' WHERE id = ?", other)
				await sql(
					w.store,
					"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
					w.users.alice.id,
					other
				)
				const [block] = await sql<{ id: number }>(
					w.store,
					'INSERT INTO domain_blocks (account_id, domain, created_at) VALUES (?, ?, ?) RETURNING id',
					w.users.alice.id,
					domain,
					new Date(NOW).toISOString()
				)
				await sql(
					w.store,
					`INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at)
					SELECT ?, max(id), ? FROM follows`,
					block!.id,
					NOW - 1000 + i
				)
				keys.push([block!.id])
			}
			return keys
		},
		finished: gone(DOMAIN_BLOCK_CLEANUPS),
		state: async (store, key) => ({
			row: await rowState(DOMAIN_BLOCK_CLEANUPS)(store, key),
			follows: await count(
				store,
				`SELECT 1 FROM follows f JOIN accounts a ON a.id = f.target_account_id
				WHERE a.domain = (SELECT domain FROM domain_blocks WHERE id = ?)`,
				...key
			),
		}),
	},
	notification_requests: {
		t: NOTIFICATION_REQUEST_JOBS,
		run: (store, now) => store.runNotificationRequestJobs(BUILD, { now }),
		// Dismissed requests of alice's, each sender's two filtered notifications left: a batch deletes them, then ends
		// the job.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const from = await remoteAccount(w.store, `n${i}`, 'n.example')
				await notifications(w.store, w.users.alice.id, from, null, 1)
				const [row] = await sql<{ id: number }>(
					w.store,
					`INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor)
					SELECT ?, ?, 'dismiss', max(id) + 1 FROM notifications RETURNING id`,
					w.users.alice.id,
					from
				)
				keys.push([row!.id])
			}
			return keys
		},
		finished: gone(NOTIFICATION_REQUEST_JOBS),
		state: async (store, key) => ({
			row: await rowState(NOTIFICATION_REQUEST_JOBS)(store, key),
			notifications: await count(
				store,
				'SELECT 1 FROM notifications WHERE from_account_id = (SELECT from_account_id FROM notification_request_jobs WHERE id = ?)',
				...key
			),
		}),
	},
	notification_clears: {
		t: NOTIFICATION_CLEARS,
		run: (store, now) => store.runNotificationRequestJobs(BUILD, { now }),
		// Clears, each over two notifications of its account: a batch deletes them, then ends the clear.
		seed: async (w, n) => {
			const keys: Key[] = []
			const from = await remoteAccount(w.store, 'csender', 'n.example')
			for (const id of await localAccounts(w, n)) {
				await notifications(w.store, id, from, null, 0)
				await sql(
					w.store,
					'INSERT INTO notification_clears (account_id, max_id) SELECT ?1, max(id) FROM notifications WHERE account_id = ?1',
					id
				)
				keys.push([id])
			}
			return keys
		},
		finished: gone(NOTIFICATION_CLEARS),
		state: async (store, key) => ({
			row: await rowState(NOTIFICATION_CLEARS)(store, key),
			notifications: await count(store, 'SELECT 1 FROM notifications WHERE account_id = ?', ...key),
		}),
	},
	notification_dismissals: {
		t: NOTIFICATION_DISMISSALS,
		run: (store, now) => store.runNotificationRequestJobs(BUILD, { now }),
		// Dismissals of alice's groups, each of two notifications: a batch deletes them, then ends the dismissal.
		seed: async (w, n) => {
			const keys: Key[] = []
			for (let i = 0; i < n; i++) {
				const key = [w.users.alice.id, `g${i}`] as const
				const from = await remoteAccount(w.store, `d${i}`, 'n.example')
				await notifications(w.store, w.users.alice.id, from, key[1], 0)
				await sql(
					w.store,
					`INSERT INTO notification_dismissals (account_id, group_key, max_id)
					SELECT ?1, ?2, max(id) FROM notifications WHERE account_id = ?1 AND group_key = ?2`,
					...key
				)
				keys.push(key)
			}
			return keys
		},
		finished: gone(NOTIFICATION_DISMISSALS),
		state: async (store, key) => ({
			row: await rowState(NOTIFICATION_DISMISSALS)(store, key),
			notifications: await count(store, 'SELECT 1 FROM notifications WHERE account_id = ? AND group_key = ?', ...key),
		}),
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

describe('the seeks under stale statistics (RES-7)', () => {
	const PARKED = 'CASE WHEN i <= ?1 THEN 6 ELSE 3 END'
	const DUE = 'CASE WHEN i <= ?1 THEN NULL ELSE ?3 + 3600000 END'
	const N = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2 * ?1)`
	// 2 × ?1 failing rows of each table: ?1 parked, ?1 backing off (due an hour after ?3), of alice (?2) where they
	// name a local account; with the rows they reference.
	const GROW: Record<string, readonly string[]> = {
		revocations: [
			`${N} INSERT INTO quote_revocations (authorization, actor_uri, revoked_at, pending, attempts, due_at)
			SELECT 'https://p.example/s/' || i, 'https://p.example/u', i, 1, ${PARKED}, ${DUE} FROM n WHERE ?2 = ?2`,
		],
		domain_block_cleanups: [
			`${N} INSERT INTO domain_blocks (id, account_id, domain, created_at)
			SELECT 100000 + i, ?2, 'g' || i || '.example', '' FROM n WHERE ?3 = ?3`,
			`${N} INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at, attempts, due_at)
			SELECT 100000 + i, 0, i, ${PARKED}, ${DUE} FROM n WHERE ?2 = ?2`,
		],
		notification_requests: [
			`${N} INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('6%017d', i), 'https://p.example/u/' || i, 'p' || i, 'p.example' FROM n WHERE ?2 = ?2 AND ?3 = ?3`,
			`${N} INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor, attempts, due_at)
			SELECT ?2, printf('6%017d', i), 'dismiss', 0, ${PARKED}, ${DUE} FROM n`,
		],
		notification_clears: [
			`${N} INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('2%017d', i), 'https://kopje.test/ap/users/p' || i, 'p' || i, NULL FROM n WHERE ?2 = ?2 AND ?3 = ?3`,
			`${N} INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT printf('2%017d', i), 'p' || i || '@example.com', X'00', X'00', 'k' FROM n WHERE ?2 = ?2 AND ?3 = ?3`,
			`${N} INSERT INTO notification_clears (account_id, max_id, attempts, due_at)
			SELECT printf('2%017d', i), 0, ${PARKED}, ${DUE} FROM n WHERE ?2 = ?2`,
		],
		notification_dismissals: [
			`${N} INSERT INTO notification_dismissals (account_id, group_key, max_id, attempts, due_at)
			SELECT ?2, 'pg' || i, 0, ${PARKED}, ${DUE} FROM n`,
		],
		local_moderation: [
			`${N} INSERT INTO moderation_jobs (kind, account_id, generation, phase, attempts, due_at)
			SELECT 'tokens', ?2, 1000 + i, 'tokens', ${PARKED}, ${DUE} FROM n`,
		],
		remote_moderation: [
			`${N} INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, phase, attempts, due_at)
			SELECT 'account', 'p' || i, 'account', 0, 'follows', ${PARKED}, ${DUE} FROM n WHERE ?2 = ?2`,
		],
	}
	const OPERATIONS: Record<string, StoreOperation<{ now: number }, unknown>> = {
		revocations: runInboundJobs,
		domain_block_cleanups: runDomainBlockCleanups,
		notification_requests: runNotificationRequestJobs,
		notification_clears: runNotificationRequestJobs,
		notification_dismissals: runNotificationRequestJobs,
		local_moderation: runModerationJobs,
		remote_moderation: runModerationJobs,
	}
	const PER_STATE = 5000

	it.each(NAMES)(
		'%s: reads its next item, the retry walk and its keys by their indexes with 10,000 failing rows',
		async (name) => {
			const f = FAMILIES[name]!
			const table = f.t.table
			const w = await community(['alice'])
			// Two due retries and two fresh items, each of which a batch finishes.
			const items = await f.seed(w, 4)
			for (const key of items.slice(0, 2)) {
				await setRetry(w.store, f.t, key, 1, NOW - 1)
			}
			const credential = { tokenHash: await sha256Hex(w.users.alice.token), scope: 'write' as const, now: NOW }
			const { after } = await staleStatistics(w, {
				grow: async () => {
					for (const statement of GROW[name]!) {
						await sql(w.store, statement, PER_STATE, w.users.alice.id, NOW)
					}
				},
				capture: async (phase) => {
					if (phase === 'before') {
						return []
					}
					const pattern = new RegExp(`\\b${table}\\b`)
					const operation = OPERATIONS[name]
					if (operation === undefined) {
						throw new Error(`no operation for ${name}`)
					}
					const plans = []
					for (let i = 0; i < 2; i++) {
						plans.push(...(await plannedRun(w, pattern, operation, { now: NOW }, true)).plans)
					}
					// The request-time seeks of the families that have them.
					if (name === 'notification_requests') {
						const input = { credential, ids: ['1'], now: NOW }
						plans.push(...(await plannedRun(w, pattern, acceptNotificationRequests, input, true)).plans)
					} else if (name === 'notification_clears') {
						plans.push(...(await plannedRun(w, pattern, clearNotifications, { credential }, true)).plans)
					} else if (name === 'notification_dismissals') {
						const input = { credential, groupKey: 'pg1' }
						plans.push(...(await plannedRun(w, pattern, dismissNotificationGroup, input, true)).plans)
					}
					plans.push(...(await plannedRun(w, pattern, retryParkedJobs, {}, true)).plans)
					return plans
				},
			})
			// The rounds ran the two due retries and the two fresh items.
			for (const key of items) {
				expect(await f.finished(w.store, key)).toBe(true)
			}
			// No statement scans the table (by its name, or the aliases the families' reads give it) but through one of its
			// partial indexes, which a seek without a range (the oldest fresh item, the retry walk) reads from its start,
			// within its LIMIT.
			for (const statement of after) {
				const scans = scansOf(statement.plan, [table, 'j', 'c']).filter(
					(detail) => !new RegExp(`USING (?:COVERING )?INDEX ${table}_(?:fresh|failing)\\b`).test(detail)
				)
				expect(scans, statement.query).toEqual([])
			}
			// The one-row seeks (the retry walk's, which reads up to its limit, below).
			const seeks = after.filter(
				(s) =>
					s.query.includes(`INDEXED BY ${table}_`) &&
					/^\s*SELECT/.test(s.query) &&
					!s.query.startsWith('SELECT CAST(rowid AS TEXT) AS r')
			)
			expect(seeks.some((s) => s.query.includes(`${table}_fresh`))).toBe(true)
			expect(seeks.some((s) => s.query.includes('due_at <= ?1'))).toBe(true)
			for (const seek of seeks) {
				expect(seek.rows, `${seek.query} ${seek.plan.join(' | ')}`).toBeLessThanOrEqual(2)
			}
			// The retry walk: its seek of the failing index and its updates (one statement by key, or one per rowid).
			const walk = after.filter(
				(s) =>
					s.query.startsWith(`UPDATE ${table} SET attempts = 0, due_at = NULL WHERE`) ||
					s.query.startsWith(`SELECT CAST(rowid AS TEXT) AS r FROM ${table} INDEXED BY ${table}_failing`)
			)
			expect(walk.length).toBeGreaterThan(0)
			// At its cap (RETRY_JOBS_LIMIT failing rows reset): a fixed number of reads per row reset, none for the 9,900
			// failing rows past the limit.
			expect(walk.reduce((sum, statement) => sum + statement.rows, 0)).toBeLessThanOrEqual(5 * RETRY_JOBS_LIMIT)
		},
		180_000
	)
})

describe('job ids past 2^53 (DATA-6)', () => {
	// 2^53, and 2^53 + 1, which a JavaScript number cannot tell from it.
	const TWO_53 = '9007199254740992'
	const NEXT = '9007199254740993'
	const attemptsOf = async (store: StoreStub, table: string, id: string) =>
		(await sql<{ attempts: number }>(store, `SELECT attempts FROM ${table} WHERE id = CAST(? AS INTEGER)`, id))[0]
			?.attempts

	it('makes exactly the failing rows fresh, and retry-all ends', async () => {
		const w = await community(['alice'])
		for (const id of [TWO_53, NEXT]) {
			await sql(
				w.store,
				`INSERT INTO remote_moderation_jobs (id, kind, subject, mode, follow_bound, phase, attempts)
				VALUES (CAST(?1 AS INTEGER), 'account', 's' || ?1, 'account', 0, 'follows', 0)`,
				id
			)
		}
		// Only 2^53 + 1 parked: a call that rounded its id would reset 2^53 (fresh already) and leave it parked.
		await sql(w.store, 'UPDATE remote_moderation_jobs SET attempts = 6 WHERE id = CAST(? AS INTEGER)', NEXT)
		expect(await w.store.retryParkedJobs(BUILD, {})).toEqual({ reset: 1, more: false })
		expect(await attemptsOf(w.store, 'remote_moderation_jobs', NEXT)).toBe(0)
		expect(await attemptsOf(w.store, 'remote_moderation_jobs', TWO_53)).toBe(0)
	})

	it('records a failed round on its own job, next to 2^53', async () => {
		const w = await community(['alice'])
		// Two jobs of generations that ended, each with more staged inboxes than a round drops (its round drops them and
		// saves its phase): 2^53 runs first.
		for (const id of [TWO_53, NEXT]) {
			await sql(
				w.store,
				`INSERT INTO moderation_jobs (id, kind, account_id, generation, phase)
				VALUES (CAST(?1 AS INTEGER), 'suspension', ?2, CAST(substr(?1, -3) AS INTEGER), 'write')`,
				id,
				w.users.alice.id
			)
			await stage(w.store, id, 4 * REACH_ROUND)
		}
		await failOn(w.store, MODERATION_JOBS, [NEXT], 'test_big')
		itemLogs()
		await w.store.runModerationJobs(BUILD, { now: NOW })
		expect(await attemptsOf(w.store, 'moderation_jobs', NEXT)).toBe(1)
		expect(await attemptsOf(w.store, 'moderation_jobs', TWO_53)).toBe(0)
	})

	it('runs a bulk answer’s job after an imported one of 2^53', async () => {
		const w = await community(['alice'])
		const { alice } = w.users
		const imported = await remoteAccount(w.store, 'imported', 'n.example')
		const sender = await remoteAccount(w.store, 'sender', 'n.example')
		await notifications(w.store, alice.id, imported, null, 1)
		await notifications(w.store, alice.id, sender, null, 1)
		// The imported job, backing off, raises the jobs' sequence: the request's job is 2^53 + 1.
		await sql(
			w.store,
			`INSERT INTO notification_request_jobs (id, account_id, from_account_id, kind, cursor, attempts, due_at)
			SELECT CAST(? AS INTEGER), ?, ?, 'accept', max(id) + 1, 2, ? FROM notifications`,
			TWO_53,
			alice.id,
			imported,
			NOW + 3_600_000
		)
		const [request] = await sql<{ id: string }>(
			w.store,
			`INSERT INTO notification_requests (account_id, from_account_id, notifications_count) VALUES (?, ?, 2)
			RETURNING CAST(id AS TEXT) AS id`,
			alice.id,
			sender
		)
		const answered = await w.request(
			'/api/v1/notifications/requests/accept',
			bearer(alice.token, json({ id: [request!.id] }))
		)
		expect(answered.status).toBe(200)
		// The request's job ran (its sender's notifications unfiltered, the job done); the imported one is untouched.
		const filtered = (from: string) =>
			sql(w.store, 'SELECT filtered FROM notifications WHERE from_account_id = ? ORDER BY id', from)
		expect(await filtered(sender)).toEqual([{ filtered: 0 }, { filtered: 0 }])
		expect(await filtered(imported)).toEqual([{ filtered: 1 }, { filtered: 1 }])
		expect(
			await sql(w.store, 'SELECT CAST(id AS TEXT) AS id, attempts FROM notification_request_jobs ORDER BY id')
		).toEqual([{ id: TWO_53, attempts: 2 }])
	})

	it('records a failed first cleanup batch of a block on its own cleanup, next to 2^53', async () => {
		const w = await community(['alice'])
		const { alice } = w.users
		const other = await remoteAccount(w.store, 'u', 'new.example')
		await sql(
			w.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			alice.id,
			other
		)
		// An imported block of 2^53 with its cleanup backing off: the request's block is 2^53 + 1.
		await sql(
			w.store,
			"INSERT INTO domain_blocks (id, account_id, domain, created_at) VALUES (CAST(? AS INTEGER), ?, 'old.example', '')",
			TWO_53,
			alice.id
		)
		await sql(
			w.store,
			`INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at, attempts, due_at)
			VALUES (CAST(? AS INTEGER), 0, 0, 2, ?)`,
			TWO_53,
			NOW + 3_600_000
		)
		await failOn(w.store, DOMAIN_BLOCK_CLEANUPS, [NEXT], 'test_big')
		itemLogs()
		const blocked = await w.request('/api/v1/domain_blocks', bearer(alice.token, json({ domain: 'new.example' })))
		expect(blocked.status).toBe(200)
		expect(
			await sql(
				w.store,
				'SELECT CAST(domain_block_id AS TEXT) AS id, attempts FROM domain_block_cleanups ORDER BY domain_block_id'
			)
		).toEqual([
			{ id: TWO_53, attempts: 2 },
			{ id: NEXT, attempts: 1 },
		])
	})

	it('ends a cleanup over follow ids past 2^53, in a round and in the request', async () => {
		const w = await community(['alice'])
		const { alice } = w.users
		const other = await remoteAccount(w.store, 'u', 'far.example')
		const PLUS = (n: bigint) => String(9007199254740992n + n)
		// One follow of alice's into the domain at 2^53 + 1; a cleanup from 2^53 to 2^53 + 4 (as a block left it).
		await sql(
			w.store,
			"INSERT INTO follows (id, account_id, target_account_id, state) VALUES (CAST(? AS INTEGER), ?, ?, 'accepted')",
			PLUS(1n),
			alice.id,
			other
		)
		const [block] = await sql<{ id: number }>(
			w.store,
			"INSERT INTO domain_blocks (account_id, domain, created_at) VALUES (?, 'far.example', '') RETURNING id",
			alice.id
		)
		await sql(
			w.store,
			`INSERT INTO domain_block_cleanups (domain_block_id, bound, cursor, created_at)
			VALUES (?, CAST(? AS INTEGER), CAST(? AS INTEGER), 0)`,
			block!.id,
			PLUS(4n),
			TWO_53
		)
		const follows = () => sql(w.store, 'SELECT 1 FROM follows WHERE account_id = ?', alice.id)
		expect(await w.store.runDomainBlockCleanups(BUILD, { now: NOW })).toMatchObject({ pending: false })
		expect(await follows()).toEqual([])
		expect(await sql(w.store, 'SELECT 1 FROM domain_block_cleanups')).toEqual([])
		// In the request: the newest follow, 2^53 + 3, bounds the block's cleanup, and its first batch ends it.
		const another = await remoteAccount(w.store, 'v', 'near.example')
		await sql(
			w.store,
			"INSERT INTO follows (id, account_id, target_account_id, state) VALUES (CAST(? AS INTEGER), ?, ?, 'accepted')",
			PLUS(3n),
			alice.id,
			another
		)
		const blocked = await w.request('/api/v1/domain_blocks', bearer(alice.token, json({ domain: 'near.example' })))
		expect(blocked.status).toBe(200)
		expect(await follows()).toEqual([])
		expect(await sql(w.store, 'SELECT 1 FROM domain_block_cleanups')).toEqual([])
	})

	it('ends every follow of a cleanup over a window ending at an id a number rounds up', async () => {
		const w = await community(['alice'])
		const { alice } = w.users
		// 501 follows of alice's into the domain, 2^53 + 4 to 2^53 + 504: the request's batch ends 500 of them, its window
		// ending at 2^53 + 503 (which a JavaScript number reads as 2^53 + 504, the bound).
		const COUNT = DOMAIN_BLOCK_WINDOW + 1
		await sql(
			w.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('5%017d', i), 'https://wide.example/u/' || i, 'w' || i, 'wide.example' FROM n`,
			COUNT
		)
		await sql(
			w.store,
			`INSERT INTO follows (id, account_id, target_account_id, state)
			SELECT CAST(?1 AS INTEGER) + 3 + CAST(substr(id, 2) AS INTEGER), ?2, id, 'accepted' FROM accounts
			WHERE domain = 'wide.example'`,
			TWO_53,
			alice.id
		)
		const left = () => sql(w.store, 'SELECT CAST(id AS TEXT) AS id FROM follows WHERE account_id = ?', alice.id)
		const blocked = await w.request('/api/v1/domain_blocks', bearer(alice.token, json({ domain: 'wide.example' })))
		expect(blocked.status).toBe(200)
		expect(await left()).toEqual([{ id: String(9007199254740992n + 504n) }])
		expect(await sql(w.store, 'SELECT CAST(cursor AS TEXT) AS cursor FROM domain_block_cleanups')).toEqual([
			{ cursor: String(9007199254740992n + 503n) },
		])
		await w.store.runDomainBlockCleanups(BUILD, { now: NOW })
		expect(await left()).toEqual([])
		expect(await sql(w.store, 'SELECT 1 FROM domain_block_cleanups')).toEqual([])
	}, 60_000)

	it('accepts a request whose sender’s newest notification is at 2^53', async () => {
		const w = await community(['alice'])
		const { alice } = w.users
		const sender = await remoteAccount(w.store, 'a', 'n.example')
		// The job's cursor is the newest notification's id + 1: 2^53 + 1, which a number reads as 2^53.
		await sql(
			w.store,
			`INSERT INTO notifications (id, account_id, type, from_account_id, filtered)
			VALUES (CAST(? AS INTEGER), ?, 'follow', ?, 1)`,
			TWO_53,
			alice.id,
			sender
		)
		const [request] = await sql<{ id: string }>(
			w.store,
			`INSERT INTO notification_requests (account_id, from_account_id, notifications_count) VALUES (?, ?, 1)
			RETURNING CAST(id AS TEXT) AS id`,
			alice.id,
			sender
		)
		const answered = await w.request(
			`/api/v1/notifications/requests/${request!.id}/accept`,
			bearer(alice.token, json({}))
		)
		expect(answered.status).toBe(200)
		expect(await sql(w.store, 'SELECT filtered FROM notifications WHERE from_account_id = ?', sender)).toEqual([
			{ filtered: 0 },
		])
	})

	it('runs an imported request job whose cursor is 2^53 + 1 in a round', async () => {
		const w = await community(['alice'])
		const { alice } = w.users
		const sender = await remoteAccount(w.store, 'a', 'n.example')
		await sql(
			w.store,
			`INSERT INTO notifications (id, account_id, type, from_account_id, filtered)
			VALUES (CAST(? AS INTEGER), ?, 'follow', ?, 1)`,
			TWO_53,
			alice.id,
			sender
		)
		await sql(
			w.store,
			`INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor)
			VALUES (?, ?, 'dismiss', CAST(? AS INTEGER))`,
			alice.id,
			sender,
			NEXT
		)
		expect(await w.store.runNotificationRequestJobs(BUILD, { now: NOW })).toMatchObject({ pending: false })
		expect(await sql(w.store, 'SELECT 1 FROM notifications WHERE from_account_id = ?', sender)).toEqual([])
		expect(await sql(w.store, 'SELECT 1 FROM notification_request_jobs')).toEqual([])
	})

	it('answers a request whose sender’s notifications pass 2^53, and clears them', async () => {
		const w = await community(['alice'])
		const { alice } = w.users
		const senders = [await remoteAccount(w.store, 'a', 'n.example'), await remoteAccount(w.store, 'd', 'n.example')]
		// Each sender's filtered notification, at ids a JavaScript number rounds (2^53 + 1 down, 2^53 + 3 up), with its
		// request: the first is accepted, the second dismissed.
		const requests: string[] = []
		for (const [i, sender] of senders.entries()) {
			await sql(
				w.store,
				`INSERT INTO notifications (id, account_id, type, from_account_id, filtered)
				VALUES (CAST(? AS INTEGER), ?, 'follow', ?, 1)`,
				String(9007199254740993n + 2n * BigInt(i)),
				alice.id,
				sender
			)
			const [row] = await sql<{ id: string }>(
				w.store,
				`INSERT INTO notification_requests (account_id, from_account_id, notifications_count) VALUES (?, ?, 1)
				RETURNING CAST(id AS TEXT) AS id`,
				alice.id,
				sender
			)
			requests.push(row!.id)
		}
		const answer = (id: string, how: string) =>
			w.request(`/api/v1/notifications/requests/${id}/${how}`, bearer(alice.token, json({})))
		expect((await answer(requests[0]!, 'accept')).status).toBe(200)
		expect((await answer(requests[1]!, 'dismiss')).status).toBe(200)
		const stored = () =>
			sql(
				w.store,
				'SELECT CAST(id AS TEXT) AS id, filtered FROM notifications WHERE account_id = ? ORDER BY id',
				alice.id
			)
		// The accepted sender's is shown, the dismissed one's gone, and no job is left.
		expect(await stored()).toEqual([{ id: NEXT, filtered: 0 }])
		expect(await sql(w.store, 'SELECT 1 FROM notification_request_jobs')).toEqual([])
		// A later notification at 2^53 + 5 (which rounds up), then a clear: every one goes, and the clear with them.
		await sql(
			w.store,
			"INSERT INTO notifications (id, account_id, type, from_account_id) VALUES (CAST(? AS INTEGER), ?, 'mention', ?)",
			String(9007199254740992n + 5n),
			alice.id,
			senders[1]!
		)
		expect((await w.request('/api/v1/notifications/clear', bearer(alice.token, json({})))).status).toBe(200)
		expect(await stored()).toEqual([])
		expect(await sql(w.store, 'SELECT 1 FROM notification_clears')).toEqual([])
	})
})

describe('the selection order (RES-5)', () => {
	// Local jobs of generations that ended, each with 3 × REACH_ROUND staged inboxes (a round drops REACH_ROUND), in
	// id order; the rounds each ran, from the inboxes left.
	async function jobs(w: World, n: number): Promise<string[]> {
		const ids: string[] = []
		for (let i = 0; i < n; i++) {
			const [row] = await sql<{ id: string }>(
				w.store,
				`INSERT INTO moderation_jobs (kind, account_id, generation, phase) VALUES ('suspension', ?, ?, 'end')
				RETURNING CAST(id AS TEXT) AS id`,
				w.users.alice.id,
				100 + i
			)
			await stage(w.store, row!.id, 3 * REACH_ROUND)
			ids.push(row!.id)
		}
		return ids
	}
	const roundsRan = async (store: StoreStub, ids: readonly string[]) =>
		Promise.all(
			ids.map(
				async (id) =>
					3 -
					(await sql<{ n: number }>(store, 'SELECT count(*) AS n FROM moderation_reach WHERE job_id = ?', id))[0]!.n /
						REACH_ROUND
			)
		)

	it('runs a due retry before an older fresh job', async () => {
		const w = await community(['alice'])
		const [older, retry] = await jobs(w, 2)
		await setRetry(w.store, MODERATION_JOBS, [retry!], 1, NOW - 1)
		const ran = await writtenBy(w.store, (db) => moderationRound(db, NOW))
		expect(ran.result).toMatchObject({ id: retry, fresh: false })
		expect(await roundsRan(w.store, [older!, retry!])).toEqual([0, 1])
	})

	it('runs a due retry below the turn, past fresh jobs above it', async () => {
		const w = await community(['alice'])
		// The turn is past the third job; the first is a due retry, the others fresh.
		const ids = await jobs(w, 4)
		await setRetry(w.store, MODERATION_JOBS, [ids[0]!], 1, NOW - 1)
		const ran = await writtenBy(w.store, (db) => moderationRound(db, NOW, ids[2]))
		expect(ran.result).toMatchObject({ id: ids[0], fresh: false })
		expect(await roundsRan(w.store, ids)).toEqual([1, 0, 0, 0])
	})

	it('moves the turn past fresh jobs only: a due retry leaves it where it was', async () => {
		const w = await community(['alice'])
		// The due retry first by id, then three fresh jobs; one call runs MODERATION_ROUNDS rounds.
		const ids = await jobs(w, 4)
		await setRetry(w.store, MODERATION_JOBS, [ids[0]!], 1, NOW - 1)
		await w.store.runModerationJobs(BUILD, { now: NOW })
		// The retry, then (now fresh, past the turn's start) the retry again, then the next two; the last waits.
		expect(await roundsRan(w.store, ids)).toEqual([2, 1, 1, 0])
	})
})
