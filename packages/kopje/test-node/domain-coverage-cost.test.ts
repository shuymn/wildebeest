import type { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { createKopjeDatabase } from '../cli/lib/cutover/kopje-db.js'

// The no-block fast path of R38's domain coverage (audience.ts guardedSql), by what SQLite executes: the walk of a
// host's suffixes calls instr() at every label, so instr(), overridden here by a counting function of the same
// behavior, counts the walk. Workerd's rows-read counter does not count a walk that finds no block, and node:sqlite
// exposes no SQLITE_STMTSTATUS_VM_STEP, so the calls are the execution measure. Each projection's values are read in
// full. This pins that no host is walked without a suspend block; it cannot tell the CASE from an AND here: node's
// SQLite (3.53) skips the walk's EXISTS under a false AND, where the sqlite3 3.51 shell ran it (31,042 against 178,042
// virtual machine steps over 1,000 accounts), so the CASE is what holds on either.

const ACCOUNTS = 200

// The Store's SQL builders, loaded by a computed specifier: audience.ts is typed against the Workers runtime, which
// this suite's TypeScript project does not include.
const { availableJoinedSql, availableSql } = (await import(
	new URL('../src/domain/audience.ts', import.meta.url).href
)) as { availableJoinedSql: (a: string, l: string) => string; availableSql: (x: string) => string }

function store(labels: number, blocks: [string, 'suspend' | 'noop'][]): { db: DatabaseSync; calls: () => number } {
	const db = createKopjeDatabase()
	let calls = 0
	db.function('instr', { deterministic: true }, (haystack, needle) => {
		calls++
		return typeof haystack === 'string' && typeof needle === 'string' ? haystack.indexOf(needle) + 1 : null
	})
	const domain = [...Array.from({ length: labels - 2 }, (_, i) => `l${i}`), 'far', 'example'].join('.')
	db.prepare(
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT CAST(500000000000000000 + i AS TEXT), 'https://' || ?2 || '/users/u' || i, 'u' || i, ?2 FROM n`
	).run(ACCOUNTS, domain)
	for (const [blocked, severity] of blocks) {
		db.prepare(
			"INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at) VALUES (?, ?, 'x', 'x')"
		).run(blocked, severity)
	}
	return { db, calls: () => calls }
}

// instr() calls of each availability form projected over every account, its values read in full.
function walked(labels: number, blocks: [string, 'suspend' | 'noop'][]): { joined: number; single: number } {
	const projections = {
		joined: `SELECT a.id, ${availableJoinedSql('a', 'l')} AS v FROM accounts a LEFT JOIN local_accounts l ON l.account_id = a.id`,
		single: `SELECT a.id, ${availableSql('a.id')} AS v FROM accounts a`,
	}
	const counted = { joined: 0, single: 0 }
	for (const [form, query] of Object.entries(projections) as [keyof typeof projections, string][]) {
		const { db, calls } = store(labels, blocks)
		const rows = db.prepare(query.replaceAll('main.', '')).all() as { v: number }[]
		expect(rows).toHaveLength(ACCOUNTS)
		expect(rows.every((row) => row.v === 1)).toBe(true)
		counted[form] = calls()
		db.close()
	}
	return counted
}

describe('domain coverage in a result column (R38)', () => {
	it('walks no host while no suspend block exists, however deep, and walks each once one exists', () => {
		const none = { joined: 0, single: 0 }
		expect(walked(2, [])).toEqual(none)
		expect(walked(12, [])).toEqual(none)
		expect(walked(12, [['far.example', 'noop']])).toEqual(none)
		// The positive control: a suspend block elsewhere makes every account walk its host, deeper ones longer.
		const shallow = walked(2, [['elsewhere.example', 'suspend']])
		const deep = walked(12, [['elsewhere.example', 'suspend']])
		expect(shallow.joined).toBeGreaterThanOrEqual(ACCOUNTS)
		expect(shallow.single).toBeGreaterThanOrEqual(ACCOUNTS)
		expect(deep.joined).toBeGreaterThan(shallow.joined + 5 * ACCOUNTS)
		expect(deep.single).toBeGreaterThan(shallow.single + 5 * ACCOUNTS)
	})
})
