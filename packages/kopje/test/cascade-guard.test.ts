import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { community, remoteAccount, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import {
	deleteStatusBatch,
	MAX_TRACKED_LIKES,
	PURGE_BATCH,
	purgeBatch,
	PURGED_ACCOUNT_CHILDREN,
	PURGED_ACCOUNT_REFERENCES,
	STATUS_CHILDREN,
} from '../src/domain/inbox'
import { TOKEN_CHILDREN } from '../src/domain/suspension'
import type { StoreStub } from '../src/platform/store-client'

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
	trend_statuses: 'one row per status, inside the final delete’s reservation (deleteStatusWithin)',
	status_trend_reviews: 'one row per status, inside the final delete’s reservation (deleteStatusWithin)',
	status_cards: 'one row per status, inside the final delete’s reservation (deleteStatusWithin)',
	poll_votes: 'below polls: deleted a batch at a time by deletePollVotes, checked by hasPollVotes',
	push_deliveries: 'below notifications, which go a batch at a time; at most MAX_PUSH_BACKLOG (1,000) wait in all',
}

// Tables met through the account's cascades that the purge's completion check (accountHasRows) does not list. A
// purge deletes only a remote account (`domain IS NOT NULL`), so a table only a local account owns never holds its
// rows; the tables naming local_accounts are not met at all, since local_accounts restricts the delete.
const ACCOUNT_EXEMPT: Record<string, string> = {
	conversations: 'owned by a local account only; a remote account is the only one purged',
	conversation_statuses: 'below conversations, owned by a local account only',
	stream_conversation_marks:
		"a local account's only (made at its `direct` subscription, one row); a remote account is the only one purged",
	poll_votes: 'deleted a batch at a time by deleteAccountVotes, checked by hasPollVotes in accountHasRows',
	account_trend_reviews: 'one row per account, inside the final delete’s reservation (purgeBatch)',
	push_deliveries:
		"below notifications: deleted child-first by the purge's sender and report windows (purgeRelationships), so no notification's delete cascades",
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
		"one conversation and its owner's streaming mark written per link deleted, and the mark's journal row (stream_conversation_changed): STATUS_CHILDREN's conversation_statuses entry takes a fourth of the rows left (the listening case below)",
	statuses_last_status_removed:
		"one account row per status deleted: deleteStatusWithin reserves it with the status's own delete",
	statuses_last_status_changed:
		'one account row per status hidden: deleteStatusBatch hides a status only with three rows left (the status, this row and its card)',
	quotes_count_inserted: 'fires on a quote insert, which no batched delete or purge makes',
	quotes_count_changed:
		"one statuses row per accepted quote that leaves its count or changes its target, two at most: a detach (STATUS_CHILDREN's quoted_status_id entry) takes an accepted one off the status being deleted, and that entry and a revocation batch (quotes.ts) take half the rows left",
	quotes_count_deleted:
		"one statuses row per accepted quote deleted: STATUS_CHILDREN's status_id entry takes a third of the rows left",
	quotes_authorization_retired:
		"one quote_revocations row per authorization of Kopje's cleared: only quotes of local statuses hold one, which no batched delete or purge detaches (they remove remote statuses), and a Delete of the quoting status clears its own before batching (retireQuoteOf)",
	quotes_authorization_deleted:
		"one quote_revocations row per quote deleted while holding an authorization of Kopje's (a purge of its quoting author): STATUS_CHILDREN's status_id entry takes a third of the rows left",
	stream_notification_inserted:
		'fires on a notification insert, which no batched delete or purge makes (the exact-budget cases below run with a listener too)',
	stream_status_inserted:
		'fires on a status insert, which no batched delete or purge makes, whether `user`, a list, a `public*` stream or a hashtag arms it (the exact-budget cases below run with all of them listening, and with the feeds alone)',
	stream_conversation_changed:
		"one journal row when an owner's mark moves, at most one per owner ahead of the position: counted with conversation_statuses_removed, a fourth row per link",
	stream_status_edited:
		'fires only when edited_at changes, which no batched delete or purge does: hiding a status writes its visibility and content (the exact-budget cases below run with `user`, a list and the feeds listening, and with the feeds alone)',
}

// Streaming subscriptions of the account on `user`, `user:notification`, a list, `direct`, `public` and a hashtag, which
// arm every journal trigger (migrations 0026_streaming, 0028_streaming_home, 0032_streaming_lists and
// 0035_streaming_public), and its conversation mark, which makes every conversation write take a change sequence; or,
// with 'feeds', on `public` and a hashtag alone, which arm the status triggers for public statuses only.
async function listen(store: StoreStub, listening: boolean | 'feeds', accountId: string): Promise<void> {
	if (listening === 'feeds') {
		await sql(
			store,
			`INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES (?1, 'public', 1), (?1, 'hashtag:cats', 1)`,
			accountId
		)
	} else if (listening) {
		await sql(
			store,
			`INSERT INTO stream_subscriptions (account_id, stream_key, sockets)
			VALUES (?1, 'user', 1), (?1, 'user:notification', 1), (?1, 'list:100000000000000001', 1), (?1, 'direct', 1),
				(?1, 'public', 1), (?1, 'hashtag:cats', 1)`,
			accountId
		)
		await sql(store, 'INSERT INTO stream_conversation_marks (account_id, seq) VALUES (?, 0)', accountId)
	}
}

// The journal's rows: a batch, armed or not, journals nothing.
async function journaled(store: StoreStub): Promise<unknown> {
	return sql(store, 'SELECT count(*) AS n FROM stream_events')
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

// The foreign keys naming `root` itself that cascade or set null, as `table.column`: a table with two of them (quotes)
// needs an entry for each, since each is removed by its own statement.
function directKeys(keys: ForeignKey[], root: string): string[] {
	return keys
		.filter((key) => key.table === root && ['CASCADE', 'SET NULL'].includes(key.onDelete))
		.map((key) => `${key.from}.${key.column}`)
		.sort()
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

	it('lists each foreign key naming statuses, not only its table', async () => {
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			const direct = directKeys(foreignKeys(state.storage.sql), 'statuses')
			const listed = STATUS_CHILDREN.filter((child) => child.parent === undefined).map(
				(child) => `${child.table}.${child.column}`
			)
			expect(
				direct.filter((key) => !listed.includes(key) && STATUS_EXEMPT[key.split('.')[0]!] === undefined),
				'each of these foreign keys cascades from statuses: give it its own STATUS_CHILDREN entry in src/domain/inbox.ts'
			).toEqual([])
			expect(listed.filter((key) => !direct.includes(key))).toEqual([])
		})
	})

	// A table below another child names it by its own foreign key, comes before it (so the parent's delete finds none
	// of its rows left), and has its own existence check: it has no status column.
	it('lists a table below another child before it, by its foreign key to it', async () => {
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			const keys = foreignKeys(state.storage.sql)
			const below = STATUS_CHILDREN.filter((child) => child.parent !== undefined)
			expect(below.map((child) => child.table)).toEqual(['favourite_likes'])
			for (const child of below) {
				expect(
					keys.filter((key) => key.from === child.table && key.table === child.parent && key.onDelete === 'CASCADE')
				).toEqual([{ from: child.table, table: child.parent, column: child.column, onDelete: 'CASCADE' }])
				const at = STATUS_CHILDREN.findIndex((entry) => entry === child)
				expect(STATUS_CHILDREN.findIndex((entry) => entry.table === child.parent)).toBeGreaterThan(at)
				expect(child.exists).toMatch(new RegExp(`\\b${child.parent}\\b.*\\bstatus_id = \\?1`))
			}
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

	// A logical reference (an account id no foreign key holds) is cleared by the purge through its own index: it is not a
	// foreign key, so no delete of the account reaches it, and its partial index holds exactly the rows that name one.
	it('clears each logical reference through a partial index of its column', async () => {
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			const sql = state.storage.sql
			const keys = foreignKeys(sql)
			expect(PURGED_ACCOUNT_REFERENCES.length).toBeGreaterThan(0)
			for (const reference of PURGED_ACCOUNT_REFERENCES) {
				expect(keys.filter((key) => key.from === reference.table && key.column === reference.column)).toEqual([])
				const index = sql
					.exec<{ tbl_name: string; sql: string }>(
						"SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
						reference.index
					)
					.toArray()
				expect(index).toEqual([{ tbl_name: reference.table, sql: expect.any(String) }])
				expect(
					sql
						.exec<{ name: string }>(`PRAGMA index_info("${reference.index}")`)
						.toArray()
						.map((row) => row.name)
				).toEqual([reference.column])
				expect(index[0]!.sql).toContain(`WHERE ${reference.column} IS NOT NULL`)
			}
		})
	})

	// A table with two foreign keys naming accounts (follows, blocks, reports) has its rows found by each: the
	// completion check names every such column, so the account's delete finds none of its rows by either.
	it('lists each foreign key naming accounts, not only its table', async () => {
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			const direct = directKeys(foreignKeys(state.storage.sql), 'accounts')
			const checked = (key: string) => {
				const [table, column] = key.split('.') as [string, string]
				return PURGED_ACCOUNT_CHILDREN.some(
					(child) => child.table === table && new RegExp(`(^|\\W)${column} = \\?1\\b`).test(child.check)
				)
			}
			expect(
				direct.filter((key) => !checked(key) && ACCOUNT_EXEMPT[key.split('.')[0]!] === undefined),
				'each of these foreign keys cascades from accounts: check its column in a PURGED_ACCOUNT_CHILDREN entry in src/domain/inbox.ts'
			).toEqual([])
		})
	})
})

// The tables that name local_accounts (a local user's own rows, and the moderation columns of migration
// 0029_admin_reports) are never met by a batched delete or purge: local_accounts restricts its account's delete, and
// no code deletes a local account. A foreign key to local_accounts that cascades or sets null is therefore bounded
// only while that holds; this pins it, so a delete of local accounts cannot be added without bounding them first. That
// no code deletes one is test-node/policy-boundary.test.ts's.

// A local status's own delete (statuses.ts deleteStatus, in its author's request) cascades its children, and below them
// only what the schema bounds per row, so a converted or imported Store holds no more: each such table, with its bound
// per parent row and the trigger that holds it.
const LOCAL_DELETE_BOUNDS: Record<string, { per: string; bound: number; trigger: string }> = {
	favourite_likes: { per: 'favourites', bound: MAX_TRACKED_LIKES, trigger: 'favourite_likes_cap' },
}

describe('cascade guard below a local status’s own children (RES-6)', () => {
	it.each(Object.entries(LOCAL_DELETE_BOUNDS))('%s: refuses a row past its bound per parent', async (table, held) => {
		const h = await community(['alice'])
		const remote = await remoteAccount(h.store, 'carol')
		const status = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
		await sql(h.store, "INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, 'x')", remote, status)
		const insert = (n: number) =>
			sql(
				h.store,
				`INSERT INTO ${table} (favourite_id, uri, received_at) SELECT id, 'https://remote.example/likes/' || ?, 0 FROM ${held.per}`,
				n
			)
		for (let n = 0; n < held.bound; n++) {
			await insert(n)
		}
		await expect(insert(held.bound)).rejects.toThrow(/more than 4 Like ids for one favourite/)
		expect(await sql(h.store, "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?", table)).toEqual(
			[{ name: held.trigger }]
		)
	})
})

describe('cascade guard below local_accounts (RES-6)', () => {
	it('meets nothing: local_accounts restricts the delete of its account, and nothing deletes a local account', async () => {
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			const keys = foreignKeys(state.storage.sql)
			expect(keys.filter((key) => key.from === 'local_accounts')).toEqual([
				{ from: 'local_accounts', table: 'accounts', column: 'account_id', onDelete: 'RESTRICT' },
			])
			expect(cascadesFrom(keys, 'accounts', ['statuses'])).not.toContain('local_accounts')
			// The report's moderation columns name the admin's account, and let go of it if it ever went; its reporter is any
			// account (migration 0054_remote_reports), found by the purge's completion check.
			expect(
				keys
					.filter((key) => key.table === 'local_accounts' && key.from === 'reports')
					.map((key) => [key.column, key.onDelete])
					.sort()
			).toEqual([
				['action_taken_by_account_id', 'SET NULL'],
				['assigned_account_id', 'SET NULL'],
			])
			expect(
				keys
					.filter((key) => key.table === 'accounts' && key.from === 'reports')
					.map((key) => key.column)
					.sort()
			).toEqual(['account_id', 'target_account_id'])
		})
	})
})

describe('cascade guard below oauth_tokens (RES-6)', () => {
	// The tokens job of a suspension (src/domain/suspension.ts) deletes the rows of a token of an earlier epoch child-first, in
	// TOKEN_CHILDREN's order, and the token last, so no delete cascades and each round counts what it writes. A table
	// that cascades from oauth_tokens but is missing there would be emptied by the token's delete, unbounded.
	it('lists every table that cascades from oauth_tokens, each before the tables it cascades from', async () => {
		await runInDurableObject(await migratedStore(), (_instance, state) => {
			const keys = foreignKeys(state.storage.sql)
			const found = cascadesFrom(keys, 'oauth_tokens', [])
			expect(
				found,
				'these tables cascade from oauth_tokens: add each to TOKEN_CHILDREN in src/domain/suspension.ts, child first, and delete its rows in the tokens job'
			).toEqual([...TOKEN_CHILDREN].sort())
			// Child first: every parent a listed table cascades from, below oauth_tokens, comes after it.
			TOKEN_CHILDREN.forEach((table, index) => {
				const parents = keys
					.filter((key) => key.from === table && ['CASCADE', 'SET NULL'].includes(key.onDelete))
					.map((key) => key.table)
					.filter((parent) => parent !== 'oauth_tokens' && found.includes(parent))
				for (const parent of parents) {
					expect(
						TOKEN_CHILDREN.indexOf(parent as (typeof TOKEN_CHILDREN)[number]),
						`${table} -> ${parent}`
					).toBeGreaterThan(index)
				}
			})
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

describe('a status in many conversations that keep an older one, their owners streaming `direct`', () => {
	// Each link's delete moves its conversation's last status back to the older status: with the owner's mark, the
	// trigger writes the mark, its journal row (the owner's first) and the conversation, at most four rows with the link
	// (migration 0032_streaming_lists).
	it.each([false, true])(
		'stays within PURGE_BATCH, each mark and stream_seq advancing (listening: %s)',
		async (listening) => {
			const h = await community(['alice'])
			const remote = await remoteAccount(h.store, 'carol')
			const older = await seedStatus(h.store, { accountId: remote, visibility: 'direct', content: '<p>older</p>' })
			const status = await seedStatus(h.store, { accountId: remote, visibility: 'direct', content: '<p>x</p>' })
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
			const owners = await sql<{ id: string }>(h.store, "SELECT id FROM accounts WHERE id GLOB '5*' ORDER BY id")
			for (const { id } of owners) {
				await listen(h.store, listening, id)
			}
			// 600 conversations (12 owners, 50 sets of participants each) holding both statuses, the newer one last.
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
			INSERT INTO conversations (account_id, thread, participants, last_status_id, unread)
			SELECT a.id, s.thread || '#' || i, json_array(s.account_id, printf('9%017d', i)), s.id, 1
			FROM accounts a, n, statuses s WHERE a.id GLOB '5*' AND s.id = ?`,
				status
			)
			await sql(
				h.store,
				'INSERT INTO conversation_statuses (conversation_id, status_id) SELECT id, ?1 FROM conversations UNION ALL SELECT id, ?2 FROM conversations',
				status,
				older
			)
			const batches: number[] = []
			for (let i = 0; i < 20; i++) {
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
			// The marks' moves journaled one row per owner, whatever the batches (the position never moved).
			expect(await sql(h.store, "SELECT count(*) AS n FROM stream_events WHERE kind = 'conversation'")).toEqual([
				{ n: listening ? owners.length : 0 },
			])
			expect(await sql(h.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', status)).toEqual([{ n: 0 }])
			expect(await sql(h.store, 'SELECT count(*) AS n FROM conversations WHERE last_status_id = ?', older)).toEqual([
				{ n: 600 },
			])
			expect(await sql(h.store, 'SELECT DISTINCT seq FROM stream_conversation_marks')).toEqual(
				listening ? [{ seq: 50 }] : []
			)
			expect(
				await sql(
					h.store,
					'SELECT count(DISTINCT stream_seq) AS seqs, min(stream_seq) AS low, max(stream_seq) AS high FROM conversations'
				)
			).toEqual([listening ? { seqs: 50, low: 1, high: 50 } : { seqs: 1, low: 0, high: 0 }])
		}
	)
})

describe("a status's own delete within a batch", () => {
	// A purge reaches the account's newest status, a reply with a poll that quotes another status (accepted), after its
	// children left the batch exactly the rows the delete used to reserve: the status, its poll, the parent's recount, and
	// the account's last status, which the trigger of migration 0021_directory moves back, one row more. Its quote went
	// before it with the quoted status's count (the trigger quotes_count_deleted), two rows.
	// With a streaming listener the journal triggers are armed (migrations 0026_streaming, 0028_streaming_home and
	// 0035_streaming_public; the feeds alone arm them for these public statuses); the batch writes the same rows and
	// journals nothing.
	it.each([false, true, 'feeds'] as const)(
		'stays within PURGE_BATCH when the status is the newest of its account (listening: %s)',
		async (listening) => {
			const h = await community(['alice'])
			await listen(h.store, listening, h.users.alice.id)
			const parent = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
			const quoted = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
			const remote = await remoteAccount(h.store, 'carol')
			const uri = 'https://remote.example/users/carol'
			const reply = await seedStatus(h.store, { accountId: remote, visibility: 'public', inReplyToId: parent })
			await sql(h.store, `INSERT INTO polls (status_id, options, tallies) VALUES (?, '["a","b"]', '[0,0]')`, reply)
			await sql(
				h.store,
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				SELECT ?1, uri, id, account_id, 'accepted', '2026-10-12T00:00:00.000Z' FROM statuses WHERE id = ?2`,
				reply,
				quoted
			)
			expect(await sql(h.store, 'SELECT quotes_count FROM statuses WHERE id = ?', quoted)).toEqual([
				{ quotes_count: 1 },
			])
			// The mentions the batch deletes first: all of the budget but the 3 rows the delete used to reserve and the 2
			// of the quote.
			const mentions = PURGE_BATCH - 5
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
			// The statuses' own inserts are journaled with a listener; the batches add nothing.
			const before = await journaled(h.store)
			expect(before).toEqual([{ n: listening ? 3 : 0 }])
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
			expect(await sql(h.store, 'SELECT count(*) AS n FROM quotes')).toEqual([{ n: 0 }])
			expect(await sql(h.store, 'SELECT quotes_count FROM statuses WHERE id = ?', quoted)).toEqual([
				{ quotes_count: 0 },
			])
			expect(await journaled(h.store)).toEqual(before)
		}
	)

	it.each([false, true, 'feeds'] as const)(
		'hides a status within PURGE_BATCH when its mentions leave one row (listening: %s)',
		async (listening) => {
			const h = await community(['alice'])
			await listen(h.store, listening, h.users.alice.id)
			const remote = await remoteAccount(h.store, 'carol')
			const status = await seedStatus(h.store, { accountId: remote, visibility: 'public' })
			// The status's own insert is journaled with a listener; the batches add nothing.
			const before = await journaled(h.store)
			expect(before).toEqual([{ n: listening ? 1 : 0 }])
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
			expect(await sql(h.store, 'SELECT last_status_id AS id FROM accounts WHERE id = ?', remote)).toEqual([
				{ id: null },
			])
			expect(await journaled(h.store)).toEqual(before)
		}
	)
})

describe('trend and card rows within a batch (0057_trends, 0067_status_cards)', () => {
	// The status's final delete reserves 7 rows: the status, its poll, its trend_statuses, status_trend_reviews and
	// status_cards rows, the account's last status (0021_directory moves it back: the status is the account's newest) and
	// the parent's recount. The mentions the batch deletes first leave exactly those rows, so the batch ends at
	// PURGE_BATCH. With one row fewer left (6), the delete waits for the next batch.
	it.each([
		[true, 7],
		[false, 7],
		[true, 6],
	])('deletes a status with its trend and card rows within the budget (poll: %s, left: %i)', async (poll, left) => {
		const h = await community(['alice'])
		const parent = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
		const remote = await remoteAccount(h.store, 'carol')
		const uri = 'https://remote.example/users/carol'
		const reply = await seedStatus(h.store, { accountId: remote, visibility: 'public', inReplyToId: parent })
		if (poll) {
			await sql(h.store, `INSERT INTO polls (status_id, options, tallies) VALUES (?, '["a","b"]', '[0,0]')`, reply)
		}
		await sql(h.store, 'INSERT INTO trend_statuses (status_id, account_id, score) VALUES (?, ?, 9)', reply, remote)
		await sql(
			h.store,
			"INSERT INTO status_trend_reviews (status_id, trendable, reviewed_at) VALUES (?, 1, '2026-10-12T00:00:00.000Z')",
			reply
		)
		await sql(
			h.store,
			`INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at)
			VALUES (?, 'https://a.example/', 0, 0, 't', 0)`,
			reply
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('6%017d', i), 'https://many.example/users/m' || i, 'm' || i, 'many.example' FROM n`,
			PURGE_BATCH - left
		)
		await sql(
			h.store,
			"INSERT INTO status_mentions (status_id, account_id) SELECT ?, id FROM accounts WHERE id GLOB '6*'",
			reply
		)
		const batch = () =>
			runInDurableObject(h.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				const more = state.storage.transactionSync(() => purgeBatch(db, uri, NOW))
				return { wrote: changes() - before, more }
			})
		const first = await batch()
		if (left === 6) {
			expect(first).toEqual({ wrote: PURGE_BATCH - 6, more: true })
			expect(await sql(h.store, 'SELECT count(*) AS n FROM trend_statuses')).toEqual([{ n: 1 }])
			expect(await sql(h.store, 'SELECT count(*) AS n FROM status_cards')).toEqual([{ n: 1 }])
			// The seven rows, then the account (no job row to complete).
			expect((await batch()).wrote).toBe(8)
			return
		}
		expect(await sql(h.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', reply)).toEqual([{ n: 0 }])
		expect(first.wrote).toBe(PURGE_BATCH - (poll ? 0 : 1))
		expect(await sql(h.store, 'SELECT count(*) AS n FROM trend_statuses')).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM status_trend_reviews')).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM status_cards')).toEqual([{ n: 0 }])
		expect(first.more).toBe(true)
		expect(await batch()).toMatchObject({ more: false })
	})

	// The account's final delete reserves 3 rows: the account, its account_trend_reviews row and the job's completion.
	it.each([3, 2])('purges an account with its trend review when %i rows are left', async (left) => {
		const h = await community(['alice'])
		const remote = await remoteAccount(h.store, 'carol')
		const uri = 'https://remote.example/users/carol'
		await sql(
			h.store,
			"INSERT INTO account_trend_reviews (account_id, trendable, reviewed_at) VALUES (?, 0, '2026-10-12T00:00:00.000Z')",
			remote
		)
		await sql(h.store, "INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?1, ?1, 0)", uri)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('6%017d', i), 'https://many.example/users/m' || i, 'm' || i, 'many.example' FROM n`,
			PURGE_BATCH - left
		)
		await sql(
			h.store,
			"INSERT INTO blocks (account_id, target_account_id) SELECT id, ? FROM accounts WHERE id GLOB '6*'",
			remote
		)
		const wrote = await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
			const before = changes()
			state.storage.transactionSync(() => purgeBatch(db, uri, NOW))
			return changes() - before
		})
		const gone = (await sql(h.store, 'SELECT count(*) AS n FROM accounts WHERE id = ?', remote))[0]!.n === 0
		expect(gone).toBe(left === 3)
		expect(wrote).toBe(left === 3 ? PURGE_BATCH : PURGE_BATCH - 2)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM account_trend_reviews')).toEqual([{ n: left === 3 ? 0 : 1 }])
	})
})
