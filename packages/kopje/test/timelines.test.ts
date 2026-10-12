import { describe, expect, it } from 'vitest'

import { bearer, sql } from './api-helpers'
import { act, community, follow, ids, post, remoteAccount, seedStatus } from './status-helpers'

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
