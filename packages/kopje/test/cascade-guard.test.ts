import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { migratedStore } from './helpers'
import { PURGED_ACCOUNT_CHILDREN, STATUS_CHILDREN } from '../src/domain/inbox'

// RES-6: a status's delete (deleteStatusWithin) and a remote account's purge (purgeBatch) remove the rows that name
// their parent a batch at a time and delete the parent only once none is left, so the parent's delete cascades
// nothing. A table that cascades from the parent but is missing from inbox.ts's lists would be emptied by that final
// delete, unbounded. These tests read every cascading foreign key of the migrated schema and require each table to be
// in the list or exempted here with the reason it is bounded or never met.

// Tables met through the status's cascades (or SET NULL) that deleteStatusWithin does not list.
const STATUS_EXEMPT: Record<string, string> = {
	statuses:
		'self-references: the replies are detached (in_reply_to_id) and boosts deleted before the status, by its own steps',
	polls: 'one row per status, deleted with it',
	poll_votes: 'below polls: deleted a batch at a time by deletePollVotes, checked by hasPollVotes',
	conversation_statuses:
		'one row per conversation holding the status, at most one per local account (owner, thread, participants); its trigger updates or deletes that conversation',
	push_deliveries: 'below notifications, which go a batch at a time; at most MAX_PUSH_BACKLOG (1,000) wait in all',
}

// Tables met through the account's cascades that the purge's completion check (accountHasRows) does not list. A
// purge deletes only a remote account (`domain IS NOT NULL`), so a table only a local account owns never holds its
// rows; the tables naming local_accounts are not met at all, since local_accounts restricts the delete.
const ACCOUNT_EXEMPT: Record<string, string> = {
	conversations: 'owned by a local account only; a remote account is the only one purged',
	conversation_statuses: 'below conversations, owned by a local account only',
	poll_votes: 'deleted a batch at a time by deleteAccountVotes, checked by hasPollVotes in accountHasRows',
	push_deliveries: 'below notifications, which go a batch at a time; at most MAX_PUSH_BACKLOG (1,000) wait in all',
}

type ForeignKey = { from: string; table: string; column: string; onDelete: string }

function foreignKeys(sql: SqlStorage): ForeignKey[] {
	const tables = sql
		.exec<{ name: string }>(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
		)
		.toArray()
		.map((row) => row.name)
	return tables.flatMap((from) =>
		sql
			.exec<{ table: string; from: string; on_delete: string }>(`PRAGMA foreign_key_list("${from}")`)
			.toArray()
			.map((row) => ({ from, table: row.table, column: row.from, onDelete: row.on_delete }))
	)
}

// The tables whose rows a delete in `root` cascades to or updates (CASCADE or SET NULL), transitively; the tables
// in `stop` are reported but not followed.
function cascadesFrom(keys: ForeignKey[], root: string, stop: readonly string[]): string[] {
	const found = new Set<string>()
	const queue = [root]
	for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
		for (const key of keys) {
			if (key.table !== parent || !['CASCADE', 'SET NULL'].includes(key.onDelete) || found.has(key.from)) {
				continue
			}
			found.add(key.from)
			if (!stop.includes(key.from)) {
				queue.push(key.from)
			}
		}
	}
	return [...found].sort()
}

function unguarded(found: string[], listed: readonly { table: string }[], exempt: Record<string, string>): string[] {
	return found.filter((table) => !listed.some((child) => child.table === table) && exempt[table] === undefined)
}

describe('cascade guard (RES-6)', () => {
	it('lists or exempts every table that cascades from statuses', async () => {
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			const found = cascadesFrom(foreignKeys(state.storage.sql), 'statuses', ['statuses'])
			expect(
				unguarded(found, STATUS_CHILDREN, STATUS_EXEMPT),
				'these tables cascade from statuses: add each to STATUS_CHILDREN in src/domain/inbox.ts, or exempt it in STATUS_EXEMPT with the reason its rows stay bounded'
			).toEqual([])
			// An exemption or entry for a table that no longer cascades is stale.
			expect(Object.keys(STATUS_EXEMPT).filter((table) => !found.includes(table))).toEqual([])
			expect(STATUS_CHILDREN.filter((child) => !found.includes(child.table))).toEqual([])
		})
	})

	it('lists or exempts every table that cascades from accounts', async () => {
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			// What cascades below statuses is the status side's: the purge deletes statuses through deleteStatusWithin.
			const found = cascadesFrom(foreignKeys(state.storage.sql), 'accounts', ['statuses'])
			expect(
				unguarded(found, PURGED_ACCOUNT_CHILDREN, ACCOUNT_EXEMPT),
				'these tables cascade from accounts: add each to PURGED_ACCOUNT_CHILDREN in src/domain/inbox.ts (and empty it in the purge), or exempt it in ACCOUNT_EXEMPT with the reason its rows stay bounded'
			).toEqual([])
			expect(Object.keys(ACCOUNT_EXEMPT).filter((table) => !found.includes(table))).toEqual([])
			expect(PURGED_ACCOUNT_CHILDREN.filter((child) => !found.includes(child.table))).toEqual([])
		})
	})
})
