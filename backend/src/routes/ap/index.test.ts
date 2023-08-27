import app from 'wildebeest/backend/src'
import { assertStatus, assertCORS } from 'wildebeest/backend/test/utils'

test('CORS on OPTIONS', async () => {
	const request = new Request('https://example.com/ap/o/unknown-id', { method: 'OPTIONS' })

	const res = await app.request(request)
	await assertStatus(res, 204)
	assertCORS(res, request)
})
