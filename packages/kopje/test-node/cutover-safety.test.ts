import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { convert, exportOf, opened, verify, workspace } from './cutover-helpers.js'
import { ACTOR_URI_LIMIT, REMOTE_USERNAME, STATUS_URI_LIMIT } from '../cli/lib/cutover/convert.js'
import {
	cutJsonString,
	jsonStringBytes,
	REMOTE_BIO_BYTES,
	sanitizeRemoteBio,
	sanitizeRemoteContent,
	SPOILER_BYTES,
	STATUS_CONTENT_BYTES,
} from '../cli/lib/cutover/kopje-runtime.js'
import { loadLegacyExport } from '../cli/lib/cutover/legacy-load.js'
import { ExportError, parseStatement, tableExpressions } from '../cli/lib/cutover/sql-script.js'

// The converter's own safety: a strict export grammar (DATA-11), reports without content even on failure (DATA-13),
// exclusive outputs, HTML that is never cut silently, and a size preflight.

const space = workspace()

function codeOf(run: () => unknown): string {
	try {
		run()
	} catch (error) {
		if (error instanceof ExportError) {
			return error.code
		}
		throw error
	}
	return 'accepted'
}

async function appendTo(exportPath: string, table: string, text: string) {
	const file = join(exportPath, `${table}.sql`)
	await writeFile(file, `${await readFile(file, 'utf8')}${text}\n`)
}

describe('the export grammar (DATA-11)', () => {
	it('decodes only literal values', () => {
		expect(
			parseStatement(`INSERT INTO "t" VALUES(NULL,-1,2.5,'a''b',X'00ff',replace('a\\nb','\\n',char(10)),TRUE)`)
		).toEqual({
			kind: 'insert',
			table: 't',
			columns: null,
			rows: [[null, -1n, 2.5, "a'b", new Uint8Array([0, 255]), 'a\nb', 1n]],
		})
	})

	for (const [name, statement, code] of [
		['INSERT ... SELECT', 'INSERT INTO "peers" ("domain") SELECT id FROM actors', 'invalid-insert'],
		['a function in VALUES', `INSERT INTO "peers" ("domain") VALUES(upper('x'))`, 'invalid-literal'],
		['randomblob in VALUES', 'INSERT INTO "peers" ("domain") VALUES(randomblob(4))', 'invalid-literal'],
		['an expression in VALUES', 'INSERT INTO "peers" ("domain") VALUES(1+1)', 'invalid-insert'],
		['a subquery in VALUES', 'INSERT INTO "peers" ("domain") VALUES((SELECT 1))', 'invalid-literal'],
		['INSERT OR REPLACE', `INSERT OR REPLACE INTO "peers" ("domain") VALUES('x')`, 'unexpected-statement'],
		['CREATE TABLE AS SELECT', 'CREATE TABLE "x" AS SELECT * FROM actors', 'invalid-create-table'],
		['a subquery default', 'CREATE TABLE "x" ("a" DEFAULT (SELECT 1))', 'invalid-create-table'],
		['trailing text after CREATE TABLE', 'CREATE TABLE "x" ("a") AS SELECT 1', 'invalid-create-table'],
		['UPDATE', "UPDATE actors SET id = 'x'", 'unexpected-statement'],
		['DELETE', 'DELETE FROM actors', 'unexpected-statement'],
		['DROP', 'DROP TABLE actors', 'unexpected-statement'],
		['ATTACH', "ATTACH DATABASE 'x' AS y", 'unexpected-statement'],
		['another PRAGMA', 'PRAGMA writable_schema = 1', 'unexpected-statement'],
	] as const) {
		it(`refuses ${name} with a fixed code`, () => {
			expect(codeOf(() => parseStatement(statement))).toBe(code)
		})
	}

	it('accepts the replace(replace(...)) form SQLite .dump writes, and nothing deeper', () => {
		expect(
			parseStatement(`INSERT INTO "t" VALUES(replace(replace('a\\r\\nb','\\r',char(13)),'\\n',char(10)))`)
		).toMatchObject({ rows: [['a\r\nb']] })
		// 28 levels would double 'A' into 2^28 characters.
		let bomb = "'A'"
		for (let i = 0; i < 28; i++) {
			bomb = `replace(${bomb},'A',char(65,65))`
		}
		expect(codeOf(() => parseStatement(`INSERT INTO "t" VALUES(${bomb})`))).toBe('invalid-literal')
	})

	it('sizes an expansion before building it, and bounds the decoded data of an export', () => {
		const wide = `char(${Array.from({ length: 64 }, () => '66').join(',')})`
		const big = `replace(replace('${'A'.repeat(300_000)}','A',${wide}),'B',${wide})`
		expect(codeOf(() => parseStatement(`INSERT INTO "t" VALUES(${big})`))).toBe('decoded-data-too-large')
		const budget = { remaining: 10 }
		expect(parseStatement(`INSERT INTO "t" VALUES('12345')`, budget)).toMatchObject({ rows: [['12345']] })
		expect(codeOf(() => parseStatement(`INSERT INTO "t" VALUES('123456')`, budget))).toBe('decoded-data-too-large')
	})

	it('never runs the export DDL of bookkeeping tables', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const file = join(exportPath, 'd1_migrations.sql')
		const text = (await readFile(file, 'utf8'))
			.replace(
				'applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL',
				'applied_at BLOB DEFAULT (randomblob(268435456))'
			)
			.replaceAll(
				/INSERT INTO "d1_migrations" \("id","name","applied_at"\) VALUES\((\d+),('[^']+'),'[^']+'\);/g,
				'INSERT INTO "d1_migrations" ("id","name") VALUES($1,$2);'
			)
		expect(text).toContain('randomblob(268435456)')
		await writeFile(file, text)
		const started = Date.now()
		const { ok } = await convert(space.dir, exportPath)
		expect(ok).toBe(true)
		expect(Date.now() - started).toBeLessThan(10_000)
	})

	it('refuses data-table DDL whose default or check expressions differ from the canonical ones, before running it', async () => {
		expect(
			tableExpressions(
				`CREATE TABLE "x" ("c" AS (a || 1), "a" TEXT DEFAULT 'p', -- a, comment\n "b" INT CHECK (b > 0), CHECK (a <> b))`
			)
		).toEqual({
			columns: [
				['a', ["DEFAULT 'p'"]],
				['b', ['CHECK (B>0)']],
				['c', ['AS (A||1)']],
			],
			constraints: ['CHECK (A<>B)'],
		})
		// By column name: the same columns in another order compare equal, an expression on another column does not.
		const one = tableExpressions(`CREATE TABLE "x" ("a" TEXT DEFAULT 'p', "b" TEXT)`)
		expect(tableExpressions(`CREATE TABLE x (b TEXT, \`a\` TEXT DEFAULT 'p')`)).toEqual(one)
		expect(tableExpressions(`CREATE TABLE "x" ("a" TEXT, "b" TEXT DEFAULT 'p')`)).not.toEqual(one)
		for (const definition of [
			'CREATE TABLE "peers" ("domain" TEXT UNIQUE NOT NULL DEFAULT (randomblob(268435456)))',
			'CREATE TABLE "peers" ("domain" TEXT UNIQUE NOT NULL CHECK (length(randomblob(268435456)) > 0))',
		]) {
			const exportPath = await exportOf(space.dir, { level: 39 }, `export-${definition.length}`)
			const file = join(exportPath, 'peers.sql')
			await writeFile(file, (await readFile(file, 'utf8')).replace(/CREATE TABLE "peers"[^;]*;/, `${definition};`))
			const { ok, manifest } = await convert(space.dir, exportPath, { out: `out-${definition.length}` })
			expect(ok).toBe(false)
			expect(manifest.stop).toMatchObject({ code: 'schema-mismatch' })
		}
	})

	it('refuses an export that carries such a statement before running any of it', async () => {
		const fixture = await exportOf(space.dir, { level: 39 })
		await appendTo(fixture, 'peers', 'INSERT INTO "peers" ("domain") SELECT id FROM actors;')
		const texts = [await readFile(join(fixture, 'peers.sql'), 'utf8')]
		expect(codeOf(() => loadLegacyExport({ texts }))).toBe('invalid-insert')
		const { ok, manifest } = await convert(space.dir, fixture)
		expect(ok).toBe(false)
		expect(manifest.stop).toMatchObject({ code: 'invalid-insert' })
	})
})

describe('failure reports carry codes, counts and digests only (DATA-13)', () => {
	const SECRET = 'secret-marker-7f3a'
	const cases: [string, (exportPath: string) => Promise<void>][] = [
		[
			'an unsupported object type',
			async (exportPath) => {
				const file = join(exportPath, 'objects.sql')
				await writeFile(
					file,
					(await readFile(file, 'utf8')).replace(`,'Note','`, `,'https://${SECRET}.example/Kind','`)
				)
			},
		],
		['an extra table', (exportPath) => appendTo(exportPath, 'peers', `CREATE TABLE "${SECRET}" ("x" TEXT);`)],
		[
			'rows of an undefined table',
			(exportPath) => appendTo(exportPath, 'peers', `INSERT INTO "${SECRET}" ("x") VALUES('y');`),
		],
		[
			'a function call around content',
			(exportPath) => appendTo(exportPath, 'peers', `INSERT INTO "peers" ("domain") VALUES(upper('${SECRET}'));`),
		],
		[
			'an unknown column',
			(exportPath) => appendTo(exportPath, 'peers', `INSERT INTO "peers" ("${SECRET}") VALUES('x');`),
		],
		[
			'a value a constraint refuses',
			(exportPath) => appendTo(exportPath, 'peers', `INSERT INTO "peers" ("domain") VALUES(NULL);`),
		],
	]
	for (const [name, damage] of cases) {
		it(`with ${name}`, async () => {
			const exportPath = await exportOf(space.dir, { level: 39 })
			await damage(exportPath)
			const cli = fileURLToPath(new URL('../cli/kopje-admin.js', import.meta.url))
			const out = join(space.dir, 'out')
			const run = await promisify(execFile)(process.execPath, [
				cli,
				'convert',
				exportPath,
				'--out',
				out,
				'--base-time',
				'2026-10-20T00:00:00Z',
			]).catch((error: { code: number; stdout: string; stderr: string }) => error)
			expect('code' in run ? run.code : 0).toBe(3)
			const printed = `${run.stdout}${run.stderr}${await readFile(join(out, 'manifest.json'), 'utf8')}`
			expect(printed).toContain('"result": "stopped"')
			for (const leak of [SECRET, 'remote.example', 'kopje.test', 'alice@example.com']) {
				expect(printed).not.toContain(leak)
			}
		})
	}
})

describe('outputs', () => {
	it('are created with mode 0600 and only once', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const { ok, dumpPath } = await convert(space.dir, exportPath)
		expect(ok).toBe(true)
		expect((await stat(dumpPath)).mode & 0o777).toBe(0o600)
		expect((await stat(join(space.dir, 'out', 'manifest.json'))).mode & 0o777).toBe(0o600)
		await expect(convert(space.dir, exportPath)).rejects.toMatchObject({ code: 'output-exists' })
	})

	it('never reuse an existing file or follow a link', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const out = join(space.dir, 'out')
		await mkdir(out)
		await writeFile(join(out, 'kopje.dump'), 'kept', { mode: 0o644 })
		await expect(convert(space.dir, exportPath)).rejects.toMatchObject({ code: 'output-exists' })
		expect(await readFile(join(out, 'kopje.dump'), 'utf8')).toBe('kept')

		const victim = join(space.dir, 'victim.txt')
		await writeFile(victim, 'untouched')
		const linked = join(space.dir, 'linked')
		await mkdir(linked)
		await symlink(victim, join(linked, 'kopje.dump'))
		await expect(convert(space.dir, exportPath, { out: 'linked' })).rejects.toMatchObject({ code: 'output-exists' })
		expect(await readFile(victim, 'utf8')).toBe('untouched')
		expect((await lstat(join(linked, 'kopje.dump'))).isSymbolicLink()).toBe(true)

		await symlink(join(space.dir, 'elsewhere'), join(space.dir, 'dir-link'))
		await mkdir(join(space.dir, 'elsewhere'))
		await expect(convert(space.dir, exportPath, { out: 'dir-link' })).rejects.toMatchObject({
			code: 'output-not-a-directory',
		})
	})
})

describe('HTML is never cut silently', () => {
	it('stops on content over the sanitizer limit unless truncation is accepted; verify fails likewise', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const file = join(exportPath, 'objects.sql')
		await writeFile(
			file,
			(await readFile(file, 'utf8')).replace('<p>a reply to alice</p>', `<p>${'long '.repeat(11_000)}</p>`)
		)
		const stopped = await convert(space.dir, exportPath)
		expect(stopped.ok).toBe(false)
		expect((stopped.manifest.conversion as { problems: Record<string, number> }).problems).toEqual({
			'html:longer-than-sanitizer-limit': 1,
		})
		const accepted = await convert(space.dir, exportPath, { out: 'accepted', acceptTruncation: true })
		expect(accepted.ok).toBe(true)
		expect((await verify(exportPath, accepted.dumpPath)).ok).toBe(false)
		expect((await verify(exportPath, accepted.dumpPath, { acceptTruncation: true })).ok).toBe(true)
	})

	it('stops on a bio over its bound unless truncation is accepted, and stores it cut as the Worker does', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		// Within the sanitizer's raw limit, but about 780 KB once sanitized: past REMOTE_BIO_BYTES.
		const bio = '<a>'.repeat(16_000)
		const files = (await readdir(exportPath)).filter((name) => name.endsWith('.sql'))
		let replaced = 0
		for (const name of files) {
			const text = await readFile(join(exportPath, name), 'utf8')
			if (text.includes('<p>bio 0</p>')) {
				await writeFile(join(exportPath, name), text.replace('<p>bio 0</p>', bio))
				replaced++
			}
		}
		expect(replaced).toBe(1)
		const stopped = await convert(space.dir, exportPath)
		expect(stopped.ok).toBe(false)
		expect((stopped.manifest.conversion as { problems: Record<string, number> }).problems).toEqual({
			'html:bio-longer-than-bound': 1,
		})
		const accepted = await convert(space.dir, exportPath, { out: 'accepted', acceptTruncation: true })
		expect(accepted.ok).toBe(true)
		const db = await opened(accepted.dumpPath)
		const row = db.prepare("SELECT note FROM accounts WHERE uri = 'https://remote.example/users/r0'").get() as {
			note: string
		}
		db.close()
		expect(row.note).toBe(sanitizeRemoteBio(bio))
		expect(jsonStringBytes(row.note)).toBeLessThanOrEqual(REMOTE_BIO_BYTES)
		// Verification counts the cut bio as a truncation, and agrees with the converter once it is accepted.
		const refused = await verify(exportPath, accepted.dumpPath)
		expect(refused.ok).toBe(false)
		expect(refused.report).toMatchObject({ truncation: { overLimit: 1, accepted: false } })
		expect((await verify(exportPath, accepted.dumpPath, { acceptTruncation: true })).ok).toBe(true)
	})

	// Replaces `from` with `to` in every file of the export; returns how many files held it.
	const replacedIn = async (exportPath: string, from: string, to: string) => {
		let replaced = 0
		for (const name of (await readdir(exportPath)).filter((n) => n.endsWith('.sql'))) {
			const text = await readFile(join(exportPath, name), 'utf8')
			if (text.includes(from)) {
				await writeFile(join(exportPath, name), text.replaceAll(from, to))
				replaced++
			}
		}
		return replaced
	}

	it('stops on status text over its bounds unless truncation is accepted, and stores it cut as the Worker does', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		// Content within the sanitizer's raw limit but about 780 KB once sanitized, and a content warning of 48 KB.
		const content = '<a>'.repeat(16_000)
		const spoiler = '注意'.repeat(8_000)
		expect(await replacedIn(exportPath, '<p>unlisted from r3, lost its original id</p>', content)).toBe(1)
		expect(await replacedIn(exportPath, 'CW 注意', spoiler)).toBe(1)
		const stopped = await convert(space.dir, exportPath)
		expect(stopped.ok).toBe(false)
		expect((stopped.manifest.conversion as { problems: Record<string, number> }).problems).toEqual({
			'html:content-longer-than-bound': 1,
			'text:spoiler-longer-than-bound': 1,
		})
		const accepted = await convert(space.dir, exportPath, { out: 'accepted', acceptTruncation: true })
		expect(accepted.ok).toBe(true)
		const db = await opened(accepted.dumpPath)
		const rows = db.prepare('SELECT content, spoiler_text FROM statuses').all() as {
			content: string
			spoiler_text: string
		}[]
		db.close()
		expect(rows.map((row) => row.content)).toContain(sanitizeRemoteContent(content))
		expect(rows.map((row) => row.spoiler_text)).toContain(cutJsonString(spoiler, SPOILER_BYTES))
		for (const row of rows) {
			expect(jsonStringBytes(row.content)).toBeLessThanOrEqual(STATUS_CONTENT_BYTES)
			expect(jsonStringBytes(row.spoiler_text)).toBeLessThanOrEqual(SPOILER_BYTES)
		}
		// Verification counts both as truncations, and agrees with the converter once they are accepted.
		const refused = await verify(exportPath, accepted.dumpPath)
		expect(refused.ok).toBe(false)
		expect(refused.report).toMatchObject({ truncation: { overLimit: 2, accepted: false } })
		expect((await verify(exportPath, accepted.dumpPath, { acceptTruncation: true })).ok).toBe(true)
	})

	it('counts an attachment of an earlier version that the Worker shows cut', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const long = `[{"type":"Document","mediaType":"image/png","url":"https://remote.example/a.png","name":"${'d'.repeat(10_001)}"}]`
		expect(
			await replacedIn(
				exportPath,
				'"spoiler_text":"","sensitive":false,"attachment":[]',
				`"spoiler_text":"","sensitive":false,"attachment":${long}`
			)
		).toBe(1)
		const converted = await convert(space.dir, exportPath)
		expect(converted.ok).toBe(true)
		expect(
			(converted.manifest.conversion as { normalized: Record<string, number> }).normalized[
				'edits:media-field-over-bound'
			]
		).toBe(1)
	})

	it('refuses a remote username the Worker would refuse, whatever truncation accepts', async () => {
		const source = await readFile(fileURLToPath(new URL('../src/federation/remote-actor.ts', import.meta.url)), 'utf8')
		expect(source).toContain(`const USERNAME = ${REMOTE_USERNAME}\n`)
		const exportPath = await exportOf(space.dir, { level: 39 })
		expect(await replacedIn(exportPath, '"preferredUsername":"r3"', '"preferredUsername":"r\\u00e9"')).toBe(1)
		const stopped = await convert(space.dir, exportPath, { acceptTruncation: true })
		expect(stopped.ok).toBe(false)
		expect((stopped.manifest.conversion as { problems: Record<string, number> }).problems).toEqual({
			'remote-actor-username-invalid': 1,
		})
	})

	it('refuses an actor id over the bound the Worker stores, whatever truncation accepts', async () => {
		// The converter's bounds of identities are the Worker's (src/domain/profile-bounds.ts, status-bounds.ts).
		const source = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
		expect(await source('../src/domain/profile-bounds.ts')).toContain(`ACTOR_URI_LIMIT = ${ACTOR_URI_LIMIT}\n`)
		expect(await source('../src/domain/status-bounds.ts')).toContain(`STATUS_URL_LIMIT = ${STATUS_URI_LIMIT}\n`)
		const exportPath = await exportOf(space.dir, { level: 39 })
		const long = `https://remote.example/users/r2${'x'.repeat(ACTOR_URI_LIMIT)}`
		expect(await replacedIn(exportPath, 'https://remote.example/users/r2', long)).toBeGreaterThan(0)
		const stopped = await convert(space.dir, exportPath, { acceptTruncation: true })
		expect(stopped.ok).toBe(false)
		expect((stopped.manifest.conversion as { problems: Record<string, number> }).problems).toMatchObject({
			'remote-actor-uri-over-limit': 1,
		})
	})

	it('stores sanitized HTML as written here by hand, not as computed by the shared sanitizer', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const file = join(exportPath, 'objects.sql')
		const legacy = '<p>a reply to alice</p>'
		const hostile =
			'<p>hi<script>alert(1)</script> <a href="javascript:alert(1)">x</a> <a href="https://a.example/" class="mention evil">y</a><br/>z</p><h1>T</h1><img src="https://a.example/i.png">'
		await writeFile(file, (await readFile(file, 'utf8')).replace(legacy, JSON.stringify(hostile).slice(1, -1)))
		const { ok, dumpPath } = await convert(space.dir, exportPath)
		expect(ok).toBe(true)
		const db = await opened(dumpPath)
		const row = db.prepare("SELECT content FROM statuses WHERE content LIKE '<p>hi%'").get() as { content: string }
		db.close()
		expect(row.content).toBe(
			'<p>hi <a rel="nofollow noopener" target="_blank">x</a> <a href="https://a.example/" class="mention" rel="nofollow noopener" target="_blank">y</a><br>z</p><p><strong>T</strong></p>'
		)
	})
})

describe('size preflight', () => {
	it('refuses an export over 1 GiB in total, though each file is under the per-file limit', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		for (const name of ['zx.sql', 'zy.sql', 'zz.sql']) {
			await writeFile(join(exportPath, name), '')
			await truncate(join(exportPath, name), 400 * 1024 * 1024)
		}
		const { ok, manifest } = await convert(space.dir, exportPath)
		expect(ok).toBe(false)
		expect(manifest.stop).toMatchObject({ code: 'export-too-large' })
	})

	it('refuses to verify a dump over 512 MiB before reading it', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const dump = join(space.dir, 'big.dump')
		await writeFile(dump, '')
		await truncate(dump, 600 * 1024 * 1024)
		const { ok, report } = await verify(exportPath, dump)
		expect(ok).toBe(false)
		expect(report).toMatchObject({ result: 'FAIL', stop: { code: 'export-too-large' } })
	})

	it('refuses an export file over 512 MiB before reading it', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const big = join(exportPath, 'zz.sql')
		await writeFile(big, '')
		await truncate(big, 600 * 1024 * 1024)
		const { ok, manifest } = await convert(space.dir, exportPath)
		expect(ok).toBe(false)
		expect(manifest.stop).toMatchObject({ code: 'export-too-large' })
	})
})
