import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import { deleteBookmark, insertBookmark } from '@wildebeest/backend/mastodon/bookmark'
import { acceptFollowing, addFollowing, removeFollowing } from '@wildebeest/backend/mastodon/follow'
import { deleteLike, insertLike } from '@wildebeest/backend/mastodon/like'
import { createReblog, deleteReblog } from '@wildebeest/backend/mastodon/reblog'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_interaction_count'
const domain = 'cloudflare.com'

describe('interaction_count', () => {
	async function createLocalUserAndRemoteObject(db: ReturnType<typeof makeDB>) {
		const actorId = `https://cloudflare.com/ap/users/${crypto.randomUUID()}`
		const objectId = `https://example.com/objects/${crypto.randomUUID()}`

		await db
			.prepare(
				`INSERT INTO actors (id, type, username, domain, properties, mastodon_id)
				VALUES (?, 'Person', 'local', 'cloudflare.com', '{}', ?)`
			)
			.bind(actorId, crypto.randomUUID())
			.run()

		await db
			.prepare(
				`INSERT INTO users (id, actor_id, email, privkey, privkey_salt, pubkey, is_admin, cdate)
				VALUES (?, ?, ?, '', '', '', 0, '2020-01-01T00:00:00.000Z')`
			)
			.bind(crypto.randomUUID(), actorId, `${crypto.randomUUID()}@example.com`)
			.run()

		await db
			.prepare(
				`INSERT INTO objects (id, type, properties, local, mastodon_id)
				VALUES (?, 'Note', '{}', 0, ?)`
			)
			.bind(objectId, crypto.randomUUID())
			.run()

		return { actor: { id: new URL(actorId) }, obj: { id: new URL(objectId) }, actorId, objectId }
	}

	test('favourite increments remote object interaction_count', async () => {
		const db = makeDB()
		const actorId = 'https://cloudflare.com/ap/users/local'
		const objectId = 'https://example.com/objects/1'

		await db
			.prepare(
				`INSERT INTO actors (id, type, username, domain, properties, mastodon_id)
				VALUES (?, 'Person', 'local', 'cloudflare.com', '{}', '1')`
			)
			.bind(actorId)
			.run()

		await db
			.prepare(
				`INSERT INTO users (id, actor_id, email, privkey, privkey_salt, pubkey, is_admin, cdate)
				VALUES (?, ?, 'test@example.com', '', '', '', 0, '2020-01-01T00:00:00.000Z')`
			)
			.bind(crypto.randomUUID(), actorId)
			.run()

		await db
			.prepare(
				`INSERT INTO objects (id, type, properties, local, mastodon_id)
				VALUES (?, 'Note', '{}', 0, '2')`
			)
			.bind(objectId)
			.run()

		await insertLike(db, { id: new URL(actorId) }, { id: new URL(objectId) })
		await insertLike(db, { id: new URL(actorId) }, { id: new URL(objectId) })

		const row = await db
			.prepare('SELECT interaction_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(1)
	})

	test('unfavourite decrements remote object interaction_count once', async () => {
		const db = makeDB()
		const { actor, obj, objectId } = await createLocalUserAndRemoteObject(db)

		await insertLike(db, actor, obj)
		await deleteLike(db, actor, obj)
		await deleteLike(db, actor, obj)

		const row = await db
			.prepare('SELECT interaction_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(0)
	})

	test('duplicate favourite repairs remote object interaction_count', async () => {
		const db = makeDB()
		const { actor, obj, objectId } = await createLocalUserAndRemoteObject(db)

		await insertLike(db, actor, obj)
		await db.prepare(`UPDATE objects SET interaction_count = 5 WHERE id = ?`).bind(objectId).run()
		await insertLike(db, actor, obj)

		const row = await db
			.prepare('SELECT interaction_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(1)
	})

	test('duplicate unfavourite repairs remote object interaction_count', async () => {
		const db = makeDB()
		const { actor, obj, objectId } = await createLocalUserAndRemoteObject(db)

		await insertLike(db, actor, obj)
		await deleteLike(db, actor, obj)
		await db.prepare(`UPDATE objects SET interaction_count = 5 WHERE id = ?`).bind(objectId).run()
		await deleteLike(db, actor, obj)

		const row = await db
			.prepare('SELECT interaction_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(0)
	})

	test('bookmark increments and unbookmark decrements remote object interaction_count once', async () => {
		const db = makeDB()
		const { actor, obj, objectId } = await createLocalUserAndRemoteObject(db)

		await insertBookmark(db, actor, obj)
		await insertBookmark(db, actor, obj)
		await deleteBookmark(db, actor, obj)
		await deleteBookmark(db, actor, obj)

		const row = await db
			.prepare('SELECT interaction_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(0)
	})

	test('duplicate bookmark repairs remote object interaction_count', async () => {
		const db = makeDB()
		const { actor, obj, objectId } = await createLocalUserAndRemoteObject(db)

		await insertBookmark(db, actor, obj)
		await db.prepare(`UPDATE objects SET interaction_count = 5 WHERE id = ?`).bind(objectId).run()
		await insertBookmark(db, actor, obj)

		const row = await db
			.prepare('SELECT interaction_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(1)
	})

	test('duplicate unbookmark repairs remote object interaction_count', async () => {
		const db = makeDB()
		const { actor, obj, objectId } = await createLocalUserAndRemoteObject(db)

		await insertBookmark(db, actor, obj)
		await deleteBookmark(db, actor, obj)
		await db.prepare(`UPDATE objects SET interaction_count = 5 WHERE id = ?`).bind(objectId).run()
		await deleteBookmark(db, actor, obj)

		const row = await db
			.prepare('SELECT interaction_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(0)
	})

	test('unreblog decrements remote object interaction_count once', async () => {
		const db = makeDB()
		const { actor, obj, actorId, objectId } = await createLocalUserAndRemoteObject(db)
		const outboxObjectId = crypto.randomUUID()

		await db
			.prepare(`INSERT INTO outbox_objects (id, actor_id, object_id) VALUES (?, ?, ?)`)
			.bind(outboxObjectId, actorId, objectId)
			.run()

		await db
			.prepare(
				`INSERT INTO actor_reblogs (id, actor_id, object_id, outbox_object_id, mastodon_id)
				VALUES (?, ?, ?, ?, ?)`
			)
			.bind(crypto.randomUUID(), actorId, objectId, outboxObjectId, crypto.randomUUID())
			.run()
		await db.prepare(`UPDATE objects SET interaction_count = 1, reblogs_count = 1 WHERE id = ?`).bind(objectId).run()

		await deleteReblog(db, actor, obj)
		await deleteReblog(db, actor, obj)

		const row = await db
			.prepare('SELECT interaction_count, reblogs_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number; reblogs_count: number }>()
		expect(row?.interaction_count).toBe(0)
		expect(row?.reblogs_count).toBe(0)
	})

	test('unreblog repairs stale remote object counters', async () => {
		const db = makeDB()
		const { actor, obj, actorId, objectId } = await createLocalUserAndRemoteObject(db)
		const outboxObjectId = crypto.randomUUID()

		await db
			.prepare(`INSERT INTO outbox_objects (id, actor_id, object_id) VALUES (?, ?, ?)`)
			.bind(outboxObjectId, actorId, objectId)
			.run()
		await db
			.prepare(
				`INSERT INTO actor_reblogs (id, actor_id, object_id, outbox_object_id, mastodon_id)
				VALUES (?, ?, ?, ?, ?)`
			)
			.bind(crypto.randomUUID(), actorId, objectId, outboxObjectId, crypto.randomUUID())
			.run()
		await db.prepare(`UPDATE objects SET interaction_count = 5, reblogs_count = 5 WHERE id = ?`).bind(objectId).run()

		await deleteReblog(db, actor, obj)

		const row = await db
			.prepare('SELECT interaction_count, reblogs_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number; reblogs_count: number }>()
		expect(row?.interaction_count).toBe(0)
		expect(row?.reblogs_count).toBe(0)
	})

	test('duplicate reblog repairs remote object counters', async () => {
		const db = makeDB()
		const { actor, obj, actorId, objectId } = await createLocalUserAndRemoteObject(db)
		const outboxObjectId = crypto.randomUUID()
		const activityId = `https://${domain}/ap/a/${crypto.randomUUID()}`

		await db
			.prepare(`INSERT INTO outbox_objects (id, actor_id, object_id) VALUES (?, ?, ?)`)
			.bind(outboxObjectId, actorId, objectId)
			.run()
		await db
			.prepare(
				`INSERT INTO actor_reblogs (id, actor_id, object_id, outbox_object_id, mastodon_id)
				VALUES (?, ?, ?, ?, ?)`
			)
			.bind(activityId, actorId, objectId, outboxObjectId, crypto.randomUUID())
			.run()

		const created = await createReblog(
			db,
			actor as Parameters<typeof createReblog>[1],
			{
				...obj,
				type: 'Note',
				content: 'remote status',
				attributedTo: new URL(actorId),
				attachment: [],
				sensitive: false,
				to: [PUBLIC_GROUP],
				cc: [],
			},
			{ id: new URL(activityId), to: [PUBLIC_GROUP], cc: [] }
		)
		expect(created).toBe(false)

		const row = await db
			.prepare('SELECT interaction_count, reblogs_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number; reblogs_count: number }>()
		expect(row?.interaction_count).toBe(1)
		expect(row?.reblogs_count).toBe(1)
	})

	test('favourite does not increment local object interaction_count', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'local2@cloudflare.com')
		const note = await createPublicStatus(domain, db, actor, 'local status')

		await insertLike(db, actor, note)

		const row = await db
			.prepare('SELECT interaction_count FROM objects WHERE id = ?')
			.bind(note.id.toString())
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(0)
	})

	test('accepting follow increments remote actor interaction_count', async () => {
		const db = makeDB()
		const localFollower = await createTestUser(domain, db, userKEK, 'follower@cloudflare.com')
		const remoteActorId = 'https://example.com/users/remote'

		await db
			.prepare(
				`INSERT INTO actors (id, type, username, domain, properties, mastodon_id, interaction_count)
				VALUES (?, 'Person', 'remote', 'example.com', '{}', '20', 0)`
			)
			.bind(remoteActorId)
			.run()

		const remoteActor = { id: new URL(remoteActorId) }
		await addFollowing(domain, db, localFollower, remoteActor)
		await acceptFollowing(db, localFollower, remoteActor)

		const row = await db
			.prepare('SELECT interaction_count FROM actors WHERE id = ?')
			.bind(remoteActorId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(1)
	})

	test('unfollowing decrements remote actor interaction_count', async () => {
		const db = makeDB()
		const localFollower = await createTestUser(domain, db, userKEK, 'unfollower@cloudflare.com')
		const remoteActorId = 'https://example.com/users/remote2'

		await db
			.prepare(
				`INSERT INTO actors (id, type, username, domain, properties, mastodon_id, interaction_count)
				VALUES (?, 'Person', 'remote2', 'example.com', '{}', '21', 0)`
			)
			.bind(remoteActorId)
			.run()

		const remoteActor = { id: new URL(remoteActorId) }
		await addFollowing(domain, db, localFollower, remoteActor)
		await acceptFollowing(db, localFollower, remoteActor)
		await removeFollowing(db, localFollower, remoteActor)

		const row = await db
			.prepare('SELECT interaction_count FROM actors WHERE id = ?')
			.bind(remoteActorId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(0)
	})
})
