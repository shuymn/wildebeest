import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { beforeEach, describe, expect, it } from 'vitest'

import {
	convert as convertIn,
	exportOf as exportIn,
	opened,
	tampered as tamperedIn,
	verify as verifyWith,
	workspace,
} from './cutover-helpers.js'
import type { FixtureOptions } from './legacy-fixture.js'

// The converter end to end on synthetic exports (DATA-11 to DATA-14): convert, then check the result against
// expectations computed independently from the export, and show the check fails on each kind of damage.

const space = workspace()
const exportOf = (options: FixtureOptions, name?: string) => exportIn(space.dir, options, name)
const convert = (exportPath: string, extra?: Parameters<typeof convertIn>[2]) => convertIn(space.dir, exportPath, extra)
const verify = (exportPath: string, dumpPath: string, acceptDeletions = false) =>
	verifyWith(exportPath, dumpPath, { acceptDeletions })
const tampered = (dumpPath: string, sql: string) => tamperedIn(space.dir, dumpPath, sql)
const dir = () => space.dir

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
				'audience',
				'follows',
				'favourites',
				'notifications',
				'clients',
			]) {
				expect(categories[name]?.expected, name).toBeGreaterThan(0)
			}
			expect(categories.boosts?.expected ?? 0).toBe(options.level >= 2 ? 3 : 0)
			if (options.level >= 23) {
				expect(categories.edits?.expected).toBe(1)
			}
			if (options.level >= 32) {
				expect(categories.lists?.expected).toBe(1)
				expect(categories.blocks?.expected).toBe(2)
			}
		})
	}

	it('keeps legacy ids, accepted follows without a Follow record, local media and old /ap/o ids', async () => {
		const exportPath = await exportOf({ level: 39 })
		const { manifest, dumpPath } = await convert(exportPath)
		const conversion = manifest.conversion as Record<string, Record<string, number>>
		expect(conversion.normalized).toMatchObject({
			'follows:accepted-without-follow-record': 2,
			'notifications:duplicate-merged': 1,
			'statuses:remote-without-original-uri': 1,
		})
		expect(conversion.legacyIds).toMatchObject({ accounts: 2, statuses: 6, statuses_ap_o: 3, media_ap_o: 3 })
		const db = await opened(dumpPath)
		const value = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0]
		// Accepted follows without a Follow record keep uri NULL; one with an activity gets its id.
		expect(value("SELECT count(*) FROM follows WHERE state = 'accepted' AND uri IS NULL")).toBe(2)
		expect(value("SELECT uri FROM follows WHERE uri LIKE '%/ap/a/follow-300'")).toBe(
			'https://kopje.test/ap/a/follow-300'
		)
		// Old media stays at its URLs, and old Image ids are kept.
		expect(value("SELECT count(*) FROM media_attachments WHERE url LIKE 'https://images.example/%'")).toBe(3)
		expect(value('SELECT count(*) FROM media_attachments WHERE status_id IS NULL AND legacy_ap_o IS NOT NULL')).toBe(1)
		// Every id is 18 digits; notifications keep theirs, and the counter continues past the largest.
		expect(value('SELECT count(*) FROM statuses WHERE length(id) <> 18')).toBe(0)
		expect(value('SELECT group_concat(id) FROM (SELECT id FROM notifications ORDER BY id)')).toBe('1,2,3,4,6,7,8,9')
		expect(value("SELECT seq FROM sqlite_sequence WHERE name = 'notifications'")).toBe(9)
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
			['a DM is widened', "UPDATE statuses SET visibility = 'public' WHERE visibility = 'direct'", 'audience'],
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
			[
				'a DM recipient is removed',
				"DELETE FROM status_mentions WHERE status_id = (SELECT id FROM statuses WHERE content LIKE '%secret direct%')",
				'audience',
			],
			[
				'a DM recipient is added',
				"INSERT INTO status_mentions (status_id, account_id, silent) SELECT s.id, a.id, 1 FROM statuses s, accounts a WHERE s.content LIKE '%secret direct%' AND a.uri LIKE '%/users/r4'",
				'audience',
			],
			[
				'a followers-only status gets a non-follower recipient',
				"INSERT INTO status_mentions (status_id, account_id, silent) SELECT s.id, a.id, 0 FROM statuses s, accounts a WHERE s.content LIKE '%followers only%' AND a.uri LIKE '%/users/r3'",
				'audience',
			],
			['a reply link is dropped', 'UPDATE statuses SET in_reply_to_id = NULL', 'replies'],
			[
				'a followers-only boost gets a recipient',
				"INSERT INTO status_mentions (status_id, account_id, silent) SELECT s.id, a.id, 1 FROM statuses s, accounts a WHERE s.uri LIKE '%000000000220' AND a.uri LIKE '%/users/r4'",
				'boosts',
			],
			[
				'a followers-only status names another author',
				"UPDATE statuses SET account_id = (SELECT id FROM accounts WHERE uri LIKE '%/users/Bob') WHERE content LIKE '%followers only%'",
				'audience',
			],
			['a remote proxy alias is lost', 'UPDATE statuses SET legacy_ap_o = NULL', 'aliases'],
			[
				'the notification counter goes back',
				"UPDATE sqlite_sequence SET seq = 1 WHERE name = 'notifications'",
				'counters',
			],
			['a follow preference changes', 'UPDATE follows SET notify = 1', 'follows'],
			['a list policy changes', "UPDATE lists SET replies_policy = 'none'", 'lists'],
			['client scopes change', "UPDATE oauth_clients SET scopes = 'read write follow push admin'", 'clients'],
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
		const accepted = await convert(exportPath, { acceptDeletions: true, out: 'accepted' })
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
		const db = await opened(dumpPath)
		const hex = (sql: string, d: DatabaseSync) => (d.prepare(sql).all() as { k: string }[]).map((r) => r.k).sort()
		expect(
			hex("SELECT hex(privkey) || ':' || hex(privkey_salt) || ':' || pubkey AS k FROM local_accounts", db)
		).toEqual(hex("SELECT hex(privkey) || ':' || hex(privkey_salt) || ':' || pubkey AS k FROM users", legacy))
	})

	it('runs from the real CLI under Node and prints counts and digests only (DATA-13)', async () => {
		const exportPath = await exportOf({ level: 39 })
		const cli = fileURLToPath(new URL('../cli/kopje-admin.js', import.meta.url))
		const out = join(dir(), 'cli-out')
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
