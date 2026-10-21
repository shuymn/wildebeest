import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { seedAccount } from './api-helpers'
import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { plannedRun, scansOf, staleStatistics, watchedCursor } from './read-helpers'
import { statusContext } from '../src/domain/statuses'
import type { StoreStub } from '../src/platform/store-client'

// /context must do bounded work however wide or deep the reply tree is (RES-7), not only return a bounded list. The
// work is measured as the rows SQLite reads for the whole operation.

const ROOT = '100000000000000000'

// One statement writes a tree under ROOT: `wide` direct replies, or a chain `deep` replies long.
async function tree(store: StoreStub, shape: { wide?: number; deep?: number }): Promise<string> {
	const author = await seedAccount(store, { username: 'author' })
	await runInDurableObject(store, (_instance, state) => {
		const sql = state.storage.sql
		sql.exec(
			"INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES (?, 'https://kopje.test/ap/o/root', ?, 'public', '<p>root</p>', '2026-01-01T00:00:00.000Z')",
			ROOT,
			author
		)
		sql.exec(
			`WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, visibility, content, published_at)
			SELECT printf('2%017d', i), 'https://kopje.test/ap/o/' || i, ?1, 'https://kopje.test/ap/o/p',
				CASE WHEN ?3 THEN ?4 WHEN i = 1 THEN ?4 ELSE printf('2%017d', i - 1) END,
				'public', '<p>r</p>', '2026-01-01T00:00:00.000Z'
			FROM n`,
			author,
			shape.wide ?? shape.deep ?? 0,
			shape.wide === undefined ? 0 : 1,
			ROOT
		)
		sql.exec("INSERT INTO oauth_clients (id, secret, name, redirect_uris) VALUES ('c', 's', 'c', 'https://c.test/cb')")
		sql.exec(
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('t', 'access', 'c', ?, 'read')",
			author
		)
	})
	return author
}

// Runs /context for ROOT over a SqlStorage that counts the rows each statement reads.
async function rowsRead(store: StoreStub, signedIn: boolean): Promise<{ read: number; descendants: number }> {
	return runInDurableObject(store, (_instance, state) => {
		let read = 0
		const sql = state.storage.sql
		const counting = {
			exec: (query: string, ...params: SqlStorageValue[]) => {
				const cursor = sql.exec(query, ...params)
				return watchedCursor(cursor, () => (read += cursor.rowsRead))
			},
		} as unknown as SqlStorage
		const credential = signedIn ? { tokenHash: 't', scope: 'read:statuses' as const, now: NOW } : null
		const result = statusContext.run(counting, {
			credential,
			id: ROOT,
			now: NOW,
			present: { origin: 'https://kopje.test' },
		})
		if (result.status !== 'ok' || result.value.status !== 'ok') {
			throw new Error('context failed')
		}
		return { read, descendants: result.value.value.descendants.length }
	})
}

async function measure(shape: { wide?: number; deep?: number }, signedIn: boolean) {
	const store = await migratedStore()
	await tree(store, shape)
	return rowsRead(store, signedIn)
}

describe('context work is bounded', () => {
	for (const signedIn of [false, true]) {
		const who = signedIn ? 'signed in' : 'anonymous'

		// Both trees are well past the returned limit (60 anonymous, 4,096 signed in), so they return the same list.
		it(`${who}: a tree several times wider costs about the same`, async () => {
			const width = signedIn ? 10_000 : 1_000
			const narrow = await measure({ wide: width }, signedIn)
			const wide = await measure({ wide: width * 4 }, signedIn)
			expect(wide.descendants).toBe(narrow.descendants)
			expect(wide.read).toBeLessThan(narrow.read * 1.5)
		})

		// Both chains are past the depth and traversal bounds (20 anonymous; 4,096 deep signed in).
		it(`${who}: a chain twice as deep costs about the same`, async () => {
			const length = signedIn ? 9_000 : 1_000
			const deep = await measure({ deep: length }, signedIn)
			const deeper = await measure({ deep: length * 2 }, signedIn)
			expect(deeper.descendants).toBe(deep.descendants)
			expect(deeper.read).toBeLessThan(deep.read * 1.5)
		})
	}
})

describe('context reads with stale statistics (RES-7)', () => {
	it('seeks each ancestor and descendant by id, the statuses grown after ANALYZE', async () => {
		const store = await migratedStore()
		const author = await tree(store, { deep: 4 })
		const h = { store }
		const run = () =>
			plannedRun(h, /WITH RECURSIVE up|FROM json_each\(\?[12]\) [jf] (CROSS )?JOIN/, statusContext, {
				credential: { tokenHash: 't', scope: 'read:statuses', now: NOW },
				id: '200000000000000002',
				now: NOW,
				present: { origin: 'https://kopje.test' },
			})
		const { before, after } = await staleStatistics(h, {
			capture: () => run(),
			grow: () =>
				runInDurableObject(store, (_instance, state) => {
					// Other threads: roots and replies to them, each below and above the thread's ids.
					state.storage.sql.exec(
						`WITH RECURSIVE n (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 20000 - 1)
						INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, visibility, content, published_at)
						SELECT printf('%d', CASE WHEN i % 2 = 0 THEN 150000000000000000 ELSE 300000000000000000 END + i),
							'https://kopje.test/ap/o/x' || i, ?1, CASE WHEN i % 4 >= 2 THEN 'https://kopje.test/ap/o/p' END,
							CASE WHEN i % 4 >= 2 THEN printf('%d', CASE WHEN i % 2 = 0 THEN 150000000000000000 ELSE 300000000000000000 END + i - 2) END,
							'public', '<p>x</p>', '2026-01-01T00:00:00.000Z'
						FROM n`,
						author
					)
				}),
		})
		expect(after.result).toEqual(before.result)
		const context = (
			after.result as { value: { value: { ancestors: { id: string }[]; descendants: { id: string }[] } } }
		).value.value
		expect([context.ancestors.map((s) => s.id), context.descendants.map((s) => s.id)]).toEqual([
			[ROOT, '200000000000000001'],
			['200000000000000003', '200000000000000004'],
		])
		// The ancestors, the descendants' levels (the frontier's children through statuses_in_reply_to), then their
		// admission.
		expect(after.plans.map((p) => p.query.trim().slice(0, 14))).toEqual([
			'WITH RECURSIVE',
			'SELECT s.id, s',
			'SELECT s.id, s',
			'SELECT s.id, s',
			'SELECT s.id AS',
		])
		for (const [i, { query, plan, rows }] of after.plans.entries()) {
			const name = query.trim().slice(0, 40)
			expect(scansOf(plan, ['s', 'statuses']), name).toEqual([])
			if (i === 0 || i === 4) {
				// The anchor, the recursive step and the admission: each by id.
				expect(
					plan.filter((d) => d === 'SEARCH s USING INDEX sqlite_autoindex_statuses_1 (id=?)'),
					name
				).toHaveLength(i === 0 ? 2 : 1)
				expect(rows, name).toBe(before.plans[i]!.rows)
			} else {
				expect(plan, name).toContain('SEARCH s USING INDEX statuses_in_reply_to (in_reply_to_id=?)')
				// One more index entry at most, past the frontier's children.
				expect(rows - before.plans[i]!.rows, name).toBeLessThanOrEqual(1)
			}
		}
	}, 60_000)
})
