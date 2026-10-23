import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminClaims, adminHarness, adminTeam, setTeamAccess } from './access-helpers'
import { harness, inboxDeps } from './app-helpers'
import { PNG_PLAIN } from './fixtures/images'
import { BUILD, freshStore, migratedStore, testKernel } from './helpers'
import { bytes, mediaForm, TestCodec, upload } from './media-helpers'
import { ACCESS, beginImport, dumpViaRpc, seedStore } from './ops-helpers'
import { community } from './status-helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { createSnapshotSaver } from '../src/federation/snapshot'
import { type SpoolMessage, spoolInbox } from '../src/federation/spool'
import { handleQueue } from '../src/jobs/queue'
import { errorFields } from '../src/platform/error-message'
import { ImageCodecError } from '../src/platform/images'
import type { LogLevel } from '../src/platform/log'
import type { StoreStub } from '../src/platform/store-client'
import { type MaintenanceReason, storeMaintenanceError, toStoreUnavailable } from '../src/platform/store-errors'
import { StreamHub } from '../src/stream-hub'

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
		// Each console call's arguments, parsed back from the serialized line.
		entries: () => lines.map((line) => JSON.parse(line) as unknown[]),
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
		expect(logs.entries()).toEqual([
			[{ event: 'kopje.error', method: 'GET', route: '/.well-known/webfinger', status: 500, error: 'Error' }],
		])
	})

	it('logs the route template, not the path with its parameters', async () => {
		const logs = captureLogs()
		const response = await harness(failingStore).request('/api/v1/accounts/dummy-query-secret')
		expect(response.status).toBe(500)
		logs.expectNoSecrets()
		expect(logs.entries()).toEqual([
			[{ event: 'kopje.error', method: 'GET', route: '/api/v1/accounts/:id', status: 500, error: 'Error' }],
		])
	})

	it('logs a failed streaming upgrade by its route, never its token or query', async () => {
		const logs = captureLogs()
		const response = await harness(failingStore).request('/api/v1/streaming?stream=dummy-query-secret', {
			headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'kopje-dummy-token-0123' },
		})
		expect(response.status).toBe(500)
		logs.expectNoSecrets()
		expect(logs.entries()).toEqual([
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
		expect(logs.entries()).toEqual([[expect.objectContaining({ event: 'kopje.error', method: 'OTHER', status: 500 })]])
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
		expect(logs.entries()).toEqual([
			[{ event: 'kopje.snapshot.save-failed', kind: 'path', error: 'StoreUnavailableError', reason }],
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

	it('logs a failed snapshot save without its message or key', async () => {
		const logs = captureLogs()
		const save = createSnapshotSaver(() => 0)
		await save(
			failingStore,
			BUILD,
			'webfinger:acct:dummy-query-secret@kopje.test',
			{ contentType: 'application/jrd+json', body: '{}' },
			{ kind: 'instance-actor', rendered: 'x' },
			0
		)
		logs.expectNoSecrets()
		expect(logs.entries()).toEqual([[{ event: 'kopje.snapshot.save-failed', kind: 'webfinger', error: 'Error' }]])
	})

	it('logs an unreadable stored snapshot without its content', async () => {
		const store = await migratedStore()
		const logs = captureLogs()
		const result = await runInDurableObject(store, (instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO kopje_state (name, value) VALUES ('snapshot:path:/ap/users/dummy-query-secret', ?)",
				'dummy post content'
			)
			return instance.rescueSnapshot(BUILD, 'path:/ap/users/dummy-query-secret')
		})
		expect(result).toBeNull()
		logs.expectNoSecrets()
		expect(logs.entries()).toEqual([[{ event: 'kopje.store.snapshot.unreadable', kind: 'path', error: 'SyntaxError' }]])
	})

	it('logs an admin error by route and status only', async () => {
		const team = await adminTeam()
		const store = await migratedStore()
		await setTeamAccess(store, team)
		const failing = {
			adminGate: (build: string) => store.adminGate(build),
			reportTargetPage: () => Promise.reject(secretError()),
		} as unknown as StoreStub
		const logs = captureLogs()
		const response = await adminHarness(failing, team).as(adminClaims(), '/admin/reports/dummy-query-secret')
		expect(response.status).toBe(500)
		logs.expectNoSecrets()
		expect(logs.entries()).toEqual([
			[{ event: 'kopje.admin.error', method: 'GET', route: '/admin/reports/:id', status: 500, error: 'Error' }],
		])
	})

	// A refused kopje_state name is quoted in the refusal's message (store-import.ts), which the caller gets back.
	it('logs a failed import chunk by code only', async () => {
		const source = await migratedStore()
		await seedStore(source, 0)
		const { text } = await dumpViaRpc(source)
		const target = await migratedStore()
		const id = await beginImport(target, text)
		const chunk = new TextEncoder().encode(
			`INSERT INTO "kopje_state" ("name","value") VALUES ('dummy-query-secret','{}');\n`
		)
		const logs = captureLogs()
		expect(await target.importChunk(BUILD, ACCESS, id, 1, chunk)).toMatchObject({ code: 'state-not-allowed' })
		logs.expectNoSecrets()
		expect(logs.entries()).toEqual([
			[
				{
					event: 'kopje.store.import.chunk-failed',
					id,
					seq: 1,
					applied: false,
					code: 'state-not-allowed',
					error: 'ImportError',
				},
			],
		])
	})

	it('logs a failed image transformation without the codec message', async () => {
		const codec = new TestCodec()
		codec.encode = () => Promise.reject(new ImageCodecError(null, SECRET_MESSAGE))
		const h = await community(['alice'], 'read write follow', { images: () => codec })
		const logs = captureLogs()
		const response = await upload(h, h.users.alice, mediaForm(bytes(PNG_PLAIN), {}, 'a.png', 'image/png'))
		expect(response.status).toBe(500)
		logs.expectNoSecrets()
		expect(logs.entries()).toContainEqual([{ event: 'kopje.media.transform_failed', detail: 'images error' }])
	})
})

describe('log levels', () => {
	it('logs a Store failure at error level', async () => {
		const entries: [unknown, LogLevel | undefined][] = []
		await runInDurableObject(freshStore(), async (_instance, state) => {
			const broken = [...MIGRATIONS, { name: '9999_broken', sql: 'INSERT INTO missing VALUES (1);' }]
			const kernel = testKernel(state, broken, { log: (entry, level) => entries.push([entry.event, level]) })
			expect(await kernel.upgrade()).toMatchObject({ ok: false, reason: 'upgrade-failed' })
		})
		expect(entries).toContainEqual(['kopje.store.upgrade.failed', 'error'])
		expect(entries).toContainEqual(['kopje.store.upgrade.start', undefined])
	})

	// A turn request that fails for an unexpected cause is an error; an overloaded object is retried, a warning.
	it.each([
		['an unexpected cause', new Error('boom'), 'error'],
		['an overloaded object', Object.assign(new Error('overloaded'), { overloaded: true }), 'warn'],
	] as const)('logs a failed turn request for %s at %s', async (_label, cause, level) => {
		const waits: Promise<unknown>[] = []
		const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as unknown as DurableObjectState
		const hub = new StreamHub(ctx, {} as never, () => Promise.reject(cause))
		const logged: [string, unknown][] = []
		for (const method of ['log', 'warn', 'error'] as const) {
			vi.spyOn(console, method).mockImplementation((entry: unknown) => logged.push([method, entry]))
		}
		hub.tick()
		await Promise.all(waits)
		expect(logged).toEqual([[level, { event: 'kopje.stream.turn-request-failed', error: 'Error' }]])
	})
})

// kopje.store.unavailable: an HTTP request that met an unavailable Store, by its reason. Maintenance the env sets is
// the operator's own, and is not logged.
describe('store unavailable', () => {
	const held = (reason: MaintenanceReason) =>
		new Proxy(
			{},
			{
				get: (_target, name) =>
					name === 'rescueSnapshot' ? () => Promise.resolve(null) : () => Promise.reject(storeMaintenanceError(reason)),
			}
		) as StoreStub

	const unavailableLogs = async (reason: MaintenanceReason, mode: string | undefined) => {
		const logs = captureLogs()
		const response = await harness(held(reason), { MAINTENANCE: mode }).request(
			'/.well-known/webfinger?resource=acct:dummy-query-secret@kopje.test'
		)
		expect(response.status).toBe(503)
		logs.expectNoSecrets()
		return (logs.entries() as [{ event: string }][]).filter(([entry]) => entry.event === 'kopje.store.unavailable')
	}

	it.each([
		['maintenance', undefined, true],
		['maintenance', 'off', true],
		['maintenance', 'readonly', false],
		['maintenance', 'full', false],
		['schema-pending', 'readonly', true],
		['upgrade-failed', 'full', true],
		['transient', 'off', true],
	] as const)('for %s while MAINTENANCE is %s, logs it: %s', async (reason, mode, logged) => {
		expect(await unavailableLogs(reason, mode)).toEqual(
			logged ? [[{ event: 'kopje.store.unavailable', reason, class: 'always' }]] : []
		)
	})
})
