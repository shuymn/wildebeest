import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { insertBookmark } from '@wildebeest/backend/mastodon/bookmark'
import { insertLike } from '@wildebeest/backend/mastodon/like'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_unfavourite'
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]/unfavourite', () => {
	test('unfavourite removes favourite and favourites list returns favourites', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'unfavourite@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'favourited status')
		await insertLike(db, actor, note)
		await insertBookmark(db, actor, note)

		const listRes = await app.fetch(new Request(`https://${domain}/api/v1/favourites`), {
			DATABASE: db,
			userKEK,
			data: { connectedActor: actor },
		})
		await assertStatus(listRes, 200)
		const statuses = await listRes.json<Array<{ id: string; favourited: boolean; bookmarked: boolean }>>()
		assert.equal(statuses.length, 1)
		assert.equal(statuses[0]?.id, note[mastodonIdSymbol])
		assert.equal(statuses[0]?.favourited, true)
		assert.equal(statuses[0]?.bookmarked, true)

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/unfavourite`, { method: 'POST' }),
			{
				DATABASE: db,
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(res, 200)
		const data = await res.json<{ favourited: boolean; bookmarked: boolean }>()
		assert.equal(data.favourited, false)
		assert.equal(data.bookmarked, true)

		const emptyListRes = await app.fetch(new Request(`https://${domain}/api/v1/favourites`), {
			DATABASE: db,
			userKEK,
			data: { connectedActor: actor },
		})
		await assertStatus(emptyListRes, 200)
		const emptyStatuses = await emptyListRes.json<Array<{ id: string }>>()
		assert.deepEqual(emptyStatuses, [])
	})
})
