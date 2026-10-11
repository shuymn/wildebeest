import { runInDurableObject } from 'cloudflare:test'

import { testKvStore } from '@fedify/testing'
import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'

import { BUILD, migratedStore, rejectionOf } from './helpers'
import { DoKvStore } from '../src/federation/kv-store'
import { toStoreUnavailable } from '../src/platform/store-errors'

async function collect<T>(entries: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const entry of entries) {
		out.push(entry)
	}
	return out
}

describe('DoKvStore', () => {
	it("passes Fedify's KvStore test suite, including cas and TTL", async () => {
		const store = await migratedStore()
		await testKvStore(
			() =>
				new DoKvStore(
					() => store,
					BUILD,
					() => Date.now()
				),
			() => {}
		)
	})

	it('honors expires_at with the injected clock', async () => {
		const store = await migratedStore()
		let now = 1_000_000
		const kv = new DoKvStore(
			() => store,
			BUILD,
			() => now
		)

		await kv.set(['a', 'ttl'], { v: 1 }, { ttl: Temporal.Duration.from({ seconds: 10 }) })
		await kv.set(['a', 'forever'], 'kept')
		await runInDurableObject(store, (_instance, state) => {
			const rows = state.storage.sql.exec('SELECT key, expires_at FROM fedify_kv ORDER BY key').toArray()
			expect(rows).toEqual([
				{ key: '["a","forever"]', expires_at: null },
				{ key: '["a","ttl"]', expires_at: 1_010_000 },
			])
		})

		now = 1_009_999
		expect(await kv.get(['a', 'ttl'])).toEqual({ v: 1 })
		now = 1_010_000
		expect(await kv.get(['a', 'ttl'])).toBeUndefined()
		expect(await collect(kv.list(['a']))).toEqual([{ key: ['a', 'forever'], value: 'kept' }])
		expect(await kv.cas(['a', 'ttl'], undefined, 'replaced')).toBe(true)
		expect(await kv.get(['a', 'ttl'])).toBe('replaced')
	})

	it('matches a prefix by key range, not by string prefix or LIKE', async () => {
		const store = await migratedStore()
		const kv = new DoKvStore(
			() => store,
			BUILD,
			() => 0
		)
		const url = `https://remote.example/${'x'.repeat(200)}%_`
		await kv.set(['_fedify', 'remoteDocument', url], 1)
		await kv.set(['_fedify', 'remoteDocumentX', url], 2)
		await kv.set(['_fedify'], 3)
		await kv.set(['_fedifyX', 'a'], 4)

		expect(await collect(kv.list(['_fedify', 'remoteDocument']))).toEqual([
			{ key: ['_fedify', 'remoteDocument', url], value: 1 },
		])
		expect((await collect(kv.list(['_fedify']))).map((e) => e.value)).toEqual([1, 2, 3])
	})

	it('is refused like any write while the Store is readonly', async () => {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const hold = { reason: 'upgrade-failed', build: BUILD, detail: 'test', at: 0 }
			state.storage.sql.exec("INSERT INTO kopje_state (name, value) VALUES ('hold', ?)", JSON.stringify(hold))
		})
		const stale = new DoKvStore(
			() => store,
			BUILD,
			() => 0
		)
		// The hold is read when the kernel first loads its state, which this Store has not done yet.
		expect(await stale.get(['k'])).toBeUndefined()
		expect(toStoreUnavailable(await rejectionOf(stale.set(['k'], 1)))?.reason).toBe('upgrade-failed')
	})
})
