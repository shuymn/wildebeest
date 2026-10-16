import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { community, remoteAccount, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import {
	deleteStatusBatch,
	PURGE_BATCH,
	purgeBatch,
	PURGED_ACCOUNT_CHILDREN,
	STATUS_CHILDREN,
} from '../src/domain/inbox'

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

// Triggers that write. A batched delete or purge counts every row changed (total_changes()), so a trigger its writes
// fire must have its own writes counted where the batch decides it has room. Each one is named here with where that
// is, or why no batch fires it.
const WRITING_TRIGGERS: Record<string, string> = {
	statuses_thread: 'fires on a status insert, which no batched delete or purge makes',
	statuses_last_status_stored: 'fires on a status insert, which no batched delete or purge makes',
	list_members_follow_ended:
		"a follow's delete deletes the follower's list rows of the account; the purge deletes the account's list rows first (purgeRelationships), so then it writes none",
	account_pins_follow_ended:
		"a follow's delete deletes the follower's endorsement of the account; the purge deletes the account's endorsements first (purgeRelationships), so then it writes none",
	conversation_statuses_removed:
		"one conversation written per link deleted: STATUS_CHILDREN's conversation_statuses entry takes half the rows left",
	statuses_last_status_removed:
		"one account row per status deleted: deleteStatusWithin reserves it with the status's own delete",
	statuses_last_status_changed:
		'one account row per status hidden: deleteStatusBatch hides a status only with two rows left',
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

	it('names every trigger that writes, with where its writes are counted', async () => {
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			const triggers = state.storage.sql
				.exec<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger'")
				.toArray()
			// A trigger writes when its body (after BEGIN) holds an INSERT, REPLACE, UPDATE or DELETE; one that only RAISEs
			// writes nothing. A cheap reading of the text, not a parser: a migration could fool it on purpose.
			const writing = triggers
				.filter(({ sql }) => /\b(INSERT|REPLACE|UPDATE|DELETE)\b/i.test(sql.split(/\bBEGIN\b/i)[1] ?? ''))
				.map(({ name }) => name)
				.sort()
			expect(
				writing.filter((name) => !Object.hasOwn(WRITING_TRIGGERS, name)),
				'these triggers write: count their writes where a batched delete or purge that fires them decides it has room (src/domain/inbox.ts), and name each in WRITING_TRIGGERS with where, or why no batch fires it'
			).toEqual([])
			expect(Object.keys(WRITING_TRIGGERS).filter((name) => !writing.includes(name))).toEqual([])
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

describe('a status in many conversations', () => {
	it('leaves them over batches, each within PURGE_BATCH, its conversations with them', async () => {
		const h = await community(['alice'])
		const remote = await remoteAccount(h.store, 'carol')
		const status = await seedStatus(h.store, { accountId: remote, visibility: 'direct', content: '<p>x</p>' })
		// 600 conversations holding the status, of 12 local accounts under 50 sets of participants each (a status
		// joins a conversation again when an Update changes whom it mentions): each link's delete also deletes its
		// conversation, so 1,200 rows, more than a batch writes.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12)
			INSERT INTO accounts (id, uri, username) SELECT printf('5%017d', i), 'https://kopje.test/ap/users/c' || i, 'c' || i FROM n`
		)
		await sql(
			h.store,
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '5*'`
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
			INSERT INTO conversations (account_id, thread, participants, last_status_id, unread)
			SELECT a.id, s.thread, json_array(s.account_id, printf('9%017d', i)), s.id, 1
			FROM accounts a, n, statuses s WHERE a.id GLOB '5*' AND s.id = ?`,
			status
		)
		await sql(
			h.store,
			'INSERT INTO conversation_statuses (conversation_id, status_id) SELECT id, ? FROM conversations',
			status
		)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM conversation_statuses')).toEqual([{ n: 600 }])
		const batches: number[] = []
		for (let i = 0; i < 10; i++) {
			const { wrote, remaining } = await runInDurableObject(h.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				const more = state.storage.transactionSync(() => deleteStatusBatch(db, status, NOW))
				return { wrote: changes() - before, remaining: more }
			})
			batches.push(wrote)
			if (!remaining) {
				break
			}
		}
		expect(batches.length).toBeGreaterThan(1)
		expect(batches.every((wrote) => wrote <= PURGE_BATCH)).toBe(true)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', status)).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM conversations')).toEqual([{ n: 0 }])
	})
})

describe("a status's own delete within a batch", () => {
	// A purge reaches the account's newest status, a reply with a poll, after its children left the batch exactly the
	// rows the delete used to reserve: the status, its poll, the parent's recount, and the account's last status, which
	// the trigger of migration 0021_directory moves back, one row more.
	it('stays within PURGE_BATCH when the status is the newest of its account', async () => {
		const h = await community(['alice'])
		const parent = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
		const remote = await remoteAccount(h.store, 'carol')
		const uri = 'https://remote.example/users/carol'
		const reply = await seedStatus(h.store, { accountId: remote, visibility: 'public', inReplyToId: parent })
		await sql(h.store, `INSERT INTO polls (status_id, options, tallies) VALUES (?, '["a","b"]', '[0,0]')`, reply)
		// The mentions the batch deletes first: all of the budget but the 3 rows the delete used to reserve.
		const mentions = PURGE_BATCH - 3
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('6%017d', i), 'https://many.example/users/m' || i, 'm' || i, 'many.example' FROM n`,
			mentions
		)
		await sql(
			h.store,
			"INSERT INTO status_mentions (status_id, account_id) SELECT ?, id FROM accounts WHERE id GLOB '6*'",
			reply
		)
		expect(await sql(h.store, 'SELECT last_status_id AS id FROM accounts WHERE id = ?', remote)).toEqual([
			{ id: reply },
		])
		const batches: number[] = []
		for (let i = 0; i < 10; i++) {
			const { wrote, remaining } = await runInDurableObject(h.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				const more = state.storage.transactionSync(() => purgeBatch(db, uri, NOW))
				return { wrote: changes() - before, remaining: more }
			})
			batches.push(wrote)
			if (!remaining) {
				break
			}
		}
		expect(batches.length).toBeGreaterThan(1)
		expect(batches[0]).toBe(PURGE_BATCH - 3)
		expect(batches.every((wrote) => wrote <= PURGE_BATCH)).toBe(true)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM accounts WHERE id = ?', remote)).toEqual([{ n: 0 }])
	})

	it('hides a status within PURGE_BATCH when its mentions leave one row', async () => {
		const h = await community(['alice'])
		const remote = await remoteAccount(h.store, 'carol')
		const status = await seedStatus(h.store, { accountId: remote, visibility: 'public' })
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('6%017d', i), 'https://many.example/users/m' || i, 'm' || i, 'many.example' FROM n`,
			PURGE_BATCH - 1
		)
		await sql(
			h.store,
			"INSERT INTO status_mentions (status_id, account_id) SELECT ?, id FROM accounts WHERE id GLOB '6*'",
			status
		)
		const batches: number[] = []
		for (let i = 0; i < 10; i++) {
			const { wrote, remaining } = await runInDurableObject(h.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				const more = state.storage.transactionSync(() => deleteStatusBatch(db, status, NOW))
				return { wrote: changes() - before, remaining: more }
			})
			batches.push(wrote)
			if (!remaining) {
				break
			}
		}
		expect(batches[0]).toBe(PURGE_BATCH - 1)
		expect(batches.every((wrote) => wrote <= PURGE_BATCH)).toBe(true)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', status)).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT last_status_id AS id FROM accounts WHERE id = ?', remote)).toEqual([{ id: null }])
	})
})
