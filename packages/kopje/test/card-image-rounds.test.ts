import { env } from 'cloudflare:workers'

import { describe, expect, it, vi } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { cardWorld, type CardWorld, pageWith } from './card-image-helpers'
import { BUILD } from './helpers'
import { r2Keys } from './media-helpers'
import { encodeWebp } from './webp-fixtures'
import { CARD_IMAGE_HOLD_MS, CARD_IMAGE_ROUND_CLAIMS, claimCardImages } from '../src/domain/card-images'
import { ORPHAN_GRACE_MS, RECONCILE_BATCH } from '../src/domain/media'
import {
	CARD_IMAGE_CLAIM_MS,
	CARD_IMAGE_FETCHES_MS,
	CARD_IMAGE_IMAGES_CALLS,
	CARD_IMAGE_OWN_STORE_CALLS,
	CARD_IMAGE_PUTS,
	CARD_IMAGE_ROUND_MS,
	CARD_IMAGE_STORE_CALLS,
	CARD_IMAGE_SUBREQUESTS,
	outstandingCardImageCalls,
} from '../src/federation/card-images'
import { reconcileMedia } from '../src/mastodon/media'
import { type CodecInput, imagesCodec } from '../src/platform/images'
import type { StoreStub } from '../src/platform/store-client'
import { CARD_IMAGE_BODY_LIMIT } from '../src/platform/stored-bounds'

// The cron's card image round (federation/card-images.ts) over the Store's claim, admissions and record
// (domain/card-images.ts), the sink's image mode and the local Images binding.

const SHARE = { IMAGES_CARD_MONTHLY_TRANSFORMS: '1000' }
const IMAGE = 'https://cdn.example/a.webp'
const SITE = 'https://site.example/a'
const iso = (ms: number) => new Date(ms).toISOString()

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

const webp = (bytes: Uint8Array) => () => new Response(bytes, { headers: { 'content-type': 'image/webp' } })

// `n` statuses whose cards name images i.webp (attached through a card round), each image routed to a WebP.
async function withImages(w: CardWorld, n = 1, size: [number, number] = [64, 48]) {
	const body = await encodeWebp(...size)
	const ids: string[] = []
	for (let i = 0; i < n; i++) {
		const image = n === 1 ? IMAGE : `https://cdn.example/${i}.webp`
		w.addRoutes({ [`${SITE}${i}`]: pageWith(image, `Alt ${i}`), [image]: webp(body) })
		ids.push(await w.postLink(`${SITE}${i}`))
	}
	await w.cardRound()
	w.requests.length = 0
	return ids
}

// A Store stub whose `method` calls are replaced by `replace` (the call's index among them, from 0).
function wrapped(
	store: StoreStub,
	method: string,
	replace: (n: number, real: () => Promise<unknown>, input: unknown) => Promise<unknown>
): StoreStub {
	let n = 0
	return new Proxy(store, {
		get: (target, key) => {
			const real = Reflect.get(target, key) as unknown
			if (key !== method || typeof real !== 'function') {
				return real
			}
			const stub = target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
			return (...args: unknown[]) => replace(n++, () => stub[method]!(...args), args[1])
		},
	}) as StoreStub
}

// A codec over the local binding whose binding calls can be held, recording them: info() (the preflight and the
// output's) and output() ('encode').
function steeredCodec(steer: { holdEncode?: Promise<void>; holdInfo?: Promise<void>; input?: CodecInput } = {}) {
	const calls: string[] = []
	const binding = {
		info: async (stream: ReadableStream<Uint8Array>) => {
			calls.push('info')
			await steer.holdInfo
			return env.IMAGES.info(stream)
		},
		input: (stream: ReadableStream<Uint8Array>) => {
			let real = env.IMAGES.input(stream)
			const transformer = {
				transform: (options: ImageTransform) => {
					real = real.transform(options)
					return transformer
				},
				output: async (options: ImageOutputOptions) => {
					calls.push('encode')
					await steer.holdEncode
					return real.output(options)
				},
			}
			return transformer
		},
	} as unknown as ImagesBinding
	return { codec: imagesCodec(binding, { input: steer.input ?? 'stream' }), calls }
}

// A Store stub that moves the clock to 20 ms before the first claim's deadline once the `nth` `method` call returns,
// so the guard of the call after it gives up (in 20 ms) while that call is held.
function nearDeadline(w: CardWorld, method: string, nth = 0): StoreStub {
	return wrapped(w.h.store, method, async (n, real) => {
		const result = await real()
		if (n === nth) {
			w.clock.t = NOW + CARD_IMAGE_CLAIM_MS - 20
		}
		return result
	})
}

describe('the card image round', () => {
	it('fetches, re-encodes once and stores an image, its tombstone deleted (I19)', async () => {
		const w = await cardWorld(SHARE)
		const [id] = await withImages(w, 1, [1200, 500])
		const headers: Headers[] = []
		const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
			headers.push(new Request(input, init).headers)
			return w.fetch(input, init)
		}
		const result = await w.imageRound({ loader: { fetch, checkHost: () => Promise.resolve() } })
		expect(result).toEqual({ claimed: 1, stored: 1, none: 0, unattempted: 0, released: 0, lost: 0, stopped: false })
		expect(w.requests).toEqual([`GET ${IMAGE}`])
		expect([...(headers[0] ?? [])]).toEqual([
			['user-agent', expect.stringMatching(/^Kopje\/\S+ \(\+https:\/\/kopje\.test\/\) Bot$/)],
		])
		const [row] = await w.images()
		expect(row).toMatchObject({ source_url: IMAGE, due_at: null, attempts: 0, stored_at: NOW, height: 309 })
		expect(row!.width).toBeLessThanOrEqual(743)
		expect(row!.blurhash).toHaveLength(36)
		expect(await w.orphans()).toEqual([])
		const object = await env.MEDIA.get(`files/${row!.token}/full`)
		expect(object?.httpMetadata?.contentType).toBe('image/webp')
		expect(new Uint8Array(await object!.arrayBuffer()).subarray(8, 12)).toEqual(new TextEncoder().encode('WEBP'))
		expect((await w.card(id!))!.image_id).toBe(row!.id)
		// The card counter is charged once; the uploads' counter never.
		expect(await sql(w.h.store, "SELECT name, value FROM kopje_state WHERE name GLOB 'images_*'")).toEqual([
			{ name: `images_card_transforms:${iso(NOW).slice(0, 7)}`, value: '1' },
		])
		await env.MEDIA.delete(`files/${row!.token}/full`)
	})

	it('S0 (AM4): at a share of 0 makes no Images call and no fetch, while expiry and the GC still run', async () => {
		const w = await cardWorld()
		await withImages(w)
		await sql(
			w.h.store,
			`INSERT INTO card_images (id, source_url, enqueued_at, token, width, height, stored_at)
			VALUES ('700000000000000001', 'https://cdn.example/old.webp', 1, ?, 1, 1, 1)`,
			`t${'0'.repeat(42)}`
		)
		const steered = steeredCodec()
		const claims = vi.fn()
		const store = wrapped(w.h.store, 'claimCardImages', (_n, real, input) => {
			claims(input)
			return real()
		})
		expect(await w.imageRound({ images: () => steered.codec, store: () => store })).toMatchObject({ claimed: 0 })
		expect(claims).toHaveBeenCalledWith(expect.objectContaining({ tokens: [], share: 0 }))
		expect(steered.calls).toEqual([])
		expect(w.requests).toEqual([])
		expect((await w.images()).map((row) => row.id)).not.toContain('700000000000000001')
		expect((await w.orphans()).map((o) => o.media_id)).toEqual(['700000000000000001'])
	})

	it('I0, I1, I3, I4: refuses a source the sink refuses, a failed GET, a body past the limit and a non-image', async () => {
		const w = await cardWorld(SHARE)
		const sources = [
			'https://cdn.example:8443/a.webp',
			'https://cdn.example/missing.webp',
			'https://cdn.example/large.webp',
			'https://cdn.example/page.webp',
		]
		const exact = new Uint8Array(CARD_IMAGE_BODY_LIMIT)
		exact.set(await encodeWebp(4, 4))
		for (const [i, source] of sources.entries()) {
			w.addRoutes({ [`${SITE}${i}`]: pageWith(source) })
			await w.postLink(`${SITE}${i}`)
		}
		w.addRoutes({
			'https://cdn.example/large.webp': webp(exact),
			'https://cdn.example/page.webp': () =>
				new Response('<html></html>', { headers: { 'content-type': 'image/webp' } }),
		})
		await w.cardRound()
		w.requests.length = 0
		const steered = steeredCodec()
		const first = await w.imageRound({ images: () => steered.codec })
		const second = await w.imageRound({ images: () => steered.codec })
		expect(first.none + second.none).toBe(4)
		// The port was refused before any network step; no Images call was made for any.
		expect(w.requests).toEqual(sources.slice(1).map((s) => `GET ${s}`))
		expect(steered.calls).toEqual([])
		expect(await w.images()).toEqual([])
		// CARD_IMAGE_BODY_LIMIT is exclusive, as Mastodon's less_than.
		expect(exact.byteLength).toBe(8_388_608)
	})

	it('I2: a policy RPC failure leaves the claim unattempted, its attempt given back', async () => {
		const w = await cardWorld(SHARE)
		await withImages(w)
		const store = wrapped(w.h.store, 'webHopRefused', () => Promise.reject(new Error('policy unreadable')))
		expect(await w.imageRound({ store: () => store })).toMatchObject({ claimed: 1, unattempted: 1 })
		expect(w.requests).toEqual([])
		expect((await w.images())[0]).toMatchObject({ due_at: NOW, attempts: 0, claim: 1 })
	})

	it('I11: 9422 leaves the claim unattempted and releases the rest of the round, from info() and from encode', async () => {
		for (const failing of ['info', 'encode'] as const) {
			const w = await cardWorld(SHARE)
			await withImages(w, 3)
			const quota = () => Promise.reject(Object.assign(new Error('quota'), { code: 9422 }))
			const binding = {
				info: (stream: ReadableStream<Uint8Array>) => (failing === 'info' ? quota() : env.IMAGES.info(stream)),
				input: (stream: ReadableStream<Uint8Array>) => {
					if (failing === 'info') {
						return env.IMAGES.input(stream)
					}
					const transformer = { transform: () => transformer, output: quota }
					return transformer
				},
			} as unknown as ImagesBinding
			const result = await w.imageRound({ images: () => imagesCodec(binding) })
			expect(result, failing).toMatchObject({ claimed: 3, unattempted: 1, released: 2, stopped: true })
			expect(w.requests).toHaveLength(1)
			expect((await w.images()).every((row) => row.attempts === 0 && row.stored_at === null)).toBe(true)
		}
	})
})

describe('a call given up keeps its slot (AM15)', () => {
	it.each(['stream', 'blob'] satisfies CodecInput[])(
		'on the %s path: no later claim and no claim of the next round starts until it settles',
		async (input) => {
			const w = await cardWorld(SHARE)
			await withImages(w, 3)
			const hold = deferred()
			const steered = steeredCodec({ holdEncode: hold.promise, input })
			const near = nearDeadline(w, 'startCardImage')
			const first = await w.imageRound({ images: () => steered.codec, store: () => near })
			expect(first).toMatchObject({ claimed: 3, unattempted: 1, released: 2, stopped: true })
			expect(steered.calls).toEqual(['info', 'encode'])
			expect(outstandingCardImageCalls()).toBe(1)
			// The transformation stays charged (I10).
			expect(await sql(w.h.store, "SELECT value FROM kopje_state WHERE name GLOB 'images_card_transforms:*'")).toEqual([
				{ value: '1' },
			])
			// The next round claims nothing while the call runs: its claim carries no token, expiry and GC still run.
			const tokens = vi.fn()
			const store = wrapped(w.h.store, 'claimCardImages', (_n, real, given) => {
				tokens((given as { tokens: string[] }).tokens)
				return real()
			})
			w.clock.t = NOW + CARD_IMAGE_ROUND_MS * 2
			expect(await w.imageRound({ images: () => steered.codec, store: () => store })).toMatchObject({
				claimed: 0,
				stopped: true,
			})
			expect(tokens).toHaveBeenCalledWith([])
			expect(steered.calls).toEqual(['info', 'encode'])
			hold.resolve()
			await vi.waitFor(() => expect(outstandingCardImageCalls()).toBe(0))
			w.clock.t = NOW + CARD_IMAGE_HOLD_MS + 1
			const after = await w.imageRound({ images: () => imagesCodec(env.IMAGES, { input }) })
			expect(after.claimed).toBe(3)
			expect(after.stored).toBe(3)
			for (const row of await w.images()) {
				await env.MEDIA.delete(`files/${row.token}/full`)
			}
		}
	)

	it('cancels an output read given up at the deadline: nothing stays outstanding, and the next round claims', async () => {
		const w = await cardWorld(SHARE)
		await withImages(w, 2)
		const state = { cancelled: false, pulls: 0 }
		const output = () =>
			new ReadableStream<Uint8Array>({
				pull: () => {
					state.pulls++
					// Stalls: no chunk ever comes.
					return new Promise<void>(() => {})
				},
				cancel: () => {
					state.cancelled = true
				},
			})
		const binding = {
			info: (stream: ReadableStream<Uint8Array>) => env.IMAGES.info(stream),
			input: () => {
				const transformer = {
					transform: () => transformer,
					output: () => Promise.resolve({ image: output, contentType: () => 'image/webp' }),
				}
				return transformer
			},
		} as unknown as ImagesBinding
		const near = nearDeadline(w, 'startCardImage')
		const first = await w.imageRound({ images: () => imagesCodec(binding), store: () => near })
		expect(first).toMatchObject({ claimed: 2, unattempted: 1, released: 1, stopped: true })
		expect(state.pulls).toBeGreaterThan(0)
		expect(state.cancelled).toBe(true)
		await vi.waitFor(() => expect(outstandingCardImageCalls()).toBe(0))
		// The next round claims again (the released rows are due).
		const next = await w.imageRound({ images: () => imagesCodec(env.IMAGES) })
		expect(next).toMatchObject({ claimed: 2, stored: 2, stopped: false })
		for (const row of await w.images()) {
			await env.MEDIA.delete(`files/${row.token}/full`)
		}
	})

	it('a stalled put is unattempted, its tombstone kept and the round stopped (I17)', async () => {
		const w = await cardWorld(SHARE)
		await withImages(w, 2)
		const hold = deferred()
		const bucket = {
			put: async () => {
				await hold.promise
				return null
			},
		} as unknown as R2Bucket
		// The put's deadline is the claim's: the clock is moved near it by admission #3, the second admission.
		const near = nearDeadline(w, 'admitCardImage', 1)
		const result = await w.imageRound({ bucket: () => bucket, store: () => near })
		expect(result).toMatchObject({ claimed: 2, unattempted: 1, released: 1, stopped: true })
		expect(outstandingCardImageCalls()).toBe(1)
		const rows = await w.images()
		expect(rows.every((row) => row.attempts === 0 && row.stored_at === null)).toBe(true)
		// Both claims' tombstones stay: the stalled write may still land.
		expect(await w.orphans()).toHaveLength(2)
		hold.resolve()
		await vi.waitFor(() => expect(outstandingCardImageCalls()).toBe(0))
	})
})

describe('the admissions (AM6)', () => {
	it.each([
		['#1, before the preflight info()', 'fetch', []],
		['#2, before encode', 'info', ['info']],
		// The output's info() is the third Images call (encodeChecked).
		['#3, before the put', 'encode', ['info', 'encode', 'info']],
	] as [string, 'fetch' | 'info' | 'encode', string[]][])(
		'starts nothing further once the Store enters maintenance at %s',
		async (_name, at, calls) => {
			const w = await cardWorld(SHARE)
			await withImages(w)
			const gate = deferred()
			const hold = at === 'fetch' ? undefined : gate.promise
			const steered = steeredCodec(at === 'info' ? { holdInfo: hold } : at === 'encode' ? { holdEncode: hold } : {})
			const reached = deferred()
			const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
				const response = await w.fetch(input, init)
				if (at === 'fetch') {
					await w.h.store.setMaintenance(BUILD, true)
				}
				reached.resolve()
				return response
			}
			const puts: string[] = []
			const bucket = { put: (key: string) => (puts.push(key), Promise.resolve(null)) } as unknown as R2Bucket
			const error = vi.spyOn(console, 'error').mockImplementation(() => {})
			const running = w.imageRound({
				images: () => steered.codec,
				bucket: () => bucket,
				loader: { fetch, checkHost: () => Promise.resolve() },
			})
			await reached.promise
			if (at !== 'fetch') {
				await vi.waitFor(() => expect(steered.calls).toContain(at))
				await w.h.store.setMaintenance(BUILD, true)
				gate.resolve()
			}
			const result = await running
			error.mockRestore()
			expect(result.stored).toBe(0)
			expect(steered.calls).toEqual(calls)
			expect(puts).toEqual([])
			await w.h.store.setMaintenance(BUILD, false)
			// The claim stays open (its record was refused too) and is claimed again after its hold.
			expect((await w.images())[0]).toMatchObject({ attempts: 1, stored_at: null })
		}
	)

	it('follows no redirect and starts no request once maintenance is entered during a held DNS check', async () => {
		const w = await cardWorld(SHARE)
		await withImages(w)
		const gate = deferred()
		const reached = deferred()
		const steered = steeredCodec()
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const running = w.imageRound({
			images: () => steered.codec,
			loader: {
				fetch: w.fetch,
				checkHost: async () => {
					reached.resolve()
					await gate.promise
				},
			},
		})
		await reached.promise
		await w.h.store.setMaintenance(BUILD, true)
		gate.resolve()
		expect(await running).toMatchObject({ claimed: 1, stored: 0 })
		error.mockRestore()
		expect(w.requests).toEqual([])
		expect(steered.calls).toEqual([])
		await w.h.store.setMaintenance(BUILD, false)
	})
})

describe('the reconciliation gate (AM1)', () => {
	it('keeps a held claim’s tombstone and object until delete_after, then both go and a late record is refused', async () => {
		const w = await cardWorld(SHARE)
		await withImages(w)
		const gate = deferred()
		const reached = deferred()
		const store = wrapped(w.h.store, 'recordCardImage', async (_n, real) => {
			reached.resolve()
			await gate.promise
			return real()
		})
		const running = w.imageRound({ store: () => store })
		await reached.promise
		const [tombstone] = await w.orphans()
		const key = `files/${tombstone!.file_token}/full`
		expect(await r2Keys(key)).toEqual([key])
		expect(tombstone!.delete_after).toBe(iso(NOW + CARD_IMAGE_HOLD_MS + ORPHAN_GRACE_MS))
		const reconcile = (at: number) => reconcileMedia(env, { build: () => BUILD, now: () => at, store: () => w.h.store })
		// Past the hold, before delete_after: nothing is reconciled.
		for (const at of [NOW + CARD_IMAGE_HOLD_MS + 1, NOW + CARD_IMAGE_HOLD_MS + ORPHAN_GRACE_MS - 1]) {
			expect(await reconcile(at)).toBe(0)
			expect(await r2Keys(key)).toEqual([key])
			expect(await w.orphans()).toHaveLength(1)
		}
		// Past it: the object and the tombstone go, and the late record finds no fence.
		expect(await reconcile(NOW + CARD_IMAGE_HOLD_MS + ORPHAN_GRACE_MS)).toBe(1)
		expect(await r2Keys(key)).toEqual([])
		gate.resolve()
		expect(await running).toMatchObject({ stored: 0, lost: 1 })
		expect((await w.images())[0]).toMatchObject({ stored_at: null, token: null })
	})
})

describe('the reconciliation capacity (AM8)', () => {
	it(
		'pauses the GC at the backlog while upload and claim tombstones drain, then resumes',
		{ timeout: 180_000 },
		async () => {
			const w = await cardWorld(SHARE)
			await withImages(w, 3)
			// An image GC backlog of 10,000 unreferenced stored rows, and 250 upload tombstones due at once.
			await sql(
				w.h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
				INSERT INTO card_images (id, source_url, enqueued_at, token, width, height, stored_at)
				SELECT printf('7%017d', i), 'https://cdn.example/s/' || i, 1, printf('g%042d', i), 1, 1, 1 FROM n`
			)
			await sql(
				w.h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
				INSERT INTO media_orphans (file_token, media_id, delete_after)
				SELECT printf('u%042d', i), printf('3%017d', i), ?1 FROM n`,
				iso(NOW)
			)
			const due = async (at: number) =>
				(
					await sql<{ n: number }>(
						w.h.store,
						'SELECT count(*) AS n FROM media_orphans WHERE delete_after <= ?',
						iso(at)
					)
				)[0]!.n
			const counts = { paused: 0, collectedAfterPause: 0 }
			// Ticks every 5 minutes, then again from the claims' delete_after on.
			const ticks = [
				...Array.from({ length: 10 }, (_, k) => NOW + k * 300_000),
				...Array.from({ length: 10 }, (_, k) => NOW + CARD_IMAGE_HOLD_MS + ORPHAN_GRACE_MS + k * 300_000),
			]
			for (const [k, at] of ticks.entries()) {
				w.clock.t = at
				const before = await due(at)
				const claimed = await w.op(claimCardImages, {
					now: at,
					tokens: k === 0 ? ['c'.repeat(43), 'd'.repeat(43), 'e'.repeat(43)] : [],
					share: 1000,
				})
				if (k === 0) {
					expect(claimed.claims).toHaveLength(3)
				}
				if (claimed.paused) {
					counts.paused++
					expect(before).toBeGreaterThanOrEqual(100)
				} else if (claimed.collected > 0) {
					// The GC adds at most one walk to a backlog below the drain's batch: 163 due at most of its own.
					expect(before).toBeLessThan(100)
					expect(await due(at)).toBeLessThanOrEqual(99 + 64)
					counts.collectedAfterPause += counts.paused > 0 ? 1 : 0
				}
				await reconcileMedia(env, { build: () => BUILD, now: () => at, store: () => w.h.store })
			}
			expect(counts.paused).toBeGreaterThan(0)
			expect(counts.collectedAfterPause).toBeGreaterThan(0)
			// Every upload and claim tombstone was reconciled.
			expect(
				await sql(
					w.h.store,
					"SELECT file_token FROM media_orphans WHERE file_token GLOB 'u*' OR file_token GLOB '[cde]*'"
				)
			).toEqual([])
			expect(RECONCILE_BATCH).toBe(100)
		}
	)
})

describe('the bounds of a round (RES-6)', () => {
	it('derives its budgets, windows and the daily claims', () => {
		expect({
			subrequests: CARD_IMAGE_SUBREQUESTS,
			policyReads: CARD_IMAGE_STORE_CALLS,
			images: CARD_IMAGE_IMAGES_CALLS,
			puts: CARD_IMAGE_PUTS,
			ownStoreCalls: CARD_IMAGE_OWN_STORE_CALLS,
		}).toEqual({ subrequests: 36, policyReads: 12, images: 9, puts: 3, ownStoreCalls: 13 })
		// 12 requests and 24 DNS lookups; 12 policy reads before the DNS checks and 12 after.
		expect(CARD_IMAGE_ROUND_CLAIMS * CARD_IMAGE_CLAIM_MS).toBeLessThanOrEqual(CARD_IMAGE_FETCHES_MS)
		expect(CARD_IMAGE_HOLD_MS).toBeGreaterThanOrEqual(2 * CARD_IMAGE_ROUND_MS)
		expect(CARD_IMAGE_ROUND_CLAIMS * ((24 * 60) / 5)).toBe(864)
		// The cron subtotal after this round (docs/threat-model.md RES-6): PR-B's 484 requests, 136 DNS lookups, 136
		// policy reads and 13 own Store calls, plus this round's.
		expect({
			requests: 484 + CARD_IMAGE_SUBREQUESTS / 3,
			dns: 136 + (2 * CARD_IMAGE_SUBREQUESTS) / 3,
			policy: 136 + 2 * CARD_IMAGE_STORE_CALLS,
			own: 13 + CARD_IMAGE_OWN_STORE_CALLS,
		}).toEqual({ requests: 496, dns: 160, policy: 160, own: 26 })
	})

	it('runs from the cron outside the env maintenance only', async () => {
		const { scheduledCardImages } = await import('../src/jobs/scheduled')
		const w = await cardWorld(SHARE)
		await withImages(w)
		await scheduledCardImages({ ...w.h.env, MAINTENANCE: 'on' } as unknown as Env, w.imageDeps())
		expect((await w.images())[0]).toMatchObject({ attempts: 0 })
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const failing = wrapped(w.h.store, 'claimCardImages', () => Promise.reject(new Error('boom')))
		await scheduledCardImages(
			{ ...w.h.env, MAINTENANCE: 'off' } as unknown as Env,
			w.imageDeps({ store: () => failing })
		)
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.scheduled.card_images_failed' }))
		error.mockRestore()
	})
})
