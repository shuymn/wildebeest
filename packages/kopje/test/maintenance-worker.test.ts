import { describe, expect, inject, it } from 'vitest'

import { apiHarness, sql } from './api-helpers'
import { harness, inboxDeps, NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { AP, mastodonActor, RemoteWeb, signedInit } from './inbox-helpers'
import { ADMIN_AUD, ADMIN_EMAIL, importViaRpc, setAccess } from './ops-helpers'
import { QueueSim } from './queue-sim'
import type { SpoolMessage } from '../src/federation/spool'
import { handleQueue } from '../src/jobs/queue'
import {
	createMaintenanceWorker,
	MAINTENANCE_RETRY_AFTER_SECONDS,
	type MaintenanceEnv,
	type MaintenanceSnapshot,
	SPOOL_BACKLOG_BYTES,
	SPOOL_BACKLOG_MESSAGES,
	SPOOL_QUEUE_BINDING,
	SPOOL_RATE_LIMIT_BINDING,
} from '../src/maintenance'

// The cutover's maintenance worker (docs/cutover-runbook.md, step 3). The global setup (test-node/cutover-global-setup
// .ts) converts a synthetic legacy export and writes its `_worker.js` with the real CLI and bundles; here the snapshot
// it carries is served next to a real Store that imported the same export, and what the worker spools is replayed
// into that Store by Kopje's own consumer.
//   OPS-6: no write but the spool, the same refusals as Kopje's gate, nothing touched but Kopje's Queue.
//   OPS-7: the documents are the ones Kopje serves after the import, keys included.
//   OPS-1: a spooled request is replayed and verified against the time it was spooled.

declare module 'vitest' {
	export interface ProvidedContext {
		cutover: { dump: string; expected: Record<string, Record<string, string>> }
		maintenance: { source: string; workerPath: string }
	}
}

const ORIGIN = 'https://kopje.test'
// A signature of the right shape (only replay verifies it).
const SIGNED = {
	'content-type': AP,
	signature: 'keyId="https://remote.example/users/a#main-key",headers="(request-target) host date",signature="x"',
}

function snapshotOf(source: string): MaintenanceSnapshot {
	const line = source.split('\n')[1]!
	return JSON.parse(line.slice('const KOPJE_MAINTENANCE_SNAPSHOT = '.length, -1)) as MaintenanceSnapshot
}

// Every binding a legacy Pages project has; any use of one fails the test.
function legacyBindings(): Record<string, unknown> {
	const touched = (name: string) =>
		new Proxy(
			{},
			{
				get: (_target, property) => {
					throw new Error(`the maintenance worker used ${name}.${String(property)}`)
				},
			}
		)
	return Object.fromEntries(
		['DATABASE', 'QUEUE', 'DO_CACHE', 'KV_CACHE', 'ASSETS'].map((name) => [name, touched(name)])
	)
}

function maintenance(now = () => NOW) {
	const { source } = inject('maintenance')
	const snapshot = snapshotOf(source)
	const worker = createMaintenanceWorker(snapshot, now)
	const queue = new QueueSim()
	const env = { ...legacyBindings(), [SPOOL_QUEUE_BINDING]: queue.queue }
	const request = (path: string, init?: RequestInit) =>
		worker.fetch!(
			new Request(`${ORIGIN}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
			env,
			{} as ExecutionContext
		)
	return { snapshot, queue, request, worker }
}

async function imported() {
	const { dump } = inject('cutover')
	const h = await apiHarness()
	await setAccess(h.store, { access_team_domain: h.team.teamDomain })
	const authority = {
		kind: 'access',
		email: ADMIN_EMAIL,
		commonName: null,
		teamDomain: h.team.teamDomain,
		aud: ADMIN_AUD,
	} as const
	const { report } = await importViaRpc(h.store, dump, 16 * 1024, authority)
	expect(report).toMatchObject({ ok: true })
	return h
}

// The same request to Kopje after the import and to the maintenance worker: same status, the headers that matter to
// peers and caches, and the same body.
async function expectParity(
	h: Awaited<ReturnType<typeof imported>>,
	request: (path: string, init?: RequestInit) => Response | Promise<Response>,
	path: string,
	init: RequestInit
) {
	const live = await h.request(path, init)
	const served = await request(path, init)
	const label = `${init.method ?? 'GET'} ${path}`
	expect(served.status, label).toBe(live.status)
	for (const name of ['content-type', 'vary', 'cache-control', 'access-control-allow-origin', 'etag']) {
		expect(served.headers.get(name), `${label} ${name}`).toBe(live.headers.get(name))
	}
	expect(await served.text(), label).toBe(await live.text())
}

// The request a peer would send for a snapshot key.
function requestFor(key: string): [string, RequestInit] {
	if (key.startsWith('path:')) {
		return [key.slice('path:'.length), { headers: { accept: AP } }]
	}
	return [`/.well-known/webfinger?resource=${encodeURIComponent(key.slice('webfinger:'.length))}`, {}]
}

describe('the maintenance snapshot (OPS-7)', () => {
	it('holds every local actor, its WebFinger answers, and nothing else', () => {
		const { snapshot } = maintenance()
		expect(snapshot.inboxes.sort()).toEqual(['Bob', 'alice'])
		expect(Object.keys(snapshot.documents).sort()).toEqual([
			'path:/ap/users/Bob',
			'path:/ap/users/alice',
			'webfinger:acct:Bob@kopje.test',
			'webfinger:acct:alice@kopje.test',
			'webfinger:https://kopje.test/ap/users/Bob',
			'webfinger:https://kopje.test/ap/users/alice',
		])
	})

	it('serves byte for byte what the Store serves after the import, keys included', async () => {
		const h = await imported()
		const { snapshot, request } = maintenance()
		const keys = await sql<{ username: string; pubkey: string }>(
			h.store,
			'SELECT a.username, l.pubkey FROM accounts a JOIN local_accounts l ON l.account_id = a.id'
		)
		expect(keys).toHaveLength(2)
		for (const key of Object.keys(snapshot.documents)) {
			const [path, init] = requestFor(key)
			await expectParity(h, request, path, init)
		}
		for (const { username, pubkey } of keys) {
			const actor = (await (await request(`/ap/users/${username}`, { headers: { accept: AP } })).json()) as {
				publicKey: { id: string; publicKeyPem: string }
			}
			expect(actor.publicKey.id).toBe(`${ORIGIN}/ap/users/${username}#main-key`)
			expect(actor.publicKey.publicKeyPem.replace(/\s+/g, '')).toBe(pubkey.replace(/\s+/g, ''))
		}
	})

	// What peers send besides the canonical requests: other ActivityPub Accept values, HEAD, WebFinger in other cases
	// and for unknown names, actor paths in another case. Status, the headers peers and caches read, and the body
	// equal Kopje's after the import.
	it.each<[string, RequestInit]>([
		[
			'/ap/users/alice',
			{ headers: { accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"' } },
		],
		['/ap/users/alice', { headers: { accept: 'application/json' } }],
		['/ap/users/alice', { method: 'HEAD', headers: { accept: AP } }],
		['/ap/users/ALICE', { headers: { accept: AP } }],
		['/ap/users/nobody', { headers: { accept: AP } }],
		['/ap/users/Bob', { method: 'HEAD', headers: { accept: AP } }],
		['/.well-known/webfinger?resource=acct:ALICE@kopje.test', {}],
		['/.well-known/webfinger?resource=acct:alice@KOPJE.test', {}],
		['/.well-known/webfinger?resource=acct:bob@kopje.test', {}],
		['/.well-known/webfinger?resource=acct:nobody@kopje.test', {}],
		['/.well-known/webfinger?resource=acct:alice@other.example', {}],
		['/.well-known/webfinger?resource=https://kopje.test/ap/users/ALICE', {}],
		['/.well-known/webfinger?resource=https://kopje.test/@alice', {}],
		['/.well-known/webfinger?resource=acct:alice@kopje.test', { method: 'HEAD' }],
	])('answers %s as Kopje does (%o)', async (path, init) => {
		const h = await imported()
		const { request } = maintenance()
		await expectParity(h, request, path, init)
	})

	it('answers anything it cannot tell exactly with 503 and Retry-After', async () => {
		const { request } = maintenance()
		for (const [path, init] of [
			['/ap/users/alice', { headers: { accept: 'text/html' } }],
			['/actor', { headers: { accept: AP } }],
			['/.well-known/webfinger?resource=https://kopje.test/actor', {}],
			['/.well-known/webfinger?resource=https://other.example/users/a', {}],
			['/.well-known/webfinger', {}],
			['/.well-known/nodeinfo', {}],
			['/nodeinfo/2.1', {}],
			['/ap/users/alice/outbox', { headers: { accept: AP } }],
			['/ap/users/alice/followers', { headers: { accept: AP } }],
			['/ap/o/0b3c1b52-9f1e-4f43-a2b6-7d0a3f1c2e11', { headers: { accept: AP } }],
			['/api/v1/timelines/public', {}],
			['/@alice', {}],
			['/', {}],
		] as const) {
			const response = await request(path, init)
			expect(response.status, path).toBe(503)
			expect(response.headers.get('retry-after'), path).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS))
			expect(response.headers.get('x-content-type-options'), path).toBe('nosniff')
		}
	})
})

// Kopje itself answers the rest of the window (steps 7 and 8) with the same maintenance answer.
describe('Retry-After through the whole window', () => {
	it("is on Kopje's own maintenance answers, in full and in readonly maintenance", async () => {
		const full = await apiHarness({ MAINTENANCE: 'full' })
		const read = await full.request('/api/v1/timelines/public')
		expect(read.status).toBe(503)
		expect(read.headers.get('retry-after')).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS))
		const readonly = await apiHarness({ MAINTENANCE: 'readonly' })
		const write = await readonly.request('/api/v1/statuses', { method: 'POST', body: '{}' })
		expect(write.status).toBe(503)
		expect(write.headers.get('retry-after')).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS))
	})
})

describe('the maintenance worker accepts no write but the spool (OPS-6)', () => {
	it('refuses every other write with 503 and touches no legacy binding', async () => {
		const { request, queue } = maintenance()
		for (const [method, path] of [
			['POST', '/api/v1/statuses'],
			['POST', '/api/v1/apps'],
			['POST', '/oauth/token'],
			['PUT', '/api/v1/accounts/update_credentials'],
			['PATCH', '/api/v1/accounts/update_credentials'],
			['DELETE', '/api/v1/statuses/1'],
			['POST', '/ap/users/alice/outbox'],
			['POST', '/ap/users/alice'],
			['PUT', '/ap/users/alice/inbox'],
			['POST', '/first-login'],
			['POST', '/api/v1/push/subscription'],
		] as const) {
			const response = await request(path, { method, headers: { 'content-type': AP }, body: '{}' })
			expect(response.status, `${method} ${path}`).toBe(503)
		}
		expect(queue.send).not.toHaveBeenCalled()
	})

	it('refuses before spooling what Kopje refuses: unknown personal inboxes, other media types, oversized bodies', async () => {
		const { request, queue } = maintenance()
		for (const path of ['/ap/users/nobody/inbox', '/ap/users/ALICE/inbox', '/ap/users/Ali%63e/inbox']) {
			expect((await request(path, { method: 'POST', headers: { 'content-type': AP }, body: '{}' })).status, path).toBe(
				404
			)
		}
		for (const type of ['application/json', 'text/plain', '']) {
			const response = await request('/inbox', { method: 'POST', headers: { 'content-type': type }, body: '{}' })
			expect(response.status, type).toBe(415)
		}
		const big = new Uint8Array(1024 * 1024 + 1)
		expect((await request('/inbox', { method: 'POST', headers: { 'content-type': AP }, body: big })).status).toBe(413)
		// Random bytes do not deflate: the request does not fit one Queue message, and nothing is sent (OPS-1).
		const noise = new Uint8Array(200 * 1024)
		for (let i = 0; i < noise.length; i += 65536) {
			crypto.getRandomValues(noise.subarray(i, i + 65536))
		}
		expect((await request('/inbox', { method: 'POST', headers: SIGNED, body: noise })).status).toBe(503)
		expect(queue.send).not.toHaveBeenCalled()
	})

	it('answers 503 rather than 202 when it cannot spool', async () => {
		const { worker } = maintenance()
		const init = { method: 'POST', headers: SIGNED, body: '{}' }
		const call = (env: Record<string, unknown>) =>
			worker.fetch!(
				new Request(`${ORIGIN}/inbox`, init) as Request<unknown, IncomingRequestCfProperties>,
				env,
				{} as ExecutionContext
			)
		expect((await call(legacyBindings())).status).toBe(503)
		const failing = { send: () => Promise.reject(new Error('queue unavailable')) }
		expect((await call({ ...legacyBindings(), [SPOOL_QUEUE_BINDING]: failing })).status).toBe(503)
	})
})

describe('the spool admits only signed requests, within its budget (OPS-6)', () => {
	const post = (worker: ExportedHandler<MaintenanceEnv>, env: MaintenanceEnv, headers: Record<string, string>) =>
		worker.fetch!(
			new Request(`${ORIGIN}/inbox`, { method: 'POST', headers, body: '{}' }) as Request<
				unknown,
				IncomingRequestCfProperties
			>,
			env,
			{} as ExecutionContext
		)

	it('refuses a request without a signature of the right shape, before anything is spooled', async () => {
		const { worker, queue } = maintenance()
		const env = { [SPOOL_QUEUE_BINDING]: queue.queue }
		for (const signature of [
			undefined,
			'headers="date",signature="x"',
			'keyId="http://remote.example/users/a#main-key",signature="x"',
			'keyId="",signature="x"',
			`keyId="https://remote.example/${'a'.repeat(2048)}",signature="x"`,
		]) {
			const headers: Record<string, string> = { 'content-type': AP }
			if (signature !== undefined) {
				headers.signature = signature
			}
			expect((await post(worker, env, headers)).status, String(signature)).toBe(401)
		}
		expect(queue.send).not.toHaveBeenCalled()
		const rfc9421 = {
			'content-type': AP,
			'signature-input': 'sig1=("@method" "@target-uri");keyid="https://remote.example/users/a#main-key"',
			signature: 'sig1=:eA==:',
		}
		expect((await post(worker, env, rfc9421)).status).toBe(202)
		expect((await post(worker, env, SIGNED)).status).toBe(202)
	})

	it('answers 429 over the per-IP rate limit, when the Pages project binds one', async () => {
		const { worker, queue } = maintenance()
		const keys: string[] = []
		const limiter = {
			limit: ({ key }: { key: string }) => {
				keys.push(key)
				return Promise.resolve({ success: keys.length < 2 })
			},
		}
		const env = { [SPOOL_QUEUE_BINDING]: queue.queue, [SPOOL_RATE_LIMIT_BINDING]: limiter }
		const headers = { ...SIGNED, 'cf-connecting-ip': '192.0.2.1' }
		expect((await post(worker, env, headers)).status).toBe(202)
		const limited = await post(worker, env, headers)
		expect(limited.status).toBe(429)
		expect(limited.headers.get('retry-after')).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS))
		expect(keys).toEqual(['192.0.2.1', '192.0.2.1'])
		expect(queue.pending).toHaveLength(1)
	})

	it("answers 503 once the Queue's backlog reaches the budget, and admits again when it falls", async () => {
		let clock = NOW
		const worker = createMaintenanceWorker(maintenance().snapshot, () => clock)
		const queue = new QueueSim()
		let backlog = { backlogCount: SPOOL_BACKLOG_MESSAGES, backlogBytes: 0 }
		const withMetrics = Object.assign(queue.queue, { metrics: () => Promise.resolve(backlog) })
		const env = { [SPOOL_QUEUE_BINDING]: withMetrics }
		const full = await post(worker, env, SIGNED)
		expect(full.status).toBe(503)
		expect(full.headers.get('retry-after')).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS))
		backlog = { backlogCount: 0, backlogBytes: SPOOL_BACKLOG_BYTES }
		clock += 60_000
		expect((await post(worker, env, SIGNED)).status).toBe(503)
		backlog = { backlogCount: 0, backlogBytes: 0 }
		clock += 60_000
		expect((await post(worker, env, SIGNED)).status).toBe(202)
		expect(queue.pending).toHaveLength(1)
	})
})

describe('admission fails closed when the backlog cannot be read (OPS-6)', () => {
	const post = (worker: ExportedHandler<MaintenanceEnv>, env: MaintenanceEnv) =>
		worker.fetch!(
			new Request(`${ORIGIN}/inbox`, { method: 'POST', headers: SIGNED, body: '{}' }) as Request<
				unknown,
				IncomingRequestCfProperties
			>,
			env,
			{} as ExecutionContext
		)

	it('in the maintenance worker: a Queue without metrics, or whose metrics fail, admits nothing', async () => {
		for (const metrics of [undefined, () => Promise.reject(new Error('metrics unavailable'))]) {
			const { worker } = maintenance()
			const sent: unknown[] = []
			const queue = { send: (body: unknown) => Promise.resolve(void sent.push(body)), ...(metrics ? { metrics } : {}) }
			const response = await post(worker, { [SPOOL_QUEUE_BINDING]: queue as unknown as Queue })
			expect(response.status).toBe(503)
			expect(response.headers.get('retry-after')).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS))
			expect(sent).toEqual([])
		}
	})

	it("in Kopje's own maintenance gate: the same budget, failing closed", async () => {
		const signed = { method: 'POST', headers: SIGNED, body: '{}' }
		for (const queue of [
			{ send: () => Promise.resolve() },
			{ send: () => Promise.resolve(), metrics: () => Promise.reject(new Error('metrics unavailable')) },
			{
				send: () => Promise.resolve(),
				metrics: () => Promise.resolve({ backlogCount: SPOOL_BACKLOG_MESSAGES, backlogBytes: 0 }),
			},
		]) {
			const h = harness(await migratedStore(), { MAINTENANCE: 'readonly', QUEUE: queue })
			const response = await h.request('/inbox', signed)
			expect(response.status).toBe(503)
			expect(response.headers.get('retry-after')).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS))
		}
		const open = harness(await migratedStore(), { MAINTENANCE: 'readonly' })
		expect((await open.request('/inbox', signed)).status).toBe(202)
	})
})

describe('spooled inbox requests replay into Kopje (OPS-1)', () => {
	async function follow(path: string) {
		const web = new RemoteWeb()
		const carol = await mastodonActor(web, 'carol')
		const activity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `${carol.uri}#follows/1`,
			type: 'Follow',
			actor: carol.uri,
			object: `${ORIGIN}/ap/users/alice`,
		}
		return { web, carol, init: await signedInit(carol, path, activity) }
	}

	for (const path of ['/inbox', '/ap/users/alice/inbox']) {
		it(`spools a signed Follow to ${path} in Kopje's format, and Kopje replays it after the cutover`, async () => {
			const h = await imported()
			const { request, queue } = maintenance()
			const { web, carol, init } = await follow(path)

			const response = await request(path, init)
			expect(response.status).toBe(202)
			expect(queue.pending).toHaveLength(1)
			const [, options] = queue.send.mock.calls[0]! as [SpoolMessage, QueueSendOptions]
			expect(options).toEqual({ contentType: 'v8' })
			expect(queue.pending[0]!.body).toMatchObject({ kind: 'spool', url: `${ORIGIN}${path}`, spooledAt: NOW })

			// Kopje's consumer after publication: its clock is a day past the signature, which still verifies against
			// the time the request was spooled.
			const deps = { ...inboxDeps(() => h.store, web.loader), now: () => NOW + 24 * 60 * 60 * 1000 }
			const env = { ...h.env, MAINTENANCE: 'off', QUEUE: new QueueSim().queue } as Env
			await queue.deliver((batch) => handleQueue(batch, env, deps))
			expect(queue.retries).toBe(0)
			const follows = await sql<{ state: string }>(
				h.store,
				`SELECT f.state FROM follows f JOIN accounts a ON a.id = f.account_id JOIN accounts t ON t.id = f.target_account_id
				WHERE a.uri = ? AND t.username = 'alice' AND t.domain IS NULL`,
				carol.uri
			)
			expect(follows).toEqual([{ state: 'accepted' }])
		})
	}

	it('keeps the signature binding: a request altered in the spool is refused on replay', async () => {
		const h = await imported()
		const { request, queue } = maintenance()
		const { web, carol, init } = await follow('/inbox')
		expect((await request('/inbox', init)).status).toBe(202)
		const message = queue.pending[0]!.body as SpoolMessage
		message.headers = message.headers.map(([name, value]) =>
			name === 'date' ? [name, new Date(NOW + 1000).toUTCString()] : [name, value]
		)
		const env = { ...h.env, MAINTENANCE: 'off', QUEUE: new QueueSim().queue } as Env
		await queue.deliver((batch) =>
			handleQueue(
				batch,
				env,
				inboxDeps(() => h.store, web.loader)
			)
		)
		const follows = await sql<{ n: number }>(
			h.store,
			'SELECT count(*) AS n FROM follows f JOIN accounts a ON a.id = f.account_id WHERE a.uri = ?',
			carol.uri
		)
		expect(follows).toEqual([{ n: 0 }])
	})
})

describe('the generated _worker.js', () => {
	it('is the bundle with its snapshot, and serves and spools as the module does', async () => {
		const { workerPath, source } = inject('maintenance')
		const module = (await import(/* @vite-ignore */ workerPath)) as {
			default: ExportedHandler<Record<string, unknown>>
		}
		const queue = new QueueSim()
		const env = { ...legacyBindings(), [SPOOL_QUEUE_BINDING]: queue.queue }
		const call = (path: string, init?: RequestInit) =>
			module.default.fetch!(
				new Request(`${ORIGIN}${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
				env,
				{} as ExecutionContext
			)
		const actor = await call('/ap/users/alice', { headers: { accept: AP } })
		expect(actor.status).toBe(200)
		expect(await actor.text()).toBe(snapshotOf(source).documents['path:/ap/users/alice']!.body)
		expect((await call('/api/v1/statuses', { method: 'POST', body: '{}' })).status).toBe(503)
		const spooled = await call('/inbox', { method: 'POST', headers: SIGNED, body: '{}' })
		expect(spooled.status).toBe(202)
		expect(queue.pending).toHaveLength(1)
	})
})
