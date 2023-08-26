import mutes from 'wildebeest/backend/src/routes/api/v1/mutes'
import { assertStatus, assertJSON } from 'wildebeest/backend/test/utils'

describe('/api/v1/mutes', () => {
	test('mutes returns an empty array', async () => {
		const res = await mutes.request('/')
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<unknown[]>()
		expect(data.length).toBe(0)
	})
})
