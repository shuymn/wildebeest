import { describe, expect, it } from 'vitest'

import {
	chainDigest,
	END_LINE as CLI_END,
	HEADER_PREFIX as CLI_HEADER,
	TRAILER_PREFIX as CLI_TRAILER,
} from '../cli/lib/format.js'
import {
	END_LINE,
	HEADER_PREFIX,
	insertTemplate,
	linkTemplate,
	parseStatements,
	renderTemplate,
	scanLiteral,
	type TableSpec,
	TRAILER_PREFIX,
	utf8Length,
} from '../src/platform/dump-format'
import { readOnlyProblem } from '../src/platform/readonly-sql'
import { Sha256, sha256Hex } from '../src/platform/sha256'

async function subtleHex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('Sha256', () => {
	it('matches WebCrypto for lengths around block boundaries', async () => {
		for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
			const data = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff)
			expect(sha256Hex(data), `length ${length}`).toBe(await subtleHex(data))
		}
	})

	it('continues identically after save and restore at any split', async () => {
		const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 13) & 0xff)
		const expected = await subtleHex(data)
		for (const split of [0, 1, 63, 64, 65, 200, 300]) {
			const first = new Sha256().update(data.subarray(0, split))
			const resumed = Sha256.restore(first.save()).update(data.subarray(split))
			expect(resumed.hex(), `split ${split}`).toBe(expected)
		}
	})

	it('rejects a malformed saved state', () => {
		expect(() => Sha256.restore('nope')).toThrow('invalid hash state')
		expect(() => Sha256.restore(`${'0'.repeat(64)}:3:`)).toThrow('invalid hash state')
	})
})

describe('dump format', () => {
	const statuses: TableSpec = {
		name: 'statuses',
		columns: ['id', 'content', 'reblog_of_id'],
		order: { by: 'rowid' },
		key: ['id'],
		deferred: ['reblog_of_id'],
	}

	it('keeps the CLI constants and chain digest in step with the Store', async () => {
		expect([CLI_HEADER, CLI_TRAILER, CLI_END]).toEqual([HEADER_PREFIX, TRAILER_PREFIX, END_LINE])
		const chunk = new TextEncoder().encode('INSERT ...;\n')
		expect(await chainDigest('abc', chunk)).toBe(new Sha256().update('abc').update(chunk).hex())
	})

	it('scans every literal form quote() produces', () => {
		for (const literal of [
			'NULL',
			'0',
			'-42',
			'9223372036854775807',
			'1.0',
			'-0.5',
			'1.5e+300',
			'9.0e+999',
			"'it''s'",
			"''",
			"X'00FF'",
			"X''",
			"CAST(X'610062' AS TEXT)",
		]) {
			expect(scanLiteral(`${literal},`, 0), literal).toBe(literal.length)
		}
		for (const bad of ["'open", "X'0'", "X'GG'", '1.', '--1', 'NUL', "CAST(X'00' AS BLOB)", '(SELECT 1)']) {
			expect(scanLiteral(bad, 0), bad).not.toBe(bad.length)
		}
	})

	it('accepts only exact template statements of catalog tables', () => {
		const insert = `${renderTemplate(insertTemplate(statuses), ["'1'", "'a;\nb'", 'NULL'])}\n`
		const link = `${renderTemplate(linkTemplate(statuses), ["'1'", "'1'"])}\n`
		expect(link).toBe(`UPDATE "statuses" SET "reblog_of_id"='1' WHERE "id"='1';\n`)
		expect(parseStatements(insert + link, [statuses]).map((s) => s.kind)).toEqual(['insert', 'link'])

		const refused = [
			`INSERT INTO "accounts" ("id") VALUES ('1');\n`,
			`INSERT INTO "statuses" ("id","content") VALUES ('1','a');\n`,
			`INSERT INTO "statuses" ("id","content","reblog_of_id") VALUES ('1','a',NULL);DROP TABLE statuses;\n`,
			`INSERT INTO "statuses" ("id","content","reblog_of_id") VALUES ('1',(SELECT 1),NULL);\n`,
			`INSERT INTO "statuses" ("id","content","reblog_of_id") VALUES ('1','a',NULL); -- c\n`,
			`DELETE FROM "statuses";\n`,
			`UPDATE "statuses" SET "content"='x' WHERE "id"='1';\n`,
			`INSERT INTO "statuses" ("id","content","reblog_of_id") VALUES ('1','a',NULL);`,
		]
		for (const text of refused) {
			expect(() => parseStatements(text, [statuses]), text).toThrow()
		}
	})

	it('counts UTF-8 bytes', () => {
		for (const text of ['abc', 'é', '✓', '🦬', 'a🦬b\u0000']) {
			expect(utf8Length(text)).toBe(new TextEncoder().encode(text).byteLength)
		}
	})
})

describe('read-only SQL check', () => {
	it('accepts single SELECT and WITH statements', () => {
		for (const sql of [
			'SELECT 1',
			'select count(*) from statuses;',
			"SELECT ';' AS semi, 'DELETE FROM x' AS text",
			'SELECT "delete" FROM t',
			"SELECT replace(content, 'a', 'b') FROM statuses",
			'WITH x AS (SELECT 1 AS n) SELECT n FROM x',
			"SELECT * FROM pragma_table_info('statuses')",
			'SELECT 1 /* DELETE */ -- UPDATE\n',
		]) {
			expect(readOnlyProblem(sql), sql).toBeNull()
		}
	})

	it('refuses writes, multiple statements and other statement kinds', () => {
		for (const sql of [
			'',
			'DELETE FROM statuses',
			'WITH x AS (SELECT 1) DELETE FROM statuses',
			'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
			'WITH x AS (SELECT 1) REPLACE INTO t VALUES (1)',
			'SELECT 1; DELETE FROM statuses',
			'SELECT 1;;',
			'SELECT 1; -- trailing\nDROP TABLE statuses',
			'/* SELECT */ DELETE FROM statuses',
			'-- SELECT\nUPDATE statuses SET content = 1',
			'PRAGMA foreign_keys = OFF',
			"ATTACH DATABASE 'x' AS y",
			'VACUUM',
			'SELECT 1 /* unterminated',
			"SELECT 'unterminated",
			'SELECT * FROM t WHERE x IN (SELECT 1) UNION SELECT load_extension(1)',
			'select 1 where 1 = (insert into t values (1))',
		]) {
			expect(readOnlyProblem(sql), sql).not.toBeNull()
		}
	})
})
