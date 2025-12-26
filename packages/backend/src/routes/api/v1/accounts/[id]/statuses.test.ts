import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import {
	cacheActivityObject,
	getActivityObject,
	isAnnounceActivity,
	isCreateActivity,
	PUBLIC_GROUP,
} from '@wildebeest/backend/activitypub/activities'
import { getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { addObjectInOutbox, get } from '@wildebeest/backend/activitypub/actors/outbox'
import { getApId, getObjectById, mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { createImage } from '@wildebeest/backend/activitypub/objects/image'
import { isNote, Note } from '@wildebeest/backend/activitypub/objects/note'
import { insertLike } from '@wildebeest/backend/mastodon/like'
import { createReblog } from '@wildebeest/backend/mastodon/reblog'
import { createPublicStatus, createReply } from '@wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, assertStatus } from '@wildebeest/backend/test/utils'
import { isUUID } from '@wildebeest/backend/utils'
import { queryAcct } from '@wildebeest/backend/webfinger'

const userKEK = 'test_kek2'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const domain = 'cloudflare.com'

describe('/api/v1/accounts/[id]/statuses', () => {
	test('get local actor statuses', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const firstNote = await createPublicStatus(domain, db, actor, 'my first status')
		await insertLike(db, actor, firstNote)
		await sleep(5)
		const secondNote = await createPublicStatus(domain, db, actor, 'my second status')
		await sleep(5)
		await createReblog(db, actor, secondNote, { to: [PUBLIC_GROUP], cc: [], id: 'https://example.com/activity' })

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/statuses`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<
			{
				id: string
				content: unknown
				account: { acct: unknown }
				favourites_count: unknown
				reblogs_count: unknown
				reblog: Record<string, unknown>
				uri: string
				url: string
			}[]
		>()
		assert.equal(data.length, 3)

		assert(!isUUID(data[0].id) && !isNaN(Number(data[0].id)), data[0].id)
		assert.equal(data[0].content, '')
		assert.equal(data[0].account.acct, 'sven')
		assert.equal(data[0].favourites_count, 0)
		assert.equal(data[0].reblogs_count, 0)
		assert.equal(data[0].uri, 'https://example.com/activity')
		assert.equal(data[0].reblog.content, '<p>my second status</p>')

		assert(!isUUID(data[1].id) && !isNaN(Number(data[1].id)), data[1].id)
		assert.equal(data[1].content, '<p>my second status</p>')
		assert.equal(data[1].account.acct, 'sven')
		assert.equal(data[1].favourites_count, 0)
		assert.equal(data[1].reblogs_count, 1)
		assert.equal(new URL(data[1].url).pathname, '/@sven/' + data[1].id)

		assert(!isUUID(data[2].id) && !isNaN(Number(data[2].id)), data[2].id)
		assert.equal(data[2].content, '<p>my first status</p>')
		assert.equal(data[2].favourites_count, 1)
		assert.equal(data[2].reblogs_count, 0)
	})

	test("get local actor statuses doesn't include replies", async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'a post')
		await sleep(10)
		await createReply(domain, db, actor, note, '@sven@cloudflare.com a reply')

		const req = new Request(
			`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/statuses?exclude_replies=true`
		)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<unknown[]>()

		// Only 1 post because the reply is hidden
		assert.equal(data.length, 1)
	})

	test('get local actor statuses includes media attachements', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const properties = { url: 'https://example.com/image.jpg', type: 'Image' as const }
		const mediaAttachments = [await createImage(domain, db, actor, properties)]
		await createPublicStatus(domain, db, actor, 'status from actor', mediaAttachments)

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/statuses`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<{ media_attachments: { type: unknown; url: unknown }[] }[]>()

		assert.equal(data.length, 1)
		assert.equal(data[0].media_attachments.length, 1)
		assert.equal(data[0].media_attachments[0].type, 'image')
		assert.equal(data[0].media_attachments[0].url, properties.url)
	})

	test('get pinned statuses', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/statuses?pinned=true`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<unknown[]>()
		assert.equal(data.length, 0)
	})

	test('get local actor statuses with max_id', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		await db
			.prepare("INSERT INTO objects (id, type, properties, local, mastodon_id) VALUES (?, ?, ?, 1, 'mastodon_id')")
			.bind('https://example.com/object1', 'Note', JSON.stringify({ content: 'my first status' }))
			.run()
		await db
			.prepare("INSERT INTO objects (id, type, properties, local, mastodon_id) VALUES (?, ?, ?, 1, 'mastodon_id2')")
			.bind('https://example.com/object2', 'Note', JSON.stringify({ content: 'my second status' }))
			.run()
		await db
			.prepare('INSERT INTO outbox_objects (id, actor_id, object_id, cdate, [to]) VALUES (?, ?, ?, ?, ?)')
			.bind(
				'outbox1',
				actor.id.toString(),
				'https://example.com/object1',
				'2022-12-16 08:14:48',
				JSON.stringify([PUBLIC_GROUP])
			)
			.run()
		await db
			.prepare('INSERT INTO outbox_objects (id, actor_id, object_id, cdate, [to]) VALUES (?, ?, ?, ?, ?)')
			.bind(
				'outbox2',
				actor.id.toString(),
				'https://example.com/object2',
				'2022-12-16 10:14:48',
				JSON.stringify([PUBLIC_GROUP])
			)
			.run()

		{
			// Query statuses before object2, should only see object1.
			const req = new Request(
				`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/statuses?max_id=mastodon_id2`
			)
			const res = await app.fetch(req, { DATABASE: db })
			await assertStatus(res, 200)

			const data = await res.json<{ content: unknown; account: { acct: unknown } }[]>()
			assert.equal(data.length, 1)
			assert.equal(data[0].content, 'my first status')
			assert.equal(data[0].account.acct, 'sven')
		}

		{
			// Query statuses before object1, nothing is after.
			const req = new Request(
				`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/statuses?max_id=mastodon_id`
			)
			const res = await app.fetch(req, { DATABASE: db })
			await assertStatus(res, 200)

			const data = await res.json<unknown[]>()
			assert.equal(data.length, 0)
		}
	})

	test('get local actor statuses with max_id poiting to unknown id', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const req = new Request(`https://${domain}/api/v1/accounts/${actor[mastodonIdSymbol]}/statuses?max_id=object1`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 404)
	})

	test('get remote actor statuses', async () => {
		const db = makeDB()

		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')

		const note = await createPublicStatus(domain, db, actorA, 'my localnote status')

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://social.com/.well-known/webfinger?resource=acct%3Asomeone%40social.com') {
					return new Response(
						JSON.stringify({
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: 'https://social.com/users/someone',
								},
							],
						})
					)
				}

				if (input.toString() === 'https://social.com/users/someone') {
					return new Response(
						JSON.stringify({
							id: 'https://social.com/users/someone',
							type: 'Person',
							preferredUsername: 'someone',
							outbox: 'https://social.com/outbox',
						})
					)
				}

				if (input.toString() === 'https://social.com/outbox') {
					return new Response(
						JSON.stringify({
							first: 'https://social.com/outbox/page1',
						})
					)
				}

				if (input.toString() === 'https://social.com/outbox/page1') {
					return new Response(
						JSON.stringify({
							orderedItems: [
								{
									id: 'https://mastodon.social/users/a/statuses/b/activity',
									type: 'Create',
									actor: 'https://social.com/users/someone',
									published: '2022-12-10T23:48:38Z',
									to: [PUBLIC_GROUP],
									object: {
										id: 'https://example.com/object1',
										type: 'Note',
										content: '<p>p</p>',
										attachment: [
											{
												id: '',
												type: 'Document',
												mediaType: 'image/jpeg',
												url: 'https://example.com/image',
												blurhash: 'U48;V;_24mx[_1~p.7%MW9?a-;xtxvWBt6ad',
												width: 1080,
												height: 894,
											},
											{
												id: '',
												type: 'Document',
												mediaType: 'video/mp4',
												url: 'https://example.com/video',
												blurhash: 'UB9jfvtT0gO^N5tSX4XV9uR%^Ni]D%Rj$*nf',
												width: 1080,
												height: 616,
											},
										],
										to: [],
										cc: [],
										attributedTo: 'https://social.com/users/someone',
										sensitive: false,
									} satisfies Note,
								},
								{
									id: 'https://mastodon.social/users/c/statuses/d/activity',
									type: 'Announce',
									actor: 'https://social.com/users/someone',
									published: '2022-12-10T23:48:38Z',
									to: [PUBLIC_GROUP],
									object: note.id,
								},
							],
						})
					)
				}

				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const actorB = await queryAcct({ localPart: 'someone', domain: 'social.com' }, db)
		assert.ok(actorB)
		const collection = await get(actorB)
		for (const item of collection.items) {
			if (isCreateActivity(item)) {
				const actor = await getAndCacheActor(getApId(item.actor), db)
				assert.ok(actor)
				const res = await cacheActivityObject(domain, db, getActivityObject(item), actor)
				assert.ok(res)
				assert.ok(res.object)
				// Date in the past to create the order
				await addObjectInOutbox(db, actorB, res.object, item.to, item.cc, '2022-12-10T23:48:38Z')
			}
			if (isAnnounceActivity(item)) {
				const objectId = getApId(item.object)
				const obj = await getObjectById<Note>(domain, db, objectId)
				assert.ok(obj)
				assert.ok(isNote(obj))
				await createReblog(db, actorB, obj, item)
			}
		}

		const req = new Request(`https://${domain}/api/v1/accounts/${actorB[mastodonIdSymbol]}/statuses`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data =
			await res.json<{ content: unknown; account: { username: unknown }; media_attachments: { type: unknown }[] }[]>()
		assert.equal(data.length, 2)
		assert.equal(data[1].content, '<p>p</p>')
		assert.equal(data[1].account.username, 'someone')

		assert.equal(data[1].media_attachments.length, 2)
		assert.equal(data[1].media_attachments[0].type, 'image')
		assert.equal(data[1].media_attachments[1].type, 'video')

		// Statuses were imported locally and once was a reblog of an already
		// existing local object.
		const { count } = await db
			.prepare(`SELECT count(*) as count FROM objects`)
			.first<{ count: number }>()
			.then((row) => {
				assert.ok(row)
				return row
			})
		assert.equal(count, 2)
	})
})
