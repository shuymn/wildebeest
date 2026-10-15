import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { migratedStore } from './helpers'
import { type ModelSubscription, NOTIFICATION_TYPES, outboundKindOf, PolicyModel } from './policy-model'
import { accountId, REMOTE_DOMAINS, runs, type World, worldArb, writeWorld } from './policy-world'
import { updateCredentials } from '../src/domain/accounts'
import { API_VISIBILITIES, type ApiVisibility } from '../src/domain/audience'
import { type Claim, claimDeliveries, completeDelivery, EXPANSION_STEP, type Target } from '../src/domain/deliveries'
import type { NotificationType } from '../src/domain/notifications'
import { POLICIES } from '../src/domain/push'
import {
	createStatus,
	deleteStatus,
	editStatus,
	favourite,
	reblog,
	unfavourite,
	unreblog,
} from '../src/domain/statuses'
import type { StoreStub } from '../src/platform/store-client'
import type { StoreOperation } from '../src/platform/store-kernel'

// The write-side oracle (docs/visibility.md, "The oracle and the bounds harness"): on generated worlds
// (test/policy-world.ts), local authors post with every visibility and mentions, edit (a mention dropped by an edit
// stays as a silent one), delete, boost and undo a boost, favourite and undo it, and change their profile, while
// deliveries are made, remote followers leave, and authors block accounts and domains. After each action, every
// outbound activity it recorded, its targets, the notifications and the Web Push rows it wrote are checked against
// the model of the rules (test/policy-model.ts):
//   - R23: the targets of an activity are inboxes of the accounts the model lets it reach (content leaves out the
//     followers on a domain the author blocks and the addressed accounts the author blocks or whose domain it blocks;
//     a retraction may also reach what was sent about its object before), and a personal copy goes only to an
//     addressed account the activity does not name;
//   - R22: to and cc never name a silent recipient, and content never names an account the author blocks or whose
//     domain it blocks; a boost's Announce names the original's author exactly when the author does not block them or
//     their domain, and its Undo names them always;
//   - a retraction reaches every inbox that received what it withdraws or may still: delivered, still in a deliveries
//     row, or in a chunk of targets not yet expanded; an Update of the actor reaches every follower;
//   - R15 and R16: every notification written is shown to its recipient, and every push recorded is wanted, at the
//     time of the action.

// Cases per property: each writes a world and runs a sequence of actions in it. The seed is fixed (FC_SEED replays
// another), and witnesses (below) run each scenario the properties must see, so coverage never depends on chance.
const CASES = 500
const SEED = 20261015
const PRESENT = { origin: 'https://kopje.test' }
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

const ACTION_KINDS = [
	'post',
	'post',
	'edit',
	'delete',
	'delete',
	'boost',
	'unboost',
	'favourite',
	'unfavourite',
	'profile',
	'deliver',
	'deliver',
	'unfollow',
	'block',
	'block',
	'domain block',
] as const

type Action = {
	// A witness may also have every remote follower of the author leave at once, or start the deletion of a remote
	// account (`account`), as an inbound Delete of the actor does.
	kind: (typeof ACTION_KINDS)[number] | 'followers leave' | 'deletion starts'
	// Indices, taken modulo what the world offers when the action runs.
	actor: number
	target: number
	visibility: ApiVisibility
	mentions: number[]
	reply: boolean
	// A witness's choice of the account a block, domain block or unfollow names, instead of `target`.
	account?: number
}

type Case = {
	world: World
	// Per remote account (by its index among the remotes): whether it has a shared inbox.
	shared: boolean[]
	// Per local account: its Web Push subscription.
	subscriptions: { alerts: boolean[]; policy: (typeof POLICIES)[number]; expired: boolean }[]
	actions: Action[]
}

const actionArb: fc.Arbitrary<Action> = fc.record({
	kind: fc.constantFrom(...ACTION_KINDS),
	actor: fc.nat(),
	target: fc.nat(),
	visibility: fc.constantFrom(...API_VISIBILITIES),
	mentions: fc.array(fc.nat(), { maxLength: 3 }),
	reply: fc.boolean(),
})

const caseArb: fc.Arbitrary<Case> = fc.record({
	world: worldArb,
	shared: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
	subscriptions: fc.array(
		fc.record({
			alerts: fc.array(fc.boolean(), { minLength: NOTIFICATION_TYPES.length, maxLength: NOTIFICATION_TYPES.length }),
			policy: fc.constantFrom(...POLICIES),
			expired: fc.boolean(),
		}),
		{ minLength: 4, maxLength: 4 }
	),
	actions: fc.array(actionArb, { minLength: 10, maxLength: 24, size: 'max' }),
})

// The scenarios the properties must see, so none passes by checking nothing.
const SCENARIOS = [
	'actor Update to a domain-blocked follower',
	'content leaves out a domain-blocked follower',
	'content leaves out an unavailable account',
	'content to a silent recipient',
	'notification',
	'push',
	'retraction reaches a blocked receiver',
	'retraction reaches an outstanding target',
	'retraction reaches an unavailable receiver',
	'retraction reaches an unexpanded target',
	'retraction reaches what was delivered',
	'Undo(Announce) names a blocked author',
] as const

type Scenario = (typeof SCENARIOS)[number]

// A case written by hand: the four local accounts (L0 acts), remote accounts R0, R1, ... alternately on the two
// remote domains with a personal inbox only, the given statuses and accepted follows of L0, and every local account
// subscribed to every alert.
function witness(
	remotes: number,
	world: Partial<Pick<World, 'statuses'>> & { followers?: number[] },
	actions: (Partial<Action> & Pick<Action, 'kind'>)[]
): Case {
	const accounts: World['accounts'] = []
	for (let i = 0; i < 4; i++) {
		accounts.push({
			name: `L${i}`,
			local: true,
			suspended: false,
			deleting: false,
			hidesCollections: false,
			domain: null,
			uri: `https://kopje.test/ap/users/l${i}`,
		})
	}
	for (let i = 0; i < remotes; i++) {
		const domain = REMOTE_DOMAINS[i % REMOTE_DOMAINS.length]!
		accounts.push({
			name: `R${i}`,
			local: false,
			suspended: false,
			deleting: false,
			hidesCollections: false,
			domain,
			uri: `https://${domain}/users/r${i}`,
		})
	}
	return {
		world: {
			accounts,
			statuses: world.statuses ?? [],
			follows: (world.followers ?? []).map((from) => ({
				from,
				to: 0,
				accepted: true,
				showReblogs: true,
				notify: false,
			})),
			blocks: [],
			mutes: [],
			domainBlocks: [],
			now: '2026-10-12T00:00:00.000Z',
		},
		shared: [false],
		subscriptions: [{ alerts: NOTIFICATION_TYPES.map(() => true), policy: 'all', expired: false }],
		actions: actions.map((action) => ({
			actor: 0,
			target: 0,
			visibility: 'public',
			mentions: [],
			reply: false,
			...action,
		})),
	}
}

const R0 = 4
const R1 = 5

const WITNESSES: { name: string; scenarios: Scenario[]; case: Case }[] = [
	{
		name: 'a post and a delete after the deletion of a mentioned follower starts',
		scenarios: ['content leaves out an unavailable account', 'retraction reaches an unavailable receiver'],
		case: witness(2, { followers: [R0, R1] }, [
			{ kind: 'post', mentions: [R0] },
			{ kind: 'deliver' },
			{ kind: 'deletion starts', account: R0 },
			{ kind: 'post', mentions: [R0] },
			{ kind: 'delete' },
		]),
	},
	{
		name: 'a boost of an author on a blocked domain, and its Undo',
		scenarios: ['Undo(Announce) names a blocked author'],
		case: witness(
			2,
			{
				statuses: [
					{ name: 'S0', author: R0, visibility: 'public', mentions: [], reblogOf: null, replyTo: null, tagged: false },
				],
				followers: [R1],
			},
			[{ kind: 'domain block', account: R0 }, { kind: 'boost' }, { kind: 'unboost' }]
		),
	},
	{
		name: 'a profile change and a post with a follower on a blocked domain',
		scenarios: ['actor Update to a domain-blocked follower', 'content leaves out a domain-blocked follower'],
		case: witness(2, { followers: [R0, R1] }, [
			{ kind: 'domain block', account: R0 },
			{ kind: 'profile' },
			{ kind: 'post' },
		]),
	},
	{
		name: 'an edit that turns a mention silent, with notifications and pushes',
		scenarios: ['content to a silent recipient', 'notification', 'push'],
		case: witness(1, {}, [{ kind: 'post', mentions: [R0, 1] }, { kind: 'edit' }]),
	},
	{
		name: 'a delete of a delivered status after its follower is blocked',
		scenarios: ['retraction reaches what was delivered', 'retraction reaches a blocked receiver'],
		case: witness(1, { followers: [R0] }, [
			{ kind: 'post' },
			{ kind: 'deliver' },
			{ kind: 'block', account: R0 },
			{ kind: 'delete' },
		]),
	},
	{
		name: 'a delete before delivery after the follower leaves',
		scenarios: ['retraction reaches an outstanding target'],
		case: witness(1, { followers: [R0] }, [{ kind: 'post' }, { kind: 'unfollow', account: R0 }, { kind: 'delete' }]),
	},
	{
		name: 'a delete, after the followers leave, while the Create has targets not yet expanded',
		scenarios: ['retraction reaches an unexpanded target'],
		case: witness(EXPANSION_STEP + 5, { followers: Array.from({ length: EXPANSION_STEP + 5 }, (_, i) => 4 + i) }, [
			{ kind: 'post' },
			{ kind: 'followers leave' },
			{ kind: 'delete' },
		]),
	},
]

// What the property and the witnesses saw.
const seen = new Set<Scenario>()

describe('the write paths agree with the model of the outbound and notification rules', () => {
	let store: StoreStub
	beforeAll(async () => {
		store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('writes', 'secret', 'writes', 'urn:ietf:wg:oauth:2.0:oob', 'read write follow push')"
			)
		})
	})

	afterAll(() => {
		expect([...seen].sort()).toEqual([...SCENARIOS].sort())
	})

	for (const { name, scenarios, case: c } of WITNESSES) {
		it(`sees ${name}`, async () => {
			const saw = new Set<Scenario>()
			const problems = await runInDurableObject(store, (_instance, state) => check(state.storage.sql, c, saw))
			for (const scenario of saw) {
				seen.add(scenario)
			}
			expect(problems).toEqual([])
			expect(scenarios.filter((scenario) => !saw.has(scenario))).toEqual([])
		})
	}

	it('sends, addresses and notifies only as the rules allow', async () => {
		await fc.assert(
			fc.asyncProperty(caseArb, async (c) => {
				const problems = await runInDurableObject(store, (_instance, state) => check(state.storage.sql, c, seen))
				expect(problems).toEqual([])
			}),
			runs(CASES, SEED)
		)
	}, 120_000)
})

const actingToken = (x: number) => `policy-writes-${x}`
const pushToken = (x: number) => `policy-writes-push-${x}`

// The tables the actions write besides the world's, children first.
const WRITTEN_TABLES = [
	'push_deliveries',
	'push_subscriptions',
	'oauth_tokens',
	'deliveries',
	'outbound_targets',
	'outbound_receipts',
	'outbound_activities',
	'status_edits',
]

type Inboxes = { personal: string; shared: string | null }

// Writes the case: the world, the remote accounts' inboxes, and for each available local account a token to act with
// and a Web Push subscription on a second token. Returns the inboxes by account and the model's subscriptions by id.
function writeCase(
	sql: SqlStorage,
	c: Case
): { inboxes: Map<number, Inboxes>; subscriptions: Map<number, ModelSubscription> } {
	for (const table of WRITTEN_TABLES) {
		sql.exec(`DELETE FROM ${table}`)
	}
	writeWorld(sql, c.world)
	const inboxes = new Map<number, Inboxes>()
	const subscriptions = new Map<number, ModelSubscription>()
	const before = new Date(Date.parse(c.world.now) - 60_000).toISOString()
	let remote = 0
	c.world.accounts.forEach((account, x) => {
		if (!account.local) {
			const shared = c.shared[remote++ % c.shared.length] === true ? `https://${account.domain}/inbox` : null
			const personal = `${account.uri}/inbox`
			inboxes.set(x, { personal, shared })
			sql.exec('UPDATE accounts SET inbox_url = ?, shared_inbox_url = ? WHERE id = ?', personal, shared, accountId(x))
			return
		}
		if (account.suspended) {
			// A suspension deletes the account's tokens and subscriptions.
			return
		}
		const sub = c.subscriptions[x % c.subscriptions.length]!
		for (const [token, expires] of [
			[actingToken(x), null],
			[pushToken(x), sub.expired ? before : null],
		] as const) {
			sql.exec(
				`INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, expires_at)
				VALUES (?, 'access', 'writes', ?, 'read write follow push', ?)`,
				token,
				accountId(x),
				expires
			)
		}
		const alerts = NOTIFICATION_TYPES.filter((_, i) => sub.alerts[i] === true)
		const { id } = sql
			.exec<{ id: number }>(
				`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts, policy)
				VALUES (?, 'https://push.example/1', 'p256dh', 'auth', ?, ?) RETURNING id`,
				pushToken(x),
				JSON.stringify(Object.fromEntries(alerts.map((type) => [type, true]))),
				sub.policy
			)
			.one()
		subscriptions.set(id, {
			recipient: x,
			alerts,
			policy: sub.policy,
			tokenExpiresAt: sub.expired ? before : null,
		})
	})
	return { inboxes, subscriptions }
}

// The Store as a world of the model: the case's accounts, and the statuses and edges as they are now. Status indices
// follow the ids; `byId` and `byUri` find them.
type Snapshot = { world: World; byId: Map<string, number>; byUri: Map<string, number> }

function readWorld(sql: SqlStorage, base: World): Snapshot {
	const accountIndex = new Map(base.accounts.map((_, x) => [accountId(x), x]))
	const account = (id: string): number => {
		const x = accountIndex.get(id)
		if (x === undefined) {
			throw new Error(`unknown account ${id}`)
		}
		return x
	}
	const rows = sql
		.exec<{
			id: string
			uri: string
			account_id: string
			visibility: World['statuses'][number]['visibility']
			reblog_of_id: string | null
			in_reply_to_id: string | null
		}>('SELECT id, uri, account_id, visibility, reblog_of_id, in_reply_to_id FROM statuses ORDER BY id')
		.toArray()
	const byId = new Map(rows.map((row, s) => [row.id, s]))
	const deleting = new Set(
		sql
			.exec<{ id: string }>('SELECT id FROM accounts WHERE deleted_at IS NOT NULL')
			.toArray()
			.map((row) => row.id)
	)
	const mentions = sql
		.exec<{ status_id: string; account_id: string; silent: number }>(
			'SELECT status_id, account_id, silent FROM status_mentions ORDER BY account_id'
		)
		.toArray()
	return {
		byId,
		byUri: new Map(rows.map((row, s) => [row.uri, s])),
		world: {
			// Whether each remote account's deletion has started, as the Store has it now.
			accounts: base.accounts.map((account, x) => ({ ...account, deleting: deleting.has(accountId(x)) })),
			statuses: rows.map((row, s) => ({
				name: `S${s}`,
				author: account(row.account_id),
				visibility: row.visibility,
				mentions: mentions
					.filter((m) => m.status_id === row.id)
					.map((m) => ({ account: account(m.account_id), silent: m.silent === 1 })),
				reblogOf: row.reblog_of_id === null ? null : (byId.get(row.reblog_of_id) ?? null),
				replyTo: row.in_reply_to_id === null ? null : (byId.get(row.in_reply_to_id) ?? null),
				tagged: false,
			})),
			follows: sql
				.exec<{ account_id: string; target_account_id: string; state: string; show_reblogs: number; notify: number }>(
					'SELECT account_id, target_account_id, state, show_reblogs, notify FROM follows'
				)
				.toArray()
				.map((f) => ({
					from: account(f.account_id),
					to: account(f.target_account_id),
					accepted: f.state === 'accepted',
					showReblogs: f.show_reblogs === 1,
					notify: f.notify === 1,
				})),
			blocks: sql
				.exec<{ account_id: string; target_account_id: string }>('SELECT account_id, target_account_id FROM blocks')
				.toArray()
				.map((b) => ({ from: account(b.account_id), to: account(b.target_account_id) })),
			mutes: sql
				.exec<{ account_id: string; target_account_id: string; expires_at: string | null; hide_notifications: number }>(
					'SELECT account_id, target_account_id, expires_at, hide_notifications FROM mutes'
				)
				.toArray()
				.map((m) => ({
					from: account(m.account_id),
					to: account(m.target_account_id),
					expiresAt: m.expires_at,
					hideNotifications: m.hide_notifications === 1,
				})),
			domainBlocks: sql
				.exec<{ account_id: string; domain: string }>('SELECT account_id, domain FROM domain_blocks')
				.toArray()
				.map((d) => ({ owner: account(d.account_id), domain: d.domain })),
			now: base.now,
		},
	}
}

type Activity = { id?: unknown; type?: unknown; to?: unknown; cc?: unknown; object?: unknown }

function uris(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value]
	}
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function idOf(value: unknown): string | null {
	if (typeof value === 'string') {
		return value
	}
	const id = typeof value === 'object' && value !== null ? (value as { id?: unknown }).id : undefined
	return typeof id === 'string' ? id : null
}

// What an activity is about: the status of a Create, Update or Delete, the Announce or Like itself, or what an Undo
// withdraws.
function subjectOf(activity: Activity): string | null {
	switch (activity.type) {
		case 'Create':
		case 'Update':
		case 'Delete':
		case 'Undo':
			return idOf(activity.object)
		default:
			return idOf(activity)
	}
}

// Every account an activity and its object name in to and cc.
function namedIn(activity: Activity): Set<string> {
	const object = typeof activity.object === 'object' && activity.object !== null ? (activity.object as Activity) : {}
	return new Set([...uris(activity.to), ...uris(activity.cc), ...uris(object.to), ...uris(object.cc)])
}

// The targets recorded for an activity: its deliveries rows and its targets not yet expanded.
function targetsOf(sql: SqlStorage, activityId: string): Target[] {
	return sql
		.exec<Target>(
			`SELECT inbox_url AS inbox, addressee FROM deliveries WHERE activity_id = CAST(?1 AS INTEGER)
			UNION ALL
			SELECT json_extract(t.value, '$.inbox'), json_extract(t.value, '$.addressee')
			FROM outbound_targets c, json_each(c.targets) t WHERE c.activity_id = CAST(?1 AS INTEGER) AND t.key >= c.next`,
			activityId
		)
		.toArray()
}

type ActivityRow = { id: string; account_id: string; body: string }

const activityRows = (sql: SqlStorage): ActivityRow[] =>
	sql
		.exec<ActivityRow>('SELECT CAST(id AS TEXT) AS id, account_id, body FROM outbound_activities ORDER BY id')
		.toArray()

const rowKey = (row: ActivityRow) => `${row.id} ${row.body}`

function outstandingTargets(sql: SqlStorage): Map<string, { rows: Set<string>; unexpanded: Set<string> }> {
	const found = new Map<string, { rows: Set<string>; unexpanded: Set<string> }>()
	const rows = sql
		.exec<{ subject: string; inbox: string; unexpanded: number }>(
			`SELECT o.object_uri AS subject, d.inbox_url AS inbox, 0 AS unexpanded
			FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id WHERE o.retracts = 0
			UNION ALL
			SELECT o.object_uri, json_extract(t.value, '$.inbox'), 1
			FROM outbound_activities o JOIN outbound_targets c ON c.activity_id = o.id, json_each(c.targets) t
			WHERE o.retracts = 0 AND t.key >= c.next`
		)
		.toArray()
	for (const row of rows) {
		if (row.subject === null || row.inbox === '') {
			continue
		}
		const entry = found.get(row.subject) ?? { rows: new Set<string>(), unexpanded: new Set<string>() }
		;(row.unexpanded === 1 ? entry.unexpanded : entry.rows).add(row.inbox)
		found.set(row.subject, entry)
	}
	return found
}

const maxId = (sql: SqlStorage, table: string): number =>
	sql.exec<{ n: number }>(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table}`).one().n

// Runs the case's actions and returns what disagrees with the model; `saw` collects the scenarios it checked.
function check(sql: SqlStorage, c: Case, saw: Set<Scenario>): string[] {
	const { inboxes, subscriptions } = writeCase(sql, c)
	const { world } = c
	const now = Date.parse(world.now)
	const problems: string[] = []
	const run = <T>(operation: StoreOperation<never, unknown>, input: unknown) => operation.run(sql, input as never) as T
	const credential = (x: number) => ({ credential: { tokenHash: actingToken(x), scope: 'write', now }, now })
	const accountIndex = new Map(world.accounts.map((_, x) => [accountId(x), x]))
	const uriOf = (x: number) => world.accounts[x]!.uri
	const nameOf = (x: number) => world.accounts[x]!.name
	const inboxOf = (x: number) => inboxes.get(x)?.shared ?? inboxes.get(x)?.personal ?? null
	const inboxesOf = (x: number) => [inboxes.get(x)?.shared ?? null, inboxes.get(x)?.personal ?? null]
	const handleOf = (x: number) => {
		const account = world.accounts[x]!
		const username = account.name.toLowerCase()
		return account.local ? `@${username}` : `@${username}@${account.domain}`
	}
	const authors = world.accounts.flatMap((account, x) => (account.local && !account.suspended ? [x] : []))
	const pick = <T>(items: readonly T[], n: number): T | undefined => items[n % Math.max(items.length, 1)]

	// Every inbox an activity about each object (status uri, Announce or Like id) was recorded for, and those it was
	// delivered to.
	const recorded = new Map<string, Set<string>>()
	const delivered = new Map<string, Set<string>>()
	const add = (map: Map<string, Set<string>>, key: string | null, inbox: string) => {
		if (key !== null && inbox !== '') {
			map.set(key, (map.get(key) ?? new Set()).add(inbox))
		}
	}
	let objects = 0

	// The Store as a world before each action: the world after the previous one.
	let before = readWorld(sql, world)
	for (const action of c.actions) {
		// What earlier activities about each object may still send: their deliveries rows, in any state (a leased one may
		// have been POSTed), and their targets not yet expanded.
		const outstanding = outstandingTargets(sql)
		// outbound_activities reuses the id of a dropped row, and an edit replaces a waiting Create with one of the same
		// id naming the current version, so a row is told apart by its id and its body.
		const recordedBefore = new Set(activityRows(sql).map(rowKey))
		const marks = {
			notifications: maxId(sql, 'notifications'),
			pushes: maxId(sql, 'push_deliveries'),
		}
		const author = pick(authors, action.actor)
		if (author === undefined) {
			break
		}
		const ids = [...before.byId.keys()]
		const uris = [...before.byUri.keys()]
		const statuses = before.world.statuses.map((status, s) => ({ ...status, s, id: ids[s]!, uri: uris[s]! }))
		const originals = statuses.filter((status) => status.reblogOf === null)
		const own = statuses.filter((status) => status.author === author)
		// Whom a block names: as often a remote follower of the author, or an account something was delivered to, as any
		// account. What a delete takes: as often a status something was delivered about as any of the author's own.
		const received = new Set([...delivered.values()].flatMap((set) => [...set]))
		const receivers = world.accounts.flatMap((_, x) =>
			inboxesOf(x).some((inbox) => received.has(inbox ?? '')) ? [x] : []
		)
		const related = [
			...receivers,
			...receivers,
			...before.world.follows.flatMap((f) => (f.to === author && !world.accounts[f.from]!.local ? [f.from] : [])),
			...world.accounts.map((_, x) => x),
		]
		const text = action.mentions.map((n) => handleOf(n % world.accounts.length)).join(' ')
		const label = `${action.kind} by ${nameOf(author)}`
		// What the action must record: a retraction of what it withdraws, an Update of the actor.
		let withdrawn: string | null = null
		let profiled = false
		switch (action.kind) {
			case 'post': {
				const parent = action.reply ? pick(originals, action.target) : undefined
				run(createStatus, {
					...credential(author),
					text: `${text} post`,
					visibility: action.visibility,
					spoilerText: '',
					mediaIds: [],
					...(parent === undefined ? {} : { inReplyToId: parent.id }),
					objectId: `writes-${objects++}`,
					present: PRESENT,
				})
				break
			}
			case 'edit': {
				const status = pick(
					own.filter((s) => s.reblogOf === null),
					action.target
				)
				if (status !== undefined) {
					run(editStatus, {
						...credential(author),
						id: status.id,
						text: `${text} edited ${objects++}`,
						spoilerText: '',
						mediaIds: [],
						mediaAttributes: [],
						present: PRESENT,
					})
				}
				break
			}
			case 'delete': {
				const status = pick([...own.filter((s) => delivered.has(s.uri)), ...own], action.target)
				if (status !== undefined) {
					withdrawn = status.uri
					run(deleteStatus, { ...credential(author), id: status.id, deleteMedia: false, present: PRESENT })
				}
				break
			}
			case 'boost': {
				const status = pick(originals, action.target)
				if (status !== undefined) {
					run(reblog, {
						...credential(author),
						id: status.id,
						visibility: action.visibility,
						objectId: `writes-${objects++}`,
						present: PRESENT,
					})
				}
				break
			}
			case 'unboost': {
				const boost = pick(
					own.filter((s) => s.reblogOf !== null),
					action.target
				)
				if (boost?.reblogOf !== undefined && boost.reblogOf !== null) {
					withdrawn = boost.uri
					run(unreblog, { ...credential(author), id: statuses[boost.reblogOf]!.id, present: PRESENT })
				}
				break
			}
			case 'favourite':
			case 'unfavourite': {
				const status = pick(originals, action.target)
				if (status !== undefined) {
					run(action.kind === 'favourite' ? favourite : unfavourite, {
						...credential(author),
						id: status.id,
						present: PRESENT,
					})
				}
				break
			}
			case 'profile':
				profiled = true
				run(updateCredentials, {
					...credential(author),
					changes: { displayName: `profile ${objects++}` },
					present: PRESENT,
				})
				break
			case 'deliver':
				for (let round = 0; round < 64; round++) {
					const leaseToken = `lease-${objects++}`
					const claim = run<Claim>(claimDeliveries, { now, leaseToken })
					if (claim.deliveries.length === 0) {
						break
					}
					for (const delivery of claim.deliveries) {
						run(completeDelivery, {
							id: delivery.id,
							leaseToken,
							now,
							outcome: { kind: 'delivered', status: 202 },
						})
						add(delivered, subjectOf(JSON.parse(delivery.body) as Activity), delivery.inbox)
					}
				}
				break
			case 'unfollow': {
				// A remote follower leaves.
				const follow = pick(
					before.world.follows.filter(
						(f) =>
							f.to === author &&
							!world.accounts[f.from]!.local &&
							(action.account === undefined || f.from === action.account)
					),
					action.target
				)
				if (follow !== undefined) {
					sql.exec(
						'DELETE FROM follows WHERE account_id = ? AND target_account_id = ?',
						accountId(follow.from),
						accountId(follow.to)
					)
				}
				break
			}
			case 'deletion starts':
				if (action.account !== undefined) {
					sql.exec('UPDATE accounts SET deleted_at = ? WHERE id = ?', world.now, accountId(action.account))
				}
				break
			case 'followers leave':
				sql.exec(
					'DELETE FROM follows WHERE target_account_id = ? AND account_id IN (SELECT id FROM accounts WHERE domain IS NOT NULL)',
					accountId(author)
				)
				break
			case 'block': {
				// A block, with the follows it ends either way; the activities it sends are not the subject here.
				const target = action.account ?? pick(related, action.target)
				if (target !== undefined && target !== author) {
					sql.exec(
						'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
						accountId(author),
						accountId(target)
					)
					sql.exec(
						'DELETE FROM follows WHERE (account_id = ?1 AND target_account_id = ?2) OR (account_id = ?2 AND target_account_id = ?1)',
						accountId(author),
						accountId(target)
					)
				}
				break
			}
			case 'domain block': {
				// A domain block whose cleanup has not reached the follows there yet.
				const target = action.account ?? pick(related, action.target)
				const domain = target === undefined ? null : world.accounts[target]!.domain
				if (domain !== null) {
					sql.exec(
						'INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?) ON CONFLICT DO NOTHING',
						accountId(author),
						domain
					)
				}
				break
			}
		}
		const after = readWorld(sql, world)

		// The activities the action recorded.
		const retracted = new Set<string | null>()
		const contentInboxes = new Set<string>()
		let actorUpdated = false
		const activities = activityRows(sql).filter((row) => !recordedBefore.has(rowKey(row)))
		for (const row of activities) {
			const { activity } = JSON.parse(row.body) as { activity: Activity }
			const kind = outboundKindOf(activity)
			const signer = accountIndex.get(row.account_id)!
			const subject = subjectOf(activity)
			const targets = targetsOf(sql, row.id)
			const actorUpdate = kind === 'other' && activity.type === 'Update'
			if (kind === 'retraction') {
				retracted.add(subject)
			} else if (actorUpdate) {
				actorUpdated = true
			}
			const named = namedIn(activity)
			const what = `${label}: ${String(activity.type)} ${String(activity.id)}`
			// The world the activity's object is judged in: before the action for a retraction (it may be gone).
			const snapshot = kind === 'retraction' ? before : after
			const m = new PolicyModel(snapshot.world)
			const inner = typeof activity.object === 'object' && activity.object !== null ? (activity.object as Activity) : {}
			let audience: { followers: boolean; accounts: number[] }
			// The accounts it may name besides Public and the signer's followers, and those it must name.
			const mayName = new Set<number>()
			const mustName = new Set<number>()
			if (actorUpdate) {
				audience = { followers: true, accounts: [] }
			} else if (activity.type === 'Like' || inner.type === 'Like') {
				const s = snapshot.byUri.get(String(activity.type === 'Like' ? activity.object : inner.object))
				audience = { followers: false, accounts: s === undefined ? [] : [snapshot.world.statuses[s]!.author] }
			} else if (activity.type === 'Announce' || inner.type === 'Announce') {
				const boost = snapshot.byUri.get(String(activity.type === 'Announce' ? activity.id : inner.id))
				const original = boost === undefined ? null : snapshot.world.statuses[boost]!.reblogOf
				const originalAuthor = original === null ? null : snapshot.world.statuses[original]!.author
				audience = { followers: true, accounts: originalAuthor === null ? [] : [originalAuthor] }
				if (originalAuthor !== null && m.names(kind, signer, originalAuthor)) {
					mustName.add(originalAuthor)
					if (kind === 'retraction' && m.blocked(signer, originalAuthor)) {
						saw.add('Undo(Announce) names a blocked author')
					}
				}
				for (const x of mustName) {
					mayName.add(x)
				}
			} else {
				const s = subject === null ? undefined : snapshot.byUri.get(subject)
				if (s === undefined) {
					problems.push(`${what}: about no stored status`)
					continue
				}
				audience = m.statusAudience(s)
				for (const mention of snapshot.world.statuses[s]!.mentions) {
					if (!mention.silent && m.names(kind, signer, mention.account)) {
						mayName.add(mention.account)
					}
				}
			}
			const reach = m.reaches(kind, signer, audience)

			// R22: to and cc name only Public, the signer's followers and the accounts the rule lets it name.
			const allowedNames = new Set([PUBLIC, `${uriOf(signer)}/followers`, ...[...mayName].map(uriOf)])
			for (const uri of named) {
				if (!allowedNames.has(uri)) {
					problems.push(`${what}: names ${uri}`)
				}
			}
			for (const x of mustName) {
				if (!named.has(uriOf(x))) {
					problems.push(`${what}: does not name ${nameOf(x)}`)
				}
			}

			// R23: every target is an inbox of an account it reaches (or, for a retraction, one that was sent something
			// about its object); a personal copy goes to an addressed account it does not name.
			const allowedInboxes = new Set<string | null>([
				...reach.followers.map(inboxOf),
				...reach.accounts.flatMap(inboxesOf),
				...(kind === 'retraction' ? (recorded.get(subject ?? '') ?? []) : []),
			])
			const addressees = new Set(reach.accounts.map(uriOf))
			for (const target of targets) {
				if (target.inbox !== '' && !allowedInboxes.has(target.inbox)) {
					problems.push(`${what}: sent to ${target.inbox}`)
				}
				if (target.addressee !== null) {
					if (!addressees.has(target.addressee) || named.has(target.addressee)) {
						problems.push(`${what}: a personal copy for ${target.addressee}`)
					} else if (kind === 'content') {
						saw.add('content to a silent recipient')
					}
				}
			}
			const sent = new Set(targets.map((target) => target.inbox))
			if (kind === 'content') {
				for (const target of targets) {
					contentInboxes.add(target.inbox)
				}
				const whole = m.reaches('other', signer, audience)
				if (
					[...whole.followers, ...whole.accounts].some(
						(x) => !m.available(x) && inboxesOf(x).every((inbox) => inbox === null || !sent.has(inbox))
					)
				) {
					saw.add('content leaves out an unavailable account')
				}
			}

			// A retraction reaches every inbox that received what it withdraws, or may still, the blocked included.
			if (kind === 'retraction') {
				const pending = outstanding.get(subject ?? '')
				for (const [inbox, scenario] of [
					...[...(delivered.get(subject ?? '') ?? [])].map(
						(i) => [i, 'retraction reaches what was delivered'] as const
					),
					...[...(pending?.rows ?? [])].map((i) => [i, 'retraction reaches an outstanding target'] as const),
					...[...(pending?.unexpanded ?? [])].map((i) => [i, 'retraction reaches an unexpanded target'] as const),
				]) {
					if (!sent.has(inbox)) {
						problems.push(`${what}: misses ${inbox}, which ${String(subject)} was sent or queued to`)
						continue
					}
					saw.add(scenario)
					if (
						world.accounts.some(
							(_, x) =>
								m.blocked(signer, x) &&
								inboxesOf(x).includes(inbox) &&
								!reach.followers.some((f) => inboxOf(f) === inbox)
						)
					) {
						saw.add('retraction reaches a blocked receiver')
					}
					if (world.accounts.some((_, x) => !m.available(x) && inboxesOf(x).includes(inbox))) {
						saw.add('retraction reaches an unavailable receiver')
					}
				}
			}
			// An Update of the actor reaches every follower, on a blocked domain too.
			if (actorUpdate) {
				for (const f of reach.followers) {
					if (!sent.has(inboxOf(f) ?? '')) {
						problems.push(`${what}: misses the follower ${nameOf(f)}`)
					} else if (m.domainBlocks(signer, f)) {
						saw.add('actor Update to a domain-blocked follower')
					}
				}
			}
			if (kind !== 'retraction') {
				for (const target of targets) {
					add(recorded, subject, target.inbox)
				}
			}
		}

		const model = new PolicyModel(after.world)
		const followers = model.reaches('other', author, { followers: true, accounts: [] }).followers
		// A post leaves out the followers on a domain its author blocks (checked above as a bound on each target).
		if (action.kind === 'post') {
			const kept = model.reaches('content', author, { followers: true, accounts: [] }).followers
			const left = followers.filter((f) => !kept.includes(f) && !kept.some((k) => inboxOf(k) === inboxOf(f)))
			if (left.length > 0 && left.every((f) => !contentInboxes.has(inboxOf(f) ?? ''))) {
				saw.add('content leaves out a domain-blocked follower')
			}
		}
		const owed =
			withdrawn === null
				? 0
				: (delivered.get(withdrawn)?.size ?? 0) +
					(outstanding.get(withdrawn)?.rows.size ?? 0) +
					(outstanding.get(withdrawn)?.unexpanded.size ?? 0)
		if (owed > 0 && !retracted.has(withdrawn)) {
			problems.push(`${label}: records no retraction of ${withdrawn}, which was sent or queued`)
		}
		if (profiled && followers.length > 0 && !actorUpdated) {
			problems.push(`${label}: records no Update for the followers ${followers.map(nameOf).join(' ')}`)
		}

		// R15: every notification the action wrote is shown to its recipient, at the time of the action.
		const notifications = sql
			.exec<{
				id: number
				account_id: string
				type: NotificationType
				from_account_id: string
				status_id: string | null
			}>('SELECT id, account_id, type, from_account_id, status_id FROM notifications WHERE id > ?', marks.notifications)
			.toArray()
		for (const n of notifications) {
			saw.add('notification')
			const r = accountIndex.get(n.account_id)!
			const from = accountIndex.get(n.from_account_id)!
			const s = n.status_id === null ? null : (after.byId.get(n.status_id) ?? null)
			if (!world.accounts[r]!.local || !model.shown(r, n.type, from, s)) {
				problems.push(`${label}: notifies ${nameOf(r)} of ${n.type} from ${nameOf(from)}`)
			}
		}
		// R16: every push recorded is wanted by its subscription, at the time of the action.
		const pushes = sql
			.exec<{ subscription_id: number; type: NotificationType; from_account_id: string; status_id: string | null }>(
				`SELECT p.subscription_id, n.type, n.from_account_id, n.status_id
				FROM push_deliveries p JOIN notifications n ON n.id = p.notification_id WHERE p.id > ?`,
				marks.pushes
			)
			.toArray()
		for (const push of pushes) {
			saw.add('push')
			const sub = subscriptions.get(push.subscription_id)
			const from = accountIndex.get(push.from_account_id)!
			const s = push.status_id === null ? null : (after.byId.get(push.status_id) ?? null)
			if (sub === undefined || !model.pushed(sub, push.type, from, s)) {
				problems.push(`${label}: pushes ${push.type} from ${nameOf(from)} to subscription ${push.subscription_id}`)
			}
		}
		before = after
	}
	return problems
}
