import { describe, expect, it } from 'vitest'

import { bearer, login, sql } from './api-helpers'
import { act, block, community, follow, mute, post, remoteAccount, seedStatus } from './status-helpers'
import { HASHTAG_CANDIDATES, LIBRARY_SOURCE_LIMIT } from '../src/domain/search'

type Results = {
	accounts: { id: string; acct: string }[]
	statuses: { id: string; content: string }[]
	hashtags: { name: string; url: string; history: [] }[]
}

async function fixture() {
	const h = await community(['alice', 'bob', 'carol'])
	const search = async (q: string, extra = '', token = h.users.alice.token) => {
		const response = await h.request(`/api/v2/search?q=${encodeURIComponent(q)}${extra}`, bearer(token))
		if (response.status !== 200) {
			throw new Error(`search: ${response.status} ${await response.text()}`)
		}
		return response.json<Results>()
	}
	const statusIds = async (q: string, extra = '', token?: string) =>
		(await search(q, `&type=statuses${extra}`, token)).statuses.map((s) => s.id)
	return { h, search, statusIds }
}

describe('GET /api/v2/search', () => {
	it('refuses unauthenticated search and tokens without read:search', async () => {
		const { h } = await fixture()
		expect((await h.request('/api/v2/search?q=alice')).status).toBe(401)
		const { token } = await login(h, { scope: 'read:accounts', email: 'alice@example.com' })
		expect((await h.request('/api/v2/search?q=alice', bearer(token))).status).toBe(403)
		const { token: searcher } = await login(h, { scope: 'read:search', email: 'alice@example.com' })
		expect((await h.request('/api/v2/search?q=alice', bearer(searcher))).status).toBe(200)
	})

	it('finds statuses in the viewer’s library: own, boosted, favourited, bookmarked and mentioned', async () => {
		const { h, statusIds } = await fixture()
		const { alice, bob, carol } = h.users
		const own = await post(h, alice, { status: 'library own' })
		const boosted = await post(h, bob, { status: 'library boosted' })
		const favourited = await post(h, bob, { status: 'library favourited' })
		const bookmarked = await post(h, carol, { status: 'library bookmarked' })
		const mentioned = await post(h, carol, { status: '@alice library mentioned' })
		const elsewhere = await post(h, bob, { status: 'library unrelated' })
		await act(h, alice, `/api/v1/statuses/${boosted.id}/reblog`)
		await act(h, alice, `/api/v1/statuses/${favourited.id}/favourite`)
		await act(h, alice, `/api/v1/statuses/${bookmarked.id}/bookmark`)
		expect(await statusIds('library')).toEqual(
			[own, boosted, favourited, bookmarked, mentioned]
				.map((s) => s.id)
				.sort()
				.reverse()
		)
		expect(await statusIds('library')).not.toContain(elsewhere.id)
		// AND terms, exclusion, and NFKC and kana variants.
		expect(await statusIds('library -boosted -favourited -bookmarked -mentioned')).toEqual([own.id])
		const kana = await post(h, alice, { status: 'ＡＢＣ　ねこのサーバー' })
		expect(await statusIds('abc ネコ')).toEqual([kana.id])
		expect(await statusIds('サーバ')).toEqual([kana.id])
	})

	it('never returns a status the viewer may not see, even from the library (VIS-1, private status in search)', async () => {
		const { h, statusIds } = await fixture()
		const { alice, bob, carol } = h.users
		// A direct status between bob and carol, and a private one of bob's, that alice has rows for anyway.
		const direct = await seedStatus(h.store, {
			accountId: bob.id,
			visibility: 'direct',
			content: '<p>secret direct</p>',
			mentions: [{ accountId: carol.id }],
		})
		const priv = await seedStatus(h.store, {
			accountId: bob.id,
			visibility: 'private',
			content: '<p>secret private</p>',
		})
		for (const id of [direct, priv]) {
			await sql(h.store, 'INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', alice.id, id)
			await sql(h.store, 'INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)', alice.id, id)
		}
		expect(await statusIds('secret')).toEqual([])
		// carol, mentioned, finds the direct status.
		expect(await statusIds('secret', '', carol.token)).toEqual([direct])
		// A follower sees the private one once it is in their library.
		await follow(h, alice, bob.id)
		expect(await statusIds('secret')).toEqual([priv])
		// account_id searches that account's statuses, still under the rule.
		const open = await post(h, bob, { status: 'secret public' })
		expect(await statusIds('secret', `&account_id=${bob.id}`, carol.token)).toEqual([open.id, direct])
	})

	it('drops a boosted status that became inaccessible, and authors the viewer filters (VIS-1, VIS-5)', async () => {
		const { h, statusIds } = await fixture()
		const { alice, bob, carol } = h.users
		const boosted = await post(h, bob, { status: 'boosted once' })
		await act(h, alice, `/api/v1/statuses/${boosted.id}/reblog`)
		expect(await statusIds('boosted')).toEqual([boosted.id])
		await block(h.store, bob.id, alice.id)
		expect(await statusIds('boosted')).toEqual([])
		const muted = await post(h, carol, { status: '@alice boosted muted' })
		expect(await statusIds('boosted')).toEqual([muted.id])
		await mute(h.store, alice.id, carol.id)
		expect(await statusIds('boosted')).toEqual([])
	})

	it('filters before LIMIT and pages by max_id, min_id and offset (RES-7)', async () => {
		const { h, statusIds } = await fixture()
		const { alice, bob } = h.users
		const visible = await post(h, bob, { status: '@alice page visible' })
		for (let i = 0; i < 3; i++) {
			const hidden = await seedStatus(h.store, {
				accountId: bob.id,
				visibility: 'private',
				content: '<p>page hidden</p>',
			})
			await sql(h.store, 'INSERT INTO bookmarks (account_id, status_id) VALUES (?, ?)', alice.id, hidden)
		}
		expect(await statusIds('page', '&limit=1')).toEqual([visible.id])
		const newer = await post(h, alice, { status: 'page newer' })
		expect(await statusIds('page', '&limit=1')).toEqual([newer.id])
		expect(await statusIds('page', '&limit=1&offset=1')).toEqual([visible.id])
		expect(await statusIds('page', `&max_id=${newer.id}`)).toEqual([visible.id])
		expect(await statusIds('page', `&min_id=${visible.id}`)).toEqual([newer.id])
	})

	it('finds hashtags by prefix, exact first, only where the viewer can see a status with them', async () => {
		const { h, search } = await fixture()
		const { alice, bob, carol } = h.users
		await post(h, bob, { status: '#cats #catsofkopje #cat' })
		await seedStatus(h.store, {
			accountId: bob.id,
			visibility: 'direct',
			content: '<p>x</p>',
			mentions: [{ accountId: carol.id }],
			tags: ['catsecret'],
		})
		const tags = (await search('#cat', '&type=hashtags')).hashtags
		expect(tags.map((t) => t.name)).toEqual(['cat', 'cats', 'catsofkopje'])
		expect(tags[0]).toEqual({ name: 'cat', url: 'https://kopje.test/tags/cat', history: [] })
		expect((await search('cat', '&type=hashtags', carol.token)).hashtags.map((t) => t.name)).toContain('catsecret')
		expect((await search('ＣＡＴ', '&type=hashtags&limit=1&offset=1')).hashtags.map((t) => t.name)).toEqual(['cats'])
		void alice
	})

	it('answers every type by default, accounts included, and an unknown type with nothing', async () => {
		const { h, search } = await fixture()
		await remoteAccount(h.store, 'alicia', 'remote.example')
		await post(h, h.users.alice, { status: 'about alic #alicetag' })
		const all = await search('alic')
		expect(all.accounts.map((a) => a.acct).sort()).toEqual(['alice', 'alicia@remote.example'])
		expect(all.statuses).toHaveLength(1)
		expect(all.hashtags.map((t) => t.name)).toEqual(['alicetag'])
		expect(await search('alic', '&type=lists')).toEqual({ accounts: [], statuses: [], hashtags: [] })
		expect((await search('alic', '&type=accounts&following=true')).accounts).toEqual([])
	})

	it('answers resolve=true from local data (remote resolution is B1b-2)', async () => {
		const { h, search } = await fixture()
		await post(h, h.users.alice, { status: 'resolve me' })
		const results = await search('https://elsewhere.example/@someone/1 resolve', '&resolve=true')
		expect(results.accounts).toEqual([])
		expect((await search('resolve', '&resolve=true')).statuses).toHaveLength(1)
	})

	it('bounds the query, the limit and the offset (RES-1, RES-3)', async () => {
		const { h, search } = await fixture()
		const token = h.users.alice.token
		expect((await h.request(`/api/v2/search?q=${'a'.repeat(501)}`, bearer(token))).status).toBe(400)
		expect((await h.request(`/api/v1/accounts/search?q=${'a'.repeat(501)}`, bearer(token))).status).toBe(400)
		expect((await h.request('/api/v2/search?q=%20', bearer(token))).status).toBe(400)
		expect((await h.request('/api/v2/search', bearer(token))).status).toBe(400)
		for (let i = 0; i < 45; i++) {
			await sql(
				h.store,
				`INSERT INTO accounts (id, uri, username, domain, search_text) VALUES (?, ?, ?, 'many.example', ?)`,
				String(200000000000000000n + BigInt(i)),
				`https://many.example/users/m${i}`,
				`m${i}`,
				`many m${i}@many.example`
			)
		}
		expect((await search('many', '&type=accounts&limit=100')).accounts).toHaveLength(40)
		expect((await search('many', '&type=accounts')).accounts).toHaveLength(20)
		expect((await search('many', '&type=accounts&offset=10001')).accounts).toEqual([])
		const accounts = await h.request('/api/v1/accounts/search?q=many&offset=10001', bearer(token))
		expect(await accounts.json()).toEqual([])
	})

	it('matches a bounded window of the library', async () => {
		expect(LIBRARY_SOURCE_LIMIT).toBeLessThanOrEqual(2500)
		expect(HASHTAG_CANDIDATES).toBeLessThanOrEqual(100)
		const { h, statusIds } = await fixture()
		const { alice } = h.users
		const old = await post(h, alice, { status: 'window oldest' })
		// Newer library rows than the window holds push the oldest out of a search without max_id.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, search_text)
			SELECT CAST(900000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/w' || i, ?, 'public', '', '2026-10-12T00:00:00.000Z', 'filler'
			FROM n`,
			LIBRARY_SOURCE_LIMIT,
			alice.id
		)
		expect(await statusIds('window')).toEqual([])
		expect(await statusIds('window', '&max_id=900000000000000000')).toEqual([old.id])
	})
})
