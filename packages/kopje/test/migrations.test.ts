import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { NOW } from './app-helpers'
import { ACCOUNT_EMOJIS_FULL, accountAtCap, padded, STATUS_EMOJIS_FULL, statusAtCap } from './emoji-fixtures'
import { BUILD, freshStore, migratedStore, rejectionOf, tableNames, testKernel as kernel } from './helpers'
import { BREAK_WITNESSES } from './migration-fixtures'
import {
	BOUNDED,
	columnsSql,
	inserter,
	JSON_BOUNDED,
	movedCountSql,
	seedBounded,
	storedSql,
	TABLES,
	textSql,
	valuesOf,
} from './stored-bounds-fixtures'
import { MIGRATIONS } from '../src/db/migrations'
import { Db } from '../src/db/sql'
import { DISTRIBUTABLE_SQL, REACHES_FOLLOWERS_SQL, REQUIRES_MENTION_SQL } from '../src/domain/audience'
import { CONVERSATIONS_BACKFILL } from '../src/domain/conversation-rows'
import { MODERATION_LOG_KEEP } from '../src/domain/moderation-log'
import { readOperation, sessionOperation, writeOperation } from '../src/domain/operation'
import { storeRemoteStatus } from '../src/domain/remote-statuses'
import { actOnReport, fileRemoteReports, getAdminReport } from '../src/domain/reports'
import { moderationRound } from '../src/domain/suspension'
import { normalizeTag } from '../src/domain/tag-name'
import { parseRemoteStatus } from '../src/federation/remote-status'
import {
	EMOJI_EDGE_LIMIT,
	EMOJI_IMAGE_LIMIT,
	EMOJI_INPUT_TYPES,
	EMOJI_PREVIEW_LIMIT,
	EMOJI_SERVED_TYPES,
} from '../src/platform/emoji-image'
import { ACTIVITY_ID_LIMIT, withinIdentityBound } from '../src/platform/identity-bounds'
import { StoreUnavailableError, toStoreUnavailable } from '../src/platform/store-errors'
import {
	ANNOUNCEMENT_TEXT_BYTES,
	EMOJI_CATEGORY_BYTES,
	EMOJI_CATEGORY_LENGTH,
	emojiBoundsMigrationSql,
	INSTANCE_SETTING_BOUNDS,
	INSTANCE_SETTING_NAMES,
	instanceBoundsMigrationSql,
	type InstanceSettingName,
	LOCAL_EMOJI_SHORTCODE,
	MAX_ANNOUNCEMENTS,
	MAX_ENABLED_EMOJIS,
	MAX_LIVE_ANNOUNCEMENTS,
	MAX_REACTION_NAMES,
	MAX_TREND_REVIEWS,
	MAX_TREND_STATUSES,
	MAX_TREND_TAGS,
	profileBoundsMigrationSql,
	REACTION_NAME_BYTES,
	storedBoundsMigrationSql,
	storedInstanceSetting,
	storedSetting,
	TREND_ALLOWED_ROWS,
	TREND_REVIEW_POOL,
	TREND_SCORE_MAX,
	TREND_SETTING_BOUNDS,
	TREND_STATUSES_PER_AUTHOR,
	trendTagNameCheckSql,
} from '../src/platform/stored-bounds'

// The shipped migrations, in order; test-only files are named after them (9999_*).
const NAMES = MIGRATIONS.map((m) => m.name)

// A generated migration: a header of comment lines, a blank line, then exactly the generator's output.
function expectGenerated(at: number, generated: string): void {
	const sql = MIGRATIONS[at]?.sql ?? ''
	const end = sql.indexOf('\n\n')
	expect(
		sql
			.slice(0, end)
			.split('\n')
			.every((line) => line.startsWith('--'))
	).toBe(true)
	expect(sql.slice(end + 2)).toBe(generated)
}
const LATEST = NAMES.at(-1)

const SCHEMA_TABLES = [
	'account_notes',
	'account_pins',
	'accounts',
	'admin_actions',
	'announcement_dismissals',
	'announcement_reactions',
	'announcements',
	'blocks',
	'bookmarks',
	'collection_syncs',
	'conversation_mutes',
	'conversation_statuses',
	'conversations',
	'custom_emojis',
	'deliveries',
	'domain_block_cleanups',
	'domain_blocks',
	'favourite_likes',
	'favourites',
	'fedify_kv',
	'follow_recommendation_mutes',
	'follows',
	'inbound_jobs',
	'inbound_retractions',
	'inbound_spool',
	'instance_domain_blocks',
	'instance_settings',
	'list_accounts',
	'lists',
	'local_accounts',
	'markers',
	'media_attachments',
	'moderation_jobs',
	'moderation_reach',
	'mutes',
	'notification_clears',
	'notification_dismissals',
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
	'quote_revocations',
	'quotes',
	'remote_keys',
	'remote_moderation_jobs',
	'reports',
	'scheduled_statuses',
	'status_edits',
	'status_pins',
	'status_mentions',
	'status_tags',
	'statuses',
	'stream_cursor',
	'stream_delete_viewers',
	'stream_events',
	'stream_subscriptions',
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

	it('upgrades a Store with 0022_reports: a report goes with its reporter and its account, not with a status', async () => {
		const at = NAMES.indexOf('0022_reports')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			expect(tableNames(sql)).not.toContain('reports')
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
			for (const n of [3, 4]) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'remote.example')",
					id(n),
					`https://remote.example/users/r${n}`,
					`r${n}`
				)
			}
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES (?, 'https://remote.example/objects/10', ?, 'public', '', '2026-10-01T00:00:00.000Z')`,
				id(10),
				id(3)
			)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0022_reports'],
			})
			let n = 0
			const report = (reporter: string, target: string, columns: Record<string, SqlStorageValue> = {}) =>
				sql.exec(
					`INSERT INTO reports (account_id, target_account_id, uri, created_at${Object.keys(columns)
						.map((c) => `, ${c}`)
						.join('')})
					VALUES (?, ?, ?, '2026-10-12T00:00:00.000Z'${Object.keys(columns)
						.map(() => ', ?')
						.join('')})`,
					reporter,
					target,
					`https://kopje.test/actor#reports/${++n}`,
					...Object.values(columns)
				)
			report(id(1), id(3), { status_ids: JSON.stringify([id(10)]) })
			report(id(1), id(4))
			report(id(2), id(3), { category: 'violation', rule_ids: '["1"]' })
			expect(
				sql
					.exec(
						'SELECT status_ids, comment, category, rule_ids, forwarded FROM reports WHERE account_id = ? AND target_account_id = ?',
						id(1),
						id(4)
					)
					.one()
			).toEqual({
				status_ids: '[]',
				comment: '',
				category: 'other',
				rule_ids: null,
				forwarded: 0,
			})
			// Only a local account reports, in Mastodon's categories, with arrays of ids and a Flag id of its own.
			expect(() => report(id(3), id(4))).toThrow(/FOREIGN KEY/)
			expect(() => report(id(1), id(3), { category: 'rude' })).toThrow(/CHECK/)
			expect(() => report(id(1), id(3), { status_ids: '{}' })).toThrow(/CHECK/)
			expect(() => report(id(1), id(3), { rule_ids: '"1"' })).toThrow(/CHECK/)
			expect(() =>
				sql.exec(
					"INSERT INTO reports (account_id, target_account_id, uri, created_at) VALUES (?, ?, 'https://kopje.test/actor#reports/1', '')",
					id(1),
					id(3)
				)
			).toThrow(/UNIQUE/)
			const reports = () =>
				sql.exec('SELECT account_id, target_account_id, status_ids FROM reports ORDER BY id').toArray()
			// A deleted status stays named; the reported account's delete and the reporter's take their reports.
			sql.exec('DELETE FROM statuses WHERE id = ?', id(10))
			expect(reports()).toHaveLength(3)
			sql.exec('DELETE FROM accounts WHERE id = ?', id(4))
			expect(reports()).toEqual([
				{ account_id: id(1), target_account_id: id(3), status_ids: JSON.stringify([id(10)]) },
				{ account_id: id(2), target_account_id: id(3), status_ids: '[]' },
			])
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', id(1))
			expect(reports()).toEqual([{ account_id: id(2), target_account_id: id(3), status_ids: '[]' }])
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
			const logs: Record<string, unknown>[] = []
			const fresh = kernel(state, EXTRA, { log: (entry) => logs.push(entry) })
			expect(await fresh.health(BUILD)).toMatchObject({ schema: { status: 'current' }, readonly: true, hold: null })
			expect(await fresh.execute(BUILD, countSettings, undefined)).toBe(0)
			await expect(fresh.execute(BUILD, putSetting, 'domain')).rejects.toThrow('kopje-maintenance: upgrade-in-progress')
			expect(await state.storage.getAlarm()).not.toBeNull()

			// The alarm re-runs verification only, over the whole Store, then leaves readonly.
			expect(await fresh.upgrade()).toMatchObject({ ok: true, applied: [] })
			expect(logs).toContainEqual(
				expect.objectContaining({ event: 'kopje.store.upgrade.start', foreignKeyCheck: 'store' })
			)
			await fresh.execute(BUILD, putSetting, 'domain')
			expect(await kernel(state, EXTRA).health(BUILD)).toMatchObject({ readonly: false })
		})
	})

	// A reference no key serves, outside anything the files below touch: only a whole-Store check finds it.
	const seedMismatch = (sql: SqlStorage) =>
		sql.exec('CREATE TABLE fk_elsewhere (name TEXT REFERENCES accounts (display_name))')
	const declared = (name: string, sql: string) => ({ name, sql, foreignKeys: 'unchanged' as const })
	const DECLARED_EXTRA = [...MIGRATIONS, declared('9999_extra', 'ALTER TABLE accounts ADD COLUMN extra INTEGER;')]
	const startLog = (logs: Record<string, unknown>[]) => logs.find((e) => e.event === 'kopje.store.upgrade.start')

	it('skips the whole-Store foreign-key check on a fresh upgrade whose files are all declared unchanged', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS).upgrade()
			seedMismatch(sql)
			const logs: Record<string, unknown>[] = []

			expect(await kernel(state, DECLARED_EXTRA, { log: (e) => logs.push(e) }).upgrade()).toMatchObject({
				ok: true,
				applied: ['9999_extra'],
			})
			// The mismatch the files did not make is still there: the upgrade did not scan the Store.
			expect(() => sql.exec('PRAGMA foreign_key_check').toArray()).toThrow(/foreign key mismatch/)
			expect(startLog(logs)).toMatchObject({ foreignKeyCheck: 'skipped' })
			expect(await kernel(state, DECLARED_EXTRA).health(BUILD)).toMatchObject({ readonly: false })
		})
	})

	it.each([
		[
			'an undeclared file',
			[...MIGRATIONS, { name: '9999_extra', sql: 'ALTER TABLE accounts ADD COLUMN extra INTEGER;' }],
		],
		[
			'a declared file followed by an undeclared one',
			[...DECLARED_EXTRA, { name: '9999_more', sql: 'ALTER TABLE accounts ADD COLUMN more INTEGER;' }],
		],
	])('checks the whole Store on a fresh upgrade with %s', async (_label, migrations) => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await kernel(state, MIGRATIONS).upgrade()
			seedMismatch(state.storage.sql)
			const logs: Record<string, unknown>[] = []

			const result = await kernel(state, migrations, { log: (e) => logs.push(e) }).upgrade()
			expect(result).toMatchObject({
				ok: false,
				reason: 'verify-failed',
				detail: expect.stringMatching(/foreign key mismatch/),
			})
			expect(startLog(logs)).toMatchObject({ foreignKeyCheck: 'store' })
			expect(await kernel(state, migrations).health(BUILD)).toMatchObject({ readonly: true, hold: 'verify-failed' })
		})
	})

	it('checks the whole Store on a marker-bearing retry of declared files', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await kernel(state, MIGRATIONS).upgrade()
			seedMismatch(state.storage.sql)
			expect(await kernel(state, DECLARED_EXTRA, { inject: failAt('apply') }).upgrade()).toMatchObject({
				ok: false,
				reason: 'upgrade-failed',
			})
			expect(bookkeeping(state.storage.sql).map((m) => m.name)).toEqual(NAMES)

			expect(await kernel(state, DECLARED_EXTRA).retryUpgrade(BUILD)).toMatchObject({
				ok: false,
				reason: 'verify-failed',
				detail: expect.stringMatching(/foreign key mismatch/),
			})
			expect(bookkeeping(state.storage.sql).map((m) => m.name)).toEqual([...NAMES, '9999_extra'])
		})
	})

	it('checks the whole Store when verification alone re-runs after declared files', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await kernel(state, MIGRATIONS).upgrade()
			const failing = kernel(state, DECLARED_EXTRA, {
				inject: (phase) => {
					failAt('verify')(phase)
					failAt('hold')(phase)
				},
			})
			expect(await failing.upgrade()).toMatchObject({ ok: false, reason: 'verify-failed' })
			seedMismatch(state.storage.sql)

			// Nothing is pending, and the marker means this run cannot vouch for the files applied before it.
			expect(await kernel(state, DECLARED_EXTRA).upgrade()).toMatchObject({
				ok: false,
				reason: 'verify-failed',
				detail: expect.stringMatching(/foreign key mismatch/),
			})
		})
	})

	it("checks the whole Store when a new build resumes an older build's partial range of declared files", async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			await kernel(state, MIGRATIONS).upgrade()
			const range = [
				...MIGRATIONS,
				declared('9999_a', 'ALTER TABLE accounts ADD COLUMN a INTEGER;'),
				declared('9999_b', 'ALTER TABLE accounts ADD COLUMN b INTEGER;'),
			]
			let applies = 0
			const secondApply = (phase: string) => {
				if (phase === 'apply' && ++applies === 2) {
					throw new Error('injected apply failure')
				}
			}
			expect(await kernel(state, range, { build: 'old', inject: secondApply }).upgrade()).toMatchObject({
				ok: false,
				reason: 'upgrade-failed',
			})
			expect(bookkeeping(state.storage.sql).map((m) => m.name)).toEqual([...NAMES, '9999_a'])
			seedMismatch(state.storage.sql)
			const logs: Record<string, unknown>[] = []

			// The new build clears the older build's hold, keeps its marker and applies only 9999_b.
			expect(await kernel(state, range, { build: 'next', log: (e) => logs.push(e) }).upgrade()).toMatchObject({
				ok: false,
				reason: 'verify-failed',
				detail: expect.stringMatching(/foreign key mismatch/),
			})
			expect(startLog(logs)).toMatchObject({ pending: ['9999_b'], foreignKeyCheck: 'store' })
		})
	})

	it.each(BREAK_WITNESSES)('refuses $label', async ({ fixture, breaking, detail }) => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const fixed = [...MIGRATIONS, { name: '9999_a_fixture', sql: fixture }]
			expect(await kernel(state, fixed).upgrade()).toMatchObject({ ok: true })
			const broken = [...fixed, { name: '9999_b_break', sql: breaking }]

			expect(await kernel(state, broken).upgrade()).toMatchObject({
				ok: false,
				reason: 'verify-failed',
				detail: expect.stringMatching(detail),
			})
			expect(bookkeeping(state.storage.sql).map((m) => m.name)).toEqual([...NAMES, '9999_a_fixture', '9999_b_break'])
			expect(await kernel(state, broken).health(BUILD)).toMatchObject({ readonly: true, hold: 'verify-failed' })
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

describe('0023_notification_clears', () => {
	it('adds empty tables of clears and dismissals that go with their local account, and leaves stored notifications shown', async () => {
		const at = NAMES.indexOf('0023_notification_clears')
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
				"INSERT INTO notifications (account_id, type, from_account_id, group_key) VALUES (?, 'follow', ?, 'follow-1')",
				alice,
				bob
			)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0023_notification_clears'],
			})
			for (const table of ['notification_clears', 'notification_dismissals']) {
				expect([table, sql.exec(`SELECT count(*) AS n FROM ${table}`).one()]).toEqual([table, { n: 0 }])
			}
			expect(sql.exec('SELECT type FROM notifications').toArray()).toEqual([{ type: 'follow' }])
			// Only a local account clears or dismisses, one clear each and one dismissal per group.
			expect(() => sql.exec('INSERT INTO notification_clears (account_id, max_id) VALUES (?, 1)', bob)).toThrow(
				/FOREIGN KEY/
			)
			sql.exec('INSERT INTO notification_clears (account_id, max_id) VALUES (?, 1)', alice)
			expect(() => sql.exec('INSERT INTO notification_clears (account_id, max_id) VALUES (?, 2)', alice)).toThrow(
				/UNIQUE|PRIMARY KEY/
			)
			sql.exec("INSERT INTO notification_dismissals (account_id, group_key, max_id) VALUES (?, 'follow-1', 1)", alice)
			expect(() =>
				sql.exec("INSERT INTO notification_dismissals (account_id, group_key, max_id) VALUES (?, 'follow-1', 2)", alice)
			).toThrow(/UNIQUE|PRIMARY KEY/)
			sql.exec('DELETE FROM notifications')
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', alice)
			for (const table of ['notification_clears', 'notification_dismissals']) {
				expect([table, sql.exec(`SELECT count(*) AS n FROM ${table}`).one()]).toEqual([table, { n: 0 }])
			}
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})
})

describe('0024_attribution_domains', () => {
	it('gives every local account an empty list of attribution domains, and refuses a value that is not a JSON array', async () => {
		const at = NAMES.indexOf('0024_attribution_domains')
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
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0024_attribution_domains'],
			})
			expect(sql.exec('SELECT account_id, attribution_domains FROM local_accounts').toArray()).toEqual([
				{ account_id: alice, attribution_domains: '[]' },
			])
			for (const bad of ['not json', '{}', '"writer.example"']) {
				expect(() => sql.exec('UPDATE local_accounts SET attribution_domains = ?', bad)).toThrow(
					/CHECK constraint failed/
				)
			}
			sql.exec('UPDATE local_accounts SET attribution_domains = ?', '["writer.example"]')
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})
})

describe('0025_remote_collections', () => {
	const NAME = '0025_remote_collections'
	const id = (n: number) => String(100000000000000000n + BigInt(n))

	// The file's statements (it has no trigger).
	function statements(): string[] {
		const out: string[] = []
		let current = ''
		for (const line of (MIGRATIONS.find((m) => m.name === NAME)?.sql ?? '').split('\n')) {
			if (line.startsWith('--') || line.trim() === '') {
				continue
			}
			current += `${line}\n`
			if (line.endsWith(';')) {
				out.push(current)
				current = ''
			}
		}
		return out
	}

	it(`upgrades a Store with ${NAME}: local pins and featured hashtags kept, and any account's taken from now on`, async () => {
		const at = NAMES.indexOf(NAME)
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			const [alice, bob] = [id(1), id(2)]
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')",
				alice
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, hide_collections) VALUES (?, 'a@example.com', X'00', X'00', 'k', 1)",
				alice
			)
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/bob', 'bob', 'remote.example')",
				bob
			)
			for (const [n, author] of [
				[11, alice],
				[12, alice],
				[21, bob],
			] as const) {
				sql.exec(
					"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', '2026-10-01T00:00:00.000Z')",
					id(n),
					`https://example/o/${n}`,
					author
				)
			}
			sql.exec(
				"INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?1, ?2, '2026-10-01T00:00:00.000Z'), (?1, ?3, '2026-10-02T00:00:00.000Z')",
				alice,
				id(11),
				id(12)
			)
			sql.exec(
				`INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count, last_status_at, created_at)
				VALUES (?, ?, 'cats', 'Cats', 2, '2026-10-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`,
				id(31),
				alice
			)
			// A remote account's rows were refused before.
			expect(() => sql.exec('INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)', bob, id(21))).toThrow(
				/FOREIGN KEY/
			)
			const pins = () => sql.exec('SELECT account_id, status_id, created_at FROM status_pins ORDER BY 1, 2').toArray()
			const featured = () => sql.exec('SELECT * FROM featured_tags ORDER BY id').toArray()
			const [pinsBefore, featuredBefore] = [pins(), featured()]

			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(pins()).toEqual(pinsBefore)
			expect(featured()).toEqual(featuredBefore)
			expect(
				sql
					.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'status_pins' AND sql IS NOT NULL")
					.toArray()
			).toEqual([{ name: 'status_pins_status' }])
			expect(sql.exec('SELECT id, hide_collections FROM accounts ORDER BY id').toArray()).toEqual([
				{ id: alice, hide_collections: null },
				{ id: bob, hide_collections: null },
			])
			expect(sql.exec('SELECT count(*) AS n FROM collection_syncs').one()).toEqual({ n: 0 })

			// Now a remote account pins, features, hides and waits for a sync; an unknown account still cannot.
			sql.exec('INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)', bob, id(21))
			sql.exec(
				"INSERT INTO featured_tags (id, account_id, name, display_name) VALUES (?, ?, 'dogs', 'Dogs')",
				id(32),
				bob
			)
			sql.exec('UPDATE accounts SET hide_collections = 1 WHERE id = ?', bob)
			// The column has no constraint, so adding it checked no stored account (SQLite validates existing rows against
			// a CHECK, NOT NULL or foreign key of an added column).
			const column = sql
				.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
				.one()
				.sql.match(/hide_collections[^,)]*/)?.[0]
			expect(column).toBe('hide_collections INTEGER')
			sql.exec('INSERT INTO collection_syncs (account_id, due_at) VALUES (?, 1)', bob)
			expect(() => sql.exec('INSERT INTO status_pins (account_id, status_id) VALUES (?, ?)', id(9), id(21))).toThrow(
				/FOREIGN KEY/
			)
			expect(() => sql.exec('INSERT INTO collection_syncs (account_id, due_at) VALUES (?, 1)', id(9))).toThrow(
				/FOREIGN KEY/
			)
			expect(() =>
				sql.exec(
					"INSERT INTO featured_tags (id, account_id, name, display_name) VALUES (?, ?, 'dogs', 'x')",
					id(33),
					bob
				)
			).toThrow(/UNIQUE/)
			// They go with their status and their account.
			sql.exec('DELETE FROM statuses WHERE id = ?', id(11))
			expect(pins()).toEqual([pinsBefore[1], expect.objectContaining({ account_id: bob, status_id: id(21) })])
			sql.exec('DELETE FROM accounts WHERE id = ?', bob)
			expect(pins()).toEqual([pinsBefore[1]])
			expect(featured()).toEqual(featuredBefore)
			expect(sql.exec('SELECT count(*) AS n FROM collection_syncs').one()).toEqual({ n: 0 })
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('reads each pin and featured hashtag a bounded number of times, and nothing remote', async () => {
		const at = NAMES.indexOf(NAME)
		// `locals` local accounts with `each` pins and featured hashtags each, and `remotes` remote accounts, each with a
		// stored document of about 2 KB and ten statuses.
		const measure = async (locals: number, each: number, remotes: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain)
					SELECT CAST(100000000000000000 + i AS TEXT), 'https://kopje.test/ap/users/u' || i, 'u' || i, NULL FROM n`,
					locals
				)
				sql.exec(
					`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
					SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts`
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain, raw)
					SELECT CAST(300000000000000000 + i AS TEXT), 'https://remote.example/users/r' || i, 'r' || i, 'remote.example',
						json_object('summary', hex(randomblob(1000)))
					FROM n`,
					remotes
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					SELECT CAST(CAST(a.id AS INTEGER) + 100000000000000000 + n.i * 1000000 AS TEXT), a.uri || '/s/' || n.i, a.id,
						'public', '2026-10-01T00:00:00.000Z'
					FROM accounts a CROSS JOIN n WHERE a.domain IS NOT NULL OR n.i < ?2`,
					Math.max(each, 10),
					each
				)
				sql.exec(
					`INSERT INTO status_pins (account_id, status_id)
					SELECT s.account_id, s.id FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id`
				)
				sql.exec(
					`INSERT INTO featured_tags (id, account_id, name, display_name)
					SELECT CAST(CAST(s.id AS INTEGER) + 100000000000000000 AS TEXT), s.account_id, 't' || s.id, 't' || s.id
					FROM statuses s JOIN local_accounts l ON l.account_id = s.account_id`
				)
				let read = 0
				for (const statement of statements()) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				// Not vacuous: every row was copied.
				expect(
					sql.exec('SELECT (SELECT count(*) FROM status_pins) + (SELECT count(*) FROM featured_tags) AS n').one()
				).toEqual({ n: 2 * locals * each })
				return read
			})
		}
		const few = await measure(100, 5, 0)
		const remote = await measure(100, 5, 5000)
		const locals = await measure(1000, 5, 0)
		const each = await measure(100, 50, 0)
		// The remote accounts and their statuses are not read; each pin and featured hashtag a few times.
		expect(remote).toBeLessThanOrEqual(few + 10)
		expect(locals - few).toBeLessThanOrEqual(4 * 2 * (1000 - 100) * 5)
		expect(each - few).toBeLessThanOrEqual(4 * 2 * 100 * (50 - 5))
	}, 120_000)
})

describe('0026_streaming', () => {
	it('records an unfiltered notification for a recipient with a subscription, and stops at the span', async () => {
		const at = NAMES.indexOf('0026_streaming')
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			const [alice, bob] = ['100000000000000001', '100000000000000002']
			for (const [id, name] of [
				[alice, 'alice'],
				[bob, 'bob'],
			] as const) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
					id,
					`https://kopje.test/ap/users/${name}`,
					name
				)
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
					id,
					`${name}@example.com`
				)
			}
			sql.exec("INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)", alice, bob)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0026_streaming'],
			})
			// Nothing is journaled for what was written before, nor without a subscription.
			expect(sql.exec('SELECT count(*) AS n FROM stream_events').one().n).toBe(0)
			expect(sql.exec('SELECT event_id, account_id FROM stream_cursor').toArray()).toEqual([
				{ event_id: 0, account_id: null },
			])
			sql.exec("INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow', ?)", bob, alice)
			expect(sql.exec('SELECT count(*) AS n FROM stream_events').one().n).toBe(0)
			sql.exec("INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)", alice)
			// Filtered, then unfiltered: only the second is journaled, and another account's never.
			sql.exec(
				"INSERT INTO notifications (account_id, type, from_account_id, filtered) VALUES (?, 'mention', ?, 1)",
				alice,
				bob
			)
			const id = sql
				.exec<{ id: number }>(
					"INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'favourite', ?) RETURNING id",
					alice,
					bob
				)
				.one().id
			sql.exec("INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'reblog', ?)", bob, alice)
			expect(sql.exec('SELECT kind, subject FROM stream_events').toArray()).toEqual([
				{ kind: 'notification', subject: String(id) },
			])
			// Once the journal spans 4,096 ids, nothing more is recorded.
			sql.exec(
				"INSERT INTO stream_events (id, kind, subject, created_at) SELECT max(id) + 4095, 'notification', '0', '2026-10-12T00:00:00.000Z' FROM stream_events"
			)
			sql.exec(
				"INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'follow_request', ?)",
				alice,
				bob
			)
			expect(sql.exec('SELECT count(*) AS n FROM stream_events').one().n).toBe(3)
			sql.exec("INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'poll', ?)", alice, bob)
			expect(sql.exec('SELECT count(*) AS n FROM stream_events').one().n).toBe(3)
			expect(() => sql.exec('INSERT INTO stream_cursor (id, event_id) VALUES (2, 0)')).toThrow(
				/CHECK constraint failed/
			)
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})
})

describe('0028_streaming_home', () => {
	it('journals statuses and edits while some account listens, stops at the span, and keeps captures with their event', async () => {
		const at = NAMES.indexOf('0028_streaming_home')
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
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'alice@example.com', X'00', X'00', 'k')",
				alice
			)
			// A position mid-event and a registry row, as a Store running 0026 may hold them.
			sql.exec('UPDATE stream_cursor SET event_id = 7, account_id = ?', alice)
			sql.exec(
				"INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user:notification', 1)",
				alice
			)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0028_streaming_home'],
			})
			expect(sql.exec('SELECT event_id, subject, account_id FROM stream_cursor').toArray()).toEqual([
				{ event_id: 7, subject: 0, account_id: alice },
			])
			const status = (id: string) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, 'public', '<p>x</p>', '2026-10-12T00:00:00.000Z')`,
					id,
					`https://kopje.test/ap/o/${id}`,
					alice
				)
			const edit = (id: string, editedAt: string | null) =>
				sql.exec('UPDATE statuses SET edited_at = ? WHERE id = ?', editedAt, id)
			const journal = () => sql.exec('SELECT kind, subject FROM stream_events ORDER BY id').toArray()
			// Only `user:notification`: an edit is journaled (the mention reference), an insert is not.
			status('200000000000000001')
			edit('200000000000000001', '2026-10-12T01:00:00.000Z')
			expect(journal()).toEqual([{ kind: 'edit', subject: '200000000000000001' }])
			sql.exec('DELETE FROM stream_events')
			// With `user`: both; an update that leaves edited_at as it was, or clears it, is no edit.
			sql.exec("INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)", alice)
			status('200000000000000002')
			edit('200000000000000002', '2026-10-12T01:00:00.000Z')
			edit('200000000000000002', '2026-10-12T01:00:00.000Z')
			sql.exec("UPDATE statuses SET content = '<p>y</p>' WHERE id = '200000000000000002'")
			edit('200000000000000002', null)
			expect(journal()).toEqual([
				{ kind: 'status', subject: '200000000000000002' },
				{ kind: 'edit', subject: '200000000000000002' },
			])
			// A capture names its journal row by id only: the row's delete leaves it to streamPrune.
			const event = sql
				.exec<{ id: number }>(
					"INSERT INTO stream_events (kind, subject, created_at) VALUES ('delete', '200000000000000002', '2026-10-12T00:00:00.000Z') RETURNING id"
				)
				.one().id
			sql.exec(
				"INSERT INTO stream_delete_viewers (event_id, account_id, lists, boosts) VALUES (?, ?, '[]', '[]')",
				event,
				alice
			)
			sql.exec('DELETE FROM stream_events WHERE id = ?', event)
			expect(sql.exec('SELECT count(*) AS n FROM stream_delete_viewers').one().n).toBe(1)
			sql.exec('DELETE FROM stream_delete_viewers')
			// Once the journal spans 4,096 ids, nothing more is recorded.
			sql.exec(
				"INSERT INTO stream_events (id, kind, subject, created_at) SELECT max(id) + 4095, 'status', '0', '2026-10-12T00:00:00.000Z' FROM stream_events"
			)
			const before = journal().length
			status('200000000000000003')
			edit('200000000000000003', '2026-10-12T01:00:00.000Z')
			expect(journal()).toHaveLength(before)
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})
})

describe('0029_admin_reports', () => {
	const at = NAMES.indexOf('0029_admin_reports')
	const id = (n: number) => String(100000000000000000n + BigInt(n))

	// Two local accounts, a remote one, and `reports` reports of the remote one by the first; `others` more remote
	// accounts, each with a status and a follow of the first local account.
	function seed(sql: SqlStorage, reports: number, others = 0) {
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
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO reports (account_id, target_account_id, uri, created_at)
			SELECT ?2, ?3, 'https://kopje.test/actor#reports/' || i, '2026-10-12T00:00:00.000Z' FROM n`,
			reports,
			id(1),
			id(3)
		)
		if (others > 0) {
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain) SELECT CAST(200000000000000000 + i AS TEXT),
					'https://other.example/users/o' || i, 'o' || i, 'other.example' FROM n`,
				others
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(CAST(id AS INTEGER) + 100000000000000000 AS TEXT), uri || '/s', id, 'public', '', '2026-10-01T00:00:00.000Z'
				FROM accounts WHERE domain = 'other.example'`
			)
			sql.exec(
				"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE domain = 'other.example'",
				id(1)
			)
		}
	}

	it('adds the moderation columns, empty, the state indexes in place of the old ones, and the moderation log', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 3)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0029_admin_reports'],
			})
			expect(
				sql
					.exec(
						'SELECT action_taken_at, action_taken_by_account_id, assigned_account_id, updated_at FROM reports GROUP BY 1, 2, 3, 4'
					)
					.toArray()
			).toEqual([
				{ action_taken_at: null, action_taken_by_account_id: null, assigned_account_id: null, updated_at: null },
			])
			const indexes = sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reports' AND sql IS NOT NULL ORDER BY name"
				)
				.toArray()
				.map((row) => row.name)
			expect(indexes).toEqual([
				'reports_account_state',
				'reports_action_taken_by',
				'reports_assigned',
				'reports_state',
				'reports_target_state',
			])
			// The admin's account goes to NULL if it ever went; the reporter's reports go with the reporter.
			sql.exec(
				"UPDATE reports SET action_taken_at = '2026-10-13T00:00:00.000Z', action_taken_by_account_id = ?1, assigned_account_id = ?1",
				id(2)
			)
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', id(2))
			expect(
				sql.exec('SELECT DISTINCT action_taken_by_account_id, assigned_account_id FROM reports').toArray()
			).toEqual([{ action_taken_by_account_id: null, assigned_account_id: null }])
			expect(() => sql.exec('UPDATE reports SET assigned_account_id = ?', id(3))).toThrow(
				/FOREIGN KEY constraint failed/
			)
			// The log: an actor of two kinds, JSON detail, no foreign key.
			sql.exec(
				"INSERT INTO admin_actions (actor, account_id, action, target_type, target_id, created_at) VALUES ('oauth', ?, 'resolve', 'Report', '1', '2026-10-13T00:00:00.000Z')",
				id(9)
			)
			expect(() =>
				sql.exec(
					"INSERT INTO admin_actions (actor, action, target_type, target_id, created_at) VALUES ('nobody', 'x', 'Report', '1', 'x')"
				)
			).toThrow(/CHECK constraint failed/)
			expect(() =>
				sql.exec(
					"INSERT INTO admin_actions (actor, action, target_type, target_id, detail, created_at) VALUES ('access', 'x', 'Report', '1', '{', 'x')"
				)
			).toThrow(/CHECK constraint failed/)
			sql.exec('DELETE FROM local_accounts WHERE account_id = ?', id(1))
			expect(sql.exec('SELECT count(*) AS n FROM reports').one().n).toBe(0)
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('reads each report a bounded number of times, and no account, status or follow', async () => {
		const statements = (MIGRATIONS[at]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (reports: number, others: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, reports, others)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				return read
			})
		}
		const few = await measure(1000, 0)
		const crowded = await measure(1000, 10_000)
		const many = await measure(10_000, 0)
		// Each of the five index builds reads the reports a bounded number of times; the accounts, statuses and follows
		// are not read.
		expect(crowded).toBeLessThanOrEqual(few + 10)
		expect(many - few).toBeLessThanOrEqual(10 * (10_000 - 1000))
	}, 120_000)
})

describe('0030_admin_accounts', () => {
	const at = NAMES.indexOf('0030_admin_accounts')

	// `accounts` remote accounts with display names, `follows` follows of each, and `statuses` statuses among them.
	function seed(sql: SqlStorage, accounts: number, follows = 0, statuses = 0) {
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, display_name) SELECT CAST(100000000000000000 + i AS TEXT),
				'https://remote.example/users/u' || i, 'u' || i, 'remote.example', 'Name ' || i FROM n`,
			accounts
		)
		// Each account follows the next `follows` accounts.
		for (let k = 1; k <= follows; k++) {
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO follows (account_id, target_account_id, state) SELECT CAST(100000000000000000 + i AS TEXT),
					CAST(100000000000000000 + (i + CAST(?2 AS INTEGER)) % CAST(?1 AS INTEGER) AS TEXT), 'accepted' FROM n`,
				accounts,
				k
			)
		}
		if (statuses > 0) {
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT CAST(300000000000000000 + i AS TEXT), 'https://remote.example/s/' || i,
					CAST(100000000000000000 + i % CAST(?2 AS INTEGER) AS TEXT), 'public', '', '2026-10-01T00:00:00.000Z' FROM n`,
				statuses,
				accounts
			)
		}
	}

	it('indexes the lowercased display names, which a prefix range reads in order', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 3)
			sql.exec("UPDATE accounts SET display_name = 'ALICE' WHERE username = 'u1'")
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0030_admin_accounts'],
			})
			const query =
				"SELECT username FROM accounts INDEXED BY accounts_display_name WHERE lower(display_name) >= 'al' AND lower(display_name) < 'am'"
			expect(sql.exec(query).toArray()).toEqual([{ username: 'u1' }])
			expect(
				sql
					.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
					.toArray()
					.map((row) => row.detail)
			).toEqual([expect.stringContaining('USING INDEX accounts_display_name')])
		})
	})

	it('reads each account a bounded number of times, and no follow or status', async () => {
		const statements = (MIGRATIONS[at]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (accounts: number, follows: number, statuses: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, accounts, follows, statuses)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				return read
			})
		}
		const few = await measure(1000, 0, 0)
		const crowded = await measure(1000, 30, 20_000)
		const many = await measure(10_000, 0, 0)
		// The index build reads the accounts a bounded number of times; the follows and statuses are not read.
		expect(crowded).toBeLessThanOrEqual(few + 10)
		expect(many - few).toBeLessThanOrEqual(3 * (10_000 - 1000))
		expect(many).toBeGreaterThan(few)
	}, 120_000)
})

describe('0031_admin_accounts_available', () => {
	const at = NAMES.indexOf('0031_admin_accounts_available')

	// `accounts` remote accounts, every `deleted`-th of them with its deletion started, and `follows` follows of each.
	function seed(sql: SqlStorage, accounts: number, follows = 0, deleted = 0) {
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, deleted_at) SELECT CAST(100000000000000000 + i AS TEXT),
				'https://remote.example/users/u' || i, 'u' || i, 'remote.example',
				CASE WHEN ?2 > 0 AND i % CAST(?2 AS INTEGER) = 0 THEN '2026-10-01T00:00:00.000Z' END FROM n`,
			accounts,
			deleted
		)
		for (let k = 1; k <= follows; k++) {
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO follows (account_id, target_account_id, state) SELECT CAST(100000000000000000 + i AS TEXT),
					CAST(100000000000000000 + (i + CAST(?2 AS INTEGER)) % CAST(?1 AS INTEGER) AS TEXT), 'accepted' FROM n`,
				accounts,
				k
			)
		}
	}

	it('indexes by id the accounts whose deletion has not started, which an active walk reads in order', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 6, 0, 2)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0031_admin_accounts_available'],
			})
			const query =
				'SELECT username FROM accounts INDEXED BY accounts_available WHERE deleted_at IS NULL ORDER BY id DESC'
			expect(sql.exec(query).toArray()).toEqual([{ username: 'u5' }, { username: 'u3' }, { username: 'u1' }])
			expect(
				sql
					.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
					.toArray()
					.map((row) => row.detail)
			).toEqual([expect.stringContaining('USING INDEX accounts_available')])
		})
	})

	it('reads each account a bounded number of times, and no follow', async () => {
		const statements = (MIGRATIONS[at]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (accounts: number, follows: number, deleted: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, accounts, follows, deleted)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				return read
			})
		}
		const few = await measure(1000, 0, 0)
		const crowded = await measure(1000, 30, 2)
		const many = await measure(10_000, 0, 0)
		// The index build reads the accounts a bounded number of times, deleted or not; the follows are not read.
		expect(crowded).toBeLessThanOrEqual(few + 10)
		expect(many - few).toBeLessThanOrEqual(3 * (10_000 - 1000))
		expect(many).toBeGreaterThan(few)
	}, 120_000)
})

describe('0032_streaming_lists', () => {
	const at = NAMES.indexOf('0032_streaming_lists')
	const id = (n: number) => String(100000000000000000n + BigInt(n))

	// A local account with `conversations` conversations (each holding one status of its own), and `others` remote
	// statuses nobody's conversation holds.
	function seed(sql: SqlStorage, conversations: number, others = 0) {
		sql.exec("INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')", id(1))
		sql.exec(
			"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'alice@example.com', X'00', X'00', 'k')",
			id(1)
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, ?2, 'direct', '', '2026-10-12T00:00:00.000Z'
			FROM n WHERE ?1 > 0`,
			conversations + others,
			id(1)
		)
		sql.exec(
			`INSERT INTO conversations (account_id, thread, participants, last_status_id, unread)
			SELECT account_id, thread, '[]', id, 0 FROM statuses ORDER BY id LIMIT ?`,
			conversations
		)
		sql.exec(
			'INSERT INTO conversation_statuses (conversation_id, status_id) SELECT id, last_status_id FROM conversations'
		)
	}

	it('journals statuses for list listeners, and moves a mark with each conversation write the trigger makes', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 1)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0032_streaming_lists'],
			})
			expect(sql.exec('SELECT stream_seq FROM conversations').toArray()).toEqual([{ stream_seq: 0 }])
			const journal = () => sql.exec('SELECT kind, subject FROM stream_events ORDER BY id').toArray()
			const status = (n: number) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					VALUES (?, ?, ?, 'public', '<p>x</p>', '2026-10-12T00:00:00.000Z')`,
					id(300 + n),
					`https://kopje.test/ap/o/s${n}`,
					id(1)
				)
			// Nobody listens: nothing; a list alone arms both triggers.
			status(1)
			expect(journal()).toEqual([])
			sql.exec(
				"INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'list:100000000000000009', 1)",
				id(1)
			)
			status(2)
			sql.exec("UPDATE statuses SET edited_at = '2026-10-12T01:00:00.000Z' WHERE id = ?", id(302))
			expect(journal()).toEqual([
				{ kind: 'status', subject: id(302) },
				{ kind: 'edit', subject: id(302) },
			])
			// The conversation gains a newer status, then loses it: without a mark, stream_seq stays; with one, the
			// removal takes the next value.
			const conversation = sql.exec<{ id: number }>('SELECT id FROM conversations').one().id
			sql.exec('UPDATE conversations SET last_status_id = ? WHERE id = ?', id(302), conversation)
			sql.exec('INSERT INTO conversation_statuses (conversation_id, status_id) VALUES (?, ?)', conversation, id(302))
			sql.exec('DELETE FROM conversation_statuses WHERE status_id = ?', id(302))
			expect(sql.exec('SELECT last_status_id, stream_seq FROM conversations').toArray()).toEqual([
				{ last_status_id: '200000000000000001', stream_seq: 0 },
			])
			sql.exec('INSERT INTO stream_conversation_marks (account_id, seq) VALUES (?, 7)', id(1))
			sql.exec('UPDATE conversations SET last_status_id = ? WHERE id = ?', id(302), conversation)
			sql.exec('INSERT INTO conversation_statuses (conversation_id, status_id) VALUES (?, ?)', conversation, id(302))
			sql.exec('DELETE FROM conversation_statuses WHERE status_id = ?', id(302))
			expect(sql.exec('SELECT last_status_id, stream_seq FROM conversations').toArray()).toEqual([
				{ last_status_id: '200000000000000001', stream_seq: 8 },
			])
			// The last link's delete deletes the conversation and leaves the mark where it was.
			sql.exec('DELETE FROM conversation_statuses')
			expect(sql.exec('SELECT count(*) AS n FROM conversations').one().n).toBe(0)
			expect(sql.exec('SELECT seq FROM stream_conversation_marks').toArray()).toEqual([{ seq: 8 }])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('reads each conversation a bounded number of times, and no status', async () => {
		// The file's statements: a trigger's body holds statements of its own, and ends at END.
		const statements: string[] = []
		let statement = ''
		for (const line of (MIGRATIONS[at]?.sql ?? '').split('\n').filter((line) => !line.startsWith('--'))) {
			statement += `${line}\n`
			const trigger = /^\s*CREATE TRIGGER/i.test(statement)
			if (trigger ? /^END;\s*$/.test(line) : /;\s*$/.test(line)) {
				statements.push(statement)
				statement = ''
			}
		}
		expect(statements).toHaveLength(18)
		const measure = async (conversations: number, others: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, conversations, others)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(sql.exec('SELECT count(*) AS n FROM conversations').one().n).toBe(conversations)
				return read
			})
		}
		const few = await measure(1000, 0)
		const crowded = await measure(1000, 10_000)
		const many = await measure(10_000, 0)
		// The index reads the conversations once; the statuses and their links are not read.
		expect(crowded).toBeLessThanOrEqual(few + 10)
		expect(many - few).toBeLessThanOrEqual(3 * (10_000 - 1000))
	}, 120_000)
})

describe('0033_quotes', () => {
	const NAME = '0033_quotes'
	const id = (n: number) => String(100000000000000000n + BigInt(n))

	// The file's statements, a trigger whole (its body holds semicolons of its own).
	function statements(): string[] {
		const out: string[] = []
		let current = ''
		for (const line of (MIGRATIONS.find((m) => m.name === NAME)?.sql ?? '').split('\n')) {
			if (line.startsWith('--') || line.trim() === '') {
				continue
			}
			current += `${line}\n`
			if (current.startsWith('CREATE TRIGGER') ? line === 'END;' : line.endsWith(';')) {
				out.push(current)
				current = ''
			}
		}
		return out
	}

	it(`upgrades a Store with ${NAME}: stored statuses count no quote, and quotes keep their rules`, async () => {
		const at = NAMES.indexOf(NAME)
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/bob', 'bob', 'remote.example')",
				id(1)
			)
			for (const n of [11, 12, 13]) {
				sql.exec(
					"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', '2026-10-01T00:00:00.000Z')",
					id(n),
					`https://remote.example/users/bob/statuses/${n}`,
					id(1)
				)
			}
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(sql.exec('SELECT DISTINCT quotes_count FROM statuses').toArray()).toEqual([{ quotes_count: 0 }])
			const quote = (status: number, state_: string, quoted: number | null) =>
				sql.exec(
					`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
					VALUES (?, 'https://remote.example/users/bob/statuses/13', ?, ?, ?, '2026-10-12T00:00:00.000Z')`,
					id(status),
					quoted === null ? null : id(quoted),
					quoted === null ? null : id(1),
					state_
				)
			const count = () => sql.exec('SELECT quotes_count AS n FROM statuses WHERE id = ?', id(13)).one().n
			// The count follows accepted quotes, by deltas.
			quote(11, 'accepted', 13)
			quote(12, 'pending', 13)
			expect(count()).toBe(1)
			sql.exec("UPDATE quotes SET state = 'accepted' WHERE status_id = ?", id(12))
			expect(count()).toBe(2)
			sql.exec("UPDATE quotes SET state = 'revoked' WHERE status_id = ?", id(11))
			expect(count()).toBe(1)
			sql.exec('DELETE FROM quotes WHERE status_id = ?', id(12))
			expect(count()).toBe(0)
			// An accepted quote needs its quoted status, its author goes with it, and work is only for a live quote.
			expect(() => quote(12, 'accepted', null)).toThrow(/CHECK constraint failed/)
			expect(() =>
				sql.exec(
					"INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, state, updated_at) VALUES (?, 'x', ?, 'pending', 'x')",
					id(12),
					id(13)
				)
			).toThrow(/CHECK constraint failed/)
			expect(() =>
				sql.exec(
					"INSERT INTO quotes (status_id, quoted_uri, state, verify_after, updated_at) VALUES (?, NULL, 'deleted', 1, 'x')",
					id(12)
				)
			).toThrow(/CHECK constraint failed/)
			expect(() =>
				sql.exec(
					"INSERT INTO quotes (status_id, quoted_uri, state, updated_at) VALUES (?, NULL, 'pending', 'x')",
					id(12)
				)
			).toThrow(/CHECK constraint failed/)
			sql.exec("INSERT INTO quotes (status_id, quoted_uri, state, updated_at) VALUES (?, NULL, 'deleted', 'x')", id(12))
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('reads no stored status, however many there are', async () => {
		const at = NAMES.indexOf(NAME)
		const measure = async (statuses: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/bob', 'bob', 'remote.example')",
					id(1)
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(200000000000000000 + i AS TEXT), 'https://remote.example/users/bob/statuses/' || i, ?2, 'public',
						hex(randomblob(500)), '2026-10-01T00:00:00.000Z'
					FROM n`,
					statuses,
					id(1)
				)
				let read = 0
				for (const statement of statements()) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				// Not vacuous: the column is there for every status.
				expect(sql.exec('SELECT count(*) AS n FROM statuses WHERE quotes_count = 0').one()).toEqual({ n: statuses })
				return read
			})
		}
		const few = await measure(100)
		const many = await measure(10_000)
		expect(statements().length).toBeGreaterThan(5)
		expect(many).toBeLessThanOrEqual(few + 10)
	}, 120_000)
})

describe('0036_quotes_list', () => {
	const NAME = '0036_quotes_list'
	const at = NAMES.indexOf(NAME)
	const id = (n: number) => String(100000000000000000n + BigInt(n))

	// `statuses` public statuses of one remote account, the first of them quoted by the next `quotes`, one in four of
	// those accepted.
	function seed(sql: SqlStorage, statuses: number, quotes: number): void {
		sql.exec(
			"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.example/users/bob', 'bob', 'remote.example')",
			id(0)
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT CAST(200000000000000000 + i AS TEXT), 'https://remote.example/users/bob/statuses/' || i, ?2, 'public',
				hex(randomblob(200)), '2026-10-01T00:00:00.000Z'
			FROM n`,
			statuses,
			id(0)
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + 1)
			INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
			SELECT CAST(200000000000000000 + i AS TEXT), 'https://remote.example/users/bob/statuses/1', '200000000000000001',
				?2, CASE i % 4 WHEN 0 THEN 'accepted' WHEN 1 THEN 'pending' WHEN 2 THEN 'rejected' ELSE 'revoked' END,
				'2026-10-01T00:00:00.000Z'
			FROM n`,
			quotes,
			id(0)
		)
	}

	it('indexes the accepted quotes of a status in quoting status order, which the list reads without a sort', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 40, 30)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			const plan = sql
				.exec<{ detail: string }>(
					`EXPLAIN QUERY PLAN SELECT status_id FROM quotes INDEXED BY quotes_accepted
					WHERE quoted_status_id = ?1 AND state = 'accepted' AND status_id < ?2 AND status_id > ?3
					ORDER BY status_id DESC LIMIT 20`,
					'200000000000000001',
					':',
					''
				)
				.toArray()
				.map((row) => row.detail)
			expect(plan.join('\n')).toContain('quotes_accepted')
			expect(plan.join('\n')).not.toContain('TEMP B-TREE')
			const listed = sql
				.exec<{ status_id: string }>(
					"SELECT status_id FROM quotes INDEXED BY quotes_accepted WHERE quoted_status_id = ? AND state = 'accepted' ORDER BY status_id DESC",
					'200000000000000001'
				)
				.toArray()
			expect(listed).toHaveLength(7)
		})
	})

	// The index reads the quotes and no status: the same with 200 or 20,000 statuses, and a row or two (the quote and its
	// index entry) more for each quote more.
	it('reads the quotes and no status, however many statuses there are', async () => {
		const measure = async (statuses: number, quotes: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, statuses, quotes)
				const cursor = sql.exec(MIGRATIONS[at]?.sql ?? '')
				cursor.toArray()
				// Not vacuous: the index holds the accepted quotes.
				expect(
					sql
						.exec(
							"SELECT count(*) AS n FROM quotes INDEXED BY quotes_accepted WHERE state = 'accepted' AND quoted_status_id > ''"
						)
						.one()
				).toEqual({ n: Math.floor((quotes + 1) / 4) })
				return cursor.rowsRead
			})
		}
		const few = await measure(200, 100)
		const statuses = await measure(20_000, 100)
		const quotes = await measure(20_000, 10_000)
		expect(statuses).toBeLessThanOrEqual(few + 10)
		expect(quotes - statuses).toBeLessThanOrEqual(2 * (10_000 - 100))
	}, 120_000)
})

describe('0034_admin_suspension', () => {
	const at = NAMES.indexOf('0034_admin_suspension')
	const id = (n: number) => String(100000000000000000n + BigInt(n))

	// `locals` local accounts, each with `tokens` access tokens and a follow of the next account.
	function seed(sql: SqlStorage, locals: number, tokens = 0) {
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username) SELECT CAST(100000000000000000 + i AS TEXT),
				'https://kopje.test/ap/users/u' || i, 'u' || i FROM n`,
			locals
		)
		sql.exec(
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts`
		)
		sql.exec(
			"INSERT INTO oauth_clients (id, secret, name, redirect_uris) VALUES ('c', 'x', 'c', 'urn:ietf:wg:oauth:2.0:oob')"
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes)
			SELECT a.id || '-' || n.i, 'access', 'c', a.id, 'read' FROM accounts a, n`,
			tokens
		)
		sql.exec(
			`INSERT INTO follows (account_id, target_account_id, state)
			SELECT id, CAST(id + 1 AS TEXT), 'accepted' FROM accounts WHERE CAST(id + 1 AS TEXT) IN (SELECT id FROM accounts)`
		)
	}

	it('adds the credential epochs and the jobs, whose staged audience a job deletes itself', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 2, 1)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0034_admin_suspension'],
			})
			expect(sql.exec('SELECT DISTINCT epoch FROM oauth_tokens').toArray()).toEqual([{ epoch: 0 }])
			expect(sql.exec('SELECT credential_epoch FROM local_accounts').toArray()).toEqual([
				{ credential_epoch: 0 },
				{ credential_epoch: 0 },
			])
			sql.exec(
				"INSERT INTO moderation_jobs (kind, account_id, generation, phase) VALUES ('suspension', ?, 1, 'reports')",
				id(1)
			)
			expect(() =>
				sql.exec(
					"INSERT INTO moderation_jobs (kind, account_id, generation, phase) VALUES ('suspension', ?, 1, 'x')",
					id(1)
				)
			).toThrow(/UNIQUE constraint failed/)
			expect(() =>
				sql.exec(
					"INSERT INTO moderation_jobs (kind, account_id, generation, phase) VALUES ('silence', ?, 1, 'x')",
					id(1)
				)
			).toThrow(/CHECK constraint failed/)
			const job = sql.exec<{ id: number }>('SELECT id FROM moderation_jobs').one().id
			sql.exec("INSERT INTO moderation_reach (job_id, inbox) VALUES (?, 'https://a.example/inbox')", job)
			sql.exec("INSERT OR IGNORE INTO moderation_reach (job_id, inbox) VALUES (?, 'https://a.example/inbox')", job)
			expect(sql.exec('SELECT count(*) AS n FROM moderation_reach').one().n).toBe(1)
			// The staged rows do not cascade from their job: it deletes them before itself.
			expect(() => sql.exec('DELETE FROM moderation_jobs WHERE id = ?', job)).toThrow(/FOREIGN KEY constraint failed/)
			sql.exec('DELETE FROM moderation_reach WHERE job_id = ?', job)
			sql.exec('DELETE FROM moderation_jobs WHERE id = ?', job)
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('reads no account, token or follow, however many there are', async () => {
		const statements = (MIGRATIONS[at]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		const measure = async (locals: number, tokens: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, locals, tokens)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				return read
			})
		}
		const few = await measure(2, 0)
		const many = await measure(500, 20)
		expect(many).toBe(few)
	}, 120_000)
})

describe('0035_streaming_public', () => {
	const at = NAMES.indexOf('0035_streaming_public')
	const id = (n: number) => String(100000000000000000n + BigInt(n))

	// A local account with `statuses` public statuses, each with a hashtag.
	function seed(sql: SqlStorage, statuses: number) {
		sql.exec("INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')", id(1))
		sql.exec(
			"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'alice@example.com', X'00', X'00', 'k')",
			id(1)
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, ?2, 'public', '', '2026-10-12T00:00:00.000Z'
			FROM n WHERE ?1 > 0`,
			statuses,
			id(1)
		)
		sql.exec("INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses")
	}

	it('journals public statuses that are not boosts, and their edits, for feed listeners', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 0)
			sql.exec(
				"INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'public:local:media', 1)",
				id(1)
			)
			const status = (n: number, visibility: string, reblogOf: string | null = null) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
					VALUES (?, ?, ?, ?, ?, ?, '2026-10-12T00:00:00.000Z')`,
					id(300 + n),
					`https://kopje.test/ap/o/s${n}`,
					id(1),
					reblogOf,
					visibility,
					reblogOf === null ? '<p>x</p>' : ''
				)
			const edit = (n: number) =>
				sql.exec("UPDATE statuses SET edited_at = '2026-10-12T01:00:00.000Z' WHERE id = ?", id(300 + n))
			const journal = () => sql.exec('SELECT kind, subject FROM stream_events ORDER BY id').toArray()
			// Before: a feed alone arms nothing.
			status(1, 'public')
			expect(journal()).toEqual([])
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({
				ok: true,
				applied: ['0035_streaming_public'],
			})
			status(2, 'public')
			status(3, 'unlisted')
			status(4, 'public', id(302))
			edit(2)
			edit(3)
			expect(journal()).toEqual([
				{ kind: 'status', subject: id(302) },
				{ kind: 'edit', subject: id(302) },
			])
			// A hashtag key arms them too; `user` arms them for every status, as before.
			sql.exec('DELETE FROM stream_events')
			sql.exec("UPDATE stream_subscriptions SET stream_key = 'hashtag:local:cats'")
			status(5, 'public')
			status(6, 'private')
			expect(journal()).toEqual([{ kind: 'status', subject: id(305) }])
			sql.exec("INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)", id(1))
			status(7, 'private')
			expect(journal()).toEqual([
				{ kind: 'status', subject: id(305) },
				{ kind: 'status', subject: id(307) },
			])
			expect(sql.exec('SELECT count(*) AS n FROM stream_delete_tombstones').one().n).toBe(0)
		})
	})

	it('reads the same rows with 0 or 10,000 statuses', async () => {
		// The file's statements: a trigger's body holds statements of its own, and ends at END.
		const statements: string[] = []
		let statement = ''
		for (const line of (MIGRATIONS[at]?.sql ?? '').split('\n').filter((line) => !line.startsWith('--'))) {
			statement += `${line}\n`
			const trigger = /^\s*CREATE TRIGGER/i.test(statement)
			if (trigger ? /^END;\s*$/.test(line) : /;\s*$/.test(line)) {
				statements.push(statement)
				statement = ''
			}
		}
		expect(statements).toHaveLength(5)
		const measure = async (statuses: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, statuses)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				expect(sql.exec('SELECT count(*) AS n FROM statuses').one().n).toBe(statuses)
				return read
			})
		}
		// A table and triggers made: no status, hashtag or other row of the Store is read.
		expect(await measure(10_000)).toBe(await measure(0))
	}, 120_000)
})

describe('0037_quote_policy', () => {
	const NAME = '0037_quote_policy'
	const at = NAMES.indexOf(NAME)
	const id = (n: number) => String(100000000000000000n + BigInt(n))

	// `locals` local accounts, and `statuses` public statuses of the first of them.
	function seed(sql: SqlStorage, locals: number, statuses: number) {
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username) SELECT CAST(100000000000000000 + i AS TEXT),
				'https://kopje.test/ap/users/u' || i, 'u' || i FROM n`,
			locals
		)
		sql.exec(
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts`
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, ?2, 'public',
				hex(randomblob(200)), '2026-10-12T00:00:00.000Z'
			FROM n WHERE ?1 > 0`,
			statuses,
			id(1)
		)
	}

	it('leaves every stored status unquotable and gives local accounts the public default', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 2, 3)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(sql.exec('SELECT DISTINCT quote_policy FROM statuses').toArray()).toEqual([{ quote_policy: 0 }])
			expect(sql.exec('SELECT DISTINCT default_quote_policy FROM local_accounts').toArray()).toEqual([
				{ default_quote_policy: 'public' },
			])
			for (const policy of ['followers', 'nobody']) {
				sql.exec('UPDATE local_accounts SET default_quote_policy = ? WHERE account_id = ?', policy, id(1))
			}
			expect(() =>
				sql.exec("UPDATE local_accounts SET default_quote_policy = 'following' WHERE account_id = ?", id(1))
			).toThrow(/CHECK constraint failed/)
			expect(() => sql.exec('UPDATE statuses SET quote_policy = NULL')).toThrow(/NOT NULL constraint failed/)
			sql.exec('UPDATE statuses SET quote_policy = ? WHERE id = ?', (2 << 16) | 4, '200000000000000001')
			expect(sql.exec('SELECT quote_policy FROM statuses WHERE id = ?', '200000000000000001').one()).toEqual({
				quote_policy: 131076,
			})
		})
	})

	// Both columns have a constant default, so neither table is rewritten, and the statuses column has no CHECK: the rows
	// read are the same with 10,000 statuses or 500 local accounts as with none. SQLite also tests the local_accounts
	// column's CHECK against each stored local account (a handful on any instance), which the cursor does not count.
	it('reads the same rows however many statuses or local accounts there are', async () => {
		const statements = (MIGRATIONS[at]?.sql ?? '')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.split(';')
			.filter((statement) => statement.trim() !== '')
		expect(statements).toHaveLength(2)
		const measure = async (locals: number, statuses: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, locals, statuses)
				let read = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				// Not vacuous: the rows are there, and the columns were added.
				expect(sql.exec('SELECT count(*) AS n, sum(quote_policy) AS p FROM statuses').one()).toEqual({
					n: statuses,
					p: statuses === 0 ? null : 0,
				})
				expect(
					sql.exec("SELECT count(*) AS n FROM local_accounts WHERE default_quote_policy = 'public'").one()
				).toEqual({ n: locals })
				return read
			})
		}
		const few = await measure(2, 0)
		const statuses = await measure(2, 10_000)
		const locals = await measure(500, 0)
		expect(statuses).toBe(few)
		expect(locals).toBe(few)
	}, 120_000)
})

describe('0038_quote_requests', () => {
	const NAME = '0038_quote_requests'
	const at = NAMES.indexOf(NAME)

	// A local account with `statuses` public statuses, and `quotes` quotes among them (status i + 1 quoting status i).
	function seed(sql: SqlStorage, statuses: number, quotes: number) {
		sql.exec(
			`INSERT INTO accounts (id, uri, username) VALUES ('100000000000000001', 'https://kopje.test/ap/users/u1', 'u1')`
		)
		sql.exec(
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			VALUES ('100000000000000001', 'u1@example.com', X'00', X'00', 'k')`
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT CAST(200000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, '100000000000000001', 'public',
				'x', '2026-10-12T00:00:00.000Z'
			FROM n WHERE ?1 > 0`,
			statuses
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
			SELECT CAST(200000000000000000 + i + 1 AS TEXT), 'https://kopje.test/ap/o/' || i,
				CAST(200000000000000000 + i AS TEXT), '100000000000000001',
				CASE i % 2 WHEN 0 THEN 'accepted' ELSE 'pending' END, '2026-10-12T00:00:00.000Z'
			FROM n WHERE ?1 > 0`,
			quotes
		)
	}

	it('keeps an authorization only while accepted, and records each one retired, by any path', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 4, 3)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			const quote = (n: number) => String(200000000000000000n + BigInt(n))
			// 2 quotes 1 (pending), 3 quotes 2 (accepted), 4 quotes 3 (pending).
			expect(() => sql.exec("UPDATE quotes SET authorization_id = 'a' WHERE status_id = ?", quote(2))).toThrow(
				/CHECK constraint failed/
			)
			sql.exec("UPDATE quotes SET authorization_id = 'a' WHERE status_id = ?", quote(3))
			expect(() => sql.exec("UPDATE quotes SET state = 'revoked' WHERE status_id = ?", quote(3))).toThrow(
				/CHECK constraint failed/
			)
			sql.exec("UPDATE quotes SET state = 'accepted', authorization_id = 'b' WHERE status_id = ?", quote(4))
			expect(() =>
				sql.exec("UPDATE quotes SET state = 'accepted', authorization_id = 'b' WHERE status_id = ?", quote(2))
			).toThrow(/UNIQUE constraint failed/)
			sql.exec("UPDATE quotes SET state = 'revoked', authorization_id = NULL WHERE status_id = ?", quote(3))
			sql.exec('DELETE FROM quotes WHERE status_id = ?', quote(4))
			expect(
				sql.exec('SELECT authorization, actor_uri, pending FROM quote_revocations ORDER BY authorization').toArray()
			).toEqual([
				{ authorization: 'a', actor_uri: 'https://kopje.test/ap/users/u1', pending: 0 },
				{ authorization: 'b', actor_uri: 'https://kopje.test/ap/users/u1', pending: 0 },
			])
			sql.exec(
				`INSERT INTO quote_requests (activity_uri, actor_uri, instrument_uri, quoted_status_id, answered_at)
				VALUES ('r', 'x', 'i', 's', 1)`
			)
			expect(() =>
				sql.exec(
					`INSERT INTO quote_requests (activity_uri, actor_uri, instrument_uri, quoted_status_id, answered_at)
					VALUES ('r', 'y', 'i', 's', 2)`
				)
			).toThrow(/UNIQUE constraint failed/)
		})
	})

	// The ALTERs change the schema alone; the CHECK is tested against each stored quote (all NULL), so the rows read
	// grow with the quotes and with nothing else.
	it('reads the stored quotes once, for the CHECK, and nothing else', async () => {
		const measure = async (statuses: number, quotes: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, statuses, quotes)
				// The file in one call, as the kernel runs it.
				const cursor = sql.exec(MIGRATIONS[at]?.sql ?? '')
				cursor.toArray()
				const read = cursor.rowsRead
				expect(sql.exec('SELECT count(*) AS n FROM quotes WHERE authorization_id IS NULL').one()).toEqual({
					n: quotes,
				})
				return read
			})
		}
		const none = await measure(1, 0)
		expect(await measure(10_001, 0)).toBe(none)
		const some = (await measure(1_001, 1_000)) - none
		const twice = (await measure(2_001, 2_000)) - none
		expect(some).toBeLessThanOrEqual(2 * 1_000 + 2)
		expect(Math.abs(twice - 2 * some)).toBeLessThanOrEqual(2)
	}, 120_000)
})

describe('0039_quotes_local', () => {
	const NAME = '0039_quotes_local'
	const at = NAMES.indexOf(NAME)
	const status = (n: number) => String(200000000000000000n + BigInt(n))

	// A remote account with `statuses` public statuses, and `quotes` quotes among them (status i + 1 quoting status i,
	// each naming the stamp s<i>).
	function seed(sql: SqlStorage, statuses: number, quotes: number) {
		sql.exec(
			`INSERT INTO accounts (id, uri, username, domain)
			VALUES ('100000000000000001', 'https://remote.test/users/u1', 'u1', 'remote.test')`
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT CAST(200000000000000000 + i AS TEXT), 'https://remote.test/o/' || i, '100000000000000001', 'public',
				'x', '2026-10-12T00:00:00.000Z'
			FROM n WHERE ?1 > 0`,
			statuses
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, approval_uri, updated_at)
			SELECT CAST(200000000000000000 + i + 1 AS TEXT), 'https://remote.test/o/' || i,
				CAST(200000000000000000 + i AS TEXT), '100000000000000001', 'pending', 'https://remote.test/s' || i,
				'2026-10-12T00:00:00.000Z'
			FROM n WHERE ?1 > 0`,
			quotes
		)
	}

	it('marks every stored quote received, and keeps one local quote per stamp and quoted author', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seed(sql, 5, 4)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(sql.exec('SELECT DISTINCT local FROM quotes').toArray()).toEqual([{ local: 0 }])
			expect(() => sql.exec('UPDATE quotes SET local = 2 WHERE status_id = ?', status(2))).toThrow(
				/CHECK constraint failed/
			)
			// Received quotes may name one stamp many times; local ones once per quoted author.
			sql.exec(
				"UPDATE quotes SET approval_uri = 'https://remote.test/s' WHERE status_id IN (?, ?)",
				status(2),
				status(3)
			)
			sql.exec("UPDATE quotes SET local = 1, approval_uri = 'https://remote.test/t' WHERE status_id = ?", status(4))
			expect(() =>
				sql.exec("UPDATE quotes SET local = 1, approval_uri = 'https://remote.test/t' WHERE status_id = ?", status(5))
			).toThrow(/UNIQUE constraint failed/)
			sql.exec('UPDATE quotes SET local = 1, approval_uri = NULL WHERE status_id = ?', status(5))
			sql.exec('UPDATE quotes SET local = 1, approval_uri = NULL WHERE status_id = ?', status(3))
		})
	})

	// The ALTER's CHECK is tested against each stored quote, and the index reads each once: the rows read grow with the
	// quotes (linearly, give or take the index build's own page reads) and with nothing else.
	it('reads the stored quotes, and nothing else', async () => {
		const measure = async (statuses: number, quotes: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, statuses, quotes)
				const cursor = sql.exec(MIGRATIONS[at]?.sql ?? '')
				cursor.toArray()
				const read = cursor.rowsRead
				expect(sql.exec('SELECT count(*) AS n FROM quotes WHERE local = 0').one()).toEqual({ n: quotes })
				return read
			})
		}
		const none = await measure(1, 0)
		expect(await measure(10_001, 0)).toBe(none)
		const some = (await measure(1_001, 1_000)) - none
		const twice = (await measure(2_001, 2_000)) - none
		expect(some).toBeLessThanOrEqual(2 * 1_000 + 2)
		expect(Math.abs(twice - 2 * some)).toBeLessThanOrEqual(2)
	}, 120_000)
})

// The reporter and the reported account of the report notification migrations (0040, 0041).
const REPORTER = '100000000000000001'
const TARGET = '100000000000000002'

// A local reporter with `notifications` mentions of it by the target, and one report of the target.
function seedReport(sql: SqlStorage, notifications: number) {
	sql.exec(
		`INSERT INTO accounts (id, uri, username, domain) VALUES
			(?1, 'https://kopje.test/ap/users/r', 'r', NULL), (?2, 'https://remote.test/users/t', 't', 'remote.test')`,
		REPORTER,
		TARGET
	)
	sql.exec(
		"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'r@example.com', X'00', X'00', 'k')",
		REPORTER
	)
	sql.exec(
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		SELECT CAST(200000000000000000 + i AS TEXT), 'https://remote.test/o/' || i, ?2, 'public', 'x',
			'2026-10-12T00:00:00.000Z'
		FROM n WHERE ?1 > 0`,
		notifications,
		TARGET
	)
	sql.exec(
		`INSERT INTO notifications (account_id, type, from_account_id, status_id)
		SELECT ?1, 'mention', ?2, id FROM statuses`,
		REPORTER,
		TARGET
	)
	sql.exec(
		`INSERT INTO reports (id, account_id, target_account_id, uri, created_at)
		VALUES (7, ?, ?, 'https://kopje.test/actor#reports/7', '2026-10-12T00:00:00.000Z')`,
		REPORTER,
		TARGET
	)
}

describe('0040_report_notifications', () => {
	const NAME = '0040_report_notifications'
	const at = NAMES.indexOf(NAME)

	it("names a notification's report, which takes it along when deleted, and keeps the natural key", async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seedReport(sql, 2)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(sql.exec('SELECT DISTINCT report_id FROM notifications').toArray()).toEqual([{ report_id: null }])
			const admin =
				"INSERT INTO notifications (account_id, type, from_account_id, report_id) VALUES (?, 'admin.report', ?, ?)"
			expect(() => sql.exec(admin, REPORTER, TARGET, 8)).toThrow(/FOREIGN KEY constraint failed/)
			sql.exec(admin, REPORTER, TARGET, 7)
			// One admin.report per recipient and sender (notifications_natural is unchanged).
			sql.exec(
				`INSERT INTO reports (id, account_id, target_account_id, uri, created_at)
				VALUES (8, ?, ?, 'https://kopje.test/actor#reports/8', '2026-10-12T00:00:00.000Z')`,
				REPORTER,
				TARGET
			)
			expect(() => sql.exec(admin, REPORTER, TARGET, 8)).toThrow(/UNIQUE constraint failed/)
			const plan = sql
				.exec<{ detail: string }>('EXPLAIN QUERY PLAN SELECT id FROM notifications WHERE report_id = 7')
				.toArray()
				.map((row) => row.detail)
			expect(plan.join('\n')).toContain('notifications_report')
			sql.exec('DELETE FROM reports WHERE id = 7')
			expect(sql.exec("SELECT count(*) AS n FROM notifications WHERE type = 'admin.report'").one()).toEqual({ n: 0 })
			expect(sql.exec('SELECT count(*) AS n FROM notifications').one()).toEqual({ n: 2 })
		})
	})

	// The ALTER reads nothing; the partial index reads each notification once: the rows read grow with the
	// notifications (linearly, give or take the index build's own page reads) and with nothing else.
	it('reads the stored notifications, and nothing else', async () => {
		const measure = async (notifications: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seedReport(sql, notifications)
				const cursor = sql.exec(MIGRATIONS[at]?.sql ?? '')
				cursor.toArray()
				return cursor.rowsRead
			})
		}
		const none = await measure(0)
		const some = (await measure(1_000)) - none
		const twice = (await measure(2_000)) - none
		expect(some).toBeLessThanOrEqual(1_000 + 2)
		expect(Math.abs(twice - 2 * some)).toBeLessThanOrEqual(2)
	}, 120_000)
})

describe('0041_report_notifications_key', () => {
	const NAME = '0041_report_notifications_key'
	const at = NAMES.indexOf(NAME)

	it('keys an admin.report by its report, and every other notification as before', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seedReport(sql, 0)
			sql.exec(
				`INSERT INTO reports (id, account_id, target_account_id, uri, created_at)
				VALUES (8, ?, ?, 'https://kopje.test/actor#reports/8', '2026-10-12T00:00:00.000Z')`,
				REPORTER,
				TARGET
			)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			const admin =
				"INSERT INTO notifications (account_id, type, from_account_id, report_id) VALUES ('100000000000000001', 'admin.report', '100000000000000002', ?)"
			sql.exec(admin, 7)
			sql.exec(admin, 8)
			expect(() => sql.exec(admin, 8)).toThrow(/UNIQUE constraint failed/)
			const follow =
				"INSERT INTO notifications (account_id, type, from_account_id) VALUES ('100000000000000001', 'follow', '100000000000000002')"
			sql.exec(follow)
			expect(() => sql.exec(follow)).toThrow(/UNIQUE constraint failed/)
			const plan = sql
				.exec<{ detail: string }>(
					`EXPLAIN QUERY PLAN SELECT id FROM notifications WHERE account_id = '1' AND type = 'mention'
					AND from_account_id = '2' AND IFNULL(status_id, '') = '3'`
				)
				.toArray()
				.map((row) => row.detail)
			expect(plan.join('\n')).toContain('notifications_natural')
		})
	})
})

describe('0042_report_action_fence', () => {
	const NAME = '0042_report_action_fence'
	const at = NAMES.indexOf(NAME)
	const SUSPENDED_AT = '2026-10-12T00:00:00.000Z'
	// The file's statements, in order (its comments dropped; no statement holds a semicolon).
	const STATEMENTS = (MIGRATIONS[at]?.sql ?? '')
		.split('\n')
		.filter((line) => !line.startsWith('--'))
		.join('\n')
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement !== '')

	function log(sql: SqlStorage, id: number, action: string, type: 'Report' | 'Account', target: string, detail = {}) {
		sql.exec(
			`INSERT INTO admin_actions (id, actor, account_id, action, target_type, target_id, detail, created_at)
			VALUES (?, 'oauth', ?, ?, ?, ?, ?, '2026-10-12T00:00:00.000Z')`,
			id,
			REPORTER,
			action,
			type,
			target,
			JSON.stringify(detail)
		)
	}

	function report(sql: SqlStorage, id: number, target = TARGET) {
		sql.exec(
			`INSERT INTO reports (id, account_id, target_account_id, uri, created_at)
			VALUES (?1, ?2, ?3, 'https://kopje.test/actor#reports/' || ?1, '2026-10-12T00:00:00.000Z')`,
			id,
			REPORTER,
			target
		)
	}

	// REPORTER suspended at SUSPENDED_AT in epoch 1, its suspension job still in the report phase.
	function suspended(sql: SqlStorage) {
		sql.exec(
			'UPDATE local_accounts SET suspended_at = ?, credential_epoch = 1 WHERE account_id = ?',
			SUSPENDED_AT,
			REPORTER
		)
		sql.exec(
			`INSERT INTO moderation_jobs (kind, account_id, generation, since, report_bound, phase)
			VALUES ('suspension', ?, 1, ?, 1000, 'reports')`,
			REPORTER,
			SUSPENDED_AT
		)
	}

	it("carries each report's newest log id over, and each running suspension job's own suspend row", async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seedReport(sql, 0)
			report(sql, 8)
			report(sql, 9)
			log(sql, 1, 'resolve', 'Report', '7')
			log(sql, 2, 'suspend', 'Account', REPORTER, { suspended_at: '2026-10-11T00:00:00.000Z' })
			log(sql, 3, 'reopen', 'Report', '7')
			log(sql, 4, 'update', 'Report', '8')
			log(sql, 5, 'suspend', 'Account', REPORTER, { suspended_at: SUSPENDED_AT })
			sql.exec(
				"INSERT INTO moderation_jobs (kind, account_id, generation, phase) VALUES ('tokens', ?, 1, 'tokens')",
				REPORTER
			)
			// The first suspension's job, of an epoch that ended: it never resolves again, so it keeps NULL.
			sql.exec(
				`INSERT INTO moderation_jobs (kind, account_id, generation, since, phase)
				VALUES ('suspension', ?, 0, '2026-10-11T00:00:00.000Z', 'reports')`,
				REPORTER
			)
			suspended(sql)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(sql.exec('SELECT id, last_action_id FROM reports ORDER BY id').toArray()).toEqual([
				{ id: 7, last_action_id: 3 },
				{ id: 8, last_action_id: 4 },
				{ id: 9, last_action_id: null },
			])
			expect(sql.exec('SELECT kind, action_bound FROM moderation_jobs ORDER BY id').toArray()).toEqual([
				{ kind: 'tokens', action_bound: null },
				{ kind: 'suspension', action_bound: null },
				{ kind: 'suspension', action_bound: 5 },
			])
			// The jobs are sought by their unique key, from the suspended accounts, never scanned.
			const plan = sql
				.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${STATEMENTS.at(-1)}`)
				.toArray()
				.map((row) => row.detail)
				.join('\n')
			expect(plan).toMatch(
				/SEARCH moderation_jobs USING INDEX sqlite_autoindex_moderation_jobs_1 \(account_id=\? AND kind=\? AND generation=\?\)/
			)
			expect(plan).not.toMatch(/SCAN moderation_jobs/)
		})
	})

	// Before the upgrade: REPORTER is suspended, then the admin reopens a report on REPORTER; `pruned` drops both log
	// rows before the upgrade, while the job is still pending. The job's first round then runs.
	async function reopenedAcrossUpgrade(pruned: boolean) {
		const store = freshStore()
		return runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, MIGRATIONS.slice(0, at)).upgrade()).toMatchObject({ ok: true })
			seedReport(sql, 0)
			report(sql, 10, REPORTER)
			report(sql, 11, REPORTER)
			log(sql, 1, 'resolve', 'Report', '10')
			log(sql, 2, 'suspend', 'Account', REPORTER, { suspended_at: SUSPENDED_AT })
			log(sql, 3, 'reopen', 'Report', '10')
			log(sql, 4, 'update', 'Report', '7')
			suspended(sql)
			if (pruned) {
				sql.exec('DELETE FROM admin_actions WHERE id <= 3')
			}
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			state.storage.transactionSync(() => moderationRound(new Db(sql), Date.parse(SUSPENDED_AT)))
			return {
				bound: sql.exec('SELECT action_bound FROM moderation_jobs').one().action_bound,
				reports: sql
					.exec('SELECT id, action_taken_at IS NOT NULL AS resolved FROM reports WHERE id >= 10 ORDER BY id')
					.toArray(),
			}
		})
	}

	it('leaves open a report reopened after a suspension from before the upgrade, also when the log was pruned', async () => {
		expect(await reopenedAcrossUpgrade(false)).toEqual({
			bound: 2,
			reports: [
				{ id: 10, resolved: 0 },
				{ id: 11, resolved: 1 },
			],
		})
		// The suspension's row is gone, so its bound is unknown: the job resolves none, and leaves them to the admin.
		expect(await reopenedAcrossUpgrade(true)).toEqual({
			bound: null,
			reports: [
				{ id: 10, resolved: 0 },
				{ id: 11, resolved: 0 },
			],
		})
	})

	type Scale = { reports?: number; log?: number; current?: number; obsolete?: number }

	// The rows each statement of the file reads, summed, on a store of `reports` reports, `log` logged report writes,
	// `current` suspended accounts each with its suspend row and its job in the report phase, and `obsolete` jobs of
	// epochs that ended (REPORTER's, which has a suspend row too).
	async function cost({ reports = 0, log = 0, current = 0, obsolete = 0 }: Scale) {
		const store = freshStore()
		return runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			seedReport(sql, 0)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 8 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + 7)
				INSERT INTO reports (id, account_id, target_account_id, uri, created_at)
				SELECT i, ?2, ?3, 'https://kopje.test/actor#reports/' || i, '2026-10-12T00:00:00.000Z' FROM n WHERE ?1 > 0`,
				reports,
				REPORTER,
				TARGET
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO admin_actions (actor, account_id, action, target_type, target_id, created_at)
				SELECT 'oauth', ?2, 'update', 'Report', '7', '2026-10-12T00:00:00.000Z' FROM n WHERE ?1 > 0`,
				log,
				REPORTER
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(300000000000000000 + i AS TEXT), 'https://kopje.test/ap/users/s' || i, 's' || i, NULL
				FROM n WHERE ?1 > 0`,
				current
			)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, suspended_at, credential_epoch)
				SELECT id, username || '@example.com', X'00', X'00', 'k', ?1, 2 FROM accounts WHERE username GLOB 's*'`,
				SUSPENDED_AT
			)
			sql.exec(
				`INSERT INTO moderation_jobs (kind, account_id, generation, since, phase)
				SELECT 'suspension', account_id, 2, ?1, 'reports' FROM local_accounts WHERE credential_epoch = 2`,
				SUSPENDED_AT
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO moderation_jobs (kind, account_id, generation, since, phase)
				SELECT 'suspension', ?2, i, ?3, 'reports' FROM n WHERE ?1 > 0`,
				obsolete,
				REPORTER,
				SUSPENDED_AT
			)
			sql.exec(
				`INSERT INTO admin_actions (actor, account_id, action, target_type, target_id, detail, created_at)
				SELECT 'oauth', ?1, 'suspend', 'Account', account_id, json_object('suspended_at', ?2), ?2
				FROM local_accounts`,
				REPORTER,
				SUSPENDED_AT
			)
			let read = 0
			for (const statement of STATEMENTS) {
				const cursor = sql.exec(statement)
				cursor.toArray()
				read += cursor.rowsRead
			}
			expect(sql.exec('SELECT count(*) AS n FROM moderation_jobs WHERE action_bound IS NOT NULL').one()).toEqual({
				n: current,
			})
			return read
		})
	}

	// The carry-over reads the log twice and seeks each suspended account's current job: the rows read grow with the
	// log and the current jobs, and never with the reports or with jobs of epochs that ended.
	it('reads the log and the current jobs, and nothing that grows with the reports or obsolete jobs', async () => {
		const none = await cost({})
		const logged = (await cost({ log: 1_000 })) - none
		const twice = (await cost({ log: 2_000 })) - none
		expect(logged).toBeGreaterThanOrEqual(2 * 1_000)
		expect(logged).toBeLessThanOrEqual(3 * 1_000 + 3)
		expect(Math.abs(twice - 2 * logged)).toBeLessThanOrEqual(3)
		expect(await cost({ reports: 10_000 })).toBe(none)
		const jobs = (await cost({ current: 100 })) - none
		const jobsTwice = (await cost({ current: 200 })) - none
		expect(jobs).toBeGreaterThan(0)
		expect(Math.abs(jobsTwice - 2 * jobs)).toBeLessThanOrEqual(3)
		// The log at its cap, and a backlog of 5,000 jobs of ended epochs, besides the current ones.
		const capped = await cost({ log: MODERATION_LOG_KEEP, current: 100 })
		expect(await cost({ log: MODERATION_LOG_KEEP, current: 100, obsolete: 5_000, reports: 10_000 })).toBe(capped)
	}, 300_000)
})

describe('0044_delivery_provenance', () => {
	const NAME = '0044_delivery_provenance'
	const at = NAMES.indexOf(NAME)

	// The rows the file reads on a store of `deliveries` queued rows, and what an old row holds after it.
	async function upgrade(deliveries: number) {
		const store = freshStore()
		return runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES ('100000000000000001', 'https://kopje.test/ap/users/a', 'a')"
			)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				VALUES ('100000000000000001', 'a@example.com', X'00', X'00', 'k')`
			)
			sql.exec(
				`INSERT INTO outbound_activities (id, account_id, body, created_at)
				VALUES (1, '100000000000000001', '{"activity":{"type":"Create"},"audience":{"followers":true,"accounts":[]}}', 0)`
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
				SELECT 1, '100000000000000001', 'https://s' || i || '.example/inbox', 'https://s' || i || '.example',
					'pending', 0, 0 FROM n WHERE ?1 > 0`,
				deliveries
			)
			const cursor = sql.exec(MIGRATIONS[at]?.sql ?? '')
			cursor.toArray()
			return {
				read: cursor.rowsRead,
				written: cursor.rowsWritten,
				first: sql
					.exec('SELECT recipient_accounts, recipient_domains, recipients_many FROM deliveries ORDER BY id LIMIT 1')
					.toArray(),
			}
		})
	}

	// Each ALTER changes the schema alone: no row is read or written, however many deliveries are queued.
	it('reads and writes no delivery, and leaves queued rows without provenance', async () => {
		const none = await upgrade(0)
		const many = await upgrade(10_000)
		expect(many.read).toBe(none.read)
		expect(many.written).toBe(none.written)
		expect(many.first).toEqual([{ recipient_accounts: null, recipient_domains: null, recipients_many: null }])
	}, 120_000)
})

describe('0045_remote_suspension', () => {
	const NAME = '0045_remote_suspension'
	const at = NAMES.indexOf(NAME)
	const statements = (MIGRATIONS[at]?.sql ?? '')
		.split('\n')
		.filter((line) => !line.startsWith('--'))
		.join('\n')
		.split(';')
		.filter((statement) => statement.trim() !== '')

	// `accounts` remote accounts, every second one being deleted, with `follows` follows of each; and one local account.
	function seed(sql: SqlStorage, accounts: number, follows: number) {
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, deleted_at) SELECT CAST(100000000000000000 + i AS TEXT),
				'https://remote.example/users/u' || i, 'u' || i, 'remote.example',
				CASE WHEN i % 2 = 0 THEN '2026-10-01T00:00:00.000Z' END FROM n`,
			accounts
		)
		sql.exec(
			"INSERT INTO accounts (id, uri, username) VALUES ('900000000000000000', 'https://kopje.test/ap/users/l', 'l')"
		)
		for (let k = 1; k <= follows; k++) {
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
				INSERT INTO follows (account_id, target_account_id, state) SELECT CAST(100000000000000000 + i AS TEXT),
					CAST(100000000000000000 + (i + CAST(?2 AS INTEGER)) % CAST(?1 AS INTEGER) AS TEXT), 'accepted' FROM n`,
				accounts,
				k
			)
		}
	}

	it('indexes the suspended and the active accounts by id, and drops the index it replaces', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			seed(sql, 4, 0)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			const at0 = '2026-10-18T00:00:00.000Z'
			sql.exec(
				"UPDATE accounts SET suspended_at = ?, suspension_source = 'account' WHERE id = '100000000000000001'",
				at0
			)
			const plan = (query: string) =>
				sql
					.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
					.toArray()
					.map((row) => row.detail)
			const suspended = 'SELECT id FROM accounts INDEXED BY accounts_suspended WHERE suspended_at IS NOT NULL'
			expect(sql.exec(suspended).toArray()).toEqual([{ id: '100000000000000001' }])
			expect(plan(suspended)).toEqual(['SCAN accounts USING INDEX accounts_suspended'])
			const active =
				'SELECT id FROM accounts INDEXED BY accounts_active WHERE deleted_at IS NULL AND suspended_at IS NULL ORDER BY id'
			expect(sql.exec(active).toArray()).toEqual([{ id: '100000000000000003' }, { id: '900000000000000000' }])
			expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'accounts_available'").toArray()).toEqual([])
			const unsuperseded =
				"SELECT id FROM outbound_activities WHERE account_id = 'a' AND object_uri = 'o' AND superseded = 0 ORDER BY id"
			expect(plan(unsuperseded)).toEqual([
				'SEARCH outbound_activities USING COVERING INDEX outbound_activities_unsuperseded (account_id=? AND object_uri=?)',
			])
			sql.exec(
				"INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, phase) VALUES ('account', 'x', 'account', 0, 'reports')"
			)
			expect(() =>
				sql.exec(
					"INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, phase) VALUES ('account', 'x', 'account', 0, 'reports')"
				)
			).toThrow(/UNIQUE constraint failed/)
			expect(() =>
				sql.exec(
					"INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, phase) VALUES ('silence', 'y', 'account', 0, 'reports')"
				)
			).toThrow(/CHECK constraint failed/)
		})
	})

	it('reads each account a bounded number of times, and no follow', async () => {
		const measure = async (accounts: number, follows: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				seed(sql, accounts, follows)
				let read = 0
				let written = 0
				for (const statement of statements) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
					written += cursor.rowsWritten
				}
				return { read, written }
			})
		}
		const few = await measure(1000, 0)
		const crowded = await measure(1000, 30)
		const many = await measure(10_000, 0)
		// The two index builds read the accounts a bounded number of times; the follows are not read.
		expect(crowded.read).toBeLessThanOrEqual(few.read + 10)
		expect(many.read - few.read).toBeLessThanOrEqual(4 * (10_000 - 1000))
		expect(many.read).toBeGreaterThan(few.read)
		// The index of the active accounts holds every available one; nothing else is written per account.
		expect(many.written - few.written).toBeLessThanOrEqual(2 * (10_000 - 1000))
	}, 120_000)
})

describe('0046_instance_domain_blocks', () => {
	const NAME = '0046_instance_domain_blocks'
	const at = NAMES.indexOf(NAME)

	it('stores one block per domain with an id never given twice, refuses a deeper or unnormalized domain, and seeks suspend blocks', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			// Nothing of the existing schema is read: a store with accounts upgrades the same way.
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES ('100000000000000001', 'https://r.example/u', 'u', 'r.example')"
			)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			const insert = (domain: string, severity = 'suspend') =>
				sql
					.exec<{ id: number }>(
						"INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at) VALUES (?, ?, 'x', 'x') RETURNING id",
						domain,
						severity
					)
					.one().id
			expect(insert('a.example')).toBe(1)
			expect(() => insert('a.example', 'noop')).toThrow(/UNIQUE constraint failed/)
			for (const refused of ['A.example', 'example', 'a.b.c.d.e.f.g.h.example', '']) {
				expect(() => insert(refused)).toThrow(/CHECK constraint failed/)
			}
			expect(() => insert('b.example', 'silence')).toThrow(/CHECK constraint failed/)
			expect(insert('a.b.c.d.e.f.g.example', 'noop')).toBe(2)
			sql.exec('DELETE FROM instance_domain_blocks WHERE id = 2')
			expect(insert('c.example')).toBe(3)
			const plan = sql
				.exec<{ detail: string }>(
					`EXPLAIN QUERY PLAN SELECT 1 FROM instance_domain_blocks INDEXED BY instance_domain_blocks_suspend
					WHERE severity = 'suspend'`
				)
				.toArray()
				.map((row) => row.detail)
			expect(plan).toEqual(['SCAN instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend'])
		})
	})
})

describe('0047_status_mentions_shown', () => {
	const NAME = '0047_status_mentions_shown'
	const at = NAMES.indexOf(NAME)

	it('indexes the mentions that are not silent, built over the existing rows, as the presenter reads them', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					('100000000000000001', 'https://r.example/a', 'a', 'r.example'),
					('100000000000000002', 'https://r.example/b', 'b', 'r.example')`
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				VALUES ('200000000000000001', 'https://r.example/s', '100000000000000001', 'public', 'x')`
			)
			sql.exec(
				`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id) VALUES
					('200000000000000001', '100000000000000001', 1, 0, '100000000000000001'),
					('200000000000000001', '100000000000000002', 0, 0, '100000000000000001')`
			)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			const shown = sql
				.exec<{ account_id: string }>(
					`SELECT account_id FROM status_mentions INDEXED BY status_mentions_shown
					WHERE status_id = '200000000000000001' AND silent = 0 ORDER BY account_id LIMIT 200`
				)
				.toArray()
			expect(shown).toEqual([{ account_id: '100000000000000002' }])
			const plan = sql
				.exec<{ detail: string }>(
					`EXPLAIN QUERY PLAN SELECT account_id FROM status_mentions INDEXED BY status_mentions_shown
					WHERE status_id = ?1 AND silent = 0 ORDER BY account_id LIMIT 200`,
					'200000000000000001'
				)
				.toArray()
				.map((row) => row.detail)
			expect(plan).toEqual(['SEARCH status_mentions USING COVERING INDEX status_mentions_shown (status_id=?)'])
		})
	})
})

describe('0048_stored_bounds', () => {
	const NAME = '0048_stored_bounds'
	const at = NAMES.indexOf(NAME)
	const REFUSED = (table: string) => new RegExp(`${table}: a value past its stored bound`)

	it("holds storedBoundsMigrationSql's output after its header", () => {
		expectGenerated(at, storedBoundsMigrationSql())
	})

	it('stores each covered value as P(x), keeps values at their bounds, and leaves only fixed points', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			seedBounded(sql)
			const tables = TABLES
			const expected = tables.map((table) => sql.exec(storedSql(table)).toArray())
			for (const table of tables) {
				expect(sql.exec<{ n: number }>(movedCountSql(table)).one().n, table).toBeGreaterThanOrEqual(2)
			}

			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			// Each stored value is, byte for byte (hex), P of the value before, row by row.
			expect(tables.map((table) => sql.exec(columnsSql(table)).toArray())).toEqual(expected)
			expect(tables.map((table) => sql.exec<{ n: number }>(movedCountSql(table)).one().n)).toEqual([0, 0, 0, 0])
			// The rows at their bounds are unchanged; the JSON-bounded values of 400,000 U+0001 are past their bounds.
			for (const table of tables) {
				const rows = sql.exec(textSql(table)).toArray()
				expect(rows[0]).toMatchObject(valuesOf(table, 'at'))
				const flood = rows[2] ?? {}
				for (const { column } of JSON_BOUNDED.filter((j) => j.table === table)) {
					expect(flood[column]).toBe(column === 'spoiler_text' ? '\u0001'.repeat(2730) : '')
				}
			}
			// Lone surrogate bytes are cut by SQLite's characters: the display name at its bound is kept, the one past it
			// keeps 2,048 of its three-byte characters.
			const names = sql
				.exec<{ bytes: number }>(
					"SELECT length(CAST(display_name AS BLOB)) AS bytes FROM accounts WHERE hex(display_name) GLOB 'EDA080*'"
				)
				.toArray()
			expect(names).toEqual([{ bytes: 3 * 2048 }, { bytes: 3 * 2048 }])
			// A media URL past its bound is stored as '', the column being NOT NULL.
			expect(sql.exec("SELECT count(*) AS n FROM media_attachments WHERE url = ''").one().n).toBe(2)
		})
	}, 120_000)

	it('refuses a value one past its bound on insert and update, and accepts one at it', async () => {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const insert = inserter(sql)
			insert('accounts', {})
			insert('statuses', {})
			for (const { table, column, at: value, past } of BOUNDED) {
				const own = insert(table, { [column]: value })
				const key = table === 'status_edits' ? 'rowid' : 'id'
				for (const over of past) {
					expect(() => insert(table, { [column]: over }), `${table}.${column}`).toThrow(REFUSED(table))
					expect(() => sql.exec(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`, over, own)).toThrow(
						REFUSED(table)
					)
				}
				sql.exec(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`, value, own)
				expect(sql.exec(`SELECT ${column} AS v FROM ${table} WHERE ${key} = ?`, own).one().v).toBe(value)
			}
		})
	}, 120_000)

	it('fails by its check on an uploaded media URL past the bound, and leaves the Store unmigrated', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			seedBounded(sql)
			sql.exec(
				"UPDATE media_attachments SET file_token = 'token', url = ? WHERE id = '300000000000000001'",
				'https://kopje.test/'.padEnd(2049, 'x')
			)
			const before = TABLES.map((table) => sql.exec(columnsSql(table)).toArray())
			const result = await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()
			expect(result).toMatchObject({ ok: false, reason: 'upgrade-failed' })
			expect(result.ok === false && result.detail).toContain(
				'CHECK constraint failed: tokened_media_url_within_2048_bytes'
			)
			expect(bookkeeping(sql).map((m) => m.name)).toEqual(NAMES.slice(0, at))
			expect(TABLES.map((table) => sql.exec(columnsSql(table)).toArray())).toEqual(before)
			expect(
				sql.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB '*_bounds_*'").toArray()
			).toEqual([])
		})
	}, 120_000)
})

describe('0049_instance_bounds', () => {
	const NAME = '0049_instance_bounds'
	const at = NAMES.indexOf(NAME)
	const REFUSED = /instance_settings: a value past its stored bound/
	const astral = '\u{1F600}'
	const ENCODER = new TextEncoder()
	const bytes = (text: string) => ENCODER.encode(text).length
	// 50,000 UTF-8 bytes exactly, of three-byte characters and two ASCII ones.
	const documentAt = `${'日'.repeat(16_666)}aa`
	const emailAt = `${'a'.repeat(254 - '@example.com'.length)}@example.com`
	const rulesAt = JSON.stringify([`${'r'.repeat(65_536 - 4)}`])
	// Each covered name at its bound (kept), and one past it in its unit (refused, and rewritten by the migration).
	const BOUNDS: Record<InstanceSettingName, { at: string; past: string[] }> = {
		title: { at: astral.repeat(1024), past: [astral.repeat(1025), `${'t'.repeat(1024)}\u3000`] },
		description: { at: astral.repeat(200), past: [astral.repeat(201)] },
		contact_email: { at: emailAt, past: [`a${emailAt}`] },
		rules: { at: rulesAt, past: [JSON.stringify([`${'r'.repeat(65_536 - 3)}`]), '{"a":1}', '[1,', ''] },
		extended_description: { at: documentAt, past: [`${documentAt}a`, ' \t\n\v\f\r'] },
		privacy_policy: { at: documentAt, past: [`${documentAt}a`, ''] },
		terms_of_service: { at: documentAt, past: [`${documentAt}a`, '\v'] },
		terms_of_service_effective_date: {
			at: '2026-11-01',
			past: ['2026-02-30', '2026-1-05', ' 2026-11-01', '2026-11-1 '],
		},
		show_domain_blocks: { at: 'users', past: ['everyone', 'Users', 'all '] },
		show_domain_blocks_rationale: { at: 'all', past: ['', 'disabled\u0000'] },
		extended_description_updated_at: {
			at: '2026-10-19T00:00:00.000Z',
			past: ['2026-10-19T00:00:00Z', '2026-10-19T24:00:00.000Z', '2026-02-30T00:00:00.000Z'],
		},
		privacy_policy_updated_at: { at: '9999-12-31T23:59:59.999Z', past: ['2026-10-19 00:00:00.000Z'] },
	}
	// Names 0049 does not cover, with values far past any covered bound.
	const UNCOVERED = { domain: 'd'.repeat(70_000), admin_email: ' ', web_client_id: '' }
	const rows = (sql: SqlStorage) =>
		sql.exec<{ name: string; value: string }>('SELECT name, value FROM instance_settings ORDER BY name').toArray()
	const insert = (sql: SqlStorage, values: Record<string, string>) => {
		for (const [name, value] of Object.entries(values)) {
			sql.exec('INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', name, value)
		}
	}

	it("holds instanceBoundsMigrationSql's output after its header", () => {
		expectGenerated(at, instanceBoundsMigrationSql())
	})

	it('measures each bound in its unit', () => {
		expect([bytes(documentAt), documentAt.length, bytes(emailAt), bytes(rulesAt)]).toEqual([
			50_000, 16_668, 254, 65_536,
		])
		expect([...BOUNDS.title.at].length).toBe(1024)
		expect(bytes(BOUNDS.rules.past[0] ?? '')).toBe(65_537)
	})

	// One round per value of each name (a name holds one row): every value at its bound, then each value past it in
	// turn, with the uncovered names beside them.
	const rounds: Record<string, string>[] = [
		Object.fromEntries(INSTANCE_SETTING_NAMES.map((name) => [name, BOUNDS[name].at])),
		...[0, 1, 2, 3].map((i) =>
			Object.fromEntries(
				INSTANCE_SETTING_NAMES.flatMap((name) => {
					const past = BOUNDS[name].past[i]
					return past === undefined ? [] : [[name, past]]
				})
			)
		),
	]
	for (const [round, values] of rounds.entries()) {
		it(`stores each covered value as P(x) and leaves the other names alone (round ${round})`, async () => {
			const store = freshStore()
			await runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				insert(sql, { ...values, ...UNCOVERED })
				const expected = rows(sql).flatMap(({ name, value }) => {
					const bound = INSTANCE_SETTING_BOUNDS[name as InstanceSettingName]
					if (bound === undefined) {
						return [{ name, value }]
					}
					const stored = sql.exec<{ v: string | null }>(`SELECT ${bound.projection('?1')} AS v`, value).one().v
					// The writer agrees with P on these normalized values.
					expect(storedInstanceSetting(name as InstanceSettingName, value), name).toBe(stored)
					return stored === null ? [] : [{ name, value: stored }]
				})
				expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
				expect(rows(sql)).toEqual(expected)
				if (round === 0) {
					expect(rows(sql)).toHaveLength(INSTANCE_SETTING_NAMES.length + 3)
				} else {
					// Only the cut names keep a row past their bound, cut.
					expect(rows(sql).map((row) => row.name)).toEqual(
						[
							'admin_email',
							'domain',
							'web_client_id',
							...(round === 1 ? ['description', 'title'] : round === 2 ? ['title'] : []),
						].sort()
					)
				}
			})
		}, 120_000)
	}

	it('refuses a value one past its bound on insert and update, and accepts one at it', async () => {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			for (const name of INSTANCE_SETTING_NAMES) {
				const { at: value, past } = BOUNDS[name]
				for (const over of past) {
					expect(() => sql.exec('INSERT INTO instance_settings (name, value) VALUES (?, ?)', name, over), name).toThrow(
						REFUSED
					)
				}
				sql.exec('INSERT INTO instance_settings (name, value) VALUES (?, ?)', name, value)
				for (const over of past) {
					expect(() => sql.exec('UPDATE instance_settings SET value = ? WHERE name = ?', over, name), name).toThrow(
						REFUSED
					)
				}
				expect(sql.exec('SELECT value AS v FROM instance_settings WHERE name = ?', name).one().v).toBe(value)
			}
			// A rename into a covered name is checked too; uncovered names take anything.
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('scratch', ?)", 'x'.repeat(300))
			expect(() =>
				sql.exec("UPDATE instance_settings SET name = 'contact_email_x' WHERE name = 'scratch'")
			).not.toThrow()
			sql.exec("DELETE FROM instance_settings WHERE name = 'contact_email'")
			expect(() =>
				sql.exec("UPDATE instance_settings SET name = 'contact_email' WHERE name = 'contact_email_x'")
			).toThrow(REFUSED)
			insert(sql, UNCOVERED)
			// A Unicode space is text, not blank.
			expect(() => sql.exec("UPDATE instance_settings SET value = '\u3000' WHERE name = 'title'")).not.toThrow()
		})
	}, 120_000)

	it("indexes the suspend blocks by domain, which the public list's chunk query searches", async () => {
		const store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			const plan = state.storage.sql
				.exec<{ detail: string }>(
					`EXPLAIN QUERY PLAN SELECT domain, obfuscate, public_comment FROM instance_domain_blocks
					INDEXED BY instance_domain_blocks_public WHERE severity = 'suspend' AND domain > ?1 ORDER BY domain LIMIT 500`,
					''
				)
				.toArray()
				.map((row) => row.detail)
			expect(plan).toEqual(['SEARCH instance_domain_blocks USING INDEX instance_domain_blocks_public (domain>?)'])
		})
	})
})

describe('0050_follow_recommendation_mutes', () => {
	const NAME = '0050_follow_recommendation_mutes'
	const at = NAMES.indexOf(NAME)

	it('stores one dismissal per local account and known account, gone with either, found by target', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			// Nothing of the existing schema is read: a store with accounts upgrades the same way.
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					('100000000000000001', 'https://kopje.test/ap/users/a', 'a', NULL),
					('100000000000000002', 'https://r.example/b', 'b', 'r.example'),
					('100000000000000003', 'https://r.example/c', 'c', 'r.example')`
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES ('100000000000000001', 'a@example.com', X'00', X'00', 'test')"
			)
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			const dismiss = (owner: string, target: string) =>
				sql.exec('INSERT INTO follow_recommendation_mutes (account_id, target_account_id) VALUES (?, ?)', owner, target)
			dismiss('100000000000000001', '100000000000000002')
			dismiss('100000000000000001', '100000000000000003')
			expect(() => dismiss('100000000000000001', '100000000000000002')).toThrow(/UNIQUE constraint failed/)
			// The owner is a local account, the target a known one.
			expect(() => dismiss('100000000000000002', '100000000000000003')).toThrow(/FOREIGN KEY constraint failed/)
			expect(() => dismiss('100000000000000001', '100000000000000009')).toThrow(/FOREIGN KEY constraint failed/)
			const { created_at } = sql
				.exec<{ created_at: string }>('SELECT created_at FROM follow_recommendation_mutes LIMIT 1')
				.one()
			expect(created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
			const plan = sql
				.exec<{ detail: string }>(
					'EXPLAIN QUERY PLAN SELECT account_id FROM follow_recommendation_mutes WHERE target_account_id = ?',
					'100000000000000002'
				)
				.toArray()
				.map((row) => row.detail)
			expect(plan).toEqual([
				'SEARCH follow_recommendation_mutes USING COVERING INDEX follow_recommendation_mutes_target (target_account_id=?)',
			])
			sql.exec("DELETE FROM accounts WHERE id = '100000000000000003'")
			expect(sql.exec('SELECT target_account_id FROM follow_recommendation_mutes').toArray()).toEqual([
				{ target_account_id: '100000000000000002' },
			])
		})
	})
})

describe('0051_follow_answer_pairs', () => {
	const NAME = '0051_follow_answer_pairs'
	const at = NAMES.indexOf(NAME)
	const LOCAL = '100000000000000001'
	const REMOTE = '100000000000000002'
	const answer = (type: string, objectType: string, actor: string) =>
		JSON.stringify({
			activity: {
				type,
				actor: 'https://kopje.test/ap/users/a',
				object: { id: 'https://r.example/f/1', type: objectType, actor, object: 'https://kopje.test/ap/users/a' },
			},
			audience: { followers: false, accounts: [REMOTE] },
		})

	it('tags every Follow answer with its remote pair, exposes their existing rows, and nothing else', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					(?1, 'https://kopje.test/ap/users/a', 'a', NULL), (?2, 'https://r.example/u', 'u', 'r.example')`,
				LOCAL,
				REMOTE
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				LOCAL
			)
			const bodies = [
				answer('Accept', 'Follow', 'https://r.example/u'),
				answer('Reject', 'Follow', 'https://r.example/u'),
				// Not tagged: a QuoteRequest's answer, another activity, an answer to an actor never stored, and one to a
				// local actor's Follow.
				answer('Accept', 'QuoteRequest', 'https://r.example/u'),
				'{"activity":{"type":"Create","object":{"type":"Note"}},"audience":{"followers":true,"accounts":[]}}',
				answer('Accept', 'Follow', 'https://gone.example/u'),
				answer('Accept', 'Follow', 'https://kopje.test/ap/users/a'),
			]
			for (const [i, body] of bodies.entries()) {
				sql.exec(
					'INSERT INTO outbound_activities (id, account_id, body, created_at) VALUES (?, ?, ?, 0)',
					i + 1,
					LOCAL,
					body
				)
				sql.exec(
					`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
					VALUES (?, ?, 'https://r.example/inbox', 'https://r.example', ?, 0, 0)`,
					i + 1,
					LOCAL,
					i % 2 === 0 ? 'pending' : 'gave_up'
				)
			}
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(
				sql
					.exec(
						'SELECT o.id, o.follow_pair, d.exposed FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id ORDER BY o.id'
					)
					.toArray()
			).toEqual([
				{ id: 1, follow_pair: REMOTE, exposed: 1 },
				{ id: 2, follow_pair: REMOTE, exposed: 1 },
				{ id: 3, follow_pair: null, exposed: 0 },
				{ id: 4, follow_pair: null, exposed: 0 },
				{ id: 5, follow_pair: null, exposed: 0 },
				{ id: 6, follow_pair: null, exposed: 0 },
			])
			expect(() => sql.exec('UPDATE deliveries SET exposed = 2 WHERE id = 1')).toThrow(/CHECK constraint failed/)
			const plan = (query: string) =>
				sql
					.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
					.toArray()
					.map((row) => row.detail)
			expect(
				plan(
					`SELECT d.id FROM outbound_activities o INDEXED BY outbound_activities_follow_swept
					CROSS JOIN deliveries d INDEXED BY deliveries_activity ON d.activity_id = o.id
					WHERE o.follow_pair IS NOT NULL AND o.superseded = 1 AND d.state = 'gave_up' ORDER BY o.id LIMIT 500`
				)
			).toEqual([
				'SCAN o USING INDEX outbound_activities_follow_swept',
				'SEARCH d USING INDEX deliveries_activity (activity_id=?)',
			])
		})
	})
})

describe('0052_favourite_likes', () => {
	const NAME = '0052_favourite_likes'
	const at = NAMES.indexOf(NAME)

	it('copies nothing: favourites keep their uri; the new table holds each id once, within its bound and cap', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice', NULL),
					('100000000000000002', 'https://r.example/u/bob', 'bob', 'r.example')`
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES
					('200000000000000001', 'https://kopje.test/ap/o/1', '100000000000000001', 'public', 'x'),
					('200000000000000002', 'https://kopje.test/ap/o/2', '100000000000000001', 'public', 'x')`
			)
			sql.exec(
				`INSERT INTO favourites (id, account_id, status_id, uri, created_at) VALUES
					(1, '100000000000000001', '200000000000000002', 'https://kopje.test/ap/users/alice#likes/1', 'x'),
					(2, '100000000000000002', '200000000000000001', 'https://r.example/likes/2', 'x'),
					(3, '100000000000000002', '200000000000000002', 'https://r.example/likes/3', 'x')`
			)
			const before = sql.exec('SELECT * FROM favourites ORDER BY id').toArray()
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(sql.exec('SELECT * FROM favourites ORDER BY id').toArray()).toEqual(before)
			expect(sql.exec('SELECT count(*) AS n FROM favourite_likes').one().n).toBe(0)
			const planOf = (query: string, ...params: string[]) =>
				sql
					.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
					.toArray()
					.map((row) => row.detail)
			// An Undo's lookup (inbox.ts trackedLike, interactionOf) names favourite_likes_uri: the actor's favourites,
			// any number, are never ranged over.
			expect(
				planOf(
					`SELECT l.id FROM favourite_likes l INDEXED BY favourite_likes_uri
					JOIN favourites f ON f.id = l.favourite_id WHERE l.uri = ? AND f.account_id = ?`,
					'https://r.example/likes/2',
					'100000000000000002'
				)
			).toEqual(['SEARCH l USING INDEX favourite_likes_uri (uri=?)', 'SEARCH f USING INTEGER PRIMARY KEY (rowid=?)'])
			// A retained id, the actor's own (inbox.ts retainedLike) and any actor's (like's admission), one seek each.
			expect(
				planOf(
					`SELECT f.id, f.status_id FROM favourites f INDEXED BY favourites_like_uri
					WHERE f.uri = ? AND f.account_id = ? LIMIT 1`,
					'https://r.example/likes/2',
					'100000000000000002'
				)
			).toEqual(['SEARCH f USING INDEX favourites_like_uri (uri=? AND account_id=?)'])
			expect(
				planOf(
					'SELECT 1 FROM favourites INDEXED BY favourites_like_uri WHERE uri = ? LIMIT 1',
					'https://r.example/likes/2'
				)
			).toEqual(['SEARCH favourites USING COVERING INDEX favourites_like_uri (uri=?)'])
			const insert = (favourite: number, uri: string) =>
				sql.exec('INSERT INTO favourite_likes (favourite_id, uri, received_at) VALUES (?, ?, 0)', favourite, uri)
			// Favourite 2 retains its id, which counts: three rows make its four.
			for (let n = 0; n < 3; n++) {
				insert(2, `https://r.example/likes/2-${n}`)
			}
			// The cap, a repeated id (for another favourite too) and an id past ACTIVITY_ID_LIMIT, as an import writes them.
			expect(() => insert(2, 'https://r.example/likes/2-x')).toThrow(
				/favourite_likes: more than 4 Like ids for one favourite/
			)
			expect(() => insert(3, 'https://r.example/likes/2-0')).toThrow(/UNIQUE constraint failed: favourite_likes.uri/)
			const long = `https://r.example/likes/${'x'.repeat(4097 - 'https://r.example/likes/'.length)}`
			expect(() => insert(3, long)).toThrow(/like_id_within_4096_json_bytes/)
			insert(3, long.slice(0, -1))
			// A favourite's delete takes its ids.
			sql.exec('DELETE FROM favourites WHERE id = 2')
			expect(sql.exec('SELECT count(*) AS n FROM favourite_likes WHERE favourite_id = 2').one().n).toBe(0)
		})
	})
})

describe('0053_custom_emoji_snapshots', () => {
	const NAME = '0053_custom_emoji_snapshots'
	const at = NAMES.indexOf(NAME)

	it("holds emojiBoundsMigrationSql's output after its header", () => {
		expectGenerated(at, emojiBoundsMigrationSql())
	})

	it('keeps every row as it was, with no emoji, then refuses a snapshot past its bound on insert and update', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice', NULL),
					('100000000000000002', 'https://r.example/u/bob', 'bob', 'r.example')`
			)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES
					('200000000000000001', 'https://kopje.test/ap/o/1', '100000000000000001', 'public', '<p>a</p>', 'x'),
					('200000000000000002', 'https://r.example/n/2', '100000000000000002', 'public', '<p>b</p>', 'x')`
			)
			sql.exec(
				`INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at)
				VALUES ('200000000000000002', '<p>a</p>', '', '[]', 'x')`
			)
			const tables = ['accounts', 'statuses', 'status_edits'] as const
			const before = tables.map((table) => sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray())
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			tables.forEach((table, i) => {
				expect(sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray()).toEqual(
					before[i]!.map((row) => ({ ...row, emojis: null }))
				)
			})
			const cases = {
				accounts: { key: 'id', id: '100000000000000002', at: ACCOUNT_EMOJIS_FULL, past: padded(accountAtCap(), 6145) },
				statuses: { key: 'id', id: '200000000000000002', at: STATUS_EMOJIS_FULL, past: padded(statusAtCap(), 12_289) },
				status_edits: {
					key: 'status_id',
					id: '200000000000000002',
					at: STATUS_EMOJIS_FULL,
					past: JSON.stringify(statusAtCap(true)),
				},
			}
			for (const [table, c] of Object.entries(cases)) {
				const refused = new RegExp(`${table}: emojis past their stored bound`)
				const update = (value: string | null) =>
					sql.exec(`UPDATE ${table} SET emojis = ? WHERE ${c.key} = ?`, value, c.id)
				expect(() => update(c.past)).toThrow(refused)
				expect(() => update('[]')).toThrow(refused)
				expect(() => update('[["a","javascript:alert(1)"]]')).toThrow(refused)
				update(c.at)
				expect(sql.exec(`SELECT emojis FROM ${table} WHERE ${c.key} = ?`, c.id).one().emojis).toBe(c.at)
				update(null)
				update(c.at)
				// A write that leaves emojis alone does not judge it again.
				sql.exec(`UPDATE ${table} SET rowid = rowid WHERE ${c.key} = ?`, c.id)
			}
			const insertAccount = (id: string, emojis: string) =>
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain, emojis) VALUES (?, ?, 'u', 'r.example', ?)",
					id,
					`https://r.example/u/${id}`,
					emojis
				)
			expect(() => insertAccount('100000000000000003', cases.accounts.past)).toThrow(/accounts: emojis past/)
			insertAccount('100000000000000003', cases.accounts.at)
			const insertStatus = (id: string, emojis: string) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, published_at, emojis)
					VALUES (?, ?, '100000000000000002', 'public', 'x', ?)`,
					id,
					`https://r.example/n/${id}`,
					emojis
				)
			expect(() => insertStatus('200000000000000003', cases.statuses.past)).toThrow(/statuses: emojis past/)
			insertStatus('200000000000000003', cases.statuses.at)
			const insertEdit = (emojis: string) =>
				sql.exec(
					`INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at, emojis)
					VALUES ('200000000000000003', '', '', '[]', 'x', ?)`,
					emojis
				)
			expect(() => insertEdit(cases.status_edits.past)).toThrow(/status_edits: emojis past/)
			insertEdit(cases.status_edits.at)
		})
	})

	// Adding the columns rewrites only the schema: what the file reads does not grow with the rows of the tables.
	it('reads no row of the tables', async () => {
		const readFor = async (rows: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
				const sql = state.storage.sql
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain) SELECT CAST(300000000000000000 + i AS TEXT),
						'https://r.example/u/' || i, 'u' || i, 'r.example' FROM n`,
					rows
				)
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(CAST(id AS INTEGER) + 100000000000000000 AS TEXT), uri || '/s', id, 'public', '<p>x</p>', 'x'
					FROM accounts WHERE domain IS NOT NULL`
				)
				sql.exec(
					`INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at)
					SELECT id, '<p>x</p>', '', '[]', 'x' FROM statuses`
				)
				expect(sql.exec('SELECT count(*) AS n FROM status_edits').one().n).toBe(rows)
				let read = 0
				for (const statement of (MIGRATIONS[at]?.sql ?? '').split('\n\n').filter((part) => !part.startsWith('--'))) {
					const cursor = sql.exec(statement)
					cursor.toArray()
					read += cursor.rowsRead
				}
				return read
			})
		}
		expect(await readFor(10_000)).toBe(await readFor(1))
	})
})

describe('0054_remote_reports', () => {
	const NAME = '0054_remote_reports'
	const at = NAMES.indexOf(NAME)
	const BEFORE = MIGRATIONS.slice(0, at)
	const WITH = MIGRATIONS.slice(0, at + 1)
	const ADMIN = '100000000000000001'
	const FORMER = '100000000000000002'
	const CAROL = '100000000000000003'
	const DAN = '100000000000000004'

	// Two local accounts (the admin and a former admin), two remote ones, and `reports` reports by the admin, each with
	// its admin.report for both admins and two pushes of the first.
	function seed(sql: SqlStorage, reports = 4): void {
		sql.exec(
			`INSERT INTO accounts (id, uri, username, domain) VALUES
				(?1, 'https://kopje.test/ap/users/admin', 'admin', NULL),
				(?2, 'https://kopje.test/ap/users/former', 'former', NULL),
				(?3, 'https://r.example/users/carol', 'carol', 'r.example'),
				(?4, 'https://r.example/users/dan', 'dan', 'r.example')`,
			ADMIN,
			FORMER,
			CAROL,
			DAN
		)
		sql.exec(
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			VALUES (?1, 'a@x', X'00', X'00', 'k'), (?2, 'f@x', X'00', X'00', 'k')`,
			ADMIN,
			FORMER
		)
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO reports (id, account_id, target_account_id, status_ids, comment, category, rule_ids, forwarded, uri,
				created_at, action_taken_at, action_taken_by_account_id, assigned_account_id, updated_at, last_action_id)
			SELECT i, CASE i % 2 WHEN 0 THEN ?2 ELSE ?3 END, CASE i % 3 WHEN 0 THEN ?4 ELSE ?5 END, '["1","2"]',
				printf('%.*c', 1000, 'c'), CASE i % 2 WHEN 0 THEN 'violation' ELSE 'spam' END,
				CASE i % 2 WHEN 0 THEN '["1"]' END, i % 2, 'https://kopje.test/actor#reports/' || i, 'x',
				CASE WHEN i % 4 = 0 THEN 'y' END, CASE WHEN i % 4 = 0 THEN ?2 END, CASE WHEN i % 5 = 0 THEN ?3 END,
				CASE WHEN i % 4 = 0 THEN 'z' END, CASE WHEN i % 4 = 0 THEN i END
			FROM n WHERE ?1 > 0`,
			reports,
			ADMIN,
			FORMER,
			CAROL,
			DAN
		)
		sql.exec(
			`INSERT INTO notifications (account_id, type, from_account_id, report_id, group_key, filtered)
			SELECT l.account_id, 'admin.report', r.account_id, r.id, 'ungrouped-' || r.id, r.id % 2
			FROM reports r CROSS JOIN local_accounts l WHERE r.account_id <> l.account_id OR r.id % 3 = 0`
		)
		sql.exec(
			"INSERT INTO notifications (account_id, type, from_account_id) VALUES (?1, 'follow', ?2), (?1, 'mention', ?3)",
			ADMIN,
			CAROL,
			DAN
		)
		sql.exec('INSERT INTO notification_clears (account_id, max_id) VALUES (?, 1)', FORMER)
		sql.exec("INSERT INTO notification_dismissals (account_id, group_key, max_id) VALUES (?, 'ungrouped-2', 9)", ADMIN)
		sql.exec(
			"INSERT INTO oauth_clients (id, secret, name, redirect_uris) VALUES ('c', 's', 'c', 'urn:ietf:wg:oauth:2.0:oob')"
		)
		sql.exec(
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('t1', 'access', 'c', ?1, 'push'), ('t2', 'access', 'c', ?1, 'push')",
			ADMIN
		)
		sql.exec(
			"INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth) VALUES ('t1', 'https://p/1', 'p', 'a'), ('t2', 'https://p/2', 'p', 'a')"
		)
		sql.exec(
			`INSERT INTO push_deliveries (subscription_id, notification_id, next_attempt_at, updated_at)
			SELECT p.id, n.id, 0, 0 FROM push_subscriptions p
			JOIN (SELECT min(id) AS id FROM notifications WHERE report_id IS NOT NULL) n ON n.id IS NOT NULL`
		)
	}

	const snapshot = (sql: SqlStorage) => ({
		reports: sql.exec('SELECT * FROM reports ORDER BY id').toArray(),
		notifications: sql.exec('SELECT * FROM notifications ORDER BY id').toArray(),
		pushes: sql.exec('SELECT * FROM push_deliveries ORDER BY id').toArray(),
		clears: sql.exec('SELECT * FROM notification_clears').toArray(),
		dismissals: sql.exec('SELECT * FROM notification_dismissals').toArray(),
	})
	const leftovers = (sql: SqlStorage) => ({
		tags: sql.exec("SELECT count(*) AS n FROM notifications WHERE type GLOB 'admin.report#*'").one().n,
		tables: sql.exec("SELECT name FROM sqlite_schema WHERE name GLOB 'reports_0054*'").toArray(),
	})
	// A fresh Store upgraded to the file before 0054, seeded with 4 reports.
	const withSeeded = (step: (sql: SqlStorage, state: DurableObjectState) => Promise<void>) =>
		runInDurableObject(freshStore(), async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, BEFORE).upgrade()).toMatchObject({ ok: true })
			seed(sql, 4)
			await step(sql, state)
		})

	const sequence = (sql: SqlStorage) =>
		sql.exec<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'reports'").toArray()[0]?.seq ?? null

	it('keeps every report, notification, push and id, and rebuilds the table for remote reporters', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, BEFORE).upgrade()).toMatchObject({ ok: true })
			seed(sql, 12)
			const before = snapshot(sql)
			expect(before.notifications.length).toBeGreaterThan(12)
			expect(await kernel(state, WITH).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(snapshot(sql)).toEqual(before)
			expect(leftovers(sql)).toEqual({ tags: 0, tables: [] })
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
			expect(
				sql
					.exec<{ table: string; from: string }>('SELECT "table", "from" FROM pragma_foreign_key_list(?)', 'reports')
					.toArray()
					.map((key) => `${key.from}>${key.table}`)
					.sort()
			).toEqual([
				'account_id>accounts',
				'action_taken_by_account_id>local_accounts',
				'assigned_account_id>local_accounts',
				'target_account_id>accounts',
			])
			expect(
				sql
					.exec<{ name: string }>(
						"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'reports' ORDER BY name"
					)
					.toArray()
					.map((row) => row.name)
			).toEqual([
				'reports_account_state',
				'reports_action_taken_by',
				'reports_assigned',
				'reports_pair_state',
				'reports_state',
				'reports_target_state',
				'sqlite_autoindex_reports_1',
			])
			expect(sequence(sql)).toBe(12)
			// A report's delete still takes its notifications and their pushes.
			sql.exec(
				'DELETE FROM reports WHERE id = (SELECT report_id FROM push_deliveries d JOIN notifications n ON n.id = d.notification_id LIMIT 1)'
			)
			expect(sql.exec('SELECT count(*) AS n FROM push_deliveries').one().n).toBe(0)
			// A remote reporter; one report per Flag id and account; the uri within 4,096 JSON-escaped bytes.
			const insert = (uri: string, target = ADMIN) =>
				sql.exec(
					"INSERT INTO reports (account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, 'x')",
					CAROL,
					target,
					uri
				)
			insert('https://r.example/flags/1')
			insert('https://r.example/flags/1', FORMER)
			expect(() => insert('https://r.example/flags/1')).toThrow(
				/UNIQUE constraint failed: reports.uri, reports.target_account_id/
			)
			const prefix = 'https://r.example/flags/'
			const units = Math.floor((4096 - prefix.length) / 6)
			const at4096 = prefix + 'a'.repeat(4096 - prefix.length - 6 * units) + '\u0001'.repeat(units)
			expect(withinIdentityBound(at4096, ACTIVITY_ID_LIMIT)).toBe(true)
			insert(at4096)
			expect(() => insert(`${at4096}x`)).toThrow(/report_uri_within_4096_json_bytes/)
			expect(withinIdentityBound(`${at4096}x`, ACTIVITY_ID_LIMIT)).toBe(false)
			// Ids are never given twice: the next is above the deleted one.
			expect(sql.exec('SELECT max(id) AS id FROM reports').one().id).toBe(15)
		})
	})

	it.each([
		['a log Report target', 9, 3, 3, 9],
		['a local job bound', 3, 9, 3, 9],
		['a remote job bound', 3, 3, 9, 9],
		['only the live reports', 3, 3, 3, 4],
	])('starts the id counter above %s', async (_name, logged, local, remote, expected) => {
		await withSeeded(async (sql, state) => {
			sql.exec(
				"INSERT INTO admin_actions (actor, action, target_type, target_id, created_at) VALUES ('access', 'resolve', 'Report', ?, 'x'), ('access', 'x', 'Report', 'not-a-number', 'x'), ('access', 'x', 'Account', '99', 'x')",
				String(logged)
			)
			sql.exec(
				"INSERT INTO moderation_jobs (kind, account_id, generation, report_bound, phase) VALUES ('suspension', ?, 1, ?, 'reports')",
				ADMIN,
				local
			)
			sql.exec(
				`INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, report_bound, phase)
				VALUES ('account', ?, 'account', 0, ?, 'reports'), ('domain', '', 'domain', 0, NULL, 'clear')`,
				CAROL,
				remote
			)
			expect(await kernel(state, WITH).upgrade()).toMatchObject({ ok: true })
			expect(sequence(sql)).toBe(expected)
			sql.exec(
				"INSERT INTO reports (account_id, target_account_id, uri, created_at) VALUES (?, ?, 'u:new', 'x')",
				CAROL,
				ADMIN
			)
			expect(sql.exec("SELECT id FROM reports WHERE uri = 'u:new'").one().id).toBe(expected + 1)
		})
	})

	// A log target names a report when it spells a signed 64-bit integer (leading zeros allowed); anything else is
	// skipped, and an id past the integer range cannot be a report's.
	it.each([
		['18 digits, the last that leaves room', '999999999999999998', 999999999999999998n],
		['leading zeros', '0000000000000000000009', 9n],
		['past the largest id', '9223372036854775808', 4n],
		['digits and more', '12a', 4n],
		['an empty id', '', 4n],
	])('reads a log Report target of %s', async (_name, target, expected) => {
		await withSeeded(async (sql, state) => {
			sql.exec(
				"INSERT INTO admin_actions (actor, action, target_type, target_id, created_at) VALUES ('access', 'resolve', 'Report', ?, 'x')",
				target
			)
			expect(await kernel(state, WITH).upgrade()).toMatchObject({ ok: true })
			const seq = sql
				.exec<{ seq: string }>("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'reports'")
				.one().seq
			expect(BigInt(seq)).toBe(expected)
		})
	})

	// A next report id past 18 digits could not be read by id (reportRow) nor linked: the upgrade is held first.
	it.each([
		[
			'a log target of 999999999999999999',
			"INSERT INTO admin_actions (actor, action, target_type, target_id, created_at) VALUES ('access', 'resolve', 'Report', '999999999999999999', 'x')",
		],
		[
			'a 19-digit log target',
			"INSERT INTO admin_actions (actor, action, target_type, target_id, created_at) VALUES ('access', 'resolve', 'Report', '1000000000000000000', 'x')",
		],
		[
			'the largest log target',
			"INSERT INTO admin_actions (actor, action, target_type, target_id, created_at) VALUES ('access', 'resolve', 'Report', '09223372036854775807', 'x')",
		],
		[
			'a local job bound',
			`INSERT INTO moderation_jobs (kind, account_id, generation, report_bound, phase) VALUES ('suspension', '${ADMIN}', 1, 999999999999999999, 'reports')`,
		],
		[
			'a remote job bound',
			`INSERT INTO remote_moderation_jobs (kind, subject, mode, follow_bound, report_bound, phase) VALUES ('account', '${CAROL}', 'account', 0, 1000000000000000000, 'out')`,
		],
		[
			'a live report',
			`INSERT INTO reports (id, account_id, target_account_id, uri, created_at) VALUES (999999999999999999, '${ADMIN}', '${CAROL}', 'u:last', 'x')`,
		],
	])('holds the upgrade, writing nothing, for %s', async (_name, statement) => {
		await withSeeded(async (sql, state) => {
			sql.exec(statement)
			const before = snapshot(sql)
			const k = kernel(state, WITH)
			const result = await k.upgrade()
			expect(result).toMatchObject({ ok: false, reason: 'upgrade-failed' })
			expect(JSON.stringify(result)).toMatch(/report_ids_within_18_digits/)
			expect(snapshot(sql)).toEqual(before)
			expect(leftovers(sql)).toEqual({ tags: 0, tables: [] })
			expect(bookkeeping(sql).map((m) => m.name)).not.toContain(NAME)
			expect(await k.health(BUILD)).toMatchObject({ readonly: true, hold: 'upgrade-failed' })
		})
	})

	// A counter seeded near the end of the 18-digit range still gives a remote report the admin reads and resolves.
	it('refuses a Flag past the last 18-digit id whole, and files, shows and resolves one at it', async () => {
		await withSeeded(async (sql, state) => {
			sql.exec(
				"INSERT INTO admin_actions (actor, action, target_type, target_id, created_at) VALUES ('access', 'resolve', 'Report', '999999999999999998', 'x')"
			)
			// Through every migration: the admin's reads below are the current code's, which read later columns too.
			expect(await kernel(state, MIGRATIONS).upgrade()).toMatchObject({ ok: true })
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('admin_email', 'a@x')")
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('admin-token', 'access', 'c', ?, 'admin:read admin:write')",
				ADMIN
			)
			const db = new Db(sql)
			const flag = (id: string, objects: string[]) =>
				state.storage.transactionSync(() =>
					fileRemoteReports(db, { id: CAROL, domain: 'r.example' }, { id, objects, content: 'x' }, NOW)
				)
			const users = (...names: string[]) => names.map((name) => `https://kopje.test/ap/users/${name}`)
			const before = { ...snapshot(sql), sequence: sequence(sql) }
			// Two new reports need two ids, and only one is left: the second insert fails its CHECK, and the whole Flag
			// with it (its first report and both notifications included).
			expect(() => flag('https://r.example/flags/two', users('admin', 'former'))).toThrow(/report_id_within_18_digits/)
			expect({ ...snapshot(sql), sequence: sequence(sql) }).toEqual(before)
			expect(flag('https://r.example/flags/last', users('former'))).toEqual({ filed: true, reason: 'reported' })
			const id = sql
				.exec<{ id: string }>("SELECT CAST(id AS TEXT) AS id FROM reports WHERE uri = 'https://r.example/flags/last'")
				.one().id
			expect(id).toBe('999999999999999999')
			const present = { origin: 'https://kopje.test' }
			const read = { tokenHash: 'admin-token', scope: 'admin:read:reports', now: NOW } as const
			expect(getAdminReport.run(sql, { credential: read, id, present })).toMatchObject({
				status: 'ok',
				value: { status: 'ok', report: { id, account: { id: CAROL } } },
			})
			const write = { tokenHash: 'admin-token', scope: 'admin:write:reports', now: NOW } as const
			expect(actOnReport.run(sql, { credential: write, id, action: 'resolve', present })).toMatchObject({
				status: 'ok',
				value: { status: 'ok', report: { id, action_taken: true } },
			})
			// The ids are used up: a further report is refused whole.
			const after = snapshot(sql)
			expect(() => flag('https://r.example/flags/more', users('admin'))).toThrow(/report_id_within_18_digits/)
			expect(snapshot(sql)).toEqual(after)
		})
	})

	it('fails before any write when a local account holds a notification type in the tag range', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, BEFORE).upgrade()).toMatchObject({ ok: true })
			seed(sql, 3)
			sql.exec(
				"INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'admin.report#2', ?)",
				ADMIN,
				CAROL
			)
			const before = snapshot(sql)
			const result = await kernel(state, WITH).upgrade()
			expect(result).toMatchObject({ ok: false, reason: 'upgrade-failed' })
			expect(JSON.stringify(result)).toMatch(/report_notifications_are_admin_reports/)
			expect(snapshot(sql)).toEqual(before)
		})
	})

	it('starts the counter above a deleted report the log alone still names, and at 1 with nothing', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, BEFORE).upgrade()).toMatchObject({ ok: true })
			seed(sql, 2)
			sql.exec(
				"INSERT INTO admin_actions (actor, action, target_type, target_id, created_at) VALUES ('access', 'resolve', 'Report', '2', 'x')"
			)
			sql.exec('DELETE FROM reports WHERE id = 2')
			expect(await kernel(state, WITH).upgrade()).toMatchObject({ ok: true })
			expect(sequence(sql)).toBe(2)
		})
		const empty = freshStore()
		await runInDurableObject(empty, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, WITH).upgrade()).toMatchObject({ ok: true })
			expect(sequence(sql)).toBeNull()
			seed(sql, 0)
			sql.exec(
				"INSERT INTO reports (account_id, target_account_id, uri, created_at) VALUES (?, ?, 'u:1', 'x')",
				CAROL,
				ADMIN
			)
			expect(sql.exec('SELECT id FROM reports').one().id).toBe(1)
		})
	})

	it('rolls the whole file back when the copy fails after the detach, stays held, and applies on retry', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, BEFORE).upgrade()).toMatchObject({ ok: true })
			seed(sql, 6)
			sql.exec("UPDATE reports SET comment = printf('%.*c', 5001, 'c') WHERE id = 3")
			const before = snapshot(sql)
			const k = kernel(state, WITH)
			expect(await k.upgrade()).toMatchObject({ ok: false, reason: 'upgrade-failed' })
			expect(snapshot(sql)).toEqual(before)
			expect(leftovers(sql)).toEqual({ tags: 0, tables: [] })
			expect(bookkeeping(sql).map((m) => m.name)).not.toContain(NAME)
			expect(await k.health(BUILD)).toMatchObject({ readonly: true, hold: 'upgrade-failed' })
			expect(await kernel(state, WITH).upgrade()).toMatchObject({ ok: false, detail: 'held' })
			sql.exec("UPDATE reports SET comment = 'short' WHERE id = 3")
			const retried = await kernel(state, WITH).retryUpgrade(BUILD)
			expect(retried).toMatchObject({ ok: true, applied: [NAME] })
			expect(sql.exec('SELECT count(*) AS n FROM reports').one().n).toBe(6)
		})
	})

	it('keeps the new schema when verification fails after the commit, held; a retry verifies only', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, BEFORE).upgrade()).toMatchObject({ ok: true })
			seed(sql, 6)
			const before = snapshot(sql)
			const failing = kernel(state, WITH, {
				inject: (phase) => {
					if (phase === 'verify') {
						throw new Error('injected verify failure')
					}
				},
			})
			expect(await failing.upgrade()).toMatchObject({ ok: false, reason: 'verify-failed' })
			expect(bookkeeping(sql).map((m) => m.name)).toContain(NAME)
			expect(snapshot(sql)).toEqual(before)
			expect(sql.exec("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'reports_pair_state'").one().n).toBe(1)
			expect(await kernel(state, WITH).upgrade()).toMatchObject({ ok: false, detail: 'held' })
			expect(await kernel(state, WITH).retryUpgrade(BUILD)).toMatchObject({ ok: true, applied: [] })
			expect(sequence(sql)).toBe(6)
		})
	})

	it('fails before any write on a report notification of another type', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, BEFORE).upgrade()).toMatchObject({ ok: true })
			seed(sql, 3)
			sql.exec(
				"UPDATE notifications SET type = 'mention' WHERE id = (SELECT min(id) FROM notifications WHERE report_id IS NOT NULL)"
			)
			const before = snapshot(sql)
			const result = await kernel(state, WITH).upgrade()
			expect(result).toMatchObject({ ok: false, reason: 'upgrade-failed' })
			expect(JSON.stringify(result)).toMatch(/report_notifications_are_admin_reports/)
			expect(snapshot(sql)).toEqual(before)
		})
	})

	it('detaches through notifications_report and relinks through notifications_natural', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			expect(await kernel(state, BEFORE).upgrade()).toMatchObject({ ok: true })
			const plan = (query: string) =>
				sql
					.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
					.toArray()
					.map((row) => row.detail)
					.join(' | ')
			expect(
				plan(
					"UPDATE notifications SET type = 'admin.report#' || report_id, report_id = NULL WHERE report_id IS NOT NULL"
				)
			).toMatch(/notifications_report/)
			expect(
				plan(
					`UPDATE notifications SET report_id = CAST(substr(type, 14) AS INTEGER), type = 'admin.report'
					WHERE account_id IN (SELECT account_id FROM local_accounts) AND type > 'admin.report#' AND type < 'admin.report$'`
				)
			).toMatch(/notifications_natural \(account_id=\? AND type>\? AND type<\?\)/)
		})
	})

	// The rows read grow with the reports and their notifications, and not with the other notifications.
	it('reads the reports and their notifications, and not the other notifications', async () => {
		const measure = async (reports: number, others: number) => {
			const store = freshStore()
			return runInDurableObject(store, async (_instance, state) => {
				const sql = state.storage.sql
				await kernel(state, BEFORE).upgrade()
				seed(sql, reports)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					SELECT CAST(500000000000000000 + i AS TEXT), 'https://r.example/s/' || i, ?2, 'public', 'x' FROM n`,
					others,
					CAROL
				)
				sql.exec(
					`INSERT INTO notifications (account_id, type, from_account_id, status_id)
					SELECT ?1, 'mention', account_id, id FROM statuses`,
					ADMIN
				)
				const cursor = sql.exec(MIGRATIONS[at]?.sql ?? '')
				cursor.toArray()
				return cursor.rowsRead
			})
		}
		const base = await measure(100, 0)
		expect(Math.abs((await measure(100, 2_000)) - base)).toBeLessThanOrEqual(2)
		const some = (await measure(1_100, 0)) - base
		const twice = (await measure(2_100, 0)) - base
		expect(Math.abs(twice - 2 * some)).toBeLessThanOrEqual(0.02 * some)
	}, 120_000)
})

describe('0055_local_custom_emojis', () => {
	const NAME = '0055_local_custom_emojis'
	const at = NAMES.indexOf(NAME)
	const ALICE = '100000000000000001'
	const REMOTE = '100000000000000002'
	const META = '{"original":{"width":1024,"height":1024},"small":{"width":640,"height":640}}'

	it('repeats the bounds of emoji-image.ts and stored-bounds.ts in its literals', () => {
		const sql = MIGRATIONS[at]?.sql ?? ''
		expect([EMOJI_EDGE_LIMIT, MAX_ENABLED_EMOJIS, EMOJI_CATEGORY_LENGTH, EMOJI_CATEGORY_BYTES]).toEqual([
			1024, 1000, 64, 256,
		])
		expect(sql).toContain(`BETWEEN 1 AND ${EMOJI_EDGE_LIMIT}`)
		expect(sql).toContain(`>= ${MAX_ENABLED_EMOJIS}`)
		expect(sql).toContain(`length(category) <= ${EMOJI_CATEGORY_LENGTH}`)
		expect(sql).toContain(`BETWEEN 1 AND ${EMOJI_CATEGORY_BYTES}`)
		expect(sql).toContain(`m.content_type IN (${EMOJI_SERVED_TYPES.map((t) => `'${t}'`).join(', ')})`)
		expect(sql).toContain("shortcode NOT GLOB '*[^A-Za-z0-9_]*'")
		expect(sql).toContain('BETWEEN 2 AND 128')
		expect(LOCAL_EMOJI_SHORTCODE.source).toBe('^[A-Za-z0-9_]{2,128}$')
		// Not in the file, but the limits it names: the Worker's checks (platform/emoji-image.ts).
		expect([EMOJI_IMAGE_LIMIT, EMOJI_PREVIEW_LIMIT, EMOJI_INPUT_TYPES]).toEqual([
			262_144,
			524_288,
			['image/png', 'image/gif', 'image/webp'],
		])
	})

	it('keeps every row as it was, then holds every CHECK and trigger at its bound', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					(?, 'https://kopje.test/ap/users/alice', 'alice', NULL), (?, 'https://r.example/u/bob', 'bob', 'r.example')`,
				ALICE,
				REMOTE
			)
			let n = 0
			const media = (overrides: Record<string, string | number | null> = {}): string => {
				const id = String(300_000_000_000_000_000n + BigInt(++n))
				const row = {
					id,
					account_id: ALICE,
					type: 'image',
					url: `https://kopje.test/media/tok${String(n).padStart(29, '0')}/full.png`,
					file_token: `tok${String(n).padStart(29, '0')}`,
					content_type: 'image/png',
					meta: META,
					processed: 1,
					gc_at: null,
					status_id: null,
					...overrides,
				}
				const columns = Object.keys(row)
				sql.exec(
					`INSERT INTO media_attachments (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
					...Object.values(row)
				)
				return id
			}
			const kept = media()
			const before = sql.exec('SELECT * FROM media_attachments ORDER BY rowid').toArray()
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(sql.exec('SELECT * FROM media_attachments ORDER BY rowid').toArray()).toEqual(before)
			const insert = (id: string, values: Record<string, string | number | null> = {}) => {
				const row = { id, shortcode: 'blob', created_at: '2026-10-12T00:00:00.000Z', ...values }
				const columns = Object.keys(row)
				sql.exec(
					`INSERT INTO custom_emojis (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
					...Object.values(row)
				)
			}
			const remove = (id: string) => sql.exec('DELETE FROM custom_emojis WHERE id = ?', id)
			// Shortcodes: 2 and 128 ASCII characters; 1, 129, '+', '-', non-ASCII and a NUL refused.
			for (const shortcode of ['ab', 'x'.repeat(128), 'A_9']) {
				insert(kept, { shortcode })
				remove(kept)
			}
			for (const shortcode of ['a', 'x'.repeat(129), 'a+b', 'a-b', 'aé', 'ab\u0000', '\u0000ab', 'a b']) {
				expect(() => insert(kept, { shortcode })).toThrow(/custom_emoji_shortcode_2_to_128_ascii/)
			}
			expect(() => insert(kept, { shortcode: 12 })).toThrow(/custom_emoji_shortcode/)
			// Categories: 64 four-byte code points (256 bytes) and 64 three-byte ones; 65 code points, 257 bytes, NUL,
			// U+0001, U+001F and DEL refused; empty refused (NULL is none).
			for (const category of ['\u{1F600}'.repeat(64), '日'.repeat(64), 'a', null]) {
				insert(kept, { category })
				remove(kept)
			}
			for (const category of [
				'日'.repeat(65),
				'a'.repeat(257),
				'a\u0000',
				'\u0000',
				'a\u0001',
				'a\u001f',
				'a\u007f',
				'',
			]) {
				expect(() => insert(kept, { category })).toThrow(/custom_emoji_category_within_256_bytes/)
			}
			// Stored bytes only: lone surrogate bytes are 64 SQLite characters and 192 bytes, so the CHECK passes them.
			sql.exec(
				`INSERT INTO custom_emojis (id, shortcode, category, created_at)
				VALUES (?, 'blob', CAST(X'${'EDA080'.repeat(64)}' AS TEXT), '2026-10-12T00:00:00.000Z')`,
				kept
			)
			remove(kept)
			// Ids, flags and times.
			for (const id of ['1', `${kept}0`, kept.replace('3', 'x')]) {
				expect(() => insert(id)).toThrow(/custom_emoji_id_is_a_snowflake|FOREIGN KEY|kept local upload/)
			}
			for (const flags of [{ disabled: 2 }, { visible_in_picker: -1 }, { disabled: null }] as Record<
				string,
				number | null
			>[]) {
				expect(() => insert(kept, flags)).toThrow(/custom_emoji_flags|NOT NULL/)
			}
			insert(kept, { created_at: '2026-10-12T23:59:59.999Z' })
			remove(kept)
			// strftime keeps hour 24, which Temporal.Instant.from (the actor's Emoji tags) refuses.
			for (const created_at of [
				'2026-10-12T00:00:00Z',
				'2026-10-12 00:00:00.000Z',
				'2026-13-12T00:00:00.000Z',
				'2026-10-12T24:00:00.000Z',
				'2026-10-12T24:01:00.000Z',
				'x',
			]) {
				expect(() => insert(kept, { created_at })).toThrow(/custom_emoji_created_at_iso/)
			}
			// The image: a kept, complete, unattached local upload served as PNG or WebP within the recorded edges.
			const refused = /custom_emojis: the image is not a kept local upload within the emoji limits/
			const cases: Record<string, Record<string, string | number | null>> = {
				remote: { account_id: REMOTE },
				unprocessed: { processed: 0 },
				reservation: { url: '' },
				doomed: { gc_at: '2026-10-12T00:00:00.000Z' },
				jpeg: { content_type: 'image/jpeg', url: 'https://kopje.test/media/x/full.jpg' },
				untokened: { file_token: null },
				'no meta': { meta: null },
				'no edges': { meta: '{"small":{"width":1,"height":1}}' },
				'real edges': { meta: '{"original":{"width":64.0,"height":64}}' },
				'text edges': { meta: '{"original":{"width":"64","height":64}}' },
				'1025 wide': { meta: '{"original":{"width":1025,"height":1}}' },
				'1025 tall': { meta: '{"original":{"width":1,"height":1025}}' },
				'0 wide': { meta: '{"original":{"width":0,"height":1}}' },
			}
			for (const [label, overrides] of Object.entries(cases)) {
				expect(() => insert(media(overrides)), label).toThrow(refused)
			}
			const attached = media()
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				VALUES ('400000000000000001', 'https://kopje.test/ap/o/1', ?, 'public', 'x')`,
				ALICE
			)
			sql.exec("UPDATE media_attachments SET status_id = '400000000000000001' WHERE id = ?", attached)
			expect(() => insert(attached)).toThrow(refused)
			expect(() => insert('399999999999999999')).toThrow(refused)
			insert(media({ meta: '{"original":{"width":1024,"height":1}}', content_type: 'image/webp' }))
			// One enabled emoji per shortcode; a disabled one may share it.
			expect(() => insert(media())).toThrow(/UNIQUE constraint failed: custom_emojis.shortcode/)
			insert(media(), { disabled: 1 })
			// The id, shortcode and time never change; the flags and category may.
			const id = sql.exec<{ id: string }>('SELECT id FROM custom_emojis WHERE disabled = 0').one().id
			const immutable = /custom_emojis: an emoji's id, shortcode and time never change/
			expect(() => sql.exec("UPDATE custom_emojis SET shortcode = 'other' WHERE id = ?", id)).toThrow(immutable)
			expect(() =>
				sql.exec("UPDATE custom_emojis SET created_at = '2026-10-13T00:00:00.000Z' WHERE id = ?", id)
			).toThrow(immutable)
			expect(() => sql.exec('UPDATE custom_emojis SET id = ? WHERE id = ?', kept, id)).toThrow(immutable)
			sql.exec("UPDATE custom_emojis SET category = 'c', visible_in_picker = 0 WHERE id = ?", id)
			// The image of an emoji is never deleted: its row's delete fails on the foreign key.
			expect(() => sql.exec('DELETE FROM media_attachments WHERE id = ?', id)).toThrow(/FOREIGN KEY constraint failed/)
		})
	})

	it('holds at most 1,000 enabled emoji, on insert and on enabling, disabled ones uncounted', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()
			sql.exec(
				"INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')",
				ALICE
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1002)
				INSERT INTO media_attachments (id, account_id, type, url, file_token, content_type, meta, processed)
				SELECT CAST(300000000000000000 + i AS TEXT), ?, 'image', 'https://kopje.test/media/t' || i || '/full.png',
					printf('tok%029d', i), 'image/png', ?, 1 FROM n`,
				ALICE,
				META
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
				INSERT INTO custom_emojis (id, shortcode, created_at)
				SELECT CAST(300000000000000000 + i AS TEXT), 'e' || i, '2026-10-12T00:00:00.000Z' FROM n`
			)
			const insert = (i: number, disabled: number) =>
				sql.exec(
					"INSERT INTO custom_emojis (id, shortcode, disabled, created_at) VALUES (?, ?, ?, '2026-10-12T00:00:00.000Z')",
					String(300_000_000_000_000_000n + BigInt(i)),
					`e${i}`,
					disabled
				)
			insert(1000, 0)
			const over = /custom_emojis: more than 1000 enabled/
			expect(() => insert(1001, 0)).toThrow(over)
			insert(1001, 1)
			expect(() => sql.exec("UPDATE custom_emojis SET disabled = 0 WHERE shortcode = 'e1001'")).toThrow(over)
			sql.exec("UPDATE custom_emojis SET disabled = 1 WHERE shortcode = 'e1'")
			sql.exec("UPDATE custom_emojis SET disabled = 0 WHERE shortcode = 'e1001'")
			// A write that leaves `disabled` as it is, or keeps an enabled emoji enabled, is not judged.
			sql.exec("UPDATE custom_emojis SET disabled = 0 WHERE shortcode = 'e2'")
			expect(sql.exec('SELECT count(*) AS n FROM custom_emojis WHERE disabled = 0').one().n).toBe(1000)
		})
	})
})

describe('0056_announcements', () => {
	const NAME = '0056_announcements'
	const at = NAMES.indexOf(NAME)
	const ALICE = '100000000000000001'
	const BOB = '100000000000000002'
	const T = '2026-10-12T00:00:00.000Z'
	const JOURNAL_OBJECTS = [
		'stream_notification_inserted',
		'stream_status_inserted',
		'stream_status_edited',
		'stream_conversation_changed',
		'stream_events_conversation',
	]
	const objects = (sql: SqlStorage) =>
		sql
			.exec<{ type: string; name: string; tbl_name: string; sql: string }>(
				`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN (${JOURNAL_OBJECTS.map(() => '?').join(', ')})
				ORDER BY name`,
				...JOURNAL_OBJECTS
			)
			.toArray()

	it('repeats the bounds of stored-bounds.ts in its literals', () => {
		const sql = MIGRATIONS[at]?.sql ?? ''
		expect([ANNOUNCEMENT_TEXT_BYTES, MAX_ANNOUNCEMENTS, MAX_LIVE_ANNOUNCEMENTS, REACTION_NAME_BYTES]).toEqual([
			10_000, 1000, 16, 128,
		])
		expect(MAX_REACTION_NAMES).toBe(8)
		expect(sql).toContain(`length(CAST(text AS BLOB)) BETWEEN 1 AND ${ANNOUNCEMENT_TEXT_BYTES}`)
		expect(sql).toContain(`(SELECT count(*) FROM announcements) >= ${MAX_ANNOUNCEMENTS}`)
		expect(sql.match(new RegExp(`IS NOT NULL\\) >= ${MAX_LIVE_ANNOUNCEMENTS}\\n`, 'g'))).toHaveLength(2)
		expect(sql).toContain(`length(CAST(name AS BLOB)) BETWEEN 1 AND ${REACTION_NAME_BYTES}`)
		expect(sql).toContain(`WHERE announcement_id = NEW.announcement_id) >= ${MAX_REACTION_NAMES}`)
		// workerd refuses a LIKE or GLOB pattern over 50 bytes.
		for (const [, pattern] of sql.matchAll(/GLOB\s+'([^']*)'/g)) {
			expect(new TextEncoder().encode(pattern).length).toBeLessThanOrEqual(50)
		}
	})

	it('rebuilds the journal with its rows, ids, cursor, triggers and index, and journals as before', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			const before = objects(sql)
			expect(before.map((o) => o.name)).toEqual([...JOURNAL_OBJECTS].sort())
			sql.exec(
				`INSERT INTO stream_events (id, kind, subject, created_at) VALUES
					(7, 'status', '1', ?1), (9, 'conversation', ?2, ?1), (4103, 'notification', '5', ?1)`,
				T,
				ALICE
			)
			sql.exec('UPDATE stream_cursor SET event_id = 9, account_id = ? WHERE id = 1', ALICE)
			const rows = sql.exec('SELECT * FROM stream_events ORDER BY id').toArray()
			expect(await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()).toMatchObject({ ok: true, applied: [NAME] })
			expect(sql.exec('SELECT * FROM stream_events ORDER BY id').toArray()).toEqual(rows)
			expect(sql.exec('SELECT event_id, account_id FROM stream_cursor').toArray()).toEqual([
				{ event_id: 9, account_id: ALICE },
			])
			// Byte for byte, as 0032_streaming_lists and 0035_streaming_public made them.
			expect(objects(sql)).toEqual(before)
			// The new kinds; an unknown one is refused; the next id follows the highest.
			sql.exec('DELETE FROM stream_events WHERE id = 4103')
			for (const kind of ['announcement', 'announcement_reaction']) {
				sql.exec('INSERT INTO stream_events (kind, subject, created_at) VALUES (?, ?, ?)', kind, '1', T)
			}
			expect(() =>
				sql.exec("INSERT INTO stream_events (kind, subject, created_at) VALUES ('announcement.delete', '1', ?)", T)
			).toThrow(/CHECK constraint failed/)
			// Statuses, edits and notifications still journal for a `user` listener.
			sql.exec(
				`INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')`,
				ALICE
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
				ALICE
			)
			sql.exec("INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?, 'user', 1)", ALICE)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES ('300000000000000001', 'https://kopje.test/ap/o/1', ?, 'public', '<p>x</p>', ?)`,
				ALICE,
				T
			)
			sql.exec("UPDATE statuses SET edited_at = '2026-10-12T01:00:00.000Z'")
			sql.exec("INSERT INTO notifications (account_id, type, from_account_id) VALUES (?, 'mention', ?)", ALICE, ALICE)
			expect(
				sql
					.exec('SELECT id, kind FROM stream_events WHERE id > 9 ORDER BY id')
					.toArray()
					.map((r) => r.kind)
			).toEqual(['announcement', 'announcement_reaction', 'status', 'edit', 'notification'])
			expect(sql.exec<{ id: number }>('SELECT min(id) AS id FROM stream_events WHERE id > 9').one().id).toBe(10)
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	// A migrated Store with two local accounts and an enabled custom emoji `blob` (id EMOJI).
	const EMOJI = '300000000000000001'
	async function migrated(state: DurableObjectState) {
		const sql = state.storage.sql
		await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()
		for (const [id, name] of [
			[ALICE, 'alice'],
			[BOB, 'bob'],
		] as const) {
			sql.exec(
				'INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)',
				id,
				`https://kopje.test/ap/users/${name}`,
				name
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
				id,
				`${name}@example.com`
			)
		}
		sql.exec(
			`INSERT INTO media_attachments (id, account_id, type, url, file_token, content_type, meta, processed)
			VALUES (?, ?, 'image', 'https://kopje.test/media/t/full.png', 't', 'image/png',
				'{"original":{"width":1,"height":1}}', 1)`,
			EMOJI,
			ALICE
		)
		sql.exec("INSERT INTO custom_emojis (id, shortcode, created_at) VALUES (?, 'blob', ?)", EMOJI, T)
		return sql
	}

	const announcementId = (n: number) => String(200_000_000_000_000_000n + BigInt(n))

	function inserter(sql: SqlStorage) {
		let n = 0
		return (values: Record<string, string | number | null> = {}) => {
			const row = { id: announcementId(++n), text: 'hello', created_at: T, updated_at: T, ...values }
			const columns = Object.keys(row)
			sql.exec(
				`INSERT INTO announcements (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
				...Object.values(row)
			)
			return row.id
		}
	}

	it('holds the text, times, range, flags and publication at their bounds', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = await migrated(state)
			const insert = inserter(sql)
			const remove = (id: string) => sql.exec('DELETE FROM announcements WHERE id = ?', id)
			// Text: 10,000 bytes (one- and four-byte characters), 10,001 refused, NUL anywhere, ASCII blank.
			for (const text of ['x'.repeat(10_000), '\u{1F600}'.repeat(2500), ' a ', '　']) {
				remove(insert({ text }))
			}
			for (const text of [
				'x'.repeat(10_001),
				'\u{1F600}'.repeat(2500) + 'x',
				'a\u0000',
				'\u0000a',
				'',
				' \t\n\r\v\f',
			]) {
				expect(() => insert({ text })).toThrow(/announcement_text_within_10000_bytes/)
			}
			expect(() =>
				sql.exec(
					"INSERT INTO announcements (id, text, created_at, updated_at) VALUES (?, X'41', ?, ?)",
					announcementId(0),
					T,
					T
				)
			).toThrow(/announcement_text_within_10000_bytes/)
			// Times: written by strftime's own form, fractions .001 and .999, NULL where nullable.
			const times = /announcement_times_iso/
			for (const column of ['starts_at', 'ends_at', 'published_at', 'scheduled_at', 'created_at', 'updated_at']) {
				const pair = column === 'starts_at' || column === 'ends_at'
				const fill = (value: string | null) => (pair ? { starts_at: value, ends_at: value } : { [column]: value })
				for (const value of ['2026-10-12T23:59:59.999Z', '2026-02-28T00:00:00.001Z']) {
					remove(insert(fill(value)))
				}
				if (column !== 'created_at' && column !== 'updated_at') {
					remove(insert(fill(null)))
				} else {
					expect(() => insert(fill(null))).toThrow(/NOT NULL/)
				}
				for (const value of [
					'2026-02-30T00:00:00.000Z',
					'2026-10-12T24:00:00.000Z',
					'2026-10-12T24:01:00.000Z',
					'2026-10-12T00:00:00.00Z',
					'2026-10-12T00:00:00.000+00:00',
					'2026-10-12 00:00:00.000Z',
					'not a time at all, 24 b.',
				]) {
					expect(() => insert(fill(value)), `${column} ${value}`).toThrow(times)
				}
			}
			// An UPDATE is judged too.
			const kept = insert({ starts_at: T, ends_at: T })
			sql.exec("UPDATE announcements SET ends_at = '2026-10-13T00:00:00.000Z', updated_at = ? WHERE id = ?", T, kept)
			expect(() =>
				sql.exec("UPDATE announcements SET updated_at = '2026-10-12T24:00:00.000Z' WHERE id = ?", kept)
			).toThrow(times)
			// Both ends or neither, the end not before the start.
			const range = /announcement_range/
			expect(() => insert({ starts_at: T })).toThrow(range)
			expect(() => insert({ ends_at: T })).toThrow(range)
			expect(() => insert({ starts_at: '2026-10-12T00:00:00.001Z', ends_at: T })).toThrow(range)
			// Flags and publication: a published row has a time and no schedule.
			expect(() => insert({ all_day: 2 })).toThrow(/announcement_flags/)
			expect(() => insert({ published: 1 })).toThrow(/announcement_publication/)
			expect(() => insert({ published: 1, published_at: T, scheduled_at: T })).toThrow(/announcement_publication/)
			remove(insert({ published: 1, published_at: T }))
			remove(insert({ scheduled_at: T }))
			// Ids are 18-digit snowflakes and never change; so is the creation time.
			for (const id of ['1', `${announcementId(1)}0`, announcementId(1).replace('2', 'x')]) {
				expect(() => insert({ id })).toThrow(/announcement_id_is_a_snowflake/)
			}
			const immutable = /announcements: an announcement's id and creation time never change/
			expect(() => sql.exec('UPDATE announcements SET id = ? WHERE id = ?', announcementId(999), kept)).toThrow(
				immutable
			)
			expect(() =>
				sql.exec("UPDATE announcements SET created_at = '2026-10-13T00:00:00.000Z' WHERE id = ?", kept)
			).toThrow(immutable)
		})
	})

	it('holds 1,000 announcements, 16 of them published or scheduled, on every write that makes one live', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = await migrated(state)
			const insert = inserter(sql)
			const live = /announcements: more than 16 published or scheduled/
			const published = { published: 1, published_at: T }
			for (let i = 0; i < 8; i++) {
				insert(published)
				insert({ scheduled_at: T })
			}
			expect(() => insert(published)).toThrow(live)
			expect(() => insert({ scheduled_at: T })).toThrow(live)
			const draft = insert()
			expect(() => sql.exec('UPDATE announcements SET published = 1, published_at = ? WHERE id = ?', T, draft)).toThrow(
				live
			)
			expect(() => sql.exec('UPDATE announcements SET scheduled_at = ? WHERE id = ?', T, draft)).toThrow(live)
			// Publishing a scheduled row makes nothing newly live, so it is not judged.
			const scheduled = sql
				.exec<{ id: string }>('SELECT id FROM announcements WHERE scheduled_at IS NOT NULL LIMIT 1')
				.one().id
			sql.exec(
				'UPDATE announcements SET published = 1, published_at = scheduled_at, scheduled_at = NULL WHERE id = ?',
				scheduled
			)
			// Unpublishing one frees a place.
			sql.exec('UPDATE announcements SET published = 0 WHERE id = ?', scheduled)
			sql.exec('UPDATE announcements SET scheduled_at = ? WHERE id = ?', T, draft)
			// 1,000 in all.
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO announcements (id, text, created_at, updated_at)
				SELECT CAST(210000000000000000 + i AS TEXT), 'x', ?2, ?2 FROM n`,
				MAX_ANNOUNCEMENTS - 1 - 17,
				T
			)
			insert()
			expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM announcements').one().n).toBe(MAX_ANNOUNCEMENTS)
			expect(() => insert()).toThrow(/announcements: more than 1000/)
		})
	})

	it('holds reaction names at their bounds, 8 per announcement, and custom emoji by their shortcode', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = await migrated(state)
			const announcement = inserter(sql)({ published: 1, published_at: T })
			const react = (name: string, account = ALICE, emoji: string | null = null) =>
				sql.exec(
					'INSERT INTO announcement_reactions (announcement_id, account_id, name, custom_emoji_id) VALUES (?, ?, ?, ?)',
					announcement,
					account,
					name,
					emoji
				)
			const unreact = (name: string) => sql.exec('DELETE FROM announcement_reactions WHERE name = ?', name)
			const check = /announcement_reaction_name_within_128_bytes/
			// 128 bytes: 32 four-byte characters; 129 refused, NUL, U+0001, DEL, ASCII without a custom emoji.
			for (const name of ['\u{1F600}'.repeat(32), '👍', 'é']) {
				react(name)
				unreact(name)
			}
			for (const name of [
				'\u{1F600}'.repeat(32) + 'x',
				'👍\u0000',
				'\u0000👍',
				'👍\u0001',
				'👍\u007f',
				'a',
				'',
				'blob',
			]) {
				expect(() => react(name), JSON.stringify(name)).toThrow(check)
			}
			// A custom emoji's reaction is its ASCII shortcode, and the emoji's.
			react('blob', ALICE, EMOJI)
			// (The trigger runs before the CHECK, which backs it up.)
			expect(() => react('blob👍', BOB, EMOJI)).toThrow(/a custom emoji reaction is named by its shortcode/)
			expect(() => react('blab', BOB, EMOJI)).toThrow(/a custom emoji reaction is named by its shortcode/)
			expect(() => react('blob', BOB, '399999999999999999')).toThrow(/shortcode|FOREIGN KEY/)
			// One per (name, account); never changed.
			expect(() => react('blob', ALICE, EMOJI)).toThrow(/UNIQUE constraint failed/)
			expect(() => sql.exec("UPDATE announcement_reactions SET name = '👎'")).toThrow(
				/a reaction is added or removed, never changed/
			)
			// 8 names: the ninth refused, an existing one still added.
			for (const name of ['1', '2', '3', '4', '5', '6', '7'].map((d) => `${d}⃣`)) {
				react(name)
			}
			expect(() => react('👍')).toThrow(/announcement_reactions: more than 8 names for one announcement/)
			react('1⃣', BOB)
			react('blob', BOB, EMOJI)
			// The rows go with the announcement or the account; dismissals are one per pair.
			sql.exec('INSERT INTO announcement_dismissals (account_id, announcement_id) VALUES (?, ?)', ALICE, announcement)
			expect(() =>
				sql.exec('INSERT INTO announcement_dismissals (account_id, announcement_id) VALUES (?, ?)', ALICE, announcement)
			).toThrow(/UNIQUE|PRIMARY KEY/)
			expect(() =>
				sql.exec(
					'INSERT INTO announcement_dismissals (account_id, announcement_id) VALUES (?, ?)',
					ALICE,
					announcementId(9)
				)
			).toThrow(/FOREIGN KEY/)
			sql.exec('DELETE FROM announcements')
			expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM announcement_reactions').one().n).toBe(0)
			expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM announcement_dismissals').one().n).toBe(0)
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})
})

describe('0057_trends', () => {
	const NAME = '0057_trends'
	const at = NAMES.indexOf(NAME)
	const T = '2026-10-20T00:00:00.000Z'
	const accountId = (n: number) => String(100_000_000_000_000_000n + BigInt(n))
	const statusId = (n: number) => String(300_000_000_000_000_000n + BigInt(n))

	it('repeats the bounds of stored-bounds.ts in its literals', () => {
		const sql = MIGRATIONS[at]?.sql ?? ''
		expect([MAX_TREND_TAGS, MAX_TREND_STATUSES, TREND_STATUSES_PER_AUTHOR, MAX_TREND_REVIEWS, TREND_SCORE_MAX]).toEqual(
			[250, 250, 3, 10_000, 1e15]
		)
		expect(TREND_ALLOWED_ROWS + TREND_REVIEW_POOL).toBe(MAX_TREND_TAGS)
		expect(sql).toContain(`CONSTRAINT trend_tag_name CHECK (${trendTagNameCheckSql('name')})`)
		expect(sql).toContain(`CONSTRAINT tag_trend_review_name CHECK (${trendTagNameCheckSql('name')})`)
		expect(sql).toContain(`(SELECT count(*) FROM trend_tags) >= ${MAX_TREND_TAGS}\n`)
		expect(sql).toContain(`(SELECT count(*) FROM trend_statuses) >= ${MAX_TREND_STATUSES}\n`)
		expect(sql).toContain(`WHERE account_id = NEW.account_id) >= ${TREND_STATUSES_PER_AUTHOR}\n`)
		for (const table of ['tag_trend_reviews', 'status_trend_reviews', 'account_trend_reviews']) {
			expect(sql).toContain(`(SELECT count(*) FROM ${table}) >= ${MAX_TREND_REVIEWS}\n`)
		}
		expect(sql.match(/BETWEEN (?:score|0|0\.3) AND 1e15\b/g)).toHaveLength(3)
		expect(Object.keys(TREND_SETTING_BOUNDS)).toEqual(['trends', 'trendable_by_default'])
		// workerd refuses a LIKE or GLOB pattern over 50 bytes; the name pattern is built from char() and joined.
		for (const [, pattern] of sql.matchAll(/GLOB\s+'([^']*)'/g)) {
			expect(new TextEncoder().encode(pattern).length).toBeLessThanOrEqual(50)
		}
		const built = "'*[' || char(1) || '-/:-^`{-' || char(127) || ']*'"
		expect(sql).toContain(built)
		expect(2 + 1 + '-/:-^`{-'.length + 1 + 2).toBe(14)
	})

	async function migrated(state: DurableObjectState, authors = 2) {
		const sql = state.storage.sql
		await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username) SELECT CAST(100000000000000000 + i AS TEXT),
				'https://kopje.test/ap/users/u' || i, 'u' || i FROM n`,
			authors
		)
		return sql
	}

	// `count` public statuses of the author `author` from status number `first`.
	function statuses(sql: SqlStorage, author: number, first: number, count: number) {
		sql.exec(
			`WITH RECURSIVE n(i) AS (SELECT CAST(?1 AS INTEGER) UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(300000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/' || i, ?3, 'public', ?4 FROM n`,
			first,
			count,
			accountId(author),
			T
		)
	}

	it('holds tag names, scores and times at their bounds', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = await migrated(state)
			for (const table of ['trend_tags', 'tag_trend_reviews'] as const) {
				const insert = (name: SqlStorageValue, values: Record<string, SqlStorageValue> = {}) => {
					const row =
						table === 'trend_tags'
							? { name, score: 1, max_score: 2, max_score_at: T, ...values }
							: { name, trendable: 1, reviewed_at: T, ...values }
					sql.exec(
						`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row)
							.map(() => '?')
							.join(', ')})`,
						...Object.values(row)
					)
				}
				const check = table === 'trend_tags' ? /trend_tag_name/ : /tag_trend_review_name/
				// 1,024 bytes (256 four-byte characters) and 256 characters pass; 1,025 bytes, 257 characters fail.
				for (const name of ['\u{1F600}'.repeat(256), 'é'.repeat(256), 'a_0', 'ß']) {
					insert(name)
				}
				for (const name of [
					'\u{1F600}'.repeat(256) + 'a',
					'é'.repeat(257),
					'a'.repeat(257),
					'',
					'a\u0000',
					'\u0000',
					'a\u0001',
					'A',
					'-',
					'a b',
					'a/b',
					'a:b',
					'a^b',
					'a`b',
					'a{b',
					'a\u007f',
				]) {
					expect(() => insert(name), JSON.stringify(name)).toThrow(check)
				}
				expect(() => insert(new Uint8Array([0x61]).buffer)).toThrow(check)
				// An imported malformed name: x'C0' and 1,023 continuation bytes, 1,024 bytes and one character.
				sql.exec(
					`INSERT INTO ${table} (name, ${table === 'trend_tags' ? 'score, max_score, max_score_at' : 'trendable, reviewed_at'})
					VALUES (CAST(x'C0' || ?1 AS TEXT), ${table === 'trend_tags' ? '1, 1, ?2' : '0, ?2'})`,
					new Uint8Array(1023).fill(0x80).buffer,
					T
				)
				expect(() =>
					sql.exec(
						`INSERT INTO ${table} (name, ${table === 'trend_tags' ? 'score, max_score, max_score_at' : 'trendable, reviewed_at'})
						VALUES (CAST(x'C080' || ?1 AS TEXT), ${table === 'trend_tags' ? '1, 1, ?2' : '0, ?2'})`,
						new Uint8Array(1023).fill(0x80).buffer,
						T
					)
				).toThrow(check)
				const at = table === 'trend_tags' ? 'max_score_at' : 'reviewed_at'
				const times = table === 'trend_tags' ? /trend_tag_max_score_at_iso/ : /tag_trend_review_at_iso/
				for (const [i, value] of ['2026-10-20T23:59:59.999Z', '2026-02-28T00:00:00.001Z'].entries()) {
					insert(`t${i}`, { [at]: value })
				}
				for (const value of [
					'2026-02-30T00:00:00.000Z',
					'2026-10-12T24:00:00.000Z',
					'2026-10-12T24:01:00.000Z',
					'2026-10-12T00:00:00.00Z',
					'2026-10-12T00:00:00.000+00:00',
					'not a time at all, 24 b.',
				]) {
					expect(() => insert('x', { [at]: value }), value).toThrow(times)
				}
				expect(() => sql.exec(`UPDATE ${table} SET ${at} = '2026-10-12T24:00:00.000Z' WHERE name = 't0'`)).toThrow(
					times
				)
				sql.exec(`UPDATE ${table} SET ${at} = '2026-10-21T00:00:00.000Z' WHERE name = 't0'`)
			}
			// Scores: 0 <= score <= max_score <= 1e15, numbers only.
			const score = (s: SqlStorageValue, max: SqlStorageValue) =>
				sql.exec('INSERT INTO trend_tags (name, score, max_score, max_score_at) VALUES (?, ?, ?, ?)', 's', s, max, T)
			for (const [s, max] of [
				[-1, 1],
				[null, 1],
				[1, null],
				[1e15 + 1, 1e15 + 1],
				[2, 1],
				[new Uint8Array([0x31]).buffer, 2],
			] as const) {
				expect(() => score(s, max), JSON.stringify([s instanceof ArrayBuffer ? 'blob' : s, max])).toThrow(
					/trend_tag_scores|NOT NULL/
				)
			}
			score(0, 1e15)
			sql.exec("DELETE FROM trend_tags WHERE name = 's'")
			score(1e15, 1e15)
			// The settings: 'true' and 'false' only, for these two names; other names keep 0049's bounds.
			const setting = /instance_settings: a value past its stored bound/
			for (const name of ['trends', 'trendable_by_default']) {
				for (const value of ['true', 'false']) {
					sql.exec('INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', name, value)
				}
				for (const value of ['on', '', 'TRUE', 'true ', '1']) {
					expect(() =>
						sql.exec('INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', name, value)
					).toThrow(setting)
					expect(() => sql.exec('UPDATE instance_settings SET value = ? WHERE name = ?', value, name)).toThrow(setting)
				}
				expect(() =>
					sql.exec("INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, X'74727565')", name)
				).toThrow(setting)
				expect(storedSetting(name as 'trends', 'true')).toBe('true')
				expect(storedSetting(name as 'trends', 'yes')).toBeNull()
			}
			expect(() =>
				sql.exec("UPDATE instance_settings SET name = 'trends', value = 'x' WHERE name = 'trendable_by_default'")
			).toThrow(setting)
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'on')")
			expect(MIGRATIONS.find((m) => m.name === '0049_instance_bounds')?.sql).toContain(instanceBoundsMigrationSql())
		})
	})

	it('caps the trend tables for new keys only, so stored keys update and upsert at the cap', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = await migrated(state, 90)
			// 250 trend tags; the 251st refused; an update and an upsert of a stored key pass.
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO trend_tags (name, score, max_score, max_score_at) SELECT 't' || i, 1, 1, ?2 FROM n`,
				MAX_TREND_TAGS,
				T
			)
			const tag = (name: string) =>
				sql.exec(
					`INSERT INTO trend_tags (name, score, max_score, max_score_at) VALUES (?, 2, 3, ?)
					ON CONFLICT (name) DO UPDATE SET score = excluded.score, max_score = excluded.max_score`,
					name,
					T
				)
			expect(() => tag('new')).toThrow(/trend_tags: more than 250/)
			tag('t1')
			sql.exec("UPDATE trend_tags SET score = 5, max_score = 5 WHERE name = 't2'")
			expect(sql.exec("SELECT score FROM trend_tags WHERE name = 't1'").one().score).toBe(2)
			sql.exec("DELETE FROM trend_tags WHERE name = 't3'")
			tag('new')
			// 250 trend statuses of 84 authors at 3 each (the last at 1); the 251st refused, a stored one upserts.
			for (let a = 1; a <= 84; a++) {
				statuses(sql, a, a * 10, a === 84 ? 1 : 3)
			}
			statuses(sql, 85, 2000, 4)
			sql.exec(
				`INSERT INTO trend_statuses (status_id, account_id, score)
				SELECT id, account_id, 1 FROM statuses WHERE account_id <> ?`,
				accountId(85)
			)
			expect(sql.exec('SELECT count(*) AS n FROM trend_statuses').one().n).toBe(250)
			const trend = (id: string, author: string, score = 1) =>
				sql.exec(
					`INSERT INTO trend_statuses (status_id, account_id, score) VALUES (?, ?, ?)
					ON CONFLICT (status_id) DO UPDATE SET score = excluded.score`,
					id,
					author,
					score
				)
			expect(() => trend(statusId(2000), accountId(85))).toThrow(/trend_statuses: more than 250/)
			trend(statusId(10), accountId(1), 7)
			expect(sql.exec('SELECT score FROM trend_statuses WHERE status_id = ?', statusId(10)).one().score).toBe(7)
			// Three per author: a fourth refused, a stored one still upserted.
			sql.exec('DELETE FROM trend_statuses WHERE account_id IN (?, ?)', accountId(83), accountId(84))
			for (let i = 0; i < 3; i++) {
				trend(statusId(2000 + i), accountId(85))
			}
			expect(() => trend(statusId(2003), accountId(85))).toThrow(/trend_statuses: more than 3 for one author/)
			trend(statusId(2000), accountId(85), 9)
			// The author is the status's, and a row's status and author never change.
			sql.exec('DELETE FROM trend_statuses WHERE account_id = ?', accountId(85))
			expect(() => trend(statusId(2000), accountId(1))).toThrow(/account_id is the status's author/)
			expect(() => trend(statusId(99_999), accountId(1))).toThrow(/account_id is the status's author/)
			trend(statusId(2000), accountId(85))
			expect(() =>
				sql.exec('UPDATE trend_statuses SET account_id = ? WHERE status_id = ?', accountId(1), statusId(2000))
			).toThrow(/a row's status and author never change/)
			expect(() =>
				sql.exec('UPDATE trend_statuses SET status_id = ? WHERE status_id = ?', statusId(2001), statusId(2000))
			).toThrow(/a row's status and author never change/)
			expect(() => trend(statusId(2001), accountId(85), 0.29)).toThrow(/trend_status_score/)
			expect(() => trend(statusId(2001), accountId(85), 1e15 + 1)).toThrow(/trend_status_score/)
			// Rows go with their status, reviews with theirs.
			sql.exec(
				'INSERT INTO status_trend_reviews (status_id, trendable, reviewed_at) VALUES (?, 1, ?)',
				statusId(2000),
				T
			)
			sql.exec(
				'INSERT INTO account_trend_reviews (account_id, trendable, reviewed_at) VALUES (?, 0, ?)',
				accountId(85),
				T
			)
			sql.exec('DELETE FROM statuses WHERE id = ?', statusId(2000))
			expect(sql.exec('SELECT count(*) AS n FROM trend_statuses WHERE status_id = ?', statusId(2000)).one().n).toBe(0)
			expect(sql.exec('SELECT count(*) AS n FROM status_trend_reviews').one().n).toBe(0)
			sql.exec('DELETE FROM statuses WHERE account_id = ?', accountId(85))
			sql.exec('DELETE FROM accounts WHERE id = ?', accountId(85))
			expect(sql.exec('SELECT count(*) AS n FROM account_trend_reviews').one().n).toBe(0)
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('caps each review table at 10,000 new keys, and updates a stored decision at the cap', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = await migrated(state, MAX_TREND_REVIEWS + 1)
			statuses(sql, 1, 1, MAX_TREND_REVIEWS + 1)
			const fill = (table: string, key: string, from: string) =>
				sql.exec(
					`INSERT INTO ${table} (${key}, trendable, reviewed_at) SELECT k, 1, ?2 FROM (${from}) LIMIT ?1`,
					MAX_TREND_REVIEWS,
					T
				)
			fill(
				'tag_trend_reviews',
				'name',
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_TREND_REVIEWS}) SELECT 't' || i AS k FROM n`
			)
			fill('status_trend_reviews', 'status_id', 'SELECT id AS k FROM statuses ORDER BY id')
			fill('account_trend_reviews', 'account_id', 'SELECT id AS k FROM accounts ORDER BY id')
			for (const [table, key, stored, fresh] of [
				['tag_trend_reviews', 'name', 't1', 'fresh'],
				['status_trend_reviews', 'status_id', statusId(1), statusId(MAX_TREND_REVIEWS + 1)],
				['account_trend_reviews', 'account_id', accountId(1), accountId(MAX_TREND_REVIEWS + 1)],
			] as const) {
				const upsert = (value: string) =>
					sql.exec(
						`INSERT INTO ${table} (${key}, trendable, reviewed_at) VALUES (?, 0, ?)
						ON CONFLICT (${key}) DO UPDATE SET trendable = excluded.trendable`,
						value,
						T
					)
				expect(() => upsert(fresh)).toThrow(new RegExp(`${table}: more than 10000`))
				upsert(stored)
				expect(sql.exec(`SELECT trendable FROM ${table} WHERE ${key} = ?`, stored).one().trendable).toBe(0)
			}
		})
	}, 60_000)

	it('plans each cap trigger as a key seek and a covering count', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = await migrated(state)
			const plan = (query: string) =>
				sql
					.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
					.toArray()
					.map((r) => r.detail)
			expect(plan("SELECT 1 FROM trend_tags WHERE name = 'x'")).toEqual([
				expect.stringMatching(/SEARCH trend_tags USING (?:COVERING INDEX|PRIMARY KEY) .*\(name=\?\)/),
			])
			expect(plan("SELECT count(*) FROM trend_statuses WHERE account_id = 'x'").join('\n')).toMatch(
				/SEARCH trend_statuses USING COVERING INDEX trend_statuses_account \(account_id=\?\)/
			)
			expect(plan('SELECT count(*) FROM tag_trend_reviews').join('\n')).toMatch(/SCAN tag_trend_reviews/)
		})
	})
})

describe('0058_profile_credentials', () => {
	const NAME = '0058_profile_credentials'
	const at = NAMES.indexOf(NAME)

	it("holds profileBoundsMigrationSql's output after its header", () => {
		expectGenerated(at, profileBoundsMigrationSql())
	})

	it('keeps rows as they were, then bounds indexable as stored and the cursor', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await kernel(state, MIGRATIONS.slice(0, at)).upgrade()
			sql.exec(
				`INSERT INTO accounts (id, uri, username) VALUES ('100000000000000001', 'https://kopje.test/ap/users/a', 'a'),
					('100000000000000002', 'https://kopje.test/ap/users/b', 'b')`
			)
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES ('100000000000000001', 'a@example.com', X'00', X'00', 'k')"
			)
			await kernel(state, MIGRATIONS.slice(0, at + 1)).upgrade()
			expect(sql.exec('SELECT id, indexable FROM accounts ORDER BY id').toArray()).toEqual([
				{ id: '100000000000000001', indexable: null },
				{ id: '100000000000000002', indexable: null },
			])
			expect(sql.exec('SELECT accept_requests_after FROM local_accounts').toArray()).toEqual([
				{ accept_requests_after: null },
			])
			const setIndexable = (value: SqlStorageValue) =>
				sql.exec("UPDATE accounts SET indexable = ? WHERE id = '100000000000000002'", value)
			const insert = (value: SqlStorageValue) =>
				sql.exec(
					"INSERT INTO accounts (id, uri, username, indexable) VALUES ('100000000000000003', 'https://kopje.test/ap/users/c', 'c', ?)",
					value
				)
			for (const value of [0, 1, null]) {
				setIndexable(value)
			}
			// INTEGER affinity stores '1' as 1 (and '1' with a NUL after it, read up to the NUL), which is the stored value
			// the trigger judges.
			for (const value of ['1', '1\u0000']) {
				setIndexable(value)
				expect(
					sql.exec("SELECT typeof(indexable) AS t, indexable FROM accounts WHERE id = '100000000000000002'").one()
				).toEqual({ t: 'integer', indexable: 1 })
			}
			for (const value of ['yes', 1.5, 2, -1, new Uint8Array([1]).buffer, '\u00001']) {
				expect(() => setIndexable(value), typeof value === 'string' ? JSON.stringify(value) : typeof value).toThrow(
					/indexable past its stored bound/
				)
				expect(() => insert(value), typeof value === 'string' ? JSON.stringify(value) : typeof value).toThrow(
					/indexable past its stored bound/
				)
			}
			insert(1)
			const setCursor = (value: SqlStorageValue) =>
				sql.exec('UPDATE local_accounts SET accept_requests_after = ?', value)
			for (const value of [0, null, '9007199254740993']) {
				setCursor(value)
			}
			expect(sql.exec('SELECT CAST(accept_requests_after AS TEXT) AS c FROM local_accounts').one()).toEqual({
				c: '9007199254740993',
			})
			for (const value of [-1, 'x', 1.5]) {
				expect(() => setCursor(value), String(value)).toThrow(/accept_requests_after_cursor/)
			}
		})
	})
})
