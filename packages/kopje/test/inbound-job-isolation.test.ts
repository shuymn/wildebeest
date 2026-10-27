import { runInDurableObject, env as testEnv } from 'cloudflare:test'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AccessTeam, adminClaims, adminHarness, adminTeam, setTeamAccess } from './access-helpers'
import { bearer, sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { BUILD, rejectionOf } from './helpers'
import { mastodonActor } from './inbox-helpers'
import {
	ALICE,
	announce,
	AS,
	create,
	DAVE,
	followed,
	mastodonNote,
	remove,
	type Setup,
	setup,
	statusRow,
	undo,
} from './inbox-status-helpers'
import { accessAdminStore } from './ops-helpers'
import { QueueSim } from './queue-sim'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { Db } from '../src/db/sql'
import { JOB_BATCHES_PER_RUN, JOB_RETENTION_MS, MOVE_BATCH, PURGE_BATCH, runInboundJobs } from '../src/domain/inbox'
import {
	INBOUND_JOBS,
	JOB_RETRY_DELAYS_MS,
	MAX_JOB_ATTEMPTS,
	recordJobAttempt,
	RETRY_JOBS_LIMIT,
	retryParkedJobs,
	SAFE_MS,
} from '../src/domain/job-attempts'
import { jobsRound } from '../src/jobs/queue'
import type { StoreStub } from '../src/platform/store-client'

// RES-5, RES-6 (D2, D3 of the job-round isolation): each inbound job's batch runs in its own savepoint; a batch that
// fails, or that leaves work and moved nothing, is recorded on its job, which backs off (JOB_RETRY_DELAYS_MS) and
// parks after MAX_JOB_ATTEMPTS, so one job's failure or stall holds back no other job; a request's first batch that
// fails leaves the request's own writes committed.

const MINUTE = 60_000
const FAIL = 'test: the batch fails'

type JobRow = { kind: string; key: string; attempts: number; due_at: number | null; done: number }

const jobs = (store: StoreStub) =>
	sql<JobRow>(
		store,
		'SELECT kind, key, attempts, due_at, done_at IS NOT NULL AS done FROM inbound_jobs ORDER BY created_at, kind, key'
	)

const job = async (store: StoreStub, kind: string, key: string) =>
	(
		await sql<JobRow>(
			store,
			'SELECT kind, key, attempts, due_at, done_at IS NOT NULL AS done FROM inbound_jobs WHERE kind = ? AND key = ?',
			kind,
			key
		)
	)[0]

const round = (store: StoreStub, now: number) => store.runInboundJobs(BUILD, { now })

// A remote account (its id: 4 then 17 digits of n) of `host`.
async function remoteAccount(store: StoreStub, n: number, host = 'jobs.example'): Promise<{ id: string; uri: string }> {
	const id = `4${String(n).padStart(17, '0')}`
	const uri = `https://${host}/users/u${n}`
	await sql(store, 'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)', id, uri, `u${n}`, host)
	return { id, uri }
}

// A public status (its id: 6 then 17 digits of n) of `author`, boosting `of` when given.
async function status(store: StoreStub, n: number, author: string, of?: string): Promise<string> {
	const id = `6${String(n).padStart(17, '0')}`
	await sql(
		store,
		`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
		VALUES (?1, 'https://jobs.example/s/' || ?1, ?2, ?3, 'public', CASE WHEN ?3 IS NULL THEN 'text' ELSE '' END, ?4)`,
		id,
		author,
		of ?? null,
		'2026-10-11T00:00:00.000Z'
	)
	return id
}

async function insertJob(
	store: StoreStub,
	row: { kind: 'purge' | 'delete' | 'move'; key: string; actor: string; at: number; extra?: Record<string, unknown> }
): Promise<void> {
	const extra = row.extra ?? {}
	const columns = ['kind', 'key', 'actor_uri', 'created_at', ...Object.keys(extra)]
	await sql(
		store,
		`INSERT INTO inbound_jobs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
		row.kind,
		row.key,
		row.actor,
		row.at,
		...(Object.values(extra) as SqlStorageValue[])
	)
}

// A remote status whose delete job fails at its first write (a test trigger on its mentions), with the job.
async function failingDelete(store: StoreStub, n: number, at: number): Promise<{ id: string; author: string }> {
	const author = await remoteAccount(store, n)
	const mentioned = await remoteAccount(store, n + 1)
	const id = await status(store, n, author.id)
	await sql(store, 'INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)', id, mentioned.id)
	await sql(
		store,
		`CREATE TRIGGER test_fail_${n} BEFORE DELETE ON status_mentions WHEN old.status_id = '${id}'
		BEGIN SELECT RAISE(ABORT, '${FAIL}'); END`
	)
	await insertJob(store, { kind: 'delete', key: id, actor: author.uri, at })
	return { id, author: author.uri }
}

// The kopje.jobs.item.* events logged, as logged.
function itemLogs() {
	const error = vi.spyOn(console, 'error').mockImplementation(() => {})
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const entries = () =>
		[...error.mock.calls, ...warn.mock.calls]
			.map((args) => args[0] as { event?: string })
			.filter((entry) => typeof entry?.event === 'string' && entry.event.startsWith('kopje.jobs.item.'))
	const everything = () => JSON.stringify([...error.mock.calls, ...warn.mock.calls])
	return { entries, everything }
}

afterEach(() => {
	vi.restoreAllMocks()
})

// Rounds at each due time of the job until it parks: the attempts after each round.
async function untilParked(store: StoreStub, kind: string, key: string, start = NOW): Promise<number[]> {
	const seen: number[] = []
	let at = start
	for (let i = 0; i < 20; i++) {
		await round(store, at)
		const row = (await job(store, kind, key))!
		seen.push(row.attempts)
		if (row.attempts === MAX_JOB_ATTEMPTS || row.done === 1) {
			return seen
		}
		at = row.due_at ?? at
	}
	throw new Error(`the ${kind} job did not park`)
}

describe('a failing job is isolated, backs off and parks (D2, D3)', () => {
	it('parks a permanently failing first job after MAX_JOB_ATTEMPTS while a purge, a Move and a delete behind it finish', async () => {
		const t = await setup()
		const logs = itemLogs()
		const failing = await failingDelete(t.store, 1, NOW - 10)
		// A purge of carol (one status), a Move of dan's followers (alice) to erin, and a delete of a bare status.
		const carol = await remoteAccount(t.store, 10)
		await status(t.store, 10, carol.id)
		await insertJob(t.store, { kind: 'purge', key: carol.uri, actor: carol.uri, at: NOW - 9 })
		const dan = await remoteAccount(t.store, 20)
		const erin = await remoteAccount(t.store, 21)
		const [edge] = await sql<{ id: string }>(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted') RETURNING CAST(id AS TEXT) AS id",
			ALICE,
			dan.id
		)
		const move = `${dan.uri}#move`
		await insertJob(t.store, {
			kind: 'move',
			key: move,
			actor: dan.uri,
			at: NOW - 8,
			extra: { target_account_id: erin.id, bound: edge!.id, cursor: '0' },
		})
		const bare = await status(t.store, 30, carol.id === '' ? '' : (await remoteAccount(t.store, 30)).id)
		await insertJob(t.store, { kind: 'delete', key: bare, actor: 'https://jobs.example/users/u30', at: NOW - 7 })

		// The first round: the failing job takes one batch, the three behind it the others (JOB_BATCHES_PER_RUN).
		expect(JOB_BATCHES_PER_RUN).toBe(4)
		expect(await round(t.store, NOW)).toMatchObject({ pending: false })
		expect(await jobs(t.store)).toEqual([
			{ kind: 'delete', key: failing.id, attempts: 1, due_at: NOW + JOB_RETRY_DELAYS_MS[0]!, done: 0 },
			{ kind: 'purge', key: carol.uri, attempts: 0, due_at: null, done: 1 },
			{ kind: 'move', key: move, attempts: 0, due_at: null, done: 1 },
			{ kind: 'delete', key: bare, attempts: 0, due_at: null, done: 1 },
		])
		// Their work is done: carol is gone, alice follows erin and no longer dan, the bare status is gone.
		expect(await sql(t.store, 'SELECT 1 FROM accounts WHERE id = ?', carol.id)).toEqual([])
		expect(
			await sql(t.store, 'SELECT target_account_id AS target FROM follows WHERE account_id = ? ORDER BY 1', ALICE)
		).toEqual([{ target: erin.id }])
		expect(await sql(t.store, 'SELECT 1 FROM statuses WHERE id = ?', bare)).toEqual([])

		// Before it is due, a round runs nothing and asks for no other (no hot loop).
		expect(await round(t.store, NOW + JOB_RETRY_DELAYS_MS[0]! - 1)).toMatchObject({ pending: false })
		expect((await job(t.store, 'delete', failing.id))!.attempts).toBe(1)
		// At each due time one more attempt, each delay in turn, then parked: never selected again.
		const attempts = await untilParked(t.store, 'delete', failing.id, NOW + JOB_RETRY_DELAYS_MS[0]!)
		expect(attempts).toEqual([2, 3, 4, 5, 6])
		expect(await job(t.store, 'delete', failing.id)).toEqual({
			kind: 'delete',
			key: failing.id,
			attempts: MAX_JOB_ATTEMPTS,
			due_at: null,
			done: 0,
		})
		expect(await round(t.store, NOW + 365 * 24 * 60 * MINUTE)).toMatchObject({ pending: false })
		expect((await job(t.store, 'delete', failing.id))!.attempts).toBe(MAX_JOB_ATTEMPTS)
		// The status is kept (the job fails safe) with its mention.
		expect(await sql(t.store, 'SELECT count(*) AS n FROM status_mentions WHERE status_id = ?', failing.id)).toEqual([
			{ n: 1 },
		])

		// Logged by family, outcome and count, never by key (DATA-5).
		expect(logs.entries()).toEqual([
			...[1, 2, 3, 4, 5].map((n) => ({
				event: 'kopje.jobs.item.failed',
				family: 'inbound',
				outcome: 'error',
				attempts: n,
				parked: false,
				error: 'Error',
			})),
			{
				event: 'kopje.jobs.item.failed',
				family: 'inbound',
				outcome: 'error',
				attempts: 6,
				parked: true,
				error: 'Error',
			},
			{ event: 'kopje.jobs.item.parked', family: 'inbound' },
		])
		for (const secret of [failing.id, failing.author, FAIL]) {
			expect(logs.everything()).not.toContain(secret)
		}
	}, 60_000)

	it('runs imported retry states as stored, and the CHECKs refuse every other pair', async () => {
		const t = await setup()
		const states: Record<string, [number, number | null]> = {
			due: [5, NOW - 1],
			parked: [6, null],
			fresh: [0, null],
			far: [3, SAFE_MS],
		}
		const ids: Record<string, string> = {}
		let n = 100
		for (const [name, [attempts, due]] of Object.entries(states)) {
			const failing = await failingDelete(t.store, n, NOW - 100 + n)
			ids[name] = failing.id
			await sql(
				t.store,
				"UPDATE inbound_jobs SET attempts = ?, due_at = ? WHERE kind = 'delete' AND key = ?",
				attempts,
				due,
				failing.id
			)
			n += 10
		}
		expect(await round(t.store, NOW)).toMatchObject({ pending: false })
		const after = Object.fromEntries(
			await Promise.all(
				Object.entries(ids).map(async ([name, id]) => {
					const row = (await job(t.store, 'delete', id))!
					return [name, [row.attempts, row.due_at]] as const
				})
			)
		)
		expect(after).toEqual({
			// The 5th failure was due: its 6th parks it.
			due: [6, null],
			parked: [6, null],
			fresh: [1, NOW + JOB_RETRY_DELAYS_MS[0]!],
			far: [3, SAFE_MS],
		})
		const set = (attempts: SqlStorageValue, due: SqlStorageValue) =>
			sql(
				t.store,
				"UPDATE inbound_jobs SET attempts = ?, due_at = ? WHERE kind = 'delete' AND key = ?",
				attempts,
				due,
				ids.fresh!
			)
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
			await expect(set(attempts, due), JSON.stringify([attempts, due])).rejects.toThrow(/CHECK constraint failed/)
		}
		await expect(set(null, null)).rejects.toThrow(/NOT NULL constraint failed/)
		// The guarded branch: the accepted pairs.
		for (const [attempts, due] of [
			[0, null],
			[1, 0],
			[5, SAFE_MS],
			[6, null],
		] as [number, number | null][]) {
			await set(attempts, due)
		}
	})

	it('clamps a delay to SAFE_MS, counts from 0 before the epoch, and parks at the last attempt', async () => {
		const t = await setup()
		const delayed = await failingDelete(t.store, 200, NOW)
		const parked = await failingDelete(t.store, 210, NOW)
		await sql(t.store, 'UPDATE inbound_jobs SET attempts = 5, due_at = 0 WHERE key = ?', parked.id)
		const attempt = (key: string, now: number) =>
			runInDurableObject(t.store, (_instance, state) => {
				vi.spyOn(console, 'error').mockImplementation(() => {})
				vi.spyOn(console, 'warn').mockImplementation(() => {})
				state.storage.transactionSync(() =>
					recordJobAttempt(new Db(state.storage.sql), INBOUND_JOBS, ['delete', key], now, { outcome: 'stall' })
				)
			})
		await attempt(delayed.id, -5)
		expect((await job(t.store, 'delete', delayed.id))!.due_at).toBe(JOB_RETRY_DELAYS_MS[0])
		await attempt(delayed.id, SAFE_MS - 1)
		expect(await job(t.store, 'delete', delayed.id)).toMatchObject({ attempts: 2, due_at: SAFE_MS })
		await attempt(parked.id, NOW)
		expect(await job(t.store, 'delete', parked.id)).toMatchObject({ attempts: 6, due_at: null })
		// A parked row is not changed again.
		await attempt(parked.id, NOW)
		expect(await job(t.store, 'delete', parked.id)).toMatchObject({ attempts: 6, due_at: null })
	})

	it('counts no attempt while the Store is in maintenance (RES-5)', async () => {
		const t = await setup()
		const failing = await failingDelete(t.store, 300, NOW)
		const version = (t.env as unknown as { CF_VERSION_METADATA: { id: string } }).CF_VERSION_METADATA.id
		expect(await t.store.setMaintenance(version, true)).toEqual({ maintenance: true })
		expect(String(await rejectionOf(round(t.store, NOW)))).toMatch(/maintenance/)
		expect((await job(t.store, 'delete', failing.id))!.attempts).toBe(0)
		// The guarded branch: out of maintenance the same round counts its attempt.
		expect(await t.store.setMaintenance(version, false)).toEqual({ maintenance: false })
		vi.spyOn(console, 'error').mockImplementation(() => {})
		await round(t.store, NOW)
		expect((await job(t.store, 'delete', failing.id))!.attempts).toBe(1)
	})
})

describe('a request’s first batch (D3)', () => {
	// bob's public status with a hashtag and a mention of alice, stored through his Create.
	async function tagged() {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob, {
			content: '<p>#kopje @alice</p>',
			tag: [
				{ type: 'Hashtag', name: '#kopje', href: 'https://mastodon.example/tags/kopje' },
				{ type: 'Mention', name: '@alice@kopje.test', href: 'https://kopje.test/ap/users/alice' },
			],
		})
		expect(await t.post(bob, create(bob, note))).toBe(202)
		const row = (await statusRow(t.store, note.id))!
		return { t, bob, note, id: row.id }
	}

	it('rolls a failing first batch back after its writes, and commits the Delete’s retraction and hide (202)', async () => {
		const { t, bob, note, id } = await tagged()
		expect(await sql(t.store, 'SELECT account_id FROM status_mentions WHERE status_id = ?', id)).toEqual([
			{ account_id: ALICE },
		])
		expect(await sql(t.store, 'SELECT public FROM status_tags WHERE status_id = ?', id)).toEqual([{ public: 1 }])
		// The batch deletes the mention first, then fails taking the hashtag off the index.
		await sql(
			t.store,
			`CREATE TRIGGER test_untag BEFORE UPDATE ON status_tags WHEN old.status_id = '${id}'
			BEGIN SELECT RAISE(ABORT, '${FAIL}'); END`
		)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		// The batch's writes are rolled back: the mention is back.
		expect(await sql(t.store, 'SELECT account_id FROM status_mentions WHERE status_id = ?', id)).toEqual([
			{ account_id: ALICE },
		])
		// The request's own writes committed: the retraction, the hide, and the job with its attempt.
		expect(await sql(t.store, 'SELECT 1 AS x FROM inbound_retractions WHERE target_uri = ?', note.id)).not.toEqual([])
		expect(await sql(t.store, 'SELECT withdrawn, visibility, content FROM statuses WHERE id = ?', id)).toEqual([
			{ withdrawn: 1, visibility: 'direct', content: '' },
		])
		expect(await job(t.store, 'delete', id)).toEqual({
			kind: 'delete',
			key: id,
			attempts: 1,
			due_at: NOW + JOB_RETRY_DELAYS_MS[0]!,
			done: 0,
		})
	})

	it('runs no batch for a redelivered Delete of a job a round failed while the redelivery awaited its key fetch', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		const id = (await statusRow(t.store, note.id))!.id
		// More mentions than one batch removes, so the Delete's first batch leaves work.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('4%017d', i), 'https://many.example/u/' || i,
				'u' || i, 'many.example' FROM n`,
			id,
			PURGE_BATCH + 100
		)
		await sql(
			t.store,
			"INSERT INTO status_mentions (status_id, account_id) SELECT ?, id FROM accounts WHERE domain = 'many.example'",
			id
		)
		const deletion = remove(bob, note.id)
		expect(await t.post(bob, deletion)).toBe(202)
		expect(await job(t.store, 'delete', id)).toMatchObject({ attempts: 0, done: 0 })
		await sql(
			t.store,
			`CREATE TRIGGER test_fail_mentions BEFORE DELETE ON status_mentions WHEN old.status_id = '${id}'
			BEGIN SELECT RAISE(ABORT, '${FAIL}'); END`
		)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		// The redelivery's key is stale, so the Worker fetches bob's document first: held there.
		await sql(t.store, 'UPDATE remote_keys SET fetched_at = 0')
		const fetches = () => t.web.fetched.filter((url) => url === bob.uri).length
		const before = fetches()
		const held = t.web.hold(bob.uri)
		const redelivery = t.post(bob, deletion)
		await held.reached
		await round(t.store, NOW)
		expect(await job(t.store, 'delete', id)).toMatchObject({ attempts: 1, due_at: NOW + JOB_RETRY_DELAYS_MS[0]! })
		held.release()
		expect(await redelivery).toBe(202)
		// The redelivery found the job backing off: no batch, no attempt.
		expect(await job(t.store, 'delete', id)).toMatchObject({ attempts: 1, due_at: NOW + JOB_RETRY_DELAYS_MS[0]! })
		// The guarded branch: the fetch was the one held.
		expect(fetches()).toBe(before + 1)
	})
})

describe('what a batch counts as progress (D3)', () => {
	it('advances a purge by its slot retirement, then stalls on a row it cannot remove and parks', async () => {
		const t = await setup()
		const logs = itemLogs()
		const carol = await remoteAccount(t.store, 400)
		// More of carol's cached files than one batch retires (three rows each).
		const slots = Math.ceil(PURGE_BATCH / 3) + 50
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at, failed_at)
			SELECT 'attachment', printf('5%017d', i), ?1, 'https://files.example/m/' || i, 'files.example', 'image', 1, 0, 1, 1
			FROM n`,
			carol.id,
			slots
		)
		// An imported delete job naming carol (PURGED_ACCOUNT_CHILDREN), which no step of her purge removes.
		const other = await remoteAccount(t.store, 401)
		await insertJob(t.store, {
			kind: 'delete',
			key: await status(t.store, 401, other.id),
			actor: other.uri,
			at: NOW + 1,
			extra: { target_account_id: carol.id, done_at: NOW, expires_at: NOW + JOB_RETENTION_MS },
		})
		await sql(t.store, "UPDATE accounts SET deleted_at = '2026-10-11T00:00:00.000Z' WHERE id = ?", carol.id)
		await insertJob(t.store, { kind: 'purge', key: carol.uri, actor: carol.uri, at: NOW })
		await round(t.store, NOW)
		// Two batches retired every slot (each advanced), the third moved nothing: one attempt.
		expect(await sql(t.store, 'SELECT count(*) AS n FROM remote_media WHERE account_id = ?', carol.id)).toEqual([
			{ n: 0 },
		])
		expect(await job(t.store, 'purge', carol.uri)).toMatchObject({ attempts: 1, done: 0 })
		expect(await untilParked(t.store, 'purge', carol.uri, NOW + JOB_RETRY_DELAYS_MS[0]!)).toEqual([2, 3, 4, 5, 6])
		expect(logs.entries().filter((e) => e.event === 'kopje.jobs.item.failed')).toEqual(
			[1, 2, 3, 4, 5, 6].map((n) => ({
				event: 'kopje.jobs.item.failed',
				family: 'inbound',
				outcome: 'stall',
				attempts: n,
				parked: n === 6,
			}))
		)
		// Fails safe: the tombstone and the account stay.
		expect(await sql(t.store, 'SELECT deleted_at IS NOT NULL AS deleted FROM accounts WHERE id = ?', carol.id)).toEqual(
			[{ deleted: 1 }]
		)
	})

	it('advances a Move by its cursor compared in SQL, over followers it cannot move, ids past 2^53', async () => {
		const t = await setup()
		const dan = await remoteAccount(t.store, 500)
		const erin = await remoteAccount(t.store, 501)
		// MOVE_BATCH + 20 local followers of dan, each blocking erin (so none is moved), their follow ids from 2^60 + 1:
		// a JavaScript number reads the first MOVE_BATCH + 20 of them as one value.
		const base = 2n ** 60n
		const followers = MOVE_BATCH + 20
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('3%017d', i),
				'https://kopje.test/ap/users/m' || i, 'm' || i, NULL FROM n`,
			followers
		)
		await sql(
			t.store,
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@mail.example', X'00', X'00', 'k' FROM accounts WHERE id GLOB '3*'`
		)
		await sql(
			t.store,
			`INSERT INTO follows (id, account_id, target_account_id, state)
			SELECT CAST(?1 AS INTEGER) + CAST(substr(id, 2) AS INTEGER), id, ?2, 'accepted' FROM accounts WHERE id GLOB '3*'`,
			base.toString(),
			dan.id
		)
		await sql(
			t.store,
			"INSERT INTO blocks (account_id, target_account_id, created_at) SELECT id, ?, '2026-10-01T00:00:00.000Z' FROM accounts WHERE id GLOB '3*'",
			erin.id
		)
		expect(Number(base + 1n)).toBe(Number(base + BigInt(MOVE_BATCH)))
		const key = `${dan.uri}#move`
		await insertJob(t.store, {
			kind: 'move',
			key,
			actor: dan.uri,
			at: NOW,
			extra: { target_account_id: erin.id, bound: (base + BigInt(followers)).toString(), cursor: base.toString() },
		})
		const batch = () =>
			runInDurableObject(t.store, (_instance, state) =>
				state.storage.transactionSync(() =>
					runInboundJobs.run(state.storage.sql, { now: NOW }, (fn) => state.storage.transactionSync(fn))
				)
			)
		await batch()
		// The round's batches moved its cursor past every follower: done, no attempt.
		expect(await job(t.store, 'move', key)).toMatchObject({ attempts: 0, done: 1 })
		// No follower moved: each still follows dan.
		expect(await sql(t.store, 'SELECT count(*) AS n FROM follows WHERE target_account_id = ?', dan.id)).toEqual([
			{ n: followers },
		])
	})
})

describe('a boost of a boost (#1247)', () => {
	type Chain = { t: Setup; job: { kind: string; key: string }; start: () => Promise<void> }

	// The chains: a local O boosted by B0, boosted by B1 (alice's DELETE of O); a remote S boosted by R, boosted by I
	// (bob's Delete of S); and the same of bob's purge (his DeleteActor).
	async function localChain(): Promise<Chain> {
		const t = await setup()
		const posted = await t.request('/api/v1/statuses', {
			method: 'POST',
			headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'O' }),
		})
		const o = await posted.json<{ id: string }>()
		const b0 = await status(t.store, 600, DAVE, o.id)
		await status(t.store, 601, ALICE, b0)
		return {
			t,
			job: { kind: 'delete', key: o.id },
			start: async () => {
				const deleted = await t.request(`/api/v1/statuses/${o.id}`, bearer(t.tokens.alice, { method: 'DELETE' }))
				expect(deleted.status).toBe(200)
			},
		}
	}

	async function remoteChain(purge: boolean): Promise<Chain> {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		const s = (await statusRow(t.store, note.id))!.id
		const carol = await remoteAccount(t.store, 610)
		const erin = await remoteAccount(t.store, 611)
		const r = await status(t.store, 610, carol.id, s)
		await status(t.store, 611, erin.id, r)
		return {
			t,
			job: purge ? { kind: 'purge', key: bob.uri } : { kind: 'delete', key: s },
			start: async () => {
				if (purge) {
					t.web.fail(bob.uri, 410)
					expect(
						await t.post(bob, {
							'@context': AS,
							id: `${bob.uri}#delete`,
							type: 'Delete',
							actor: bob.uri,
							object: bob.uri,
						})
					).toBe(202)
				} else {
					expect(await t.post(bob, remove(bob, note.id))).toBe(202)
				}
			},
		}
	}

	it.each([
		['a local status’s delete', () => localChain()],
		['a remote status’s delete', () => remoteChain(false)],
		['a purge', () => remoteChain(true)],
	])(
		'parks %s that a chain stalls, as a stall, while another job finishes',
		async (_name, make) => {
			const chain = await make()
			const { t } = chain
			const logs = itemLogs()
			const zed = await remoteAccount(t.store, 690)
			await status(t.store, 690, zed.id)
			await insertJob(t.store, { kind: 'purge', key: zed.uri, actor: zed.uri, at: NOW + 1 })
			await chain.start()
			const attempts = await untilParked(t.store, chain.job.kind, chain.job.key)
			expect(attempts.at(-1)).toBe(MAX_JOB_ATTEMPTS)
			expect(await job(t.store, 'purge', zed.uri)).toMatchObject({ done: 1, attempts: 0 })
			const failed = logs.entries().filter((e) => e.event === 'kopje.jobs.item.failed') as { outcome: string }[]
			expect(failed.map((e) => e.outcome)).toEqual(Array<string>(MAX_JOB_ATTEMPTS).fill('stall'))
		},
		60_000
	)
})

describe('a remote boost that a status boosts (G-7)', () => {
	// bob's public S, carol's boost R of it (her Announce), and `depth` imported statuses boosting R in a chain.
	async function boosted(depth: number) {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const carol = await mastodonActor(t.web, 'carol')
		await followed(t, carol)
		const note = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		const announcement = announce(carol, note.id)
		expect(await t.post(carol, announcement)).toBe(202)
		const r = (await sql<{ id: string }>(t.store, 'SELECT id FROM statuses WHERE uri = ?', announcement.id))[0]!.id
		const erin = await remoteAccount(t.store, 700)
		await sql(
			t.store,
			`WITH RECURSIVE n(i, id, of) AS (SELECT 1, printf('6%017d', 1), ?1
				UNION ALL SELECT i + 1, printf('6%017d', i + 1), printf('6%017d', i) FROM n WHERE i < ?2)
			INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
			SELECT id, 'https://jobs.example/b/' || i, ?3, of, 'public', '2026-10-11T00:00:00.000Z' FROM n`,
			r,
			depth,
			erin.id
		)
		return { t, bob, carol, note, announcement, r }
	}

	const kept = async (store: StoreStub, id: string) =>
		(await sql<{ withdrawn: number }>(store, 'SELECT withdrawn FROM statuses WHERE id = ?', id))[0]

	it('hides a boosted boost at its Delete and removes it with its boost through the job', async () => {
		const { t, carol, announcement, r } = await boosted(1)
		expect(await t.post(carol, remove(carol, announcement.id))).toBe(202)
		// Not deleted at once (which would cascade into its boost): hidden, its job written.
		expect(await kept(t.store, r)).toEqual({ withdrawn: 1 })
		expect(await job(t.store, 'delete', r)).toMatchObject({ attempts: 0, done: 0 })
		expect(await round(t.store, NOW)).toMatchObject({ pending: false })
		expect(await kept(t.store, r)).toBeUndefined()
		expect(await sql(t.store, "SELECT 1 FROM statuses WHERE uri GLOB 'https://jobs.example/b/*'")).toEqual([])
		expect(await job(t.store, 'delete', r)).toMatchObject({ done: 1 })
	})

	it('answers an Undo of a boost atop a chain deeper than SQLite’s trigger depth, whose job parks while another finishes', async () => {
		const { t, carol, announcement, r } = await boosted(1_100)
		const logs = itemLogs()
		const zed = await remoteAccount(t.store, 790)
		await status(t.store, 5_000, zed.id)
		await insertJob(t.store, { kind: 'purge', key: zed.uri, actor: zed.uri, at: NOW + 1 })
		expect(await t.post(carol, undo(carol, announcement))).toBe(202)
		expect(await kept(t.store, r)).toEqual({ withdrawn: 1 })
		expect(await untilParked(t.store, 'delete', r)).toContain(MAX_JOB_ATTEMPTS)
		expect(await job(t.store, 'purge', zed.uri)).toMatchObject({ done: 1 })
		expect(await sql(t.store, "SELECT count(*) AS n FROM statuses WHERE uri GLOB 'https://jobs.example/b/*'")).toEqual([
			{ n: 1_100 },
		])
		expect(logs.entries().at(-1)).toEqual({ event: 'kopje.jobs.item.parked', family: 'inbound' })
	}, 60_000)

	it('runs no immediate delete for a replay once the job removed the boost’s boosts', async () => {
		const { t, carol, announcement, r } = await boosted(1)
		const deletion = remove(carol, announcement.id)
		expect(await t.post(carol, deletion)).toBe(202)
		// The job's partial cleanup: the boost's boost gone, the boost and the job kept.
		await sql(t.store, "DELETE FROM statuses WHERE uri GLOB 'https://jobs.example/b/*'")
		const captured = async () => (await sql(t.store, 'SELECT count(*) AS n FROM stream_delete_viewers'))[0]
		const before = await captured()
		expect(await t.post(carol, deletion)).toBe(202)
		expect(await kept(t.store, r)).toEqual({ withdrawn: 1 })
		expect(await captured()).toEqual(before)
		// The guarded branch: the job removes it.
		expect(await round(t.store, NOW)).toMatchObject({ pending: false })
		expect(await kept(t.store, r)).toBeUndefined()
	})
})

describe('the seeks under stale statistics (RES-7)', () => {
	it('reads the next job, the retry walk and the due checks by their indexes and keys with 20,000 failing jobs', async () => {
		const t = await setup()
		const { after } = await staleStatistics(t, {
			grow: async () => {
				// 10,000 parked, 10,000 backing off (due an hour later), 10 due retries and 10 fresh jobs, the last two of
				// statuses that are gone (each batch finishes its job).
				await sql(
					t.store,
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20020)
					INSERT INTO inbound_jobs (kind, key, actor_uri, created_at, attempts, due_at)
					SELECT 'delete', printf('9%017d', i), 'https://jobs.example/users/x', i,
						CASE WHEN i <= 10000 THEN 6 WHEN i <= 20000 THEN 3 WHEN i <= 20010 THEN 1 ELSE 0 END,
						CASE WHEN i <= 10000 THEN NULL WHEN i <= 20000 THEN ?1 + 3600000 WHEN i <= 20010 THEN ?1 - i END
					FROM n`,
					NOW
				)
			},
			capture: async (phase) => {
				if (phase === 'before') {
					return []
				}
				// A round of due retries, then rounds of the fresh jobs (none due then), then the retry walk.
				const rounds = []
				for (let i = 0; i < 6; i++) {
					rounds.push(...(await plannedRun(t, /inbound_jobs/, runInboundJobs, { now: NOW }, true)).plans)
				}
				const retry = await plannedRun(t, /inbound_jobs/, retryParkedJobs, {}, true)
				return [...rounds, ...retry.plans]
			},
		})
		// The jobs the rounds ran: the 10 due retries and the 10 fresh jobs.
		expect(
			await sql(t.store, "SELECT count(*) AS n FROM inbound_jobs WHERE done_at IS NOT NULL AND key GLOB '9*'")
		).toEqual([{ n: 20 }])
		// No statement scans the table; a seek of a partial index without a range (the oldest fresh job, the retry walk)
		// reads its first rows only, each a candidate of the index's own predicate, within its LIMIT.
		for (const statement of after) {
			const scans = scansOf(statement.plan, ['inbound_jobs']).filter(
				(detail) => !/USING (?:COVERING )?INDEX inbound_jobs_(?:fresh|failing)\b/.test(detail)
			)
			expect(scans, statement.query).toEqual([])
		}
		const seeks = after.filter(
			(s) => /INDEXED BY inbound_jobs_(?:failing|fresh)/.test(s.query) && /^\s*SELECT/.test(s.query)
		)
		expect(seeks.some((s) => s.query.includes('inbound_jobs_fresh'))).toBe(true)
		expect(seeks.some((s) => s.query.includes('due_at <= ?1'))).toBe(true)
		for (const seek of seeks) {
			expect(seek.rows, seek.query).toBeLessThanOrEqual(2)
		}
		const walk = after.find((s) =>
			/^\s*UPDATE inbound_jobs SET attempts = 0, due_at = NULL WHERE \(kind/.test(s.query)
		)!
		// At its cap (RETRY_JOBS_LIMIT failing rows reset): a fixed number of reads per row reset (its index entry, its
		// row by key, its index rewrites and its RETURNING row), none for the 19,900 failing rows past the limit.
		expect(walk.rows).toBeLessThanOrEqual(5 * RETRY_JOBS_LIMIT)
		// The job's own reads are by its key.
		const keyed = after.filter((s) => /WHERE kind = \?2 AND key = \?3/.test(s.query))
		expect(keyed.length).toBeGreaterThan(0)
		for (const read of keyed) {
			expect(read.plan.join(' | '), read.query).toMatch(/SEARCH inbound_jobs USING PRIMARY KEY/)
		}
	}, 120_000)
})

describe('retry-all (D8, RES-5)', () => {
	let team: AccessTeam

	beforeEach(async () => {
		team = await adminTeam()
	})

	async function admin() {
		const store = await accessAdminStore()
		await setTeamAccess(store, team)
		return { store, ...adminHarness(store, team) }
	}

	// `n` failing jobs, the first half parked and the rest backing off, each with a cursor and a bound, and one fresh.
	async function failing(store: StoreStub, n: number): Promise<void> {
		await sql(
			store,
			`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1 + 1)
			INSERT INTO inbound_jobs (kind, key, actor_uri, cursor, bound, created_at, attempts, due_at)
			SELECT 'delete', printf('9%017d', i), 'https://jobs.example/users/x', 'c' || i, 'b' || i, i,
				CASE WHEN i > ?1 THEN 0 WHEN i <= ?1 / 2 THEN 6 ELSE 2 END,
				CASE WHEN i > ?1 OR i <= ?1 / 2 THEN NULL ELSE ?2 + i END
			FROM k`,
			n,
			NOW + 60 * MINUTE
		)
	}

	const states = (store: StoreStub) =>
		sql<{ fresh: number; failing: number; kept: number }>(
			store,
			`SELECT sum(attempts = 0 AND due_at IS NULL) AS fresh, sum(attempts > 0) AS failing,
				sum(cursor = 'c' || CAST(substr(key, 2) AS INTEGER) AND bound = 'b' || CAST(substr(key, 2) AS INTEGER)
					AND done_at IS NULL) AS kept
			FROM inbound_jobs`
		)

	it('makes 150 failing jobs fresh, 100 then 50 a call, keeping their state, with one nudge per call that reset any', async () => {
		const { store, post, request, jobs: nudges } = await admin()
		await failing(store, 150)
		expect(await states(store)).toEqual([{ fresh: 1, failing: 150, kept: 151 }])
		// Unauthenticated: refused before the Store.
		expect((await request('/admin/jobs/retry', { method: 'POST' })).status).toBe(401)
		expect(await states(store)).toEqual([{ fresh: 1, failing: 150, kept: 151 }])
		const call = async () => (await post(adminClaims(), '/admin/jobs/retry')).json()
		expect(await call()).toEqual({ reset: RETRY_JOBS_LIMIT, more: true })
		expect(nudges).toHaveBeenCalledTimes(1)
		expect(await states(store)).toEqual([{ fresh: 101, failing: 50, kept: 151 }])
		expect(await call()).toEqual({ reset: 50, more: false })
		expect(nudges).toHaveBeenCalledTimes(2)
		expect(await call()).toEqual({ reset: 0, more: false })
		expect(nudges).toHaveBeenCalledTimes(2)
		expect(await states(store)).toEqual([{ fresh: 151, failing: 0, kept: 151 }])
	})

	it('resets a job a held round failed, and the next round runs it again', async () => {
		const { store, post } = await admin()
		const failed = await failingDelete(store, 900, NOW)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		// The round held after its inbound family, at its next Store call.
		let reached!: () => void
		let release!: () => void
		const arrived = new Promise<void>((resolve) => (reached = resolve))
		const gate = new Promise<void>((resolve) => (release = resolve))
		const held = new Proxy(store, {
			get(target, name, receiver) {
				if (name === 'runDomainBlockCleanups') {
					return async (...args: Parameters<StoreStub['runDomainBlockCleanups']>) => {
						reached()
						await gate
						return target.runDomainBlockCleanups(...args)
					}
				}
				return Reflect.get(target, name, receiver) as unknown
			},
		})
		const sim = new QueueSim()
		const env = { ...testEnv, QUEUE: sim.queue, MAINTENANCE: 'off' } as unknown as Env
		const running = jobsRound(
			env,
			inboxDeps(() => held)
		)
		await arrived
		expect(await job(store, 'delete', failed.id)).toMatchObject({ attempts: 1 })
		expect(await (await post(adminClaims(), '/admin/jobs/retry')).json()).toEqual({ reset: 1, more: false })
		release()
		await running
		// The rest of the round left it fresh; the next round runs it (and it fails again).
		expect(await job(store, 'delete', failed.id)).toMatchObject({ attempts: 0, due_at: null })
		await round(store, NOW)
		expect(await job(store, 'delete', failed.id)).toMatchObject({ attempts: 1 })
	})
})
