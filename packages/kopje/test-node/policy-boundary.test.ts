import type { Node } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

import { guardFixtures, lineOf, parse, sources, walk, type Source } from './source-scan.js'

// The policy boundary (docs/visibility.md): the rules of who sees what, who is notified and who is addressed are SQL
// fragments of one module, src/domain/audience.ts. Elsewhere, SQL calls them instead of reading the tables they
// decide on, so a new read, notification or delivery path cannot apply a copy of a rule that drifts from it. Only the
// modules that write those tables read them directly, each for the reason given. The single writers of
// notifications, outbound activities and the audience rows are pinned the same way, and so is the selection of an
// activity's recipients (recipientsFor): no other SQL turns follows into inboxes or picks an account's shared inbox.

const POLICY = 'src/domain/audience.ts'

const SOURCES = sources('src')

// What SQL outside the files of `allowed` must not contain. Every allowed file other than the policy module must
// still contain it, so the list does not outlive its reason.
type Rule = { name: string; pattern: RegExp; allowed: Record<string, string> }

const POLICY_ONLY = { [POLICY]: 'the policy module' }

// A table as SQLite reads its name: bare or quoted ("t", `t`, [t]), with an optional main. schema prefix.
function table(names: readonly string[]): string {
	const quoted = (name: string) => `(?:${name}|"${name}"|\`${name}\`|\\[${name}\\])`
	return `(?:${quoted('main')}\\s*\\.\\s*)?${quoted(`(?:${names.join('|')})`)}(?!\\w)`
}

// FROM t or JOIN t.
function reads(...names: string[]): RegExp {
	return new RegExp(`\\b(?:FROM|JOIN)\\s+${table(names)}`, 'i')
}

// One SQL string (no quote or statement end between) that reads follows and an inbox column, in either order.
const FOLLOWER_INBOXES = new RegExp(
	[
		`\\b(?:FROM|JOIN)\\s+${table(['follows'])}[^\`';]*?\\b(?:shared_)?inbox_url\\b`,
		`\\b(?:shared_)?inbox_url\\b[^\`';]*?\\b(?:FROM|JOIN)\\s+${table(['follows'])}`,
	].join('|'),
	'i'
)

// INSERT INTO t, INSERT OR <conflict> INTO t, or REPLACE INTO t.
function writes(...names: string[]): RegExp {
	return new RegExp(
		`\\b(?:INSERT(?:\\s+OR\\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE))?|REPLACE)\\s+INTO\\s+${table(names)}`,
		'i'
	)
}

const RULES: readonly Rule[] = [
	{
		name: 'reads blocks',
		pattern: reads('blocks'),
		allowed: {
			...POLICY_ONLY,
			'src/domain/blocks.ts': 'writes blocks (block, unblock) and lists the viewer’s own',
			'src/domain/inbox.ts': 'writes blocks: an inbound Block and its Undo, a Move carrying them, an actor purge',
		},
	},
	{
		name: 'reads mutes',
		pattern: reads('mutes'),
		allowed: {
			...POLICY_ONLY,
			'src/domain/blocks.ts': 'writes mutes (mute, unmute) and lists the viewer’s own',
			'src/domain/inbox.ts': 'writes mutes: the expired mute sweep, a Move carrying them, an actor purge',
		},
	},
	{
		name: 'reads domain_blocks',
		pattern: reads('domain_blocks'),
		allowed: {
			...POLICY_ONLY,
			'src/domain/blocks.ts': 'writes domain blocks and their cleanups, and lists the viewer’s own',
		},
	},
	{
		name: 'judges suspension or deletion',
		pattern: /\b(?:suspended_at|deleted_at)\s+IS\s+(?:NOT\s+)?NULL\b/i,
		allowed: POLICY_ONLY,
	},
	{
		name: 'spells a set of visibilities',
		pattern: /\bIN\s*\(\s*'(?:public|unlisted|private|direct|limited)'\s*,/i,
		allowed: POLICY_ONLY,
	},
	{
		name: 'writes notifications',
		pattern: writes('notifications'),
		allowed: { 'src/domain/notifications.ts': 'notify, through the notification rule (VIS-10)' },
	},
	{
		name: 'writes outbound activities or deliveries',
		pattern: writes('outbound_activities', 'deliveries'),
		allowed: { 'src/domain/deliveries.ts': 'enqueueActivity and the expansion of its targets (NET-2)' },
	},
	{
		name: 'writes status_mentions',
		pattern: writes('status_mentions'),
		allowed: {
			'src/domain/statuses.ts': 'a local status’s mentions, resolved by mentionableBySql',
			'src/domain/remote-statuses.ts': 'an inbound status’s addressing (interpretAddressing) and its later audience',
			'src/domain/inbox.ts': 'an inbound boost’s addressing, as silent mentions',
			'src/domain/quotes.ts':
				'an accepted QuoteRequest makes the quoted author a silent mention of the quoting status (Quote#ensure_quoted_access)',
		},
	},
	{
		name: 'expands followers into inboxes',
		pattern: FOLLOWER_INBOXES,
		allowed: {
			...POLICY_ONLY,
			'src/domain/actors.ts':
				'the followers and following collections (R13), whose items name an inbox; nothing is sent',
		},
	},
	{
		name: 'reads shared inboxes',
		pattern: /\bshared_inbox_url\b/i,
		allowed: {
			...POLICY_ONLY,
			'src/domain/inbox.ts': 'stores a remote actor’s inboxes',
			'src/domain/deliveries.ts': 'moves a row its recipient’s shared inbox refused to that recipient’s own inbox',
		},
	},
	{
		// R28: a private note is shown to its author alone.
		name: 'reads account_notes',
		pattern: reads('account_notes'),
		allowed: {
			'src/domain/accounts.ts': 'the viewer’s own notes, in their relationships (relationshipsOf), and their writes',
			'src/domain/inbox.ts': 'an actor purge deletes the notes on the account',
		},
	},
	{
		// R39: a dismissal is its owner's alone; only the policy module reads it (suggestionCandidateSql).
		name: 'reads or writes follow_recommendation_mutes',
		pattern: new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${table(['follow_recommendation_mutes'])}`, 'i'),
		allowed: {
			...POLICY_ONLY,
			'src/domain/suggestions.ts': 'the viewer’s own dismissals (dismissSuggestion)',
			'src/domain/inbox.ts': 'an actor purge deletes the dismissals of the account',
		},
	},
	{
		// R31: a conversation mute is its owner's alone; only the policy module reads it (conversationMutedSql).
		name: 'reads conversation_mutes',
		pattern: reads('conversation_mutes'),
		allowed: {
			...POLICY_ONLY,
			'src/domain/status-actions.ts': 'unmuting deletes the viewer’s own mute',
		},
	},
	{
		// R26: nothing of a scheduled status is shown, notified or delivered before it is published.
		name: 'reads or writes scheduled_statuses',
		pattern: new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${table(['scheduled_statuses'])}`, 'i'),
		allowed: {
			'src/domain/scheduled-statuses.ts': 'the owner’s scheduled statuses (scheduledOwnSql) and their publication',
		},
	},
	{
		// R27: votes are their voters' own; only counts and a viewer's own votes are shown, never who voted.
		name: 'reads or writes poll_votes',
		pattern: new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${table(['poll_votes'])}`, 'i'),
		allowed: {
			...POLICY_ONLY,
			'src/domain/polls.ts': 'votes cast through mayVoteSql (R27), the viewer’s own, and their purges',
		},
	},
	{
		// R29: the hashtags an account follows are its own; nobody else is shown them.
		name: 'reads or writes tag_follows',
		pattern: new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${table(['tag_follows'])}`, 'i'),
		allowed: {
			'src/domain/tags.ts': 'the viewer’s own followed hashtags: their follows, the list and the Tag’s following',
			'src/domain/timelines.ts': 'home’s windows of the viewer’s own followed hashtags (R9)',
		},
	},
	{
		// R34: a report is its reporter's; only its writer reads it, then the OAuth admin (R37), and a purge deletes the
		// reports of the account.
		name: 'reads or writes reports',
		pattern: new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${table(['reports'])}`, 'i'),
		allowed: {
			'src/domain/reports.ts':
				'the reporter’s report, written and answered once (createReport), and the OAuth admin’s reads and actions (R37)',
			'src/domain/inbox.ts': 'an actor purge deletes the reports of the account',
		},
	},
	{
		// Quotes are decided in one place: only quotes.ts decides a quote's state (VerifyQuoteService, the Delete of a
		// stamp, the answer to a QuoteRequest, a revoke) and keeps the answered requests, and only the policy module reads
		// them for a client (R35: quoteReads) or for reach (reachQuoters).
		name: 'reads or writes quotes',
		pattern: new RegExp(
			`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${table(['quotes', 'quote_revocations', 'quote_requests'])}`,
			'i'
		),
		allowed: {
			...POLICY_ONLY,
			'src/domain/quotes.ts':
				'quotes, their verification work, revocations, answered QuoteRequests and Kopje’s authorizations',
			'src/domain/inbox.ts':
				'a status’s batched delete detaches the quotes of it and deletes its own (STATUS_CHILDREN), never a revocation',
		},
	},
]

const files = (texts: Record<string, string>): Source[] => Object.entries(texts).map(([path, text]) => ({ path, text }))

function violations(all: readonly Source[], rules: readonly Rule[] = RULES): string[] {
	const code = new Map(all.map((source) => [source.path, parse(source).code]))
	const found: string[] = []
	for (const rule of rules) {
		for (const [file, text] of code) {
			if (rule.pattern.test(text) && rule.allowed[file] === undefined) {
				found.push(`${file} ${rule.name}`)
			}
		}
		for (const file of Object.keys(rule.allowed)) {
			if (file !== POLICY && !rule.pattern.test(code.get(file) ?? '')) {
				found.push(`${file} no longer ${rule.name}: drop it from the list`)
			}
		}
	}
	return found
}

// A source each rule flags in a module it does not allow, and a near miss it passes, in the order of RULES.
const RULE_FIXTURES: readonly [name: string, flagged: string, passed: string][] = [
	['reads blocks', "db.all('SELECT 1 FROM blocks b')", "db.all('SELECT 1 FROM blocks_archive b')"],
	['reads mutes', "db.all('SELECT 1 FROM x JOIN mutes m ON true')", "db.all('SELECT mutes FROM accounts')"],
	['reads domain_blocks', "db.all('SELECT 1 FROM main.domain_blocks d')", "db.all('SELECT 1 FROM x_domain_blocks d')"],
	[
		'judges suspension or deletion',
		"db.all('SELECT 1 FROM accounts a WHERE a.suspended_at IS NOT NULL')",
		"db.run('UPDATE accounts SET suspended_at = ?')",
	],
	[
		'spells a set of visibilities',
		"db.all(\"SELECT 1 FROM statuses WHERE visibility IN ('public', 'unlisted')\")",
		'db.all(`SELECT 1 FROM statuses WHERE visibility IN ${DISTRIBUTABLE_SQL}`)',
	],
	[
		'writes notifications',
		"db.run('INSERT OR IGNORE INTO notifications (id) VALUES (1)')",
		"db.run('DELETE FROM notifications WHERE id = ?')",
	],
	[
		'writes outbound activities or deliveries',
		"db.run('REPLACE INTO deliveries (id) VALUES (1)')",
		"db.run('INSERT INTO push_deliveries (id) VALUES (1)')",
	],
	[
		'writes status_mentions',
		'db.run(\'INSERT INTO "status_mentions" (id) VALUES (1)\')',
		"db.all('SELECT 1 FROM status_mentions')",
	],
	[
		'expands followers into inboxes',
		"db.all('SELECT a.inbox_url FROM accounts a JOIN follows f ON f.account_id = a.id')",
		"f('SELECT 1 FROM follows', 'SELECT inbox_url FROM x')",
	],
	['reads shared inboxes', 'const url = row.shared_inbox_url', "db.all('SELECT a.inbox_url FROM accounts a')"],
	[
		'reads account_notes',
		"db.all('SELECT note FROM account_notes')",
		"db.run('INSERT INTO account_notes (id) VALUES (1)')",
	],
	[
		'reads or writes follow_recommendation_mutes',
		"db.run('INSERT OR IGNORE INTO follow_recommendation_mutes (id) VALUES (1)')",
		"db.all('SELECT 1 FROM follow_recommendation_mutes_archive')",
	],
	[
		'reads conversation_mutes',
		"db.all('SELECT 1 FROM conversation_mutes')",
		"db.run('INSERT INTO conversation_mutes (id) VALUES (1)')",
	],
	[
		'reads or writes scheduled_statuses',
		"db.run('UPDATE scheduled_statuses SET x = 1')",
		"db.all('SELECT 1 FROM scheduled_statuses_archive')",
	],
	[
		'reads or writes poll_votes',
		"db.run('INSERT INTO poll_votes (id) VALUES (1)')",
		"db.all('SELECT votes_count FROM polls')",
	],
	[
		'reads or writes tag_follows',
		"db.all('SELECT 1 FROM x JOIN tag_follows t ON true')",
		"db.all('SELECT 1 FROM tags')",
	],
	['reads or writes reports', "db.all('SELECT 1 FROM reports r')", "db.all('SELECT reports FROM x')"],
	[
		'reads or writes quotes',
		"db.run('UPDATE quote_requests SET x = 1')",
		"db.all('SELECT quotes_count FROM statuses')",
	],
]

describe('policy boundary', () => {
	it('sees the source tree', () => {
		expect(SOURCES.map((s) => s.path)).toEqual(expect.arrayContaining([POLICY, 'src/domain/timelines.ts']))
	})

	it('keeps the rules in the policy module and the writes with their single writers', () => {
		expect(violations(SOURCES)).toEqual([])
	})

	it('detects violations and stale entries', () => {
		const fixtures = files({
			[POLICY]: 'db.all(`FROM blocks b`)',
			'src/domain/a.ts': 'db.all(`SELECT 1 FROM mutes m JOIN domain_blocks d WHERE l.suspended_at IS NOT NULL`)',
			'src/domain/b.ts':
				"db.all(`WHERE s.visibility IN ('public', 'unlisted') AND a.deleted_at IS NULL\nINSERT INTO notifications (id)`)",
			'src/domain/c.ts': 'db.all(`SELECT 1`)\n// SELECT 1 FROM lists',
		})
		const rules: Rule[] = [
			...RULES.slice(0, 6).map((rule) => ({ ...rule, allowed: POLICY_ONLY })),
			{ name: 'reads lists', pattern: /\bFROM\s+lists\b/, allowed: { 'src/domain/c.ts': 'stale' } },
		]
		expect(violations(fixtures, rules)).toEqual([
			'src/domain/a.ts reads mutes',
			'src/domain/a.ts reads domain_blocks',
			'src/domain/a.ts judges suspension or deletion',
			'src/domain/b.ts judges suspension or deletion',
			'src/domain/b.ts spells a set of visibilities',
			'src/domain/b.ts writes notifications',
			'src/domain/c.ts no longer reads lists: drop it from the list',
		])
	})

	guardFixtures(
		violations,
		{
			flagged: {
				'a read in a template': ['db.all(`SELECT 1 FROM ${t} JOIN blocks b`)', 'src/domain/probe.ts reads blocks'],
				...Object.fromEntries(
					RULE_FIXTURES.map(([name, flagged]) => [name, [flagged, `src/domain/probe.ts ${name}`] as [string, string]])
				),
			},
			passed: {
				'a read named in a comment': '// SELECT 1 FROM blocks b\nf()',
				...Object.fromEntries(RULE_FIXTURES.map(([name, , passed]) => [name, passed])),
			},
		},
		{ over: SOURCES }
	)

	it('has a fixture for every rule', () => {
		expect(RULE_FIXTURES.map(([name]) => name)).toEqual(RULES.map((rule) => rule.name))
	})
	guardFixtures(
		violations,
		{
			flagged: {
				'an allowed file that reads only in a comment': [
					'// SELECT * FROM scheduled_statuses\nf()',
					'src/domain/scheduled-statuses.ts no longer reads or writes scheduled_statuses: drop it from the list',
				],
			},
			passed: {},
		},
		{ path: 'src/domain/scheduled-statuses.ts', over: SOURCES }
	)
})

// The status ids the presenter accepts (VisibleStatusId, OwnStatusId, and WithVisibleStatus for a query's rows) are
// types only, made by the policy module after it applied a rule for the viewer. Elsewhere a brand's name may only
// constrain a value the policy module made: in an import, or as the type of a function parameter. Any other mention (a
// cast, a type argument such as db.all<{ id: VisibleStatusId }>, a type predicate, an alias, an annotated variable or
// return type) could make one from a plain string. The presenter is called only from the domain modules, where ESLint
// refuses an `any` argument (eslint.config.js), so no `any` reaches its parameters either.
const BRANDS = new Set(['VisibleStatusId', 'OwnStatusId', 'WithVisibleStatus'])
const PRESENTER = 'src/domain/status-presenter.ts'
const PRESENTS = /^present(?:Own)?Status(?:es)?$/

// Whether the brand's type reference `parents[0]` is the type of a function parameter: `name: Brand`,
// `name?: readonly Brand[]`, `...names: Brand[]` or `name: WithVisibleStatus<...>[]`.
function parameterType(parents: readonly Node[]): boolean {
	let i = 1
	while (parents[i]?.type === 'TSArrayType' || (parents[i]?.type === 'TSTypeOperator' && i > 1)) {
		i++
	}
	const annotation = parents[i]
	const parameter = parents[i + 1]
	const owner = parents[i + 2] as { params?: unknown } | undefined
	return (
		annotation?.type === 'TSTypeAnnotation' &&
		(parameter?.type === 'Identifier' || parameter?.type === 'RestElement') &&
		Array.isArray(owner?.params) &&
		owner.params.includes(parameter)
	)
}

function brandViolations(all: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of all) {
		const file = source.path
		if (file === POLICY) {
			continue
		}
		let presents = false
		walk(parse(source).program, (node, parents) => {
			if (node.type !== 'Identifier' || parents.some((p) => p.type === 'ImportDeclaration')) {
				return
			}
			presents ||= PRESENTS.test(node.name)
			if (!BRANDS.has(node.name)) {
				return
			}
			const reference = parents[0]
			if (reference?.type !== 'TSTypeReference' || reference.typeName !== node || !parameterType(parents)) {
				found.push(`${file}:${lineOf(source.text, node.start)} names ${node.name} outside a parameter type`)
			}
		})
		if (!file.startsWith('src/domain/') && presents) {
			found.push(`${file} presents statuses outside the domain modules`)
		}
	}
	return found
}

describe('status id brands', () => {
	it('are made by the policy module only, and the presenter takes nothing else', () => {
		expect(SOURCES.map((s) => s.path)).toContain(PRESENTER)
		expect(brandViolations(SOURCES)).toEqual([])
	})

	it('detects a brand made outside the policy module', () => {
		const fixtures = files({
			[POLICY]: 'export function f(id: string) { return id as VisibleStatusId }',
			'src/domain/ok.ts': `// A comment may name VisibleStatusId.
import {
	type OwnStatusId,
	type VisibleStatusId,
} from './audience'
function f(db: Db, ids: readonly VisibleStatusId[], id?: OwnStatusId) {}
function g(
	rows: WithVisibleStatus<Row, 'id'>[],
	id: VisibleStatusId
) {}`,
			'src/domain/cast.ts': "import { x } from './x'\n\npresentStatus(db, id as VisibleStatusId, options)",
			'src/domain/double.ts': 'presentStatuses(db, ids as unknown as OwnStatusId[], options)',
			'src/domain/argument.ts': 'const rows = db.all<{ id: VisibleStatusId }>(query)',
			'src/domain/alias.ts': 'type Row = { id: VisibleStatusId }',
			'src/domain/predicate.ts': 'function f(id: string): id is VisibleStatusId { return true }',
			'src/domain/variable.ts': 'const id: VisibleStatusId = make()',
			'src/domain/result.ts': 'function f(id: string): VisibleStatusId[] { return [] }',
			'src/mastodon/routes.ts': 'presentStatuses(db, ids, options)',
		})
		expect(brandViolations(fixtures)).toEqual([
			'src/domain/cast.ts:3 names VisibleStatusId outside a parameter type',
			'src/domain/double.ts:1 names OwnStatusId outside a parameter type',
			'src/domain/argument.ts:1 names VisibleStatusId outside a parameter type',
			'src/domain/alias.ts:1 names VisibleStatusId outside a parameter type',
			'src/domain/predicate.ts:1 names VisibleStatusId outside a parameter type',
			'src/domain/variable.ts:1 names VisibleStatusId outside a parameter type',
			'src/domain/result.ts:1 names VisibleStatusId outside a parameter type',
			'src/mastodon/routes.ts presents statuses outside the domain modules',
		])
	})

	guardFixtures(brandViolations, {
		flagged: {
			'a member of an object type followed by another': [
				'type Row = { id: VisibleStatusId, n: number }',
				'src/domain/probe.ts:1 names VisibleStatusId outside a parameter type',
			],
			'a type argument with another member': [
				'db.all<{ id: VisibleStatusId, n: number }>(query)',
				'src/domain/probe.ts:1 names VisibleStatusId outside a parameter type',
			],
			'a re-export': [
				"export { type VisibleStatusId } from './audience'",
				'src/domain/probe.ts:1 names VisibleStatusId outside a parameter type',
			],
		},
		passed: {
			'a rest parameter and a function type': 'type F = (...ids: OwnStatusId[]) => void',
			'names in comments and strings': "/* id as VisibleStatusId */ f('OwnStatusId') // VisibleStatusId",
		},
	})
})

// Whether the rule `name` flags `text` as the source of a module it does not allow, through violations().
function flags(name: string, text: string): boolean {
	const rule = RULES.find((r) => r.name === name)
	expect(rule, name).toBeDefined()
	return (
		violations([{ path: 'src/domain/probe.ts', text }], rule === undefined ? [] : [{ ...rule, allowed: {} }]).length > 0
	)
}

// `sql` as a string literal, in a quote it does not hold.
function literal(sql: string): string {
	const quote = ["'", '"', '`'].find((q) => !sql.includes(q))
	expect(quote, sql).toBeDefined()
	return `db.all(${quote}${sql}${quote})`
}

describe('recipient selection', () => {
	it('finds follows turned into inboxes, in either order, and any read of a shared inbox', () => {
		for (const sql of [
			"SELECT DISTINCT COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) FROM follows f JOIN accounts a",
			'SELECT a.inbox_url FROM accounts a JOIN main.follows f ON f.account_id = a.id',
			'SELECT a.inbox_url FROM accounts a WHERE a.id IN (SELECT account_id FROM "follows")',
			'FROM follows f JOIN accounts a ON a.id = f.account_id WHERE f.state = 1 ORDER BY a.inbox_url',
		]) {
			expect(flags('expands followers into inboxes', literal(sql)), sql).toBe(true)
		}
		expect(flags('reads shared inboxes', literal('SELECT a.shared_inbox_url FROM accounts a'))).toBe(true)
	})

	it('does not join two strings or statements', () => {
		const rule = 'expands followers into inboxes'
		expect(flags(rule, "f('SELECT 1 FROM follows', 'SELECT inbox_url FROM x')")).toBe(false)
		expect(flags(rule, literal('SELECT 1 FROM follows; SELECT inbox_url FROM x'))).toBe(false)
		expect(flags(rule, literal('SELECT inbox_url FROM deliveries'))).toBe(false)
	})
})

describe('the guarded spellings', () => {
	const SPELLINGS = (t: string) => [t, `"${t}"`, `\`${t}\``, `[${t}]`, `main.${t}`, `main."${t}"`, `"main" . [${t}]`]

	for (const [name, tables] of [
		['reads blocks', ['blocks']],
		['reads mutes', ['mutes']],
		['reads domain_blocks', ['domain_blocks']],
	] as const) {
		it(`${name}: FROM and JOIN, any quoting, with or without main.`, () => {
			for (const t of tables) {
				for (const spelled of SPELLINGS(t)) {
					expect(flags(name, literal(`SELECT 1 FROM ${spelled} b`)), spelled).toBe(true)
					expect(flags(name, literal(`SELECT 1 FROM x JOIN ${spelled} b ON true`)), spelled).toBe(true)
				}
			}
		})
	}

	for (const [name, tables] of [
		['writes notifications', ['notifications']],
		['writes outbound activities or deliveries', ['outbound_activities', 'deliveries']],
		['writes status_mentions', ['status_mentions']],
	] as const) {
		it(`${name}: INSERT, INSERT OR <conflict> and REPLACE, any quoting, with or without main.`, () => {
			for (const t of tables) {
				for (const spelled of SPELLINGS(t)) {
					for (const verb of ['INSERT', 'insert or ignore', 'INSERT OR REPLACE', 'INSERT OR ABORT', 'REPLACE']) {
						expect(flags(name, literal(`${verb} INTO ${spelled} (id) VALUES (1)`)), `${verb} ${spelled}`).toBe(true)
					}
				}
			}
		})
	}

	it('does not mistake another table or a column for a guarded one', () => {
		expect(flags('reads blocks', literal('SELECT 1 FROM domain_blocks d'))).toBe(false)
		expect(flags('reads blocks', literal('SELECT 1 FROM blocks_archive b'))).toBe(false)
		expect(flags('reads blocks', literal('SELECT blocks FROM accounts'))).toBe(false)
		expect(flags('writes notifications', literal('INSERT INTO notifications_seen (id) VALUES (1)'))).toBe(false)
		expect(
			flags('writes outbound activities or deliveries', literal('INSERT INTO push_deliveries (id) VALUES (1)'))
		).toBe(false)
	})
})

// RES-6: no code deletes a local account (test/cascade-guard.test.ts, "cascade guard below local_accounts"), so the
// tables naming local_accounts are never met by a batched delete.
const LOCAL_ACCOUNT_DELETE = /\bDELETE\s+FROM\s+(?:main\s*\.\s*)?["`[]?local_accounts\b/i

const deletesLocalAccounts = (all: readonly Source[]) =>
	all.filter((source) => LOCAL_ACCOUNT_DELETE.test(parse(source).code)).map((source) => source.path)

describe('local accounts', () => {
	it('are deleted nowhere', () => {
		expect(deletesLocalAccounts(SOURCES.filter((s) => s.path.endsWith('.ts')))).toEqual([])
	})

	guardFixtures(deletesLocalAccounts, {
		flagged: {
			'a delete': ["db.run('DELETE FROM local_accounts WHERE account_id = ?', id)", 'src/domain/probe.ts'],
			'a quoted delete': ['db.run(`delete from main."local_accounts" WHERE 1`)', 'src/domain/probe.ts'],
		},
		passed: {
			'a delete in a comment': '// DELETE FROM local_accounts\nf()',
			'another table': "db.run('DELETE FROM local_accounts_archive')",
		},
	})
})
