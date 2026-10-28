// Loads a legacy Wildebeest D1 export into a local SQLite database and bridges it to the last legacy migration
// (0039), without ever touching the legacy D1:
//
//   1. the level is the d1_migrations prefix of the canonical legacy migrations (cli/legacy-migrations, a frozen copy
//      of legacy Wildebeest's 0000 to 0039), and the export's schema must match the canonical schema at that level
//      (columns by name; see compareColumns for the one variance accepted);
//   2. the rows are loaded, by column name, into a database built from the canonical migrations up to that level, so
//      the bridge always starts from the canonical schema whatever the column order of the export;
//   3. the remaining canonical migrations are applied locally. Any migration that removes rows (0007, 0017, 0021,
//      0034 and 0038 can) is reported with its counts, and the bridge stops unless deletions are accepted.
//
// SQLite's randomblob() and random() are replaced by a fixed deterministic stream, so the bridge gives the same result
// on every run (0010, 0019 and 0020 generate values with them).

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import {
	decodeBudget,
	digestOf,
	ExportError,
	exportOrder,
	isPlatformTable,
	parseStatement,
	quoteIdentifier,
	splitStatements,
	tableExpressions,
} from './sql-script.js'

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

// Levels a live legacy instance can be at (the supported range of the cutover). T1 is shuymn's Wildebeest fork
// (0.1.0), T2 the cloudflare/wildebeest line (0.0.1, at most 0010). Below 0011 both lines have the same schema, so they are reported
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
	return name === 'd1_migrations' || name.startsWith('sqlite_') || isPlatformTable(name)
}

// Loader failures carry a fixed code and counts or digests only (DATA-13).
export const LegacyLoadError = ExportError

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
 * @typedef {{ name: string, type: string, notnull: number, dflt_value: unknown, pk: number, hidden: number }} Column
 */

/**
 * @param {DatabaseSync} db
 * @param {string} table
 * @returns {Column[]}
 */
function columnsOfTable(db, table) {
	return /** @type {Column[]} */ (
		db
			.prepare('SELECT name, lower(type) AS type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)')
			.all(table)
	)
}

/**
 * Compares an exported table's columns with the canonical ones by name, not position: a legacy D1 can hold a column
 * that an earlier form of a migration dropped and that was added back with ALTER TABLE ADD COLUMN, so it sits later in
 * the table and is nullable (docs/cutover.md). Every name must match, with the same type, default, primary key
 * position and generated kind. NOT NULL may be missing from an exported column only; such a column is returned, and
 * every row loaded into it must still satisfy the canonical constraint.
 * @param {Column[]} canonical
 * @param {Column[]} exported
 * @returns {string[] | null} the columns that are nullable in the export only, or null when the columns differ
 */
function compareColumns(canonical, exported) {
	if (canonical.length !== exported.length) {
		return null
	}
	/** @type {string[]} */
	const nullable = []
	for (const want of canonical) {
		const matches = exported.filter((c) => c.name === want.name)
		const got = matches[0]
		if (
			matches.length !== 1 ||
			got === undefined ||
			got.type !== want.type ||
			got.dflt_value !== want.dflt_value ||
			got.pk !== want.pk ||
			got.hidden !== want.hidden
		) {
			return null
		}
		if (got.notnull !== want.notnull) {
			if (want.notnull !== 1 || got.notnull !== 0) {
				return null
			}
			nullable.push(want.name)
		}
	}
	return nullable
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
 * @typedef {{ to: unknown, cc: unknown, kind: 'object' | 'to-cc' | 'target' }} Addressing
 * @typedef {{ objects: Map<string, Addressing>, authors: Map<string, string | null>,
 *   followers: Map<string, { present: boolean, value: unknown } | null>,
 *   outbox: Map<string, Addressing | null>, outboxByPair: Map<string, Addressing | null> }} SourceAddressing
 * @typedef {{ level: number, line: string, levelName: string, migrationsApplied: string[],
 *   schemaFingerprint: string, rowsLoaded: Record<string, number>,
 *   nullableInExport: string[], deletions: { migration: string, table: string, rows: number }[],
 *   foreignKeyViolations: number, notificationSequence: string | null }} LegacyReport
 */

// 0010 inserts the legacy web UI's OAuth client, whose cdate defaults to the current time. Rows a bridge migration
// creates get the base time instead, so the same export converts to the same bytes at any time.
const BRIDGE_TIMESTAMPS = /** @type {Record<string, string[]>} */ ({
	'0010_add_ui_client': ["UPDATE clients SET cdate = ?1 WHERE id = '924801be-d211-495d-8cac-e73503413af8'"],
})

/** @param {number} ms */
function legacyTime(ms) {
	return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

/** @param {unknown} text */
function addressingOf(text) {
	try {
		const value = /** @type {unknown} */ (JSON.parse(String(text)))
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			const v = /** @type {Record<string, unknown>} */ (value)
			return { to: v.to, cc: v.cc, kind: /** @type {const} */ ('object') }
		}
	} catch {
		// an object that is not JSON has no addressing
	}
	return { to: undefined, cc: undefined, kind: /** @type {const} */ ('object') }
}

/**
 * A legacy UTC timestamp (`YYYY-MM-DD HH:MM:SS[.fff]`, as CURRENT_TIMESTAMP and STRFTIME('%Y-%m-%d %H:%M:%f') write it)
 * in milliseconds, or null for anything else.
 * @param {unknown} value
 */
function timeOf(value) {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?$/.test(value)) {
		return null
	}
	const ms = Date.parse(`${value.replace(' ', 'T').replace(/Z$/, '')}Z`)
	return Number.isNaN(ms) ? null : ms
}

/** @param {unknown} text */
function jsonOrInvalid(text) {
	try {
		return /** @type {unknown} */ (JSON.parse(String(text)))
	} catch {
		return Symbol.for('kopje.invalid')
	}
}

/**
 * Reads the export (files of `wrangler d1 export --table`, or one file of them concatenated) and returns the bridged
 * database. Each source is read twice, one at a time (schema first, then rows), so only one file is in memory at once.
 * The database holds the legacy data in plaintext: it lives in memory unless `path` names a file.
 * @param {{ texts: Iterable<string | (() => string)>, acceptDeletions?: boolean, baseTime?: number, path?: string }} options
 * @returns {{ db: DatabaseSync, report: LegacyReport, originalActorIds: Map<string, string>, source: SourceAddressing }}
 */
export function loadLegacyExport({ texts, acceptDeletions = false, baseTime = 0, path = ':memory:' }) {
	const sources = [...texts].map((t) => (typeof t === 'function' ? t : () => t))
	try {
		return load(sources, acceptDeletions, baseTime, path)
	} catch (error) {
		if (error instanceof ExportError) {
			throw error
		}
		// A parser or database error can quote export content; only its class goes on.
		throw new ExportError('load-failed', { error: error instanceof Error ? error.name : 'unknown' })
	}
}

/**
 * @param {(() => string)[]} sources
 * @param {boolean} acceptDeletions
 * @param {number} baseTime
 * @param {string} path
 */
function load(sources, acceptDeletions, baseTime, path) {
	const migrations = legacyMigrations()

	// Pass 1: the export's table definitions (collected, not run), its d1_migrations rows and its sequence counter.
	// Bookkeeping tables (d1_migrations, sqlite_*, D1's _cf_* and d1_kv) never get the export's DDL: their rows are read by name into
	// a fixed schema of the converter's own.
	/** @type {Map<string, string>} */
	const definitions = new Map()
	/** @type {Set<string>} */
	const withRows = new Set()
	/** @type {{ id: bigint | null, name: string, appliedAt: unknown }[]} */
	const migrationRows = []
	/** @type {string | null} */
	let notificationSequence = null
	let budget = decodeBudget()
	const order = exportOrder()
	for (const source of sources) {
		for (const statement of splitStatements(source())) {
			const parsed = parseStatement(statement, budget)
			order(parsed)
			if (parsed.kind === 'create-table') {
				if (isSearchTable(parsed.table) || isBookkeeping(parsed.table)) {
					continue
				}
				if (definitions.has(parsed.table)) {
					throw new ExportError('duplicate-table', { table: digestOf(parsed.table) })
				}
				definitions.set(parsed.table, parsed.sql)
			} else if (parsed.kind === 'insert') {
				if (isSearchTable(parsed.table) || isPlatformTable(parsed.table)) {
					continue
				}
				if (parsed.table === 'sqlite_sequence') {
					const columns = parsed.columns ?? ['name', 'seq']
					const nameAt = columns.indexOf('name')
					const seqAt = columns.indexOf('seq')
					for (const row of parsed.rows) {
						const seq = row[seqAt]
						if (row[nameAt] === 'actor_notifications') {
							if (typeof seq !== 'bigint' || seq < 0n) {
								throw new ExportError('invalid-sequence')
							}
							notificationSequence = seq.toString()
						}
					}
					continue
				}
				if (parsed.table === 'd1_migrations') {
					const columns = parsed.columns ?? ['id', 'name', 'applied_at']
					if (!columns.every((c) => ['id', 'name', 'applied_at'].includes(c)) || !columns.includes('name')) {
						throw new ExportError('invalid-migrations-table')
					}
					for (const row of parsed.rows) {
						const id = row[columns.indexOf('id')]
						const name = row[columns.indexOf('name')]
						if (typeof name !== 'string' || (id !== undefined && typeof id !== 'bigint')) {
							throw new ExportError('invalid-migrations-table')
						}
						const appliedAt = columns.includes('applied_at') ? row[columns.indexOf('applied_at')] : undefined
						migrationRows.push({ id: typeof id === 'bigint' ? id : null, name, appliedAt })
					}
					continue
				}
				withRows.add(parsed.table)
			}
		}
	}
	for (const table of withRows) {
		if (!definitions.has(table)) {
			throw new ExportError('rows-without-table', { table: digestOf(table) })
		}
	}

	// Level: the applied names must be exactly the first canonical migrations.
	const applied = migrationRows
		.map((row, i) => ({ order: row.id ?? BigInt(i), name: row.name.replace(/\.sql$/, '') }))
		.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
		.map((row) => row.name)
	if (applied.length === 0) {
		throw new ExportError('no-migrations-applied')
	}
	if (!applied.every((name, i) => migrations[i]?.name === name)) {
		throw new ExportError('unknown-migrations', { applied: applied.length })
	}
	const level = applied.length - 1
	if (!supportedLevel(level)) {
		throw new ExportError('unsupported-level', { level })
	}

	// Schema fingerprint. Before any supplied definition runs, its DEFAULT, CHECK and generated expressions must equal
	// the canonical ones at that level, column by column; then it runs in an empty scratch database (never given a row)
	// and its columns must equal the canonical columns by name (compareColumns).
	const db = new DatabaseSync(path, { enableForeignKeyConstraints: false })
	deterministicRandom(db)
	applyMigrations(db, migrations.slice(0, level + 1))
	const canonical = schemaFingerprint(db)
	const canonicalSql = new Map(
		/** @type {{ name: string, sql: string }[]} */ (
			db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all()
		).map((t) => [t.name, t.sql])
	)
	const exported = new DatabaseSync(':memory:')
	/** @type {string[]} */
	const differing = []
	for (const [table, sql] of definitions) {
		const reference = canonicalSql.get(table)
		if (reference === undefined || !canonical.has(table)) {
			continue
		}
		if (JSON.stringify(tableExpressions(sql)) !== JSON.stringify(tableExpressions(reference))) {
			differing.push(table)
			continue
		}
		try {
			exported.exec(sql)
		} catch {
			throw new ExportError('invalid-create-table', { table: digestOf(table) })
		}
	}
	const actual = schemaFingerprint(exported)
	const missing = [...canonical.keys()].filter((t) => !definitions.has(t))
	const extra = [...definitions.keys()].filter((t) => !canonical.has(t))
	/** @type {Map<string, Set<string>>} table -> columns NOT NULL in the canonical schema only */
	const nullable = new Map()
	for (const table of canonical.keys()) {
		if (!actual.has(table) || actual.get(table) === canonical.get(table)) {
			continue
		}
		const columns = compareColumns(columnsOfTable(db, table), columnsOfTable(exported, table))
		if (columns === null) {
			differing.push(table)
		} else if (columns.length > 0) {
			nullable.set(table, new Set(columns))
		}
	}
	if (missing.length + extra.length + differing.length > 0) {
		throw new ExportError('schema-mismatch', {
			missing: missing.map(digestOf),
			extra: extra.map(digestOf),
			differing: differing.map(digestOf),
		})
	}
	// Only the schema: rows that migrations up to the level wrote (0010's client, 0011's preferences) come from the export.
	for (const table of canonical.keys()) {
		db.exec(`DELETE FROM ${quoteIdentifier(table)}`)
	}
	db.exec('DELETE FROM sqlite_sequence')

	// Pass 2: the rows, decoded literal by literal and bound into their table. Generated columns are left out whether
	// the export lists them or not.
	/** @type {Record<string, number>} */
	const rowsLoaded = Object.fromEntries([...canonical.keys()].map((t) => [t, 0]))
	/** @type {Map<string, Column[]>} */
	const columnsOf = new Map()
	/** @type {Map<string, import('node:sqlite').StatementSync>} */
	const prepared = new Map()
	budget = decodeBudget()
	db.exec('BEGIN')
	try {
		for (const source of sources) {
			for (const statement of splitStatements(source())) {
				const parsed = parseStatement(statement, budget)
				if (parsed.kind !== 'insert' || !canonical.has(parsed.table)) {
					continue
				}
				let info = columnsOf.get(parsed.table)
				if (info === undefined) {
					info = columnsOfTable(exported, parsed.table)
					columnsOf.set(parsed.table, info)
				}
				const all = info
				// Without a column list, values come in the export's column order; they go in by name either way.
				const listed = parsed.columns ?? all.filter((c) => c.hidden === 0).map((c) => c.name)
				const keep = []
				for (const [i, name] of listed.entries()) {
					const column = all.find((c) => c.name === name)
					if (column === undefined) {
						throw new ExportError('unknown-column', { table: digestOf(parsed.table) })
					}
					if (column.hidden === 0) {
						keep.push(i)
					}
				}
				// A column nullable in the export only takes no NULL, nor a NULL default when a row leaves it out. A generated
				// column is never inserted: the canonical table computes it, and its NOT NULL is checked by the insertion.
				const relaxed = [...(nullable.get(parsed.table) ?? [])].map((name) => ({
					name,
					generated: all.find((c) => c.name === name)?.hidden !== 0,
				}))
				const strict = relaxed
					.filter((c) => !c.generated)
					.map(({ name }) => {
						const at = listed.indexOf(name)
						if (at === -1 && all.find((c) => c.name === name)?.dflt_value === null) {
							throw new ExportError('null-in-not-null-column', { table: digestOf(parsed.table) })
						}
						return at
					})
				const generatedNotNull = relaxed
					.filter((c) => c.generated)
					.map((c) => `NOT NULL constraint failed: ${parsed.table}.${c.name}`)
				const key = `${parsed.table}\n${keep.map((i) => listed[i]).join('\n')}`
				let insert = prepared.get(key)
				if (insert === undefined) {
					insert = db.prepare(
						`INSERT INTO main.${quoteIdentifier(parsed.table)} (${keep.map((i) => quoteIdentifier(listed[i] ?? '')).join(', ')}) VALUES (${keep.map(() => '?').join(', ')})`
					)
					prepared.set(key, insert)
				}
				for (const row of parsed.rows) {
					if (row.length !== listed.length) {
						throw new ExportError('invalid-insert', { table: digestOf(parsed.table) })
					}
					if (strict.some((at) => at !== -1 && row[at] === null)) {
						throw new ExportError('null-in-not-null-column', { table: digestOf(parsed.table) })
					}
					try {
						insert.run(...keep.map((i) => row[i] ?? null))
					} catch (error) {
						if (error instanceof Error && generatedNotNull.some((m) => error.message.includes(m))) {
							throw new ExportError('null-in-not-null-column', { table: digestOf(parsed.table) })
						}
						throw error
					}
					rowsLoaded[parsed.table] = (rowsLoaded[parsed.table] ?? 0) + 1
				}
			}
		}
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
	exported.close()

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

	// Addressing as exported, before any bridge migration fills a default (0002 gives every outbox row Public, which
	// 0016 turns into its `to`). An object's addressing is its own JSON; an outbox row has addressing only from the level
	// that wrote it: to/cc from 0016, a single target from 0002, none before.
	// Legacy authorizes with the object's stored author (objects.original_actor_id) and that actor's followers
	// collection, which 0021 may later rewrite from attributedTo; both are captured as exported too.
	/** @type {SourceAddressing} */
	const source = {
		objects: new Map(),
		authors: new Map(),
		followers: new Map(),
		outbox: new Map(),
		outboxByPair: new Map(),
	}
	for (const row of /** @type {{ id: string, properties: unknown, original_actor_id: unknown }[]} */ (
		db.prepare('SELECT id, properties, original_actor_id FROM objects').all()
	)) {
		source.objects.set(String(row.id), addressingOf(row.properties))
		source.authors.set(String(row.id), typeof row.original_actor_id === 'string' ? row.original_actor_id : null)
	}
	for (const row of /** @type {{ id: string, properties: unknown }[]} */ (
		db.prepare('SELECT id, properties FROM actors').all()
	)) {
		const followers = /** @type {Record<string, unknown> | null} */ (
			(() => {
				const value = jsonOrInvalid(row.properties)
				return typeof value === 'object' && value !== null ? value : null
			})()
		)
		// As legacy's actorFromRow reads it: unparsable properties fail the actor (null); a missing followers property is
		// replaced from the actor id, any other value is kept as stored.
		source.followers.set(
			String(row.id),
			followers === null ? null : { present: followers.followers !== undefined, value: followers.followers }
		)
	}
	const outboxColumns = actual.get('outbox_objects') ?? ''
	const hasToCc = outboxColumns.includes('"name":"cc"')
	const hasTarget = outboxColumns.includes('"name":"target"')
	// 0016 copied each row's single target into `to` with an empty `cc`, so a row written before it was applied holds a
	// target, not the addressing it was sent with. Without a usable time of 0016, no row is read so.
	const toCcSince = timeOf(migrationRows.find((m) => m.name.replace(/\.sql$/, '') === migrations[16]?.name)?.appliedAt)
	for (const row of /** @type {Record<string, unknown>[]} */ (db.prepare('SELECT * FROM outbox_objects').all())) {
		/** @type {Addressing | null} */
		let addressing = null
		if (hasToCc) {
			const to = jsonOrInvalid(row.to)
			const cc = jsonOrInvalid(row.cc)
			const written = timeOf(row.cdate)
			const beforeToCc =
				toCcSince !== null &&
				written !== null &&
				written < toCcSince &&
				Array.isArray(to) &&
				to.length === 1 &&
				Array.isArray(cc) &&
				cc.length === 0
			addressing = { to, cc, kind: beforeToCc ? 'target' : 'to-cc' }
		} else if (hasTarget) {
			addressing = { to: [row.target], cc: [], kind: 'target' }
		}
		source.outbox.set(String(row.id), addressing)
		source.outboxByPair.set(`${String(row.actor_id)}\n${String(row.object_id)}`, addressing)
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
			for (const sql of BRIDGE_TIMESTAMPS[migration.name] ?? []) {
				db.prepare(sql).run(legacyTime(baseTime))
			}
			db.exec('COMMIT')
		} catch {
			db.exec('ROLLBACK')
			throw new ExportError('bridge-failed', { migration: migration.name })
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
		nullableInExport: [...nullable].flatMap(([table, columns]) => [...columns].map((c) => `${table}.${c}`)).sort(),
		rowsLoaded,
		deletions,
		foreignKeyViolations,
		notificationSequence,
	}
	if (deletions.length > 0 && !acceptDeletions) {
		db.close()
		throw new ExportError('deletions-not-accepted', { report })
	}
	return { db, report, originalActorIds, source }
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
