import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { act, community, post, seedStatus } from './status-helpers'
import { LIBRARY_SOURCE_LIMIT, search, type SearchRequest } from '../src/domain/search'
import { sha256Hex } from '../src/security/tokens'

// Search under the B4b review: cursors that reach past each library source's window, work that stays bounded as the
// collections grow (RES-7), and hashtags whose visibility hidden statuses cannot change (VIS-1).

type Results = { statuses: { id: string }[]; hashtags: { name: string }[]; accounts: { id: string }[] }

async function fixture() {
	const h = await community(['alice', 'bob', 'carol'])
	const search = async (q: string, extra = '', token = h.users.alice.token) => {
		const response = await h.request(`/api/v2/search?q=${encodeURIComponent(q)}${extra}`, bearer(token))
		if (response.status !== 200) {
			throw new Error(`search: ${response.status} ${await response.text()}`)
		}
		return response.json<Results>()
	}
	return { h, search }
}

// `count` public statuses by `author` with ids from `base` up, each with `content` (and no search hit for "deep").
async function fillerStatuses(
	h: Awaited<ReturnType<typeof fixture>>['h'],
	author: string,
	count: number,
	base: bigint,
	{ visibility = 'public', tag }: { visibility?: string; tag?: string } = {}
) {
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, search_text)
		SELECT CAST(? + i AS TEXT), 'https://kopje.test/ap/o/f' || ? || '-' || i, ?, ?, '<p>filler</p>',
			'2026-10-12T00:00:00.000Z', 'filler'
		FROM n`,
		count,
		String(base),
		String(base),
		author,
		visibility
	)
	if (tag !== undefined) {
		await sql(
			h.store,
			`INSERT INTO status_tags (status_id, name) SELECT id, ? FROM statuses WHERE CAST(id AS INTEGER) BETWEEN ? AND ?`,
			tag,
			String(base),
			String(base + BigInt(count) - 1n)
		)
	}
}

describe('library cursors reach past each source window', () => {
	for (const source of ['favourites', 'bookmarks', 'boosts'] as const) {
		it(`pages to an old ${source} entry with max_id`, async () => {
			const { h, search } = await fixture()
			const { alice, bob } = h.users
			const old = await post(h, bob, { status: 'deep treasure' })
			const action = { favourites: 'favourite', bookmarks: 'bookmark', boosts: 'reblog' }[source]
			await act(h, alice, `/api/v1/statuses/${old.id}/${action}`)
			// Newer entries of the same kind than the window holds, all of newer statuses.
			const count = LIBRARY_SOURCE_LIMIT + 100
			await fillerStatuses(h, bob.id, count, 300000000000000000n)
			if (source === 'boosts') {
				await sql(
					h.store,
					`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
					SELECT CAST(CAST(id AS INTEGER) + 100000000000000000 AS TEXT), uri || '/boost', ?, id, 'public', published_at
					FROM statuses WHERE account_id = ? AND id >= '300000000000000000'`,
					alice.id,
					bob.id
				)
			} else {
				await sql(
					h.store,
					`INSERT INTO ${source} (account_id, status_id) SELECT ?, id FROM statuses WHERE id >= '300000000000000000' ORDER BY id`,
					alice.id
				)
			}
			const page = await search('deep', `&type=statuses&max_id=${BigInt(old.id) + 1n}`)
			expect(page.statuses.map((s) => s.id)).toEqual([old.id])
		})
	}
})

// Runs the search operation over a SqlStorage that counts the rows each statement reads.
async function rowsRead(
	h: Awaited<ReturnType<typeof fixture>>['h'],
	token: string,
	{
		followingOnly = false,
		...input
	}: Omit<SearchRequest, 'present' | 'localDomain' | 'limit' | 'offset' | 'following'> & {
		followingOnly?: boolean
	}
): Promise<number> {
	const tokenHash = await sha256Hex(token)
	return runInDurableObject(h.store, (_instance, state) => {
		let read = 0
		const real = state.storage.sql
		const counting = {
			exec: (query: string, ...params: SqlStorageValue[]) => {
				const cursor = real.exec(query, ...params)
				return {
					toArray: () => {
						const rows = cursor.toArray()
						read += cursor.rowsRead
						return rows
					},
					get rowsWritten() {
						return cursor.rowsWritten
					},
				}
			},
		} as unknown as SqlStorage
		const result = search.run(counting, {
			credential: { tokenHash, scope: 'read:search', now: NOW },
			limit: 20,
			offset: 0,
			following: followingOnly,
			localDomain: 'kopje.test',
			present: { origin: 'https://kopje.test' },
			...input,
		})
		if (result.status !== 'ok') {
			throw new Error(`search failed: ${result.status}`)
		}
		return read
	})
}

describe('search work is bounded (RES-7)', () => {
	async function library(kind: 'favourites' | 'bookmarks', size: number) {
		const { h } = await fixture()
		const { alice, bob } = h.users
		await fillerStatuses(h, bob.id, size, 300000000000000000n)
		await sql(
			h.store,
			`INSERT INTO ${kind} (account_id, status_id) SELECT ?, id FROM statuses WHERE id >= '300000000000000000' ORDER BY random()`,
			alice.id
		)
		return rowsRead(h, alice.token, { query: 'nothing', types: ['statuses'] })
	}

	for (const kind of ['favourites', 'bookmarks'] as const) {
		it(`reads about as many rows for ${kind} four times as large`, async () => {
			const small = await library(kind, 3000)
			const large = await library(kind, 12000)
			expect(large).toBeLessThan(small * 1.5)
		}, 60_000)
	}

	async function accounts(size: number) {
		const { h } = await fixture()
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
			INSERT INTO accounts (id, uri, username, domain, search_text)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://many.example/users/u' || i, 'u' || i, 'many.example',
				'someone u' || i || '@many.example'
			FROM n`,
			size
		)
		return rowsRead(h, h.users.alice.token, { query: 'nobody', types: ['accounts'] })
	}

	it('reads about as many rows for four times as many known accounts', async () => {
		const small = await accounts(6000)
		const large = await accounts(24000)
		expect(large).toBeLessThan(small * 1.5)
	}, 60_000)

	it('reads about as many rows for hashtags with four times as many statuses', async () => {
		const measure = async (size: number) => {
			const { h } = await fixture()
			await fillerStatuses(h, h.users.bob.id, size, 300000000000000000n, { tag: 'common' })
			return rowsRead(h, h.users.alice.token, { query: 'comm', types: ['hashtags'] })
		}
		const small = await measure(3000)
		const large = await measure(12000)
		expect(large).toBeLessThan(small * 1.5)
	}, 60_000)
})

describe('hashtag results do not depend on hidden statuses (VIS-1)', () => {
	it('keeps a public hashtag when many newer hidden statuses use it', async () => {
		const { h, search } = await fixture()
		const { bob } = h.users
		await post(h, bob, { status: '#apple pie' })
		await fillerStatuses(h, bob.id, 80, 300000000000000000n, { visibility: 'private', tag: 'apple' })
		expect((await search('apple', '&type=hashtags')).hashtags.map((t) => t.name)).toEqual(['apple'])
	})

	it('is not crowded out by names that only hidden statuses use', async () => {
		const { h, search } = await fixture()
		const { bob, carol } = h.users
		for (let i = 0; i < 120; i++) {
			await seedStatus(h.store, {
				accountId: bob.id,
				visibility: 'direct',
				content: '<p>x</p>',
				mentions: [{ accountId: carol.id }],
				tags: [`a${String(i).padStart(3, '0')}`],
			})
		}
		await post(h, bob, { status: '#azz visible' })
		expect((await search('a', '&type=hashtags')).hashtags.map((t) => t.name)).toEqual(['azz'])
	})
})

describe('verification review', () => {
	// `count` remote accounts named `username` (or u<i>) on their own domains, ids from `base` up.
	async function remoteAccounts(
		h: Awaited<ReturnType<typeof fixture>>['h'],
		count: number,
		base: bigint,
		username?: string
	) {
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
			INSERT INTO accounts (id, uri, username, domain, search_text)
			SELECT CAST(? + i AS TEXT), 'https://d' || ? || '-' || i || '.example/users/x', IFNULL(?, 'u' || i),
				'd' || ? || '-' || i || '.example', IFNULL(?, 'u' || i) || '@d' || ? || '-' || i || '.example'
			FROM n`,
			count,
			String(base),
			String(base),
			username ?? null,
			String(base),
			username ?? null,
			String(base)
		)
	}

	it('finds an exact known address outside both discovery windows', async () => {
		const { h, search } = await fixture()
		await remoteAccounts(h, 1100, 500000000000000000n, 'alice')
		const target = await sql<{ id: string }>(
			h.store,
			`INSERT INTO accounts (id, uri, username, domain, search_text)
			VALUES ('600000000000000000', 'https://target.example/users/alice', 'alice', 'target.example', 'alice@target.example')
			RETURNING id`
		)
		await remoteAccounts(h, 5100, 700000000000000000n)
		const found = await search('alice@target.example', '&type=accounts')
		expect(found.accounts.map((a) => a.id)).toEqual([target[0]?.id])
	}, 60_000)

	it('finds an exact followed address beyond the following window', async () => {
		const { h, search } = await fixture()
		const { alice } = h.users
		await remoteAccounts(h, 5100, 500000000000000000n)
		await sql(
			h.store,
			`INSERT INTO accounts (id, uri, username, domain, search_text)
			VALUES ('900000000000000000', 'https://far.example/users/zed', 'zed', 'far.example', 'zed@far.example')`
		)
		await sql(
			h.store,
			`INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts WHERE domain IS NOT NULL`,
			alice.id
		)
		const found = await search('zed@far.example', '&type=accounts&following=true')
		expect(found.accounts.map((a) => a.id)).toEqual(['900000000000000000'])
	}, 60_000)

	it('reads about as many rows for a matching username prefix four times as common', async () => {
		const measure = async (size: number) => {
			const { h } = await fixture()
			await remoteAccounts(h, size, 500000000000000000n)
			return rowsRead(h, h.users.alice.token, { query: 'u', types: ['accounts'] })
		}
		const small = await measure(6000)
		const large = await measure(24000)
		expect(large).toBeLessThan(small * 1.5)
	}, 60_000)

	it('reads about as many rows for following=true with four times as many pending follows', async () => {
		const measure = async (size: number) => {
			const { h } = await fixture()
			await remoteAccounts(h, size, 500000000000000000n)
			await sql(
				h.store,
				`INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'pending' FROM accounts WHERE domain IS NOT NULL`,
				h.users.alice.id
			)
			return runFollowing(h)
		}
		const runFollowing = (h: Awaited<ReturnType<typeof fixture>>['h']) =>
			rowsRead(h, h.users.alice.token, { query: 'nobody', types: ['accounts'], followingOnly: true })
		const small = await measure(4000)
		const large = await measure(16000)
		expect(large).toBeLessThan(small * 1.5)
	}, 60_000)

	it('compares search cursors as numbers', async () => {
		const { h, search } = await fixture()
		const status = await post(h, h.users.alice, { status: 'cursor probe' })
		expect((await search('cursor', '&type=statuses&min_id=9')).statuses.map((s) => s.id)).toEqual([status.id])
		expect((await search('cursor', `&type=statuses&max_id=${'9'.repeat(19)}`)).statuses.map((s) => s.id)).toEqual([
			status.id,
		])
	})

	it('keeps hashtag results the same when hidden mentions crowd the library (VIS-1)', async () => {
		const { h, search } = await fixture()
		const { alice, bob, carol } = h.users
		await post(h, carol, { status: '@alice #needle unlisted', visibility: 'unlisted' })
		const before = (await search('needle', '&type=hashtags')).hashtags.map((t) => t.name)
		await sql(h.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', bob.id, alice.id)
		for (let i = 0; i < 520; i++) {
			await seedStatus(h.store, {
				accountId: bob.id,
				visibility: 'private',
				content: '<p>x</p>',
				mentions: [{ accountId: alice.id }],
			})
		}
		expect((await search('needle', '&type=hashtags')).hashtags.map((t) => t.name)).toEqual(before)
	}, 60_000)
})
