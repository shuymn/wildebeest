import { acceptFollowing, addFollowing, removeFollowing } from '@wildebeest/backend/mastodon/follow'
import { insertLike } from '@wildebeest/backend/mastodon/like'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_interaction_count'
const domain = 'cloudflare.com'

describe('interaction_count', () => {
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
