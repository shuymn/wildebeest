import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { addAccountsToList, createList } from '@wildebeest/backend/mastodon/list'
import { assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/[id]/lists', () => {
	test('returns empty lists for account not in any list', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')
		const targetActor = await createTestUser(domain, db, userKEK, 'target@cloudflare.com')

		const req = new Request(`https://${domain}/api/v1/accounts/${targetActor[mastodonIdSymbol]}/lists`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)
		const lists = await res.json<unknown[]>()
		assert.equal(lists.length, 0)
	})

	test('returns lists containing the account', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'list-owner-api@cloudflare.com')
		const targetActor = await createTestUser(domain, db, userKEK, 'list-target@cloudflare.com')

		const list = await createList(db, connectedActor.id.toString(), 'Colleagues')
		await addAccountsToList(db, list.id, connectedActor.id.toString(), [targetActor[mastodonIdSymbol]])

		const req = new Request(`https://${domain}/api/v1/accounts/${targetActor[mastodonIdSymbol]}/lists`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)
		const lists = await res.json<Array<{ id: string; title: string }>>()
		assert.equal(lists.length, 1)
		assert.equal(lists[0]?.id, list.id)
		assert.equal(lists[0]?.title, 'Colleagues')
	})
})
