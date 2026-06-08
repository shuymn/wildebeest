import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import { addAccountsToList, createList } from '@wildebeest/backend/mastodon/list'
import { createPublicStatus } from '@wildebeest/backend/test/shared.utils'
import { assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_list_timeline'
const domain = 'cloudflare.com'

describe('/api/v1/timelines/list/[id]', () => {
	test('returns statuses from list members', async () => {
		const db = makeDB()
		const owner = await createTestUser(domain, db, userKEK, 'timeline-owner@cloudflare.com')
		const member = await createTestUser(domain, db, userKEK, 'timeline-member@cloudflare.com')
		const outsider = await createTestUser(domain, db, userKEK, 'timeline-outsider@cloudflare.com')

		const list = await createList(db, owner.id.toString(), 'Feed')
		await addAccountsToList(db, list.id, owner.id.toString(), [member[mastodonIdSymbol]])

		await createPublicStatus(domain, db, member, 'in the list')
		await createPublicStatus(domain, db, outsider, 'not in the list')

		const timelineRes = await app.fetch(new Request(`https://${domain}/api/v1/timelines/list/${list.id}`), {
			DATABASE: db,
			data: { connectedActor: owner },
		})
		await assertStatus(timelineRes, 200)
		const statuses = await timelineRes.json<Array<{ content: string; account: { username: string } }>>()
		assert.equal(statuses.length, 1)
		assert.equal(statuses[0]?.content, '<p>in the list</p>')
		assert.equal(statuses[0]?.account.username, 'timeline-member')
	})
})
