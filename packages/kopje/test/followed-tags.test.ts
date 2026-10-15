import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, sql } from './api-helpers'
import { appToken, scopedToken } from './read-helpers'
import {
	act,
	block,
	community,
	domainBlock,
	follow,
	getJson,
	ids,
	mute,
	post,
	remoteAccount,
	seedStatus,
	type User,
} from './status-helpers'
import { MAX_FOLLOWED_TAGS } from '../src/domain/tags'

// Followed hashtags (Mastodon 4.5's TagsController#follow and #unfollow, FollowedTagsController) and what they add to
// home (FanOutOnWriteService#deliver_to_hashtag_followers!, FeedManager#filter_from_tags?).

type Tag = { name: string; url: string; history: unknown[]; following?: boolean; featuring?: boolean }

async function followTag(h: ApiHarness, user: User, name: string): Promise<Response> {
	return act(h, user, `/api/v1/tags/${encodeURIComponent(name)}/follow`)
}

async function home(h: ApiHarness, user: User): Promise<string[]> {
	return ids(h, '/api/v1/timelines/home?limit=40', user.token)
}

describe('followed hashtags', () => {
	it('follows and unfollows a hashtag, used or not, and answers with the Tag', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const followed = await followTag(h, alice, 'Cats')
		expect(followed.status).toBe(200)
		const tag = (await followed.json()) as Tag
		expect(tag).toMatchObject({
			name: 'cats',
			url: 'https://kopje.test/tags/cats',
			following: true,
			featuring: false,
		})
		expect(tag.history).toHaveLength(7)
		expect((await getJson<Tag>(h, '/api/v1/tags/cats', alice.token)).body.following).toBe(true)
		// Following again changes nothing.
		expect(((await (await followTag(h, alice, 'cats')).json()) as Tag).following).toBe(true)
		expect(await sql(h.store, 'SELECT name FROM tag_follows')).toEqual([{ name: 'cats' }])

		const unfollowed = await act(h, alice, '/api/v1/tags/cats/unfollow')
		expect(((await unfollowed.json()) as Tag).following).toBe(false)
		// Unfollowing a hashtag not followed answers the Tag too.
		expect((await act(h, alice, '/api/v1/tags/dogs/unfollow')).status).toBe(200)
		expect(await sql(h.store, 'SELECT name FROM tag_follows')).toEqual([])
	})

	it('answers 404 for a name that is not a hashtag', async () => {
		const h = await community(['alice'])
		for (const name of ['123', 'a-b', encodeURIComponent('#cats')]) {
			const response = await act(h, h.users.alice, `/api/v1/tags/${name}/follow`)
			expect([response.status, await response.json()]).toEqual([404, { error: 'Record not found' }])
		}
	})

	it('lists the followed hashtags, newest first, paged by the follow, and nobody else’s', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		for (const name of ['a1', 'a2', 'a3']) {
			await followTag(h, alice, name)
		}
		await followTag(h, bob, 'b1')
		const { status, body } = await getJson<Tag[]>(h, '/api/v1/followed_tags', alice.token)
		expect(status).toBe(200)
		expect(body.map((tag) => tag.name)).toEqual(['a3', 'a2', 'a1'])
		expect(body.every((tag) => tag.following === true && tag.featuring === false)).toBe(true)

		const first = await h.request('/api/v1/followed_tags?limit=2', bearer(alice.token))
		expect(((await first.json()) as Tag[]).map((tag) => tag.name)).toEqual(['a3', 'a2'])
		const next = /<([^>]+)>; rel="next"/.exec(first.headers.get('link') ?? '')?.[1]
		expect(next).toBeDefined()
		const second = await h.request(new URL(next ?? '').pathname + new URL(next ?? '').search, bearer(alice.token))
		expect(((await second.json()) as Tag[]).map((tag) => tag.name)).toEqual(['a1'])
		expect((await getJson<Tag[]>(h, '/api/v1/followed_tags', bob.token)).body.map((tag) => tag.name)).toEqual(['b1'])
	})

	it('pages by the follow’s number across a digit boundary, both ways', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const names = Array.from({ length: 12 }, (_, i) => `t${i + 1}`)
		for (const name of names) {
			await followTag(h, alice, name)
		}
		const page = async (query: string) => {
			const response = await h.request(`/api/v1/followed_tags?${query}`, bearer(alice.token))
			const link = response.headers.get('link') ?? ''
			const cursor = (rel: string, key: string) => new RegExp(`[?&]${key}=(\\d+)[^>]*>; rel="${rel}"`).exec(link)?.[1]
			return {
				names: ((await response.json()) as Tag[]).map((tag) => tag.name),
				next: cursor('next', 'max_id'),
				prev: cursor('prev', 'min_id'),
			}
		}
		const newest = [...names].reverse()
		const seen: string[] = []
		let query = 'limit=5'
		for (let i = 0; i < 5; i++) {
			const result = await page(query)
			seen.push(...result.names)
			if (result.next === undefined) {
				break
			}
			query = `limit=5&max_id=${result.next}`
		}
		expect(seen).toEqual(newest)
		const ascending: string[] = []
		query = 'limit=5&min_id=0'
		for (let i = 0; i < 5; i++) {
			const result = await page(query)
			if (result.names.length === 0) {
				break
			}
			ascending.unshift(...result.names)
			query = `limit=5&min_id=${result.prev ?? ''}`
		}
		expect(ascending).toEqual(newest)
	})

	it('takes the scopes Mastodon asks for, and a user (AUTH-2)', async () => {
		const h = await community(['alice'])
		for (const scope of ['write:follows', 'follow', 'write']) {
			expect(
				(await h.request('/api/v1/tags/cats/follow', bearer(await scopedToken(h, scope), { method: 'POST' }))).status
			).toBe(200)
		}
		expect(
			(await h.request('/api/v1/tags/cats/follow', bearer(await scopedToken(h, 'read'), { method: 'POST' }))).status
		).toBe(403)
		expect((await h.request('/api/v1/tags/cats/follow', { method: 'POST' })).status).toBe(401)
		for (const scope of ['read:follows', 'follow', 'read']) {
			expect((await h.request('/api/v1/followed_tags', bearer(await scopedToken(h, scope)))).status).toBe(200)
		}
		expect((await h.request('/api/v1/followed_tags', bearer(await scopedToken(h, 'write')))).status).toBe(403)
		expect((await h.request('/api/v1/followed_tags', bearer(await appToken(h)))).status).toBe(422)
	})

	it(`refuses a follow beyond ${MAX_FOLLOWED_TAGS} hashtags`, async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO tag_follows (account_id, name) SELECT ?1, 't' || i FROM n`,
			alice.id,
			MAX_FOLLOWED_TAGS
		)
		const refused = await followTag(h, alice, 'cats')
		expect([refused.status, await refused.json()]).toEqual([
			422,
			{ error: 'Validation failed: You have reached the maximum number of followed hashtags' },
		])
		// One already followed still answers.
		expect((await followTag(h, alice, 't1')).status).toBe(200)
	})

	it('shows the hashtag in search with following and featuring', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await post(h, alice, { status: '#cats', visibility: 'public' })
		await followTag(h, alice, 'cats')
		const { body } = await getJson<{ hashtags: Tag[] }>(h, '/api/v2/search?q=cats&type=hashtags', alice.token)
		expect(body.hashtags).toEqual([
			{ name: 'cats', url: 'https://kopje.test/tags/cats', history: [], following: true, featuring: false },
		])
	})
})

describe('home and followed hashtags', () => {
	it('shows the public statuses, not boosts, with a followed hashtag, from anyone', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const carol = await remoteAccount(h.store, 'carol')
		const shown = await post(h, bob, { status: 'a #cats', visibility: 'public' })
		const unlisted = await post(h, bob, { status: 'b #cats', visibility: 'unlisted' })
		const privately = await post(h, bob, { status: 'c #cats', visibility: 'private' })
		const remote = await seedStatus(h.store, { accountId: carol, visibility: 'public', tags: ['cats'] })
		const other = await post(h, bob, { status: 'd #dogs', visibility: 'public' })
		// A reply to someone the viewer does not follow, which home would leave out of a followed account's statuses.
		const reply = await post(h, bob, { status: 'e #cats', visibility: 'public', in_reply_to_id: remote })
		expect(await home(h, alice)).toEqual([])

		await followTag(h, alice, 'cats')
		expect(await home(h, alice)).toEqual([reply.id, remote, shown.id])
		// A boost of a tagged status: the original is there, the boost is not.
		await act(h, h.users.bob, `/api/v1/statuses/${shown.id}/reblog`)
		expect(await home(h, alice)).toEqual([reply.id, remote, shown.id])
		expect(await home(h, alice)).not.toContain(unlisted.id)
		expect(await home(h, alice)).not.toContain(privately.id)
		expect(await home(h, alice)).not.toContain(other.id)

		// Unfollowing takes them out of home at once.
		await act(h, alice, '/api/v1/tags/cats/unfollow')
		expect(await home(h, alice)).toEqual([])
	})

	it('shows a status once, whether it comes from a follow, the viewer or a hashtag', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, alice, bob.id)
		await followTag(h, alice, 'cats')
		await followTag(h, alice, 'dogs')
		const both = await post(h, bob, { status: '#cats #dogs', visibility: 'public' })
		const own = await post(h, alice, { status: '#cats', visibility: 'public' })
		expect(await home(h, alice)).toEqual([own.id, both.id])
	})

	it('leaves out what the viewer filters, as FeedManager#filter_from_tags? does', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const blocked = await remoteAccount(h.store, 'blocked')
		const muted = await remoteAccount(h.store, 'muted')
		const blocking = await remoteAccount(h.store, 'blocking')
		const far = await remoteAccount(h.store, 'far', 'far.example')
		const mentioned = await remoteAccount(h.store, 'mentioned')
		const silent = await remoteAccount(h.store, 'silent')
		await followTag(h, alice, 'cats')
		const tagged = (accountId: string, mentions: { accountId: string; silent?: boolean }[] = []) =>
			seedStatus(h.store, { accountId, visibility: 'public', tags: ['cats'], mentions })
		await tagged(blocked)
		await tagged(muted)
		await tagged(blocking)
		await tagged(far)
		await tagged(bob.id, [{ accountId: mentioned }])
		const silently = await tagged(bob.id, [{ accountId: silent, silent: true }])
		const kept = await tagged(bob.id)
		await block(h.store, alice.id, blocked)
		await mute(h.store, alice.id, muted)
		await block(h.store, blocking, alice.id)
		await domainBlock(h.store, alice.id, 'far.example')
		await mute(h.store, alice.id, mentioned)
		await mute(h.store, alice.id, silent)
		expect(await home(h, alice)).toEqual([kept, silently])
	})

	it('shows a followed hashtag of an exclusive list’s member, which home leaves out otherwise', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, alice, bob.id)
		const list = (await (await act(h, alice, '/api/v1/lists', { title: 'x', exclusive: true })).json()) as {
			id: string
		}
		await act(h, alice, `/api/v1/lists/${list.id}/accounts`, { account_ids: [bob.id] })
		const tagged = await post(h, bob, { status: '#cats', visibility: 'public' })
		await post(h, bob, { status: 'plain', visibility: 'public' })
		expect(await home(h, alice)).toEqual([])
		await followTag(h, alice, 'cats')
		expect(await home(h, alice)).toEqual([tagged.id])
	})

	it('pages through followed hashtags as through follows', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await followTag(h, alice, 'cats')
		const posted: string[] = []
		for (let i = 0; i < 5; i++) {
			posted.unshift((await post(h, bob, { status: `#cats ${i}`, visibility: 'public' })).id)
		}
		const page = (query: string) => ids(h, `/api/v1/timelines/home?${query}`, alice.token)
		expect(await page('limit=2')).toEqual(posted.slice(0, 2))
		expect(await page(`limit=2&max_id=${posted[1]}`)).toEqual(posted.slice(2, 4))
		expect(await page(`limit=2&min_id=${posted[4]}`)).toEqual(posted.slice(2, 4))
		expect(await page(`limit=10&since_id=${posted[2]}`)).toEqual(posted.slice(0, 2))
	})
})
