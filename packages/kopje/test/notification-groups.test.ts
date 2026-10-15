import { describe, expect, it } from 'vitest'

import { bearer, form, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { act, block, community, follow, getJson, mute, post, remoteAccount, type Status } from './status-helpers'

type Notification = { id: string; type: string; group_key: string; account: { id: string } }

type Group = {
	group_key: string
	notifications_count: number
	type: string
	most_recent_notification_id: number
	page_min_id?: string
	page_max_id?: string
	latest_page_notification_at?: string
	sample_account_ids: string[]
	status_id?: string | null
}

type Grouped = {
	accounts: { id: string }[]
	partial_accounts?: Record<string, unknown>[]
	statuses: { id: string }[]
	notification_groups: Group[]
}

const HOUR = 3_600_000
const BUCKET = Math.floor(NOW / HOUR)

// Alice's status, favourited by bob, carol and dave, boosted by bob; carol and dave follow her and dave mentions her,
// in this order: fav bob, fav carol, reblog bob, follow carol, mention dave, fav dave, follow dave.
async function scene() {
	const h = await community(['alice', 'bob', 'carol', 'dave'])
	const { alice, bob, carol, dave } = h.users
	const status = await post(h, alice, { status: 'hello' })
	await act(h, bob, `/api/v1/statuses/${status.id}/favourite`)
	await act(h, carol, `/api/v1/statuses/${status.id}/favourite`)
	await act(h, bob, `/api/v1/statuses/${status.id}/reblog`)
	await follow(h, carol, alice.id)
	const mention = await post(h, dave, { status: '@alice hi' })
	await act(h, dave, `/api/v1/statuses/${status.id}/favourite`)
	await follow(h, dave, alice.id)
	// The v1 notifications, oldest first, by what they are.
	const v1 = (await getJson<Notification[]>(h, '/api/v1/notifications', alice.token)).body.toReversed()
	const id = (type: string, from: string) => {
		const found = v1.find((n) => n.type === type && n.account.id === from)
		if (found === undefined) {
			throw new Error(`no ${type} from ${from}`)
		}
		return found.id
	}
	return { h, alice, bob, carol, dave, status, mention, v1, id }
}

const grouped = async (
	h: { request: (path: string, init?: RequestInit) => Promise<Response> },
	path: string,
	token: string
) => {
	const response = await h.request(path, bearer(token))
	return { status: response.status, link: response.headers.get('link'), body: (await response.json()) as Grouped }
}

const keys = (body: Grouped) =>
	body.notification_groups.map((g) => [g.group_key.replace(/-\d+$/, ''), g.notifications_count])

describe('grouped notifications (API v2)', () => {
	it("groups favourites and boosts of a status and follows, in Mastodon 4.5's shape", async () => {
		const { h, alice, bob, carol, dave, status, mention, v1, id } = await scene()
		const favourites = `favourite-${status.id}-${BUCKET}`
		// v1 names each notification's group.
		expect(v1.map((n) => [n.type, n.group_key])).toEqual([
			['favourite', favourites],
			['favourite', favourites],
			['reblog', `reblog-${status.id}-${BUCKET}`],
			['follow', `follow-${BUCKET}`],
			['mention', `ungrouped-${id('mention', dave.id)}`],
			['favourite', favourites],
			['follow', `follow-${BUCKET}`],
		])
		const { status: code, body } = await grouped(h, '/api/v2/notifications', alice.token)
		expect(code).toBe(200)
		expect(Object.keys(body)).toEqual(['accounts', 'statuses', 'notification_groups'])
		expect(body.notification_groups).toEqual([
			{
				group_key: `follow-${BUCKET}`,
				notifications_count: 2,
				type: 'follow',
				most_recent_notification_id: Number(id('follow', dave.id)),
				page_min_id: id('follow', carol.id),
				page_max_id: id('follow', dave.id),
				latest_page_notification_at: new Date(NOW).toISOString(),
				sample_account_ids: [dave.id, carol.id],
			},
			{
				group_key: favourites,
				notifications_count: 3,
				type: 'favourite',
				most_recent_notification_id: Number(id('favourite', dave.id)),
				page_min_id: id('favourite', bob.id),
				page_max_id: id('favourite', dave.id),
				latest_page_notification_at: new Date(NOW).toISOString(),
				sample_account_ids: [dave.id, carol.id, bob.id],
				status_id: status.id,
			},
			{
				group_key: `ungrouped-${id('mention', dave.id)}`,
				notifications_count: 1,
				type: 'mention',
				most_recent_notification_id: Number(id('mention', dave.id)),
				page_min_id: id('mention', dave.id),
				page_max_id: id('mention', dave.id),
				latest_page_notification_at: new Date(NOW).toISOString(),
				sample_account_ids: [dave.id],
				status_id: mention.id,
			},
			{
				group_key: `reblog-${status.id}-${BUCKET}`,
				notifications_count: 1,
				type: 'reblog',
				most_recent_notification_id: Number(id('reblog', bob.id)),
				page_min_id: id('reblog', bob.id),
				page_max_id: id('reblog', bob.id),
				latest_page_notification_at: new Date(NOW).toISOString(),
				sample_account_ids: [bob.id],
				status_id: status.id,
			},
		])
		expect(body.accounts.map((a) => a.id)).toEqual([dave.id, carol.id, bob.id])
		expect(body.accounts[0]).toMatchObject({ id: dave.id, acct: 'dave', followers_count: expect.any(Number) })
		expect(body.statuses.map((s) => s.id)).toEqual([status.id, mention.id])
	})

	it('answers partial accounts with expand_accounts=partial_avatars, and refuses another value', async () => {
		const { h, alice, bob, carol, dave } = await scene()
		const { body } = await grouped(h, '/api/v2/notifications?expand_accounts=partial_avatars', alice.token)
		expect(Object.keys(body)).toEqual(['accounts', 'partial_accounts', 'statuses', 'notification_groups'])
		expect(body.accounts.map((a) => a.id)).toEqual([dave.id, bob.id])
		expect(body.partial_accounts).toEqual([
			{
				id: carol.id,
				acct: 'carol',
				locked: false,
				bot: false,
				url: expect.stringContaining('carol'),
				avatar: expect.any(String),
				avatar_static: expect.any(String),
			},
		])
		const full = await grouped(h, '/api/v2/notifications?expand_accounts=full', alice.token)
		expect(full.body.accounts).toHaveLength(3)
		const refused = await h.request('/api/v2/notifications?expand_accounts=some', bearer(alice.token))
		expect({ status: refused.status, body: await refused.json() }).toEqual({
			status: 400,
			body: { error: "Invalid value for 'expand_accounts': 'some', allowed values are 'full' and 'partial_avatars'" },
		})
	})

	it('groups only grouped_types[], and filters by types[] and exclude_types[]', async () => {
		const { h, alice } = await scene()
		const read = async (query: string) => keys((await grouped(h, `/api/v2/notifications${query}`, alice.token)).body)
		expect(await read('?grouped_types[]=favourite')).toEqual([
			['ungrouped', 1],
			[expect.stringMatching(/^favourite-/), 3],
			['ungrouped', 1],
			['ungrouped', 1],
			['ungrouped', 1],
		])
		// A type that is never grouped groups nothing.
		expect((await read('?grouped_types[]=mention')).every(([key]) => key === 'ungrouped')).toBe(true)
		expect(await read('?types[]=follow&types[]=reblog')).toEqual([
			['follow', 2],
			[expect.stringMatching(/^reblog-/), 1],
		])
		expect(await read('?exclude_types[]=follow&exclude_types[]=mention')).toEqual([
			[expect.stringMatching(/^favourite-/), 3],
			[expect.stringMatching(/^reblog-/), 1],
		])
	})

	it('pages by the groups found, a group going on in the page after, with Link headers', async () => {
		const { h, alice, bob, carol, dave, id } = await scene()
		const first = await grouped(h, '/api/v2/notifications?limit=2', alice.token)
		// Each group counts and samples its notifications up to the page's newest, those below the page included.
		expect(first.body.notification_groups.map((g) => [g.type, g.notifications_count, g.sample_account_ids])).toEqual([
			['follow', 2, [dave.id, carol.id]],
			['favourite', 3, [dave.id, carol.id, bob.id]],
		])
		expect(first.body.notification_groups.map((g) => [g.page_min_id, g.page_max_id])).toEqual([
			[id('follow', dave.id), id('follow', dave.id)],
			[id('favourite', dave.id), id('favourite', dave.id)],
		])
		expect(first.link).toBe(
			`<https://kopje.test/api/v2/notifications?limit=2&max_id=${id('favourite', dave.id)}>; rel="next", ` +
				`<https://kopje.test/api/v2/notifications?limit=2&min_id=${id('follow', dave.id)}>; rel="prev"`
		)
		// The next page meets carol's follow again: the follow group goes on, counted up to this page's newest.
		const second = await grouped(h, `/api/v2/notifications?limit=2&max_id=${id('favourite', dave.id)}`, alice.token)
		expect(second.body.notification_groups.map((g) => [g.type, g.notifications_count, g.sample_account_ids])).toEqual([
			['mention', 1, [dave.id]],
			['follow', 1, [carol.id]],
		])
		// The last page: a group on it counts its notifications up to the page's newest.
		const last = await grouped(h, `/api/v2/notifications?max_id=${id('follow', carol.id)}`, alice.token)
		expect(last.body.notification_groups.map((g) => [g.type, g.notifications_count, g.sample_account_ids])).toEqual([
			['reblog', 1, [bob.id]],
			['favourite', 2, [carol.id, bob.id]],
		])
		// Above min_id, walked oldest first: each group from its oldest notification above it, answered newest first.
		const above = await grouped(h, `/api/v2/notifications?limit=2&min_id=${id('favourite', bob.id)}`, alice.token)
		expect(
			above.body.notification_groups.map((g) => [g.type, g.notifications_count, g.page_min_id, g.page_max_id])
		).toEqual([
			['reblog', 1, id('reblog', bob.id), id('reblog', bob.id)],
			['favourite', 2, id('favourite', carol.id), id('favourite', carol.id)],
		])
		const empty = await grouped(h, `/api/v2/notifications?max_id=${id('favourite', bob.id)}`, alice.token)
		expect({ link: empty.link, groups: empty.body.notification_groups }).toEqual({ link: null, groups: [] })
	})

	it("counts a group's notifications below a full page", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await post(h, alice, { status: 'hello' })
		const senders = await Promise.all(Array.from({ length: 42 }, (_, i) => remoteAccount(h.store, `r${i}`)))
		const key = `favourite-${status.id}-${BUCKET}`
		// Three favourites, then 39 mentions: a page of 40 groups ends at the newest favourite.
		for (const [i, from] of senders.entries()) {
			await sql(
				h.store,
				'INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key) VALUES (?, ?, ?, ?, ?)',
				alice.id,
				i < 3 ? 'favourite' : 'mention',
				from,
				i < 3 ? status.id : null,
				i < 3 ? key : null
			)
		}
		const { body } = await grouped(h, '/api/v2/notifications', alice.token)
		expect(body.notification_groups).toHaveLength(40)
		expect(body.notification_groups.at(-1)).toMatchObject({
			group_key: key,
			notifications_count: 3,
			sample_account_ids: [senders[2], senders[1], senders[0]],
		})
	})

	it('reaches past a large group to the groups below it', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await post(h, alice, { status: 'hello' })
		const key = `favourite-${status.id}-${BUCKET}`
		// An older mention, then 600 favourites in one group.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(660000000000000000 + i AS TEXT), 'https://far.example/users/f' || i, 'f' || i, 'far.example' FROM n`
		)
		await sql(
			h.store,
			`INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key)
			SELECT ?1, CASE WHEN id = '660000000000000000' THEN 'mention' ELSE 'favourite' END, id,
				CASE WHEN id = '660000000000000000' THEN NULL ELSE ?2 END,
				CASE WHEN id = '660000000000000000' THEN NULL ELSE ?3 END
			FROM accounts WHERE domain = 'far.example' ORDER BY id`,
			alice.id,
			status.id,
			key
		)
		const { body } = await grouped(h, '/api/v2/notifications', alice.token)
		expect(body.notification_groups.map((g) => [g.type, g.notifications_count])).toEqual([
			['favourite', 400],
			['mention', 1],
		])
	})

	it('shows one group by its key, and the accounts of a group by page', async () => {
		const { h, alice, bob, carol, dave, status, id } = await scene()
		const favourites = `favourite-${status.id}-${BUCKET}`
		const shown = await grouped(h, `/api/v2/notifications/${favourites}`, alice.token)
		expect(shown.body).toEqual({
			accounts: [
				expect.objectContaining({ id: dave.id }),
				expect.objectContaining({ id: carol.id }),
				expect.objectContaining({ id: bob.id }),
			],
			statuses: [expect.objectContaining({ id: status.id })],
			notification_groups: [
				{
					group_key: favourites,
					notifications_count: 3,
					type: 'favourite',
					most_recent_notification_id: Number(id('favourite', dave.id)),
					sample_account_ids: [dave.id, carol.id, bob.id],
					status_id: status.id,
				},
			],
		})
		// ungrouped-<id> names one notification, and the group of a grouped one.
		const mention = await grouped(h, `/api/v2/notifications/ungrouped-${id('mention', dave.id)}`, alice.token)
		expect(mention.body.notification_groups.map((g) => [g.group_key, g.type])).toEqual([
			[`ungrouped-${id('mention', dave.id)}`, 'mention'],
		])
		const byId = await grouped(h, `/api/v2/notifications/ungrouped-${id('favourite', bob.id)}`, alice.token)
		expect(byId.body.notification_groups.map((g) => [g.group_key, g.notifications_count])).toEqual([[favourites, 3]])
		for (const [key, token] of [
			['favourite-1-1', alice.token],
			['ungrouped-x', alice.token],
			[favourites, bob.token],
		] as const) {
			expect((await getJson(h, `/api/v2/notifications/${key}`, token)).status).toBe(404)
		}

		const accounts = async (path: string) => {
			const response = await h.request(path, bearer(alice.token))
			return {
				link: response.headers.get('link'),
				ids: ((await response.json()) as { id: string }[]).map((a) => a.id),
			}
		}
		expect((await accounts(`/api/v2/notifications/${favourites}/accounts`)).ids).toEqual([dave.id, carol.id, bob.id])
		const page = await accounts(`/api/v2/notifications/${favourites}/accounts?limit=2`)
		expect(page).toEqual({
			ids: [dave.id, carol.id],
			link:
				`<https://kopje.test/api/v2/notifications/${favourites}/accounts?limit=2&max_id=${id('favourite', carol.id)}>; rel="next", ` +
				`<https://kopje.test/api/v2/notifications/${favourites}/accounts?limit=2&min_id=${id('favourite', dave.id)}>; rel="prev"`,
		})
		expect(
			(await accounts(`/api/v2/notifications/${favourites}/accounts?max_id=${id('favourite', carol.id)}`)).ids
		).toEqual([bob.id])
		// Mastodon reads the accounts by group key alone.
		expect((await accounts(`/api/v2/notifications/ungrouped-${id('mention', dave.id)}/accounts`)).ids).toEqual([])
	})

	it('neither counts nor shows a notification v1 would not show', async () => {
		const { h, alice, bob, carol, dave, status } = await scene()
		await mute(h.store, alice.id, carol.id)
		await block(h.store, alice.id, bob.id)
		const { body } = await grouped(h, '/api/v2/notifications', alice.token)
		expect(body.notification_groups.map((g) => [g.type, g.notifications_count, g.sample_account_ids])).toEqual([
			['follow', 1, [dave.id]],
			['favourite', 1, [dave.id]],
			['mention', 1, [dave.id]],
		])
		expect(body.accounts.map((a) => a.id)).toEqual([dave.id])
		const favourites = `favourite-${status.id}-${BUCKET}`
		const shown = await grouped(h, `/api/v2/notifications/${favourites}`, alice.token)
		expect(shown.body.notification_groups.map((g) => [g.notifications_count, g.sample_account_ids])).toEqual([
			[1, [dave.id]],
		])
		const accounts = await getJson<{ id: string }[]>(h, `/api/v2/notifications/${favourites}/accounts`, alice.token)
		expect(accounts.body.map((a) => a.id)).toEqual([dave.id])
		expect((await getJson(h, `/api/v2/notifications/reblog-${status.id}-${BUCKET}`, alice.token)).status).toBe(404)
		expect((await getJson(h, '/api/v1/notifications/unread_count', alice.token)).body).toEqual({ count: 3 })
		expect((await getJson(h, '/api/v2/notifications/unread_count', alice.token)).body).toEqual({ count: 3 })
	})

	it('dismisses a group, shown or not, and clears every notification', async () => {
		const { h, alice, bob, dave, status, id } = await scene()
		const types = async () =>
			(await getJson<Notification[]>(h, '/api/v1/notifications', alice.token)).body.map((n) => n.type)
		await mute(h.store, alice.id, bob.id)
		const dismiss = (key: string, token = alice.token) =>
			h.request(`/api/v2/notifications/${key}/dismiss`, bearer(token, form({})))
		// Another account's dismissal of the key leaves alice's group.
		expect((await dismiss(`favourite-${status.id}-${BUCKET}`, bob.token)).status).toBe(200)
		const dismissed = await dismiss(`favourite-${status.id}-${BUCKET}`)
		expect({ status: dismissed.status, body: await dismissed.json() }).toEqual({ status: 200, body: {} })
		expect(await types()).toEqual(['follow', 'mention', 'follow'])
		// Bob's favourite went with its group, though alice was not shown it.
		await sql(h.store, 'DELETE FROM mutes')
		expect(await types()).toEqual(['follow', 'mention', 'follow', 'reblog'])
		expect((await dismiss(`ungrouped-${id('mention', dave.id)}`)).status).toBe(200)
		expect((await dismiss('no-such-group')).status).toBe(200)
		expect(await types()).toEqual(['follow', 'follow', 'reblog'])
		const cleared = await h.request('/api/v2/notifications/clear', bearer(alice.token, form({})))
		expect({ status: cleared.status, body: await cleared.json() }).toEqual({ status: 200, body: {} })
		expect(await types()).toEqual([])
	})

	it('counts the unread notifications and groups above the marker, up to the limit', async () => {
		const { h, alice, carol, dave, id } = await scene()
		const count = async (path: string) => (await getJson<{ count: number }>(h, path, alice.token)).body.count
		expect(await count('/api/v1/notifications/unread_count')).toBe(7)
		expect(await count('/api/v2/notifications/unread_count')).toBe(4)
		expect(await count('/api/v2/notifications/unread_count?grouped_types[]=reblog')).toBe(7)
		expect(await count('/api/v2/notifications/unread_count?exclude_types[]=mention')).toBe(3)
		expect(await count('/api/v1/notifications/unread_count?types[]=favourite')).toBe(3)
		expect(await count(`/api/v1/notifications/unread_count?account_id=${carol.id}`)).toBe(2)
		expect(await count('/api/v1/notifications/unread_count?limit=2')).toBe(2)
		expect(await count('/api/v2/notifications/unread_count?limit=2')).toBe(2)
		expect(await count('/api/v1/notifications/unread_count?limit=-3')).toBe(3)
		expect(await count('/api/v1/notifications/unread_count?limit=none')).toBe(0)
		const marked = await act(h, alice, '/api/v1/markers', { notifications: { last_read_id: id('follow', carol.id) } })
		expect(marked.status).toBe(200)
		expect(await count('/api/v1/notifications/unread_count')).toBe(3)
		// mention, then the favourite and follow groups above the marker.
		expect(await count('/api/v2/notifications/unread_count')).toBe(3)
		await act(h, alice, '/api/v1/markers', { notifications: { last_read_id: id('follow', dave.id) } })
		expect(await count('/api/v1/notifications/unread_count')).toBe(0)
		expect(await count('/api/v2/notifications/unread_count')).toBe(0)
		// A marker that is not a number reads as Mastodon's to_i does.
		await act(h, alice, '/api/v1/markers', { notifications: { last_read_id: 'none' } })
		expect(await count('/api/v1/notifications/unread_count')).toBe(7)
	})

	it('needs the notification scopes', async () => {
		const h = await community(['alice'], 'read:statuses write:statuses')
		const token = h.users.alice.token
		for (const path of [
			'/api/v2/notifications',
			'/api/v2/notifications/unread_count',
			'/api/v1/notifications/unread_count',
			'/api/v2/notifications/follow-1',
			'/api/v2/notifications/follow-1/accounts',
		]) {
			expect((await h.request(path, bearer(token))).status).toBe(403)
		}
		for (const path of ['/api/v2/notifications/clear', '/api/v2/notifications/follow-1/dismiss']) {
			expect((await h.request(path, bearer(token, form({})))).status).toBe(403)
		}
	})
})

describe('the group a notification joins', () => {
	it('joins the group of the same kind from up to 11 hours before, and starts one after', async () => {
		const h = await community(['alice', 'bob', 'carol', 'dave', 'erin'])
		const { alice, bob, carol, dave, erin } = h.users
		const at = async (hours: number, user: typeof bob) => {
			h.now.mockReturnValue(NOW + hours * HOUR)
			await follow(h, user, alice.id)
		}
		await at(0, bob)
		await at(11.5, carol)
		// 12 hours after the group's hour: a new group, even though carol joined the first 30 minutes ago.
		await at(12, dave)
		await at(30, erin)
		const v1 = (await getJson<Notification[]>(h, '/api/v1/notifications', alice.token)).body
		expect(v1.map((n) => [n.account.id, n.group_key])).toEqual([
			[erin.id, `follow-${BUCKET + 30}`],
			[dave.id, `follow-${BUCKET + 12}`],
			[carol.id, `follow-${BUCKET}`],
			[bob.id, `follow-${BUCKET}`],
		])
		// Favourites group by status.
		h.now.mockReturnValue(NOW + 31 * HOUR)
		const one: Status = await post(h, alice, { status: 'one' })
		const two: Status = await post(h, alice, { status: 'two' })
		await act(h, bob, `/api/v1/statuses/${one.id}/favourite`)
		await act(h, carol, `/api/v1/statuses/${two.id}/favourite`)
		await act(h, dave, `/api/v1/statuses/${one.id}/favourite`)
		const favourites = (await getJson<Notification[]>(h, '/api/v1/notifications?types[]=favourite', alice.token)).body
		expect(favourites.map((n) => n.group_key)).toEqual([
			`favourite-${one.id}-${BUCKET + 31}`,
			`favourite-${two.id}-${BUCKET + 31}`,
			`favourite-${one.id}-${BUCKET + 31}`,
		])
		const { body } = await grouped(h, '/api/v2/notifications?types[]=favourite', alice.token)
		expect(keys(body)).toEqual([
			[`favourite-${one.id}`, 2],
			[`favourite-${two.id}`, 1],
		])
	})
})
