import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { convert, exportOf, workspace } from './cutover-helpers.js'
import { buildLegacyFixture } from './legacy-fixture.js'
import {
	compareFingerprints,
	fingerprintOf,
	fingerprintSql,
	MAX_SQL_BYTES,
	SCHEMA_SQL,
	schemaOf,
} from '../cli/lib/cutover/fingerprint.js'

// Cutover step 5: the fingerprint that proves the legacy D1 stopped changing. The SQL runs here on node:sqlite against
// a synthetic legacy database, as the operator runs it on D1 with `wrangler d1 execute --json`; the answers are passed
// in wrangler's JSON shape. DATA-16: the answer and the comparison carry counts, lengths and hashes only.

const space = workspace()

async function live() {
	const fixture = await buildLegacyFixture({ level: 39, live: true })
	const db = fixture.database!
	const sql = fingerprintSql(schemaOf(asWrangler(db.prepare(SCHEMA_SQL).all())))
	const take = () => fingerprintOf(asWrangler(db.prepare(sql).all()))
	return { db, sql, take, fixture }
}

// `wrangler d1 execute --json` prints one entry per statement.
function asWrangler(rows: unknown[]) {
	return [{ results: rows, success: true, meta: {} }]
}

function changedBy(db: DatabaseSync, take: () => ReturnType<typeof fingerprintOf>, write: string) {
	const before = take()
	db.exec(write)
	return compareFingerprints(before, take())
}

describe('the fingerprint query', () => {
	it('lists the exported tables only, and fits in one D1 statement', async () => {
		const { db, sql } = await live()
		const tables = [...schemaOf(db.prepare(SCHEMA_SQL).all()).keys()]
		expect(tables).toContain('objects')
		expect(tables).toContain('d1_migrations')
		expect(tables.filter((t) => t.startsWith('search_fts') || t.startsWith('sqlite_'))).toEqual([])
		expect(Buffer.byteLength(sql)).toBeLessThan(MAX_SQL_BYTES)
		expect(sql).toMatch(/^WITH /)
		expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|PRAGMA)\b/i)
	})

	it('gives the same answer twice while nothing writes, and counts every row', async () => {
		const { db, take } = await live()
		const first = take()
		const report = compareFingerprints(first, take())
		expect(report).toMatchObject({ result: 'PASS', changed: [] })
		const objects = first.find((t) => t.table === 'objects')!
		expect(objects.rows).toBe((db.prepare('SELECT count(*) AS n FROM objects').get() as { n: number }).n)
		expect(objects.rows).toBeGreaterThan(0)
	})

	it('answers with aggregates only (DATA-16)', async () => {
		const { take, fixture } = await live()
		const answer = JSON.stringify(take())
		for (const user of fixture.users) {
			expect(answer).not.toContain(user.email)
			expect(answer).not.toContain(user.uri)
		}
		for (const row of take()) {
			expect(Object.keys(row).sort()).toEqual(['bytes', 'hash', 'rows', 'table'])
		}
	})

	// Each is a write the legacy consumer or a forgotten route could make; each must FAIL the comparison.
	it.each([
		['an inserted row', `INSERT INTO peers (domain) VALUES ('new.example')`, 'peers'],
		['a deleted row', 'DELETE FROM objects WHERE rowid = (SELECT max(rowid) FROM objects)', 'objects'],
		['a counter bumped at the same length', "UPDATE actors SET cdate = replace(cdate, '09:', '19:')", 'actors'],
		[
			'two digits of a short value swapped',
			'UPDATE objects SET cdate = substr(cdate, 1, 14) || substr(cdate, 16, 1) || substr(cdate, 15, 1) || substr(cdate, 17) WHERE rowid = (SELECT min(rowid) FROM objects)',
			'objects',
		],
		[
			'a long value rewritten at the same length in the middle',
			"UPDATE objects SET properties = substr(properties, 1, length(properties) / 2 - 1) || 'Z' || substr(properties, length(properties) / 2 + 1) WHERE rowid = (SELECT min(rowid) FROM objects)",
			'objects',
		],
		[
			'content emptied to the same length',
			"UPDATE objects SET properties = json_set(properties, '$.content', substr('                                ', 1, length(json_extract(properties, '$.content')))) WHERE json_extract(properties, '$.content') IS NOT NULL AND rowid = (SELECT min(rowid) FROM objects WHERE json_extract(properties, '$.content') IS NOT NULL)",
			'objects',
		],
		['a write that changes no value (still PASS)', 'UPDATE peers SET domain = domain', null],
	])('%s', async (_name, write, table) => {
		const { db, take } = await live()
		const report = changedBy(db, take, write)
		if (table === null) {
			// A write that changes no value is not a change.
			expect(report.result).toBe('PASS')
		} else {
			expect(report).toMatchObject({ result: 'FAIL', changed: [table] })
		}
	})

	it('refuses to compare answers of different schemas', async () => {
		const { db, take } = await live()
		const first = take()
		db.exec('ALTER TABLE peers ADD COLUMN note TEXT')
		const sql = fingerprintSql(schemaOf(db.prepare(SCHEMA_SQL).all()))
		const report = compareFingerprints(first, fingerprintOf(db.prepare(sql).all()))
		expect(report.result).toBe('FAIL')
		expect(report.changed).toContain('#schema')
	})

	it('checks the converted export against the fingerprinted database, by row counts', async () => {
		const exportPath = await exportOf(space.dir, { level: 39 })
		const { manifest } = await convert(space.dir, exportPath)
		const { take } = await live()
		const fingerprint = take()
		const rowsLoaded = (manifest.source as { rowsLoaded: Record<string, number> }).rowsLoaded
		expect(compareFingerprints(fingerprint, fingerprint, rowsLoaded)).toMatchObject({
			result: 'PASS',
			exportDiffers: [],
		})
		const short = { ...rowsLoaded, objects: (rowsLoaded.objects ?? 0) - 1 }
		expect(compareFingerprints(fingerprint, fingerprint, short)).toMatchObject({
			result: 'FAIL',
			exportDiffers: ['objects'],
		})
	})
})

describe('kopje-admin fingerprint', () => {
	const cli = fileURLToPath(new URL('../cli/kopje-admin.js', import.meta.url))
	const run = async (args: string[]) => {
		try {
			const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, ...args])
			return { code: 0, stdout, stderr }
		} catch (error) {
			const e = error as { code: number; stdout: string; stderr: string }
			return { code: e.code, stdout: e.stdout, stderr: e.stderr }
		}
	}

	it('prints the SQL and compares the answers through the real CLI', async () => {
		const { db } = await live()
		const schemaSql = await run(['fingerprint', 'schema-sql'])
		expect(schemaSql.stdout.trim()).toBe(SCHEMA_SQL)
		const schemaPath = join(space.dir, 'schema.json')
		await writeFile(schemaPath, JSON.stringify(asWrangler(db.prepare(SCHEMA_SQL).all())))
		const { stdout: sql, code } = await run(['fingerprint', 'sql', schemaPath])
		expect(code).toBe(0)

		const first = join(space.dir, 'first.json')
		const second = join(space.dir, 'second.json')
		await writeFile(first, JSON.stringify(asWrangler(db.prepare(sql.trim()).all())))
		await writeFile(second, JSON.stringify(asWrangler(db.prepare(sql.trim()).all())))
		const same = await run(['fingerprint', 'compare', first, second])
		expect(same.code).toBe(0)
		expect(JSON.parse(same.stdout)).toMatchObject({ result: 'PASS' })

		db.exec(`INSERT INTO peers (domain) VALUES ('late.example')`)
		await writeFile(second, JSON.stringify(asWrangler(db.prepare(sql.trim()).all())))
		const differs = await run(['fingerprint', 'compare', first, second])
		expect(differs.code).toBe(1)
		expect(JSON.parse(differs.stdout)).toMatchObject({ result: 'FAIL', changed: ['peers'] })
		expect(differs.stdout).not.toContain('late.example')
	})

	it('refuses an answer that is not a fingerprint', async () => {
		const path = join(space.dir, 'rows.json')
		await writeFile(path, JSON.stringify(asWrangler([{ id: 'x', content: 'y' }])))
		const result = await run(['fingerprint', 'compare', path, path])
		expect(result.code).toBe(2)
		expect(result.stderr).toContain('invalid-fingerprint-row')
	})
})
