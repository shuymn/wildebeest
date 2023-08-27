import app from 'wildebeest/backend/src'
import { assertStatus, createTestUser, makeDB } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/[id]/lists', () => {
	test('get remote actor lists', async () => {
		const db = await makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')

		const req = new Request(`https://${domain}/api/v1/accounts/1/lists`)
		const res = await app.fetch(req, { data: { connectedActor } })
		await assertStatus(res, 200)
	})
})
