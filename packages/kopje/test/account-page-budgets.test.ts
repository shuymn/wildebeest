import { describe, expect, it } from 'vitest'

import { type ApiHarness, login, registerApp, setSetting, sql } from './api-helpers'
import { answer, expectByteCutWalk, maximalAccounts, walk } from './budget-helpers'
import { community } from './status-helpers'
import { ANSWER_BYTES } from '../src/domain/answer-budget'

// RES-3: the remaining pages of accounts are answers within ANSWER_BYTES. Edge-cursor pages (blocks, mutes) and the
// admin's account list continue from their last admitted account; the directory, an offset endpoint, answers fewer
// accounts, and a client that advances its offset by the number received continues after them.

// 80 accounts at their bounds (about 121 KB each): about 70 fit one answer.
const COUNT = 80

async function edgeCursors(h: ApiHarness, table: 'blocks' | 'mutes', owner: string) {
	return new Map(
		(
			await sql<{ id: string; target: string }>(
				h.store,
				`SELECT CAST(id AS TEXT) AS id, target_account_id AS target FROM ${table} WHERE account_id = ?`,
				owner
			)
		).map((row) => [row.target, row.id])
	)
}

describe('pages of accounts within ANSWER_BYTES (RES-3)', () => {
	it('walk blocks and mutes once each in both directions, cut by bytes', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const ids = await maximalAccounts(h, 'edge', COUNT)
		for (const id of ids) {
			await sql(h.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', alice.id, id)
			await sql(h.store, 'INSERT INTO mutes (account_id, target_account_id) VALUES (?, ?)', alice.id, id)
		}
		const size = (await answer<unknown>(h, `/api/v1/accounts/${ids[0]!}`, alice.token)).bytes
		for (const table of ['blocks', 'mutes'] as const) {
			const cursors = await edgeCursors(h, table, alice.id)
			const newest = ids.toReversed()
			const cursorOf = (id: string) => cursors.get(id)!
			const path = `/api/v1/${table}?limit=80`
			expectByteCutWalk(table, await walk(h, path, 'next', alice.token), newest, 'next', size, cursorOf)
			expectByteCutWalk(table, await walk(h, `${path}&min_id=0`, 'prev', alice.token), ids, 'prev', size, cursorOf)
		}
		const [muted] = (await answer<{ mute_expires_at: unknown }[]>(h, '/api/v1/mutes?limit=1', alice.token)).body
		expect(muted).toHaveProperty('mute_expires_at', null)
	}, 300_000)

	it('answers the directory with fewer accounts, its offset continuing after them', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const ids = await maximalAccounts(h, 'listed', COUNT)
		await sql(
			h.store,
			'UPDATE accounts SET discoverable = 1 WHERE id IN (SELECT value FROM json_each(?))',
			JSON.stringify(ids)
		)
		const first = await answer<{ id: string }[]>(h, '/api/v1/directory?order=new&limit=80&local=false', alice.token)
		expect(first.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		// More accounts match than the answer holds. A client that advances by the number received (Tusky, Ivory)
		// continues after them; Mastodon's web client takes the short answer for the last (docs/response-inventory.md).
		expect(first.body.length).toBeLessThan(COUNT)
		const rest = await answer<{ id: string }[]>(
			h,
			`/api/v1/directory?order=new&limit=80&local=false&offset=${first.body.length}`,
			alice.token
		)
		expect([...first.body, ...rest.body].map((account) => account.id)).toEqual(ids.toReversed())
	}, 300_000)

	it('walks the admin account list once each, cut by bytes, `more` linking the next page', async () => {
		const h = await community(['owner'])
		await setSetting(h.store, 'admin_email', 'owner@example.com')
		const scope = 'read write admin:read admin:write'
		const token = (await login(h, { app: await registerApp(h, { scopes: scope }), scope, email: 'owner@example.com' }))
			.token
		const ids = await maximalAccounts(h, 'admin', COUNT)
		const size = (await answer<unknown>(h, `/api/v1/admin/accounts/${ids[0]!}`, token)).bytes
		const path = '/api/v2/admin/accounts?origin=remote&limit=200'
		expectByteCutWalk('admin', await walk(h, path, 'next', token), ids.toReversed(), 'next', size)
		const up = await walk(h, `${path}&min_id=0`, 'prev', token)
		expectByteCutWalk('admin', up, ids, 'prev', size)
	}, 300_000)
})
