import { describe, expect, it } from 'vitest'

import { type ApiHarness, seedFollows, sql } from './api-helpers'
import { act, community, follow, outbound, remoteAccount, type User } from './status-helpers'
import { FOLLOW_LIMIT, followLimit } from '../src/domain/accounts'

// Mastodon's FollowLimitValidator on the follow API: a local account follows up to 7,500 accounts, past that up to 1.1
// times its followers; a new follow or request past it is refused with 422, and authorizing a request is not limited.

const FOLLOWING = { direction: 'following', domain: 'many.example', base: 700_000_000_000_000_000 } as const
const FOLLOWERS = { direction: 'followers', domain: 'fans.example', base: 710_000_000_000_000_000 } as const

async function followResponse(h: ApiHarness, user: User, targetId: string, body: Record<string, unknown> = {}) {
	const response = await act(h, user, `/api/v1/accounts/${targetId}/follow`, body)
	return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const followingCount = async (h: ApiHarness, id: string) =>
	(await sql<{ n: number }>(h.store, 'SELECT following_count AS n FROM accounts WHERE id = ?', id))[0]?.n

const edges = (h: ApiHarness, accountId: string, targetId: string) =>
	sql<{ state: string }>(
		h.store,
		'SELECT state FROM follows WHERE account_id = ? AND target_account_id = ?',
		accountId,
		targetId
	)

describe('the follow limit', () => {
	it('is 7,500 below 7,500 follows, and past that 1.1 times the followers when that is more', () => {
		expect(followLimit({ following_count: 0, followers_count: 100_000 })).toBe(FOLLOW_LIMIT)
		expect(followLimit({ following_count: 7_499, followers_count: 100_000 })).toBe(7_500)
		expect(followLimit({ following_count: 7_500, followers_count: 6_818 })).toBe(7_500)
		expect(followLimit({ following_count: 7_500, followers_count: 6_819 })).toBe(7_501)
		expect(followLimit({ following_count: 9_000, followers_count: 10_000 })).toBe(11_000)
	})

	it("refuses a new follow or request at the limit with Mastodon's 422, and records nothing", async () => {
		const h = await community(['alice', 'bob', 'carol', 'dave'])
		const { alice, bob, carol, dave } = h.users
		await sql(h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', dave.id)
		const remote = await remoteAccount(h.store, 'far')
		await seedFollows(h.store, alice.id, 7_499, FOLLOWING)

		// The last follow under the limit is made.
		expect(await followResponse(h, alice, bob.id)).toMatchObject({ status: 200, body: { following: true } })
		expect(await followingCount(h, alice.id)).toBe(7_500)

		const refused = { status: 422, body: { error: 'Validation failed: You cannot follow more than 7500 people' } }
		// A local follow, a request of a locked account and a remote request (FollowRequest has the validator too).
		for (const target of [carol.id, dave.id, remote]) {
			expect(await followResponse(h, alice, target)).toEqual(refused)
			expect(await edges(h, alice.id, target)).toEqual([])
		}
		expect(await sql(h.store, 'SELECT type FROM notifications WHERE account_id IN (?, ?)', carol.id, dave.id)).toEqual(
			[]
		)
		expect((await outbound(h.store)).filter((o) => o.activity.type === 'Follow')).toEqual([])
		expect(await followingCount(h, alice.id)).toBe(7_500)
	})

	it('counts the accepted follows themselves, so an undercounted following_count does not let a follow through', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await seedFollows(h.store, alice.id, 7_500, FOLLOWING)
		// As the authorize path before its recount fix could leave it.
		await sql(h.store, 'UPDATE accounts SET following_count = 7499 WHERE id = ?', alice.id)
		expect(await followResponse(h, alice, bob.id)).toEqual({
			status: 422,
			body: { error: 'Validation failed: You cannot follow more than 7500 people' },
		})
		expect(await edges(h, alice.id, bob.id)).toEqual([])
	})

	it("still changes an existing follow's options at the limit (the validator runs on create)", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, alice, bob.id)
		await seedFollows(h.store, alice.id, 7_499, FOLLOWING)
		expect(await followingCount(h, alice.id)).toBe(7_500)
		expect(await followResponse(h, alice, bob.id, { notify: true })).toMatchObject({
			status: 200,
			body: { following: true, notifying: true },
		})
	})

	it('counts accepted follows only, not pending requests', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await seedFollows(h.store, alice.id, 7_499, FOLLOWING)
		for (const name of ['p1', 'p2', 'p3']) {
			const id = await remoteAccount(h.store, name, 'pending.example')
			await sql(
				h.store,
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'pending')",
				alice.id,
				id
			)
		}
		expect(await followResponse(h, alice, bob.id)).toMatchObject({ status: 200, body: { following: true } })
		expect(await followingCount(h, alice.id)).toBe(7_500)
	})

	it('allows 1.1 times the followers past 7,500 follows, rounded', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await seedFollows(h.store, alice.id, 7_500, FOLLOWING)
		await seedFollows(h.store, alice.id, 6_819, FOLLOWERS)
		expect(await followResponse(h, alice, bob.id)).toMatchObject({ status: 200, body: { following: true } })
		expect(await followResponse(h, alice, carol.id)).toEqual({
			status: 422,
			body: { error: 'Validation failed: You cannot follow more than 7501 people' },
		})
	})

	it('does not limit authorizing a request (FollowRequest#authorize! bypasses it)', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await sql(h.store, 'UPDATE accounts SET locked = 1 WHERE id = ?', bob.id)
		expect(await followResponse(h, alice, bob.id)).toMatchObject({ status: 200, body: { requested: true } })
		await seedFollows(h.store, alice.id, 7_500, FOLLOWING)
		const authorized = await act(h, bob, `/api/v1/follow_requests/${alice.id}/authorize`)
		expect(authorized.status).toBe(200)
		expect(await edges(h, alice.id, bob.id)).toEqual([{ state: 'accepted' }])
		expect(await followingCount(h, alice.id)).toBe(7_501)
		// The authorized follow counts toward the limit after it.
		expect(await followResponse(h, alice, carol.id)).toMatchObject({ status: 422 })
	})
})
