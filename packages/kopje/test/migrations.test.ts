import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { freshStore, rejectionOf, tableNames } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { readOperation, writeOperation } from '../src/domain/operation'
import { StoreUnavailableError, toStoreUnavailable } from '../src/platform/store-errors'
import { type Migration, StoreKernel } from '../src/platform/store-kernel'
import { BUILD_VERSION } from '../src/version'

const SCHEMA_TABLES = [
	'accounts',
	'blocks',
	'bookmarks',
	'deliveries',
	'domain_blocks',
	'favourites',
	'fedify_kv',
	'follows',
	'inbound_retractions',
	'inbound_spool',
	'instance_settings',
	'list_accounts',
	'lists',
	'local_accounts',
	'media_attachments',
	'mutes',
	'notifications',
	'oauth_clients',
	'oauth_tokens',
	'outbound_activities',
	'push_subscriptions',
	'status_edits',
	'status_mentions',
	'status_tags',
	'statuses',
]

const countSettings = readOperation<void, number>(
	(db) => db.first<{ n: number }>('SELECT count(*) AS n FROM instance_settings')?.n ?? 0
)
const putSetting = writeOperation<string, void>((db, name) => {
	db.run('INSERT INTO instance_settings (name, value) VALUES (?, ?)', name, 'x')
})

function bookkeeping(sql: SqlStorage) {
	return sql
		.exec<{ name: string; applied_at: number }>('SELECT name, applied_at FROM kopje_migrations ORDER BY name')
		.toArray()
}

function kernel(
	state: DurableObjectState,
	migrations: readonly Migration[],
	extra: Partial<{ build: string; transaction: <T>(fn: () => T) => T }> = {}
) {
	return new StoreKernel(state, { build: BUILD_VERSION, migrations, log: () => {}, ...extra })
}

describe('Store migration runner', () => {
	it('applies the schema on a fresh Store through the alarm, never on construction', async () => {
		const store = freshStore()

		const before = await store.health(BUILD_VERSION)
		expect(before.schema).toMatchObject({ status: 'pending', pending: ['0000_initial'], applied: [] })
		expect(before.readonly).toBe(true)

		// Detecting the pending file scheduled an immediate alarm; nothing else upgrades the schema.
		await vi.waitFor(async () => expect((await store.health(BUILD_VERSION)).schema.status).toBe('current'))
		expect(await runDurableObjectAlarm(store)).toBe(false)

		const after = await store.health(BUILD_VERSION)
		expect(after.schema).toMatchObject({ status: 'current', applied: ['0000_initial'] })
		expect(after.readonly).toBe(false)
		expect(after.lastBookmark).toEqual(expect.any(String))
		expect(after.databaseSize).toBeGreaterThan(0)
		expect(await store.setupState(BUILD_VERSION)).toEqual({ complete: false })
		await runInDurableObject(store, (_instance, state) => {
			expect(tableNames(state.storage.sql)).toEqual(expect.arrayContaining([...SCHEMA_TABLES, 'kopje_migrations']))
		})
	})

	it('treats a re-run as a no-op', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			expect(await kernel(state, MIGRATIONS).upgrade()).toMatchObject({ ok: true, applied: ['0000_initial'] })
			const recorded = bookkeeping(state.storage.sql)

			expect(await kernel(state, MIGRATIONS).upgrade()).toEqual({ ok: true, bookmark: null, applied: [] })
			expect(bookkeeping(state.storage.sql)).toEqual(recorded)
		})
	})

	it('stays readonly with exact bookkeeping when a file fails, and lets a fixed build continue', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const broken = [
				...MIGRATIONS,
				{ name: '0001_broken', sql: 'CREATE TABLE half_done (a); INSERT INTO missing VALUES (1);' },
			]
			const k = kernel(state, broken)

			const result = await k.upgrade()
			expect(result).toMatchObject({ ok: false, reason: 'upgrade-failed', bookmark: expect.any(String) })
			expect(bookkeeping(state.storage.sql).map((m) => m.name)).toEqual(['0000_initial'])
			expect(tableNames(state.storage.sql)).not.toContain('half_done')
			expect(await k.health(BUILD_VERSION)).toMatchObject({ readonly: true, hold: 'upgrade-failed' })
			await expect(k.execute(BUILD_VERSION, countSettings, undefined)).rejects.toThrow('schema-pending')

			// The same build does not retry on its own; rescue RPCs keep working.
			expect(await k.upgrade()).toMatchObject({ ok: false, detail: 'held' })
			expect(await kernel(state, broken).version()).toEqual({
				build: BUILD_VERSION,
				expected: '0001_broken',
				applied: '0000_initial',
			})

			// A fix-forward deploy (new build, corrected file) clears the hold and upgrades.
			const fixed = [...MIGRATIONS, { name: '0001_fixed', sql: 'CREATE TABLE fixed (a);' }]
			expect(await kernel(state, fixed, { build: 'next' }).upgrade()).toMatchObject({
				ok: true,
				applied: ['0001_fixed'],
			})
		})
	})

	it('re-reads bookkeeping after an error thrown once the writes were already durable', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			let calls = 0
			const timesOutAfterCommit = <T>(fn: () => T): T => {
				const value = state.storage.transactionSync(fn)
				if (++calls === 2) {
					throw new Error('Durable Object storage operation exceeded timeout')
				}
				return value
			}
			const k = kernel(state, [...MIGRATIONS, { name: '0001_extra', sql: 'CREATE TABLE extra (a);' }], {
				transaction: timesOutAfterCommit,
			})

			const result = await k.upgrade()
			expect(result).toMatchObject({ ok: false, reason: 'upgrade-failed' })
			expect(result.ok === false && result.detail).toContain('0001_extra (recorded: true)')
			expect(bookkeeping(state.storage.sql).map((m) => m.name)).toEqual(['0000_initial', '0001_extra'])
			expect(tableNames(state.storage.sql)).toContain('extra')

			// The schema is complete but the Store stays readonly: reads pass, writes are refused.
			expect(await k.health(BUILD_VERSION)).toMatchObject({ schema: { status: 'current' }, readonly: true })
			expect(await k.execute(BUILD_VERSION, countSettings, undefined)).toBe(0)
			await expect(k.execute(BUILD_VERSION, putSetting, 'domain')).rejects.toThrow('kopje-maintenance: upgrade-failed')
		})
	})

	it('refuses calls from another build without leaving normal mode', async () => {
		const store = freshStore()
		await runInDurableObject(store, (_instance, state) => kernel(state, MIGRATIONS).upgrade())

		const error = toStoreUnavailable(await rejectionOf(store.setupState('0.0.0-other')))
		expect(error).toBeInstanceOf(StoreUnavailableError)
		expect(error?.reason).toBe('version-mismatch')
		expect(await store.health('0.0.0-other')).toMatchObject({ versionMatch: false, readonly: false })
		expect(await store.setupState(BUILD_VERSION)).toEqual({ complete: false })
	})

	it('goes readonly without an upgrade alarm when an applied file was changed', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await kernel(state, MIGRATIONS).upgrade()
			await state.storage.deleteAlarm()
			const edited = [{ name: '0000_initial', sql: `${MIGRATIONS[0]?.sql}\n-- edited` }]
			const k = kernel(state, edited)

			expect(await k.health(BUILD_VERSION)).toMatchObject({ schema: { status: 'diverged' }, readonly: true })
			expect(await state.storage.getAlarm()).toBeNull()
			await expect(k.execute(BUILD_VERSION, countSettings, undefined)).rejects.toThrow('schema-diverged')
		})
	})
})
