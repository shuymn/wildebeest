import { DUMPED_STATE, rowCount, SEQUENCE_TABLE, STATE_TABLE, textLiteral } from './dump-catalog'
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

// A Store with no rows in any dumped table (kopje_state counts only its dumped names).
export function isEmpty(sql: SqlStorage, tables: readonly TableSpec[]): boolean {
	return tables.every((t) => rowCount(sql, t) === 0)
}

// Executes validated statements. Statement text is executed as is: parseStatements has matched it against a template
// of this Store's catalog, so it is an INSERT of literals into all columns of a known table or a link UPDATE by key.
// Literals keep SQLite's exact types (JS numbers would bind as REAL).
export function applyStatements(sql: SqlStorage, statements: readonly ParsedStatement[]): void {
	const allowedState = new Set(DUMPED_STATE.map(textLiteral))
	for (const statement of statements) {
		if (statement.kind === 'link') {
			if (sql.exec(statement.text).rowsWritten === 0) {
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
			sql.exec(`DELETE FROM ${quoteIdentifier(SEQUENCE_TABLE)} WHERE name = ${name}`)
		}
		sql.exec(statement.text)
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
