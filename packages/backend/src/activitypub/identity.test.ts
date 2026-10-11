import { strict as assert } from 'node:assert/strict'

import {
	AnnounceActivity,
	CreateActivity,
	DeleteActivity,
	PUBLIC_GROUP,
} from '@wildebeest/backend/activitypub/activities'
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

// A URL answered with a redirect to another URL, which `fetch` follows.
type Redirect = { redirectTo: string }

function isRedirect(value: unknown): value is Redirect {
	return typeof value === 'object' && value !== null && 'redirectTo' in value
}

// Serve the given documents by URL, like `fetch` would: the response URL is
// the final URL after redirects. Any other request is a 404.
function serve(documents: Record<string, unknown>): string[] {
	const requests: string[] = []
	globalThis.fetch = (input) => {
		let url = input instanceof URL || typeof input === 'string' ? input.toString() : input.url
		requests.push(url)
		let document = documents[url]
		while (isRedirect(document)) {
			url = document.redirectTo
			document = documents[url]
		}
		if (document === undefined) {
			return Promise.resolve(new Response('', { status: 404 }))
		}
		const res = new Response(JSON.stringify(document))
		Object.defineProperty(res, 'url', { value: url })
		return Promise.resolve(res)
	}
	return requests
}

// Remote objects reach the cache through an Announce of their URL.
async function announce(db: Database, objectUrl: string, actor = 'https://evil.example/actor') {
	const activity: AnnounceActivity = {
		type: 'Announce',
		id: getApId(`${actor}/announce/${crypto.randomUUID()}`),
		actor: getApId(actor),
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

describe('Remote actor fetch identity', () => {
	test('an actor document claiming an id of another origin is rejected', async () => {
		const db = makeDB()
		serve({
			'https://evil.example/actor': person('https://victim.example/actor', 'forged'),
			'https://victim.example/actor': person('https://victim.example/actor', 'genuine'),
		})

		assert.equal(await getAndCacheActor(new URL('https://evil.example/actor'), db), null)
		assert.equal(await actorRow(db, 'https://victim.example/actor'), null)
	})

	test('an actor document claiming another id of the same origin is rejected', async () => {
		const db = makeDB()
		serve({
			'https://example.com/a': person('https://example.com/b', 'b'),
			'https://example.com/b': person('https://example.com/b', 'b'),
		})

		// Callers use the returned id as the actor they asked for.
		assert.equal(await getAndCacheActor(new URL('https://example.com/a'), db), null)
		assert.equal(await actorRow(db, 'https://example.com/b'), null)
	})

	test('an actor document from another port of the claimed host is rejected', async () => {
		const db = makeDB()
		serve({ 'https://victim.example:8443/actor': person('https://victim.example/actor', 'forged') })

		assert.equal(await getAndCacheActor(new URL('https://victim.example:8443/actor'), db), null)
		assert.equal(await actorRow(db, 'https://victim.example/actor'), null)
	})

	test('an actor document cannot claim to be a local actor', async () => {
		const db = makeDB()
		const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const before = await actorRow(db, local.id.toString())
		serve({ 'https://evil.example/actor': person(local.id.toString(), 'forged') })

		assert.equal(await getAndCacheActor(new URL('https://evil.example/actor'), db), null)
		assert.deepEqual(await actorRow(db, local.id.toString()), before)
	})

	test('an actor document cannot replace a cached actor of another origin', async () => {
		const db = makeDB()
		serve({ 'https://victim.example/actor': person('https://victim.example/actor', 'genuine') })
		assert.ok(await getAndCacheActor(new URL('https://victim.example/actor'), db))
		serve({ 'https://evil.example/actor': person('https://victim.example/actor', 'forged') })

		assert.equal(await getAndCacheActor(new URL('https://evil.example/actor'), db), null)
		const row = await actorRow(db, 'https://victim.example/actor')
		assert.ok(row)
		assert.equal(JSON.parse(row.properties).preferredUsername, 'genuine')
	})

	test('an actor document served after a same-origin redirect is accepted', async () => {
		const db = makeDB()
		serve({
			'https://example.com/actor': { redirectTo: 'https://example.com/users/actor' },
			'https://example.com/users/actor': person('https://example.com/actor', 'actor'),
		})

		const actor = await getAndCacheActor(new URL('https://example.com/actor'), db)
		assert.ok(actor)
		assert.equal(actor.id.toString(), 'https://example.com/actor')
	})

	test('an actor document served after a cross-origin redirect is rejected', async () => {
		const db = makeDB()
		serve({
			'https://victim.example/actor': { redirectTo: 'https://evil.example/actor' },
			'https://evil.example/actor': person('https://victim.example/actor', 'forged'),
		})

		assert.equal(await getAndCacheActor(new URL('https://victim.example/actor'), db), null)
		assert.equal(await actorRow(db, 'https://victim.example/actor'), null)
	})
})

describe('Remote object fetch identity', () => {
	const actors = {
		'https://evil.example/actor': person('https://evil.example/actor', 'evil'),
		'https://victim.example/actor': person('https://victim.example/actor', 'victim'),
		'https://victim.example/booster': person('https://victim.example/booster', 'booster'),
		'https://author.example/actor': person('https://author.example/actor', 'author'),
		'https://replier.example/actor': person('https://replier.example/actor', 'replier'),
	}

	test('a fetched object claiming an id of another origin is not cached', async () => {
		const db = makeDB()
		serve({
			...actors,
			'https://evil.example/note': note('https://victim.example/note', 'https://victim.example/actor', {
				content: 'forged',
			}),
			'https://victim.example/note': note('https://victim.example/note', 'https://victim.example/actor'),
		})

		await announce(db, 'https://evil.example/note')
		assert.equal((await objectRows(db)).length, 0)
	})

	test('a fetched object cannot claim an id on our origin', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const localId = `https://${domain}/ap/o/forged`
		serve({
			...actors,
			[localId]: { redirectTo: 'https://evil.example/note' },
			'https://evil.example/note': note(localId, 'https://evil.example/actor'),
		})

		await announce(db, localId)
		assert.equal((await objectRows(db)).length, 0)
	})

	test('a fetched object cannot replace a cached object of another origin', async () => {
		const db = makeDB()
		serve({
			...actors,
			'https://victim.example/note': note('https://victim.example/note', 'https://victim.example/actor', {
				content: 'genuine',
			}),
			'https://evil.example/note': note('https://victim.example/note', 'https://victim.example/actor', {
				content: 'forged',
			}),
		})
		await announce(db, 'https://victim.example/note', 'https://author.example/actor')

		await announce(db, 'https://evil.example/note')

		const rows = await objectRows(db)
		assert.equal(rows.length, 1)
		assert.equal(JSON.parse(rows[0].properties).content, 'genuine')
		assert.equal(rows[0].original_actor_id, 'https://victim.example/actor')
	})

	test('an object served after a cross-origin redirect is rejected', async () => {
		const db = makeDB()
		serve({
			...actors,
			'https://victim.example/note': { redirectTo: 'https://evil.example/note' },
			'https://evil.example/note': note('https://victim.example/note', 'https://victim.example/actor'),
		})

		await announce(db, 'https://victim.example/note')
		assert.equal((await objectRows(db)).length, 0)
	})

	test('an object served after a same-origin redirect is cached under its id', async () => {
		const db = makeDB()
		serve({
			...actors,
			'https://victim.example/note': { redirectTo: 'https://victim.example/notes/1' },
			'https://victim.example/notes/1': note('https://victim.example/note', 'https://victim.example/actor'),
		})

		await announce(db, 'https://victim.example/note')
		const rows = await objectRows(db)
		assert.equal(rows.length, 1)
		assert.equal(rows[0].original_object_id, 'https://victim.example/note')
	})

	test('an object attributed to an actor of another origin is rejected', async () => {
		const db = makeDB()
		serve({
			...actors,
			'https://evil.example/note': note('https://evil.example/note', 'https://victim.example/actor'),
		})

		await announce(db, 'https://evil.example/note')
		assert.equal((await objectRows(db)).length, 0)
	})

	test('an announced object is attributed to its author, not to the announcing actor', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		serve({
			...actors,
			'https://author.example/note': note('https://author.example/note', 'https://author.example/actor'),
		})

		await announce(db, 'https://author.example/note')

		const rows = await objectRows(db)
		assert.equal(rows.length, 1)
		assert.equal(rows[0].original_actor_id, 'https://author.example/actor')
	})

	test('an announcing actor cannot delete the announced object', async () => {
		const db = makeDB()
		serve({
			...actors,
			'https://victim.example/note': note('https://victim.example/note', 'https://victim.example/actor'),
		})
		// The booster shares the origin of the author, so only the recorded owner
		// tells them apart.
		await announce(db, 'https://victim.example/note', 'https://victim.example/booster')

		const activity: DeleteActivity = {
			type: 'Delete',
			id: getApId('https://victim.example/booster/delete/1'),
			actor: getApId('https://victim.example/booster'),
			object: getApId('https://victim.example/note'),
		}
		await activityHandler.handle(domain, activity, db, userKEK, adminEmail, vapidKeys)

		assert.equal((await objectRows(db)).length, 1)
	})

	test('the parent of an inbound reply is attributed to its own author', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		serve({
			...actors,
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
