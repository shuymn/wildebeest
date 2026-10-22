import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { BUILD, freshStore, testKernel as kernel } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { readOperation, writeOperation } from '../src/domain/operation'
import type { Migration, StoreKernel } from '../src/platform/store-kernel'

// StoreKernel.executeProbing (the inbox gate's write admission, federation/inbox.ts): the read is admitted as execute
// admits it, and the probe reports exactly what a write would meet in the same state, from the same table.

const countSettings = readOperation<void, number>(
	(db) => db.first<{ n: number }>('SELECT count(*) AS n FROM instance_settings')?.n ?? 0
)
let written = 0
const putSetting = writeOperation<void, void>((db) => {
	db.run('INSERT INTO instance_settings (name, value) VALUES (?, ?)', `probe-${++written}`, 'x')
})

const NOW = 1_000_000
const LEASE_UNTIL = NOW + 60_000

// The reason a write is refused with now, or null when it is admitted.
async function writeRefusal(k: StoreKernel): Promise<string | null> {
	try {
		await k.execute(BUILD, putSetting, undefined)
		return null
	} catch (error) {
		const message = (error as Error).message
		return message.slice(message.indexOf(': ') + 2)
	}
}

type Seed = (sql: SqlStorage) => void

const state =
	(name: string, value: unknown): Seed =>
	(sql) =>
		sql.exec('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', name, JSON.stringify(value))

const HOLD = state('hold', { reason: 'upgrade-failed', build: BUILD, detail: 'test', at: 0 })
const UPGRADING = state('upgrade', { build: BUILD, bookmark: 'b', at: 0 })
const MAINTENANCE = state('maintenance', { mode: 'readonly', at: 0 })
const UNPUBLISHED = state('unpublished', { at: 0, import: 'i' })
const DUMP = state('dump', { id: 'd', startedAt: 0, leaseMs: 60_000, leaseUntil: LEASE_UNTIL })

// A migrated Store with the seeds applied, and a kernel over it whose clock is `now`.
async function probed(seeds: Seed[], now = NOW, migrations: readonly Migration[] = MIGRATIONS) {
	const store = freshStore()
	return runInDurableObject(store, async (_instance, durable) => {
		await kernel(durable, MIGRATIONS).upgrade()
		await durable.storage.deleteAlarm()
		for (const seed of seeds) {
			seed(durable.storage.sql)
		}
		const k = kernel(durable, migrations, { now: () => now })
		const probe = await k.executeProbing(BUILD, countSettings, undefined, 'write')
		return { probe, write: await writeRefusal(k) }
	})
}

describe('executeProbing reports the write admission of the same state', () => {
	it.each<[string, Seed[], number, string | null]>([
		['nothing held', [], NOW, null],
		['an upgrade hold', [HOLD], NOW, 'upgrade-failed'],
		['an upgrade of the current schema', [UPGRADING], NOW, 'upgrade-in-progress'],
		['the maintenance flag', [MAINTENANCE], NOW, 'maintenance'],
		['an unpublished import', [UNPUBLISHED], NOW, 'unpublished'],
		['a dump within its lease', [DUMP], NOW, 'dump-in-progress'],
		['a dump past its lease, by the Store clock', [DUMP], LEASE_UNTIL, null],
		['maintenance and an unpublished import', [MAINTENANCE, UNPUBLISHED], NOW, 'maintenance'],
		['a hold and the maintenance flag', [HOLD, MAINTENANCE], NOW, 'upgrade-failed'],
		['a dump and the maintenance flag', [DUMP, MAINTENANCE], NOW, 'dump-in-progress'],
	])('with %s', async (_name, seeds, now, refused) => {
		const { probe, write } = await probed(seeds, now)
		// The read still answers, whatever a write would meet.
		expect(probe.output).toEqual(expect.any(Number))
		expect(probe.refused).toBe(refused)
		expect(write).toBe(refused)
	})

	it.each<[string, Seed[], readonly Migration[], string]>([
		['an import in progress', [state('import', { id: 'i' })], MIGRATIONS, 'import-in-progress'],
		['a pending schema', [], [...MIGRATIONS, { name: '9999_extra', sql: 'CREATE TABLE extra (a);' }], 'schema-pending'],
		[
			'a diverged schema',
			[],
			[{ name: '0000_initial', sql: `${MIGRATIONS[0]?.sql}\n-- edited` }, ...MIGRATIONS.slice(1)],
			'schema-diverged',
		],
	])('throws as execute does with %s', async (_name, seeds, migrations, reason) => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, durable) => {
			await kernel(durable, MIGRATIONS).upgrade()
			await durable.storage.deleteAlarm()
			for (const seed of seeds) {
				seed(durable.storage.sql)
			}
			const k = kernel(durable, migrations, { now: () => NOW })
			await expect(k.executeProbing(BUILD, countSettings, undefined, 'write')).rejects.toThrow(reason)
			await expect(k.execute(BUILD, countSettings, undefined)).rejects.toThrow(reason)
		})
	})

	it('throws for another build, as execute does', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, durable) => {
			await kernel(durable, MIGRATIONS).upgrade()
			await durable.storage.deleteAlarm()
			const k = kernel(durable, MIGRATIONS)
			await expect(k.executeProbing('0.0.0-other', countSettings, undefined, 'write')).rejects.toThrow(
				'version-mismatch'
			)
		})
	})
})
