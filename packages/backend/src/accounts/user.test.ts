import { strict as assert } from 'node:assert/strict'

import { isAdminUser } from '@wildebeest/backend/accounts'
import { createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_user'
const domain = 'cloudflare.com'

describe('isAdminUser', () => {
	test('unauthenticated requests are not admin', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'owner@cloudflare.com')
		assert.equal(await isAdminUser(db, 'owner@cloudflare.com', null), false)
	})

	test('other users are not admin', async () => {
		const db = makeDB()
		await createTestUser(domain, db, userKEK, 'owner@cloudflare.com')
		const other = await createTestUser(domain, db, userKEK, 'other@cloudflare.com')
		assert.equal(await isAdminUser(db, 'owner@cloudflare.com', other), false)
		assert.equal(await isAdminUser(db, '', other), false)
	})

	test('the owner is admin', async () => {
		const db = makeDB()
		const owner = await createTestUser(domain, db, userKEK, 'owner@cloudflare.com')
		assert.equal(await isAdminUser(db, 'owner@cloudflare.com', owner), true)
	})

	test('users flagged as admin are admin', async () => {
		const db = makeDB()
		const admin = await createTestUser(domain, db, userKEK, 'admin@cloudflare.com', {}, true)
		assert.equal(await isAdminUser(db, 'owner@cloudflare.com', admin), true)
	})
})
