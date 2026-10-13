// A local SQLite database with the Kopje Store schema, its dump catalog, and a dump writer, for the cutover. The
// catalog and the literals follow src/platform/dump-catalog.ts and dump-literals.ts (docs/dump-format.md); a Store
// refuses a dump whose header differs from its own catalog, so any drift fails at `import` begin.

import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { END_LINE, HEADER_PREFIX, TRAILER_PREFIX } from '../format.js'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url))

/** @returns {{ name: string, sql: string }[]} */
export function kopjeMigrations() {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((f) => ({ name: f.slice(0, -'.sql'.length), sql: readFileSync(`${MIGRATIONS_DIR}${f}`, 'utf8') }))
}

/** @param {string | Uint8Array} data */
export function sha256Hex(data) {
	return createHash('sha256').update(data).digest('hex')
}

/** @returns {{ name: string, checksum: string }[]} */
export function migrationRecords() {
	return kopjeMigrations().map((m) => ({ name: m.name, checksum: sha256Hex(m.sql) }))
}

/**
 * An empty database with the Store's schema and bookkeeping tables (as the Store kernel creates them).
 * @param {string} [path]
 */
export function createKopjeDatabase(path = ':memory:') {
	const db = new DatabaseSync(path)
	db.exec(
		'CREATE TABLE IF NOT EXISTS kopje_migrations (name TEXT NOT NULL PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) WITHOUT ROWID;' +
			'CREATE TABLE IF NOT EXISTS kopje_state (name TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID'
	)
	for (const migration of kopjeMigrations()) {
		db.exec('BEGIN')
		db.exec(migration.sql)
		db.exec('COMMIT')
	}
	return db
}

/**
 * @typedef {{ name: string, columns: string[], order: { by: 'rowid' } | { by: 'key', columns: string[] },
 *   key: string[], deferred: string[], only?: { column: string, values: string[] } }} TableSpec
 */

const DUMPED_STATE = ['last_local_id']

/** @param {string} name */
function excluded(name) {
	return (
		name === 'kopje_migrations' ||
		name === 'media_orphans' ||
		name === 'backup_media' ||
		name.startsWith('_cf_') ||
		(name.startsWith('sqlite_') && name !== 'sqlite_sequence')
	)
}

/** @param {string} name */
export function quoteIdentifier(name) {
	return `"${name.replaceAll('"', '""')}"`
}

/**
 * The dump catalog of a database, as the Store's readCatalog computes it.
 * @param {DatabaseSync} db
 * @returns {TableSpec[]}
 */
export function readCatalog(db) {
	const tables = /** @type {{ name: string, sql: string | null }[]} */ (
		db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name COLLATE BINARY").all()
	).filter((t) => !excluded(t.name))
	/** @type {Map<string, TableSpec>} */
	const specs = new Map()
	/** @type {Map<string, { parent: string, columns: string[] }[]>} */
	const foreignKeys = new Map()
	for (const table of tables) {
		const info = /** @type {{ name: string, pk: number, hidden: number }[]} */ (
			db.prepare('SELECT name, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table.name)
		).filter((c) => c.hidden === 0)
		const key = info
			.filter((c) => c.pk > 0)
			.sort((a, b) => a.pk - b.pk)
			.map((c) => c.name)
		const withoutRowid = /\)\s*WITHOUT\s+ROWID\s*$/i.test(table.sql ?? '')
		const sequence = table.name === 'sqlite_sequence'
		/** @type {TableSpec} */
		const spec = {
			name: table.name,
			columns: info.map((c) => c.name),
			order: sequence ? { by: 'key', columns: ['name'] } : withoutRowid ? { by: 'key', columns: key } : { by: 'rowid' },
			key: sequence ? ['name'] : key,
			deferred: [],
		}
		if (table.name === 'kopje_state') {
			spec.only = { column: 'name', values: [...DUMPED_STATE] }
		}
		specs.set(table.name, spec)
		/** @type {Map<number, { parent: string, columns: string[] }>} */
		const byId = new Map()
		for (const fk of /** @type {{ id: number, table: string, from: string }[]} */ (
			db.prepare('SELECT id, "table", "from" FROM pragma_foreign_key_list(?) ORDER BY id, seq').all(table.name)
		)) {
			const entry = byId.get(fk.id) ?? { parent: fk.table, columns: [] }
			entry.columns.push(fk.from)
			byId.set(fk.id, entry)
		}
		foreignKeys.set(table.name, [...byId.values()])
	}
	/** @type {TableSpec[]} */
	const ordered = []
	/** @type {Set<string>} */
	const placed = new Set()
	const remaining = [...specs.keys()].filter((name) => name !== 'sqlite_sequence')
	while (remaining.length > 0) {
		const ready = remaining.findIndex((name) =>
			(foreignKeys.get(name) ?? []).every((fk) => fk.parent === name || placed.has(fk.parent) || !specs.has(fk.parent))
		)
		const name = remaining.splice(ready === -1 ? 0 : ready, 1)[0] ?? ''
		const spec = specs.get(name)
		if (spec === undefined) {
			continue
		}
		/** @type {Set<string>} */
		const deferred = new Set()
		for (const fk of foreignKeys.get(name) ?? []) {
			if (fk.parent === name || (specs.has(fk.parent) && !placed.has(fk.parent))) {
				fk.columns.forEach((column) => deferred.add(column))
			}
		}
		spec.deferred = spec.columns.filter((column) => deferred.has(column))
		placed.add(name)
		ordered.push(spec)
	}
	const sequence = specs.get('sqlite_sequence')
	if (sequence !== undefined) {
		ordered.push(sequence)
	}
	return ordered
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** @param {Uint8Array} bytes */
function hex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')
}

/** @param {number} value */
function realLiteral(value) {
	if (value === Infinity) {
		return '9e999'
	}
	if (value === -Infinity) {
		return '-9e999'
	}
	if (Object.is(value, -0)) {
		return '-0.0'
	}
	const text = String(value)
	return /[.e]/.test(text) ? text : `${text}.0`
}

/**
 * The canonical literal of a value read as (typeof, exact value).
 * @param {unknown} type
 * @param {unknown} value
 */
function valueLiteral(type, value) {
	switch (type) {
		case 'null':
			return 'NULL'
		case 'integer':
			return String(value)
		case 'real':
			return realLiteral(Number(value))
		case 'text': {
			const bytes = value instanceof Uint8Array ? value : new Uint8Array()
			let text = null
			try {
				text = utf8.decode(bytes)
			} catch {
				text = null
			}
			return text === null || text.includes('\0') ? `CAST(X'${hex(bytes)}' AS TEXT)` : `'${text.replaceAll("'", "''")}'`
		}
		case 'blob':
			return `X'${hex(value instanceof Uint8Array ? value : new Uint8Array())}'`
		default:
			throw new Error(`unexpected storage class ${String(type)}`)
	}
}

/** @param {string} column */
function readColumn(column) {
	const q = quoteIdentifier(column)
	return `typeof(${q}), CASE typeof(${q}) WHEN 'integer' THEN CAST(${q} AS TEXT) WHEN 'text' THEN CAST(${q} AS BLOB) ELSE ${q} END`
}

/**
 * Rows of a table in its dump order, as canonical literals of the selected columns.
 * @param {DatabaseSync} db
 * @param {TableSpec} spec
 * @param {string[]} selected
 * @param {string} [filter]
 * @returns {Generator<string[]>}
 */
function* scan(db, spec, selected, filter) {
	const where = []
	if (spec.only !== undefined) {
		where.push(`${quoteIdentifier(spec.only.column)} IN (${spec.only.values.map((v) => `'${v}'`).join(',')})`)
	}
	if (filter !== undefined) {
		where.push(filter)
	}
	const order = spec.order.by === 'rowid' ? 'rowid' : spec.order.columns.map(quoteIdentifier).join(',')
	const statement = db.prepare(
		`SELECT ${selected.map(readColumn).join(', ')} FROM ${quoteIdentifier(spec.name)}` +
			(where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
			` ORDER BY ${order}`
	)
	statement.setReturnArrays(true)
	for (const row of statement.iterate()) {
		const values = /** @type {unknown[]} */ (/** @type {unknown} */ (row))
		/** @type {string[]} */
		const literals = []
		for (let i = 0; i < values.length; i += 2) {
			literals.push(valueLiteral(values[i], values[i + 1]))
		}
		yield literals
	}
}

/**
 * Writes the database as a Kopje dump to `path` and returns the trailer.
 * @param {DatabaseSync} db
 * @param {{ path: string, catalog: TableSpec[], migrations: { name: string, checksum: string }[], createdAt: string,
 *   source: { build: string, version: string } }} options
 */
export function writeDump(db, { path, catalog, migrations, createdAt, source }) {
	// Created exclusively: an existing file or link at the path is never followed or reused.
	const fd = openSync(path, 'wx', 0o600)
	try {
		const header = { format: 1, createdAt, source, migrations, tables: catalog }
		writeSync(fd, `${HEADER_PREFIX}${JSON.stringify(header)}\n`)
		const body = createHash('sha256')
		let statements = 0
		let bytes = 0
		/** @type {string[]} */
		let pending = []
		let pendingBytes = 0
		/** @param {string} line */
		const emit = (line) => {
			const buffer = encoder.encode(line)
			body.update(buffer)
			bytes += buffer.length
			statements++
			pending.push(line)
			pendingBytes += buffer.length
			if (pendingBytes > 1 << 20) {
				writeSync(fd, pending.join(''))
				pending = []
				pendingBytes = 0
			}
		}
		/** @type {{ name: string, rows: number, checksum: string }[]} */
		const tables = []
		for (const spec of catalog) {
			const prefix = `INSERT INTO ${quoteIdentifier(spec.name)} (${spec.columns.map(quoteIdentifier).join(',')}) VALUES (`
			const deferred = spec.columns.map((c) => spec.deferred.includes(c))
			const checksum = createHash('sha256')
			let rows = 0
			for (const literals of scan(db, spec, spec.columns)) {
				checksum.update(`${literals.join(',')}\n`)
				emit(`${prefix}${literals.map((l, i) => (deferred[i] ? 'NULL' : l)).join(',')});\n`)
				rows++
			}
			tables.push({ name: spec.name, rows, checksum: checksum.digest('hex') })
		}
		for (const spec of catalog) {
			if (spec.deferred.length === 0) {
				continue
			}
			const filter = `(${spec.deferred.map((c) => `${quoteIdentifier(c)} IS NOT NULL`).join(' OR ')})`
			for (const literals of scan(db, spec, [...spec.deferred, ...spec.key], filter)) {
				const set = spec.deferred.map((c, i) => `${quoteIdentifier(c)}=${literals[i]}`).join(',')
				const where = spec.key
					.map((c, i) => `${quoteIdentifier(c)}=${literals[spec.deferred.length + i]}`)
					.join(' AND ')
				emit(`UPDATE ${quoteIdentifier(spec.name)} SET ${set} WHERE ${where};\n`)
			}
		}
		writeSync(fd, pending.join(''))
		const trailer = { tables, body: { statements, bytes, sha256: body.digest('hex') } }
		writeSync(fd, `${TRAILER_PREFIX}${JSON.stringify(trailer)}\n${END_LINE}\n`)
		fsyncSync(fd)
		return trailer
	} finally {
		closeSync(fd)
	}
}

/**
 * Executes a dump's statements against a database with the Kopje schema (a dump is a valid SQLite script for one).
 * Used to inspect a converted dump locally and, in tests, to change one and dump it again.
 * @param {DatabaseSync} db
 * @param {string} text
 */
export function loadDump(db, text) {
	const start = text.indexOf('\n') + 1
	const end = text.lastIndexOf(`\n${TRAILER_PREFIX}`) + 1
	const body = text.slice(start, end)
	// sqlite_sequence rows replace the counter of their name, as the Store's importer does.
	const sequence = /^INSERT INTO "sqlite_sequence" \("name","seq"\) VALUES \('([^']+)',(\d+)\);\n/gm
	const counters = [...body.matchAll(sequence)]
	db.exec('BEGIN')
	try {
		db.exec(body.replace(sequence, ''))
		for (const [, name, seq] of counters) {
			db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name ?? '')
			db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name ?? '', BigInt(seq ?? '0'))
		}
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}
