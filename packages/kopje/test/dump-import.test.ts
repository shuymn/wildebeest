import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

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
import { columnsSql, movedCountSql, seedBounded, storedSql, TABLES } from './stored-bounds-fixtures'
import { MIGRATIONS } from '../src/db/migrations'
import { readOperation, sessionOperation, writeOperation } from '../src/domain/operation'
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

	// RES-2: a dump taken before 0048_stored_bounds, of rows past their stored bounds, restores into a Store at the
	// same migrations (the import requires them equal), which then upgrades through 0048 to P(x) of every value.
	it('restores a dump taken before 0048_stored_bounds, which then upgrades through it', async () => {
		const before = MIGRATIONS.slice(0, MIGRATION_NAMES.indexOf('0048_stored_bounds'))
		const options = { source: { build: BUILD, version: 'test' }, log: () => {} }
		const source = freshStore()
		const text = await runInDurableObject(source, async (_instance, state) => {
			await state.storage.deleteAlarm()
			expect(await testKernel(state, before).upgrade()).toMatchObject({ ok: true })
			seedBounded(state.storage.sql)
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
			const expected = TABLES.map((table) => sql.exec(storedSql(table)).toArray())
			expect(TABLES.map((table) => sql.exec<{ n: number }>(movedCountSql(table)).one().n).every((n) => n > 0)).toBe(
				true
			)
			const through = MIGRATIONS.slice(0, before.length + 1)
			expect(await testKernel(state, through).upgrade()).toMatchObject({ ok: true, applied: ['0048_stored_bounds'] })
			expect(TABLES.map((table) => sql.exec(columnsSql(table)).toArray())).toEqual(expected)
			expect(TABLES.map((table) => sql.exec<{ n: number }>(movedCountSql(table)).one().n)).toEqual([0, 0, 0, 0])
		})
	}, 120_000)

	// RES-2: a dump taken before 0049_instance_bounds, of instance settings past their stored bounds, restores into a
	// Store at the same migrations, which then upgrades through 0049 to P(x) of every value (no row where P is none).
	it('restores a dump taken before 0049_instance_bounds, which then upgrades through it', async () => {
		const before = MIGRATIONS.slice(0, MIGRATION_NAMES.indexOf('0049_instance_bounds'))
		const options = { source: { build: BUILD, version: 'test' }, log: () => {} }
		const settings = {
			title: 'T'.repeat(1500),
			description: `${' '.repeat(200)}tail`,
			contact_email: `${'e'.repeat(300)}@example.com`,
			privacy_policy: `<p>${'p'.repeat(50_000)}</p>`,
			extended_description: '<p>kept</p>',
			terms_of_service: ' \v ',
			show_domain_blocks: 'everyone',
		}
		const source = freshStore()
		const text = await runInDurableObject(source, async (_instance, state) => {
			await state.storage.deleteAlarm()
			expect(await testKernel(state, before).upgrade()).toMatchObject({ ok: true })
			for (const [name, value] of Object.entries(settings)) {
				state.storage.sql.exec('INSERT INTO instance_settings (name, value) VALUES (?, ?)', name, value)
			}
			const dumping = new StoreAdmin(state, testKernel(state, before), options)
			return (
				await collectDump({
					start: () => dumping.dumpStart(),
					next: (cursor) => dumping.dumpNext(cursor),
					finish: (cursor) => dumping.dumpFinish(cursor),
				})
			).text
		})
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
			for (const [i, chunk] of (await importChunks(text, 64 * 1024)).entries()) {
				expect(await importing.importChunk(BUILD, ACCESS, begun.progress.id, i + 1, chunk)).toMatchObject({ ok: true })
			}
			expect(await importing.importFinish(BUILD, ACCESS, begun.progress.id, trailer)).toMatchObject({ ok: true })
			for (;;) {
				const verified = await importing.importVerify(BUILD, ACCESS, begun.progress.id)
				if (!verified.ok) {
					throw new Error(verified.message)
				}
				if (verified.done) {
					expect(verified.report).toMatchObject({ ok: true, problems: [] })
					break
				}
			}
			const names = Object.keys(settings)
			const read = () =>
				sql
					.exec<{ name: string; value: string }>(
						`SELECT name, value FROM instance_settings WHERE name IN (${names.map(() => '?').join(', ')}) ORDER BY name`,
						...names
					)
					.toArray()
			expect(read()).toHaveLength(names.length)
			const through = MIGRATIONS.slice(0, before.length + 1)
			expect(await testKernel(state, through).upgrade()).toMatchObject({ ok: true, applied: ['0049_instance_bounds'] })
			// The description's first 200 code points are blank, so it goes too.
			expect(read()).toEqual([
				{ name: 'extended_description', value: '<p>kept</p>' },
				{ name: 'title', value: 'T'.repeat(1024) },
			])
		})
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
