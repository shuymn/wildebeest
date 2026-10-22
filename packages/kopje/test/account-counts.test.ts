import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { ALICE, DAVE, setup } from './inbox-status-helpers'
import { observedSql } from './read-helpers'
import { getAccount } from '../src/domain/accounts'
import { MAX_ACCOUNT_COUNT, presentedCountSql, storedCount } from '../src/platform/stored-bounds'

// RES-2: accounts.followers_count, following_count and statuses_count have no stored bound (no CHECK or trigger), so
// an imported or converted row may hold any value there. Every read that presents, ranks or sums one takes
// presentedCountSql: a value past storedCount's range presents as 0 and never leaves SQLite.

const ORIGIN = 'https://kopje.test'
const TEXT_BYTES = 1_000_000

// Imported values, each with what it presents as: TEXT (one of 1,000,000 bytes), a BLOB, malformed UTF-8, a REAL, a
// negative, one past MAX_ACCOUNT_COUNT; and, within the range, an integer and the text of one (which INTEGER affinity
// stores as that integer).
const IMPORTED: [string, string, number][] = [
	['text', "'x'", 0],
	['1,000,000-byte text', `replace(hex(zeroblob(${TEXT_BYTES / 2})), '0', 'x')`, 0],
	['blob', 'zeroblob(64)', 0],
	['malformed bytes', "CAST(X'FFFE80' AS TEXT)", 0],
	['real', '1.5', 0],
	['negative', '-1', 0],
	['past MAX_ACCOUNT_COUNT', String(MAX_ACCOUNT_COUNT + 1), 0],
	['the largest', String(MAX_ACCOUNT_COUNT), MAX_ACCOUNT_COUNT],
	['an integer', '5', 5],
	['an integer as text', "'12'", 12],
]

describe('account counts as they are read', () => {
	// A number as a writer binds it (workerd binds a JavaScript number as a REAL; INTEGER affinity stores an integral one
	// as an integer).
	it('keeps storedCount and presentedCountSql to one range', async () => {
		const t = await setup()
		for (const value of [0, 5, MAX_ACCOUNT_COUNT, MAX_ACCOUNT_COUNT + 1, 2 ** 63, -1, 1.5]) {
			await sql(t.store, 'UPDATE accounts SET followers_count = ? WHERE id = ?', value, ALICE)
			const [row] = await sql<{ p: number }>(
				t.store,
				`SELECT ${presentedCountSql('followers_count')} AS p FROM accounts WHERE id = ?`,
				ALICE
			)
			expect([value, row?.p]).toEqual([value, storedCount(value) ?? 0])
		}
	})

	it.each(IMPORTED)(
		'presents an imported remote account’s %s as its count, and reads no value past it',
		async (name, value, presented) => {
			const t = await setup()
			const id = '933000000000000100'
			await sql(
				t.store,
				`INSERT INTO accounts (id, uri, username, domain, followers_count, following_count, statuses_count)
				VALUES (?1, 'https://remote.example/users/bob', 'bob', 'remote.example', ${value}, ${value}, ${value})`,
				id
			)
			// The one that moved to it shows it nested (Account#moved).
			await sql(
				t.store,
				`INSERT INTO accounts (id, uri, username, domain, moved_to_account_id)
				VALUES ('933000000000000101', 'https://remote.example/users/carol', 'carol', 'remote.example', ?)`,
				id
			)
			const [stored] = await sql<{ type: string; bytes: number }>(
				t.store,
				`SELECT typeof(followers_count) AS type, length(CAST(followers_count AS BLOB)) AS bytes
				FROM accounts WHERE id = ?`,
				id
			)
			if (name === '1,000,000-byte text') {
				expect(stored).toEqual({ type: 'text', bytes: TEXT_BYTES })
			}
			const counts = { followers_count: presented, following_count: presented, statuses_count: presented }
			expect((await t.api(`/api/v1/accounts/${id}`, null)).body).toMatchObject(counts)
			expect((await t.api('/api/v1/accounts/933000000000000101', null)).body).toMatchObject({ moved: counts })
			// The rows getAccount materializes hold no value of the stored one's size.
			const longest = await runInDurableObject(t.store, (_instance, state) => {
				let bytes = 0
				const counting = observedSql(state.storage.sql, (read) => {
					for (const row of read) {
						for (const column of Object.values(row)) {
							const size =
								typeof column === 'string'
									? new TextEncoder().encode(column).length
									: column instanceof ArrayBuffer
										? column.byteLength
										: 8
							bytes = Math.max(bytes, size)
						}
					}
				})
				getAccount.run(counting, { id: '933000000000000101', present: { origin: ORIGIN } })
				return bytes
			})
			expect(longest).toBeLessThan(1000)
		}
	)

	it('presents, serves and sums a local account’s imported counts within the range', async () => {
		const t = await setup()
		await sql(
			t.store,
			`UPDATE accounts SET statuses_count = 2.5, following_count = -4,
				followers_count = replace(hex(zeroblob(${TEXT_BYTES / 2})), '0', 'x')
			WHERE id = ?`,
			ALICE
		)
		await sql(t.store, 'UPDATE accounts SET statuses_count = 3 WHERE id = ?', DAVE)
		expect((await t.api(`/api/v1/accounts/${ALICE}`, null)).body).toMatchObject({
			statuses_count: 0,
			following_count: 0,
			followers_count: 0,
		})
		const outbox = await t.request('/ap/users/alice/outbox', { headers: { accept: 'application/activity+json' } })
		expect(((await outbox.json()) as { totalItems: number }).totalItems).toBe(0)
		const instance = (await t.api<{ stats: { status_count: number } }>('/api/v1/instance', null)).body
		expect(instance.stats.status_count).toBe(3)
	})
})
