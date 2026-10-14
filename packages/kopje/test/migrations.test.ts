import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { BUILD, freshStore, rejectionOf, tableNames, testKernel as kernel } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { readOperation, sessionOperation, writeOperation } from '../src/domain/operation'
import { StoreUnavailableError, toStoreUnavailable } from '../src/platform/store-errors'

// The shipped migrations, in order; test-only files are named after them (9999_*).
const NAMES = MIGRATIONS.map((m) => m.name)
const LATEST = NAMES.at(-1)

const SCHEMA_TABLES = [
	'accounts',
	'blocks',
	'bookmarks',
	'deliveries',
	'domain_block_cleanups',
	'domain_blocks',
	'favourites',
	'fedify_kv',
	'follows',
	'inbound_jobs',
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
	'outbound_receipts',
	'outbound_targets',
	'push_deliveries',
	'push_subscriptions',
	'remote_keys',
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

const putSession = sessionOperation<string, void>((db, name) => {
	db.run('INSERT INTO instance_settings (name, value) VALUES (?, ?)', name, 'x')
})

function bookkeeping(sql: SqlStorage) {
	return sql
		.exec<{ name: string; applied_at: number }>('SELECT name, applied_at FROM kopje_migrations ORDER BY name')
		.toArray()
}

describe('Store migration runner', () => {
	it('applies the schema on a fresh Store through the alarm, never on construction', async () => {
		const store = freshStore()

		const before = await store.health(BUILD)
		expect(before.schema).toMatchObject({ status: 'pending', pending: NAMES, applied: [] })
		expect(before.readonly).toBe(true)

		// Detecting the pending file scheduled an immediate alarm; nothing else upgrades the schema.
		await vi.waitFor(async () => expect((await store.health(BUILD)).schema.status).toBe('current'))
		expect(await runDurableObjectAlarm(store)).toBe(false)

		const after = await store.health(BUILD)
		expect(after.schema).toMatchObject({ status: 'current', applied: NAMES })
		expect(after.readonly).toBe(false)
		expect(after.lastBookmark).toEqual(expect.any(String))
		expect(after.databaseSize).toBeGreaterThan(0)
		expect(await store.setupState(BUILD)).toEqual({ complete: false })
		await runInDurableObject(store, (_instance, state) => {
			expect(tableNames(state.storage.sql)).toEqual(expect.arrayContaining([...SCHEMA_TABLES, 'kopje_migrations']))
		})
	})

	it('0001 adds mute expiry and domain block cleanups to a Store with data, keeping every mute indefinite', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			expect(await kernel(state, MIGRATIONS.slice(0, 1)).upgrade()).toMatchObject({ ok: true, applied: [NAMES[0]] })
			const sql = state.storage.sql
			const [local, remote] = ['100000000000000001', '100000000000000002']
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					(?, 'https://kopje.test/ap/users/alice', 'alice', NULL), (?, 'https://remote.test/users/bob', 'bob', 'remote.test')`,
				local,
				remote
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				local
			)
			sql.exec(
				"INSERT INTO mutes (account_id, target_account_id, hide_notifications, created_at) VALUES (?, ?, 0, '2026-01-01T00:00:00.000Z')",
				local,
				remote
			)

			expect(await kernel(state, MIGRATIONS.slice(0, 2)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0001_blocks_and_mutes'],
			})
			expect(
				sql.exec('SELECT account_id, target_account_id, hide_notifications, expires_at FROM mutes').toArray()
			).toEqual([{ account_id: local, target_account_id: remote, hide_notifications: 0, expires_at: null }])
			expect(
				sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'mutes_expires'").toArray()
			).toEqual([{ sql: expect.stringContaining('WHERE expires_at IS NOT NULL') }])
			expect(tableNames(sql)).toContain('domain_block_cleanups')
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('treats a re-run as a no-op', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			expect(await kernel(state, MIGRATIONS).upgrade()).toMatchObject({ ok: true, applied: NAMES })
			const recorded = bookkeeping(state.storage.sql)

			expect(await kernel(state, MIGRATIONS).upgrade()).toEqual({ ok: true, bookmark: null, applied: [] })
			expect(bookkeeping(state.storage.sql)).toEqual(recorded)
		})
	})

	it('upgrades a Store at 0001_blocks_and_mutes with 0002_web_push, keeping its subscriptions', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, 2)).upgrade()).toMatchObject({
				applied: ['0000_initial', '0001_blocks_and_mutes'],
			})
			sql.exec(`
				INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('c', 's', 'n', 'urn:x', 'push');
				INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes) VALUES ('h', 'access', 'c', 'push');
				INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth) VALUES ('h', 'https://p.example/', 'k', 'a');
			`)
			expect(await kernel(state, MIGRATIONS.slice(0, 3)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0002_web_push'],
			})
			expect(sql.exec('SELECT standard, token_sealed FROM push_subscriptions').toArray()).toEqual([
				{ standard: 0, token_sealed: '' },
			])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('upgrades a Store at 0002_web_push with 0003_domain_block_form: trailing dots go, and a duplicate merges', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, 3)).upgrade()).toMatchObject({ ok: true })
			const [alice, bob] = ['100000000000000001', '100000000000000002']
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					(?, 'https://kopje.test/ap/users/alice', 'alice', NULL), (?, 'https://kopje.test/ap/users/bob', 'bob', NULL)`,
				alice,
				bob
			)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES
					(?, 'a@example.com', X'00', X'00', 'k'), (?, 'b@example.com', X'00', X'00', 'k')`,
				alice,
				bob
			)
			// A converted dotted block, and the same domain blocked again through the API later, with its cleanup.
			sql.exec(
				`INSERT INTO domain_blocks (id, account_id, domain) VALUES
					(1, ?1, 'pair.example.'), (2, ?1, 'pair.example'), (3, ?1, 'dotted.example.'), (4, ?1, 'plain.example'),
					(5, ?2, 'pair.example.')`,
				alice,
				bob
			)
			sql.exec('INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at) VALUES (2, 7, 1)')

			expect(await kernel(state, MIGRATIONS).upgrade()).toMatchObject({
				ok: true,
				applied: ['0003_domain_block_form'],
			})
			expect(sql.exec('SELECT id, account_id, domain FROM domain_blocks ORDER BY id').toArray()).toEqual([
				{ id: 1, account_id: alice, domain: 'pair.example' },
				{ id: 3, account_id: alice, domain: 'dotted.example' },
				{ id: 4, account_id: alice, domain: 'plain.example' },
				{ id: 5, account_id: bob, domain: 'pair.example' },
			])
			// The merged row's cleanup now belongs to the block that stays.
			expect(sql.exec('SELECT domain_block_id, bound FROM domain_block_cleanups').toArray()).toEqual([
				{ domain_block_id: 1, bound: 7 },
			])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('stays readonly with exact bookkeeping when a file fails, and lets a fixed build continue', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const broken = [
				...MIGRATIONS,
				{ name: '9999_broken', sql: 'CREATE TABLE half_done (a); INSERT INTO missing VALUES (1);' },
			]
			const k = kernel(state, broken)

			const result = await k.upgrade()
			expect(result).toMatchObject({ ok: false, reason: 'upgrade-failed', bookmark: expect.any(String) })
			expect(bookkeeping(state.storage.sql).map((m) => m.name)).toEqual(NAMES)
			expect(tableNames(state.storage.sql)).not.toContain('half_done')
			expect(await k.health(BUILD)).toMatchObject({ readonly: true, hold: 'upgrade-failed' })
			await expect(k.execute(BUILD, countSettings, undefined)).rejects.toThrow('schema-pending')

			// The same build does not retry on its own; rescue RPCs keep working.
			expect(await k.upgrade()).toMatchObject({ ok: false, detail: 'held' })
			expect(await kernel(state, broken).version()).toEqual({
				build: BUILD,
				expected: '9999_broken',
				applied: LATEST,
			})

			// A fix-forward deploy (new build, corrected file) clears the hold and upgrades.
			const fixed = [...MIGRATIONS, { name: '9999_fixed', sql: 'CREATE TABLE fixed (a);' }]
			expect(await kernel(state, fixed, { build: 'next' }).upgrade()).toMatchObject({
				ok: true,
				applied: ['9999_fixed'],
			})
		})
	})

	it('re-reads bookkeeping after an error thrown once the writes were already durable', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			let thrown = false
			// Throws once, right after the transaction that recorded 9999_extra committed.
			const timesOutAfterCommit = <T>(fn: () => T): T => {
				const value = state.storage.transactionSync(fn)
				if (!thrown && bookkeeping(state.storage.sql).some((m) => m.name === '9999_extra')) {
					thrown = true
					throw new Error('Durable Object storage operation exceeded timeout')
				}
				return value
			}
			const k = kernel(state, [...MIGRATIONS, { name: '9999_extra', sql: 'CREATE TABLE extra (a);' }], {
				transaction: timesOutAfterCommit,
			})

			const result = await k.upgrade()
			expect(result).toMatchObject({ ok: false, reason: 'upgrade-failed' })
			expect(result.ok === false && result.detail).toContain('9999_extra (recorded: true)')
			expect(bookkeeping(state.storage.sql).map((m) => m.name)).toEqual([...NAMES, '9999_extra'])
			expect(tableNames(state.storage.sql)).toContain('extra')

			// The schema is complete but the Store stays readonly: reads pass, writes are refused.
			expect(await k.health(BUILD)).toMatchObject({ schema: { status: 'current' }, readonly: true })
			expect(await k.execute(BUILD, countSettings, undefined)).toBe(0)
			await expect(k.execute(BUILD, putSetting, 'domain')).rejects.toThrow('kopje-maintenance: upgrade-failed')
		})
	})

	it('serves read and session operations and refuses writes while held readonly', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await kernel(state, MIGRATIONS).upgrade()
			const hold = { reason: 'upgrade-failed', build: BUILD, detail: 'test', at: 0 }
			state.storage.sql.exec("INSERT INTO kopje_state (name, value) VALUES ('hold', ?)", JSON.stringify(hold))
			const k = kernel(state, MIGRATIONS)

			await k.execute(BUILD, putSession, 'session')
			expect(await k.execute(BUILD, countSettings, undefined)).toBe(1)
			await expect(k.execute(BUILD, putSetting, 'write')).rejects.toThrow('kopje-maintenance: upgrade-failed')
			expect(await k.execute(BUILD, countSettings, undefined)).toBe(1)
		})
	})

	const EXTRA = [...MIGRATIONS, { name: '9999_extra', sql: 'CREATE TABLE extra (a);' }]
	const failAt = (target: string) => (phase: string) => {
		if (phase === target) {
			throw new Error(`injected ${phase} failure`)
		}
	}

	it.each([
		['bookmark', 'bookmark-failed', NAMES],
		['apply', 'upgrade-failed', NAMES],
		['verify', 'verify-failed', [...NAMES, '9999_extra']],
	])('stays readonly after a %s failure, also in a fresh kernel', async (phase, reason, recorded) => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await kernel(state, MIGRATIONS).upgrade()
			const k = kernel(state, EXTRA, { inject: failAt(phase) })

			expect(await k.upgrade()).toMatchObject({ ok: false, reason })
			expect(bookkeeping(state.storage.sql).map((m) => m.name)).toEqual(recorded)
			for (const view of [k, kernel(state, EXTRA)]) {
				expect(await view.health(BUILD)).toMatchObject({ readonly: true, hold: reason })
			}
		})
	})

	it('keeps a fresh kernel readonly and re-runs verification when the hold could not be persisted', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await kernel(state, MIGRATIONS).upgrade()
			await state.storage.deleteAlarm()
			// Verification throws, and so does recording the hold: only the upgrade marker is durable.
			const failing = kernel(state, EXTRA, {
				inject: (phase) => {
					failAt('verify')(phase)
					failAt('hold')(phase)
				},
			})
			expect(await failing.upgrade()).toMatchObject({ ok: false, reason: 'verify-failed' })
			expect(await failing.health(BUILD)).toMatchObject({ readonly: true })

			// A new isolate sees every file applied but no successful verification.
			const fresh = kernel(state, EXTRA)
			expect(await fresh.health(BUILD)).toMatchObject({ schema: { status: 'current' }, readonly: true, hold: null })
			expect(await fresh.execute(BUILD, countSettings, undefined)).toBe(0)
			await expect(fresh.execute(BUILD, putSetting, 'domain')).rejects.toThrow('kopje-maintenance: upgrade-in-progress')
			expect(await state.storage.getAlarm()).not.toBeNull()

			// The alarm re-runs verification only, then leaves readonly.
			expect(await fresh.upgrade()).toMatchObject({ ok: true, applied: [] })
			await fresh.execute(BUILD, putSetting, 'domain')
			expect(await kernel(state, EXTRA).health(BUILD)).toMatchObject({ readonly: false })
		})
	})

	it('refuses calls from another build without leaving normal mode', async () => {
		const store = freshStore()
		await runInDurableObject(store, (_instance, state) => kernel(state, MIGRATIONS).upgrade())

		const error = toStoreUnavailable(await rejectionOf(store.setupState('0.0.0-other')))
		expect(error).toBeInstanceOf(StoreUnavailableError)
		expect(error?.reason).toBe('version-mismatch')
		expect(await store.health('0.0.0-other')).toMatchObject({ versionMatch: false, readonly: false })
		expect(await store.setupState(BUILD)).toEqual({ complete: false })
	})

	it('refuses a PITR restore from another build but keeps introspection open to it', async () => {
		const store = freshStore()
		await runInDurableObject(store, (_instance, state) => kernel(state, MIGRATIONS).upgrade())
		const { lastBookmark } = await store.health(BUILD)
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('marker', 'kept')")
		})

		const error = toStoreUnavailable(await rejectionOf(store.pitrToBookmark('0.0.0-other', lastBookmark!)))
		expect(error?.reason).toBe('version-mismatch')
		expect(await store.version('0.0.0-other')).toMatchObject({ build: BUILD })
		const dump = await store.dumpStart('0.0.0-other')
		expect(dump).toMatchObject({ ok: true })
		expect(await store.dumpFinish('0.0.0-other', dump.ok ? dump.cursor : null, true)).toMatchObject({ aborted: true })
		// The object was neither restarted nor rewound.
		await runInDurableObject(store, (_instance, state) => {
			expect(state.storage.sql.exec("SELECT value FROM instance_settings WHERE name = 'marker'").toArray()).toEqual([
				{ value: 'kept' },
			])
		})
	})

	it('goes readonly without an upgrade alarm when an applied file was changed', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await kernel(state, MIGRATIONS).upgrade()
			await state.storage.deleteAlarm()
			const edited = [{ name: '0000_initial', sql: `${MIGRATIONS[0]?.sql}\n-- edited` }, ...MIGRATIONS.slice(1)]
			const k = kernel(state, edited)

			expect(await k.health(BUILD)).toMatchObject({ schema: { status: 'diverged' }, readonly: true })
			expect(await state.storage.getAlarm()).toBeNull()
			await expect(k.execute(BUILD, countSettings, undefined)).rejects.toThrow('schema-diverged')
		})
	})
})
