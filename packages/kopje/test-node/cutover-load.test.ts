import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildLegacyFixture } from './legacy-fixture.js'
import { LegacyLoadError, loadLegacyExport } from '../cli/lib/cutover/legacy-load.js'
import { classify, splitStatements } from '../cli/lib/cutover/sql-script.js'

const T1_LEVELS = [0, 5, 10, 18, 23, 35, 39]

function errorOf(run: () => unknown): LegacyLoadError {
	try {
		run()
	} catch (error) {
		if (error instanceof LegacyLoadError) {
			return error
		}
		throw error
	}
	throw new Error('expected a LegacyLoadError')
}

describe('legacy migrations copy', () => {
	it('is byte-identical to the repository migrations, which are frozen at 0039', () => {
		const root = fileURLToPath(new URL('../../../migrations/', import.meta.url))
		const copy = fileURLToPath(new URL('../cli/legacy-migrations/', import.meta.url))
		const names = readdirSync(root).sort()
		expect(readdirSync(copy).sort()).toEqual(names)
		expect(names.at(-1)).toMatch(/^0039_/)
		for (const name of names) {
			expect(readFileSync(`${copy}${name}`, 'utf8'), name).toBe(readFileSync(`${root}${name}`, 'utf8'))
		}
	})
})

describe('export statements', () => {
	it('splits on semicolons outside literals, identifiers and comments, and keeps triggers whole', () => {
		const script = [
			'-- comment; with a semicolon\nPRAGMA defer_foreign_keys=TRUE;',
			`INSERT INTO "t" ("a","b") VALUES('x;y''z','line\n;');`,
			'CREATE TRIGGER tr AFTER INSERT ON t BEGIN DELETE FROM u; INSERT INTO u VALUES (1); END;',
			'INSERT INTO `t` VALUES(1, /* ; */ 2)',
		].join('\n')
		const statements = [...splitStatements(script)]
		expect(statements).toHaveLength(4)
		expect(statements.map((s) => classify(s).kind)).toEqual(['pragma', 'insert', 'create-other', 'insert'])
		expect(classify(statements[1] ?? '')).toMatchObject({ table: 't', hasColumns: true })
		expect(classify(statements[3] ?? '')).toMatchObject({ table: 't', hasColumns: false })
		expect(classify('DROP TABLE actors').kind).toBe('other')
		expect(classify('ATTACH DATABASE x AS y').kind).toBe('other')
	})
})

describe('loading and bridging an export', () => {
	for (const level of T1_LEVELS) {
		it(`detects T1 level ${level} and bridges it to 0039`, async () => {
			const fixture = await buildLegacyFixture({ level })
			const { db, report } = loadLegacyExport({ texts: fixture.texts.values() })
			expect(report.level).toBe(level)
			expect(report.migrationsApplied).toHaveLength(39 - level)
			expect(report.deletions).toEqual([])
			const users = db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }
			expect(users.n).toBe(2)
			db.close()
		})
	}

	it('loads a T2 export written with the upstream DDL', async () => {
		const fixture = await buildLegacyFixture({ level: 10, line: 'T2' })
		const { report } = loadLegacyExport({ texts: fixture.texts.values() })
		expect(report).toMatchObject({ level: 10, line: 'T1 or T2', deletions: [] })
	})

	it('gives the same bridged data on every run (deterministic randomblob)', async () => {
		const fixture = await buildLegacyFixture({ level: 5 })
		const read = () => {
			const { db } = loadLegacyExport({ texts: fixture.texts.values() })
			const rows = db
				.prepare('SELECT id, secret FROM clients UNION ALL SELECT id, mastodon_id FROM actors ORDER BY 1')
				.all()
			db.close()
			return rows
		}
		expect(read()).toEqual(read())
	})

	it('accepts one concatenated file as well as one file per table', async () => {
		const fixture = await buildLegacyFixture({ level: 39 })
		const { report } = loadLegacyExport({ texts: [[...fixture.texts.values()].join('\n')] })
		expect(report.level).toBe(39)
	})

	it('stops on rows the bridge removes until deletions are accepted, and reports their counts', async () => {
		const fixture = await buildLegacyFixture({ level: 5, withDeletions: true })
		const error = errorOf(() => loadLegacyExport({ texts: fixture.texts.values() }))
		expect(error.code).toBe('deletions-not-accepted')
		const { report } = loadLegacyExport({ texts: fixture.texts.values(), acceptDeletions: true })
		const by = (migration: string) => report.deletions.filter((d) => d.migration.startsWith(migration))
		expect(by('0007')).toEqual([{ migration: '0007_change_subscriptions_id', table: 'subscriptions', rows: 1 }])
		expect(by('0017')).toEqual([{ migration: '0017_change_actor_reblogs', table: 'actor_reblogs', rows: 1 }])
		expect(by('0021').find((d) => d.table === 'objects')).toEqual({
			migration: '0021_update_objects',
			table: 'objects',
			rows: 1,
		})
		expect(by('0034')).toEqual([{ migration: '0034_add_unique_actor_favourites', table: 'actor_favourites', rows: 1 }])
	})

	it('refuses unknown migrations, unsupported levels, schema drift and stray statements', async () => {
		const fixture = await buildLegacyFixture({ level: 39 })
		const texts = new Map(fixture.texts)

		const forked = new Map(texts)
		forked.set(
			'd1_migrations',
			`${texts.get('d1_migrations') ?? ''}INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(41,'0040_fork.sql','2024-01-01');\n`
		)
		expect(errorOf(() => loadLegacyExport({ texts: forked.values() })).code).toBe('unknown-migrations')

		const partial = await buildLegacyFixture({ level: 20 })
		expect(errorOf(() => loadLegacyExport({ texts: partial.texts.values() })).code).toBe('unsupported-level')

		const drifted = new Map(texts)
		drifted.set('peers', 'CREATE TABLE "peers" ("domain" TEXT UNIQUE NOT NULL, "extra" TEXT);\n')
		expect(errorOf(() => loadLegacyExport({ texts: drifted.values() })).code).toBe('schema-mismatch')

		const missing = new Map(texts)
		missing.delete('lists')
		expect(errorOf(() => loadLegacyExport({ texts: missing.values() }))).toMatchObject({
			code: 'schema-mismatch',
			detail: { missing: ['lists'] },
		})

		const hostile = new Map(texts)
		hostile.set('x', 'DROP TABLE actors;\n')
		expect(errorOf(() => loadLegacyExport({ texts: hostile.values() })).code).toBe('unexpected-statement')
	})
})
