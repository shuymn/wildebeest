import { isLiteral, quoteIdentifier, type TableSpec } from './dump-format'
import { bindAll, readColumn, textLiteral, valueLiteral } from './dump-literals'

// What a dump contains, read from the live schema so a new migration needs no change here.
//
// Excluded, never restored blindly:
//   kopje_migrations      the header carries the applied migrations; the target recreates them with its runner
//   kopje_state           except the names in DUMPED_STATE. hold, upgrade, upgrade_bookmark (the bookmark belongs to
//                         the source object), maintenance, dump and import are state of one object at one time
//   media_orphans         tombstones of R2 objects to delete; a restored Store must not delete what it restores
//   backup_media          the backup's media index for one bucket; a restored Store starts a fresh media baseline
//   _cf_*                 platform internals
//   sqlite_* internals    except sqlite_sequence (AUTOINCREMENT counters), which is restored by name
export const STATE_TABLE = 'kopje_state'
export const DUMPED_STATE = ['last_local_id', 'profile_updates'] as const
export const SEQUENCE_TABLE = 'sqlite_sequence'

// The local accounts whose avatar or header a cutover conversion changed (`convert --images`): a JSON array of account
// ids, which publication announces with an Update each and then deletes (domain/actor-update.ts). Only a converted dump
// holds it, so a Store dumped after publication never does.
export const PROFILE_UPDATES = 'profile_updates'

// The account ids of a PROFILE_UPDATES value, or null when it is not a JSON array of non-empty strings.
export function parseProfileUpdates(value: unknown): string[] | null {
	if (typeof value !== 'string') {
		return null
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return null
	}
	return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string' && id !== '')
		? (parsed as string[])
		: null
}

function excluded(name: string): boolean {
	return (
		name === 'kopje_migrations' ||
		name === 'media_orphans' ||
		name === 'backup_media' ||
		name.startsWith('_cf_') ||
		(name.startsWith('sqlite_') && name !== SEQUENCE_TABLE)
	)
}

type ForeignKey = { parent: string; columns: string[] }

export class CatalogError extends Error {}

export function readCatalog(sql: SqlStorage): TableSpec[] {
	const tables = sql
		.exec<{ name: string; sql: string | null }>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name COLLATE BINARY"
		)
		.toArray()
		.filter((t) => !excluded(t.name))

	const specs = new Map<string, TableSpec>()
	const foreignKeys = new Map<string, ForeignKey[]>()
	for (const table of tables) {
		const info = sql
			.exec<{ name: string; pk: number; hidden: number }>(
				'SELECT name, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
				table.name
			)
			.toArray()
			.filter((c) => c.hidden === 0)
		const columns = info.map((c) => c.name)
		const key = info
			.filter((c) => c.pk > 0)
			.sort((a, b) => a.pk - b.pk)
			.map((c) => c.name)
		const withoutRowid = /\)\s*WITHOUT\s+ROWID\s*$/i.test(table.sql ?? '')
		const spec: TableSpec = {
			name: table.name,
			columns,
			order:
				table.name === SEQUENCE_TABLE
					? { by: 'key', columns: ['name'] }
					: withoutRowid
						? { by: 'key', columns: key }
						: { by: 'rowid' },
			key: table.name === SEQUENCE_TABLE ? ['name'] : key,
			deferred: [],
		}
		if (table.name === STATE_TABLE) {
			spec.only = { column: 'name', values: [...DUMPED_STATE] }
		}
		specs.set(table.name, spec)

		const byId = new Map<number, ForeignKey>()
		for (const fk of sql
			.exec<{
				id: number
				table: string
				from: string
			}>('SELECT id, "table", "from" FROM pragma_foreign_key_list(?) ORDER BY id, seq', table.name)
			.toArray()) {
			const entry = byId.get(fk.id) ?? { parent: fk.table, columns: [] }
			entry.columns.push(fk.from)
			byId.set(fk.id, entry)
		}
		foreignKeys.set(table.name, [...byId.values()])
	}

	// Parents before children (names break ties). A reference to the same table or, in a cycle, to a table not yet
	// placed is deferred: rows are inserted with NULL there and linked after all rows are in.
	const ordered: TableSpec[] = []
	const placed = new Set<string>()
	const remaining = [...specs.keys()].filter((name) => name !== SEQUENCE_TABLE)
	while (remaining.length > 0) {
		const ready = remaining.findIndex((name) =>
			(foreignKeys.get(name) ?? []).every((fk) => fk.parent === name || placed.has(fk.parent) || !specs.has(fk.parent))
		)
		const index = ready === -1 ? 0 : ready
		const name = remaining.splice(index, 1)[0] ?? ''
		const spec = specs.get(name)
		if (spec === undefined) {
			continue
		}
		const deferred = new Set<string>()
		for (const fk of foreignKeys.get(name) ?? []) {
			if (fk.parent === name || (specs.has(fk.parent) && !placed.has(fk.parent))) {
				fk.columns.forEach((column) => deferred.add(column))
			}
		}
		spec.deferred = spec.columns.filter((column) => deferred.has(column))
		if (spec.deferred.length > 0 && spec.key.length === 0) {
			throw new CatalogError(`${name} has deferred references but no primary key`)
		}
		placed.add(name)
		ordered.push(spec)
	}
	const sequence = specs.get(SEQUENCE_TABLE)
	if (sequence !== undefined) {
		ordered.push(sequence)
	}
	return ordered
}

export type ScanMode = 'rows' | 'links'

// One row of a scan: the ordering key (to resume after it) and the canonical literals (dump-literals.ts) of the
// selected columns. In rows mode those are all columns; in links mode the deferred columns followed by the primary
// key columns.
export type ScannedRow = { after: string[]; literals: string[] }

// Reads a table in its order, starting after a cursor key, and hands each row to `visit` until it returns false.
export function scanTable(
	sql: SqlStorage,
	spec: TableSpec,
	mode: ScanMode,
	after: readonly string[] | null,
	visit: (row: ScannedRow) => boolean
): void {
	const byRowid = spec.order.by === 'rowid'
	const orderColumns = spec.order.by === 'key' ? spec.order.columns : []
	const selected = mode === 'rows' ? spec.columns : [...spec.deferred, ...spec.key]
	const where: string[] = []
	const bindings: SqlStorageValue[] = []
	if (spec.only !== undefined) {
		where.push(`${quoteIdentifier(spec.only.column)} IN (${spec.only.values.map(textLiteral).join(',')})`)
	}
	if (mode === 'links') {
		where.push(`(${spec.deferred.map((c) => `${quoteIdentifier(c)} IS NOT NULL`).join(' OR ')})`)
	}
	if (after !== null) {
		if (byRowid) {
			if (after.length !== 1 || !/^-?\d{1,19}$/.test(after[0] ?? '')) {
				throw new CatalogError(`invalid cursor key for ${spec.name}`)
			}
			where.push('rowid > CAST(? AS INTEGER)')
			bindings.push(after[0] ?? '')
		} else {
			if (after.length !== orderColumns.length || !after.every(isLiteral)) {
				throw new CatalogError(`invalid cursor key for ${spec.name}`)
			}
			let bound
			try {
				bound = bindAll(after)
			} catch {
				throw new CatalogError(`invalid cursor key for ${spec.name}`)
			}
			where.push(`(${orderColumns.map(quoteIdentifier).join(',')}) > (${bound.exprs.join(',')})`)
			bindings.push(...bound.params)
		}
	}
	const keyColumns = byRowid ? ['CAST(rowid AS TEXT)'] : orderColumns.flatMap(readColumn)
	const order = byRowid ? 'rowid' : orderColumns.map(quoteIdentifier).join(',')
	const query =
		`SELECT ${[...keyColumns, ...selected.flatMap(readColumn)].join(', ')} FROM ${quoteIdentifier(spec.name)}` +
		(where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
		` ORDER BY ${order}`
	const keyWidth = keyColumns.length
	for (const raw of sql.exec(query, ...bindings).raw()) {
		const keys = byRowid ? [raw[0] as string] : pairsToLiterals(raw, 0, keyWidth)
		if (!visit({ after: keys, literals: pairsToLiterals(raw, keyWidth, raw.length) })) {
			return
		}
	}
}

function pairsToLiterals(raw: SqlStorageValue[], from: number, to: number): string[] {
	const literals: string[] = []
	for (let i = from; i < to; i += 2) {
		literals.push(valueLiteral(raw[i] ?? null, raw[i + 1] ?? null))
	}
	return literals
}

// Whether a table has a dumped row (kopje_state: an allowlisted one) outside `except`. EXISTS stops at the first
// row; count(*) would scan the table.
export function hasRows(
	sql: SqlStorage,
	spec: TableSpec,
	except?: { column: string; values: readonly string[] }
): boolean {
	const where: string[] = []
	if (spec.only !== undefined) {
		where.push(`${quoteIdentifier(spec.only.column)} IN (${spec.only.values.map(textLiteral).join(',')})`)
	}
	if (except !== undefined) {
		where.push(`${quoteIdentifier(except.column)} NOT IN (${except.values.map(() => '?').join(',')})`)
	}
	const filter = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
	const query = `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(spec.name)}${filter}) AS found`
	return sql.exec<{ found: number }>(query, ...(except?.values ?? [])).one().found === 1
}
