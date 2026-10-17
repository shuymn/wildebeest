import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// RES-2: a column a remote server controls (or a converted row may carry past today's ingestion bounds) leaves SQLite
// only through its projection helper (src/domain/profile-bounds.ts, src/domain/status-bounds.ts), which bounds it.
// This test reads every SQL string in src/domain and fails on a raw read.
//
// - Reading is naming the column in a SELECT's result list (a subquery's included) or in RETURNING; a reference inside
//   a helper call's argument is the helper's. Comparing is naming it anywhere else: WHERE, ON, ORDER BY, GROUP BY, a
//   write's SET or VALUES. INSERT ... SELECT copies values inside SQLite, so its SELECT is no read.
// - A SQL string is a string or template literal naming SELECT or RETURNING. An interpolated constant of the module
//   (or of another src/domain module, by its unique name) is inlined, so ACCOUNT_COLUMNS and STATUS_FROM are read
//   where they are used; a helper call (by its own name) is a bounded value.
// - Fail closed: any other interpolation inside a result list or RETURNING is a finding (`interpolation <expression>`)
//   unless it names a builder of SAFE_INTERPOLATIONS, so neither an import alias nor an interpolated string hides a
//   column; so are a string with SQL keywords joined by `+` (`concatenated SQL`) and a bounded column named as a
//   property value (`column <alias.column>`), which SQL built elsewhere selects.
// - Tables are found by name from FROM and JOIN, with their aliases. A bare column counts when a table of the SELECT
//   has it; `*` and `alias.*` count when such a table has a bounded column.
// - ALLOWED lists, per module, the findings that present nothing, with their reason and exact count.

type Bounded = { table: string; column: string; helpers: readonly string[] }

export const BOUNDED: readonly Bounded[] = [
	{ table: 'accounts', column: 'note', helpers: ['noteSql'] },
	{ table: 'accounts', column: 'display_name', helpers: ['displayNameSql'] },
	{ table: 'accounts', column: 'username', helpers: ['usernameSql'] },
	{ table: 'accounts', column: 'url', helpers: ['profileUrlSql'] },
	{ table: 'accounts', column: 'avatar_url', helpers: ['profileUrlSql'] },
	{ table: 'accounts', column: 'header_url', helpers: ['profileUrlSql'] },
	{ table: 'accounts', column: 'uri', helpers: ['actorUriSql'] },
	{ table: 'statuses', column: 'content', helpers: ['contentSql'] },
	{ table: 'statuses', column: 'spoiler_text', helpers: ['spoilerSql'] },
	{ table: 'statuses', column: 'source_text', helpers: ['sourceTextSql'] },
	{ table: 'statuses', column: 'url', helpers: ['statusUrlSql'] },
	{ table: 'statuses', column: 'uri', helpers: ['statusUriSql'] },
	{ table: 'media_attachments', column: 'description', helpers: ['mediaDescriptionSql'] },
	{ table: 'media_attachments', column: 'url', helpers: ['mediaUrlSql'] },
	{ table: 'media_attachments', column: 'preview_url', helpers: ['mediaUrlSql'] },
	{ table: 'media_attachments', column: 'meta', helpers: ['mediaMetaSql'] },
	{ table: 'status_edits', column: 'content', helpers: ['contentSql'] },
	{ table: 'status_edits', column: 'spoiler_text', helpers: ['spoilerSql'] },
	{ table: 'status_edits', column: 'media_json', helpers: ['editMediaSql'] },
	{ table: 'status_edits', column: 'poll_options', helpers: ['pollOptionsSql'] },
	{ table: 'polls', column: 'options', helpers: ['pollOptionsSql'] },
	{ table: 'status_tags', column: 'name', helpers: ['tagNameSql'] },
]

const HELPERS = new Set(BOUNDED.flatMap((b) => b.helpers))
const COLUMNS = new Map<string, Set<string>>()
for (const { table, column } of BOUNDED) {
	COLUMNS.set(table, (COLUMNS.get(table) ?? new Set()).add(column))
}

// ---- SQL text

const TOKEN =
	/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|[A-Za-z_]\w*\.\*|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?|\?\d*|[(),;*]|\S/g

const CLAUSE_END = new Set(['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT'])
const NOT_ALIAS = new Set([
	...CLAUSE_END,
	'ON',
	'USING',
	'JOIN',
	'LEFT',
	'RIGHT',
	'INNER',
	'OUTER',
	'CROSS',
	'NATURAL',
	'FULL',
	'INDEXED',
	'NOT',
	'RETURNING',
])

function tokens(sql: string): string[] {
	return (sql.match(TOKEN) ?? []).filter((t) => !t.startsWith('--'))
}

// The index of the parenthesis that closes the one at `open`.
function closing(list: readonly string[], open: number): number {
	let depth = 0
	for (let i = open; i < list.length; i++) {
		if (list[i] === '(') {
			depth++
		} else if (list[i] === ')' && --depth === 0) {
			return i
		}
	}
	return list.length
}

// The tables a FROM clause names (`list` from FROM to the clause's end, at one depth), by alias and by name.
function tablesOf(list: readonly string[]): Map<string, string> {
	const tables = new Map<string, string>()
	for (let i = 0; i < list.length; i++) {
		const token = list[i]!
		if (token === '(') {
			i = closing(list, i)
			continue
		}
		const upper = token.toUpperCase()
		if (upper !== 'FROM' && upper !== 'JOIN' && token !== ',') {
			continue
		}
		const name = list[i + 1]
		if (name === undefined || name === '(' || !/^[A-Za-z_]\w*$/.test(name)) {
			continue
		}
		let next = i + 2
		if (list[next] === '(') {
			next = closing(list, next) + 1
		}
		const table = name.toLowerCase()
		tables.set(table, table)
		if (list[next]?.toUpperCase() === 'AS') {
			next++
		}
		const alias = list[next]
		if (alias !== undefined && /^[A-Za-z_]\w*$/.test(alias) && !NOT_ALIAS.has(alias.toUpperCase())) {
			tables.set(alias.toLowerCase(), table)
		}
	}
	return tables
}

// The bounded columns `list` (a result list, subqueries skipped) reads from `tables`.
function readsOf(list: readonly string[], tables: Map<string, string>): string[] {
	const found: string[] = []
	const named = [...new Set(tables.values())]
	for (let i = 0; i < list.length; i++) {
		const token = list[i]!
		if (token === '(' && list[i + 1]?.toUpperCase() === 'SELECT') {
			i = closing(list, i)
			continue
		}
		const previous = list[i - 1]?.toUpperCase()
		const opaque = /^__expr(\d+)__$/.exec(token)
		if (opaque !== null) {
			found.push(`unresolved:${opaque[1]}`)
			continue
		}
		if (token === '*') {
			if (previous === '(') {
				continue
			}
			found.push(...named.flatMap((t) => [...(COLUMNS.get(t) ?? [])].map((c) => `${t}.${c}`)))
			continue
		}
		const star = /^([A-Za-z_]\w*)\.\*$/.exec(token)
		if (star !== null) {
			const table = tables.get(star[1]!.toLowerCase())
			found.push(...[...(COLUMNS.get(table ?? '') ?? [])].map((c) => `${table}.${c}`))
			continue
		}
		const qualified = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(token)
		if (qualified !== null) {
			const table = tables.get(qualified[1]!.toLowerCase())
			const column = qualified[2]!.toLowerCase()
			if (table !== undefined && COLUMNS.get(table)?.has(column) === true) {
				found.push(`${table}.${column}`)
			}
			continue
		}
		if (/^[A-Za-z_]\w*$/.test(token) && previous !== 'AS' && list[i + 1] !== '(') {
			const column = token.toLowerCase()
			for (const table of named) {
				if (COLUMNS.get(table)?.has(column) === true) {
					found.push(`${table}.${column}`)
				}
			}
		}
	}
	return found
}

const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE'])

// The bounded columns one SQL string reads.
export function boundedReads(sql: string): string[] {
	const list = tokens(sql)
	const found: string[] = []
	const write = list.some((t, i) => WRITES.has(t.toUpperCase()) && list[i - 1]?.toUpperCase() !== 'DO')
	const depths: number[] = []
	let depth = 0
	for (const token of list) {
		if (token === '(') {
			depth++
		}
		depths.push(depth)
		if (token === ')') {
			depth--
		}
	}
	for (let i = 0; i < list.length; i++) {
		const keyword = list[i]!.toUpperCase()
		if (keyword !== 'SELECT' && keyword !== 'RETURNING') {
			continue
		}
		if (keyword === 'SELECT' && write) {
			continue
		}
		const d = depths[i]!
		let end = i + 1
		let from = -1
		while (end < list.length) {
			const token = list[end]!
			const upper = token.toUpperCase()
			if ((token === ')' && depths[end]! === d) || token === ';') {
				break
			}
			if (depths[end] === d && token !== '(') {
				if (upper === 'FROM' && from === -1) {
					from = end
				} else if (CLAUSE_END.has(upper) || (upper === 'SELECT' && end > i)) {
					break
				}
			}
			end++
		}
		const resultEnd = from === -1 ? end : from
		const fromClause = from === -1 ? [] : list.slice(from, end).filter((_, k) => depths[from + k]! >= d)
		let tables = tablesOf(fromClause)
		if (keyword === 'RETURNING') {
			const target = list.findIndex((t, k) => k < i && ['INTO', 'UPDATE', 'FROM'].includes(t.toUpperCase()))
			tables = new Map(target === -1 ? [] : [[list[target + 1]!.toLowerCase(), list[target + 1]!.toLowerCase()]])
		}
		found.push(...readsOf(list.slice(i + 1, resultEnd), tables))
	}
	return found
}

// ---- TypeScript sources, read by a small lexer (comments, strings, templates with nested interpolations, regular
// expression literals), as range-predicates.test.ts reads them as text: the package has no TypeScript parser API.

type Part = { text: string } | { expression: string }

type Literal = {
	path: string
	offset: number
	end: number
	parts: Part[]
	inHelper: boolean
	constant: string | null
}

const HELPER_CALL = new RegExp(String.raw`^\s*(${[...HELPERS].join('|')})\s*\(`)

function lex(path: string, text: string): Literal[] {
	const literals: Literal[] = []
	let i = 0
	// Reads code until `stop` (a closing brace of an interpolation at depth 0) or the end; returns where it stopped.
	const code = (inHelper: boolean, stop: boolean): number => {
		let depth = 0
		let last = ''
		while (i < text.length) {
			const c = text[i]!
			if (c === '/' && text[i + 1] === '/') {
				i = text.indexOf('\n', i)
				i = i === -1 ? text.length : i
				continue
			}
			if (c === '/' && text[i + 1] === '*') {
				i = text.indexOf('*/', i + 2) + 2
				continue
			}
			if (c === '/' && (last === '' || '(,=:[!&|?{};'.includes(last))) {
				i++
				let inClass = false
				while (i < text.length && (text[i] !== '/' || inClass)) {
					if (text[i] === '\\') {
						i++
					} else if (text[i] === '[') {
						inClass = true
					} else if (text[i] === ']') {
						inClass = false
					}
					i++
				}
				i++
				last = '/'
				continue
			}
			if (c === "'" || c === '"') {
				const start = i
				i++
				let value = ''
				while (i < text.length && text[i] !== c) {
					if (text[i] === '\\') {
						i++
					}
					value += text[i]
					i++
				}
				i++
				literals.push({ path, offset: start, end: i, parts: [{ text: value }], inHelper, constant: constantAt(start) })
				last = c
				continue
			}
			if (c === '`') {
				template(inHelper)
				last = '`'
				continue
			}
			if (c === '{') {
				depth++
			} else if (c === '}') {
				if (stop && depth === 0) {
					return i
				}
				depth--
			}
			if (!/\s/.test(c)) {
				last = c
			}
			i++
		}
		return i
	}
	const constantAt = (start: number): string | null =>
		/\bconst\s+(\w+)\s*(?::[^=]+)?=\s*$/.exec(text.slice(Math.max(0, start - 200), start))?.[1] ?? null
	const template = (inHelper: boolean): void => {
		const start = i
		const constant = constantAt(start)
		const parts: Part[] = []
		let value = ''
		i++
		while (i < text.length && text[i] !== '`') {
			if (text[i] === '\\') {
				value += text[i + 1]
				i += 2
				continue
			}
			if (text[i] === '$' && text[i + 1] === '{') {
				parts.push({ text: value })
				value = ''
				i += 2
				const from = i
				const helper = HELPER_CALL.test(text.slice(from, from + 64))
				const end = code(inHelper || helper, true)
				parts.push({ expression: text.slice(from, end) })
				i = end + 1
				continue
			}
			value += text[i]
			i++
		}
		i++
		parts.push({ text: value })
		literals.push({ path, offset: start, end: i, parts, inHelper, constant })
	}
	code(false, false)
	return literals
}

export type Source = { path: string; text: string; literals: Literal[] }

export function source(path: string, text: string): Source {
	return { path, text, literals: lex(path, text) }
}

function sources(dir: string): Source[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			return sources(path)
		}
		if (!entry.name.endsWith('.ts')) {
			return []
		}
		return [source(path, readFileSync(path, 'utf8'))]
	})
}

// The text of a literal, constants inlined (the module's own first, then another module's by a unique name), helper
// calls and other interpolations opaque.
function render(
	literal: Literal,
	local: Map<string, Literal>,
	global: Map<string, Literal | null>,
	exprs: string[],
	seen: ReadonlySet<Literal> = new Set()
): string {
	return literal.parts
		.map((part) => {
			if ('text' in part) {
				return part.text
			}
			if (HELPER_CALL.test(part.expression)) {
				return ' __bounded__ '
			}
			const name = /^\s*(\w+)\s*$/.exec(part.expression)?.[1]
			const target = name === undefined ? undefined : (local.get(`${literal.path}#${name}`) ?? global.get(name))
			if (target === undefined || target === null || seen.has(target)) {
				exprs.push(part.expression.replace(/\s+/g, ' ').trim())
				return ` __expr${exprs.length - 1}__ `
			}
			return ` ${render(target, local, global, exprs, new Set([...seen, target]))} `
		})
		.join('')
}

type Finding = { path: string; line: number; read: string }

// Builders an interpolation in a result list may name without a finding: each yields a predicate, a number, ids, or a
// value it bounds itself (cutSql); none passes a bounded column through. Any other interpolation there is a finding,
// so a raw column cannot hide behind one (an import alias of a helper included), unless ALLOWED names it.
const SAFE_INTERPOLATIONS = new Set([
	'availableJoinedSql',
	'availableLocalSql',
	'availableSql',
	'blocksSql',
	'cutSql',
	'DISTRIBUTABLE_SQL',
	'domainBlocksSql',
	'followableBySql',
	'followListsShownSql',
	'hidesCollectionsSql',
	'hostCoveredSql',
	'mayQuoteSql',
	'mutesSql',
	'notificationPolicySql',
	'participantsSql',
	'pendingAppsSql',
	'quotePolicySql',
	'REQUIRES_MENTION_SQL',
	'visibleSql',
])

// SQL keywords that mark a string as SQL when it is concatenated.
const SQL_TEXT = /\b(?:SELECT|FROM|WHERE|RETURNING|INSERT|UPDATE)\b/

// Raw reads of bounded columns, interpolations a result list cannot resolve (`interpolation <expression>`), SQL built
// by concatenation (`concatenated SQL`), and helper calls whose argument names a column the helper does not bound.
export function scan(all: readonly Source[]): { reads: Finding[]; misuses: Finding[] } {
	const local = new Map<string, Literal>()
	const global = new Map<string, Literal | null>()
	for (const literal of all.flatMap((source) => source.literals)) {
		if (literal.constant !== null) {
			local.set(`${literal.path}#${literal.constant}`, literal)
			global.set(literal.constant, global.has(literal.constant) ? null : literal)
		}
	}
	const reads: Finding[] = []
	const misuses: Finding[] = []
	const call = new RegExp(String.raw`\b(${[...HELPERS].join('|')})\(\s*(['"\`])([^'"\`$]*)\2`, 'g')
	for (const { path, text, literals } of all) {
		const lineOf = (offset: number) => text.slice(0, offset).split('\n').length
		for (const match of text.matchAll(call)) {
			const [, helper, , argument] = match
			const column = argument!.slice(argument!.lastIndexOf('.') + 1)
			if (!BOUNDED.some((b) => b.column === column && b.helpers.includes(helper!))) {
				misuses.push({ path, line: lineOf(match.index), read: `${helper}(${argument})` })
			}
		}
		for (const literal of literals) {
			if (literal.inHelper) {
				continue
			}
			const exprs: string[] = []
			const sql = render(literal, local, global, exprs)
			const line = lineOf(literal.offset)
			const before = text.slice(0, literal.offset).trimEnd().at(-1)
			const after = text.slice(literal.end).trimStart()[0]
			if ((before === '+' || after === '+') && SQL_TEXT.test(sql)) {
				reads.push({ path, line, read: 'concatenated SQL' })
			}
			// A bounded column named as a property value (a status read's extra columns) is selected by SQL built
			// elsewhere, so it counts as a read wherever it is named.
			const named = /^\s*\w+\.(\w+)\s*$/.exec(sql)?.[1]
			if (before === ':' && named !== undefined && BOUNDED.some((b) => b.column === named)) {
				reads.push({ path, line, read: `column ${sql.trim()}` })
			}
			if (/\b(?:SELECT|RETURNING)\b/i.test(sql)) {
				for (const read of boundedReads(sql)) {
					const opaque = /^unresolved:(\d+)$/.exec(read)
					const expression = opaque === null ? null : (exprs[Number(opaque[1])] ?? '')
					if (expression !== null && SAFE_INTERPOLATIONS.has(/^\w+/.exec(expression)?.[0] ?? '')) {
						continue
					}
					reads.push({ path, line, read: expression === null ? read : `interpolation ${expression}` })
				}
			}
		}
	}
	return { reads, misuses }
}

// Reads that are not presentation, by module and column, with how many there are.
const LOCAL = "a local account's own row (its username, profile and media are bounded where the account writes them)"
const ACTIVITYPUB =
	'an ActivityPub document built from a local status or actor (statusFacts, the actor documents), not an API answer'
const COMPARED = 'compared in the Worker with an incoming value, never presented'
const UPLOAD = "a local upload's stored URL, for its R2 objects, never presented"
const IDENTITY = 'an identity compared, stored or sent in an activity, never presented'
const PREDICATE = 'inside a predicate builder: its SELECTs compute values that are compared, never returned'
const EXTRA_COLUMNS = "a status or notification read's extra columns, checked where they are named (column findings)"
const COMPARED_SQL = 'a tag name a stream matches in SQL, never returned'
const WINDOW = "a merged window's stream key, order value or aggregate name, over ids"
const POLL = "a poll's stored choices, matched against a vote or an update, never presented"

const ALLOWED: Record<string, { count: number; reason: string }> = {
	'src/domain/audience.ts interpolation host': { count: 1, reason: PREDICATE },
	'src/domain/audience.ts interpolation a': { count: 1, reason: PREDICATE },
	'src/domain/audience.ts interpolation uriHostSql(`${a}.uri`)': { count: 1, reason: PREDICATE },
	'src/domain/audience.ts interpolation SNAPSHOT_STATE_PREFIX': { count: 1, reason: PREDICATE },
	'src/domain/audience.ts interpolation key': { count: 1, reason: PREDICATE },
	"src/domain/audience.ts interpolation columns(extra, 'id')": { count: 1, reason: EXTRA_COLUMNS },
	"src/domain/audience.ts interpolation columns(query.columns, 'status_id')": { count: 1, reason: EXTRA_COLUMNS },
	'src/domain/audience.ts interpolation column': { count: 1, reason: PREDICATE },
	"src/domain/audience.ts interpolation mentionsSender('ps')": { count: 2, reason: PREDICATE },
	'src/domain/audience.ts interpolation r': { count: 1, reason: PREDICATE },
	"src/domain/audience.ts interpolation uriHostSql('a.uri')": { count: 3, reason: PREDICATE },
	'src/domain/conversation-rows.ts interpolation s': { count: 1, reason: PREDICATE },
	'src/domain/media.ts interpolation column': { count: 2, reason: LOCAL },
	'src/domain/timelines.ts interpolation FOLLOWED_STREAM': { count: 2, reason: WINDOW },
	'src/domain/timelines.ts interpolation OWN': { count: 1, reason: WINDOW },
	'src/domain/timelines.ts interpolation TAG_STREAM': { count: 1, reason: WINDOW },
	'src/domain/timelines.ts column t.name': { count: 1, reason: COMPARED_SQL },
	'src/domain/timelines.ts interpolation n': { count: 1, reason: WINDOW },
	'src/domain/timelines.ts column s.uri': { count: 1, reason: IDENTITY },
	'src/domain/web-pages.ts column au.username': { count: 1, reason: LOCAL },
	'src/domain/windows.ts interpolation highest': { count: 1, reason: WINDOW },
	'src/domain/windows.ts interpolation end': { count: 1, reason: WINDOW },
	'src/domain/accounts.ts accounts.uri': { count: 4, reason: IDENTITY },
	'src/domain/activities.ts statuses.uri': { count: 5, reason: ACTIVITYPUB },
	'src/domain/activities.ts accounts.uri': { count: 5, reason: ACTIVITYPUB },
	'src/domain/actor-update.ts accounts.uri': { count: 1, reason: ACTIVITYPUB },
	'src/domain/actors.ts accounts.uri': { count: 1, reason: ACTIVITYPUB },
	'src/domain/blocks.ts accounts.uri': { count: 2, reason: IDENTITY },
	'src/domain/deliveries.ts accounts.uri': { count: 2, reason: IDENTITY },
	'src/domain/featured-tags.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/inbox.ts accounts.uri': { count: 7, reason: IDENTITY },
	'src/domain/inbox.ts statuses.uri': { count: 1, reason: IDENTITY },
	'src/domain/media.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/polls.ts statuses.uri': { count: 1, reason: IDENTITY },
	'src/domain/polls.ts accounts.uri': { count: 2, reason: IDENTITY },
	'src/domain/quotes.ts statuses.uri': { count: 6, reason: IDENTITY },
	'src/domain/quotes.ts accounts.uri': { count: 7, reason: IDENTITY },
	'src/domain/remote-collections.ts accounts.uri': { count: 3, reason: IDENTITY },
	'src/domain/remote-collections.ts statuses.uri': { count: 1, reason: IDENTITY },
	'src/domain/remote-statuses.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/reports.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/status-actions.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/status-actions.ts statuses.uri': { count: 1, reason: IDENTITY },
	'src/domain/statuses.ts accounts.uri': { count: 6, reason: IDENTITY },
	'src/domain/statuses.ts statuses.uri': { count: 9, reason: IDENTITY },
	'src/domain/accounts.ts accounts.username': { count: 1, reason: LOCAL },
	'src/domain/accounts.ts accounts.display_name': { count: 1, reason: LOCAL },
	'src/domain/activities.ts polls.options': { count: 1, reason: ACTIVITYPUB },
	'src/domain/activities.ts statuses.content': { count: 1, reason: ACTIVITYPUB },
	'src/domain/activities.ts statuses.spoiler_text': { count: 1, reason: ACTIVITYPUB },
	'src/domain/activities.ts accounts.username': { count: 2, reason: ACTIVITYPUB },
	'src/domain/activities.ts status_tags.name': { count: 1, reason: ACTIVITYPUB },
	'src/domain/activities.ts media_attachments.url': { count: 2, reason: ACTIVITYPUB },
	'src/domain/activities.ts media_attachments.description': { count: 2, reason: ACTIVITYPUB },
	'src/domain/actor-update.ts accounts.username': { count: 1, reason: ACTIVITYPUB },
	'src/domain/actor-update.ts accounts.display_name': { count: 1, reason: ACTIVITYPUB },
	'src/domain/actor-update.ts accounts.note': { count: 1, reason: ACTIVITYPUB },
	'src/domain/actor-update.ts accounts.avatar_url': { count: 1, reason: ACTIVITYPUB },
	'src/domain/actor-update.ts accounts.header_url': { count: 1, reason: ACTIVITYPUB },
	'src/domain/actors.ts accounts.username': { count: 7, reason: LOCAL },
	'src/domain/actors.ts accounts.display_name': { count: 1, reason: LOCAL },
	'src/domain/actors.ts accounts.note': { count: 1, reason: LOCAL },
	'src/domain/actors.ts accounts.avatar_url': { count: 1, reason: LOCAL },
	'src/domain/actors.ts accounts.header_url': { count: 1, reason: LOCAL },
	'src/domain/admin-accounts.ts accounts.username': { count: 2, reason: LOCAL },
	'src/domain/admin-authority.ts accounts.username': { count: 1, reason: LOCAL },
	'src/domain/deliveries.ts accounts.username': {
		count: 1,
		reason: `the local sender of a delivery the operator lists (${LOCAL})`,
	},
	'src/domain/featured-tags.ts status_tags.name': {
		count: 1,
		reason: "compared with the author's featured tags to count them, never presented",
	},
	'src/domain/media.ts media_attachments.url': { count: 3, reason: UPLOAD },
	'src/domain/oauth.ts accounts.username': { count: 1, reason: LOCAL },
	'src/domain/polls.ts polls.options': { count: 3, reason: POLL },
	'src/domain/quotes.ts accounts.username': { count: 2, reason: `a local signer or quoted author (${LOCAL})` },
	'src/domain/remote-statuses.ts statuses.content': { count: 1, reason: COMPARED },
	'src/domain/remote-statuses.ts statuses.spoiler_text': { count: 1, reason: COMPARED },
	'src/domain/remote-statuses.ts media_attachments.url': { count: 2, reason: COMPARED },
	'src/domain/remote-statuses.ts media_attachments.description': { count: 1, reason: COMPARED },
	'src/domain/snapshot.ts accounts.username': { count: 1, reason: LOCAL },
	'src/domain/statuses.ts accounts.username': { count: 1, reason: LOCAL },
	'src/domain/statuses.ts statuses.content': {
		count: 1,
		reason: "the author's own status, compared with an edit, never presented",
	},
	'src/domain/statuses.ts statuses.source_text': {
		count: 1,
		reason: "the author's own status, compared with an edit, never presented",
	},
	'src/domain/statuses.ts statuses.spoiler_text': {
		count: 1,
		reason: "the author's own status, compared with an edit, never presented",
	},
	'src/domain/statuses.ts media_attachments.description': {
		count: 1,
		reason: "the author's own media, compared with an edit, never presented",
	},
	'src/domain/streaming.ts status_tags.name': {
		count: 1,
		reason: 'matched against stream subscriptions, within the capture limit, never presented',
	},
}

describe('the bounded-read matcher', () => {
	it.each([
		['SELECT s.content FROM statuses s', ['statuses.content']],
		['SELECT content, id FROM statuses WHERE id = ?', ['statuses.content']],
		['SELECT x.note AS bio FROM accounts x', ['accounts.note']],
		['SELECT a.* FROM accounts a', ['accounts.note', 'accounts.display_name']],
		['SELECT m.url FROM media_attachments m JOIN statuses s ON s.id = m.status_id', ['media_attachments.url']],
		['SELECT (SELECT e.content FROM status_edits e LIMIT 1) AS c FROM statuses s', ['status_edits.content']],
		['UPDATE statuses SET content = ? WHERE id = ? RETURNING content', ['statuses.content']],
		['SELECT j.value FROM json_each(?1) j JOIN status_tags t ON t.status_id = j.value', []],
		['SELECT t.name FROM json_each(?1) j JOIN status_tags t ON t.status_id = j.value', ['status_tags.name']],
	])('reads %j', (sql, expected) => {
		const found = boundedReads(sql)
		for (const read of expected) {
			expect(found).toContain(read)
		}
		if (expected.length === 0) {
			expect(found).toEqual([])
		}
	})

	it.each([
		'SELECT s.id FROM statuses s WHERE s.content = ?',
		'SELECT a.id FROM accounts a WHERE lower(a.username) = ?1 ORDER BY a.display_name',
		'SELECT  __bounded__  AS content FROM statuses s',
		'INSERT INTO status_edits (status_id, content) SELECT id, content FROM statuses WHERE id = ?',
		'SELECT count(*) AS n FROM statuses',
		'SELECT s.url FROM accounts s2 JOIN follows s ON s.id = s2.id',
	])('leaves %j', (sql) => {
		expect(boundedReads(sql)).toEqual([])
	})
})

describe('the source scanner', () => {
	const findings = (text: string) => scan([source('src/domain/probe.ts', text)]).reads.map((finding) => finding.read)

	it.each([
		['a raw column', 'db.all(`SELECT s.content FROM statuses s`)', 'statuses.content'],
		['an interpolated string', "db.all(`SELECT ${'s.content'} FROM statuses s`)", "interpolation 's.content'"],
		[
			'an import alias of a helper',
			"import { contentSql as c } from './status-bounds'\ndb.all(`SELECT ${c('s.content')} AS content FROM statuses s`)",
			"interpolation c('s.content')",
		],
		['concatenated SQL', "db.all('SELECT s.content ' + 'FROM statuses s')", 'concatenated SQL'],
		['a column passed as a property', "read.select(db, { columns: { text: 's.content' } })", 'column s.content'],
		[
			'a constant of raw columns',
			"const COLUMNS = 's.id, s.content'\ndb.all(`SELECT ${COLUMNS} FROM statuses s`)",
			'statuses.content',
		],
	])('finds %s', (_name, text, read) => {
		expect(findings(text)).toContain(read)
	})

	it.each([
		['a helper', "db.all(`SELECT ${contentSql('s.content')} AS content FROM statuses s`)"],
		['a comparison', 'db.all(`SELECT s.id FROM statuses s WHERE s.content = ?`)'],
		['a safe builder', "db.all(`SELECT s.id, ${availableSql('s.account_id')} AS a FROM statuses s`)"],
	])('leaves %s', (_name, text) => {
		expect(findings(text)).toEqual([])
	})
})

describe('bounded columns in src/domain', () => {
	const root = fileURLToPath(new URL('../src/domain', import.meta.url))
	const { reads, misuses } = scan(sources(root))
	const name = (path: string) => `src/domain/${relative(root, path).replaceAll('\\', '/')}`

	it('are read only through their helpers', () => {
		const counts = new Map<string, Finding[]>()
		for (const finding of reads) {
			const key = `${name(finding.path)} ${finding.read}`
			counts.set(key, [...(counts.get(key) ?? []), finding])
		}
		const unexpected = [...counts].flatMap(([key, found]) =>
			ALLOWED[key]?.count === found.length ? [] : [`${key}: ${found.map((f) => f.line).join(', ')}`]
		)
		const stale = Object.keys(ALLOWED).filter((key) => !counts.has(key))
		expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] })
	})

	it('bound the column each helper is given', () => {
		expect(misuses.map((m) => `${name(m.path)}:${m.line} ${m.read}`)).toEqual([])
	})
})
