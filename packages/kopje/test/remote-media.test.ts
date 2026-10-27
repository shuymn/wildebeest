import { env } from 'cloudflare:workers'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { blockDomain } from './domain-block-helpers'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { claimWith, fence, GIF, mediaWorld, type MediaWorld, PNG, record, storedOutcome } from './remote-media-helpers'
import {
	admitRemoteMedia,
	CLAIM_WALK,
	confirmRemoteMediaDeleted,
	DEFER_MS,
	DELETE_BACKOFF_MS,
	DELETE_BATCH,
	EXPIRE_PENDING_MS,
	FAILED_RESET_MS,
	LANE0_CLAIMS,
	LANE1_HEADROOM,
	LATE_PUT_MS,
	maintainRemoteMedia,
	recordRemoteMediaValidation,
	REMOTE_MEDIA_HOLD_MS,
	REMOTE_MEDIA_PENDING_LIMIT,
	REMOTE_SETTLE_MS,
	remoteMediaOrphans,
	remoteMediaSwept,
	reservationOf,
	RETRY_BATCH,
	RETRY_DELAYS_MS,
	syncProfileFiles,
	type RemoteMediaClaim,
	type RemoteMediaOutcome,
} from '../src/domain/remote-media'
import { readConfig, REMOTE_MEDIA_CACHE_MIN_BYTES } from '../src/platform/config'
import { SAFE_INTEGER_MAX } from '../src/platform/stored-bounds'

// The Store's part of the cache of remote media (domain/remote-media.ts): enqueue, claim, admission and record under
// the fence, maintenance (expiry, the walks, reclamation, deletion, PITR validation, orphans), and its accounting.

const CAP = 4 * 1024 * 1024 * 1024
const R = reservationOf('avatar', 'image')!
let tokens = 0
const token = () => `T${String(++tokens).padStart(42, '0')}`

const claim = (w: MediaWorld, n = LANE0_CLAIMS, cap = CAP) => claimWith(w, token, n, cap)

// A remote account's avatar stored at `bytes`, stored last (reclaimed after every other avatar), so a test reaches a
// cap's edge at the least cap the configuration accepts.
async function ballast(w: MediaWorld, bytes: number) {
	const account = await w.remote({ avatar: `https://files.example/ballast/${++tokens}.png` })
	const token = `B${String(tokens).padStart(42, '0')}`
	const [slot] = await sql<{ id: number }>(w.t.store, 'SELECT id FROM remote_media WHERE owner_id = ?', account.id)
	await sql(
		w.t.store,
		`UPDATE remote_media SET due_at = NULL, token = ?2, ext = 'png', stored_at = ?3 WHERE id = ?1`,
		slot!.id,
		token,
		SAFE_INTEGER_MAX
	)
	await sql(
		w.t.store,
		`INSERT INTO remote_media_objects (token, slot_id, state, charge, kind, content_type, claimed_at, stored_at)
		VALUES (?1, ?2, 'stored', ?3, 'avatar', 'image/png', 1, ?4)`,
		token,
		slot!.id,
		bytes,
		SAFE_INTEGER_MAX
	)
	await sql(w.t.store, 'UPDATE remote_media_usage SET bytes = bytes + ?, pending = pending - 1 WHERE id = 1', bytes)
}

const stored = storedOutcome

const maintain = (w: MediaWorld, restoredAt: number | null = null, cap = CAP) =>
	w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt, cap })

describe('enqueue (syncProfileFiles)', () => {
	it('enqueues a pending slot for each acceptable profile image, and none for a local account', async () => {
		const w = await mediaWorld()
		const a = await w.remote({ avatar: 'https://files.example/a.png', header: 'https://files.example/h.png' })
		expect((await w.slots()).map((s) => [s.kind, s.url, s.due_at, s.lane])).toEqual([
			['avatar', a.avatar, w.clock.now, 0],
			['header', a.header, w.clock.now, 0],
		])
		await w.exact()
		// A local account (ID-3) gets none, whatever its URLs.
		const local = (await sql<{ id: string }>(w.t.store, 'SELECT account_id AS id FROM local_accounts LIMIT 1'))[0]!.id
		await w.db((d) => syncProfileFiles(d, local, { avatar: 'https://files.example/l.png', header: null }, w.clock.now))
		expect(await sql(w.t.store, 'SELECT 1 FROM remote_media WHERE owner_id = ?', local)).toEqual([])
	})

	it.each([
		['http', 'http://files.example/a.png'],
		['a port', 'https://files.example:8443/a.png'],
		['an IP literal', 'https://192.0.2.1/a.png'],
		['a single label', 'https://files/a.png'],
		['the own host', 'https://kopje.test/media/a.png'],
		['a space', 'https://files.example/a b.png'],
	])('enqueues nothing for %s', async (_, url) => {
		const w = await mediaWorld()
		await w.remote({ avatar: url })
		expect(await w.slots()).toEqual([])
	})

	it('enqueues nothing for a host a domain block covers', async () => {
		const w = await mediaWorld()
		await blockDomain(w.t.store, 'files.example', 'suspend')
		await w.remote({ avatar: 'https://files.example/a.png' })
		expect(await w.slots()).toEqual([])
	})

	it('resets a slot whose URL changed, removes one whose URL is gone, and resets a failed one only after a day', async () => {
		const w = await mediaWorld()
		const a = await w.remote({ avatar: 'https://files.example/1.png' })
		const [first] = await w.slots()
		await w.db((d) => syncProfileFiles(d, a.id, { avatar: 'https://files.example/2.png', header: null }, w.clock.now))
		const [moved] = await w.slots()
		expect(moved).toMatchObject({ id: first!.id, url: 'https://files.example/2.png', generation: 1 })
		// Failed: the same URL resets it only once a day has passed.
		await sql(w.t.store, 'UPDATE remote_media SET due_at = NULL, failed_at = ?2 WHERE id = ?1', first!.id, w.clock.now)
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = pending - 1')
		const same = () =>
			w.db((d) => syncProfileFiles(d, a.id, { avatar: 'https://files.example/2.png', header: null }, w.clock.now))
		w.clock.now += FAILED_RESET_MS
		await same()
		expect((await w.slots())[0]).toMatchObject({ failed_at: w.clock.now - FAILED_RESET_MS, due_at: null })
		w.clock.now += 1
		await same()
		expect((await w.slots())[0]).toMatchObject({ failed_at: null, due_at: w.clock.now, generation: 2 })
		await w.db((d) => syncProfileFiles(d, a.id, { avatar: null, header: null }, w.clock.now))
		expect(await w.slots()).toEqual([])
		await w.exact()
	})

	it('changes the pending count by the old-to-new state delta at the pending limit', async () => {
		const w = await mediaWorld()
		const a = await w.remote({ avatar: 'https://files.example/1.png' })
		const b = await w.remote({ avatar: 'https://files.example/b.png' })
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = ?', REMOTE_MEDIA_PENDING_LIMIT)
		// Resetting a pending slot (and a claimed one) adds nothing, so it is applied at the limit.
		for (let i = 0; i < 3; i++) {
			await w.change(a.id, { avatar: `https://files.example/r${i}.png`, header: null })
		}
		expect((await w.usage()).pending).toBe(REMOTE_MEDIA_PENDING_LIMIT)
		const [claimed] = (await claim(w)).claims
		await w.change(b.id, { avatar: 'https://files.example/b2.png', header: null })
		expect((await w.usage()).pending).toBe(REMOTE_MEDIA_PENDING_LIMIT)
		expect(claimed).toBeDefined()
		// A failed slot is not reset past the limit, and no new slot is inserted.
		await sql(w.t.store, 'UPDATE remote_media SET due_at = NULL, failed_at = 1 WHERE owner_id = ?', a.id)
		w.clock.now += FAILED_RESET_MS + 1
		await w.change(a.id, { avatar: 'https://files.example/r2.png', header: null })
		expect((await w.slots()).find((s) => s.owner_id === a.id)).toMatchObject({ failed_at: 1 })
		await w.remote({ avatar: 'https://files.example/c.png' })
		expect(await sql(w.t.store, "SELECT 1 FROM remote_media WHERE url = 'https://files.example/c.png'")).toEqual([])
	})
})

describe('claim (claimRemoteMedia)', () => {
	it('claims at most LANE0_CLAIMS due slots, reserving R for each before any key exists', async () => {
		const w = await mediaWorld()
		for (let i = 0; i < LANE0_CLAIMS + 2; i++) {
			await w.remote()
		}
		const out = await claim(w, LANE0_CLAIMS + 2)
		expect(out.claims).toHaveLength(LANE0_CLAIMS)
		const objects = await w.objects()
		expect(objects.every((o) => o.state === 'reserved' && o.charge === R && o.claimed_at === w.clock.now)).toBe(true)
		expect((await w.usage()).bytes).toBe(LANE0_CLAIMS * R)
		const claimedSlots = (await w.slots()).filter((s) => s.claim === 1)
		expect(claimedSlots.every((s) => s.attempts === 1 && s.due_at === w.clock.now + REMOTE_MEDIA_HOLD_MS)).toBe(true)
		await w.exact()
		expect(CLAIM_WALK).toBe(64)
	})

	it('admits a reservation exactly at the cap, defers one byte past it, and charges no attempt', async () => {
		const w = await mediaWorld()
		await w.remote()
		await w.remote()
		await ballast(w, REMOTE_MEDIA_CACHE_MIN_BYTES - 2 * R)
		const at = await claim(w, 2, REMOTE_MEDIA_CACHE_MIN_BYTES)
		expect(at.claims).toHaveLength(2)
		const w2 = await mediaWorld()
		await w2.remote()
		await w2.remote()
		await ballast(w2, REMOTE_MEDIA_CACHE_MIN_BYTES - 2 * R + 1)
		const past = await claim(w2, 2, REMOTE_MEDIA_CACHE_MIN_BYTES)
		expect(past).toMatchObject({ deferred: 1 })
		expect(past.claims).toHaveLength(1)
		const deferred = (await w2.slots()).find((s) => s.claim === 0)!
		expect(deferred).toMatchObject({ attempts: 0, due_at: w2.clock.now + DEFER_MS })
	})

	it('deletes ineligible slots, exhausted ones and one at the end of its counter, dooming any object', async () => {
		const w = await mediaWorld()
		const gone = await w.remote()
		const exhausted = await w.remote()
		const end = await w.remote()
		const fine = await w.remote()
		// The account's avatar changed without the slot (an imported row): the slot no longer owns its URL.
		await sql(w.t.store, "UPDATE accounts SET avatar_url = 'https://files.example/other.png' WHERE id = ?", gone.id)
		await sql(w.t.store, 'UPDATE remote_media SET attempts = 4 WHERE owner_id = ?', exhausted.id)
		await sql(w.t.store, 'UPDATE remote_media SET claim = ? WHERE owner_id = ?', SAFE_INTEGER_MAX, end.id)
		const out = await claim(w)
		expect(out).toMatchObject({ dropped: 3 })
		expect(out.claims.map((c) => c.url)).toEqual([fine.avatar])
		expect((await w.slots()).map((s) => s.owner_id)).toEqual([fine.id])
		await w.exact()
	})

	it('expires slots pending more than a week, never one under an open hold', async () => {
		const w = await mediaWorld()
		const held = await w.remote()
		await w.remote()
		await claim(w, 1)
		w.clock.now += EXPIRE_PENDING_MS + 1
		await sql(w.t.store, 'UPDATE remote_media SET due_at = ? WHERE owner_id = ?', w.clock.now + 1, held.id)
		const out = await claim(w, 0)
		expect(out.expired).toBe(1)
		await w.exact()
	})
})

describe('record (recordRemoteMedia) under the fence', () => {
	it('stores the object at its actual bytes and points the slot at it', async () => {
		const w = await mediaWorld()
		await w.remote()
		const [c] = (await claim(w)).claims
		expect(await w.op(admitRemoteMedia, { ...fence(c!), hosts: ['files.example'] })).toEqual({ held: true })
		expect(await record(w, c!, stored(123))).toEqual({ held: true })
		expect(await w.objects()).toMatchObject([{ state: 'stored', charge: 123, content_type: 'image/png' }])
		expect((await w.slots())[0]).toMatchObject({ token: c!.token, ext: 'png', due_at: null, attempts: 0 })
		expect(await w.usage()).toEqual({ bytes: 123, doomed: 0, pending: 0 })
		await w.exact()
	})

	it('retries a transient failure after 10 minutes, 1 hour and 6 hours, and fails for good at the fourth', async () => {
		const w = await mediaWorld()
		await w.remote()
		for (const delay of [...RETRY_DELAYS_MS, null]) {
			const [c] = (await claim(w)).claims
			await record(w, c!, { kind: 'failed', permanent: false })
			const [slot] = await w.slots()
			if (delay === null) {
				expect(slot).toMatchObject({ due_at: null, failed_at: w.clock.now, attempts: 4 })
			} else {
				expect(slot!.due_at).toBe(w.clock.now + delay)
				w.clock.now += delay
			}
		}
		await w.exact()
	})

	it('dooms the object of a partial, a failure and a release LATE_PUT_MS after its claim, charged until deleted', async () => {
		const w = await mediaWorld()
		await w.remote()
		await w.remote()
		await w.remote()
		const [a, b, c] = (await claim(w)).claims
		w.clock.now += 1000
		await record(w, a!, { kind: 'partial' })
		await record(w, b!, { kind: 'failed', permanent: true })
		await record(w, c!, { kind: 'unattempted' })
		const objects = await w.objects()
		expect(objects.map((o) => [o.state, o.due_at, o.charge])).toEqual(
			Array.from({ length: 3 }, () => ['doomed', w.clock.now - 1000 + LATE_PUT_MS, R])
		)
		expect(await w.usage()).toMatchObject({ bytes: 3 * R, doomed: 3 * R })
		// The release gave its attempt back and stays due; the partial is retried; the permanent failure is failed.
		const slots = await w.slots()
		expect(slots.map((s) => [s.attempts, s.due_at === null, s.failed_at !== null])).toEqual([
			[1, false, false],
			[1, true, true],
			[0, false, false],
		])
		await w.exact()
	})

	it('records nothing for a claim whose URL changed, whose account was suspended or blocked, or an older claim', async () => {
		const w = await mediaWorld()
		const changed = await w.remote()
		const suspended = await w.remote()
		const blocked = await w.remote({}, 'blocked.example')
		const older = await w.remote()
		const claims = (await claim(w)).claims
		const of = (id: string) => claims.find((c) => c.url.includes(`/${Number(id.slice(1))}.png`))!
		await w.db((d) =>
			syncProfileFiles(d, changed.id, { avatar: 'https://files.example/new.png', header: null }, w.clock.now)
		)
		await sql(
			w.t.store,
			"UPDATE accounts SET suspended_at = ?2, suspension_source = 'account' WHERE id = ?1",
			suspended.id,
			new Date(w.clock.now).toISOString()
		)
		await blockDomain(w.t.store, 'blocked.example', 'suspend')
		const olderClaim = of(older.id)
		await sql(w.t.store, 'UPDATE remote_media SET claim = claim + 1 WHERE id = ?', olderClaim.slot)
		for (const c of [of(changed.id), of(suspended.id), of(blocked.id), olderClaim]) {
			expect(await w.op(admitRemoteMedia, { ...fence(c), hosts: ['files.example'] }), c.url).toEqual({ held: false })
			expect(await record(w, c, stored()), c.url).toEqual({ held: false })
		}
		expect((await w.slots()).every((s) => s.token === null)).toBe(true)
		expect((await w.objects()).every((o) => o.state === 'doomed')).toBe(true)
		await w.exact()
	})

	it('records nothing for a redirect host the domain policy covers, nor for another category', async () => {
		const w = await mediaWorld()
		await w.remote()
		await w.remote()
		const [a, b] = (await claim(w)).claims
		await blockDomain(w.t.store, 'cdn.example', 'suspend')
		expect(await w.op(admitRemoteMedia, { ...fence(a!), hosts: ['files.example', 'cdn.example'] })).toEqual({
			held: false,
		})
		expect(await record(w, a!, stored(10, ['files.example', 'cdn.example']))).toEqual({ held: false })
		expect(await record(w, b!, { ...stored(), category: 'video' } as RemoteMediaOutcome)).toEqual({ held: false })
		expect((await w.objects()).every((o) => o.state === 'doomed')).toBe(true)
		await w.exact()
	})

	it('records nothing once the reservation expired, nor for another generation of the same claim', async () => {
		const w = await mediaWorld()
		await w.remote()
		await w.remote()
		const [expired, regenerated] = (await claim(w)).claims as [RemoteMediaClaim, RemoteMediaClaim]
		// The second claim's slot keeps its claim and URL but not its generation (only the fence's generation differs).
		await sql(w.t.store, 'UPDATE remote_media SET generation = generation + 1 WHERE id = ?', regenerated.slot)
		expect(await w.op(admitRemoteMedia, { ...fence(regenerated), hosts: ['files.example'] })).toEqual({ held: false })
		expect(await record(w, regenerated, stored())).toEqual({ held: false })
		// The first one's record comes after its reservation expired: its slot, claim and generation unchanged.
		w.clock.now += LATE_PUT_MS + 1
		expect((await maintain(w)).counts.expired).toBeGreaterThanOrEqual(1)
		const [slot] = (await w.slots()).filter((s) => s.id === expired.slot)
		expect(slot).toMatchObject({ claim: expired.claim, generation: expired.generation, url: expired.url })
		expect(await w.op(admitRemoteMedia, { ...fence(expired), hosts: ['files.example'] })).toEqual({ held: false })
		expect(await record(w, expired, stored())).toEqual({ held: false })
		expect((await w.slots()).every((s) => s.token === null)).toBe(true)
		await w.exact()
	})
})

describe('maintenance (maintainRemoteMedia)', () => {
	it('confirms a deletion only after the delete returned, and backs off a failed one', async () => {
		const w = await mediaWorld()
		await w.remote()
		const [c] = (await claim(w)).claims
		await record(w, c!, { kind: 'failed', permanent: true })
		// Not due before LATE_PUT_MS after the claim.
		expect((await maintain(w)).deletions).toEqual([])
		w.clock.now += LATE_PUT_MS
		const due = await maintain(w)
		expect(due.deletions).toEqual([
			[{ token: c!.token, keys: [`remote/${c!.token}/full`, `remote/${c!.token}/still`] }],
		])
		await w.op(confirmRemoteMediaDeleted, { results: [{ token: c!.token, deleted: false }], now: w.clock.now })
		expect(await w.objects()).toMatchObject([
			{ state: 'doomed', delete_attempts: 1, due_at: w.clock.now + DELETE_BACKOFF_MS },
		])
		expect((await w.usage()).bytes).toBe(R)
		await w.op(confirmRemoteMediaDeleted, { results: [{ token: c!.token, deleted: true }], now: w.clock.now })
		expect(await w.objects()).toEqual([])
		expect(await w.usage()).toEqual({ bytes: 0, doomed: 0, pending: 0 })
	})

	it(
		'takes a deletion never tried past DELETE_BATCH retried ones, each group by its own seek, after ANALYZE and growth',
		{ timeout: 120_000 },
		async () => {
			const w = await mediaWorld()
			await w.remote()
			const [c] = (await claim(w)).claims
			await record(w, c!, { kind: 'failed', permanent: true })
			w.clock.now += LATE_PUT_MS
			const capture = async () => {
				const { result, plans } = await plannedRun(w.t, /state = 'doomed' AND delete_attempts/, maintainRemoteMedia, {
					now: w.clock.now,
					restoredAt: null,
					cap: CAP,
				})
				return { groups: result.deletions, plans }
			}
			const { before, after } = await staleStatistics(w.t, {
				capture,
				grow: async () => {
					// Twice DELETE_BATCH objects due whose delete failed eight times, older than the one never tried.
					const count = 2 * DELETE_BATCH
					await sql(
						w.t.store,
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
						INSERT INTO remote_media_objects (token, state, charge, kind, claimed_at, due_at, delete_attempts)
						SELECT printf('D%042d', i), 'doomed', 1, 'avatar', 1, i, 8 FROM n`,
						w.clock.now,
						count
					)
					await sql(
						w.t.store,
						'UPDATE remote_media_usage SET bytes = bytes + ?1, doomed = doomed + ?1 WHERE id = 1',
						count
					)
				},
			})
			expect(before.groups).toEqual([
				[{ token: c!.token, keys: [`remote/${c!.token}/full`, `remote/${c!.token}/still`] }],
			])
			const [fresh, retry] = after.groups
			expect(fresh!.map((d) => d.token)).toEqual([c!.token])
			// The retried ones: of the fewest attempts, RETRY_BATCH halved for each attempt past the first.
			expect(retry).toHaveLength(Math.max(1, RETRY_BATCH >> 7))
			for (const { plans } of [before, after]) {
				expect(plans).toHaveLength(2)
				for (const { plan, rows } of plans) {
					expect(scansOf(plan, ['remote_media_objects']), plan.join('\n')).toEqual([])
					expect(plan.join('\n')).not.toContain('TEMP B-TREE')
					expect(rows).toBeLessThanOrEqual(DELETE_BATCH)
				}
				expect(plans.map((p) => p.plan.join(' ')).join(' ')).toMatch(/remote_media_objects_retry/)
				expect(plans.map((p) => p.plan.join(' ')).join(' ')).toMatch(/remote_media_objects_due/)
			}
			await w.exact()
		}
	)

	it('dooms a reservation whose record was lost once LATE_PUT_MS has passed, still charged', async () => {
		const w = await mediaWorld()
		await w.remote()
		await claim(w)
		w.clock.now += LATE_PUT_MS
		expect((await maintain(w)).counts.expired).toBe(0)
		w.clock.now += 1
		expect((await maintain(w)).counts.expired).toBe(1)
		expect(await w.objects()).toMatchObject([{ state: 'doomed', due_at: w.clock.now, charge: R }])
		await w.exact()
	})

	it('retires in the validity walk a slot whose account became unavailable or whose redirect host was blocked', async () => {
		const w = await mediaWorld()
		const suspended = await w.remote()
		const redirected = await w.remote()
		const kept = await w.remote()
		const claims = (await claim(w)).claims
		for (const c of claims) {
			await record(
				w,
				c,
				stored(
					10,
					c.url.includes(`/${Number(redirected.id.slice(1))}.png`)
						? ['files.example', 'cdn.example']
						: ['files.example']
				)
			)
		}
		await sql(
			w.t.store,
			"UPDATE accounts SET suspended_at = ?2, suspension_source = 'account' WHERE id = ?1",
			suspended.id,
			new Date(w.clock.now).toISOString()
		)
		await blockDomain(w.t.store, 'cdn.example', 'suspend')
		const out = await maintain(w)
		expect(out.counts.retired).toBe(2)
		// The available account's avatar is enqueued again by the backfill, to be fetched (and refused) again.
		expect((await w.slots()).filter((s) => s.token !== null).map((s) => s.owner_id)).toEqual([kept.id])
		expect((await w.slots()).some((s) => s.owner_id === suspended.id)).toBe(false)
		expect((await w.objects()).filter((o) => o.state === 'doomed')).toHaveLength(2)
		await w.exact()
	})

	it('reclaims the oldest stored objects past the threshold, one large victim sufficing', async () => {
		const w = await mediaWorld()
		const cap = REMOTE_MEDIA_CACHE_MIN_BYTES
		// The threshold (cap less LANE1_HEADROOM) is 4R above the ballast.
		await ballast(w, cap - LANE1_HEADROOM - 4 * R)
		for (let i = 0; i < 3; i++) {
			await w.remote()
		}
		const claims = (await claim(w, 3, cap)).claims
		await record(w, claims[0]!, stored(R))
		w.clock.now += 1
		await record(w, claims[1]!, stored(R))
		await record(w, claims[2]!, stored(10))
		// Within the threshold (cap less LANE1_HEADROOM) with nothing due: nothing is reclaimed.
		expect((await maintain(w, null, cap)).counts.reclaimed).toBe(0)
		// Two due slots demand 2R: past the threshold; the oldest object alone brings it back within it.
		await w.remote()
		await w.remote()
		const out = await maintain(w, null, cap)
		expect(out.counts.reclaimed).toBe(1)
		expect((await w.objects()).filter((o) => o.state === 'doomed').map((o) => o.token)).toEqual([claims[0]!.token])
		await w.exact()
	})

	it('accepts a cap of 0 or at least 256 MiB and refuses one between, as any invalid variable', () => {
		const issues = (value: string) => {
			const config = readConfig({ ...env, REMOTE_MEDIA_CACHE_BYTES: value })
			return config.ok ? [] : config.issues.filter((issue) => issue.startsWith('REMOTE_MEDIA_CACHE_BYTES'))
		}
		expect(REMOTE_MEDIA_CACHE_MIN_BYTES).toBe(256 * 1024 * 1024)
		expect(REMOTE_MEDIA_CACHE_MIN_BYTES).toBeGreaterThan(LANE1_HEADROOM)
		expect(issues('0')).toEqual([])
		expect(issues(String(REMOTE_MEDIA_CACHE_MIN_BYTES - 1))).toHaveLength(1)
		expect(issues(String(LANE1_HEADROOM))).toHaveLength(1)
		expect(issues(String(REMOTE_MEDIA_CACHE_MIN_BYTES))).toEqual([])
	})

	it('reclaims nothing exactly at the threshold of the least cap, and from one byte past it', async () => {
		const cap = REMOTE_MEDIA_CACHE_MIN_BYTES
		for (const [over, reclaimed] of [
			[0, 0],
			[1, 1],
		] as const) {
			const w = await mediaWorld()
			await w.remote()
			const [c] = (await claim(w, 1, cap)).claims
			await record(w, c!, stored(R))
			await ballast(w, cap - LANE1_HEADROOM - R + over)
			expect((await maintain(w, null, cap)).counts.reclaimed, String(over)).toBe(reclaimed)
			await w.exact()
		}
	})

	it('with caching off (a cap of 0) claims nothing and reclaims nothing, keeping what is cached', async () => {
		const w = await mediaWorld()
		await w.remote()
		await w.remote()
		const [c] = (await claim(w, 1)).claims
		await record(w, c!, stored(R))
		const before = { slots: await w.slots(), objects: await w.objects() }
		expect(await claim(w, LANE0_CLAIMS, 0)).toMatchObject({ claims: [], deferred: 0 })
		expect((await maintain(w, null, 0)).counts.reclaimed).toBe(0)
		expect({ slots: await w.slots(), objects: await w.objects() }).toEqual(before)
		await w.exact()
	})

	it('settles after a restore with no write, then dooms the restored reservations and validates every variant', async () => {
		const w = await mediaWorld()
		await w.remote()
		await w.remote()
		const [a, b] = (await claim(w)).claims
		await record(w, a!, stored(100, ['files.example'], 'image/gif'))
		const restoredAt = w.clock.now + 1
		w.clock.now = restoredAt + REMOTE_SETTLE_MS - 1
		const before = await w.objects()
		expect(await maintain(w, restoredAt)).toMatchObject({ status: 'settling', deletions: [], validation: [] })
		expect(await w.objects()).toEqual(before)
		w.clock.now = restoredAt + REMOTE_SETTLE_MS
		const first = await maintain(w, restoredAt)
		expect(first.counts.restored).toBe(1)
		expect((await w.objects()).find((o) => o.token === b!.token)).toMatchObject({
			state: 'doomed',
			due_at: w.clock.now,
		})
		expect(first.validation).toEqual([
			{ token: a!.token, keys: [`remote/${a!.token}/full`, `remote/${a!.token}/still`] },
		])
		// Its still is missing: the object is doomed and the slot reset to pending.
		await w.op(recordRemoteMediaValidation, { results: [{ token: a!.token, missing: true }], now: w.clock.now })
		expect((await w.slots()).find((s) => s.id === a!.slot)).toMatchObject({ token: null, due_at: w.clock.now })
		const second = await maintain(w, restoredAt)
		expect(second.validation).toEqual([])
		expect(await sql(w.t.store, "SELECT value FROM kopje_state WHERE name = 'remote_media_validated_at'")).toEqual([
			{ value: String(restoredAt) },
		])
		await w.exact()
	})

	it('starts the validation walk again for a restore to a bookmark taken mid-validation', async () => {
		const w = await mediaWorld()
		for (let i = 0; i < 3; i++) {
			await w.remote()
		}
		const claims = (await claim(w)).claims
		for (const c of claims) {
			await record(w, c, stored())
		}
		const tokens = claims.map((c) => c.token).toSorted()
		const first = w.clock.now + 1
		w.clock.now = first + REMOTE_SETTLE_MS
		expect((await maintain(w, first)).validation.map((v) => v.token)).toEqual(tokens)
		await w.op(recordRemoteMediaValidation, { results: [{ token: tokens[0]!, missing: false }], now: w.clock.now })
		// A bookmark taken here holds the walk's progress past the first object.
		const names = ['remote_media_validation', 'remote_media_validated_at']
		const state = () =>
			sql<{ name: string; value: string }>(
				w.t.store,
				'SELECT name, value FROM kopje_state WHERE name IN (?1, ?2) ORDER BY name',
				...names
			)
		const bookmark = await state()
		await w.op(recordRemoteMediaValidation, {
			results: tokens.slice(1).map((token) => ({ token, missing: false })),
			now: w.clock.now,
		})
		expect((await maintain(w, first)).validation).toEqual([])
		expect((await state()).map((row) => row.name)).toContain('remote_media_validated_at')
		// The second restore rewinds the Store to the bookmark; the walk checks every object again, the first included.
		await sql(w.t.store, 'DELETE FROM kopje_state WHERE name IN (?1, ?2)', ...names)
		for (const row of bookmark) {
			await sql(w.t.store, 'INSERT INTO kopje_state (name, value) VALUES (?, ?)', row.name, row.value)
		}
		const second = w.clock.now + 1
		w.clock.now = second + REMOTE_SETTLE_MS
		expect((await maintain(w, second)).validation.map((v) => v.token)).toEqual(tokens)
		await w.exact()
	})

	it(
		'reads the validation batch in token order through its index, past a doomed prefix, after ANALYZE and growth',
		{ timeout: 120_000 },
		async () => {
			const w = await mediaWorld()
			for (let i = 0; i < 3; i++) {
				await w.remote()
			}
			for (const c of (await claim(w)).claims) {
				await record(w, c, stored())
			}
			const restoredAt = w.clock.now + 1
			w.clock.now = restoredAt + REMOTE_SETTLE_MS
			const capture = async () => {
				const { result, plans } = await plannedRun(w.t, /state = 'stored' AND token > \?1/, maintainRemoteMedia, {
					now: w.clock.now,
					restoredAt,
					cap: CAP,
				})
				return { batch: result.validation.length, plans }
			}
			const { before, after } = await staleStatistics(w.t, {
				capture,
				grow: () =>
					// 20,000 doomed objects whose tokens sort before every stored one.
					sql(
						w.t.store,
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
						INSERT INTO remote_media_objects (token, state, charge, kind, claimed_at, due_at)
						SELECT printf('A%042d', i), 'doomed', 1, 'avatar', 1, ?1 FROM n`,
						w.clock.now + 24 * 60 * 60 * 1000
					),
			})
			for (const { batch, plans } of [before, after]) {
				expect(batch).toBe(3)
				expect(plans).toHaveLength(1)
				expect(scansOf(plans[0]!.plan, ['remote_media_objects']), plans[0]!.plan.join('\n')).toEqual([])
				expect(plans[0]!.plan.join('\n')).toContain('remote_media_objects_validation')
				expect(plans[0]!.plan.join('\n')).not.toContain('TEMP B-TREE')
				expect(plans[0]!.rows).toBeLessThanOrEqual(3 + 1)
			}
		}
	)

	it('sweeps only unknown objects older than a day, once an hour', async () => {
		const w = await mediaWorld()
		await w.remote()
		const [c] = (await claim(w)).claims
		const old = w.clock.now - 24 * 60 * 60 * 1000 - 1
		const keys = [
			{ key: `remote/${c!.token}/full`, uploaded: old },
			{ key: `remote/${'U'.repeat(43)}/full`, uploaded: old },
			{ key: `remote/${'V'.repeat(43)}/still`, uploaded: w.clock.now },
			{ key: 'files/x/full', uploaded: old },
		]
		// Handed out at most once an hour: the attempt is recorded as it is handed out.
		expect((await maintain(w)).sweep).toBe('')
		expect((await maintain(w)).sweep).toBeNull()
		expect(await w.op(remoteMediaOrphans, { keys, cursor: 'next', now: w.clock.now })).toEqual({
			orphans: [`remote/${'U'.repeat(43)}/full`],
		})
		// A page with orphans moves the cursor only once their delete returned.
		w.clock.now += 60 * 60 * 1000
		expect((await maintain(w)).sweep).toBe('')
		await w.op(remoteMediaSwept, { cursor: 'next', now: w.clock.now })
		w.clock.now += 60 * 60 * 1000
		expect((await maintain(w)).sweep).toBe('next')
		// A page without one moves it in the lookup itself.
		expect(await w.op(remoteMediaOrphans, { keys: keys.slice(2), cursor: null, now: w.clock.now })).toEqual({
			orphans: [],
		})
		w.clock.now += 60 * 60 * 1000
		expect((await maintain(w)).sweep).toBe('')
	})

	it('backfills the remote accounts newest first, due an hour later', async () => {
		const w = await mediaWorld()
		const ids = ['699999999999999990', '699999999999999991']
		for (const id of ids) {
			await sql(
				w.t.store,
				"INSERT INTO accounts (id, uri, username, domain, avatar_url) VALUES (?1, 'https://files.example/u/' || ?1, 'b' || ?1, 'files.example', 'https://files.example/b/' || ?1 || '.png')",
				id
			)
		}
		const out = await maintain(w)
		expect(out.counts.backfilled).toBeGreaterThanOrEqual(2)
		expect((await w.slots()).map((s) => [s.owner_id, s.due_at])).toEqual(
			expect.arrayContaining(ids.map((id) => [id, w.clock.now + 60 * 60 * 1000]))
		)
		await w.exact()
	})

	it('keeps the usage row equal to the ledger after any sequence of operations', { timeout: 120_000 }, async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.constantFrom(
						'remote',
						'claim',
						'store',
						'fail',
						'partial',
						'release',
						'tick',
						'maintain',
						'delete',
						'reset'
					),
					{
						minLength: 1,
						maxLength: 20,
					}
				),
				async (steps) => {
					const w = await mediaWorld()
					const open: RemoteMediaClaim[] = []
					let made: { id: string }[] = []
					for (const step of steps) {
						if (step === 'remote') {
							made = [...made, await w.remote()]
						} else if (step === 'claim') {
							open.push(...(await claim(w, 2)).claims)
						} else if (step === 'store' || step === 'fail' || step === 'partial' || step === 'release') {
							const c = open.shift()
							if (c !== undefined) {
								await record(
									w,
									c,
									step === 'store'
										? stored(50)
										: step === 'fail'
											? { kind: 'failed', permanent: false }
											: step === 'partial'
												? { kind: 'partial' }
												: { kind: 'unattempted' }
								)
							}
						} else if (step === 'tick') {
							w.clock.now += LATE_PUT_MS
						} else if (step === 'maintain') {
							await maintain(w)
						} else if (step === 'delete') {
							const due = (await maintain(w)).deletions.flat().map((d) => ({ token: d.token, deleted: true }))
							await w.op(confirmRemoteMediaDeleted, { results: due, now: w.clock.now })
						} else if (made.length > 0) {
							const a = made[0]!
							await w.db((d) =>
								syncProfileFiles(
									d,
									a.id,
									{ avatar: `https://files.example/x${w.clock.now}.png`, header: null },
									w.clock.now
								)
							)
						}
						await w.exact()
					}
				}
			),
			{ numRuns: 15 }
		)
	})
})

describe('the round (remoteMediaRound)', () => {
	it('fetches, verifies and puts a still profile image, and an animated one with its still', async () => {
		const w = await mediaWorld()
		const a = await w.remote({ avatar: 'https://files.example/a.png', header: 'https://files.example/h.gif' })
		w.serve(a.avatar!, PNG)
		w.serve(a.header!, GIF)
		const out = await w.round()
		expect(out).toMatchObject({ status: 'ready', claimed: 2, stored: 2, failed: 0 })
		const slots = await w.slots()
		expect(slots.map((s) => [s.kind, s.ext, s.still_ext])).toEqual([
			['avatar', 'png', null],
			['header', 'gif', 'gif'],
		])
		const full = await env.MEDIA.get(`remote/${slots[1]!.token}/full`)
		expect(full?.httpMetadata?.contentType).toBe('image/gif')
		expect(new Uint8Array(await full!.arrayBuffer()).length).toBe(GIF.length)
		expect(await env.MEDIA.head(`remote/${slots[1]!.token}/still`)).not.toBeNull()
		await w.exact()
	})

	it('fails a file the sink or the verification refuses, recording each failure', async () => {
		const w = await mediaWorld()
		const missing = await w.remote({ avatar: 'https://files.example/missing.png' })
		const html = await w.remote({ avatar: 'https://files.example/page.png' })
		w.serve(html.avatar!, new TextEncoder().encode('<!doctype html><script>alert(1)</script>'), {
			'content-type': 'image/png',
		})
		const out = await w.round()
		expect(out).toMatchObject({ claimed: 2, failed: 2, stored: 0 })
		expect((await w.slots()).map((s) => s.failed_at !== null)).toEqual([true, true])
		expect(missing).toBeDefined()
		await w.exact()
	})

	it('stops before any write or R2 operation while a restore settles', async () => {
		const w = await mediaWorld()
		const a = await w.remote()
		w.serve(a.avatar!, PNG)
		const storeId = w.t.store.id.toString()
		await env.MEDIA.put(`kopje/pitr-restored/${storeId}`, JSON.stringify({ at: Date.now() }))
		try {
			const out = await w.round()
			expect(out.status).toBe('settling')
			expect(w.requests).toEqual([])
			expect(await w.objects()).toEqual([])
		} finally {
			await env.MEDIA.delete(`kopje/pitr-restored/${storeId}`)
		}
	})

	it('does nothing in the env maintenance', async () => {
		const w = await mediaWorld()
		await w.remote()
		const out = await w.round({}, { MAINTENANCE: 'readonly' })
		expect(out).toMatchObject({ status: 'unset', claimed: 0 })
		expect(await w.objects()).toEqual([])
	})
})
