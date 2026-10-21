import { describe, expect, it } from 'vitest'

import { type ApiHarness, apiHarness, bearer, seedAccount, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { DAY_MS } from './read-helpers'
import { community } from './status-helpers'

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

// Contract: the declared version is 4.5.0 and api_versions.mastodon is 7 (the reasoning is above MASTODON_VERSION in
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
			version: '4.5.0',
			urls: { streaming_api: 'wss://kopje.test' },
			stats: { user_count: 1, status_count: 0, domain_count: 1 },
			thumbnail: 'https://kopje.test/assets/thumbnail.png',
			languages: ['en'],
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
			version: '4.5.0',
			source_url: 'https://github.com/shuymn/wildebeest',
			description: 'A test instance',
			usage: { users: { active_month: 0 } },
			thumbnail: { url: 'https://kopje.test/assets/thumbnail.png' },
			icon: [],
			languages: ['en'],
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
				timelines_access: {
					live_feeds: { local: 'public', remote: 'public' },
					hashtag_feeds: { local: 'public', remote: 'public' },
					trending_link_feeds: { local: 'public', remote: 'public' },
				},
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
			api_versions: { mastodon: 7 },
			contact: { email: 'admin@kopje.test', account: null },
			rules: RULES,
		})
	})

	it('names the privacy policy and terms of service pages on v2 only while they are available', async () => {
		const h = await configured()
		const urls = async () =>
			(await (await h.request('/api/v2/instance')).json<{ configuration: { urls: Record<string, unknown> } }>())
				.configuration.urls
		await setSetting(h.store, 'privacy_policy', '<p>Policy</p>')
		await setSetting(h.store, 'terms_of_service', '<p>Terms</p>')
		expect(await urls()).toMatchObject({ privacy_policy: 'https://kopje.test/privacy-policy', terms_of_service: null })
		await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
		expect(await urls()).toMatchObject({
			privacy_policy: 'https://kopje.test/privacy-policy',
			terms_of_service: 'https://kopje.test/terms-of-service',
		})
		await sql(h.store, "DELETE FROM instance_settings WHERE name IN ('privacy_policy', 'terms_of_service')")
		expect(await urls()).toMatchObject({ privacy_policy: null, terms_of_service: null })
	})

	it('declares the same version on both endpoints, and api_versions on v2 only as Mastodon does', async () => {
		const h = await configured()
		const v1 = await (await h.request('/api/v1/instance')).json<Record<string, unknown>>()
		const v2 = await (await h.request('/api/v2/instance')).json<Record<string, unknown>>()
		expect(v1.version).toBe('4.5.0')
		expect(v2.version).toBe(v1.version)
		expect(v2.api_versions).toEqual({ mastodon: 7 })
		expect(v1).not.toHaveProperty('api_versions')
	})

	it('falls back to the request host before setup and to no rules', async () => {
		const h = await apiHarness()
		// rules that are no JSON array cannot be stored (0049_instance_bounds); none of these elements is a rule.
		await setSetting(h.store, 'rules', JSON.stringify([1, null, { text: '' }, { text: 3 }]))
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

describe('instance contact account (contact_username)', () => {
	const v1 = async (h: ApiHarness) => (await h.request('/api/v1/instance')).json<{ contact_account: unknown }>()
	const v2 = async (h: ApiHarness) => (await h.request('/api/v2/instance')).json<{ contact: unknown }>()
	const shown = async (h: ApiHarness, id: string) => (await h.request(`/api/v1/accounts/${id}`)).json()
	const idOf = async (h: ApiHarness, username: string) =>
		(await sql<{ id: string }>(h.store, 'SELECT id FROM accounts WHERE username = ?', username))[0]!.id

	it('presents the account it names on v1 and v2, and null without one', async () => {
		const h = await configured()
		expect((await v1(h)).contact_account).toBeNull()
		await setSetting(h.store, 'contact_username', 'alice')
		const alice = await shown(h, await idOf(h, 'alice'))
		expect(alice).toMatchObject({ username: 'alice', acct: 'alice' })
		expect((await v1(h)).contact_account).toEqual(alice)
		expect((await v2(h)).contact).toEqual({ email: 'admin@kopje.test', account: alice })
		await setSetting(h.store, 'contact_username', 'bob@remote.test')
		const bob = await shown(h, await idOf(h, 'bob'))
		expect(bob).toMatchObject({ acct: 'bob@remote.test' })
		expect((await v1(h)).contact_account).toEqual(bob)
		expect((await v2(h)).contact).toEqual({ email: 'admin@kopje.test', account: bob })
	})

	it('shows a suspended contact redacted (VIS-30), and a deleted one as null', async () => {
		const h = await configured()
		const aliceId = await idOf(h, 'alice')
		await setSetting(h.store, 'contact_username', 'alice')
		await h.store.suspendAccount(BUILD, { accountId: aliceId, now: NOW })
		expect((await v1(h)).contact_account).toMatchObject({ id: aliceId, suspended: true, display_name: '' })
		expect((await v1(h)).contact_account).toEqual(await shown(h, aliceId))
		await setSetting(h.store, 'contact_username', 'bob@remote.test')
		await sql(h.store, 'DELETE FROM accounts WHERE id = ?', await idOf(h, 'bob'))
		expect((await v1(h)).contact_account).toBeNull()
		expect((await v2(h)).contact).toEqual({ email: 'admin@kopje.test', account: null })
	})
})

describe('instance usage.users.active_month', () => {
	const activeMonth = async (h: ApiHarness) =>
		(await (await h.request('/api/v2/instance')).json<{ usage: { users: { active_month: number } } }>()).usage.users
			.active_month
	const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

	it('counts the available local accounts active today or on the 27 UTC days before', async () => {
		const h = await community(['alice', 'bob'])
		expect(await activeMonth(h)).toBe(0)
		// The harness waits for the work the response leaves running (waitUntil), so the day is recorded on return.
		expect((await h.request('/api/v1/preferences', bearer(h.users.alice.token))).status).toBe(200)
		expect(await activeMonth(h)).toBe(1)
		const setBob = (ms: number) =>
			sql(h.store, 'UPDATE local_accounts SET active_on = ? WHERE account_id = ?', day(ms), h.users.bob.id)
		await setBob(NOW - 27 * DAY_MS)
		expect(await activeMonth(h)).toBe(2)
		await setBob(NOW - 28 * DAY_MS)
		expect(await activeMonth(h)).toBe(1)
		await h.store.suspendAccount(BUILD, { accountId: h.users.alice.id, now: NOW })
		expect(await activeMonth(h)).toBe(0)
	})
})
