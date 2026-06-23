import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { assertStatus, assertJSON, createTestUser, makeDB, makeDOCache } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_mutes'
const domain = 'cloudflare.com'

describe('/api/v1/mutes', () => {
	test('mute, list, and unmute accounts', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'muter@cloudflare.com')
		const target = await createTestUser(domain, db, userKEK, 'muted@cloudflare.com')

		const muteRes = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${target[mastodonIdSymbol]}/mute`, { method: 'POST' }),
			{ DATABASE: db, DO_CACHE: makeDOCache(), data: { connectedActor: actor } }
		)
		await assertStatus(muteRes, 200)
		const relationship = await muteRes.json<{ muting: boolean; muting_notifications: boolean }>()
		assert.equal(relationship.muting, true)
		assert.equal(relationship.muting_notifications, true)

		const res = await app.fetch(new Request(`https://${domain}/api/v1/mutes`), {
			DATABASE: db,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<Array<{ id: string }>>()
		assert.equal(data.length, 1)
		assert.equal(data[0]?.id, target[mastodonIdSymbol])

		const unmuteRes = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${target[mastodonIdSymbol]}/unmute`, { method: 'POST' }),
			{ DATABASE: db, DO_CACHE: makeDOCache(), data: { connectedActor: actor } }
		)
		await assertStatus(unmuteRes, 200)
		const unmuted = await unmuteRes.json<{ muting: boolean }>()
		assert.equal(unmuted.muting, false)
	})

	test('self mute is forbidden', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'self-muter@cloudflare.com')

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/mute`, { method: 'POST' }),
			{ DATABASE: db, data: { connectedActor: actor } }
		)
		await assertStatus(res, 403)
	})

	test('mute persists notification preference in relationships', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'muter-notifications@cloudflare.com')
		const target = await createTestUser(domain, db, userKEK, 'muted-notifications@cloudflare.com')

		const muteRes = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${target[mastodonIdSymbol]}/mute`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ notifications: false }),
			}),
			{ DATABASE: db, DO_CACHE: makeDOCache(), data: { connectedActor: actor } }
		)
		await assertStatus(muteRes, 200)
		const muted = await muteRes.json<{ muting: boolean; muting_notifications: boolean }>()
		assert.equal(muted.muting, true)
		assert.equal(muted.muting_notifications, false)

		const relationshipsRes = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/relationships?id[]=${target[mastodonIdSymbol]}`),
			{ DATABASE: db, data: { connectedActor: actor } }
		)
		await assertStatus(relationshipsRes, 200)

		const relationships = await relationshipsRes.json<Array<{ muting: boolean; muting_notifications: boolean }>>()
		assert.equal(relationships[0].muting, true)
		assert.equal(relationships[0].muting_notifications, false)

		const remuteRes = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${target[mastodonIdSymbol]}/mute`, { method: 'POST' }),
			{ DATABASE: db, DO_CACHE: makeDOCache(), data: { connectedActor: actor } }
		)
		await assertStatus(remuteRes, 200)
		const remuted = await remuteRes.json<{ muting: boolean; muting_notifications: boolean }>()
		assert.equal(remuted.muting, true)
		assert.equal(remuted.muting_notifications, true)
	})
})
