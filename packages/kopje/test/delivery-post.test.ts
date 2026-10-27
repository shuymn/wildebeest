import { env } from 'cloudflare:workers'

import { type DocumentLoader, verifyRequestDetailed } from '@fedify/fedify'
import { describe, expect, it, vi } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { LEGACY } from './federation-helpers'
import { QueueSim } from './queue-sim'
import { community, post, remoteAccount, remoteFollows } from './status-helpers'
import { LEASE_MS } from '../src/domain/deliveries'
import type { DeliveryOutcome } from '../src/domain/deliveries'
import {
	ACTIVITY_CONTENT_TYPE,
	classifyStatus,
	DELIVERY_TIMEOUT_MS,
	MAX_DOORBELL_DELAY_SECONDS,
	type PostDeps,
	postActivity,
} from '../src/federation/delivery'
import { type DeliveryDeps, deliveryRound, scheduledDeliveries } from '../src/jobs/deliver'
import { handleQueue } from '../src/jobs/queue'
import type { StoreStub } from '../src/platform/store-client'
import { createKeyring } from '../src/security/keyring'

// The Worker's side of outbound delivery: the signed POST (NET-2, NET-3, DATA-1, DATA-7), Mastodon's response
// classification, rounds over the Store, and the Queue doorbell (RES-5, RES-6). All fetches are mocked.

const ALICE = 'https://kopje.test/ap/users/alice'
const KEY_ID = new URL(`${ALICE}#main-key`)
const publicHost = () => Promise.resolve()

function aliceLoader(pubkey: string): DocumentLoader {
	return (url) =>
		Promise.resolve({
			contextUrl: null,
			documentUrl: url,
			document: {
				'@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
				id: ALICE,
				type: 'Person',
				inbox: `${ALICE}/inbox`,
				publicKey: { id: KEY_ID.href, owner: ALICE, publicKeyPem: pubkey },
			},
		})
}

async function aliceSigner() {
	return (await createKeyring(LEGACY.kek).signerFor({ ...LEGACY, keyId: KEY_ID })).sign
}

type Sent = { url: string; request: Request }

function recordingFetch(answer: (request: Request) => Response | Promise<Response>) {
	const sent: Sent[] = []
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		sent.push({ url: request.url, request: request.clone() })
		return answer(request)
	})
	return { fetch: fetch as unknown as typeof globalThis.fetch, sent }
}

// One POST with a full budget: the clock stands at NOW and the deadline is the round's.
function send(
	deps: Omit<PostDeps, 'now'>,
	inbox: string,
	body: string,
	sign: (request: Request) => Promise<Request>
): Promise<DeliveryOutcome> {
	return postActivity(
		{ ...deps, now: () => NOW },
		{ inbox, body, signer: () => Promise.resolve(sign), deadline: NOW + 50_000 }
	)
}

const BODY = JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${ALICE}#x`, type: 'Like' })

describe('the POST (NET-2, NET-3)', () => {
	it('signs the activity with its author key, as JSON-LD, and Mastodon-compatible (DATA-7)', async () => {
		const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }))
		const deps = { fetch, checkHost: publicHost, userAgent: 'Kopje/test' }
		expect(await send(deps, 'https://remote.example/inbox', BODY, await aliceSigner())).toEqual({
			kind: 'delivered',
			status: 202,
		})
		const request = sent[0]?.request
		expect(request?.method).toBe('POST')
		expect(request?.redirect).toBe('manual')
		expect(request?.headers.get('content-type')).toBe(ACTIVITY_CONTENT_TYPE)
		expect(request?.headers.get('digest')).toMatch(/^SHA-256=/)
		expect(request?.headers.get('signature')).toContain(`keyId="${KEY_ID.href}"`)
		expect(request?.headers.get('signature')).toMatch(/headers="\(request-target\) [^"]*digest[^"]*"/)
		expect(await request?.clone().text()).toBe(BODY)
		// Fedify's verifier (what a Fedify server runs) accepts it, digest included.
		expect(
			await verifyRequestDetailed(request as Request, { documentLoader: aliceLoader(LEGACY.pubkey) })
		).toMatchObject({
			verified: true,
			key: { id: KEY_ID },
		})
	})

	it('NET-2: never follows a redirect with a private activity, and retries instead', async () => {
		const { fetch, sent } = recordingFetch(
			() => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/collect' } })
		)
		const result = await send(
			{ fetch, checkHost: publicHost, userAgent: 'Kopje/test' },
			'https://remote.example/inbox',
			JSON.stringify({ type: 'Create', to: ['https://remote.example/users/bob'], object: { content: 'secret' } }),
			await aliceSigner()
		)
		expect(result).toEqual({ kind: 'failed', status: 307, error: 'redirect not followed (HTTP 307)', permanent: false })
		expect(sent.map((s) => s.url)).toEqual(['https://remote.example/inbox'])
		for (const status of [301, 302, 303, 308]) {
			expect(classifyStatus(status)).toMatchObject({ kind: 'failed', permanent: false })
		}
	})

	it('classifies answers as Mastodon does', () => {
		const permanent = (status: number) => {
			const outcome = classifyStatus(status)
			return outcome.kind === 'failed' ? outcome.permanent : 'delivered'
		}
		expect([200, 201, 202, 204].map(permanent)).toEqual(['delivered', 'delivered', 'delivered', 'delivered'])
		expect([400, 403, 404, 410, 413, 422, 501].map(permanent)).toEqual([true, true, true, true, true, true, true])
		expect([401, 408, 429, 500, 502, 503, 504].map(permanent)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			false,
		])
	})

	it('NET-3: refuses inboxes that fail the public-host rules before any request', async () => {
		const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }))
		const sign = await aliceSigner()
		const deps = { fetch, checkHost: publicHost, userAgent: 'Kopje/test' }
		for (const inbox of [
			'http://remote.example/inbox',
			'https://127.0.0.1/inbox',
			'https://[::1]/inbox',
			'https://localhost/inbox',
			'https://intranet/inbox',
			'https://user:pw@remote.example/inbox',
			'not a url',
		]) {
			expect(await send(deps, inbox, BODY, sign)).toMatchObject({ kind: 'failed', permanent: true })
		}
		// A name that resolves to a private address is refused by the DNS check, and retried later.
		const privateDns = { ...deps, checkHost: () => Promise.reject(new Error('private address')) }
		expect(await send(privateDns, 'https://rebound.example/inbox', BODY, sign)).toMatchObject({
			kind: 'failed',
			permanent: false,
		})
		expect(sent).toEqual([])
	})

	it('NET-2: times out the POST before the lease ends', async () => {
		expect(DELIVERY_TIMEOUT_MS).toBeLessThan(LEASE_MS)
		const fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch
		const result = await send(
			{ fetch, checkHost: publicHost, userAgent: 'Kopje/test', timeoutMs: 20 },
			'https://slow.example/inbox',
			BODY,
			await aliceSigner()
		)
		expect(result).toEqual({ kind: 'failed', status: null, error: 'timed out after 20 ms', permanent: false })
	})

	it('reports a network error by class only (DATA-5)', async () => {
		const fetch = vi.fn(() =>
			Promise.reject(new TypeError('connect failed to https://remote.example/inbox?token=SECRET'))
		) as unknown as typeof globalThis.fetch
		const result = await send(
			{ fetch, checkHost: publicHost, userAgent: 'Kopje/test' },
			'https://remote.example/inbox',
			BODY,
			await aliceSigner()
		)
		expect(result).toEqual({ kind: 'failed', status: null, error: 'network error (TypeError)', permanent: false })
	})
})

// A community whose alice signs with the legacy fixture key, and remote followers on two servers.
async function signedCommunity() {
	const h = await community(['alice'])
	const { alice } = h.users
	await sql(
		h.store,
		'UPDATE local_accounts SET privkey = ?, privkey_salt = ?, pubkey = ? WHERE account_id = ?',
		LEGACY.privkey.slice().buffer,
		LEGACY.salt.slice().buffer,
		LEGACY.pubkey,
		alice.id
	)
	for (const [name, domain] of [
		['fan', 'fans.example'],
		['other', 'other.example'],
	] as const) {
		await remoteFollows(h.store, await remoteAccount(h.store, name, domain), alice.id)
	}
	return h
}

function roundDeps(store: StoreStub, fetch: typeof globalThis.fetch, now = () => NOW): DeliveryDeps {
	let n = 0
	return {
		build: () => env.CF_VERSION_METADATA.id,
		store: () => store,
		now,
		fetch,
		checkHost: publicHost,
		leaseToken: () => `lease-${++n}`,
	}
}

const testEnv = (queue: QueueSim, extra: Record<string, unknown> = {}) =>
	({ ...env, USER_KEK: LEGACY.kek, QUEUE: queue.queue, ...extra }) as unknown as Env

function doorbellBatch(count: number) {
	const messages = Array.from({ length: count }, (_, i) => ({
		id: `d${i}`,
		body: { kind: 'deliver' },
		timestamp: new Date(NOW),
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}))
	return {
		batch: { queue: 'kopje', messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch,
		messages,
	}
}

describe('delivery rounds', () => {
	it('delivers a status to each inbox, signed by its author, and settles the rows', async () => {
		const h = await signedCommunity()
		const status = await post(h, h.users.alice, { status: 'hello fediverse' })
		const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }))
		const result = await deliveryRound(testEnv(new QueueSim()), roundDeps(h.store, fetch))
		expect(result).toEqual({ claimed: 2, settled: ['delivered', 'delivered'], nextDueAt: null })
		expect(sent.map((s) => s.url).sort()).toEqual(['https://fans.example/inbox', 'https://other.example/inbox'])
		for (const { request } of sent) {
			expect(await verifyRequestDetailed(request, { documentLoader: aliceLoader(LEGACY.pubkey) })).toMatchObject({
				verified: true,
			})
			expect(JSON.parse(await request.text())).toMatchObject({ type: 'Create', object: { id: status.uri } })
		}
		expect(await sql(h.store, 'SELECT id FROM deliveries')).toEqual([])
		expect(await sql(h.store, 'SELECT id FROM outbound_activities')).toEqual([])
	})

	it('retries a failure and keeps the other inboxes going', async () => {
		const h = await signedCommunity()
		await post(h, h.users.alice, { status: 'hello' })
		const { fetch } = recordingFetch(
			(request) => new Response(null, { status: new URL(request.url).origin === 'https://fans.example' ? 503 : 202 })
		)
		const result = await deliveryRound(testEnv(new QueueSim()), roundDeps(h.store, fetch))
		expect(result.settled.sort()).toEqual(['delivered', 'retry'])
		expect(result.nextDueAt).toBe(NOW + 60_000)
		expect(await sql(h.store, 'SELECT inbox_url, state, last_status FROM deliveries')).toEqual([
			{ inbox_url: 'https://fans.example/inbox', state: 'pending', last_status: 503 },
		])
	})

	it('OPS-3: a lost completion leaves the row leased until its lease ends, then it is delivered again', async () => {
		const h = await signedCommunity()
		await post(h, h.users.alice, { status: 'hello' })
		const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }))
		const store = h.store
		// The Store is unreachable for the completions: the POSTs happened, their outcomes did not arrive.
		const lossy = new Proxy(store, {
			get: (target, name) =>
				name === 'completeDelivery'
					? () => Promise.reject(new Error('Network connection lost.'))
					: (Reflect.get(target, name) as unknown),
		})
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const lost = await deliveryRound(testEnv(new QueueSim()), { ...roundDeps(store, fetch), store: () => lossy })
		expect(lost).toMatchObject({ claimed: 2, settled: [] })
		expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.delivery.complete.failed' }))
		errors.mockRestore()
		expect(await deliveryRound(testEnv(new QueueSim()), roundDeps(store, fetch))).toMatchObject({ claimed: 0 })
		const later = await deliveryRound(
			testEnv(new QueueSim()),
			roundDeps(store, fetch, () => NOW + LEASE_MS)
		)
		expect(later).toMatchObject({ claimed: 2, settled: ['delivered', 'delivered'] })
		// The receivers saw the same activity twice and deduplicate it by its id.
		expect(
			new Set(await Promise.all(sent.map(async (s) => (JSON.parse(await s.request.text()) as { id: string }).id))).size
		).toBe(1)
	})
})

describe('the doorbell (RES-5, RES-6)', () => {
	it('runs one round for a batch of doorbells and rings again for retries, delayed', async () => {
		const h = await signedCommunity()
		await post(h, h.users.alice, { status: 'hello' })
		const queue = new QueueSim()
		const { fetch, sent } = recordingFetch(() => new Response(null, { status: 503 }))
		const { batch, messages } = doorbellBatch(5)
		const deps = roundDeps(h.store, fetch)
		await handleQueue(batch, testEnv(queue), { build: deps.build, store: deps.store, delivery: deps })
		expect(sent).toHaveLength(2)
		expect(messages.every((m) => m.ack.mock.calls.length === 1 && m.retry.mock.calls.length === 0)).toBe(true)
		expect(queue.pending.map((m) => [m.body, m.delaySeconds])).toEqual([[{ kind: 'deliver' }, 60]])
	})

	it('RES-5: claims nothing and counts no attempt in maintenance', async () => {
		const h = await signedCommunity()
		await post(h, h.users.alice, { status: 'hello' })
		const queue = new QueueSim()
		const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }))
		const { batch, messages } = doorbellBatch(1)
		const deps = roundDeps(h.store, fetch)
		await handleQueue(batch, testEnv(queue, { MAINTENANCE: 'readonly' }), {
			build: deps.build,
			store: deps.store,
			delivery: deps,
		})
		await scheduledDeliveries(testEnv(queue, { MAINTENANCE: 'full' }), deps)
		expect(sent).toEqual([])
		expect(messages[0]?.ack).toHaveBeenCalled()
		expect(queue.pending).toEqual([])
		expect(await sql(h.store, 'SELECT attempts, state FROM deliveries')).toEqual([
			{ attempts: 0, state: 'pending' },
			{ attempts: 0, state: 'pending' },
		])
	})

	it('rings at once while due work remains after a round, and from the cron', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		for (let i = 0; i < 17; i++) {
			await remoteFollows(h.store, await remoteAccount(h.store, `f${i}`, `server${i}.example`), alice.id)
		}
		await post(h, alice, { status: 'to many' })
		const queue = new QueueSim()
		const { fetch } = recordingFetch(() => new Response(null, { status: 202 }))
		const deps = roundDeps(h.store, fetch)
		await handleQueue(doorbellBatch(1).batch, testEnv(queue, { USER_KEK: '' }), {
			build: deps.build,
			store: deps.store,
			delivery: deps,
		})
		// The fixture keys of community() do not unwrap: the 16 claimed are retried, and the 17th is due at once.
		expect(queue.pending.map((m) => m.delaySeconds)).toEqual([0])
		await scheduledDeliveries(testEnv(queue), deps)
		expect(queue.pending).toHaveLength(2)
		expect(MAX_DOORBELL_DELAY_SECONDS).toBe(12 * 60 * 60)
	})

	it('rings after an API write', async () => {
		const h = await community(['alice'])
		await post(h, h.users.alice, { status: 'hello' })
		expect(h.doorbell).toHaveBeenCalledTimes(1)
		await h.request('/api/v1/timelines/home', { headers: { authorization: `Bearer ${h.users.alice.token}` } })
		expect(h.doorbell).toHaveBeenCalledTimes(1)
	})
})
