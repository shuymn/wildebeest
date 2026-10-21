import { describe, expect, it } from 'vitest'

import { seedAccount, sql } from './api-helpers'
import { migratedStore } from './helpers'
import { accessAdminStore, copyConfig, dumpViaRpc, importViaRpc } from './ops-helpers'
import type { StoreStub } from '../src/platform/store-client'

// Account warnings in dumps (docs/dump-format.md "Stored bounds"): a warning and its moderation_warning notification
// round-trip with the id counter, and an import is held to the CHECKs and triggers of 0062_account_warnings (refused
// with their names).

const STAMP = '2026-10-12T01:02:03.004Z'
const NOTIFIED = '2026-10-12T05:06:07.008Z'
const STATUS = '300000000000000001'

async function source() {
	const store = await accessAdminStore()
	const alice = await seedAccount(store, { username: 'alice', email: 'alice@example.com' })
	for (const [text, statusIds] of [
		['warned text', JSON.stringify([STATUS])],
		['', null],
	] as const) {
		const [{ id }] = (await sql<{ id: number }>(
			store,
			`INSERT INTO account_warnings (target_account_id, action, text, status_ids, created_at)
			VALUES (?, 'none', ?, ?, ?) RETURNING id`,
			alice,
			text,
			statusIds,
			STAMP
		)) as [{ id: number }]
		await sql(
			store,
			`INSERT INTO notifications (account_id, type, from_account_id, account_warning_id, created_at)
			VALUES (?1, 'moderation_warning', ?1, ?2, ?3)`,
			alice,
			id,
			NOTIFIED
		)
	}
	// A third warning deleted: the counter is past every row.
	await sql(
		store,
		"INSERT INTO account_warnings (target_account_id, action, created_at) VALUES (?, 'none', ?)",
		alice,
		STAMP
	)
	await sql(store, 'DELETE FROM account_warnings WHERE id = 3')
	return store
}

const rows = (store: StoreStub) =>
	Promise.all([
		sql(store, 'SELECT * FROM account_warnings ORDER BY id'),
		sql(store, 'SELECT id, account_id, type, account_warning_id FROM notifications ORDER BY id'),
		sql(store, "SELECT seq FROM sqlite_sequence WHERE name = 'account_warnings'"),
	])

describe('account warnings in dumps', () => {
	it('round-trip with their notifications and the id counter', async () => {
		const store = await source()
		const { text } = await dumpViaRpc(store)
		const target = await migratedStore()
		await copyConfig(store, target)
		expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] })
		const [warnings, notifications, sequence] = await rows(target)
		expect([warnings, notifications, sequence]).toEqual(await rows(store))
		expect(warnings).toHaveLength(2)
		expect(notifications.filter((n) => n.type === 'moderation_warning')).toHaveLength(2)
		expect(sequence).toEqual([{ seq: 3 }])
	}, 60_000)

	it('are refused on import past their bounds, with the constraint’s name', async () => {
		const store = await source()
		const { text } = await dumpViaRpc(store)
		const ids = `'${JSON.stringify([STATUS])}'`
		const refusedIds = /account_warnings: status_ids past its stored bound/
		const cases: [string, string, RegExp][] = [
			["'warned text'", "CAST(X'610062' AS TEXT)", /account_warning_text_within_10000_bytes/],
			["'warned text'", "X'61'", /account_warning_text_within_10000_bytes/],
			[`'${STAMP}'`, "'2026-10-12T24:00:00.000Z'", /account_warning_created_at_iso/],
			[ids, "X'5B5D'", refusedIds],
			[ids, "CAST(X'5B5D00' AS TEXT)", refusedIds],
			[ids, "'[] x'", refusedIds],
			[ids, "'[1]'", refusedIds],
			[ids, `'["30000000000000000\\u0000"]'`, refusedIds],
			[ids, `'["${STATUS}", 2]'`, refusedIds],
			[ids, `'${JSON.stringify(Array.from({ length: 101 }, () => STATUS))}'`, refusedIds],
		]
		for (const [from, to, refused] of cases) {
			const changed = text.replace(from, to)
			expect(changed, from).not.toBe(text)
			const target = await migratedStore()
			await copyConfig(store, target)
			await expect(importViaRpc(target, changed), `${from} -> ${to}`).rejects.toThrow(refused)
		}
	}, 180_000)
})
