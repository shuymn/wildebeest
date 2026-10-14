import { readFileSync } from 'node:fs'
import type { SQLInputValue } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { createKopjeDatabase, readCatalog } from '../cli/lib/cutover/kopje-db.js'

// Every table and column of the migrated Store schema against the cutover tools that name them by hand: the converter
// (convert.js) writes columns of the Store schema, and the actual side of verify-conversion (verify-actual.js) reads
// them back from a dump. A migration that adds a table or column fails here until each tool handles it or a list below
// says why that tool leaves it alone. The dump, import and backup read their catalog from the live schema
// (src/platform/dump-catalog.ts, and its copy for the converter in cli/lib/cutover/kopje-db.js); both run here, so a
// table either leaves out must be in NOT_DUMPED.

// Tables neither dump catalog includes, each with why (the other tables are dumped and restored whole).
const NOT_DUMPED: Record<string, string> = {
	backup_media: "the backup's media index for one bucket; a restored Store starts a fresh media baseline",
	kopje_migrations: 'the dump header carries the applied migrations; the target records its own',
	media_orphans: 'tombstones of R2 objects to delete; a restored Store must not delete what it restores',
}

// Tables the cutover never carries: the converter writes nothing to them (docs/cutover.md, "Clients and settings").
const NOT_CARRIED: Record<string, string> = {
	backup_media: 'the backup media index of one bucket; a converted Store starts a fresh baseline',
	deliveries: 'outbound queue; legacy queues are not carried',
	domain_block_cleanups: 'pending work of a domain block made in Kopje',
	fedify_kv: 'federation cache',
	inbound_jobs: 'inbound queue; legacy queues are not carried',
	inbound_retractions: 'inbound queue state',
	inbound_spool: 'inbound queue state',
	kopje_migrations: 'the target Store records its own migrations',
	media_orphans: 'tombstones of R2 objects; a converted Store has none',
	oauth_tokens: 'access tokens are not carried: users sign in again',
	outbound_activities: 'outbound queue; legacy queues are not carried',
	outbound_receipts: 'records of deliveries made by Kopje',
	outbound_targets: 'outbound queue; legacy queues are not carried',
	push_deliveries: 'push queue; legacy has no such data',
	push_subscriptions: 'push subscriptions are not carried: clients register again',
	remote_keys: 'fetched again on demand',
}

const ASSIGNED = 'INTEGER PRIMARY KEY, assigned on insert'
const DEFAULT = 'left at its default by the converter (NOT_CONVERTED)'

// Columns of carried tables the converter leaves at their schema defaults.
const NOT_CONVERTED: Record<string, string> = {
	'accounts.confirmed_username': 'set when Kopje confirms a WebFinger domain; legacy has none',
	'blocks.id': ASSIGNED,
	'bookmarks.id': ASSIGNED,
	'domain_blocks.id': ASSIGNED,
	'favourites.id': ASSIGNED,
	'follows.id': ASSIGNED,
	'local_accounts.fields': 'legacy has no profile fields',
	'local_accounts.suspended_at': 'legacy has no suspension',
	'media_attachments.focus_x': 'legacy has no focal point',
	'media_attachments.focus_y': 'legacy has no focal point',
	'media_attachments.gc_at': 'converted media is kept: attached, or a profile or earlier-version image',
	'mutes.expires_at': 'legacy mutes never expire',
	'mutes.id': ASSIGNED,
	'status_edits.id': ASSIGNED,
	'statuses.withdrawn': 'marks an Undo Kopje recorded; legacy has none',
}

const ID = 'assigned by the converter; records are keyed by AP URIs, never by assigned ids'
const TIME = 'row time (legacy cdate or the base time); only published_at is compared'
const COUNTER = 'recomputed from carried rows, which are compared'
const SEARCH = 'search text derived from compared columns'
const FROM_RAW = 'remote: read from raw, which is compared byte for byte; local: NULL'
const OUTSIDE = "carried from legacy, outside verify-conversion's categories (docs/cutover.md, Verification)"

// Columns of carried tables verify-conversion does not compare.
const NOT_VERIFIED: Record<string, string> = {
	'accounts.actor_type': OUTSIDE,
	'accounts.confirmed_username': DEFAULT,
	'accounts.created_at': TIME,
	'accounts.discoverable': OUTSIDE,
	'accounts.fetched_at': TIME,
	'accounts.followers_count': COUNTER,
	'accounts.following_count': COUNTER,
	'accounts.inbox_url': FROM_RAW,
	'accounts.search_text': SEARCH,
	'accounts.shared_inbox_url': FROM_RAW,
	'accounts.statuses_count': COUNTER,
	'accounts.url': FROM_RAW,
	'blocks.created_at': TIME,
	'blocks.id': DEFAULT,
	'blocks.uri': OUTSIDE,
	'bookmarks.created_at': TIME,
	'bookmarks.id': DEFAULT,
	'domain_blocks.created_at': TIME,
	'domain_blocks.id': DEFAULT,
	'favourites.created_at': TIME,
	'favourites.id': DEFAULT,
	'favourites.uri': OUTSIDE,
	'follows.created_at': TIME,
	'follows.id': DEFAULT,
	'follows.languages': OUTSIDE,
	'lists.created_at': TIME,
	'local_accounts.also_known_as': OUTSIDE,
	'local_accounts.created_at': TIME,
	'local_accounts.default_language': OUTSIDE,
	'local_accounts.default_sensitive': OUTSIDE,
	'local_accounts.default_visibility': OUTSIDE,
	'local_accounts.fields': DEFAULT,
	'local_accounts.suspended_at': DEFAULT,
	'media_attachments.created_at': TIME,
	'media_attachments.focus_x': DEFAULT,
	'media_attachments.focus_y': DEFAULT,
	'media_attachments.gc_at': DEFAULT,
	'media_attachments.id': ID,
	'media_attachments.processed': 'always 1: converted media needs no processing',
	'media_attachments.type': OUTSIDE,
	'mutes.created_at': TIME,
	'mutes.id': DEFAULT,
	'notifications.created_at': TIME,
	'oauth_clients.created_at': TIME,
	'oauth_clients.website': OUTSIDE,
	'status_edits.created_at': TIME,
	'status_edits.id': DEFAULT,
	'status_tags.name': OUTSIDE,
	'status_tags.status_id': OUTSIDE,
	'statuses.client_key': OUTSIDE,
	'statuses.created_at': TIME,
	'statuses.edited_at': OUTSIDE,
	'statuses.favourites_count': COUNTER,
	'statuses.in_reply_to_account_id': 'derived from the reply links and authors, which are compared',
	'statuses.language': OUTSIDE,
	'statuses.reblogs_count': COUNTER,
	'statuses.remote_version': 'remote: published_at, or edited_at when edited; local: NULL',
	'statuses.replies_count': COUNTER,
	'statuses.search_text': SEARCH,
	'statuses.url': FROM_RAW,
	'statuses.withdrawn': DEFAULT,
}

// Table name to its visible columns, as a Store migrated by every shipped migration has them.
function schemaColumns(): Map<string, string[]> {
	const db = createKopjeDatabase()
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
		name: string
	}[]
	const columns = new Map(
		tables.map(({ name }) => {
			const info = db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid').all(name)
			return [name, (info as { name: string }[]).map((c) => c.name)] as const
		})
	)
	db.close()
	return columns
}

function source(path: string): string {
	return readFileSync(new URL(path, import.meta.url), 'utf8')
}

function add(into: Map<string, Set<string>>, table: string, columns: Iterable<string>) {
	const set = into.get(table) ?? new Set<string>()
	for (const column of columns) {
		set.add(column)
	}
	into.set(table, set)
}

// A JavaScript source split into its code, with comments blanked out (offsets kept), and the text of its string and
// template literals, a template's substitutions as `${}`. A `/` after an operator, a bracket or a keyword starts a
// regular expression literal, as in JavaScript.
function scan(text: string): { code: string; literals: string[] } {
	const literals: string[] = []
	let code = ''
	let last = ''
	let i = 0
	while (i < text.length) {
		const c = text[i] ?? ''
		const next = text[i + 1]
		if (c === '/' && (next === '/' || next === '*')) {
			const close = next === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2) + 2
			const end = close < i + 2 ? text.length : close
			code += text.slice(i, end).replace(/[^\n]/g, ' ')
			i = end
		} else if (c === "'" || c === '"' || c === '`') {
			const end = literalEnd(text, i, literals)
			code += text.slice(i, end)
			last = c
			i = end
		} else if (c === '/' && (/^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /\b(?:return|typeof|case)\s*$/.test(code))) {
			let j = i + 1
			for (let inClass = false; j < text.length && (inClass || text[j] !== '/'); j++) {
				if (text[j] === '\\') {
					j++
				} else if (text[j] === '[' || text[j] === ']') {
					inClass = text[j] === '['
				}
			}
			code += text.slice(i, j + 1)
			last = '/'
			i = j + 1
		} else {
			code += c
			last = /\s/.test(c) ? last : c
			i++
		}
	}
	return { code, literals }
}

// The end of the string or template literal at `start`; pushes its text to `literals`.
function literalEnd(text: string, start: number, literals: string[]): number {
	const quote = text[start]
	let value = ''
	let i = start + 1
	while (i < text.length && text[i] !== quote) {
		if (text[i] === '\\') {
			value += text.slice(i, i + 2)
			i += 2
		} else if (quote === '`' && text.startsWith('${', i)) {
			// A substitution: skip to its closing brace, past nested braces and literals.
			let depth = 0
			for (i += 2; i < text.length && (depth > 0 || text[i] !== '}'); i++) {
				const c = text[i]
				if (c === "'" || c === '"' || c === '`') {
					i = literalEnd(text, i, []) - 1
				}
				depth += c === '{' ? 1 : c === '}' ? -1 : 0
			}
			value += '${}'
			i++
		} else {
			value += text[i]
			i++
		}
	}
	literals.push(value)
	return i + 1
}

// The assigned columns of an UPDATE's SET clause, up to its WHERE or end; null when an assignment has another form.
function assignedColumns(clause: string): string[] | null {
	const assigned: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i <= clause.length; i++) {
		const c = clause[i]
		if (c === "'") {
			i = clause.indexOf("'", i + 1)
			if (i === -1) {
				return null
			}
			continue
		}
		depth += c === '(' ? 1 : c === ')' ? -1 : 0
		const end = depth === 0 && (c === undefined || c === ';' || /^\sWHERE\s/.test(clause.slice(i, i + 7)))
		if (depth === 0 && (c === ',' || end)) {
			const column = /^\s*(\w+)\s*=/.exec(clause.slice(start, i))?.[1]
			if (column === undefined) {
				return null
			}
			assigned.push(column)
			start = i + 1
		}
		if (end) {
			return assigned
		}
	}
	return null
}

// The columns each INSERT and UPDATE in the string and template literals of a source names. A literal with INSERT or
// UPDATE in another form (a table or column list from a substitution, say) is returned as unparsed.
function writtenColumns(text: string): { columns: Map<string, Set<string>>; unparsed: string[] } {
	const columns = new Map<string, Set<string>>()
	const unparsed: string[] = []
	for (const sql of scan(text).literals) {
		for (const m of sql.matchAll(/\b(?:INSERT|UPDATE)\b/g)) {
			const rest = sql.slice(m.index)
			const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/.exec(rest)
			const insertColumns = insert?.[2]?.split(',').map((c) => c.trim())
			const update = /^UPDATE\s+(\w+)\s+SET\s/.exec(rest)
			const updateColumns = update === null ? null : assignedColumns(rest.slice(update[0].length))
			if (insert !== null && insertColumns?.every((c) => /^\w+$/.test(c))) {
				add(columns, insert[1] ?? '', insertColumns)
			} else if (update !== null && updateColumns !== null) {
				add(columns, update[1] ?? '', updateColumns)
			} else {
				unparsed.push(rest.slice(0, 80))
			}
		}
	}
	return { columns, unparsed }
}

// A column read in verify-actual.js: t('column'), row.column, row['column'] or c === 'column' (a link statement's
// columns), or row[...] by any other key.
const COLUMN_READ = /\bt\('(\w+)'\)|\brow\.(\w+)|\brow\['(\w+)'\]|\bc === '(\w+)'|\brow\[/g
// The two places that index the row by a variable: where it is built, and t, whose callers name the column.
const ROW_BY_VARIABLE = ['row[column] = statement.literals[i]', 'textOf(row[column])']

// The columns verify-actual.js reads per table, from its code without comments: each `case 'table':` of its switch and
// each `statement.table === 'table'` branch runs to the next one (the last to `default:`). A read outside them (in a
// shared helper, say) belongs to no table and is returned as unattributed.
function readColumns(text: string): { columns: Map<string, Set<string>>; unattributed: string[] } {
	const { code } = scan(text)
	const columns = new Map<string, Set<string>>()
	const unattributed: string[] = []
	const starts = [...code.matchAll(/case '(\w+)':|statement\.table === '(\w+)'/g)]
	const stop = code.indexOf('default:', starts.at(-1)?.index ?? 0)
	const regions = starts.map((m, i) => ({
		table: m[1] ?? m[2] ?? '',
		start: m.index,
		end: starts[i + 1]?.index ?? stop,
	}))
	for (const m of code.matchAll(COLUMN_READ)) {
		const column = m[1] ?? m[2] ?? m[3] ?? m[4]
		const region = regions.find((r) => r.start <= m.index && m.index < r.end)
		if (column === undefined && ROW_BY_VARIABLE.some((form) => code.startsWith(form, m.index - form.indexOf('row[')))) {
			continue
		}
		if (column === undefined || region === undefined) {
			unattributed.push(column === undefined ? code.slice(m.index, code.indexOf(']', m.index) + 1) : m[0])
		} else {
			add(columns, region.table, [column])
		}
	}
	return { columns, unattributed }
}

// The kopje_state names a source writes: every literal naming kopje_state must be an INSERT of a literal name.
function stateNames(text: string): { names: string[]; unparsed: string[] } {
	const names: string[] = []
	const unparsed: string[] = []
	for (const sql of scan(text).literals.filter((literal) => literal.includes('kopje_state'))) {
		const name = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+kopje_state\s*\(name,\s*value\)\s*VALUES\s*\('(\w+)',/.exec(sql)?.[1]
		if (name === undefined) {
			unparsed.push(sql.slice(0, 80))
		} else {
			names.push(name)
		}
	}
	return { names, unparsed }
}

// The `table.column` names in `columns` that the schema does not have.
function unknown(schema: Map<string, string[]>, columns: Map<string, Set<string>>): string[] {
	return [...columns].flatMap(([table, names]) =>
		[...names].filter((c) => !(schema.get(table) ?? []).includes(c)).map((c) => `${table}.${c}`)
	)
}

const sorted = (names: Iterable<string>) => [...names].sort()

describe('the write scanner', () => {
	it('reads INSERT and UPDATE in every quote style, with or without WHERE or a semicolon', () => {
		const source = [
			"kopje.exec('UPDATE statuses SET retired_column = 0')",
			'kopje.prepare("UPDATE accounts SET a = ?, b = (SELECT count(*) FROM f WHERE f.x = \'y,z\') WHERE id = ?")',
			'kopje.exec(`\n\tUPDATE lists SET c = 1;\n\tUPDATE mutes SET d = 2\n`)',
			"insert('INSERT OR IGNORE INTO blocks (e, f) VALUES (?, ?)')",
			'insert(`INSERT INTO follows (g,\n\th) VALUES (${a}, ${"x"})`)',
		].join('\n')
		expect(writtenColumns(source)).toEqual({
			columns: new Map([
				['statuses', new Set(['retired_column'])],
				['accounts', new Set(['a', 'b'])],
				['lists', new Set(['c'])],
				['mutes', new Set(['d'])],
				['blocks', new Set(['e', 'f'])],
				['follows', new Set(['g', 'h'])],
			]),
			unparsed: [],
		})
	})

	it('ignores comments and regular expressions, and reports SQL it cannot read', () => {
		const source = [
			"// kopje.exec('UPDATE statuses SET commented = 0')",
			"/* insert('INSERT INTO blocks (commented) VALUES (1)') */",
			"const quote = /'/g",
			'kopje.exec(`INSERT INTO ${table} (a) VALUES (1)`)',
			"kopje.exec('UPDATE accounts SET ' + column + ' = 1')",
		].join('\n')
		expect(writtenColumns(source).columns).toEqual(new Map())
		expect(writtenColumns(source).unparsed).toEqual(['INSERT INTO ${} (a) VALUES (1)', 'UPDATE accounts SET '])
	})
})

describe('the read scanner', () => {
	const switchOver = (cases: string, before = '') =>
		[
			before,
			'for (const statement of statements) {',
			"\tif (statement.table === 'statuses') {",
			"\t\tconst id = statement.where.find(([c]) => c === 'id')",
			'\t\tcontinue',
			'\t}',
			'\tconst row = {}',
			"\tstatement.columns.forEach((column, i) => { row[column] = statement.literals[i] ?? 'NULL' })",
			'\tconst t = (column) => textOf(row[column])',
			'\tswitch (statement.table) {',
			cases,
			'\t\tdefault:',
			'\t\t\tbreak',
			'\t}',
			'}',
		].join('\n')

	it('attributes reads to the case or link branch they are in, and skips comments', () => {
		const source = switchOver(
			[
				"\t\tcase 'mutes':",
				"\t\t\tput('mutes', [int(row.hide_notifications), null, // t('expires_at'),",
				"\t\t\t\t/* row.commented */ row['quoted']])",
				'\t\t\tbreak',
			].join('\n')
		)
		expect(readColumns(source)).toEqual({
			columns: new Map([
				['statuses', new Set(['id'])],
				['mutes', new Set(['hide_notifications', 'quoted'])],
			]),
			unattributed: [],
		})
	})

	it('reports a read outside every case, and a row indexed by a variable', () => {
		const source = switchOver(
			["\t\tcase 'mutes':", "\t\t\tput('mutes', [shared(row), row[key]])", '\t\t\tbreak'].join('\n'),
			'const shared = (row) => row.some_column'
		)
		expect(readColumns(source).unattributed).toEqual(['row.some_column', 'row[key]'])
	})
})

describe('the dump catalogs', () => {
	// The Store's catalog code, loaded by a computed path: test-node's tsconfig lacks the Workers types it is checked
	// with (the package's own tsc run checks it). Its SqlStorage is a thin adapter over the node database.
	const store = import(`../src/platform/${'dump-catalog'}.ts`) as Promise<{
		readCatalog: (sql: {
			exec: (query: string, ...bindings: SQLInputValue[]) => { toArray: () => unknown[] }
		}) => unknown
		DUMPED_STATE: readonly string[]
	}>

	it('match, and leave out only the tables NOT_DUMPED says why for', async () => {
		const db = createKopjeDatabase()
		const exec = (query: string, ...bindings: SQLInputValue[]) => ({
			toArray: () => db.prepare(query).all(...bindings),
		})
		const catalog = readCatalog(db)
		expect((await store).readCatalog({ exec })).toEqual(catalog)
		const dumped = new Set(catalog.map((spec) => spec.name))
		const left = [...schemaColumns().keys()].filter((table) => !dumped.has(table))
		expect(sorted(left)).toEqual(sorted(Object.keys(NOT_DUMPED)))
	})

	it('keep every kopje_state name the converter writes', async () => {
		const { DUMPED_STATE } = await store
		const { names, unparsed } = stateNames(source('../cli/lib/cutover/convert.js'))
		expect(unparsed).toEqual([])
		expect(names.length).toBeGreaterThan(0)
		expect(names.filter((name) => !DUMPED_STATE.includes(name))).toEqual([])
	})
})

describe('the Store schema in the cutover tools', () => {
	const schema = schemaColumns()
	const { columns: written, unparsed } = writtenColumns(source('../cli/lib/cutover/convert.js'))
	const { columns: read, unattributed } = readColumns(source('../cli/lib/cutover/verify-actual.js'))
	const carried = [...schema.keys()].filter((table) => !(table in NOT_CARRIED))

	it('names only tables and columns the schema has', () => {
		expect(unknown(schema, written)).toEqual([])
		expect(unknown(schema, read)).toEqual([])
		expect(sorted(Object.keys(NOT_CARRIED).filter((t) => !schema.has(t)))).toEqual([])
	})

	it('convert writes each table the cutover carries, and each of its columns or says why not', () => {
		expect(unparsed).toEqual([])
		expect(sorted(written.keys())).toEqual(sorted(carried))
		const unwritten = carried.flatMap((table) =>
			(schema.get(table) ?? []).filter((c) => !written.get(table)?.has(c)).map((c) => `${table}.${c}`)
		)
		expect(sorted(unwritten)).toEqual(sorted(Object.keys(NOT_CONVERTED)))
	})

	it('verify-conversion reads each column of the tables the cutover carries, or says why not', () => {
		expect(unattributed).toEqual([])
		expect(sorted([...read.keys()].filter((table) => table in NOT_CARRIED))).toEqual([])
		const unread = carried.flatMap((table) =>
			(schema.get(table) ?? []).filter((c) => !read.get(table)?.has(c)).map((c) => `${table}.${c}`)
		)
		expect(sorted(unread)).toEqual(sorted(Object.keys(NOT_VERIFIED)))
	})
})
