import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildLegacyFixture, type FixtureOptions } from './legacy-fixture.js'
import { createKopjeDatabase, loadDump, migrationRecords, readCatalog, writeDump } from '../cli/lib/cutover/kopje-db.js'
import { convertExport, verifyConversion } from '../cli/lib/cutover/run.js'

// The converter end to end on synthetic exports (DATA-11 to DATA-14): convert, then check the result against
// expectations computed independently from the export, and show the check fails on each kind of damage.

const BASE_TIME = Date.parse('2026-10-20T00:00:00.000Z')
let dir: string

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'kopje-cutover-'))
})

afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

async function exportOf(options: FixtureOptions, name = 'export'): Promise<string> {
	const fixture = await buildLegacyFixture(options)
	const path = join(dir, name)
	await mkdir(path)
	for (const [table, text] of fixture.texts) {
		await writeFile(join(path, `${table}.sql`), text)
	}
	return path
}

async function convert(
	exportPath: string,
	extra: { acceptDeletions?: boolean; env?: Record<string, string>; out?: string } = {}
) {
	const outDir = join(dir, extra.out ?? 'out')
	const result = await convertExport({
		exportPath,
		outDir,
		acceptDeletions: extra.acceptDeletions ?? false,
		baseTime: BASE_TIME,
		env: extra.env ?? {},
		version: 'test',
	})
	return { ...result, dumpPath: join(outDir, 'kopje.dump') }
}

async function verify(exportPath: string, dumpPath: string, acceptDeletions = false) {
	return verifyConversion({ exportPath, dumpPath, acceptDeletions, baseTime: 0, env: {} })
}

// Applies SQL to a converted dump and writes it again as a self-consistent dump (as a converter bug would produce).
async function tampered(dumpPath: string, sql: string): Promise<string> {
	const db = createKopjeDatabase()
	loadDump(db, await readFile(dumpPath, 'utf8'))
	db.exec('PRAGMA foreign_keys = OFF')
	db.exec(sql)
	const path = join(dir, `tampered-${Math.random().toString(36).slice(2)}.dump`)
	writeDump(db, {
		path,
		catalog: readCatalog(db),
		migrations: migrationRecords(),
		createdAt: new Date(BASE_TIME).toISOString(),
		source: { build: 'test', version: 'test' },
	})
	db.close()
	return path
}

describe('convert and verify-conversion', () => {
	for (const options of [
		{ level: 0 },
		{ level: 10 },
		{ level: 10, line: 'T2' as const },
		{ level: 18 },
		{ level: 23 },
		{ level: 35 },
		{ level: 39 },
	]) {
		it(`converts a ${options.line ?? 'T1'} export at level ${options.level} and the independent check passes`, async () => {
			const exportPath = await exportOf(options)
			const { ok, manifest, dumpPath } = await convert(exportPath)
			expect(manifest.stop).toBeUndefined()
			expect(ok).toBe(true)
			const { ok: verified, report } = await verify(exportPath, dumpPath)
			const categories = (
				report as { categories: Record<string, { expected: number; missing: number; extra: number; changed: number }> }
			).categories
			const failing = Object.entries(categories).filter(([, c]) => c.missing + c.extra + c.changed > 0)
			expect(failing).toEqual([])
			expect(verified).toBe(true)
			for (const name of [
				'accounts',
				'keys',
				'statuses',
				'boosts',
				'follows',
				'favourites',
				'notifications',
				'clients',
			]) {
				expect(categories[name]?.expected, name).toBeGreaterThan(0)
			}
			if (options.level >= 23) {
				expect(categories.edits?.expected).toBe(1)
			}
			if (options.level >= 32) {
				expect(categories.lists?.expected).toBe(1)
				expect(categories.blocks?.expected).toBe(2)
			}
		})
	}

	it('is deterministic: the same export and base time give the same dump', async () => {
		const exportPath = await exportOf({ level: 18 })
		const first = await convert(exportPath, { out: 'a' })
		const second = await convert(exportPath, { out: 'b' })
		expect(await readFile(first.dumpPath, 'utf8')).toBe(await readFile(second.dumpPath, 'utf8'))
		expect((first.manifest.dump as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/)
	})

	it('keeps legacy ids, accepted follows without a Follow record, local media and old /ap/o ids', async () => {
		const exportPath = await exportOf({ level: 39 })
		const { manifest, dumpPath } = await convert(exportPath)
		const conversion = manifest.conversion as Record<string, Record<string, number>>
		expect(conversion.normalized).toMatchObject({
			'follows:accepted-without-follow-record': 2,
			'notifications:duplicate-merged': 1,
			'statuses:remote-without-original-uri': 1,
		})
		expect(conversion.legacyIds).toMatchObject({ accounts: 2, statuses: 5, statuses_ap_o: 3, media_ap_o: 2 })
		const db = createKopjeDatabase()
		loadDump(db, await readFile(dumpPath, 'utf8'))
		const value = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0]
		// Accepted follows without a Follow record keep uri NULL; one with an activity gets its id.
		expect(value("SELECT count(*) FROM follows WHERE state = 'accepted' AND uri IS NULL")).toBe(2)
		expect(value("SELECT uri FROM follows WHERE uri LIKE '%/ap/a/follow-300'")).toBe(
			'https://kopje.test/ap/a/follow-300'
		)
		// Old media stays at its URLs, and old Image ids are kept.
		expect(value("SELECT count(*) FROM media_attachments WHERE url LIKE 'https://images.example/%'")).toBe(2)
		expect(value('SELECT count(*) FROM media_attachments WHERE status_id IS NULL AND legacy_ap_o IS NOT NULL')).toBe(1)
		// Every id is 18 digits; notifications keep theirs, and the counter continues past the largest.
		expect(value('SELECT count(*) FROM statuses WHERE length(id) <> 18')).toBe(0)
		expect(value('SELECT group_concat(id) FROM (SELECT id FROM notifications ORDER BY id)')).toBe('1,2,3,4,6,7,8')
		expect(value("SELECT seq FROM sqlite_sequence WHERE name = 'notifications'")).toBe(8)
		// The DM stays direct, and remote raw is the legacy text byte for byte.
		expect(value("SELECT visibility FROM statuses WHERE content LIKE '%secret direct%'")).toBe('direct')
		expect(value('SELECT count(*) FROM statuses WHERE raw IS NOT NULL')).toBe(4)
		expect(value("SELECT value FROM kopje_state WHERE name = 'last_local_id'")).toMatch(/^\d{18}$/)
		db.close()
	})

	describe('the check fails on damage (DATA-12)', () => {
		const cases: [string, string, string][] = [
			['a status is missing', "DELETE FROM statuses WHERE content LIKE '%followers only%'", 'statuses'],
			['content is emptied', "UPDATE statuses SET content = '' WHERE content LIKE '%followers only%'", 'statuses'],
			[
				'content is rewritten to the same length',
				"UPDATE statuses SET content = replace(content, 'followers only', 'FOLLOWERS ONLY') WHERE content LIKE '%followers only%'",
				'statuses',
			],
			[
				'source text is rewritten',
				"UPDATE statuses SET source_text = upper(source_text) WHERE source_text = 'Bob says hi'",
				'statuses',
			],
			['a DM is widened', "UPDATE statuses SET visibility = 'public' WHERE visibility = 'direct'", 'statuses'],
			['remote raw is changed', "UPDATE statuses SET raw = replace(raw, 'Note', 'Nope') WHERE raw IS NOT NULL", 'raw'],
			['an edit is dropped', 'DELETE FROM status_edits WHERE id = (SELECT min(id) FROM status_edits)', 'edits'],
			[
				'an attachment moves',
				"UPDATE media_attachments SET url = url || '?' WHERE status_id IS NOT NULL",
				'attachments',
			],
			['a profile is changed', "UPDATE accounts SET display_name = 'X' WHERE domain IS NULL", 'accounts'],
			['a wrapped key byte changes', 'UPDATE local_accounts SET privkey = zeroblob(length(privkey))', 'keys'],
			['a follow is dropped', "DELETE FROM follows WHERE state = 'pending'", 'follows'],
			['a follow loses its Follow record', 'UPDATE follows SET uri = NULL', 'follows'],
			[
				'a favourite is added',
				'INSERT INTO favourites (account_id, status_id) SELECT a.id, s.id FROM accounts a, statuses s WHERE a.domain IS NULL AND s.reblog_of_id IS NULL AND NOT EXISTS (SELECT 1 FROM favourites f WHERE f.account_id = a.id AND f.status_id = s.id) LIMIT 1',
				'favourites',
			],
			['a boost is dropped', 'DELETE FROM statuses WHERE reblog_of_id IS NOT NULL', 'boosts'],
			['a notification is dropped', 'DELETE FROM notifications WHERE id = 1', 'notifications'],
			['a list member is dropped', 'DELETE FROM list_accounts', 'list_accounts'],
			['a setting changes', "UPDATE instance_settings SET value = 'x' WHERE name = 'rules'", 'settings'],
			['a client secret changes', "UPDATE oauth_clients SET secret = 'x'", 'clients'],
			['a legacy id is lost', 'UPDATE statuses SET legacy_id = NULL', 'legacy_ids'],
		]
		let exportPath: string
		let dumpPath: string
		beforeEach(async () => {
			exportPath = await exportOf({ level: 39 })
			dumpPath = (await convert(exportPath)).dumpPath
		})
		for (const [name, sql, category] of cases) {
			it(`FAILs when ${name}`, async () => {
				const { ok, report } = await verify(exportPath, await tampered(dumpPath, sql))
				expect(ok).toBe(false)
				const result = (report as { categories: Record<string, { missing: number; extra: number; changed: number }> })
					.categories[category]
				expect(result, category).toBeDefined()
				expect((result?.missing ?? 0) + (result?.extra ?? 0) + (result?.changed ?? 0)).toBeGreaterThan(0)
			})
		}

		it('passes on an untouched round trip through the same tamper path', async () => {
			expect((await verify(exportPath, await tampered(dumpPath, 'SELECT 1'))).ok).toBe(true)
		})
	})

	it('stops on rows the bridge removes until --accept-deletions, and then still verifies', async () => {
		const exportPath = await exportOf({ level: 5, withDeletions: true })
		const stopped = await convert(exportPath)
		expect(stopped.ok).toBe(false)
		expect(stopped.manifest.stop).toMatchObject({ code: 'deletions-not-accepted' })
		const accepted = await convert(exportPath, { acceptDeletions: true })
		expect(accepted.ok).toBe(true)
		expect((await verify(exportPath, accepted.dumpPath, true)).ok).toBe(true)
	})

	it('checks that one KEK candidate unwraps every key, naming candidates only (DATA-14)', async () => {
		const mixed = await exportOf({ level: 39, keks: { alice: '', bob: 'legacy-kek-value' } })
		const stopped = await convert(mixed)
		expect(stopped.ok).toBe(false)
		expect(stopped.manifest.kek).toMatchObject({ uniform: false })
		expect(JSON.stringify(stopped.manifest)).not.toContain('legacy-kek-value')

		const same = await exportOf({ level: 39, keks: { alice: 'legacy-kek-value', bob: 'legacy-kek-value' } }, 'same')
		const withoutSecret = await convert(same, { out: 'no-secret' })
		expect(withoutSecret.manifest.kek).toMatchObject({ uniform: false, users: [{ kek: null }, { kek: null }] })
		const converted = await convert(same, { out: 'secret', env: { USER_KEY: 'legacy-kek-value' } })
		expect(converted.ok).toBe(true)
		expect(converted.manifest.kek).toMatchObject({ uniform: true, kek: 'USER_KEY', emptyKek: false })
	})

	it('keeps wrapped keys byte for byte (DATA-1: no re-wrapping)', async () => {
		const exportPath = await exportOf({ level: 39 })
		const { dumpPath } = await convert(exportPath)
		const legacy = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false })
		for (const table of ['users']) {
			legacy.exec(await readFile(join(exportPath, `${table}.sql`), 'utf8'))
		}
		const db = createKopjeDatabase()
		loadDump(db, await readFile(dumpPath, 'utf8'))
		const hex = (sql: string, d: DatabaseSync) => (d.prepare(sql).all() as { k: string }[]).map((r) => r.k).sort()
		expect(
			hex("SELECT hex(privkey) || ':' || hex(privkey_salt) || ':' || pubkey AS k FROM local_accounts", db)
		).toEqual(hex("SELECT hex(privkey) || ':' || hex(privkey_salt) || ':' || pubkey AS k FROM users", legacy))
	})

	it('runs from the real CLI under Node and prints counts and digests only (DATA-13)', async () => {
		const exportPath = await exportOf({ level: 39 })
		const cli = fileURLToPath(new URL('../cli/kopje-admin.js', import.meta.url))
		const out = join(dir, 'cli-out')
		const run = promisify(execFile)
		const converted = await run(process.execPath, [
			cli,
			'convert',
			exportPath,
			'--out',
			out,
			'--base-time',
			'2026-10-20T00:00:00Z',
		])
		const verified = await run(process.execPath, [cli, 'verify-conversion', exportPath, join(out, 'kopje.dump')])
		const printed = converted.stdout + converted.stderr + verified.stdout + verified.stderr
		expect(verified.stdout).toContain('"result": "PASS"')
		for (const secret of [
			'secret direct message',
			'alice@example.com',
			'kopje.test',
			'BEGIN PUBLIC KEY',
			'fixture-client-secret',
			'remote.example',
		]) {
			expect(printed).not.toContain(secret)
		}
		const manifest = await readFile(join(out, 'manifest.json'), 'utf8')
		for (const secret of [
			'secret direct message',
			'alice@example.com',
			'kopje.test',
			'BEGIN PUBLIC KEY',
			'fixture-client-secret',
			'remote.example',
		]) {
			expect(manifest).not.toContain(secret)
		}
	})
})
