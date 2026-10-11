import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import type { Actor } from '@wildebeest/backend/activitypub/actors'
import type { Database } from '@wildebeest/backend/database'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import { assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'
import { MessageType } from '@wildebeest/backend/types'
import { signRequest } from '@wildebeest/backend/utils/http-signing'
import { generateDigestHeader } from '@wildebeest/backend/utils/http-signing-cavage'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const userKEK = 'test_kek5'
const vapidKeys = {} as JWK
const domain = 'cloudflare.com'

function actorDocument(actor: Actor): string {
	return JSON.stringify({
		id: actor.id.toString(),
		type: actor.type,
		preferredUsername: actor.preferredUsername,
		publicKey: { ...actor.publicKey, id: `${actor.id.toString()}#main-key`, owner: actor.id.toString() },
	})
}

// Serve each actor's own document at its key id, the way Mastodon/Misskey do.
function mockKeyFetch(...actors: Actor[]): void {
	globalThis.fetch = async (input) => {
		if (input instanceof URL || typeof input === 'string') {
			const url = input.toString()
			for (const actor of actors) {
				if (url === `${actor.id.toString()}#main-key` || url === actor.id.toString()) {
					return new Response(actorDocument(actor))
				}
			}
			throw new Error(`unexpected request to "${url}"`)
		}
		throw new Error('unexpected request to ' + input.url)
	}
}

type QueueSpy = { messages: any[] } & { send(v: any): Promise<void>; sendBatch(): Promise<void> }

function makeQueueSpy(): QueueSpy {
	const messages: any[] = []
	return {
		messages,
		async send(v: any) {
			messages.push(v)
		},
		async sendBatch() {
			throw new Error('unimplemented')
		},
	}
}

async function signedInboxRequest(
	db: Database,
	signer: Actor,
	localHandle: string,
	activity: unknown,
	{ keyId, digest }: { keyId?: URL; digest?: string } = {}
): Promise<Request> {
	const body = JSON.stringify(activity)
	const req = new Request(`https://${domain}/ap/users/${localHandle}/inbox`, {
		method: 'POST',
		body,
		headers: { Digest: digest ?? (await generateDigestHeader(body)) },
	})
	const signingKey = await getSigningKey(userKEK, db, signer)
	await signRequest(req, signingKey, keyId ?? new URL(`${signer.id.toString()}#main-key`))
	return req
}

function makeEnv(db: Database, queue: unknown) {
	return { DATABASE: db, QUEUE: queue, userKEK, VAPID_JWK: JSON.stringify(vapidKeys) }
}

describe('Inbox', () => {
	test('send Note to non existent user', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')
		mockKeyFetch(connectedActor)

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(db, connectedActor, 'sven', { actor: connectedActor.id.toString() })
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 404)
	})

	test('send activity sends message in queue', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		mockKeyFetch(actor)

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(db, actor, 'sven', {
			type: 'some activity',
			actor: actor.id.toString(),
		})
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 200)

		assert.equal(queue.messages.length, 1)
		const msg = queue.messages[0]
		assert.equal(msg.type, MessageType.Inbox)
		assert.equal(msg.actorId, actor.id.toString())
		assert.equal(msg.activity.type, 'some activity')
		// The verified key owner travels with the message.
		assert.equal(msg.signerId, actor.id.toString())
	})

	test('activity signed by another actor is rejected', async () => {
		const db = makeDB()
		const recipient = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const signer = await createTestUser(domain, db, userKEK, 'a@cloudflare.com', { preferredUsername: 'a' })
		const impersonated = await createTestUser(domain, db, userKEK, 'b@cloudflare.com', { preferredUsername: 'b' })
		mockKeyFetch(recipient, signer, impersonated)

		const queue = makeQueueSpy()
		// Signed with A's key, but claims to come from B.
		const req = await signedInboxRequest(db, signer, 'sven', {
			type: 'Follow',
			actor: impersonated.id.toString(),
			object: recipient.id.toString(),
		})
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(queue.messages.length, 0)
	})

	test('key document whose owner does not list the key is rejected', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const keyId = new URL(`${actor.id.toString()}#other-key`)

		// The actor document advertises `#main-key`, not the key that signed.
		globalThis.fetch = async (input) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === keyId.toString()) {
					return new Response(actorDocument(actor))
				}
				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(db, actor, 'sven', { type: 'Follow', actor: actor.id.toString() }, { keyId })
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(queue.messages.length, 0)
	})

	test('key served by a host other than its claimed owner is rejected', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const keyId = new URL('https://evil.example/key')

		// An attacker-controlled key document claiming to belong to a local actor.
		globalThis.fetch = async (input) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === keyId.toString()) {
					return new Response(
						JSON.stringify({
							id: actor.id.toString(),
							type: 'Person',
							publicKey: { ...actor.publicKey, id: keyId.toString(), owner: actor.id.toString() },
						})
					)
				}
				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(db, actor, 'sven', { type: 'Follow', actor: actor.id.toString() }, { keyId })
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(queue.messages.length, 0)
	})

	test('actor document served from another port of the same host is rejected', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const keyId = new URL(`https://${domain}:8443/key`)

		// Same hostname as the actor, but another origin.
		globalThis.fetch = async (input) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === keyId.toString()) {
					return new Response(
						JSON.stringify({
							id: actor.id.toString(),
							type: 'Person',
							publicKey: { ...actor.publicKey, id: keyId.toString(), owner: actor.id.toString() },
						})
					)
				}
				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(db, actor, 'sven', { type: 'Follow', actor: actor.id.toString() }, { keyId })
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(queue.messages.length, 0)
	})

	test('standalone key document on another port of the owner host is rejected', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const keyId = new URL(`https://${domain}:8443/key`)

		globalThis.fetch = async (input) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === keyId.toString()) {
					return new Response(JSON.stringify({ ...actor.publicKey, id: keyId.toString(), owner: actor.id.toString() }))
				}
				if (input.toString() === actor.id.toString()) {
					return new Response(
						JSON.stringify({
							id: actor.id.toString(),
							type: 'Person',
							publicKey: { ...actor.publicKey, id: keyId.toString(), owner: actor.id.toString() },
						})
					)
				}
				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(db, actor, 'sven', { type: 'Follow', actor: actor.id.toString() }, { keyId })
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(queue.messages.length, 0)
	})

	test('key document reached through a cross-origin redirect is rejected', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const keyId = new URL(`${actor.id.toString()}#main-key`)

		// The key URL is on the actor origin, but the document comes from elsewhere.
		globalThis.fetch = (input) => {
			const url = input instanceof URL || typeof input === 'string' ? input.toString() : input.url
			if (url === keyId.toString()) {
				const res = new Response(actorDocument(actor))
				Object.defineProperty(res, 'url', { value: 'https://evil.example/actor' })
				return Promise.resolve(res)
			}
			return Promise.reject(new Error(`unexpected request to "${url}"`))
		}

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(db, actor, 'sven', { type: 'Follow', actor: actor.id.toString() }, { keyId })
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(queue.messages.length, 0)
	})

	test('key document reached through a same-origin redirect is accepted', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const keyId = new URL(`${actor.id.toString()}#main-key`)

		globalThis.fetch = (input) => {
			const url = input instanceof URL || typeof input === 'string' ? input.toString() : input.url
			if (url === keyId.toString()) {
				const res = new Response(actorDocument(actor))
				Object.defineProperty(res, 'url', { value: `https://${domain}/users/sven` })
				return Promise.resolve(res)
			}
			return Promise.reject(new Error(`unexpected request to "${url}"`))
		}

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(
			db,
			actor,
			'sven',
			{ type: 'some activity', actor: actor.id.toString() },
			{ keyId }
		)
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 200)
		assert.equal(queue.messages.length, 1)
	})

	test('standalone key document is resolved through its owner', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const keyId = new URL(`${actor.id.toString()}/main-key`)

		// GoToSocial style: the key lives at its own URL and names its owner.
		globalThis.fetch = async (input) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === keyId.toString()) {
					return new Response(JSON.stringify({ ...actor.publicKey, id: keyId.toString(), owner: actor.id.toString() }))
				}
				if (input.toString() === actor.id.toString()) {
					return new Response(
						JSON.stringify({
							id: actor.id.toString(),
							type: 'Person',
							publicKey: { ...actor.publicKey, id: keyId.toString(), owner: actor.id.toString() },
						})
					)
				}
				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(
			db,
			actor,
			'sven',
			{ type: 'some activity', actor: actor.id.toString() },
			{ keyId }
		)
		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 200)
		assert.equal(queue.messages.length, 1)
		assert.equal(queue.messages[0].signerId, actor.id.toString())
	})

	test('tampered signature is rejected before the queue', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		mockKeyFetch(actor)

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(db, actor, 'sven', { type: 'Follow', actor: actor.id.toString() })
		const signature = req.headers.get('signature')
		assert(signature)
		req.headers.set('signature', signature.replace(/signature="[^"]+"/, 'signature="aW52YWxpZA=="'))

		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(queue.messages.length, 0)
	})

	test('tampered body is rejected before the queue', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		mockKeyFetch(actor)

		const queue = makeQueueSpy()
		const signed = await signedInboxRequest(db, actor, 'sven', { type: 'Follow', actor: actor.id.toString() })
		const tampered = new Request(signed, { method: 'POST', body: JSON.stringify({ type: 'Delete' }) })

		const res = await app.fetch(tampered, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(await res.text(), 'invalid digest')
		assert.equal(queue.messages.length, 0)
	})

	test('invalid digest is rejected before the queue', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		mockKeyFetch(actor)

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(
			db,
			actor,
			'sven',
			{ type: 'Follow', actor: actor.id.toString() },
			{ digest: 'SHA-256=invalid' }
		)

		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(await res.text(), 'invalid digest')
		assert.equal(queue.messages.length, 0)
	})

	test('unsigned signed-header set is rejected', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		mockKeyFetch(actor)

		const queue = makeQueueSpy()
		const req = await signedInboxRequest(db, actor, 'sven', { type: 'Follow', actor: actor.id.toString() })
		const signature = req.headers.get('signature')
		assert(signature)
		// Drop `digest` from the set of signed headers.
		req.headers.set('signature', signature.replace('date host digest', 'date host'))

		const res = await app.fetch(req, makeEnv(db, queue))
		await assertStatus(res, 401)
		assert.equal(queue.messages.length, 0)
	})
})
