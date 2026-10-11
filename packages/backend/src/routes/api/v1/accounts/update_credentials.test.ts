import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { getActorById } from '@wildebeest/backend/activitypub/actors'
import { getApId } from '@wildebeest/backend/activitypub/objects'
import { addFollowing, acceptFollowing } from '@wildebeest/backend/mastodon/follow'
import { makeDB, makeQueue, createTestUser, assertStatus } from '@wildebeest/backend/test/utils'
import { MessageType } from '@wildebeest/backend/types'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/update_credentials', () => {
	test('update credentials', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const updates = new FormData()
		updates.set('display_name', 'newsven')
		updates.set('note', 'hein')

		const req = new Request('https://example.com/api/v1/accounts/update_credentials', {
			method: 'PATCH',
			body: updates,
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			CF_ACCOUNT_ID: 'CF_ACCOUNT_ID',
			CF_API_TOKEN: 'CF_API_TOKEN',
			userKEK,
			QUEUE: queue,
			data: { connectedActor },
		})
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data.display_name, 'newsven')
		assert.equal(data.note, '<p>hein</p>')
		assert.equal(data.source.note, 'hein')

		const updatedActor: any = await getActorById(db, getApId(connectedActor))
		assert(updatedActor)
		assert.equal(updatedActor.name, 'newsven')
		assert.equal(updatedActor.summary, '<p>hein</p>')
	})

	test('update credentials does not store HTML from the display name and note', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const updates = new FormData()
		updates.set('display_name', 'sven<img src=x onerror="alert(1)"><script>alert(2)</script>')
		updates.set('note', '<img src=x onerror="alert(1)">\n<a href="javascript:alert(2)">hi</a>\n\n2nd & last')

		const req = new Request('https://example.com/api/v1/accounts/update_credentials', {
			method: 'PATCH',
			body: updates,
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			CF_ACCOUNT_ID: 'CF_ACCOUNT_ID',
			CF_API_TOKEN: 'CF_API_TOKEN',
			userKEK,
			QUEUE: queue,
			data: { connectedActor },
		})
		await assertStatus(res, 200)

		const expectedNote =
			'<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;<br />&lt;a href=&quot;javascript:alert(2)&quot;&gt;hi&lt;/a&gt;</p><p>2nd &amp; last</p>'
		const data = await res.json<any>()
		assert.equal(data.display_name, 'sven')
		assert.equal(data.note, expectedNote)

		const updatedActor: any = await getActorById(db, getApId(connectedActor))
		assert(updatedActor)
		assert.equal(updatedActor.name, 'sven')
		assert.equal(updatedActor.summary, expectedNote)
	})

	test('update credentials sends update to follower', async () => {
		const db = makeDB()
		const queue = makeQueue()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		await addFollowing(domain, db, actor2, connectedActor)
		await acceptFollowing(db, actor2, connectedActor)

		const updates = new FormData()
		updates.set('display_name', 'newsven')

		const req = new Request('https://example.com/api/v1/accounts/update_credentials', {
			method: 'PATCH',
			body: updates,
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			CF_ACCOUNT_ID: 'CF_ACCOUNT_ID',
			CF_API_TOKEN: 'CF_API_TOKEN',
			userKEK,
			QUEUE: queue,
			data: { connectedActor },
		})
		await assertStatus(res, 200)

		assert.equal(queue.messages.length, 1)

		assert.equal(queue.messages[0].type, MessageType.Deliver)
		assert.equal(queue.messages[0].activity.type, 'Update')
		assert.equal(queue.messages[0].actorId, connectedActor.id.toString())
		assert.equal(queue.messages[0].toActorId, actor2.id.toString())
	})

	test('update credentials avatar and header', async () => {
		globalThis.fetch = async (input, data: any) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input === 'https://api.cloudflare.com/client/v4/accounts/CF_ACCOUNT_ID/images/v1') {
					assert.equal(data.method, 'POST')
					const file: any = (data.body as { get: (str: string) => any }).get('file')
					return new Response(
						JSON.stringify({
							success: true,
							result: {
								variants: [
									'https://example.com/' + file.name + '/avatar',
									'https://example.com/' + file.name + '/header',
								],
							},
						})
					)
				}
				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const db = makeDB()
		const queue = makeQueue()
		const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const updates = new FormData()
		updates.set('avatar', new File(['bytes'], 'selfie.jpg', { type: 'image/jpeg' }))
		updates.set('header', new File(['bytes2'], 'mountain.jpg', { type: 'image/jpeg' }))

		const req = new Request('https://example.com/api/v1/accounts/update_credentials', {
			method: 'PATCH',
			body: updates,
		})
		const res = await app.fetch(req, {
			DATABASE: db,
			CF_ACCOUNT_ID: 'CF_ACCOUNT_ID',
			CF_API_TOKEN: 'CF_API_TOKEN',
			userKEK,
			QUEUE: queue,
			data: { connectedActor },
		})
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data.avatar, 'https://example.com/selfie.jpg/avatar')
		assert.equal(data.header, 'https://example.com/mountain.jpg/header')
	})
})
