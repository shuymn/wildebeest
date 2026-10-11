import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { harness } from './app-helpers'
import { fixtureKeyGen, LEGACY, seedLocalAccount, setDomain } from './federation-helpers'
import { BUILD, freshStore, migratedStore, testKernel } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { createSnapshotSaver, SNAPSHOT_SAVE_INTERVAL_MS } from '../src/federation/snapshot'
import type { StoreStub } from '../src/platform/store-client'
import { storeMaintenanceError } from '../src/platform/store-errors'
import { SNAPSHOT_MAX_BODY_BYTES } from '../src/platform/store-kernel'

const DOMAIN = 'social.example'
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
	})

	it('does not store a document over the size cap', async () => {
		const store = await migratedStore()
		await setDomain(store, DOMAIN)
		await seedLocalAccount(store, DOMAIN, { id: '111111111111111111', username: 'Alice', note: 'x'.repeat(70 * 1024) })
		const { request } = harness(store, { USER_KEK: LEGACY.kek }, BUILD, offline)
		expect((await request('/ap/users/Alice', AP)).status).toBe(200)
		expect(await snapshotNames(store)).not.toContain('snapshot:path:/ap/users/Alice')

		const big = { contentType: 'application/json', body: 'x'.repeat(SNAPSHOT_MAX_BODY_BYTES + 1) }
		expect(await store.saveSnapshot(BUILD, { key: 'path:/actor', ...big })).toBe(false)
		expect(await store.saveSnapshot(BUILD, { key: 'hold', contentType: 'x', body: '{}' })).toBe(false)
		expect(await store.saveSnapshot(BUILD, { key: `path:/${'x'.repeat(600)}`, contentType: 'x', body: '{}' })).toBe(
			false
		)
		expect(await snapshotNames(store)).toEqual([])
	})

	it('writes only when a document changed, and a changed one at most once per interval', async () => {
		let now = 0
		let writes = 0
		const counting = {
			saveSnapshot: () => {
				writes++
				return Promise.resolve(true)
			},
		} as unknown as StoreStub
		const save = createSnapshotSaver(() => now)
		const doc = (body: string) => ({ contentType: 'application/activity+json', body })

		await save(counting, BUILD, 'path:/actor', doc('a'))
		await save(counting, BUILD, 'path:/actor', doc('a'))
		now = SNAPSHOT_SAVE_INTERVAL_MS * 10
		await save(counting, BUILD, 'path:/actor', doc('a'))
		expect(writes).toBe(1)

		await save(counting, BUILD, 'path:/actor', doc('b'))
		expect(writes).toBe(2)
		now += 1
		await save(counting, BUILD, 'path:/actor', doc('c'))
		expect(writes).toBe(2)
		now += SNAPSHOT_SAVE_INTERVAL_MS
		await save(counting, BUILD, 'path:/actor', doc('c'))
		expect(writes).toBe(3)
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
