import { strict as assert } from 'node:assert/strict'

import { AnnounceActivity, PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import * as activityHandler from 'wildebeest/backend/src/activitypub/activities/handle'
import { getApId } from 'wildebeest/backend/src/activitypub/objects'
import { Note } from 'wildebeest/backend/src/activitypub/objects/note'
import { addFollowing, acceptFollowing } from 'wildebeest/backend/src/mastodon/follow'
import { JWK } from 'wildebeest/backend/src/webpush/jwk'
import {
	createDirectStatus,
	createPrivateStatus,
	createPublicStatus,
	createUnlistedStatus,
} from 'wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, createActivityId } from 'wildebeest/backend/test/utils'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek15'
const vapidKeys = {} as JWK

describe('Announce', () => {
	test('records reblog in db', async () => {
		const db = makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const actorB = await createTestUser(domain, db, userKEK, 'b@cloudflare.com')

		const note = await createPublicStatus(domain, db, actorA, 'my first status')

		const activity: AnnounceActivity = {
			type: 'Announce',
			id: createActivityId(domain),
			actor: actorB.id,
			object: note.id,
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const entry = await db.prepare('SELECT * FROM actor_reblogs').first<{
			actor_id: URL
			object_id: URL
		}>()
		assert.ok(entry)
		assert.equal(entry.actor_id.toString(), actorB.id.toString())
		assert.equal(entry.object_id.toString(), note.id.toString())
	})

	test('creates notification', async () => {
		const db = makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
		const actorB = await createTestUser(domain, db, userKEK, 'b@cloudflare.com')

		const note = await createPublicStatus(domain, db, actorA, 'my first status')

		const activity: AnnounceActivity = {
			type: 'Announce',
			id: createActivityId(domain),
			actor: actorB.id,
			object: note.id,
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const entry = await db.prepare('SELECT * FROM actor_notifications').first<{
			type: string
			actor_id: URL
			from_actor_id: URL
		}>()
		assert(entry)
		assert.equal(entry.type, 'reblog')
		assert.equal(entry.actor_id.toString(), actorA.id.toString())
		assert.equal(entry.from_actor_id.toString(), actorB.id.toString())
	})

	test('Announce objects are stored and added to the remote actors outbox', async () => {
		const remoteActorId = 'https://example.com/actor'
		const objectId = 'https://example.com/some-object'

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === remoteActorId) {
					return new Response(
						JSON.stringify({
							id: remoteActorId,
							icon: { url: 'https://img.com' },
							type: 'Person',
							preferredUsername: 'actor',
						})
					)
				}

				if (input.toString() === objectId) {
					return new Response(
						JSON.stringify({
							id: objectId,
							type: 'Note',
							content: 'foo',
							source: {
								content: 'foo',
								mediaType: 'text/plain',
							},
							attachment: [],
							sensitive: false,
							attributedTo: remoteActorId,
							to: [PUBLIC_GROUP],
							cc: [],
						} satisfies Note)
					)
				}

				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const activity: AnnounceActivity = {
			type: 'Announce',
			id: createActivityId(domain),
			actor: getApId(remoteActorId),
			to: [PUBLIC_GROUP],
			cc: [],
			object: getApId(objectId),
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const object = await db.prepare('SELECT * FROM objects').first<{
			type: string
			original_actor_id: string
		}>()
		assert(object)
		assert.equal(object.type, 'Note')
		assert.equal(object.original_actor_id, remoteActorId)

		const outbox_object = await db
			.prepare('SELECT * FROM outbox_objects WHERE actor_id=?')
			.bind(remoteActorId)
			.first<{ id: string; actor_id: string }>()
		assert(outbox_object)
		assert.equal(outbox_object.actor_id, remoteActorId)

		const actor_reblog = await db
			.prepare('SELECT 1 FROM actor_reblogs WHERE outbox_object_id=?')
			.bind(outbox_object.id)
			.first()
		assert(actor_reblog)
	})

	describe("handle reblog of a local account's post by a remote account", () => {
		const remoteActorId = 'https://example.com/actor'
		const remoteActorFollowers = 'https://example.com/actor/followers'

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === remoteActorId) {
					return new Response(
						JSON.stringify({
							id: remoteActorId,
							icon: { url: 'https://img.com' },
							type: 'Person',
						})
					)
				}
				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		test.each([
			{
				title: 'status: public <- reblog: public',
				createStatusFn: createPublicStatus,
				to: [PUBLIC_GROUP],
				cc: [remoteActorFollowers],
				allowed: true,
			},
			{
				title: 'status: public <- reblog: unlisted',
				createStatusFn: createPublicStatus,
				to: [remoteActorFollowers],
				cc: [PUBLIC_GROUP],
				allowed: true,
			},
			{
				title: 'status: public <- reblog: private',
				createStatusFn: createPublicStatus,
				to: [remoteActorFollowers],
				cc: [],
				allowed: true,
			},
			{
				title: 'status: unlisted <- reblog: public',
				createStatusFn: createUnlistedStatus,
				to: [PUBLIC_GROUP],
				cc: [remoteActorFollowers],
				allowed: true,
			},
			{
				title: 'status: unlisted <- reblog: unlisted',
				createStatusFn: createUnlistedStatus,
				to: [remoteActorFollowers],
				cc: [PUBLIC_GROUP],
				allowed: true,
			},
			{
				title: 'status: unlisted <- reblog: private',
				createStatusFn: createUnlistedStatus,
				to: [remoteActorFollowers],
				cc: [],
				allowed: true,
			},
			{
				title: 'status: private <- reblog: public',
				createStatusFn: createPrivateStatus,
				to: [PUBLIC_GROUP],
				cc: [remoteActorFollowers],
				allowed: false,
			},
			{
				title: 'status: private <- reblog: unlisted',
				createStatusFn: createPrivateStatus,
				to: [remoteActorFollowers],
				cc: [PUBLIC_GROUP],
				allowed: false,
			},
			{
				title: 'status: private <- reblog: private',
				createStatusFn: createPrivateStatus,
				to: [remoteActorFollowers],
				cc: [],
				allowed: false,
			},
			{
				title: 'status: direct <- reblog: public',
				createStatusFn: createDirectStatus,
				to: [PUBLIC_GROUP],
				cc: [remoteActorFollowers],
				allowed: false,
			},
			{
				title: 'status: direct <- reblog: unlisted',
				createStatusFn: createDirectStatus,
				to: [remoteActorFollowers],
				cc: [PUBLIC_GROUP],
				allowed: false,
			},
			{
				title: 'status: direct <- reblog: private',
				createStatusFn: createDirectStatus,
				to: [remoteActorFollowers],
				cc: [],
				allowed: false,
			},
			{
				title: 'status: direct <- reblog: direct',
				createStatusFn: createDirectStatus,
				to: [remoteActorId],
				cc: [],
				allowed: false,
			},
		])('$title', async ({ createStatusFn, to, cc, allowed }) => {
			const db = makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const note = await createStatusFn(domain, db, actor, 'my first status')

			const activity: AnnounceActivity = {
				type: 'Announce',
				id: createActivityId(domain),
				actor: getApId(remoteActorId),
				to,
				cc,
				object: getApId(note.id),
			}

			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			const object = await db
				.prepare(`SELECT type, original_actor_id, json_extract(properties, '$.to') as [to] FROM objects`)
				.first<{
					type: string
					original_actor_id: string
					to: string
				}>()
			assert(object)
			assert.equal(object.type, 'Note')
			assert.equal(object.original_actor_id, actor.id.toString())

			const { results } = await db
				.prepare('SELECT * FROM outbox_objects WHERE actor_id=?')
				.bind(remoteActorId)
				.all<{ id: string; object_id: string; to: string; cc: string }>()
			if (allowed) {
				assert(results)
				assert.equal(results[0].object_id, note.id.toString())
				assert.equal(results[0].to, JSON.stringify(to))
				assert.equal(results[0].cc, JSON.stringify(cc))

				const { results: rows } = await db
					.prepare('SELECT 1 FROM actor_reblogs WHERE outbox_object_id=?')
					.bind(results[0].id)
					.all()
				assert(rows !== undefined && rows.length === 1)
			} else {
				assert(results === undefined || results.length === 0)
			}
		})
	})

	test('Even if followed, reblogging of private posts is not permitted', async () => {
		const db = makeDB()
		const actorA = await createTestUser(domain, db, userKEK, 'sven1@cloudflare.com')
		const actorB = await createTestUser(domain, db, userKEK, 'sven2@cloudflare.com')
		await addFollowing(domain, db, actorB, actorA)
		await acceptFollowing(db, actorA, actorB)

		const note = await createPrivateStatus(domain, db, actorA, 'my first status')

		const activity: AnnounceActivity = {
			type: 'Announce',
			id: createActivityId(domain),
			actor: getApId(actorB.id),
			to: [actorB.followers.toString()],
			cc: [],
			object: getApId(note.id),
		}

		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const { results } = await db
			.prepare('SELECT * FROM outbox_objects WHERE actor_id=?')
			.bind(actorB.id.toString())
			.all<{ id: string; object_id: string; to: string; cc: string }>()
		assert(results === undefined || results.length === 0)
	})

	describe('Reblogging of private/direct posts is only permitted to the post author', () => {
		test.each([
			{
				title: 'status: private <- self reblog: public',
				visibility: 'public',
				allowed: false,
			},
			{
				title: 'status: private <- self reblog: unlisted',
				visibility: 'unlisted',
				allowed: false,
			},
			{
				title: 'status: private <- self reblog: private',
				visibility: 'private',
				allowed: true,
			},
		])('$title', async ({ visibility, allowed }) => {
			const db = makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const note = await createPrivateStatus(domain, db, actor, 'my first status')

			const activity: AnnounceActivity = {
				type: 'Announce',
				id: createActivityId(domain),
				actor: getApId(actor.id),
				to: visibility === 'public' ? [PUBLIC_GROUP] : [actor.followers.toString()],
				cc: visibility === 'unlisted' ? [PUBLIC_GROUP] : [],
				object: getApId(note.id),
			}

			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			const { results } = await db
				.prepare(
					'SELECT 1 FROM outbox_objects INNER JOIN actor_reblogs ON actor_reblogs.outbox_object_id = outbox_objects.id WHERE outbox_objects.actor_id=?'
				)
				.bind(actor.id.toString())
				.all()
			if (allowed) {
				assert(
					results !== undefined && results.length === 1,
					JSON.stringify({
						results,
						note: { to: note.to, cc: note.cc },
						activity: { to: activity.to, cc: activity.cc },
					})
				)
			} else {
				assert(
					results === undefined || results.length === 0,
					JSON.stringify({
						results,
						note: { to: note.to, cc: note.cc },
						activity: { to: activity.to, cc: activity.cc },
					})
				)
			}
		})

		test.each([
			{
				title: 'status: direct <- self reblog: public',
				visibility: 'public',
				allowed: false,
			},
			{
				title: 'status: direct <- self reblog: unlisted',
				visibility: 'unlisted',
				allowed: false,
			},
			{
				title: 'status: direct <- self reblog: private',
				visibility: 'private',
				allowed: false,
			},
			{
				title: 'status: direct <- self reblog: direct',
				visibility: 'direct',
				allowed: true,
			},
		])('$title', async ({ visibility, allowed }) => {
			const db = makeDB()
			const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

			const note = await createDirectStatus(domain, db, actor, 'my first status')

			const activity: AnnounceActivity = {
				type: 'Announce',
				id: createActivityId(domain),
				actor: getApId(actor.id),
				to:
					visibility === 'public'
						? [PUBLIC_GROUP]
						: visibility !== 'direct'
							? [actor.followers.toString()]
							: [actor.id.toString()],
				cc: visibility === 'unlisted' ? [PUBLIC_GROUP] : [],
				object: getApId(note.id),
			}

			await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

			const { results } = await db
				.prepare(
					'SELECT 1 FROM outbox_objects INNER JOIN actor_reblogs ON actor_reblogs.outbox_object_id = outbox_objects.id WHERE outbox_objects.actor_id=?'
				)
				.bind(actor.id.toString())
				.all()
			if (allowed) {
				assert(results !== undefined && results.length === 1)
			} else {
				assert(results === undefined || results.length === 0)
			}
		})
	})

	test('duplicated announce', async () => {
		const remoteActorId = 'https://example.com/actor'
		const objectId = 'https://example.com/some-object'
		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === remoteActorId) {
					return new Response(
						JSON.stringify({
							id: remoteActorId,
							icon: { url: 'https://img.com' },
							type: 'Person',
							preferredUsername: 'actor',
						})
					)
				}

				if (input.toString() === objectId) {
					return new Response(
						JSON.stringify({
							id: objectId,
							type: 'Note',
							content: 'foo',
							source: {
								content: 'foo',
								mediaType: 'text/plain',
							},
							attachment: [],
							sensitive: false,
							attributedTo: remoteActorId,
							to: [PUBLIC_GROUP],
							cc: [],
						} satisfies Note)
					)
				}

				throw new Error('unexpected request to ' + input.toString())
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const activity: AnnounceActivity = {
			type: 'Announce',
			id: createActivityId(domain),
			actor: getApId(remoteActorId),
			to: [PUBLIC_GROUP],
			cc: [],
			object: getApId(objectId),
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		// Handle the same Activity
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		// Ensure only one reblog is kept
		const { count } = await db
			.prepare('SELECT count(*) as count FROM outbox_objects')
			.first<{ count: number }>()
			.then((row) => {
				assert.ok(row)
				return row
			})
		assert.equal(count, 1)
	})
})
