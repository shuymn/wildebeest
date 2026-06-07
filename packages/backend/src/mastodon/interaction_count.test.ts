import { insertLike } from '@wildebeest/backend/mastodon/like'
import { makeDB } from '@wildebeest/backend/test/utils'

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

		const row = await db
			.prepare('SELECT interaction_count FROM objects WHERE id = ?')
			.bind(objectId)
			.first<{ interaction_count: number }>()
		expect(row?.interaction_count).toBe(1)
	})
})
