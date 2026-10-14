import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { appToken, DAY_MS, rowsRead, scopedToken } from './read-helpers'
import { community, getJson, seedStatus } from './status-helpers'
import { getTag, MAX_TAG_HISTORY_STATUSES } from '../src/domain/tags'

// GET /api/v1/tags/:id: the Tag entity, its history (VIS-12), the optional token (AUTH-2) and the work bound (RES-7).

type Tag = {
	name: string
	url: string
	history: { day: string; uses: string; accounts: string }[]
	following?: boolean
}

describe('tags', () => {
	const day = (daysAgo: number) => String((NOW - daysAgo * DAY_MS) / 1000)

	it('shows a tag with seven days of history, today first', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const remote = await seedAccount(h.store, { username: 'carol', domain: 'remote.example' })
		const at = (daysAgo: number) => NOW - daysAgo * DAY_MS + 3_600_000
		for (const [accountId, daysAgo, visibility] of [
			[alice.id, 0, 'public'],
			[alice.id, 0, 'unlisted'],
			[bob.id, 0, 'public'],
			[remote, 2, 'public'],
			[remote, 6, 'public'],
			// Outside the window, or hidden from someone: never counted.
			[remote, 7, 'public'],
			[alice.id, 1, 'private'],
			[alice.id, 1, 'direct'],
			[remote, 1, 'limited'],
		] as const) {
			await seedStatus(h.store, { accountId, visibility, tags: ['cats'], published: at(daysAgo) })
		}
		const original = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: at(3) })
		await seedStatus(h.store, { accountId: alice.id, visibility: 'public', reblogOfId: original, tags: ['cats'] })

		const { status, body } = await getJson<Tag>(h, '/api/v1/tags/Cats')
		expect(status).toBe(200)
		expect(body).toEqual({
			name: 'cats',
			url: 'https://kopje.test/tags/cats',
			history: [
				{ day: day(0), uses: '3', accounts: '2' },
				{ day: day(1), uses: '0', accounts: '0' },
				{ day: day(2), uses: '1', accounts: '1' },
				{ day: day(3), uses: '0', accounts: '0' },
				{ day: day(4), uses: '0', accounts: '0' },
				{ day: day(5), uses: '0', accounts: '0' },
				{ day: day(6), uses: '1', accounts: '1' },
			],
		})
		// The same for a signed-in viewer, who follows no tag yet.
		expect((await getJson<Tag>(h, '/api/v1/tags/cats', alice.token)).body).toEqual({ ...body, following: false })
	})

	it('leaves out the statuses of a suspended account (VIS-12)', async () => {
		const h = await community(['alice'])
		await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public', tags: ['cats'] })
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			'2026-01-01',
			h.users.alice.id
		)
		const { body } = await getJson<Tag>(h, '/api/v1/tags/cats')
		expect(body.history[0]).toEqual({ day: day(0), uses: '0', accounts: '0' })
	})

	it('shows an unused tag and answers 404 for a name that is not a hashtag', async () => {
		const h = await apiHarness()
		const unused = await getJson<Tag>(h, `/api/v1/tags/${encodeURIComponent('猫')}`)
		expect(unused.status).toBe(200)
		expect(unused.body.name).toBe('猫')
		expect(unused.body.history.every((entry) => entry.uses === '0')).toBe(true)
		for (const name of ['123', 'a-b', encodeURIComponent('#cats'), 'x'.repeat(1001)]) {
			expect(await getJson(h, `/api/v1/tags/${name}`)).toEqual({ status: 404, body: { error: 'Record not found' } })
		}
	})

	it('reads an optional token: none or an app token is anonymous, a bad one is refused (AUTH-2)', async () => {
		const h = await community(['alice'])
		expect((await getJson<Tag>(h, '/api/v1/tags/cats', await appToken(h))).body).not.toHaveProperty('following')
		expect((await h.request('/api/v1/tags/cats', bearer('nope'))).status).toBe(401)
		expect((await h.request('/api/v1/tags/cats', bearer(await scopedToken(h, 'read:statuses')))).status).toBe(403)
	})

	it('reads only the window and at most MAX_TAG_HISTORY_STATUSES statuses (RES-7)', async () => {
		const measure = async (old: number, recent: number) => {
			const h = await community(['alice'])
			const insert = async (count: number, base: bigint) => {
				await sql(
					h.store,
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					SELECT CAST(? + i AS TEXT), 'https://kopje.test/ap/o/t' || ? || '-' || i, ?, 'public', ? FROM n`,
					count,
					String(base),
					String(base),
					h.users.alice.id,
					new Date(Number(base >> 16n)).toISOString()
				)
				await sql(
					h.store,
					`INSERT INTO status_tags (status_id, name) SELECT id, 'cats' FROM statuses WHERE id >= ? AND id < ?`,
					String(base),
					String(base + BigInt(count))
				)
			}
			// Old statuses a month back, recent ones an hour into today.
			await insert(old, BigInt(NOW - 30 * DAY_MS) << 16n)
			if (recent > 0) {
				await insert(recent, BigInt(NOW + 3_600_000) << 16n)
			}
			const read = await rowsRead(h, getTag, {
				credential: null,
				name: 'cats',
				now: NOW + DAY_MS / 2,
				present: { origin: 'https://kopje.test' },
			})
			const { body } = await getJson<Tag>(h, '/api/v1/tags/cats')
			return { read, body }
		}
		const small = await measure(2000, 100)
		const large = await measure(8000, 100)
		expect(large.read).toBeLessThan(small.read * 1.5)

		const capped = await measure(0, MAX_TAG_HISTORY_STATUSES + 500)
		expect(capped.body.history[0]?.uses).toBe(String(MAX_TAG_HISTORY_STATUSES))
	}, 120_000)
})
