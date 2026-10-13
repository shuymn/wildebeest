// `kopje-admin fingerprint`: proves that the legacy D1 stopped changing (cutover step 5, docs/cutover-runbook.md).
//
// The operator runs read-only SQL with `wrangler d1 execute --remote --json --command`; this module only writes that
// SQL and compares what it returned. It never connects to anything (DATA-11). The answer of the fingerprint query is
// aggregate-only by construction: per table, the row count, the total length of the quoted values and a 31-bit hash
// (DATA-13, DATA-16). D1 has no hash function, so the hash is pure SQL:
//
//   cell  = quote(value): the value's SQL literal, so types, NULL and blobs stay distinct
//   v     = (length, polynomial hashes of the first 16 characters, the middle 16 and the last 16, and a weighted
//            count of 20 frequent characters over the whole cell), combined mod P
//   table = sum over cells of v * w(table, column) mod P, w a constant derived from the table and column names
//
// The three windows cover values of up to 48 characters completely (counters, flags, timestamps, ids); the counts and
// the length cover the rest of longer ones. Every intermediate value stays below 2^63, so SQLite never switches to
// floating point. The sum is over cells, so it does not depend on row order or rowids (a VACUUM does not change it).
// Not seen: a value moved between two rows of one column, and a same-length change outside the windows of a long value
// that keeps the counted characters' counts (characters reordered, or one rarely counted letter swapped for another).
// That is enough to tell that writes stopped, which is all step 5 asks: any insert or delete, and any update of a
// short value or of a value's length or counted characters, changes the result. Content integrity is checked row by
// row afterwards, by verify-conversion (DATA-12).

import { createHash } from 'node:crypto'

export const FINGERPRINT_VERSION = 1

// 2^31 - 1, prime.
const P = 2147483647n
const BASE = 1000003n
const HEAD = 16
const PAD = '~'.repeat(HEAD)
const COUNTED = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '"', ':', ',', 'a', 'e', 'i', 'n', 'o', 's', 't']
// Keeps a single statement well under D1's 100 KB statement limit.
export const MAX_SQL_BYTES = 90 * 1024

// Lists the tables and their columns. Run it once, with `--json`, and give the result to `fingerprint sql`. Internal
// tables (sqlite_*, D1's _cf_*), virtual tables (the full-text index) and their shadow tables are left out, as the
// export leaves them out.
export const SCHEMA_SQL = [
	'SELECT m.name AS t, p.cid AS i, p.name AS c',
	'FROM sqlite_schema AS m JOIN pragma_table_info(m.name) AS p',
	"WHERE m.type = 'table'",
	"AND substr(m.name, 1, 7) <> 'sqlite_' AND substr(m.name, 1, 4) <> '_cf_'",
	"AND m.sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
	"AND NOT EXISTS (SELECT 1 FROM sqlite_schema AS v WHERE v.type = 'table' AND v.sql LIKE 'CREATE VIRTUAL TABLE%'",
	"AND substr(m.name, 1, length(v.name) + 1) = v.name || '_')",
	'ORDER BY m.name, p.cid',
].join(' ')

export class FingerprintError extends Error {
	/** @param {string} code */
	constructor(code) {
		super(code)
		this.code = code
	}
}

/**
 * The rows of a `wrangler d1 execute --json` answer: `[{ results: [...] }, ...]` (one entry per statement), or a plain
 * array of rows.
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
export function resultRows(value) {
	if (!Array.isArray(value)) {
		throw new FingerprintError('not-a-result')
	}
	const list = /** @type {unknown[]} */ (value)
	if (list.every((entry) => typeof entry === 'object' && entry !== null && 'results' in entry)) {
		if (list.length !== 1) {
			throw new FingerprintError('expected-one-statement')
		}
		/** @type {unknown} */
		const results = /** @type {{ results: unknown }} */ (list[0]).results
		if (!Array.isArray(results)) {
			throw new FingerprintError('not-a-result')
		}
		return results.map((/** @type {unknown} */ row) => /** @type {Record<string, unknown>} */ (row))
	}
	return /** @type {Record<string, unknown>[]} */ (list)
}

/**
 * @param {unknown} value the answer of SCHEMA_SQL
 * @returns {Map<string, string[]>} table -> columns in order
 */
export function schemaOf(value) {
	/** @type {Map<string, { i: number, c: string }[]>} */
	const tables = new Map()
	for (const row of resultRows(value)) {
		const { t, i, c } = /** @type {Record<string, unknown>} */ (row)
		if (typeof t !== 'string' || typeof c !== 'string' || typeof i !== 'number' || !Number.isInteger(i) || t === '') {
			throw new FingerprintError('invalid-schema-row')
		}
		const columns = tables.get(t) ?? []
		columns.push({ i, c })
		tables.set(t, columns)
	}
	if (tables.size === 0) {
		throw new FingerprintError('empty-schema')
	}
	return new Map(
		[...tables]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([t, columns]) => [t, columns.sort((a, b) => a.i - b.i).map((column) => column.c)])
	)
}

/** @param {string} name */
function identifier(name) {
	return `"${name.replaceAll('"', '""')}"`
}

/** @param {string} text */
function literal(text) {
	return `'${text.replaceAll("'", "''")}'`
}

/** @param {string} text a number below P derived from a text */
function weight(text) {
	const digest = createHash('sha256').update(text).digest()
	return (digest.readBigUInt64BE(0) % (P - 1n)) + 1n
}

/** @param {Map<string, string[]>} schema */
export function schemaDigest(schema) {
	const hash = createHash('sha256')
	for (const [table, columns] of schema) {
		hash.update(`${JSON.stringify([table, columns])}\n`)
	}
	return hash.digest('hex')
}

// Σ unicode(substr(<column>, i, 1)) * BASE^i mod P, over the HEAD characters of a padded value.
/** @param {string} column */
function polynomial(column) {
	const terms = []
	let power = 1n
	for (let i = 1; i <= HEAD; i++) {
		power = (power * BASE) % P
		terms.push(`unicode(substr(${column}, ${i}, 1)) * ${power}`)
	}
	return `(${terms.join(' + ')}) % ${P}`
}

function counts() {
	return COUNTED.map(
		(ch, index) => `(n - length(replace(q, ${literal(ch)}, ''))) * ${(weight(`count:${index}`) % 61n) + 2n}`
	).join(' + ')
}

/**
 * The fingerprint query for a schema: one read-only SELECT whose answer is, per table, `rows`, `bytes` (the total
 * length of the quoted values) and `hash`, plus a first row `#schema` whose hash ties the answer to this schema.
 * @param {Map<string, string[]>} schema
 */
export function fingerprintSql(schema) {
	const cells = []
	const rows = []
	for (const [table, columns] of schema) {
		const name = literal(table)
		for (const column of columns) {
			const w = weight(`column:${JSON.stringify([table, column])}`)
			cells.push(`SELECT ${name} AS t, ${w} AS w, quote(${identifier(column)}) AS q FROM ${identifier(table)}`)
		}
		rows.push(`SELECT ${name} AS t, count(*) AS n FROM ${identifier(table)}`)
	}
	const [c1, c2, c3, c4, c5] = ['length', 'head', 'tail', 'counts', 'middle'].map((part) => weight(`part:${part}`))
	const pinned = BigInt(`0x${schemaDigest(schema).slice(0, 12)}`)
	const sql = [
		`WITH cells AS (${cells.join(' UNION ALL ')}),`,
		`f AS (SELECT t, w, n, substr(q || '${PAD}', 1, ${HEAD}) AS h, substr('${PAD}' || q, -${HEAD}) AS e,`,
		`substr(q || '${PAD}', max(1, (n - ${HEAD}) / 2 + 1), ${HEAD}) AS m, ${counts()} AS k`,
		`FROM (SELECT t, w, q, length(q) AS n FROM cells)),`,
		`g AS (SELECT t, sum(n) AS bytes, sum((((n % ${P}) * ${c1} % ${P} + (${polynomial('h')}) * ${c2} % ${P}`,
		`+ (${polynomial('e')}) * ${c3} % ${P} + (${polynomial('m')}) * ${c5} % ${P} + (k % ${P}) * ${c4} % ${P}) % ${P})`,
		`* w % ${P}) AS s FROM f GROUP BY t),`,
		`r AS (${rows.join(' UNION ALL ')})`,
		`SELECT '#schema' AS "table", ${schema.size} AS "rows", ${FINGERPRINT_VERSION} AS bytes, ${pinned} AS hash`,
		`UNION ALL SELECT * FROM (SELECT r.t, r.n, coalesce(g.bytes, 0), coalesce(g.s % ${P}, 0)`,
		'FROM r LEFT JOIN g ON g.t = r.t ORDER BY r.t)',
	].join(' ')
	if (new TextEncoder().encode(sql).byteLength > MAX_SQL_BYTES) {
		throw new FingerprintError('sql-too-long')
	}
	return sql
}

/**
 * @typedef {{ table: string, rows: number, bytes: number, hash: number }} TableFingerprint
 */

/**
 * @param {unknown} value the answer of the fingerprint query
 * @returns {TableFingerprint[]}
 */
export function fingerprintOf(value) {
	const tables = resultRows(value).map((row) => {
		const { table, rows, bytes, hash } = /** @type {Record<string, unknown>} */ (row)
		if (
			typeof table !== 'string' ||
			![rows, bytes, hash].every((n) => typeof n === 'number' && Number.isSafeInteger(n))
		) {
			throw new FingerprintError('invalid-fingerprint-row')
		}
		return { table, rows: Number(rows), bytes: Number(bytes), hash: Number(hash) }
	})
	if (!tables.some((t) => t.table === '#schema') || new Set(tables.map((t) => t.table)).size !== tables.length) {
		throw new FingerprintError('invalid-fingerprint')
	}
	return tables.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
}

/** @param {TableFingerprint[]} tables */
function digestOf(tables) {
	return createHash('sha256').update(JSON.stringify(tables)).digest('hex')
}

/**
 * Compares two fingerprints of the same database. PASS only when every table has the same count, length and hash.
 * With `rowsLoaded` (from the converter's manifest, `source.rowsLoaded`), also checks that the export holds exactly the
 * rows the database had when it was fingerprinted.
 * @param {TableFingerprint[]} first
 * @param {TableFingerprint[]} second
 * @param {Record<string, number>} [rowsLoaded]
 */
export function compareFingerprints(first, second, rowsLoaded) {
	const before = new Map(first.map((t) => [t.table, t]))
	const after = new Map(second.map((t) => [t.table, t]))
	/** @type {string[]} */
	const changed = []
	for (const name of new Set([...before.keys(), ...after.keys()])) {
		const a = before.get(name)
		const b = after.get(name)
		if (a === undefined || b === undefined || a.rows !== b.rows || a.bytes !== b.bytes || a.hash !== b.hash) {
			changed.push(name)
		}
	}
	/** @type {string[]} */
	const exportDiffers = []
	if (rowsLoaded !== undefined) {
		for (const [name, count] of Object.entries(rowsLoaded)) {
			const live = after.get(name)
			if (live === undefined || live.rows !== count) {
				exportDiffers.push(name)
			}
		}
	}
	const tables = second.filter((t) => t.table !== '#schema')
	return {
		result: changed.length === 0 && exportDiffers.length === 0 ? 'PASS' : 'FAIL',
		tables: tables.length,
		rows: tables.reduce((sum, t) => sum + t.rows, 0),
		changed: changed.sort(),
		...(rowsLoaded === undefined ? {} : { exportDiffers: exportDiffers.sort() }),
		firstSha256: digestOf(first),
		secondSha256: digestOf(second),
	}
}
