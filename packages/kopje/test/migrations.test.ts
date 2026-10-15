import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { BUILD, freshStore, rejectionOf, tableNames, testKernel as kernel } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { REQUIRES_MENTION_SQL } from '../src/domain/audience'
import { CONVERSATIONS_BACKFILL } from '../src/domain/conversation-rows'
import { readOperation, sessionOperation, writeOperation } from '../src/domain/operation'
import { StoreUnavailableError, toStoreUnavailable } from '../src/platform/store-errors'

// The shipped migrations, in order; test-only files are named after them (9999_*).
const NAMES = MIGRATIONS.map((m) => m.name)
const LATEST = NAMES.at(-1)

const SCHEMA_TABLES = [
	'accounts',
	'blocks',
	'bookmarks',
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
