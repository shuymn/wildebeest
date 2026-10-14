import { describe, expect, it } from 'vitest'

import { MIGRATIONS } from '../src/db/migrations'
import { DISTRIBUTABLE_SQL, REACHES_FOLLOWERS_SQL, REQUIRES_MENTION_SQL } from '../src/domain/audience'

// The policy boundary (docs/visibility.md): the rules of who sees what, who is notified and who is addressed are SQL
// fragments of one module, src/domain/audience.ts. Elsewhere, SQL calls them instead of reading the tables they
// decide on, so a new read, notification or delivery path cannot apply a copy of a rule that drifts from it. Only the
// modules that write those tables read them directly, each for the reason given. The single writers of
// notifications, outbound activities and the audience rows are pinned the same way.

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

const RULES: readonly Rule[] = [
	{
		name: 'reads blocks',
		pattern: /\b(?:FROM|JOIN)\s+blocks\b/i,
		allowed: {
			...POLICY_ONLY,
			'../src/domain/blocks.ts': 'writes blocks (block, unblock) and lists the viewer’s own',
			'../src/domain/inbox.ts': 'writes blocks: an inbound Block and its Undo, a Move carrying them, an actor purge',
		},
	},
	{
		name: 'reads mutes',
		pattern: /\b(?:FROM|JOIN)\s+mutes\b/i,
		allowed: {
			...POLICY_ONLY,
			'../src/domain/blocks.ts': 'writes mutes (mute, unmute) and lists the viewer’s own',
			'../src/domain/inbox.ts': 'writes mutes: the expired mute sweep, a Move carrying them, an actor purge',
		},
	},
	{
		name: 'reads domain_blocks',
		pattern: /\b(?:FROM|JOIN)\s+domain_blocks\b/i,
		allowed: {
			...POLICY_ONLY,
			'../src/domain/blocks.ts': 'writes domain blocks and their cleanups, and lists the viewer’s own',
		},
	},
	{
		name: 'judges suspension',
		pattern: /\bsuspended_at\s+IS\s+(?:NOT\s+)?NULL\b/i,
		allowed: POLICY_ONLY,
	},
	{
		name: 'spells a set of visibilities',
		pattern: /\bIN\s*\(\s*'(?:public|unlisted|private|direct|limited)'\s*,/i,
		allowed: POLICY_ONLY,
	},
	{
		name: 'writes notifications',
		pattern: /\bINSERT\s+INTO\s+notifications\b/i,
		allowed: { '../src/domain/notifications.ts': 'notify, through the notification rule (VIS-10)' },
	},
	{
		name: 'writes outbound activities or deliveries',
		pattern: /\bINSERT\s+INTO\s+(?:outbound_activities|deliveries)\b/i,
		allowed: { '../src/domain/deliveries.ts': 'enqueueActivity and the expansion of its targets (NET-2)' },
	},
	{
		name: 'writes status_mentions',
		pattern: /\bINSERT\s+INTO\s+status_mentions\b/i,
		allowed: {
			'../src/domain/statuses.ts': 'a local status’s mentions, resolved by mentionableBySql',
			'../src/domain/remote-statuses.ts': 'an inbound status’s addressing (interpretAddressing) and its later audience',
			'../src/domain/inbox.ts': 'an inbound boost’s addressing, as silent mentions',
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
			'../src/domain/b.ts': "WHERE s.visibility IN ('public', 'unlisted') AND x\nINSERT INTO notifications (id)",
			'../src/domain/c.ts': 'SELECT 1',
		}
		const rules: Rule[] = [
			...RULES.slice(0, 6).map((rule) => ({ ...rule, allowed: POLICY_ONLY })),
			{ name: 'reads lists', pattern: /\bFROM\s+lists\b/, allowed: { '../src/domain/c.ts': 'stale' } },
		]
		expect(violations(files, rules)).toEqual([
			'../src/domain/a.ts reads mutes',
			'../src/domain/a.ts reads domain_blocks',
			'../src/domain/a.ts judges suspension',
			'../src/domain/b.ts spells a set of visibilities',
			'../src/domain/b.ts writes notifications',
			'../src/domain/c.ts no longer reads lists: drop it from the list',
		])
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
