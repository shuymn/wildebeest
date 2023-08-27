import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { createDirectStatus, createPublicStatus } from 'wildebeest/backend/test/shared.utils'
import { assertStatus, createTestUser, makeDB } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek5'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const domain = 'cloudflare.com'

describe('Outbox', () => {
	test('return outbox', async () => {
		const db = await makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		await createPublicStatus(domain, db, actor, 'my first status')
		await createPublicStatus(domain, db, actor, 'my second status')

		const req = new Request(`https://${domain}/ap/users/sven/outbox`)
		const res = await app.fetch(req, { DATABASE: db, userKEK })
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

		const req = new Request(`https://${domain}/ap/users/sven/outbox/page`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data.type, 'OrderedCollectionPage')
		assert.equal(data.orderedItems.length, 2)
		assert.equal(data.orderedItems[0].object.content, '<p>my second status</p>')
		assert.equal(data.orderedItems[1].object.content, '<p>my first status</p>')
	})

	test("doesn't show private notes to anyone", async () => {
		const db = await makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const actorB = await createTestUser(domain, db, userKEK, 'b@cloudflare.com')

		await createDirectStatus(domain, db, actorA, 'DM', [], { to: [actorB] })

		{
			const req = new Request(`https://${domain}/ap/users/a/outbox/page`)
			const res = await app.fetch(req, { DATABASE: db })
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.orderedItems.length, 0)
		}

		{
			const req = new Request(`https://${domain}/ap/users/b/outbox/page`)
			const res = await app.fetch(req, { DATABASE: db })
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

		const req = new Request(`https://${domain}/ap/users/target/outbox/page`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<any>()
		assert.equal(data.orderedItems.length, 0)
	})
})
