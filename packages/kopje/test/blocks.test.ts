import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, json, login, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import {
	act,
	community,
	follow,
	getJson,
	ids,
	outbound,
	post,
	remoteAccount,
	remoteFollows,
	seedStatus,
	type User,
} from './status-helpers'
import type { Relationship } from '../src/domain/accounts'
import { DOMAIN_BLOCK_BATCH } from '../src/domain/blocks'

// Blocks, mutes and domain blocks through the API (domain/blocks.ts, mastodon/blocks.ts): the endpoints, their scopes
// and errors, the relationships they end and the activities they send, and how they filter timelines, search and
// notifications (VIS-5, VIS-13, VIS-14, VIS-15 in docs/threat-model.md).

const ALICE_URI = 'https://kopje.test/ap/users/alice'

async function relationship(h: ApiHarness, user: User, id: string): Promise<Relationship> {
	const { status, body } = await getJson<Relationship[]>(h, `/api/v1/accounts/relationships?id[]=${id}`, user.token)
	expect(status).toBe(200)
	return body[0]!
}

async function relate(h: ApiHarness, user: User, path: string, body: Record<string, unknown> = {}) {
	const response = await act(h, user, path, body)
	expect(response.status).toBe(200)
	return response.json<Relationship>()
}

async function follows(h: ApiHarness): Promise<{ account_id: string; target_account_id: string; state: string }[]> {
	return sql(h.store, 'SELECT account_id, target_account_id, state FROM follows ORDER BY id')
}

// Each outbound activity with the inboxes it was expanded to.
async function sent(h: ApiHarness) {
	const deliveries = await sql<{ activity_id: number; inbox_url: string }>(
		h.store,
		'SELECT activity_id, inbox_url FROM deliveries ORDER BY id'
	)
	const rows = await sql<{ id: number; retracts: number; superseded: number }>(
		h.store,
		'SELECT id, retracts, superseded FROM outbound_activities ORDER BY id'
	)
	const bodies = await outbound(h.store)
	return rows.map((row, i) => ({
		...bodies[i]!,
		retracts: row.retracts,
		superseded: row.superseded,
		inboxes: deliveries.filter((d) => d.activity_id === row.id).map((d) => d.inbox_url),
	}))
}

describe('blocks', () => {
	it('blocks a local account: the follows end both ways and neither may follow again until unblocked', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, alice, bob.id)
		await follow(h, bob, alice.id)

		expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/block`)).toMatchObject({
			id: bob.id,
			following: false,
			followed_by: false,
			blocking: true,
			blocked_by: false,
		})
		expect(await relationship(h, bob, alice.id)).toMatchObject({ blocking: false, blocked_by: true })
		expect(await follows(h)).toEqual([])
		// The follow notifications go with the follows; counts are recomputed.
		expect(await sql(h.store, "SELECT 1 FROM notifications WHERE type = 'follow'")).toEqual([])
		expect(
			await sql(h.store, 'SELECT followers_count, following_count FROM accounts WHERE id IN (?, ?)', alice.id, bob.id)
		).toEqual([
			{ followers_count: 0, following_count: 0 },
			{ followers_count: 0, following_count: 0 },
		])
		expect((await act(h, alice, `/api/v1/accounts/${bob.id}/follow`)).status).toBe(403)
		expect((await act(h, bob, `/api/v1/accounts/${alice.id}/follow`)).status).toBe(403)
		// Blocking again changes nothing; a local block federates nothing.
		expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/block`)).toMatchObject({ blocking: true })
		expect(await sql(h.store, 'SELECT uri FROM blocks')).toEqual([{ uri: null }])
		expect(await outbound(h.store)).toEqual([])

		expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/unblock`)).toMatchObject({ blocking: false })
		expect(await relationship(h, bob, alice.id)).toMatchObject({ blocked_by: false })
		expect((await act(h, bob, `/api/v1/accounts/${alice.id}/follow`)).status).toBe(200)
	})

	it('sends a remote account Undo Follow, Reject and Block, and Undo Block on unblock', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const carol = await remoteAccount(h.store, 'carol')
		const carolUri = 'https://remote.example/users/carol'
		await follow(h, alice, carol)
		const carolFollow = 'https://remote.example/users/carol#follows/9'
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'accepted', ?)",
			carol,
			alice.id,
			carolFollow
		)
		const [ours] = await sql<{ id: number; uri: string }>(
			h.store,
			'SELECT id, uri FROM follows WHERE account_id = ?',
			alice.id
		)

		expect(await relate(h, alice, `/api/v1/accounts/${carol}/block`)).toMatchObject({
			blocking: true,
			following: false,
			requested: false,
			followed_by: false,
		})
		const [edge] = await sql<{ id: number; uri: string }>(h.store, 'SELECT id, uri FROM blocks')
		const blockId = `${ALICE_URI}#blocks/${edge!.id}`
		expect(edge!.uri).toBe(blockId)
		const [, undoFollow, reject, blockActivity] = await sent(h)
		const shared = ['https://remote.example/inbox']
		expect(undoFollow).toMatchObject({
			signer: alice.id,
			activity: {
				type: 'Undo',
				actor: ALICE_URI,
				object: { id: ours!.uri, type: 'Follow', actor: ALICE_URI, object: carolUri },
			},
			audience: { followers: false, accounts: [carol] },
			inboxes: shared,
		})
		// The Reject ends a follow we had accepted, so it withdraws it.
		expect(reject).toMatchObject({
			activity: {
				type: 'Reject',
				actor: ALICE_URI,
				object: { id: carolFollow, type: 'Follow', actor: carolUri, object: ALICE_URI },
			},
			retracts: 1,
			inboxes: shared,
		})
		expect(blockActivity).toMatchObject({
			activity: { id: blockId, type: 'Block', actor: ALICE_URI, object: carolUri },
			audience: { followers: false, accounts: [carol] },
			retracts: 0,
			inboxes: shared,
		})
		// The ended Follow is recorded as retracted, so a replay of it does not come back (ID-7).
		expect(await sql(h.store, 'SELECT actor_uri, target_uri FROM inbound_retractions')).toEqual([
			{ actor_uri: carolUri, target_uri: carolFollow },
		])

		expect(await relate(h, alice, `/api/v1/accounts/${carol}/unblock`)).toMatchObject({ blocking: false })
		const all = await sent(h)
		expect(all.at(-1)).toMatchObject({
			activity: {
				id: `${blockId}/undo`,
				type: 'Undo',
				actor: ALICE_URI,
				object: { id: blockId, type: 'Block', actor: ALICE_URI, object: carolUri },
			},
			retracts: 1,
			inboxes: shared,
		})
		// The Undo supersedes the Block it retracts.
		expect(all.find((o) => o.activity.type === 'Block')).toMatchObject({ superseded: 1 })
		expect(await sql(h.store, 'SELECT 1 FROM blocks')).toEqual([])
	})

	it('answers a pending remote request with a Reject that withdraws nothing', async () => {
		const h = await community(['alice'])
		const carol = await remoteAccount(h.store, 'carol')
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state, uri) VALUES (?, ?, 'pending', ?)",
			carol,
			h.users.alice.id,
			'https://remote.example/users/carol#follows/1'
		)
		await relate(h, h.users.alice, `/api/v1/accounts/${carol}/block`)
		expect((await sent(h)).map((o) => [o.activity.type, o.retracts])).toEqual([
			['Reject', 0],
			['Block', 0],
		])
		expect(await follows(h)).toEqual([])
	})

	it('answers 404 for an unknown account and 403 for oneself, and needs write:blocks or follow', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		expect((await act(h, alice, '/api/v1/accounts/999999999999999999/block')).status).toBe(404)
		expect((await act(h, alice, `/api/v1/accounts/${alice.id}/block`)).status).toBe(403)
		expect((await act(h, alice, `/api/v1/accounts/${alice.id}/mute`)).status).toBe(403)
		expect((await h.request(`/api/v1/accounts/${bob.id}/block`, { method: 'POST' })).status).toBe(401)
		const { token: readOnly } = await login(h, { email: 'alice@example.com', scope: 'read' })
		const { token: legacy } = await login(h, { email: 'alice@example.com', scope: 'follow' })
		const { token: blocksOnly } = await login(h, { email: 'alice@example.com', scope: 'write:blocks read:blocks' })
		const statusOf = async (path: string, token: string, method = 'POST') =>
			(await h.request(path, bearer(token, { method }))).status
		expect(await statusOf(`/api/v1/accounts/${bob.id}/block`, readOnly)).toBe(403)
		expect(await statusOf(`/api/v1/accounts/${bob.id}/mute`, blocksOnly)).toBe(403)
		expect(await statusOf(`/api/v1/accounts/${bob.id}/block`, blocksOnly)).toBe(200)
		expect(await statusOf(`/api/v1/accounts/${bob.id}/mute`, legacy)).toBe(200)
		expect(await statusOf('/api/v1/blocks', blocksOnly, 'GET')).toBe(200)
		expect(await statusOf('/api/v1/mutes', blocksOnly, 'GET')).toBe(403)
		expect(await statusOf('/api/v1/mutes', legacy, 'GET')).toBe(200)
		expect(await statusOf('/api/v1/domain_blocks', readOnly, 'GET')).toBe(200)
		expect(await statusOf('/api/v1/domain_blocks', readOnly)).toBe(403)
	})

	it('lists blocked accounts newest first, paged by Link headers', async () => {
		const h = await community(['alice'])
		const targets = [
			await remoteAccount(h.store, 'one'),
			await remoteAccount(h.store, 'two'),
			await remoteAccount(h.store, 'three'),
		]
		for (const target of targets) {
			await relate(h, h.users.alice, `/api/v1/accounts/${target}/block`)
		}
		const first = await h.request('/api/v1/blocks?limit=2', bearer(h.users.alice.token))
		expect((await first.json<{ id: string }[]>()).map((a) => a.id)).toEqual([targets[2], targets[1]])
		const link = first.headers.get('link') ?? ''
		const next = /<([^>]+)>; rel="next"/.exec(link)?.[1]
		expect(next).toMatch(/max_id=\d+/)
		expect(link).toMatch(/min_id=\d+>; rel="prev"/)
		expect(await ids(h, next!.replace('https://kopje.test', ''), h.users.alice.token)).toEqual([targets[0]])
	})

	it('applies an inbound Block and its Undo: blocked_by, both follows ended, ours undone there', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const carol = await remoteAccount(h.store, 'carol')
		const carolUri = 'https://remote.example/users/carol'
		await follow(h, alice, carol)
		await remoteFollows(h.store, carol, alice.id)
		const receive = (activity: Parameters<typeof h.store.receiveActivity>[1]['activity']) =>
			h.store.receiveActivity(BUILD, {
				now: NOW,
				origin: 'https://kopje.test',
				actorUri: carolUri,
				actor: null,
				activity,
			})
		const blockId = `${carolUri}#blocks/1`

		expect(await receive({ type: 'Block', id: blockId, object: ALICE_URI })).toMatchObject({ applied: true })
		expect(await relationship(h, alice, carol)).toMatchObject({
			blocked_by: true,
			blocking: false,
			following: false,
			requested: false,
			followed_by: false,
		})
		expect(await follows(h)).toEqual([])
		expect((await outbound(h.store)).map((o) => o.activity.type)).toEqual(['Follow', 'Undo'])
		expect((await act(h, alice, `/api/v1/accounts/${carol}/follow`)).status).toBe(403)

		const undo = { id: `${blockId}/undo`, object: { id: blockId, type: 'Block', actor: carolUri, object: ALICE_URI } }
		expect(await receive({ type: 'Undo', ...undo })).toMatchObject({ applied: true })
		expect(await relationship(h, alice, carol)).toMatchObject({ blocked_by: false })
	})
})

describe('mutes', () => {
	it('mutes with notifications by default, takes notifications and duration, lists and unmutes', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`)).toMatchObject({
			muting: true,
			muting_notifications: true,
			muting_expires_at: null,
		})
		const expires = new Date(NOW + 3600_000).toISOString()
		expect(
			await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`, { notifications: false, duration: 3600 })
		).toMatchObject({ muting: true, muting_notifications: false, muting_expires_at: expires })
		expect(await sql(h.store, 'SELECT hide_notifications, expires_at FROM mutes')).toEqual([
			{ hide_notifications: 0, expires_at: expires },
		])
		// A mute is local only, and the muted account sees nothing of it.
		expect(await outbound(h.store)).toEqual([])
		expect(await relationship(h, bob, alice.id)).toMatchObject({ blocked_by: false, muting: false })
		const { body } = await getJson<{ id: string; mute_expires_at: string | null }[]>(h, '/api/v1/mutes', alice.token)
		expect(body.map((a) => [a.id, a.mute_expires_at])).toEqual([[bob.id, expires]])

		expect(await relate(h, alice, `/api/v1/accounts/${bob.id}/unmute`)).toMatchObject({
			muting: false,
			muting_notifications: false,
			muting_expires_at: null,
		})
		expect(await ids(h, '/api/v1/mutes', alice.token)).toEqual([])
	})

	it('reads duration as Mastodon does: 0 or no number is indefinite, a negative one has already expired', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const path = `/api/v1/accounts/${bob.id}/mute`
		expect(await relate(h, alice, path, { duration: 'soon' })).toMatchObject({ muting: true, muting_expires_at: null })
		expect(await relate(h, alice, path, { duration: 0 })).toMatchObject({ muting: true, muting_expires_at: null })
		expect(await relate(h, alice, path, { duration: -5 })).toMatchObject({ muting: false })
		expect(await relate(h, alice, path, { duration: '1e400' })).toMatchObject({ muting: true })
		expect(await relate(h, alice, path, { duration: '99999999999999999999' })).toMatchObject({
			muting: true,
			muting_expires_at: '9999-12-31T23:59:59.999Z',
		})
	})

	it('hides the muted account from timelines and search; notifications only when it mutes them', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, alice, bob.id)
		const status = await post(h, bob, { status: '@alice hello #topic' })
		const everywhere = async () => ({
			home: await ids(h, '/api/v1/timelines/home', alice.token),
			public: await ids(h, '/api/v1/timelines/public', alice.token),
			tag: await ids(h, '/api/v1/timelines/tag/topic', alice.token),
			search: (
				await getJson<{ statuses: { id: string }[] }>(h, '/api/v2/search?q=hello', alice.token)
			).body.statuses.map((s) => s.id),
			notifications: (await getJson<{ type: string }[]>(h, '/api/v1/notifications', alice.token)).body.map(
				(n) => n.type
			),
		})
		expect(await everywhere()).toEqual({
			home: [status.id],
			public: [status.id],
			tag: [status.id],
			search: [status.id],
			notifications: ['mention'],
		})

		await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`, { notifications: false })
		expect(await everywhere()).toEqual({ home: [], public: [], tag: [], search: [], notifications: ['mention'] })
		await post(h, bob, { status: '@alice still here' })
		expect((await everywhere()).notifications).toEqual(['mention', 'mention'])

		await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`)
		expect((await everywhere()).notifications).toEqual([])
		// None is written while the mute hides them.
		await post(h, bob, { status: '@alice again' })
		expect(await sql(h.store, "SELECT count(*) AS n FROM notifications WHERE type = 'mention'")).toEqual([{ n: 2 }])
		// The account's own profile still lists its statuses, as in Mastodon.
		expect(await ids(h, `/api/v1/accounts/${bob.id}/statuses`, alice.token)).toHaveLength(3)
	})

	it('stops applying an expired mute at its time, before any sweep removes it', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, alice, bob.id)
		const status = await post(h, bob, { status: '@alice hi' })
		await relate(h, alice, `/api/v1/accounts/${bob.id}/mute`, { duration: 60 })
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).toEqual([])
		expect(await ids(h, '/api/v1/notifications', alice.token)).toEqual([])

		h.now.mockReturnValue(NOW + 30_000)
		await post(h, bob, { status: '@alice during the mute' })
		h.now.mockReturnValue(NOW + 60_000)
		expect(await relationship(h, alice, bob.id)).toMatchObject({ muting: false, muting_expires_at: null })
		expect(await ids(h, '/api/v1/mutes', alice.token)).toEqual([])
		const home = await ids(h, '/api/v1/timelines/home', alice.token)
		expect(home).toHaveLength(2)
		expect(home).toContain(status.id)
		// The notification written before the mute shows again; none was written during it.
		expect(await ids(h, '/api/v1/notifications', alice.token)).toHaveLength(1)
		await post(h, bob, { status: '@alice after' })
		expect(await ids(h, '/api/v1/notifications', alice.token)).toHaveLength(2)
		expect(await sql(h.store, 'SELECT 1 FROM mutes')).toHaveLength(1)

		// The inbound sweep removes it later; a mute still running stays.
		const other = await remoteAccount(h.store, 'other')
		await relate(h, alice, `/api/v1/accounts/${other}/mute`, { duration: 3600 })
		await h.store.runInboundJobs(BUILD, { now: NOW + 60_000 })
		expect(await sql(h.store, 'SELECT target_account_id FROM mutes')).toEqual([{ target_account_id: other }])
	})
})

describe('mentions of blocked and muted accounts', () => {
	it('leaves a status that mentions or replies to them out of home and mention notifications', async () => {
		const h = await community(['alice', 'friend', 'foe'])
		const { alice, friend, foe } = h.users
		await follow(h, alice, friend.id)
		const plain = await post(h, friend, { status: 'nothing to see' })
		const aboutFoe = await post(h, friend, { status: '@foe hello' })
		const both = await post(h, friend, { status: '@alice @foe hey' })
		const parent = await post(h, foe, { status: 'foe speaks' })
		const reply = await post(h, friend, { status: '@alice look', in_reply_to_id: parent.id })
		expect(await ids(h, '/api/v1/notifications', alice.token)).toHaveLength(2)

		await relate(h, alice, `/api/v1/accounts/${foe.id}/block`)
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).toEqual([plain.id])
		expect(await ids(h, '/api/v1/notifications', alice.token)).toEqual([])

		// A mute filters home too; mention notifications only while it mutes notifications.
		await relate(h, alice, `/api/v1/accounts/${foe.id}/unblock`)
		await relate(h, alice, `/api/v1/accounts/${foe.id}/mute`, { notifications: false })
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).toEqual([plain.id])
		const shown = await getJson<{ status: { id: string } }[]>(h, '/api/v1/notifications', alice.token)
		expect(shown.body.map((n) => n.status.id)).toEqual([reply.id, both.id])
		await relate(h, alice, `/api/v1/accounts/${foe.id}/mute`)
		expect(await ids(h, '/api/v1/notifications', alice.token)).toEqual([])

		await relate(h, alice, `/api/v1/accounts/${foe.id}/unmute`)
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).toEqual([both.id, aboutFoe.id, plain.id])
	})
})

describe('domain blocks', () => {
	async function blockDomain(h: ApiHarness, user: User, domain: string) {
		return h.request('/api/v1/domain_blocks', bearer(user.token, json({ domain })))
	}

	it('normalizes the domain, refuses the local domain and invalid names, lists and unblocks', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const created = await blockDomain(h, alice, 'Example.COM.')
		expect(created.status).toBe(200)
		expect(await created.json()).toEqual({})
		expect((await blockDomain(h, alice, 'example.com/')).status).toBe(200)
		expect((await blockDomain(h, alice, 'bücher.example')).status).toBe(200)
		for (const [domain, error] of [
			['kopje.test', "Validation failed: Domain is this server's own domain"],
			['', "Validation failed: Domain can't be blank"],
			['not a domain', 'Validation failed: Domain is invalid'],
			['https://other.example', 'Validation failed: Domain is invalid'],
		] as const) {
			const refused = await blockDomain(h, alice, domain)
			expect({ domain, status: refused.status, body: await refused.json() }).toEqual({
				domain,
				status: 422,
				body: { error },
			})
		}
		expect((await getJson(h, '/api/v1/domain_blocks', alice.token)).body).toEqual([
			'xn--bcher-kva.example',
			'example.com',
		])
		const page = await h.request('/api/v1/domain_blocks?limit=1', bearer(alice.token))
		expect(await page.json()).toEqual(['xn--bcher-kva.example'])
		expect(page.headers.get('link')).toMatch(/max_id=\d+>; rel="next"/)

		const removed = await h.request(
			'/api/v1/domain_blocks',
			bearer(alice.token, json({ domain: 'EXAMPLE.com' }, { method: 'DELETE' }))
		)
		expect(await removed.json()).toEqual({})
		const again = await h.request(
			'/api/v1/domain_blocks?domain=nothing.example',
			bearer(alice.token, { method: 'DELETE' })
		)
		expect(again.status).toBe(200)
		expect((await getJson(h, '/api/v1/domain_blocks', alice.token)).body).toEqual(['xn--bcher-kva.example'])
	})

	it('removes followers there with a Reject, keeps our follows, and hides the domain', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan', 'blocked.example')
		const asker = await remoteAccount(h.store, 'asker', 'blocked.example')
		const star = await remoteAccount(h.store, 'star', 'blocked.example')
		const other = await remoteAccount(h.store, 'other', 'other.example')
		await sql(
			h.store,
			`INSERT INTO follows (account_id, target_account_id, state, uri) VALUES
				(?1, ?4, 'accepted', 'https://blocked.example/f/1'), (?2, ?4, 'pending', 'https://blocked.example/f/2'),
				(?3, ?4, 'accepted', 'https://other.example/f/3'), (?4, ?5, 'accepted', NULL)`,
			fan,
			asker,
			other,
			alice.id,
			star
		)
		const starStatus = await seedStatus(h.store, { accountId: star, visibility: 'public', content: '<p>star</p>' })
		expect((await getJson(h, '/api/v1/domain_blocks/preview?domain=Blocked.Example', alice.token)).body).toEqual({
			following_count: 1,
			followers_count: 1,
		})
		expect((await h.request('/api/v1/domain_blocks/preview', bearer(alice.token))).status).toBe(400)
		await sql(h.store, 'DELETE FROM outbound_activities')

		expect((await blockDomain(h, alice, 'blocked.example')).status).toBe(200)
		expect(await follows(h)).toEqual([
			{ account_id: other, target_account_id: alice.id, state: 'accepted' },
			{ account_id: alice.id, target_account_id: star, state: 'accepted' },
		])
		expect((await sent(h)).map((o) => [o.activity.type, (o.activity.object as { id: string }).id, o.retracts])).toEqual(
			[
				['Reject', 'https://blocked.example/f/1', 1],
				['Reject', 'https://blocked.example/f/2', 0],
			]
		)
		expect(await sql(h.store, 'SELECT followers_count FROM accounts WHERE id = ?', alice.id)).toEqual([
			{ followers_count: 1 },
		])
		expect(await relationship(h, alice, star)).toMatchObject({ domain_blocking: true, following: true })
		expect(await relationship(h, alice, other)).toMatchObject({ domain_blocking: false })
		expect(await ids(h, '/api/v1/timelines/public', alice.token)).not.toContain(starStatus)
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).not.toContain(starStatus)
		// Following an account of the domain is refused (FollowService).
		expect((await act(h, alice, `/api/v1/accounts/${fan}/follow`)).status).toBe(403)
	})

	it(`removes at most ${DOMAIN_BLOCK_BATCH} followers a call; the rest get no deliveries and go with the next call`, async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
			SELECT printf('%018d', 300000000000000000 + i), 'https://spam.example/users/u' || i, 'u' || i, 'spam.example',
				'https://spam.example/users/u' || i || '/inbox', 'https://spam.example/inbox' FROM n`,
			alice.id,
			DOMAIN_BLOCK_BATCH + 1
		)
		await sql(
			h.store,
			`INSERT INTO follows (account_id, target_account_id, state)
			SELECT id, ?, 'accepted' FROM accounts WHERE domain = 'spam.example'`,
			alice.id
		)
		const fromSpam =
			"SELECT count(*) AS n FROM follows f JOIN accounts a ON a.id = f.account_id WHERE a.domain = 'spam.example'"

		expect((await blockDomain(h, alice, 'spam.example')).status).toBe(200)
		expect(await sql(h.store, fromSpam)).toEqual([{ n: 1 }])
		await post(h, alice, { status: 'not for spam' })
		const creates = await sql(
			h.store,
			`SELECT d.inbox_url FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
			WHERE json_extract(o.body, '$.activity.type') = 'Create'`
		)
		expect(creates).toEqual([])

		expect((await blockDomain(h, alice, 'spam.example')).status).toBe(200)
		expect(await sql(h.store, fromSpam)).toEqual([{ n: 0 }])
	})
})
