import { readCatalog, type ScannedRow, scanTable } from './dump-catalog'
import {
	DUMP_FORMAT,
	type DumpHeader,
	type DumpTrailer,
	insertTemplate,
	linkTemplate,
	type MigrationRecord,
	renderTemplate,
	type TableResult,
	type TableSpec,
	utf8Length,
} from './dump-format'
import { Sha256 } from './sha256'

// Where a dump or a verification stands. Rows of table `table` after key `after` are next; `rows` and `hash` cover
// the rows of that table already read. Links run after all rows, over the tables that have deferred columns.
export type ScanPosition = {
	phase: 'rows' | 'links' | 'done'
	table: number
	after: string[] | null
	rows: number
	hash: string | null
}

// The resumable cursor a dump RPC returns. The caller persists it and passes it back; any cursor of the same dump can
// be replayed (the Store is frozen, so the same cursor always yields the same chunk).
export type DumpCursor = ScanPosition & {
	v: 1
	dump: string
	body: { statements: number; bytes: number; hash: string }
}

export const MAX_DUMP_CHUNK_BYTES = 16 * 1024 * 1024
export const MIN_DUMP_CHUNK_BYTES = 1024

export function buildHeader(
	sql: SqlStorage,
	migrations: MigrationRecord[],
	source: DumpHeader['source'],
	now: number
): DumpHeader {
	return { format: DUMP_FORMAT, createdAt: new Date(now).toISOString(), source, migrations, tables: readCatalog(sql) }
}

export function initialCursor(dump: string): DumpCursor {
	return {
		v: 1,
		dump,
		phase: 'rows',
		table: 0,
		after: null,
		rows: 0,
		hash: null,
		body: { statements: 0, bytes: 0, hash: new Sha256().save() },
	}
}

// Checks the shape of a cursor that came back from a caller.
export function parseCursor(value: unknown): DumpCursor {
	const c = value as Partial<DumpCursor> | null
	const ok =
		typeof c === 'object' &&
		c !== null &&
		c.v === 1 &&
		typeof c.dump === 'string' &&
		(c.phase === 'rows' || c.phase === 'links' || c.phase === 'done') &&
		Number.isSafeInteger(c.table) &&
		(c.table ?? -1) >= 0 &&
		(c.after === null || (Array.isArray(c.after) && c.after.every((k) => typeof k === 'string'))) &&
		Number.isSafeInteger(c.rows) &&
		(c.hash === null || typeof c.hash === 'string') &&
		typeof c.body === 'object' &&
		c.body !== null &&
		Number.isSafeInteger(c.body.statements) &&
		Number.isSafeInteger(c.body.bytes) &&
		typeof c.body.hash === 'string'
	if (!ok) {
		throw new Error('invalid dump cursor')
	}
	return c as DumpCursor
}

export type DumpStep = { chunk: Uint8Array; cursor: DumpCursor; finished: TableResult[] }

const HASH_BATCH = 1 << 20

// Reads the next chunk: whole statements up to maxBytes (at least one statement), resuming at the cursor. Tables
// whose rows were all read in this step are returned in `finished` with their row count and checksum.
export function dumpStep(sql: SqlStorage, tables: readonly TableSpec[], start: DumpCursor, maxBytes: number): DumpStep {
	const cursor: DumpCursor = {
		...start,
		after: start.after === null ? null : [...start.after],
		body: { ...start.body },
	}
	const out: string[] = []
	const finished: TableResult[] = []
	let bytes = 0
	const linked = tables.filter((t) => t.deferred.length > 0)
	const fits = (statement: string) => {
		const size = utf8Length(statement)
		if (out.length > 0 && bytes + size > maxBytes) {
			return false
		}
		out.push(statement)
		bytes += size
		return true
	}

	while (cursor.phase !== 'done' && bytes < maxBytes) {
		if (cursor.phase === 'rows') {
			const spec = tables[cursor.table]
			if (spec === undefined) {
				Object.assign(cursor, { phase: 'links', table: 0, after: null, rows: 0, hash: null })
				continue
			}
			const hasher = new RowHasher(cursor.hash)
			const template = insertTemplate(spec)
			const deferred = spec.deferred.map((c) => spec.columns.indexOf(c))
			let full = false
			scanTable(sql, spec, 'rows', cursor.after, ({ after, literals }) => {
				const values = deferred.length === 0 ? literals : literals.map((v, i) => (deferred.includes(i) ? 'NULL' : v))
				if (!fits(`${renderTemplate(template, values)}\n`)) {
					full = true
					return false
				}
				hasher.add(literals)
				cursor.rows++
				cursor.after = after
				return true
			})
			if (full) {
				cursor.hash = hasher.save()
				break
			}
			finished.push({ name: spec.name, rows: cursor.rows, checksum: hasher.hex() })
			Object.assign(cursor, { table: cursor.table + 1, after: null, rows: 0, hash: null })
		} else {
			const spec = linked[cursor.table]
			if (spec === undefined) {
				Object.assign(cursor, { phase: 'done', table: 0, after: null, rows: 0, hash: null })
				continue
			}
			const template = linkTemplate(spec)
			let full = false
			scanTable(sql, spec, 'links', cursor.after, ({ after, literals }) => {
				if (!fits(`${renderTemplate(template, literals)}\n`)) {
					full = true
					return false
				}
				cursor.after = after
				return true
			})
			if (full) {
				break
			}
			Object.assign(cursor, { table: cursor.table + 1, after: null })
		}
	}

	const chunk = new TextEncoder().encode(out.join(''))
	const body = Sha256.restore(cursor.body.hash).update(chunk)
	cursor.body = {
		statements: cursor.body.statements + out.length,
		bytes: cursor.body.bytes + chunk.length,
		hash: body.save(),
	}
	return { chunk, cursor, finished }
}

export function trailerOf(results: readonly TableResult[], cursor: DumpCursor): DumpTrailer {
	return {
		tables: [...results],
		body: {
			statements: cursor.body.statements,
			bytes: cursor.body.bytes,
			sha256: Sha256.restore(cursor.body.hash).hex(),
		},
	}
}

// The per-table checksum: SHA-256 over each row's literals joined by ',' plus '\n', in the table's order.
export class RowHasher {
	readonly #hash: Sha256
	#pending = ''

	constructor(saved: string | null) {
		this.#hash = saved === null ? new Sha256() : Sha256.restore(saved)
	}

	add(literals: readonly string[]): void {
		this.#pending += `${literals.join(',')}\n`
		if (this.#pending.length >= HASH_BATCH) {
			this.#flush()
		}
	}

	save(): string {
		this.#flush()
		return this.#hash.save()
	}

	hex(): string {
		this.#flush()
		return this.#hash.hex()
	}

	#flush(): void {
		if (this.#pending.length > 0) {
			this.#hash.update(this.#pending)
			this.#pending = ''
		}
	}
}

// refused: the problem a row check found, which ends the step (the import cannot be verified).
export type VerifyStep = { position: ScanPosition; finished: TableResult[]; bytes: number; refused: string | null }

// A check of each row the scan reads, by the scan's own position: a problem it returns refuses the import.
export type RowCheck = (spec: TableSpec, row: ScannedRow) => string | null

// Recomputes table checksums from a position for up to maxBytes of row text, checking each row read (`check`); used
// to verify an import.
export function checksumStep(
	sql: SqlStorage,
	tables: readonly TableSpec[],
	start: ScanPosition,
	maxBytes: number,
	check: RowCheck = () => null
): VerifyStep {
	const position: ScanPosition = { ...start }
	const finished: TableResult[] = []
	let bytes = 0
	let refused: string | null = null
	while (position.phase === 'rows' && bytes < maxBytes) {
		const spec = tables[position.table]
		if (spec === undefined) {
			Object.assign(position, { phase: 'done', table: 0, after: null, rows: 0, hash: null })
			break
		}
		const hasher = new RowHasher(position.hash)
		let full = false
		scanTable(sql, spec, 'rows', position.after, (row) => {
			const { after, literals } = row
			refused = check(spec, row)
			if (refused !== null) {
				return false
			}
			hasher.add(literals)
			position.rows++
			position.after = after
			bytes += literals.reduce((n, v) => n + v.length + 1, 0)
			if (bytes >= maxBytes) {
				full = true
				return false
			}
			return true
		})
		if (refused !== null) {
			break
		}
		if (full) {
			position.hash = hasher.save()
			break
		}
		finished.push({ name: spec.name, rows: position.rows, checksum: hasher.hex() })
		Object.assign(position, { table: position.table + 1, after: null, rows: 0, hash: null })
	}
	return { position, finished, bytes, refused }
}
