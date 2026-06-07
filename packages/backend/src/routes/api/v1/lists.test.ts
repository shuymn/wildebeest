import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { assertJSON, assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_lists'
const domain = 'cloudflare.com'

describe('/api/v1/lists', () => {
	test('create and list lists', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'lists@cloudflare.com')

		const createReq = new Request(`https://${domain}/api/v1/lists`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'Friends', replies_policy: 'list', exclusive: false }),
		})
		const createRes = await app.fetch(createReq, { DATABASE: db, data: { connectedActor } })
		await assertStatus(createRes, 200)
		assertJSON(createRes)
		const created = await createRes.json<{ id: string; title: string }>()
		assert.equal(created.title, 'Friends')

		const listReq = new Request(`https://${domain}/api/v1/lists`)
		const listRes = await app.fetch(listReq, { DATABASE: db, data: { connectedActor } })
		await assertStatus(listRes, 200)
		const lists = await listRes.json<Array<{ id: string }>>()
		assert.equal(lists.length, 1)
		assert.equal(lists[0]?.id, created.id)
	})

	test('update and delete list', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'lists2@cloudflare.com')

		const createRes = await app.fetch(
			new Request(`https://${domain}/api/v1/lists`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Old title' }),
			}),
			{ DATABASE: db, data: { connectedActor } }
		)
		const { id } = await createRes.json<{ id: string }>()

		const updateRes = await app.fetch(
			new Request(`https://${domain}/api/v1/lists/${id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'New title' }),
			}),
			{ DATABASE: db, data: { connectedActor } }
		)
		await assertStatus(updateRes, 200)
		const updated = await updateRes.json<{ title: string }>()
		assert.equal(updated.title, 'New title')

		const deleteRes = await app.fetch(
			new Request(`https://${domain}/api/v1/lists/${id}`, { method: 'DELETE' }),
			{ DATABASE: db, data: { connectedActor } }
		)
		await assertStatus(deleteRes, 200)
	})
})
