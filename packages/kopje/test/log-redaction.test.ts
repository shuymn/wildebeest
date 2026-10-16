import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { harness, inboxDeps } from './app-helpers'
import { BUILD, migratedStore } from './helpers'
import { createSnapshotSaver } from '../src/federation/snapshot'
import { type SpoolMessage, spoolInbox } from '../src/federation/spool'
import { handleQueue } from '../src/jobs/queue'
import { errorFields } from '../src/platform/error-message'
import type { StoreStub } from '../src/platform/store-client'
import { storeMaintenanceError, toStoreUnavailable } from '../src/platform/store-errors'

// DATA-5: logs carry allowlisted fields only. Every failure below throws a message full of dummy secrets (a bearer
// token, an Access JWT, a request body); none of them may reach the console.
const MARKERS = ['kopje-dummy-token', 'dummy-access-assertion', 'dummy post content', 'dummy-query-secret']
const SECRET_MESSAGE =
	'failed: authorization: Bearer kopje-dummy-token-0123 cf-access-jwt-assertion: ' +
	'eyJhbGciOiJub25lIn0.dummy-access-assertion.c2ln body: {"status":"dummy post content"}'

function secretError(): Error {
	return new Error(SECRET_MESSAGE)
}

function captureLogs() {
	const lines: string[] = []
	for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			lines.push(
				JSON.stringify(args, (_key, value: unknown) =>
					value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value
				)
			)
		})
	}
	return {
		lines,
		expectNoSecrets() {
			const text = lines.join('\n')
			for (const marker of MARKERS) {
				expect(text).not.toContain(marker)
			}
		},
	}
}

afterEach(() => {
	vi.restoreAllMocks()
})

// Every call fails with a secret-bearing error, except the publication mark and the handoff check that precede the
// call under test.
const failingStore = new Proxy(
	{},
	{
		get: (_target, name) =>
			name === 'markPublished'
				? () => Promise.resolve({ published: { at: 0, via: 'command' } })
				: name === 'handedOff'
					? () => Promise.resolve(false)
					: () => Promise.reject(secretError()),
	}
) as StoreStub

function spoolMessage(): SpoolMessage {
	return {
		kind: 'spool',
		url: 'https://kopje.test/inbox',
		method: 'POST',
		headers: [],
		body: new Uint8Array(1),
		spooledAt: 0,
	}
}

function batchOf(body: unknown) {
	const message = { id: 'm1', body, timestamp: new Date(), attempts: 1, ack: vi.fn(), retry: vi.fn() }
	return { batch: { queue: 'kopje', messages: [message] } as unknown as MessageBatch, message }
}

describe('log redaction', () => {
	it('logs an unexpected request error by class, route and status only', async () => {
		const logs = captureLogs()
		const response = await harness(failingStore).request(
			'/.well-known/webfinger?resource=acct:dummy-query-secret@kopje.test',
			{ headers: { authorization: 'Bearer kopje-dummy-token-0123' } }
		)
		expect(response.status).toBe(500)
		logs.expectNoSecrets()
		expect(logs.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
			[{ event: 'kopje.error', method: 'GET', route: '/.well-known/webfinger', status: 500, error: 'Error' }],
		])
	})

	it('logs the route template, not the path with its parameters', async () => {
		const logs = captureLogs()
		const response = await harness(failingStore).request('/api/v1/accounts/dummy-query-secret')
		expect(response.status).toBe(500)
		logs.expectNoSecrets()
		expect(logs.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
			[{ event: 'kopje.error', method: 'GET', route: '/api/v1/accounts/:id', status: 500, error: 'Error' }],
		])
	})

	it("logs a failed streaming upgrade by its route, never the query's access_token", async () => {
		const logs = captureLogs()
		const response = await harness(failingStore).request(
			'/api/v1/streaming?access_token=kopje-dummy-token-0123&stream=dummy-query-secret',
			{ headers: { upgrade: 'websocket' } }
		)
		expect(response.status).toBe(500)
		logs.expectNoSecrets()
		expect(logs.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
			[{ event: 'kopje.error', method: 'GET', route: '/api/v1/streaming', status: 500, error: 'Error' }],
		])
	})

	// workerd refuses methods outside its own list, so an extension method it knows (WebDAV's PROPFIND) stands in for any
	// method outside the standard set.
	it('logs a non-standard method as OTHER', async () => {
		const logs = captureLogs()
		const response = await harness(failingStore).request('/.well-known/webfinger', { method: 'PROPFIND' })
		expect(response.status).toBe(500)
		logs.expectNoSecrets()
		expect(logs.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
			[expect.objectContaining({ event: 'kopje.error', method: 'OTHER', status: 500 })],
		])
	})

	it.each(['schema-pending', 'transient'] as const)('keeps the Store maintenance reason %s', async (reason) => {
		const logs = captureLogs()
		const held = new Proxy({}, { get: () => () => Promise.reject(storeMaintenanceError(reason)) }) as StoreStub
		const save = createSnapshotSaver(() => 0)
		await save(
			held,
			BUILD,
			'path:/actor',
			{ contentType: 'application/activity+json', body: '{}' },
			{ kind: 'instance-actor', rendered: 'x' },
			0
		)
		expect(logs.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
			[{ event: 'kopje.snapshot.save-failed', key: 'path:/actor', error: 'StoreUnavailableError', reason }],
		])
	})

	it('logs only allowlisted metadata, whatever name, code or reason an error carries', () => {
		const custom = Object.assign(new Error(SECRET_MESSAGE), { name: 'dummy-query-secret', code: 'dummy-query-secret' })
		expect(errorFields(custom)).toEqual({ error: 'Error' })
		// The Worker reads the reason out of the Store's message, so an unknown one is dropped.
		const forged = toStoreUnavailable(new Error('kopje-maintenance: dummy-query-secret'))
		expect(errorFields(forged)).toEqual({ error: 'StoreUnavailableError' })
		// Standard names are kept: they tell an abort or timeout from other failures.
		expect(errorFields(new DOMException('dummy post content', 'TimeoutError'))).toEqual({
			error: 'DOMException',
			name: 'TimeoutError',
		})
		expect(errorFields(new TypeError('dummy post content'))).toEqual({ error: 'TypeError' })
		expect(errorFields('dummy post content')).toEqual({ error: 'string' })
	})

	it('logs a failed spool replay without its message', async () => {
		const logs = captureLogs()
		const { batch, message } = batchOf(spoolMessage())
		await handleQueue(
			batch,
			{ ...env, MAINTENANCE: 'off' } as Env,
			inboxDeps(() => failingStore)
		)
		expect(message.retry).toHaveBeenCalledOnce()
		logs.expectNoSecrets()
		expect(logs.lines.join('\n')).toContain('kopje.spool.replay.failed')
	})

	it('logs a failed requeue without its message', async () => {
		const logs = captureLogs()
		const { batch, message } = batchOf(spoolMessage())
		const queue = { send: () => Promise.reject(secretError()) } as unknown as Queue
		await handleQueue(
			batch,
			{ ...env, MAINTENANCE: 'readonly', QUEUE: queue } as Env,
			inboxDeps(() => failingStore)
		)
		expect(message.retry).toHaveBeenCalledOnce()
		logs.expectNoSecrets()
		expect(logs.lines.join('\n')).toContain('kopje.spool.requeue.failed')
	})

	it('logs a failed spool send without its message', async () => {
		const logs = captureLogs()
		const queue = { send: () => Promise.reject(secretError()) } as unknown as Queue
		const request = new Request('https://kopje.test/inbox', { method: 'POST' })
		const response = await spoolInbox(request, new TextEncoder().encode('{"content":"dummy post content"}'), queue, 0)
		expect(response.status).toBe(503)
		logs.expectNoSecrets()
		expect(logs.lines.join('\n')).toContain('kopje.spool.failed')
	})

	it('logs a failed snapshot save without its message', async () => {
		const logs = captureLogs()
		const save = createSnapshotSaver(() => 0)
		await save(
			failingStore,
			BUILD,
			'path:/actor',
			{ contentType: 'application/activity+json', body: '{}' },
			{ kind: 'instance-actor', rendered: 'x' },
			0
		)
		logs.expectNoSecrets()
		expect(logs.lines.join('\n')).toContain('kopje.snapshot.save-failed')
	})

	it('logs an unreadable stored snapshot without its content', async () => {
		const store = await migratedStore()
		const logs = captureLogs()
		const result = await runInDurableObject(store, (instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO kopje_state (name, value) VALUES ('snapshot:path:/actor', ?)",
				'dummy post content'
			)
			return instance.rescueSnapshot(BUILD, 'path:/actor')
		})
		expect(result).toBeNull()
		logs.expectNoSecrets()
		expect(logs.lines.join('\n')).toContain('kopje.store.snapshot.unreadable')
	})
})
