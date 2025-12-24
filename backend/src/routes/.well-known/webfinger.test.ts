import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { makeDB, assertStatus, assertCache } from 'wildebeest/backend/test/utils'

describe('WebFinger', () => {
	test('no resource queried', async () => {
		const db = makeDB()

		const req = new Request('https://example.com/.well-known/webfinger')
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 400)
	})

	test('invalid resource', async () => {
		const db = makeDB()

		const req = new Request('https://example.com/.well-known/webfinger?resource=hein:a')
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 400)
	})

	test('query local account', async () => {
		const db = makeDB()

		const req = new Request('https://example.com/.well-known/webfinger?resource=acct:sven')
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 400)
	})

	test('query remote non-existing account', async () => {
		const db = makeDB()

		const req = new Request('https://example.com/.well-known/webfinger?resource=acct:sven@example.com')
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 404)
	})

	test('query remote existing account', async () => {
		const db = makeDB()
		await db
			.prepare(
				'INSERT INTO actors (id, mastodon_id, domain, properties, type, username) VALUES (?, ?, ?, ?, ?, lower(?))'
			)
			.bind(
				'https://example.com/ap/users/sven',
				'12345',
				'example.com',
				JSON.stringify({
					type: 'Person',
					preferredUsername: 'sven',
				}),
				'Person',
				'sven'
			)
			.run()

		{
			const req = new Request('https://example.com/.well-known/webfinger?resource=acct:sven@example.com')
			const res = await app.fetch(req, { DATABASE: db })
			await assertStatus(res, 200)
			assert.equal(res.headers.get('content-type'), 'application/jrd+json')
			assertCache(res, 3600)
			const data = await res.json<any>()
			assert.equal(data.links.length, 1)
			assert.equal(data.links[0].href, 'https://example.com/ap/users/sven')
		}

		{
			const req = new Request('https://example.com/.well-known/webfinger?resource=acct:SVEN@example.com')
			const res = await app.fetch(req, { DATABASE: db })
			await assertStatus(res, 200)
			const data = await res.json<any>()
			assert.equal(data.links[0].href, 'https://example.com/ap/users/sven')
		}
	})
})
