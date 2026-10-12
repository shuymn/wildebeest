import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { BUILD, freshStore, migratedStore, rejectionOf, testKernel } from './helpers'
import {
	ACCESS,
	beginImport,
	copyConfig,
	ensureAdmin,
	dumpViaRpc,
	finishImport,
	importChunks,
	importViaRpc,
	resetImport,
	seedStore,
	setAccess,
	splitDump,
	tableSnapshot,
} from './ops-helpers'
import { readOperation, sessionOperation, writeOperation } from '../src/domain/operation'
import type { DumpTrailer } from '../src/platform/dump-format'
import { Sha256 } from '../src/platform/sha256'
import { type AdminOptions, StoreAdmin } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'
import type { DumpCursor } from '../src/platform/store-dump'
import { toStoreUnavailable } from '../src/platform/store-errors'

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
		const state = (await tableSnapshot(target)).kopje_state
		expect(state).toContain('last_local_id=110000000000000099')
		expect(state).not.toContain('upgrade_bookmark=source-only')
		// The imported Store serves again.
		expect(await target.setupState(BUILD)).toEqual({ complete: true })
	})

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
		expect(header.migrations.map((m) => m.name)).toEqual(['0000_initial'])
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
		const inbox = toStoreUnavailable(await rejectionOf(store.receiveInbox(BUILD, { receivedAt: 1 })))
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
		expect(await store.health(BUILD)).toMatchObject({ schema: { status: 'current' }, readonly: false })
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
		expect(await target.importProgress(BUILD, ACCESS)).toMatchObject({ progress: { lastSeq: 0, statements: 0 } })
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
		expect(await store.retryUpgrade(BUILD)).toMatchObject({ ok: true, applied: ['0000_initial'] })
		expect(await store.health(BUILD)).toMatchObject({ hold: null, readonly: false, schema: { status: 'current' } })
	})
})

describe('read-only SQL', () => {
	it('returns rows and encodes blobs', async () => {
		const store = await seeded(0)
		expect(await store.query(BUILD, 'SELECT privkey, email FROM local_accounts')).toEqual({
			ok: true,
			columns: ['privkey', 'email'],
			rows: [[{ blob: '000102ff270a' }, 'alice@kopje.test']],
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
