import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, seedAccount, setSetting } from './api-helpers'
import { remoteAccounts, rowsRead } from './read-helpers'
import { getJson } from './status-helpers'
import { instancePeers, instanceRules, MAX_PEERS, PEER_SEARCH_LIMIT, searchPeers } from '../src/domain/instance'

// /api/v1/instance/*: public reads clients make at startup and on an about page (AUTH-2), with the peers bounded
// (RES-3, RES-7).

describe('instance details', () => {
	it('lists the rules as every instance endpoint shows them, with a hint and translations as Mastodon', async () => {
		const h = await apiHarness()
		await setSetting(
			h.store,
			'rules',
			JSON.stringify(['Be kind', { id: 'r2', text: 'No spam', hint: 'No ads either' }, { text: 'Hi', hint: 3 }])
		)
		const rules = await getJson(h, '/api/v1/instance/rules')
		expect(rules).toEqual({
			status: 200,
			body: [
				{ id: '1', text: 'Be kind', hint: '', translations: {} },
				{ id: 'r2', text: 'No spam', hint: 'No ads either', translations: {} },
				{ id: '3', text: 'Hi', hint: '', translations: {} },
			],
		})
		const v1 = await getJson<{ rules: unknown }>(h, '/api/v1/instance')
		const v2 = await getJson<{ rules: unknown }>(h, '/api/v2/instance')
		expect(v1.body.rules).toEqual(rules.body)
		expect(v2.body.rules).toEqual(rules.body)
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

	it('searches the peers by domain prefix, as Mastodon with the peers API on', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice' })
		for (const [username, domain] of [
			['bob', 'mastodon.example'],
			['carol', 'mastodon.example'],
			['dave', 'masto.example'],
			['erin', 'misskey.example'],
			['frank', 'xn--r8jz45g.example'],
			['grace', '123.example'],
		] as const) {
			await seedAccount(h.store, { username, domain })
		}
		const search = (q: string) => getJson(h, `/api/v1/peers/search?q=${encodeURIComponent(q)}`)
		expect(await search('masto')).toEqual({ status: 200, body: ['masto.example', 'mastodon.example'] })
		// Normalized as a host: trimmed, a trailing slash dropped, lowercased, IDNA-encoded.
		expect(await search('  MASTODON.example/ ')).toEqual({ status: 200, body: ['mastodon.example'] })
		expect(await search('例え')).toEqual({ status: 200, body: ['xn--r8jz45g.example'] })
		expect(await search('pleroma')).toEqual({ status: 200, body: [] })
		// As Addressable reads a host, not WHATWG: a trailing dot dropped, and numbers kept as written (not 0.0.0.123).
		expect(await search('mastodon.example.')).toEqual({ status: 200, body: ['mastodon.example'] })
		expect(await search('123')).toEqual({ status: 200, body: ['123.example'] })
		// Not a host: Mastodon rescues Addressable's InvalidURIError with [].
		expect(await search('masto/don')).toEqual({ status: 200, body: [] })
		// A blank q leaves Mastodon's @domains unset: null.
		for (const path of ['/api/v1/peers/search', '/api/v1/peers/search?q=%20']) {
			const response = await h.request(path)
			expect(response.status).toBe(200)
			expect(await response.text()).toBe('null')
		}
	})

	it('bounds a peer search to its limit, reading one row past it (RES-3, RES-7)', async () => {
		const h = await apiHarness()
		await remoteAccounts(h, 50, 4)
		const peers = (await getJson<string[]>(h, '/api/v1/instance/peers')).body
		const matching = peers.filter((domain) => domain.startsWith('d1'))
		expect(matching.length).toBeGreaterThan(PEER_SEARCH_LIMIT)
		const { body } = await getJson<string[]>(h, '/api/v1/peers/search?q=d1')
		expect(body).toEqual(matching.slice(0, PEER_SEARCH_LIMIT))
		expect(body).toHaveLength(PEER_SEARCH_LIMIT)
		expect(await rowsRead(h, searchPeers, { prefix: 'd1' })).toBeLessThanOrEqual(2 * (PEER_SEARCH_LIMIT + 1))
	})

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

	it('has no translation languages, as Mastodon without a translation service', async () => {
		const h = await apiHarness()
		expect(await getJson(h, '/api/v1/instance/translation_languages')).toEqual({ status: 200, body: {} })
	})

	it('answers 404 for what is not configured: privacy policy, terms of service, activity and domain blocks', async () => {
		const h = await apiHarness()
		for (const path of [
			'privacy_policy',
			'terms_of_service',
			'terms_of_service/2026-01-01',
			'activity',
			'domain_blocks',
		]) {
			expect(await getJson(h, `/api/v1/instance/${path}`)).toEqual({ status: 404, body: { error: 'Record not found' } })
		}
	})

	it('is public: no token is needed and a stale one is ignored', async () => {
		const h = await apiHarness()
		for (const path of [
			'/api/v1/instance/rules',
			'/api/v1/instance/peers',
			'/api/v1/instance/extended_description',
			'/api/v1/instance/languages',
			'/api/v1/instance/translation_languages',
			'/api/v1/peers/search?q=a',
		]) {
			expect((await h.request(path)).status).toBe(200)
			expect((await h.request(path, bearer('stale'))).status).toBe(200)
		}
	})
})
