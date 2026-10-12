import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { seedAccount } from './api-helpers'
import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
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
				return {
					toArray: () => {
						const rows = cursor.toArray()
						read += cursor.rowsRead
						return rows
					},
					get rowsWritten() {
						return cursor.rowsWritten
					},
				}
			},
		} as unknown as SqlStorage
		const credential = signedIn ? { tokenHash: 't', scope: 'read:statuses' as const, now: NOW } : null
		const result = statusContext.run(counting, { credential, id: ROOT, present: { origin: 'https://kopje.test' } })
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
