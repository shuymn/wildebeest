import { readFileSync } from 'node:fs'
import type { SQLInputValue } from 'node:sqlite'

import { SyntaxKind, type Node, type SourceFile } from 'typescript/unstable/ast'
import {
	isBinaryExpression,
	isCallExpression,
	isCaseClause,
	isElementAccessExpression,
	isIdentifier,
	isIfStatement,
	isNoSubstitutionTemplateLiteral,
	isPropertyAccessExpression,
	isStringLiteral,
	isSwitchStatement,
	isVariableDeclaration,
} from 'typescript/unstable/ast/is'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { API } from 'typescript/unstable/sync'
import { describe, expect, it } from 'vitest'

import { createKopjeDatabase, readCatalog } from '../cli/lib/cutover/kopje-db.js'
import { splitStatements } from '../cli/lib/cutover/sql-script.js'

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

// JavaScript sources, by name, parsed by the TypeScript compiler in a virtual project of their own.
function parse<Name extends string>(sources: Record<Name, string>): Record<Name, SourceFile> {
	const files: Record<string, string> = {
		'/src/tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true, noLib: true }, include: ['*.js'] }),
	}
	for (const [name, text] of Object.entries<string>(sources)) {
		files[`/src/${name}.js`] = text
	}
	const api = new API({ cwd: '/src', fs: createVirtualFileSystem(files) })
	try {
		const program = api.updateSnapshot({ openProject: '/src/tsconfig.json' }).getProjects()[0]?.program
		const parsed = Object.keys(sources).map((name) => [name, program?.getSourceFile(`/src/${name}.js`)] as const)
		if (parsed.some(([, file]) => file === undefined)) {
			throw new Error('a source did not parse')
		}
		return Object.fromEntries(parsed) as Record<Name, SourceFile>
	} finally {
		api.close()
	}
}

function descendants(root: Node): Node[] {
	const all: Node[] = []
	const visit = (node: Node) => {
		all.push(node)
		node.forEachChild(visit)
	}
	root.forEachChild(visit)
	return all
}

const literal = (node: Node | undefined) =>
	node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
const named = (node: Node, name: string) => isIdentifier(node) && node.text === name
const snippet = (node: Node) => node.getText().replace(/\s+/g, ' ')

function enclosedBy(node: Node, test: (ancestor: Node) => boolean): boolean {
	for (let at: Node | undefined = node.parent; at !== undefined; at = at.parent) {
		if (test(at)) {
			return true
		}
	}
	return false
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
		const end = depth === 0 && (c === undefined || /^\sWHERE\s/.test(clause.slice(i, i + 7)))
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

// What convert.js writes to the Kopje database. Its SQL runs through insert(sql), kopje.exec(sql) and
// kopje.prepare(sql) (insert wraps the last); the SQL must be one literal, split into statements by the cutover's own
// splitter. An INSERT or UPDATE adds its columns, an INSERT into kopje_state its one literal name; any other argument,
// statement or kopje_state row is unparsed.
function converterWrites(file: SourceFile) {
	const columns = new Map<string, Set<string>>()
	const stateNames: string[] = []
	const unparsed: string[] = []
	for (const node of descendants(file)) {
		const callee = isCallExpression(node) ? node.expression : undefined
		const runs =
			callee !== undefined &&
			(named(callee, 'insert') ||
				(isPropertyAccessExpression(callee) &&
					named(callee.expression, 'kopje') &&
					['exec', 'prepare'].includes(callee.name.text)))
		if (
			!runs ||
			!isCallExpression(node) ||
			enclosedBy(node, (at) => isVariableDeclaration(at) && named(at.name, 'insert'))
		) {
			continue
		}
		const sql = literal(node.arguments[0])
		for (const statement of sql === undefined ? [] : splitStatements(sql)) {
			const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/.exec(statement)
			const update = /^UPDATE\s+(\w+)\s+SET\s+([\s\S]*)$/.exec(statement)
			const inserted = insert?.[2]?.split(',').map((c) => c.trim())
			const assigned = update === null ? null : assignedColumns(update[2] ?? '')
			const state =
				insert?.[1] === 'kopje_state' ? /^\(\s*'(\w+)'\s*,\s*\?\s*\)$/.exec(insert[3] ?? '')?.[1] : undefined
			if (insert !== null && inserted?.every((c) => /^\w+$/.test(c)) && (insert[1] !== 'kopje_state' || state)) {
				add(columns, insert[1] ?? '', inserted)
				if (state !== undefined) {
					stateNames.push(state)
				}
			} else if (update !== null && assigned !== null && update[1] !== 'kopje_state') {
				add(columns, update[1] ?? '', assigned)
			} else if (!/^(?:SELECT|DELETE|PRAGMA|BEGIN|COMMIT)\b/.test(statement)) {
				unparsed.push(statement)
			}
		}
		if (sql === undefined) {
			unparsed.push(snippet(node))
		}
	}
	return { columns, stateNames, unparsed }
}

const isTableOfStatement = (node: Node) =>
	isPropertyAccessExpression(node) && named(node.expression, 'statement') && node.name.text === 'table'

// The table a node of verify-actual.js reads for: the case clause of `switch (statement.table)` around it, or the
// block of `if (statement.table === 'table')` around it.
function tableOf(node: Node): string | undefined {
	for (let at: Node | undefined = node; at?.parent !== undefined; at = at.parent) {
		const up = at.parent
		if (isCaseClause(at) && isSwitchStatement(up.parent) && isTableOfStatement(up.parent.expression)) {
			return literal(at.expression)
		}
		const test = isIfStatement(up) && up.thenStatement.pos === at.pos ? up.expression : undefined
		if (test !== undefined && isBinaryExpression(test) && isTableOfStatement(test.left)) {
			return test.operatorToken.kind === SyntaxKind.EqualsEqualsEqualsToken ? literal(test.right) : undefined
		}
	}
	return undefined
}

// The columns verify-actual.js reads per table: t('column'), row.column, row['column'], and c === 'column' (a link
// statement's columns). A read outside a case clause or link block, or row[...] by a variable other than where the row
// is built (row[column] = ...) and in t itself, is unattributed.
function verifierReads(file: SourceFile) {
	const columns = new Map<string, Set<string>>()
	const unattributed: string[] = []
	for (const node of descendants(file)) {
		let column: string | undefined
		if (isCallExpression(node) && named(node.expression, 't')) {
			column = literal(node.arguments[0])
		} else if (isPropertyAccessExpression(node) && named(node.expression, 'row')) {
			column = node.name.text
		} else if (isElementAccessExpression(node) && named(node.expression, 'row')) {
			column = literal(node.argumentExpression)
			const built = isBinaryExpression(node.parent) && node.parent.left.pos === node.pos
			if (
				column === undefined &&
				(built || enclosedBy(node, (at) => isVariableDeclaration(at) && named(at.name, 't')))
			) {
				continue
			}
		} else if (isBinaryExpression(node) && named(node.left, 'c')) {
			column = literal(node.right)
		} else {
			continue
		}
		const table = column === undefined ? undefined : tableOf(node)
		if (column === undefined || table === undefined) {
			unattributed.push(snippet(node))
		} else {
			add(columns, table, [column])
		}
	}
	return { columns, unattributed }
}

// The `table.column` names in `columns` that the schema does not have.
function unknown(schema: Map<string, string[]>, columns: Map<string, Set<string>>): string[] {
	return [...columns].flatMap(([table, names]) =>
		[...names].filter((c) => !(schema.get(table) ?? []).includes(c)).map((c) => `${table}.${c}`)
	)
}

const sorted = (names: Iterable<string>) => [...names].sort()

const files = parse({
	convert: source('../cli/lib/cutover/convert.js'),
	verify: source('../cli/lib/cutover/verify-actual.js'),
})

describe('the source scanners', () => {
	const fixtures = parse({
		writes: [
			'const insert = (sql) => kopje.prepare(sql)',
			"kopje.exec('UPDATE statuses SET retired_column = 0')",
			'kopje.prepare("UPDATE accounts SET a = ?, b = (SELECT count(*) FROM f WHERE f.x = \'y,z\') WHERE id = ?")',
			'kopje.exec(`\n\tUPDATE lists SET c = 1;\n\tUPDATE mutes SET d = 2\n`)',
			"insert('INSERT OR IGNORE INTO blocks (e, f) VALUES (?, ?)')",
			'kopje.prepare("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (\'kept\', ?)")',
			"// kopje.exec('UPDATE statuses SET commented = 0')",
			"const message = 'INSERT INTO statuses (new_column) VALUES (1)'",
			"if (failed) throw new Error('UPDATE failed')",
			'kopje.exec(`INSERT INTO ${table} (a) VALUES (1)`)',
			"kopje.exec('UPDATE accounts SET ' + column + ' = 1')",
			'insert(sql)',
			"kopje.prepare(\"INSERT INTO kopje_state (name, value) VALUES ('a', ?), ('b', ?)\")",
		].join('\n'),
		reads: [
			'const shared = (row) => row.some_column',
			'for (const statement of statements) {',
			"\tif (statement.table === 'statuses') {",
			"\t\tstatement.where.find(([c]) => c === 'id')",
			'\t\tcontinue',
			'\t}',
			'\tconst row = {}',
			"\tstatement.columns.forEach((column, i) => { row[column] = statement.literals[i] ?? 'NULL' })",
			'\tconst t = (column) => textOf(row[column])',
			"\tt('stray')",
			'\tswitch (statement.table) {',
			"\t\tcase 'mutes':",
			"\t\t\tput('mutes', [int(row.hide_notifications), null, // t('expires_at'),",
			"\t\t\t\t/* row.commented */ row['quoted'], \"t('in_a_string')\", row[key]])",
			'\t\t\tbreak',
			'\t\tdefault:',
			'\t\t\tbreak',
			'\t}',
			'}',
		].join('\n'),
	})

	it('take SQL only from literal arguments of the calls that run it, statement by statement', () => {
		const { columns, stateNames, unparsed } = converterWrites(fixtures.writes)
		expect(columns).toEqual(
			new Map([
				['statuses', new Set(['retired_column'])],
				['accounts', new Set(['a', 'b'])],
				['lists', new Set(['c'])],
				['mutes', new Set(['d'])],
				['blocks', new Set(['e', 'f'])],
				['kopje_state', new Set(['name', 'value'])],
			])
		)
		expect(stateNames).toEqual(['kept'])
		expect(unparsed).toEqual([
			'kopje.exec(`INSERT INTO ${table} (a) VALUES (1)`)',
			"kopje.exec('UPDATE accounts SET ' + column + ' = 1')",
			'insert(sql)',
			"INSERT INTO kopje_state (name, value) VALUES ('a', ?), ('b', ?)",
		])
	})

	it('attribute reads to their case clause or link block, and report every other read', () => {
		const { columns, unattributed } = verifierReads(fixtures.reads)
		expect(columns).toEqual(
			new Map([
				['statuses', new Set(['id'])],
				['mutes', new Set(['hide_notifications', 'quoted'])],
			])
		)
		expect(unattributed).toEqual(['row.some_column', "t('stray')", 'row[key]'])
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
		const { stateNames, unparsed } = converterWrites(files.convert)
		expect(unparsed).toEqual([])
		expect(stateNames.length).toBeGreaterThan(0)
		expect(stateNames.filter((name) => !DUMPED_STATE.includes(name))).toEqual([])
	})
})

describe('the Store schema in the cutover tools', () => {
	const schema = schemaColumns()
	const { columns: written, unparsed } = converterWrites(files.convert)
	const { columns: read, unattributed } = verifierReads(files.verify)
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
