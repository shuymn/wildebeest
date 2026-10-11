import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { harness, migratedStore } from './app-helpers'
import { freshStore } from './helpers'
import type { StoreStub } from '../src/platform/store-client'

describe('app skeleton', () => {
	it('reports health with env, Store, schema, and database checks', async () => {
		const { request } = harness(await migratedStore())

		const response = await request('/health')
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			ok: true,
			checks: {
				env: { ok: true },
				store: { ok: true },
				schema: { ok: true, status: 'current', applied: '0000_initial', expected: '0000_initial' },
				database: { ok: true, size: expect.any(Number) },
			},
		})
	})

	it('fails health while the schema is pending', async () => {
		const response = await harness(freshStore()).request('/health')
		expect(response.status).toBe(503)
		expect(await response.json()).toMatchObject({ ok: false, checks: { schema: { ok: false, status: 'pending' } } })
	})

	it('fails health on invalid env and refuses other requests', async () => {
		const { request } = harness(await migratedStore(), { MAINTENANCE: 'sometimes' })

		const health = await request('/health')
		expect(health.status).toBe(503)
		expect(await health.json()).toMatchObject({
			checks: { env: { ok: false, issues: [expect.stringMatching(/^MAINTENANCE/)] } },
		})
		expect((await request('/api/v1/instance')).status).toBe(503)
	})

	it('returns JSON 404 for unknown API paths', async () => {
		const { request } = harness(await migratedStore())

		const api = await request('/api/v1/nope')
		expect(api.status).toBe(404)
		expect(await api.json()).toEqual({ error: 'Record not found' })
		expect((await request('/nope')).status).toBe(404)
	})

	it('answers unexpected errors in Mastodon format', async () => {
		const broken = { setupState: () => Promise.reject(new Error('boom')) } as unknown as StoreStub
		const response = await harness(broken).request('/.well-known/webfinger')
		expect(response.status).toBe(500)
		expect(await response.json()).toEqual({ error: 'Internal Server Error' })
	})

	it('answers 503 on federation routes until setup has fixed the domain', async () => {
		const store = await migratedStore()
		const { request } = harness(store)

		for (const path of ['/.well-known/webfinger', '/.well-known/nodeinfo', '/ap/users/alice', '/actor']) {
			const response = await request(path)
			expect(response.status, path).toBe(503)
			expect(await response.json()).toEqual({ error: 'This server has not been set up yet' })
		}
		expect((await request('/inbox', { method: 'POST', body: '{}' })).status).toBe(503)

		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
		})
		expect((await request('/.well-known/webfinger')).status).toBe(404)
	})
})
