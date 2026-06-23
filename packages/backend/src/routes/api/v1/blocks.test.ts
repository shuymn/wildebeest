import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { acceptFollowing, addFollowing } from '@wildebeest/backend/mastodon/follow'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import {
	assertStatus,
	assertJSON,
	createTestUser,
	makeCache,
	makeDB,
	makeDOCache,
} from '@wildebeest/backend/test/utils'
import { MastodonStatus } from '@wildebeest/backend/types'

const userKEK = 'test_kek_blocks'
const domain = 'cloudflare.com'

describe('/api/v1/blocks', () => {
	test('block, list, and unblock accounts', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'blocker@cloudflare.com')
		const target = await createTestUser(domain, db, userKEK, 'blocked@cloudflare.com')

		const blockRes = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${target[mastodonIdSymbol]}/block`, { method: 'POST' }),
			{ DATABASE: db, DO_CACHE: makeDOCache(), data: { connectedActor: actor } }
		)
		await assertStatus(blockRes, 200)
		const relationship = await blockRes.json<{ blocking: boolean }>()
		assert.equal(relationship.blocking, true)

		const res = await app.fetch(new Request(`https://${domain}/api/v1/blocks`), {
			DATABASE: db,
			data: { connectedActor: actor },
		})
		await assertStatus(res, 200)
		assertJSON(res)

		const data = await res.json<Array<{ id: string }>>()
		assert.equal(data.length, 1)
		assert.equal(data[0]?.id, target[mastodonIdSymbol])

		const unblockRes = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${target[mastodonIdSymbol]}/unblock`, { method: 'POST' }),
			{ DATABASE: db, DO_CACHE: makeDOCache(), data: { connectedActor: actor } }
		)
		await assertStatus(unblockRes, 200)
		const unblocked = await unblockRes.json<{ blocking: boolean }>()
		assert.equal(unblocked.blocking, false)
	})

	test('block removes existing follows in both directions', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'follow-blocker@cloudflare.com')
		const target = await createTestUser(domain, db, userKEK, 'follow-blocked@cloudflare.com')

		await addFollowing(domain, db, actor, target)
		await acceptFollowing(db, actor, target)
		await addFollowing(domain, db, target, actor)
		await acceptFollowing(db, target, actor)

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${target[mastodonIdSymbol]}/block`, { method: 'POST' }),
			{ DATABASE: db, DO_CACHE: makeDOCache(), data: { connectedActor: actor } }
		)
		await assertStatus(res, 200)
		const relationship = await res.json<{ blocking: boolean; following: boolean; followed_by: boolean }>()
		assert.equal(relationship.blocking, true)
		assert.equal(relationship.following, false)

		const row = await db.prepare(`SELECT count(*) as count FROM actor_following`).first<{ count: number }>()
		assert.equal(row?.count, 0)
	})

	test('block returns relationship when timeline regeneration fails', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'cache-failure-blocker@cloudflare.com')
		const target = await createTestUser(domain, db, userKEK, 'cache-failure-blocked@cloudflare.com')
		const failingCache = {
			async get<T>(): Promise<T | null> {
				return null
			},
			async put<T>(_key: string, _value: T): Promise<void> {
				throw new Error('cache write failed')
			},
		}

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${target[mastodonIdSymbol]}/block`, { method: 'POST' }),
			{ DATABASE: db, DO_CACHE: makeDOCache(failingCache), data: { connectedActor: actor } }
		)
		await assertStatus(res, 200)
		const relationship = await res.json<{ blocking: boolean }>()
		assert.equal(relationship.blocking, true)
	})

	test('block regenerates cached home timeline', async () => {
		const db = makeDB()
		const cache = makeCache()
		const actor = await createTestUser(domain, db, userKEK, 'cache-blocker@cloudflare.com')
		const target = await createTestUser(domain, db, userKEK, 'cache-blocked@cloudflare.com')
		const visible = await createTestUser(domain, db, userKEK, 'cache-visible@cloudflare.com')

		for (const account of [target, visible]) {
			await addFollowing(domain, db, actor, account)
			await acceptFollowing(db, actor, account)
			await createPublicStatus(domain, db, account, `post from ${account.preferredUsername}`)
		}
		await addFollowing(domain, db, target, actor)
		await acceptFollowing(db, target, actor)
		await createPublicStatus(domain, db, actor, 'post from blocker')
		await cache.put(actor.id.toString() + '/timeline/home', 'stale timeline')
		await cache.put(target.id.toString() + '/timeline/home', 'stale target timeline')

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${target[mastodonIdSymbol]}/block`, { method: 'POST' }),
			{ DATABASE: db, DO_CACHE: makeDOCache(cache), data: { connectedActor: actor } }
		)
		await assertStatus(res, 200)

		const timeline = await cache.get<MastodonStatus[]>(actor.id.toString() + '/timeline/home')
		assert.equal(
			timeline?.some((status) => status.account.username === 'cache-blocked'),
			false
		)
		assert.equal(
			timeline?.some((status) => status.account.username === 'cache-visible'),
			true
		)

		const targetTimeline = await cache.get<MastodonStatus[]>(target.id.toString() + '/timeline/home')
		assert.equal(
			targetTimeline?.some((status) => status.account.username === 'cache-blocker'),
			false
		)
	})

	test('self block is forbidden', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'self-blocker@cloudflare.com')

		const res = await app.fetch(
			new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/block`, { method: 'POST' }),
			{ DATABASE: db, data: { connectedActor: actor } }
		)
		await assertStatus(res, 403)
	})
})
