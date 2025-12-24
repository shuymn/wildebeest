import { strict as assert } from 'node:assert/strict'

import app from 'wildebeest/backend/src'
import { mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { createPublicStatus, createReply } from 'wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, assertStatus } from 'wildebeest/backend/test/utils'

const userKEK = 'test_kek4'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]/context', () => {
	test('status context shows descendants', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const note = await createPublicStatus(domain, db, actor, 'a post', [], { sensitive: false })
		await sleep(10)

		await createReply(domain, db, actor, note, '@sven@cloudflare.com a reply')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]!}/context`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<{ ancestors: unknown[]; descendants: Array<{ content: unknown }> }>()
		assert.equal(data.ancestors.length, 0)
		assert.equal(data.descendants.length, 1)
		assert.equal(
			data.descendants[0].content,
			'<p><span class="h-card"><a href="https://cloudflare.com/@sven" class="u-url mention">@<span>sven</span></a></span> a reply</p>'
		)
	})
})
