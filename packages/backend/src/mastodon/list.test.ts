import { strict as assert } from 'node:assert/strict'

import { mastodonIdSymbol } from '@wildebeest/backend/activitypub/objects'
import {
	addAccountsToList,
	createList,
	deleteList,
	getListById,
	getListMemberActorIds,
	getListsContainingAccount,
	getListsForOwner,
	removeAccountsFromList,
	updateList,
} from '@wildebeest/backend/mastodon/list'
import { createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_list_module'
const domain = 'cloudflare.com'

describe('mastodon/list', () => {
	test('create, read, update, and delete lists', async () => {
		const db = makeDB()
		const owner = await createTestUser(domain, db, userKEK, 'owner@cloudflare.com')

		const created = await createList(db, owner.id.toString(), 'Friends', 'followed', true)
		assert.equal(created.title, 'Friends')
		assert.equal(created.replies_policy, 'followed')
		assert.equal(created.exclusive, true)

		const lists = await getListsForOwner(db, owner.id.toString())
		assert.equal(lists.length, 1)
		assert.equal(lists[0]?.id, created.id)

		const fetched = await getListById(db, created.id, owner.id.toString())
		assert.equal(fetched?.title, 'Friends')
		assert.equal(fetched?.exclusive, true)

		const updated = await updateList(db, created.id, owner.id.toString(), { title: 'Close friends' })
		assert.equal(updated?.title, 'Close friends')

		const deleted = await deleteList(db, created.id, owner.id.toString())
		assert.equal(deleted, true)
		assert.equal(await getListById(db, created.id, owner.id.toString()), null)
	})

	test('getListById returns null for another owner', async () => {
		const db = makeDB()
		const owner = await createTestUser(domain, db, userKEK, 'owner2@cloudflare.com')
		const other = await createTestUser(domain, db, userKEK, 'other@cloudflare.com')

		const list = await createList(db, owner.id.toString(), 'Private list')

		assert.equal(await getListById(db, list.id, other.id.toString()), null)
	})

	test('add and remove list members', async () => {
		const db = makeDB()
		const owner = await createTestUser(domain, db, userKEK, 'owner3@cloudflare.com')
		const member = await createTestUser(domain, db, userKEK, 'member@cloudflare.com')

		const list = await createList(db, owner.id.toString(), 'Team')

		const added = await addAccountsToList(db, list.id, owner.id.toString(), [member[mastodonIdSymbol]])
		assert.equal(added?.id, list.id)

		const memberIds = await getListMemberActorIds(db, list.id)
		assert.deepEqual(memberIds, [member.id.toString()])

		const containing = await getListsContainingAccount(db, owner.id.toString(), member.id.toString())
		assert.equal(containing.length, 1)
		assert.equal(containing[0]?.id, list.id)

		await removeAccountsFromList(db, list.id, owner.id.toString(), [member[mastodonIdSymbol]])
		assert.deepEqual(await getListMemberActorIds(db, list.id), [])
	})
})
