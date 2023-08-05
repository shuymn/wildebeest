import { strict as assert } from 'node:assert/strict'

import * as webfinger from 'wildebeest/functions/.well-known/webfinger'

import { assertCache, assertStatus, makeDB } from './utils'

describe('WebFinger', () => {
	test('no resource queried', async () => {
		const db = await makeDB()

		const req = new Request('https://example.com/.well-known/webfinger')
		const res = await webfinger.handleRequest(req, db)
		await assertStatus(res, 400)
	})

	test('invalid resource', async () => {
		const db = await makeDB()

		const req = new Request('https://example.com/.well-known/webfinger?resource=hein:a')
		const res = await webfinger.handleRequest(req, db)
		await assertStatus(res, 400)
	})

	test('query local account', async () => {
		const db = await makeDB()

		const req = new Request('https://example.com/.well-known/webfinger?resource=acct:sven')
		const res = await webfinger.handleRequest(req, db)
		await assertStatus(res, 400)
	})

	test('query remote non-existing account', async () => {
		const db = await makeDB()

		const req = new Request('https://example.com/.well-known/webfinger?resource=acct:sven@example.com')
		const res = await webfinger.handleRequest(req, db)
		await assertStatus(res, 404)
	})

	test('query remote existing account', async () => {
		const db = await makeDB()
		await db
			.prepare(
				'INSERT INTO actors (id, mastodon_id, domain, properties, type, username) VALUES (?, ?, ?, ?, ?, lower(?))'
			)
			.bind(
				'https://example.com/ap/users/sven',
				'12345',
				'cloudflare.com',
				JSON.stringify({
					type: 'Person',
					preferredUsername: 'sven',
				}),
				'Person',
				'sven'
			)
			.run()

		const req = new Request('https://example.com/.well-known/webfinger?resource=acct:sven@example.com')
		const res = await webfinger.handleRequest(req, db)
		await assertStatus(res, 200)
		assert.equal(res.headers.get('content-type'), 'application/jrd+json')
		assertCache(res, 3600)

		const data = await res.json<any>()
		assert.equal(data.links.length, 1)
	})
})
