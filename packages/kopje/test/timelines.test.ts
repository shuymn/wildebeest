import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { act, community, follow, getJson, ids, post, remoteAccount, seedStatus } from './status-helpers'

describe('timeline paging', () => {
	it('pages home with max_id, since_id and min_id and a Link header', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const posted: string[] = []
		for (let i = 0; i < 5; i++) {
			posted.push((await post(h, alice, { status: `#${i}` })).id)
		}
		const [p0, p1, p2, p3, p4] = posted as [string, string, string, string, string]
		const first = await h.request('/api/v1/timelines/home?limit=2', bearer(alice.token))
		expect((await first.json<{ id: string }[]>()).map((s) => s.id)).toEqual([p4, p3])
		expect(first.headers.get('link')).toBe(
			`<https://kopje.test/api/v1/timelines/home?limit=2&max_id=${p3}>; rel="next", ` +
				`<https://kopje.test/api/v1/timelines/home?limit=2&min_id=${p4}>; rel="prev"`
		)
		expect(await ids(h, `/api/v1/timelines/home?limit=2&max_id=${p3}`, alice.token)).toEqual([p2, p1])
		expect(await ids(h, `/api/v1/timelines/home?limit=2&min_id=${p1}`, alice.token)).toEqual([p3, p2])
		expect(await ids(h, `/api/v1/timelines/home?limit=2&since_id=${p1}`, alice.token)).toEqual([p4, p3])
		expect(await ids(h, `/api/v1/timelines/home?max_id=${p1}`, alice.token)).toEqual([p0])
		// Cursors of another length compare as numbers, not as text.
		expect(await ids(h, '/api/v1/timelines/home?max_id=9', alice.token)).toEqual([])
		expect(await ids(h, '/api/v1/timelines/home?since_id=9999999999999999999', alice.token)).toEqual([])
		expect(await ids(h, '/api/v1/timelines/home?limit=1&max_id=9999999999999999999', alice.token)).toEqual([p4])
	})

	it('pages bookmarks by the bookmark, not the status', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const older = await post(h, alice, { status: 'older' })
		const newer = await post(h, alice, { status: 'newer' })
		await act(h, alice, `/api/v1/statuses/${newer.id}/bookmark`)
		await act(h, alice, `/api/v1/statuses/${older.id}/bookmark`)
		const response = await h.request('/api/v1/bookmarks?limit=1', bearer(alice.token))
		expect((await response.json<{ id: string }[]>()).map((s) => s.id)).toEqual([older.id])
		const next = /<([^>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
		expect(next).toMatch(/max_id=\d+$/)
		expect(await ids(h, new URL(next ?? '').pathname + new URL(next ?? '').search, alice.token)).toEqual([newer.id])
	})
})

describe('home', () => {
	it('leaves out boosts from follows with reblogs off and replies to accounts not followed', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await follow(h, alice, bob.id)
		const carols = await post(h, carol, { status: 'carol' })
		const boost = await (await act(h, bob, `/api/v1/statuses/${carols.id}/reblog`)).json<{ id: string }>()
		const replyToCarol = await post(h, bob, { status: 'to carol', in_reply_to_id: carols.id })
		const own = await post(h, bob, { status: 'own' })
		const thread = await post(h, bob, { status: 'thread', in_reply_to_id: own.id })
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).toEqual([thread.id, own.id, boost.id])
		await act(h, alice, `/api/v1/accounts/${bob.id}/follow`, { reblogs: false })
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).toEqual([thread.id, own.id])
		expect(replyToCarol.id).not.toBe('')
	})
})

describe('public and tag timelines', () => {
	it('splits local and remote, skips boosts and replies to others, and filters by media and tags', async () => {
		// Statuses are written in this order, so their ids are increasing.
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'rem')
		const local = await post(h, alice, { status: 'local #a #b' })
		const far = await seedStatus(h.store, { accountId: remote, visibility: 'public', tags: ['a'] })
		const unlisted = await post(h, alice, { status: 'unlisted #a', visibility: 'unlisted' })
		await act(h, alice, `/api/v1/statuses/${far}/reblog`)
		const reply = await post(h, alice, { status: 'reply #a', in_reply_to_id: far })
		const selfReply = await post(h, alice, { status: 'self #a', in_reply_to_id: local.id })
		expect(await ids(h, '/api/v1/timelines/public')).toEqual([selfReply.id, far, local.id])
		expect(await ids(h, '/api/v1/timelines/public?local=true')).toEqual([selfReply.id, local.id])
		expect(await ids(h, '/api/v1/timelines/public?remote=true')).toEqual([far])
		await sql(
			h.store,
			"INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES ('100000000000000001', ?, ?, 'image', 'u')",
			alice.id,
			local.id
		)
		expect(await ids(h, '/api/v1/timelines/public?only_media=true')).toEqual([local.id])
		// Unlike the public timeline, a hashtag timeline keeps replies (Mastodon's TagFeed).
		expect(await ids(h, '/api/v1/timelines/tag/A')).toEqual([selfReply.id, reply.id, far, local.id])
		expect(await ids(h, '/api/v1/timelines/tag/a?all[]=b')).toEqual([local.id])
		expect(await ids(h, '/api/v1/timelines/tag/a?none[]=b')).toEqual([selfReply.id, reply.id, far])
		expect(await ids(h, '/api/v1/timelines/tag/zzz?any[]=b')).toEqual([local.id])
		expect(unlisted.id).not.toBe('')
	})
})

describe('account statuses', () => {
	it('filters replies, boosts, media and tags; pinned is empty for now', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const bobs = await post(h, bob, { status: 'bob' })
		const first = await post(h, alice, { status: 'first #x' })
		const selfReply = await post(h, alice, { status: 'thread', in_reply_to_id: first.id })
		const reply = await post(h, alice, { status: 'reply', in_reply_to_id: bobs.id })
		const boost = await (await act(h, alice, `/api/v1/statuses/${bobs.id}/reblog`)).json<{ id: string }>()
		const path = `/api/v1/accounts/${alice.id}/statuses`
		expect(await ids(h, path)).toEqual([boost.id, reply.id, selfReply.id, first.id])
		expect(await ids(h, `${path}?exclude_replies=true`)).toEqual([boost.id, selfReply.id, first.id])
		expect(await ids(h, `${path}?exclude_reblogs=true`)).toEqual([reply.id, selfReply.id, first.id])
		expect(await ids(h, `${path}?tagged=X`)).toEqual([first.id])
		expect(await ids(h, `${path}?only_media=true`)).toEqual([])
		expect(await ids(h, `${path}?pinned=true`)).toEqual([])
		expect((await h.request('/api/v1/accounts/999999999999999999/statuses')).status).toBe(404)
	})
})

describe('home: conversations, languages and posting notifications (FeedManager, FeedInsertWorker)', () => {
	it("keeps the viewer's own reply to an account they do not follow", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const bobs = await post(h, bob, { status: 'bob' })
		const reply = await post(h, alice, { status: '@bob hi', in_reply_to_id: bobs.id })
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).toEqual([reply.id])
	})

	it('carries the reply target through a self-reply continuation (Status#carried_over_reply_to_account_id)', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await follow(h, carol, alice.id)
		const bobs = await post(h, bob, { status: 'bob' })
		const reply = await post(h, alice, { status: '@bob one', in_reply_to_id: bobs.id })
		const continuation = await post(h, alice, { status: 'two', in_reply_to_id: reply.id })
		const thread = await post(h, alice, { status: 'own thread' })
		const selfReply = await post(h, alice, { status: 'own thread 2', in_reply_to_id: thread.id })
		const { body } = await getJson<{ in_reply_to_id: string; in_reply_to_account_id: string }>(
			h,
			`/api/v1/statuses/${continuation.id}`
		)
		expect(body).toMatchObject({ in_reply_to_id: reply.id, in_reply_to_account_id: bob.id })
		// carol does not follow bob: the conversation with bob stays out of her home, the own thread does not.
		expect(await ids(h, '/api/v1/timelines/home', carol.token)).toEqual([selfReply.id, thread.id])
		expect(await ids(h, '/api/v1/timelines/public?local=true')).toEqual([selfReply.id, thread.id, bobs.id])
		expect(await ids(h, `/api/v1/accounts/${alice.id}/statuses?exclude_replies=true`)).toEqual([
			selfReply.id,
			thread.id,
		])
	})

	it("applies a follow's languages", async () => {
		const h = await community(['alice', 'carol'])
		const { alice, carol } = h.users
		await act(h, carol, `/api/v1/accounts/${alice.id}/follow`, { languages: ['ja'] })
		const ja = await post(h, alice, { status: 'こんにちは', language: 'ja' })
		await post(h, alice, { status: 'hello', language: 'en' })
		const unknown = await post(h, alice, { status: '?' })
		expect(await ids(h, '/api/v1/timelines/home', carol.token)).toEqual([unknown.id, ja.id])
	})

	it('notifies followers who asked to be notified, once, and not of replies to others', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await act(h, carol, `/api/v1/accounts/${alice.id}/follow`, { notify: true })
		const bobs = await post(h, bob, { status: 'bob' })
		const send = () =>
			h.request(
				'/api/v1/statuses',
				bearer(alice.token, json({ status: 'news' }, { headers: { 'idempotency-key': 'n-1' } }))
			)
		const status = await (await send()).json<{ id: string }>()
		await send()
		await post(h, alice, { status: 'to bob', in_reply_to_id: bobs.id })
		await post(h, alice, { status: '@bob secret', visibility: 'direct' })
		const notifications = await getJson<{ type: string; status: { id: string } }[]>(
			h,
			'/api/v1/notifications',
			carol.token
		)
		expect(notifications.body.map((n) => [n.type, n.status.id])).toEqual([['status', status.id]])
	})
})

describe('cursors', () => {
	it('strips leading zeros from a status cursor', async () => {
		const h = await community(['alice'])
		await post(h, h.users.alice, { status: 'x' })
		expect(await ids(h, '/api/v1/timelines/home?max_id=0000000000000000009', h.users.alice.token)).toEqual([])
		expect(await ids(h, '/api/v1/timelines/home?since_id=0000000000000000009', h.users.alice.token)).toHaveLength(1)
	})

	it('pages edge and notification ids above 2^53 exactly, in both directions', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const a = await post(h, alice, { status: 'a' })
		const b = await post(h, alice, { status: 'b' })
		// 2^53 + 1 and 2^53 + 3: a JS number would round them to their neighbours.
		const low = '9007199254740993'
		const high = '9007199254740995'
		await sql(h.store, 'INSERT INTO favourites (id, account_id, status_id) VALUES (?, ?, ?)', low, alice.id, a.id)
		await sql(h.store, 'INSERT INTO favourites (id, account_id, status_id) VALUES (?, ?, ?)', high, alice.id, b.id)
		await sql(
			h.store,
			'INSERT INTO favourites (id, account_id, status_id) VALUES (?, ?, ?)',
			'9007199254740994',
			bob.id,
			b.id
		)
		for (const [id, type, status] of [
			[low, 'favourite', a.id],
			[high, 'follow', null],
		] as const) {
			await sql(
				h.store,
				"INSERT INTO notifications (id, account_id, type, from_account_id, status_id, created_at) VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')",
				id,
				alice.id,
				type,
				bob.id,
				status
			)
		}
		expect(await ids(h, `/api/v1/favourites?max_id=${high}`, alice.token)).toEqual([a.id])
		expect(await ids(h, `/api/v1/favourites?min_id=${low}`, alice.token)).toEqual([b.id])
		expect(await ids(h, `/api/v1/notifications?max_id=${high}`, alice.token)).toEqual([low])
		expect(await ids(h, `/api/v1/notifications?min_id=${low}`, alice.token)).toEqual([high])
		expect(await ids(h, `/api/v1/statuses/${b.id}/favourited_by?max_id=9007199254740995`)).toEqual([bob.id])
		expect(await ids(h, `/api/v1/statuses/${b.id}/favourited_by?min_id=9007199254740994`)).toEqual([alice.id])
		const response = await h.request('/api/v1/favourites?limit=1', bearer(alice.token))
		expect(response.headers.get('link')).toContain(`max_id=${high}>; rel="next"`)
	})
})

describe('cursor and filter edge cases', () => {
	it('reads an all-zero cursor as zero', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'x' })
		expect(await ids(h, '/api/v1/timelines/home?max_id=0000000000000000000', h.users.alice.token)).toEqual([])
		expect(await ids(h, '/api/v1/timelines/home?since_id=0000000000000000000', h.users.alice.token)).toEqual([
			status.id,
		])
		expect(await ids(h, '/api/v1/timelines/home?min_id=0', h.users.alice.token)).toEqual([status.id])
	})

	it("does not apply a follow's languages to boosts, which carry no language (as Mastodon)", async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await act(h, carol, `/api/v1/accounts/${bob.id}/follow`, { languages: ['ja'] })
		const english = await post(h, alice, { status: 'hello', language: 'en' })
		const boost = await (await act(h, bob, `/api/v1/statuses/${english.id}/reblog`)).json<{ id: string }>()
		await post(h, bob, { status: 'hello too', language: 'en' })
		expect(await ids(h, '/api/v1/timelines/home', carol.token)).toEqual([boost.id])
	})

	it('combines a follow’s languages with notify: only posts in its languages notify', async () => {
		const h = await community(['alice', 'carol'])
		const { alice, carol } = h.users
		await act(h, carol, `/api/v1/accounts/${alice.id}/follow`, { languages: ['ja'], notify: true })
		await post(h, alice, { status: 'hello', language: 'en' })
		const ja = await post(h, alice, { status: 'こんにちは', language: 'ja' })
		const unknown = await post(h, alice, { status: '?' })
		const { body } = await getJson<{ type: string; status: { id: string } }[]>(h, '/api/v1/notifications', carol.token)
		expect(body.map((n) => [n.type, n.status.id])).toEqual([
			['status', unknown.id],
			['status', ja.id],
		])
	})
})
