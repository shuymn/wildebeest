import { type SqlToken, tokenizeSql } from '../src/platform/readonly-sql'

// Lints of migration SQL (test/migration-lint.test.ts), over the tokens of src/platform/readonly-sql.ts, so comments,
// strings and quoted identifiers never hide a keyword or pass for one. Their threat assumption: Migration in
// src/platform/store-kernel.ts.

const isWord = (token: SqlToken | undefined, text: string): boolean => token?.kind === 'word' && token.text === text

// Every migration: no PRAGMA statement and no DEFERRABLE clause.
export function forbiddenProblem(sql: string): string | null {
	const tokens = tokenizeSql(sql)
	if (typeof tokens === 'string') {
		return tokens
	}
	const found = tokens.find((t) => isWord(t, 'PRAGMA') || isWord(t, 'DEFERRABLE'))
	return found === undefined ? null : `${found.text} is not allowed in a migration`
}

type Statement = { tokens: SqlToken[]; trigger: boolean }

const BLOCK_WORDS = new Set(['BEGIN', 'CASE', 'END'])

function startsTrigger(tokens: SqlToken[]): boolean {
	return (
		isWord(tokens[0], 'CREATE') &&
		(isWord(tokens[1], 'TRIGGER') ||
			((isWord(tokens[1], 'TEMP') || isWord(tokens[1], 'TEMPORARY')) && isWord(tokens[2], 'TRIGGER')))
	)
}

// The top-level statements, split at each ';'. Only a CREATE [TEMP] TRIGGER statement holds blocks: its one BEGIN
// opens the body, each CASE opens an expression, and END closes the innermost; the body's END must end the statement.
// Elsewhere BEGIN, CASE and END are refused, so a word that SQLite reads as an identifier (`AS begin`, a column named
// end) can neither open nor close a block. Refused too: unquoted non-ASCII and a word the tokenizer split (longer than
// its 256 characters), since SQLite reads either as part of one identifier.
function statements(sql: string, tokens: SqlToken[]): Statement[] | string {
	const out: Statement[] = []
	let current: SqlToken[] = []
	let blocks: ('BEGIN' | 'CASE')[] = []
	let body: 'none' | 'open' | 'closed' = 'none'
	const end = (): string | null => {
		const trigger = startsTrigger(current)
		if (trigger && (blocks.length > 0 || body !== 'closed')) {
			return 'a trigger statement must end with the END of its body'
		}
		if (current.length > 0) {
			out.push({ tokens: current, trigger })
		}
		current = []
		blocks = []
		body = 'none'
		return null
	}
	for (const [i, t] of tokens.entries()) {
		if (t.kind === 'punct' && t.text.charCodeAt(0) > 0x7f) {
			return 'unquoted non-ASCII is not allowed'
		}
		if ((t.kind === 'word' || (t.kind === 'other' && t.text === '0')) && /[A-Za-z0-9_$]/.test(sql[t.at - 1] ?? '')) {
			return 'an unquoted identifier longer than 256 characters is not allowed'
		}
		if (t.kind === 'punct' && t.text === ';' && blocks.length === 0) {
			const problem = end()
			if (problem !== null) {
				return problem
			}
			continue
		}
		current.push(t)
		if (t.kind !== 'word' || !BLOCK_WORDS.has(t.text)) {
			continue
		}
		if (!startsTrigger(current)) {
			return `${t.text} is allowed only in a trigger statement`
		}
		if (body === 'closed') {
			return `${t.text} after the END of a trigger's body`
		}
		if (t.text === 'CASE') {
			blocks.push('CASE')
		} else if (t.text === 'BEGIN') {
			if (body !== 'none' || blocks.length > 0) {
				return 'BEGIN is allowed only once in a trigger statement, to open its body'
			}
			blocks.push('BEGIN')
			body = 'open'
		} else {
			const closed = blocks.pop()
			if (closed === undefined) {
				return 'END without a BEGIN or CASE'
			}
			const next = tokens[i + 1]
			if (closed === 'BEGIN') {
				if (next !== undefined && !(next.kind === 'punct' && next.text === ';')) {
					return "a trigger's body must end its statement"
				}
				body = 'closed'
			}
		}
	}
	return blocks.length > 0 ? 'unterminated BEGIN or CASE' : (end() ?? out)
}

const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'SELECT', 'WITH'])

// A file declared foreignKeys: 'unchanged' may hold only statements that cannot change a reference or a key:
//   ALTER TABLE <name> ADD [COLUMN] ... with no REFERENCES and no generated column (GENERATED, or AS followed by '(');
//   CREATE TRIGGER (its body's writes are checked as they run) and DROP TRIGGER (a trigger holds no key or
//   reference); CREATE INDEX that is not UNIQUE;
//   DML (INSERT, UPDATE, DELETE, REPLACE, SELECT, WITH), checked statement by statement (foreign keys are immediate,
//   and no migration may defer them).
// Anything else (CREATE TABLE or VIEW, CREATE UNIQUE INDEX, DROP, RENAME, DROP COLUMN, TEMP objects, ...) is refused,
// and so is a trigger named BEGIN, CASE or END.
export function unchangedProblem(sql: string): string | null {
	const tokens = tokenizeSql(sql)
	if (typeof tokens === 'string') {
		return tokens
	}
	const split = statements(sql, tokens)
	if (typeof split === 'string') {
		return split
	}
	for (const { tokens: s, trigger } of split) {
		const word = (i: number) => (s[i]?.kind === 'word' ? s[i].text : null)
		if (trigger) {
			if (word(1) !== 'TRIGGER') {
				return `CREATE ${word(1) ?? ''} TRIGGER is not allowed`
			}
			let name = isWord(s[2], 'IF') && isWord(s[3], 'NOT') && isWord(s[4], 'EXISTS') ? 5 : 2
			if (s[name + 1]?.kind === 'punct' && s[name + 1]?.text === '.') {
				name += 2
			}
			if (BLOCK_WORDS.has(word(name) ?? '')) {
				return `a trigger named ${word(name)} is not allowed`
			}
		} else if (word(0) === 'ALTER') {
			const add = word(1) === 'TABLE' && s[2] !== undefined && s[2].kind !== 'punct' && word(3) === 'ADD'
			const generated = s.some(
				(t, i) => isWord(t, 'GENERATED') || (isWord(t, 'AS') && s[i + 1]?.kind === 'punct' && s[i + 1]?.text === '(')
			)
			if (!add || generated || s.some((t) => isWord(t, 'REFERENCES'))) {
				return 'only ALTER TABLE ... ADD COLUMN without REFERENCES or a generated column is allowed'
			}
		} else if (word(0) === 'CREATE') {
			if (word(1) !== 'INDEX') {
				return `CREATE ${word(1) ?? ''} is not allowed`
			}
		} else if (word(0) === 'DROP' && word(1) === 'TRIGGER') {
			continue
		} else if (!DML.has(word(0) ?? '')) {
			return `${word(0) ?? s[0]?.text ?? ''} is not allowed`
		}
	}
	return null
}
