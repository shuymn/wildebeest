import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
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
		expect(lists).toEqual([])
	})
})
