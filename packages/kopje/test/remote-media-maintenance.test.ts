import { env } from 'cloudflare:workers'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sql } from './api-helpers'
import { GIF, mediaWorld, type MediaWorld } from './remote-media-helpers'
import {
	AUDIT_CHUNK,
	BACKFILL_BATCH,
	DELETE_BACKOFF_MAX_MS,
	DELETE_SPLITS,
	LATE_PUT_MS,
	REMOTE_SETTLE_MS,
	VALIDATION_FAILURES,
} from '../src/domain/remote-media'
import { outstandingRemoteMediaCalls, PUT_MS, R2_DELETE_MS, R2_HEAD_MS } from '../src/federation/remote-media'
import { restoreMarkerKey } from '../src/platform/media-files'
import type { StoreStub } from '../src/platform/store-client'

// The cache's maintenance through the production round (federation/remote-media.ts): the Store's calls, the media
// bucket and the sink, on one clock the Store reads too (Date, faked; timers stay real), with explicit barriers where
// an R2 call is held while the Store moves on. Each test checks what R2 holds and that the usage row is exact.

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(Date.UTC(2026, 9, 1))
})

afterEach(() => {
	vi.useRealTimers()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

// The round's clock and the Store's, moved together.
function at(w: MediaWorld, ms: number): void {
	w.clock.now = ms
	vi.setSystemTime(ms)
}

const settle = async (until: () => boolean) => {
	while (!until()) {
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

// A bucket over the real one whose calls by method may be intercepted.
function bucketWith(hooks: {
	delete?: (keys: string[], real: () => Promise<void>) => Promise<void>
	head?: (key: string, real: () => Promise<R2Object | null>) => Promise<R2Object | null>
	put?: (key: string, real: () => Promise<unknown>) => Promise<unknown>
}) {
	return new Proxy(env.MEDIA, {
		get: (target, key) => {
			const real = Reflect.get(target, key) as unknown
			if (typeof real !== 'function') {
				return real
			}
			const bound = (real as (...a: unknown[]) => unknown).bind(target)
			if (key === 'delete' && hooks.delete !== undefined) {
				return (keys: string | string[]) =>
					hooks.delete!(Array.isArray(keys) ? keys : [keys], () => bound(keys) as Promise<void>)
			}
			if (key === 'head' && hooks.head !== undefined) {
				return (k: string) => hooks.head!(k, () => bound(k) as Promise<R2Object | null>)
			}
			if (key === 'put' && hooks.put !== undefined) {
				return (k: string, ...rest: unknown[]) => hooks.put!(k, () => bound(k, ...rest) as Promise<unknown>)
			}
			return bound
		},
	})
}

// n remote accounts whose avatars (animated GIFs: a full file and a still each) the round caches.
async function cached(w: MediaWorld, n: number) {
	const accounts = []
	for (let i = 0; i < n; i++) {
		const account = await w.remote()
		w.serve(account.avatar!, GIF)
		accounts.push(account)
	}
	const out = await w.round()
	expect(out.stored).toBe(n)
	const objects = (await w.objects()).toSorted((a, b) => (a.token < b.token ? -1 : 1))
	return { accounts, tokens: objects.map((o) => o.token) }
}

const keysOf = (token: string) => [`remote/${token}/full`, `remote/${token}/still`]
const inBucket = async (token: string) =>
	(await Promise.all(keysOf(token).map((key) => env.MEDIA.head(key)))).filter((o) => o !== null).length

async function markRestore(w: MediaWorld, restoredAt: number) {
	await env.MEDIA.put(restoreMarkerKey(w.t.store.id.toString()), JSON.stringify({ at: restoredAt }))
}

async function clearRestore(w: MediaWorld) {
	await env.MEDIA.delete(restoreMarkerKey(w.t.store.id.toString()))
}

const validation = async (w: MediaWorld) => {
	const [row] = await sql<{ value: string }>(
		w.t.store,
		"SELECT value FROM kopje_state WHERE name = 'remote_media_validation'"
	)
	return row === undefined ? null : (JSON.parse(row.value) as { cursor: string; failures?: number })
}

// The Store stub with `method` failing on its `n`th call (from 0).
function failingOn(store: StoreStub, method: string, n: number) {
	let calls = 0
	return new Proxy(store, {
		get: (target, key) => {
			if (key !== method) {
				return Reflect.get(target, key) as unknown
			}
			return (...args: unknown[]) => {
				if (calls++ === n) {
					return Promise.reject(new Error('the Store call failed'))
				}
				return (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args)
			}
		},
	})
}

describe('deletion through the round', () => {
	it('keeps an object whose delete failed doomed and charged, retries it, and subtracts it only after success', async () => {
		const w = await mediaWorld()
		const { accounts, tokens } = await cached(w, 1)
		await w.change(accounts[0]!.id, { avatar: null, header: null })
		const charged = (await w.usage()).bytes
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const failed = await w.round({
			bucket: () => bucketWith({ delete: () => Promise.reject(new Error('R2 failed')) }),
		})
		warn.mockRestore()
		expect(failed.deleted).toBe(0)
		expect(await w.objects()).toMatchObject([{ token: tokens[0], state: 'doomed', delete_attempts: 1 }])
		expect(await w.usage()).toMatchObject({ bytes: charged, doomed: charged })
		expect(await inBucket(tokens[0]!)).toBe(2)
		// Not due again before its backoff.
		expect((await w.round()).deleted).toBe(0)
		at(w, w.clock.now + 5 * 60 * 1000)
		expect((await w.round()).deleted).toBe(1)
		expect(await w.objects()).toEqual([])
		expect(await inBucket(tokens[0]!)).toBe(0)
		expect(await w.usage()).toMatchObject({ bytes: 0, doomed: 0 })
		await w.exact()
	})

	it('keeps an object whose delete was given up charged though the delete landed, and deletes it again', async () => {
		const w = await mediaWorld()
		const { accounts, tokens } = await cached(w, 1)
		await w.change(accounts[0]!.id, { avatar: null, header: null })
		const gate = deferred()
		const out = await w.round({
			bucket: () =>
				bucketWith({
					delete: async (_keys, real) => {
						at(w, w.clock.now + R2_DELETE_MS + 1)
						await gate.promise
						await real()
					},
				}),
		})
		expect(out.deleted).toBe(0)
		gate.resolve()
		await settle(() => outstandingRemoteMediaCalls() === 0)
		// The delete landed after the round gave it up: R2 is empty, the ledger still charges it.
		expect(await inBucket(tokens[0]!)).toBe(0)
		expect(await w.objects()).toMatchObject([{ state: 'doomed', delete_attempts: 1 }])
		at(w, w.clock.now + 5 * 60 * 1000)
		expect((await w.round()).deleted).toBe(1)
		expect(await w.objects()).toEqual([])
		await w.exact()
	})

	it('deletes again an object whose delete returned but whose confirmation failed', async () => {
		const w = await mediaWorld()
		const { accounts, tokens } = await cached(w, 1)
		await w.change(accounts[0]!.id, { avatar: null, header: null })
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		await w.round({ store: () => failingOn(w.t.store, 'confirmRemoteMediaDeleted', 0) as StoreStub })
		error.mockRestore()
		expect(await inBucket(tokens[0]!)).toBe(0)
		expect(await w.objects()).toMatchObject([{ state: 'doomed', delete_attempts: 0 }])
		expect((await w.usage()).doomed).toBeGreaterThan(0)
		expect((await w.round()).deleted).toBe(1)
		expect(await w.objects()).toEqual([])
		await w.exact()
	})

	it('does not let a delete that fails every time hold back the others, isolating it', async () => {
		const w = await mediaWorld()
		const { tokens } = await cached(w, 3)
		const [stuck, withIt, later] = tokens as [string, string, string]
		const accountOf = async (token: string) =>
			(await sql<{ owner_id: string }>(w.t.store, 'SELECT owner_id FROM remote_media WHERE token = ?', token))[0]!
				.owner_id
		const bucket = () =>
			bucketWith({
				delete: (keys, real) =>
					keys.some((key) => key.includes(stuck)) ? Promise.reject(new Error('R2 failed')) : real(),
			})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			// The stuck one and another fail together.
			await w.change(await accountOf(stuck), { avatar: null, header: null })
			await w.change(await accountOf(withIt), { avatar: null, header: null })
			expect((await w.round({ bucket })).deleted).toBe(0)
			// A deletion doomed later goes at once, in its own group.
			await w.change(await accountOf(later), { avatar: null, header: null })
			expect((await w.round({ bucket })).deleted).toBe(1)
			expect(await inBucket(later)).toBe(0)
			// The two are retried in ever smaller groups until they part; then the other goes.
			for (let i = 0; i <= DELETE_SPLITS && (await inBucket(withIt)) > 0; i++) {
				at(w, w.clock.now + DELETE_BACKOFF_MAX_MS)
				await w.round({ bucket })
			}
			expect(await inBucket(withIt)).toBe(0)
			expect(await inBucket(stuck)).toBe(2)
			expect((await w.objects()).map((o) => o.token)).toEqual([stuck])
		} finally {
			warn.mockRestore()
		}
		await w.exact()
	})
})

describe('a late put through the round', () => {
	it('deletes a put given up and landed late only once LATE_PUT_MS has passed since its claim', async () => {
		const w = await mediaWorld()
		const account = await w.remote()
		w.serve(account.avatar!, GIF)
		const gate = deferred()
		let first = true
		const bucket = () =>
			bucketWith({
				put: async (_key, real) => {
					if (first) {
						first = false
						at(w, w.clock.now + PUT_MS + 1)
						await gate.promise
					}
					return real()
				},
			})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const out = await w.round({ bucket })
		warn.mockRestore()
		expect(out).toMatchObject({ claimed: 1, stored: 0 })
		const [object] = await w.objects()
		expect(object).toMatchObject({ state: 'doomed', due_at: object!.claimed_at + LATE_PUT_MS })
		gate.resolve()
		await settle(() => outstandingRemoteMediaCalls() === 0)
		const key = `remote/${object!.token}/full`
		expect(await env.MEDIA.head(key)).not.toBeNull()
		w.serve(account.avatar!, () => new Response('gone', { status: 404 }))
		at(w, object!.claimed_at + LATE_PUT_MS - 1)
		expect((await w.round()).deleted).toBe(0)
		expect(await env.MEDIA.head(key)).not.toBeNull()
		at(w, object!.claimed_at + LATE_PUT_MS)
		expect((await w.round()).deleted).toBe(1)
		expect(await env.MEDIA.head(key)).toBeNull()
		await w.exact()
	})
})

describe('PITR validation through the round', () => {
	it('records the prefix whose heads fit before the record, and resumes after it', async () => {
		const w = await mediaWorld()
		const { tokens } = await cached(w, 3)
		const restoredAt = w.clock.now
		await markRestore(w, restoredAt)
		try {
			at(w, restoredAt + REMOTE_SETTLE_MS)
			// Each head takes 2.5 head budgets of the round's time: after the first object, the second's last head would end
			// within the allocation but not before the record's own budget, so it is not started, and the first is recorded.
			const bucket = () =>
				bucketWith({
					head: async (_key, real) => {
						at(w, w.clock.now + 2.5 * R2_HEAD_MS)
						return real()
					},
				})
			for (const token of tokens) {
				expect((await w.round({ bucket })).validated).toBe(1)
				expect((await validation(w))?.cursor).toBe(token)
			}
			await w.round({ bucket })
			expect(await sql(w.t.store, "SELECT value FROM kopje_state WHERE name = 'remote_media_validated_at'")).toEqual([
				{ value: String(restoredAt) },
			])
		} finally {
			await clearRestore(w)
		}
		await w.exact()
	})

	it('does not let an object whose heads fail every time hold back the walk', async () => {
		const w = await mediaWorld()
		const { accounts, tokens } = await cached(w, 2)
		const [stuck, next] = tokens as [string, string]
		// Its file is fetched again once it is handled as missing; here the fetch fails, so the walk sees only the other.
		const [owner] = await sql<{ owner_id: string }>(
			w.t.store,
			'SELECT owner_id FROM remote_media WHERE token = ?',
			stuck
		)
		const stuckAvatar = accounts.find((account) => account.id === owner!.owner_id)!.avatar!
		w.serve(stuckAvatar, () => new Response('gone', { status: 404 }))
		const restoredAt = w.clock.now
		await markRestore(w, restoredAt)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			at(w, restoredAt + REMOTE_SETTLE_MS)
			const bucket = () =>
				bucketWith({
					head: (key, real) => (key.includes(stuck) ? Promise.reject(new Error('R2 failed')) : real()),
				})
			for (let i = 1; i < VALIDATION_FAILURES; i++) {
				expect((await w.round({ bucket })).validated).toBe(0)
				expect(await validation(w)).toMatchObject({ cursor: '', failures: i })
			}
			// The last failure handles it as missing: doomed, its slot fetched again; the walk goes on past it.
			await w.round({ bucket })
			expect((await w.objects()).find((o) => o.token === stuck)).toMatchObject({ state: 'doomed' })
			expect(await validation(w)).toMatchObject({ cursor: stuck, failures: 0 })
			expect((await w.round({ bucket })).validated).toBe(1)
			expect((await validation(w))?.cursor).toBe(next)
		} finally {
			warn.mockRestore()
			await clearRestore(w)
		}
		await w.exact()
	})

	it('after a restore during a held delete, confirms nothing restored and fetches the missing file again', async () => {
		const w = await mediaWorld()
		const { accounts, tokens } = await cached(w, 1)
		const tables = ['remote_media', 'remote_media_objects', 'remote_media_usage'] as const
		const bookmark = {
			rows: Object.fromEntries(
				await Promise.all(tables.map(async (table) => [table, await sql(w.t.store, `SELECT * FROM ${table}`)] as const))
			),
			avatar: accounts[0]!.avatar,
		}
		await w.change(accounts[0]!.id, { avatar: null, header: null })
		const gate = deferred()
		const held = deferred()
		const round = w.round({
			bucket: () =>
				bucketWith({
					delete: async (_keys, real) => {
						held.resolve()
						await gate.promise
						await real()
					},
				}),
		})
		await held.promise
		// A restore to the bookmark while the delete is held: the rows as they were, the account's avatar too.
		for (const table of tables) {
			await sql(w.t.store, `DELETE FROM ${table}`)
			for (const row of bookmark.rows[table]!) {
				const columns = Object.keys(row as object)
				await sql(
					w.t.store,
					`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
					...columns.map((c) => (row as Record<string, SqlStorageValue>)[c]!)
				)
			}
		}
		await sql(w.t.store, 'UPDATE accounts SET avatar_url = ? WHERE id = ?', bookmark.avatar, accounts[0]!.id)
		const restoredAt = w.clock.now
		await markRestore(w, restoredAt)
		try {
			gate.resolve()
			expect((await round).deleted).toBe(0)
			// The delete removed the files of an object the restored ledger shows stored.
			expect(await inBucket(tokens[0]!)).toBe(0)
			expect(await w.objects()).toMatchObject([{ token: tokens[0], state: 'stored' }])
			expect((await w.round()).status).toBe('settling')
			at(w, restoredAt + REMOTE_SETTLE_MS)
			const validated = await w.round()
			expect(validated.validated).toBe(1)
			expect(validated.stored).toBe(1)
			const live = (await w.objects()).filter((o) => o.state === 'stored')
			expect(live).toHaveLength(1)
			expect(live[0]!.token).not.toBe(tokens[0])
			expect(await inBucket(live[0]!.token)).toBe(2)
		} finally {
			await clearRestore(w)
		}
		await w.exact()
	})
})

describe('walks across rounds', () => {
	it('backfills every account once though accounts change between its chunks', async () => {
		const w = await mediaWorld()
		const count = BACKFILL_BATCH + 50
		await sql(
			w.t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain, avatar_url)
			SELECT printf('69%016d', i), 'https://files.example/u/' || i, 'b' || i, 'files.example',
				'https://files.example/b/' || i || '.png' FROM n`,
			count
		)
		// A URL refused every time (http) among them: never a slot, never in the way.
		await sql(
			w.t.store,
			"UPDATE accounts SET avatar_url = 'http://files.example/x.png' WHERE id = ?",
			'69' + '0'.repeat(13) + '100'
		)
		const backfill = async () =>
			JSON.parse(
				(
					await sql<{ value: string }>(w.t.store, "SELECT value FROM kopje_state WHERE name = 'remote_media_backfill'")
				)[0]!.value
			) as { cursor: string; done: boolean }
		await w.round()
		const first = await backfill()
		expect(first.done).toBe(false)
		// Between the chunks: a processed account changes its avatar, and a new account arrives through its storing branch.
		const processed = `69${String(count).padStart(16, '0')}`
		await w.change(processed, { avatar: 'https://files.example/changed.png', header: null })
		const arrived = await w.remote()
		for (let i = 0; i < 3 && !(await backfill()).done; i++) {
			await w.round()
		}
		expect((await backfill()).done).toBe(true)
		const slots = await sql<{ owner_id: string; url: string }>(w.t.store, 'SELECT owner_id, url FROM remote_media')
		const urls = new Map(slots.map((s) => [s.owner_id, s.url]))
		const current = await sql<{ id: string; avatar_url: string }>(
			w.t.store,
			"SELECT id, avatar_url FROM accounts WHERE domain IS NOT NULL AND avatar_url LIKE 'https://%'"
		)
		expect(current.length).toBe(count)
		for (const account of current) {
			expect(urls.get(account.id), account.id).toBe(account.avatar_url)
		}
		expect(urls.get(arrived.id)).toBe(arrived.avatar)
		expect(slots).toHaveLength(count)
		await w.exact()
	}, 120_000)

	it('reports no drift for writes between the audit chunks', async () => {
		const w = await mediaWorld()
		const count = AUDIT_CHUNK + 20
		// Stored objects past one audit chunk, each an account's avatar.
		await sql(
			w.t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain, avatar_url)
			SELECT printf('68%016d', i), 'https://files.example/u/' || i, 'c' || i, 'files.example',
				'https://files.example/c/' || i || '.png' FROM n`,
			count
		)
		await sql(
			w.t.store,
			`INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at, token, ext,
				stored_at)
			SELECT 'avatar', id, id, avatar_url, 'files.example', 'image', 0, 0, 1, printf('A%042d', CAST(substr(id, 3) AS INTEGER)),
				'png', 1 FROM accounts WHERE id LIKE '68%'`
		)
		await sql(
			w.t.store,
			`INSERT INTO remote_media_objects (token, slot_id, state, charge, kind, content_type, claimed_at, stored_at)
			SELECT token, id, 'stored', 100, 'avatar', 'image/png', 1, 1 FROM remote_media WHERE token IS NOT NULL`
		)
		await sql(w.t.store, 'UPDATE remote_media_usage SET bytes = bytes + ? WHERE id = 1', 100 * count)
		// Accounts the backfill would enqueue are done: only the audit walks.
		await sql(
			w.t.store,
			`INSERT INTO kopje_state (name, value) VALUES ('remote_media_backfill', '{"v":1,"cursor":"000000000000000000","done":true}')
			ON CONFLICT (name) DO UPDATE SET value = excluded.value`
		)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		try {
			await w.round()
			// Between the chunks: an object the audit already counted is doomed and deleted, and one it has not yet counted
			// too; a new claim reserves another.
			await w.change(`68${String(1).padStart(16, '0')}`, { avatar: null, header: null })
			await w.change(`68${String(count).padStart(16, '0')}`, { avatar: null, header: null })
			const fresh = await w.remote()
			w.serve(fresh.avatar!, GIF)
			await w.round()
			await w.round()
			expect(warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.remote_media.drift_found' }))
		} finally {
			warn.mockRestore()
		}
		await w.exact()
	}, 120_000)

	it('does not let a file that fails every time hold back the claims of the others', async () => {
		const w = await mediaWorld()
		const failing = await w.remote()
		const others = [await w.remote(), await w.remote()]
		w.serve(failing.avatar!, () => new Response('down', { status: 503 }))
		for (const account of others) {
			w.serve(account.avatar!, GIF)
		}
		const out = await w.round()
		expect(out).toMatchObject({ claimed: 3, stored: 2, failed: 1 })
		expect((await w.slots()).find((s) => s.owner_id === failing.id)).toMatchObject({ token: null })
		await w.exact()
	})
})
