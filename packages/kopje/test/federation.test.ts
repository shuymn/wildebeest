import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { harness } from './app-helpers'
import {
	fixtureKeyGen,
	LEGACY,
	LEGACY_EMPTY_KEK,
	seedFollow,
	seedLocalAccount,
	seedRemoteAccount,
	setDomain,
} from './federation-helpers'
import { migratedStore } from './helpers'
import { version as packageVersion } from '../package.json'
import type { StoreStub } from '../src/platform/store-client'
import { base64ToBytes } from '../src/security/key-wrap'
import { checkKey } from '../src/security/keyring'

// Identity goldens: every expected value is a literal. The domain is fixed at /setup ('social.example') and differs
// from the request host ('kopje.test'), so ids must come from the Store, never from the request.
const DOMAIN = 'social.example'
const KEK = LEGACY.kek
const ALICE = '111111111111111111'
const BOB = '222222222222222222'
const AP = { headers: { accept: 'application/activity+json' } }

const pemBody = (pem: string) => pem.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s/g, '')

async function instance(options: { kek?: string } = {}) {
	const store = await migratedStore()
	await setDomain(store, DOMAIN)
	await seedLocalAccount(store, DOMAIN, { id: ALICE, username: 'Alice', displayName: 'Alice A', note: '<p>hi</p>' })
	await seedRemoteAccount(store, BOB, 'https://remote.example/users/bob', 'remote.example')
	let generated = 0
	const keygen = () => {
		generated++
		return fixtureKeyGen()
	}
	const loader = { fetch: () => Promise.reject(new Error('offline')), checkHost: () => Promise.resolve() }
	const h = harness(store, { USER_KEK: options.kek ?? KEK }, undefined, { keygen, loader })
	const json = async (path: string, init: RequestInit = AP) => {
		const response = await h.request(path, init)
		return {
			status: response.status,
			type: response.headers.get('content-type'),
			body: (await response.json()) as never,
		}
	}
	return { ...h, store, json, generated: () => generated }
}

describe('actor document', () => {
	it('publishes a local actor with ids under the fixed domain', async () => {
		const { json } = await instance()
		const { status, type, body } = await json('/ap/users/Alice')

		expect(status).toBe(200)
		expect(type).toBe('application/activity+json')
		expect(body).toMatchObject({
			id: 'https://social.example/ap/users/Alice',
			type: 'Person',
			preferredUsername: 'Alice',
			name: 'Alice A',
			summary: '<p>hi</p>',
			url: 'https://social.example/@Alice',
			inbox: 'https://social.example/ap/users/Alice/inbox',
			outbox: 'https://social.example/ap/users/Alice/outbox',
			followers: 'https://social.example/ap/users/Alice/followers',
			following: 'https://social.example/ap/users/Alice/following',
			endpoints: { sharedInbox: 'https://social.example/inbox' },
			manuallyApprovesFollowers: false,
			discoverable: true,
			published: '2026-10-01T00:00:00Z',
			publicKey: {
				id: 'https://social.example/ap/users/Alice#main-key',
				owner: 'https://social.example/ap/users/Alice',
			},
		})
		// The same key as local_accounts.pubkey (Fedify re-wraps the base64 at 64 columns).
		const { publicKeyPem } = (body as { publicKey: { publicKeyPem: string } }).publicKey
		expect(pemBody(publicKeyPem)).toBe(pemBody(LEGACY.pubkey))
	})

	it('answers 404 for an unknown actor and for a differently cased path', async () => {
		const { request } = await instance()
		expect((await request('/ap/users/nobody', AP)).status).toBe(404)
		expect((await request('/ap/users/alice', AP)).status).toBe(404)
	})

	it('answers 406 to a request that does not accept ActivityPub', async () => {
		const { request } = await instance()
		expect((await request('/ap/users/Alice', { headers: { accept: 'text/html' } })).status).toBe(406)
	})
})

describe('instance actor', () => {
	it('publishes an Application at /actor with its own key, wrapped with the KEK in instance_settings', async () => {
		const { json, store, generated } = await instance()
		const { status, body } = await json('/actor')

		expect(status).toBe(200)
		expect(body).toMatchObject({
			id: 'https://social.example/actor',
			type: 'Application',
			preferredUsername: 'social.example',
			inbox: 'https://social.example/actor/inbox',
			outbox: 'https://social.example/actor/outbox',
			endpoints: { sharedInbox: 'https://social.example/inbox' },
			publicKey: { id: 'https://social.example/actor#main-key', owner: 'https://social.example/actor' },
		})
		const { publicKeyPem } = (body as { publicKey: { publicKeyPem: string } }).publicKey
		expect(pemBody(publicKeyPem)).toBe(pemBody(LEGACY_EMPTY_KEK.pubkey))

		const stored = await storedInstanceKey(store)
		expect(stored.pubkey).toBe(LEGACY_EMPTY_KEK.pubkey)
		expect(await checkKey(KEK, stored)).toBe('ok')
		expect(await checkKey('', stored)).toBe('unwrap-failed')

		await json('/actor')
		expect(generated()).toBe(1)
	})

	it('is not served under /ap/users', async () => {
		const { request } = await instance()
		expect((await request('/ap/users/kopje%3Ainstance', AP)).status).toBe(404)
	})
})

async function storedInstanceKey(store: StoreStub) {
	const value = await runInDurableObject(store, (_instance, state) => {
		const row = state.storage.sql
			.exec<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'instance_actor_key'")
			.one()
		return row.value
	})
	const key = JSON.parse(value) as { privkey: string; salt: string; pubkey: string }
	return { privkey: base64ToBytes(key.privkey), salt: base64ToBytes(key.salt), pubkey: key.pubkey }
}

describe('WebFinger', () => {
	it('resolves acct:user@domain to the actor, with the profile link', async () => {
		const { json } = await instance()
		const { status, type, body } = await json('/.well-known/webfinger?resource=acct:Alice@social.example')

		expect(status).toBe(200)
		expect(type).toBe('application/jrd+json')
		expect(body).toEqual({
			subject: 'acct:Alice@social.example',
			aliases: ['https://social.example/ap/users/Alice'],
			links: [
				{ rel: 'self', type: 'application/activity+json', href: 'https://social.example/ap/users/Alice' },
				{ rel: 'http://webfinger.net/rel/profile-page', href: 'https://social.example/@Alice' },
			],
		})
	})

	it('matches the username case-insensitively and accepts the actor URI', async () => {
		const { json } = await instance()
		const lower = await json('/.well-known/webfinger?resource=acct:alice@social.example')
		expect(lower.body).toMatchObject({
			links: expect.arrayContaining([
				{ rel: 'self', type: 'application/activity+json', href: 'https://social.example/ap/users/Alice' },
			]),
		})
		const byUri = await json('/.well-known/webfinger?resource=https://social.example/ap/users/Alice')
		expect(byUri.body).toMatchObject({
			subject: 'https://social.example/ap/users/Alice',
			links: expect.arrayContaining([
				{ rel: 'self', type: 'application/activity+json', href: 'https://social.example/ap/users/Alice' },
			]),
		})
	})

	it('answers 404 for another host, an unknown user, and the request host', async () => {
		const { request } = await instance()
		for (const resource of ['acct:Alice@other.example', 'acct:nobody@social.example', 'acct:Alice@kopje.test']) {
			expect((await request(`/.well-known/webfinger?resource=${resource}`)).status, resource).toBe(404)
		}
	})
})

describe('NodeInfo', () => {
	async function withPosts() {
		const i = await instance()
		await runInDurableObject(i.store, (_instance, state) => {
			state.storage.sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES
				('333333333333333333', 'https://social.example/ap/o/1', '${ALICE}', 'public', '2026-10-05T00:00:00.000Z')`
			)
		})
		return i
	}

	it('links both versions from /.well-known/nodeinfo', async () => {
		const { json } = await instance()
		expect((await json('/.well-known/nodeinfo')).body).toEqual({
			links: [
				{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: 'https://social.example/nodeinfo/2.0' },
				{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: 'https://social.example/nodeinfo/2.1' },
			],
		})
	})

	it('serves 2.1 with software kopje and the package version', async () => {
		const { json } = await withPosts()
		const { type, body } = await json('/nodeinfo/2.1')
		expect(type).toBe('application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"')
		expect(body).toEqual({
			$schema: 'http://nodeinfo.diaspora.software/ns/schema/2.1#',
			version: '2.1',
			software: {
				name: 'kopje',
				version: packageVersion,
				repository: 'https://github.com/shuymn/wildebeest',
				homepage: 'https://github.com/shuymn/wildebeest',
			},
			protocols: ['activitypub'],
			services: { inbound: [], outbound: [] },
			openRegistrations: false,
			usage: { users: { total: 1, activeMonth: 1, activeHalfyear: 1 }, localPosts: 1, localComments: 0 },
			metadata: {},
		})
	})

	it('serves 2.0 without the 2.1-only software fields', async () => {
		const { json } = await withPosts()
		const { type, body } = await json('/nodeinfo/2.0')
		expect(type).toBe('application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.0#"')
		expect(body).toEqual({
			$schema: 'http://nodeinfo.diaspora.software/ns/schema/2.0#',
			version: '2.0',
			software: { name: 'kopje', version: packageVersion },
			protocols: ['activitypub'],
			services: { inbound: [], outbound: [] },
			openRegistrations: false,
			usage: { users: { total: 1, activeMonth: 1, activeHalfyear: 1 }, localPosts: 1, localComments: 0 },
			metadata: {},
		})
	})
})

describe('followers and following collections', () => {
	it('answers the count with a first page link, and pages of actor ids', async () => {
		const { json, store } = await instance()
		await seedFollow(store, BOB, ALICE)

		expect((await json('/ap/users/Alice/followers')).body).toMatchObject({
			id: 'https://social.example/ap/users/Alice/followers',
			type: 'OrderedCollection',
			totalItems: 1,
			first: 'https://social.example/ap/users/Alice/followers?cursor=1',
		})
		expect((await json('/ap/users/Alice/followers?cursor=1')).body).toMatchObject({
			id: 'https://social.example/ap/users/Alice/followers?cursor=1',
			type: 'OrderedCollectionPage',
			partOf: 'https://social.example/ap/users/Alice/followers',
			orderedItems: ['https://remote.example/users/bob'],
		})
		expect((await json('/ap/users/Alice/following')).body).toMatchObject({
			id: 'https://social.example/ap/users/Alice/following',
			type: 'OrderedCollection',
			totalItems: 0,
		})
	})

	it('counts accepted follows only, newest first, 40 per page', async () => {
		const { json, store } = await instance()
		await seedFollow(store, ALICE, BOB, 'pending')
		for (let i = 1; i <= 41; i++) {
			const id = `4000000000000000${String(i).padStart(2, '0')}`
			await seedRemoteAccount(store, id, `https://remote.example/users/u${i}`, 'remote.example')
			await seedFollow(store, ALICE, id)
		}

		expect((await json('/ap/users/Alice/following')).body).toMatchObject({ totalItems: 41 })
		const first = (await json('/ap/users/Alice/following?cursor=1')).body as { orderedItems: string[]; next: string }
		expect(first.orderedItems).toHaveLength(40)
		expect(first.orderedItems[0]).toBe('https://remote.example/users/u41')
		expect(first.next).toBe('https://social.example/ap/users/Alice/following?cursor=2')
		expect((await json('/ap/users/Alice/following?cursor=2')).body).toMatchObject({
			orderedItems: ['https://remote.example/users/u1'],
		})
	})

	it('answers 404 for an unknown actor, another spelling of a username, or a malformed page', async () => {
		const { request } = await instance()
		for (const path of [
			'/ap/users/nobody/followers',
			'/ap/users/alice/followers',
			'/ap/users/alice/following?cursor=1',
			'/ap/users/Alice/followers?cursor=0',
			'/ap/users/Alice/followers?cursor=x',
		]) {
			expect((await request(path, AP)).status, path).toBe(404)
		}
	})
})
