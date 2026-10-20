import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { BUILD, completeSetup, migratedStore } from './helpers'
import { ACCESS, setAccess } from './ops-helpers'
import { AT, author, HOUR, round, trendStatus } from './trend-helpers'
import { tagId } from '../src/domain/tags'
import type { StoreStub } from '../src/platform/store-client'
import { MAX_TREND_REVIEWS } from '../src/platform/stored-bounds'

// The Access admin's trends reviews (domain/trends.ts, app/admin.ts /admin/trends): Access only (AUTH-5), logged
// (VIS-29), immediate, and capped at MAX_TREND_REVIEWS new keys per table (RES-4).

const ORIGIN = 'https://kopje.test'

async function adminStore(): Promise<StoreStub> {
	const store = await migratedStore()
	await setAccess(store)
	await completeSetup(store)
	return store
}

describe('trends reviews', () => {
	it('refuses anyone but the Access admin, and a name that is not a hashtag', async () => {
		const store = await adminStore()
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
		const store = await adminStore()
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
