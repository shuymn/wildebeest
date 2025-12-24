import { strict as assert } from 'node:assert/strict'

import { moveFollowers } from 'wildebeest/backend/src/mastodon/follow'
import { makeDB, createTestUser } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek23'
const domain = 'cloudflare.com'

describe('Follow', () => {
	test('move followers', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		globalThis.fetch = async (input: RequestInfo) => {
			if (input instanceof URL || typeof input === 'string') {
				if (input.toString() === 'https://example.com/user/a') {
					return new Response(
						JSON.stringify({ id: 'https://example.com/user/a', type: 'Person', preferredUsername: 'a' })
					)
				}
				if (input.toString() === 'https://example.com/user/b') {
					return new Response(
						JSON.stringify({ id: 'https://example.com/user/b', type: 'Person', preferredUsername: 'b' })
					)
				}
				if (input.toString() === 'https://example.com/user/c') {
					return new Response(
						JSON.stringify({ id: 'https://example.com/user/c', type: 'Person', preferredUsername: 'c' })
					)
				}
				throw new Error(`unexpected request to "${input.toString()}"`)
			}
			throw new Error('unexpected request to ' + input.url)
		}

		const followers = ['https://example.com/user/a', 'https://example.com/user/b', 'https://example.com/user/c']

		await moveFollowers(domain, db, actor, followers)

		const { results, success } = await db.prepare('SELECT * FROM actor_following').all<any>()
		assert(success)
		assert(results)
		assert.equal(results.length, 3)
		assert.equal(results[0].state, 'accepted')
		assert.equal(results[0].actor_id, 'https://example.com/user/a')
		assert.equal(results[0].target_actor_acct, 'sven')
		assert.equal(results[1].state, 'accepted')
		assert.equal(results[1].actor_id, 'https://example.com/user/b')
		assert.equal(results[1].target_actor_acct, 'sven')
		assert.equal(results[2].state, 'accepted')
		assert.equal(results[2].actor_id, 'https://example.com/user/c')
		assert.equal(results[2].target_actor_acct, 'sven')
	})
})
