import type { Node } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

import { guardFixtures, lineOf, parse, sources, walk, type Source } from './source-scan.js'

// GET /api/v1/instance/activity counts what Mastodon's ActivityTracker counts at creation
// (domain/instance-activity.ts): every function that inserts a local status (a statuses row whose id allocateLocalId
// gives) calls countStatus, and every function that inserts a local account (local_accounts) calls countRegistration
// and recordLogin. A remote status takes no local id, and an import or a cutover conversion runs no Store function
// that inserts one, so neither counts.

const SOURCES = sources('src')

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

// The innermost function around each match of `pattern` in `code`, as its text.
function enclosing(program: Node, code: string, pattern: RegExp): { start: number; text: string }[] {
	const found: { start: number; text: string }[] = []
	for (const match of code.matchAll(new RegExp(pattern.source, 'g'))) {
		let best: Node | null = null
		walk(program, (node) => {
			if (FUNCTIONS.has(node.type) && node.start <= match.index && match.index < node.end) {
				best = node
			}
		})
		const node = best as Node | null
		if (node !== null) {
			found.push({ start: node.start, text: code.slice(node.start, node.end) })
		}
	}
	return found
}

const RULES = [
	{
		name: 'a local status insert without countStatus',
		insert: /\bINSERT\s+INTO\s+statuses\b/,
		local: /\ballocateLocalId\(/,
		calls: [/\bcountStatus\(/],
	},
	{
		name: 'a local account insert without countRegistration and recordLogin',
		insert: /\bINSERT\s+INTO\s+local_accounts\b/,
		local: null,
		calls: [/\bcountRegistration\(/, /\brecordLogin\(/],
	},
] as const

function violations(all: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of all) {
		const { program, code } = parse(source)
		for (const rule of RULES) {
			for (const fn of enclosing(program, code, rule.insert)) {
				if ((rule.local === null || rule.local.test(fn.text)) && !rule.calls.every((call) => call.test(fn.text))) {
					found.push(`${source.path}:${lineOf(source.text, fn.start)} ${rule.name}`)
				}
			}
		}
	}
	return [...new Set(found)]
}

// The functions each rule covers in the tree, so the guard cannot pass over nothing.
function covered(all: readonly Source[]): string[] {
	return all.flatMap((source) => {
		const { program, code } = parse(source)
		return RULES.flatMap((rule) =>
			enclosing(program, code, rule.insert)
				.filter((fn) => rule.local === null || rule.local.test(fn.text))
				.map(() => `${source.path} ${rule.name.split(' without')[0]}`)
		)
	})
}

describe('instance activity writers', () => {
	it('counts every local status and account the Store inserts', () => {
		expect(violations(SOURCES)).toEqual([])
		expect(covered(SOURCES).sort()).toEqual(
			[
				'src/domain/setup.ts a local account insert',
				'src/domain/statuses.ts a local status insert',
				'src/domain/statuses.ts a local status insert',
			].sort()
		)
	})

	guardFixtures(violations, {
		flagged: {
			'a post without the counter': [
				"function p(db) {\n\tconst id = allocateLocalId(db, now)\n\tdb.run('INSERT INTO statuses (id) VALUES (?)', id)\n}",
				'src/domain/probe.ts:1 a local status insert without countStatus',
			],
			'an account without its login': [
				'const s = (db) => {\n\tdb.run(`INSERT INTO local_accounts (account_id) VALUES (?)`, id)\n\tcountRegistration(db, now)\n}',
				'src/domain/probe.ts:1 a local account insert without countRegistration and recordLogin',
			],
		},
		passed: {
			'a remote status': "function r(db) {\n\tdb.run('INSERT INTO statuses (id) VALUES (?)', storedId)\n}",
			'a counted post': [
				'function p(db) {',
				'\tconst id = allocateLocalId(db, now)',
				"\tdb.run('INSERT INTO statuses (id) VALUES (?)', id)",
				'\tcountStatus(db, visibility, now)',
				'}',
			].join('\n'),
			'an insert named in a comment': '// INSERT INTO local_accounts\nf()',
		},
	})
})
