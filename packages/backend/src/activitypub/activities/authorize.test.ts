import { strict as assert } from 'node:assert/strict'

import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import { getActorById } from '@wildebeest/backend/activitypub/actors'
import { getApId, getObjectById } from '@wildebeest/backend/activitypub/objects'
import type { Database } from '@wildebeest/backend/database'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { createActivityId, createTestUser, makeDB } from '@wildebeest/backend/test/utils'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek_authorize'
const vapidKeys = {} as JWK

async function countObjects(db: Database): Promise<number> {
	const row = await db.prepare('SELECT count(*) as count FROM objects').first<{ count: number }>()
	assert.ok(row)
	return row.count
}

describe('Inbound activity authorization', () => {
	beforeEach(() => {
		globalThis.fetch = async (input) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://example.com/actor') {
					return new Response(
						JSON.stringify({ id: 'https://example.com/actor', type: 'Person', preferredUsername: 'actor' })
					)
				}
				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}
	})

	test('remote Update of a local actor is ignored', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		await activityHandler.handle(
			domain,
			{
				type: 'Update',
				id: getApId('https://evil.example/activities/1'),
				actor: actor.id,
				object: {
					id: actor.id,
					type: 'Person',
					name: 'forged',
					preferredUsername: 'sven',
					publicKey: { id: actor.id.toString() + '#main-key', publicKeyPem: 'forged-key' },
				},
			} as any,
			db,
			userKEK,
			adminEmail,
			vapidKeys
		)

		const stored = await getActorById(db, actor.id)
		assert.ok(stored)
		assert.equal(stored.name, 'sven')
		assert.equal(stored.publicKey?.publicKeyPem, actor.publicKey?.publicKeyPem)
	})

	test('remote Update of a local object is ignored', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'original content')
		const before = await getObjectById(domain, db, note.id)
		assert.ok(before)

		await activityHandler.handle(
			domain,
			{
				type: 'Update',
				id: getApId('https://evil.example/activities/2'),
				actor: actor.id,
				object: {
					id: note.id,
					type: 'Note',
					content: 'forged content',
					attributedTo: actor.id,
					to: [PUBLIC_GROUP],
					cc: [],
				},
			} as any,
			db,
			userKEK,
			adminEmail,
			vapidKeys
		)

		const stored = await getObjectById(domain, db, note.id)
		assert.ok(stored)
		assert.equal(stored.content, before.content)
		assert.doesNotMatch(stored.content ?? '', /forged/)
	})

	test('Delete of an object from another origin is ignored', async () => {
		const db = makeDB()
		const evilActorId = 'https://evil.example/actor'
		const objectId = 'https://example.com/note1'

		// Even when the stored attribution names the sender, an object hosted
		// elsewhere cannot be deleted by it.
		await db
			.prepare(
				'INSERT INTO objects (id, type, properties, original_actor_id, original_object_id, local, mastodon_id) VALUES (?, ?, ?, ?, ?, 0, ?)'
			)
			.bind(
				'https://cloudflare.com/ap/o/1',
				'Note',
				JSON.stringify({ id: objectId, type: 'Note', content: 'x', to: [PUBLIC_GROUP], cc: [] }),
				evilActorId,
				objectId,
				'mastodonid1'
			)
			.run()

		await activityHandler.handle(
			domain,
			{
				type: 'Delete',
				id: getApId('https://evil.example/activities/3'),
				actor: getApId(evilActorId),
				object: getApId(objectId),
			},
			db,
			userKEK,
			adminEmail,
			vapidKeys
		)

		assert.equal(await countObjects(db), 1)
	})

	test('Create whose object is attributed to another actor is ignored', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		await activityHandler.handle(
			domain,
			{
				type: 'Create',
				id: createActivityId('example.com'),
				actor: getApId('https://example.com/actor'),
				to: [actor.id],
				cc: [],
				object: {
					id: getApId('https://example.com/note-forged'),
					type: 'Note',
					content: 'forged',
					attributedTo: 'https://example.com/someone-else',
					to: [actor.id],
					cc: [],
				},
			} as any,
			db,
			userKEK,
			adminEmail,
			vapidKeys
		)

		assert.equal(await countObjects(db), 0)
	})

	test('Accept of a Follow targeting another actor is ignored', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		await activityHandler.handle(
			domain,
			{
				type: 'Accept',
				id: getApId('https://example.com/activities/4'),
				actor: getApId('https://example.com/actor'),
				object: {
					type: 'Follow',
					id: getApId('https://cloudflare.com/ap/a/1'),
					actor: actor.id,
					object: getApId('https://example.com/someone-else'),
				},
			} as any,
			db,
			userKEK,
			adminEmail,
			vapidKeys
		)

		const row = await db.prepare('SELECT count(*) as count FROM actor_following').first<{ count: number }>()
		assert.equal(row?.count, 0)
	})
})
