import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { BUILD } from './helpers'
import { ACCESS, accessAdminStore } from './ops-helpers'
import { AT, author, authors, HOUR, linkPosts, round, storedLink, trendStatus } from './trend-helpers'
import { idOfBytes, tagId } from '../src/domain/tags'
import type { ImportAuthority } from '../src/platform/store-admin'
import type { StoreStub } from '../src/platform/store-client'
import { MAX_TREND_REVIEWS } from '../src/platform/stored-bounds'

// The Access admin's trends reviews (domain/trends.ts, app/admin.ts /admin/trends): Access only (AUTH-5), logged
// (VIS-29), immediate, and capped at MAX_TREND_REVIEWS new keys per table (RES-4).

const ORIGIN = 'https://kopje.test'

describe('trends reviews', () => {
	it('refuses anyone but the Access admin, and a name that is not a hashtag', async () => {
		const store = await accessAdminStore()
		const token = { kind: 'import-token' } as const
		for (const result of [
			await store.reviewTrendTag(BUILD, { authority: token, name: 'x', trendable: true, origin: ORIGIN }),
			await store.adminTrendTags(BUILD, { authority: token, offset: 0, limit: 20, origin: ORIGIN }),
			await store.adminTrendStatuses(BUILD, { authority: token, offset: 0, limit: 20 }),
		]) {
			expect(result).toMatchObject({ ok: false, code: 'wrong-authority' })
		}
		for (const name of ['', 'a b', '#', 'é'.repeat(257), '\u{1F600}'.repeat(257)]) {
			expect(
				await store.reviewTrendTag(BUILD, { authority: ACCESS, name, trendable: true, origin: ORIGIN }),
				name
			).toMatchObject({ ok: false, code: 'invalid-tag' })
		}
		expect(
			await store.reviewTrendStatus(BUILD, {
				authority: ACCESS,
				id: '999999999999999999',
				trendable: true,
				author: false,
			})
		).toMatchObject({ ok: false, code: 'trend-status-not-found' })
		expect(await sql(store, 'SELECT count(*) AS n FROM admin_actions')).toEqual([{ n: 0 }])
	})

	it('logs each decision and updates a stored one at 10,000, refusing a new one', async () => {
		const store = await accessAdminStore()
		await sql(
			store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO tag_trend_reviews (name, trendable, reviewed_at) SELECT 't' || i, 0, ?2 FROM n`,
			MAX_TREND_REVIEWS,
			new Date(AT).toISOString()
		)
		const stored = await store.reviewTrendTag(BUILD, { authority: ACCESS, name: 'T1', trendable: true, origin: ORIGIN })
		expect(stored).toMatchObject({ ok: true, tag: { name: 't1', trendable: true, requires_review: false, score: 0 } })
		expect(
			await store.reviewTrendTag(BUILD, { authority: ACCESS, name: 'fresh', trendable: true, origin: ORIGIN })
		).toMatchObject({ ok: false, code: 'review-limit' })
		const a = await author(store, 'a', { domain: 'remote.example' })
		const post = await trendStatus(store, { author: a, published: Date.now() - HOUR, favourites: 9 })
		expect(
			await store.reviewTrendStatus(BUILD, { authority: ACCESS, id: post, trendable: false, author: true })
		).toEqual({ ok: true, id: post, trendable: false, status: null })
		await round(store, Date.now())
		const listed = await store.adminTrendStatuses(BUILD, { authority: ACCESS, offset: 0, limit: 40 })
		expect(listed).toMatchObject({
			ok: true,
			statuses: [{ id: post, trendable: false, requires_review: false, account: { id: a, acct: 'a@remote.example' } }],
			settings: { trends: true, trendable_by_default: false },
		})
		expect(await sql(store, 'SELECT action, target_type, target_id, detail FROM admin_actions ORDER BY id')).toEqual([
			{
				action: 'approve',
				target_type: 'Tag',
				target_id: tagId('t1'),
				detail: '{"name":"t1","identity":"admin@kopje.test"}',
			},
			{
				action: 'reject',
				target_type: 'Account',
				target_id: a,
				detail: `{"status":"${post}","identity":"admin@kopje.test"}`,
			},
		])
	})
})

describe('link and publisher reviews (0071_link_trends)', () => {
	const LINK = 'https://a.news.example/story'

	// A public post with a qualifying copy of LINK, and LINK stored with a score.
	async function linked(store: StoreStub) {
		const [a] = await authors(store, 1)
		const [id] = await linkPosts(store, [a!], LINK, AT - HOUR)
		await storedLink(store, LINK, 3, 3, AT)
		return id!
	}

	it('refuses anyone but the Access admin, and its twin reviews', async () => {
		const store = await accessAdminStore()
		await linked(store)
		const calls = (authority: ImportAuthority) => [
			store.adminTrendLinks(BUILD, { authority, offset: 0, limit: 20 }),
			store.adminTrendPublishers(BUILD, { authority, offset: 0, limit: 100 }),
			store.reviewTrendLink(BUILD, { authority, url: LINK, trendable: true, publisher: false }),
			store.reviewTrendPublisher(BUILD, { authority, domain: 'news.example', trendable: true }),
		]
		for (const authority of [{ kind: 'import-token' } as const, { kind: 'import-session', secret: 'x' } as const]) {
			for (const result of await Promise.all(calls(authority))) {
				expect(result).toMatchObject({ ok: false, code: 'wrong-authority' })
			}
		}
		expect(await sql(store, 'SELECT count(*) AS n FROM admin_actions')).toEqual([{ n: 0 }])
		for (const result of await Promise.all(calls(ACCESS))) {
			expect(result).toMatchObject({ ok: true })
		}
		expect(await sql(store, 'SELECT count(*) AS n FROM admin_actions')).toEqual([{ n: 2 }])
	})

	it('refuses an invalid link, one no public post shows, and a domain that is not one', async () => {
		const store = await accessAdminStore()
		const id = await linked(store)
		for (const url of [
			'',
			'http://a.news.example/',
			'https://a.news.example/|',
			`https://x.example/${'a'.repeat(2048)}`,
		]) {
			expect(
				await store.reviewTrendLink(BUILD, { authority: ACCESS, url, trendable: true, publisher: false }),
				url.slice(0, 40)
			).toMatchObject({ ok: false, code: 'invalid-link' })
		}
		// Its twin is found; an unlisted copy is no public post's.
		expect(
			await store.reviewTrendLink(BUILD, { authority: ACCESS, url: LINK, trendable: true, publisher: false })
		).toMatchObject({ ok: true, link: { url: LINK, trendable: true, requires_review: false, score: 3 } })
		await sql(store, 'UPDATE status_cards SET public = 0 WHERE status_id = ?', id)
		expect(
			await store.reviewTrendLink(BUILD, { authority: ACCESS, url: LINK, trendable: true, publisher: false })
		).toMatchObject({ ok: false, code: 'link-not-found' })
		for (const domain of ['example', 'news.example:443', 'a b.example', `${'a'.repeat(250)}.example`, '']) {
			expect(
				await store.reviewTrendPublisher(BUILD, { authority: ACCESS, domain, trendable: true }),
				domain.slice(0, 40)
			).toMatchObject({ ok: false, code: 'invalid-domain' })
		}
		expect(
			await store.reviewTrendPublisher(BUILD, { authority: ACCESS, domain: 'News.Example.', trendable: false })
		).toMatchObject({ ok: true, publisher: { domain: 'news.example', trendable: false } })
	})

	it('reviews the publisher that decides a link with publisher, dropping the link’s own review, each logged', async () => {
		const store = await accessAdminStore()
		await linked(store)
		const link = (publisher: boolean, trendable: boolean) =>
			store.reviewTrendLink(BUILD, { authority: ACCESS, url: LINK, trendable, publisher })
		expect(await link(false, true)).toMatchObject({ ok: true, link: { trendable: true, publisher: null } })
		// No publisher review yet: one for the link's own domain; the link's review is dropped.
		expect(await link(true, false)).toMatchObject({
			ok: true,
			link: {
				url: LINK,
				domain: 'a.news.example',
				trendable: false,
				reviewed_at: null,
				publisher: { domain: 'a.news.example', trendable: false },
			},
		})
		expect(await sql(store, 'SELECT count(*) AS n FROM link_trend_reviews')).toEqual([{ n: 0 }])
		// With a nearer review on news.example only, publisher reviews that one.
		await sql(store, "DELETE FROM link_provider_reviews WHERE domain = 'a.news.example'")
		await store.reviewTrendPublisher(BUILD, { authority: ACCESS, domain: 'news.example', trendable: false })
		expect(await link(true, true)).toMatchObject({
			ok: true,
			link: { publisher: { domain: 'news.example', trendable: true } },
		})
		const listed = await store.adminTrendLinks(BUILD, { authority: ACCESS, offset: 0, limit: 20 })
		expect(listed).toMatchObject({
			ok: true,
			links: [{ url: LINK, title: 'A title', provider_name: 'A publisher', language: 'en', trendable: true }],
		})
		expect(await store.adminTrendPublishers(BUILD, { authority: ACCESS, offset: 0, limit: 100 })).toEqual({
			ok: true,
			publishers: [{ domain: 'news.example', trendable: true, reviewed_at: expect.any(String) }],
		})
		const identity = 'admin@kopje.test'
		expect(await sql(store, 'SELECT action, target_type, target_id, detail FROM admin_actions ORDER BY id')).toEqual([
			{
				action: 'approve',
				target_type: 'PreviewCard',
				target_id: idOfBytes(new TextEncoder().encode(LINK)),
				detail: JSON.stringify({ url: LINK, identity }),
			},
			{
				action: 'reject',
				target_type: 'PreviewCardProvider',
				target_id: 'a.news.example',
				detail: JSON.stringify({ domain: 'a.news.example', url: LINK, identity }),
			},
			{
				action: 'reject',
				target_type: 'PreviewCardProvider',
				target_id: 'news.example',
				detail: JSON.stringify({ domain: 'news.example', identity }),
			},
			{
				action: 'approve',
				target_type: 'PreviewCardProvider',
				target_id: 'news.example',
				detail: JSON.stringify({ domain: 'news.example', url: LINK, identity }),
			},
		])
	})

	it('updates a stored decision at 10,000 and refuses a new one, for links and publishers', async () => {
		const store = await accessAdminStore()
		await linked(store)
		for (const [table, key, of] of [
			['link_trend_reviews', 'url', "'https://r.example/' || i"],
			['link_provider_reviews', 'domain', "'r' || i || '.example'"],
		] as const) {
			await sql(
				store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO ${table} (${key}, trendable, reviewed_at) SELECT ${of}, 0, ?2 FROM n`,
				MAX_TREND_REVIEWS,
				new Date(AT).toISOString()
			)
		}
		expect(
			await store.reviewTrendLink(BUILD, { authority: ACCESS, url: LINK, trendable: true, publisher: false })
		).toMatchObject({ ok: false, code: 'review-limit' })
		expect(
			await store.reviewTrendLink(BUILD, { authority: ACCESS, url: LINK, trendable: true, publisher: true })
		).toMatchObject({ ok: false, code: 'review-limit' })
		expect(
			await store.reviewTrendPublisher(BUILD, { authority: ACCESS, domain: 'fresh.example', trendable: true })
		).toMatchObject({ ok: false, code: 'review-limit' })
		expect(
			await store.reviewTrendPublisher(BUILD, { authority: ACCESS, domain: 'r1.example', trendable: true })
		).toMatchObject({ ok: true, publisher: { domain: 'r1.example', trendable: true } })
		await sql(store, "DELETE FROM link_trend_reviews WHERE url = 'https://r.example/1'")
		expect(
			await store.reviewTrendLink(BUILD, { authority: ACCESS, url: LINK, trendable: true, publisher: false })
		).toMatchObject({ ok: true })
	})
})
