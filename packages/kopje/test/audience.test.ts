import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { block, community, domainBlock, mute, post, remoteAccount, remoteFollows, seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import {
	addresses,
	addressingOf,
	canView,
	interpretAddressing,
	listableSql,
	outboundKind,
	ownStatusId,
	PUBLIC_COLLECTION,
	recipientsFor,
	statusReads,
	viewableStatusId,
	type Visibility,
} from '../src/domain/audience'
import { presentOwnStatus, presentStatuses } from '../src/domain/status-presenter'
import type { StoreStub } from '../src/platform/store-client'

const FOLLOWERS = 'https://remote.example/users/author/followers'

describe('interpretAddressing (Mastodon StatusParser#visibility, ProcessStatus#process_audience)', () => {
	const known = new Map([
		['https://kopje.test/ap/users/alice', 'A'],
		['https://kopje.test/ap/users/bob', 'B'],
		['https://remote.example/users/carol', 'C'],
	])
	const base = { followersUri: FOLLOWERS, mentionUris: [], known }

	it('reads public, unlisted, private and direct from to and cc', () => {
		expect(interpretAddressing({ ...base, to: [PUBLIC_COLLECTION], cc: [FOLLOWERS] }).visibility).toBe('public')
		expect(interpretAddressing({ ...base, to: ['as:Public'], cc: [] }).visibility).toBe('public')
		expect(interpretAddressing({ ...base, to: [FOLLOWERS], cc: ['Public'] }).visibility).toBe('unlisted')
		expect(interpretAddressing({ ...base, to: [FOLLOWERS], cc: [] }).visibility).toBe('private')
		expect(
			interpretAddressing({
				...base,
				to: ['https://kopje.test/ap/users/alice'],
				cc: [],
				mentionUris: ['https://kopje.test/ap/users/alice'],
			})
		).toEqual({ visibility: 'direct', mentions: [{ accountId: 'A', silent: false }] })
	})

	it('reads Misskey specified (addressed but not mentioned) as limited with silent mentions', () => {
		expect(
			interpretAddressing({
				...base,
				to: ['https://kopje.test/ap/users/alice', 'https://kopje.test/ap/users/bob', 'https://unknown.example/u/x'],
				cc: [],
				mentionUris: ['https://kopje.test/ap/users/alice'],
			})
		).toEqual({
			visibility: 'limited',
			mentions: [
				{ accountId: 'A', silent: false },
				{ accountId: 'B', silent: true },
			],
		})
	})

	it('gives the owner of the personal inbox it arrived at a silent mention', () => {
		expect(interpretAddressing({ ...base, to: [FOLLOWERS], cc: [], deliveredTo: 'B' })).toEqual({
			visibility: 'private',
			mentions: [{ accountId: 'B', silent: true }],
		})
		// A direct status delivered to someone not addressed is limited: they may see it, but are not listed.
		expect(interpretAddressing({ ...base, to: [], cc: [], deliveredTo: 'B' }).visibility).toBe('limited')
	})
})

describe('addressingOf (Mastodon TagManager#to and #cc)', () => {
	const recipients = [
		{ accountId: 'C', uri: 'https://remote.example/users/carol', silent: false },
		{ accountId: 'D', uri: 'https://remote.example/users/dave', silent: true },
	]
	const carol = 'https://remote.example/users/carol'
	it.each<[Visibility, { to: string[]; cc: string[] }]>([
		['public', { to: [PUBLIC_COLLECTION], cc: [FOLLOWERS, carol] }],
		['unlisted', { to: [FOLLOWERS], cc: [PUBLIC_COLLECTION, carol] }],
		['private', { to: [FOLLOWERS], cc: [carol] }],
		['direct', { to: [carol], cc: [] }],
		['limited', { to: [carol], cc: [] }],
	])('%s never writes a silent recipient', (visibility, expected) => {
		expect(addressingOf(visibility, FOLLOWERS, recipients)).toEqual(expected)
	})
})

describe('the recipient rule (recipientsFor, addresses)', () => {
	it('classifies content, retractions and everything else', () => {
		const note = { id: 'https://kopje.test/ap/o/1', type: 'Note' }
		expect(outboundKind({ type: 'Create', object: note })).toBe('content')
		expect(outboundKind({ type: 'Update', object: note })).toBe('content')
		expect(outboundKind({ type: 'Announce', object: note.id })).toBe('content')
		expect(outboundKind({ type: 'Update', object: { type: 'Person' } })).toBe('other')
		expect(outboundKind({ type: 'Like', object: note.id })).toBe('other')
		expect(outboundKind({ type: 'Follow', object: note.id })).toBe('other')
		expect(outboundKind({ type: 'Reject', object: {} })).toBe('other')
		expect(outboundKind({ type: 'Reject', object: {} }, true)).toBe('retraction')
		expect(outboundKind({ type: 'Delete', object: note })).toBe('retraction')
		expect(outboundKind({ type: 'Undo', object: { type: 'Announce' } })).toBe('retraction')
	})

	it('delivers no content to an account being deleted, and still delivers its retractions', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const gone = await remoteAccount(h.store, 'gone', 'gone.example')
		await remoteFollows(h.store, gone, alice.id)
		await remoteFollows(h.store, await remoteAccount(h.store, 'fan', 'other.example'), alice.id)
		const first = await post(h, alice, { status: '@gone@gone.example hello' })
		// Its deletion starts (an inbound Delete of the actor), before the purge removes its follows and mentions.
		await sql(h.store, 'UPDATE accounts SET deleted_at = ? WHERE id = ?', new Date(NOW).toISOString(), gone)

		await post(h, alice, { status: 'a new post' })
		const edited = await h.request(
			`/api/v1/statuses/${first.id}`,
			bearer(alice.token, json({ status: '@gone@gone.example hello again' }, { method: 'PUT' }))
		)
		expect(edited.status).toBe(200)
		const targets = async () => {
			const rows = await sql<{ type: string; content: string | null; inbox_url: string }>(
				h.store,
				`SELECT json_extract(o.body, '$.activity.type') AS type, json_extract(o.body, '$.activity.object.content') AS content,
					d.inbox_url
				FROM outbound_activities o JOIN deliveries d ON d.activity_id = o.id ORDER BY o.id, d.inbox_url`
			)
			return rows.map((r) => [r.type, r.content, r.inbox_url])
		}
		// The first Create was recorded before the deletion started; the new post and the edit do not reach the account.
		const recorded = await targets()
		expect(recorded).toEqual(
			expect.arrayContaining([
				['Create', expect.stringContaining('hello</p>'), 'https://gone.example/inbox'],
				['Create', expect.stringContaining('a new post'), 'https://other.example/inbox'],
			])
		)
		expect(JSON.stringify(recorded.filter((t) => t[2] === 'https://gone.example/inbox'))).not.toContain('again')
		expect(recorded.filter((t) => t[1]?.includes('a new post') === true)).toHaveLength(1)
		expect(recorded.some((t) => t[1]?.includes('again') === true)).toBe(true)

		expect((await h.request(`/api/v1/statuses/${first.id}`, bearer(alice.token, { method: 'DELETE' }))).status).toBe(
			200
		)
		// The edit could no longer mention the account, so it is a silent recipient now: the Delete reaches it at its
		// personal inbox too, and at the shared inbox its Create went to.
		expect((await targets()).filter((t) => t[0] === 'Delete').map((t) => t[2])).toEqual([
			'https://gone.example/inbox',
			'https://gone.example/users/gone/inbox',
			'https://other.example/inbox',
		])
	})

	it('leaves unavailable and blocked accounts out of content only; a retraction names them all', async () => {
		const h = await community(['alice', 'carol'])
		const { alice, carol } = h.users
		const bob = await remoteAccount(h.store, 'bob')
		const far = await remoteAccount(h.store, 'far', 'blocked.example')
		const fan = await remoteAccount(h.store, 'fan', 'blocked.example')
		await remoteFollows(h.store, fan, alice.id)
		await block(h.store, alice.id, bob)
		await domainBlock(h.store, alice.id, 'blocked.example')
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			carol.id
		)
		const reached = await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const audience = { followers: true, accounts: [carol.id, bob, far] }
			const of = (type: string) => {
				const recipients = recipientsFor(db, alice.id, { type, object: 'https://kopje.test/ap/o/1' }, audience)
				return {
					followers: recipients.followerInboxes,
					accounts: recipients.accounts.map((a) => a.uri),
					named: [carol.id, bob, far].map((x) => addresses(db, outboundKind({ type }), alice.id, x)),
				}
			}
			return { content: of('Announce'), retraction: of('Delete'), other: of('Like') }
		})
		expect(reached.content).toEqual({ followers: [], accounts: [], named: [false, false, false] })
		const everyone = {
			followers: ['https://blocked.example/inbox'],
			accounts: ['https://remote.example/users/bob', 'https://blocked.example/users/far'],
			named: [true, true, true],
		}
		expect(reached.retraction).toEqual(everyone)
		expect(reached.other).toEqual(everyone)
	})
})

// The read rule against the real schema, viewer by viewer (Mastodon's spec/policies/status_policy_spec.rb #show?).
describe('canView and the list rule', () => {
	type Cast = Record<'author' | 'follower' | 'mentioned' | 'silent' | 'stranger' | 'blocked' | 'pending', string>

	async function cast(store: StoreStub): Promise<Cast> {
		const ids = {} as Cast
		for (const name of ['author', 'follower', 'mentioned', 'silent', 'stranger', 'blocked', 'pending'] as const) {
			ids[name] = await seedAccount(store, { username: name })
		}
		await remoteFollows(store, ids.follower, ids.author)
		await remoteFollows(store, ids.blocked, ids.author)
		await sql(
			store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'pending')",
			ids.pending,
			ids.author
		)
		await block(store, ids.author, ids.blocked)
		return ids
	}

	async function view(
		store: StoreStub,
		viewer: string | null,
		status: string
	): Promise<{ show: boolean; list: boolean }> {
		return runInDurableObject(store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const listed = db.first(
				`SELECT 1 AS yes FROM statuses s WHERE s.id = ?2 AND ${listableSql('s', '?1', '?3')}`,
				viewer,
				status,
				new Date(NOW).toISOString()
			)
			return { show: canView(db, viewer, status), list: listed !== undefined }
		})
	}

	const EVERYONE = ['author', 'follower', 'mentioned', 'silent', 'stranger', 'pending', 'anonymous'] as const
	const EXPECTED: Record<Visibility, readonly (typeof EVERYONE)[number][]> = {
		public: EVERYONE,
		unlisted: EVERYONE,
		private: ['author', 'follower', 'mentioned', 'silent'],
		direct: ['author', 'mentioned', 'silent'],
		limited: ['author', 'mentioned', 'silent'],
	}

	it.each(Object.entries(EXPECTED) as [Visibility, readonly string[]][])(
		'%s is seen by exactly the right viewers, and never by one the author blocks',
		async (visibility, allowed) => {
			const store = await migratedStore()
			const ids = await cast(store)
			const status = await seedStatus(store, {
				accountId: ids.author,
				visibility,
				mentions: [{ accountId: ids.mentioned }, { accountId: ids.silent, silent: true }, { accountId: ids.blocked }],
			})
			for (const viewer of [...EVERYONE, 'blocked'] as const) {
				const viewerId = viewer === 'anonymous' ? null : ids[viewer]
				const seen = await view(store, viewerId, status)
				expect({ viewer, ...seen }).toEqual({ viewer, show: allowed.includes(viewer), list: allowed.includes(viewer) })
			}
		}
	)

	it("hides a suspended author's statuses from everyone", async () => {
		const store = await migratedStore()
		const ids = await cast(store)
		const status = await seedStatus(store, { accountId: ids.author, visibility: 'public' })
		await sql(
			store,
			"UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
			ids.author
		)
		for (const viewer of [ids.author, ids.follower, null]) {
			expect(await view(store, viewer, status)).toEqual({ show: false, list: false })
		}
	})

	it('shows the blocked, muted or domain-blocked author by itself but keeps them out of lists (StatusFilter)', async () => {
		const store = await migratedStore()
		const viewer = await seedAccount(store, { username: 'viewer' })
		const blockedAuthor = await seedAccount(store, { username: 'b', domain: 'one.example' })
		const mutedAuthor = await seedAccount(store, { username: 'm', domain: 'two.example' })
		const domainBlocked = await seedAccount(store, { username: 'd', domain: 'three.example' })
		await block(store, viewer, blockedAuthor)
		await mute(store, viewer, mutedAuthor)
		await domainBlock(store, viewer, 'three.example')
		for (const author of [blockedAuthor, mutedAuthor, domainBlocked]) {
			const status = await seedStatus(store, { accountId: author, visibility: 'public' })
			expect(await view(store, viewer, status)).toEqual({ show: true, list: false })
			// A boost of it by someone else is filtered too.
			const booster = await seedAccount(store, { username: `boost${author.slice(-4)}`, domain: 'four.example' })
			const boost = await seedStatus(store, { accountId: booster, visibility: 'public', reblogOfId: status })
			expect(await view(store, viewer, boost)).toEqual({ show: true, list: false })
		}
	})

	it('needs the original of a boost to be visible as well', async () => {
		const store = await migratedStore()
		const ids = await cast(store)
		const original = await seedStatus(store, { accountId: ids.author, visibility: 'private' })
		const boost = await seedStatus(store, { accountId: ids.author, visibility: 'public', reblogOfId: original })
		expect(await view(store, ids.stranger, boost)).toEqual({ show: false, list: false })
		expect(await view(store, ids.follower, boost)).toEqual({ show: true, list: true })
	})
})

// The ids the presenter accepts (docs/visibility.md, "Status ids the presenter accepts").
describe('statusReads, the id brands and the presenter guard', () => {
	const NOW_ISO = new Date(NOW).toISOString()
	const PRESENT = { origin: 'https://kopje.test' }

	async function world() {
		const store = await migratedStore()
		const author = await seedAccount(store, { username: 'author' })
		const booster = await seedAccount(store, { username: 'booster' })
		const original = await seedStatus(store, { accountId: author, visibility: 'public' })
		const boost = await seedStatus(store, { accountId: booster, visibility: 'public', reblogOfId: original })
		return { store, author, booster, original, boost }
	}

	// The reader writes each SELECT's projection (s.id) and puts its rule over that same `statuses s` as a conjunct of the
	// SELECT's own WHERE; a caller supplies only the joins, its conditions and the tail.
	it('selects only ids its rule passed, whatever the caller writes around the rule', async () => {
		const { store, author, booster, boost } = await world()
		const hidden = await seedStatus(store, { accountId: author, visibility: 'private' })
		await runInDurableObject(store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const viewer = { accountId: booster, now: NOW_ISO }
			// `visible` takes no time; `listable` takes it at ?4.
			const read = statusReads(viewer, { viewer: '?1' })
			const timed = statusReads(viewer, { viewer: '?1', now: '?4' })
			const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort()
			const params = [booster, boost, hidden]
			const both = { where: 's.id IN (?2, ?3)' }
			expect(ids(read.select(db, 'visible', both, ...params))).toEqual([boost])
			expect(ids(timed.select(db, 'listable', both, ...params, NOW_ISO))).toEqual([boost])
			// A condition with OR stays inside its own parentheses.
			expect(ids(read.select(db, 'visible', { where: 's.id = ?3 OR 1' }, ...params))).not.toContain(hidden)
			// A subquery naming another `statuses s` cannot take the rule's place.
			expect(
				ids(read.select(db, 'visible', { where: 'EXISTS (SELECT 1 FROM statuses s WHERE s.id = ?3)' }, ...params))
			).not.toContain(hidden)
			// A WITH table is read by the conditions or joins only; the id is the joined status's, under the rule.
			const permitted = { with: 'WITH permitted (id) AS (SELECT ?3)', from: 'permitted p JOIN', join: 'ON s.id = p.id' }
			expect(read.select(db, 'visible', permitted, ...params)).toEqual([])
			// Every branch of a union is a ruled SELECT of the id alone (a branch takes no columns).
			const union = (branches: { where: string }[]) =>
				ids(read.union(db, 'visible', { all: true, branches, tail: 'ORDER BY id' }, ...params))
			expect(union([{ where: 's.id = ?2' }, { where: 's.id = ?3' }])).toEqual([boost])
			expect(
				read.union(
					db,
					'visible',
					// @ts-expect-error a union branch has no columns: the reader projects s.id in every branch
					{ all: true, branches: [{ where: 's.id IN (?2, ?3)', columns: { id: 's.reblog_of_id' } }], tail: '' },
					...params
				)
			).toEqual([{ id: boost }])
			// Another viewer or time in the rule's parameters.
			const bound = "a status query must bind the viewer's account id and time"
			expect(() => read.select(db, 'visible', both, null, boost, hidden)).toThrow(bound)
			expect(() => timed.select(db, 'listable', both, booster, boost, hidden, '2026-10-13T00:00:00.000Z')).toThrow(
				bound
			)
			// A reader without a time has no rule that needs one.
			expect(() => statusReads(null, { viewer: '?1' }).select(db, 'listable', both, null, boost, hidden)).toThrow(
				'this rule needs the time of the read'
			)
		})
	})

	it('keeps the id column its own and reads the real tables, whatever the caller names', async () => {
		const { store, author, booster, original, boost } = await world()
		const hidden = await seedStatus(store, { accountId: author, visibility: 'private' })
		await block(store, author, booster)
		await runInDurableObject(store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const viewer = { accountId: booster, now: NOW_ISO }
			const read = statusReads(viewer, { viewer: '?1' })
			const named = 'a status query cannot select a column named'
			expect(() =>
				// @ts-expect-error the id column is the reader's
				read.select(db, 'visible', { where: 's.id = ?2', columns: { id: 's.reblog_of_id' } }, booster, boost)
			).toThrow(`${named} id`)
			expect(() =>
				read.select(db, 'visible', { where: 's.id = ?2', columns: { '"id"': 's.reblog_of_id' } }, booster, boost)
			).toThrow(`${named} "id"`)
			expect(() =>
				statusReads(viewer, { viewer: '?1', now: '?2' }).notifications(
					db,
					// @ts-expect-error the status column is the reader's
					{ where: 'n.account_id = ?1', columns: { status_id: "'x'" } },
					booster,
					NOW_ISO
				)
			).toThrow(`${named} status_id`)
			// A WITH table named like a table the reader or the rule reads does not replace it.
			const ids = (rows: { id: string }[]) => rows.map((row) => row.id)
			const statuses = `WITH statuses (id, account_id, visibility, reblog_of_id) AS (
				SELECT ?3, account_id, visibility, reblog_of_id FROM main.statuses WHERE id = ?2)`
			expect(
				ids(read.select(db, 'visible', { with: statuses, where: 's.id IN (?2, ?3)' }, booster, boost, hidden))
			).toEqual([boost])
			const blocks = 'WITH blocks (account_id, target_account_id) AS (SELECT NULL, NULL)'
			expect(read.select(db, 'visible', { with: blocks, where: 's.id = ?2' }, booster, original)).toEqual([])
		})
	})

	it('shows a boost only with an original the viewer may see, and their own boost without it', async () => {
		const { store, author, booster, original, boost } = await world()
		await block(store, author, booster)
		await runInDurableObject(store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			// The boost row by itself passes the rule for its author; its original does not.
			const read = statusReads({ accountId: booster, now: NOW_ISO }, { viewer: '?1' })
			const rows = read.select(db, 'visible', { where: 's.id = ?2' }, booster, boost)
			expect(rows.map((row) => row.id)).toEqual([boost])
			const options = { ...PRESENT, viewerId: booster, now: NOW_ISO }
			expect(
				presentStatuses(
					db,
					rows.map((row) => row.id),
					options
				)
			).toEqual([])
			expect(viewableStatusId(db, booster, boost)).toBeNull()
			const own = ownStatusId(db, booster, boost)
			expect(own).toBe(boost)
			expect(presentOwnStatus(db, own!, options)).toMatchObject({ id: boost, reblog: null })
			// Not the viewer's own.
			expect(ownStatusId(db, booster, original)).toBeNull()
			// The original's author sees both.
			const visible = viewableStatusId(db, author, boost)
			expect(
				presentStatuses(db, visible === null ? [] : [visible], { ...PRESENT, viewerId: author, now: NOW_ISO })
			).toMatchObject([{ id: boost, reblog: { id: original } }])
		})
	})
})
