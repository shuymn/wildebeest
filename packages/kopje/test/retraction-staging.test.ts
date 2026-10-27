import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { watchedCursor } from './read-helpers'
import { Db } from '../src/db/sql'
import {
	audienceTargets,
	beginRetraction,
	type DeliveryEnvelope,
	STAGE_MIN_ROWS,
	stageRetraction,
	STAGING_BYTES,
	STAGING_READ,
	TARGET_CHUNK_BYTES,
	type Target,
} from '../src/domain/deliveries'
import { PURGE_BATCH } from '../src/domain/inbox'
import type { StoreStub } from '../src/platform/store-client'

// RES-6: a retraction's targets staged from per-source cursors (deliveries.ts stageRetraction) over calls of at most
// maxRows rows each are audienceTargets' targets read whole at the start, each once.

const SIGNER = '100000000000000001'
const STATUS = '200000000000000001'
const STATUS_URI = 'https://kopje.test/ap/o/s'
const PARENT = '200000000000000002'

const ACCOUNT = (i: number) => `3${String(i).padStart(17, '0')}`
const BOOST = (i: number) => `4${String(i).padStart(17, '0')}`
const QUOTE = (i: number) => `5${String(i).padStart(17, '0')}`

// Inboxes, NUL and astral characters among them, and two that are no deliverable inbox.
const POOL = [
	'https://h0.example/inbox',
	'https://h1.example/inbox',
	'https://h1.example/users/a/inbox',
	'https://h2.example/in\u0000box',
	'https://h3.example/\u{1F600}/inbox',
	'https://h4.example/inbox',
	'http://h5.example/inbox',
	'',
]

type Remote = {
	inbox: number
	shared: number | null
	variant: number
	follower: boolean
	mentioned: boolean
	listed: boolean
	named: boolean
	boosts: number
	quotes: number
	votes: number[]
}

type World = {
	remotes: Remote[]
	addressed: boolean
	followers: boolean
	distributable: boolean
	parent: number
	chunks: number[][]
	next: number
	deliveries: number[]
	receipts: number[]
}

const VARIANTS = ['', '\u0000x', '\u{1F600}']

const remote = fc.record({
	inbox: fc.integer({ min: 0, max: POOL.length - 1 }),
	shared: fc.option(fc.integer({ min: 0, max: POOL.length - 1 }), { nil: null }),
	variant: fc.integer({ min: 0, max: VARIANTS.length - 1 }),
	follower: fc.boolean(),
	mentioned: fc.boolean(),
	listed: fc.boolean(),
	named: fc.boolean(),
	boosts: fc.integer({ min: 0, max: 2 }),
	quotes: fc.integer({ min: 0, max: 1 }),
	votes: fc.uniqueArray(fc.constantFrom(0, 1, 2.5), { maxLength: 3 }),
})

const world: fc.Arbitrary<World> = fc.record({
	remotes: fc.array(remote, { maxLength: 24 }),
	addressed: fc.boolean(),
	followers: fc.boolean(),
	distributable: fc.boolean(),
	parent: fc.integer({ min: -1, max: 23 }),
	chunks: fc.array(fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), { minLength: 1, maxLength: 5 }), {
		maxLength: 3,
	}),
	next: fc.integer({ min: 0, max: 3 }),
	deliveries: fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), { maxLength: 6 }),
	receipts: fc.uniqueArray(fc.integer({ min: 0, max: POOL.length - 1 }), { maxLength: 6 }),
})

// The signer, its hidden status (a Delete's), and the world's remote accounts and their rows.
function seed(sql: SqlStorage, w: World): DeliveryEnvelope {
	sql.exec(
		`INSERT INTO accounts (id, uri, username, domain) VALUES (?1, 'https://kopje.test/ap/users/alice', 'alice', NULL)`,
		SIGNER
	)
	sql.exec(
		"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'a@example.com', X'00', X'00', 'k')",
		SIGNER
	)
	w.remotes.forEach((r, i) => {
		sql.exec(
			'INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url) VALUES (?, ?, ?, ?, ?, ?)',
			ACCOUNT(i),
			`https://h${i % 5}.example/users/u${i}${VARIANTS[r.variant]}`,
			`u${i}`,
			`h${i % 5}.example`,
			POOL[r.inbox]!,
			r.shared === null ? null : POOL[r.shared]!
		)
	})
	const parent = w.parent >= 0 && w.parent < w.remotes.length
	if (parent) {
		sql.exec(
			`INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, 'https://h0.example/p', ?, 'public', ?)`,
			PARENT,
			ACCOUNT(w.parent),
			new Date(NOW).toISOString()
		)
	}
	sql.exec(
		`INSERT INTO statuses (id, uri, account_id, visibility, published_at, withdrawn, in_reply_to_id, in_reply_to_uri)
		VALUES (?, ?, ?, 'direct', ?, 1, ?, ?)`,
		STATUS,
		STATUS_URI,
		SIGNER,
		new Date(NOW).toISOString(),
		parent ? PARENT : null,
		parent ? 'https://h0.example/p' : null
	)
	sql.exec(`INSERT INTO polls (status_id, options, tallies) VALUES (?, '["a","b","c"]', '[0,0,0]')`, STATUS)
	w.remotes.forEach((r, i) => {
		if (r.follower) {
			sql.exec(
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				ACCOUNT(i),
				SIGNER
			)
		}
		if (r.mentioned) {
			sql.exec(
				'INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id) VALUES (?, ?, ?, 1, ?)',
				STATUS,
				ACCOUNT(i),
				r.named ? 0 : 1,
				SIGNER
			)
		}
		for (let b = 0; b < r.boosts; b++) {
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at, withdrawn)
				VALUES (?, ?, ?, ?, 'public', ?, ?)`,
				BOOST(i * 10 + b),
				`https://h0.example/b/${i}/${b}`,
				ACCOUNT(i),
				STATUS,
				new Date(NOW).toISOString(),
				b === 0 ? 0 : 1
			)
		}
		for (let q = 0; q < r.quotes; q++) {
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?, ?, ?, 'public', ?)`,
				QUOTE(i * 10 + q),
				`https://h0.example/q/${i}/${q}`,
				ACCOUNT(i),
				new Date(NOW).toISOString()
			)
			sql.exec(
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				VALUES (?, ?, ?, ?, 'accepted', '')`,
				QUOTE(i * 10 + q),
				STATUS_URI,
				STATUS,
				SIGNER
			)
		}
		for (const choice of r.votes) {
			sql.exec('INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, ?)', STATUS, ACCOUNT(i), choice)
		}
	})
	// An earlier Create of the status: its chunks not yet expanded, its rows in every state, and the receipts.
	const create = sql
		.exec<{ id: number }>(
			`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
			VALUES (?, '{"activity":{"type":"Create"},"audience":{"followers":false,"accounts":[]}}', ?, 0, 0) RETURNING id`,
			SIGNER,
			STATUS_URI
		)
		.one().id
	for (const chunk of w.chunks) {
		sql.exec(
			'INSERT INTO outbound_targets (activity_id, targets, next) VALUES (?, ?, ?)',
			create,
			JSON.stringify(chunk.map((i) => ({ inbox: POOL[i], addressee: null }))),
			Math.min(w.next, chunk.length - 1)
		)
	}
	const states = ['queued', 'pending', 'leased', 'gave_up']
	w.deliveries.forEach((i, n) => {
		const state = states[n % states.length]!
		sql.exec(
			`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, lease_token)
			VALUES (?, ?, ?, 'x', ?, 0, 0, ?)`,
			create,
			SIGNER,
			POOL[i]!,
			state,
			state === 'leased' ? 't' : null
		)
	})
	for (const i of w.receipts) {
		sql.exec(
			'INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, ?, ?, 0)',
			STATUS,
			POOL[i]!,
			SIGNER
		)
	}
	const named = w.remotes.flatMap((r, i) =>
		r.named ? [`https://h${i % 5}.example/users/u${i}${VARIANTS[r.variant]}`] : []
	)
	return {
		activity: {
			type: 'Delete',
			id: `${STATUS_URI}#delete`,
			actor: 'https://kopje.test/ap/users/alice',
			object: STATUS_URI,
			...(w.addressed ? { to: named } : {}),
		},
		audience: {
			followers: w.followers,
			accounts: w.remotes.flatMap((r, i) => (r.listed ? [ACCOUNT(i)] : [])),
			status: STATUS,
			...(w.distributable ? { distributable: true } : {}),
			pollVoters: STATUS,
		},
	}
}

// A target as a staged retraction writes it: its provenance without domains (staged retractions carry account
// provenance only), and only when chunked() admits it.
function comparable(t: Target): string | null {
	const rest: Target = { ...t }
	delete rest.domains
	const json = JSON.stringify(rest)
	return new TextEncoder().encode(json).byteLength + 3 <= TARGET_CHUNK_BYTES ? json : null
}

// Stages the intent call by call, each call's maxRows the next of `rows`, each in its own transaction: the calls and
// the most rows a call wrote above its maxRows (0 when none did).
function stageAll(state: DurableObjectState, rows: readonly number[], cap = 5000): { calls: number; over: number } {
	const db = new Db(state.storage.sql, (fn) => state.storage.transactionSync(fn))
	const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
	let over = 0
	for (let call = 0; call < cap; call++) {
		const maxRows = rows[call % rows.length]!
		const before = changes()
		const done = state.storage.transactionSync(() => stageRetraction(db, SIGNER, STATUS_URI, maxRows))
		over = Math.max(over, changes() - before - maxRows)
		if (done) {
			return { calls: call + 1, over }
		}
	}
	throw new Error('the staging did not end')
}

function written(sql: SqlStorage, intent: string): string[] {
	return sql
		.exec<{ targets: string }>(
			'SELECT targets FROM outbound_targets WHERE activity_id = CAST(? AS INTEGER) ORDER BY id',
			intent
		)
		.toArray()
		.flatMap((c) => (JSON.parse(c.targets) as Target[]).map((t) => JSON.stringify(t)))
}

async function staged(w: World, rows: readonly number[]) {
	const store: StoreStub = await migratedStore()
	return runInDurableObject(store, (_instance, state) => {
		const sql = state.storage.sql
		const envelope = state.storage.transactionSync(() => seed(sql, w))
		const db = new Db(sql)
		const oracle = audienceTargets(db, SIGNER, envelope.activity, envelope.audience)
			.map(comparable)
			.filter((t): t is string => t !== null)
		const intent = state.storage.transactionSync(() => beginRetraction(db, SIGNER, envelope, NOW, 1, 'bounded')!)
		const run = stageAll(state, rows)
		return {
			oracle,
			written: written(sql, intent),
			...run,
			left: sql
				.exec<{ n: number }>(
					'SELECT (SELECT count(*) FROM retraction_stagings) + (SELECT count(*) FROM retraction_reach) AS n'
				)
				.one().n,
			staged: sql
				.exec<{ staged: string | null }>('SELECT staged FROM outbound_activities WHERE id = ?', intent)
				.toArray(),
		}
	})
}

describe('a staged retraction (RES-6)', () => {
	it('writes audienceTargets’ targets at the start, each once, within each call’s maxRows', async () => {
		await fc.assert(
			fc.asyncProperty(
				world,
				fc.array(fc.integer({ min: STAGE_MIN_ROWS, max: 500 }), { minLength: 1, maxLength: 8 }),
				async (w, rows) => {
					const result = await staged(w, rows)
					expect(result.over).toBe(0)
					expect(new Set(result.written).size).toBe(result.written.length)
					expect([...result.written].sort()).toEqual([...result.oracle].sort())
					expect(result.left).toBe(0)
					expect(result.staged.every((s) => s.staged === null)).toBe(true)
				}
			),
			{ numRuns: 30 }
		)
	}, 300_000)
})

// A SqlStorage over `real` that adds each statement's rows read (cursor.rowsRead) and the UTF-8 bytes of the text it
// returned to `meter`.
function metered(real: SqlStorage, meter: { reads: number; bytes: number }): SqlStorage {
	const encoder = new TextEncoder()
	return {
		exec: (query: string, ...params: SqlStorageValue[]) => {
			const cursor = real.exec(query, ...params)
			return watchedCursor(
				cursor,
				() => (meter.reads += cursor.rowsRead),
				(rows) => {
					for (const value of rows.flatMap((row) => Object.values(row))) {
						meter.bytes += typeof value === 'string' ? encoder.encode(value).byteLength : 0
					}
				}
			)
		},
	} as unknown as SqlStorage
}

// maxRows drawn in [STAGE_MIN_ROWS, PURGE_BATCH] by a fixed generator, so a failure replays.
function drawnRows(n: number): number[] {
	let x = 12345
	return Array.from({ length: n }, () => {
		x = (x * 1103515245 + 12345) % 2147483648
		return STAGE_MIN_ROWS + (x % (PURGE_BATCH - STAGE_MIN_ROWS + 1))
	})
}

// Every source past STAGING_READ at once, grown after the statistics were taken: 5,000 followers on distinct inboxes
// (one at TARGET_CHUNK_BYTES raw bytes, one past it), 600 silent mentions (personal copies), 600 boosters and one
// account with 600 boosts, 600 quoters, 600 voters and one with 100 choices (fractional ones too), 600 addressed
// accounts in the envelope, 500 earlier intents without rows and a Create with 600 targets not expanded (the first
// chunk mid-way) and 600 rows in every state, and 600 receipts with one past TARGET_CHUNK_BYTES.
async function cappedWorld(): Promise<{ store: StoreStub; envelope: DeliveryEnvelope }> {
	const store = await migratedStore()
	const envelope = await runInDurableObject(store, (_instance, state) => {
		const sql = state.storage.sql
		const base = state.storage.transactionSync(() =>
			seed(sql, {
				remotes: [{ ...REMOTE, follower: true, mentioned: true, boosts: 1, quotes: 1, votes: [0], listed: true }],
				addressed: true,
				followers: true,
				distributable: true,
				parent: 0,
				chunks: [[0, 1]],
				next: 0,
				deliveries: [0],
				receipts: [0],
			})
		)
		sql.exec('ANALYZE')
		const n = (count: number, body: string, ...params: SqlStorageValue[]) =>
			sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}) ${body}`, ...params)
		state.storage.transactionSync(() => {
			n(
				6000,
				`INSERT INTO accounts (id, uri, username, domain, inbox_url)
				SELECT printf('6%017d', i), 'https://f' || i || '.example/u', 'u', 'f' || i || '.example',
					'https://f' || i || '.example/in' || char(0) || 'box' || char(128512) FROM n`
			)
			for (const [i, bytes] of [
				[5001, TARGET_CHUNK_BYTES],
				[5002, TARGET_CHUNK_BYTES + 1],
			] as const) {
				const prefix = 'https://big.example/'
				sql.exec(
					"UPDATE accounts SET inbox_url = ? || replace(hex(zeroblob(?)), '00', 'x') WHERE id = printf('6%017d', ?)",
					prefix,
					bytes - prefix.length,
					i
				)
			}
			n(
				5002,
				`INSERT INTO follows (account_id, target_account_id, state) SELECT printf('6%017d', i), ?, 'accepted' FROM n`,
				SIGNER
			)
			n(
				600,
				`INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
				SELECT ?1, printf('6%017d', i), 1, 1, ?2 FROM n`,
				STATUS,
				SIGNER
			)
			n(
				600,
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
				SELECT printf('7%017d', i), 'https://f.example/b/' || i, printf('6%017d', 600 + i), ?1, 'public', '2026-01-01' FROM n`,
				STATUS
			)
			n(
				600,
				`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at, withdrawn)
				SELECT printf('7%017d', 1000 + i), 'https://f.example/bb/' || i, printf('6%017d', 1201), ?1, 'public', '2026-01-01',
					i > 1 FROM n`,
				STATUS
			)
			n(
				600,
				`INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT printf('8%017d', i), 'https://f.example/q/' || i, printf('6%017d', 1201 + i), 'public', '2026-01-01' FROM n`
			)
			n(
				600,
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
				SELECT printf('8%017d', i), ?1, ?2, ?3, 'accepted', '' FROM n`,
				STATUS_URI,
				STATUS,
				SIGNER
			)
			n(
				600,
				`INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?1, printf('6%017d', 1801 + i), 0 FROM n`,
				STATUS
			)
			n(
				100,
				`INSERT INTO poll_votes (poll_id, account_id, choice) SELECT ?1, printf('6%017d', 2402), (i - 1) / 2.0 FROM n`,
				STATUS
			)
			n(
				500,
				`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
				SELECT ?1, '{"activity":{"type":"Update"},"audience":{"followers":false,"accounts":[]}}', ?2, 0, 0 FROM n`,
				SIGNER,
				STATUS_URI
			)
			const create = sql
				.exec<{ id: number }>(
					`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
					VALUES (?, '{"activity":{"type":"Create"},"audience":{"followers":false,"accounts":[]}}', ?, 0, 0) RETURNING id`,
					SIGNER,
					STATUS_URI
				)
				.one().id
			for (let c = 0; c < 6; c++) {
				sql.exec(
					'INSERT INTO outbound_targets (activity_id, targets, next) VALUES (?, ?, ?)',
					create,
					JSON.stringify(
						Array.from({ length: 100 }, (_, i) => ({ inbox: `https://c${c * 100 + i}.example/inbox`, addressee: null }))
					),
					c === 0 ? 50 : 0
				)
			}
			n(
				600,
				`INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at, lease_token)
				SELECT ?1, ?2, 'https://d' || i || '.example/inbox', 'x',
					CASE i % 4 WHEN 0 THEN 'queued' WHEN 1 THEN 'pending' WHEN 2 THEN 'leased' ELSE 'gave_up' END, 0, 0,
					CASE i % 4 WHEN 2 THEN 't' END FROM n`,
				create,
				SIGNER
			)
			n(
				600,
				`INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
				SELECT ?1, 'https://e' || i || '.example/inbox', ?2, 0 FROM n`,
				STATUS,
				SIGNER
			)
			sql.exec(
				`INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
				VALUES (?1, 'https://e3.example/' || replace(hex(zeroblob(?3)), '00', 'x'), ?2, 0)`,
				STATUS,
				SIGNER,
				TARGET_CHUNK_BYTES
			)
		})
		const audience = base.audience as Record<string, unknown>
		return {
			...base,
			audience: {
				...base.audience,
				accounts: [
					...(audience.accounts as string[]),
					...Array.from({ length: 600 }, (_, i) => `6${String(2403 + i).padStart(17, '0')}`),
				],
			},
		}
	})
	return { store, envelope }
}

const REMOTE: Remote = {
	inbox: 0,
	shared: null,
	variant: 0,
	follower: false,
	mentioned: false,
	listed: false,
	named: false,
	boosts: 0,
	quotes: 0,
	votes: [],
}

describe('a staged retraction’s calls at every source’s cap (RES-6)', () => {
	it('reads, returns and writes within their derived bounds in each call, and stages what audienceTargets finds', async () => {
		const { store, envelope } = await cappedWorld()
		const warned = vi.spyOn(console, 'warn')
		const result = await runInDurableObject(store, (_instance, state) => {
			const real = state.storage.sql
			const oracle = audienceTargets(new Db(real), SIGNER, envelope.activity, envelope.audience)
				.map(comparable)
				.filter((t): t is string => t !== null)
			const intent = state.storage.transactionSync(() =>
				beginRetraction(new Db(real), SIGNER, envelope, NOW, 1, 'bounded')!
			)
			const rows = drawnRows(997)
			const calls: { reads: number; bytes: number; wrote: number; maxRows: number }[] = []
			for (let call = 0; call < 2000; call++) {
				const meter = { reads: 0, bytes: 0 }
				const db = new Db(metered(real, meter), (fn) => state.storage.transactionSync(fn))
				const changes = () => new Db(real).first<{ n: number }>('SELECT total_changes() AS n')!.n
				const maxRows = rows[call % rows.length]!
				const before = changes()
				const done = state.storage.transactionSync(() => stageRetraction(db, SIGNER, STATUS_URI, maxRows))
				calls.push({ ...meter, wrote: changes() - before, maxRows })
				if (done) {
					break
				}
			}
			return {
				calls,
				oracle,
				written: written(real, intent),
				receipts: real.exec<{ n: number }>('SELECT count(*) AS n FROM outbound_receipts').one().n,
				body: real
					.exec<{ n: number }>('SELECT length(CAST(body AS BLOB)) AS n FROM outbound_activities WHERE id = ?', intent)
					.one().n,
			}
		})
		const oversized = warned.mock.calls.filter(
			([e]) => (e as { event?: string }).event === 'kopje.delivery.oversized_target'
		)
		warned.mockRestore()
		expect(result.calls.length).toBeGreaterThan(20)
		for (const [i, call] of result.calls.entries()) {
			expect(call.wrote, `call ${i}`).toBeLessThanOrEqual(call.maxRows)
			// Gathering: at most three rows a raw candidate (its index entry and two seeks), the statements past them,
			// and the receipts' cursor read again in SQL; merging: a read and an upsert a target; writing out: the page,
			// and its range delete's offset and rows; and the fixed seeks.
			expect(call.reads, `call ${i}`).toBeLessThanOrEqual(7 * STAGING_READ + 2 * call.maxRows + 64)
			// The projected values and one past STAGING_BYTES, the chunks parsed and one past it, the staged page and one
			// past it, and the envelope.
			expect(call.bytes, `call ${i}`).toBeLessThanOrEqual(3 * STAGING_BYTES + 3 * TARGET_CHUNK_BYTES + result.body)
		}
		expect(new Set(result.written).size).toBe(result.written.length)
		expect([...result.written].sort()).toEqual([...result.oracle].sort())
		// The receipt past TARGET_CHUNK_BYTES is deleted, never a target; the inbox at the cap is refused by chunked's
		// rule, the one past it never reaches the Worker; each is logged.
		expect(result.receipts).toBe(601)
		expect(result.written.some((t) => t.includes('big.example') || t.includes('e3.example/x'))).toBe(false)
		expect(oversized.length).toBeGreaterThan(0)
	}, 600_000)
})
