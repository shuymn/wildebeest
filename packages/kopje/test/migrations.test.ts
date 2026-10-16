import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { BUILD, freshStore, rejectionOf, tableNames, testKernel as kernel } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { Db } from '../src/db/sql'
import { DISTRIBUTABLE_SQL, REACHES_FOLLOWERS_SQL, REQUIRES_MENTION_SQL } from '../src/domain/audience'
import { CONVERSATIONS_BACKFILL } from '../src/domain/conversation-rows'
import { readOperation, sessionOperation, writeOperation } from '../src/domain/operation'
import { storeRemoteStatus } from '../src/domain/remote-statuses'
import { normalizeTag } from '../src/domain/tag-name'
import { parseRemoteStatus } from '../src/federation/remote-status'
import { StoreUnavailableError, toStoreUnavailable } from '../src/platform/store-errors'

// The shipped migrations, in order; test-only files are named after them (9999_*).
const NAMES = MIGRATIONS.map((m) => m.name)
const LATEST = NAMES.at(-1)

const SCHEMA_TABLES = [
	'account_notes',
	'account_pins',
	'accounts',
	'blocks',
	'bookmarks',
	'conversation_mutes',
	'conversation_statuses',
	'conversations',
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
	'markers',
	'media_attachments',
	'mutes',
	'notification_permissions',
	'notification_policies',
	'notification_request_jobs',
	'notification_requests',
	'notifications',
	'oauth_clients',
	'oauth_tokens',
	'outbound_activities',
	'outbound_receipts',
	'outbound_targets',
	'push_deliveries',
	'push_subscriptions',
	'remote_keys',
	'scheduled_statuses',
	'status_edits',
	'status_pins',
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
				applied: [NAMES[1]],
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
				applied: NAMES.slice(0, 2),
			})
			sql.exec(`
				INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('c', 's', 'n', 'urn:x', 'push');
				INSERT INTO oauth_tokens (token_hash, kind, client_id, scopes) VALUES ('h', 'access', 'c', 'push');
				INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth) VALUES ('h', 'https://p.example/', 'k', 'a');
			`)
			expect(await kernel(state, MIGRATIONS.slice(0, 3)).upgrade()).toMatchObject({ ok: true, applied: [NAMES[2]] })
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
			// A converted dotted block with a cleanup, and the same domain blocked again through the API; two dotted
			// spellings of one domain; a dotted block alone; one already in form; another account's dotted block.
			sql.exec(
				`INSERT INTO domain_blocks (id, account_id, domain) VALUES
					(1, ?1, 'pair.example.'), (2, ?1, 'pair.example'), (3, ?1, 'dotted.example.'), (4, ?1, 'plain.example'),
					(5, ?2, 'pair.example.'), (6, ?1, 'twin.example..'), (7, ?1, 'twin.example.')`,
				alice,
				bob
			)
			sql.exec('INSERT INTO domain_block_cleanups (domain_block_id, bound, created_at) VALUES (1, 7, 1)')

			expect(await kernel(state, MIGRATIONS.slice(0, 4)).upgrade()).toMatchObject({ ok: true, applied: [NAMES[3]] })
			expect(sql.exec('SELECT id, account_id, domain FROM domain_blocks ORDER BY id').toArray()).toEqual([
				{ id: 2, account_id: alice, domain: 'pair.example' },
				{ id: 3, account_id: alice, domain: 'dotted.example' },
				{ id: 4, account_id: alice, domain: 'plain.example' },
				{ id: 5, account_id: bob, domain: 'pair.example' },
				{ id: 6, account_id: alice, domain: 'twin.example' },
			])
			// The merged row's cleanup now belongs to the block that stays.
			expect(sql.exec('SELECT domain_block_id, bound FROM domain_block_cleanups').toArray()).toEqual([
				{ domain_block_id: 2, bound: 7 },
			])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0003_domain_block_form reads each block in form once, however many an account holds (RES-7)', async () => {
		const migration = MIGRATIONS.find((m) => m.name === '0003_domain_block_form')!
		const statements = migration.sql
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (normal: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, 3)).upgrade()
				const alice = '100000000000000001'
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice', NULL)",
					alice
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
					alice
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
					INSERT INTO domain_blocks (account_id, domain) SELECT ?1, 'd' || i || '.example' FROM n`,
					alice,
					normal
				)
				sql.exec(
					"INSERT INTO domain_blocks (account_id, domain) VALUES (?1, 'd1.example.'), (?1, 'new.example.'), (?1, 'new.example..')",
					alice
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(sql.exec("SELECT count(*) AS n FROM domain_blocks WHERE domain LIKE '%.'").one()).toEqual({ n: 0 })
				expect(sql.exec('SELECT count(*) AS n FROM domain_blocks').one()).toEqual({ n: normal + 1 })
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// One pass over the table per statement that looks for dotted rows; nothing per pair of rows.
		expect(large - small).toBeLessThanOrEqual(2 * (10_000 - 1000))
	}, 60_000)

	it('upgrades a Store at 0003_domain_block_form with 0004_status_tags_public: hashtags of public statuses are marked', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, 4)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice', NULL)",
				alice
			)
			const visibilities = ['public', 'unlisted', 'private', 'direct', 'limited']
			visibilities.forEach((visibility, i) => {
				const id = String(200000000000000001n + BigInt(i))
				sql.exec(
					"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')",
					id,
					`https://kopje.test/ap/o/${i}`,
					alice,
					visibility
				)
				sql.exec("INSERT INTO status_tags (status_id, name) VALUES (?, 'cats'), (?, 'dogs')", id, id)
			})

			expect(await kernel(state, MIGRATIONS.slice(0, 5)).upgrade()).toMatchObject({ ok: true, applied: [NAMES[4]] })
			expect(
				sql
					.exec(
						`SELECT s.visibility, t.name, t.public FROM status_tags t JOIN statuses s ON s.id = t.status_id
						ORDER BY t.status_id, t.name`
					)
					.toArray()
			).toEqual(
				visibilities.flatMap((visibility) =>
					['cats', 'dogs'].map((name) => ({ visibility, name, public: visibility === 'public' ? 1 : 0 }))
				)
			)
			expect(
				sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'status_tags_public'").toArray()
			).toEqual([{ sql: expect.stringContaining('WHERE public = 1') }])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0004_status_tags_public reads each hashtag row a bounded number of times, however many there are', async () => {
		const migration = MIGRATIONS.find((m) => m.name === '0004_status_tags_public')!
		const statements = migration.sql
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, 4)).upgrade()
				const alice = '100000000000000001'
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice', NULL)",
					alice
				)
				// Every other status public, each with two hashtags.
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
					INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, ?1,
						CASE i % 2 WHEN 0 THEN 'public' ELSE 'private' END, '2026-01-01T00:00:00.000Z' FROM n`,
					alice,
					count
				)
				sql.exec(
					"INSERT INTO status_tags (status_id, name) SELECT id, 'cats' FROM statuses UNION ALL SELECT id, 'dogs' FROM statuses"
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(sql.exec('SELECT count(*) AS n FROM status_tags WHERE public = 1').one()).toEqual({ n: count })
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// A few reads per hashtag row added (the backfill's pass with its status lookup, the index build's pass), nothing
		// per pair of rows.
		const added = 2 * (10_000 - 1000)
		expect(large - small).toBeLessThanOrEqual(5 * added)
	}, 60_000)

	it('upgrades a Store at 0004_status_tags_public with 0005_hide_collections: every account keeps its network shown', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, 5)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice', NULL)",
				alice
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				alice
			)

			expect(await kernel(state, MIGRATIONS.slice(0, 6)).upgrade()).toMatchObject({ ok: true, applied: [NAMES[5]] })
			expect(sql.exec('SELECT account_id, hide_collections FROM local_accounts').toArray()).toEqual([
				{ account_id: alice, hide_collections: 0 },
			])
			expect(() => sql.exec('UPDATE local_accounts SET hide_collections = 2')).toThrow(/CHECK constraint failed/)
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('upgrades a Store at 0005_hide_collections with 0006_account_deletion: an account whose purge runs is marked', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, 6)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice', NULL)",
				alice
			)
			// bob's purge runs, carol's finished (her row is gone) and dan has none.
			for (const [i, name] of ['bob', 'dan'].entries()) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
					String(100000000000000002n + BigInt(i)),
					`https://remote.example/users/${name}`,
					name,
					'remote.example'
				)
			}
			const started = Date.parse('2026-10-14T12:34:56.789Z')
			sql.exec(
				`INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?1, ?1, ?2)`,
				'https://remote.example/users/bob',
				started
			)
			sql.exec(
				`INSERT INTO inbound_jobs (kind, key, actor_uri, done_at, expires_at, created_at) VALUES ('purge', ?1, ?1, ?2, ?3, ?2)`,
				'https://remote.example/users/carol',
				started,
				started + 1
			)

			expect(await kernel(state, MIGRATIONS.slice(0, 7)).upgrade()).toMatchObject({ ok: true, applied: [NAMES[6]] })
			expect(sql.exec('SELECT username, deleted_at FROM accounts ORDER BY id').toArray()).toEqual([
				{ username: 'alice', deleted_at: null },
				{ username: 'bob', deleted_at: '2026-10-14T12:34:56.789Z' },
				{ username: 'dan', deleted_at: null },
			])
			// A local account is never marked.
			expect(() => sql.exec("UPDATE accounts SET deleted_at = '2026-10-15T00:00:00.000Z' WHERE id = ?", alice)).toThrow(
				/CHECK constraint failed/
			)
			expect(
				sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'accounts_deleted'").toArray()
			).toEqual([{ sql: expect.stringContaining('WHERE deleted_at IS NOT NULL') }])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0006_account_deletion reads each account a bounded number of times, however many there are', async () => {
		const migration = MIGRATIONS.find((m) => m.name === '0006_account_deletion')!
		const statements = migration.sql
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, 6)).upgrade()
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain)
					SELECT CAST(100000000000000000 + i AS TEXT), 'https://remote.example/users/u' || i, 'u' || i, 'remote.example'
					FROM n`,
					count
				)
				// Ten running purges, whatever the number of accounts.
				sql.exec(
					`INSERT INTO inbound_jobs (kind, key, actor_uri, created_at)
					SELECT 'purge', uri, uri, 1 FROM accounts ORDER BY id LIMIT 10`
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(sql.exec('SELECT count(*) AS n FROM accounts WHERE deleted_at IS NOT NULL').one()).toEqual({ n: 10 })
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// A few reads per account added (the CHECK's pass over the table, the index build's pass), none per pair.
		const added = 10_000 - 1000
		expect(large - small).toBeLessThanOrEqual(5 * added)
	}, 60_000)

	it('upgrades a Store at 0006_account_deletion with 0007_list_members: members nobody follows go, and leave with the follow', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, 7)).upgrade()).toMatchObject({ ok: true })
			const id = (n: number) => String(100000000000000000n + BigInt(n))
			for (const n of [1, 2]) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id(n),
					`https://kopje.test/ap/users/u${n}`,
					`u${n}`
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
					id(n),
					`u${n}@example.com`
				)
			}
			for (const n of [3, 4, 5, 6]) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'remote.example')",
					id(n),
					`https://remote.example/users/r${n}`,
					`r${n}`
				)
			}
			// u1 follows r3 and has asked r4; u2 follows r5. r6 is followed by nobody.
			sql.exec(
				`INSERT INTO follows (account_id, target_account_id, state) VALUES
					(?1, ?3, 'accepted'), (?1, ?4, 'pending'), (?2, ?5, 'accepted')`,
				id(1),
				id(2),
				id(3),
				id(4),
				id(5)
			)
			sql.exec(
				"INSERT INTO lists (id, account_id, title) VALUES ('800000000000000001', ?, 'a'), ('800000000000000002', ?, 'b')",
				id(1),
				id(2)
			)
			for (const [list, members] of [
				['800000000000000001', [1, 3, 4, 5, 6]],
				['800000000000000002', [3, 5]],
			] as const) {
				for (const n of members) {
					sql.exec('INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', list, id(n))
				}
			}

			expect(await kernel(state, MIGRATIONS.slice(0, 8)).upgrade()).toMatchObject({ ok: true, applied: [NAMES[7]] })
			const members = () =>
				sql.exec('SELECT list_id, account_id FROM list_accounts ORDER BY list_id, account_id').toArray()
			expect(members()).toEqual([
				{ list_id: '800000000000000001', account_id: id(1) },
				{ list_id: '800000000000000001', account_id: id(3) },
				{ list_id: '800000000000000001', account_id: id(4) },
				{ list_id: '800000000000000002', account_id: id(5) },
			])
			// A follow's end takes its account out of the follower's lists only; an accepted request keeps it.
			sql.exec("UPDATE follows SET state = 'accepted' WHERE target_account_id = ?", id(4))
			sql.exec('DELETE FROM follows WHERE account_id = ? AND target_account_id = ?', id(1), id(3))
			sql.exec('DELETE FROM follows WHERE account_id = ? AND target_account_id = ?', id(2), id(5))
			expect(members()).toEqual([
				{ list_id: '800000000000000001', account_id: id(1) },
				{ list_id: '800000000000000001', account_id: id(4) },
			])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0007_list_members reads each member a bounded number of times, however many there are', async () => {
		const migration = MIGRATIONS.find((m) => m.name === '0007_list_members')!
		const cleanup = migration.sql
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split('CREATE TRIGGER')[0]!
			.split(';')
			.filter((statement) => statement.trim() !== '')
		expect(cleanup).toHaveLength(1)
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, 7)).upgrade()
				sql.exec(
					"INSERT INTO accounts (id, uri, username) VALUES ('100000000000000000', 'https://kopje.test/ap/users/o', 'o')"
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES ('100000000000000000', 'o@example.com', X'00', X'00', 'k')"
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain)
					SELECT CAST(100000000000000000 + i AS TEXT), 'https://remote.example/users/u' || i, 'u' || i, 'remote.example'
					FROM n`,
					count
				)
				// The owner follows every other account; every account is in one of five lists.
				sql.exec(
					`INSERT INTO follows (account_id, target_account_id, state)
					SELECT '100000000000000000', id, 'accepted' FROM accounts WHERE domain IS NOT NULL AND id % 2 = 0`
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
					INSERT INTO lists (id, account_id, title) SELECT CAST(800000000000000000 + i AS TEXT), '100000000000000000', 'l' FROM n`
				)
				sql.exec(
					`INSERT INTO list_accounts (list_id, account_id)
					SELECT CAST(800000000000000001 + id % 5 AS TEXT), id FROM accounts WHERE domain IS NOT NULL`
				)
				const cursor = sql.exec(cleanup[0]!)
				cursor.toArray()
				expect(sql.exec('SELECT count(*) AS n FROM list_accounts').one()).toEqual({ n: count / 2 })
				return cursor.rowsRead
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// A few reads per member added (the row, its list, its follow), none per pair.
		expect(large - small).toBeLessThanOrEqual(5 * (10_000 - 1000))
	}, 60_000)

	it('upgrades a Store at 0007_list_members with 0008_status_mentions_requires_mention: mentions in direct and limited statuses are marked', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, 8)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			const bob = '100000000000000002'
			for (const [id, name] of [
				[alice, 'alice'],
				[bob, 'bob'],
			]) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, NULL)',
					id,
					`https://kopje.test/ap/users/${name}`,
					name
				)
			}
			const visibilities = ['public', 'unlisted', 'private', 'direct', 'limited']
			visibilities.forEach((visibility, i) => {
				const id = String(200000000000000001n + BigInt(i))
				sql.exec(
					"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')",
					id,
					`https://kopje.test/ap/o/${i}`,
					alice,
					visibility
				)
				sql.exec('INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, ?)', id, bob, i % 2)
			})

			expect(await kernel(state, MIGRATIONS.slice(0, 9)).upgrade()).toMatchObject({ ok: true, applied: [NAMES[8]] })
			expect(
				sql
					.exec(
						`SELECT s.visibility, m.silent, m.requires_mention, m.author_id FROM status_mentions m
						JOIN statuses s ON s.id = m.status_id ORDER BY m.status_id`
					)
					.toArray()
			).toEqual(
				visibilities.map((visibility, i) => ({
					visibility,
					silent: i % 2,
					requires_mention: visibility === 'direct' || visibility === 'limited' ? 1 : 0,
					author_id: alice,
				}))
			)
			expect(
				sql
					.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'status_mentions_requires_mention'")
					.toArray()
			).toEqual([{ sql: expect.stringMatching(/\(account_id, author_id, status_id\)\s+WHERE requires_mention = 1/) }])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0008_status_mentions_requires_mention marks the visibilities the policy names', () => {
		const migration = MIGRATIONS.find((m) => m.name === '0008_status_mentions_requires_mention')!
		expect(migration.sql).toContain(`IN ${REQUIRES_MENTION_SQL}`)
	})

	it('0008_status_mentions_requires_mention reads each mention row a bounded number of times, however many there are', async () => {
		const migration = MIGRATIONS.find((m) => m.name === '0008_status_mentions_requires_mention')!
		const statements = migration.sql
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, 8)).upgrade()
				sql.exec(
					`INSERT INTO accounts (id, uri, username, domain) VALUES
					('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice', NULL),
					('100000000000000002', 'https://kopje.test/ap/users/bob', 'bob', NULL),
					('100000000000000003', 'https://kopje.test/ap/users/carol', 'carol', NULL)`
				)
				// Every other status direct, each mentioning two accounts.
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, '100000000000000001',
						CASE i % 2 WHEN 0 THEN 'direct' ELSE 'public' END, '2026-01-01T00:00:00.000Z' FROM n`,
					count
				)
				sql.exec(
					`INSERT INTO status_mentions (status_id, account_id)
					SELECT id, '100000000000000002' FROM statuses UNION ALL SELECT id, '100000000000000003' FROM statuses`
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(
					sql
						.exec(
							"SELECT count(*) AS n FROM status_mentions WHERE requires_mention = 1 AND author_id = '100000000000000001'"
						)
						.one()
				).toEqual({ n: count })
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// A few reads per mention row added (the backfill's pass with its status lookup, the index build's pass), nothing
		// per pair of rows.
		const added = 2 * (10_000 - 1000)
		expect(large - small).toBeLessThanOrEqual(5 * added)
	}, 60_000)

	it('upgrades a Store with 0012_filters: filters go with their account, rules with their filter, statuses with theirs', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			const at = NAMES.indexOf('0012_filters')
			expect(at).toBeGreaterThan(0)
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			expect(tableNames(sql)).not.toContain('filters')
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0012_filters'],
			})
			const alice = '100000000000000001'
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice', NULL)",
				alice
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'alice@example.com', x'00', x'00', 'k')",
				alice
			)
			sql.exec(
				"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES ('200000000000000001', 'https://kopje.test/ap/o/1', ?, 'public', '2026-01-01T00:00:00.000Z')",
				alice
			)
			sql.exec(
				`INSERT INTO filters (id, account_id, title, context) VALUES ('300000000000000001', ?, 'f', '["home"]'),
					('300000000000000002', ?, 'g', '["public"]')`,
				alice,
				alice
			)
			sql.exec(
				"INSERT INTO filter_keywords (id, filter_id, keyword) VALUES ('400000000000000001', '300000000000000001', 'k')"
			)
			sql.exec(
				`INSERT INTO filter_statuses (id, filter_id, status_id) VALUES
					('500000000000000001', '300000000000000001', '200000000000000001'),
					('500000000000000002', '300000000000000002', '200000000000000001')`
			)
			expect(() =>
				sql.exec(
					"INSERT INTO filters (id, account_id, title, context, action) VALUES ('300000000000000003', ?, 'h', '[]', 'delete')",
					alice
				)
			).toThrow(/CHECK/)
			expect(() =>
				sql.exec(
					"INSERT INTO filters (id, account_id, title, context) VALUES ('300000000000000003', ?, 'h', 'home')",
					alice
				)
			).toThrow(/CHECK/)
			expect(() =>
				sql.exec(
					"INSERT INTO filter_statuses (id, filter_id, status_id) VALUES ('500000000000000003', '300000000000000001', '200000000000000001')"
				)
			).toThrow(/UNIQUE/)

			sql.exec("DELETE FROM filters WHERE id = '300000000000000001'")
			expect(sql.exec('SELECT id FROM filter_keywords').toArray()).toEqual([])
			expect(sql.exec('SELECT id FROM filter_statuses').toArray()).toEqual([{ id: '500000000000000002' }])
			sql.exec("DELETE FROM statuses WHERE id = '200000000000000001'")
			expect(sql.exec('SELECT id FROM filter_statuses').toArray()).toEqual([])
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', alice)
			expect(sql.exec('SELECT id FROM filters').toArray()).toEqual([])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})
	// Found by name, so the tests hold whatever migrations come before it.
	const CONVERSATIONS = NAMES.indexOf('0009_conversations')

	it('0009_conversations runs the backfill the cutover runs', () => {
		expect(MIGRATIONS[CONVERSATIONS]?.sql).toContain(CONVERSATIONS_BACKFILL)
	})

	it('upgrades a Store with 0009_conversations: the direct statuses stored make their conversations', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, CONVERSATIONS)).upgrade()).toMatchObject({ ok: true })
			const id = (n: number) => String(100000000000000000n + BigInt(n))
			const statusId = (n: number) => String(200000000000000000n + BigInt(n))
			for (const n of [1, 2]) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id(n),
					`https://kopje.test/ap/users/u${n}`,
					`u${n}`
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
					id(n),
					`u${n}@example.com`
				)
			}
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/r', 'r', 'remote.example')",
				id(3)
			)
			const status = (
				n: number,
				author: number,
				visibility: string,
				mentions: number[],
				notified: number[],
				parent: { id?: number; uri?: string } = {}
			) => {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, in_reply_to_id, in_reply_to_uri, published_at)
					VALUES (?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z')`,
					statusId(n),
					`https://kopje.test/ap/o/${n}`,
					id(author),
					visibility,
					parent.id === undefined ? null : statusId(parent.id),
					parent.uri ?? (parent.id === undefined ? null : `https://kopje.test/ap/o/${parent.id}`)
				)
				for (const m of mentions) {
					sql.exec('INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, 0)', statusId(n), id(m))
				}
				for (const r of notified) {
					sql.exec(
						"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
						id(r),
						id(author),
						statusId(n)
					)
				}
			}
			// u1 writes to u2, who answers; r writes to u1 in reply to a status never stored, and to u2, whose notification
			// is gone (cleared). A limited, a private and a public status mention u1 too.
			status(1, 1, 'direct', [2], [2])
			status(2, 2, 'direct', [1], [1], { id: 1 })
			status(3, 3, 'direct', [1], [1], { uri: 'https://remote.example/objects/gone' })
			status(4, 3, 'direct', [2], [])
			status(5, 3, 'limited', [1], [1])
			status(6, 2, 'private', [1], [1])
			status(7, 2, 'public', [1], [1])

			expect(await kernel(state, MIGRATIONS.slice(0, CONVERSATIONS + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: [NAMES[CONVERSATIONS]],
			})
			const conversations = () =>
				sql
					.exec(
						`SELECT c.account_id, c.thread, c.participants, c.last_status_id, c.unread,
							(SELECT json_group_array(status_id) FROM conversation_statuses WHERE conversation_id = c.id) AS statuses
						FROM conversations c ORDER BY c.id`
					)
					.toArray()
			expect(conversations()).toEqual([
				{
					account_id: id(1),
					thread: 'https://kopje.test/ap/o/1',
					participants: JSON.stringify([id(2)]),
					last_status_id: statusId(2),
					unread: 1,
					statuses: JSON.stringify([statusId(1), statusId(2)]),
				},
				{
					account_id: id(2),
					thread: 'https://kopje.test/ap/o/1',
					participants: JSON.stringify([id(1)]),
					last_status_id: statusId(2),
					unread: 0,
					statuses: JSON.stringify([statusId(1), statusId(2)]),
				},
				{
					account_id: id(1),
					thread: 'https://remote.example/objects/gone',
					participants: JSON.stringify([id(3)]),
					last_status_id: statusId(3),
					unread: 1,
					statuses: JSON.stringify([statusId(3)]),
				},
			])
			// Every status has its thread: the start of its chain, or the uri a reply to a status never stored names.
			expect(sql.exec('SELECT id, thread FROM statuses ORDER BY id').toArray()).toEqual([
				{ id: statusId(1), thread: 'https://kopje.test/ap/o/1' },
				{ id: statusId(2), thread: 'https://kopje.test/ap/o/1' },
				{ id: statusId(3), thread: 'https://remote.example/objects/gone' },
				{ id: statusId(4), thread: 'https://kopje.test/ap/o/4' },
				{ id: statusId(5), thread: 'https://kopje.test/ap/o/5' },
				{ id: statusId(6), thread: 'https://kopje.test/ap/o/6' },
				{ id: statusId(7), thread: 'https://kopje.test/ap/o/7' },
			])
			// A deleted status leaves: the last status moves back, and a conversation with none left goes.
			sql.exec('DELETE FROM statuses WHERE id = ?', statusId(2))
			sql.exec('DELETE FROM statuses WHERE id = ?', statusId(3))
			expect(conversations()).toEqual([
				expect.objectContaining({ account_id: id(1), last_status_id: statusId(1), unread: 1 }),
				expect.objectContaining({ account_id: id(2), last_status_id: statusId(1), unread: 0 }),
			])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0009_conversations threads a chain deeper than any walk and a cycle as the write path keeps them', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, CONVERSATIONS)).upgrade()
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES ('100000000000000003', 'https://remote.example/users/r', 'r', 'remote.example')"
			)
			const uri = (i: number) => `https://remote.example/objects/${i}`
			// A chain of 5,000 replies, the first replying to a status never stored; and A and B replying to each other.
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
				INSERT INTO statuses (id, uri, account_id, visibility, in_reply_to_id, in_reply_to_uri, published_at)
				SELECT CAST(200000000000000000 + i AS TEXT), 'https://remote.example/objects/' || i, '100000000000000003',
					'direct', CASE WHEN i > 1 THEN CAST(200000000000000000 + i - 1 AS TEXT) END,
					'https://remote.example/objects/' || (i - 1), '2026-10-01T00:00:00.000Z'
				FROM n`
			)
			for (const [id, parent] of [
				['300000000000000001', '300000000000000002'],
				['300000000000000002', '300000000000000001'],
			]) {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, in_reply_to_uri, published_at)
					VALUES (?, ?, '100000000000000003', 'direct', ?, '2026-10-01T00:00:00.000Z')`,
					id,
					`https://remote.example/objects/${id}`,
					`https://remote.example/objects/${parent}`
				)
			}
			sql.exec("UPDATE statuses SET in_reply_to_id = '300000000000000002' WHERE id = '300000000000000001'")
			sql.exec("UPDATE statuses SET in_reply_to_id = '300000000000000001' WHERE id = '300000000000000002'")
			expect(await kernel(state, MIGRATIONS.slice(0, CONVERSATIONS + 1)).upgrade()).toMatchObject({ ok: true })
			const threads = (where: string) =>
				sql
					.exec(`SELECT DISTINCT thread FROM statuses WHERE ${where}`)
					.toArray()
					.map((row) => row.thread)
			// The whole chain takes the uri its first status names, however deep.
			expect(threads("id < '300000000000000000'")).toEqual([uri(0)])
			// Neither status of the cycle starts a chain: each takes the uri it names.
			expect(threads("id = '300000000000000001'")).toEqual(['https://remote.example/objects/300000000000000002'])
			expect(threads("id = '300000000000000002'")).toEqual(['https://remote.example/objects/300000000000000001'])
			// Statuses written after take their parent's thread, which never changes.
			for (const [id, parent] of [
				['400000000000000001', '200000000000005000'],
				['400000000000000002', '300000000000000001'],
			]) {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, in_reply_to_id, in_reply_to_uri, published_at)
					VALUES (?, ?, '100000000000000003', 'direct', ?, 'https://remote.example/parent', '2026-10-01T00:00:00.000Z')`,
					id,
					`https://remote.example/objects/${id}`,
					parent
				)
			}
			expect(threads("id = '400000000000000001'")).toEqual([uri(0)])
			expect(threads("id = '400000000000000002'")).toEqual(['https://remote.example/objects/300000000000000002'])
		})
	}, 60_000)

	it('0009_conversations threads a received status by the conversation its stored object names', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, CONVERSATIONS)).upgrade()
			const alice = '100000000000000001'
			const bob = '100000000000000002'
			const aliceUri = 'https://kopje.test/ap/users/alice'
			sql.exec("INSERT INTO accounts (id, uri, username) VALUES (?, ?, 'alice')", alice, aliceUri)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'alice@example.com', X'00', X'00', 'k')",
				alice
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://mastodon.example/users/bob', 'bob', 'mastodon.example')",
				bob
			)
			const conversation = 'tag:mastodon.example,2026-10-11:objectId=1:objectType=Conversation'
			const note = (n: number, extra: Record<string, unknown> = {}) => ({
				id: `https://mastodon.example/users/bob/statuses/${n}`,
				type: 'Note',
				attributedTo: 'https://mastodon.example/users/bob',
				to: [aliceUri],
				cc: [],
				published: `2026-10-11T12:0${n}:00Z`,
				content: `<p>${n}</p>`,
				tag: [{ type: 'Mention', href: aliceUri }],
				conversation,
				...extra,
			})
			// Stored before the upgrade: R naming its conversation, and S naming one too long to be one (as no release
			// stored a thread then, both without one).
			const before = (n: number, raw: Record<string, unknown>) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, published_at, raw)
					VALUES (?, ?, ?, 'direct', '2026-10-11T12:00:00.000Z', ?)`,
					`20000000000000000${n}`,
					raw.id,
					bob,
					JSON.stringify(raw)
				)
			const r = note(1)
			before(1, r)
			const s = note(5, { conversation: 'x'.repeat(4097) })
			before(5, s)
			expect(await kernel(state, MIGRATIONS.slice(0, CONVERSATIONS + 1)).upgrade()).toMatchObject({ ok: true })
			const threadOf = (uri: string) =>
				sql.exec<{ thread: string }>('SELECT thread FROM statuses WHERE uri = ?', uri).one().thread
			expect([threadOf(r.id), threadOf(s.id)]).toEqual([conversation, s.id])

			// After it, P replies to R and Q to P, and Q arrives first: all of them are in one thread and one conversation.
			// This build's code writes them, over the schema it ships.
			expect(await kernel(state, MIGRATIONS).upgrade()).toMatchObject({ ok: true })
			// Alice accepts private mentions from anyone, so bob's reach her conversations (the default policy filters a
			// private mention from an account she does not follow).
			sql.exec("INSERT INTO notification_policies (account_id, for_private_mentions) VALUES (?, 'accept')", alice)
			const db = new Db(sql)
			const p = note(2, { inReplyTo: r.id })
			const q = note(3, { inReplyTo: p.id })
			for (const object of [q, p]) {
				const input = parseRemoteStatus(object)
				expect(input).not.toBeNull()
				const outcome = storeRemoteStatus(db, { id: bob, uri: 'https://mastodon.example/users/bob' }, input!, {
					now: Date.parse('2026-10-11T13:00:00Z'),
					origin: 'https://kopje.test',
					deliveredTo: alice,
					fetched: false,
				})
				expect(outcome).toMatchObject({ applied: true })
			}
			expect([r, p, q].map((n) => threadOf(n.id))).toEqual([conversation, conversation, conversation])
			expect(sql.exec('SELECT count(*) AS n FROM conversations WHERE account_id = ?', alice).one()).toEqual({ n: 1 })
		})
	})

	it('0009_conversations reads each status a bounded number of times, and each direct one a few more', async () => {
		const migration = MIGRATIONS[CONVERSATIONS]!
		const statements = migration.sql
			.replace(/--.*$/gm, '')
			.split('CREATE TRIGGER')[0]!
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, CONVERSATIONS)).upgrade()
				for (const [n, domain] of [
					[1, null],
					[2, null],
					[3, 'remote.example'],
				] as const) {
					sql.exec(
						'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
						String(100000000000000000n + BigInt(n)),
						`https://kopje.test/ap/users/u${n}`,
						`u${n}`,
						domain
					)
					if (domain === null) {
						sql.exec(
							"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
							String(100000000000000000n + BigInt(n)),
							`u${n}@example.com`
						)
					}
				}
				// One status in ten is direct, from u1 or r to u2 (notified), each the reply to the one before it of its
				// author; the rest are public.
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO statuses (id, uri, account_id, visibility, in_reply_to_id, in_reply_to_uri, published_at)
					SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i,
						CASE WHEN i % 20 = 0 THEN '100000000000000003' ELSE '100000000000000001' END,
						CASE WHEN i % 10 = 0 THEN 'direct' ELSE 'public' END,
						CASE WHEN i % 10 = 0 AND i > 20 THEN CAST(200000000000000000 + i - 20 AS TEXT) END,
						CASE WHEN i % 10 = 0 AND i > 20 THEN 'https://kopje.test/ap/o/' || (i - 20) END,
						'2026-10-01T00:00:00.000Z'
					FROM n`,
					count
				)
				sql.exec(
					`INSERT INTO status_mentions (status_id, account_id) SELECT id, '100000000000000002' FROM statuses
					WHERE visibility = 'direct'`
				)
				sql.exec(
					`INSERT INTO notifications (account_id, type, from_account_id, status_id)
					SELECT '100000000000000002', 'mention', account_id, id FROM statuses WHERE visibility = 'direct'`
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(sql.exec('SELECT count(*) AS n FROM conversation_statuses').one()).toEqual({ n: (count / 10) * 1.5 })
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// A few reads per status added (its thread, from the start of its chain down, and its write), and a bounded number
		// per direct status (its mention, its notification, its two owners' rows), however long its reply chain: none per
		// pair.
		const added = 10_000 - 1000
		expect(large - small).toBeLessThanOrEqual(6 * added + 20 * (added / 10))
	}, 60_000)

	it('upgrades a Store with 0014_account_notes_and_pins: notes and endorsements go with their account, endorsements with the follow', async () => {
		const at = NAMES.indexOf('0014_account_notes_and_pins')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			expect(tableNames(sql)).not.toContain('account_pins')
			const id = (n: number) => String(100000000000000000n + BigInt(n))
			for (const n of [1, 2]) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id(n),
					`https://kopje.test/ap/users/u${n}`,
					`u${n}`
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
					id(n),
					`u${n}@example.com`
				)
			}
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/r', 'r', 'remote.example')",
				id(3)
			)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0014_account_notes_and_pins'],
			})
			const pins = () => sql.exec('SELECT account_id, target_account_id FROM account_pins ORDER BY 1, 2').toArray()
			const note = (account: string, target: string, comment: string) =>
				sql.exec(
					'INSERT INTO account_notes (account_id, target_account_id, comment) VALUES (?, ?, ?)',
					account,
					target,
					comment
				)
			for (const [account, target] of [
				[id(1), id(2)],
				[id(1), id(3)],
				[id(2), id(3)],
			] as const) {
				sql.exec(
					"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
					account,
					target
				)
				sql.exec('INSERT INTO account_pins (account_id, target_account_id) VALUES (?, ?)', account, target)
			}
			expect(() =>
				sql.exec('INSERT INTO account_pins (account_id, target_account_id) VALUES (?, ?)', id(1), id(2))
			).toThrow(/UNIQUE/)
			expect(() =>
				sql.exec('INSERT INTO account_pins (account_id, target_account_id) VALUES (?, ?)', id(1), id(1))
			).toThrow(/CHECK/)
			// Only a local account endorses or keeps notes.
			expect(() =>
				sql.exec('INSERT INTO account_pins (account_id, target_account_id) VALUES (?, ?)', id(3), id(1))
			).toThrow(/FOREIGN KEY/)
			expect(() => note(id(3), id(1), 'x')).toThrow(/FOREIGN KEY/)
			note(id(1), id(3), '𝒜'.repeat(2000))
			note(id(1), id(1), 'me')
			expect(() => note(id(2), id(3), '')).toThrow(/CHECK/)
			expect(() => note(id(2), id(3), 'a'.repeat(2001))).toThrow(/CHECK/)
			expect(() => note(id(1), id(3), 'again')).toThrow(/UNIQUE|PRIMARY KEY/)

			// A follow's end takes its endorsement, and only that one.
			sql.exec('DELETE FROM follows WHERE account_id = ? AND target_account_id = ?', id(1), id(3))
			expect(pins()).toEqual([
				{ account_id: id(1), target_account_id: id(2) },
				{ account_id: id(2), target_account_id: id(3) },
			])
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', id(1))
			expect(pins()).toEqual([{ account_id: id(2), target_account_id: id(3) }])
			expect(sql.exec('SELECT count(*) AS n FROM account_notes').one()).toEqual({ n: 0 })
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('upgrades a Store with 0018_status_pins_and_conversation_mutes: pins go with their status and account, mutes with their account', async () => {
		const at = NAMES.indexOf('0018_status_pins_and_conversation_mutes')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			expect(tableNames(sql)).not.toContain('status_pins')
			const id = (n: number) => String(100000000000000000n + BigInt(n))
			for (const n of [1, 2]) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id(n),
					`https://kopje.test/ap/users/u${n}`,
					`u${n}`
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
					id(n),
					`u${n}@example.com`
				)
			}
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/r', 'r', 'remote.example')",
				id(3)
			)
			for (const [status, author] of [
				[10, 1],
				[11, 1],
				[12, 2],
			] as const) {
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, 'public', '', '2026-10-01T00:00:00.000Z')`,
					id(status),
					`https://kopje.test/ap/o/${status}`,
					id(author)
				)
			}
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0018_status_pins_and_conversation_mutes'],
			})
			const pin = (account: string, status: string) =>
				sql.exec('INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)', account, status)
			const muteThread = (account: string, thread: string) =>
				sql.exec('INSERT INTO conversation_mutes (account_id, thread) VALUES (?, ?)', account, thread)
			pin(id(1), id(10))
			pin(id(1), id(11))
			pin(id(2), id(12))
			expect(() => pin(id(1), id(10))).toThrow(/UNIQUE|PRIMARY KEY/)
			// Only a local account pins or mutes.
			expect(() => pin(id(3), id(12))).toThrow(/FOREIGN KEY/)
			expect(() => muteThread(id(3), 'https://kopje.test/ap/o/10')).toThrow(/FOREIGN KEY/)
			muteThread(id(1), 'https://kopje.test/ap/o/10')
			muteThread(id(2), 'https://kopje.test/ap/o/10')
			expect(() => muteThread(id(1), 'https://kopje.test/ap/o/10')).toThrow(/UNIQUE|PRIMARY KEY/)
			const pins = () => sql.exec('SELECT account_id, status_id FROM status_pins ORDER BY 1, 2').toArray()
			// A pin goes with its status; a mute outlives the statuses of its thread.
			sql.exec('DELETE FROM statuses WHERE id = ?', id(10))
			expect(pins()).toEqual([
				{ account_id: id(1), status_id: id(11) },
				{ account_id: id(2), status_id: id(12) },
			])
			expect(sql.exec('SELECT count(*) AS n FROM conversation_mutes').one()).toEqual({ n: 2 })
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', id(1))
			expect(pins()).toEqual([{ account_id: id(2), status_id: id(12) }])
			expect(sql.exec('SELECT account_id FROM conversation_mutes').toArray()).toEqual([{ account_id: id(2) }])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('upgrades a Store with 0010_markers: a new table whose rows go with their local account', async () => {
		// By name, not position: the files before it are whatever this build ships.
		const at = NAMES.indexOf('0010_markers')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')",
				alice
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				alice
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES ('100000000000000002', 'https://remote.example/users/r', 'r', 'remote.example')"
			)

			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0010_markers'],
			})
			const insert = (account: string, timeline: string, lastReadId: string) =>
				sql.exec(
					"INSERT INTO markers (account_id, timeline, last_read_id, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
					account,
					timeline,
					lastReadId
				)
			insert(alice, 'home', '1')
			insert(alice, 'notifications', '2')
			expect(() => insert(alice, 'home', '3')).toThrow(/UNIQUE constraint failed/)
			expect(() => insert(alice, 'public', '3')).toThrow(/CHECK constraint failed/)
			expect(() => insert(alice, 'home', '')).toThrow(/CHECK constraint failed/)
			expect(() => sql.exec("UPDATE markers SET last_read_id = ? WHERE timeline = 'home'", 'a'.repeat(256))).toThrow(
				/CHECK constraint failed/
			)
			// Only a local account has markers.
			expect(() => insert('100000000000000002', 'home', '1')).toThrow(/FOREIGN KEY constraint failed/)
			expect(sql.exec('SELECT version FROM markers').toArray()).toEqual([{ version: 0 }, { version: 0 }])
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', alice)
			expect(sql.exec('SELECT count(*) AS n FROM markers').one()).toEqual({ n: 0 })
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('upgrades a Store with 0017_notification_groups: stored notifications stay ungrouped, and new ones are indexed by group', async () => {
		const at = NAMES.indexOf('0017_notification_groups')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			const bob = '100000000000000002'
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')",
				alice
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				alice
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/bob', 'bob', 'remote.example')",
				bob
			)
			sql.exec("INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)", alice, bob)

			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0017_notification_groups'],
			})
			expect(sql.exec('SELECT type, group_key FROM notifications').toArray()).toEqual([
				{ type: 'follow', group_key: null },
			])
			sql.exec(
				"INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key) VALUES (?, 'mention', ?, NULL, 'follow-1')",
				alice,
				bob
			)
			const plan = sql
				.exec<{ detail: string }>(
					'EXPLAIN QUERY PLAN SELECT id FROM notifications WHERE account_id = ? AND group_key = ? ORDER BY id DESC',
					alice,
					'follow-1'
				)
				.toArray()
				.map((row) => row.detail)
			expect(plan.join('\n')).toContain('notifications_group')
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', alice)
			expect(sql.exec('SELECT count(*) AS n FROM notifications').one()).toEqual({ n: 0 })
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0017_notification_groups reads each stored notification a bounded number of times, however many there are', async () => {
		const index = NAMES.indexOf('0017_notification_groups')
		const statements = (MIGRATIONS[index]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, index)).upgrade()
				sql.exec(
					"INSERT INTO accounts (id, uri, username) VALUES ('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice')"
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES ('100000000000000001', 'a@example.com', X'00', X'00', 'k')"
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain) SELECT CAST(200000000000000000 + i AS TEXT),
						'https://remote.example/users/u' || i, 'u' || i, 'remote.example' FROM n`,
					count
				)
				sql.exec(
					`INSERT INTO notifications (account_id, type, from_account_id)
					SELECT '100000000000000001', 'follow', id FROM accounts WHERE domain = 'remote.example'`
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// The column is added without a pass, and the partial index's build reads each notification once.
		expect(large - small).toBeLessThanOrEqual(3 * (10_000 - 1000))
	}, 60_000)

	it('upgrades a Store with 0020_notification_policies: stored notifications stay shown, and the new tables go with their accounts and statuses', async () => {
		const at = NAMES.indexOf('0020_notification_policies')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			const bob = '100000000000000002'
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')",
				alice
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				alice
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/bob', 'bob', 'remote.example')",
				bob
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES ('200000000000000001', 'https://remote.example/o/1', ?, 'direct', '', '2026-10-01T00:00:00.000Z')`,
				bob
			)
			sql.exec("INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)", alice, bob)

			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0020_notification_policies'],
			})
			expect(sql.exec('SELECT type, filtered FROM notifications').toArray()).toEqual([{ type: 'follow', filtered: 0 }])
			const plan = sql
				.exec<{ detail: string }>(
					'EXPLAIN QUERY PLAN SELECT id FROM notifications WHERE account_id = ? AND filtered = 0 ORDER BY id DESC',
					alice
				)
				.toArray()
				.map((row) => row.detail)
			expect(plan.join('\n')).toContain('notifications_unfiltered')
			// The policy's defaults, and its choices limited to accept, filter and drop.
			sql.exec('INSERT INTO notification_policies (account_id) VALUES (?)', alice)
			expect(
				sql
					.exec(
						'SELECT for_not_following, for_not_followers, for_new_accounts, for_private_mentions, for_limited_accounts FROM notification_policies'
					)
					.one()
			).toEqual({
				for_not_following: 'accept',
				for_not_followers: 'accept',
				for_new_accounts: 'accept',
				for_private_mentions: 'filter',
				for_limited_accounts: 'filter',
			})
			expect(() => sql.exec("UPDATE notification_policies SET for_new_accounts = 'block'")).toThrow(/CHECK/)
			// Only a local account has a policy, permissions, requests or jobs; a sender may be remote.
			expect(() => sql.exec('INSERT INTO notification_policies (account_id) VALUES (?)', bob)).toThrow(/FOREIGN KEY/)
			sql.exec('INSERT INTO notification_permissions (account_id, from_account_id) VALUES (?, ?)', alice, bob)
			expect(() =>
				sql.exec('INSERT INTO notification_permissions (account_id, from_account_id) VALUES (?, ?)', alice, bob)
			).toThrow(/UNIQUE|PRIMARY KEY/)
			sql.exec(
				"INSERT INTO notification_requests (account_id, from_account_id, last_status_id) VALUES (?, ?, '200000000000000001')",
				alice,
				bob
			)
			expect(() =>
				sql.exec('INSERT INTO notification_requests (account_id, from_account_id) VALUES (?, ?)', alice, bob)
			).toThrow(/UNIQUE/)
			sql.exec(
				"INSERT INTO notification_request_jobs (account_id, from_account_id, kind, cursor) VALUES (?, ?, 'accept', 2)",
				alice,
				bob
			)
			// A request's last status goes to null with its status.
			sql.exec("DELETE FROM statuses WHERE id = '200000000000000001'")
			expect(sql.exec('SELECT last_status_id FROM notification_requests').toArray()).toEqual([{ last_status_id: null }])
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', alice)
			for (const table of [
				'notification_policies',
				'notification_permissions',
				'notification_requests',
				'notification_request_jobs',
			]) {
				expect([table, sql.exec(`SELECT count(*) AS n FROM ${table}`).one()]).toEqual([table, { n: 0 }])
			}
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0020_notification_policies reads each stored notification a bounded number of times, however many there are', async () => {
		const index = NAMES.indexOf('0020_notification_policies')
		const statements = (MIGRATIONS[index]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, index)).upgrade()
				sql.exec(
					"INSERT INTO accounts (id, uri, username) VALUES ('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice')"
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES ('100000000000000001', 'a@example.com', X'00', X'00', 'k')"
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain) SELECT CAST(200000000000000000 + i AS TEXT),
						'https://remote.example/users/u' || i, 'u' || i, 'remote.example' FROM n`,
					count
				)
				sql.exec(
					`INSERT INTO notifications (account_id, type, from_account_id)
					SELECT '100000000000000001', 'follow', id FROM accounts WHERE domain = 'remote.example'`
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// The column is added without a pass, and the partial index's build reads each notification once.
		expect(large - small).toBeLessThanOrEqual(3 * (10_000 - 1000))
	}, 60_000)

	it('upgrades a Store with 0019_tag_normalization: hashtag names as Mastodon normalizes them, merged where they meet', async () => {
		const index = NAMES.indexOf('0019_tag_normalization')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, index)).upgrade()).toMatchObject({ ok: true })
			const [alice, bob] = ['100000000000000001', '100000000000000002']
			for (const [id, name] of [
				[alice, 'alice'],
				[bob, 'bob'],
			] as const) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/' || ?, ?, NULL)",
					id,
					name,
					name
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ? || '@example.com', X'00', X'00', 'k')",
					id,
					name
				)
			}
			const status = (n: number, account: string, visibility: string, minute: number) => {
				const id = String(200000000000000000n + BigInt(n))
				sql.exec(
					'INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, ?, ?)',
					id,
					`https://kopje.test/ap/o/${n}`,
					account,
					visibility,
					`2026-10-01T00:${String(minute).padStart(2, '0')}:00.000Z`
				)
				return id
			}
			const tag = (statusId: string, name: string, isPublic: number) =>
				sql.exec('INSERT INTO status_tags (status_id, name, public) VALUES (?, ?, ?)', statusId, name, isPublic)
			// Names as NFKC and lowercase left them.
			const both = status(1, alice, 'public', 1)
			tag(both, 'café', 1)
			tag(both, 'cafe', 1)
			const accented = status(2, alice, 'unlisted', 2)
			tag(accented, 'café', 0)
			tag(accented, 'i\u0307stanbul', 0)
			tag(accented, '\u0301', 0)
			const hidden = status(3, alice, 'private', 3)
			tag(hidden, 'blåhaj', 0)
			const bobs = status(4, bob, 'public', 4)
			tag(bobs, 'blåhaj', 1)
			tag(bobs, 'cats', 1)
			// alice followed cafe before café; bob followed café first, then cafe, and a name that becomes empty.
			for (const [account, name] of [
				[alice, 'cafe'],
				[bob, 'café'],
				[alice, 'café'],
				[bob, 'cafe'],
				[bob, '\u0301'],
				[alice, 'cats'],
			] as const) {
				sql.exec('INSERT INTO tag_follows (account_id, name) VALUES (?, ?)', account, name)
			}
			// alice featured Café first, then cafe and BLÅHAJ; bob only blahaj, before any status of his had it (counted 0).
			const feature = (id: string, account: string, name: string, display: string) =>
				sql.exec(
					`INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count, last_status_at)
					VALUES (?, ?, ?, ?, 0, NULL)`,
					id,
					account,
					name,
					display
				)
			feature('700000000000000001', alice, 'café', 'Café')
			feature('700000000000000002', alice, 'cafe', 'cafe')
			feature('700000000000000003', alice, 'blåhaj', 'BLÅHAJ')
			feature('700000000000000004', bob, 'blahaj', 'blahaj')

			expect(await kernel(state, MIGRATIONS.slice(0, index + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: [NAMES[index]],
			})
			expect(sql.exec('SELECT status_id, name, public FROM status_tags ORDER BY status_id, name').toArray()).toEqual([
				{ status_id: both, name: 'cafe', public: 1 },
				{ status_id: accented, name: 'cafe', public: 0 },
				{ status_id: accented, name: 'istanbul', public: 0 },
				{ status_id: hidden, name: 'blahaj', public: 0 },
				{ status_id: bobs, name: 'blahaj', public: 1 },
				{ status_id: bobs, name: 'cats', public: 1 },
			])
			expect(sql.exec('SELECT id, account_id, name FROM tag_follows ORDER BY id').toArray()).toEqual([
				{ id: 1, account_id: alice, name: 'cafe' },
				{ id: 2, account_id: bob, name: 'cafe' },
				{ id: 6, account_id: alice, name: 'cats' },
			])
			// The earliest featured hashtag of each name stays, recounted from its account's public and unlisted statuses.
			expect(
				sql
					.exec(
						'SELECT id, account_id, name, display_name, statuses_count, last_status_at FROM featured_tags ORDER BY id'
					)
					.toArray()
			).toEqual([
				{
					id: '700000000000000001',
					account_id: alice,
					name: 'cafe',
					display_name: 'Café',
					statuses_count: 2,
					last_status_at: '2026-10-01T00:02:00.000Z',
				},
				{
					id: '700000000000000003',
					account_id: alice,
					name: 'blahaj',
					display_name: 'BLÅHAJ',
					statuses_count: 0,
					last_status_at: null,
				},
				{
					id: '700000000000000004',
					account_id: bob,
					name: 'blahaj',
					display_name: 'blahaj',
					statuses_count: 1,
					last_status_at: '2026-10-01T00:04:00.000Z',
				},
			])
			// No Remove is queued for the featured hashtag that went, and the helper tables are gone.
			expect(sql.exec('SELECT count(*) AS n FROM outbound_activities').one()).toEqual({ n: 0 })
			expect(tableNames(sql)).not.toEqual(expect.arrayContaining(['tag_renames']))
			expect(tableNames(sql)).not.toEqual(expect.arrayContaining(['tag_folds']))
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0019_tag_normalization names each stored name as normalizeTag names what it was made from', async () => {
		const index = NAMES.indexOf('0019_tag_normalization')
		// Every letter of ASCIIFolding's table, every character of the first blocks (Latin to Thai, combining marks and
		// connectors included), Japanese, fullwidth forms, and every 97th code point beyond, each between two letters;
		// and some whole names. Characters the runtime does not know are left out: the migration judges by Unicode 17.
		const samples = [
			...'ÀÁÂÃÄÅàáâãäåĀāĂăĄąÇçĆćĈĉĊċČčÐðĎďĐđÈÉÊËèéêëĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħÌÍÎÏìíîïĨĩĪīĬĭĮįİıĴĵĶķĸĹĺĻļĽľĿŀŁłÑñŃńŅņŇňŉŊŋÒÓÔÕÖØòóôõöøŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšſŢţŤťŦŧÙÚÛÜùúûüŨũŪūŬŭŮůŰűŲųŴŵÝýÿŶŷŸŹźŻżŽž',
		]
		const ranges = [
			[0x20, 0xfff, 1],
			[0x1e00, 0x206f, 1],
			[0x3000, 0x30ff, 1],
			[0xff00, 0xffef, 1],
			[0x1000, 0x10ffff, 97],
		] as const
		for (const [from, to, step] of ranges) {
			for (let c = from; c <= to; c += step) {
				const char = String.fromCodePoint(c)
				if ((c < 0xd800 || c > 0xdfff) && !/\p{Cn}/u.test(char)) {
					samples.push(`x${char}y`)
				}
			}
		}
		samples.push(
			'İstanbul',
			'Café',
			'BLÅHAJ',
			'ｶﾞ',
			'か゛',
			'ไทย\u0E47',
			'a\u200Cb',
			'e\u0301',
			'Ⅻ',
			'ﬁ',
			'\uFDFA',
			'\u0301'
		)
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, index)).upgrade()).toMatchObject({ ok: true })
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES ('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice', NULL)"
			)
			// One status for each, so no two names meet.
			const stored = samples.map((sample) => sample.normalize('NFKC').toLowerCase())
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, '100000000000000001', 'public',
					'2026-10-01T00:00:00.000Z' FROM n`,
				samples.length
			)
			sql.exec(
				`INSERT INTO status_tags (status_id, name, public)
				SELECT CAST(200000000000000001 + key AS TEXT), value, 1 FROM json_each(?)`,
				JSON.stringify(stored)
			)
			expect(await kernel(state, MIGRATIONS.slice(0, index + 1)).upgrade()).toMatchObject({ ok: true })
			const names = new Map(
				sql
					.exec<{ status_id: string; name: string }>('SELECT status_id, name FROM status_tags')
					.toArray()
					.map((row) => [Number(BigInt(row.status_id) - 200000000000000001n), row.name])
			)
			const mismatches = samples
				.map((sample, i) => ({ sample, migrated: names.get(i) ?? '', normalized: normalizeTag(sample) }))
				.filter(({ migrated, normalized }) => migrated !== normalized)
			expect(mismatches).toEqual([])
			// Not vacuous: names were folded and cut, and one that leaves nothing went.
			expect(names.get(samples.indexOf('Café'))).toBe('cafe')
			expect(names.get(samples.indexOf('İstanbul'))).toBe('istanbul')
			expect(names.has(samples.indexOf('\u0301'))).toBe(false)
		})
	}, 60_000)

	it('0019_tag_normalization counts the visibilities the policy names', () => {
		const migration = MIGRATIONS.find((m) => m.name === '0019_tag_normalization')!
		expect(migration.sql).toContain(`s.visibility IN ${DISTRIBUTABLE_SQL}`)
	})

	it('0019_tag_normalization reads each hashtag row a bounded number of times, however many there are', async () => {
		const index = NAMES.indexOf('0019_tag_normalization')
		const statements = (MIGRATIONS[index]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, index)).upgrade()
				// `count` local accounts, each with a public status tagged café, cafe and cats, follows of café and cafe, and
				// cafe and café featured: every row is renamed or merged.
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain) SELECT CAST(100000000000000000 + i AS TEXT),
						'https://kopje.test/ap/users/u' || i, 'u' || i, NULL FROM n`,
					count
				)
				sql.exec(
					`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
					SELECT id, id || '@example.com', X'00', X'00', 'k' FROM accounts`
				)
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					SELECT CAST(100000000000000000 + CAST(id AS INTEGER) AS TEXT), 'https://kopje.test/ap/o/' || id, id, 'public',
						'2026-10-01T00:00:00.000Z' FROM accounts`
				)
				sql.exec(
					`INSERT INTO status_tags (status_id, name, public)
					SELECT id, 'café', 1 FROM statuses UNION ALL SELECT id, 'cafe', 1 FROM statuses
					UNION ALL SELECT id, 'cats', 1 FROM statuses`
				)
				sql.exec(
					`INSERT INTO tag_follows (account_id, name)
					SELECT id, 'café' FROM accounts UNION ALL SELECT id, 'cafe' FROM accounts`
				)
				sql.exec(
					`INSERT INTO featured_tags (id, account_id, name, display_name)
					SELECT CAST(500000000000000000 + 2 * CAST(id AS INTEGER) - 200000000000000000 AS TEXT), id, 'cafe', 'cafe'
						FROM accounts
					UNION ALL SELECT CAST(500000000000000001 + 2 * CAST(id AS INTEGER) - 200000000000000000 AS TEXT), id, 'café',
						'Café' FROM accounts`
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(
					sql
						.exec(
							`SELECT (SELECT count(*) FROM status_tags WHERE name = 'cafe') AS tagged,
								(SELECT count(*) FROM tag_follows WHERE name = 'cafe') AS followed,
								(SELECT count(*) FROM featured_tags WHERE name = 'cafe' AND statuses_count = 1) AS featured`
						)
						.one()
				).toEqual({ tagged: count, followed: count, featured: count })
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// Per account added: three hashtag rows, two follows and two featured hashtags, each read a few times (the pass
		// that finds the names, the merge, the rename) with lookups by index, and one status walked by the recount.
		const added = 7 * (10_000 - 1000)
		expect(large - small).toBeLessThanOrEqual(10 * added)
	}, 120_000)

	it('0019_tag_normalization merges many spellings of one name for many accounts in linear work', async () => {
		const index = NAMES.indexOf('0019_tag_normalization')
		const statements = (MIGRATIONS[index]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		// `accounts` accounts, each following dogs and then one of `spellings` names that all become cafe (two combining
		// marks, which a hashtag cannot hold, between caf and e), each name also on a status: a merge that looked up every
		// spelling of the new name for each follow would grow with their product.
		const measure = async (accounts: number, spellings: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, index)).upgrade()
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain) SELECT CAST(100000000000000000 + i AS TEXT),
						'https://kopje.test/ap/users/u' || i, 'u' || i, NULL FROM n`,
					accounts
				)
				sql.exec(
					`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
					SELECT id, id || '@example.com', X'00', X'00', 'k' FROM accounts`
				)
				const spelling = (i: string) => `'caf' || char(0x0300 + ${i} % 16) || char(0x0300 + ${i} / 16) || 'e'`
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, '100000000000000001', 'public',
						'2026-10-01T00:00:00.000Z' FROM n`,
					spellings
				)
				sql.exec(
					`INSERT INTO status_tags (status_id, name, public)
					SELECT id, ${spelling('(CAST(id AS INTEGER) - 200000000000000000)')}, 1 FROM statuses`
				)
				sql.exec("INSERT INTO tag_follows (account_id, name) SELECT id, 'dogs' FROM accounts ORDER BY id")
				sql.exec(
					`INSERT INTO tag_follows (account_id, name)
					SELECT id, ${spelling('(CAST(id AS INTEGER) % ?1)')} FROM accounts ORDER BY id`,
					spellings
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(
					sql
						.exec(
							`SELECT (SELECT count(DISTINCT name) FROM status_tags) AS names,
								(SELECT count(*) FROM tag_follows WHERE name = 'cafe') AS followed`
						)
						.one()
				).toEqual({ names: 1, followed: accounts })
				return read
			})
		}
		const small = await measure(400, 16)
		const large = await measure(4000, 160)
		// Per account added: two follows; per spelling added: a status, its hashtag row and the spelling's rename, each
		// read a few times with lookups by index.
		const added = 2 * (4000 - 400) + 3 * (160 - 16)
		expect(large - small).toBeLessThanOrEqual(10 * added)
	}, 120_000)

	it('upgrades a Store with 0011_scheduled_statuses: uploads stay as they were, and scheduled statuses hold theirs and go with their account', async () => {
		const index = NAMES.indexOf('0011_scheduled_statuses')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, index)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice', NULL)",
				alice
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				alice
			)
			sql.exec(
				`INSERT INTO media_attachments (id, account_id, type, url, file_token, gc_at)
				VALUES ('800000000000000001', ?, 'image', 'https://kopje.test/files/t/full', 't', '2026-10-13T00:00:00.000Z')`,
				alice
			)

			expect(await kernel(state, MIGRATIONS.slice(0, index + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: [NAMES[index]],
			})
			expect(sql.exec('SELECT scheduled_status_id, gc_at FROM media_attachments').toArray()).toEqual([
				{ scheduled_status_id: null, gc_at: '2026-10-13T00:00:00.000Z' },
			])
			const schedule = (id: string, at = '2026-10-20T00:00:00.000Z', params = '{}') =>
				sql.exec(
					'INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, ?)',
					id,
					alice,
					at,
					params
				)
			schedule('600000000000000001')
			sql.exec("UPDATE media_attachments SET scheduled_status_id = '600000000000000001', gc_at = NULL")
			// The time in the one form the module writes, params a bounded JSON object, and an upload held or attached.
			expect(() => schedule('600000000000000002', '2026-10-20T00:00:00Z')).toThrow(/CHECK/)
			expect(() => schedule('600000000000000002', '2026-10-20T00:00:00.000Z', '[]')).toThrow(/CHECK/)
			expect(() =>
				schedule('600000000000000002', '2026-10-20T00:00:00.000Z', JSON.stringify({ text: 'x'.repeat(131072) }))
			).toThrow(/CHECK/)
			sql.exec(
				"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES ('200000000000000001', 'https://kopje.test/ap/o/1', ?, 'public', '2026-01-01T00:00:00.000Z')",
				alice
			)
			expect(() => sql.exec("UPDATE media_attachments SET status_id = '200000000000000001'")).toThrow(/CHECK/)
			// Deleting the scheduled status lets the upload go; deleting the account deletes its scheduled statuses.
			sql.exec("DELETE FROM scheduled_statuses WHERE id = '600000000000000001'")
			expect(sql.exec('SELECT scheduled_status_id FROM media_attachments').toArray()).toEqual([
				{ scheduled_status_id: null },
			])
			schedule('600000000000000003')
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', alice)
			expect(sql.exec('SELECT count(*) AS n FROM scheduled_statuses').one()).toEqual({ n: 0 })
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0011_scheduled_statuses reads each stored upload a bounded number of times, however many there are', async () => {
		const index = NAMES.indexOf('0011_scheduled_statuses')
		const statements = (MIGRATIONS[index]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, index)).upgrade()
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES ('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice', NULL)"
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO media_attachments (id, account_id, type, url) SELECT CAST(800000000000000000 + i AS TEXT),
						'100000000000000001', 'image', 'https://kopje.test/files/' || i FROM n`,
					count
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// The column's check and the partial index's build each read an upload once, nothing per pair of rows.
		expect(large - small).toBeLessThanOrEqual(5 * (10_000 - 1000))
	}, 60_000)

	it('upgrades a Store with 0013_polls: new tables whose rows go with their status and account, and edits keep their history', async () => {
		const index = NAMES.indexOf('0013_polls')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, index)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			const remote = '100000000000000002'
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice', NULL)",
				alice
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/r', 'r', 'remote.example')",
				remote
			)
			sql.exec(
				"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES ('200000000000000001', 'https://kopje.test/ap/o/1', ?, 'public', '2026-01-01T00:00:00.000Z')",
				alice
			)
			sql.exec(
				"INSERT INTO status_edits (status_id, content, created_at) VALUES ('200000000000000001', 'old', '2026-01-01T00:00:00.000Z')"
			)

			expect(await kernel(state, MIGRATIONS.slice(0, index + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: [NAMES[index]],
			})
			expect(sql.exec('SELECT poll_options FROM status_edits').toArray()).toEqual([{ poll_options: null }])
			const poll = (options: string, tallies: string, expiresAt: string | null = '2026-01-02T00:00:00.000Z') =>
				sql.exec(
					"INSERT INTO polls (status_id, options, tallies, expires_at) VALUES ('200000000000000001', ?, ?, ?)",
					options,
					tallies,
					expiresAt
				)
			// As many counts as choices, at least one choice and at most 100, and a time in the one form the Store writes.
			expect(() => poll('["a","b"]', '[0]')).toThrow(/CHECK/)
			expect(() => poll('[]', '[]')).toThrow(/CHECK/)
			expect(() => poll(JSON.stringify(Array.from({ length: 101 }, String)), '[]')).toThrow(/CHECK/)
			expect(() => poll('["a","b"]', '[0,0]', '2026-01-02T00:00:00Z')).toThrow(/CHECK/)
			poll('["a","b"]', '[0,0]')
			const vote = (account: string, choice: number) =>
				sql.exec(
					"INSERT INTO poll_votes (poll_id, account_id, choice) VALUES ('200000000000000001', ?, ?)",
					account,
					choice
				)
			vote(remote, 0)
			expect(() => vote(remote, 0)).toThrow(/UNIQUE/)
			vote(alice, 1)
			expect(() => sql.exec("UPDATE status_edits SET poll_options = '{}'")).toThrow(/CHECK/)
			// A vote goes with its account; the poll and its votes go with the status.
			sql.exec('DELETE FROM accounts WHERE id = ?', remote)
			expect(sql.exec('SELECT account_id FROM poll_votes').toArray()).toEqual([{ account_id: alice }])
			sql.exec("DELETE FROM statuses WHERE id = '200000000000000001'")
			expect(sql.exec('SELECT (SELECT count(*) FROM polls) + (SELECT count(*) FROM poll_votes) AS n').one()).toEqual({
				n: 0,
			})
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('upgrades a Store with 0016_tags: followed and featured hashtags of local accounts, which go with the account, and whether each actor was sent with its featured collections', async () => {
		const index = NAMES.indexOf('0016_tags')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, index)).upgrade()).toMatchObject({ ok: true })
			const alice = '100000000000000001'
			const remote = '100000000000000002'
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice', NULL)",
				alice
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				alice
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/r', 'r', 'remote.example')",
				remote
			)
			expect(await kernel(state, MIGRATIONS.slice(0, index + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: [NAMES[index]],
			})
			const followTag = (account: string, name: string) =>
				sql.exec('INSERT INTO tag_follows (account_id, name) VALUES (?, ?)', account, name)
			const featureTag = (id: string, account: string, name: string) =>
				sql.exec(
					'INSERT INTO featured_tags (id, account_id, name, display_name) VALUES (?, ?, ?, ?)',
					id,
					account,
					name,
					name
				)
			// No actor has been sent with its featured collections yet.
			expect(sql.exec('SELECT featured_announced FROM local_accounts').toArray()).toEqual([{ featured_announced: 0 }])
			expect(() => sql.exec('UPDATE local_accounts SET featured_announced = 2')).toThrow(/CHECK/)
			followTag(alice, 'cats')
			expect(() => followTag(alice, 'cats')).toThrow(/UNIQUE/)
			expect(() => followTag(alice, '')).toThrow(/CHECK/)
			// Only a local account follows or features a hashtag.
			expect(() => followTag(remote, 'cats')).toThrow(/FOREIGN KEY/)
			featureTag('700000000000000001', alice, 'cats')
			expect(() => featureTag('700000000000000002', alice, 'cats')).toThrow(/UNIQUE/)
			expect(() => featureTag('7', alice, 'dogs')).toThrow(/CHECK/)
			expect(() => featureTag('700000000000000003', remote, 'dogs')).toThrow(/FOREIGN KEY/)
			expect(() => sql.exec('UPDATE featured_tags SET statuses_count = -1')).toThrow(/CHECK/)
			// Both go with the account.
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', alice)
			expect(
				sql.exec('SELECT (SELECT count(*) FROM tag_follows) + (SELECT count(*) FROM featured_tags) AS n').one()
			).toEqual({ n: 0 })
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})
	it('upgrades a Store with 0015_media_shown: media only earlier versions of one status name goes back to it, unshown', async () => {
		const index = NAMES.indexOf('0015_media_shown')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, index)).upgrade()).toMatchObject({ ok: true })
			const [alice, bob] = ['100000000000000001', '100000000000000002']
			for (const [id, name] of [
				[alice, 'alice'],
				[bob, 'bob'],
			] as const) {
				sql.exec(
					`INSERT INTO accounts (id, uri, username, domain, avatar_url) VALUES (?, ?, ?, NULL, ?)`,
					id,
					`https://kopje.test/ap/users/${name}`,
					name,
					`https://kopje.test/media/${name}-avatar/full.png`
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
					id,
					`${name}@example.com`
				)
			}
			const [edited, other] = ['200000000000000001', '200000000000000002']
			for (const id of [edited, other]) {
				sql.exec(
					"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', '2026-01-01T00:00:00.000Z')",
					id,
					`https://kopje.test/ap/o/${id}`,
					alice
				)
			}
			const later = (ms: number) => new Date(Date.now() + ms).toISOString()
			const HOUR = 60 * 60 * 1000
			// id: [account, status_id, gc_at, token, url]
			const rows: Record<string, [string, string | null, string | null, string | null, string]> = {
				// Shown now; kept for good by the cutover; detached by an edit a day ago, or an hour and a half before its
				// sweep, or half an hour before it; doomed.
				'800000000000000001': [alice, edited, null, 't1', 'https://kopje.test/media/t1/full.png'],
				'800000000000000002': [alice, null, null, 't2', 'https://kopje.test/media/t2/full.png'],
				'800000000000000003': [alice, null, later(23 * HOUR), 't3', 'https://kopje.test/media/t3/full.png'],
				'800000000000000004': [alice, null, later(HOUR / 2), 't4', 'https://kopje.test/media/t4/full.png'],
				'800000000000000005': [alice, null, '1970-01-01T00:00:00.000Z', 't5', 'https://kopje.test/media/t5/full.png'],
				// Named by earlier versions of two statuses; named by none; alice's avatar; bob's; a remote file.
				'800000000000000006': [alice, null, null, 't6', 'https://kopje.test/media/t6/full.png'],
				'800000000000000007': [alice, null, null, 't7', 'https://kopje.test/media/t7/full.png'],
				'800000000000000008': [alice, null, null, 'alice-avatar', 'https://kopje.test/media/alice-avatar/full.png'],
				'800000000000000009': [bob, null, null, 't9', 'https://kopje.test/media/t9/full.png'],
				'800000000000000010': [alice, null, null, null, 'https://remote.example/a.png'],
			}
			for (const [id, [account, status, gcAt, token, url]] of Object.entries(rows)) {
				sql.exec(
					'INSERT INTO media_attachments (id, account_id, status_id, type, url, file_token, gc_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
					id,
					account,
					status,
					'image',
					url,
					token,
					gcAt
				)
			}
			const named = (ids: string[]) => JSON.stringify(ids.map((id) => ({ id, type: 'image', url: rows[id]?.[4] })))
			const edit = (status: string, media: string) =>
				sql.exec(
					"INSERT INTO status_edits (status_id, content, media_json, created_at) VALUES (?, 'old', ?, '2026-01-01T00:00:00.000Z')",
					status,
					media
				)
			edit(edited, named(['800000000000000001', '800000000000000002', '800000000000000003', '800000000000000004']))
			edit(edited, named(['800000000000000005', '800000000000000006', '800000000000000008', '800000000000000009']))
			edit(edited, named(['800000000000000010']))
			edit(edited, '{"id":"800000000000000007"}')
			edit(other, named(['800000000000000006']))

			expect(await kernel(state, MIGRATIONS.slice(0, index + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: [NAMES[index]],
			})
			const after = sql
				.exec<{ id: string; status_id: string | null; shown: number; gc_at: string | null }>(
					'SELECT id, status_id, shown, gc_at FROM media_attachments ORDER BY id'
				)
				.toArray()
			const linked = (id: string) => ({ id, status_id: edited, shown: 0, gc_at: null })
			const unchanged = (id: string) => ({ id, status_id: rows[id]?.[1], shown: 1, gc_at: rows[id]?.[2] })
			expect(after).toEqual([
				unchanged('800000000000000001'),
				linked('800000000000000002'),
				linked('800000000000000003'),
				...[4, 5, 6, 7, 8, 9, 10].map((n) => unchanged(String(800000000000000000n + BigInt(n)))),
			])
			// Unshown media has a status; the index seeks what statuses show.
			expect(() => sql.exec("UPDATE media_attachments SET shown = 0 WHERE id = '800000000000000007'")).toThrow(/CHECK/)
			expect(() => sql.exec("UPDATE media_attachments SET shown = 2 WHERE id = '800000000000000001'")).toThrow(/CHECK/)
			expect(
				sql
					.exec<{ name: string }>("SELECT name FROM pragma_index_info('media_attachments_status') ORDER BY seqno")
					.toArray()
			).toEqual([{ name: 'status_id' }, { name: 'shown' }, { name: 'position' }])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('0015_media_shown reads each upload and each edit a bounded number of times, however many there are', async () => {
		const index = NAMES.indexOf('0015_media_shown')
		const statements = (MIGRATIONS[index]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (count: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, index)).upgrade()
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES ('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice', NULL)"
				)
				// Each status shows one upload, and its earlier version names another, kept unattached.
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, '100000000000000001', 'public',
						'2026-01-01T00:00:00.000Z' FROM n`,
					count
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO media_attachments (id, account_id, status_id, type, url, file_token)
					SELECT CAST(800000000000000000 + i * 2 + k AS TEXT), '100000000000000001',
						CASE k WHEN 0 THEN CAST(200000000000000000 + i AS TEXT) END, 'image', 'https://kopje.test/media/' || i || '-' || k,
						i || '-' || k
					FROM n, (SELECT 0 AS k UNION ALL SELECT 1)`,
					count
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO status_edits (status_id, content, media_json, created_at)
					SELECT CAST(200000000000000000 + i AS TEXT), 'old',
						json_array(json_object('id', CAST(800000000000000000 + i * 2 AS TEXT)),
							json_object('id', CAST(800000000000000000 + i * 2 + 1 AS TEXT))),
						'2026-01-01T00:00:00.000Z' FROM n`,
					count
				)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(sql.exec('SELECT count(*) AS n FROM media_attachments WHERE shown = 0').one()).toEqual({ n: count })
				return read
			})
		}
		const small = await measure(1000)
		const large = await measure(10_000)
		// The column's check and the index build read each upload once, the link each edit's media once and each named
		// upload, its status and its account once: nothing per pair of rows.
		expect(large - small).toBeLessThanOrEqual(20 * (10_000 - 1000))
	}, 60_000)

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

describe('0021_directory', () => {
	const NAME = '0021_directory'
	const id = (n: number) => String(100000000000000000n + BigInt(n))

	// The file's statements, a trigger's body kept whole.
	function statements(): string[] {
		const out: string[] = []
		let current = ''
		for (const line of (MIGRATIONS.find((m) => m.name === NAME)?.sql ?? '').split('\n')) {
			if (line.startsWith('--') || line.trim() === '') {
				continue
			}
			current += `${line}\n`
			if (/^CREATE TRIGGER/.test(current) ? /^END;$/.test(line) : line.endsWith(';')) {
				out.push(current)
				current = ''
			}
		}
		return out
	}

	// `accounts` remote accounts, each with `statuses` statuses: public, then private, unlisted and direct in turn, the
	// newest direct when there are four or more; and one account without statuses.
	function seed(sql: SqlStorage, accounts: number, statuses: number): void {
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(100000000000000000 + i AS TEXT), 'https://remote.example/users/u' || i, 'u' || i, 'remote.example'
			FROM n`,
			accounts + 1
		)
		sql.exec(
			`WITH RECURSIVE a(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM a WHERE i < ?1),
				n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(200000000000000000 + a.i * 1000 + n.i AS TEXT), 'https://remote.example/o/' || a.i || '/' || n.i,
				CAST(100000000000000000 + a.i AS TEXT),
				CASE WHEN n.i = 0 THEN 'public' WHEN n.i % 3 = 1 THEN 'private' WHEN n.i % 3 = 2 THEN 'unlisted' ELSE 'direct' END,
				'2026-10-01T00:00:00.000Z'
			FROM a CROSS JOIN n`,
			accounts,
			statuses
		)
	}

	it(`upgrades a Store with ${NAME}: each account's newest public, unlisted or private status, kept by triggers`, async () => {
		const at = NAMES.indexOf(NAME)
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			for (const n of [1, 2, 3]) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'remote.example')",
					id(n),
					`https://remote.example/users/u${n}`,
					`u${n}`
				)
			}
			const status = (n: number, author: number, visibility: string) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					VALUES (?, ?, ?, ?, '2026-10-01T00:00:00.000Z')`,
					id(1000 + n),
					`https://remote.example/o/${n}`,
					id(author),
					visibility
				)
			status(1, 1, 'public')
			status(2, 1, 'unlisted')
			status(3, 1, 'direct')
			status(4, 2, 'limited')
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			const last = () =>
				sql
					.exec<{ id: string; last: string | null }>('SELECT id, last_status_id AS last FROM accounts ORDER BY id')
					.toArray()
			expect(last()).toEqual([
				{ id: id(1), last: id(1002) },
				{ id: id(2), last: null },
				{ id: id(3), last: null },
			])
			// A newer status raises it, a direct one does not; an older one stored late does not lower it.
			status(5, 2, 'private')
			status(6, 2, 'direct')
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				VALUES (?, 'https://remote.example/o/old', ?, 'public', '2026-10-01T00:00:00.000Z')`,
				id(900),
				id(2)
			)
			expect(last()[1]).toEqual({ id: id(2), last: id(1005) })
			// Deleting or hiding the newest moves it back; deleting an older one changes nothing.
			sql.exec('DELETE FROM statuses WHERE id = ?', id(1002))
			expect(last()[0]).toEqual({ id: id(1), last: id(1001) })
			sql.exec("UPDATE statuses SET visibility = 'direct' WHERE id = ?", id(1005))
			expect(last()[1]).toEqual({ id: id(2), last: id(900) })
			sql.exec('DELETE FROM statuses WHERE id = ?', id(900))
			expect(last()[1]).toEqual({ id: id(2), last: null })
			status(7, 3, 'public')
			sql.exec('DELETE FROM statuses WHERE id = ?', id(1003))
			expect(last()[0]).toEqual({ id: id(1), last: id(1001) })
			// A status moved to another account (none does; the trigger covers it) leaves the first and joins the second.
			sql.exec('UPDATE statuses SET account_id = ? WHERE id = ?', id(1), id(1007))
			expect(last()).toEqual([
				{ id: id(1), last: id(1007) },
				{ id: id(2), last: null },
				{ id: id(3), last: null },
			])
		})
	})

	it('counts the visibilities the policy names, in the order of statuses_feed', () => {
		const migration = MIGRATIONS.find((m) => m.name === NAME)!
		expect(migration.sql).toContain(`s.visibility IN ${REACHES_FOLLOWERS_SQL}`)
		expect(migration.sql).toContain(`NEW.visibility IN ${REACHES_FOLLOWERS_SQL}`)
		expect(migration.sql).toContain(`OLD.visibility IN ${REACHES_FOLLOWERS_SQL}`)
		expect(migration.sql).not.toMatch(/visibility IN \((?!'public', 'unlisted', 'private'\))/)
	})

	it('reads each account a bounded number of times, however many statuses each has', async () => {
		const at = NAMES.indexOf(NAME)
		const measure = async (accounts: number, statusesEach: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, accounts, statusesEach)
				let read = 0
				for (const statement of statements()) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				// Not vacuous: the newest status that is not direct is each account's, and the last account has none.
				const wrong = sql
					.exec<{ n: number }>(
						`SELECT count(*) AS n FROM accounts a WHERE last_status_id IS NOT (SELECT max(s.id) FROM statuses s
							WHERE s.account_id = a.id AND s.visibility <> 'direct')`
					)
					.one().n
				expect(wrong).toBe(0)
				expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM accounts WHERE last_status_id IS NULL').one().n).toBe(
					1
				)
				return read
			})
		}
		const few = await measure(1000, 4)
		const long = await measure(1000, 40)
		const many = await measure(10_000, 4)
		// Each account: its row for the column, one seek of its newest status, and a pass per index.
		expect(long).toBeLessThanOrEqual(few + 10)
		expect(many - few).toBeLessThanOrEqual(10 * (10_000 - 1000))
	}, 120_000)
})
