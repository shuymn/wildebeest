import { strict as assert } from 'node:assert/strict'

import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import { createAnnounceActivity } from 'wildebeest/backend/src/activitypub/activities/announce'
import { createImage } from 'wildebeest/backend/src/activitypub/objects/image'
import { acceptFollowing, addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { insertHashtags } from 'wildebeest/backend/src/mastodon/hashtag'
import { insertLike } from 'wildebeest/backend/src/mastodon/like'
import { createReblog } from 'wildebeest/backend/src/mastodon/reblog'
import * as timelines from 'wildebeest/backend/src/mastodon/timeline'
import { createDirectStatus, createPublicStatus, createReply } from 'wildebeest/backend/test/shared.utils'
import * as timelines_home from 'wildebeest/functions/api/v1/timelines/home'
import * as timelines_public from 'wildebeest/functions/api/v1/timelines/public'

import { assertCORS, assertJSON, assertStatus, createTestUser, makeCache, makeDB } from '../utils'

const userKEK = 'test_kek6'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const domain = 'cloudflare.com'

describe('Mastodon APIs', () => {
	describe('timelines', () => {
		test('home returns Notes in following Actors', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')

			// Actor is following actor2, but not actor3.
			await addFollowing(domain, db, actor, actor2)
			await acceptFollowing(db, actor, actor2)

			// Actor 2 is posting
			const firstNoteFromActor2 = await createPublicStatus(domain, db, actor2, 'first status from actor2', [], {
				published: '2021-01-01T00:00:00.000Z',
			})
			await createPublicStatus(domain, db, actor2, 'second status from actor2', [], {
				published: '2021-01-01T00:00:00.001Z',
			})
			await createPublicStatus(domain, db, actor3, 'first status from actor3', [], {
				published: '2021-01-01T00:00:00.002Z',
			})

			await insertLike(db, actor, firstNoteFromActor2)
			await createReblog(db, actor, firstNoteFromActor2, {
				to: [PUBLIC_GROUP],
				cc: [],
				id: 'https://example.com/activity',
			})

			// Actor should only see posts from actor2 in the timeline
			const connectedActor: any = actor
			const data = await timelines.getHomeTimeline(domain, db, connectedActor)
			assert.equal(data.length, 3)
			assert(data[0].id)
			assert.equal(data[0].content, '')
			assert.equal(data[0].account.username, 'sven')
			assert.equal(data[0].reblog?.content, 'first status from actor2')
			assert.equal(data[0].reblog?.account.username, 'sven2')
			assert.equal(data[1].content, 'second status from actor2')
			assert.equal(data[1].account.username, 'sven2')
			assert.equal(data[2].content, 'first status from actor2')
			assert.equal(data[2].account.username, 'sven2')
			assert.equal(data[2].favourites_count, 1)
			assert.equal(data[2].reblogs_count, 1)
		})

		test("home doesn't show private Notes from followed actors", async () => {
			const db = await makeDB()
			const actor1 = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')

			// actor3 follows actor1 and actor2
			await addFollowing(domain, db, actor3, actor1)
			await acceptFollowing(db, actor3, actor1)
			await addFollowing(domain, db, actor3, actor2)
			await acceptFollowing(db, actor3, actor2)

			// actor2 sends a DM to actor1
			await createDirectStatus(domain, db, actor2, 'DM', [], { to: [actor1] })

			// actor3 shouldn't see the private note
			const data = await timelines.getHomeTimeline(domain, db, actor3)
			assert.equal(data.length, 0)
		})

		test("home returns Notes sent to Actor's followers", async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')

			// Actor is following actor2
			await addFollowing(domain, db, actor, actor2)
			await acceptFollowing(db, actor, actor2)

			// Actor 2 is posting
			await createPublicStatus(domain, db, actor2, 'test post')

			// Actor should only see posts from actor2 in the timeline
			const data = await timelines.getHomeTimeline(domain, db, actor)
			assert.equal(data.length, 1)
			assert.equal(data[0].content, 'test post')
		})

		test("public doesn't show private Notes", async () => {
			const db = await makeDB()
			const actor1 = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')

			// actor2 sends a DM to actor1
			await createDirectStatus(domain, db, actor2, 'DM', [], { to: [actor1] })

			const data = await timelines.getPublicTimeline(domain, db, timelines.LocalPreference.NotSet, false, 20)
			assert.equal(data.length, 0)
		})

		test('home returns Notes from ourself', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			// Actor is posting
			await createPublicStatus(domain, db, actor, 'status from myself')

			// Actor should only see posts from actor2 in the timeline
			const connectedActor = actor
			const data = await timelines.getHomeTimeline(domain, db, connectedActor)
			assert.equal(data.length, 1)
			assert(data[0].id)
			assert.equal(data[0].content, 'status from myself')
			assert.equal(data[0].account.username, 'sven')
		})

		test('home returns cache', async () => {
			const db = await makeDB()
			const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const cache = makeCache()
			await cache.put(connectedActor.id + '/timeline/home', 12345)

			const req = new Request('https://' + domain)
			const data = await timelines_home.handleRequest(req, cache, connectedActor)
			assert.equal(await data.json(), 12345)
		})

		test('home returns empty if not in cache', async () => {
			const db = await makeDB()
			const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const cache = makeCache()
			const req = new Request('https://' + domain)
			const data = await timelines_home.handleRequest(req, cache, connectedActor)
			const posts = await data.json<Array<any>>()

			assert.equal(posts.length, 0)
		})

		test('public returns Notes', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')

			const statusFromActor = await createPublicStatus(domain, db, actor, 'status from actor', [], {
				published: '2021-01-01T00:00:00.000Z',
			})
			await sleep(10)
			await createPublicStatus(domain, db, actor2, 'status from actor2', [], { published: '2021-01-01T00:00:00.001Z' })

			await insertLike(db, actor, statusFromActor)
			await createReblog(db, actor, statusFromActor, {
				to: [PUBLIC_GROUP],
				cc: [],
				id: 'https://example.com/activity',
			})

			const res = await timelines_public.handleRequest(
				{ domain, db },
				{ local: false, remote: false, only_media: false, limit: 20 }
			)
			await assertStatus(res, 200)
			assertJSON(res)
			assertCORS(res)

			const data = await res.json<any>()
			assert.equal(data.length, 3)
			assert(data[0].id)
			assert.equal(data[0].content, '')
			assert.equal(data[0].account.username, 'sven')
			assert.equal(data[0].reblog.content, 'status from actor')
			assert.equal(data[0].reblog.account.username, 'sven')

			assert.equal(data[1].content, 'status from actor2')
			assert.equal(data[1].account.username, 'sven2')

			assert.equal(data[2].content, 'status from actor')
			assert.equal(data[2].account.username, 'sven')
			assert.equal(data[2].favourites_count, 1)
			assert.equal(data[2].reblogs_count, 1)

			// if we request only remote objects nothing should be returned
			const remoteRes = await timelines_public.handleRequest(
				{ domain, db },
				{
					local: false,
					remote: true,
					only_media: false,
					limit: 20,
				}
			)
			assert.equal(remoteRes.status, 200)
			assertJSON(remoteRes)
			assertCORS(remoteRes)
			const remoteData = await remoteRes.json<any>()
			assert.equal(remoteData.length, 0)
		})

		test('public includes attachment', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const properties = { url: 'https://example.com/image.jpg' }
			const mediaAttachments = [await createImage(domain, db, actor, properties)]
			await createPublicStatus(domain, db, actor, 'status from actor', mediaAttachments)

			const res = await timelines_public.handleRequest(
				{ domain, db },
				{ local: false, remote: false, only_media: false, limit: 20 }
			)
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.length, 1)
			assert.equal(data[0].media_attachments.length, 1)
			assert.equal(data[0].media_attachments[0].type, 'image')
			assert.equal(data[0].media_attachments[0].url, properties.url)
		})

		test('public timeline uses published_date', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			await createPublicStatus(domain, db, actor, 'note1', [], { published: '2021-01-01T00:00:00.001Z' })
			await createPublicStatus(domain, db, actor, 'note2', [], { published: '2021-01-01T00:00:00.000Z' })
			await createPublicStatus(domain, db, actor, 'note3', [], { published: '2021-01-01T00:00:00.002Z' })

			const res = await timelines_public.handleRequest(
				{ domain, db },
				{ local: false, remote: false, only_media: false, limit: 20 }
			)
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data[0].content, 'note3')
			assert.equal(data[1].content, 'note1')
			assert.equal(data[2].content, 'note2')
		})

		test('home timelines do not hides and counts public replies', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const note = await createPublicStatus(domain, db, actor, 'a post')

			await sleep(10)

			await createReply(domain, db, actor, note, 'a reply')

			const connectedActor: any = actor

			{
				const data = await timelines.getHomeTimeline(domain, db, connectedActor)
				assert.equal(data.length, 2)
				assert.equal(data[0].content, 'a reply')
				assert.equal(data[0].replies_count, 0)
				assert.equal(data[1].content, 'a post')
				assert.equal(data[1].replies_count, 1)
			}

			{
				const data = await timelines.getPublicTimeline(domain, db, timelines.LocalPreference.NotSet, false, 20)
				assert.equal(data.length, 1)
				assert.equal(data[0].content, 'a post')
				assert.equal(data[0].replies_count, 1)
			}
		})

		test('show status reblogged', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const note = await createPublicStatus(domain, db, actor, 'a post', [], { published: '2021-01-01T00:00:00.000Z' })
			await createReblog(db, actor, note, {
				to: [PUBLIC_GROUP],
				cc: [],
				id: 'https://example.com/activity',
			})

			const connectedActor: any = actor

			const data = await timelines.getHomeTimeline(domain, db, connectedActor)
			assert.equal(data.length, 2)
			assert.equal(data[1].reblogged, true)
		})

		test('show status favourited', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const note = await createPublicStatus(domain, db, actor, 'a post')
			await insertLike(db, actor, note)

			const connectedActor: any = actor

			const data = await timelines.getHomeTimeline(domain, db, connectedActor)
			assert.equal(data.length, 1)
			assert.equal(data[0].favourited, true)
		})

		test('show reblogs as independent notes', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actorA = await createTestUser(domain, db, userKEK, 'svenA@cloudflare.com')
			const actorB = await createTestUser(domain, db, userKEK, 'svenB@cloudflare.com')

			// Actor posts
			const note = await createPublicStatus(domain, db, actor, 'a post')

			const activityA = await createAnnounceActivity(db, domain, actorA, note.id, new Set([PUBLIC_GROUP]), new Set())
			const activityB = await createAnnounceActivity(db, domain, actorB, note.id, new Set([PUBLIC_GROUP]), new Set())

			// ActorA and B reblog the post
			await createReblog(db, actorA, note, activityA, activityA.published)
			await createReblog(db, actorB, note, activityB, activityB.published)

			const data = await timelines.getPublicTimeline(domain, db, timelines.LocalPreference.NotSet, false, 20)
			assert.equal(data.length, 3)
		})

		test('timeline with non exitent tag', async () => {
			const db = await makeDB()

			const data = await timelines.getPublicTimeline(
				domain,
				db,
				timelines.LocalPreference.NotSet,
				false,
				20,
				'non-existent-tag'
			)
			assert.equal(data.length, 0)
		})

		test('timeline tag', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			{
				const note = await createPublicStatus(domain, db, actor, 'test 1', [], {
					published: '2021-01-01T00:00:00.000Z',
				})
				await insertHashtags(db, note, ['test', 'a'])
			}
			await sleep(10)
			{
				const note = await createPublicStatus(domain, db, actor, 'test 2')
				await insertHashtags(db, note, ['test', 'b'])
			}

			{
				const data = await timelines.getPublicTimeline(
					domain,
					db,
					timelines.LocalPreference.NotSet,
					false,
					20,
					undefined,
					undefined,
					'test'
				)
				assert.equal(data.length, 2)
				assert.equal(data[0].content, 'test 2')
				assert.equal(data[1].content, 'test 1')
			}

			{
				const data = await timelines.getPublicTimeline(
					domain,
					db,
					timelines.LocalPreference.NotSet,
					false,
					20,
					undefined,
					undefined,
					'a'
				)
				assert.equal(data.length, 1)
				assert.equal(data[0].content, 'test 1')
			}
		})
	})
})
