import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
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
