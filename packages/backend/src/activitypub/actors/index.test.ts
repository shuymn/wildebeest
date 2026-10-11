import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { Actor, fetchActor, getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { Remote } from '@wildebeest/backend/activitypub/objects'
import { assertStatus, isUrlValid, makeDB } from '@wildebeest/backend/test/utils'

const domain = 'cloudflare.com'

describe('Actors', () => {
	test('fetch non-existant user by id', async () => {
		const db = makeDB()

		const req = new Request(`https://${domain}/ap/users/nonexisting`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 404)
	})

	test('fetch user by id', async () => {
		const db = makeDB()
		const properties: Remote<Actor> = {
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

		// The served key comes from the `users` table, not from the (possibly
		// tampered with) stored actor properties.
		const userPubkey = '-----BEGIN PUBLIC KEY-----users-table-key-----END PUBLIC KEY-----'
		await db
			.prepare(
				'INSERT INTO users (id, actor_id, email, privkey, privkey_salt, pubkey, is_admin, cdate) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
			)
			.bind(
				crypto.randomUUID(),
				`https://${domain}/ap/users/sven`,
				'sven@cloudflare.com',
				new Uint8Array([1, 2, 3]).buffer,
				new Uint8Array([4, 5, 6]).buffer,
				userPubkey,
				new Date().toISOString()
			)
			.run()

		const req = new Request(`https://${domain}/ap/users/sven`)
		const res = await app.fetch(req, { DATABASE: db })
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
		assert.equal(data.publicKey.publicKeyPem, userPubkey)
		assert.equal(data.publicKey.id, `https://${domain}/ap/users/sven#main-key`)
		// The stored collections pointed at another host and must be ignored.
		assert.equal(data.inbox, `https://${domain}/ap/users/sven/inbox`)
		assert.equal(data.outbox, `https://${domain}/ap/users/sven/outbox`)
		assert.equal(data.followers, `https://${domain}/ap/users/sven/followers`)
		assert.equal(data.following, `https://${domain}/ap/users/sven/following`)
	})

	test('sanitize Actor properties', async () => {
		globalThis.fetch = async (input) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://example.com/actor') {
					return new Response(
						JSON.stringify({
							id: 'https://example.com/actor',
							type: 'Person',
							summary: "it's me, Mario. <script>alert(1)</script>",
							name: 'hi<br />hey',
							preferredUsername: 'sven <script>alert(1)</script>',
							attachment: [
								{
									type: 'PropertyValue',
									name: '<b onclick="alert(2)">site</b>',
									value: '<a href="javascript:alert(3)" style="x">x</a><a href="https://a.com" class="bad">a.com</a>',
								},
							],
						})
					)
				}
				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const actor = await fetchActor('https://example.com/actor')
		assert.ok(actor)
		assert.equal(actor.summary, "it's me, Mario. ")
		assert.equal(actor.name, 'hi hey')
		assert.equal(actor.preferredUsername, 'sven')
		assert.deepEqual((actor as unknown as { attachment: unknown }).attachment, [
			{
				type: 'PropertyValue',
				name: 'site',
				value:
					'<a rel="nofollow noopener noreferrer" target="_blank">x</a><a href="https://a.com" rel="nofollow noopener noreferrer" target="_blank">a.com</a>',
			},
		])
	})

	test('Actor properties limits', async () => {
		globalThis.fetch = async (input) => {
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

		const actor = await fetchActor('https://example.com/actor')
		assert.ok(actor)
		assert.equal(actor.summary, 'a'.repeat(500))
		assert.equal(actor.name, 'b'.repeat(30))
		assert.equal(actor.preferredUsername, 'c'.repeat(30))
	})

	test('getAndCache adds peer', async () => {
		const actorId = new URL('https://example.com/user/foo')

		globalThis.fetch = async (input) => {
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

		const db = makeDB()

		await getAndCacheActor(actorId, db)

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

		globalThis.fetch = async (input) => {
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

		const db = makeDB()

		await getAndCacheActor(actorId, db)

		const { results } = (await db.prepare('SELECT * FROM actors').all()) as any
		assert.equal(results.length, 1)
		assert.equal(results[0].id, actorId.toString())
		assert.equal(results[0].type, 'Service')
	})
})
