import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { insertBlock } from '@wildebeest/backend/mastodon/block'
import { insertLike } from '@wildebeest/backend/mastodon/like'
import { createPrivateStatus, createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_bookmark'
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]/bookmark', () => {
	test('bookmark and unbookmark update API-visible state', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'bookmark@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'bookmarked status')

		const bookmarkRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/bookmark`, { method: 'POST' }),
			{
				DATABASE: db,
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(bookmarkRes, 200)
		const bookmarked = await bookmarkRes.json<{ bookmarked: boolean; favourited: boolean }>()
		assert.equal(bookmarked.bookmarked, true)
		assert.equal(bookmarked.favourited, false)

		const unbookmarkRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/unbookmark`, { method: 'POST' }),
			{ DATABASE: db, userKEK, data: { connectedActor: actor } }
		)
		await assertStatus(unbookmarkRes, 200)
		const unbookmarked = await unbookmarkRes.json<{ bookmarked: boolean }>()
		assert.equal(unbookmarked.bookmarked, false)

		const listRes = await app.fetch(new Request(`https://${domain}/api/v1/bookmarks`), {
			DATABASE: db,
			userKEK,
			data: { connectedActor: actor },
		})
		await assertStatus(listRes, 200)
		const statuses = await listRes.json<Array<{ id: string }>>()
		assert.deepEqual(statuses, [])
	})

	test('bookmarks list returns bookmarked statuses', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'bookmarks-list@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'listed bookmark')
		await insertLike(db, actor, note)

		const bookmarkRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/bookmark`, { method: 'POST' }),
			{
				DATABASE: db,
				userKEK,
				data: { connectedActor: actor },
			}
		)
		await assertStatus(bookmarkRes, 200)

		const res = await app.fetch(new Request(`https://${domain}/api/v1/bookmarks`), {
			DATABASE: db,
			userKEK,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)
		const statuses = await res.json<Array<{ id: string; bookmarked: boolean; favourited: boolean }>>()
		assert.equal(statuses.length, 1)
		assert.equal(statuses[0]?.id, note[mastodonIdSymbol])
		assert.equal(statuses[0]?.bookmarked, true)
		assert.equal(statuses[0]?.favourited, true)
	})

	test('bookmark rejects private status hidden from viewer before mutation', async () => {
		const db = makeDB()
		const author = await createTestUser(domain, db, userKEK, 'private-bookmark-author@cloudflare.com')
		const viewer = await createTestUser(domain, db, userKEK, 'private-bookmark-viewer@cloudflare.com')
		const note = await createPrivateStatus(domain, db, author, 'private bookmark')

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/bookmark`, { method: 'POST' }),
			{ DATABASE: db, userKEK, data: { connectedActor: viewer } }
		)
		await assertStatus(res, 404)

		const row = await db.prepare(`SELECT count(*) as count FROM bookmarks`).first<{ count: number }>()
		assert.equal(row?.count, 0)
	})

	test('bookmarks list hides statuses blocked after bookmarking', async () => {
		const db = makeDB()
		const viewer = await createTestUser(domain, db, userKEK, 'blocked-bookmark-viewer@cloudflare.com')
		const author = await createTestUser(domain, db, userKEK, 'blocked-bookmark-author@cloudflare.com')
		const note = await createPublicStatus(domain, db, author, 'blocked after bookmark')

		const bookmarkRes = await app.fetch(
			new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/bookmark`, { method: 'POST' }),
			{ DATABASE: db, userKEK, data: { connectedActor: viewer } }
		)
		await assertStatus(bookmarkRes, 200)
		await insertBlock(db, author, viewer)

		const res = await app.fetch(new Request(`https://${domain}/api/v1/bookmarks`), {
			DATABASE: db,
			userKEK,
			data: { connectedActor: viewer },
		})
		await assertStatus(res, 200)
		const statuses = await res.json<Array<{ id: string }>>()
		assert.equal(statuses.length, 0)
	})
})
