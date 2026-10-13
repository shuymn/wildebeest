// The statements of the SQL scripts `wrangler d1 export` writes, parsed by a strict grammar. Nothing from an export is
// executed as written except a validated CREATE TABLE in a scratch database: rows are decoded here, literal by literal,
// and bound as parameters. Errors carry fixed codes only, never text from the export (DATA-13).

import { createHash } from 'node:crypto'

export class ExportError extends Error {
	/**
	 * @param {string} code a fixed code
	 * @param {Record<string, unknown>} [detail] counts, levels and digests only
	 */
	constructor(code, detail = {}) {
		super(code)
		this.code = code
		this.detail = detail
	}
}

// A short digest of an untrusted identifier (a table name, an object type) for reports.
/** @param {string} text */
export function digestOf(text) {
	return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * Yields the statements of a script without their terminating ';' and leading comments. Quotes ('', "", `` and
 * []) and comments are honored, and a CREATE TRIGGER statement runs to its END.
 * @param {string} text
 * @returns {Generator<string>}
 */
export function* splitStatements(text) {
	let start = 0
	let i = 0
	const n = text.length
	while (i < n) {
		const c = text[i]
		if (c === "'" || c === '"' || c === '`') {
			i = skipQuoted(text, i)
		} else if (c === '[') {
			const end = text.indexOf(']', i)
			i = end === -1 ? n : end + 1
		} else if (c === '-' && text[i + 1] === '-') {
			const end = text.indexOf('\n', i)
			i = end === -1 ? n : end + 1
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2)
			i = end === -1 ? n : end + 2
		} else if (c === ';') {
			const statement = stripComments(text.slice(start, i)).trim()
			if (/^CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(statement) && !/\bEND$/i.test(statement)) {
				i++
				continue
			}
			if (statement !== '') {
				yield statement
			}
			i++
			start = i
		} else {
			i++
		}
	}
	const rest = stripComments(text.slice(start)).trim()
	if (rest !== '') {
		yield rest
	}
}

/**
 * Position after the quoted token starting at `at` (its quote doubled inside).
 * @param {string} text
 * @param {number} at
 */
function skipQuoted(text, at) {
	const close = text[at]
	let i = at + 1
	while (i < text.length) {
		if (text[i] === close) {
			if (text[i + 1] === close) {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return text.length
}

/** @param {string} statement */
function stripComments(statement) {
	let s = statement.trimStart()
	for (;;) {
		if (s.startsWith('--')) {
			const end = s.indexOf('\n')
			s = end === -1 ? '' : s.slice(end + 1).trimStart()
		} else if (s.startsWith('/*')) {
			const end = s.indexOf('*/')
			s = end === -1 ? '' : s.slice(end + 2).trimStart()
		} else {
			return s
		}
	}
}

/** @param {string} quoted */
export function unquoteIdentifier(quoted) {
	if (quoted.startsWith('"') || quoted.startsWith('`')) {
		const q = quoted.charAt(0)
		return quoted.slice(1, -1).replaceAll(q + q, q)
	}
	if (quoted.startsWith('[')) {
		return quoted.slice(1, -1)
	}
	return quoted
}

/** @param {string} name */
export function quoteIdentifier(name) {
	return `"${name.replaceAll('"', '""')}"`
}

/** @typedef {null | bigint | number | string | Uint8Array} Value */

// Bounds on decoded data. SQLite's .dump writes replace(replace('<text>','\r',char(13)),'\n',char(10)) at most, so two
// levels of replace are enough; an expansion is sized before it is built. One decoded literal may hold at most 16 Mi
// UTF-16 units (a Store row is at most 2 MB anyway), and all literals of one pass over an export at most 1 Gi units,
// the export size limit: a small statement cannot decode into more memory than the export could hold.
export const MAX_REPLACE_DEPTH = 2
export const MAX_LITERAL_UNITS = 16 * 1024 * 1024
export const MAX_DECODED_UNITS = 1024 * 1024 * 1024

/** @typedef {{ remaining: number }} DecodeBudget */

/** @returns {DecodeBudget} */
export function decodeBudget() {
	return { remaining: MAX_DECODED_UNITS }
}

/**
 * @param {DecodeBudget} budget
 * @param {number} units
 */
function spend(budget, units) {
	if (units > MAX_LITERAL_UNITS || units > budget.remaining) {
		throw new ExportError('decoded-data-too-large')
	}
	budget.remaining -= units
}

/**
 * @typedef {{ kind: 'pragma' } | { kind: 'create-table', table: string, sql: string } | { kind: 'ignored' }
 *   | { kind: 'insert', table: string, columns: string[] | null, rows: Value[][] }} Statement
 */

// A cursor over one statement.
class Scanner {
	/**
	 * @param {string} text
	 * @param {DecodeBudget} [budget]
	 */
	constructor(text, budget = decodeBudget()) {
		this.text = text
		this.at = 0
		this.budget = budget
	}

	space() {
		while (this.at < this.text.length && /\s/.test(this.text[this.at] ?? '')) {
			this.at++
		}
	}

	/** @param {string} word a keyword, matched case-insensitively at a word boundary */
	keyword(word) {
		this.space()
		const slice = this.text.slice(this.at, this.at + word.length)
		const next = this.text[this.at + word.length] ?? ''
		if (slice.toUpperCase() === word && !/[A-Za-z0-9_$]/.test(next)) {
			this.at += word.length
			return true
		}
		return false
	}

	/** @param {string} char */
	punct(char) {
		this.space()
		if (this.text[this.at] === char) {
			this.at++
			return true
		}
		return false
	}

	identifier() {
		this.space()
		const c = this.text[this.at]
		let end
		if (c === '"' || c === '`') {
			end = skipQuoted(this.text, this.at)
		} else if (c === '[') {
			end = this.text.indexOf(']', this.at) + 1
		} else {
			const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(this.text.slice(this.at, this.at + 256))
			end = match === null ? 0 : this.at + match[0].length
		}
		if (end <= this.at) {
			throw new ExportError('invalid-statement')
		}
		const name = unquoteIdentifier(this.text.slice(this.at, end))
		this.at = end
		return name
	}

	done() {
		this.space()
		return this.at >= this.text.length
	}
}

/**
 * One literal value: NULL, TRUE/FALSE, a number, a string, a blob, or the replace(<string>, '<marker>', char(n...))
 * form SQLite's .dump writes for strings with control characters. Nothing else, so no function or expression runs.
 * @param {Scanner} s
 * @returns {Value}
 */
function literal(s) {
	s.space()
	const text = s.text
	const c = text[s.at]
	if (c === "'") {
		const value = quotedString(s)
		spend(s.budget, value.length)
		return value
	}
	if ((c === 'X' || c === 'x') && text[s.at + 1] === "'") {
		const end = text.indexOf("'", s.at + 2)
		const hex = end === -1 ? '' : text.slice(s.at + 2, end)
		if (end === -1 || hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) {
			throw new ExportError('invalid-literal')
		}
		spend(s.budget, hex.length / 2)
		const bytes = new Uint8Array(hex.length / 2)
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
		}
		s.at = end + 1
		return bytes
	}
	if (s.keyword('NULL')) {
		return null
	}
	if (s.keyword('TRUE')) {
		return 1n
	}
	if (s.keyword('FALSE')) {
		return 0n
	}
	if (s.keyword('REPLACE')) {
		const value = replaced(s, 1)
		spend(s.budget, value.length)
		return value
	}
	const match = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(text.slice(s.at, s.at + 64))
	if (match === null) {
		throw new ExportError('invalid-literal')
	}
	s.at += match[0].length
	const token = match[0]
	if (/^[-+]?\d+$/.test(token)) {
		const value = BigInt(token)
		if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) {
			throw new ExportError('invalid-literal')
		}
		return value
	}
	return Number(token)
}

/**
 * A quoted string at the cursor.
 * @param {Scanner} s
 */
function quotedString(s) {
	s.space()
	const text = s.text
	if (text[s.at] !== "'") {
		throw new ExportError('invalid-literal')
	}
	const end = skipQuoted(text, s.at)
	if (text[end - 1] !== "'" || end - s.at < 2) {
		throw new ExportError('invalid-literal')
	}
	const value = text.slice(s.at + 1, end - 1).replaceAll("''", "'")
	s.at = end
	return value
}

/**
 * replace(<string or replace(...)>, '<marker>', char(<code>, ...)), after the REPLACE keyword, at most
 * MAX_REPLACE_DEPTH deep. The result's length is computed before the result is built.
 * @param {Scanner} s
 * @param {number} depth
 * @returns {string}
 */
function replaced(s, depth) {
	if (depth > MAX_REPLACE_DEPTH || !s.punct('(')) {
		throw new ExportError('invalid-literal')
	}
	const inner = s.keyword('REPLACE') ? replaced(s, depth + 1) : quotedString(s)
	if (!s.punct(',')) {
		throw new ExportError('invalid-literal')
	}
	const marker = quotedString(s)
	if (marker === '' || !s.punct(',') || !s.keyword('CHAR') || !s.punct('(')) {
		throw new ExportError('invalid-literal')
	}
	const codes = []
	do {
		s.space()
		const match = /^\d{1,7}/.exec(s.text.slice(s.at, s.at + 8))
		const code = match === null ? NaN : Number(match[0])
		if (match === null || code > 0x10ffff || codes.length >= 64) {
			throw new ExportError('invalid-literal')
		}
		s.at += match[0].length
		codes.push(code)
	} while (s.punct(','))
	if (!s.punct(')') || !s.punct(')')) {
		throw new ExportError('invalid-literal')
	}
	const replacement = String.fromCodePoint(...codes)
	const occurrences = inner.split(marker).length - 1
	const length = inner.length + occurrences * (replacement.length - marker.length)
	if (length > MAX_LITERAL_UNITS) {
		throw new ExportError('decoded-data-too-large')
	}
	return inner.split(marker).join(replacement)
}

/**
 * Parses one export statement. Throws ExportError with a fixed code for anything outside the grammar:
 *   PRAGMA defer_foreign_keys|foreign_keys = <word>
 *   CREATE TABLE [IF NOT EXISTS] <name> ( <definition> ) [WITHOUT ROWID | STRICT, ...]
 *   CREATE [UNIQUE] INDEX | TRIGGER | VIEW | VIRTUAL TABLE ...      (ignored, never run)
 *   INSERT INTO <name> [( <column>, ... )] VALUES ( <literal>, ... ) [, ( ... )]...
 * @param {string} statement
 * @param {DecodeBudget} [budget] shared by all statements of one pass over an export
 * @returns {Statement}
 */
export function parseStatement(statement, budget = decodeBudget()) {
	if (/^PRAGMA\s+(defer_foreign_keys|foreign_keys)\s*=\s*\w+$/i.test(statement)) {
		return { kind: 'pragma' }
	}
	if (
		/^CREATE\s+(UNIQUE\s+)?INDEX\b|^CREATE\s+(TEMP\w*\s+)?TRIGGER\b|^CREATE\s+VIEW\b|^CREATE\s+VIRTUAL\s+TABLE\b/i.test(
			statement
		)
	) {
		return { kind: 'ignored' }
	}
	const s = new Scanner(statement)
	if (s.keyword('CREATE') && s.keyword('TABLE')) {
		if (s.keyword('IF') && !(s.keyword('NOT') && s.keyword('EXISTS'))) {
			throw new ExportError('invalid-create-table')
		}
		const table = s.identifier()
		s.space()
		if (statement[s.at] !== '(') {
			throw new ExportError('invalid-create-table')
		}
		// The definition runs to the matching parenthesis; only table options may follow it.
		let depth = 0
		let i = s.at
		for (; i < statement.length; i++) {
			const c = statement[i]
			if (c === "'" || c === '"' || c === '`') {
				i = skipQuoted(statement, i) - 1
			} else if (c === '[') {
				i = statement.indexOf(']', i)
				if (i === -1) {
					throw new ExportError('invalid-create-table')
				}
			} else if (c === '(') {
				depth++
			} else if (c === ')') {
				depth--
				if (depth === 0) {
					break
				}
			}
		}
		const rest = statement.slice(i + 1)
		if (depth !== 0 || !/^\s*((WITHOUT\s+ROWID|STRICT)\s*(,\s*(WITHOUT\s+ROWID|STRICT)\s*)*)?$/i.test(rest)) {
			throw new ExportError('invalid-create-table')
		}
		if (/\bSELECT\b/i.test(statement.slice(s.at, i).replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, ''))) {
			throw new ExportError('invalid-create-table')
		}
		return { kind: 'create-table', table, sql: statement }
	}
	const insert = new Scanner(statement, budget)
	if (insert.keyword('INSERT') && insert.keyword('INTO')) {
		let table = insert.identifier()
		if (table.toLowerCase() === 'main' && insert.punct('.')) {
			table = insert.identifier()
		}
		/** @type {string[] | null} */
		let columns = null
		if (insert.punct('(')) {
			columns = []
			do {
				columns.push(insert.identifier())
			} while (insert.punct(','))
			if (!insert.punct(')')) {
				throw new ExportError('invalid-insert')
			}
		}
		if (!insert.keyword('VALUES')) {
			throw new ExportError('invalid-insert')
		}
		/** @type {Value[][]} */
		const rows = []
		do {
			if (!insert.punct('(')) {
				throw new ExportError('invalid-insert')
			}
			/** @type {Value[]} */
			const values = []
			do {
				values.push(literal(insert))
			} while (insert.punct(','))
			if (!insert.punct(')') || (columns !== null && values.length !== columns.length)) {
				throw new ExportError('invalid-insert')
			}
			rows.push(values)
		} while (insert.punct(','))
		if (!insert.done()) {
			throw new ExportError('invalid-insert')
		}
		return { kind: 'insert', table, columns, rows }
	}
	throw new ExportError('unexpected-statement')
}

/**
 * The DEFAULT, CHECK and generated-column (AS) expressions of a CREATE TABLE statement, in order, each normalized
 * outside string literals (no whitespace or identifier quotes, upper case), so the same definition written with other
 * spacing or quoting compares equal and any other expression does not.
 * @param {string} sql
 * @returns {string[]}
 */
export function tableExpressions(sql) {
	const start = sql.indexOf('(')
	/** @type {string[]} */
	const out = []
	let i = start + 1
	/** @param {number} from */
	const group = (from) => {
		let depth = 0
		for (let j = from; j < sql.length; j++) {
			const c = sql[j]
			if (c === "'" || c === '"' || c === '`') {
				j = skipQuoted(sql, j) - 1
			} else if (c === '(') {
				depth++
			} else if (c === ')') {
				depth--
				if (depth === 0) {
					return j + 1
				}
			}
		}
		return sql.length
	}
	while (start !== -1 && i < sql.length) {
		const c = sql[i] ?? ''
		if (c === "'" || c === '"' || c === '`') {
			i = skipQuoted(sql, i)
			continue
		}
		const word = /^[A-Za-z_]+/.exec(sql.slice(i, i + 16))?.[0]
		if (word === undefined || /[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
			i++
			continue
		}
		const kind = word.toUpperCase()
		i += word.length
		if (kind !== 'DEFAULT' && kind !== 'CHECK' && kind !== 'AS') {
			continue
		}
		while (/\s/.test(sql[i] ?? '')) {
			i++
		}
		let end
		if (sql[i] === '(') {
			end = group(i)
		} else if (sql[i] === "'") {
			end = skipQuoted(sql, i)
		} else {
			end = i + (/^[-+]?[A-Za-z0-9_.]+/.exec(sql.slice(i, i + 64))?.[0].length ?? 0)
		}
		out.push(`${kind} ${normalizeExpression(sql.slice(i, end))}`)
		i = end
	}
	return out
}

/** @param {string} expression */
function normalizeExpression(expression) {
	let out = ''
	for (let i = 0; i < expression.length; i++) {
		const c = expression[i] ?? ''
		if (c === "'") {
			const end = skipQuoted(expression, i)
			out += expression.slice(i, end)
			i = end - 1
		} else if (!/\s/.test(c) && c !== '"' && c !== '`') {
			out += c.toUpperCase()
		}
	}
	return out
}
