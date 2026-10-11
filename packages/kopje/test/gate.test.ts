import { createMessageBatch, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { harness, heldStore, migratedStore, NOW } from './app-helpers'
import { classifyRequest, decide, type RequestClass } from '../src/app/gate'
import type { SpoolMessage } from '../src/federation/spool'
import { handleQueue, QUEUE_RETRY_DELAY_SECONDS } from '../src/jobs/queue'
import { maxMode } from '../src/platform/maintenance'

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

	it('takes the stricter of two modes', () => {
		expect(maxMode('off', 'readonly')).toBe('readonly')
		expect(maxMode('full', 'readonly')).toBe('full')
		expect(maxMode('off', 'off')).toBe('off')
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
		for (const path of ['/api/v1/statuses', '/api/v1/timelines/home', '/oauth/token']) {
			h.app.all(path, (c) => c.text('reached'))
		}
		return h
	}

	it('answers writes with a Mastodon 503 in readonly but lets reads and sessions through', async () => {
		const { request } = await probed('readonly')

		const write = await request('/api/v1/statuses', { method: 'POST' })
		expect(write.status).toBe(503)
		expect(await write.json()).toEqual({ error: expect.stringContaining('maintenance') })
		for (const [path, method] of [
			['/api/v1/timelines/home', 'GET'],
			['/oauth/token', 'POST'],
		] as const) {
			const response = await request(path, { method })
			expect(response.status, path).toBe(200)
			expect(await response.text(), path).toBe('reached')
		}
	})

	it('refuses reads and sessions in full but keeps always-served routes', async () => {
		const { request } = await probed('full')

		expect((await request('/api/v1/timelines/home')).status).toBe(503)
		expect((await request('/oauth/token', { method: 'POST' })).status).toBe(503)
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
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
		})

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

	it('maps a Store version mismatch to spool for inboxes and 503 for everything else', async () => {
		const { request, send } = harness(await migratedStore(), {}, '0.0.0-other')

		expect((await request('/inbox', { method: 'POST', body: '{}' })).status).toBe(202)
		expect(send).toHaveBeenCalledOnce()
		const webfinger = await request('/.well-known/webfinger?resource=acct:a@kopje.test')
		expect(webfinger.status).toBe(503)
		expect(await webfinger.json()).toEqual({ error: expect.stringContaining('maintenance') })
	})

	it('keeps queue messages for later with a delay', () => {
		const batch = createMessageBatch('kopje', [{ id: '1', timestamp: new Date(NOW), attempts: 1, body: {} }])
		const retryAll = vi.spyOn(batch, 'retryAll')
		handleQueue(batch)
		expect(retryAll).toHaveBeenCalledWith({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS })
	})
})
