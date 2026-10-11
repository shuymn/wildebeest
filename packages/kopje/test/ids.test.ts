import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { BUILD, freshStore } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { insertWithFreshId, localId, type RandomInt, remoteId } from '../src/domain/ids'
import { StoreKernel } from '../src/platform/store-kernel'

const NOW = Date.parse('2026-10-12T12:34:56.789Z')
const fixed =
	(value: number): RandomInt =>
	(max) =>
		Math.min(value, max - 1)

function timeOf(id: string): number {
	return Number(BigInt(id) >> 16n)
}

describe('ID generator', () => {
	it('produces 18-digit decimal strings', () => {
		for (const id of [localId(NOW), remoteId('2018-05-10T00:00:00Z', NOW), localId(Date.parse('2400-01-01'))]) {
			expect(id).toMatch(/^\d{18}$/)
		}
	})

	it('uses the caller clock for local IDs and orders them by time as text', () => {
		const a = localId(NOW, fixed(0xffff))
		const b = localId(NOW + 1, fixed(0))
		expect(timeOf(a)).toBe(NOW)
		expect(a < b).toBe(true)
	})

	it('truncates published to the second and adds 0-999 random ms for remote IDs', () => {
		expect(timeOf(remoteId('2026-10-12T12:00:00.987Z', NOW, fixed(0)))).toBe(Date.parse('2026-10-12T12:00:00.000Z'))
		expect(timeOf(remoteId('2026-10-12T12:00:00.987Z', NOW, fixed(999)))).toBe(Date.parse('2026-10-12T12:00:00.999Z'))
	})

	it('clamps future, unparsable, and too-early published times', () => {
		const nowSecond = Math.floor(NOW / 1000) * 1000
		expect(timeOf(remoteId('2999-01-01T00:00:00Z', NOW, fixed(0)))).toBe(nowSecond)
		expect(timeOf(remoteId('not a date', NOW, fixed(0)))).toBe(nowSecond)
		expect(timeOf(remoteId('2001-01-01T00:00:00Z', NOW, fixed(0)))).toBe(Date.UTC(2018, 4, 10))
	})

	it('regenerates on an ID collision and lets other UNIQUE violations through', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await new StoreKernel(state, { build: BUILD, migrations: MIGRATIONS, log: () => {} }).upgrade()
			const sql = state.storage.sql
			const insert = (uri: string) => (id: string) => {
				sql.exec("INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'a', 'x.test')", id, uri)
				return id
			}
			const taken = localId(NOW, fixed(1))
			insert('https://x.test/1')(taken)

			const candidates = [taken, localId(NOW, fixed(2))]
			const id = state.storage.transactionSync(() =>
				insertWithFreshId('accounts', () => candidates.shift()!, insert('https://x.test/2'))
			)
			expect(id).toBe(localId(NOW, fixed(2)))

			expect(() => insertWithFreshId('accounts', () => localId(NOW, fixed(3)), insert('https://x.test/1'))).toThrow(
				'UNIQUE constraint failed: accounts.uri'
			)
		})
	})
})
