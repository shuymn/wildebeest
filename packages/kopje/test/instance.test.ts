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
		image_size_limit: 16777216,
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
	{ id: '1', text: 'Be kind', hint: '', translations: {} },
	{ id: 'r2', text: 'No spam', hint: '', translations: {} },
]

// Contract: the declared version is 4.4.0 and api_versions.mastodon is 6 (the reasoning is above MASTODON_VERSION in
// src/mastodon/instance.ts). Changing these payloads changes what clients do; update this test only together with that
// decision.
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
			version: '4.4.0',
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
			version: '4.4.0',
			source_url: 'https://github.com/shuymn/wildebeest',
			description: 'A test instance',
			usage: { users: { active_month: 1 } },
			thumbnail: { url: 'https://kopje.test/assets/thumbnail.png' },
			icon: [],
			languages: [],
			configuration: {
				urls: {
					streaming: 'wss://kopje.test',
					status: null,
					about: 'https://kopje.test/about',
					privacy_policy: null,
					terms_of_service: null,
				},
				vapid: { public_key: VAPID_PUBLIC_KEY },
				...CONFIGURATION,
				accounts: { max_featured_tags: 10, max_pinned_statuses: 5 },
				media_attachments: { ...CONFIGURATION.media_attachments, description_limit: 1500 },
				translation: { enabled: false },
				limited_federation: false,
			},
			registrations: {
				enabled: false,
				approval_required: false,
				reason_required: false,
				message: null,
				min_age: null,
				url: null,
			},
			api_versions: { mastodon: 6 },
			contact: { email: 'admin@kopje.test', account: null },
			rules: RULES,
		})
	})

	it('declares the same version on both endpoints, and api_versions on v2 only as Mastodon does', async () => {
		const h = await configured()
		const v1 = await (await h.request('/api/v1/instance')).json<Record<string, unknown>>()
		const v2 = await (await h.request('/api/v2/instance')).json<Record<string, unknown>>()
		expect(v1.version).toBe('4.4.0')
		expect(v2.version).toBe(v1.version)
		expect(v2.api_versions).toEqual({ mastodon: 6 })
		expect(v1).not.toHaveProperty('api_versions')
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
