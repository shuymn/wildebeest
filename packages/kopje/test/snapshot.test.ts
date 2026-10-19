import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { harness, NOW } from './app-helpers'
import { fixtureKeyGen, LEGACY, LEGACY_EMPTY_KEK, seedLocalAccount, setDomain } from './federation-helpers'
import { BUILD, freshStore, migratedStore, testKernel } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { createSnapshotSaver, SNAPSHOT_SAVE_INTERVAL_MS } from '../src/federation/snapshot'
import type { StoreStub } from '../src/platform/store-client'
import { storeMaintenanceError } from '../src/platform/store-errors'
import { SNAPSHOT_MAX_BODY_BYTES } from '../src/platform/store-kernel'

const DOMAIN = 'social.example'
const STATIC = { kind: 'static' } as const
const AP = { headers: { accept: 'application/activity+json' } }
const offline = {
	keygen: fixtureKeyGen,
	loader: { fetch: () => Promise.reject(new Error('offline')), checkHost: () => Promise.resolve() },
}
const ALWAYS = [
	'/ap/users/Alice',
	'/actor',
	'/.well-known/webfinger?resource=acct:Alice@social.example',
	'/.well-known/webfinger?resource=https://social.example/ap/users/Alice',
	'/.well-known/nodeinfo',
	'/nodeinfo/2.0',
	'/nodeinfo/2.1',
]

async function served(store: StoreStub, build = BUILD) {
	const { request } = harness(store, { USER_KEK: LEGACY.kek }, build, offline)
	const bodies: Record<string, { status: number; type: string | null; body: string }> = {}
	for (const path of ALWAYS) {
		const response = await request(path, AP)
		bodies[path] = { status: response.status, type: response.headers.get('content-type'), body: await response.text() }
	}
	return { request, bodies }
}

async function healthyInstance() {
	const store = await migratedStore()
	await setDomain(store, DOMAIN)
	await seedLocalAccount(store, DOMAIN, { id: '111111111111111111', username: 'Alice' })
	return { store, healthy: (await served(store)).bodies }
}

function snapshotNames(store: StoreStub): Promise<string[]> {
	return runInDurableObject(store, (_instance, state) =>
		state.storage.sql
			.exec<{ name: string }>("SELECT name FROM kopje_state WHERE name LIKE 'snapshot:%' ORDER BY name")
			.toArray()
			.map((row) => row.name)
	)
}

describe('actor document snapshot', () => {
	it('keeps the last good actor, WebFinger and NodeInfo payloads on the healthy path', async () => {
		const { store, healthy } = await healthyInstance()
		for (const path of ALWAYS) {
			expect(healthy[path]?.status, path).toBe(200)
		}
		expect(await snapshotNames(store)).toEqual([
			'snapshot:path:/.well-known/nodeinfo',
			'snapshot:path:/actor',
			'snapshot:path:/ap/users/Alice',
			'snapshot:path:/nodeinfo/2.0',
			'snapshot:path:/nodeinfo/2.1',
			'snapshot:webfinger:acct:Alice@social.example',
			'snapshot:webfinger:https://social.example/ap/users/Alice',
		])
	})

	it('does not keep non-canonical WebFinger queries, misses, or HTML negotiation', async () => {
		const { store } = await healthyInstance()
		const { request } = harness(store, { USER_KEK: LEGACY.kek }, BUILD, offline)
		const before = await snapshotNames(store)
		await request('/.well-known/webfinger?resource=acct:alice@social.example')
		await request('/.well-known/webfinger?resource=acct:nobody@social.example')
		await request('/ap/users/nobody', AP)
		await request('/ap/users/Alice', { headers: { accept: 'text/html' } })
		expect(await snapshotNames(store)).toEqual(before)
	})

	it('serves the snapshots instead of 503 while the Worker and the Store builds differ', async () => {
		const { store, healthy } = await healthyInstance()
		const { request, bodies } = await served(store, '0.0.0-other')

		for (const path of ALWAYS) {
			expect(bodies[path], path).toEqual(healthy[path])
		}
		expect((await request('/ap/users/nobody', AP)).status).toBe(503)
		expect((await request('/.well-known/webfinger?resource=acct:alice@social.example')).status).toBe(503)
		expect((await request('/ap/users/Alice', { headers: { accept: 'text/html' } })).status).toBe(503)
		expect((await request('/ap/users/Alice/followers', AP)).status).toBe(503)
	})

	it('serves the snapshots while the Store refuses domain operations', async () => {
		const { store, healthy } = await healthyInstance()
		// The Store answers rescue RPCs but refuses every operation, as with a diverged schema.
		const refusing = new Proxy(store, {
			get(target, property, receiver) {
				if (property === 'rescueSnapshot') {
					return Reflect.get(target, property, receiver) as unknown
				}
				return () => Promise.reject(storeMaintenanceError('schema-diverged'))
			},
		})
		const { bodies } = await served(refusing)
		for (const path of ALWAYS) {
			expect(bodies[path], path).toEqual(healthy[path])
		}
	})

	it('answers 503 when no snapshot was ever kept', async () => {
		const store = freshStore()
		const { request } = harness(store, {}, '0.0.0-other', offline)
		expect((await request('/ap/users/Alice', AP)).status).toBe(503)
		expect((await request('/nodeinfo/2.1')).status).toBe(503)
	})
})

describe('snapshot freshness', () => {
	it('rejects a delayed save of a document rendered before a key rotation, in any isolate', async () => {
		const { store } = await healthyInstance()
		const key = 'path:/ap/users/Alice'
		const before = await store.rescueSnapshot(BUILD, key)
		const renderedFrom = JSON.stringify(await store.localActor(BUILD, { username: 'Alice' }))

		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE local_accounts SET pubkey = ? WHERE account_id = '111111111111111111'",
				LEGACY_EMPTY_KEK.pubkey
			)
		})
		// Another isolate (a fresh harness) renders and keeps the rotated document.
		const { request } = harness(store, { USER_KEK: LEGACY.kek }, BUILD, offline)
		expect((await request('/ap/users/Alice', AP)).status).toBe(200)
		const after = await store.rescueSnapshot(BUILD, key)
		expect(after?.body).not.toBe(before?.body)

		// The old response's background save arrives late.
		const late = await store.saveSnapshot(BUILD, {
			key,
			contentType: before?.contentType ?? '',
			body: before?.body ?? '',
			source: { kind: 'actor', username: 'Alice', rendered: renderedFrom },
			renderedAt: NOW,
		})
		expect(late).toBe(false)
		expect(await store.rescueSnapshot(BUILD, key)).toEqual(after)
	})
})

describe('snapshots of a suspended actor', () => {
	const ACTOR_KEYS = [
		'path:/ap/users/Alice',
		'webfinger:acct:Alice@social.example',
		'webfinger:https://social.example/ap/users/Alice',
	]

	it('drops them on suspension, then keeps the redacted documents, and the full ones again after unsuspension', async () => {
		const { store, healthy } = await healthyInstance()
		const before = await store.rescueSnapshot(BUILD, 'path:/ap/users/Alice')
		const renderedFrom = JSON.stringify(await store.localActor(BUILD, { username: 'Alice' }))

		expect(await store.suspendAccount(BUILD, { accountId: '111111111111111111', now: NOW })).toEqual({
			suspended: true,
		})
		for (const key of ACTOR_KEYS) {
			expect(await store.rescueSnapshot(BUILD, key), key).toBeNull()
		}
		// The instance's own snapshots stay.
		expect(await snapshotNames(store)).toEqual([
			'snapshot:path:/.well-known/nodeinfo',
			'snapshot:path:/actor',
			'snapshot:path:/nodeinfo/2.0',
			'snapshot:path:/nodeinfo/2.1',
		])
		// While the Store refuses, the actor's documents answer 503 rather than the document from before.
		const { request } = harness(store, { USER_KEK: LEGACY.kek }, '0.0.0-other', offline)
		expect((await request('/ap/users/Alice', AP)).status).toBe(503)
		// A save of the document rendered before the suspension, arriving late, is refused.
		expect(
			await store.saveSnapshot(BUILD, {
				key: 'path:/ap/users/Alice',
				contentType: before?.contentType ?? '',
				body: before?.body ?? '',
				source: { kind: 'actor', username: 'Alice', rendered: renderedFrom },
				renderedAt: NOW,
			})
		).toBe(false)

		// The next live requests keep the redacted documents, which the rescue path then serves.
		const suspended = (await served(store)).bodies
		expect(JSON.parse(suspended['/ap/users/Alice']?.body ?? '{}')).toMatchObject({ suspended: true })
		expect(JSON.parse(suspended['/ap/users/Alice']?.body ?? '{}')).not.toHaveProperty('name')
		const rescued = (await served(store, '0.0.0-other')).bodies
		for (const path of ALWAYS) {
			expect(rescued[path], path).toEqual(suspended[path])
		}

		// Unsuspended, the live requests keep the full documents again.
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec("UPDATE local_accounts SET suspended_at = NULL WHERE account_id = '111111111111111111'")
		})
		expect((await served(store)).bodies).toEqual(healthy)
		expect((await served(store, '0.0.0-other')).bodies).toEqual(healthy)
	})
})

describe('snapshot render order', () => {
	it('refuses a NodeInfo rendered before the kept one, though its own source still recomputes the same', async () => {
		const { store } = await healthyInstance()
		const day = 24 * 60 * 60 * 1000
		// After the render time of the snapshot healthyInstance kept (NOW), so only the two renders below compete.
		const posted = NOW
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES
				('333333333333333333', 'https://social.example/ap/o/1', '111111111111111111', 'public', ?)`,
				new Date(posted).toISOString()
			)
		})
		const render = async (now: number) => {
			const usage = await store.nodeInfoUsage(BUILD, { now })
			return {
				key: 'path:/nodeinfo/2.1',
				contentType: 'application/json',
				body: JSON.stringify(usage),
				source: { kind: 'nodeinfo', now, rendered: JSON.stringify(usage) } as const,
				renderedAt: now,
			}
		}
		const early = await render(posted + 29 * day) // the post still counts as active this month
		const late = await render(posted + 31 * day) // it has aged out
		expect(early.body).not.toBe(late.body)

		expect(await store.saveSnapshot(BUILD, late)).toBe(true)
		expect(await store.saveSnapshot(BUILD, early)).toBe(false)
		expect((await store.rescueSnapshot(BUILD, 'path:/nodeinfo/2.1'))?.body).toBe(late.body)
	})
})

describe('snapshot caps', () => {
	it('creates no rows for arbitrary handles, resources or query strings', async () => {
		const { store } = await healthyInstance()
		const before = await snapshotNames(store)
		const { request } = harness(store, { USER_KEK: LEGACY.kek }, BUILD, offline)
		for (let i = 0; i < 20; i++) {
			const junk = `${crypto.randomUUID()}${'x'.repeat(i * 50)}`
			await request(`/ap/users/${junk}`, AP)
			await request(`/ap/users/Alice?v=${junk}`, AP)
			await request(`/.well-known/webfinger?resource=acct:${junk}@social.example`)
			await request(`/.well-known/webfinger?resource=https://social.example/ap/users/${junk}`)
			await request(`/nodeinfo/2.1?v=${junk}`)
		}
		expect(await snapshotNames(store)).toEqual(before)
		// 100 requests through Fedify; the default 5 s is too tight when the whole repository's suites run at once.
	}, 30_000)

	it('creates no rows for other spellings of a canonical path or resource', async () => {
		const { store } = await healthyInstance()
		const before = await snapshotNames(store)
		const { request } = harness(store, { USER_KEK: LEGACY.kek }, BUILD, offline)
		await request('/ap/users/Ali%63e', AP)
		await request('/ap/users/%41lice', AP)
		await request('/ap/users/Alice/', AP)
		await request('/.well-known/webfinger?resource=acct%3AAlice%40social.example&resource=acct:Bob@x.example')
		await request('/.well-known/webfinger?resource=acct:Alice@SOCIAL.EXAMPLE')
		await request('/.well-known/webfinger?resource=https://social.example/ap/users/Ali%63e')
		expect(await snapshotNames(store)).toEqual(before)
	})

	it('drops the kept snapshot when its replacement is over the size cap', async () => {
		const store = await migratedStore()
		const small = { contentType: 'application/activity+json', body: '{"v":1}' }
		const big = { contentType: 'application/activity+json', body: 'x'.repeat(SNAPSHOT_MAX_BODY_BYTES + 1) }
		expect(await store.saveSnapshot(BUILD, { source: STATIC, renderedAt: 0, key: 'path:/actor', ...small })).toBe(true)

		expect(await store.saveSnapshot(BUILD, { source: STATIC, renderedAt: 0, key: 'path:/actor', ...big })).toBe(false)
		// The rescue path then answers 503 rather than serving the outdated document.
		expect(await store.rescueSnapshot(BUILD, 'path:/actor')).toBeNull()
	})

	it('does not store a document over the size cap', async () => {
		const store = await migratedStore()
		await setDomain(store, DOMAIN)
		await seedLocalAccount(store, DOMAIN, {
			id: '111111111111111111',
			username: 'Alice',
			note: 'x'.repeat(64 * 1024 - 2),
		})
		const { request } = harness(store, { USER_KEK: LEGACY.kek }, BUILD, offline)
		expect((await request('/ap/users/Alice', AP)).status).toBe(200)
		expect(await store.rescueSnapshot(BUILD, 'path:/ap/users/Alice')).toBeNull()

		const big = { contentType: 'application/json', body: 'x'.repeat(SNAPSHOT_MAX_BODY_BYTES + 1) }
		expect(await store.saveSnapshot(BUILD, { source: STATIC, renderedAt: 0, key: 'path:/actor', ...big })).toBe(false)
		expect(
			await store.saveSnapshot(BUILD, { source: STATIC, renderedAt: 0, key: 'hold', contentType: 'x', body: '{}' })
		).toBe(false)
		expect(
			await store.saveSnapshot(BUILD, {
				source: STATIC,
				renderedAt: 0,
				key: `path:/${'x'.repeat(600)}`,
				contentType: 'x',
				body: '{}',
			})
		).toBe(false)
		// Oversized bodies of valid keys leave only their render time (no body); malformed keys leave nothing.
		expect(await snapshotNames(store)).toEqual(['snapshot:path:/actor', 'snapshot:path:/ap/users/Alice'])
		expect(await store.rescueSnapshot(BUILD, 'path:/actor')).toBeNull()
	})

	it('does not remember a save the Store refused', async () => {
		const answers = [false, true]
		let writes = 0
		const refusingOnce = {
			saveSnapshot: () => {
				writes++
				return Promise.resolve(answers.shift() ?? true)
			},
		} as unknown as StoreStub
		const save = createSnapshotSaver(() => 0)
		const doc = { contentType: 'application/activity+json', body: 'b' }

		await save(refusingOnce, BUILD, 'path:/actor', doc, STATIC, 0)
		await save(refusingOnce, BUILD, 'path:/actor', doc, STATIC, 0)
		expect(writes).toBe(2)
	})

	it('re-saves an identical document at most once per interval', async () => {
		let now = 0
		let writes = 0
		const counting = {
			saveSnapshot: () => {
				writes++
				return Promise.resolve(true)
			},
		} as unknown as StoreStub
		const save = createSnapshotSaver(() => now)
		const doc = { contentType: 'application/activity+json', body: 'a' }

		await save(counting, BUILD, 'path:/actor', doc, STATIC, 0)
		now = SNAPSHOT_SAVE_INTERVAL_MS - 1
		await save(counting, BUILD, 'path:/actor', doc, STATIC, 0)
		expect(writes).toBe(1)
		now = SNAPSHOT_SAVE_INTERVAL_MS
		await save(counting, BUILD, 'path:/actor', doc, STATIC, 0)
		expect(writes).toBe(2)
	})

	it('saves a changed document at once, even inside the interval', async () => {
		const store = await migratedStore()
		let now = 0
		const save = createSnapshotSaver(() => now)
		const doc = (body: string) => ({ contentType: 'application/activity+json', body })

		await save(store, BUILD, 'path:/actor', doc('old-key'), STATIC, 0)
		now = 1
		await save(store, BUILD, 'path:/actor', doc('new-key'), STATIC, 0)
		expect(await store.rescueSnapshot(BUILD, 'path:/actor')).toEqual(doc('new-key'))
	})

	it('reads only snapshot keys back', async () => {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec("INSERT INTO kopje_state (name, value) VALUES ('snapshot:hold', '{}')")
		})
		expect(await store.rescueSnapshot('0.0.0-other', 'hold')).toBeNull()
		expect(await store.rescueSnapshot('0.0.0-other', 'last_local_id')).toBeNull()
		expect(await store.rescueSnapshot('0.0.0-other', `path:/${'x'.repeat(600)}`)).toBeNull()
	})
})

describe('rescue snapshot RPC', () => {
	it('reads a kept snapshot in a Store whose schema has diverged', async () => {
		const store = await migratedStore()
		await runInDurableObject(store, async (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO kopje_state (name, value) VALUES ('snapshot:path:/actor', ?)",
				JSON.stringify({ contentType: 'application/activity+json', body: '{}' })
			)
			const diverged = testKernel(state, [{ name: '0000_other', sql: 'SELECT 1' }])
			expect((await diverged.health(BUILD)).schema.status).toBe('diverged')
			expect(diverged.readSnapshot('path:/actor')).toEqual({ contentType: 'application/activity+json', body: '{}' })
			expect(diverged.readSnapshot('path:/nope')).toBeNull()
			expect(testKernel(state, MIGRATIONS).readSnapshot('path:/actor')).not.toBeNull()
		})
	})

	it('answers null on a Store that never ran', async () => {
		expect(await freshStore().rescueSnapshot('0.0.0-other', 'path:/actor')).toBeNull()
	})
})
