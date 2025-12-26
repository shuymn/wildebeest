import { fetchMock } from 'cloudflare:test'
import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { MastodonError } from '@wildebeest/backend/errors'
import { getClientByClientCredential } from '@wildebeest/backend/mastodon/client'
import { makeDB, assertStatus, createTestClient, assertCORS, assertJSON } from '@wildebeest/backend/test/utils'

describe('/oauth/token', () => {
	beforeEach(() => {
		fetchMock.activate()
		fetchMock.disableNetConnect()
	})

	test('token error on unknown client', async () => {
		const db = makeDB()

		const req = new Request('https://example.com/oauth/token', {
			method: 'POST',
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code: 'some-code',
				client_id: 'unknown',
				client_secret: 'unknown',
				redirect_uri: 'https://example.com',
			}),
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
			},
		})
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 401)
		const body = await res.json<MastodonError>()
		assert.ok(body.error.includes('invalid_client'))
	})

	test('token returns auth infos', async () => {
		const db = makeDB()
		const testScope = 'test abcd'
		const client = await createTestClient(db, 'https://localhost', testScope)

		{
			const req = new Request('https://example.com/oauth/token', {
				method: 'POST',
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code: client.id + '.some-code',
					client_id: client.id,
					client_secret: client.secret,
					redirect_uri: client.redirect_uris,
					scope: testScope,
				}),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
			})
			const res = await app.fetch(req, { DATABASE: db })
			await assertStatus(res, 200)
			assertCORS(res, req)
			assertJSON(res)

			const data = await res.json<{ access_token: unknown; scope: unknown }>()
			assert.equal(data.access_token, client.id + '.some-code')
			assert.equal(data.scope, testScope)
		}
		{
			const req = new Request('https://example.com/oauth/token', {
				method: 'POST',
				body: new URLSearchParams({
					grant_type: 'client_credentials',
					client_id: client.id,
					client_secret: client.secret,
					redirect_uri: client.redirect_uris,
					scope: testScope,
				}),
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
				},
			})
			const res = await app.fetch(req, { DATABASE: db })
			await assertStatus(res, 200)
			assertCORS(res, req)
			assertJSON(res)

			const data = await res.json<{ access_token: string; scope: unknown }>()
			assert.deepEqual(client, await getClientByClientCredential(db, data.access_token))
			assert.equal(data.scope, testScope)
		}
	})

	test('token handles empty code', async () => {
		const db = makeDB()
		const body = new URLSearchParams({ code: '' })

		const req = new Request('https://example.com/oauth/token', {
			method: 'POST',
			body,
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
			},
		})
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 401)
	})

	test('token returns CORS', async () => {
		const req = new Request('https://example.com/oauth/token', {
			method: 'OPTIONS',
		})
		const res = await app.fetch(req)
		await assertStatus(res, 204)
		assertCORS(res, req)
	})

	test('token handles code in URL', async () => {
		const db = makeDB()
		const client = await createTestClient(db, 'https://localhost')

		const code = client.id + '.a'

		const req = new Request('https://example.com/oauth/token?code=' + code, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				grant_type: 'authorization_code',
				client_id: client.id,
				client_secret: client.secret,
				redirect_uri: client.redirect_uris,
			}),
		})
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data.access_token, code)
	})
})
