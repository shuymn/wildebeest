// Identity goldens: the public identifiers of a local actor are a federation
// contract. Every expected value below is a literal derived from the domain and
// the handle by the ActivityPub/WebFinger conventions this server published,
// never computed by calling the implementation.

import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { createCreateActivity } from '@wildebeest/backend/activitypub/activities/create'
import { deliverToActor } from '@wildebeest/backend/activitypub/deliver'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const domain = 'cloudflare.com'
const userKEK = 'test_kek_identity'

const ACTOR_ID = 'https://cloudflare.com/ap/users/golden'

describe('Local actor identity goldens', () => {
	test('actor document', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'golden@cloudflare.com', { preferredUsername: 'golden' })

		const res = await app.fetch(new Request('https://cloudflare.com/ap/users/golden'), { DATABASE: db })
		await assertStatus(res, 200)
		const doc = await res.json<any>()

		assert.equal(doc.id, 'https://cloudflare.com/ap/users/golden')
		assert.equal(doc.type, 'Person')
		assert.equal(doc.preferredUsername, 'golden')
		assert.equal(doc.url, 'https://cloudflare.com/@golden')
		assert.equal(doc.inbox, 'https://cloudflare.com/ap/users/golden/inbox')
		assert.equal(doc.outbox, 'https://cloudflare.com/ap/users/golden/outbox')
		assert.equal(doc.followers, 'https://cloudflare.com/ap/users/golden/followers')
		assert.equal(doc.following, 'https://cloudflare.com/ap/users/golden/following')
		assert.equal(doc.publicKey.id, 'https://cloudflare.com/ap/users/golden#main-key')
		assert.equal(doc.publicKey.owner, 'https://cloudflare.com/ap/users/golden')
		const { pubkey } = (await db
			.prepare('SELECT pubkey FROM users WHERE email=?1')
			.bind('golden@cloudflare.com')
			.first<{ pubkey: string }>())!
		assert.equal(doc.publicKey.publicKeyPem, pubkey)
		assert.match(doc.publicKey.publicKeyPem, /^-----BEGIN PUBLIC KEY-----\n/)
		assert.equal(actor.id.toString(), ACTOR_ID)
	})

	test('WebFinger', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'golden@cloudflare.com', { preferredUsername: 'golden' })

		const res = await app.fetch(
			new Request('https://cloudflare.com/.well-known/webfinger?resource=acct:golden@cloudflare.com'),
			{ DATABASE: db }
		)
		await assertStatus(res, 200)
		assert.deepEqual(await res.json(), {
			subject: 'acct:golden@cloudflare.com',
			aliases: ['https://cloudflare.com/ap/users/golden'],
			links: [{ rel: 'self', type: 'application/activity+json', href: 'https://cloudflare.com/ap/users/golden' }],
		})
	})

	test('outbound activity', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'golden@cloudflare.com', { preferredUsername: 'golden' })
		const note = await createPublicStatus(domain, db, actor, 'golden status')
		const activity = await createCreateActivity(db, domain, actor, note)

		const serialized = JSON.parse(JSON.stringify(activity))
		assert.equal(serialized.actor, 'https://cloudflare.com/ap/users/golden')
		assert.match(serialized.id, /^https:\/\/cloudflare\.com\/ap\/a\/[0-9a-f-]{36}$/)
		assert.equal(serialized.object.attributedTo, 'https://cloudflare.com/ap/users/golden')
		assert.match(serialized.object.id, /^https:\/\/cloudflare\.com\/ap\/o\/[0-9a-f-]{36}$/)

		let signature: string | null = null
		let sent: any = null
		globalThis.fetch = async (input) => {
			if (input instanceof Request && input.url === 'https://example.com/inbox') {
				signature = input.headers.get('signature')
				sent = await input.json()
				return new Response('')
			}
			throw new Error('unexpected request')
		}
		const signingKey = await getSigningKey(userKEK, db, actor)
		const to = { ...actor, id: new URL('https://example.com/users/a'), inbox: new URL('https://example.com/inbox') }
		await deliverToActor(signingKey, actor, to, activity, domain)

		assert.ok(signature)
		assert.match(signature, /keyId="https:\/\/cloudflare\.com\/ap\/users\/golden#main-key"/)
		assert.equal(sent.actor, 'https://cloudflare.com/ap/users/golden')
	})
})
