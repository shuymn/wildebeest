import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { PUBLIC_GROUP } from '@wildebeest/backend/activitypub/activities'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { createReblog } from '@wildebeest/backend/mastodon/reblog'
import { createPublicStatus, createReply } from '@wildebeest/backend/test/shared.utils'
import { makeDB, createTestUser, assertStatus } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek4'
const domain = 'cloudflare.com'

describe('/api/v1/statuses/[id]/context', () => {
	test('status context shows descendants', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')

		const note = await createPublicStatus(domain, db, actor, 'a post')

		await createReply(domain, db, actor, note, '@sven@cloudflare.com a reply')

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/context`)
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

	test('status context does not duplicate reblogged descendants', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const reblogger = await createTestUser(domain, db, userKEK, 'reblogger@cloudflare.com')

		const note = await createPublicStatus(domain, db, actor, 'a post')
		const reply = await createReply(domain, db, actor, note, '@sven@cloudflare.com a reply')
		const inserted = await createReblog(db, reblogger, reply, {
			to: [PUBLIC_GROUP],
			cc: [],
			id: 'https://example.com/reblogged-reply',
		})
		assert.equal(inserted, true)

		const req = new Request(`https://${domain}/api/v1/statuses/${note[mastodonIdSymbol]}/context`)
		const res = await app.fetch(req, { DATABASE: db })
		await assertStatus(res, 200)

		const data = await res.json<{ descendants: Array<{ account: { username: string } }> }>()
		assert.equal(data.descendants.length, 1)
		assert.equal(data.descendants[0].account.username, 'sven')
	})
})
