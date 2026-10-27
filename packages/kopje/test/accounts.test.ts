import { describe, expect, it } from 'vitest'

import { type ApiHarness, apiHarness, bearer, form, json, login, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import { appToken, scopedToken } from './read-helpers'
import { block, community, domainBlock, follow, getJson, ids as listIds, mute, remoteFollows } from './status-helpers'

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
			indexable: false,
			group: false,
			created_at: new Date(NOW).toISOString(),
			note: '',
			url: 'https://kopje.test/@alice',
			uri: 'https://kopje.test/ap/users/alice',
			avatar: 'https://kopje.test/assets/avatar.jpg',
			avatar_static: 'https://kopje.test/assets/avatar.jpg',
			header: 'https://kopje.test/assets/header.jpg',
			header_static: 'https://kopje.test/assets/header.jpg',
			followers_count: 0,
			following_count: 0,
			statuses_count: 0,
			last_status_at: null,
			hide_collections: false,
			emojis: [],
			fields: [],
			noindex: false,
			roles: [],
			source: {
				privacy: 'public',
				sensitive: false,
				language: null,
				note: '',
				fields: [],
				follow_requests_count: 0,
				hide_collections: false,
				discoverable: null,
				indexable: false,
				attribution_domains: [],
				quote_policy: 'public',
			},
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

	it('hides the network with hide_collections, shown on the account and in source', async () => {
		const h = await aliceSession()
		const hide = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(h.token, json({ hide_collections: true }, { method: 'PATCH' }))
		)
		expect(await hide.json()).toMatchObject({ hide_collections: true, source: { hide_collections: true } })
		const [row] = await sql<{ hide_collections: number }>(
			h.store,
			'SELECT hide_collections FROM local_accounts WHERE account_id = ?',
			h.aliceId
		)
		expect(row?.hide_collections).toBe(1)
		expect(await (await h.request(`/api/v1/accounts/${h.aliceId}`)).json()).toMatchObject({ hide_collections: true })
		// Left out, it stays as it is; false shows the network again.
		const other = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(h.token, json({ display_name: 'Alice A.' }, { method: 'PATCH' }))
		)
		expect(await other.json()).toMatchObject({ hide_collections: true })
		const show = new FormData()
		show.set('hide_collections', 'false')
		const shown = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(h.token, { method: 'PATCH', body: show })
		)
		expect(await shown.json()).toMatchObject({ hide_collections: false, source: { hide_collections: false } })
	})

	it('stores attribution domains as Mastodon normalizes them and gives them back in source', async () => {
		const h = await aliceSession()
		const patch = (body: Record<string, unknown>) =>
			h.request('/api/v1/accounts/update_credentials', bearer(h.token, json(body, { method: 'PATCH' })))
		const response = await patch({
			attribution_domains: [' https://writer.example ', '*.news.example', 'writer.example', '', 'Bücher.example'],
		})
		expect(response.status).toBe(200)
		const domains = ['writer.example', 'news.example', 'Bücher.example']
		expect(await response.json()).toMatchObject({ source: { attribution_domains: domains } })
		const verified = await h.request('/api/v1/accounts/verify_credentials', bearer(h.token))
		expect(await verified.json()).toMatchObject({ source: { attribution_domains: domains } })
		// Left out or sent as a scalar (which Mastodon's strong parameters drop), they stay as they are.
		expect(await (await patch({ display_name: 'Alice A.' })).json()).toMatchObject({
			source: { attribution_domains: domains },
		})
		expect(await (await patch({ attribution_domains: 'other.example' })).json()).toMatchObject({
			source: { attribution_domains: domains },
		})
		// An empty list clears them, from a form as from JSON.
		const clear = new FormData()
		clear.set('attribution_domains[]', '')
		const cleared = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(h.token, { method: 'PATCH', body: clear })
		)
		expect(await cleared.json()).toMatchObject({ source: { attribution_domains: [] } })
		expect(await (await patch({ attribution_domains: ['a.example'] })).json()).toMatchObject({
			source: { attribution_domains: ['a.example'] },
		})
		expect(await (await patch({ attribution_domains: [] })).json()).toMatchObject({
			source: { attribution_domains: [] },
		})
	})

	it('refuses attribution domains that are not domain names, or more than 100, with Mastodon messages', async () => {
		const h = await aliceSession()
		const patch = (body: Record<string, unknown>) =>
			h.request('/api/v1/accounts/update_credentials', bearer(h.token, json(body, { method: 'PATCH' })))
		const invalid = await patch({
			attribution_domains: ['ok.example', 'under_score.example', 'writer.example/path', '.lead.example', 'a b'],
		})
		expect(invalid.status).toBe(422)
		expect(await invalid.json()).toEqual({
			error:
				'Validation failed: Attribution domains under_score.example is not a valid domain name, Attribution domains writer.example/path is not a valid domain name, Attribution domains .lead.example is not a valid domain name, Attribution domains a b is not a valid domain name',
		})
		const many = await patch({ attribution_domains: Array.from({ length: 101 }, (_, i) => `d${i}.example`) })
		expect(many.status).toBe(422)
		expect(await many.json()).toEqual({
			error: 'Validation failed: Attribution domains is too long (maximum is 100 characters)',
		})
		const hundred = await patch({ attribution_domains: Array.from({ length: 100 }, (_, i) => `d${i}.example`) })
		expect(hundred.status).toBe(200)
		// A trailing dot passes, as Ruby's split drops the empty label after it; a label of 64 characters does not.
		expect((await patch({ attribution_domains: ['dot.example.'] })).status).toBe(200)
		expect((await patch({ attribution_domains: [`${'a'.repeat(64)}.example`] })).status).toBe(422)
		const [row] = await sql<{ attribution_domains: string }>(
			h.store,
			'SELECT attribution_domains FROM local_accounts WHERE account_id = ?',
			h.aliceId
		)
		expect(JSON.parse(row?.attribution_domains ?? '')).toEqual(['dot.example.'])
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
			avatar: 'https://kopje.test/assets/avatar.jpg',
			avatar_static: 'https://kopje.test/assets/avatar.jpg',
			header: 'https://kopje.test/assets/header.jpg',
			header_static: 'https://kopje.test/assets/header.jpg',
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
			avatar: 'https://kopje.test/assets/avatar.jpg',
			avatar_static: 'https://kopje.test/assets/avatar.jpg',
			header: 'https://kopje.test/assets/header.jpg',
			header_static: 'https://kopje.test/assets/header.jpg',
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

describe('relationships of unavailable accounts (R1, with_suspended)', () => {
	// A suspended local account, an account the instance suspended, one being deleted and one on a suspended domain,
	// each followed and noted by alice: Mastodon's Account.without_suspended leaves them out unless with_suspended.
	async function unavailableWorld() {
		const h = await aliceSession()
		const available = await seedAccount(h.store, { username: 'bob' })
		const local = await seedAccount(h.store, { username: 'carol' })
		const suspended = await seedAccount(h.store, { username: 'dave', domain: 'remote.test' })
		const deleting = await seedAccount(h.store, { username: 'erin', domain: 'remote.test' })
		const covered = await seedAccount(h.store, { username: 'frank', domain: 'covered.test' })
		const unavailable = [local, suspended, deleting, covered]
		for (const id of [available, ...unavailable]) {
			await sql(
				h.store,
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				h.aliceId,
				id
			)
			await sql(
				h.store,
				"INSERT INTO account_notes (account_id, target_account_id, comment) VALUES (?, ?, 'n')",
				h.aliceId,
				id
			)
		}
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			local
		)
		await sql(
			h.store,
			"UPDATE accounts SET suspended_at = ?, suspension_source = 'account' WHERE id = ?",
			new Date(NOW).toISOString(),
			suspended
		)
		await sql(h.store, 'UPDATE accounts SET deleted_at = ? WHERE id = ?', new Date(NOW).toISOString(), deleting)
		await blockDomain(h.store, 'covered.test')
		return { ...h, available, unavailable }
	}

	const relationshipsOf = async (h: ApiHarness & { token: string }, ids: string[], suffix = '') => {
		const query = ids.map((id) => `id[]=${id}`).join('&')
		const response = await h.request(`/api/v1/accounts/relationships?${query}${suffix}`, bearer(h.token))
		expect(response.status).toBe(200)
		return response.json<{ id: string; following: boolean; note: string }[]>()
	}

	it('leaves unavailable accounts out by default and with a false with_suspended', async () => {
		const h = await unavailableWorld()
		for (const suffix of ['', '&with_suspended=false', '&with_suspended=0']) {
			const entries = await relationshipsOf(h, [...h.unavailable, h.available], suffix)
			expect(entries.map((entry) => entry.id)).toEqual([h.available])
		}
		expect(await relationshipsOf(h, h.unavailable)).toEqual([])
	})

	it('includes them, in request order and once each, with a true with_suspended', async () => {
		const h = await unavailableWorld()
		const requested = [h.unavailable[2]!, h.available, ...h.unavailable, h.unavailable[0]!]
		for (const suffix of ['&with_suspended=true', '&with_suspended=1']) {
			const entries = await relationshipsOf(h, requested, suffix)
			expect(entries.map((entry) => entry.id)).toEqual([...new Set(requested)])
			for (const entry of entries) {
				expect(entry).toMatchObject({ following: true, note: 'n' })
			}
		}
	})

	it("includes an account on a domain the viewer blocks, which only marks it (Mastodon's domain_blocking)", async () => {
		const h = await aliceSession()
		const remote = await seedAccount(h.store, { username: 'dave', domain: 'blocked.test' })
		await domainBlock(h.store, h.aliceId, 'blocked.test')
		expect(await relationshipsOf(h, [remote])).toEqual([expect.objectContaining({ id: remote, domain_blocking: true })])
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

describe('follower lists for the viewer (R13)', () => {
	// carol is followed by alice, bob, dave and the remote erin, and follows them all.
	async function network() {
		const h = await community(['alice', 'bob', 'carol', 'dave'])
		const { alice, bob, carol, dave } = h.users
		const erin = await seedAccount(h.store, { username: 'erin', domain: 'remote.example' })
		for (const user of [alice, bob, dave]) {
			await follow(h, user, carol.id)
			await follow(h, carol, user.id)
		}
		await remoteFollows(h.store, erin, carol.id)
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			carol.id,
			erin
		)
		const ids = async (direction: 'followers' | 'following', token?: string) =>
			(await listIds(h, `/api/v1/accounts/${carol.id}/${direction}`, token)).sort()
		return { h, erin, ids }
	}

	it('leaves out, for a signed-in viewer, the accounts they block, mute or are blocked by', async () => {
		const { h, erin, ids } = await network()
		const { alice, bob, carol, dave } = h.users
		await block(h.store, alice.id, bob.id)
		await mute(h.store, alice.id, dave.id)
		await block(h.store, erin, alice.id)
		// A domain block is not a reason (Mastodon leaves out accounts only).
		await domainBlock(h.store, alice.id, 'remote.example')
		for (const direction of ['followers', 'following'] as const) {
			expect(await ids(direction, alice.token)).toEqual([alice.id].sort())
			expect(await ids(direction)).toEqual([alice.id, bob.id, dave.id, erin].sort())
			// The owner sees every entry, whatever it blocks or mutes.
			expect(await ids(direction, carol.token)).toEqual([alice.id, bob.id, dave.id, erin].sort())
		}
		// A mute that has expired no longer applies.
		await sql(
			h.store,
			'UPDATE mutes SET expires_at = ? WHERE account_id = ?',
			new Date(NOW - 1000).toISOString(),
			alice.id
		)
		expect(await ids('followers', alice.token)).toEqual([alice.id, dave.id].sort())
	})

	it('lists a suspended account, redacted', async () => {
		const { h, ids } = await network()
		const { bob, carol } = h.users
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?', '2026-01-01', bob.id)
		const { body } = await getJson<{ id: string; suspended?: boolean }[]>(h, `/api/v1/accounts/${carol.id}/followers`)
		expect(body.find((account) => account.id === bob.id)).toMatchObject({ suspended: true, display_name: '' })
		expect(await ids('following')).toContain(bob.id)
	})

	it('lists nothing of a suspended account, of one that blocks the viewer, or that hides its network', async () => {
		const { h, ids } = await network()
		const { alice, bob, carol } = h.users
		await block(h.store, carol.id, alice.id)
		for (const direction of ['followers', 'following'] as const) {
			expect(await ids(direction, alice.token)).toEqual([])
			expect(await ids(direction, bob.token)).not.toEqual([])
		}

		const hide = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(carol.token, json({ hide_collections: true }, { method: 'PATCH' }))
		)
		expect(hide.status).toBe(200)
		for (const direction of ['followers', 'following'] as const) {
			expect(await ids(direction, bob.token)).toEqual([])
			expect(await ids(direction)).toEqual([])
			// The owner still sees its own.
			expect(await ids(direction, carol.token)).not.toEqual([])
		}

		await sql(
			h.store,
			'UPDATE local_accounts SET hide_collections = 0, suspended_at = ? WHERE account_id = ?',
			'2026-01-01',
			carol.id
		)
		for (const direction of ['followers', 'following'] as const) {
			expect(await ids(direction)).toEqual([])
		}
	})

	it('reads an optional token: an invalid one or one without read:accounts is refused, an app token is anonymous', async () => {
		const { h } = await network()
		const { carol } = h.users
		expect((await h.request(`/api/v1/accounts/${carol.id}/followers`, bearer('nope'))).status).toBe(401)
		const statusesOnly = await scopedToken(h, 'read:statuses')
		expect((await h.request(`/api/v1/accounts/${carol.id}/following`, bearer(statusesOnly))).status).toBe(403)
		const app = await appToken(h)
		expect((await h.request(`/api/v1/accounts/${carol.id}/following`, bearer(app))).status).toBe(200)
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
