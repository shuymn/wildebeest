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

// The innermost function around each match of `pattern` in `code`, with the names of the functions it calls (call
// expressions only: a name in a string or a comment is not a call).
type Enclosing = { start: number; calls: Set<string> }

function enclosing(program: Node, code: string, pattern: RegExp): Enclosing[] {
	const found: Enclosing[] = []
	for (const match of code.matchAll(new RegExp(pattern.source, 'g'))) {
		let best: Node | null = null
		walk(program, (node) => {
			if (FUNCTIONS.has(node.type) && node.start <= match.index && match.index < node.end) {
				best = node
			}
		})
		const fn = best as Node | null
		if (fn !== null) {
			const calls = new Set<string>()
			walk(fn, (node) => {
				if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
					calls.add(node.callee.name)
				}
			})
			found.push({ start: fn.start, calls })
		}
	}
	return found
}

const RULES = [
	{
		name: 'a local status insert without countStatus',
		insert: /\bINSERT\s+INTO\s+statuses\b/,
		local: 'allocateLocalId',
		calls: ['countStatus'],
	},
	{
		name: 'a local account insert without countRegistration and recordLogin',
		insert: /\bINSERT\s+INTO\s+local_accounts\b/,
		local: null,
		calls: ['countRegistration', 'recordLogin'],
	},
] as const

const isLocal = (rule: (typeof RULES)[number], fn: Enclosing) => rule.local === null || fn.calls.has(rule.local)

function violations(all: readonly Source[]): string[] {
	const found: string[] = []
	for (const source of all) {
		const { program, code } = parse(source)
		for (const rule of RULES) {
			for (const fn of enclosing(program, code, rule.insert)) {
				if (isLocal(rule, fn) && !rule.calls.every((call) => fn.calls.has(call))) {
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
				.filter((fn) => isLocal(rule, fn))
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
			'an account without its registration': [
				'const s = (db) => {\n\tdb.run(`INSERT INTO local_accounts (account_id) VALUES (?)`, id)\n\trecordLogin(db, id, now)\n}',
				'src/domain/probe.ts:1 a local account insert without countRegistration and recordLogin',
			],
			'a counter named in a string, not called': [
				"function p(db) {\n\tconst id = allocateLocalId(db, now)\n\tdb.run('INSERT INTO statuses (id) VALUES (?)', id, 'countStatus(')\n}",
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
