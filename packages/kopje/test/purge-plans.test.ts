import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { writtenBy } from './inbox-store-helpers'
import { plannedRun, type PlannedStatement, scansOf, staleStatistics } from './read-helpers'
import { community } from './status-helpers'
import { PURGE_BATCH, purgeBatch } from '../src/domain/inbox'
import { writeOperation } from '../src/domain/operation'
import type { StoreStub } from '../src/platform/store-client'

// RES-6 and RES-7: a remote account's purge (purgeBatch) seeks what it deletes by key, with statistics taken before
// the Store grew, so each batch reads what it writes and not the tables it writes to.

const AT = new Date(NOW).toISOString()
const id18 = (n: number, k: number) => String(700000000000000000n + BigInt(n) * 100n + BigInt(k))
const uriOf = (n: number) => `https://far${n}.example/users/v`

// Victim n's world: its statuses, a reply and a boost of them, its favourites and those of its statuses (each with a
// tracked Like id), follows, blocks and a mute both ways, notifications, reports of it and by it with their
// admin.report, a mention, a bookmark, quotes both ways and its cached profile images.
function victim(sql: SqlStorage, alice: string, n: number): void {
	const v = id18(n, 0)
	const o = id18(n, 1)
	const [s1, s2, a, r, b, q] = [10, 11, 12, 13, 14, 15].map((k) => id18(n, k)) as [
		string,
		string,
		string,
		string,
		string,
		string,
	]
	sql.exec(
		`INSERT INTO accounts (id, uri, username, domain) VALUES (?1, ?2, 'v', ?3), (?4, ?2 || '/o', 'o', ?3)`,
		v,
		uriOf(n),
		`far${n}.example`,
		o
	)
	const status = (id: string, account: string, extra: { reply?: string; reblog?: string } = {}) =>
		sql.exec(
			`INSERT INTO statuses (id, uri, account_id, in_reply_to_id, in_reply_to_uri, reblog_of_id, visibility, content,
				published_at)
			VALUES (?1, 'https://s.example/' || ?1, ?2, ?3, CASE WHEN ?3 IS NOT NULL THEN 'https://s.example/' || ?3 END, ?4,
				'public', CASE WHEN ?4 IS NULL THEN '<p>x</p>' ELSE '' END, ?5)`,
			id,
			account,
			extra.reply ?? null,
			extra.reblog ?? null,
			AT
		)
	status(s1, v)
	status(s2, v, { reply: s1 })
	status(a, alice)
	status(r, alice, { reply: s1 })
	status(b, o, { reblog: s1 })
	status(q, alice)
	sql.exec('INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)', s1, alice)
	for (const [account, target] of [
		[v, a],
		[alice, s1],
		[o, s1],
	] as const) {
		sql.exec('INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, ?)', account, target, AT)
		sql.exec(
			"INSERT INTO favourite_likes (favourite_id, uri, received_at) VALUES (last_insert_rowid(), 'https://l.example/' || ?, 0)",
			`${n}-${account}-${target}`
		)
	}
	for (const [from, to] of [
		[v, alice],
		[alice, v],
		[o, v],
	] as const) {
		sql.exec(
			"INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'accepted', ?)",
			from,
			to,
			AT
		)
		sql.exec('INSERT INTO blocks (account_id, target_account_id, created_at) VALUES (?, ?, ?)', from, to, AT)
	}
	sql.exec('INSERT INTO mutes (account_id, target_account_id, created_at) VALUES (?, ?, ?)', alice, v, AT)
	sql.exec(
		`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at)
		VALUES (?1, 'mention', ?2, ?3, ?4), (?1, 'follow', ?2, NULL, ?4)`,
		alice,
		v,
		s1,
		AT
	)
	for (const [reporter, target] of [
		[alice, v],
		[v, alice],
	] as const) {
		sql.exec(
			"INSERT INTO reports (account_id, target_account_id, uri, created_at) VALUES (?, ?, 'https://r.example/' || ?, ?)",
			reporter,
			target,
			`${n}-${reporter}`,
			AT
		)
		sql.exec(
			`INSERT INTO notifications (account_id, type, from_account_id, report_id, created_at)
			VALUES (?, 'admin.report', ?, last_insert_rowid(), ?)`,
			alice,
			reporter,
			AT
		)
	}
	sql.exec('INSERT INTO bookmarks (account_id, status_id, created_at) VALUES (?, ?, ?)', alice, s1, AT)
	sql.exec("INSERT INTO status_edits (status_id, content, created_at) VALUES (?1, 'a', ?2), (?1, 'b', ?2)", s1, AT)
	sql.exec(
		"INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES (?1, ?2, ?3, 'image', 'https://m.example/' || ?1)",
		id18(n, 20),
		v,
		s1
	)
	sql.exec("INSERT INTO status_tags (status_id, name, public) VALUES (?, 'cats', 1)", s1)
	// Its cached avatar, stored, and its header, pending (remote-media.ts).
	const token = `V${String(n).padStart(42, '0')}`
	sql.exec(
		`INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, due_at, enqueued_at,
			token, ext, stored_at)
		VALUES ('avatar', ?1, ?1, 'https://f.example/a' || ?1, 'f.example', 'image', 0, 0, NULL, 1, ?2, 'gif', 1),
			('header', ?1, ?1, 'https://f.example/h' || ?1, 'f.example', 'image', 0, 0, 1, 1, NULL, NULL, NULL)`,
		v,
		token
	)
	sql.exec(
		`INSERT INTO remote_media_objects (token, slot_id, state, charge, kind, content_type, claimed_at, stored_at)
		SELECT ?1, id, 'stored', 1000, 'avatar', 'image/gif', 1, 1 FROM remote_media WHERE token = ?1`,
		token
	)
	// An unattached attachment, and the cached files of both attachments: the attached one's pending, the other's icon
	// failed.
	sql.exec(
		"INSERT INTO media_attachments (id, account_id, type, url) VALUES (?1, ?2, 'image', 'https://m.example/' || ?1)",
		id18(n, 21),
		v
	)
	sql.exec(
		`INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, due_at, enqueued_at,
			failed_at)
		VALUES ('attachment', ?1, ?3, 'https://m.example/' || ?1, 'm.example', 'image', 1, 0, 1, 1, NULL),
			('thumbnail', ?2, ?3, 'https://m.example/p' || ?2, 'm.example', 'image', 0, 0, NULL, 1, 1)`,
		id18(n, 20),
		id18(n, 21),
		v
	)
	sql.exec('UPDATE remote_media_usage SET bytes = bytes + 1000, pending = pending + 2 WHERE id = 1')
	sql.exec("INSERT INTO filters (id, account_id, title, context) VALUES (?, ?, 'f', '[\"home\"]')", id18(n, 30), alice)
	sql.exec('INSERT INTO filter_statuses (id, filter_id, status_id) VALUES (?, ?, ?)', id18(n, 31), id18(n, 30), s1)
	sql.exec(
		'INSERT INTO notification_requests (account_id, from_account_id, last_status_id) VALUES (?, ?, ?)',
		alice,
		v,
		s1
	)
	// A poll of its own with votes, and its votes in a poll of the local account's.
	for (const [poll, voter] of [
		[s1, alice],
		[a, v],
	] as const) {
		sql.exec('INSERT INTO polls (status_id, options, tallies) VALUES (?, \'["x","y"]\', \'[1,0]\')', poll)
		sql.exec('INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, 0)', poll, voter)
	}
	for (const [quoting, quoted, account] of [
		[q, s1, v],
		[s1, a, alice],
	] as const) {
		sql.exec(
			`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
			VALUES (?1, 'https://s.example/' || ?2, ?2, ?3, 'accepted', ?4)`,
			quoting,
			quoted,
			account,
			AT
		)
	}
}

function victims(store: StoreStub, alice: string, from: number, count: number): Promise<void> {
	return runInDurableObject(store, (_instance, state) =>
		state.storage.transactionSync(() => {
			for (let n = from; n < from + count; n++) {
				victim(state.storage.sql, alice, n)
			}
		})
	)
}

// The tables (and aliases) a purge reads and writes: none is scanned. A materialized window (w) or subquery may be.
const TABLES = [
	'accounts',
	'blocks',
	'bookmarks',
	'favourite_likes',
	'favourites',
	'filter_statuses',
	'follows',
	'media_attachments',
	'mutes',
	'notification_requests',
	'notifications',
	'poll_votes',
	'polls',
	'push_deliveries',
	'quotes',
	'remote_media',
	'remote_media_objects',
	'remote_media_usage',
	'reports',
	'status_edits',
	'status_mentions',
	'status_tags',
	'statuses',
	'a',
	'd',
	'l',
	'n',
	'o',
	'r',
	's',
]

// Each table's rows that name no victim below 10 (the grown ones only, once both purges are done).
async function counts(store: StoreStub): Promise<Record<string, number>> {
	return runInDurableObject(store, (_instance, state) => {
		const of = (table: string, where: string) =>
			state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).one().n
		const grownAccount = (column: string) => `${column} >= '700000000000001000'`
		return {
			statuses: of('statuses', grownAccount('id')),
			favourites: of('favourites', grownAccount('status_id')),
			favourite_likes: of(
				'favourite_likes',
				"uri NOT LIKE 'https://l.example/0-%' AND uri NOT LIKE 'https://l.example/1-%'"
			),
			follows: of('follows', `${grownAccount('account_id')} OR ${grownAccount('target_account_id')}`),
			blocks: of('blocks', `${grownAccount('account_id')} OR ${grownAccount('target_account_id')}`),
			mutes: of('mutes', grownAccount('target_account_id')),
			notifications: of(
				'notifications',
				"account_id IN (SELECT l.account_id FROM local_accounts l JOIN accounts a ON a.id = l.account_id WHERE a.username = 'bob')"
			),
			reports: of('reports', `${grownAccount('account_id')} OR ${grownAccount('target_account_id')}`),
			bookmarks: of('bookmarks', grownAccount('status_id')),
			quotes: of('quotes', grownAccount('status_id')),
			poll_votes: of('poll_votes', grownAccount('poll_id')),
			media_attachments: of('media_attachments', grownAccount('id')),
			filter_statuses: of('filter_statuses', grownAccount('id')),
			notification_requests: of('notification_requests', grownAccount('from_account_id')),
			status_edits: of('status_edits', grownAccount('status_id')),
			accounts: of('accounts', grownAccount('id')),
			remote_media: of('remote_media', grownAccount('account_id')),
			stored_objects: of(
				'remote_media_objects',
				`state = 'stored' AND slot_id IN (SELECT id FROM remote_media WHERE ${grownAccount('account_id')})`
			),
		}
	})
}

const batch = writeOperation<{ uri: string }, boolean>((db, { uri }) => purgeBatch(db, uri, NOW))

// The purge of victim n, batch by batch to its end: each batch's statements with their plans and rows read.
async function purge(store: StoreStub, n: number): Promise<PlannedStatement[][]> {
	const batches: PlannedStatement[][] = []
	for (let more = true; more;) {
		expect(batches.length).toBeLessThan(20)
		const { result, plans } = await plannedRun({ store }, /^\s*(DELETE|UPDATE|SELECT)\b/, batch, { uri: uriOf(n) })
		batches.push(plans)
		more = result
	}
	return batches
}

describe("a remote account's purge with stale statistics (RES-6, RES-7)", () => {
	it('seeks every row it deletes or checks, the other accounts grown after ANALYZE', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = { alice: h.users.alice.id, bob: h.users.bob.id }
		await victims(h.store, alice, 0, 2)
		let grown: Record<string, number> = {}
		const { before, after } = await staleStatistics(h, {
			capture: (phase) => purge(h.store, phase === 'before' ? 0 : 1),
			grow: async () => {
				await victims(h.store, bob, 10, 1000)
				grown = await counts(h.store)
			},
		})
		expect(after.length).toBe(before.length)
		const was = before.flat()
		const plans = after.flat()
		expect(plans.map((p) => p.query)).toEqual(was.map((p) => p.query))
		for (const [i, { query, plan, rows }] of plans.entries()) {
			const name = query.replace(/\s+/g, ' ').slice(0, 100)
			expect(scansOf(plan, TABLES), name).toEqual([])
			// The same rows as before the growth (the local account's recount reads fewer: the first victim's follow of it
			// is gone), one index entry past a range at most.
			expect(rows - was[i]!.rows, name).toBeLessThanOrEqual(1)
		}
		// Both victims are gone, with every row naming them; the grown ones are whole.
		expect(await counts(h.store)).toEqual(grown)
	}, 120_000)
})

describe("a remote account's purge by key, batch by batch (RES-6)", () => {
	it('writes within PURGE_BATCH, the follows of both sides lowest id first, as many rows as the batches write', async () => {
		const h = await community(['alice'])
		const alice = h.users.alice.id
		await victims(h.store, alice, 0, 1)
		const v = id18(0, 0)
		// 300 accounts following the victim and followed by it, the two sides' ids interleaved; 300 favourites of its
		// status, each with a tracked Like id, notifications from it and blocks of it.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 300 - 1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(710000000000000000 + i AS TEXT), 'https://f.example/u' || i, 'u' || i, 'f.example' FROM n`
		)
		await sql(
			h.store,
			`INSERT INTO follows (account_id, target_account_id, state, created_at)
			SELECT CASE WHEN k = 0 THEN a.id ELSE ?1 END, CASE WHEN k = 0 THEN ?1 ELSE a.id END, 'accepted', ?2
			FROM accounts a CROSS JOIN (SELECT 0 AS k UNION ALL SELECT 1) WHERE a.domain = 'f.example' ORDER BY a.id, k`,
			v,
			AT
		)
		await sql(
			h.store,
			`INSERT INTO favourites (account_id, status_id, created_at)
			SELECT id, ?1, ?2 FROM accounts WHERE domain = 'f.example' ORDER BY id`,
			id18(0, 10),
			AT
		)
		await sql(
			h.store,
			`INSERT INTO favourite_likes (favourite_id, uri, received_at)
			SELECT id, 'https://f.example/likes/' || id, 0 FROM favourites WHERE status_id = ?1 AND account_id <> ?2`,
			id18(0, 10),
			alice
		)
		await sql(
			h.store,
			`INSERT INTO blocks (account_id, target_account_id, created_at)
			SELECT id, ?1, ?2 FROM accounts WHERE domain = 'f.example' ORDER BY id`,
			v,
			AT
		)
		// The counters the purge recounts, stale until it does: the local account's follows and its status's favourites.
		await sql(h.store, 'UPDATE accounts SET followers_count = 7, following_count = 7 WHERE id = ?', alice)
		await sql(h.store, 'UPDATE statuses SET favourites_count = 7 WHERE id = ?', id18(0, 12))
		const followIds = await sql<{ id: number; out: number }>(
			h.store,
			'SELECT id, account_id = ?1 AS out FROM follows WHERE account_id = ?1 OR target_account_id = ?1 ORDER BY id',
			v
		)
		const batches: { more: boolean; changes: number }[] = []
		let firstLeft: number[] = []
		for (let more = true; more;) {
			expect(batches.length).toBeLessThan(40)
			const { result, rows } = await writtenBy(h.store, (db) => purgeBatch(db, uriOf(0), NOW))
			batches.push({ more: result, changes: rows })
			more = result
			if (batches.length === 1) {
				firstLeft = (
					await sql<{ id: number }>(
						h.store,
						'SELECT id FROM follows WHERE account_id = ?1 OR target_account_id = ?1 ORDER BY id',
						v
					)
				).map((r) => r.id)
			}
		}
		// Each batch within PURGE_BATCH, the whole purge over several.
		expect(batches.length).toBeGreaterThan(1)
		for (const { changes } of batches) {
			expect(changes).toBeLessThanOrEqual(PURGE_BATCH)
		}
		expect(batches.slice(0, -1).map((b) => b.changes)).toEqual(batches.slice(0, -1).map(() => PURGE_BATCH))
		// Every row it deletes, recounts and finishes, as the purge wrote them with one statement over each bounded
		// selection (measured before the per-row writes: 500, 500, 500 and 51, five of them its two cached images: each
		// slot deleted with the usage row, and the stored one's object doomed), and its attachments' since: an
		// unattached row, and two slots, the pending one's with the usage row.
		expect(batches.reduce((sum, b) => sum + b.changes, 0)).toBe(1555)
		expect(await sql(h.store, 'SELECT followers_count, following_count FROM accounts WHERE id = ?', alice)).toEqual([
			{ followers_count: 0, following_count: 0 },
		])
		expect(await sql(h.store, 'SELECT favourites_count FROM statuses WHERE id = ?', id18(0, 12))).toEqual([
			{ favourites_count: 0 },
		])
		// The first batch's follows: the first of both sides by their ids as text, as one read of both in that order takes.
		const gone = followIds.map((f) => String(f.id)).filter((id) => !firstLeft.includes(Number(id)))
		expect(gone.length).toBeGreaterThan(0)
		expect(gone.toSorted()).toEqual(
			followIds
				.map((f) => String(f.id))
				.toSorted()
				.slice(0, gone.length)
		)
		expect(new Set(followIds.filter((f) => gone.includes(String(f.id))).map((f) => f.out))).toEqual(new Set([0, 1]))
		expect(await sql(h.store, 'SELECT id FROM accounts WHERE id = ?', v)).toEqual([])
	}, 120_000)
})
