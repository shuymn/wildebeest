import { strict as assert } from 'node:assert/strict'

import {
	cacheActivityObject,
	getActivityObject,
	isAnnounceActivity,
	isCreateActivity,
	PUBLIC_GROUP,
} from 'wildebeest/backend/src/activitypub/activities'
import { getActorById } from 'wildebeest/backend/src/activitypub/actors'
import { addObjectInOutbox, get } from 'wildebeest/backend/src/activitypub/actors/outbox'
import { getApId, getObjectById, mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { createImage } from 'wildebeest/backend/src/activitypub/objects/image'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { acceptFollowing, addFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { insertLike } from 'wildebeest/backend/src/mastodon/like'
import { createReblog } from 'wildebeest/backend/src/mastodon/reblog'
import { MessageType } from 'wildebeest/backend/src/types'
import { isUUID } from 'wildebeest/backend/src/utils'
import { queryAcct } from 'wildebeest/backend/src/webfinger'
import { createPublicStatus, createReply } from 'wildebeest/backend/test/shared.utils'
import * as accounts_get from 'wildebeest/functions/api/v1/accounts/[id]'
import * as accounts_featured_tags from 'wildebeest/functions/api/v1/accounts/[id]/featured_tags'
import * as accounts_follow from 'wildebeest/functions/api/v1/accounts/[id]/follow'
import * as accounts_followers from 'wildebeest/functions/api/v1/accounts/[id]/followers'
import * as accounts_following from 'wildebeest/functions/api/v1/accounts/[id]/following'
import * as accounts_lists from 'wildebeest/functions/api/v1/accounts/[id]/lists'
import * as accounts_statuses from 'wildebeest/functions/api/v1/accounts/[id]/statuses'
import * as accounts_unfollow from 'wildebeest/functions/api/v1/accounts/[id]/unfollow'
import * as lookup from 'wildebeest/functions/api/v1/accounts/lookup'
import * as accounts_relationships from 'wildebeest/functions/api/v1/accounts/relationships'
import * as accounts_update_creds from 'wildebeest/functions/api/v1/accounts/update_credentials'
import * as accounts_verify_creds from 'wildebeest/functions/api/v1/accounts/verify_credentials'
import * as filters from 'wildebeest/functions/api/v1/filters'
import * as preferences from 'wildebeest/functions/api/v1/preferences'

import { assertCORS, assertJSON, assertStatus, createTestUser, isUrlValid, makeDB, makeQueue } from '../utils'

const userKEK = 'test_kek2'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const domain = 'cloudflare.com'

describe('Mastodon APIs', () => {
	describe('accounts', () => {
		beforeEach(() => {
			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://remote.com/.well-known/webfinger?resource=acct%3Asven%40remote.com') {
						return new Response(
							JSON.stringify({
								links: [
									{
										rel: 'self',
										type: 'application/activity+json',
										href: 'https://social.com/sven',
									},
								],
							})
						)
					}

					if (input.toString() === 'https://social.com/sven') {
						return new Response(
							JSON.stringify({
								id: 'sven@remote.com',
								type: 'Person',
								preferredUsername: 'sven',
								name: 'sven ssss',

								icon: { url: 'icon.jpg' },
								image: { url: 'image.jpg' },
							})
						)
					}

					throw new Error('unexpected request to ' + input.toString)
				}
				throw new Error('unexpected request to ' + input.url)
			}
		})

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

			const context: any = { data }
			const res = await accounts_verify_creds.onRequest(context)
			await assertStatus(res, 401)
		})

		test('verify the credentials', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const connectedActor = actor

			const context: any = { data: { connectedActor }, env: { DATABASE: db } }
			const res = await accounts_verify_creds.onRequest(context)
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

		test('update credentials', async () => {
			const db = await makeDB()
			const queue = makeQueue()
			const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const updates = new FormData()
			updates.set('display_name', 'newsven')
			updates.set('note', 'hein')

			const req = new Request('https://example.com', {
				method: 'PATCH',
				body: updates,
			})
			const res = await accounts_update_creds.handleRequest(
				db,
				req,
				connectedActor,
				'CF_ACCOUNT_ID',
				'CF_API_TOKEN',
				userKEK,
				queue
			)
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.display_name, 'newsven')
			assert.equal(data.note, 'hein')

			const updatedActor: any = await getActorById(db, getApId(connectedActor))
			assert(updatedActor)
			assert.equal(updatedActor.name, 'newsven')
			assert.equal(updatedActor.summary, 'hein')
		})

		test('update credentials sends update to follower', async () => {
			const db = await makeDB()
			const queue = makeQueue()
			const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			await addFollowing(domain, db, actor2, connectedActor)
			await acceptFollowing(db, actor2, connectedActor)

			const updates = new FormData()
			updates.set('display_name', 'newsven')

			const req = new Request('https://example.com', {
				method: 'PATCH',
				body: updates,
			})
			const res = await accounts_update_creds.handleRequest(
				db,
				req,
				connectedActor,
				'CF_ACCOUNT_ID',
				'CF_API_TOKEN',
				userKEK,
				queue
			)
			await assertStatus(res, 200)

			assert.equal(queue.messages.length, 1)

			assert.equal(queue.messages[0].type, MessageType.Deliver)
			assert.equal(queue.messages[0].activity.type, 'Update')
			assert.equal(queue.messages[0].actorId, connectedActor.id.toString())
			assert.equal(queue.messages[0].toActorId, actor2.id.toString())
		})

		test('update credentials avatar and header', async () => {
			globalThis.fetch = async (input: RequestInfo, data: any) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input === 'https://api.cloudflare.com/client/v4/accounts/CF_ACCOUNT_ID/images/v1') {
						assert.equal(data.method, 'POST')
						const file: any = (data.body as { get: (str: string) => any }).get('file')
						return new Response(
							JSON.stringify({
								success: true,
								result: {
									variants: [
										'https://example.com/' + file.name + '/avatar',
										'https://example.com/' + file.name + '/header',
									],
								},
							})
						)
					}
					throw new Error('unexpected request to ' + input.toString())
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const db = await makeDB()
			const queue = makeQueue()
			const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const updates = new FormData()
			updates.set('avatar', new File(['bytes'], 'selfie.jpg', { type: 'image/jpeg' }))
			updates.set('header', new File(['bytes2'], 'mountain.jpg', { type: 'image/jpeg' }))

			const req = new Request('https://example.com', {
				method: 'PATCH',
				body: updates,
			})
			const res = await accounts_update_creds.handleRequest(
				db,
				req,
				connectedActor,
				'CF_ACCOUNT_ID',
				'CF_API_TOKEN',
				userKEK,
				queue
			)
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.avatar, 'https://example.com/selfie.jpg/avatar')
			assert.equal(data.header, 'https://example.com/mountain.jpg/header')
		})

		test('lookup unknown remote actor', async () => {
			const db = await makeDB()
			const res = await lookup.handleRequest({ domain, db }, 'sven@social.com')
			await assertStatus(res, 404)
		})

		test('lookup unknown local actor', async () => {
			const db = await makeDB()
			const res = await lookup.handleRequest({ domain, db }, 'sven')
			await assertStatus(res, 404)
		})

		test('lookup remote actor', async () => {
			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://social.com/.well-known/webfinger?resource=acct%3Asomeone%40social.com') {
						return new Response(
							JSON.stringify({
								links: [
									{
										rel: 'self',
										type: 'application/activity+json',
										href: 'https://social.com/someone',
									},
								],
							})
						)
					}

					if (input.toString() === 'https://social.com/someone') {
						return new Response(
							JSON.stringify({
								id: 'https://social.com/someone',
								url: 'https://social.com/@someone',
								type: 'Person',
								preferredUsername: '<script>some</script>one',
								name: 'Sven <i>Cool<i>',
								outbox: 'https://social.com/someone/outbox',
								following: 'https://social.com/someone/following',
								followers: 'https://social.com/someone/followers',
							})
						)
					}

					if (input.toString() === 'https://social.com/someone/following') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://social.com/someone/following',
								type: 'OrderedCollection',
								totalItems: 123,
								first: 'https://social.com/someone/following/page',
							})
						)
					}

					if (input.toString() === 'https://social.com/someone/followers') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://social.com/someone/followers',
								type: 'OrderedCollection',
								totalItems: 321,
								first: 'https://social.com/someone/followers/page',
							})
						)
					}

					if (input.toString() === 'https://social.com/someone/outbox') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://social.com/someone/outbox',
								type: 'OrderedCollection',
								totalItems: 890,
								first: 'https://social.com/someone/outbox/page',
							})
						)
					}

					throw new Error('unexpected request to ' + input.toString())
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const db = await makeDB()
			await queryAcct({ localPart: 'someone', domain: 'social.com' }, db)
			const res = await lookup.handleRequest({ domain, db }, 'someone@social.com')
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.username, 'someone')
			assert.equal(data.display_name, 'Sven Cool')
			assert.equal(data.acct, 'someone@social.com')

			assert(isUrlValid(data.url))
			assert(data.url, 'https://social.com/@someone')

			assert.equal(data.followers_count, 321)
			assert.equal(data.following_count, 123)
			assert.equal(data.statuses_count, 890)
		})

		test('lookup local actor', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')
			await addFollowing(domain, db, actor, actor2)
			await acceptFollowing(db, actor, actor2)
			await addFollowing(domain, db, actor, actor3)
			await acceptFollowing(db, actor, actor3)
			await addFollowing(domain, db, actor3, actor)
			await acceptFollowing(db, actor3, actor)

			await createPublicStatus(domain, db, actor, 'my first status')

			const res = await lookup.handleRequest({ domain, db }, 'sven')
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.username, 'sven')
			assert.equal(data.acct, 'sven')
			assert.equal(data.followers_count, 1)
			assert.equal(data.following_count, 2)
			assert.equal(data.statuses_count, 1)
			assert(isUrlValid(data.url))
			assert((data.url as string).includes(domain))
		})

		test('get remote actor by id', async () => {
			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://social.com/.well-known/webfinger?resource=acct%3Asven%40social.com') {
						return new Response(
							JSON.stringify({
								links: [
									{
										rel: 'self',
										type: 'application/activity+json',
										href: 'https://social.com/someone',
									},
								],
							})
						)
					}

					if (input.toString() === 'https://social.com/someone') {
						return new Response(
							JSON.stringify({
								id: 'https://social.com/someone',
								url: 'https://social.com/@someone',
								type: 'Person',
								preferredUsername: '<script>bad</script>sven',
								name: 'Sven <i>Cool<i>',
								outbox: 'https://social.com/someone/outbox',
								following: 'https://social.com/someone/following',
								followers: 'https://social.com/someone/followers',
							})
						)
					}

					if (input.toString() === 'https://social.com/someone/following') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://social.com/someone/following',
								type: 'OrderedCollection',
								totalItems: 123,
								first: 'https://social.com/someone/following/page',
							})
						)
					}

					if (input.toString() === 'https://social.com/someone/followers') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://social.com/someone/followers',
								type: 'OrderedCollection',
								totalItems: 321,
								first: 'https://social.com/someone/followers/page',
							})
						)
					}

					if (input.toString() === 'https://social.com/someone/outbox') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://social.com/someone/outbox',
								type: 'OrderedCollection',
								totalItems: 890,
								first: 'https://social.com/someone/outbox/page',
							})
						)
					}

					throw new Error('unexpected request to ' + input.toString())
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const db = await makeDB()
			const actor = await queryAcct({ localPart: 'sven', domain: 'social.com' }, db)
			assert.ok(actor)
			const res = await accounts_get.handleRequest({ domain, db }, actor[mastodonIdSymbol])
			await assertStatus(res, 200)
			const data = await res.json<any>()
			// Note the sanitization
			assert.equal(data.username, 'badsven')
			assert.equal(data.display_name, 'Sven Cool')
			assert.equal(data.acct, 'badsven@social.com')

			assert(isUrlValid(data.url))
			assert(data.url, 'https://social.com/@someone')

			assert.equal(data.followers_count, 321)
			assert.equal(data.following_count, 123)
			assert.equal(data.statuses_count, 890)
		})

		test('get unknown actor by id', async () => {
			const db = await makeDB()
			const res = await accounts_get.handleRequest({ domain, db }, '123456789')
			await assertStatus(res, 404)
		})

		test('get local actor by id', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			const actor3 = await createTestUser(domain, db, userKEK, 'sven3@cloudflare.com')
			await addFollowing(domain, db, actor, actor2)
			await acceptFollowing(db, actor, actor2)
			await addFollowing(domain, db, actor, actor3)
			await acceptFollowing(db, actor, actor3)
			await addFollowing(domain, db, actor3, actor)
			await acceptFollowing(db, actor3, actor)

			await createPublicStatus(domain, db, actor, 'my first status')

			const res = await accounts_get.handleRequest({ domain, db }, actor[mastodonIdSymbol])
			await assertStatus(res, 200)

			const data = await res.json<any>()
			assert.equal(data.username, 'sven')
			assert.equal(data.acct, 'sven')
			assert.equal(data.followers_count, 1)
			assert.equal(data.following_count, 2)
			assert.equal(data.statuses_count, 1)
			assert(isUrlValid(data.url))
			assert((data.url as string).includes(domain))
		})

		test('get local actor statuses', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const firstNote = await createPublicStatus(domain, db, actor, 'my first status')
			await insertLike(db, actor, firstNote)
			await sleep(5)
			const secondNote = await createPublicStatus(domain, db, actor, 'my second status')
			await sleep(5)
			await createReblog(db, actor, secondNote, { to: [PUBLIC_GROUP], cc: [], id: 'https://example.com/activity' })

			const res = await accounts_statuses.onRequestGet({
				request: new Request('https://' + domain),
				env: { DATABASE: db },
				params: { id: actor[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
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
			assert.equal(data[0].reblog.content, 'my second status')

			assert(!isUUID(data[1].id) && !isNaN(Number(data[1].id)), data[1].id)
			assert.equal(data[1].content, 'my second status')
			assert.equal(data[1].account.acct, 'sven')
			assert.equal(data[1].favourites_count, 0)
			assert.equal(data[1].reblogs_count, 1)
			assert.equal(new URL(data[1].url).pathname, '/@sven/' + data[1].id)

			assert(!isUUID(data[2].id) && !isNaN(Number(data[2].id)), data[2].id)
			assert.equal(data[2].content, 'my first status')
			assert.equal(data[2].favourites_count, 1)
			assert.equal(data[2].reblogs_count, 0)
		})

		test("get local actor statuses doesn't include replies", async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const note = await createPublicStatus(domain, db, actor, 'a post')
			await sleep(10)
			await createReply(domain, db, actor, note, 'a reply')

			const res = await accounts_statuses.onRequestGet({
				request: new Request(`https://${domain}?exclude_replies=true`),
				env: { DATABASE: db },
				params: { id: actor[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const data = await res.json<unknown[]>()

			// Only 1 post because the reply is hidden
			assert.equal(data.length, 1)
		})

		test('get local actor statuses includes media attachements', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const properties = { url: 'https://example.com/image.jpg', type: 'Image' as const }
			const mediaAttachments = [await createImage(domain, db, actor, properties)]
			await createPublicStatus(domain, db, actor, 'status from actor', mediaAttachments)

			const res = await accounts_statuses.onRequestGet({
				request: new Request('https://' + domain),
				env: { DATABASE: db },
				params: { id: actor[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const data = await res.json<{ media_attachments: { type: unknown; url: unknown }[] }[]>()

			assert.equal(data.length, 1)
			assert.equal(data[0].media_attachments.length, 1)
			assert.equal(data[0].media_attachments[0].type, 'image')
			assert.equal(data[0].media_attachments[0].url, properties.url)
		})

		test('get pinned statuses', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const res = await accounts_statuses.onRequestGet({
				request: new Request(`https://${domain}?pinned=true`),
				env: { DATABASE: db },
				params: { id: actor[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const data = await res.json<unknown[]>()
			assert.equal(data.length, 0)
		})

		test('get local actor statuses with max_id', async () => {
			const db = await makeDB()
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
				const res = await accounts_statuses.onRequestGet({
					request: new Request(`https://${domain}?max_id=mastodon_id2`),
					env: { DATABASE: db },
					params: { id: actor[mastodonIdSymbol] },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any)
				await assertStatus(res, 200)

				const data = await res.json<{ content: unknown; account: { acct: unknown } }[]>()
				assert.equal(data.length, 1)
				assert.equal(data[0].content, 'my first status')
				assert.equal(data[0].account.acct, 'sven')
			}

			{
				// Query statuses before object1, nothing is after.
				const res = await accounts_statuses.onRequestGet({
					request: new Request(`https://${domain}?max_id=mastodon_id`),
					env: { DATABASE: db },
					params: { id: actor[mastodonIdSymbol] },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any)
				await assertStatus(res, 200)

				const data = await res.json<unknown[]>()
				assert.equal(data.length, 0)
			}
		})

		test('get local actor statuses with max_id poiting to unknown id', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const res = await accounts_statuses.onRequestGet({
				request: new Request(`https://${domain}?max_id=object1`),
				env: { DATABASE: db },
				params: { id: actor[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 404)
		})

		test('get remote actor statuses', async () => {
			const db = await makeDB()

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
													type: 'Document',
													mediaType: 'image/jpeg',
													url: 'https://example.com/image',
													name: null,
													blurhash: 'U48;V;_24mx[_1~p.7%MW9?a-;xtxvWBt6ad',
													width: 1080,
													height: 894,
												},
												{
													type: 'Document',
													mediaType: 'video/mp4',
													url: 'https://example.com/video',
													name: null,
													blurhash: 'UB9jfvtT0gO^N5tSX4XV9uR%^Ni]D%Rj$*nf',
													width: 1080,
													height: 616,
												},
											],
										},
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
					const objectId = getApId(item.object)
					const res = await cacheActivityObject(domain, getActivityObject(item), db, getApId(item.actor), objectId)
					assert.ok(res)
					// Date in the past to create the order
					await addObjectInOutbox(db, actorB, res.object, item.to, item.cc, '2022-12-10T23:48:38Z')
				}
				if (isAnnounceActivity(item)) {
					const objectId = getApId(item.object)
					const obj = await getObjectById<Note>(db, objectId)
					assert.ok(obj)
					await createReblog(db, actorB, obj, item)
				}
			}

			const res = await accounts_statuses.onRequestGet({
				request: new Request('https://' + domain),
				env: { DATABASE: db },
				params: { id: actorB[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const data = await res.json<
				{ content: unknown; account: { username: unknown }; media_attachments: { type: unknown }[] }[]
			>()
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

		test('get remote actor followers', async () => {
			const db = await makeDB()
			const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')

			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://example.com/.well-known/webfinger?resource=acct%3Asven%40example.com') {
						return new Response(
							JSON.stringify({
								links: [
									{
										rel: 'self',
										type: 'application/activity+json',
										href: 'https://example.com/users/sven',
									},
								],
							})
						)
					}

					if (input.toString() === 'https://example.com/users/sven') {
						return new Response(
							JSON.stringify({
								id: 'https://example.com/users/sven',
								type: 'Person',
								preferredUsername: 'sven',
								followers: 'https://example.com/users/sven/followers',
							})
						)
					}

					if (input.toString() === 'https://example.com/users/sven/followers') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://example.com/users/sven/followers',
								type: 'OrderedCollection',
								totalItems: 3,
								first: 'https://example.com/users/sven/followers/1',
							})
						)
					}

					if (input.toString() === 'https://example.com/users/sven/followers/1') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://example.com/users/sven/followers/1',
								type: 'OrderedCollectionPage',
								totalItems: 3,
								partOf: 'https://example.com/users/sven/followers',
								orderedItems: [
									actorA.id.toString(), // local user
									'https://example.com/users/b', // remote user
								],
							})
						)
					}

					if (input.toString() === 'https://example.com/users/b') {
						return new Response(
							JSON.stringify({
								id: 'https://example.com/users/b',
								type: 'Person',
								preferredUsername: 'b',
							})
						)
					}

					throw new Error('unexpected request to ' + input.toString())
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const actor = await queryAcct({ localPart: 'sven', domain: 'example.com' }, db)
			assert.ok(actor)

			const res = await accounts_followers.onRequestGet({
				request: new Request('https://' + domain),
				env: { DATABASE: db },
				params: { id: actor[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const data = await res.json<{ acct: unknown }[]>()
			assert.equal(data.length, 2)

			assert.equal(data[0].acct, 'a')
			assert.equal(data[1].acct, 'b@example.com')
		})

		test('get local actor followers', async () => {
			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://' + domain + '/ap/users/sven2') {
						return new Response(
							JSON.stringify({
								id: 'https://example.com/actor',
								type: 'Person',
							})
						)
					}
					throw new Error('unexpected request to ' + input.toString())
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			await addFollowing(domain, db, actor2, actor)
			await acceptFollowing(db, actor2, actor)

			const res = await accounts_followers.onRequestGet({
				request: new Request('https://' + domain),
				env: { DATABASE: db },
				params: { id: actor[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const data = await res.json<unknown[]>()
			assert.equal(data.length, 1)
		})

		test('get local actor following', async () => {
			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://' + domain + '/ap/users/sven2') {
						return new Response(
							JSON.stringify({
								id: 'https://example.com/foo',
								type: 'Person',
							})
						)
					}
					throw new Error('unexpected request to ' + input.toString())
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
			await addFollowing(domain, db, actor, actor2)
			await acceptFollowing(db, actor, actor2)

			const res = await accounts_following.onRequestGet({
				request: new Request('https://' + domain),
				env: { DATABASE: db },
				params: { id: actor[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const data = await res.json<unknown[]>()
			assert.equal(data.length, 1)
		})

		test('get remote actor following', async () => {
			const db = await makeDB()
			const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')

			globalThis.fetch = async (input: RequestInfo) => {
				if (input instanceof URL || typeof input === 'string') {
					if (input.toString() === 'https://example.com/.well-known/webfinger?resource=acct%3Asven%40example.com') {
						return new Response(
							JSON.stringify({
								links: [
									{
										rel: 'self',
										type: 'application/activity+json',
										href: 'https://example.com/users/sven',
									},
								],
							})
						)
					}

					if (input.toString() === 'https://example.com/users/sven') {
						return new Response(
							JSON.stringify({
								id: 'https://example.com/users/sven',
								type: 'Person',
								following: 'https://example.com/users/sven/following',
								preferredUsername: 'sven',
							})
						)
					}

					if (input.toString() === 'https://example.com/users/sven/following') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://example.com/users/sven/following',
								type: 'OrderedCollection',
								totalItems: 3,
								first: 'https://example.com/users/sven/following/1',
							})
						)
					}

					if (input.toString() === 'https://example.com/users/sven/following/1') {
						return new Response(
							JSON.stringify({
								'@context': 'https://www.w3.org/ns/activitystreams',
								id: 'https://example.com/users/sven/following/1',
								type: 'OrderedCollectionPage',
								totalItems: 3,
								partOf: 'https://example.com/users/sven/following',
								orderedItems: [
									actorA.id.toString(), // local user
									'https://example.com/users/b', // remote user
								],
							})
						)
					}

					if (input.toString() === 'https://example.com/users/b') {
						return new Response(
							JSON.stringify({
								id: 'https://example.com/users/b',
								type: 'Person',
								preferredUsername: 'b',
							})
						)
					}

					throw new Error('unexpected request to ' + input.toString())
				}
				throw new Error('unexpected request to ' + input.url)
			}

			const actor = await queryAcct({ localPart: 'sven', domain: 'example.com' }, db)
			assert.ok(actor)

			const res = await accounts_following.onRequestGet({
				request: new Request('https://' + domain),
				env: { DATABASE: db },
				params: { id: actor[mastodonIdSymbol] },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any)
			await assertStatus(res, 200)

			const data = await res.json<{ acct: unknown }[]>()
			assert.equal(data.length, 2)

			assert.equal(data[0].acct, 'a')
			assert.equal(data[1].acct, 'b@example.com')
		})

		test('get remote actor featured_tags', async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const res = await accounts_featured_tags.onRequestGet({ params: { id: 'stub' } } as any)
			await assertStatus(res, 200)
		})

		test('get remote actor lists', async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const res = await accounts_lists.onRequestGet({ params: { id: 'stub' } } as any)
			await assertStatus(res, 200)
		})

		describe('relationships', () => {
			test('relationships missing ids', async () => {
				const db = await makeDB()
				const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				const req = new Request('https://mastodon.example/api/v1/accounts/relationships')
				const res = await accounts_relationships.onRequestGet({
					request: req,
					env: { DATABASE: db },
					data: { connectedActor },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any)
				await assertStatus(res, 400)
			})

			test('relationships with ids', async () => {
				const db = await makeDB()
				const req = new Request('https://mastodon.example/api/v1/accounts/relationships?id[]=first&id[]=second')
				const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				const res = await accounts_relationships.onRequestGet({
					request: req,
					env: { DATABASE: db },
					data: { connectedActor },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any)
				await assertStatus(res, 200)
				assertCORS(res)
				assertJSON(res)

				const data = await res.json<Array<any>>()
				assert.equal(data.length, 2)
				assert.equal(data[0].id, 'first')
				assert.equal(data[0].following, false)
				assert.equal(data[1].id, 'second')
				assert.equal(data[1].following, false)
			})

			test('relationships with one id', async () => {
				const db = await makeDB()
				const req = new Request('https://mastodon.example/api/v1/accounts/relationships?id[]=first')
				const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				const res = await accounts_relationships.onRequestGet({
					request: req,
					env: { DATABASE: db },
					data: { connectedActor },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any)
				await assertStatus(res, 200)
				assertCORS(res)
				assertJSON(res)

				const data = await res.json<Array<any>>()
				assert.equal(data.length, 1)
				assert.equal(data[0].id, 'first')
				assert.equal(data[0].following, false)
			})

			test('relationships following', async () => {
				const db = await makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
				await addFollowing(domain, db, actor, actor2)
				await acceptFollowing(db, actor, actor2)

				const req = new Request(
					'https://mastodon.example/api/v1/accounts/relationships?id[]=' + actor2[mastodonIdSymbol]
				)
				const res = await accounts_relationships.onRequestGet({
					request: req,
					env: { DATABASE: db },
					data: { connectedActor: actor },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any)
				await assertStatus(res, 200)

				const data = await res.json<Array<any>>()
				assert.equal(data.length, 1)
				assert.equal(data[0].following, true)
			})

			test('relationships following request', async () => {
				const db = await makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				const actor2 = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
				await addFollowing(domain, db, actor, actor2)

				const req = new Request(
					'https://mastodon.example/api/v1/accounts/relationships?id[]=' + actor2[mastodonIdSymbol]
				)
				const res = await accounts_relationships.onRequestGet({
					request: req,
					env: { DATABASE: db },
					data: { connectedActor: actor },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any)
				await assertStatus(res, 200)

				const data = await res.json<Array<any>>()
				assert.equal(data.length, 1)
				assert.equal(data[0].requested, true)
				assert.equal(data[0].following, false)
			})
		})

		test('follow local account', async () => {
			const db = await makeDB()
			const connectedActor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const targetActor = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')

			const res = await accounts_follow.handleRequest(
				{ domain, db, connectedActor, userKEK },
				targetActor[mastodonIdSymbol],
				{}
			)
			await assertStatus(res, 403)
		})

		describe('follow', () => {
			let receivedActivity: any = null

			beforeEach(() => {
				receivedActivity = null

				globalThis.fetch = async (input: RequestInfo) => {
					const request = new Request(input)
					if (request.url === 'https://example.com/.well-known/webfinger?resource=acct%3Aactor%40example.com') {
						return new Response(
							JSON.stringify({
								links: [
									{
										rel: 'self',
										type: 'application/activity+json',
										href: `https://example.com/ap/users/actor`,
									},
								],
							})
						)
					}

					if (request.url === `https://example.com/ap/users/actor`) {
						return new Response(
							JSON.stringify({
								id: `https://example.com/ap/users/actor`,
								type: 'Person',
								inbox: `https://example.com/ap/users/actor/inbox`,
								preferredUsername: 'actor',
							})
						)
					}

					if (request.url === `https://example.com/ap/users/actor/inbox`) {
						assert.equal(request.method, 'POST')
						receivedActivity = await request.json()
						return new Response('')
					}

					throw new Error('unexpected request to ' + request.url)
				}
			})

			test('follow account', async () => {
				const db = await makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				const connectedActor = actor

				const followee = await queryAcct({ localPart: 'actor', domain: 'example.com' }, db)
				assert.ok(followee)
				const res = await accounts_follow.handleRequest(
					{ domain, db, connectedActor, userKEK },
					followee[mastodonIdSymbol],
					{}
				)
				await assertStatus(res, 200)
				assertCORS(res)
				assertJSON(res)

				assert(receivedActivity)
				assert.equal(receivedActivity.type, 'Follow')

				const row = await db
					.prepare(`SELECT target_actor_acct, target_actor_id, state FROM actor_following WHERE actor_id=?`)
					.bind(actor.id.toString())
					.first<{ target_actor_acct: string; target_actor_id: string; state: string }>()
					.then((row) => {
						assert.ok(row)
						return row
					})
				assert.equal(row.target_actor_acct, 'actor@example.com')
				assert.equal(row.target_actor_id, `https://example.com/ap/users/actor`)
				assert.equal(row.state, 'pending')
			})

			test('unfollow account', async () => {
				const db = await makeDB()
				const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
				const followee = await queryAcct({ localPart: 'actor', domain: 'example.com' }, db)
				assert.ok(followee)
				await addFollowing(domain, db, actor, followee)

				const connectedActor = actor
				const res = await accounts_unfollow.handleRequest(
					{ domain, db, connectedActor, userKEK },
					followee[mastodonIdSymbol]
				)
				await assertStatus(res, 200)
				assertCORS(res)
				assertJSON(res)

				assert(receivedActivity)
				assert.equal(receivedActivity.type, 'Undo')
				assert.equal(receivedActivity.object.type, 'Follow')

				const row = await db
					.prepare(`SELECT count(*) as count FROM actor_following WHERE actor_id=?`)
					.bind(actor.id.toString())
					.first<{ count: number }>()
				assert(row)
				assert.equal(row.count, 0)
			})
		})

		test('view filters return empty array', async () => {
			const res = await filters.onRequest()
			await assertStatus(res, 200)
			assertJSON(res)

			const data = await res.json<any>()
			assert.equal(data.length, 0)
		})

		test('preferences', async () => {
			const db = await makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'alice@example.com')
			const connectedActor = actor

			const context: any = { data: { connectedActor }, env: { DATABASE: db } }
			const res = await preferences.onRequest(context)
			await assertStatus(res, 200)
			assertCORS(res)
			assertJSON(res)

			const data = await res.json<any>()
			assert.equal(data['posting:default:language'], null)
			assert.equal(data['posting:default:sensitive'], false)
			assert.equal(data['posting:default:visibility'], 'public')
			assert.equal(data['reading:expand:media'], 'default')
			assert.equal(data['reading:expand:spoilers'], false)
		})
	})
})
