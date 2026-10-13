import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
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
	failing,
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
		{ level: 23, actorTypeDrift: true },
		{ level: 39, actorTypeDrift: true },
	]) {
		const name = `${options.line ?? 'T1'} export at level ${options.level}${'actorTypeDrift' in options ? ' with actors.type added back' : ''}`
		it(`converts a ${name} and the independent check passes`, async () => {
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

	it('reads sqlite_sequence as D1 exports it (a reset, then the counter rows), and refuses a second reset', async () => {
		const exportPath = await exportOf({ level: 39, notificationSequence: 12n })
		const file = join(exportPath, 'sqlite_sequence.sql')
		const text = await readFile(file, 'utf8')
		expect(text).toMatch(
			/^PRAGMA defer_foreign_keys=TRUE;\nDELETE FROM sqlite_sequence;\nINSERT INTO "sqlite_sequence"/
		)
		const { ok, manifest, dumpPath } = await convert(exportPath)
		expect(ok).toBe(true)
		expect(manifest.source).toMatchObject({ notificationSequence: '12' })
		expect((await verify(exportPath, dumpPath)).ok).toBe(true)

		await writeFile(file, `${text}DELETE FROM sqlite_sequence;\n`)
		const again = await convert(exportPath, { out: 'out-again' })
		expect(again.ok).toBe(false)
		expect(again.manifest.stop).toMatchObject({ code: 'unexpected-statement' })
		const { ok: verified, report } = await verify(exportPath, dumpPath)
		expect(verified).toBe(false)
		expect(report.stop).toMatchObject({ code: 'unexpected-statement' })
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
				'an unattached image changes owner',
				"UPDATE media_attachments SET account_id = (SELECT id FROM accounts WHERE uri LIKE '%/users/Bob') WHERE status_id IS NULL AND legacy_ap_o IS NOT NULL",
				'media',
			],
			[
				'an image moves to another status',
				"UPDATE media_attachments SET status_id = (SELECT id FROM statuses WHERE content LIKE '%Bob says hi%') WHERE legacy_ap_o IS NOT NULL AND status_id IS NOT NULL",
				'media',
			],
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

describe('rows legacy never showed, and outbox rows written before 0016', () => {
	const notificationCount = async (dumpPath: string) => {
		const db = await opened(dumpPath)
		const n = (db.prepare('SELECT count(*) AS n FROM notifications').get() as { n: number }).n
		db.close()
		return n
	}

	it('drops notifications owned by a remote account, counted, and only with --accept-deletions', async () => {
		const plain = await convert(await exportOf({ level: 39 }, 'plain'), { out: 'plain' })
		const exportPath = await exportOf({ level: 39, remoteOwnedNotifications: true })
		const refused = await convert(exportPath)
		expect(refused.ok).toBe(false)
		expect(refused.manifest.stop).toMatchObject({ code: 'conversion-refused' })
		expect(refused.manifest.conversion).toMatchObject({
			problems: {},
			dropped: { 'notifications:owner-remote': 2 },
		})
		const { ok, dumpPath } = await convert(exportPath, { acceptDeletions: true, out: 'accepted' })
		expect(ok).toBe(true)
		expect(await notificationCount(dumpPath)).toBe(await notificationCount(plain.dumpPath))
		// The independent check expects a local user's notifications only.
		expect((await verify(exportPath, dumpPath, true)).ok).toBe(true)
	})

	it('reads a row written before 0016 as its target, which may narrow the audience of its status', async () => {
		const exportPath = await exportOf({ level: 39, before0016: 'narrowed' })
		const { ok, manifest, dumpPath } = await convert(exportPath)
		expect(manifest.stop).toBeUndefined()
		expect(ok).toBe(true)
		const db = await opened(dumpPath)
		const row = db.prepare("SELECT visibility FROM statuses WHERE content LIKE '%unlisted, with a CW%'").get()
		db.close()
		expect(row).toEqual({ visibility: 'unlisted' })
		expect((await verify(exportPath, dumpPath)).ok).toBe(true)
	})

	// DATA-15: the status keeps its own audience; a target outside it is a conflict, and so is any row while the time of
	// 0016 is unknown.
	for (const [name, options, edit] of [
		['a target that would widen the audience', { level: 39, before0016: 'widened' }, null],
		['an unusable applied_at of 0016', { level: 39, before0016: 'unusable-time' }, null],
		[
			'no applied_at in d1_migrations',
			{ level: 39, before0016: 'narrowed' },
			(text: string) =>
				text.replaceAll(
					/INSERT INTO "d1_migrations" \("id","name","applied_at"\) VALUES\((\d+),('[^']+'),'[^']+'\);/g,
					'INSERT INTO "d1_migrations" ("id","name") VALUES($1,$2);'
				),
		],
	] as const) {
		it(`stops on ${name}`, async () => {
			const exportPath = await exportOf(options)
			if (edit !== null) {
				const file = join(exportPath, 'd1_migrations.sql')
				const text = await readFile(file, 'utf8')
				expect(edit(text)).not.toBe(text)
				await writeFile(file, edit(text))
			}
			const { ok, manifest } = await convert(exportPath, { acceptDeletions: true })
			expect(ok).toBe(false)
			expect(manifest.conversion).toMatchObject({ problems: { 'statuses:addressing-conflict': 1 } })
		})
	}
})

describe('text with a lone surrogate', () => {
	it('carries it with U+FFFD in its place, counted, and the independent check agrees', async () => {
		const exportPath = await exportOf({ level: 39, loneSurrogates: true })
		const { ok, manifest, dumpPath } = await convert(exportPath)
		expect(manifest.stop).toBeUndefined()
		expect(ok).toBe(true)
		// A display name, a bio, a status's content, content warning and attachment description.
		expect((manifest.conversion as { normalized: Record<string, number> }).normalized).toMatchObject({
			'text:lone-surrogate-replaced': 5,
		})
		const db = await opened(dumpPath)
		const value = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0]
		expect(value("SELECT count(*) FROM accounts WHERE display_name LIKE '%\uFFFD' OR note LIKE '%\uFFFD%'")).toBe(2)
		expect(
			value("SELECT count(*) FROM statuses WHERE content LIKE '%cut \uFFFD%' AND spoiler_text = 'cw \uFFFD'")
		).toBe(1)
		expect(value("SELECT count(*) FROM media_attachments WHERE description = 'alt \uFFFD'")).toBe(1)
		db.close()
		const { ok: verified, categories } = await verifyWith(exportPath, dumpPath)
		expect(failing(categories)).toEqual([])
		expect(verified).toBe(true)
	})
})
