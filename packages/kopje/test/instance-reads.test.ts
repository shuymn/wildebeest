import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, seedAccount, setSetting } from './api-helpers'
import { remoteAccounts, rowsRead } from './read-helpers'
import { getJson } from './status-helpers'
import { instancePeers, instanceRules, MAX_PEERS } from '../src/domain/instance'

// /api/v1/instance/*: public reads clients make at startup and on an about page (AUTH-2), with the peers bounded
// (RES-3, RES-7).

describe('instance details', () => {
	it('lists the rules as /api/v2/instance shows them', async () => {
		const h = await apiHarness()
		await setSetting(h.store, 'rules', JSON.stringify(['Be kind', { id: 'r2', text: 'No spam' }]))
		const rules = await getJson(h, '/api/v1/instance/rules')
		expect(rules).toEqual({
			status: 200,
			body: [
				{ id: '1', text: 'Be kind' },
				{ id: 'r2', text: 'No spam' },
			],
		})
		const v2 = await getJson<{ rules: unknown }>(h, '/api/v2/instance')
		expect(rules.body).toEqual(v2.body.rules)
	})

	it('reads only the rules setting, whatever the accounts (RES-7)', async () => {
		const measure = async (accounts: number) => {
			const h = await apiHarness()
			await setSetting(h.store, 'rules', JSON.stringify(['Be kind']))
			await remoteAccounts(h, 50, accounts / 50)
			return rowsRead(h, instanceRules, undefined)
		}
		const small = await measure(1000)
		const large = await measure(8000)
		expect(small).toBeLessThanOrEqual(1)
		expect(large).toBe(small)
	}, 60_000)

	it('lists each known remote domain once, in order, and no local account', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice' })
		await seedAccount(h.store, { username: 'bob', domain: 'b.example' })
		await seedAccount(h.store, { username: 'carol', domain: 'a.example' })
		await seedAccount(h.store, { username: 'dave', domain: 'b.example' })
		expect(await getJson(h, '/api/v1/instance/peers')).toEqual({ status: 200, body: ['a.example', 'b.example'] })
	})

	it('bounds the peers and reads rows by domain, not by account (RES-3, RES-7)', async () => {
		const measure = async (perDomain: number) => {
			const h = await apiHarness()
			await remoteAccounts(h, 50, perDomain)
			return rowsRead(h, instancePeers, undefined)
		}
		const small = await measure(20)
		const large = await measure(80)
		expect(large).toBeLessThan(small * 1.5)

		const h = await apiHarness()
		await remoteAccounts(h, MAX_PEERS + 5, 1)
		const { body } = await getJson<string[]>(h, '/api/v1/instance/peers')
		expect(body).toHaveLength(MAX_PEERS)
		expect(new Set(body).size).toBe(MAX_PEERS)
	}, 60_000)

	it('has no extended description', async () => {
		const h = await apiHarness()
		expect(await getJson(h, '/api/v1/instance/extended_description')).toEqual({
			status: 200,
			body: { updated_at: null, content: '' },
		})
	})

	it('lists the ISO 639-1 languages with English names', async () => {
		const h = await apiHarness()
		const { status, body } = await getJson<{ code: string; name: string }[]>(h, '/api/v1/instance/languages')
		expect(status).toBe(200)
		expect(body).toHaveLength(183)
		expect(body).toContainEqual({ code: 'en', name: 'English' })
		expect(body).toContainEqual({ code: 'ja', name: 'Japanese' })
		expect(new Set(body.map((language) => language.code)).size).toBe(183)
		expect(body.every((language) => /^[a-z]{2}$/.test(language.code) && language.name !== '')).toBe(true)
	})

	it('answers 404 for what is not configured: privacy policy, terms of service, activity and domain blocks', async () => {
		const h = await apiHarness()
		for (const path of ['privacy_policy', 'terms_of_service', 'activity', 'domain_blocks']) {
			expect(await getJson(h, `/api/v1/instance/${path}`)).toEqual({ status: 404, body: { error: 'Record not found' } })
		}
	})

	it('is public: no token is needed and a stale one is ignored', async () => {
		const h = await apiHarness()
		for (const path of ['rules', 'peers', 'extended_description', 'languages']) {
			expect((await h.request(`/api/v1/instance/${path}`)).status).toBe(200)
			expect((await h.request(`/api/v1/instance/${path}`, bearer('stale'))).status).toBe(200)
		}
	})
})
