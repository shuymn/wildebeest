// Splits the SQL scripts that `wrangler d1 export` writes into single statements, and recognizes the few statement
// shapes an export may contain. Statements are never executed as text: the loader routes each INSERT into a staging
// table of its own table and refuses anything else that would change a database.

/**
 * Yields the statements of a script, without their terminating ';' and surrounding whitespace. Quotes ('', "", ``
 * and []) and comments are honored, and a CREATE TRIGGER statement runs to its END.
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
			const close = c
			i++
			while (i < n) {
				if (text[i] === close) {
					if (text[i + 1] === close) {
						i += 2
						continue
					}
					break
				}
				i++
			}
			i++
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

// Removes leading comment lines (the export starts parts with them); comments inside a statement stay.
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

const IDENTIFIER = String.raw`("(?:[^"]|"")+"|\`[^\`]+\`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`

/** @param {string} quoted */
export function unquoteIdentifier(quoted) {
	if (quoted.startsWith('"')) {
		return quoted.slice(1, -1).replaceAll('""', '"')
	}
	if (quoted.startsWith('`') || quoted.startsWith('[')) {
		return quoted.slice(1, -1)
	}
	return quoted
}

/** @param {string} name */
export function quoteIdentifier(name) {
	return `"${name.replaceAll('"', '""')}"`
}

/**
 * @typedef {{ kind: 'pragma' } | { kind: 'create-table', table: string, sql: string }
 *   | { kind: 'create-other' } | { kind: 'insert', table: string, hasColumns: boolean, rest: string }
 *   | { kind: 'other' }} Statement
 */

const INSERT = new RegExp(String.raw`^INSERT\s+INTO\s+(?:main\.)?${IDENTIFIER}\s*`, 'i')
const CREATE_TABLE = new RegExp(String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`, 'i')

/**
 * @param {string} statement
 * @returns {Statement}
 */
export function classify(statement) {
	if (/^PRAGMA\s+(defer_foreign_keys|foreign_keys)\s*=\s*\w+$/i.test(statement)) {
		return { kind: 'pragma' }
	}
	const insert = INSERT.exec(statement)
	if (insert !== null) {
		const rest = statement.slice(insert[0].length)
		return { kind: 'insert', table: unquoteIdentifier(insert[1] ?? ''), hasColumns: rest.startsWith('('), rest }
	}
	const create = CREATE_TABLE.exec(statement)
	if (create !== null) {
		return { kind: 'create-table', table: unquoteIdentifier(create[1] ?? ''), sql: statement }
	}
	if (/^CREATE\s+(UNIQUE\s+)?INDEX\b|^CREATE\s+(TEMP\w*\s+)?TRIGGER\b|^CREATE\s+VIEW\b/i.test(statement)) {
		return { kind: 'create-other' }
	}
	return { kind: 'other' }
}
