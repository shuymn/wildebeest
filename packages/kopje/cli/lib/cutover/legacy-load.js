// Loads a legacy Wildebeest D1 export into a local SQLite database and bridges it to the last legacy migration
// (0039), without ever touching the legacy D1:
//
//   1. the level is the d1_migrations prefix of the canonical legacy migrations (cli/legacy-migrations, a frozen copy
//      of the repository's /migrations), and the export's schema must match the canonical schema at that level;
//   2. the rows are loaded into a database built from the canonical migrations up to that level;
//   3. the remaining canonical migrations are applied locally. Any migration that removes rows (0007, 0017, 0021,
//      0034 and 0038 can) is reported with its counts, and the bridge stops unless deletions are accepted.
//
// SQLite's randomblob() and random() are replaced by a fixed deterministic stream, so the bridge gives the same result
// on every run (0010, 0019 and 0020 generate values with them).

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { classify, quoteIdentifier, splitStatements } from './sql-script.js'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../legacy-migrations/', import.meta.url))

/** @typedef {{ name: string, sql: string }} LegacyMigration */

/** @returns {LegacyMigration[]} */
export function legacyMigrations() {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((f) => ({ name: f.slice(0, -'.sql'.length), sql: readFileSync(`${MIGRATIONS_DIR}${f}`, 'utf8') }))
}

export const LAST_LEGACY_LEVEL = 39

// Levels a live legacy instance can be at (the supported range of the cutover). T1 is the line in this repository (0.1.0), T2 the
// cloudflare/wildebeest line (0.0.1, at most 0010). Below 0011 both lines have the same schema, so they are reported
// together.
/** @param {number} level */
export function supportedLevel(level) {
	return level <= 10 || level === 18 || level === 23 || level === 35 || level === 39
}

/** @param {number} level */
export function lineOf(level) {
	return level <= 10 ? 'T1 or T2' : 'T1'
}

// The legacy instance's full-text index is not exported and not needed.
/** @param {string} name */
function isSearchTable(name) {
	return name === 'search_fts' || name.startsWith('search_fts_')
}

/** @param {string} name */
function isBookkeeping(name) {
	return name === 'd1_migrations' || name.startsWith('sqlite_') || name.startsWith('_cf_')
}

export class LegacyLoadError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {Record<string, unknown>} [detail]
	 */
	constructor(code, message, detail = {}) {
		super(message)
		this.code = code
		this.detail = detail
	}
}

// A fixed pseudo-random stream (SHA-256 in counter mode) for randomblob() and random().
/** @param {DatabaseSync} db */
function deterministicRandom(db) {
	let counter = 0
	/** @param {number} length */
	const bytes = (length) => {
		const out = new Uint8Array(length)
		let filled = 0
		while (filled < length) {
			const block = createHash('sha256').update(`kopje-cutover-bridge:${counter++}`).digest()
			out.set(block.subarray(0, Math.min(block.length, length - filled)), filled)
			filled += block.length
		}
		return out
	}
	db.function('randomblob', { deterministic: false }, (n) => bytes(Math.max(1, Number(n))))
	db.function('random', { deterministic: false }, () => new DataView(bytes(8).buffer).getBigInt64(0))
}

/**
 * @param {DatabaseSync} db
 * @returns {Map<string, string>} table -> column fingerprint
 */
function schemaFingerprint(db) {
	/** @type {Map<string, string>} */
	const tables = new Map()
	const rows = /** @type {{ name: string, sql: string | null }[]} */ (
		db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
	)
	for (const { name, sql } of rows) {
		if (isSearchTable(name) || isBookkeeping(name) || /^CREATE\s+VIRTUAL/i.test(sql ?? '')) {
			continue
		}
		const columns = db
			.prepare('SELECT name, lower(type) AS type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)')
			.all(name)
		tables.set(name, JSON.stringify(columns))
	}
	return tables
}

/** @param {Map<string, string>} tables */
function fingerprintDigest(tables) {
	const hash = createHash('sha256')
	for (const [name, columns] of [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		hash.update(`${name}\n${columns}\n`)
	}
	return hash.digest('hex')
}

/**
 * @param {DatabaseSync} db
 * @param {LegacyMigration[]} migrations
 */
function applyMigrations(db, migrations) {
	for (const migration of migrations) {
		db.exec(migration.sql)
	}
}

/** @param {DatabaseSync} db */
function rowCounts(db) {
	/** @type {Map<string, number>} */
	const counts = new Map()
	for (const name of schemaFingerprint(db).keys()) {
		const row = /** @type {{ n: number }} */ (db.prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(name)}`).get())
		counts.set(name, Number(row.n))
	}
	return counts
}

/**
 * @typedef {{ level: number, line: string, levelName: string, migrationsApplied: string[],
 *   schemaFingerprint: string, rowsLoaded: Record<string, number>,
 *   deletions: { migration: string, table: string, rows: number }[], foreignKeyViolations: number,
 *   notificationSequence: number | null }} LegacyReport
 */

/**
 * Reads the export (files of `wrangler d1 export --table`, or one file of them concatenated) and returns the bridged
 * database. The database holds the legacy data in plaintext: it lives in memory unless `path` names a file.
 * @param {{ texts: Iterable<string>, acceptDeletions?: boolean, path?: string }} options
 * @returns {{ db: DatabaseSync, report: LegacyReport, originalActorIds: Map<string, string> }}
 */
export function loadLegacyExport({ texts, acceptDeletions = false, path = ':memory:' }) {
	const migrations = legacyMigrations()

	// The export's own schema (its CREATE TABLE statements) and its rows, grouped by table.
	const exported = new DatabaseSync(':memory:')
	/** @type {Map<string, string[]>} */
	const inserts = new Map()
	/** @type {Set<string>} */
	const created = new Set()
	for (const text of texts) {
		for (const statement of splitStatements(text)) {
			const parsed = classify(statement)
			switch (parsed.kind) {
				case 'pragma':
				case 'create-other':
					break
				case 'create-table':
					if (isSearchTable(parsed.table) || parsed.table.startsWith('sqlite_')) {
						break
					}
					if (created.has(parsed.table)) {
						throw new LegacyLoadError('duplicate-table', `the export defines table ${parsed.table} twice`)
					}
					created.add(parsed.table)
					exported.exec(parsed.sql)
					break
				case 'insert': {
					if (isSearchTable(parsed.table)) {
						break
					}
					const list = inserts.get(parsed.table) ?? []
					list.push(statement)
					inserts.set(parsed.table, list)
					break
				}
				default:
					throw new LegacyLoadError(
						'unexpected-statement',
						'the export contains a statement that is not a table definition or a row'
					)
			}
		}
	}
	for (const table of inserts.keys()) {
		if (!created.has(table) && table !== 'sqlite_sequence') {
			throw new LegacyLoadError('rows-without-table', `the export has rows for ${table} but no definition of it`)
		}
	}

	// Level: the applied names must be exactly the first canonical migrations.
	if (!created.has('d1_migrations')) {
		throw new LegacyLoadError('no-d1-migrations', 'the export has no d1_migrations table')
	}
	for (const statement of inserts.get('d1_migrations') ?? []) {
		exported.prepare(statement).run()
	}
	const applied = /** @type {{ name: string }[]} */ (
		exported.prepare('SELECT name FROM d1_migrations ORDER BY id').all()
	).map((r) => String(r.name).replace(/\.sql$/, ''))
	if (applied.length === 0) {
		throw new LegacyLoadError('no-migrations-applied', 'd1_migrations is empty')
	}
	const prefixMatches = applied.every((name, i) => migrations[i]?.name === name)
	if (!prefixMatches) {
		throw new LegacyLoadError(
			'unknown-migrations',
			'd1_migrations is not a prefix of the canonical legacy migrations (a fork with its own migrations, or an alpha D1)',
			{ applied: applied.length }
		)
	}
	const level = applied.length - 1
	if (!supportedLevel(level)) {
		throw new LegacyLoadError(
			'unsupported-level',
			`migration level ${String(level).padStart(4, '0')} is not supported`,
			{
				level,
			}
		)
	}

	// Schema fingerprint: the export's tables must be exactly the canonical tables at that level, column by column.
	const db = new DatabaseSync(path, { enableForeignKeyConstraints: false })
	deterministicRandom(db)
	applyMigrations(db, migrations.slice(0, level + 1))
	const canonical = schemaFingerprint(db)
	const actual = schemaFingerprint(exported)
	const missing = [...canonical.keys()].filter((t) => !actual.has(t))
	const extra = [...actual.keys()].filter((t) => !canonical.has(t))
	const differing = [...canonical.keys()].filter((t) => actual.has(t) && actual.get(t) !== canonical.get(t))
	if (missing.length + extra.length + differing.length > 0) {
		throw new LegacyLoadError('schema-mismatch', 'the export schema does not match the canonical schema at its level', {
			missing,
			extra,
			differing,
		})
	}

	// Only the schema: rows that migrations up to the level wrote (0010's client, 0011's preferences) come from the export.
	for (const table of canonical.keys()) {
		db.exec(`DELETE FROM ${quoteIdentifier(table)}`)
	}
	db.exec('DELETE FROM sqlite_sequence')

	// Rows: each INSERT goes into a staging table with the export's columns, then into the real table without its
	// generated columns (an export may or may not list them).
	/** @type {Record<string, number>} */
	const rowsLoaded = {}
	db.exec('BEGIN')
	try {
		for (const table of canonical.keys()) {
			const columns = /** @type {{ name: string, hidden: number }[]} */ (
				exported.prepare('SELECT name, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table)
			)
			const stage = quoteIdentifier(`kopje_stage_${table}`)
			const plain = columns.filter((c) => c.hidden === 0).map((c) => quoteIdentifier(c.name))
			db.exec(`CREATE TEMP TABLE ${stage} (${columns.map((c) => quoteIdentifier(c.name)).join(', ')})`)
			for (const statement of inserts.get(table) ?? []) {
				const parsed = classify(statement)
				if (parsed.kind !== 'insert') {
					continue
				}
				const target = parsed.hasColumns ? `${stage} ` : `${stage} (${plain.join(', ')}) `
				db.prepare(`INSERT INTO ${target}${parsed.rest}`).run()
			}
			db.exec(
				`INSERT INTO main.${quoteIdentifier(table)} (${plain.join(', ')}) SELECT ${plain.join(', ')} FROM ${stage} ORDER BY rowid`
			)
			const loaded = /** @type {{ n: number }} */ (db.prepare(`SELECT count(*) AS n FROM ${stage}`).get())
			rowsLoaded[table] = Number(loaded.n)
			db.exec(`DROP TABLE ${stage}`)
		}
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}

	// The API ids accounts had before the bridge: 0020 gives every account without one a random id that no client has
	// seen, which is not a legacy id.
	/** @type {Map<string, string>} */
	const originalActorIds = new Map()
	if (actual.get('actors')?.includes('"mastodon_id"')) {
		for (const row of /** @type {{ id: string, mastodon_id: string }[]} */ (
			db.prepare('SELECT id, mastodon_id FROM actors WHERE mastodon_id IS NOT NULL').all()
		)) {
			originalActorIds.set(row.id, row.mastodon_id)
		}
	}

	// The AUTOINCREMENT high-water mark of notifications, when the export includes sqlite_sequence.
	let notificationSequence = null
	for (const statement of inserts.get('sqlite_sequence') ?? []) {
		const match = /\('actor_notifications',\s*(\d+)\)/.exec(statement)
		if (match !== null) {
			notificationSequence = Number(match[1])
		}
	}

	// Bridge to 0039, one migration at a time, counting the rows each one removes.
	/** @type {{ migration: string, table: string, rows: number }[]} */
	const deletions = []
	const pending = migrations.slice(level + 1)
	for (const migration of pending) {
		const before = rowCounts(db)
		db.exec('BEGIN')
		try {
			db.exec(migration.sql)
			db.exec('COMMIT')
		} catch (error) {
			db.exec('ROLLBACK')
			throw new LegacyLoadError('bridge-failed', `canonical migration ${migration.name} failed: ${String(error)}`)
		}
		const after = rowCounts(db)
		for (const [table, rows] of before) {
			const remaining = after.get(table) ?? 0
			if (remaining < rows) {
				deletions.push({ migration: migration.name, table, rows: rows - remaining })
			}
		}
	}
	const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length

	/** @type {LegacyReport} */
	const report = {
		level,
		line: lineOf(level),
		levelName: migrations[level]?.name ?? '',
		migrationsApplied: pending.map((m) => m.name),
		schemaFingerprint: fingerprintDigest(actual),
		rowsLoaded,
		deletions,
		foreignKeyViolations,
		notificationSequence,
	}
	if (deletions.length > 0 && !acceptDeletions) {
		db.close()
		throw new LegacyLoadError(
			'deletions-not-accepted',
			'bridging removes rows; review the counts and pass --accept-deletions to continue',
			{ report }
		)
	}
	return { db, report, originalActorIds }
}

/**
 * The canonical legacy schema at a level, in a fresh database (fixtures and tests build exports from it).
 * @param {number} level
 * @param {string} [path]
 */
export function canonicalLegacyDatabase(level, path = ':memory:') {
	const db = new DatabaseSync(path, { enableForeignKeyConstraints: false })
	deterministicRandom(db)
	applyMigrations(db, legacyMigrations().slice(0, level + 1))
	return db
}
