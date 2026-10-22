import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { ACCOUNT_EMOJIS_FULL, STATUS_EMOJIS_FULL } from './emoji-fixtures'
import { BUILD, freshStore, MIGRATION_NAMES, migratedStore, rejectionOf, testKernel } from './helpers'
import {
	ACCESS,
	ADMIN_AUD,
	ADMIN_EMAIL,
	beginImport,
	collectDump,
	copyConfig,
	ensureAdmin,
	dumpViaRpc,
	finishImport,
	importChunks,
	importViaRpc,
	resetImport,
	seedStore,
	SERVICE_CLIENT_ID,
	setAccess,
	splitDump,
	tableSnapshot,
	TEAM_DOMAIN,
} from './ops-helpers'
import { blurhashOf, columnsSql, movedCountSql, seedBounded, storedSql, TABLES } from './stored-bounds-fixtures'
import { MIGRATIONS } from '../src/db/migrations'
import { accountFeaturedTags } from '../src/domain/featured-tags'
import { readOperation, sessionOperation, writeOperation } from '../src/domain/operation'
import { followedTags } from '../src/domain/tags'
import { MAX_PROFILE_UPDATES } from '../src/platform/dump-catalog'
import type { DumpTrailer, TableSpec } from '../src/platform/dump-format'
import { Sha256 } from '../src/platform/sha256'
import {
	type AdminOptions,
	IMPORT_CHUNK_WORK_BYTES,
	MAX_IMPORT_CHUNK_STATEMENTS,
	StoreAdmin,
} from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'
import type { DumpCursor } from '../src/platform/store-dump'
import { toStoreUnavailable } from '../src/platform/store-errors'
import { applyStagedLinks, MAX_LINK_STATEMENT_BYTES } from '../src/platform/store-import'

const TOKEN = { kind: 'import-token' } as const

const readSettings = readOperation<void, number>((db) => db.all('SELECT * FROM instance_settings').length)
const writeSetting = writeOperation<string, void>((db, name) => {
	db.run("INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, 'x')", name)
})
const sessionWrite = sessionOperation<string, void>((db, name) => {
	db.run("INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, 's')", name)
})

function admin(state: DurableObjectState, options: Partial<AdminOptions> = {}): StoreAdmin {
	return new StoreAdmin(state, testKernel(state), {
		source: { build: BUILD, version: 'test' },
		log: () => {},
		...options,
	})
}

function withoutState(snapshot: Record<string, string[]>): Record<string, string[]> {
	const { kopje_state: _state, ...rest } = snapshot
	return rest
}

async function seeded(statuses = 30): Promise<StoreStub> {
	const store = await migratedStore()
	await seedStore(store, statuses)
	return store
}

describe('dump', () => {
	it('round-trips into a fresh Store with equal checksums and identical rows', async () => {
		const source = await seeded()
		const { text, chunks } = await dumpViaRpc(source, 4096)
		expect(chunks).toBeGreaterThan(3)
		const { trailer } = splitDump(text) as { trailer: DumpTrailer }

		// Configuration (here the domain) is set with config, never imported.
		const target = await migratedStore()
		await copyConfig(source, target)
		const { report, chunks: sent } = await importViaRpc(target, text, 8 * 1024)
		expect(sent).toBeGreaterThan(1)
		expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0, problems: [] })
		expect(report?.tables.map((t) => [t.name, t.rows, t.checksum])).toEqual(
			trailer.tables.map((t) => [t.name, t.rows, t.checksum])
		)

		// An independent comparison (typed hex of every value) agrees.
		expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(source)))
		const mutes = 'SELECT hide_notifications, expires_at FROM mutes'
		const read = (store: StoreStub) =>
			runInDurableObject(store, (_instance, state) => state.storage.sql.exec(mutes).toArray())
		expect(await read(target)).toEqual([{ hide_notifications: 0, expires_at: '2026-10-13T00:00:00.000Z' }])
		const state = (await tableSnapshot(target)).kopje_state
		expect(state).toContain('last_local_id=110000000000000099')
		expect(state).not.toContain('upgrade_bookmark=source-only')
		// The imported Store serves again.
		expect(await target.setupState(BUILD)).toEqual({ complete: true })
	})

	it('round-trips a remote report and the report id counter (0054_remote_reports)', async () => {
		const source = await seeded()
		await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				"INSERT INTO accounts (id, uri, username, domain) VALUES ('190000000000000001', 'https://r.example/actor', 'actor', 'r.example')"
			)
			const target = sql.exec<{ id: string }>('SELECT account_id AS id FROM local_accounts LIMIT 1').one().id
			sql.exec(
				`INSERT INTO reports (id, account_id, target_account_id, comment, uri, created_at)
				VALUES (7, '190000000000000001', ?1, 'remote', 'https://r.example/flags/1', 'x'),
					(9, '190000000000000001', ?1, '', 'https://r.example/flags/2', 'x')`,
				target
			)
			sql.exec('DELETE FROM reports WHERE id = 9')
		})
		const { text } = await dumpViaRpc(source, 4096)
		expect(text).toMatch(/^INSERT INTO "sqlite_sequence" \("name","seq"\) VALUES \('reports',9\);$/m)
		const target = await migratedStore()
		await copyConfig(source, target)
		const { report } = await importViaRpc(target, text, 8 * 1024)
		expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0, problems: [] })
		expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(source)))
		const next = await runInDurableObject(target, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				`INSERT INTO reports (account_id, target_account_id, uri, created_at)
				SELECT account_id, target_account_id, 'https://r.example/flags/3', 'x' FROM reports WHERE id = 7`
			)
			return sql.exec<{ id: number }>("SELECT id FROM reports WHERE uri = 'https://r.example/flags/3'").one().id
		})
		expect(next).toBe(10)
	})

	// The streaming journal's trigger (migration 0026_streaming) makes SQLite start the journal's AUTOINCREMENT counter
	// on the first notification insert, recording or not; restored notifications must not leave a counter the dump lacks.
	it('round-trips a Store upgraded to 0026_streaming with notifications written before it', async () => {
		const source = freshStore()
		const before = MIGRATIONS.slice(0, MIGRATION_NAMES.indexOf('0026_streaming'))
		await runInDurableObject(source, (_instance, state) => testKernel(state, before).upgrade())
		await seedStore(source, 3)
		await runInDurableObject(source, (_instance, state) => testKernel(state).upgrade())
		const { text } = await dumpViaRpc(source)
		const target = await migratedStore()
		await copyConfig(source, target)
		const { report } = await importViaRpc(target, text)
		expect(report).toMatchObject({ ok: true, problems: [] })
		expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(source)))
	})

	// A dump of a Store migrated to just before `migration`, seeded by `seed`, imported and verified into a Store at the
	// same migrations (the import requires them equal), all through StoreAdmin over kernels of those migrations, so
	// nothing upgrades the Store on its own. `check` then runs in the target, given the kernel that applies `migration`.
	async function restoredBefore(
		migration: string,
		seed: (sql: SqlStorage) => void,
		check: (sql: SqlStorage, upgrade: () => ReturnType<ReturnType<typeof testKernel>['upgrade']>) => Promise<void>
	): Promise<void> {
		const before = MIGRATIONS.slice(0, MIGRATION_NAMES.indexOf(migration))
		const options = { source: { build: BUILD, version: 'test' }, log: () => {} }
		const source = freshStore()
		const text = await runInDurableObject(source, async (_instance, state) => {
			await state.storage.deleteAlarm()
			expect(await testKernel(state, before).upgrade()).toMatchObject({ ok: true })
			seed(state.storage.sql)
			const dumping = new StoreAdmin(state, testKernel(state, before), options)
			return (
				await collectDump({
					start: () => dumping.dumpStart(),
					next: (cursor) => dumping.dumpNext(cursor),
					finish: (cursor) => dumping.dumpFinish(cursor),
				})
			).text
		})
		const chunks = await importChunks(text, 64 * 1024)
		const target = freshStore()
		await runInDurableObject(target, async (_instance, state) => {
			const sql = state.storage.sql
			await state.storage.deleteAlarm()
			expect(await testKernel(state, before).upgrade()).toMatchObject({ ok: true })
			for (const [name, value] of Object.entries({
				access_team_domain: TEAM_DOMAIN,
				access_admin_aud: ADMIN_AUD,
				admin_email: ADMIN_EMAIL,
				access_service_token_client_id: SERVICE_CLIENT_ID,
			})) {
				sql.exec('INSERT INTO instance_settings (name, value) VALUES (?, ?)', name, value)
			}
			const importing = new StoreAdmin(state, testKernel(state, before), options)
			const { header, trailer } = splitDump(text)
			const begun = await importing.importBegin(BUILD, ACCESS, header)
			if (!begun.ok) {
				throw new Error(begun.message)
			}
			const id = begun.progress.id
			for (const [i, chunk] of chunks.entries()) {
				expect(await importing.importChunk(BUILD, ACCESS, id, i + 1, chunk)).toMatchObject({ ok: true })
			}
			expect(await importing.importFinish(BUILD, ACCESS, id, trailer)).toMatchObject({ ok: true })
			for (;;) {
				const verified = await importing.importVerify(BUILD, ACCESS, id)
				if (!verified.ok) {
					throw new Error(verified.message)
				}
				if (verified.done) {
					expect(verified.report).toMatchObject({ ok: true, problems: [] })
					break
				}
			}
			await check(sql, () => testKernel(state, MIGRATIONS.slice(0, before.length + 1)).upgrade())
		})
	}

	// RES-2: a dump taken before 0048_stored_bounds, of rows past their stored bounds, restores into a Store at the
	// same migrations, which then upgrades through 0048 to P(x) of every value.
	it('restores a dump taken before 0048_stored_bounds, which then upgrades through it', async () => {
		await restoredBefore('0048_stored_bounds', seedBounded, async (sql, upgrade) => {
			const expected = TABLES.map((table) => sql.exec(storedSql(table)).toArray())
			expect(TABLES.map((table) => sql.exec<{ n: number }>(movedCountSql(table)).one().n).every((n) => n > 0)).toBe(
				true
			)
			expect(await upgrade()).toMatchObject({ ok: true, applied: ['0048_stored_bounds'] })
			expect(TABLES.map((table) => sql.exec(columnsSql(table)).toArray())).toEqual(expected)
			expect(TABLES.map((table) => sql.exec<{ n: number }>(movedCountSql(table)).one().n)).toEqual([0, 0, 0, 0])
		})
	}, 120_000)

	// RES-2: a dump taken before 0049_instance_bounds, of instance settings past their stored bounds, restores into a
	// Store at the same migrations, which then upgrades through 0049 to P(x) of every value (no row where P is none).
	it('restores a dump taken before 0049_instance_bounds, which then upgrades through it', async () => {
		const settings = {
			title: 'T'.repeat(1500),
			description: `${' '.repeat(200)}tail`,
			contact_email: `${'e'.repeat(300)}@example.com`,
			privacy_policy: `<p>${'p'.repeat(50_000)}</p>`,
			extended_description: '<p>kept</p>',
			terms_of_service: ' \v ',
			show_domain_blocks: 'everyone',
		}
		const seed = (sql: SqlStorage) => {
			for (const [name, value] of Object.entries(settings)) {
				sql.exec('INSERT INTO instance_settings (name, value) VALUES (?, ?)', name, value)
			}
		}
		await restoredBefore('0049_instance_bounds', seed, async (sql, upgrade) => {
			const names = Object.keys(settings)
			const read = () =>
				sql
					.exec<{ name: string; value: string }>(
						`SELECT name, value FROM instance_settings WHERE name IN (${names.map(() => '?').join(', ')}) ORDER BY name`,
						...names
					)
					.toArray()
			expect(read()).toHaveLength(names.length)
			expect(await upgrade()).toMatchObject({ ok: true, applied: ['0049_instance_bounds'] })
			// The description's first 200 code points are blank, so it goes too.
			expect(read()).toEqual([
				{ name: 'extended_description', value: '<p>kept</p>' },
				{ name: 'title', value: 'T'.repeat(1024) },
			])
		})
	}, 120_000)

	// RES-2: a dump taken before 0053_custom_emoji_snapshots restores and upgrades with no emoji; one taken after carries
	// the snapshots verbatim, at their stored caps, and the import's triggers accept them.
	// A dump taken before 0056_announcements restores into a Store at its migrations
	// (an import requires the same migrations), which then upgrades through 0056 with its rows and no announcement.
	// A dump taken before 0057_trends restores into a Store at its migrations, which then upgrades through 0057 with its
	// rows and no trend.
	it('restores a dump taken before 0057_trends, which then upgrades through it', async () => {
		await restoredBefore(
			'0057_trends',
			(sql) => {
				sql.exec(
					"INSERT INTO accounts (id, uri, username) VALUES ('100000000000000001', 'https://kopje.test/ap/users/a', 'a')"
				)
			},
			async (sql, upgrade) => {
				expect(sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'trend_tags'").toArray()).toEqual([])
				expect(await upgrade()).toMatchObject({ ok: true, applied: ['0057_trends'] })
				expect(sql.exec('SELECT username FROM accounts').toArray()).toEqual([{ username: 'a' }])
				expect(sql.exec('SELECT count(*) AS n FROM trend_tags').one().n).toBe(0)
			}
		)
	}, 120_000)

	it('restores a dump taken before 0056_announcements, which then upgrades through it', async () => {
		await restoredBefore(
			'0056_announcements',
			(sql) => {
				sql.exec(
					"INSERT INTO accounts (id, uri, username) VALUES ('100000000000000001', 'https://kopje.test/ap/users/a', 'a')"
				)
			},
			async (sql, upgrade) => {
				expect(sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'announcements'").toArray()).toEqual([])
				expect(await upgrade()).toMatchObject({ ok: true, applied: ['0056_announcements'] })
				expect(sql.exec('SELECT username FROM accounts').toArray()).toEqual([{ username: 'a' }])
				expect(sql.exec('SELECT count(*) AS n FROM announcements').one().n).toBe(0)
			}
		)
	}, 120_000)

	it('restores a dump taken before 0053_custom_emoji_snapshots, and round-trips snapshots at their caps', async () => {
		const seedAccounts = (sql: SqlStorage) =>
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice', NULL),
					('100000000000000002', 'https://remote.test/users/bob', 'bob', 'remote.test')`
			)
		await restoredBefore('0053_custom_emoji_snapshots', seedAccounts, async (sql, upgrade) => {
			expect(await upgrade()).toMatchObject({ ok: true, applied: ['0053_custom_emoji_snapshots'] })
			expect(sql.exec('SELECT DISTINCT emojis FROM accounts').toArray()).toEqual([{ emojis: null }])
		})
		const source = await seeded(3)
		await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec('UPDATE accounts SET emojis = ? WHERE domain IS NOT NULL', ACCOUNT_EMOJIS_FULL)
			sql.exec('UPDATE statuses SET emojis = ? WHERE reblog_of_id IS NULL', STATUS_EMOJIS_FULL)
		})
		const { text } = await dumpViaRpc(source)
		const target = await migratedStore()
		await copyConfig(source, target)
		const { report } = await importViaRpc(target, text)
		expect(report).toMatchObject({ ok: true, problems: [] })
		expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(source)))
		const read = (store: StoreStub) =>
			runInDurableObject(store, (_instance, state) =>
				state.storage.sql.exec('SELECT emojis FROM accounts UNION ALL SELECT emojis FROM statuses').toArray()
			)
		expect((await read(target)).filter((row) => row.emojis !== null).length).toBeGreaterThan(1)
		expect(await read(target)).toEqual(await read(source))
	}, 120_000)

	// RES-2: a snapshot holding a raw NUL after a complete JSON value, which SQLite's JSON functions read as valid, is
	// refused by the importer's insert (the triggers of 0053), so no stored row can fail its presentation.
	it('refuses a snapshot with a raw NUL after a complete value on import', async () => {
		const source = await seeded(3)
		await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			// Written past the trigger, as a dump from elsewhere could hold it.
			sql.exec('DROP TRIGGER accounts_emojis_update')
			sql.exec('UPDATE accounts SET emojis = ? WHERE domain IS NOT NULL', '[["a","http://a/"]]\u0000junk')
			expect(
				sql.exec("SELECT instr(CAST(emojis AS BLOB), X'00') AS at FROM accounts WHERE domain IS NOT NULL").one().at
			).toBe(20)
		})
		const { text } = await dumpViaRpc(source)
		const target = await migratedStore()
		await copyConfig(source, target)
		const refused = await importViaRpc(target, text).then(
			() => null,
			(error: unknown) => String(error)
		)
		expect(refused).toMatch(/accounts: emojis past their stored bound/)
	}, 120_000)

	it('round-trips active_on and contact_username (0059), and refuses either past its bound on import', async () => {
		const source = await seeded(0)
		await runInDurableObject(source, (_instance, state) => {
			state.storage.sql.exec("UPDATE local_accounts SET active_on = '2026-10-21'")
			state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('contact_username', 'alice')")
		})
		const { text } = await dumpViaRpc(source)
		const restored = await migratedStore()
		await copyConfig(source, restored)
		await importViaRpc(restored, text)
		await runInDurableObject(restored, (_instance, state) => {
			const sql = state.storage.sql
			expect(sql.exec('SELECT active_on FROM local_accounts').toArray()).toEqual([{ active_on: '2026-10-21' }])
			expect(sql.exec("SELECT value FROM instance_settings WHERE name = 'contact_username'").one().value).toBe('alice')
		})
		// A dump from elsewhere, as its text could hold it: a date that is none, a contact_username of the wrong shape and
		// one of another storage class.
		const contact = (value: string) => text.replace("'contact_username','alice'", `'contact_username',${value}`)
		expect(contact("'x'")).not.toBe(text)
		for (const [dump, refused] of [
			[text.replace("'2026-10-21'", "'2026-13-01'"), /active_on_date/],
			[contact("'a@b@c'"), /instance_settings: a value past its stored bound/],
			[contact("X'61'"), /instance_settings: a value past its stored bound/],
		] as const) {
			expect(dump).not.toBe(text)
			const target = await migratedStore()
			await copyConfig(source, target)
			expect(String(await rejectionOf(importViaRpc(target, dump)))).toMatch(refused)
		}
	}, 120_000)

	it('round-trips moved_to_account_id (0060), and refuses one past its bound on import', async () => {
		const source = await seeded(0)
		const [mover, target] = await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain) VALUES
					('880000000000000001', 'https://remote.test/users/m', 'm', 'remote.test'),
					('880000000000000002', 'https://remote.test/users/t', 't', 'remote.test')`
			)
			sql.exec("UPDATE accounts SET moved_to_account_id = '880000000000000002' WHERE id = '880000000000000001'")
			return ['880000000000000001', '880000000000000002']
		})
		const { text } = await dumpViaRpc(source)
		const restored = await migratedStore()
		await copyConfig(source, restored)
		await importViaRpc(restored, text)
		await runInDurableObject(restored, (_instance, state) => {
			expect(state.storage.sql.exec('SELECT moved_to_account_id AS m FROM accounts WHERE id = ?', mover).one().m).toBe(
				target
			)
		})
		// A dump from elsewhere, as its text could hold it: the row's own id, and an id of the wrong length.
		// The mover's row, as the dump's text holds it, naming the target.
		const quoted = `'${target}'`
		const line = text.split('\n').find((row) => row.includes(`'${mover}'`) && row.includes(quoted))!
		expect(line).toBeDefined()
		for (const value of [`'${mover}'`, `'${target}0'`]) {
			const dump = text.replace(line, line.replace(quoted, value))
			expect(dump).not.toBe(text)
			const target = await migratedStore()
			await copyConfig(source, target)
			expect(String(await rejectionOf(importViaRpc(target, dump)))).toMatch(
				/accounts: moved_to_account_id past its stored bound/
			)
		}
	}, 120_000)

	it('round-trips the static images (0061), and refuses one past its bound on import', async () => {
		const source = await seeded(0)
		const still = 'https://kopje.test/media/AAAA/small.webp'
		const id = await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			const local = sql
				.exec<{ id: string }>('SELECT id FROM accounts WHERE domain IS NULL ORDER BY id LIMIT 1')
				.one().id
			sql.exec(
				`UPDATE accounts SET avatar_url = 'https://kopje.test/media/AAAA/full.webp', avatar_static_url = ?1,
					header_url = 'https://kopje.test/media/BBBB/full.png' WHERE id = ?2`,
				still,
				local
			)
			return local
		})
		const { text } = await dumpViaRpc(source)
		const restored = await migratedStore()
		await copyConfig(source, restored)
		await importViaRpc(restored, text)
		await runInDurableObject(restored, (_instance, state) => {
			expect(
				state.storage.sql
					.exec('SELECT avatar_static_url AS a, header_static_url AS h FROM accounts WHERE id = ?', id)
					.one()
			).toEqual({ a: still, h: null })
		})
		// A dump from elsewhere, as its text could hold it: a static of 513 bytes.
		const quoted = `'${still}'`
		const line = text.split('\n').find((row) => row.includes(quoted))!
		expect(line).toBeDefined()
		const dump = text.replace(line, line.replace(quoted, `'https://x/${'a'.repeat(503)}'`))
		expect(dump).not.toBe(text)
		const target = await migratedStore()
		await copyConfig(source, target)
		expect(String(await rejectionOf(importViaRpc(target, dump)))).toMatch(
			/accounts: static image past its stored bound/
		)
	}, 120_000)

	it('round-trips status apps (0064), a dangling one too, and refuses one past its bound on import', async () => {
		const source = await seeded(0)
		const client = 'A'.repeat(43)
		const ids = await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			const local = sql
				.exec<{ id: string }>('SELECT id FROM accounts WHERE domain IS NULL ORDER BY id LIMIT 1')
				.one().id
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, website) VALUES (?, 's', 'Dumped', 'urn:x', NULL)",
				client
			)
			const insert = (id: string, app: string) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, application_id)
					VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'public', '<p>x</p>', '2026-10-22T00:00:00.000Z', ?3)`,
					id,
					local,
					app
				)
			// One through an app the dump holds, one through an app since removed.
			insert('990000000000000001', client)
			insert('990000000000000002', 'gone-app')
			return ['990000000000000001', '990000000000000002']
		})
		const { text } = await dumpViaRpc(source)
		const restored = await migratedStore()
		await copyConfig(source, restored)
		await importViaRpc(restored, text)
		await runInDurableObject(restored, (_instance, state) => {
			expect(
				state.storage.sql
					.exec('SELECT id, application_id FROM statuses WHERE id IN (?, ?) ORDER BY id', ...ids)
					.toArray()
			).toEqual([
				{ id: ids[0], application_id: client },
				{ id: ids[1], application_id: 'gone-app' },
			])
		})
		// A dump from elsewhere, as its text could hold it: an id of 65 bytes.
		const quoted = "'gone-app'"
		const line = text.split('\n').find((row) => row.includes(quoted))!
		expect(line).toBeDefined()
		const dump = text.replace(line, line.replace(quoted, `'${'a'.repeat(65)}'`))
		expect(dump).not.toBe(text)
		const target = await migratedStore()
		await copyConfig(source, target)
		expect(String(await rejectionOf(importViaRpc(target, dump)))).toMatch(
			/statuses: application_id past its stored bound/
		)
	}, 120_000)

	it('restores followed and featured hashtags past the list bound as they are, which the lists leave out', async () => {
		const source = await seeded(0)
		const long = 'a'.repeat(300)
		const local = await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			const id = sql.exec<{ id: string }>('SELECT id FROM accounts WHERE domain IS NULL ORDER BY id LIMIT 1').one().id
			for (const name of [long, 'kept']) {
				sql.exec('INSERT INTO tag_follows (account_id, name) VALUES (?, ?)', id, name)
			}
			sql.exec(
				`INSERT INTO featured_tags (id, account_id, name, display_name)
				VALUES ('990000000000000001', ?1, ?2, ?2), ('990000000000000002', ?1, 'kept', 'Kept')`,
				id,
				long
			)
			return id
		})
		const { text } = await dumpViaRpc(source)
		const restored = await migratedStore()
		await copyConfig(source, restored)
		await importViaRpc(restored, text)
		await runInDurableObject(restored, (_instance, state) => {
			const sql = state.storage.sql
			expect(sql.exec('SELECT length(name) AS n FROM tag_follows ORDER BY id').toArray()).toEqual([
				{ n: 300 },
				{ n: 4 },
			])
			expect(sql.exec('SELECT length(display_name) AS n FROM featured_tags ORDER BY id').toArray()).toEqual([
				{ n: 300 },
				{ n: 4 },
			])
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('restored', 's', 'r', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('restored-token', 'access', 'restored', ?, 'read')",
				local
			)
			const followed = followedTags.run(sql, {
				credential: { tokenHash: 'restored-token', scope: 'read', now: Date.parse('2026-10-22T00:00:00.000Z') },
				page: { limit: 40 },
				present: { origin: 'https://kopje.test' },
			})
			expect(followed.status === 'ok' && followed.value.items.map((tag) => tag.name)).toEqual(['kept'])
			const featured = accountFeaturedTags.run(sql, { id: local, present: { origin: 'https://kopje.test' } })
			expect(featured?.map((tag) => tag.name)).toEqual(['Kept'])
		})
	}, 60_000)

	it('round-trips media blurhash (0065) and refuses one past its bound on import', async () => {
		const source = await seeded(0)
		const blurhash = blurhashOf(5, 5, '~')
		const id = await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			const remote = sql
				.exec<{ id: string }>('SELECT id FROM accounts WHERE domain IS NOT NULL ORDER BY id LIMIT 1')
				.one().id
			sql.exec(
				`INSERT INTO media_attachments (id, account_id, type, url, blurhash)
				VALUES ('990000000000000011', ?, 'image', 'https://remote.test/m/1', ?)`,
				remote,
				blurhash
			)
			return '990000000000000011'
		})
		const { text } = await dumpViaRpc(source)
		const restored = await migratedStore()
		await copyConfig(source, restored)
		await importViaRpc(restored, text)
		await runInDurableObject(restored, (_instance, state) => {
			expect(state.storage.sql.exec('SELECT blurhash FROM media_attachments WHERE id = ?', id).toArray()).toEqual([
				{ blurhash },
			])
		})
		// A dump from elsewhere, as its text could hold it: a blurhash of 55 bytes.
		const quoted = `'${blurhash}'`
		expect(text).toContain(quoted)
		const dump = text.replace(quoted, `'${blurhash}~'`)
		const target = await migratedStore()
		await copyConfig(source, target)
		expect(String(await rejectionOf(importViaRpc(target, dump)))).toMatch(
			/media_attachments: blurhash past its stored bound/
		)
	}, 120_000)

	it('round-trips field verification (0066), an open claim too, and refuses values past their bounds on import', async () => {
		const source = await seeded(0)
		const verified = JSON.stringify([['https://site.example/', '2026-10-22T00:00:00.000Z']])
		const local = await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			const id = sql
				.exec<{ account_id: string }>('SELECT account_id FROM local_accounts ORDER BY account_id LIMIT 1')
				.one().account_id
			sql.exec(
				`UPDATE local_accounts SET links_due_at = 1700000300000, links_hold_until = 1700000300000, links_claim = 7,
					links_attempts = 1, verified_links = ? WHERE account_id = ?`,
				verified,
				id
			)
			return id
		})
		const { text } = await dumpViaRpc(source)
		const restored = await migratedStore()
		await copyConfig(source, restored)
		await importViaRpc(restored, text)
		await runInDurableObject(restored, (_instance, state) => {
			expect(
				state.storage.sql
					.exec(
						`SELECT links_due_at, links_hold_until, links_claim, links_attempts, verified_links FROM local_accounts
						WHERE account_id = ?`,
						local
					)
					.toArray()
			).toEqual([
				{
					links_due_at: 1700000300000,
					links_hold_until: 1700000300000,
					links_claim: 7,
					links_attempts: 1,
					verified_links: verified,
				},
			])
		})
		// Dumps from elsewhere, as their text could hold them.
		const quoted = `'${verified}'`
		expect(text).toContain(quoted)
		for (const [dump, refusal] of [
			[
				text.replace(quoted, `'${verified.replace('.000Z', '.000')}'`),
				/local_accounts: verified_links past its stored bound/,
			],
			[text.replace(',7,1,', ',7,3,'), /links_attempts_count/],
			[text.replace(',7,1,', ',-7,1,'), /links_claim_count/],
			[text.replace('1700000300000,1700000300000', '-1,1700000300000'), /links_due_at_time/],
			[text.replace('1700000300000,1700000300000', '1700000300000,-1'), /links_hold_until_time/],
		] as const) {
			expect(dump).not.toBe(text)
			const target = await migratedStore()
			await copyConfig(source, target)
			expect(String(await rejectionOf(importViaRpc(target, dump)))).toMatch(refusal)
		}
	}, 120_000)

	it('restores a dump taken before 0066_field_verification, which then upgrades through it', async () => {
		await restoredBefore(
			'0066_field_verification',
			(sql) => {
				sql.exec(
					"INSERT INTO accounts (id, uri, username) VALUES ('100000000000000001', 'https://kopje.test/ap/users/a', 'a')"
				)
				sql.exec(
					`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, fields)
					VALUES ('100000000000000001', 'a@example.com', X'00', X'00', 'k', '[{"name":"n","value":"https://a.example/"}]')`
				)
			},
			async (sql, upgrade) => {
				expect(await upgrade()).toMatchObject({ ok: true, applied: ['0066_field_verification'] })
				expect(sql.exec('SELECT links_due_at, links_attempts, verified_links FROM local_accounts').toArray()).toEqual([
					{ links_due_at: null, links_attempts: 0, verified_links: null },
				])
			}
		)
	}, 120_000)

	it('writes the documented format and leaves out bookkeeping', async () => {
		const { text } = await dumpViaRpc(await seeded(0))
		const lines = text.split('\n')
		expect(lines[0]).toMatch(/^-- kopje-dump-header \{"format":1,/)
		expect(lines.at(-2)).toBe('-- kopje-dump-end')
		expect(text).toContain(`CAST(X'6E756C00696E7369646520277127203B0A' AS TEXT)`)
		expect(text).toContain(`X'000102FF270A'`)
		expect(text).toMatch(
			/^UPDATE "statuses" SET "reblog_of_id"=NULL,"in_reply_to_id"='110000000000000011' WHERE "id"='110000000000000010';$/m
		)
		expect(text).toMatch(/^INSERT INTO "sqlite_sequence" \("name","seq"\) VALUES \('notifications',9\);$/m)
		expect(text).toMatch(
			/^INSERT INTO "kopje_state" \("name","value"\) VALUES \('last_local_id','110000000000000099'\);$/m
		)
		expect(text).not.toContain('source-only')
		expect(text).not.toContain('kopje_migrations')
		expect(text).not.toContain('_cf_')
		const header = splitDump(text).header as { tables: { name: string }[]; migrations: { name: string }[] }
		expect(header.migrations.map((m) => m.name)).toEqual(MIGRATION_NAMES)
		// Parents come before children; sqlite_sequence is last.
		const order = header.tables.map((t) => t.name)
		expect(order.indexOf('accounts')).toBeLessThan(order.indexOf('local_accounts'))
		expect(order.indexOf('statuses')).toBeLessThan(order.indexOf('status_tags'))
		expect(order.at(-1)).toBe('sqlite_sequence')
	})

	it('resumes from a saved cursor with no gap and no overlap', async () => {
		const source = await seeded(40)
		const straight = splitDump((await dumpViaRpc(source, 2048)).text)

		const started = await source.dumpStart(BUILD)
		if (!started.ok) throw new Error(started.message)
		let cursor: DumpCursor = started.cursor
		const body: string[] = []
		let step = 0
		for (;;) {
			const next = await source.dumpNext(BUILD, cursor, 2048)
			if (!next.ok) throw new Error(next.message)
			step++
			if (step === 4) {
				// The response is lost: the caller still holds the old cursor and asks again.
				const again = await source.dumpNext(BUILD, cursor, 2048)
				if (!again.ok) throw new Error(again.message)
				expect(again.chunk).toEqual(next.chunk)
				expect(again.cursor).toEqual(next.cursor)
			}
			body.push(new TextDecoder().decode(next.chunk))
			cursor = next.cursor
			if (next.done) break
		}
		const finished = await source.dumpFinish(BUILD, cursor)
		if (!finished.ok || finished.trailer === null) throw new Error('finish failed')

		expect(body.join('')).toBe(straight.body)
		expect(finished.trailer).toEqual(straight.trailer)
		const inserts = body
			.join('')
			.split('\n')
			.filter((l) => l.startsWith('INSERT'))
		expect(new Set(inserts).size).toBe(inserts.length)
	})

	it('freezes session writes, writes and the upgrade alarm, but not reads', async () => {
		const store = await seeded(0)
		const started = await store.dumpStart(BUILD)
		if (!started.ok) throw new Error(started.message)

		await runInDurableObject(store, async (_instance, state) => {
			const kernel = testKernel(state)
			expect(await kernel.execute(BUILD, readSettings, undefined)).toBeGreaterThan(0)
			await expect(kernel.execute(BUILD, sessionWrite, 'login')).rejects.toThrow('dump-in-progress')
			await expect(kernel.execute(BUILD, writeSetting, 'post')).rejects.toThrow('dump-in-progress')
		})
		const delete_ = { type: 'Delete' as const, id: 'https://remote.example/d', object: 'https://remote.example/o' }
		const inbox = toStoreUnavailable(
			await rejectionOf(
				store.receiveActivity(BUILD, {
					now: 1,
					origin: 'https://kopje.test',
					actorUri: 'https://remote.example/users/a',
					actor: null,
					activity: delete_,
				})
			)
		)
		expect(inbox?.reason).toBe('dump-in-progress')
		expect(await store.health(BUILD)).toMatchObject({ readonly: true, dump: { id: started.cursor.dump } })

		expect(await store.dumpFinish(BUILD, started.cursor, true)).toMatchObject({ ok: true, aborted: true })
		await runInDurableObject(store, async (_instance, state) => {
			await testKernel(state).execute(BUILD, sessionWrite, 'login')
		})
	})

	it('defers a pending upgrade while frozen and resumes it after the dump', async () => {
		const store = freshStore()
		const started = await store.dumpStart(BUILD)
		if (!started.ok) throw new Error(started.message)
		await runInDurableObject(store, async (_instance, state) => {
			const result = await testKernel(state).upgrade()
			expect(result).toMatchObject({ ok: false, reason: 'dump-in-progress' })
			expect(state.storage.sql.exec('SELECT count(*) AS n FROM kopje_migrations').one().n).toBe(0)
			expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + 60_000)
		})
		expect(await store.dumpFinish(BUILD, started.cursor, true)).toMatchObject({ ok: true })
		// Finishing the dump schedules the deferred upgrade right away instead of after the lease (it may have run).
		await runInDurableObject(store, async (_instance, state) => {
			const alarm = await state.storage.getAlarm()
			expect(alarm === null || alarm <= Date.now() + 1000).toBe(true)
		})
		await runDurableObjectAlarm(store)
		// The alarm may already be running on its own, awaiting the bookmark, when the test asks for it.
		await vi.waitFor(async () =>
			expect(await store.health(BUILD)).toMatchObject({ schema: { status: 'current' }, readonly: false })
		)
	})

	it('releases the freeze when the lease expires and refuses to continue that dump', async () => {
		const store = await seeded(0)
		const t0 = Date.parse('2026-10-12T00:00:00Z')
		await runInDurableObject(store, async (_instance, state) => {
			const early = admin(state, { now: () => t0 })
			const started = await early.dumpStart(30)
			if (!started.ok) throw new Error(started.message)
			const frozen = testKernel(state, undefined, { now: () => t0 + 29_000 })
			await expect(frozen.execute(BUILD, writeSetting, 'a')).rejects.toThrow('dump-in-progress')

			const late = admin(state, { now: () => t0 + 31_000 })
			await testKernel(state, undefined, { now: () => t0 + 31_000 }).execute(BUILD, writeSetting, 'b')
			expect(await late.dumpNext(started.cursor)).toMatchObject({ ok: false, code: 'dump-lease-expired' })
			expect(await late.dumpStart()).toMatchObject({ ok: true })
		})
	})

	it('refuses a second dump while the first holds the lease', async () => {
		const store = await seeded(0)
		expect(await store.dumpStart(BUILD)).toMatchObject({ ok: true })
		expect(await store.dumpStart(BUILD)).toMatchObject({ ok: false, code: 'dump-in-progress' })
	})
})

describe('import', () => {
	it('resumes after an interruption from the recorded chunk', async () => {
		const { text } = await dumpViaRpc(await seeded(), 4096)
		const chunks = await importChunks(text, 4096)
		expect(chunks.length).toBeGreaterThan(4)
		const target = await migratedStore()
		const id = await beginImport(target, text)
		let digest = ''
		for (const [i, chunk] of chunks.slice(0, 3).entries()) {
			expect(await target.importChunk(BUILD, ACCESS, id, i + 1, chunk)).toMatchObject({ ok: true })
			digest = new Sha256().update(digest).update(chunk).hex()
		}

		// The client restarts: begin with the same header resumes the same import.
		const resumed = await target.importBegin(BUILD, ACCESS, splitDump(text).header)
		expect(resumed).toMatchObject({ ok: true, resumed: true, progress: { id, lastSeq: 3, digest } })
		// A chunk sent twice is reported, not applied twice.
		expect(await target.importChunk(BUILD, ACCESS, id, 3, chunks[2]!)).toMatchObject({ ok: true, duplicate: true })
		expect(await target.importChunk(BUILD, ACCESS, id, 5, chunks[4]!)).toMatchObject({
			ok: false,
			code: 'out-of-order',
		})
		for (const [i, chunk] of chunks.entries()) {
			if (i >= 3) {
				expect(await target.importChunk(BUILD, ACCESS, id, i + 1, chunk)).toMatchObject({ ok: true, duplicate: false })
			}
		}
		expect(await finishImport(target, id, text)).toMatchObject({ ok: true })
	})

	it('reports a chunk that failed after committing as applied, and verify catches a stray durable write', async () => {
		const source = await seeded()
		const { text } = await dumpViaRpc(source, 4096)
		const chunks = await importChunks(text, 4096)
		const target = await migratedStore()
		await copyConfig(source, target)
		const id = await beginImport(target, text)

		await runInDurableObject(target, async (_instance, state) => {
			const faulty = admin(state, {
				inject: (point, sql) => {
					if (point === 'import-chunk-in-transaction') {
						// A write that is not part of the dump, committed with the chunk.
						sql.exec("INSERT INTO instance_settings (name, value) VALUES ('stray', 'x')")
					}
					if (point === 'import-chunk-after-commit') {
						throw new Error('Durable Object storage operation exceeded timeout which caused object to be reset.')
					}
				},
			})
			const result = await faulty.importChunk(BUILD, ACCESS, id, 1, chunks[0]!)
			expect(result).toMatchObject({ ok: false, code: 'chunk-failed', applied: true, progress: { lastSeq: 1 } })
		})
		// The client trusted the re-read progress and continues with chunk 2.
		for (const [i, chunk] of chunks.entries()) {
			if (i >= 1) {
				expect(await target.importChunk(BUILD, ACCESS, id, i + 1, chunk)).toMatchObject({ ok: true })
			}
		}
		const report = await finishImport(target, id, text)
		expect(report).toMatchObject({ ok: false })
		expect(report?.problems.join('\n')).toMatch(/instance_settings/)
		expect(await target.importProgress(BUILD, ACCESS)).toMatchObject({ progress: { state: 'failed' } })
		// A failed import keeps the Store closed.
		expect(toStoreUnavailable(await rejectionOf(target.setupState(BUILD)))?.reason).toBe('import-in-progress')

		// Restart from scratch: the reset deletes the imported rows; the schema and the configuration stay.
		const reset = await resetImport(target, id)
		expect(reset).toMatchObject({ ok: true, done: true })
		expect(await target.importProgress(BUILD, ACCESS)).toEqual({ progress: null })
		expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true })
		expect(await target.setupState(BUILD)).toEqual({ complete: true })
	})

	it('reports a rolled-back chunk as not applied', async () => {
		const { text } = await dumpViaRpc(await seeded(0))
		const chunks = await importChunks(text, 1 << 20)
		const target = await migratedStore()
		const id = await beginImport(target, text)
		await runInDurableObject(target, async (_instance, state) => {
			const failing = admin(state, {
				inject: (point) => {
					if (point === 'import-chunk-in-transaction') throw new Error('boom')
				},
			})
			expect(await failing.importChunk(BUILD, ACCESS, id, 1, chunks[0]!)).toMatchObject({
				ok: false,
				applied: false,
				progress: { lastSeq: 0 },
			})
			expect(state.storage.sql.exec('SELECT count(*) AS n FROM accounts').one().n).toBe(0)
		})
	})

	it('accepts only an empty Store with the same migrations and tables', async () => {
		const { text } = await dumpViaRpc(await seeded(0))
		const header = splitDump(text).header as { migrations: { checksum: string }[]; tables: { columns: string[] }[] }

		// An admin of the Store (Access authority is checked against its configuration) still needs an empty Store.
		const withData = await seeded(0)
		await ensureAdmin(withData)
		expect(await withData.importBegin(BUILD, ACCESS, header)).toMatchObject({ code: 'not-empty' })
		const target = await migratedStore()
		await ensureAdmin(target)
		const otherChecksum = { ...header, migrations: [{ ...header.migrations[0], checksum: 'x' }] }
		expect(await target.importBegin(BUILD, ACCESS, otherChecksum)).toMatchObject({ code: 'migrations-differ' })
		const otherColumns = {
			...header,
			tables: header.tables.map((t, i) => (i === 0 ? { ...t, columns: [...t.columns, 'extra'] } : t)),
		}
		expect(await target.importBegin(BUILD, ACCESS, otherColumns)).toMatchObject({ code: 'catalog-differs' })
		expect(await target.importBegin(BUILD, ACCESS, { format: 2 })).toMatchObject({ code: 'invalid-header' })
		expect(toStoreUnavailable(await rejectionOf(target.importBegin('other-build', ACCESS, header)))?.reason).toBe(
			'version-mismatch'
		)
	})

	it('refuses statements outside the templates without applying anything', async () => {
		const { text } = await dumpViaRpc(await seeded(0))
		const target = await migratedStore()
		const id = await beginImport(target, text)
		const evil = new TextEncoder().encode(
			`INSERT INTO "instance_settings" ("name","value") VALUES ('a','b');\nDELETE FROM "accounts";\n`
		)
		expect(await target.importChunk(BUILD, ACCESS, id, 1, evil)).toMatchObject({ ok: false, code: 'invalid-chunk' })
		const state = new TextEncoder().encode(`INSERT INTO "kopje_state" ("name","value") VALUES ('hold','{}');\n`)
		expect(await target.importChunk(BUILD, ACCESS, id, 1, state)).toMatchObject({
			ok: false,
			code: 'state-not-allowed',
		})
		// Not a list, a repeated id, more ids than publication announces.
		for (const value of [
			{ id: '1' },
			['1', '2', '1'],
			Array.from({ length: MAX_PROFILE_UPDATES + 1 }, (_, i) => String(i)),
		]) {
			const profiles = new TextEncoder().encode(
				`INSERT INTO "kopje_state" ("name","value") VALUES ('profile_updates','${JSON.stringify(value)}');\n`
			)
			expect(await target.importChunk(BUILD, ACCESS, id, 1, profiles)).toMatchObject({
				ok: false,
				code: 'state-invalid',
			})
		}
		expect(await target.importProgress(BUILD, ACCESS)).toMatchObject({ progress: { lastSeq: 0, statements: 0 } })
	})

	// A dump written before profile_updates was restorable declares only last_local_id: it is accepted, and holds to
	// what it declares. A dump declaring a name this Store does not restore is refused.
	it('accepts a dump that restores fewer kopje_state names, and only those', async () => {
		const { text } = await dumpViaRpc(await seeded(0))
		const header = splitDump(text).header as { tables: TableSpec[] }
		const only = (values: string[]) => ({
			...header,
			tables: header.tables.map((t) => (t.name === 'kopje_state' ? { ...t, only: { column: 'name', values } } : t)),
		})
		const unknown = await migratedStore()
		await ensureAdmin(unknown)
		expect(await unknown.importBegin(BUILD, ACCESS, only(['last_local_id', 'profile_updates', 'hold']))).toMatchObject({
			code: 'catalog-differs',
		})

		const target = await migratedStore()
		await ensureAdmin(target)
		const begun = await target.importBegin(BUILD, ACCESS, only(['last_local_id']))
		if (!begun.ok) {
			throw new Error(begun.code)
		}
		const id = begun.progress.id
		const profiles = new TextEncoder().encode(
			`INSERT INTO "kopje_state" ("name","value") VALUES ('profile_updates','["1"]');\n`
		)
		expect(await target.importChunk(BUILD, ACCESS, id, 1, profiles)).toMatchObject({
			ok: false,
			code: 'state-not-allowed',
		})
		const last = new TextEncoder().encode(
			`INSERT INTO "kopje_state" ("name","value") VALUES ('last_local_id','110000000000000001');\n`
		)
		expect(await target.importChunk(BUILD, ACCESS, id, 1, last)).toMatchObject({ ok: true })
	})

	// A reset names its import; a serving Store has none, so there is nothing a reset could apply to.
	it('refuses to reset a serving Store', async () => {
		const store = await seeded(0)
		await ensureAdmin(store)
		expect(await store.importReset(BUILD, ACCESS)).toMatchObject({ ok: false, code: 'import-id-required' })
		expect(await store.importReset(BUILD, ACCESS, 'no-such-import')).toMatchObject({
			ok: false,
			code: 'import-not-found',
		})
		expect(await store.setupState(BUILD)).toEqual({ complete: true })
	})

	it('opens IMPORT_TOKEN only in bootstrap and continues a token import only by its session', async () => {
		const empty = await migratedStore()
		expect(await empty.adminGate(BUILD)).toMatchObject({ bootstrap: true })
		const configured = await migratedStore()
		await setAccess(configured)
		expect(await configured.adminGate(BUILD)).toMatchObject({ bootstrap: false })

		// The dump brings Access settings; they never authorize anyone, and the target's own (none) come back.
		const source = await seeded(0)
		await setAccess(source)
		const { text } = await dumpViaRpc(source)
		const header = splitDump(text).header
		expect(await (await seeded(0)).importBegin(BUILD, TOKEN, header)).toMatchObject({ code: 'not-bootstrap' })
		const target = await migratedStore()
		const begun = await target.importBegin(BUILD, TOKEN, header)
		if (!begun.ok || begun.session === undefined) throw new Error('no session')
		const session = { kind: 'import-session', secret: begun.session } as const
		for (const [i, chunk] of (await importChunks(text, 1 << 20)).entries()) {
			expect(await target.importChunk(BUILD, session, begun.progress.id, i + 1, chunk)).toMatchObject({ ok: true })
		}
		expect(await target.adminGate(BUILD)).toMatchObject({ bootstrap: false, access: { adminAud: null } })
		expect(await target.importFinish(BUILD, session, begun.progress.id, splitDump(text).trailer)).toMatchObject({
			ok: true,
		})
		expect(await target.importVerify(BUILD, session, begun.progress.id)).toMatchObject({ report: { ok: true } })
		expect(await target.adminGate(BUILD)).toMatchObject({ bootstrap: true, access: { adminAud: null } })
	})
})

// RES-6, DATA-3: an import call's work follows what it writes, not the bytes it receives. A link statement is short,
// but SQLite rewrites the whole row it changes, so links are staged with their chunk and applied in verify steps
// bounded by the bytes they rewrite; a chunk is bounded by statements as well as bytes.
describe('import work per call', () => {
	const ROW = 300_000

	function statusId(n: number): string {
		return String(130_000_000_000_000_000n + BigInt(n))
	}

	// A source whose replies are large rows that all need a link on import.
	async function largeReplies(replies: number): Promise<StoreStub> {
		const source = await seeded(0)
		await runInDurableObject(source, (_instance, state) => {
			const sql = state.storage.sql
			const account = sql.exec<{ id: string }>("SELECT id FROM accounts WHERE domain = 'remote.test'").one().id
			const insert = (n: number, replyTo: number | null) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, visibility, search_text, published_at)
					 VALUES (?, ?, ?, ?, ?, 'public', ?, '2026-10-12T00:00:00.000Z')`,
					statusId(n),
					`https://remote.test/s/large-${n}`,
					account,
					replyTo === null ? null : `https://remote.test/s/large-${replyTo}`,
					replyTo === null ? null : statusId(replyTo),
					`${n} ${'x'.repeat(ROW)}`
				)
			insert(0, null)
			for (let n = 1; n <= replies; n++) {
				insert(n, 0)
			}
		})
		return source
	}

	async function linkedReplies(store: StoreStub): Promise<number> {
		return runInDurableObject(
			store,
			(_instance, state) =>
				state.storage.sql
					.exec<{
						n: number
					}>("SELECT count(*) AS n FROM statuses WHERE uri LIKE '%/large-%' AND in_reply_to_id IS NOT NULL")
					.one().n
		)
	}

	it('stages links with their chunk and applies them in verify steps bounded by the rows they rewrite', async () => {
		const replies = 8
		const { text } = await dumpViaRpc(await largeReplies(replies))
		const target = await migratedStore()
		const id = await beginImport(target, text)
		for (const [i, chunk] of (await importChunks(text, 1 << 20)).entries()) {
			expect(await target.importChunk(BUILD, ACCESS, id, i + 1, chunk)).toMatchObject({ ok: true })
		}
		// No chunk rewrote a row for a link.
		expect(await linkedReplies(target)).toBe(0)
		expect(await target.importFinish(BUILD, ACCESS, id, splitDump(text).trailer)).toMatchObject({ ok: true })

		// Each step stops after the row that brings its rewritten bytes to the budget: two rows of ROW bytes here.
		const budget = ROW + ROW / 2
		await runInDurableObject(target, async (_instance, state) => {
			const linkedNow = () =>
				state.storage.sql
					.exec<{
						n: number
					}>("SELECT count(*) AS n FROM statuses WHERE uri LIKE '%/large-%' AND in_reply_to_id IS NOT NULL")
					.one().n
			let linked = 0
			let steps = 0
			for (;;) {
				const step = await admin(state).importVerify(BUILD, ACCESS, id, budget)
				if (!step.ok) throw new Error(step.message)
				expect(linkedNow() - linked, `step ${steps}`).toBeLessThanOrEqual(2)
				linked = linkedNow()
				steps++
				if (step.done) {
					expect(step.report).toMatchObject({ ok: true })
					break
				}
			}
			expect(linked).toBe(replies)
			expect(steps).toBeGreaterThanOrEqual(replies / 2)
		})
	})

	it('reads staged links one at a time, stopping at the step budget', async () => {
		const replies = 6
		const { text } = await dumpViaRpc(await largeReplies(replies))
		const target = await migratedStore()
		const id = await beginImport(target, text)
		for (const [i, chunk] of (await importChunks(text, 1 << 20)).entries()) {
			expect(await target.importChunk(BUILD, ACCESS, id, i + 1, chunk)).toMatchObject({ ok: true })
		}
		await runInDurableObject(target, (_instance, state) => {
			// Counts the staged links each query hands over.
			const batches: number[] = []
			const sql = new Proxy(state.storage.sql, {
				get(target, property) {
					if (property !== 'exec') {
						const value = Reflect.get(target, property) as unknown
						return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
					}
					return (query: string, ...bindings: SqlStorageValue[]) => {
						const cursor = target.exec(query, ...bindings)
						if (!query.startsWith('SELECT name, value FROM kopje_state')) {
							return cursor
						}
						const rows = cursor.toArray()
						batches.push(rows.length)
						return { toArray: () => rows }
					}
				},
			})
			const tables = (splitDump(text).header as { tables: TableSpec[] }).tables
			// The budget is one large row: after it the step reads nothing more.
			expect(applyStagedLinks(sql, tables, ROW, MAX_IMPORT_CHUNK_STATEMENTS)).toBe(true)
			expect(Math.max(...batches)).toBe(1)
			const linked = state.storage.sql
				.exec<{
					n: number
				}>('SELECT count(*) AS n FROM statuses WHERE in_reply_to_id IS NOT NULL OR reblog_of_id IS NOT NULL')
				.one().n
			expect(batches.length).toBe(linked)
		})
	})

	it('refuses a link longer than a link can be with its chunk', async () => {
		const { text } = await dumpViaRpc(await seeded(0))
		const target = await migratedStore()
		const id = await beginImport(target, text)
		const reply = /^UPDATE "statuses" SET "reblog_of_id"=NULL,"in_reply_to_id"=('\d+') WHERE "id"=('\d+');$/m.exec(text)
		if (reply === null) throw new Error('no reply link in the dump')
		const long = `UPDATE "statuses" SET "reblog_of_id"=NULL,"in_reply_to_id"='${'9'.repeat(MAX_LINK_STATEMENT_BYTES)}' WHERE "id"=${reply[2]};\n`
		expect(await target.importChunk(BUILD, ACCESS, id, 1, new TextEncoder().encode(long))).toMatchObject({
			ok: false,
			code: 'link-too-large',
		})
		expect(await target.importProgress(BUILD, ACCESS)).toMatchObject({ progress: { lastSeq: 0, statements: 0 } })
	})

	it('refuses a link to a missing row with its chunk', async () => {
		const { text } = await dumpViaRpc(await seeded(0))
		const target = await migratedStore()
		const id = await beginImport(target, text)
		const link = new TextEncoder().encode(
			`UPDATE "statuses" SET "reblog_of_id"=NULL,"in_reply_to_id"=NULL WHERE "id"='${statusId(1)}';\n`
		)
		expect(await target.importChunk(BUILD, ACCESS, id, 1, link)).toMatchObject({
			ok: false,
			code: 'link-target-missing',
		})
		expect(await target.importProgress(BUILD, ACCESS)).toMatchObject({ progress: { lastSeq: 0, statements: 0 } })
	})

	it('refuses verification when a staged link breaks a constraint', async () => {
		const { text } = await dumpViaRpc(await seeded(0))
		// The reply's link also makes it a boost, which its CHECK forbids. The trailer's body fields follow the edit, so
		// the import reaches verification.
		const reply = /^UPDATE "statuses" SET "reblog_of_id"=NULL,"in_reply_to_id"=('\d+') /m.exec(text)
		if (reply === null) throw new Error('no reply link in the dump')
		const edited = text.replace(reply[0], reply[0].replace('"reblog_of_id"=NULL', `"reblog_of_id"=${reply[1]}`))
		const { body, trailer } = splitDump(edited) as { body: string; trailer: DumpTrailer }
		const bytes = new TextEncoder().encode(body)
		const fixed = {
			...trailer,
			body: { ...trailer.body, bytes: bytes.byteLength, sha256: new Sha256().update(bytes).hex() },
		}
		const target = await migratedStore()
		const id = await beginImport(target, edited)
		for (const [i, chunk] of (await importChunks(edited, 1 << 20)).entries()) {
			expect(await target.importChunk(BUILD, ACCESS, id, i + 1, chunk)).toMatchObject({ ok: true })
		}
		expect(await target.importFinish(BUILD, ACCESS, id, fixed)).toMatchObject({ ok: true })
		expect(await target.importVerify(BUILD, ACCESS, id)).toMatchObject({ ok: false, code: 'link-failed' })
		expect(await target.importProgress(BUILD, ACCESS)).toMatchObject({ progress: { state: 'finished' } })
		expect(await resetImport(target, id)).toMatchObject({ ok: true, done: true })
	})

	it('refuses a chunk over the statement or byte bound without applying it', async () => {
		const { text } = await dumpViaRpc(await seeded(0))
		const target = await migratedStore()
		const id = await beginImport(target, text)
		const row = (key: string, value: string) =>
			`INSERT INTO "fedify_kv" ("key","value","expires_at") VALUES ('["${key}"]','"${value}"',NULL);\n`
		const encode = (lines: string[]) => new TextEncoder().encode(lines.join(''))
		const many = Array.from({ length: MAX_IMPORT_CHUNK_STATEMENTS + 1 }, (_, n) => row(`k${n}`, '1'))
		expect(await target.importChunk(BUILD, ACCESS, id, 1, encode(many))).toMatchObject({
			ok: false,
			code: 'chunk-too-large',
		})
		const half = 'v'.repeat(IMPORT_CHUNK_WORK_BYTES / 2)
		expect(await target.importChunk(BUILD, ACCESS, id, 1, encode([row('a', half), row('b', half)]))).toMatchObject({
			ok: false,
			code: 'chunk-too-large',
		})
		expect(await target.importProgress(BUILD, ACCESS)).toMatchObject({ progress: { lastSeq: 0, statements: 0 } })
		expect(await target.importChunk(BUILD, ACCESS, id, 1, encode(many.slice(1)))).toMatchObject({ ok: true })
	})
})

describe('maintenance flag', () => {
	it('lets reads and sessions through and refuses other writes', async () => {
		const store = await seeded(0)
		expect(await store.setMaintenance(BUILD, true)).toEqual({ maintenance: true })
		await runInDurableObject(store, async (_instance, state) => {
			const kernel = testKernel(state)
			await kernel.execute(BUILD, readSettings, undefined)
			await kernel.execute(BUILD, sessionWrite, 'login')
			await expect(kernel.execute(BUILD, writeSetting, 'post')).rejects.toThrow('kopje-maintenance: maintenance')
		})
		expect(await store.health(BUILD)).toMatchObject({ maintenance: true, readonly: true })
		await store.setMaintenance(BUILD, false)
		await runInDurableObject(store, (_instance, state) => testKernel(state).execute(BUILD, writeSetting, 'post'))
	})
})

describe('upgrade retry', () => {
	it('re-runs a held upgrade of the same build without a deploy', async () => {
		const store = freshStore()
		await runInDurableObject(store, async (_instance, state) => {
			const failing = testKernel(state, undefined, {
				inject: (phase) => {
					if (phase === 'apply') throw new Error('boom')
				},
			})
			expect(await failing.upgrade()).toMatchObject({ ok: false, reason: 'upgrade-failed' })
		})
		expect(await store.health(BUILD)).toMatchObject({ hold: 'upgrade-failed' })
		expect(toStoreUnavailable(await rejectionOf(store.retryUpgrade('other')))?.reason).toBe('version-mismatch')
		expect(await store.retryUpgrade(BUILD)).toMatchObject({ ok: true, applied: MIGRATION_NAMES })
		expect(await store.health(BUILD)).toMatchObject({ hold: null, readonly: false, schema: { status: 'current' } })
	})
})

describe('read-only SQL', () => {
	it('returns rows and encodes blobs', async () => {
		const store = await seeded(0)
		expect(await store.query(BUILD, 'SELECT fragment, spool_id FROM inbound_spool')).toEqual({
			ok: true,
			columns: ['fragment', 'spool_id'],
			rows: [[{ blob: '000102ff270a' }, 's1']],
			truncated: false,
		})
		expect(await store.query(BUILD, 'SELECT id FROM accounts', 1)).toMatchObject({
			rows: [[expect.any(String)]],
			truncated: true,
		})
	})

	it('refuses writes and tricks and leaves the data unchanged', async () => {
		const store = await seeded(0)
		const before = await tableSnapshot(store)
		for (const sql of [
			'DELETE FROM accounts',
			'WITH x AS (SELECT 1) DELETE FROM accounts',
			'SELECT 1; DELETE FROM accounts',
			'/* SELECT */ DELETE FROM accounts',
			'-- x\nUPDATE accounts SET note = 1',
			'PRAGMA foreign_keys = OFF',
			"ATTACH DATABASE 'x' AS y",
			'SELECT * FROM accounts; DROP TABLE accounts',
		]) {
			expect(await store.query(BUILD, sql), sql).toMatchObject({ ok: false, code: 'not-read-only' })
		}
		expect(await store.query(BUILD, 'SELECT * FROM nope')).toMatchObject({ ok: false, code: 'query-failed' })
		expect(await tableSnapshot(store)).toEqual(before)
	})
})
