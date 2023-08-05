import { strict as assert } from 'node:assert/strict'

import * as actors from 'wildebeest/backend/src/activitypub/actors'
import { getApId, Remote } from 'wildebeest/backend/src/activitypub/objects'
import { cacheObject } from 'wildebeest/backend/src/activitypub/objects/'
import { loadItems } from 'wildebeest/backend/src/activitypub/objects/collection'
import { MessageType } from 'wildebeest/backend/src/types'
import type { JWK } from 'wildebeest/backend/src/webpush/jwk'
import { createDirectStatus, createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { assertStatus, createTestUser, isUrlValid, makeDB } from 'wildebeest/backend/test/utils'
import * as ap_objects from 'wildebeest/functions/ap/o/[id]'
import * as ap_users from 'wildebeest/functions/ap/users/[id]'
import * as ap_inbox from 'wildebeest/functions/ap/users/[id]/inbox'
import * as ap_outbox from 'wildebeest/functions/ap/users/[id]/outbox'
import * as ap_outbox_page from 'wildebeest/functions/ap/users/[id]/outbox/page'

const userKEK = 'test_kek5'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const vapidKeys = {} as JWK
const domain = 'cloudflare.com'

describe('ActivityPub', () => {
	describe('Actors', () => {
		test('fetch non-existant user by id', async () => {
			const db = await makeDB()

			const res = await ap_users.handleRequest(domain, db, 'nonexisting')
			await assertStatus(res, 404)
		})

		test('fetch user by id', async () => {
			const db = await makeDB()
			const properties: Remote<actors.Actor> = {
				id: `https://${domain}/ap/users/sven`,
				url: `https://${domain}/@sven`,
				type: 'Person',
				preferredUsername: 'sven',
				discoverable: true,
				summary: 'test summary',
				inbox: new URL('https://example.com/inbox'),
				outbox: new URL('https://example.com/outbox'),
				following: new URL('https://example.com/following'),
				followers: new URL('https://example.com/followers'),
				featured: new URL('https://example.com/featured'),
				publicKey: {
					id: 'https://example.com/publicKey',
					publicKeyPem:
						'-----BEGIN PUBLIC KEY-----MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEApnI8FHJQXqqAdM87YwVseRUqbNLiw8nQ0zHBUyLylzaORhI4LfW4ozguiw8cWYgMbCufXMoITVmdyeTMGbQ3Q1sfQEcEjOZZXEeCCocmnYjK6MFSspjFyNw6GP0a5A/tt1tAcSlgALv8sg1RqMhSE5Kv+6lSblAYXcIzff7T2jh9EASnimaoAAJMaRH37+HqSNrouCxEArcOFhmFETadXsv+bHZMozEFmwYSTugadr4WD3tZd+ONNeimX7XZ3+QinMzFGOW19ioVHyjt3yCDU1cPvZIDR17dyEjByNvx/4N4Zly7puwBn6Ixy/GkIh5BWtL5VOFDJm/S+zcf1G1WsOAXMwKL4Nc5UWKfTB7Wd6voId7vF7nI1QYcOnoyh0GqXWhTPMQrzie4nVnUrBedxW0s/0vRXeR63vTnh5JrTVu06JGiU2pq2kvwqoui5VU6rtdImITybJ8xRkAQ2jo4FbbkS6t49PORIuivxjS9wPl7vWYazZtDVa5g/5eL7PnxOG3HsdIJWbGEh1CsG83TU9burHIepxXuQ+JqaSiKdCVc8CUiO++acUqKp7lmbYR9E/wRmvxXDFkxCZzA0UL2mRoLLLOe4aHvRSTsqiHC5Wwxyew5bb+eseJz3wovid9ZSt/tfeMAkCDmaCxEK+LGEbJ9Ik8ihis8Esm21N0A54sCAwEAAQ==-----END PUBLIC KEY-----',
				},
			}

			await db
				.prepare(
					'INSERT INTO actors (id, mastodon_id, domain, properties, type, username) VALUES (?, ?, ?, ?, ?, lower(?))'
				)
				.bind(
					`https://${domain}/ap/users/sven`,
					'12345',
					'cloudflare.com',
					JSON.stringify(properties),
					properties.type,
					properties.preferredUsername ?? null
				)
				.run()

			const res = await ap_users.handleRequest(domain, db, 'sven')
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.summary, 'test summary')
			assert(data.discoverable)
			assert(data['@context'])
			assert(isUrlValid(data.id))
			assert(isUrlValid(data.url))
			assert(isUrlValid(data.inbox))
			assert(isUrlValid(data.outbox))
			assert(isUrlValid(data.following))
			assert(isUrlValid(data.followers))
			assert(isUrlValid(data.featured))
			assert.equal(data.publicKey.publicKeyPem, properties.publicKey?.publicKeyPem)
		})

		test('sanitize Actor properties', async () => {
			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://example.com/actor') {
						return new Response(
							JSON.stringify({
								id: 'https://example.com/actor',
								type: 'Person',
								summary: "it's me, Mario. <script>alert(1)</script>",
								name: 'hi<br />hey',
								preferredUsername: 'sven <script>alert(1)</script>',
							})
						)
					}
					throw new Error(`unexpected request to "${input.toString()}"`)
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const actor = await actors.fetchActor('https://example.com/actor')
			assert.equal(actor.summary, "it's me, Mario. <p>alert(1)</p>")
			assert.equal(actor.name, 'hi hey')
			assert.equal(actor.preferredUsername, 'sven alert(1)')
		})

		test('Actor properties limits', async () => {
			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://example.com/actor') {
						return new Response(
							JSON.stringify({
								id: 'https://example.com/actor',
								type: 'Person',
								summary: 'a'.repeat(612),
								name: 'b'.repeat(50),
								preferredUsername: 'c'.repeat(50),
							})
						)
					}
					throw new Error(`unexpected request to "${input.toString()}"`)
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const actor = await actors.fetchActor('https://example.com/actor')
			assert.equal(actor.summary, 'a'.repeat(500))
			assert.equal(actor.name, 'b'.repeat(30))
			assert.equal(actor.preferredUsername, 'c'.repeat(30))
		})
	})

	describe('Outbox', () => {
		test('return outbox', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			await createPublicStatus(domain, db, actor, 'my first status')
			await createPublicStatus(domain, db, actor, 'my second status')

			const res = await ap_outbox.handleRequest(domain, db, 'sven', userKEK)
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.type, 'OrderedCollection')
			assert.equal(data.totalItems, 2)
		})

		test('return outbox page', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			await createPublicStatus(domain, db, actor, 'my first status')
			await sleep(10)
			await createPublicStatus(domain, db, actor, 'my second status')

			const res = await ap_outbox_page.handleRequest(domain, db, 'sven')
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.type, 'OrderedCollectionPage')
			assert.equal(data.orderedItems.length, 2)
			assert.equal(data.orderedItems[0].object.content, 'my second status')
			assert.equal(data.orderedItems[1].object.content, 'my first status')
		})

		test("doesn't show private notes to anyone", async () => {
			const db = await makeDB()
			const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
			const actorB = await createTestUser(domain, db, userKEK, 'b@cloudflare.com')

			await createDirectStatus(domain, db, actorA, 'DM', [], { to: [actorB] })

			{
				const res = await ap_outbox_page.handleRequest(domain, db, 'a')
				await assertStatus(res, 200)

				const data = await res.json<any>()
				assert.equal(data.orderedItems.length, 0)
			}

			{
				const res = await ap_outbox_page.handleRequest(domain, db, 'b')
				await assertStatus(res, 200)

				const data = await res.json<any>()
				assert.equal(data.orderedItems.length, 0)
			}
		})

		test("doesn't show private note in target outbox", async () => {
			const db = await makeDB()
			const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
			const actorB = await createTestUser(domain, db, userKEK, 'target@cloudflare.com')

			await createDirectStatus(domain, db, actorA, 'DM', [], { to: [actorB] })

			const res = await ap_outbox_page.handleRequest(domain, db, 'target')
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.orderedItems.length, 0)
		})
	})

	describe('Actors', () => {
		test('getAndCache adds peer', async () => {
			const actorId = new URL('https://example.com/user/foo')

			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === actorId.toString()) {
						return new Response(
							JSON.stringify({
								id: actorId,
								type: 'Person',
								preferredUsername: 'sven',
								name: 'sven ssss',

								icon: { url: 'icon.jpg' },
								image: { url: 'image.jpg' },
							})
						)
					}

					throw new Error(`unexpected request to "${input.toString()}"`)
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const db = await makeDB()

			await actors.getAndCache(actorId, db)

			const { results } = (await db.prepare('SELECT domain from peers').all()) as any
			assert.equal(results.length, 1)
			assert.equal(results[0].domain, 'example.com')
		})

		test('getAndCache supports any Actor types', async () => {
			// While Actor ObjectID MUST be globally unique, the Object can
			// change type and Mastodon uses this behavior as a feature.
			// We need to make sure our caching works with Actor that change
			// types.

			const actorId = new URL('https://example.com/user/foo')

			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === actorId.toString()) {
						return new Response(
							JSON.stringify({
								id: actorId,
								type: 'Service',
								preferredUsername: 'sven',
								name: 'sven ssss',

								icon: { url: 'icon.jpg' },
								image: { url: 'image.jpg' },
							})
						)
					}

					if (input.toString() === actorId.toString()) {
						return new Response(
							JSON.stringify({
								id: actorId,
								type: 'Person',
								preferredUsername: 'sven',
								name: 'sven ssss',

								icon: { url: 'icon.jpg' },
								image: { url: 'image.jpg' },
							})
						)
					}

					throw new Error(`unexpected request to "${input.toString()}"`)
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const db = await makeDB()

			await actors.getAndCache(actorId, db)

			const { results } = (await db.prepare('SELECT * FROM actors').all()) as any
			assert.equal(results.length, 1)
			assert.equal(results[0].id, actorId.toString())
			assert.equal(results[0].type, 'Service')
		})
	})

	describe('Objects', () => {
		test('cacheObject deduplicates object', async () => {
			const db = await makeDB()
			const properties: any = { type: 'Note', a: 1, b: 2 }
			const actor = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
			const originalObjectId = new URL('https://example.com/object1')

			let result: any

			// Cache object once adds it to the database
			const res1: any = await cacheObject(domain, db, properties, getApId(actor), originalObjectId, false)
			assert.equal(res1.object.a, 1)
			assert.equal(res1.object.b, 2)
			assert(res1.created)

			result = await db.prepare('SELECT count(*) as count from objects').first()
			assert.equal(result.count, 1)

			// Cache object second time updates the first one
			properties.a = 3
			const res2: any = await cacheObject(domain, db, properties, getApId(actor), originalObjectId, false)
			// The creation date and properties don't change
			assert.equal(res1.object.a, res2.object.a)
			assert.equal(res1.object.b, res2.object.b)
			assert.equal(res1.object.published, res2.object.published)
			assert(!res2.created)

			result = await db.prepare('SELECT count(*) as count from objects').first()
			assert.equal(result.count, 1)
		})

		test('cacheObject adds peer', async () => {
			const db = await makeDB()
			const properties: any = { type: 'Note', a: 1, b: 2 }
			const actor = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
			const originalObjectId = new URL('https://example.com/object1')

			await cacheObject(domain, db, properties, getApId(actor), originalObjectId, false)

			const { results } = (await db.prepare('SELECT domain from peers').all()) as any
			assert.equal(results.length, 1)
			assert.equal(results[0].domain, 'example.com')
		})

		test('serve unknown object', async () => {
			const db = await makeDB()
			const res = await ap_objects.handleRequest(domain, db, 'unknown id')
			await assertStatus(res, 404)
		})

		test('serve object', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
			const note = await createPublicStatus(domain, db, actor, 'content')

			const uuid = note.id.toString().replace('https://' + domain + '/ap/o/', '')
			const res = await ap_objects.handleRequest(domain, db, uuid)
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.content, 'content')
		})
	})

	describe('Inbox', () => {
		test('send Note to non existent user', async () => {
			const db = await makeDB()

			const queue = {
				async send() {
					return
				},
				async sendBatch() {
					throw new Error('unimplemented')
				},
			}

			const activity: any = {}
			const res = await ap_inbox.handleRequest(domain, db, 'sven', activity, queue, userKEK, vapidKeys)
			await assertStatus(res, 404)
		})

		test('send activity sends message in queue', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			let msg: any = null

			const queue = {
				async send(v: any) {
					msg = v
				},
				async sendBatch() {
					throw new Error('unimplemented')
				},
			}

			const activity: any = {
				type: 'some activity',
			}
			const res = await ap_inbox.handleRequest(domain, db, 'sven', activity, queue, userKEK, vapidKeys)
			await assertStatus(res, 200)

			assert(msg)
			assert.equal(msg.type, MessageType.Inbox)
			assert.equal(msg.actorId, actor.id.toString())
			assert.equal(msg.activity.type, 'some activity')
		})
	})

	describe('Collection', () => {
		test('loadItems walks pages', async () => {
			const collection = {
				totalItems: 6,
				first: 'https://example.com/1',
			} as any

			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://example.com/1') {
						return new Response(
							JSON.stringify({
								next: 'https://example.com/2',
								orderedItems: ['a', 'b'],
							})
						)
					}
					if (input.toString() === 'https://example.com/2') {
						return new Response(
							JSON.stringify({
								next: 'https://example.com/3',
								orderedItems: ['c', 'd'],
							})
						)
					}
					if (input.toString() === 'https://example.com/3') {
						return new Response(
							JSON.stringify({
								orderedItems: ['e', 'f'],
							})
						)
					}

					throw new Error(`unexpected request to "${input.toString()}"`)
				}
				throw new Error('unexpected request to ' + input.url)
			}

			{
				const items = await loadItems(collection, 10)
				assert.deepEqual(items, ['a', 'b', 'c', 'd', 'e', 'f'])
			}
			{
				const items = await loadItems(collection, 3)
				assert.deepEqual(items.length, 3)
			}
		})
	})
})
