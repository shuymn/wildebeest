import { strict as assert } from 'node:assert/strict'

import { AnnounceActivity, CreateActivity, PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import * as activityHandler from '@wildebeest/backend/activitypub/activities/handle'
import { getAndCacheActor } from '@wildebeest/backend/activitypub/actors'
import { getApId } from '@wildebeest/backend/activitypub/objects'
import { Note } from '@wildebeest/backend/activitypub/objects/note'
import type { Database } from '@wildebeest/backend/database'
import { createActivityId, createTestUser, makeDB } from '@wildebeest/backend/test/utils'
import type { JWK } from '@wildebeest/backend/webpush/jwk'

const adminEmail = 'admin@example.com'
const domain = 'cloudflare.com'
const userKEK = 'test_kek_identity'
const vapidKeys = {} as JWK

function person(id: string, preferredUsername: string) {
	return { id, type: 'Person', preferredUsername }
}

function note(id: string, attributedTo: string, extra: Partial<Note> = {}): Note {
	return {
		id,
		type: 'Note',
		content: 'content of ' + id,
		attributedTo,
		attachment: [],
		to: [PUBLIC_GROUP],
		cc: [],
		sensitive: false,
		...extra,
	}
}

// Serve the given documents by URL; any other request is a 404.
function serve(documents: Record<string, unknown>): string[] {
	const requests: string[] = []
	globalThis.fetch = (input) => {
		const url = input instanceof URL || typeof input === 'string' ? input.toString() : input.url
		requests.push(url)
		const document = documents[url]
		if (document === undefined) {
			return Promise.resolve(new Response('', { status: 404 }))
		}
		return Promise.resolve(new Response(JSON.stringify(document)))
	}
	return requests
}

// Remote objects reach the cache through an Announce of their URL.
async function announce(db: Database, objectUrl: string) {
	const activity: AnnounceActivity = {
		type: 'Announce',
		id: getApId('https://evil.example/announce/1'),
		actor: getApId('https://evil.example/actor'),
		to: [PUBLIC_GROUP],
		cc: [],
		object: getApId(objectUrl),
	}
	await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)
}

async function objectRows(db: Database) {
	const { results } = await db
		.prepare('SELECT original_object_id, original_actor_id, properties FROM objects')
		.all<{ original_object_id: string; original_actor_id: string; properties: string }>()
	return results ?? []
}

async function actorRow(db: Database, id: string) {
	return db.prepare('SELECT properties FROM actors WHERE id=?1').bind(id).first<{ properties: string }>()
}

describe('Remote fetch identity', () => {
	test('an actor document claiming an id of another origin is refetched from that origin', async () => {
		const db = makeDB()
		serve({
			'https://evil.example/actor': person('https://victim.example/actor', 'forged'),
			'https://victim.example/actor': person('https://victim.example/actor', 'genuine'),
		})

		const actor = await getAndCacheActor(new URL('https://evil.example/actor'), db)
		assert.ok(actor)
		assert.equal(actor.id.toString(), 'https://victim.example/actor')
		assert.equal(actor.preferredUsername, 'genuine')
		const row = await actorRow(db, 'https://victim.example/actor')
		assert.ok(row)
		assert.equal(JSON.parse(row.properties).preferredUsername, 'genuine')
	})

	test('an actor document whose id is not confirmed by its origin is rejected', async () => {
		const db = makeDB()
		serve({ 'https://evil.example/actor': person('https://victim.example/actor', 'forged') })

		assert.equal(await getAndCacheActor(new URL('https://evil.example/actor'), db), null)
		assert.equal(await actorRow(db, 'https://victim.example/actor'), null)
	})

	test('an actor document from another port of the claimed host is rejected', async () => {
		const db = makeDB()
		serve({ 'https://victim.example:8443/actor': person('https://victim.example/actor', 'forged') })

		assert.equal(await getAndCacheActor(new URL('https://victim.example:8443/actor'), db), null)
		assert.equal(await actorRow(db, 'https://victim.example/actor'), null)
	})

	test('a fetched object claiming an id of another origin is not cached under that id', async () => {
		const db = makeDB()
		const requests = serve({
			'https://evil.example/note': note('https://victim.example/note', 'https://victim.example/actor', {
				content: 'forged',
			}),
			'https://victim.example/actor': person('https://victim.example/actor', 'victim'),
			'https://evil.example/actor': person('https://evil.example/actor', 'evil'),
		})

		await announce(db, 'https://evil.example/note')
		assert.equal((await objectRows(db)).length, 0)
		assert.ok(requests.includes('https://victim.example/note'))
	})

	test('a fetched object is cached from its own origin when the first copy names another id', async () => {
		const db = makeDB()
		serve({
			'https://evil.example/note': note('https://victim.example/note', 'https://victim.example/actor', {
				content: 'forged',
			}),
			'https://victim.example/note': note('https://victim.example/note', 'https://victim.example/actor', {
				content: 'genuine',
			}),
			'https://victim.example/actor': person('https://victim.example/actor', 'victim'),
			'https://evil.example/actor': person('https://evil.example/actor', 'evil'),
		})

		await announce(db, 'https://evil.example/note')
		const rows = await objectRows(db)
		assert.equal(rows.length, 1)
		assert.equal(rows[0].original_object_id, 'https://victim.example/note')
		assert.equal(JSON.parse(rows[0].properties).content, 'genuine')
	})

	test('an object attributed to an actor of another origin is rejected', async () => {
		const db = makeDB()
		serve({
			'https://evil.example/note': note('https://evil.example/note', 'https://victim.example/actor'),
			'https://victim.example/actor': person('https://victim.example/actor', 'victim'),
			'https://evil.example/actor': person('https://evil.example/actor', 'evil'),
		})

		await announce(db, 'https://evil.example/note')
		assert.equal((await objectRows(db)).length, 0)
	})

	test('an announced object is attributed to its author, not to the announcing actor', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		serve({
			'https://booster.example/actor': person('https://booster.example/actor', 'booster'),
			'https://author.example/actor': person('https://author.example/actor', 'author'),
			'https://author.example/note': note('https://author.example/note', 'https://author.example/actor'),
		})

		const activity: AnnounceActivity = {
			type: 'Announce',
			id: getApId('https://booster.example/announce/1'),
			actor: getApId('https://booster.example/actor'),
			to: [PUBLIC_GROUP],
			cc: [],
			object: getApId('https://author.example/note'),
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const rows = await objectRows(db)
		assert.equal(rows.length, 1)
		assert.equal(rows[0].original_actor_id, 'https://author.example/actor')
	})

	test('the parent of an inbound reply is attributed to its own author', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		serve({
			'https://replier.example/actor': person('https://replier.example/actor', 'replier'),
			'https://author.example/actor': person('https://author.example/actor', 'author'),
			'https://author.example/note': note('https://author.example/note', 'https://author.example/actor'),
		})

		const activity: CreateActivity<Note> = {
			type: 'Create',
			id: createActivityId('replier.example'),
			actor: getApId('https://replier.example/actor'),
			to: [PUBLIC_GROUP],
			cc: [],
			object: note('https://replier.example/reply', 'https://replier.example/actor', {
				inReplyTo: 'https://author.example/note',
			}),
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		const authors = Object.fromEntries((await objectRows(db)).map((r) => [r.original_object_id, r.original_actor_id]))
		assert.equal(authors['https://replier.example/reply'], 'https://replier.example/actor')
		assert.equal(authors['https://author.example/note'], 'https://author.example/actor')
	})
})
