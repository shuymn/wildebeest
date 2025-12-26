import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import {
	assertStatus,
	makeDB,
	createTestUser,
	assertCORS,
	assertJSON,
	isUrlValid,
} from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek2'
const domain = 'cloudflare.com'

describe('/api/v1/accounts/verify_credentials', () => {
	test('missing identity', async () => {
		const data = {
			cloudflareAccess: {
				JWT: {
					getIdentity() {
						return null
					},
				},
			},
		}

		const req = new Request(`https://${domain}/api/v1/accounts/verify_credentials`)
		const res = await app.fetch(req, { data })
		await assertStatus(res, 401)
	})

	test('verify the credentials', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const connectedActor = actor

		process.env = {
			...process.env,
			DATABASE: db,
			data: { connectedActor },
		} as unknown as NodeJS.ProcessEnv
		const req = new Request(`https://${domain}/api/v1/accounts/verify_credentials`)
		const res = await app.fetch(req, { DATABASE: db, data: { connectedActor } })
		await assertStatus(res, 200)
		assertCORS(res)
		assertJSON(res)

		const data = await res.json<any>()
		assert.equal(data.display_name, 'sven')
		// Mastodon app expects the id to be a number (as string), it uses
		// it to construct an URL. ActivityPub uses URL as ObjectId so we
		// make sure we don't return the URL.
		assert(!isUrlValid(data.id))
	})
})
