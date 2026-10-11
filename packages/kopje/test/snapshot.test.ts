import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { harness } from './app-helpers'
import { fixtureKeyGen, LEGACY, seedLocalAccount, setDomain } from './federation-helpers'
import { BUILD, freshStore, migratedStore, testKernel } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import type { StoreStub } from '../src/platform/store-client'
import { storeMaintenanceError } from '../src/platform/store-errors'

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
