import { describe, expect, it } from 'vitest'

import { type ApiHarness, apiHarness, bearer, form, json, login, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'

type Account = Record<string, unknown> & { id: string }

async function aliceSession(): Promise<ApiHarness & { aliceId: string; token: string }> {
	const h = await apiHarness()
	const aliceId = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
	const { token } = await login(h, { scope: 'read write follow' })
	return { ...h, aliceId, token }
}

describe('credentials', () => {
	it('returns the viewer with source and the default role', async () => {
		const h = await aliceSession()
		const response = await h.request('/api/v1/accounts/verify_credentials', bearer(h.token))
		expect(await response.json()).toEqual({
			id: h.aliceId,
			username: 'alice',
			acct: 'alice',
			display_name: 'Alice',
			locked: false,
			bot: false,
			discoverable: null,
			group: false,
			created_at: new Date(NOW).toISOString(),
			note: '',
			url: 'https://kopje.test/@alice',
			avatar: 'https://kopje.test/assets/avatar.png',
			avatar_static: 'https://kopje.test/assets/avatar.png',
			header: 'https://kopje.test/assets/header.png',
			header_static: 'https://kopje.test/assets/header.png',
			followers_count: 0,
			following_count: 0,
			statuses_count: 0,
			last_status_at: null,
			emojis: [],
			fields: [],
			source: { privacy: 'public', sensitive: false, language: null, note: '', fields: [], follow_requests_count: 0 },
			role: { id: '-99', name: '', permissions: '0', color: '', highlighted: false },
		})
	})

	it('stores plain-text profile fields safely and gives the note back as source', async () => {
		const h = await aliceSession()
		const note = 'Hello <b>world</b> & "friends"\nsecond line\n\nnew paragraph'
		const response = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(
				h.token,
				json(
					{
						display_name: '<script>x</script>',
						note,
						locked: true,
						bot: 'true',
						source: { privacy: 'unlisted', sensitive: true, language: 'ja' },
					},
					{ method: 'PATCH' }
				)
			)
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			display_name: '<script>x</script>',
			note: '<p>Hello &lt;b&gt;world&lt;/b&gt; &amp; &quot;friends&quot;<br>second line</p><p>new paragraph</p>',
			locked: true,
			bot: true,
			source: { privacy: 'unlisted', sensitive: true, language: 'ja', note },
		})
		// display_name is searchable right away.
		const [row] = await sql<{ search_text: string }>(
			h.store,
			'SELECT search_text FROM accounts WHERE id = ?',
			h.aliceId
		)
		expect(row?.search_text).toBe('<script>x</script> alice')
	})

	it('accepts multipart forms, as most clients send them', async () => {
		const h = await aliceSession()
		const body = new FormData()
		body.set('display_name', 'Alice A.')
		body.set('source[privacy]', 'private')
		const response = await h.request('/api/v1/accounts/update_credentials', bearer(h.token, { method: 'PATCH', body }))
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ display_name: 'Alice A.', source: { privacy: 'private' } })
	})

	it('refuses invalid values without changing anything', async () => {
		const h = await aliceSession()
		for (const body of [
			{ display_name: 'x'.repeat(31) },
			{ note: 'x'.repeat(501) },
			{ source: { privacy: 'secret' } },
		]) {
			const response = await h.request(
				'/api/v1/accounts/update_credentials',
				bearer(h.token, json(body, { method: 'PATCH' }))
			)
			expect(response.status, JSON.stringify(body)).toBe(422)
		}
		const me = await h.request('/api/v1/accounts/verify_credentials', bearer(h.token))
		expect(await me.json()).toMatchObject({ display_name: 'Alice', source: { privacy: 'public' } })
	})
})

describe('account lookup', () => {
	it('finds accounts by id and by legacy id, answering with the API id', async () => {
		const h = await apiHarness()
		const id = await seedAccount(h.store, { username: 'old', legacyId: '0d3a7e4c-1b2f-4c5d-9e8f-0123456789ab' })
		expect(id).toMatch(/^\d{18}$/)

		const byId = await h.request(`/api/v1/accounts/${id}`)
		expect(await byId.json()).toMatchObject({ id, username: 'old' })
		const byLegacy = await h.request('/api/v1/accounts/0d3a7e4c-1b2f-4c5d-9e8f-0123456789ab')
		expect(byLegacy.status).toBe(200)
		expect(await byLegacy.json()).toMatchObject({ id, username: 'old' })

		const missing = await h.request('/api/v1/accounts/999999999999999999')
		expect(missing.status).toBe(404)
		expect(await missing.json()).toEqual({ error: 'Record not found' })
	})

	it('keeps 18-digit ids exact (no number rounding)', async () => {
		const h = await apiHarness()
		const id = '109999999999999999'
		await sql(
			h.store,
			"INSERT INTO accounts (id, uri, username, domain) VALUES (?, 'https://remote.test/users/big', 'big', 'remote.test')",
			id
		)
		const response = await h.request(`/api/v1/accounts/${id}`)
		expect(await response.text()).toContain(`"id":"${id}"`)
	})

	it("redacts a suspended account's profile as Mastodon 4.0.2 does", async () => {
		const h = await apiHarness()
		const id = await seedAccount(h.store, { username: 'gone', displayName: 'Gone', locked: true })
		await sql(
			h.store,
			`UPDATE accounts SET note = '<p>bio</p>', actor_type = 'Service', discoverable = 1,
				avatar_url = 'https://cdn.test/a.png', header_url = 'https://cdn.test/h.png' WHERE id = ?`,
			id
		)
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			id
		)
		const response = await h.request(`/api/v1/accounts/${id}`)
		expect(await response.json()).toMatchObject({
			id,
			username: 'gone',
			display_name: '',
			note: '',
			locked: false,
			bot: false,
			discoverable: false,
			avatar: 'https://kopje.test/assets/avatar.png',
			avatar_static: 'https://kopje.test/assets/avatar.png',
			header: 'https://kopje.test/assets/header.png',
			header_static: 'https://kopje.test/assets/header.png',
			emojis: [],
			fields: [],
			suspended: true,
		})
	})

	// HTML-3: whatever is stored (imported or federated), only http(s) URLs leave the presenter.
	it.each([
		'javascript:alert(1)',
		'JaVaScRiPt:alert(1)',
		' javascript:alert(1)',
		'data:image/png;base64,AAAA',
		'/a.png',
	])('shows the defaults for a stored avatar, header and profile URL of %j', async (bad) => {
		const h = await apiHarness()
		const id = '444444444444444444'
		await sql(
			h.store,
			`INSERT INTO accounts (id, uri, username, domain, url, avatar_url, header_url)
				VALUES (?, 'https://remote.test/users/x', 'x', 'remote.test', ?, ?, ?)`,
			id,
			bad,
			bad,
			bad
		)
		const response = await h.request(`/api/v1/accounts/${id}`)
		expect(await response.json()).toMatchObject({
			url: 'https://remote.test/@x',
			avatar: 'https://kopje.test/assets/avatar.png',
			avatar_static: 'https://kopje.test/assets/avatar.png',
			header: 'https://kopje.test/assets/header.png',
			header_static: 'https://kopje.test/assets/header.png',
		})
	})

	it('shows stored http(s) URLs of any scheme case, normalized', async () => {
		const h = await apiHarness()
		const id = '444444444444444444'
		await sql(
			h.store,
			`INSERT INTO accounts (id, uri, username, domain, url, avatar_url, header_url)
			VALUES (?, 'https://remote.test/users/x', 'x', 'remote.test', 'HTTPS://Remote.test/@x', 'Http://cdn.test/a.png',
				'https://cdn.test/h.png')`,
			id
		)
		const response = await h.request(`/api/v1/accounts/${id}`)
		expect(await response.json()).toMatchObject({
			url: 'https://remote.test/@x',
			avatar: 'http://cdn.test/a.png',
			header: 'https://cdn.test/h.png',
		})
	})

	it('looks up local and remote accounts by acct', async () => {
		const h = await apiHarness()
		const local = await seedAccount(h.store, { username: 'Alice' })
		const remote = await seedAccount(h.store, { username: 'bob', domain: 'remote.test' })
		for (const [acct, id] of [
			['alice', local],
			['@alice', local],
			['alice@kopje.test', local],
			['bob@remote.test', remote],
			['bob@REMOTE.test', remote],
		] as const) {
			const response = await h.request(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`)
			expect(response.status, acct).toBe(200)
			expect(await response.json(), acct).toMatchObject({ id })
		}
		expect((await h.request('/api/v1/accounts/lookup?acct=bob')).status).toBe(404)
		const remoteAccount = await (await h.request(`/api/v1/accounts/${remote}`)).json()
		expect(remoteAccount).toMatchObject({ acct: 'bob@remote.test', url: 'https://remote.test/@bob' })
	})
})

describe('account search', () => {
	async function searchFixture() {
		const h = await aliceSession()
		const ids = {
			taro: await seedAccount(h.store, { username: 'taro', displayName: '山田太郎' }),
			server: await seedAccount(h.store, { username: 'srv', domain: 'remote.test', displayName: 'サーバ管理人' }),
			neko: await seedAccount(h.store, { username: 'cat', domain: 'remote.test', displayName: 'ネコ好き' }),
			fullwidth: await seedAccount(h.store, { username: 'ap', displayName: 'ＡｃｔｉｖｉｔｙＰｕｂ fan' }),
		}
		const search = async (q: string, extra = '') => {
			const response = await h.request(`/api/v1/accounts/search?q=${encodeURIComponent(q)}${extra}`, bearer(h.token))
			expect(response.status).toBe(200)
			return (await response.json<Account[]>()).map((account) => account.id)
		}
		return { h, ids, search }
	}

	it('matches substrings of names and accts, including Japanese', async () => {
		const { ids, search } = await searchFixture()
		expect(await search('太郎')).toEqual([ids.taro])
		expect(await search('サーバー')).toEqual([ids.server])
		expect(await search('ねこ')).toEqual([ids.neko])
		expect(await search('activitypub')).toEqual([ids.fullwidth])
		expect(await search('srv@remote.test')).toEqual([ids.server])
		expect(await search('nothing-here')).toEqual([])
	})

	it('filters to followed accounts, pages with offset, and needs a token', async () => {
		const { h, ids, search } = await searchFixture()
		await h.request(`/api/v1/accounts/${ids.neko}/follow`, bearer(h.token, { method: 'POST' }))
		expect(await search('remote.test')).toHaveLength(2)
		expect(await search('remote.test', '&limit=1&offset=1')).toHaveLength(1)
		// A remote follow is pending until the remote Accept arrives, so it is not "following" yet.
		expect(await search('remote.test', '&following=true')).toEqual([])
		await sql(h.store, "UPDATE follows SET state = 'accepted'")
		expect(await search('remote.test', '&following=true')).toEqual([ids.neko])
		expect((await h.request('/api/v1/accounts/search?q=taro')).status).toBe(401)
	})
})

describe('follow and relationships', () => {
	it('follows a local account at once and unfollows it, keeping counts', async () => {
		const h = await aliceSession()
		const bob = await seedAccount(h.store, { username: 'bob' })

		const followed = await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, json({ notify: true })))
		expect(followed.status).toBe(200)
		expect(await followed.json()).toEqual({
			id: bob,
			following: true,
			showing_reblogs: true,
			notifying: true,
			languages: null,
			followed_by: false,
			requested_by: false,
			blocking: false,
			blocked_by: false,
			muting: false,
			muting_notifications: false,
			muting_expires_at: null,
			requested: false,
			domain_blocking: false,
			endorsed: false,
			note: '',
		})
		expect(await (await h.request(`/api/v1/accounts/${bob}`)).json()).toMatchObject({ followers_count: 1 })
		expect(await (await h.request(`/api/v1/accounts/${h.aliceId}`)).json()).toMatchObject({ following_count: 1 })

		const unfollowed = await h.request(`/api/v1/accounts/${bob}/unfollow`, bearer(h.token, { method: 'POST' }))
		expect(await unfollowed.json()).toMatchObject({ following: false, requested: false })
		expect(await (await h.request(`/api/v1/accounts/${bob}`)).json()).toMatchObject({ followers_count: 0 })
	})

	it('requests a locked or remote account and leaves remote counters alone', async () => {
		const h = await aliceSession()
		const locked = await seedAccount(h.store, { username: 'carol', locked: true })
		const remote = await seedAccount(h.store, { username: 'dave', domain: 'remote.test', followersCount: 42 })
		for (const id of [locked, remote]) {
			const response = await h.request(`/api/v1/accounts/${id}/follow`, bearer(h.token, { method: 'POST' }))
			expect(await response.json()).toMatchObject({ following: false, requested: true })
		}
		expect(await (await h.request(`/api/v1/accounts/${remote}`)).json()).toMatchObject({ followers_count: 42 })
		const carol = await (await h.request(`/api/v1/accounts/${locked}`)).json()
		expect(carol).toMatchObject({ followers_count: 0 })
	})

	it('refuses following yourself, blocked accounts, and unknown ids', async () => {
		const h = await aliceSession()
		const blocker = await seedAccount(h.store, { username: 'eve' })
		await sql(h.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', blocker, h.aliceId)
		const follow = (id: string) => h.request(`/api/v1/accounts/${id}/follow`, bearer(h.token, { method: 'POST' }))
		expect((await follow(h.aliceId)).status).toBe(403)
		expect((await follow(blocker)).status).toBe(403)
		expect((await follow('999999999999999999')).status).toBe(404)
	})

	it('refuses following a suspended account', async () => {
		const h = await aliceSession()
		const bob = await seedAccount(h.store, { username: 'bob' })
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			bob
		)
		const response = await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, { method: 'POST' }))
		expect(response.status).toBe(404)
		expect(await sql(h.store, 'SELECT 1 FROM follows')).toEqual([])
	})

	it("refuses following an account on a domain the viewer blocks, as Mastodon's FollowService does", async () => {
		const h = await aliceSession()
		const remote = await seedAccount(h.store, { username: 'dave', domain: 'blocked.test' })
		await sql(h.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.test')", h.aliceId)
		const response = await h.request(`/api/v1/accounts/${remote}/follow`, bearer(h.token, { method: 'POST' }))
		expect(response.status).toBe(403)
		expect(await sql(h.store, 'SELECT 1 FROM follows')).toEqual([])
	})

	it('clears the languages filter with an explicitly empty list, and keeps it when absent', async () => {
		const h = await aliceSession()
		const bob = await seedAccount(h.store, { username: 'bob' })
		const follow = async (init: RequestInit) =>
			(await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, init))).json<{ languages: unknown }>()

		expect((await follow(json({ languages: ['ja', 'en'] }))).languages).toEqual(['ja', 'en'])
		expect((await follow(json({ notify: true }))).languages).toEqual(['ja', 'en'])
		expect((await follow(json({ languages: [] }))).languages).toBeNull()

		expect((await follow(json({ languages: ['ja'] }))).languages).toEqual(['ja'])
		expect((await follow(form({ 'languages[]': '' }))).languages).toBeNull()
	})

	it('answers relationships for several ids, legacy ids included', async () => {
		const h = await aliceSession()
		const bob = await seedAccount(h.store, { username: 'bob', legacyId: 'legacy-bob' })
		const carol = await seedAccount(h.store, { username: 'carol' })
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			carol,
			h.aliceId
		)
		await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, json({ reblogs: false, languages: ['ja'] })))

		const response = await h.request(
			`/api/v1/accounts/relationships?id[]=legacy-bob&id[]=${carol}&id[]=999999999999999999`,
			bearer(h.token)
		)
		expect(await response.json()).toEqual([
			expect.objectContaining({
				id: bob,
				following: true,
				showing_reblogs: false,
				languages: ['ja'],
				followed_by: false,
			}),
			expect.objectContaining({ id: carol, following: false, followed_by: true }),
		])
	})
})

describe('follower lists', () => {
	async function popular(count: number) {
		const h = await apiHarness()
		const star = await seedAccount(h.store, { username: 'star' })
		const fans: string[] = []
		for (let i = 0; i < count; i++) {
			const fan = await seedAccount(h.store, { username: `fan${i}` })
			await sql(
				h.store,
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				fan,
				star
			)
			fans.push(fan)
		}
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'pending')",
			star,
			fans[0]!
		)
		return { h, star, fans }
	}

	function links(response: Response): Record<string, string> {
		const header = response.headers.get('link') ?? ''
		return Object.fromEntries(
			[...header.matchAll(/<([^>]+)>; rel="(\w+)"/g)].map((match) => [
				match[2]!,
				match[1]!.replace('https://kopje.test', ''),
			])
		)
	}

	it('pages followers newest first with max_id and min_id links', async () => {
		const { h, star, fans } = await popular(5)
		const newestFirst = [...fans].reverse()

		const first = await h.request(`/api/v1/accounts/${star}/followers?limit=2`)
		expect((await first.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(0, 2))
		const firstLinks = links(first)
		expect(firstLinks).toEqual({
			next: `/api/v1/accounts/${star}/followers?limit=2&max_id=4`,
			prev: `/api/v1/accounts/${star}/followers?limit=2&min_id=5`,
		})

		const second = await h.request(firstLinks.next!)
		expect((await second.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(2, 4))
		const back = await h.request(links(second).prev!)
		expect((await back.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(0, 2))

		const last = await h.request(`/api/v1/accounts/${star}/followers?limit=2&max_id=2`)
		expect((await last.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(4))
		expect(Object.keys(links(last))).toEqual(['prev'])

		const since = await h.request(`/api/v1/accounts/${star}/followers?since_id=3`)
		expect((await since.json<Account[]>()).map((a) => a.id)).toEqual(newestFirst.slice(0, 2))

		const empty = await h.request(`/api/v1/accounts/${star}/followers?min_id=5`)
		expect(await empty.json()).toEqual([])
		expect(empty.headers.get('link')).toBeNull()
	})

	it('lists following without pending requests and 404s unknown accounts', async () => {
		const { h, star, fans } = await popular(2)
		const following = await h.request(`/api/v1/accounts/${fans[1]}/following`)
		expect((await following.json<Account[]>()).map((a) => a.id)).toEqual([star])
		const pending = await h.request(`/api/v1/accounts/${star}/following`)
		expect(await pending.json()).toEqual([])
		expect((await h.request('/api/v1/accounts/999999999999999999/followers')).status).toBe(404)
	})
})

describe('edge ids beyond 2^53', () => {
	// Ids are kept as strings: as JS numbers, 2^53 + 1 and 2^53 + 3 would round to their neighbours.
	const BIG = ['9007199254740993', '9007199254740995']

	it('pages with exact cursors', async () => {
		const h = await apiHarness()
		const star = await seedAccount(h.store, { username: 'star' })
		const fans = [await seedAccount(h.store, { username: 'fan0' }), await seedAccount(h.store, { username: 'fan1' })]
		for (const [i, fan] of fans.entries()) {
			await sql(
				h.store,
				"INSERT INTO follows (id, account_id, target_account_id, state) VALUES (?, ?, ?, 'accepted')",
				BIG[i]!,
				fan,
				star
			)
		}
		const first = await h.request(`/api/v1/accounts/${star}/followers?limit=1`)
		expect((await first.json<Account[]>()).map((a) => a.id)).toEqual([fans[1]])
		const link = first.headers.get('link') ?? ''
		expect(link).toContain(`max_id=${BIG[1]}>`)
		expect(link).toContain(`min_id=${BIG[1]}>`)
		const next = await h.request(`/api/v1/accounts/${star}/followers?limit=1&max_id=${BIG[1]}`)
		expect((await next.json<Account[]>()).map((a) => a.id)).toEqual([fans[0]])
		const newer = await h.request(`/api/v1/accounts/${star}/followers?min_id=${BIG[0]}`)
		expect((await newer.json<Account[]>()).map((a) => a.id)).toEqual([fans[1]])
	})

	it('updates the options of an existing follow', async () => {
		const h = await aliceSession()
		const bob = await seedAccount(h.store, { username: 'bob' })
		await sql(
			h.store,
			"INSERT INTO follows (id, account_id, target_account_id, state) VALUES (?, ?, ?, 'accepted')",
			BIG[0]!,
			h.aliceId,
			bob
		)
		const response = await h.request(`/api/v1/accounts/${bob}/follow`, bearer(h.token, json({ reblogs: false })))
		expect(await response.json()).toMatchObject({ following: true, showing_reblogs: false })
	})
})
