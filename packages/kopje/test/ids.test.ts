import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { BUILD, freshStore, migratedStore, testKernel } from './helpers'
import { allocateLocalId, insertWithFreshId, type RandomInt, remoteId } from '../src/domain/ids'
import { writeOperation } from '../src/domain/operation'

const NOW = Date.parse('2026-10-12T12:34:56.789Z')
const fixed =
	(value: number): RandomInt =>
	(max) =>
		Math.min(value, max - 1)

function timeOf(id: string): number {
	return Number(BigInt(id) >> 16n)
}

describe('ID generator', () => {
	it('produces 18-digit decimal remote IDs', () => {
		for (const id of [
			remoteId('2018-05-10T00:00:00Z', NOW),
			remoteId('2400-01-01T00:00:00Z', Date.parse('2400-01-01')),
		]) {
			expect(id).toMatch(/^\d{18}$/)
		}
	})

	it('allocates local IDs in the Store that increase within one millisecond and across a backwards clock', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const k = testKernel(state)
			await k.upgrade()
			const allocate = writeOperation<{ now: number; random: RandomInt }, string>((db, { now, random }) =>
				allocateLocalId(db, now, random)
			)
			const ids = [
				await k.execute(BUILD, allocate, { now: NOW, random: fixed(0xffff) }),
				// Same millisecond, lower random bits.
				await k.execute(BUILD, allocate, { now: NOW, random: fixed(0) }),
				// The clock went back five seconds.
				await k.execute(BUILD, allocate, { now: NOW - 5000, random: fixed(0x8000) }),
			]
			for (const id of ids) {
				expect(id).toMatch(/^\d{18}$/)
			}
			expect(timeOf(ids[0]!)).toBe(NOW)
			expect([...ids].sort()).toEqual(ids)
			expect(new Set(ids).size).toBe(3)

			// The allocation shares the transaction of the write: a failed write does not advance it.
			const failing = writeOperation<void, void>((db) => {
				allocateLocalId(db, NOW + 1000, fixed(0))
				throw new Error('write failed')
			})
			await expect(k.execute(BUILD, failing, undefined)).rejects.toThrow('write failed')
			expect(await k.execute(BUILD, allocate, { now: NOW - 5000, random: fixed(0) })).toBe(
				(BigInt(ids[2]!) + 1n).toString()
			)
		})
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
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			const sql = state.storage.sql
			const insert = (uri: string) => (id: string) => {
				sql.exec("INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'a', 'x.test')", id, uri)
				return id
			}
			const taken = remoteId('2026-10-12T00:00:00Z', NOW, fixed(1))
			insert('https://x.test/1')(taken)

			const candidates = [taken, remoteId('2026-10-12T00:00:00Z', NOW, fixed(2))]
			const id = state.storage.transactionSync(() =>
				insertWithFreshId('accounts', () => candidates.shift()!, insert('https://x.test/2'))
			)
			expect(id).toBe(remoteId('2026-10-12T00:00:00Z', NOW, fixed(2)))

			expect(() =>
				insertWithFreshId('accounts', () => remoteId('2026-10-12T00:00:00Z', NOW, fixed(3)), insert('https://x.test/1'))
			).toThrow('UNIQUE constraint failed: accounts.uri')
		})
	})
})
