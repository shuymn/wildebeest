// The Store dump format (version 1). One format serves the scheduled backup, the cutover import, and restore drills.
// The full specification lives in docs/dump-format.md; this module is its executable half.
//
//   -- kopje-dump-header {json}            line 1: DumpHeader
//   INSERT INTO "t" ("a","b") VALUES (<literal>,<literal>);
//   ...                                     tables in header order, rows in each table's order
//   UPDATE "t" SET "c"=<literal> WHERE "k"=<literal>;
//   ...                                     links: deferred self/cyclic references, after all rows
//   -- kopje-dump-trailer {json}           DumpTrailer
//   -- kopje-dump-end
//
// Each statement ends with ";\n". Literals are exactly what SQLite's quote() produces, except that TEXT containing
// NUL is written as CAST(X'..' AS TEXT) (quote() would truncate it). Nothing else is accepted on import: the Store
// executes only statements that match these templates for tables of its own catalog.

export const DUMP_FORMAT = 1

export const HEADER_PREFIX = '-- kopje-dump-header '
export const TRAILER_PREFIX = '-- kopje-dump-trailer '
export const END_LINE = '-- kopje-dump-end'

// Ordering of a table's rows, which the per-table checksum depends on.
//   rowid  : ascending rowid (for INTEGER PRIMARY KEY tables that is the key; otherwise insertion order)
//   key    : ascending by the listed columns (BINARY collation), for WITHOUT ROWID tables and sqlite_sequence
export type TableOrder = { by: 'rowid' } | { by: 'key'; columns: string[] }

export type TableSpec = {
	name: string
	columns: string[]
	order: TableOrder
	// Primary key columns (used by link statements).
	key: string[]
	// FK columns referencing the same table (or a table later in the order). INSERTs write NULL there and a link
	// statement sets the value after all rows are in.
	deferred: string[]
	// Only these rows are part of the dump (kopje_state keeps only allowlisted names).
	only?: { column: string; values: string[] }
}

export type MigrationRecord = { name: string; checksum: string }

export type DumpHeader = {
	format: typeof DUMP_FORMAT
	createdAt: string
	source: { build: string; version: string }
	migrations: MigrationRecord[]
	tables: TableSpec[]
}

export type TableResult = { name: string; rows: number; checksum: string }

export type DumpTrailer = {
	tables: TableResult[]
	// The statement lines between header and trailer: their count, byte length and SHA-256.
	body: { statements: number; bytes: number; sha256: string }
}

export function headerLine(header: DumpHeader): string {
	return `${HEADER_PREFIX}${JSON.stringify(header)}\n`
}

export function trailerLines(trailer: DumpTrailer): string {
	return `${TRAILER_PREFIX}${JSON.stringify(trailer)}\n${END_LINE}\n`
}

export function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}

// Position of the first character after the literal that starts at `at`, or -1 if there is no valid literal there.
export function scanLiteral(text: string, at: number): number {
	const c = text.charCodeAt(at)
	if (c === 0x27 /* ' */) {
		let i = at + 1
		for (;;) {
			const q = text.indexOf("'", i)
			if (q === -1) {
				return -1
			}
			if (text.charCodeAt(q + 1) === 0x27) {
				i = q + 2
				continue
			}
			return q + 1
		}
	}
	if (c === 0x58 /* X */ || c === 0x78 /* x */) {
		return scanBlob(text, at)
	}
	if (text.startsWith('NULL', at)) {
		return at + 4
	}
	if (text.startsWith('CAST(', at)) {
		const end = scanBlob(text, at + 5)
		return end !== -1 && text.startsWith(' AS TEXT)', end) ? end + 9 : -1
	}
	return scanNumber(text, at)
}

function scanBlob(text: string, at: number): number {
	const c = text.charCodeAt(at)
	if ((c !== 0x58 && c !== 0x78) || text.charCodeAt(at + 1) !== 0x27) {
		return -1
	}
	let i = at + 2
	while (isHex(text.charCodeAt(i))) {
		i++
	}
	return text.charCodeAt(i) === 0x27 && (i - at - 2) % 2 === 0 ? i + 1 : -1
}

function scanNumber(text: string, at: number): number {
	let i = at
	if (text.charCodeAt(i) === 0x2d /* - */) {
		i++
	}
	const digits = (from: number) => {
		let j = from
		while (isDigit(text.charCodeAt(j))) {
			j++
		}
		return j
	}
	let end = digits(i)
	if (end === i) {
		return -1
	}
	if (text.charCodeAt(end) === 0x2e /* . */) {
		const fraction = digits(end + 1)
		if (fraction === end + 1) {
			return -1
		}
		end = fraction
	}
	const e = text.charCodeAt(end)
	if (e === 0x65 || e === 0x45) {
		let j = end + 1
		const sign = text.charCodeAt(j)
		if (sign === 0x2b || sign === 0x2d) {
			j++
		}
		const exponent = digits(j)
		if (exponent === j) {
			return -1
		}
		end = exponent
	}
	return end
}

function isDigit(c: number): boolean {
	return c >= 0x30 && c <= 0x39
}

function isHex(c: number): boolean {
	return isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
}

// A literal used as a cursor key or WHERE value must be exactly one literal.
export function isLiteral(text: string): boolean {
	return text.length > 0 && scanLiteral(text, 0) === text.length
}

// A statement template: fixed text segments with one literal between each pair.
type Template = { segments: string[] }

export type ParsedStatement =
	| { kind: 'insert'; table: TableSpec; text: string; literals: string[] }
	| { kind: 'link'; table: TableSpec; text: string; literals: string[] }

export function insertTemplate(spec: TableSpec): Template {
	const columns = spec.columns.map(quoteIdentifier).join(',')
	const segments = [`INSERT INTO ${quoteIdentifier(spec.name)} (${columns}) VALUES (`]
	for (let i = 1; i < spec.columns.length; i++) {
		segments.push(',')
	}
	segments.push(');')
	return { segments }
}

export function linkTemplate(spec: TableSpec): Template {
	const set = spec.deferred.map((column, i) => `${i === 0 ? 'SET ' : ','}${quoteIdentifier(column)}=`)
	const where = spec.key.map((column, i) => `${i === 0 ? ' WHERE ' : ' AND '}${quoteIdentifier(column)}=`)
	const segments = [...set, ...where, ';']
	segments[0] = `UPDATE ${quoteIdentifier(spec.name)} ${segments[0]}`
	return { segments }
}

export function renderTemplate(template: Template, literals: readonly string[]): string {
	let out = template.segments[0] ?? ''
	for (let i = 0; i < literals.length; i++) {
		out += literals[i] + (template.segments[i + 1] ?? '')
	}
	return out
}

export class DumpParseError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'DumpParseError'
	}
}

// Validates a chunk of statement lines against the catalog and returns the statements. The chunk must hold whole
// statements only, each ending with ";\n". Anything that does not match a template exactly is rejected.
export function parseStatements(text: string, tables: readonly TableSpec[]): ParsedStatement[] {
	const inserts = new Map<string, { spec: TableSpec; template: Template }>()
	const links = new Map<string, { spec: TableSpec; template: Template }>()
	for (const spec of tables) {
		inserts.set(spec.name, { spec, template: insertTemplate(spec) })
		if (spec.deferred.length > 0) {
			links.set(spec.name, { spec, template: linkTemplate(spec) })
		}
	}
	const statements: ParsedStatement[] = []
	let at = 0
	while (at < text.length) {
		let kind: 'insert' | 'link'
		let nameStart: number
		if (text.startsWith('INSERT INTO "', at)) {
			kind = 'insert'
			nameStart = at + 13
		} else if (text.startsWith('UPDATE "', at)) {
			kind = 'link'
			nameStart = at + 8
		} else {
			throw new DumpParseError(`unexpected text at offset ${at}: ${JSON.stringify(text.slice(at, at + 40))}`)
		}
		const nameEnd = text.indexOf('"', nameStart)
		const entry = (kind === 'insert' ? inserts : links).get(nameEnd === -1 ? '' : text.slice(nameStart, nameEnd))
		if (entry === undefined) {
			throw new DumpParseError(`statement at offset ${at} targets a table outside the catalog`)
		}
		const literals: string[] = []
		let i = at
		const { segments } = entry.template
		for (let s = 0; s < segments.length; s++) {
			const segment = segments[s] ?? ''
			if (!text.startsWith(segment, i)) {
				throw new DumpParseError(`statement at offset ${at} does not match the ${kind} template of ${entry.spec.name}`)
			}
			i += segment.length
			if (s === segments.length - 1) {
				break
			}
			const end = scanLiteral(text, i)
			if (end === -1) {
				throw new DumpParseError(`invalid literal at offset ${i}`)
			}
			literals.push(text.slice(i, end))
			i = end
		}
		if (text.charCodeAt(i) !== 0x0a) {
			throw new DumpParseError(`statement at offset ${at} is not terminated by a newline`)
		}
		statements.push({ kind, table: entry.spec, text: text.slice(at, i), literals })
		at = i + 1
	}
	return statements
}

// UTF-8 byte length of a string without encoding it.
export function utf8Length(text: string): number {
	let bytes = text.length
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i)
		if (c >= 0x80) {
			const next = text.charCodeAt(i + 1)
			if (c < 0x800) {
				bytes += 1
			} else if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
				bytes += 2 // a surrogate pair is 4 bytes for 2 code units
				i++
			} else {
				bytes += 2
			}
		}
	}
	return bytes
}
