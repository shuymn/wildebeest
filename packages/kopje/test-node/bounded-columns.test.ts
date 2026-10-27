import type { Node } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

import { guardFixtures, lineOf, parse, sources, walk, type Literal, type Part, type Source } from './source-scan.js'

// RES-2: a column a remote server controls that keeps a read-time projection (an identity, a hashtag name, a poll's
// choices, an edit's media snapshot; the other columns are bounded as stored, STORED_COLUMNS in
// src/platform/stored-bounds.ts) leaves SQLite only through its projection helper (src/domain/profile-bounds.ts,
// src/domain/status-bounds.ts), which bounds it. This test reads every SQL string in src/domain and fails on a raw
// read.
//
// - Reading is naming the column in a SELECT's result list (a subquery's included) or in RETURNING; a reference inside
//   a helper call's argument is the helper's. Comparing is naming it anywhere else: WHERE, ON, ORDER BY, GROUP BY, a
//   write's SET or VALUES. INSERT ... SELECT copies values inside SQLite, so its SELECT is no read.
// - A SQL string is a string or template literal naming SELECT or RETURNING. An interpolated constant of the module
//   (or of another src/domain module, by its unique name) is inlined, so STATUS_FROM is read where it is used; a
//   helper call (by its own name) is a bounded value. A column map's select list (`selectSql`, src/db/columns.ts) is
//   read where the map names its columns: each value is a property value, so a raw bounded column there is a finding.
// - Fail closed: any other interpolation inside a result list or RETURNING is a finding (`interpolation <expression>`)
//   unless it names a builder of SAFE_INTERPOLATIONS, so neither an import alias nor an interpolated string hides a
//   column; so are a string with SQL keywords joined by `+` (`concatenated SQL`) and a bounded column named as a
//   property value (`column <alias.column>`), which SQL built elsewhere selects.
// - Tables are found by name from FROM and JOIN, with their aliases. A bare column counts when a table of the SELECT
//   has it; `*` and `alias.*` count when such a table has a bounded column.
// - ALLOWED lists, per module, the findings that present nothing, with their reason and exact count.
//
// The guard is an architectural aid, not a proof: the aggregate response tests prove the budgets (test/status-bounds.
// test.ts). It reads SQL as tokens, not as a grammar, and has known gaps: a column qualified by an outer query's alias
// inside a correlated subquery is read against the subquery's own tables only; a bounded column passed as a property
// value is found only as a literal there (directly or as a branch of a condition), not through a variable or spread;
// and an expression is resolved only as a constant or a single call by name. A helper call counts only when the
// interpolation is that one call and nothing joined to it; quoted identifiers read as bare ones; concatenated SQL is
// found in any case.

type Bounded = { table: string; column: string; helpers: readonly string[] }

export const BOUNDED: readonly Bounded[] = [
	{ table: 'accounts', column: 'username', helpers: ['usernameSql'] },
	{ table: 'accounts', column: 'uri', helpers: ['actorUriSql'] },
	{ table: 'statuses', column: 'uri', helpers: ['statusUriSql'] },
	{ table: 'status_edits', column: 'media_json', helpers: ['editMediaSql'] },
	{ table: 'polls', column: 'options', helpers: ['pollOptionsSql'] },
	// listedTagNameSql (tag-bounds.ts) reads it within tagNameSql's bound, as hex for a strict decoding.
	{ table: 'status_tags', column: 'name', helpers: ['tagNameSql', 'listedTagNameSql'] },
]

const HELPERS = new Set(BOUNDED.flatMap((b) => b.helpers))
// Columns a helper also bounds that are not bounded columns themselves (other tables' columns of the same name are
// read raw): listedTagNameSql reads a featured hashtag's spelling within the same bound as its name.
const ALSO_BOUNDS: Readonly<Record<string, readonly string[]>> = { listedTagNameSql: ['display_name'] }
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

// Quoted identifiers ("s"."content") read as bare ones.
function tokens(sql: string): string[] {
	return (sql.replace(/"([A-Za-z_]\w*)"/g, '$1').match(TOKEN) ?? []).filter((t) => !t.startsWith('--'))
}

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
		// A table qualified by its schema (`main.statuses`) is that table.
		const name = list[i + 1]?.replace(/^main\./i, '')
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

// ---- TypeScript sources (source-scan.ts)

// A literal's expression when it is a bare name or a single call by name, with no template or `+` in its arguments:
// the name. Null otherwise, as joined text could hide an unbounded column.
function singleCall(expression: Node): string | null {
	if (expression.type === 'Identifier') {
		return expression.name
	}
	if (expression.type !== 'CallExpression' || expression.callee.type !== 'Identifier') {
		return null
	}
	let joined = false
	for (const argument of expression.arguments) {
		walk(argument, (node) => {
			joined ||= node.type === 'TemplateLiteral' || (node.type === 'BinaryExpression' && node.operator === '+')
		})
	}
	return joined ? null : expression.callee.name
}

// Whether `literal` is a property's value, directly or as a branch of a conditional or logical expression there.
function propertyValue(literal: Literal): boolean {
	let child = literal.node
	for (const parent of literal.parents) {
		if (parent.type === 'Property') {
			return parent.value === child
		}
		if (!['ConditionalExpression', 'LogicalExpression', 'TSAsExpression'].includes(parent.type)) {
			return false
		}
		child = parent
	}
	return false
}

// The helper a call calls, by its own name or as a static member (`bounds.statusUriSql`); null for any other call.
function helperOf(call: Node): string | null {
	if (call.type !== 'CallExpression') {
		return null
	}
	const { callee } = call
	const name =
		callee.type === 'Identifier'
			? callee.name
			: callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
				? callee.property.name
				: null
	return name !== null && HELPERS.has(name) ? name : null
}

// The column a helper is given: its first argument, itself. A literal nested deeper (a database call's SQL inside the
// argument) is read as any other.
const inHelper = (literal: Literal) => {
	const call = literal.parents[0]
	return call?.type === 'CallExpression' && helperOf(call) !== null && call.arguments[0] === literal.node
}

// The text of a literal, constants inlined (the module's own first, then another module's by a unique name), helper
// calls and other interpolations opaque.
function render(
	path: string,
	literal: Literal,
	local: Map<string, [string, Literal]>,
	global: Map<string, [string, Literal] | null>,
	exprs: Exclude<Part, { text: string }>[],
	seen: ReadonlySet<Literal> = new Set()
): string {
	return literal.parts
		.map((part) => {
			if ('text' in part) {
				return part.text
			}
			const call = singleCall(part.expression)
			if (call !== null && HELPERS.has(call)) {
				return ' __bounded__ '
			}
			const name = part.expression.type === 'Identifier' ? part.expression.name : undefined
			const target = name === undefined ? undefined : (local.get(`${path}#${name}`) ?? global.get(name))
			if (target === undefined || target === null || seen.has(target[1])) {
				exprs.push(part)
				return ` __expr${exprs.length - 1}__ `
			}
			return ` ${render(target[0], target[1], local, global, exprs, new Set([...seen, target[1]]))} `
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
	// A value cut to a byte cap (domain/trends.ts), around the column's own helper where it has one.
	'byteCut',

	// R43, whether a status may hold a card: a predicate (domain/audience.ts).
	'cardEligibleSql',
	// Whether a value is no card URL: a predicate (platform/stored-bounds.ts).
	'cardUrlPastSql',
	// A link's review (an integer or NULL), whether it has a timeline (a predicate) and its qualifying copy (a status
	// id): domain/trends.ts.
	'linkReviewSql',
	'listedTrendLinkSql',
	'trendCopySql',
	'cutSql',
	// Whether a job may run now: a predicate on its retry columns (domain/job-attempts.ts).
	'jobDueSql',
	// Whether a remote media slot may be claimed, recorded or kept: a predicate (domain/remote-media.ts).
	'slotEligibleSql',
	// A snapshot's cached emoji: a JSON array of entry indexes and packed server tokens, naming no bounded column
	// (platform/stored-bounds.ts).
	'emojiCacheSql',
	'DISTRIBUTABLE_SQL',
	'domainBlocksSql',
	'domainCoveredSql',
	// Whether a domain block's reject_media rules a host or an account: predicates (domain/audience.ts).
	'domainMediaRejectedSql',
	'hostMediaRejectedSql',
	// A status's filter text figure: whether an input is not text (a predicate) and an upper bound of its length from
	// stored bytes, a number (domain/status-presenter.ts).
	'filterOddInputsSql',
	'filterTextBoundSql',
	'followableBySql',
	'followListsShownSql',
	'hidesCollectionsSql',
	'hostCoveredSql',
	// A stored time read as its 24-byte ISO form, or NULL (platform/stored-bounds.ts).
	'isoTimeSql',
	// A counter or time as read, within its range, or NULL (platform/stored-bounds.ts), a number.
	'storedCountSql',
	// Whether a value is no remote field link list or link back: predicates (platform/stored-bounds.ts).
	'remoteFieldLinksPastBoundSql',
	'remoteLinkBackPastBoundSql',

	// A remote account's attachment, bounded as REMOTE_ATTACHMENT_SQL (domain/accounts.ts), cutSql within it.
	'remoteAttachmentSql',
	// Whether an Idempotency-Key's row is within its hour: a predicate over isoTimeSql (domain/statuses.ts).
	'keyFreshSql',
	'mayQuoteSql',
	'mutesSql',
	'notificationPolicySql',
	// Whether a value is no cached oEmbed template: a predicate (platform/stored-bounds.ts).
	'oembedTemplatePastSql',
	'participantsSql',
	'pendingAppsSql',
	// An account count as an integer from 0 to MAX_ACCOUNT_COUNT, else 0 (platform/stored-bounds.ts), a number.
	'presentedCountSql',
	// Local fields within their raw read bound, or NULL (platform/stored-bounds.ts): no bounded column.
	'presentedLocalFieldsSql',
	'quotePolicySql',
	// A quoted status's id.
	'quotedStatusIdSql',
	'REQUIRES_MENTION_SQL',
	// The heap of one row of a column map, a number.
	'rowHeapSql',
	// A column map's select list: its values are checked where the map names them (`column <alias.column>`).
	'selectSql',
	// As rowHeapSql: the heap of the rows one status reads (status-rows.ts), a number.
	'statusRowTerms',
	// statuses.url read through its stored bound (platform/stored-bounds.ts).
	'statusUrlSql',
	'suspendedSql',
	'visibleSql',
])

// SQL keywords that mark a string as SQL when it is concatenated.
const SQL_TEXT = /\b(?:SELECT|FROM|WHERE|RETURNING|INSERT|UPDATE)\b/i

// The findings of the file header; misuses are helper calls given a column the helper does not bound.
export function scan(all: readonly Source[]): { reads: Finding[]; misuses: Finding[] } {
	const local = new Map<string, [string, Literal]>()
	const global = new Map<string, [string, Literal] | null>()
	for (const source of all) {
		for (const literal of parse(source).literals) {
			if (literal.constant !== null) {
				local.set(`${source.path}#${literal.constant}`, [source.path, literal])
				global.set(literal.constant, global.has(literal.constant) ? null : [source.path, literal])
			}
		}
	}
	const reads: Finding[] = []
	const misuses: Finding[] = []
	for (const source of all) {
		const { path, text } = source
		const { program, literals } = parse(source)
		walk(program, (node) => {
			const helper = helperOf(node)
			if (helper === null || node.type !== 'CallExpression') {
				return
			}
			const first = node.arguments[0]
			const argument =
				first?.type === 'Literal' && typeof first.value === 'string'
					? first.value
					: first?.type === 'TemplateLiteral' && first.expressions.length === 0
						? first.quasis[0]?.value.cooked
						: undefined
			const column = argument?.slice(argument.lastIndexOf('.') + 1)
			const also = column !== undefined && (ALSO_BOUNDS[helper]?.includes(column) ?? false)
			if (argument !== undefined && !also && !BOUNDED.some((b) => b.column === column && b.helpers.includes(helper))) {
				misuses.push({ path, line: lineOf(text, node.start), read: `${helper}(${argument})` })
			}
		})
		for (const literal of literals) {
			if (inHelper(literal)) {
				continue
			}
			const exprs: Exclude<Part, { text: string }>[] = []
			const sql = render(path, literal, local, global, exprs)
			const line = lineOf(text, literal.node.start)
			const parent = literal.parents[0]
			if (parent?.type === 'BinaryExpression' && parent.operator === '+' && SQL_TEXT.test(sql)) {
				reads.push({ path, line, read: 'concatenated SQL' })
			}
			// A property-valued bounded column is selected by SQL built elsewhere (see the file header).
			const named = /^\s*\w+\.(\w+)\s*$/.exec(sql)?.[1]
			if (propertyValue(literal) && named !== undefined && BOUNDED.some((b) => b.column === named)) {
				reads.push({ path, line, read: `column ${sql.trim()}` })
			}
			if (/\b(?:SELECT|RETURNING)\b/i.test(sql)) {
				for (const read of boundedReads(sql)) {
					const opaque = /^unresolved:(\d+)$/.exec(read)
					const part = opaque === null ? null : exprs[Number(opaque[1])]
					if (part !== null && part !== undefined && SAFE_INTERPOLATIONS.has(singleCall(part.expression) ?? '')) {
						continue
					}
					const expression = part === null ? null : (part?.source.replace(/\s+/g, ' ').trim() ?? '')
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
const IDENTITY = 'an identity compared, stored or sent in an activity, never presented'
const PREDICATE = 'inside a predicate builder: its SELECTs compute values that are compared, never returned'
const EXTRA_COLUMNS = "a status or notification read's extra columns, checked where they are named (column findings)"
const COMPARED_SQL = 'a tag name a stream matches in SQL, never returned'
const WINDOW = "a merged window's stream key, order value or aggregate name, over ids"
const POLL = "a poll's stored choices, matched against a vote or an update, never presented"
const SNAPSHOT = "a field of an edit's media snapshot, bounded as an attachment's column (editMediaSql)"
const SETTINGS = "the instance settings' stored-bound projections (settingProjectionSql), naming no bounded column"
const NUMBER = 'a number constant (the trends round’s count clamp, TREND_OBSERVED_MAX), naming no column'
const MEASURE = "a measure walk's per-candidate judgements and its time (isoTimeSql), grouped into counts by day"

const STAGED =
	"a staged retraction's target (an inbox, or an addressee's identity), sent in an activity, never presented"

const REMOTE_ATTACHMENT = "a remote account's attachment entry and its original value (src), from its stored document"

const ALLOWED: Record<string, { count: number; reason: string }> = {
	'src/domain/trends.ts interpolation TREND_OBSERVED_MAX': { count: 2, reason: NUMBER },
	'src/domain/status-presenter.ts interpolation MAX_FILTER_TEXT': {
		count: 1,
		reason: 'a number constant (the filter text cap of a status), naming no column',
	},
	// filterTextBoundSql: the stored choices' bytes, a number in an upper bound, never the choices.
	'src/domain/status-presenter.ts polls.options': { count: 1, reason: 'octet_length of the stored choices, a number' },
	'src/domain/admin-measures.ts interpolation walk.kept': { count: 1, reason: MEASURE },
	// A job table's key columns (JobTable.key, constants of domain/job-attempts.ts: no bounded column), or the columns a
	// family's round reads of its next job (nextJob's options.columns, each a constant list of its module).
	'src/domain/job-attempts.ts interpolation columns': {
		count: 2,
		reason: "a job table's key columns or a family's constant column list, naming no bounded column",
	},
	'src/domain/admin-measures.ts interpolation walk.dated': { count: 1, reason: MEASURE },
	'src/domain/admin-measures.ts interpolation walk.time': { count: 1, reason: MEASURE },
	'src/domain/status-rows.ts interpolation movedHeap': {
		count: 1,
		reason:
			'a number constant (the heap a moved-to account’s row and its cached images take at their caps, in R), naming no column',
	},
	'src/domain/status-rows.ts interpolation cachedImage': {
		count: 2,
		reason: 'a number constant (the heap a cached profile image row takes at its caps, in R), naming no column',
	},
	"src/domain/instance.ts interpolation projected.join(' ')": { count: 1, reason: SETTINGS },
	"src/domain/instance.ts interpolation settingProjectionSql('contact_username', 'value')": {
		count: 1,
		reason: SETTINGS,
	},
	"src/domain/instance-activity.ts interpolation settingProjectionSql('activity_api_enabled', 'value')": {
		count: 1,
		reason: SETTINGS,
	},
	// The round's raw cut: a status's first 100 names, matched by membership only (projecting them would change which
	// rows count against the cut); the names the round returns go through tagNameSql.
	'src/domain/trends.ts status_tags.name': { count: 1, reason: COMPARED_SQL },
	'src/domain/remote-suspension.ts accounts.uri': { count: 1, reason: IDENTITY },
	// Read from main.-qualified tables: a window's tag names compared in an IN subquery, the addressed accounts' ids
	// matched against an activity's to and cc (deliveries.ts targetsOf), a forward's boost uris (shareReaches,
	// stagedShare).
	'src/domain/audience.ts status_tags.name': { count: 1, reason: PREDICATE },
	'src/domain/audience.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/audience.ts statuses.uri': { count: 2, reason: IDENTITY },
	// A staged retraction's sources (stagedAccounts and the other paged readers): each account's uri and inboxes, or a
	// reached inbox, cut at TARGET_CHUNK_BYTES (projectedSql), and whether it is left out (leavesOutSql, a predicate).
	"src/domain/audience.ts interpolation stagedAccountSql(kind, '?3', '?2')": { count: 2, reason: STAGED },
	"src/domain/audience.ts interpolation stagedAccountSql(kind, '?5', '?4')": { count: 3, reason: STAGED },
	"src/domain/audience.ts interpolation projectedSql(REACH_INBOX, 'inbox', '?5')": { count: 2, reason: STAGED },
	"src/domain/audience.ts interpolation leavesOutSql(kind, 'addressed', '?6', 'a.id')": { count: 1, reason: PREDICATE },
	"src/domain/audience.ts interpolation leavesOutSql(kind, 'follower', '?1', 'a.id')": { count: 1, reason: PREDICATE },
	"src/domain/deliveries.ts interpolation projectedSql('inbox_url', 'inbox', '?4')": { count: 1, reason: STAGED },
	"src/domain/deliveries.ts interpolation projectedSql('r.inbox_url', 'inbox', '?4')": { count: 1, reason: STAGED },
	'src/domain/audience.ts interpolation host': { count: 2, reason: PREDICATE },
	'src/domain/audience.ts interpolation a': { count: 2, reason: PREDICATE },
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
	'src/domain/timelines.ts interpolation FOLLOWED_STREAM': { count: 2, reason: WINDOW },
	'src/domain/timelines.ts interpolation OWN': { count: 1, reason: WINDOW },
	'src/domain/timelines.ts interpolation TAG_STREAM': { count: 1, reason: WINDOW },
	'src/domain/timelines.ts column t.name': { count: 1, reason: COMPARED_SQL },
	'src/domain/timelines.ts interpolation n': { count: 1, reason: WINDOW },
	'src/domain/timelines.ts column s.uri': { count: 1, reason: IDENTITY },
	'src/domain/web-pages/status.ts column au.username': { count: 1, reason: LOCAL },
	'src/domain/windows.ts interpolation highest': { count: 1, reason: WINDOW },
	'src/domain/windows.ts interpolation end': { count: 1, reason: WINDOW },
	'src/domain/accounts.ts accounts.uri': { count: 4, reason: IDENTITY },
	// remoteAttachmentSql's own parts: an attachment entry (cutSql's name and value) and its src, a fixed column name,
	// naming no bounded column.
	'src/domain/accounts.ts interpolation entry': { count: 1, reason: REMOTE_ATTACHMENT },
	"src/domain/accounts.ts interpolation eligibility ? ', c.src' : ''": { count: 1, reason: REMOTE_ATTACHMENT },
	'src/domain/accounts.ts interpolation src': { count: 1, reason: REMOTE_ATTACHMENT },
	'src/domain/accounts.ts interpolation REMOTE_FIELD_LINKS_BYTES': {
		count: 1,
		reason: 'a number constant (remote_field_links.links bound, REMOTE_VERIFIED_SQL), naming no column',
	},
	'src/domain/activities.ts statuses.uri': { count: 5, reason: ACTIVITYPUB },
	'src/domain/activities.ts accounts.uri': { count: 5, reason: ACTIVITYPUB },
	'src/domain/actor-update.ts accounts.uri': { count: 1, reason: ACTIVITYPUB },
	'src/domain/actors.ts accounts.uri': { count: 2, reason: ACTIVITYPUB },
	'src/domain/blocks.ts accounts.uri': { count: 2, reason: IDENTITY },
	'src/domain/deliveries.ts accounts.uri': { count: 3, reason: IDENTITY },
	'src/domain/featured-tags.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/inbox.ts accounts.uri': { count: 7, reason: IDENTITY },
	'src/domain/inbox.ts statuses.uri': { count: 2, reason: IDENTITY },
	'src/domain/local-emojis.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/media.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/polls.ts statuses.uri': { count: 1, reason: IDENTITY },
	'src/domain/polls.ts accounts.uri': { count: 2, reason: IDENTITY },
	'src/domain/quotes.ts statuses.uri': { count: 7, reason: IDENTITY },
	'src/domain/quotes.ts accounts.uri': { count: 7, reason: IDENTITY },
	'src/domain/remote-collections.ts accounts.uri': { count: 3, reason: IDENTITY },
	'src/domain/remote-collections.ts statuses.uri': { count: 1, reason: IDENTITY },
	'src/domain/remote-statuses.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/reports.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/status-actions.ts accounts.uri': { count: 1, reason: IDENTITY },
	'src/domain/status-actions.ts statuses.uri': { count: 1, reason: IDENTITY },
	'src/domain/statuses.ts accounts.uri': { count: 5, reason: IDENTITY },
	'src/domain/statuses.ts statuses.uri': { count: 7, reason: IDENTITY },
	'src/domain/accounts.ts accounts.username': {
		count: 3,
		reason: `${LOCAL}; and the username an address names as stored (addressRow), bounded by the address it matched and
			stored only as contact_username, never presented`,
	},
	'src/domain/activities.ts accounts.username': { count: 1, reason: ACTIVITYPUB },
	'src/domain/actor-update.ts accounts.username': { count: 1, reason: ACTIVITYPUB },
	'src/domain/actors.ts accounts.username': { count: 7, reason: LOCAL },
	'src/domain/admin-accounts.ts accounts.username': { count: 2, reason: LOCAL },
	'src/domain/admin-authority.ts column a.username': { count: 1, reason: LOCAL },
	'src/domain/deliveries.ts accounts.username': {
		count: 1,
		reason: `the local sender of a delivery the operator lists (${LOCAL})`,
	},
	'src/domain/featured-tags.ts status_tags.name': {
		count: 1,
		reason: "compared with the author's featured tags to count them, never presented",
	},
	'src/domain/oauth.ts accounts.username': { count: 1, reason: LOCAL },
	'src/domain/polls.ts polls.options': { count: 3, reason: POLL },
	"src/domain/status-bounds.ts interpolation mediaUrlSql(text('url'))": { count: 1, reason: SNAPSHOT },
	"src/domain/status-bounds.ts interpolation mediaUrlSql(text('preview_url'))": { count: 1, reason: SNAPSHOT },
	"src/domain/status-bounds.ts interpolation mediaUrlSql(text('remote_url'))": { count: 1, reason: SNAPSHOT },
	"src/domain/status-bounds.ts interpolation mediaUrlSql(text('preview_remote_url'))": { count: 1, reason: SNAPSHOT },
	"src/domain/status-bounds.ts interpolation blurhashPastBoundSql(text('blurhash'))": { count: 1, reason: SNAPSHOT },
	"src/domain/status-bounds.ts interpolation text('blurhash')": { count: 1, reason: SNAPSHOT },
	'src/domain/status-bounds.ts interpolation mediaMetaSql(meta)': { count: 1, reason: SNAPSHOT },
	"src/domain/status-bounds.ts interpolation mediaDescriptionSql(text('description'))": { count: 1, reason: SNAPSHOT },
	'src/domain/quotes.ts accounts.username': { count: 2, reason: `a local signer or quoted author (${LOCAL})` },
	'src/domain/snapshot.ts accounts.username': { count: 1, reason: LOCAL },
	'src/domain/statuses.ts accounts.username': { count: 1, reason: LOCAL },
	'src/domain/streaming.ts status_tags.name': {
		count: 1,
		reason: 'matched against stream subscriptions, within the capture limit, never presented',
	},
}

describe('the bounded-read matcher', () => {
	it.each([
		['SELECT s.uri FROM statuses s', ['statuses.uri']],
		['SELECT uri, id FROM statuses WHERE id = ?', ['statuses.uri']],
		['SELECT x.username AS name FROM accounts x', ['accounts.username']],
		['SELECT a.* FROM accounts a', ['accounts.username', 'accounts.uri']],
		['SELECT s.uri FROM media_attachments m JOIN statuses s ON s.id = m.status_id', ['statuses.uri']],
		['SELECT (SELECT e.media_json FROM status_edits e LIMIT 1) AS c FROM statuses s', ['status_edits.media_json']],
		['UPDATE statuses SET uri = ? WHERE id = ? RETURNING uri', ['statuses.uri']],
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
		'SELECT s.id FROM statuses s WHERE s.uri = ?',
		'SELECT a.id FROM accounts a WHERE lower(a.username) = ?1 ORDER BY a.uri',
		'SELECT  __bounded__  AS uri FROM statuses s',
		'INSERT INTO status_edits (status_id, media_json) SELECT id, uri FROM statuses WHERE id = ?',
		'SELECT count(*) AS n FROM statuses',
		'SELECT s.uri FROM accounts s2 JOIN follows s ON s.id = s2.id',
	])('leaves %j', (sql) => {
		expect(boundedReads(sql)).toEqual([])
	})
})

describe('the source scanner', () => {
	const find = (all: Source[]) => {
		const { reads, misuses } = scan(all)
		return [...reads.map((r) => r.read), ...misuses.map((m) => `misuse ${m.read}`)]
	}

	guardFixtures(find, {
		flagged: {
			'a raw column': ['db.all(`SELECT s.uri FROM statuses s`)', 'statuses.uri'],
			'an interpolated string': ["db.all(`SELECT ${'s.uri'} FROM statuses s`)", "interpolation 's.uri'"],
			'an import alias of a helper': [
				"import { statusUriSql as c } from './status-bounds'\ndb.all(`SELECT ${c('s.uri')} AS uri FROM statuses s`)",
				"interpolation c('s.uri')",
			],
			'concatenated SQL': ["db.all('SELECT s.uri ' + 'FROM statuses s')", 'concatenated SQL'],
			'lower-case concatenated SQL': ["db.all('select s.uri ' + 'from statuses s')", 'concatenated SQL'],
			'a helper call with more joined to it': [
				"db.all(`SELECT ${statusUriSql('s.uri') + ', s.uri'} FROM statuses s`)",
				"interpolation statusUriSql('s.uri') + ', s.uri'",
			],
			'quoted identifiers': ['db.all(`SELECT "s"."uri" FROM statuses AS "s"`)', 'statuses.uri'],
			'a schema-qualified table': [
				'db.all(`SELECT s.uri FROM json_each(?) j CROSS JOIN main.statuses s`)',
				'statuses.uri',
			],
			'a column passed as a property': ["read.select(db, { columns: { text: 's.uri' } })", 'column s.uri'],
			'a parenthesized property value': ["read.select(db, { columns: { text: ('s.uri') } })", 'column s.uri'],
			'a computed property': ["read.select(db, { columns: { [key]: 's.uri' } })", 'column s.uri'],
			'a property value chosen by a condition': ["f({ text: own ? 's.uri' : 's.id' })", 'column s.uri'],
			'a constant of raw columns': [
				"const COLUMNS = 's.id, s.uri'\ndb.all(`SELECT ${COLUMNS} FROM statuses s`)",
				'statuses.uri',
			],
			'a helper given another column': ["statusUriSql('s.content')", 'misuse statusUriSql(s.content)'],
			'a namespaced helper given another column': ["bounds.statusUriSql('t.name')", 'misuse statusUriSql(t.name)'],
			'a read nested in a helper argument': [
				"statusUriSql(db.first<{ uri: string }>('SELECT s.uri FROM statuses s')!.uri)",
				'statuses.uri',
			],
			'a reassigned let': [
				"let COLUMNS = 's.id'\nCOLUMNS = 's.id, s.uri'\ndb.all(`SELECT ${COLUMNS} FROM statuses s`)",
				'interpolation COLUMNS',
			],
			'a reassigned var': [
				"var COLUMNS = 's.id'\nCOLUMNS = 's.id, s.uri'\ndb.all(`SELECT ${COLUMNS} FROM statuses s`)",
				'interpolation COLUMNS',
			],
		},
		passed: {
			'a helper': "db.all(`SELECT ${statusUriSql('s.uri')} AS uri FROM statuses s`)",
			'a comparison': 'db.all(`SELECT s.id FROM statuses s WHERE s.uri = ?`)',
			'a namespaced helper': "db.all(`SELECT s.id FROM statuses s WHERE x = ?`, bounds.statusUriSql('s.uri'))",
			'a constant of bounded columns': "const COLUMNS = 's.id'\ndb.all(`SELECT ${COLUMNS} FROM statuses s`)",
			'a safe builder': "db.all(`SELECT s.id, ${availableSql('s.account_id')} AS a FROM statuses s`)",
			'a comment': "// db.all(`SELECT s.uri FROM statuses s`), statusUriSql('s.content')\nf()",
		},
	})
})

describe('bounded columns in src/domain', () => {
	const { reads, misuses } = scan(sources('src/domain'))

	it('are read only through their helpers', () => {
		const counts = new Map<string, Finding[]>()
		for (const finding of reads) {
			const key = `${finding.path} ${finding.read}`
			counts.set(key, [...(counts.get(key) ?? []), finding])
		}
		const unexpected = [...counts].flatMap(([key, found]) =>
			ALLOWED[key]?.count === found.length ? [] : [`${key}: ${found.map((f) => f.line).join(', ')}`]
		)
		const stale = Object.keys(ALLOWED).filter((key) => !counts.has(key))
		expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] })
	})

	it('bound the column each helper is given', () => {
		expect(misuses.map((m) => `${m.path}:${m.line} ${m.read}`)).toEqual([])
	})
})
