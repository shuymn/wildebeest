import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { harness } from './app-helpers'
import { BUILD, completeSetup, freshStore, migratedStore } from './helpers'
import { healthReport } from '../src/app/health'
import { readConfig } from '../src/platform/config'
import type { StoreStub } from '../src/platform/store-client'

describe('app skeleton', () => {
	it('answers public health with a bare ok', async () => {
		const response = await harness(await migratedStore()).request('/health')
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('ok')
	})

	it('answers public health with a bare fail while the schema is pending', async () => {
		const response = await harness(freshStore()).request('/health')
		expect(response.status).toBe(503)
		expect(await response.text()).toBe('fail')
	})

	it('discloses no env issues on public health and refuses other requests on invalid env', async () => {
		const { request } = harness(await migratedStore(), { MAINTENANCE: 'sometimes' })

		const health = await request('/health')
		expect(health.status).toBe(503)
		expect(await health.text()).toBe('fail')
		expect((await request('/api/v1/instance')).status).toBe(503)
	})

	it('keeps the detailed report for the admin side', async () => {
		const store = await migratedStore()
		const report = await healthReport(BUILD, readConfig({ ...env, MAINTENANCE: 'sometimes' }), () => store)
		expect(report).toMatchObject({
			ok: false,
			checks: { env: { ok: false, issues: [expect.stringMatching(/^MAINTENANCE/)] } },
		})
		expect(await healthReport(BUILD, readConfig(env), () => store)).toMatchObject({
			ok: true,
			build: BUILD,
			checks: {
				env: { ok: true },
				store: { ok: true },
				schema: { ok: true, status: 'current', applied: '0001_blocks_and_mutes', expected: '0001_blocks_and_mutes' },
				database: { ok: true, size: expect.any(Number) },
			},
		})
	})

	it('returns JSON 404 for unknown API paths', async () => {
		const { request } = harness(await migratedStore())

		const api = await request('/api/v1/nope')
		expect(api.status).toBe(404)
		expect(await api.json()).toEqual({ error: 'Record not found' })
		expect((await request('/nope')).status).toBe(404)
	})

	it('answers unexpected errors in Mastodon format', async () => {
		const broken = {
			setupState: () => Promise.reject(new Error('boom')),
			markPublished: () => Promise.resolve({ published: { at: 0, via: 'command' } }),
		} as unknown as StoreStub
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
		const inbox = { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: '{}' }
		expect((await request('/inbox', inbox)).status).toBe(503)

		await completeSetup(store)
		expect((await request('/.well-known/webfinger')).status).toBe(400)
	})
})
