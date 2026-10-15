import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import {
	act,
	community,
	follow,
	getJson,
	ids,
	mute,
	outbound,
	post,
	remoteAccount,
	remoteFollows,
	seedStatus,
	type Status,
} from './status-helpers'
import type { DeliveryOutcome } from '../src/domain/deliveries'
import { PIN_ERRORS } from '../src/domain/status-actions'
import { MAX_STATUSES_BY_ID } from '../src/domain/statuses'

// The remaining status actions of Mastodon 4.5: pins (Api::V1::Statuses::PinsController) with the actor's featured
// collection and its Add and Remove, conversation mutes (Statuses::MutesController) and their effect on notifications
// (NotifyService#conversation_muted?), several statuses by id (StatusesController#index) and PATCH as an edit.

const AP = { headers: { accept: 'application/activity+json' } }

type Notification = { id: string; type: string; account: { id: string }; status?: Status }

async function statusOf(h: Awaited<ReturnType<typeof community>>, id: string, token?: string) {
	return getJson<Status & { error?: string }>(h, `/api/v1/statuses/${id}`, token)
}

describe('pins', () => {
	it('pins and unpins an own status, which says so and is listed with pinned=true', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const first = await post(h, alice, { status: 'first' })
		const second = await post(h, alice, { status: 'second' })
		expect((await statusOf(h, first.id, alice.token)).body.pinned).toBe(false)

		const pinned = await act(h, alice, `/api/v1/statuses/${second.id}/pin`)
		expect(pinned.status).toBe(200)
		expect(await pinned.json()).toMatchObject({ id: second.id, pinned: true })
		await act(h, alice, `/api/v1/statuses/${first.id}/pin`)
		// The test clock stands still: the later pin is made later.
		await sql(h.store, "UPDATE status_pins SET created_at = '2026-10-12T00:00:01.000Z' WHERE status_id = ?", first.id)
		expect((await statusOf(h, first.id, alice.token)).body.pinned).toBe(true)
		// Newest pin first, as Account#pinned_statuses orders them; the other filters still apply.
		expect(await ids(h, `/api/v1/accounts/${alice.id}/statuses?pinned=true`, alice.token)).toEqual([
			first.id,
			second.id,
		])
		expect(await ids(h, `/api/v1/accounts/${alice.id}/statuses?pinned=true&min_id=0`, alice.token)).toEqual([
			second.id,
			first.id,
		])
		expect(await ids(h, `/api/v1/accounts/${alice.id}/statuses?pinned=1&exclude_replies=1`)).toEqual([
			first.id,
			second.id,
		])
		expect(await ids(h, `/api/v1/accounts/${alice.id}/statuses?pinned=true&only_media=true`)).toEqual([])

		const unpinned = await act(h, alice, `/api/v1/statuses/${first.id}/unpin`)
		expect(unpinned.status).toBe(200)
		expect(await unpinned.json()).toMatchObject({ id: first.id, pinned: false })
		expect(await ids(h, `/api/v1/accounts/${alice.id}/statuses?pinned=true`)).toEqual([second.id])
		// Unpinning what is not pinned changes nothing.
		expect((await act(h, alice, `/api/v1/statuses/${first.id}/unpin`)).status).toBe(200)
		expect(await ids(h, `/api/v1/accounts/${alice.id}/statuses?pinned=true`)).toEqual([second.id])
	})

	it("refuses with StatusPinValidator's messages, and a repeat as a duplicate", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const pin = async (id: string, user = alice) => {
			const response = await act(h, user, `/api/v1/statuses/${id}/pin`)
			return { status: response.status, body: (await response.json()) as { error?: string } }
		}
		const refused = (...messages: string[]) => ({
			status: 422,
			body: { error: `Validation failed: ${messages.join(', ')}` },
		})
		const others = await post(h, bob, { status: 'bob' })
		const boost = await (await act(h, alice, `/api/v1/statuses/${others.id}/reblog`)).json<Status>()
		const direct = await post(h, alice, { status: '@bob psst', visibility: 'direct' })
		const limited = await post(h, alice, { status: '@bob later', visibility: 'direct' })
		await sql(h.store, "UPDATE statuses SET visibility = 'limited' WHERE id = ?", limited.id)
		expect(await pin(others.id)).toEqual(refused(PIN_ERRORS.ownership))
		expect(await pin(boost.id)).toEqual(refused(PIN_ERRORS.reblog))
		expect(await pin(direct.id)).toEqual(refused(PIN_ERRORS.direct))
		// A limited status, shown as private, is a direct one with silent recipients.
		expect(await pin(limited.id)).toEqual(refused(PIN_ERRORS.direct))
		// Bob's boost of Alice's direct status cannot exist; his boost of her public one is both a boost and his.
		const mine = await post(h, alice, { status: 'mine' })
		const bobsBoost = await (await act(h, bob, `/api/v1/statuses/${mine.id}/reblog`)).json<Status>()
		expect(await pin(bobsBoost.id)).toEqual(refused(PIN_ERRORS.reblog, PIN_ERRORS.ownership))

		const kept: string[] = []
		for (let i = 0; i < 5; i++) {
			const status = await post(h, alice, { status: `pin ${i}`, visibility: i === 4 ? 'private' : 'public' })
			expect((await pin(status.id)).status).toBe(200)
			kept.push(status.id)
		}
		expect(await pin(mine.id)).toEqual(refused(PIN_ERRORS.limit))
		// At the limit, a repeat is refused for the limit; below it, as a duplicate.
		expect(await pin(kept[0]!)).toEqual(refused(PIN_ERRORS.limit))
		await act(h, alice, `/api/v1/statuses/${kept[1]}/unpin`)
		expect(await pin(kept[0]!)).toEqual({ status: 422, body: { error: 'Duplicate record' } })
		expect(await sql(h.store, 'SELECT count(*) AS n FROM status_pins')).toEqual([{ n: 4 }])
		// A status the viewer may not see is not found.
		const hidden = await post(h, bob, { status: 'followers only', visibility: 'private' })
		expect((await pin(hidden.id)).status).toBe(404)
		expect((await act(h, alice, `/api/v1/statuses/${hidden.id}/unpin`)).status).toBe(404)
		expect((await pin('999999999999999999')).status).toBe(404)
	})

	it('lists pins to whoever may see each, and shows pinned only on the viewer’s own pinnable statuses', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await follow(h, bob, alice.id)
		const open = await post(h, alice, { status: 'open' })
		const closed = await post(h, alice, { status: 'followers', visibility: 'private' })
		for (const status of [open, closed]) {
			await act(h, alice, `/api/v1/statuses/${status.id}/pin`)
		}
		const pins = (token?: string) => ids(h, `/api/v1/accounts/${alice.id}/statuses?pinned=true`, token)
		expect(await pins(bob.token)).toEqual([closed.id, open.id])
		expect(await pins(carol.token)).toEqual([open.id])
		expect(await pins()).toEqual([open.id])
		// Nobody else is told whether a status is pinned; the author is, on a pinnable status only.
		expect((await statusOf(h, open.id, bob.token)).body).not.toHaveProperty('pinned')
		const direct = await post(h, alice, { status: '@bob hi', visibility: 'direct' })
		expect((await statusOf(h, direct.id, alice.token)).body).not.toHaveProperty('pinned')
		const boost = await (await act(h, alice, `/api/v1/statuses/${open.id}/reblog`)).json<Status>()
		expect(boost).not.toHaveProperty('pinned')
		expect(boost.reblog).toMatchObject({ pinned: true })
		// A block hides them all from the blocked.
		await sql(h.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', alice.id, carol.id)
		expect(await pins(carol.token)).toEqual([])
	})

	it('tells the followers in an Add and a Remove, and serves the featured collection', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, alice.id)
		const open = await post(h, alice, { status: 'open #kopje' })
		const closed = await post(h, alice, { status: 'followers', visibility: 'private' })
		await act(h, alice, `/api/v1/statuses/${open.id}/pin`)
		await act(h, alice, `/api/v1/statuses/${closed.id}/pin`)
		await act(h, alice, `/api/v1/statuses/${open.id}/unpin`)
		await act(h, alice, `/api/v1/statuses/${open.id}/pin`)
		const actor = 'https://kopje.test/ap/users/alice'
		const featured = `${actor}/collections/featured`
		const sent = (await outbound(h.store)).filter((o) => o.activity.type === 'Add' || o.activity.type === 'Remove')
		expect(sent.map((o) => [o.activity.type, o.activity.object])).toEqual([
			['Add', open.uri],
			['Add', closed.uri],
			['Remove', open.uri],
			['Add', open.uri],
		])
		for (const o of sent) {
			expect(o).toMatchObject({
				signer: alice.id,
				activity: {
					actor,
					target: featured,
					id: expect.stringMatching(/^https:\/\/kopje\.test\/ap\/users\/alice#featured\/\d+$/),
				},
				audience: { followers: true, accounts: [] },
			})
		}
		// Each goes to the follower's shared inbox.
		const targets = await sql<{ type: string; inbox: string }>(
			h.store,
			`SELECT json_extract(o.body, '$.activity.type') AS type, d.inbox_url AS inbox
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
			WHERE json_extract(o.body, '$.activity.type') IN ('Add', 'Remove') ORDER BY d.id`
		)
		expect(targets).toEqual(
			['Add', 'Add', 'Remove', 'Add'].map((type) => ({ type, inbox: 'https://fans.example/inbox' }))
		)

		// The test clock stands still: the last pin is made later.
		await sql(h.store, "UPDATE status_pins SET created_at = '2026-10-12T00:00:01.000Z' WHERE status_id = ?", open.id)
		const response = await h.request('/ap/users/alice/collections/featured', AP)
		expect(response.status).toBe(200)
		const collection = (await response.json()) as {
			id: string
			type: string
			totalItems: number
			orderedItems: unknown[]
		}
		// Newest pin first: a public status as its Note, any other by its uri.
		expect(collection).toMatchObject({ id: featured, type: 'OrderedCollection', totalItems: 2 })
		expect(collection.orderedItems).toHaveLength(2)
		expect(collection.orderedItems[0]).toMatchObject({ id: open.uri, type: 'Note', attributedTo: actor })
		expect(collection.orderedItems[1]).toBe(closed.uri)
		expect(JSON.stringify(collection)).not.toContain('followers</p>')
		expect((await h.request('/ap/users/Alice/collections/featured', AP)).status).toBe(404)
		expect((await h.request('/ap/users/nobody/collections/featured', AP)).status).toBe(404)
		await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-10-12T00:00:00Z' WHERE account_id = ?", alice.id)
		expect((await h.request('/ap/users/alice/collections/featured', AP)).status).toBe(404)
	})

	it('never resends an Add or a Remove that a later Remove or Add of the same pin follows', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, alice.id)
		const status = await post(h, alice, { status: 'pin me' })
		let at = NOW
		// Delivers every due row of the pins, the first with `first` and the rest as sent.
		const deliver = async (first: DeliveryOutcome) => {
			at += 1000
			const { deliveries } = await h.store.claimDeliveries(BUILD, { now: at, leaseToken: `t${at}` })
			for (const d of deliveries) {
				await h.store.completeDelivery(BUILD, { id: d.id, leaseToken: `t${at}`, now: at, outcome: first })
			}
		}
		const states = () =>
			sql<{ type: string; id: string; state: string }>(
				h.store,
				`SELECT json_extract(o.body, '$.activity.type') AS type, json_extract(o.body, '$.activity.id') AS id, d.state
				FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
				WHERE json_extract(o.body, '$.activity.type') IN ('Add', 'Remove') ORDER BY d.id`
			)
		const GONE: DeliveryOutcome = { kind: 'failed', status: 410, error: 'HTTP 410', permanent: true }
		const OK: DeliveryOutcome = { kind: 'delivered', status: 202 }
		await deliver(OK)
		// An Add that gave up, then a Remove that arrived: retrying everything sends no Add.
		await act(h, alice, `/api/v1/statuses/${status.id}/pin`)
		await deliver(GONE)
		await act(h, alice, `/api/v1/statuses/${status.id}/unpin`)
		await deliver(OK)
		expect(await h.store.retryDeliveries(BUILD, { ids: 'all', now: at + 1 })).toMatchObject({ ok: true, retried: 0 })
		expect((await states()).filter((r) => r.state !== 'delivered' && r.state !== 'gave_up')).toEqual([])
		// The inverse: a Remove that gave up, then an Add that arrived.
		await act(h, alice, `/api/v1/statuses/${status.id}/pin`)
		await deliver(OK)
		await act(h, alice, `/api/v1/statuses/${status.id}/unpin`)
		await deliver(GONE)
		await act(h, alice, `/api/v1/statuses/${status.id}/pin`)
		await deliver(OK)
		expect(await h.store.retryDeliveries(BUILD, { ids: 'all', now: at + 1 })).toMatchObject({ ok: true, retried: 0 })
		expect((await states()).filter((r) => r.state !== 'delivered' && r.state !== 'gave_up')).toEqual([])
		// Each keeps its own id.
		const sent = (await outbound(h.store)).filter((o) => o.activity.type === 'Add' || o.activity.type === 'Remove')
		expect(new Set(sent.map((o) => o.activity.id)).size).toBe(sent.length)
	})

	it('goes with its status, without a Remove', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await post(h, alice, { status: 'soon gone' })
		await act(h, alice, `/api/v1/statuses/${status.id}/pin`)
		await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: 'DELETE' }))
		expect(await sql(h.store, 'SELECT * FROM status_pins')).toEqual([])
		expect((await outbound(h.store)).map((o) => o.activity.type)).not.toContain('Remove')
	})
})

describe('conversation mutes', () => {
	it('mutes and unmutes the conversation of a status, which every status of the thread then shows', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const root = await post(h, bob, { status: 'root' })
		const reply = await post(h, alice, { status: '@bob reply', in_reply_to_id: root.id })
		const other = await post(h, bob, { status: 'elsewhere' })
		const muted = await act(h, alice, `/api/v1/statuses/${reply.id}/mute`)
		expect(muted.status).toBe(200)
		expect(await muted.json()).toMatchObject({ id: reply.id, muted: true })
		expect((await statusOf(h, root.id, alice.token)).body.muted).toBe(true)
		expect((await statusOf(h, other.id, alice.token)).body.muted).toBe(false)
		// Bob's view is his own.
		expect((await statusOf(h, root.id, bob.token)).body.muted).toBe(false)
		// Muting again changes nothing.
		expect((await act(h, alice, `/api/v1/statuses/${root.id}/mute`)).status).toBe(200)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM conversation_mutes')).toEqual([{ n: 1 }])
		const unmuted = await act(h, alice, `/api/v1/statuses/${root.id}/unmute`)
		expect(await unmuted.json()).toMatchObject({ id: root.id, muted: false })
		expect((await statusOf(h, reply.id, alice.token)).body.muted).toBe(false)
		// A status the viewer may not see is not found.
		const hidden = await post(h, bob, { status: 'followers only', visibility: 'private' })
		expect((await act(h, alice, `/api/v1/statuses/${hidden.id}/mute`)).status).toBe(404)
		expect((await act(h, alice, `/api/v1/statuses/${hidden.id}/unmute`)).status).toBe(404)
	})

	it('writes no notification about a status of a muted conversation, and keeps the ones written before', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		const root = await post(h, alice, { status: 'thread' })
		const elsewhere = await post(h, alice, { status: 'elsewhere' })
		await post(h, bob, { status: '@alice before', in_reply_to_id: root.id })
		await act(h, alice, `/api/v1/statuses/${root.id}/mute`)
		const types = async () =>
			(await getJson<Notification[]>(h, '/api/v1/notifications', alice.token)).body.map((n) => [
				n.type,
				n.status?.id ?? null,
			])
		const before = await types()
		expect(before).toHaveLength(1)
		// A reply, a favourite and a boost of a status of the thread notify nothing; elsewhere they do.
		const reply = await post(h, carol, { status: '@alice muted', in_reply_to_id: root.id })
		await act(h, bob, `/api/v1/statuses/${root.id}/favourite`)
		await act(h, bob, `/api/v1/statuses/${root.id}/reblog`)
		await act(h, carol, `/api/v1/statuses/${elsewhere.id}/favourite`)
		await follow(h, carol, alice.id)
		expect(await types()).toEqual([['follow', null], ['favourite', elsewhere.id], ...before])
		// The muter's own conversation list gets nothing of a direct reply in the thread either.
		await post(h, carol, { status: '@alice direct', visibility: 'direct', in_reply_to_id: reply.id })
		expect((await getJson<unknown[]>(h, '/api/v1/conversations', alice.token)).body).toEqual([])
		await act(h, alice, `/api/v1/statuses/${root.id}/unmute`)
		await act(h, carol, `/api/v1/statuses/${root.id}/favourite`)
		expect((await types())[0]).toEqual(['favourite', root.id])
	})

	it('keeps the edit notification written before the mute when a later edit is not notified', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const status = await post(h, alice, { status: 'v1' })
		await act(h, bob, `/api/v1/statuses/${status.id}/reblog`)
		const edit = (text: string) =>
			h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, json({ status: text }, { method: 'PUT' })))
		const updates = async () =>
			(await getJson<Notification[]>(h, '/api/v1/notifications?types[]=update', bob.token)).body.map((n) => n.id)
		expect((await edit('v2')).status).toBe(200)
		const before = await updates()
		expect(before).toHaveLength(1)
		await act(h, bob, `/api/v1/statuses/${status.id}/mute`)
		expect((await edit('v3')).status).toBe(200)
		expect(await updates()).toEqual(before)
		// Unmuted, the next edit replaces it.
		await act(h, bob, `/api/v1/statuses/${status.id}/unmute`)
		await edit('v4')
		const after = await updates()
		expect(after).toHaveLength(1)
		expect(after).not.toEqual(before)
	})

	it("mutes a boost's own conversation, as Mastodon gives a boost one", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const original = await post(h, alice, { status: 'original' })
		const boost = await (await act(h, bob, `/api/v1/statuses/${original.id}/reblog`)).json<Status>()
		const response = await act(h, alice, `/api/v1/statuses/${boost.id}/mute`)
		expect(await response.json()).toMatchObject({
			id: boost.id,
			muted: true,
			reblog: { id: original.id, muted: false },
		})
		expect((await statusOf(h, original.id, alice.token)).body.muted).toBe(false)
	})

	it('goes unseen by anyone else, and is refused for a token without write:mutes', async () => {
		const h = await community(['alice'], 'read write:statuses')
		const status = await post(h, h.users.alice, { status: 'x' })
		expect((await act(h, h.users.alice, `/api/v1/statuses/${status.id}/mute`)).status).toBe(403)
		expect((await act(h, h.users.alice, `/api/v1/statuses/${status.id}/pin`)).status).toBe(403)
		expect((await statusOf(h, status.id)).body).not.toHaveProperty('muted')
	})
})

describe('GET /api/v1/statuses?id[]=', () => {
	it('shows the statuses the viewer may list, each as GET /api/v1/statuses/:id, in the order asked', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		const a = await post(h, alice, { status: 'a' })
		const b = await post(h, bob, { status: 'b' })
		const hidden = await post(h, bob, { status: 'followers only', visibility: 'private' })
		const quiet = await post(h, carol, { status: 'muted author' })
		await mute(h.store, alice.id, carol.id)
		const remote = await remoteAccount(h.store, 'dave')
		const theirs = await seedStatus(h.store, { accountId: remote, visibility: 'public' })
		const query = [b.id, '999999999999999999', a.id, hidden.id, quiet.id, theirs, b.id]
			.map((id) => `id[]=${id}`)
			.join('&')
		const { status, body } = await getJson<Status[]>(h, `/api/v1/statuses?${query}`, alice.token)
		expect(status).toBe(200)
		expect(body.map((s) => s.id)).toEqual([b.id, a.id, theirs])
		expect(body[1]).toEqual((await statusOf(h, a.id, alice.token)).body)
		// Anonymous: no viewer's filter, public statuses only.
		expect(await ids(h, `/api/v1/statuses?${query}`)).toEqual([b.id, a.id, quiet.id, theirs])
		expect(await ids(h, '/api/v1/statuses')).toEqual([])
	})

	it(`refuses more than ${MAX_STATUSES_BY_ID} distinct ids`, async () => {
		const h = await community(['alice'])
		const many = (n: number) => Array.from({ length: n }, (_, i) => `id[]=${100000000000000000n + BigInt(i)}`).join('&')
		expect((await getJson(h, `/api/v1/statuses?${many(MAX_STATUSES_BY_ID)}`)).status).toBe(200)
		expect(await getJson(h, `/api/v1/statuses?${many(MAX_STATUSES_BY_ID + 1)}`)).toEqual({
			status: 422,
			body: { error: 'Mastodon::ValidationError' },
		})
		expect((await getJson(h, `/api/v1/statuses?${many(MAX_STATUSES_BY_ID)}&id[]=100000000000000000`)).status).toBe(200)
	})
})

describe('PATCH /api/v1/statuses/:id', () => {
	it('edits as PUT does', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await post(h, alice, { status: 'before' })
		const response = await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(alice.token, json({ status: 'after' }, { method: 'PATCH' }))
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			id: status.id,
			content: '<p>after</p>',
			edited_at: expect.any(String),
		})
	})
})
