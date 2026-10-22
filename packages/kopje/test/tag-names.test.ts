import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { tagHistoryOf } from './read-helpers'
import { act, community, getJson, seedStatus, type User } from './status-helpers'
import { MAX_TAG_LENGTH, TAG_NAME_BYTES } from '../src/domain/status-bounds'
import { TAG_NAME_TOO_LONG } from '../src/domain/tag-bounds'

// The list bound of a hashtag name (tag-bounds.ts, docs/mastodon-deviations.md "Hashtags"): follows and features past
// it are refused, stored names past it or not round-tripping through strict UTF-8 are left out of every list, and a
// page of followed hashtags still pages by the rows it read.

type Tag = { id: string; name: string; history: unknown[]; following?: boolean; featuring?: boolean }
type FeaturedTag = { id: string; name: string; url: string }

const TOO_LONG = { error: `Validation failed: ${TAG_NAME_TOO_LONG}` }
// A CJK letter of four UTF-8 bytes: MAX_TAG_LENGTH of them are TAG_NAME_BYTES.
const ASTRAL = '\u{20001}'

const path = (name: string) => encodeURIComponent(name)

// Rows written as an import may hold them: the name's bytes as given (text or a blob cast to text).
async function importFollow(h: ApiHarness, user: User, name: string | ArrayBuffer) {
	await sql(h.store, 'INSERT INTO tag_follows (account_id, name) VALUES (?, CAST(? AS TEXT))', user.id, name)
}

async function importFeatured(
	h: ApiHarness,
	user: User,
	name: string | ArrayBuffer,
	display = name,
	id = '990000000000000001'
) {
	await sql(
		h.store,
		`INSERT INTO featured_tags (id, account_id, name, display_name) VALUES (?, ?, CAST(? AS TEXT), CAST(? AS TEXT))`,
		id,
		user.id,
		name,
		display
	)
}

const counts = async (h: ApiHarness) =>
	(
		await sql<{ follows: number; featured: number; outbound: number }>(
			h.store,
			`SELECT (SELECT count(*) FROM tag_follows) AS follows, (SELECT count(*) FROM featured_tags) AS featured,
				(SELECT count(*) FROM outbound_activities) AS outbound`
		)
	)[0]

describe('refusing a follow or a feature past the list bound', () => {
	it('refuses all three writes past 256 code points with a 422, and accepts exactly the bound', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const before = await counts(h)
		const past = 'a'.repeat(MAX_TAG_LENGTH + 1)
		for (const response of [
			await act(h, alice, `/api/v1/tags/${past}/follow`),
			await act(h, alice, `/api/v1/tags/${past}/feature`),
			await act(h, alice, '/api/v1/featured_tags', { name: past }),
		]) {
			expect([response.status, await response.json()]).toEqual([422, TOO_LONG])
		}
		// Nothing was written and nothing sent.
		expect(await counts(h)).toEqual(before)
		// Exactly at the bound: 256 code points, and 256 four-byte ones (1,024 bytes).
		const wide = ASTRAL.repeat(MAX_TAG_LENGTH)
		expect(new TextEncoder().encode(wide).length).toBe(TAG_NAME_BYTES)
		for (const name of ['b'.repeat(MAX_TAG_LENGTH), wide]) {
			expect((await act(h, alice, `/api/v1/tags/${path(name)}/follow`)).status).toBe(200)
		}
		expect((await act(h, alice, `/api/v1/tags/${path('c'.repeat(MAX_TAG_LENGTH))}/feature`)).status).toBe(200)
		expect((await act(h, alice, '/api/v1/featured_tags', { name: wide })).status).toBe(200)
		const followed = (await getJson<Tag[]>(h, '/api/v1/followed_tags', alice.token)).body
		expect(followed.map((tag) => [...tag.name].length)).toEqual([MAX_TAG_LENGTH, MAX_TAG_LENGTH])
		// A name past the bound in astral characters: 257 of them.
		const response = await act(h, alice, `/api/v1/tags/${path(ASTRAL.repeat(MAX_TAG_LENGTH + 1))}/follow`)
		expect([response.status, await response.json()]).toEqual([422, TOO_LONG])
	})

	it('judges the normalized name and, for a featured hashtag, its spelling too', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// U+FDFA is one letter that NFKC expands to 15 (its spaces dropped): 20 of them normalize to 300.
		const expanding = 'ﷺ'.repeat(20)
		for (const response of [
			await act(h, alice, `/api/v1/tags/${path(expanding)}/follow`),
			await act(h, alice, `/api/v1/tags/${path(expanding)}/feature`),
			await act(h, alice, '/api/v1/featured_tags', { name: expanding }),
		]) {
			expect([response.status, await response.json()]).toEqual([422, TOO_LONG])
		}
		// A spelling of 400 code points (a and a combining acute) whose normalized name is 200: refused as featured.
		const spelled = 'á'.repeat(200)
		const featured = await act(h, alice, '/api/v1/featured_tags', { name: spelled })
		expect([featured.status, await featured.json()]).toEqual([422, TOO_LONG])
		// Followed and featured by tag, it is its normalized name, within the bound.
		expect((await act(h, alice, `/api/v1/tags/${path(spelled)}/follow`)).status).toBe(200)
		expect((await act(h, alice, `/api/v1/tags/${path(spelled)}/feature`)).status).toBe(200)
	})

	it('refuses a name an imported row already holds, and still removes the row', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const long = 'a'.repeat(300)
		await importFollow(h, alice, long)
		await importFeatured(h, alice, long)
		const before = await counts(h)
		for (const response of [
			await act(h, alice, `/api/v1/tags/${long}/follow`),
			await act(h, alice, `/api/v1/tags/${long}/feature`),
			await act(h, alice, '/api/v1/featured_tags', { name: long }),
		]) {
			expect([response.status, await response.json()]).toEqual([422, TOO_LONG])
		}
		expect(await counts(h)).toEqual(before)
		// Lists hide them; unfollow, unfeature and deletion remove them.
		expect((await getJson<Tag[]>(h, '/api/v1/followed_tags', alice.token)).body).toEqual([])
		expect((await getJson<FeaturedTag[]>(h, '/api/v1/featured_tags', alice.token)).body).toEqual([])
		expect((await getJson(h, `/api/v1/accounts/${alice.id}/featured_tags`)).body).toEqual([])
		const unfollowed = await act(h, alice, `/api/v1/tags/${long}/unfollow`)
		expect([unfollowed.status, ((await unfollowed.json()) as Tag).following]).toEqual([200, false])
		expect((await act(h, alice, `/api/v1/tags/${long}/unfeature`)).status).toBe(200)
		expect(await counts(h)).toMatchObject({ follows: 0, featured: 0 })
		await importFeatured(h, alice, long, long, '990000000000000002')
		const deleted = await h.request(
			'/api/v1/featured_tags/990000000000000002',
			bearer(alice.token, { method: 'DELETE' })
		)
		expect(deleted.status).toBe(200)
		expect(await counts(h)).toMatchObject({ featured: 0 })
	})
})

describe('stored names in the lists', () => {
	it('leaves names that do not round-trip through strict UTF-8 out of lists, shows them in search by their bytes', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// "cat" and a stray continuation byte, which decodes as "cat�"; and a real "cat�" (its bytes EF BF BD),
		// which an import may hold.
		const malformed = new Uint8Array([0x63, 0x61, 0x74, 0x80]).buffer
		const real = 'cat�'
		await importFollow(h, alice, malformed)
		await importFollow(h, alice, real)
		await importFollow(h, alice, 'cat')
		await importFeatured(h, alice, real, real, '990000000000000002')
		// Public uses today: two of the real name, one of the malformed one, all by alice.
		const tagged = async (tag: string | ArrayBuffer) => {
			const id = await seedStatus(h.store, { accountId: alice.id, visibility: 'public', published: NOW + 3_600_000 })
			await sql(h.store, 'INSERT INTO status_tags (status_id, name, public) VALUES (?, CAST(? AS TEXT), 1)', id, tag)
		}
		await tagged(real)
		await tagged(real)
		await tagged(malformed)

		const followed = (await getJson<Tag[]>(h, '/api/v1/followed_tags', alice.token)).body
		expect(followed.map((tag) => [tag.name, tag.following, tag.featuring])).toEqual([
			['cat', true, false],
			[real, true, true],
		])
		// The real name's history counts its own two uses, never the malformed one's.
		expect(followed[1]?.history).toEqual(tagHistoryOf(NOW, { 0: [2, 1] }))
		expect(new Set(followed.map((tag) => tag.id)).size).toBe(2)
		// v2 search shows both, decoded alike (it pages by offset, so it leaves no row out), each by its own bytes: the
		// malformed one (the shorter to SQLite) with its one use and its follow, the real one with its two, its follow and
		// its feature, and two ids apart from each other and from "cat".
		const searched = (await getJson<{ hashtags: Tag[] }>(h, '/api/v2/search?q=cat&type=hashtags', alice.token)).body
		expect(searched.hashtags.map((tag) => [tag.name, tag.history, tag.following, tag.featuring])).toEqual([
			[real, tagHistoryOf(NOW, { 0: [1, 1] }), true, false],
			[real, followed[1]?.history, true, true],
		])
		expect(searched.hashtags[1]?.id).toBe(followed[1]?.id)
		expect(new Set([...searched.hashtags, ...followed].map((tag) => tag.id)).size).toBe(3)
		const featured = (await getJson<FeaturedTag[]>(h, '/api/v1/featured_tags', alice.token)).body
		expect(featured.map((tag) => tag.name)).toEqual([real])
		expect((await getJson<FeaturedTag[]>(h, `/api/v1/accounts/${alice.id}/featured_tags`)).body).toEqual(featured)
		// Suggestions: the hashtags of alice's statuses she does not feature; the malformed one is left out too.
		await sql(h.store, 'DELETE FROM featured_tags')
		const suggested = (await getJson<Tag[]>(h, '/api/v1/featured_tags/suggestions', alice.token)).body
		expect(suggested.map((tag) => [tag.name, tag.history])).toEqual([[real, followed[1]?.history]])
	})

	it('leaves out bounded malformed bytes and a NUL, and names past the bounds', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		for (const name of [
			new Uint8Array(300).fill(0x80).buffer,
			new Uint8Array([0xed, 0xa0, 0x80]).buffer,
			new Uint8Array([0x61, 0x00, 0x62]).buffer,
			'x'.repeat(TAG_NAME_BYTES + 1),
			'y'.repeat(MAX_TAG_LENGTH + 1),
		]) {
			await importFollow(h, alice, name)
		}
		await importFollow(h, alice, 'kept')
		expect((await getJson<Tag[]>(h, '/api/v1/followed_tags', alice.token)).body.map((tag) => tag.name)).toEqual([
			'kept',
		])
	})
})

describe('paging followed hashtags past names a list leaves out', () => {
	// Every page by the Link header's next, then back by prev from the last; names newest follow first.
	async function walk(h: ApiHarness, user: User, limit: number) {
		const pages: string[][] = []
		let url: string | undefined = `/api/v1/followed_tags?limit=${limit}`
		for (let i = 0; i < 20 && url !== undefined; i++) {
			const response = await h.request(url, bearer(user.token))
			pages.push(((await response.json()) as Tag[]).map((tag) => tag.name))
			const next = /<([^>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
			url = next === undefined ? undefined : new URL(next).pathname + new URL(next).search
		}
		return pages
	}

	it('pages by the rows read, through a mixed page and a page left out whole', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const hidden = (i: number) => `h${i}${'z'.repeat(MAX_TAG_LENGTH)}`
		// Oldest first: v1 v2 H v3 H H v4 H (H a name past the bound), so with pages of two the newest page is [H v4],
		// mixed; the next [H H], left out whole; then [v3 H] and [v2 v1].
		for (const name of ['v1', 'v2', hidden(1), 'v3', hidden(2), hidden(3), 'v4', hidden(4)]) {
			await importFollow(h, alice, name)
		}
		const pages = await walk(h, alice, 2)
		expect(pages).toEqual([['v4'], [], ['v3'], ['v2', 'v1'], []])
		// Newer pages by min_id from the oldest follow reach every valid name too.
		const back: string[] = []
		let cursor = '0'
		for (let i = 0; i < 10; i++) {
			const response = await h.request(`/api/v1/followed_tags?limit=2&min_id=${cursor}`, bearer(alice.token))
			const names = ((await response.json()) as Tag[]).map((tag) => tag.name)
			const prev = /[?&]min_id=(\d+)[^>]*>; rel="prev"/.exec(response.headers.get('link') ?? '')?.[1]
			if (prev === undefined || prev === cursor) {
				break
			}
			back.unshift(...names)
			cursor = prev
		}
		expect(back).toEqual(['v4', 'v3', 'v2', 'v1'])
	})
})

describe('paging v2 search hashtags past malformed names', () => {
	it('advances by the count received with no repeat and no gap', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// cat000 … cat005 and two malformed names among them ("cat0" and "cat00" with a stray byte), each on a public
		// status of alice's.
		const names: (string | ArrayBuffer)[] = ['cat000', 'cat001', 'cat002', 'cat003', 'cat004', 'cat005']
		names.push(
			new Uint8Array([0x63, 0x61, 0x74, 0x30, 0x80]).buffer,
			new Uint8Array([0x63, 0x61, 0x74, 0x30, 0x30, 0x80]).buffer
		)
		for (const name of names) {
			const id = await seedStatus(h.store, { accountId: alice.id, visibility: 'public', published: NOW + 3_600_000 })
			await sql(h.store, 'INSERT INTO status_tags (status_id, name, public) VALUES (?, CAST(? AS TEXT), 1)', id, name)
		}
		const page = async (limit: number, offset: number) =>
			(
				await getJson<{ hashtags: Tag[] }>(
					h,
					`/api/v2/search?q=cat&type=hashtags&limit=${limit}&offset=${offset}`,
					alice.token
				)
			).body.hashtags
		const whole = await page(40, 0)
		expect(whole).toHaveLength(names.length)
		for (const limit of [1, 2, 3]) {
			const seen: Tag[] = []
			for (let offset = 0, i = 0; i < 20; i++) {
				const got = await page(limit, offset)
				if (got.length === 0) {
					break
				}
				seen.push(...got)
				offset += got.length
			}
			expect(seen.map((tag) => tag.id)).toEqual(whole.map((tag) => tag.id))
		}
		expect(new Set(whole.map((tag) => tag.id)).size).toBe(names.length)
	})
})
