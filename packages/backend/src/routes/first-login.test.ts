import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { getActorById } from '@wildebeest/backend/activitypub/actors'
import { getSigningKey } from '@wildebeest/backend/mastodon/account'
import { ACCESS_CERTS, TEST_JWT } from '@wildebeest/backend/test/test-data'
import { makeDB, assertStatus, isUrlValid } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek3'
const accessDomain = 'access.com'
const accessAud = 'abcd'

describe('/first-login', () => {
	beforeEach(() => {
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/certs') {
					return new Response(JSON.stringify(ACCESS_CERTS))
				}

				if (input.toString() === 'https://' + accessDomain + '/cdn-cgi/access/get-identity') {
					return new Response(
						JSON.stringify({
							email: 'some@cloudflare.com',
						})
					)
				}
			}

			if (input instanceof URL || typeof input === 'string') {
				throw new Error('unexpected request to ' + input.toString())
			} else {
				throw new Error('unexpected request to ' + input.url)
			}
		}
	})

	test('first login is protected by Access', async () => {
		const db = makeDB()

		const params = new URLSearchParams({
			redirect_uri: 'https://redirect.com/a',
		})

		const formData = new FormData()
		formData.set('username', 'username')
		formData.set('name', 'name')

		const req = new Request('https://example.com/first-login?' + params.toString(), {
			method: 'POST',
			body: formData,
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, ACCESS_AUTH_DOMAIN: accessDomain, ACCESS_AUD: accessAud })
		await assertStatus(res, 401)
	})

	test('first login creates the user and redirects', async () => {
		const db = makeDB()

		const params = new URLSearchParams({
			redirect_uri: 'https://redirect.com/a',
		})

		const formData = new FormData()
		formData.set('username', 'username')
		formData.set('name', 'name')

		const req = new Request('https://example.com/first-login?' + params.toString(), {
			method: 'POST',
			body: formData,
			headers: {
				cookie: `CF_Authorization=${TEST_JWT}`,
			},
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, ACCESS_AUTH_DOMAIN: accessDomain, ACCESS_AUD: accessAud })
		await assertStatus(res, 302)

		const location = res.headers.get('location')
		assert.equal(location, 'https://redirect.com/a')

		const row = await db
			.prepare(
				'SELECT actors.properties, users.email, actors.id FROM actors INNER JOIN users ON users.actor_id = actors.id'
			)
			.first<{ properties: string; email: string; id: string }>()
		assert.ok(row)
		const properties = JSON.parse(row.properties)

		assert.equal(row.email, 'sven@cloudflare.com')
		assert.equal(properties.preferredUsername, 'username')
		assert.equal(properties.name, 'name')
		assert(isUrlValid(row.id))

		// ensure that we generate a correct key pairs for the user
		const actor = await getActorById(db, row.id)
		assert.ok(actor)
		assert((await getSigningKey(userKEK, db, actor)) instanceof CryptoKey)
	})

	test('first login redirect relative URLs', async () => {
		const db = makeDB()

		const params = new URLSearchParams({
			redirect_uri: '/a',
		})

		const formData = new FormData()
		formData.set('username', 'username')
		formData.set('name', 'name')

		const req = new Request('https://example.com/first-login?' + params.toString(), {
			method: 'POST',
			body: formData,
			headers: {
				cookie: `CF_Authorization=${TEST_JWT}`,
			},
		})
		const res = await app.fetch(req, { DATABASE: db, userKEK, ACCESS_AUTH_DOMAIN: accessDomain, ACCESS_AUD: accessAud })
		await assertStatus(res, 302)

		const location = res.headers.get('location')
		assert.equal(location, 'https://example.com/a')
	})
})
