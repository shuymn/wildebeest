import { strict as assert } from 'node:assert/strict'

import * as objects from 'wildebeest/backend/src/activitypub/objects'
import { mastodonIdSymbol, originalActorIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { createImage, Image } from 'wildebeest/backend/src/activitypub/objects/image'
import * as media from 'wildebeest/functions/api/v2/media'
import * as media_id from 'wildebeest/functions/api/v2/media/[id]'

import { assertJSON, assertStatus, createTestUser, isUrlValid, makeDB } from '../utils'

const userKEK = 'test_kek10'
const CF_ACCOUNT_ID = 'testaccountid'
const CF_API_TOKEN = 'testtoken'
const domain = 'cloudflare.com'

describe('Mastodon APIs', () => {
	describe('media', () => {
		test('upload image creates object', async () => {
			globalThis.fetch = async (input: RequestInfo) => {
				const request = new Request(input)
				if (request.url.toString() === 'https://api.cloudflare.com/client/v4/accounts/testaccountid/images/v1') {
					return new Response(
						JSON.stringify({
							success: true,
							result: {
								id: 'abcd',
								variants: ['https://example.com/' + file.name + '/usercontent'],
							},
						})
					)
				}
				throw new Error('unexpected request to ' + request.url)
			}

			const db = await makeDB()
			const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const file = new File(['abc'], 'image.jpeg', { type: 'image/jpeg' })

			const body = new FormData()
			body.set('file', file)

			const req = new Request('https://example.com/api/v2/media', {
				method: 'POST',
				body,
			})
			const res = await media.handleRequestPost(req, db, connectedActor, CF_ACCOUNT_ID, CF_API_TOKEN)
			await assertStatus(res, 200)
			assertJSON(res)

			const data = await res.json<{ id: string; url: string; preview_url: string }>()
			assert(!isUrlValid(data.id))
			assert(isUrlValid(data.url))
			assert(isUrlValid(data.preview_url))

			const obj = await objects.getObjectByMastodonId(db, data.id)
			assert(obj)
			assert(obj[mastodonIdSymbol])
			assert.equal(obj.type, 'Image')
			assert.equal(obj[originalActorIdSymbol], connectedActor.id.toString())
		})

		test('update image description', async () => {
			const db = await makeDB()
			const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const image = await createImage(domain, db, connectedActor, {
				url: 'https://cloudflare.com/image.jpg',
				description: 'foo bar',
			})

			const request = new Request('https://' + domain, {
				method: 'PUT',
				body: JSON.stringify({ description: 'new foo bar' }),
				headers: {
					'content-type': 'application/json',
				},
			})

			const res = await media_id.onRequestPut({
				request,
				env: { DATABASE: db },
				params: { id: image[mastodonIdSymbol]! },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const data = await res.json<{ description: unknown }>()
			assert.equal(data.description, 'new foo bar')

			const newImage = await objects.getObjectByMastodonId(db, image[mastodonIdSymbol]!)
			assert.ok(newImage)
			assert.equal((newImage as Image).description, 'new foo bar')
		})
	})
})
