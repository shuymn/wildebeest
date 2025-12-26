import app from '@wildebeest/backend'
import { assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/[id]/featured_tags', () => {
	test('get remote actor featured_tags', async () => {
		const db = makeDB()
		const connectedActor = await createTestUser(domain, db, userKEK, 'someone@example.com')

		const req = new Request(`https://${domain}/api/v1/accounts/1/featured_tags`)
		const res = await app.fetch(req, { data: { connectedActor } })
		await assertStatus(res, 200)
	})
})
