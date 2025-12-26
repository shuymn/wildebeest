import { strict as assert } from 'node:assert/strict'

import { ApObject, getAndCacheObject, originalObjectIdSymbol, Remote } from '@wildebeest/backend/activitypub/objects'
import { Note } from '@wildebeest/backend/activitypub/objects/note'
import { createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek5'
const domain = 'cloudflare.com'

describe('Objects', () => {
	test('cacheObject deduplicates object', async () => {
		const db = makeDB()
		const properties: Remote<Note> = {
			type: 'Note',
			id: 'https://example.com/id/object1',
			url: 'https://example.com/url/object1',
		}
		const actor = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')

		let result: any

		// Cache object once adds it to the database
		const res1 = await getAndCacheObject(domain, db, properties, actor)
		assert.ok(res1)
		assert.ok(res1.object)
		assert.ok(res1.created)
		assert.equal(res1.object[originalObjectIdSymbol], 'https://example.com/id/object1')
		assert.equal(res1.object.url?.toString(), 'https://example.com/url/object1')
		assert(res1.created)

		result = await db.prepare('SELECT count(*) as count from objects').first()
		assert.equal(result.count, 1)

		// Cache object second time updates the first one
		properties.url = 'https://example.com/url/object2'
		const res2 = await getAndCacheObject(domain, db, properties, actor)
		// The creation date and properties don't change
		assert.ok(res2)
		assert.ok(res2.object)
		assert.ok(!res2.created)
		assert.equal(res1.object.id.toString(), res2.object.id.toString())
		assert.equal(res1.object.url.toString(), res2.object.url?.toString())
		assert.equal(res1.object.published, res2.object.published)
		assert(!res2.created)

		result = await db.prepare('SELECT count(*) as count from objects').first()
		assert.equal(result.count, 1)
	})

	test('cacheObject adds peer', async () => {
		const db = makeDB()
		const properties: ApObject = {
			type: 'Note',
			id: 'https://example.com/id/object1',
			url: 'https://example.com/url/object1',
		}
		const actor = await createTestUser(domain, db, userKEK, 'a@cloudflare.com')

		await getAndCacheObject(domain, db, properties, actor)

		const { results } = (await db.prepare('SELECT domain from peers').all()) as any
		assert.equal(results.length, 1)
		assert.equal(results[0].domain, 'example.com')
	})
})
