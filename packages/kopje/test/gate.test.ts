import { describe, expect, it } from 'vitest'

import { harness, heldStore, NOW } from './app-helpers'
import { BUILD, completeSetup, migratedStore } from './helpers'
import { MAX_RETRIES, QueueSim } from './queue-sim'
import { classifyRequest, decide, type RequestClass } from '../src/app/gate'
import type { SpoolMessage } from '../src/federation/spool'
import { handleQueue, SPOOL_REQUEUE_DELAY_SECONDS } from '../src/jobs/queue'
import type { StoreStub } from '../src/platform/store-client'

describe('request classification', () => {
	it.each<[string, string, RequestClass]>([
		['GET', '/ap/users/alice', 'always'],
		['GET', '/actor', 'always'],
		['GET', '/.well-known/webfinger', 'always'],
		['GET', '/.well-known/nodeinfo', 'always'],
		['GET', '/nodeinfo/2.0', 'always'],
		['GET', '/health', 'always'],
		['GET', '/ap/users/alice/outbox', 'read'],
		['GET', '/ap/o/123', 'read'],
		['GET', '/api/v1/timelines/home', 'read'],
		['GET', '/@alice', 'read'],
		['GET', '/oauth/authorize', 'read'],
		['OPTIONS', '/ap/users/alice', 'read'],
		['POST', '/oauth/token', 'session'],
		['POST', '/oauth/revoke', 'session'],
		['POST', '/oauth/authorize', 'session'],
		['POST', '/api/v1/apps', 'session'],
		['GET', '/api/v1/apps/verify_credentials', 'read'],
		['POST', '/api/v1/accounts/1/follow', 'write'],
		['POST', '/api/v1/push/subscription', 'session'],
		['PUT', '/api/v1/push/subscription', 'session'],
		['DELETE', '/api/v1/push/subscription', 'write'],
		['POST', '/api/v1/statuses', 'write'],
		['POST', '/ap/users/alice/outbox', 'write'],
		['POST', '/inbox', 'inbox'],
		['POST', '/ap/users/alice/inbox', 'inbox'],
		['POST', '/actor/inbox', 'inbox'],
	])('%s %s is %s', (method, path, expected) => {
		expect(classifyRequest(method, path)).toBe(expected)
	})

	it('follows the design table for every mode', () => {
		const table = Object.fromEntries(
			(['always', 'read', 'session', 'write', 'inbox'] as const).map((c) => [
				c,
				[decide(c, 'off'), decide(c, 'readonly'), decide(c, 'full')],
			])
		)
		expect(table).toEqual({
			always: ['serve', 'serve', 'serve'],
			read: ['serve', 'serve', 'unavailable'],
			session: ['serve', 'serve', 'unavailable'],
			write: ['serve', 'unavailable', 'unavailable'],
			inbox: ['serve', 'spool', 'spool'],
		})
	})
})

async function inflate(bytes: Uint8Array): Promise<string> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
	return new Response(stream).text()
}

describe('maintenance gate', () => {
	// Probe routes stand in for handlers that do not exist yet, so "let through" means the handler ran.
	async function probed(mode: string) {
		const h = harness(await migratedStore(), { MAINTENANCE: mode })
		for (const path of ['/api/v1/probe', '/oauth/probe']) {
			h.app.all(path, (c) => c.text('reached'))
		}
		return h
	}

	it('answers writes with a Mastodon 503 in readonly but lets reads and sessions through', async () => {
		const { request } = await probed('readonly')

		const write = await request('/api/v1/probe', { method: 'POST' })
		expect(write.status).toBe(503)
		expect(await write.json()).toEqual({ error: expect.stringContaining('maintenance') })
		for (const [path, method] of [
			['/api/v1/probe', 'GET'],
			['/oauth/probe', 'POST'],
		] as const) {
			const response = await request(path, { method })
			expect(response.status, path).toBe(200)
			expect(await response.text(), path).toBe('reached')
		}
	})

	it('refuses reads and sessions in full but keeps always-served routes', async () => {
		const { request } = await probed('full')

		expect((await request('/api/v1/probe')).status).toBe(503)
		expect((await request('/oauth/probe', { method: 'POST' })).status).toBe(503)
		expect((await request('/health')).status).toBe(200)
	})

	it('spools inbox POSTs when the env is off but the Store is held readonly', async () => {
		const { request, send } = harness(await heldStore())

		const response = await request('/ap/users/alice/inbox', { method: 'POST', body: '{"type":"Follow"}' })
		expect(response.status).toBe(202)
		expect(send).toHaveBeenCalledOnce()
		expect(send.mock.calls[0]![0]).toMatchObject({ kind: 'spool', url: 'https://kopje.test/ap/users/alice/inbox' })
	})

	it('hands inbox POSTs to the inbox handler without spooling when nothing is held', async () => {
		const store = await migratedStore()
		const { request, send } = harness(store)
		await completeSetup(store)

		expect((await request('/inbox', { method: 'POST', body: '{}' })).status).toBe(202)
		expect(send).not.toHaveBeenCalled()
	})

	it('spools inbox POSTs as one deflated v8 message and answers 202', async () => {
		const { request, send } = harness(await migratedStore(), { MAINTENANCE: 'readonly' })
		const body = JSON.stringify({ type: 'Follow', actor: 'https://remote.test/users/a' })

		const response = await request('/ap/users/alice/inbox', {
			method: 'POST',
			headers: { 'content-type': 'application/activity+json', signature: 'keyId="k"' },
			body,
		})

		expect(response.status).toBe(202)
		expect(send).toHaveBeenCalledOnce()
		const [message, options] = send.mock.calls[0]! as [SpoolMessage, QueueSendOptions]
		expect(options).toEqual({ contentType: 'v8' })
		expect(message).toMatchObject({
			kind: 'spool',
			url: 'https://kopje.test/ap/users/alice/inbox',
			method: 'POST',
			spooledAt: NOW,
		})
		expect(message.headers).toContainEqual(['signature', 'keyId="k"'])
		expect(await inflate(message.body)).toBe(body)
	})

	it('answers 503 when the deflated request does not fit one message', async () => {
		const { request, send } = harness(await migratedStore(), { MAINTENANCE: 'full' })
		// 128 KiB of random bytes does not shrink under deflate.
		const chunk = () => crypto.getRandomValues(new Uint8Array(64 * 1024))
		const body = new Uint8Array([...chunk(), ...chunk()])

		expect((await request('/inbox', { method: 'POST', body })).status).toBe(503)
		expect(send).not.toHaveBeenCalled()
	})

	// A 2 MiB body in 64 KiB chunks that records how much was pulled and whether it was cancelled.
	function trackedBody() {
		const chunk = 64 * 1024
		const tracker = { pulled: 0, cancelled: false }
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (tracker.pulled >= 2 * 1024 * 1024) {
						controller.close()
						return
					}
					tracker.pulled += chunk
					controller.enqueue(new Uint8Array(chunk))
				},
				cancel() {
					tracker.cancelled = true
				},
			},
			{ highWaterMark: 0 }
		)
		return { stream, tracker }
	}

	it('refuses an inbox body over 1 MiB by Content-Length without reading it', async () => {
		const { request, send } = harness(await migratedStore(), { MAINTENANCE: 'readonly' })
		const { stream, tracker } = trackedBody()

		const response = await request('/inbox', {
			method: 'POST',
			headers: { 'content-length': String(2 * 1024 * 1024) },
			body: stream,
		})
		expect(response.status).toBe(413)
		expect(tracker.pulled).toBe(0)
		expect(send).not.toHaveBeenCalled()
	})

	it('stops reading a streamed inbox body as soon as it passes 1 MiB', async () => {
		const { request, send } = harness(await migratedStore(), { MAINTENANCE: 'readonly' })
		const { stream, tracker } = trackedBody()

		const response = await request('/inbox', { method: 'POST', body: stream })
		expect(response.status).toBe(413)
		expect(tracker.cancelled).toBe(true)
		expect(tracker.pulled).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024)
		expect(send).not.toHaveBeenCalled()
	})

	it('maps a Store version mismatch to spool for inboxes and 503 for everything else', async () => {
		const { request, send } = harness(await migratedStore(), {}, '0.0.0-other')

		expect((await request('/inbox', { method: 'POST', body: '{}' })).status).toBe(202)
		expect(send).toHaveBeenCalledOnce()
		const webfinger = await request('/.well-known/webfinger?resource=acct:a@kopje.test')
		expect(webfinger.status).toBe(503)
		expect(await webfinger.json()).toEqual({ error: expect.stringContaining('maintenance') })
	})

	it('refuses to send a message over the Queue size limit', async () => {
		const queue = new QueueSim()
		await expect(queue.send({ body: new Uint8Array(130_000) })).rejects.toThrow('message too large')
		await expect(queue.send({ body: new Uint8Array(100_000) })).resolves.toBeUndefined()
	})
})

describe('spool consumer', () => {
	async function spooled(store: StoreStub, overrides: Record<string, unknown> = {}) {
		const h = harness(store, overrides)
		const response = await h.request('/ap/users/alice/inbox', { method: 'POST', body: '{"type":"Follow"}' })
		expect(response.status).toBe(202)
		expect(h.queue.pending).toHaveLength(1)
		const consume = (env = h.env, resolve: () => StoreStub = () => store) =>
			h.queue.deliver((batch) => handleQueue(batch, env, { build: () => BUILD, store: resolve }))
		return { ...h, consume, original: h.queue.pending[0]!.body as SpoolMessage }
	}

	it('never exhausts retries while the Store stays held, however long', async () => {
		const { queue, consume, original } = await spooled(await heldStore())

		for (let cycle = 0; cycle < MAX_RETRIES * 2; cycle++) {
			await consume()
		}

		expect(queue.retries).toBe(0)
		expect(queue.dropped).toEqual([])
		expect(queue.pending).toHaveLength(1)
		expect(queue.pending[0]).toMatchObject({ attempts: 1, delaySeconds: SPOOL_REQUEUE_DELAY_SECONDS })
		expect(queue.pending[0]!.body).toEqual(original)
		expect(original.spooledAt).toBe(NOW)
	})

	it('requeues while the env is in maintenance and replays once it is off', async () => {
		const store = await heldStore()
		const { queue, consume, env } = await spooled(store, { MAINTENANCE: 'readonly' })
		for (let cycle = 0; cycle < 3; cycle++) {
			await consume()
		}
		expect(queue.pending).toHaveLength(1)

		// Maintenance is over: the env is off and the Store serves writes again.
		const healthy = await migratedStore()
		await completeSetup(healthy)
		await consume({ ...env, MAINTENANCE: 'off' } as Env, () => healthy)
		expect(queue.pending).toEqual([])
		expect(queue.retries).toBe(0)
	})

	it('retries, and so counts against max_retries, only on real processing errors', async () => {
		const { queue, consume, env } = await spooled(await heldStore())
		const broken = { receiveInbox: () => Promise.reject(new Error('boom')) } as unknown as StoreStub

		await consume(env, () => broken)
		expect(queue.retries).toBe(1)
		expect(queue.pending).toHaveLength(1)
	})
})
