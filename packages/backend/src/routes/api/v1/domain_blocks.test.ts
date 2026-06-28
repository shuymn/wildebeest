import { strict as assert } from 'node:assert/strict'

import app from '@wildebeest/backend'
import type { User } from '@wildebeest/backend/accounts'
import type { Database } from '@wildebeest/backend/database'
import { deleteDomainBlock, getDomainBlocks, insertDomainBlock } from '@wildebeest/backend/mastodon/domain_block'
import { assertJSON, assertStatus, createTestUser, makeDB } from '@wildebeest/backend/test/utils'

const userKEK = 'test_kek_domain_blocks'
const domain = 'cloudflare.com'

async function block(db: Database, connectedActor: User, target: string) {
	return app.fetch(
		new Request(`https://${domain}/api/v1/domain_blocks`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ domain: target }),
		}),
		{ DATABASE: db, data: { connectedActor } }
	)
}

async function unblock(db: Database, connectedActor: User, target: string) {
	return app.fetch(
		new Request(`https://${domain}/api/v1/domain_blocks`, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ domain: target }),
		}),
		{ DATABASE: db, data: { connectedActor } }
	)
}

async function list(db: Database, connectedActor: User, query = '') {
	return app.fetch(new Request(`https://${domain}/api/v1/domain_blocks${query}`), {
		DATABASE: db,
		data: { connectedActor },
	})
}

describe('/api/v1/domain_blocks', () => {
	test('block, list, and unblock a domain', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'domain-blocker@cloudflare.com')

		const blockRes = await block(db, actor, 'spam.example')
		await assertStatus(blockRes, 200)
		assertJSON(blockRes)
		assert.deepEqual(await blockRes.json(), {})

		const afterBlock = await list(db, actor)
		await assertStatus(afterBlock, 200)
		assertJSON(afterBlock)
		assert.deepEqual(await afterBlock.json<string[]>(), ['spam.example'])

		const unblockRes = await unblock(db, actor, 'spam.example')
		await assertStatus(unblockRes, 200)
		assert.deepEqual(await unblockRes.json(), {})

		const afterUnblock = await list(db, actor)
		await assertStatus(afterUnblock, 200)
		assert.deepEqual(await afterUnblock.json<string[]>(), [])
	})

	test('blocking the same domain twice is idempotent', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'idempotent-block@cloudflare.com')

		await assertStatus(await block(db, actor, 'dupe.example'), 200)
		await assertStatus(await block(db, actor, 'dupe.example'), 200)

		const res = await list(db, actor)
		assert.deepEqual(await res.json<string[]>(), ['dupe.example'])

		const row = await db
			.prepare(`SELECT count(*) as count FROM domain_blocks WHERE domain = ?`)
			.bind('dupe.example')
			.first<{ count: number }>()
		assert.equal(row?.count, 1)
	})

	test('unblocking a domain that is not blocked is a no-op', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'noop-unblock@cloudflare.com')

		const res = await unblock(db, actor, 'never-blocked.example')
		await assertStatus(res, 200)
		assert.deepEqual(await res.json(), {})
	})

	test('domains are normalized (trimmed and lowercased)', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'normalize-block@cloudflare.com')

		await assertStatus(await block(db, actor, '  Spam.Example  '), 200)
		// A differently-cased duplicate must collapse onto the same block.
		await assertStatus(await block(db, actor, 'SPAM.EXAMPLE'), 200)

		const res = await list(db, actor)
		assert.deepEqual(await res.json<string[]>(), ['spam.example'])

		// Unblocking with yet another casing variant must remove the block.
		const unblockRes = await unblock(db, actor, 'Spam.Example')
		await assertStatus(unblockRes, 200)
		assert.deepEqual(await (await list(db, actor)).json<string[]>(), [])
	})

	test('domain can be supplied as a query parameter', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'query-block@cloudflare.com')

		const blockRes = await app.fetch(
			new Request(`https://${domain}/api/v1/domain_blocks?domain=query.example`, { method: 'POST' }),
			{ DATABASE: db, data: { connectedActor: actor } }
		)
		await assertStatus(blockRes, 200)

		assert.deepEqual(await (await list(db, actor)).json<string[]>(), ['query.example'])
	})

	test('data layer normalizes domains for storage and deletion', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'data-normalize-block@cloudflare.com')

		await insertDomainBlock(db, actor, '  Data.Example  ')
		await insertDomainBlock(db, actor, 'DATA.EXAMPLE')

		assert.deepEqual(
			(await getDomainBlocks(db, actor, { limit: 100 })).map((block) => block.domain),
			['data.example']
		)

		await deleteDomainBlock(db, actor, 'Data.Example')
		assert.deepEqual(await getDomainBlocks(db, actor, { limit: 100 }), [])
	})

	test('domain blocks can be paginated', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'pagination-block@cloudflare.com')
		await db
			.prepare(
				`
INSERT INTO domain_blocks (id, account_id, domain, created_at)
VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)
`
			)
			.bind(
				'block-oldest',
				actor.id.toString(),
				'oldest.example',
				'2024-01-01 00:00:00.000',
				'block-middle',
				actor.id.toString(),
				'middle.example',
				'2024-01-02 00:00:00.000',
				'block-newest',
				actor.id.toString(),
				'newest.example',
				'2024-01-03 00:00:00.000'
			)
			.run()

		const firstPage = await list(db, actor, '?limit=2')
		await assertStatus(firstPage, 200)
		assert.deepEqual(await firstPage.json<string[]>(), ['newest.example', 'middle.example'])
		assert.match(firstPage.headers.get('link') ?? '', /max_id=block-middle/)
		assert.match(firstPage.headers.get('link') ?? '', /min_id=block-newest/)

		const nextPage = await list(db, actor, '?limit=2&max_id=block-middle')
		await assertStatus(nextPage, 200)
		assert.deepEqual(await nextPage.json<string[]>(), ['oldest.example'])
	})

	test('blocking without a domain returns 422', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'missing-domain@cloudflare.com')

		const missing = await app.fetch(new Request(`https://${domain}/api/v1/domain_blocks`, { method: 'POST' }), {
			DATABASE: db,
			data: { connectedActor: actor },
		})
		await assertStatus(missing, 422)

		const blank = await block(db, actor, '   ')
		await assertStatus(blank, 422)

		const invalidBlock = await block(db, actor, 'exa mple.com')
		await assertStatus(invalidBlock, 422)

		const invalidUnblock = await unblock(db, actor, 'exa mple.com')
		await assertStatus(invalidUnblock, 422)
	})

	test('domain blocks are scoped per account', async () => {
		const db = makeDB()
		const actor = await createTestUser(domain, db, userKEK, 'scoped-a@cloudflare.com')
		const other = await createTestUser(domain, db, userKEK, 'scoped-b@cloudflare.com')

		await assertStatus(await block(db, actor, 'only-actor.example'), 200)

		assert.deepEqual(await (await list(db, actor)).json<string[]>(), ['only-actor.example'])
		assert.deepEqual(await (await list(db, other)).json<string[]>(), [])
	})

	test('requires authentication', async () => {
		const db = makeDB()

		const getRes = await app.fetch(new Request(`https://${domain}/api/v1/domain_blocks`), { DATABASE: db })
		await assertStatus(getRes, 401)

		const postRes = await app.fetch(
			new Request(`https://${domain}/api/v1/domain_blocks`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ domain: 'spam.example' }),
			}),
			{ DATABASE: db }
		)
		await assertStatus(postRes, 401)

		const deleteRes = await app.fetch(
			new Request(`https://${domain}/api/v1/domain_blocks`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ domain: 'spam.example' }),
			}),
			{ DATABASE: db }
		)
		await assertStatus(deleteRes, 401)
	})
})
