import { evictDurableObject, runInDurableObject } from 'cloudflare:test'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { type ApiHarness, sql } from '../api-helpers'
import { NOW } from '../app-helpers'
import { BUILD } from '../helpers'
import { community } from '../status-helpers'
import { connect, drained, echo, type Inbox, type StreamMessage, takeAll } from './stream-helpers'
import { Db } from '../../src/db/sql'
import { addToConversation } from '../../src/domain/conversations'
import { runInboundJobs } from '../../src/domain/inbox'
import { deleteStatus, unreblog } from '../../src/domain/statuses'
import { CAPTURE_LIMITS, CONVERSATIONS_PER_TURN, streamCaughtUp, streamMerged } from '../../src/domain/streaming'
import { sha256Hex } from '../../src/security/tokens'
import { STREAM_FAULTS, TURN_BUDGET } from '../../src/stream-hub'

// Every event kind the hub serves, split across turns by the turn budget (RES-6). Each kind's fixture has more units
// than one turn's budget allows, read from the budget's constants: listeners on distinct tokens (a status or an edit is
// presented once per viewer, and a turn presents at most TURN_BUDGET.presentations), or a viewer's many units (a
// conversation event's changes, a delete's captured boosts). A notification is an event of one unit, its recipient's:
// its kind splits a batch of them, one for each of more recipients than a turn presents; so does a merge's, by checks
// (it presents nothing). Deletes are made by the API's operations (deleteStatus, unreblog), so their rows are gone
// before the fan-out reads the capture. The cases are docs/threat-model.md's (RES-6). Writes go straight to the Store, which starts no turn: the cases run each turn themselves (turn) or through the
// barrier. A new event kind joins KINDS.

// The cases, each of which writes one event to split (Fixture.event).
const CASES = 3

// The rounds of writes between turns, a turn after each: each round writes one event of the kind by the same author or
// owner and one by another, and the split event must finish within them.
const ROUNDS = 3

// The turns the cron may take to finish the event after a lost continuation.
const CRON_TURNS = 3

// The turns, with continuations dropped, in which what is left must be sent and the position reach the journal's head:
// far more than the cases' work needs, so a fan-out that keeps going without reaching the head fails here.
const SETTLE_TURNS = 20

// Each listener's expected messages, as `key`s, by receiver index.
type Expected = string[][]

type Fixture = {
	h: ApiHarness
	// The sockets that receive the kind's events, and those that must receive nothing.
	receivers: Inbox[]
	others: Inbox[]
	// Writes the event to split (straight to the Store, no turn).
	event: () => Promise<Expected>
	// Writes, between turns, events of the same kind by the same author or owner and by another.
	more: (round: number) => Promise<Expected>
}

type Kind = { name: string; fixture: () => Promise<Fixture> }

// A message as `<stream> <event> <id>`: the status id, a delete's id, a notification's id, or a conversation's last
// status id; `notifications_merged` has none.
function key(m: StreamMessage): string {
	const stream = (m.stream ?? []).join(' ')
	if (m.event === 'delete') {
		return `${stream} delete ${m.payload}`
	}
	if (m.event === 'notifications_merged') {
		return `${stream} notifications_merged`
	}
	const payload = JSON.parse(m.payload ?? 'null') as { id?: string; last_status?: { id: string } | null } | null
	const id = m.event === 'conversation' ? payload?.last_status?.id : payload?.id
	return `${stream} ${m.event} ${id}`
}

// The events left on a socket (an echo's error is not one), as keys.
const sent = (inbox: Inbox) => inbox.rest().flatMap((m) => (m.event === undefined ? [] : [key(m)]))

// A turn, as the cron's or a continuation's request to the Store's own stub, awaited until it ends.
async function turn(h: ApiHarness): Promise<void> {
	const response = await h.store.fetch('https://store.internal/stream/turn', { method: 'POST' })
	await response.body?.cancel()
}

// Whether the fan-out's position is at the journal's head (what the drain barrier waits for).
function caughtUp(h: ApiHarness): Promise<boolean> {
	return runInDurableObject(h.store, (_instance, state) => streamCaughtUp.run(state.storage.sql, undefined))
}

// Ids for rows written straight to the Store (each fixture has a Store of its own).
let nextId = 300000000000000000n
const newId = () => String(nextId++)

// `count` local accounts (ids `<prefix>` then 17 digits), each with the token `split-<id>` (`scopes`).
async function accounts(h: ApiHarness, count: number, prefix: string, scopes = 'read'): Promise<string[]> {
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username)
		SELECT printf('${prefix}%017d', i), 'https://kopje.test/ap/users/${prefix}' || i, '${prefix}' || i FROM n`,
		count
	)
	await sql(
		h.store,
		`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '${prefix}*'`
	)
	const ids = Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(17, '0')}`)
	for (const id of ids) {
		await sql(
			h.store,
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) SELECT ?, 'access', client_id, ?, ? FROM oauth_tokens LIMIT 1",
			await sha256Hex(`split-${id}`),
			id,
			scopes
		)
	}
	return ids
}

// The listeners of a kind: `receivers` of them receive, and one in five, interleaved by account id, does not.
function roles(receivers: number): boolean[] {
	let total = receivers
	while (total - Math.floor(total / 5) < receivers) {
		total++
	}
	return Array.from({ length: total }, (_, i) => i % 5 !== 4)
}

// A socket of `id` with each subscription sent; in effect once echoed (opened).
async function socket(h: ApiHarness, id: string, subscriptions: Record<string, string>[]): Promise<Inbox> {
	const inbox = await connect(h, `split-${id}`)
	for (const subscription of subscriptions) {
		inbox.send({ type: 'subscribe', ...subscription })
	}
	return inbox
}

// Every socket's subscriptions in effect, and the fan-out caught up; what arrived so far is taken.
async function opened(h: ApiHarness, inboxes: Inbox[]): Promise<void> {
	for (const inbox of inboxes) {
		await echo(inbox)
	}
	await drained(h, ...inboxes)
	for (const inbox of inboxes) {
		await takeAll(inbox)
	}
}

// A public status written straight to the Store (no turn), arrived and published at NOW.
async function status(
	h: ApiHarness,
	author: string,
	options: { media?: boolean; tag?: string; reblogOf?: string } = {}
): Promise<string> {
	const id = newId()
	const at = new Date(NOW).toISOString()
	await sql(
		h.store,
		`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at, created_at)
		VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, ?3, 'public', iif(?3 IS NULL, '<p>x</p>', ''), ?4, ?4)`,
		id,
		author,
		options.reblogOf ?? null,
		at
	)
	if (options.tag !== undefined) {
		await sql(h.store, 'INSERT INTO status_tags (status_id, name, public) VALUES (?, ?, 1)', id, options.tag)
	}
	if (options.media === true) {
		await sql(
			h.store,
			"INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES (?, ?, ?, 'image', 'https://kopje.test/m.png')",
			newId(),
			author,
			id
		)
	}
	return id
}

async function follow(h: ApiHarness, viewers: readonly string[], targets: readonly string[]): Promise<void> {
	await sql(
		h.store,
		`INSERT INTO follows (account_id, target_account_id, state)
		SELECT v.value, t.value, 'accepted' FROM json_each(?1) v, json_each(?2) t`,
		JSON.stringify(viewers),
		JSON.stringify(targets)
	)
}

// Each of `viewers` lists `members` in a list of its own; returns the lists' ids, by viewer.
async function lists(h: ApiHarness, viewers: readonly string[], members: readonly string[]): Promise<string[]> {
	const ids = viewers.map(() => newId())
	for (const [i, viewer] of viewers.entries()) {
		await sql(h.store, "INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'split')", ids[i]!, viewer)
		await sql(
			h.store,
			'INSERT INTO list_accounts (list_id, account_id) SELECT ?, value FROM json_each(?)',
			ids[i]!,
			JSON.stringify(members)
		)
	}
	return ids
}

// The sockets of `ids` on `user` and `user:notification`, opened, split by `who` into receivers and others.
async function notificationListeners(
	h: ApiHarness,
	ids: readonly string[],
	who: readonly boolean[]
): Promise<{ receivers: Inbox[]; others: Inbox[] }> {
	const receivers: Inbox[] = []
	const others: Inbox[] = []
	for (const [i, id] of ids.entries()) {
		const inbox = await socket(h, id, [{ stream: 'user' }, { stream: 'user:notification' }])
		;(who[i] ? receivers : others).push(inbox)
	}
	await opened(h, [...receivers, ...others])
	return { receivers, others }
}

// Statuses and edits on `user`, statuses on a list, `public*` and `hashtag*`: one presentation per receiving viewer.
type StatusKind = {
	// Each listener's subscriptions, by its index among the receivers and whether it receives.
	subscriptions: (index: number, receives: boolean, list: string) => Record<string, string>[]
	// The stream a receiver's messages name.
	stream: (index: number, list: string) => string
	event: 'update' | 'status.update'
	status: { media?: boolean; tag?: string }
	// Whether each listener has a list of its own (the list kind's subscription).
	lists?: boolean
}

function statusKind(name: string, kind: StatusKind): Kind {
	return {
		name,
		fixture: async () => {
			const h = await community(['author', 'other'])
			const { author, other } = h.users
			const who = roles(TURN_BUDGET.presentations + 1)
			const ids = await accounts(h, who.length, '5')
			const receiving = ids.filter((_, i) => who[i])
			// Receivers follow both authors (and, for a list kind, list them); the others follow nobody (and their lists are
			// empty).
			await follow(h, receiving, [author.id, other.id])
			const listIds = kind.lists === true ? await lists(h, ids, []) : ids.map(() => '')
			if (kind.lists === true) {
				for (const [i, list] of listIds.entries()) {
					if (who[i]) {
						await sql(
							h.store,
							'INSERT INTO list_accounts (list_id, account_id) VALUES (?1, ?2), (?1, ?3)',
							list,
							author.id,
							other.id
						)
					}
				}
			}
			// An edit's statuses, written before any socket opens (nothing is journaled for them): the author's one a case
			// (edited again between turns), another's one a round.
			const pool = { author: [] as string[], other: [] as string[] }
			if (kind.event === 'status.update') {
				for (let i = 0; i < CASES; i++) {
					pool.author.push(await status(h, author.id, kind.status))
				}
				for (let i = 0; i < ROUNDS; i++) {
					pool.other.push(await status(h, other.id, kind.status))
				}
			}
			const receivers: Inbox[] = []
			const receiverLists: string[] = []
			const others: Inbox[] = []
			for (const [i, id] of ids.entries()) {
				const inbox = await socket(h, id, kind.subscriptions(receivers.length, who[i]!, listIds[i]!))
				if (who[i]) {
					receivers.push(inbox)
					receiverLists.push(listIds[i]!)
				} else {
					others.push(inbox)
				}
			}
			await opened(h, [...receivers, ...others])
			const expected = (id: string): Expected =>
				receivers.map((_, i) => [`${kind.stream(i, receiverLists[i]!)} ${kind.event} ${id}`])
			let edited = 0
			let current = ''
			const edit = async (id: string) => {
				await sql(
					h.store,
					'UPDATE statuses SET edited_at = ? WHERE id = ?',
					new Date(NOW + ++edited * 1000).toISOString(),
					id
				)
				return id
			}
			return {
				h,
				receivers,
				others,
				event: async () => {
					if (kind.event === 'update') {
						return expected(await status(h, author.id, kind.status))
					}
					current = await edit(pool.author.shift()!)
					return expected(current)
				},
				more: async (round) => {
					if (kind.event === 'update') {
						const own = await status(h, author.id, kind.status)
						const another = await status(h, other.id, kind.status)
						return merge(expected(own), expected(another))
					}
					// The status being sent edited again, and another author's.
					const again = await edit(current)
					const another = await edit(pool.other[round]!)
					return merge(expected(again), expected(another))
				},
			}
		},
	}
}

function merge(...all: Expected[]): Expected {
	return all[0]!.map((_, i) => all.flatMap((expected) => expected[i]!))
}

const KINDS: Kind[] = [
	statusKind('update on user', {
		subscriptions: () => [{ stream: 'user' }],
		stream: () => 'user',
		event: 'update',
		status: {},
	}),
	statusKind('status.update on user', {
		subscriptions: () => [{ stream: 'user' }],
		stream: () => 'user',
		event: 'status.update',
		status: {},
	}),
	statusKind('update on list', {
		subscriptions: (_, __, list) => [{ stream: 'list', list }],
		stream: (_, list) => `list ${list}`,
		event: 'update',
		status: {},
		lists: true,
	}),
	// A local status with media goes on `public` and `public:local:media`, not on `public:remote`.
	statusKind('update on public and public:local:media', {
		subscriptions: (i, receives) =>
			receives ? [{ stream: i % 2 === 0 ? 'public' : 'public:local:media' }] : [{ stream: 'public:remote' }],
		stream: (i) => (i % 2 === 0 ? 'public' : 'public:local:media'),
		event: 'update',
		status: { media: true },
	}),
	statusKind('update on hashtag and hashtag:local', {
		subscriptions: (i, receives) =>
			receives
				? [{ stream: i % 2 === 0 ? 'hashtag' : 'hashtag:local', tag: 'cats' }]
				: [{ stream: 'hashtag', tag: 'dogs' }],
		stream: (i) => (i % 2 === 0 ? 'hashtag cats' : 'hashtag:local cats'),
		event: 'update',
		status: { tag: 'cats' },
	}),
	{
		// One event per notification: the split is of the batch, one notification for each of more receivers than a
		// turn presents, each sent on `user` and `user:notification`.
		name: 'notification on user and user:notification',
		fixture: async () => {
			const h = await community(['author', 'other'])
			const { author, other } = h.users
			const who = roles(TURN_BUDGET.presentations + 1)
			const ids = await accounts(h, who.length, '5')
			const receiving = ids.filter((_, i) => who[i])
			// The statuses the mentions are of, written before any socket opens: the author's one a case and one a round,
			// another's one a round.
			const pool = { author: [] as string[], other: [] as string[] }
			for (let i = 0; i < CASES + ROUNDS; i++) {
				pool.author.push(await status(h, author.id))
			}
			for (let i = 0; i < ROUNDS; i++) {
				pool.other.push(await status(h, other.id))
			}
			const { receivers, others } = await notificationListeners(h, ids, who)
			const mention = async (from: string, statusId: string): Promise<Expected> => {
				const rows = await sql<{ id: number; account_id: string }>(
					h.store,
					`INSERT INTO notifications (account_id, type, from_account_id, status_id)
					SELECT value, 'mention', ?, ? FROM json_each(?) ORDER BY value RETURNING id, account_id`,
					from,
					statusId,
					JSON.stringify(receiving)
				)
				const byAccount = new Map(rows.map((row) => [row.account_id, String(row.id)]))
				return receiving.map((id) => {
					const notification = byAccount.get(id)!
					return [`user notification ${notification}`, `user:notification notification ${notification}`]
				})
			}
			return {
				h,
				receivers,
				others,
				event: () => mention(author.id, pool.author.shift()!),
				more: async () =>
					merge(await mention(author.id, pool.author.shift()!), await mention(other.id, pool.other.shift()!)),
			}
		},
	},
	{
		// One event per transition, of one unit, its account's, sent on `user` and `user:notification`: no presentation,
		// a token check each. A batch of `perAccount` transitions for each receiver is more units than a turn's checks.
		name: 'notifications_merged on user and user:notification',
		fixture: async () => {
			const h = await community(['alice'])
			const who = roles(TURN_BUDGET.presentations + 1)
			const ids = await accounts(h, who.length, '5')
			const receiving = ids.filter((_, i) => who[i])
			const perAccount = Math.ceil(TURN_BUDGET.checks / receiving.length)
			const { receivers, others } = await notificationListeners(h, ids, who)
			const both = ['user notifications_merged', 'user:notification notifications_merged']
			// `count` transitions of each receiver (by index), journaled as notification-requests.ts does (streamMerged).
			const transitions = async (counts: Map<number, number>): Promise<Expected> => {
				await runInDurableObject(h.store, (_instance, state) => {
					const db = new Db(state.storage.sql)
					state.storage.transactionSync(() => {
						for (const [receiver, count] of counts) {
							for (let n = 0; n < count; n++) {
								streamMerged(db, receiving[receiver]!, new Date(NOW).toISOString())
							}
						}
					})
				})
				return receiving.map((_, i) => Array.from({ length: counts.get(i) ?? 0 }, () => both).flat())
			}
			return {
				h,
				receivers,
				others,
				event: () => transitions(new Map(receiving.map((_, i) => [i, perAccount]))),
				// The last receiver's (whose transitions the split leaves unsent), and the first's.
				more: () =>
					transitions(
						new Map([
							[receiving.length - 1, 1],
							[0, 1],
						])
					),
			}
		},
	},
	{
		// One event per owner with at most CONVERSATIONS_PER_TURN changes: owners enough that their changes are more than
		// a turn presents, so the last owner's event is split.
		name: 'conversation on direct',
		fixture: async () => {
			const h = await community(['alice'])
			const owners = Math.ceil((TURN_BUDGET.presentations + 1) / CONVERSATIONS_PER_TURN)
			const ids = await accounts(h, owners + 1, '4')
			const receivers: Inbox[] = []
			for (const id of ids.slice(0, owners)) {
				receivers.push(await socket(h, id, [{ stream: 'direct' }]))
			}
			// An account on `direct` with no conversation.
			const others = [await socket(h, ids[owners]!, [{ stream: 'direct' }])]
			await opened(h, [...receivers, ...others])
			// `count` new conversations of each owner (by index), each from a direct status of its own.
			const changed = async (counts: Map<number, number>): Promise<Expected> => {
				const statuses = new Map<number, string[]>()
				for (const [owner, count] of counts) {
					statuses.set(
						owner,
						Array.from({ length: count }, () => newId())
					)
				}
				await runInDurableObject(h.store, (_instance, state) => {
					const db = new Db(state.storage.sql)
					state.storage.transactionSync(() => {
						for (const [owner, list] of statuses) {
							for (const id of list) {
								db.run(
									`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
									VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, 'direct', '<p>x</p>', '2026-10-12T00:00:00.000Z')`,
									id,
									ids[owner]!
								)
								addToConversation(db, ids[owner]!, id)
							}
						}
					})
				})
				return receivers.map((_, i) => (statuses.get(i) ?? []).map((id) => `direct conversation ${id}`))
			}
			// Per round, a share of an event's changes for the owner whose event is split (the last) and for the first:
			// all the rounds' changes fit one event's, should they join one.
			const perRound = Math.floor(CONVERSATIONS_PER_TURN / ROUNDS)
			return {
				h,
				receivers,
				others,
				event: () => changed(new Map(receivers.map((_, i) => [i, CONVERSATIONS_PER_TURN]))),
				more: () =>
					changed(
						new Map([
							[owners - 1, perRound],
							[0, perRound],
						])
					),
			}
		},
	},
	{
		// A delete's units are the status and each captured boost for each viewer, on `user` and the viewer's list, two
		// checks each and no presentation: viewers enough that their units' checks are more than a turn's.
		name: 'delete of a status and of a boost on user and list',
		fixture: async () => {
			const h = await community(['author', 'other'])
			const { author, other } = h.users
			const boosts = CAPTURE_LIMITS.boosts
			const who = roles(Math.floor(TURN_BUDGET.checks / (2 * (1 + boosts))) + 1)
			const ids = await accounts(h, who.length, '5')
			const receiving = ids.filter((_, i) => who[i])
			const boosters = await accounts(h, boosts, '6', 'read write')
			await follow(h, receiving, [author.id, other.id, ...boosters])
			const listIds = await lists(h, receiving, [author.id, other.id, ...boosters])
			// The others: every author and booster blocks them, so none is captured for them.
			await sql(
				h.store,
				`INSERT INTO blocks (account_id, target_account_id)
				SELECT a.value, v.value FROM json_each(?1) a, json_each(?2) v`,
				JSON.stringify([author.id, other.id, ...boosters]),
				JSON.stringify(ids.filter((_, i) => !who[i]))
			)
			// Written before any socket opens: a status boosted by every booster for each case, the author's statuses
			// without boosts, and another's status boosted by every booster (one boost undone per round).
			const boosted: { status: string; boosts: string[] }[] = []
			for (let i = 0; i < CASES; i++) {
				const id = await status(h, author.id)
				const its: string[] = []
				for (const booster of boosters) {
					its.push(await status(h, booster, { reblogOf: id }))
				}
				boosted.push({ status: id, boosts: its })
			}
			const plain: string[] = []
			for (let i = 0; i < ROUNDS; i++) {
				plain.push(await status(h, author.id))
			}
			const shared = await status(h, other.id)
			const undone: string[] = []
			for (const booster of boosters) {
				undone.push(await status(h, booster, { reblogOf: shared }))
			}
			const receivers: Inbox[] = []
			const others: Inbox[] = []
			let listed = 0
			for (const [i, id] of ids.entries()) {
				const list = who[i] ? listIds[listed++]! : null
				const inbox = await socket(
					h,
					id,
					list === null ? [{ stream: 'user' }] : [{ stream: 'user' }, { stream: 'list', list }]
				)
				;(who[i] ? receivers : others).push(inbox)
			}
			await opened(h, [...receivers, ...others])
			// A delete as the API makes it (deleteStatus, unreblog: the capture, then the rows go, a status's boosts
			// with it in its job's rounds), in transactions of the Store's, which start no turn. The units are `deleted` (the
			// status, then its boosts), and none of their rows is left when the fan-out starts.
			const remove = async (
				operation: typeof deleteStatus | typeof unreblog,
				token: string,
				id: string,
				deleted: string[]
			): Promise<Expected> => {
				const credential = { tokenHash: await sha256Hex(token), scope: 'write:statuses' as const, now: NOW }
				const present = { origin: 'https://kopje.test' }
				const result = await runInDurableObject(h.store, (_instance, state) =>
					state.storage.transactionSync(() =>
						operation.run(state.storage.sql, { credential, id, deleteMedia: false, now: NOW, present })
					)
				)
				expect(result).toMatchObject({ status: 'ok', value: { status: 'ok' } })
				// An original's job removes it and its boosts, each round a transaction of the Store's too.
				await runInDurableObject(h.store, (_instance, state) => {
					for (let round = 0; round < 100; round++) {
						const savepoint = <T>(fn: () => T): T => state.storage.transactionSync(fn)
						if (
							!state.storage.transactionSync(() => runInboundJobs.run(state.storage.sql, { now: NOW }, savepoint))
								.pending
						) {
							return
						}
					}
					throw new Error('the jobs did not settle')
				})
				expect(
					await sql(
						h.store,
						'SELECT id FROM statuses WHERE id IN (SELECT value FROM json_each(?))',
						JSON.stringify(deleted)
					)
				).toEqual([])
				return listIds.map((list) => deleted.flatMap((d) => [`user delete ${d}`, `list ${list} delete ${d}`]))
			}
			return {
				h,
				receivers,
				others,
				event: () => {
					const next = boosted.shift()!
					return remove(deleteStatus, author.token, next.status, [next.status, ...next.boosts])
				},
				// The author deletes another status; a booster undoes its boost of another's.
				more: async (round) =>
					merge(
						await remove(deleteStatus, author.token, plain[round]!, [plain[round]!]),
						await remove(unreblog, `split-${boosters[round]!}`, shared, [undone[round]!])
					),
			}
		},
	},
]

describe.each(KINDS)('$name split across turns', (kind) => {
	let f: Fixture
	let dropped = 0

	beforeAll(async () => {
		f = await kind.fixture()
	}, 60_000)

	afterEach(async ({ task }) => {
		STREAM_FAULTS.dropContinuation = null
		// A failed case may leave a fan-out that never reaches the head, with the barrier asking for turns: the object is
		// reset, which ends both, so the cases after it are not starved.
		if (task.result?.state === 'fail') {
			await runInDurableObject(f.h.store, (_instance, state) => state.abort('the case failed')).catch(() => {})
		}
		for (const inbox of [...f.receivers, ...f.others]) {
			await takeAll(inbox)
		}
	})

	const all = () => [...f.receivers, ...f.others]

	// Each receiver got exactly what it expects, in order, and the others nothing, after the drain barrier; then a
	// further drain runs no turn and sends nothing.
	async function exactly(expected: Expected): Promise<void> {
		const { turns } = await barrier(expected)
		expect(f.receivers.map(sent)).toEqual(expected)
		expect(f.others.map(sent)).toEqual(f.others.map(() => []))
		expect((await drained(f.h, ...all())).turns).toBe(turns)
		expect(f.receivers.map(sent)).toEqual(expected)
		expect(f.others.map(sent)).toEqual(f.others.map(() => []))
	}

	// The drain barrier, failed as soon as a socket is sent more than it expects: a re-send that goes on would keep
	// the barrier from returning.
	async function barrier(expected: Expected): Promise<{ turns: number }> {
		let fail: (error: Error) => void = () => {}
		const overrun = new Promise<never>((_, reject) => {
			fail = reject
		})
		const watches = all().map((inbox, i) => {
			const limit = expected[i]?.length ?? 0
			const watch = () => {
				if (sent(inbox).length > limit) {
					fail(new Error(`a socket was sent more than the ${limit} events it expects`))
				}
			}
			inbox.ws.addEventListener('message', watch)
			return () => inbox.ws.removeEventListener('message', watch)
		})
		try {
			const drain = drained(f.h, ...all())
			// Once the overrun failed the case, the barrier is ended by the object's reset (afterEach).
			drain.catch(() => {})
			return await Promise.race([drain, overrun])
		} finally {
			for (const unwatch of watches) {
				unwatch()
			}
		}
	}

	// After a turn: what arrived is a prefix of what must arrive, on every socket; returns how many receivers have all
	// of `event`.
	async function arrived(expected: Expected, event: Expected): Promise<number> {
		for (const inbox of all()) {
			await echo(inbox)
		}
		f.receivers.forEach((inbox, i) => {
			const got = sent(inbox)
			expect(got).toEqual(expected[i]!.slice(0, got.length))
		})
		expect(f.others.map(sent)).toEqual(f.others.map(() => []))
		return f.receivers.filter((inbox, i) => sent(inbox).length >= event[i]!.length).length
	}

	// With continuations dropped, turns until the position is at the journal's head, what arrived a prefix of what must
	// arrive after each; then continuations are restored.
	async function settle(expected: Expected): Promise<void> {
		let turns = 0
		while (!(await caughtUp(f.h)) && turns < SETTLE_TURNS) {
			await turn(f.h)
			await arrived(expected, expected)
			turns++
		}
		expect(await caughtUp(f.h)).toBe(true)
		STREAM_FAULTS.dropContinuation = null
	}

	function dropContinuations(): void {
		dropped = 0
		STREAM_FAULTS.dropContinuation = () => {
			dropped++
		}
	}

	it('sends the event to each listener exactly once over two turns or more, and nothing to the others', async () => {
		const before = (await drained(f.h)).turns
		const expected = await f.event()
		await f.h.store.streamTick(BUILD)
		const { turns } = await barrier(expected)
		expect(turns - before).toBeGreaterThanOrEqual(2)
		await exactly(expected)
	})

	it('finishes the event within a bound while writes of its kind land between turns, then sends those once', async () => {
		dropContinuations()
		const event = await f.event()
		let expected = event
		await turn(f.h)
		// The turn left work, and the event was split: some receivers have it, some not yet.
		expect(dropped).toBe(1)
		const first = await arrived(expected, event)
		expect(first).toBeGreaterThan(0)
		expect(first).toBeLessThan(f.receivers.length)
		let finished = false
		for (let round = 0; round < ROUNDS; round++) {
			expected = merge(expected, await f.more(round))
			await turn(f.h)
			finished ||= (await arrived(expected, event)) === f.receivers.length
		}
		expect(finished).toBe(true)
		await settle(expected)
		await exactly(expected)
	})

	it('resumes from the persisted position after a lost continuation, by the cron, once each', async () => {
		dropContinuations()
		const event = await f.event()
		await turn(f.h)
		expect(dropped).toBe(1)
		const first = await arrived(event, event)
		expect(first).toBeGreaterThan(0)
		expect(first).toBeLessThan(f.receivers.length)
		// No continuation runs: the object is evicted, and the cron's turns go on from the persisted position.
		await evictDurableObject(f.h.store)
		let done = false
		for (let cron = 0; !done && cron < CRON_TURNS; cron++) {
			await turn(f.h)
			done = (await arrived(event, event)) === f.receivers.length
		}
		expect(done).toBe(true)
		await settle(event)
		await exactly(event)
	})
})
