import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { ACCESS, accessAdminStore } from './ops-helpers'
import { historyModel, type HistoryUse } from './policy-model'
import { DAY_MS, tagHistoryOf } from './read-helpers'
import { act, block, community, getJson, mute, seedStatus, type User } from './status-helpers'
import { setTrendSetting } from './trend-helpers'
import { followedTags, LISTED_HISTORY_ROWS, TREND_HISTORY_ROWS } from '../src/domain/tags'
import { adminTrendTags, trendingTags } from '../src/domain/trends'
import { sha256Hex } from '../src/security/tokens'

// A Tag's history on every endpoint that presents one (VIS-12, MD-5): GET /api/v1/tags/:id counts the hashtag's whole
// public range of the seven days; the lists (v2 search hashtags, followed_tags, featured_tags/suggestions) its newest
// LISTED_HISTORY_ROWS public uses, the trends lists its newest TREND_HISTORY_ROWS, each before the rule. Expected
// arrays are written out and checked against the model (test/policy-model.ts historyModel).

type Tag = {
	id: string
	name: string
	url: string
	history: { day: string; uses: string; accounts: string }[]
	following?: boolean
	featuring?: boolean
}

const HOUR = 3_600_000

// The history as [uses, accounts] per day, today first.

// The hashtag `name` as each endpoint presents it to `user`: the single Tag, and the list entries of followed_tags,
// v2 search and featured_tags/suggestions (undefined where the list does not hold it).
async function everywhere(h: ApiHarness, user: User, name: string) {
	const tag = (await getJson<Tag>(h, `/api/v1/tags/${encodeURIComponent(name)}`, user.token)).body
	const followed = (await getJson<Tag[]>(h, '/api/v1/followed_tags?limit=200', user.token)).body
	const searched = (
		await getJson<{ hashtags: Tag[] }>(
			h,
			`/api/v2/search?q=${encodeURIComponent(name)}&type=hashtags&limit=40`,
			user.token
		)
	).body.hashtags
	const suggested = (await getJson<Tag[]>(h, '/api/v1/featured_tags/suggestions', user.token)).body
	const named = (tags: Tag[]) => tags.find((entry) => entry.name === name)
	return { tag, followed: named(followed), searched: named(searched), suggested: named(suggested) }
}

// `count` public statuses of `accountId` tagged `name`, published (and received) a second apart from `at`, in one
// statement; `boost` makes each a boost of that status carrying the hashtag row, as a legacy import may.
async function uses(
	h: Pick<ApiHarness, 'store'>,
	options: { name: string; accountId: string; count: number; at: number; boost?: string }
) {
	const base = BigInt(options.at) << 16n
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
		SELECT CAST(CAST(?2 AS INTEGER) + i * 65536000 AS TEXT), 'https://kopje.test/ap/o/h' || ?2 || '-' || i, ?3, ?4,
			'public', strftime('%Y-%m-%dT%H:%M:%fZ', ?5 / 1000.0 + i, 'unixepoch') FROM n`,
		options.count,
		String(base),
		options.accountId,
		options.boost ?? null,
		options.at
	)
	await sql(
		h.store,
		`INSERT INTO status_tags (status_id, name, public) SELECT id, ?1, 1 FROM statuses
		WHERE uri GLOB 'https://kopje.test/ap/o/h' || ?2 || '-*'`,
		options.name,
		String(base)
	)
}

describe('tag history on every endpoint (VIS-12, MD-5)', () => {
	it('shows the same seven days everywhere, counting public originals of available authors only', async () => {
		const h = await community(['alice', 'bob', 'dave'])
		const { alice, bob, dave } = h.users
		const carol = await seedAccount(h.store, { username: 'carol', domain: 'remote.example' })
		const erin = await seedAccount(h.store, { username: 'erin', domain: 'far.example' })
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?', '2026-01-01', dave.id)
		// alice blocks erin and mutes bob: an anonymous aggregate still counts them.
		await block(h.store, alice.id, erin)
		await mute(h.store, alice.id, bob.id)
		const at = (daysAgo: number, hours = 1) => NOW - daysAgo * DAY_MS + hours * HOUR
		const fixture: { author: string; daysAgo: number; visibility: 'public' | 'unlisted' | 'private' | 'direct' }[] = [
			{ author: alice.id, daysAgo: 0, visibility: 'public' },
			{ author: alice.id, daysAgo: 0, visibility: 'public' },
			{ author: bob.id, daysAgo: 0, visibility: 'public' },
			// A suspended author: never counted.
			{ author: dave.id, daysAgo: 0, visibility: 'public' },
			{ author: erin, daysAgo: 1, visibility: 'public' },
			// The same author on another day counts again there.
			{ author: alice.id, daysAgo: 2, visibility: 'public' },
			{ author: carol, daysAgo: 2, visibility: 'public' },
			{ author: carol, daysAgo: 6, visibility: 'public' },
			// Outside the seven days, or not public: never counted.
			{ author: carol, daysAgo: 7, visibility: 'public' },
			{ author: bob.id, daysAgo: 0, visibility: 'unlisted' },
			{ author: alice.id, daysAgo: 1, visibility: 'private' },
			{ author: alice.id, daysAgo: 1, visibility: 'direct' },
		]
		const model: HistoryUse[] = []
		for (const [i, use] of fixture.entries()) {
			const published = at(use.daysAgo, 1 + i / 100)
			await seedStatus(h.store, { accountId: use.author, visibility: use.visibility, tags: ['cats'], published })
			model.push({
				received: published,
				published,
				public: use.visibility === 'public',
				original: true,
				available: use.author !== dave.id,
				author: use.author,
			})
		}
		// A public boost carrying the hashtag row (a legacy import's): in the range, never counted.
		const original = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: at(3) })
		const boost = at(3, 2)
		await seedStatus(h.store, {
			accountId: alice.id,
			visibility: 'public',
			reblogOfId: original,
			tags: ['cats'],
			published: boost,
		})
		model.push({ received: boost, published: boost, public: true, original: false, available: true, author: alice.id })
		await act(h, alice, '/api/v1/tags/dogs/follow')
		await act(h, alice, '/api/v1/tags/cats/follow')

		const expected = [
			[3, 2],
			[1, 1],
			[2, 2],
			[0, 0],
			[0, 0],
			[0, 0],
			[1, 1],
		]
		expect(historyModel(model, NOW, 'full')).toEqual(expected)
		expect(historyModel(model, NOW, LISTED_HISTORY_ROWS)).toEqual(expected)
		const shown = await everywhere(h, alice, 'cats')
		expect(shown.tag.history).toEqual(tagHistoryOf(NOW, { 0: [3, 2], 1: [1, 1], 2: [2, 2], 6: [1, 1] }))
		for (const entry of [shown.followed, shown.searched, shown.suggested]) {
			expect(entry?.history).toEqual(shown.tag.history)
		}
		// The relationship fields stay; anonymous, bob and alice see the same counts.
		expect([shown.followed?.following, shown.followed?.featuring]).toEqual([true, false])
		expect([shown.suggested?.following, shown.searched?.following]).toEqual([true, true])
		expect((await getJson<Tag>(h, '/api/v1/tags/cats')).body.history).toEqual(shown.tag.history)
		expect((await everywhere(h, bob, 'cats')).searched?.history).toEqual(shown.tag.history)
		// An unused hashtag has seven empty days; the followed list keeps its order, newest follow first.
		const followed = (await getJson<Tag[]>(h, '/api/v1/followed_tags', alice.token)).body
		expect(followed.map((tag) => [tag.name, tag.history])).toEqual([
			['cats', shown.tag.history],
			['dogs', tagHistoryOf(NOW)],
		])
	})

	it(`counts the newest ${LISTED_HISTORY_ROWS} public uses in a list, every one for a single hashtag`, async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await act(h, alice, '/api/v1/tags/cats/follow')
		await uses(h, { name: 'cats', accountId: alice.id, count: LISTED_HISTORY_ROWS + 1, at: NOW + HOUR })
		const shown = await everywhere(h, alice, 'cats')
		expect(shown.tag.history).toEqual(tagHistoryOf(NOW, { 0: [LISTED_HISTORY_ROWS + 1, 1] }))
		for (const entry of [shown.followed, shown.searched, shown.suggested]) {
			expect(entry?.history).toEqual(tagHistoryOf(NOW, { 0: [LISTED_HISTORY_ROWS, 1] }))
		}
	})

	it('lets a list undercount: newer unavailable and boost uses take the slots before the rule', async () => {
		const h = await community(['alice', 'dave'])
		const { alice, dave } = h.users
		await act(h, alice, '/api/v1/tags/cats/follow')
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?', '2026-01-01', dave.id)
		// One counted use, then LISTED_HISTORY_ROWS newer public uses that are not: a suspended author's and boosts.
		await uses(h, { name: 'cats', accountId: alice.id, count: 1, at: NOW + HOUR })
		const original = await seedStatus(h.store, { accountId: alice.id, visibility: 'public', published: NOW })
		const half = LISTED_HISTORY_ROWS / 2
		await uses(h, { name: 'cats', accountId: dave.id, count: half, at: NOW + 2 * HOUR })
		for (let i = 0; i < half; i++) {
			const booster = await seedAccount(h.store, { username: `b${i}`, domain: 'remote.example' })
			await uses(h, { name: 'cats', accountId: booster, count: 1, at: NOW + 3 * HOUR + i * 1000, boost: original })
		}
		const shown = await everywhere(h, alice, 'cats')
		expect(shown.tag.history).toEqual(tagHistoryOf(NOW, { 0: [1, 1] }))
		expect(shown.followed?.history).toEqual(tagHistoryOf(NOW))
		expect(shown.searched?.history).toEqual(tagHistoryOf(NOW))
		const model = [
			{ author: alice.id, original: true, available: true },
			...Array.from({ length: half }, () => ({ author: dave.id, original: true, available: false })),
			...Array.from({ length: half }, (_, i) => ({ author: `b${i}`, original: false, available: true })),
		].map((use, i) => ({ ...use, received: NOW + HOUR + i, published: NOW + HOUR + i, public: true }))
		expect(historyModel(model, NOW, 'full')[0]).toEqual([1, 1])
		expect(historyModel(model, NOW, LISTED_HISTORY_ROWS)[0]).toEqual([0, 0])
	})

	it("rolls over at UTC midnight by the credential's time", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await act(h, alice, '/api/v1/tags/cats/follow')
		await uses(h, { name: 'cats', accountId: alice.id, count: 2, at: NOW + 23 * HOUR })
		const tokenHash = await sha256Hex(alice.token)
		const at = async (now: number) => {
			const result = await runInDurableObject(h.store, (_instance, state) =>
				followedTags.run(state.storage.sql, {
					credential: { tokenHash, scope: 'read', now },
					page: { limit: 40 },
					present: { origin: 'https://kopje.test' },
				})
			)
			if (result.status !== 'ok') {
				throw new Error(result.status)
			}
			return result.value.items[0]?.history
		}
		expect(await at(NOW + DAY_MS - 1)).toEqual(tagHistoryOf(NOW, { 0: [2, 1] }))
		expect(await at(NOW + DAY_MS)).toEqual(tagHistoryOf(NOW + DAY_MS, { 1: [2, 1] }))
		// Six days on the uses are the oldest day; seven days on they are out.
		expect(await at(NOW + 7 * DAY_MS - 1)).toEqual(tagHistoryOf(NOW + 6 * DAY_MS, { 6: [2, 1] }))
		expect(await at(NOW + 7 * DAY_MS)).toEqual(tagHistoryOf(NOW + 7 * DAY_MS))
	})

	it(`counts the newest ${TREND_HISTORY_ROWS} public uses on both trends lists`, async () => {
		const store = await accessAdminStore()
		const h = { store }
		await setTrendSetting(store, 'trendable_by_default', true)
		const author = await seedAccount(store, { username: 'carol', domain: 'remote.example' })
		await sql(
			store,
			"INSERT INTO trend_tags (name, score, max_score, max_score_at) VALUES ('cats', 10, 10, ?)",
			new Date(NOW).toISOString()
		)
		await uses(h, { name: 'cats', accountId: author, count: TREND_HISTORY_ROWS + 1, at: NOW + HOUR })
		const listed = await runInDurableObject(store, (_instance, state) =>
			trendingTags.run(state.storage.sql, {
				credential: null,
				offset: 0,
				limit: 20,
				now: NOW + 12 * HOUR,
				present: { origin: 'https://kopje.test' },
			})
		)
		expect(listed.status === 'ok' && listed.value.items.map((tag) => tag.history)).toEqual([
			tagHistoryOf(NOW, { 0: [TREND_HISTORY_ROWS, 1] }),
		])
		const admin = await runInDurableObject(store, (_instance, state) =>
			adminTrendTags.run(state.storage.sql, {
				authority: ACCESS,
				offset: 0,
				limit: 20,
				now: NOW + 12 * HOUR,
				origin: 'https://kopje.test',
			})
		)
		expect(admin.ok && admin.tags.map((tag) => tag.history)).toEqual([
			tagHistoryOf(NOW, { 0: [TREND_HISTORY_ROWS, 1] }),
		])
	})
})
