import { describe, expect, it } from 'vitest'

import { apiHarness, seedAccount, setSetting } from './api-helpers'

// A fixed P-256 key; only its public half appears in responses.
const VAPID_JWK = JSON.stringify({
	kty: 'EC',
	crv: 'P-256',
	x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
	y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
	d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
})
const VAPID_PUBLIC_KEY = 'BH_Nzidw9sRdQYPL7m_bS3tYBzM1e-nvE7rPbjx70VRFx_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0'

const CONFIGURATION = {
	accounts: { max_featured_tags: 10 },
	statuses: { max_characters: 500, max_media_attachments: 4, characters_reserved_per_url: 23 },
	media_attachments: {
		supported_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'],
		image_size_limit: 10485760,
		image_matrix_limit: 16777216,
		video_size_limit: 41943040,
		video_frame_rate_limit: 60,
		video_matrix_limit: 2304000,
	},
	polls: { max_options: 4, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746 },
}

async function configured() {
	const h = await apiHarness({ VAPID_JWK })
	await setSetting(h.store, 'title', 'Kopje Test')
	await setSetting(h.store, 'description', 'A test instance')
	await setSetting(h.store, 'contact_email', 'admin@kopje.test')
	await setSetting(h.store, 'rules', JSON.stringify(['Be kind', { id: 'r2', text: 'No spam' }, { text: '' }]))
	await seedAccount(h.store, { username: 'alice' })
	await seedAccount(h.store, { username: 'bob', domain: 'remote.test' })
	return h
}

const RULES = [
	{ id: '1', text: 'Be kind' },
	{ id: 'r2', text: 'No spam' },
]

// Contract: the declared version stays 4.0.2 and api_versions is absent (design §4). Changing these payloads
// changes what clients do; update this test only together with that decision.
describe('instance contract', () => {
	it('freezes /api/v1/instance', async () => {
		const h = await configured()
		const response = await h.request('/api/v1/instance')
		expect(response.status).toBe(200)
		const body = await response.json<Record<string, unknown>>()
		expect(body).toEqual({
			uri: 'kopje.test',
			title: 'Kopje Test',
			short_description: 'A test instance',
			description: 'A test instance',
			email: 'admin@kopje.test',
			version: '4.0.2',
			urls: { streaming_api: 'wss://kopje.test' },
			stats: { user_count: 1, status_count: 0, domain_count: 1 },
			thumbnail: null,
			languages: [],
			registrations: false,
			approval_required: false,
			invites_enabled: false,
			configuration: CONFIGURATION,
			contact_account: null,
			rules: RULES,
		})
		expect(body).not.toHaveProperty('api_versions')
	})

	it('freezes /api/v2/instance with the VAPID public key', async () => {
		const h = await configured()
		const response = await h.request('/api/v2/instance')
		expect(response.status).toBe(200)
		const body = await response.json<Record<string, unknown>>()
		expect(body).toEqual({
			domain: 'kopje.test',
			title: 'Kopje Test',
			version: '4.0.2',
			source_url: 'https://github.com/shuymn/wildebeest',
			description: 'A test instance',
			usage: { users: { active_month: 1 } },
			thumbnail: { url: 'https://kopje.test/assets/thumbnail.png' },
			languages: [],
			configuration: {
				urls: { streaming: 'wss://kopje.test' },
				vapid: { public_key: VAPID_PUBLIC_KEY },
				...CONFIGURATION,
				translation: { enabled: false },
			},
			registrations: { enabled: false, approval_required: false, message: null },
			contact: { email: 'admin@kopje.test', account: null },
			rules: RULES,
		})
		expect(body).not.toHaveProperty('api_versions')
	})

	it('falls back to the request host before setup and to no rules', async () => {
		const h = await apiHarness()
		await setSetting(h.store, 'rules', 'not json')
		const body = await (await h.request('/api/v2/instance')).json<Record<string, unknown>>()
		expect(body).toMatchObject({ domain: 'kopje.test', title: 'kopje.test', rules: [] })
		expect(body.configuration).toMatchObject({ vapid: { public_key: '' } })
	})

	it('refuses an invalid VAPID_JWK as misconfiguration', async () => {
		const h = await apiHarness({ VAPID_JWK: '{"kty":"RSA"}' })
		expect((await h.request('/api/v1/instance')).status).toBe(503)
	})

	it('has custom emojis (none yet) and a JSON 404 for unknown API routes', async () => {
		const h = await apiHarness()
		const emojis = await h.request('/api/v1/custom_emojis')
		expect(emojis.status).toBe(200)
		expect(await emojis.json()).toEqual([])
		const unknown = await h.request('/api/v1/accounts/1/statuses/nope')
		expect(unknown.status).toBe(404)
		expect(await unknown.json()).toEqual({ error: 'Record not found' })
	})
})
