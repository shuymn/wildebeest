import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
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
		await assertStatus(createRes, 200)
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

		const deleteRes = await app.fetch(new Request(`https://${domain}/api/v1/lists/${id}`, { method: 'DELETE' }), {
			DATABASE: db,
			data: { connectedActor },
		})
		await assertStatus(deleteRes, 200)
	})

	test('get list by id', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'getlist@cloudflare.com')

		const createRes = await app.fetch(
			new Request(`https://${domain}/api/v1/lists`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'My list' }),
			}),
			{ DATABASE: db, data: { connectedActor } }
		)
		await assertStatus(createRes, 200)
		const { id } = await createRes.json<{ id: string }>()

		const getRes = await app.fetch(new Request(`https://${domain}/api/v1/lists/${id}`), {
			DATABASE: db,
			data: { connectedActor },
		})
		await assertStatus(getRes, 200)
		const list = await getRes.json<{ id: string; title: string }>()
		assert.equal(list.id, id)
		assert.equal(list.title, 'My list')
	})

	test('manage list accounts', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'listaccounts@cloudflare.com')
		const member = await createTestUser(domain, db, userKEK, 'listmember@cloudflare.com')

		const createRes = await app.fetch(
			new Request(`https://${domain}/api/v1/lists`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Team' }),
			}),
			{ DATABASE: db, data: { connectedActor } }
		)
		await assertStatus(createRes, 200)
		const { id } = await createRes.json<{ id: string }>()

		const addRes = await app.fetch(
			new Request(`https://${domain}/api/v1/lists/${id}/accounts`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ account_ids: [member[mastodonIdSymbol]] }),
			}),
			{ DATABASE: db, data: { connectedActor } }
		)
		await assertStatus(addRes, 200)
		const accounts = await addRes.json<Array<{ id: string }>>()
		assert.equal(accounts.length, 1)
		assert.equal(accounts[0]?.id, member[mastodonIdSymbol])

		const removeRes = await app.fetch(
			new Request(`https://${domain}/api/v1/lists/${id}/accounts`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ account_ids: [member[mastodonIdSymbol]] }),
			}),
			{ DATABASE: db, data: { connectedActor } }
		)
		await assertStatus(removeRes, 200)
		const remaining = await removeRes.json<unknown[]>()
		assert.equal(remaining.length, 0)
	})
})
