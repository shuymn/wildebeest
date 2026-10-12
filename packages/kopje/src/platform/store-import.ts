import { DUMPED_STATE, rowCount, SEQUENCE_TABLE, STATE_TABLE } from './dump-catalog'
import {
	DUMP_FORMAT,
	type DumpHeader,
	type DumpTrailer,
	type MigrationRecord,
	type ParsedStatement,
	quoteIdentifier,
	type TableResult,
	type TableSpec,
} from './dump-format'
import { bindAll, LiteralError, textLiteral } from './dump-literals'

// Checks the shape of a header that came from a caller. The catalog and migrations are compared separately.
export function parseHeader(value: unknown): DumpHeader {
	const h = value as Partial<DumpHeader> | null
	const ok =
		typeof h === 'object' &&
		h !== null &&
		h.format === DUMP_FORMAT &&
		typeof h.createdAt === 'string' &&
		typeof h.source === 'object' &&
		h.source !== null &&
		Array.isArray(h.migrations) &&
		h.migrations.every((m) => typeof m?.name === 'string' && typeof m?.checksum === 'string') &&
		Array.isArray(h.tables) &&
		h.tables.every((t) => typeof t?.name === 'string' && Array.isArray(t?.columns))
	if (!ok) {
		throw new ImportError('invalid-header', `not a kopje dump header of format ${DUMP_FORMAT}`)
	}
	return h as DumpHeader
}

export function parseTrailer(value: unknown): DumpTrailer {
	const t = value as Partial<DumpTrailer> | null
	const ok =
		typeof t === 'object' &&
		t !== null &&
		Array.isArray(t.tables) &&
		t.tables.every(
			(r) => typeof r?.name === 'string' && Number.isSafeInteger(r?.rows) && typeof r?.checksum === 'string'
		) &&
		typeof t.body === 'object' &&
		t.body !== null &&
		Number.isSafeInteger(t.body.statements) &&
		Number.isSafeInteger(t.body.bytes) &&
		typeof t.body.sha256 === 'string'
	if (!ok) {
		throw new ImportError('invalid-trailer', 'not a kopje dump trailer')
	}
	return t as DumpTrailer
}

// Expected failures of an import step. The code crosses the RPC boundary as part of the result.
export class ImportError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message)
		this.name = 'ImportError'
	}
}

function canonicalTable(t: TableSpec): string {
	return JSON.stringify([t.name, t.columns, t.order, t.key, t.deferred, t.only ?? null])
}

// Returns why the dump's tables differ from this Store's catalog, or null when they are the same.
export function catalogDifference(dump: readonly TableSpec[], target: readonly TableSpec[]): string | null {
	const names = (list: readonly TableSpec[]) => list.map((t) => t.name).join(',')
	if (names(dump) !== names(target)) {
		return `tables differ: dump has [${names(dump)}], this Store has [${names(target)}]`
	}
	for (const [i, table] of dump.entries()) {
		const mine = target[i]
		if (mine === undefined || canonicalTable(table) !== canonicalTable(mine)) {
			return `table ${table.name} differs from this Store's definition`
		}
	}
	return null
}

export function migrationDifference(
	dump: readonly MigrationRecord[],
	applied: readonly MigrationRecord[]
): string | null {
	const text = (list: readonly MigrationRecord[]) => list.map((m) => `${m.name}:${m.checksum}`).join(',')
	return text(dump) === text(applied)
		? null
		: `dump migrations [${dump.map((m) => m.name).join(',')}] differ from this Store's [${applied.map((m) => m.name).join(',')}]`
}

// Rows that are configuration of this Store rather than data: they do not make it non-empty.
export type Bootstrap = { table: string; column: string; values: readonly string[] }

// A Store with no rows in any dumped table (kopje_state counts only its dumped names, bootstrap rows not at all).
export function isEmpty(sql: SqlStorage, tables: readonly TableSpec[], bootstrap?: Bootstrap): boolean {
	return tables.every((t) => {
		if (bootstrap === undefined || t.name !== bootstrap.table) {
			return rowCount(sql, t) === 0
		}
		const names = bootstrap.values.map(() => '?').join(',')
		const query = `SELECT count(*) AS n FROM ${quoteIdentifier(t.name)} WHERE ${quoteIdentifier(bootstrap.column)} NOT IN (${names})`
		return sql.exec<{ n: number }>(query, ...bootstrap.values).one().n === 0
	})
}

// Executes validated statements. parseStatements matched each against a template of this Store's catalog; the
// literals are then bound as parameters (bindLiteral), which keeps the statement text short whatever the value size
// (the platform limits a statement to 100 KB) and keeps every storage class exact.
export function applyStatements(sql: SqlStorage, statements: readonly ParsedStatement[]): void {
	const allowedState = new Set(DUMPED_STATE.map(textLiteral))
	for (const statement of statements) {
		const table = quoteIdentifier(statement.table.name)
		let bound
		try {
			bound = bindAll(statement.literals)
		} catch (error) {
			throw new ImportError('invalid-chunk', error instanceof LiteralError ? error.message : 'invalid literal')
		}
		if (statement.kind === 'link') {
			const { deferred, key } = statement.table
			const set = deferred.map((c, i) => `${quoteIdentifier(c)} = ${bound.exprs[i]}`).join(', ')
			const match = key.map((c, i) => `${quoteIdentifier(c)} = ${bound.exprs[deferred.length + i]}`).join(' AND ')
			if (sql.exec(`UPDATE ${table} SET ${set} WHERE ${match}`, ...bound.params).rowsWritten === 0) {
				throw new ImportError('link-target-missing', `link to a missing ${statement.table.name} row`)
			}
			continue
		}
		const name = statement.literals[0] ?? ''
		if (statement.table.name === STATE_TABLE && !allowedState.has(name)) {
			throw new ImportError('state-not-allowed', `kopje_state ${name} is not restorable`)
		}
		if (statement.table.name === SEQUENCE_TABLE) {
			// AUTOINCREMENT inserts above created their own counter rows; the dumped value replaces them.
			const nameBound = bindAll([name])
			sql.exec(`DELETE FROM ${table} WHERE name = ${nameBound.exprs[0]}`, ...nameBound.params)
		}
		const columns = statement.table.columns.map(quoteIdentifier).join(',')
		sql.exec(`INSERT INTO ${table} (${columns}) VALUES (${bound.exprs.join(',')})`, ...bound.params)
	}
}

export type VerifyReport = {
	ok: boolean
	tables: {
		name: string
		rows: number
		expectedRows: number
		checksum: string
		expectedChecksum: string
		ok: boolean
	}[]
	foreignKeyViolations: number
	problems: string[]
}

export function compareResults(
	computed: readonly TableResult[],
	trailer: DumpTrailer,
	foreignKeyViolations: number
): VerifyReport {
	const problems: string[] = []
	const expected = new Map(trailer.tables.map((t) => [t.name, t]))
	const tables = computed.map((c) => {
		const want = expected.get(c.name)
		const ok = want !== undefined && want.rows === c.rows && want.checksum === c.checksum
		if (want === undefined) {
			problems.push(`${c.name} is missing from the trailer`)
		} else if (!ok) {
			const checksum = want.checksum === c.checksum ? 'matches' : 'differs'
			problems.push(`${c.name}: ${c.rows} rows (expected ${want.rows}), checksum ${checksum}`)
		}
		return {
			name: c.name,
			rows: c.rows,
			expectedRows: want?.rows ?? -1,
			checksum: c.checksum,
			expectedChecksum: want?.checksum ?? '',
			ok,
		}
	})
	for (const name of expected.keys()) {
		if (!computed.some((c) => c.name === name)) {
			problems.push(`${name} is in the trailer but not in this Store`)
		}
	}
	if (foreignKeyViolations > 0) {
		problems.push(`foreign_key_check reported ${foreignKeyViolations} violation(s)`)
	}
	return { ok: problems.length === 0, tables, foreignKeyViolations, problems }
}
