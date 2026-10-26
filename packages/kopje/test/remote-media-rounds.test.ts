import { env } from 'cloudflare:workers'

import { describe, expect, it, vi } from 'vitest'

import { sql } from './api-helpers'
import { BUILD } from './helpers'
import { GIF, mediaWorld, PNG } from './remote-media-helpers'
import { Db } from '../src/db/sql'
import { PURGE_BATCH, PURGED_ACCOUNT_REFERENCES, purgeBatch } from '../src/domain/inbox'
import { claimRemoteMedia, LANE0_CLAIMS } from '../src/domain/remote-media'
import {
	admitted,
	MAINTENANCE_MS,
	outstandingRemoteMediaCalls,
	PUT_MS,
	R2_DELETE_MS,
	REMOTE_MEDIA_OWN_STORE_CALLS,
	REMOTE_MEDIA_PUTS,
} from '../src/federation/remote-media'
import type { StoreStub } from '../src/platform/store-client'

// The round (federation/remote-media.ts) over the production paths: the Store's calls, the sink, the bucket, with
// explicit barriers where an actor is held while another commits.

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

// The Store stub with every call counted by method, and `hook` run before the one named.
function counted(store: StoreStub, hook?: { method: string; before: (n: number) => Promise<void> }) {
	const calls: string[] = []
	const stub = new Proxy(store, {
		get: (target, key) => {
			const real = Reflect.get(target, key) as unknown
			if (typeof key !== 'string' || typeof real !== 'function' || key === 'fetch') {
				return real
			}
			return async (...args: unknown[]) => {
				const n = calls.filter((call) => call === key).length
				calls.push(key)
				if (hook?.method === key) {
					await hook.before(n)
				}
				return (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[key]!(...args)
			}
		},
	})
	return { stub, calls }
}

// A bucket over the real one whose puts are recorded and may be held.
function heldBucket(hold?: (key: string) => Promise<void>) {
	const puts: string[] = []
	const bucket = new Proxy(env.MEDIA, {
		get: (target, key) => {
			const real = Reflect.get(target, key) as unknown
			if (key !== 'put' || typeof real !== 'function') {
				return typeof real === 'function' ? (real as (...a: unknown[]) => unknown).bind(target) : real
			}
			return async (k: string, ...rest: unknown[]) => {
				puts.push(k)
				await hold?.(k)
				return (real as (...a: unknown[]) => Promise<unknown>).call(target, k, ...rest)
			}
		},
	})
	return { bucket, puts }
}

describe('the round, its calls and budgets', () => {
	it(
		'makes the derived own Store calls and puts through a full round of files with stills',
		{ timeout: 60_000 },
		async () => {
			const w = await mediaWorld()
			for (let i = 0; i < LANE0_CLAIMS; i++) {
				const a = await w.remote({ avatar: `https://files.example/g${i}.gif` })
				w.serve(a.avatar!, GIF)
			}
			const { stub, calls } = counted(w.t.store)
			const { bucket, puts } = heldBucket()
			const out = await w.round({ store: () => stub, bucket: () => bucket })
			expect(out).toMatchObject({ claimed: LANE0_CLAIMS, stored: LANE0_CLAIMS })
			const own = calls.filter((call) => call !== 'webHopRefused')
			const count = (method: string) => own.filter((call) => call === method).length
			// The maintenance, the orphan sweep's lookup (due on the first round), the claim, and per file two admissions and
			// a record; no deletion or validation was due.
			expect({
				maintain: count('maintainRemoteMedia'),
				orphans: count('remoteMediaOrphans'),
				claim: count('claimRemoteMedia'),
				admit: count('admitRemoteMedia'),
				record: count('recordRemoteMedia'),
				all: own.length,
			}).toEqual({
				maintain: 1,
				orphans: 1,
				claim: 1,
				admit: 2 * LANE0_CLAIMS,
				record: LANE0_CLAIMS,
				all: 3 + 3 * LANE0_CLAIMS,
			})
			expect(own.length).toBeLessThanOrEqual(REMOTE_MEDIA_OWN_STORE_CALLS)
			expect(REMOTE_MEDIA_OWN_STORE_CALLS).toBe(78)
			// Each file's one hop is admitted before and after its DNS check.
			expect(calls.filter((call) => call === 'webHopRefused')).toHaveLength(2 * LANE0_CLAIMS)
			expect(puts).toHaveLength(REMOTE_MEDIA_PUTS)
			await w.exact()
		}
	)

	it('records a partial when maintenance is entered between the full put and the still put', async () => {
		const w = await mediaWorld()
		const a = await w.remote({ avatar: 'https://files.example/g.gif' })
		w.serve(a.avatar!, GIF)
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const { stub, calls } = counted(w.t.store, {
			method: 'admitRemoteMedia',
			before: async (n) => {
				if (n === 1) {
					await w.t.store.setMaintenance(BUILD, true)
				}
			},
		})
		try {
			const out = await w.round({ store: () => stub })
			// The record is refused too (a write in maintenance): the reservation stays, to be doomed by its expiry.
			expect(out).toMatchObject({ claimed: 1, stored: 0 })
			expect(calls.filter((call) => call === 'admitRemoteMedia')).toHaveLength(2)
			const [object] = await w.objects()
			expect(object).toMatchObject({ state: 'reserved' })
			expect(await env.MEDIA.head(`remote/${object!.token}/full`)).not.toBeNull()
			expect(await env.MEDIA.head(`remote/${object!.token}/still`)).toBeNull()
		} finally {
			await w.t.store.setMaintenance(BUILD, false)
			error.mockRestore()
		}
	})

	it('starts no request once maintenance is entered during a held DNS check', async () => {
		const w = await mediaWorld()
		const a = await w.remote()
		w.serve(a.avatar!, PNG)
		const gate = deferred()
		const reached = deferred()
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const running = w.round({
				loader: {
					fetch: (input) => {
						w.requests.push(String(input instanceof Request ? input.url : input))
						return Promise.resolve(new Response(PNG))
					},
					checkHost: async () => {
						reached.resolve()
						await gate.promise
					},
				},
			})
			await reached.promise
			await w.t.store.setMaintenance(BUILD, true)
			gate.resolve()
			expect(await running).toMatchObject({ claimed: 1, stored: 0 })
			expect(w.requests).toEqual([])
		} finally {
			await w.t.store.setMaintenance(BUILD, false)
			error.mockRestore()
		}
	})

	it('starts no further claim in the round once a put was given up, the other files already started finishing', async () => {
		const w = await mediaWorld()
		const accounts = []
		for (let i = 0; i < 6; i++) {
			accounts.push(await w.remote())
		}
		const settle = async (until: () => boolean) => {
			while (!until()) {
				await new Promise((resolve) => setTimeout(resolve, 10))
			}
		}
		// The first file's put is held past its budget; the next two files are held in their fetch until it is given up.
		const gate = deferred()
		const { bucket, puts } = heldBucket(async () => {
			if (puts.length === 1) {
				w.clock.now += PUT_MS + 1
				await gate.promise
			}
		})
		w.serve(accounts[0]!.avatar!, PNG)
		for (const account of accounts.slice(1, 3)) {
			w.serve(account.avatar!, async () => {
				await settle(() => outstandingRemoteMediaCalls() > 0)
				return new Response(PNG)
			})
		}
		for (const account of accounts.slice(3)) {
			w.serve(account.avatar!, PNG)
		}
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			const out = await w.round({ bucket: () => bucket })
			expect(out).toMatchObject({ claimed: 6, stored: 2, failed: 1, stopped: true })
			expect(puts).toHaveLength(3)
			for (const account of accounts.slice(3)) {
				expect(w.requests).not.toContain(`GET ${account.avatar}`)
			}
		} finally {
			warn.mockRestore()
			gate.resolve()
			await settle(() => outstandingRemoteMediaCalls() === 0)
		}
		await w.exact()
	}, 60_000)

	it('starts no operation whose budget does not fit what is left of its allocation', () => {
		const start = 1_000_000
		const end = start + MAINTENANCE_MS
		expect(admitted(R2_DELETE_MS, end, () => end - R2_DELETE_MS)).toBe(end)
		expect(admitted(R2_DELETE_MS, end, () => end - R2_DELETE_MS + 1)).toBeNull()
		expect(admitted(PUT_MS, end, () => start)).toBe(start + PUT_MS)
	})
})

describe("the purge of an account's slots (inbox.ts purgeBatch)", () => {
	// The account's purge as the job runs it, one batch a transaction, until nothing remains.
	async function purge(w: Awaited<ReturnType<typeof mediaWorld>>, uri: string) {
		const batches: { slots: number; account: boolean; nulled: number }[] = []
		for (let more = true; more;) {
			const state = await w.db((d: Db) => {
				const result = purgeBatch(d, uri, w.clock.now)
				return {
					more: result,
					slots: d.first<{ n: number }>("SELECT count(*) AS n FROM remote_media WHERE kind <> 'emoji'")!.n,
					account: d.first('SELECT 1 AS x FROM accounts WHERE uri = ?', uri) !== undefined,
					nulled: d.first<{ n: number }>(
						"SELECT count(*) AS n FROM remote_media WHERE account_id IS NULL AND kind <> 'emoji'"
					)!.n,
				}
			})
			more = state.more
			batches.push({ slots: state.slots, account: state.account, nulled: state.nulled })
		}
		return batches
	}

	it('retires stored and reserved slots first, resuming over batches, and deletes the account after the last', async () => {
		const w = await mediaWorld()
		const a = await w.remote({ avatar: 'https://files.example/a.png', header: 'https://files.example/h.png' })
		const [uri] = (await sql<{ uri: string }>(w.t.store, 'SELECT uri FROM accounts WHERE id = ?', a.id)).map(
			(r) => r.uri
		)
		// One stored object (the round's) and one reserved one (a claim whose record never came).
		w.serve(a.avatar!, PNG)
		await sql(w.t.store, "UPDATE remote_media SET due_at = NULL, failed_at = 1 WHERE kind = 'header'")
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = pending - 1')
		await w.round()
		await sql(w.t.store, "UPDATE remote_media SET due_at = 1, failed_at = NULL WHERE kind = 'header'")
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = pending + 1')
		await w.op(claimRemoteMedia, { now: w.clock.now, tokens: ['H'.repeat(43)], cap: 4 * 1024 ** 3 })
		await sql(w.t.store, "UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", a.id)
		const before = await w.objects()
		expect(before.map((o) => o.state)).toEqual(expect.arrayContaining(['reserved', 'stored']))
		const batches = await purge(w, uri!)
		expect(batches.at(-1)).toEqual({ slots: 0, account: false, nulled: 0 })
		expect(batches.every((batch) => batch.nulled === 0)).toBe(true)
		// The account row stays while a slot remains.
		expect(batches.filter((batch) => batch.slots > 0).every((batch) => batch.account)).toBe(true)
		expect((await w.objects()).every((o) => o.state === 'doomed')).toBe(true)
		await w.exact()
	})

	it('resumes a retirement the batch budget cut short, writing nothing else first, and deletes the account only once the last slot is retired', async () => {
		const w = await mediaWorld()
		const a = await w.remote({ avatar: 'https://files.example/a.png' })
		const [uri] = (await sql<{ uri: string }>(w.t.store, 'SELECT uri FROM accounts WHERE id = ?', a.id)).map(
			(r) => r.uri
		)
		// More slots of the account than one batch can retire, each failed (no object, nothing pending): attachments of
		// its statuses, which the purge retires as it does its profile images.
		const slots = PURGE_BATCH + 100
		await sql(
			w.t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at, failed_at)
			SELECT 'attachment', printf('5%017d', i), ?1, 'https://files.example/m/' || i, 'files.example', 'image', 1, 0, 1, 1
			FROM n`,
			a.id,
			slots
		)
		// Its follows both ways, which the purge's next step would delete with what the batch has left.
		const local = (await sql<{ id: string }>(w.t.store, 'SELECT account_id AS id FROM local_accounts LIMIT 1'))[0]!.id
		await sql(
			w.t.store,
			`INSERT INTO follows (account_id, target_account_id, state, created_at)
			VALUES (?1, ?2, 'accepted', ?3), (?2, ?1, 'accepted', ?3)`,
			a.id,
			local,
			'2026-10-01T00:00:00.000Z'
		)
		await sql(w.t.store, "UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", a.id)
		const follows = () =>
			sql<{ n: number }>(
				w.t.store,
				'SELECT count(*) AS n FROM follows WHERE account_id = ?1 OR target_account_id = ?1',
				a.id
			).then((rows) => rows[0]!.n)
		// The first batch runs out mid-retirement: slots remain, and nothing else of the account was written.
		const first = await w.db((d: Db) => {
			const more = purgeBatch(d, uri!, w.clock.now)
			return { more, slots: d.first<{ n: number }>('SELECT count(*) AS n FROM remote_media')!.n }
		})
		expect(first.more).toBe(true)
		expect(first.slots).toBeGreaterThan(0)
		expect(await follows()).toBe(2)
		const batches = await purge(w, uri!)
		expect(batches.filter((batch) => batch.slots > 0).every((batch) => batch.account)).toBe(true)
		expect(batches.at(-1)).toEqual({ slots: 0, account: false, nulled: 0 })
		expect(batches.every((batch) => batch.nulled === 0)).toBe(true)
		await w.exact()
	})

	it('never clears a slot through the generic reference loop (its retire marker), even with a slot left mid-batch', async () => {
		const w = await mediaWorld()
		const a = await w.remote({ avatar: 'https://files.example/a.png' })
		const [uri] = (await sql<{ uri: string }>(w.t.store, 'SELECT uri FROM accounts WHERE id = ?', a.id)).map(
			(r) => r.uri
		)
		expect(PURGED_ACCOUNT_REFERENCES.find((reference) => reference.table === 'remote_media')).toMatchObject({
			column: 'account_id',
			retire: true,
		})
		// A slot that appears after the retire step, before the reference loop: written by the purge's first step.
		await sql(w.t.store, 'INSERT INTO list_accounts (list_id, account_id) SELECT id, ?1 FROM lists LIMIT 0', a.id)
		await sql(
			w.t.store,
			`CREATE TRIGGER test_late_slot AFTER DELETE ON account_notes BEGIN
				INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at)
				VALUES ('header', OLD.target_account_id, OLD.target_account_id, 'https://files.example/late.png', 'files.example',
					'image', 0, 0, 1);
			END`
		)
		const local = (await sql<{ id: string }>(w.t.store, 'SELECT account_id AS id FROM local_accounts LIMIT 1'))[0]!.id
		await sql(
			w.t.store,
			"INSERT INTO account_notes (account_id, target_account_id, comment) VALUES (?1, ?2, 'n')",
			local,
			a.id
		)
		await sql(w.t.store, "UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", a.id)
		try {
			const batches = await purge(w, uri!)
			expect(batches.every((batch) => batch.nulled === 0)).toBe(true)
			expect(batches.at(-1)).toEqual({ slots: 0, account: false, nulled: 0 })
		} finally {
			await sql(w.t.store, 'DROP TRIGGER test_late_slot')
		}
		await w.exact()
	})
})
