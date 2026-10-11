import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import { getAndCacheObject, type Remote } from '@wildebeest/backend/activitypub/objects'
import { createImage } from '@wildebeest/backend/activitypub/objects/image'
import type { Note } from '@wildebeest/backend/activitypub/objects/note'
import { createDirectStatus, createPrivateStatus, createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek5'
const domain = 'cloudflare.com'

test('serve unknown object', async () => {
	const db = makeDB()
	const res = await app.fetch(new Request(`https://${domain}/ap/o/unknown-id`), { DATABASE: db })
	await assertStatus(res, 404)
})

test('serve object', async () => {
	const db = makeDB()
	const actor = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')
	const note = await createPublicStatus(domain, db, actor, 'content')

	const res = await app.fetch(new Request(note.id), { DATABASE: db })
	await assertStatus(res, 200)

	const data = await res.json<any>()
	assert.equal(data.content, '<p>content</p>')
})

test('does not serve a private object', async () => {
	const db = makeDB()
	const actor = await createTestUser(domain, db, userKEK, 'private@cloudflare.com')
	const note = await createPrivateStatus(domain, db, actor, 'private content')

	const res = await app.fetch(new Request(note.id), { DATABASE: db })
	await assertStatus(res, 404)
	assert.equal(await res.text(), '')
})

test('does not serve a direct object', async () => {
	const db = makeDB()
	const actor = await createTestUser(domain, db, userKEK, 'direct@cloudflare.com')
	const recipient = await createTestUser(domain, db, userKEK, 'direct-recipient@cloudflare.com')
	const note = await createDirectStatus(domain, db, actor, 'direct content', [], { to: [recipient] })

	const res = await app.fetch(new Request(note.id), { DATABASE: db })
	await assertStatus(res, 404)
	assert.equal(await res.text(), '')
})

test('does not serve a remote object', async () => {
	const db = makeDB()
	const actor = await createTestUser(domain, db, userKEK, 'remote-cache@cloudflare.com')
	const properties: Remote<Note> = {
		type: 'Note',
		id: 'https://example.com/id/remote-object',
		content: 'remote content',
		attributedTo: 'https://example.com/users/remote',
		attachment: [],
		to: [PUBLIC_GROUP],
		cc: [],
	}
	const cached = await getAndCacheObject<Note>(domain, db, properties, actor)
	assert.ok(cached?.object)

	const res = await app.fetch(new Request(cached.object.id), { DATABASE: db })
	await assertStatus(res, 404)
	assert.equal(await res.text(), '')
})

test('serves an image attached to a public object', async () => {
	const db = makeDB()
	const actor = await createTestUser(domain, db, userKEK, 'image-public@cloudflare.com')
	const image = await createImage(domain, db, actor, { url: 'https://example.com/image.jpg' })
	await createPublicStatus(domain, db, actor, 'public with image', [image])

	const res = await app.fetch(new Request(image.id), { DATABASE: db })
	await assertStatus(res, 200)
})

test('does not serve an unattached image', async () => {
	const db = makeDB()
	const actor = await createTestUser(domain, db, userKEK, 'image-orphan@cloudflare.com')
	const image = await createImage(domain, db, actor, { url: 'https://example.com/image.jpg' })

	const res = await app.fetch(new Request(image.id), { DATABASE: db })
	await assertStatus(res, 404)
	assert.equal(await res.text(), '')
})

test('does not serve an image attached to a direct object', async () => {
	const db = makeDB()
	const actor = await createTestUser(domain, db, userKEK, 'image-direct@cloudflare.com')
	const recipient = await createTestUser(domain, db, userKEK, 'image-direct-recipient@cloudflare.com')
	const image = await createImage(domain, db, actor, { url: 'https://example.com/image.jpg' })
	await createDirectStatus(domain, db, actor, 'direct with image', [image], { to: [recipient] })

	const res = await app.fetch(new Request(image.id), { DATABASE: db })
	await assertStatus(res, 404)
	assert.equal(await res.text(), '')
})
