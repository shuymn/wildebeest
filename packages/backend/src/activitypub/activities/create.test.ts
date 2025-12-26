import { strict as assert } from 'node:assert/strict'

import { CreateActivity, PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import { getApId, getObjectById, originalObjectIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { Note } from '@wildebeest/backend/activitypub/objects/note'
import { makeDB, createTestUser, createActivityId } from '@wildebeest/backend/test/utils'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek15'
const vapidKeys = {} as JWK

describe('Create', () => {
	test('Object must be an object', async () => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://example.com/actor') {
					return new Response(
						JSON.stringify({
							id: 'https://example.com/actor',
							type: 'Person',
							preferredUsername: 'actor',
						})
					)
				}
				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const activity: any = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			type: 'Create',
			actor: 'https://example.com/actor',
			object: 'a',
		}

		await assert.rejects(activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys), {
			message: '`activity.object` must be of type object',
		})
	})

	test('Note to inbox stores in DB', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const activity: CreateActivity<Note> = {
			type: 'Create',
			id: createActivityId(domain),
			actor: actor.id,
			to: [actor.id],
			cc: [],
			object: {
				id: getApId('https://example.com/note1'),
				type: 'Note',
				content: 'test note',
				attributedTo: actor.id,
				attachment: [],
				to: [actor.id],
				cc: [],
				sensitive: false,
			},
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const entry = await db
			.prepare('SELECT objects.* FROM inbox_objects INNER JOIN objects ON objects.id=inbox_objects.object_id')
			.first<{ properties: string }>()
		assert.ok(entry)
		const properties = JSON.parse(entry.properties)
		assert.equal(properties.content, 'test note')
	})

	test("Note adds in remote actor's outbox", async () => {
		const remoteActorId = 'https://example.com/actor'

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === remoteActorId) {
					return new Response(
						JSON.stringify({
							id: remoteActorId,
							type: 'Person',
							preferredUsername: 'actor',
						})
					)
				}
				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const activity: CreateActivity<Note> = {
			type: 'Create',
			id: createActivityId(domain),
			actor: getApId(remoteActorId),
			to: [PUBLIC_GROUP],
			cc: [],
			object: {
				id: getApId('https://example.com/note1'),
				type: 'Note',
				content: 'test note',
				attributedTo: getApId(remoteActorId),
				attachment: [],
				to: [PUBLIC_GROUP],
				cc: [],
				sensitive: false,
			},
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const entry = await db
			.prepare('SELECT * FROM outbox_objects WHERE actor_id=?')
			.bind(remoteActorId)
			.first<{ actor_id: string }>()
		assert.ok(entry)
		assert.equal(entry.actor_id, remoteActorId)
	})

	test('local actor sends Note with mention create notification', async () => {
		const db = makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const actorB = await createTestUser(domain, db, userKEK, 'b@cloudflare.com')

		const activity: CreateActivity<Note> = {
			type: 'Create',
			id: createActivityId(domain),
			actor: actorB.id,
			to: [actorA.id],
			cc: [],
			object: {
				id: getApId('https://example.com/note2'),
				type: 'Note',
				content: 'test note',
				attributedTo: actorB.id,
				to: [actorA.id],
				cc: [],
				attachment: [],
				sensitive: false,
			},
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const entry = await db.prepare('SELECT * FROM actor_notifications').first<{
			type: string
			actor_id: URL
			from_actor_id: URL
		}>()
		assert(entry)
		assert.equal(entry.type, 'mention')
		assert.equal(entry.actor_id.toString(), actorA.id.toString())
		assert.equal(entry.from_actor_id.toString(), actorB.id.toString())
	})

	test('Note records reply', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		{
			const activity: CreateActivity<Note> = {
				type: 'Create',
				id: createActivityId(domain),
				actor: actor.id,
				to: [actor.id],
				object: {
					id: getApId('https://example.com/note1'),
					type: 'Note',
					content: 'post',
					attributedTo: actor.id,
					to: [actor.id],
					cc: [],
					attachment: [],
					sensitive: false,
				},
			}
			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)
		}

		{
			const activity: CreateActivity<Note> = {
				type: 'Create',
				id: createActivityId(domain),
				actor: actor.id,
				to: [actor.id],
				object: {
					id: getApId('https://example.com/note2'),
					type: 'Note',
					content: 'reply',
					inReplyTo: 'https://example.com/note1',
					attributedTo: actor.id,
					to: [actor.id],
					cc: [],
					attachment: [],
					sensitive: false,
				},
			}
			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)
		}

		const entry = await db.prepare('SELECT * FROM actor_replies').first<{
			actor_id: string
			object_id: string
			in_reply_to_object_id: string
		}>()
		assert.ok(entry)
		assert.equal(entry.actor_id, actor.id.toString().toString())

		const obj = await getObjectById(domain, db, entry.object_id)
		assert(obj)
		assert.equal(obj[originalObjectIdSymbol], 'https://example.com/note2')

		const inReplyTo = await getObjectById(domain, db, entry.in_reply_to_object_id)
		assert(inReplyTo)
		assert.equal(inReplyTo[originalObjectIdSymbol], 'https://example.com/note1')
	})

	test('preserve Note sent with `to`', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const activity: CreateActivity<Note> = {
			type: 'Create',
			id: createActivityId(domain),
			actor: actor.id,
			to: [getApId('https://example.com/some-actor')],
			cc: [],
			object: {
				id: getApId('https://example.com/note1'),
				type: 'Note',
				content: 'test note',
				attributedTo: actor.id,
				to: [getApId('https://example.com/some-actor')],
				cc: [],
				attachment: [],
				sensitive: false,
			},
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const row = await db.prepare('SELECT `to`, cc FROM outbox_objects').first<{ to: string; cc: string }>()
		assert.ok(row)
		assert.equal(row.to, '["https://example.com/some-actor"]')
		assert.equal(row.cc, '[]')
	})

	test('Object props get sanitized', async () => {
		const db = makeDB()
		const person = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const activity: CreateActivity<Note> = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: createActivityId(domain),
			type: 'Create',
			actor: person,
			object: {
				id: getApId('https://example.com/note2'),
				type: 'Note',
				name: '<script>Dr Evil</script>',
				content:
					'<div><span class="bad h-10 p-100\tu-22\r\ndt-xi e-bam mention hashtag ellipsis invisible o-bad">foo</span><br/><p><a href="blah"><b>bold</b></a></p><script>alert("evil")</script></div>',
				attributedTo: person.id,
				to: [person],
				cc: [],
				attachment: [],
				sensitive: false,
			},
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const row = await db.prepare(`SELECT * from objects`).first<{ properties: string }>()
		assert.ok(row)
		const { content, name } = JSON.parse(row.properties)
		assert.equal(
			content,
			'<p><span class="h-10 p-100 u-22 dt-xi e-bam mention hashtag ellipsis invisible">foo</span><br/><p><a href="blah"><p>bold</p></a></p><p>alert("evil")</p></p>'
		)
		assert.equal(name, 'Dr Evil')
	})
})
