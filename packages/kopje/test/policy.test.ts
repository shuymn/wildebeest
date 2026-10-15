import { describe, expect, it } from 'vitest'

import { MIGRATIONS } from '../src/db/migrations'
import { DISTRIBUTABLE_SQL, REACHES_FOLLOWERS_SQL, REQUIRES_MENTION_SQL } from '../src/domain/audience'

// The policy boundary (docs/visibility.md): the rules of who sees what, who is notified and who is addressed are SQL
// fragments of one module, src/domain/audience.ts. Elsewhere, SQL calls them instead of reading the tables they
// decide on, so a new read, notification or delivery path cannot apply a copy of a rule that drifts from it. Only the
// modules that write those tables read them directly, each for the reason given. The single writers of
// notifications, outbound activities and the audience rows are pinned the same way, and so is the selection of an
// activity's recipients (recipientsFor): no other SQL turns follows into inboxes or picks an account's shared inbox.

const POLICY = '../src/domain/audience.ts'

const sources = import.meta.glob<string>(['../src/**/*.ts', '../src/**/*.tsx', '!../src/**/*.d.ts'], {
	query: '?raw',
	import: 'default',
	eager: true,
})

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
			'../src/domain/blocks.ts': 'writes blocks (block, unblock) and lists the viewer’s own',
			'../src/domain/inbox.ts': 'writes blocks: an inbound Block and its Undo, a Move carrying them, an actor purge',
		},
	},
	{
		name: 'reads mutes',
		pattern: reads('mutes'),
		allowed: {
			...POLICY_ONLY,
			'../src/domain/blocks.ts': 'writes mutes (mute, unmute) and lists the viewer’s own',
			'../src/domain/inbox.ts': 'writes mutes: the expired mute sweep, a Move carrying them, an actor purge',
		},
	},
	{
		name: 'reads domain_blocks',
		pattern: reads('domain_blocks'),
		allowed: {
			...POLICY_ONLY,
			'../src/domain/blocks.ts': 'writes domain blocks and their cleanups, and lists the viewer’s own',
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
		allowed: { '../src/domain/notifications.ts': 'notify, through the notification rule (VIS-10)' },
	},
	{
		name: 'writes outbound activities or deliveries',
		pattern: writes('outbound_activities', 'deliveries'),
		allowed: { '../src/domain/deliveries.ts': 'enqueueActivity and the expansion of its targets (NET-2)' },
	},
	{
		name: 'writes status_mentions',
		pattern: writes('status_mentions'),
		allowed: {
			'../src/domain/statuses.ts': 'a local status’s mentions, resolved by mentionableBySql',
			'../src/domain/remote-statuses.ts': 'an inbound status’s addressing (interpretAddressing) and its later audience',
			'../src/domain/inbox.ts': 'an inbound boost’s addressing, as silent mentions',
		},
	},
	{
		name: 'expands followers into inboxes',
		pattern: FOLLOWER_INBOXES,
		allowed: {
			...POLICY_ONLY,
			'../src/domain/actors.ts':
				'the followers and following collections (R13), whose items name an inbox; nothing is sent',
		},
	},
	{
		name: 'reads shared inboxes',
		pattern: /\bshared_inbox_url\b/i,
		allowed: {
			...POLICY_ONLY,
			'../src/domain/inbox.ts': 'stores a remote actor’s inboxes',
			'../src/domain/deliveries.ts': 'moves a row its recipient’s shared inbox refused to that recipient’s own inbox',
		},
	},
	{
		// R26: nothing of a scheduled status is shown, notified or delivered before it is published.
		name: 'reads or writes scheduled_statuses',
		pattern: new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${table(['scheduled_statuses'])}`, 'i'),
		allowed: {
			'../src/domain/scheduled-statuses.ts': 'the owner’s scheduled statuses (scheduledOwnSql) and their publication',
		},
	},
]

function violations(files: Record<string, string>, rules: readonly Rule[] = RULES): string[] {
	const found: string[] = []
	for (const rule of rules) {
		for (const [file, source] of Object.entries(files)) {
			if (rule.pattern.test(source) && rule.allowed[file] === undefined) {
				found.push(`${file} ${rule.name}`)
			}
		}
		for (const file of Object.keys(rule.allowed)) {
			if (file !== POLICY && !rule.pattern.test(files[file] ?? '')) {
				found.push(`${file} no longer ${rule.name}: drop it from the list`)
			}
		}
	}
	return found
}

describe('policy boundary', () => {
	it('sees the source tree', () => {
		expect(Object.keys(sources)).toEqual(expect.arrayContaining([POLICY, '../src/domain/timelines.ts']))
	})

	it('keeps the rules in the policy module and the writes with their single writers', () => {
		expect(violations(sources)).toEqual([])
	})

	it('detects violations and stale entries', () => {
		const files = {
			[POLICY]: 'FROM blocks b',
			'../src/domain/a.ts': 'SELECT 1 FROM mutes m JOIN domain_blocks d WHERE l.suspended_at IS NOT NULL',
			'../src/domain/b.ts':
				"WHERE s.visibility IN ('public', 'unlisted') AND a.deleted_at IS NULL\nINSERT INTO notifications (id)",
			'../src/domain/c.ts': 'SELECT 1',
		}
		const rules: Rule[] = [
			...RULES.slice(0, 6).map((rule) => ({ ...rule, allowed: POLICY_ONLY })),
			{ name: 'reads lists', pattern: /\bFROM\s+lists\b/, allowed: { '../src/domain/c.ts': 'stale' } },
		]
		expect(violations(files, rules)).toEqual([
			'../src/domain/a.ts reads mutes',
			'../src/domain/a.ts reads domain_blocks',
			'../src/domain/a.ts judges suspension or deletion',
			'../src/domain/b.ts judges suspension or deletion',
			'../src/domain/b.ts spells a set of visibilities',
			'../src/domain/b.ts writes notifications',
			'../src/domain/c.ts no longer reads lists: drop it from the list',
		])
	})
})

// The status ids the presenter accepts (VisibleStatusId, OwnStatusId, and WithVisibleStatus for a query's rows) are
// types only, made by the policy module after it applied a rule for the viewer. Elsewhere a brand's name may only
// constrain a value the policy module made: in an import, or as the type of a function parameter. Any other mention (a
// cast, a type argument such as db.all<{ id: VisibleStatusId }>, a type predicate, an alias, an annotated variable or
// return type) could make one from a plain string. The presenter is called only from the domain modules, where ESLint
// refuses an `any` argument (eslint.config.js), so no `any` reaches its parameters either.
const BRAND = /\b(?:VisibleStatusId|OwnStatusId|WithVisibleStatus)\b/g
const IMPORT = /^import\s[\s\S]*?\sfrom\s+'[^']*'/gm
const COMMENT_LINE = /^\s*\/\/.*$/gm
// `name: Brand`, `name?: readonly Brand[]` or `name: WithVisibleStatus<...>[]`, ending the parameter.
const PARAMETER_BEFORE = /(?<!\b(?:const|let|var)\s+)\b\w+\??:\s*(?:readonly\s+)?$/
const PARAMETER_AFTER = /^(?:<[^<>]*>)?(?:\[\])?\s*[,)]/
const PRESENTER = '../src/domain/status-presenter.ts'
const PRESENTS = /\bpresent(?:Own)?Status(?:es)?\b/

function brandViolations(files: Record<string, string>): string[] {
	const found: string[] = []
	for (const [file, source] of Object.entries(files)) {
		if (file === POLICY) {
			continue
		}
		// Imports and comment lines are blanked, keeping their line breaks.
		const code = source.replace(IMPORT, (text) => text.replace(/[^\n]/g, '')).replace(COMMENT_LINE, '')
		for (const match of code.matchAll(BRAND)) {
			const before = code.slice(0, match.index)
			const after = code.slice(match.index + match[0].length)
			if (!PARAMETER_BEFORE.test(before) || !PARAMETER_AFTER.test(after)) {
				const line = before.split('\n').length
				found.push(`${file}:${line} names ${match[0]} outside a parameter type`)
			}
		}
		if (!file.startsWith('../src/domain/') && PRESENTS.test(code)) {
			found.push(`${file} presents statuses outside the domain modules`)
		}
	}
	return found
}

describe('status id brands', () => {
	it('are made by the policy module only, and the presenter takes nothing else', () => {
		expect(Object.keys(sources)).toContain(PRESENTER)
		expect(brandViolations(sources)).toEqual([])
	})

	it('detects a brand made outside the policy module', () => {
		const files = {
			[POLICY]: 'export function f(id: string) { return id as VisibleStatusId }',
			'../src/domain/ok.ts': `// A comment may name VisibleStatusId.
import {
	type OwnStatusId,
	type VisibleStatusId,
} from './audience'
function f(db: Db, ids: readonly VisibleStatusId[], id?: OwnStatusId) {}
function g(
	rows: WithVisibleStatus<Row, 'id'>[],
	id: VisibleStatusId
) {}`,
			'../src/domain/cast.ts': "import { x } from './x'\n\npresentStatus(db, id as VisibleStatusId, options)",
			'../src/domain/double.ts': 'presentStatuses(db, ids as unknown as OwnStatusId[], options)',
			'../src/domain/argument.ts': 'const rows = db.all<{ id: VisibleStatusId }>(query)',
			'../src/domain/alias.ts': 'type Row = { id: VisibleStatusId }',
			'../src/domain/predicate.ts': 'function f(id: string): id is VisibleStatusId { return true }',
			'../src/domain/variable.ts': 'const id: VisibleStatusId = make()',
			'../src/domain/result.ts': 'function f(id: string): VisibleStatusId[] { return [] }',
			'../src/mastodon/routes.ts': 'presentStatuses(db, ids, options)',
		}
		expect(brandViolations(files)).toEqual([
			'../src/domain/cast.ts:3 names VisibleStatusId outside a parameter type',
			'../src/domain/double.ts:1 names OwnStatusId outside a parameter type',
			'../src/domain/argument.ts:1 names VisibleStatusId outside a parameter type',
			'../src/domain/alias.ts:1 names VisibleStatusId outside a parameter type',
			'../src/domain/predicate.ts:1 names VisibleStatusId outside a parameter type',
			'../src/domain/variable.ts:1 names VisibleStatusId outside a parameter type',
			'../src/domain/result.ts:1 names VisibleStatusId outside a parameter type',
			'../src/mastodon/routes.ts presents statuses outside the domain modules',
		])
	})
})

describe('recipient selection', () => {
	const rule = (name: string) => RULES.find((r) => r.name === name)!.pattern

	it('finds follows turned into inboxes, in either order, and any read of a shared inbox', () => {
		for (const sql of [
			"SELECT DISTINCT COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) FROM follows f JOIN accounts a",
			'SELECT a.inbox_url FROM accounts a JOIN main.follows f ON f.account_id = a.id',
			'SELECT a.inbox_url FROM accounts a WHERE a.id IN (SELECT account_id FROM "follows")',
			'FROM follows f JOIN accounts a ON a.id = f.account_id WHERE f.state = 1 ORDER BY a.inbox_url',
		]) {
			expect(rule('expands followers into inboxes').test(sql), sql).toBe(true)
		}
		expect(rule('reads shared inboxes').test('SELECT a.shared_inbox_url FROM accounts a')).toBe(true)
	})

	it('does not join two strings or statements', () => {
		expect(rule('expands followers into inboxes').test("'SELECT 1 FROM follows', 'SELECT inbox_url FROM x'")).toBe(
			false
		)
		expect(rule('expands followers into inboxes').test('SELECT 1 FROM follows; SELECT inbox_url FROM x')).toBe(false)
		expect(rule('expands followers into inboxes').test('SELECT inbox_url FROM deliveries')).toBe(false)
	})
})

describe('the guarded spellings', () => {
	const rule = (name: string) => RULES.find((r) => r.name === name)!.pattern
	const SPELLINGS = (t: string) => [t, `"${t}"`, `\`${t}\``, `[${t}]`, `main.${t}`, `main."${t}"`, `"main" . [${t}]`]

	for (const [name, tables] of [
		['reads blocks', ['blocks']],
		['reads mutes', ['mutes']],
		['reads domain_blocks', ['domain_blocks']],
	] as const) {
		it(`${name}: FROM and JOIN, any quoting, with or without main.`, () => {
			for (const t of tables) {
				for (const spelled of SPELLINGS(t)) {
					expect(rule(name).test(`SELECT 1 FROM ${spelled} b`), spelled).toBe(true)
					expect(rule(name).test(`SELECT 1 FROM x JOIN ${spelled} b ON true`), spelled).toBe(true)
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
						expect(rule(name).test(`${verb} INTO ${spelled} (id) VALUES (1)`), `${verb} ${spelled}`).toBe(true)
					}
				}
			}
		})
	}

	it('does not mistake another table or a column for a guarded one', () => {
		expect(rule('reads blocks').test('SELECT 1 FROM domain_blocks d')).toBe(false)
		expect(rule('reads blocks').test('SELECT 1 FROM blocks_archive b')).toBe(false)
		expect(rule('reads blocks').test('SELECT blocks FROM accounts')).toBe(false)
		expect(rule('writes notifications').test('INSERT INTO notifications_seen (id) VALUES (1)')).toBe(false)
		expect(rule('writes outbound activities or deliveries').test('INSERT INTO push_deliveries (id) VALUES (1)')).toBe(
			false
		)
	})
})

describe('visibility sets', () => {
	it('are generated from isDistributable and requiresMention', () => {
		expect(DISTRIBUTABLE_SQL).toBe("('public', 'unlisted')")
		expect(REQUIRES_MENTION_SQL).toBe("('direct', 'limited')")
		expect(REACHES_FOLLOWERS_SQL).toBe("('public', 'unlisted', 'private')")
	})

	it('match the partial index the feeds use, which SQLite applies only to the same list', () => {
		const schema = MIGRATIONS.map((migration) => migration.sql).join('\n')
		expect(schema).toContain(
			`CREATE INDEX statuses_feed ON statuses (account_id, id) WHERE visibility IN ${REACHES_FOLLOWERS_SQL};`
		)
	})
})
