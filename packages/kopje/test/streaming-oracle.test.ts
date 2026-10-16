import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { accountId, listId, runs, statusId, type World, worldArb, writeWorld } from './policy-world'
import { Db } from '../src/db/sql'
import type { Page, PageQuery } from '../src/domain/accounts'
import { addToConversation, type Conversation, listConversations } from '../src/domain/conversations'
import { listNotifications, type Notification } from '../src/domain/notifications'
import type { Status } from '../src/domain/status-presenter'
import { streamUnit } from '../src/domain/streaming'
import { homeTimeline, listTimeline } from '../src/domain/timelines'
import type { StoreStub } from '../src/platform/store-client'
import type { StoreOperation } from '../src/platform/store-kernel'

// R33's oracle for the `user` stream's statuses (docs/visibility.md; design "Kopje streaming API" §4.2 and §7): on
// generated worlds (test/policy-world.ts), for every local viewer and every status, the streaming unit (streamUnit,
// with its narrowed reads) agrees with the references it stands for, read in full by the REST reads:
//   - `update` on `user`: home positioned at the status (the read with max_id just above it and limit 1);
//   - `status.update` on `user`: home positioned at it, or, with a notification scope, the mention reference (the
//     viewer's notifications of type mention, listed in full, hold one of the status);
//   - `status.update` on `user:notification`: the mention reference alone.
// Then the window cases: what positioned membership means for home's followed-hashtag windows, which a page read from
// the top cuts at tagCandidates candidates (the documented difference).

const CASES = 40
const PRESENT = { origin: 'https://kopje.test' }

// The tokens of each local account: every scope, statuses only, notifications only.
const SCOPES = { read: 'read', statuses: 'read:statuses', notifications: 'read:notifications' } as const
type Grant = keyof typeof SCOPES
const tokenOf = (x: number, grant: Grant) => `stream-oracle-${grant}-${x}`

// A world and, for each mention of a local account in an original, whether its notification was filtered.
type Case = { world: World; filtered: boolean[] }

const caseArb: fc.Arbitrary<Case> = fc.record({
	world: worldArb,
	filtered: fc.array(fc.boolean(), { maxLength: 64 }),
})

function writeCase(sql: SqlStorage, { world, filtered }: Case): void {
	sql.exec('DELETE FROM oauth_tokens')
	writeWorld(sql, world)
	// Arrived as published: inside the real-time window.
	sql.exec('UPDATE statuses SET created_at = published_at')
	world.accounts.forEach((account, x) => {
		if (account.local) {
			for (const [grant, scopes] of Object.entries(SCOPES)) {
				sql.exec(
					"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'oracle', ?, ?)",
					tokenOf(x, grant as Grant),
					accountId(x),
					scopes
				)
			}
		}
	})
	// The mention notifications notify would have written: each local account an original mentions (not silently),
	// from its author, some filtered by the recipient's policy.
	let n = 0
	world.statuses.forEach((status, s) => {
		if (status.reblogOf !== null) {
			return
		}
		for (const mention of status.mentions) {
			if (!world.accounts[mention.account]?.local || mention.silent || mention.account === status.author) {
				continue
			}
			sql.exec(
				`INSERT OR IGNORE INTO notifications (account_id, type, from_account_id, status_id, filtered)
				VALUES (?, 'mention', ?, ?, ?)`,
				accountId(mention.account),
				accountId(status.author),
				statusId(s),
				filtered[n++ % Math.max(filtered.length, 1)] === true ? 1 : 0
			)
		}
	})
}

function ok<T>(result: unknown, what: string): T {
	const authorized = result as { status: string; value?: T }
	if (authorized.status !== 'ok') {
		throw new Error(`${what}: ${authorized.status}`)
	}
	return authorized.value as T
}

// What the shown rows covered, over every case, so the property cannot pass by showing nothing.
const shown = new Set<string>()

function check(sql: SqlStorage, c: Case): string[] {
	writeCase(sql, c)
	const { world } = c
	const now = Date.parse(world.now)
	const problems: string[] = []
	const run = <T>(operation: StoreOperation<never, unknown>, input: unknown) => operation.run(sql, input as never) as T
	world.accounts.forEach((account, viewer) => {
		if (!account.local || account.suspended) {
			return
		}
		const credential = { tokenHash: tokenOf(viewer, 'read'), scope: 'read', now } as const
		// The mention reference, read in full: the statuses of the viewer's listed mention notifications.
		const mentioned = new Set<string>()
		for (let page: PageQuery = { limit: 40 }; ;) {
			const listed = ok<Page<Notification>>(
				run(listNotifications, {
					credential,
					page,
					types: ['mention'],
					excludeTypes: [],
					accountId: null,
					includeFiltered: false,
					present: PRESENT,
				}),
				'notifications'
			)
			for (const notification of listed.items) {
				if (notification.status !== null && notification.status !== undefined) {
					mentioned.add(notification.status.id)
				}
			}
			if (listed.items.length < 40 || listed.oldest === null) {
				break
			}
			page = { limit: 40, maxId: listed.oldest }
		}
		// Every list of the world, the viewer's or another owner's, by its read positioned at each status.
		const listPositioned = (l: number, id: string) =>
			(
				ok<Page<Status> | null>(
					run(listTimeline, {
						credential,
						id: listId(l),
						page: { limit: 1, maxId: String(BigInt(id) + 1n) },
						present: PRESENT,
					}),
					'list'
				) as Page<Status> | null
			)?.items[0]?.id === id
		world.statuses.forEach((_, s) => {
			const id = statusId(s)
			for (const [l] of world.lists.entries()) {
				const positionedInList = listPositioned(l, id)
				for (const kind of ['status', 'edit']) {
					const made = run<{ streams: { stream: string }[] }>(streamUnit, {
						kind,
						subject: id,
						accountId: accountId(viewer),
						tokenHashes: [tokenOf(viewer, 'statuses')],
						lists: [listId(l)],
						now,
					})
					const onList = made.streams.some(({ stream }) => stream === `list:${listId(l)}`)
					if (onList !== positionedInList) {
						problems.push(
							`${kind} on list ${l} ${world.accounts[viewer]?.name} ${world.statuses[s]?.name}: sent ${onList}, the list read ${positionedInList}`
						)
					}
				}
				if (positionedInList) {
					shown.add('list')
				}
			}
			const positioned =
				ok<Page<Status>>(
					run(homeTimeline, {
						credential,
						page: { limit: 1, maxId: String(BigInt(id) + 1n) },
						present: PRESENT,
					}),
					'home'
				).items[0]?.id === id
			const mention = mentioned.has(id)
			const unit = (kind: string, grant: Grant) => {
				const made = run<{ event: string; streams: { stream: string; needs: object }[]; grants: object }>(streamUnit, {
					kind,
					subject: id,
					accountId: accountId(viewer),
					tokenHashes: [tokenOf(viewer, grant)],
					now,
				})
				// The streams a socket with this token is sent the event on.
				const granted = Object.values(made.grants)[0] as { statuses: boolean; notifications: boolean } | undefined
				return made.streams
					.filter(
						({ needs }) =>
							granted !== undefined &&
							(!(needs as { statuses: boolean }).statuses || granted.statuses) &&
							(!(needs as { notifications: boolean }).notifications || granted.notifications)
					)
					.map(({ stream }) => stream)
			}
			const expected: [string, Grant, string[]][] = [
				['status', 'read', positioned ? ['user'] : []],
				['status', 'statuses', positioned ? ['user'] : []],
				['edit', 'read', [...(positioned || mention ? ['user'] : []), ...(mention ? ['user:notification'] : [])]],
				['edit', 'statuses', positioned ? ['user'] : []],
				['edit', 'notifications', mention ? ['user:notification'] : []],
			]
			for (const [kind, grant, streams] of expected) {
				const actual = unit(kind, grant)
				if (JSON.stringify(actual) !== JSON.stringify(streams)) {
					problems.push(
						`${kind} ${grant} ${world.accounts[viewer]?.name} ${world.statuses[s]?.name}: sends on [${actual.join(' ')}], the references [${streams.join(' ')}]`
					)
				}
			}
			if (positioned) {
				shown.add('home')
			}
			if (mention && !positioned) {
				shown.add('mention only')
			}
		})
	})
	return problems
}

describe('R33: the streamed statuses agree with their references', () => {
	let store: StoreStub
	beforeAll(async () => {
		store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
			state.storage.sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('oracle', 'secret', 'oracle', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
		})
	})

	it('home positioned at the status, and the mention reference under a notification scope', async () => {
		await fc.assert(
			fc.asyncProperty(caseArb, async (c) => {
				const problems = await runInDurableObject(store, (_instance, state) => check(state.storage.sql, c))
				expect(problems).toEqual([])
			}),
			runs(CASES)
		)
		expect([...shown].sort()).toEqual(['home', 'list', 'mention only'])
	}, 120_000)
})

// Home's followed-hashtag windows (timelines.ts tagCandidates): a page from the top inspects 40 of a hashtag's public
// statuses from its cursor (for a page of 20), so a status behind 40 or more newer ones the viewer's home hides is left
// out of it; positioned at the status, it heads its window and is sent, as max_id paging shows it.
describe('R33: positioned membership and the followed-hashtag windows', () => {
	const VIEWER = '100000000000000001'
	const AUTHOR = '100000000000000002'
	const HIDDEN = '100000000000000003'
	const TOKEN = 'stream-window'

	// The viewer follows #cats and nobody; the author's public #cats status S is below `hidden` newer #cats statuses of
	// an account the viewer blocks.
	async function world(hidden: number, follows = true): Promise<{ store: StoreStub; s: string }> {
		const store = await migratedStore()
		const s = '300000000000000000'
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const at = new Date(NOW).toISOString()
			sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
			for (const [id, name, domain] of [
				[VIEWER, 'viewer', null],
				[AUTHOR, 'author', 'far.example'],
				[HIDDEN, 'hidden', 'far.example'],
			] as const) {
				sql.exec(
					'INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)',
					id,
					`https://${domain ?? 'kopje.test'}/users/${name}`,
					name,
					domain
				)
			}
			sql.exec(
				"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, 'viewer@example.com', X'00', X'00', 'test')",
				VIEWER
			)
			sql.exec('INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', VIEWER, HIDDEN)
			if (follows) {
				sql.exec("INSERT INTO tag_follows (account_id, name) VALUES (?, 'cats')", VIEWER)
			}
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
				VALUES (?, 'https://far.example/objects/s', ?, 'public', '<p>s</p>', ?, ?)`,
				s,
				AUTHOR,
				at,
				at
			)
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at)
				SELECT CAST(300000000000000000 + i AS TEXT), 'https://far.example/objects/h' || i, ?2, 'public', '<p>h</p>', ?3, ?3
				FROM n WHERE ?1 > 0`,
				hidden,
				HIDDEN,
				at
			)
			sql.exec("INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses")
			sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('window', 'secret', 'window', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
			sql.exec(
				"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'window', ?, 'read')",
				TOKEN,
				VIEWER
			)
		})
		return { store, s }
	}

	async function home(store: StoreStub, page: PageQuery): Promise<string[]> {
		return runInDurableObject(store, (_instance, state) =>
			ok<Page<Status>>(
				homeTimeline.run(state.storage.sql, {
					credential: { tokenHash: TOKEN, scope: 'read', now: NOW },
					page,
					present: PRESENT,
				}),
				'home'
			).items.map((status) => status.id)
		)
	}

	async function streamed(store: StoreStub, s: string): Promise<string> {
		return runInDurableObject(
			store,
			(_instance, state) =>
				streamUnit.run(state.storage.sql, {
					kind: 'status',
					subject: s,
					accountId: VIEWER,
					tokenHashes: [TOKEN],
					now: NOW,
				}).event
		)
	}

	const justAbove = (id: string) => String(BigInt(id) + 1n)
	const justBelow = (id: string) => String(BigInt(id) - 1n)

	it('sends S behind 41 newer hidden posts, which a page from the top leaves out', async () => {
		const { store, s } = await world(41)
		expect(await home(store, { limit: 20 })).toEqual([])
		expect(await home(store, { limit: 1, maxId: justAbove(s) })).toEqual([s])
		expect(await streamed(store, s)).toBe('update')
	})

	it('sends S at the 40th candidate, which a page from the top shows too', async () => {
		const { store, s } = await world(39)
		expect(await home(store, { limit: 20 })).toEqual([s])
		expect(await streamed(store, s)).toBe('update')
	})

	it('agrees with ascending min_id paging from just below S', async () => {
		const { store, s } = await world(41)
		expect(await home(store, { limit: 1, minId: justBelow(s) })).toEqual([s])
		expect(await streamed(store, s)).toBe('update')
	})

	it('sends nothing to an empty home', async () => {
		const { store, s } = await world(0, false)
		expect(await home(store, { limit: 20 })).toEqual([])
		expect(await home(store, { limit: 1, maxId: justAbove(s) })).toEqual([])
		expect(await streamed(store, s)).toBe('')
	})
})

// The conversation oracle (design §7): `conversation` on `direct` for (V, C) is sent exactly when C is in V's relation,
// with V's presentation of it: compared against V's whole conversation list read in one page, never against a status
// position. The world's direct originals join the conversations of their local author and mentioned local accounts,
// as storing them and notifying the mentions does.
describe('R33: the streamed conversation agrees with the conversation relation', () => {
	let store: StoreStub
	beforeAll(async () => {
		store = await migratedStore()
		await runInDurableObject(store, (_instance, state) => {
			state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')")
			state.storage.sql.exec(
				"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('oracle', 'secret', 'oracle', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
			)
		})
	})

	function checkConversations(sql: SqlStorage, c: Case): string[] {
		writeCase(sql, c)
		const { world } = c
		const db = new Db(sql)
		world.statuses.forEach((status, s) => {
			if (status.reblogOf !== null || status.visibility !== 'direct') {
				return
			}
			for (const x of new Set([status.author, ...status.mentions.map((m) => m.account)])) {
				if (world.accounts[x]?.local) {
					addToConversation(db, accountId(x), statusId(s))
				}
			}
		})
		const all = sql.exec<{ id: string }>('SELECT CAST(id AS TEXT) AS id FROM conversations ORDER BY id').toArray()
		const now = Date.parse(world.now)
		const problems: string[] = []
		world.accounts.forEach((account, viewer) => {
			if (!account.local || account.suspended) {
				return
			}
			const credential = { tokenHash: tokenOf(viewer, 'read'), scope: 'read', now } as const
			const listed = new Map(
				ok<Page<Conversation>>(
					listConversations.run(sql, { credential, page: { limit: 1000 }, present: PRESENT }),
					'conversations'
				).items.map((conversation) => [conversation.id, conversation])
			)
			for (const { id } of all) {
				const made = streamUnit.run(sql, {
					kind: 'conversation',
					subject: id,
					accountId: accountId(viewer),
					tokenHashes: [tokenOf(viewer, 'statuses')],
					now,
				})
				const expected = listed.get(id)
				const actual = made.event === 'conversation' ? made.payload : undefined
				if (JSON.stringify(actual) !== JSON.stringify(expected)) {
					problems.push(
						`conversation ${id} for ${account.name}: sent ${JSON.stringify(actual)}, listed ${JSON.stringify(expected)}`
					)
				}
				if (expected !== undefined) {
					shownConversations.add(expected.last_status === null ? 'hidden last status' : 'shown')
				}
			}
		})
		return problems
	}

	const shownConversations = new Set<string>()

	it("sends a conversation to its owner alone, as the owner's list presents it", async () => {
		await fc.assert(
			fc.asyncProperty(caseArb, async (c) => {
				const problems = await runInDurableObject(store, (_instance, state) => checkConversations(state.storage.sql, c))
				expect(problems).toEqual([])
			}),
			runs(CASES)
		)
		expect(shownConversations.has('shown')).toBe(true)
	}, 120_000)

	it('returns each of two conversations sharing a last status alone', async () => {
		const problems = await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			const world = fc.sample(worldArb, { numRuns: 1, seed: 7 })[0]!
			writeCase(sql, { world, filtered: [] })
			const owner = world.accounts.findIndex((account) => account.local && !account.suspended)
			sql.exec(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES ('290000000000000000', 'https://kopje.test/ap/o/shared', ?, 'direct', '<p>x</p>', ?)`,
				accountId(owner),
				world.now
			)
			const ids = ['a', 'b'].map(
				(participant) =>
					sql
						.exec<{ id: string }>(
							`INSERT INTO conversations (account_id, thread, participants, last_status_id, unread)
							VALUES (?, 'shared', ?, '290000000000000000', 1) RETURNING CAST(id AS TEXT) AS id`,
							accountId(owner),
							JSON.stringify([participant === 'a' ? accountId(owner) : '199999999999999999'])
						)
						.one().id
			)
			return ids.map(
				(id) =>
					(
						streamUnit.run(sql, {
							kind: 'conversation',
							subject: id,
							accountId: accountId(owner),
							tokenHashes: [tokenOf(owner, 'read')],
							now: Date.parse(world.now),
						}).payload as Conversation
					).id === id
			)
		})
		expect(problems).toEqual([true, true])
	})
})
