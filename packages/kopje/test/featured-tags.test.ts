import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, json, settle, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { appToken, plannedRun, remoteAccounts, rowsRead, scansOf, scopedToken, staleStatistics } from './read-helpers'
import { act, community, getJson, outbound, post, remoteAccount, remoteFollows, type User } from './status-helpers'
import { accountFeaturedTags, MAX_FEATURED_TAGS } from '../src/domain/featured-tags'

// Featured hashtags (Mastodon 4.5's FeaturedTag, FeaturedTagsController, FeaturedTags::SuggestionsController,
// Accounts::FeaturedTagsController and TagsController#feature and #unfeature): the endpoints, their errors, the counts
// kept as statuses come and go, the Add and Remove sent to followers, and the work each read does (RES-7).

type FeaturedTag = { id: string; name: string; url: string; statuses_count: string; last_status_at: string | null }
type Tag = { name: string; following?: boolean; featuring?: boolean }

const TODAY = new Date(NOW).toISOString().slice(0, 10)

async function feature(h: ApiHarness, user: User, name: string): Promise<Response> {
	return act(h, user, '/api/v1/featured_tags', { name })
}

async function featured(h: ApiHarness, user: User): Promise<FeaturedTag[]> {
	return (await getJson<FeaturedTag[]>(h, '/api/v1/featured_tags', user.token)).body
}

function send(h: ApiHarness, user: User, method: string, path: string) {
	return h.request(path, bearer(user.token, { method }))
}

describe('featured hashtags', () => {
	it('features a hashtag with the counts of the account’s public and unlisted statuses, as REST::FeaturedTagSerializer', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await post(h, alice, { status: '#Cats one', visibility: 'public' })
		await post(h, alice, { status: '#cats two', visibility: 'unlisted' })
		await post(h, alice, { status: '#cats three', visibility: 'private' })
		await post(h, alice, { status: '#cats four', visibility: 'direct' })
		await post(h, bob, { status: '#cats elsewhere', visibility: 'public' })
		const response = await feature(h, alice, '#Cats ')
		expect(response.status).toBe(200)
		const created = (await response.json()) as FeaturedTag
		expect(created).toEqual({
			id: expect.stringMatching(/^\d{18}$/),
			name: 'Cats',
			url: 'https://kopje.test/@alice/tagged/cats',
			statuses_count: '2',
			last_status_at: TODAY,
		})
		// The same spelling again answers the same; another spelling of the hashtag is taken.
		expect(await (await feature(h, alice, 'Cats')).json()).toEqual(created)
		const taken = await feature(h, alice, 'cats')
		expect([taken.status, await taken.json()]).toEqual([
			422,
			{ error: 'Validation failed: Tag has already been taken' },
		])
		expect(await featured(h, alice)).toEqual([created])
		expect(await featured(h, bob)).toEqual([])
		// An unused hashtag starts at zero, with no date.
		expect(await (await feature(h, alice, 'dogs')).json()).toMatchObject({ statuses_count: '0', last_status_at: null })
		expect((await featured(h, alice)).map((tag) => tag.name)).toEqual(['Cats', 'dogs'])
	})

	it('refuses an invalid or missing name, and a hashtag beyond the limit, with Mastodon’s messages', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const invalid = await feature(h, alice, 'a-b')
		expect([invalid.status, await invalid.json()]).toEqual([422, { error: 'Validation failed: Name is invalid' }])
		const blank = await feature(h, alice, '#')
		expect([blank.status, await blank.json()]).toEqual([422, { error: "Validation failed: Name can't be blank" }])
		const missing = await act(h, alice, '/api/v1/featured_tags', {})
		expect([missing.status, await missing.json()]).toEqual([
			400,
			{ error: 'param is missing or the value is empty: name' },
		])
		for (let i = 0; i < MAX_FEATURED_TAGS; i++) {
			expect((await feature(h, alice, `t${i}`)).status).toBe(200)
		}
		const over = await feature(h, alice, 'cats')
		expect([over.status, await over.json()]).toEqual([
			422,
			{ error: 'Validation failed: You have already featured the maximum number of hashtags' },
		])
		const overByTag = await act(h, alice, '/api/v1/tags/cats/feature')
		expect(overByTag.status).toBe(422)
		// One already featured still answers.
		expect((await act(h, alice, '/api/v1/tags/t0/feature')).status).toBe(200)
	})

	it('deletes the viewer’s own featured hashtag only', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const created = (await (await feature(h, alice, 'cats')).json()) as FeaturedTag
		expect((await send(h, bob, 'DELETE', `/api/v1/featured_tags/${created.id}`)).status).toBe(404)
		const deleted = await send(h, alice, 'DELETE', `/api/v1/featured_tags/${created.id}`)
		expect([deleted.status, await deleted.json()]).toEqual([200, {}])
		expect(await featured(h, alice)).toEqual([])
		expect((await send(h, alice, 'DELETE', `/api/v1/featured_tags/${created.id}`)).status).toBe(404)
	})

	it('features and unfeatures through the hashtag, answering with the Tag', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const tag = (await (await act(h, alice, '/api/v1/tags/Cats/feature')).json()) as Tag
		expect(tag).toMatchObject({ name: 'cats', following: false, featuring: true })
		expect(await featured(h, alice)).toMatchObject([{ name: 'cats' }])
		expect((await getJson<Tag>(h, '/api/v1/tags/cats', alice.token)).body.featuring).toBe(true)
		expect(((await (await act(h, alice, '/api/v1/tags/cats/feature')).json()) as Tag).featuring).toBe(true)
		expect(((await (await act(h, alice, '/api/v1/tags/cats/unfeature')).json()) as Tag).featuring).toBe(false)
		expect(await featured(h, alice)).toEqual([])
		expect((await act(h, alice, '/api/v1/tags/cats/unfeature')).status).toBe(200)
		expect((await act(h, alice, '/api/v1/tags/a-b/feature')).status).toBe(404)
	})

	it('lists the most used first', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await feature(h, alice, 'few')
		await feature(h, alice, 'many')
		await post(h, alice, { status: '#many #few', visibility: 'public' })
		await post(h, alice, { status: '#many', visibility: 'public' })
		expect((await featured(h, alice)).map((tag) => [tag.name, tag.statuses_count])).toEqual([
			['many', '2'],
			['few', '1'],
		])
	})

	it('keeps the counts as statuses are posted, edited and deleted (FeaturedTag#increment, #decrement)', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const counts = async () => {
			const [tag] = await featured(h, alice)
			const row = await sql<{ statuses_count: number; last_status_at: string | null }>(
				h.store,
				'SELECT statuses_count, last_status_at FROM featured_tags'
			)
			return { shown: tag?.statuses_count, ...row[0] }
		}
		const first = await post(h, alice, { status: '#cats 1', visibility: 'public' })
		await feature(h, alice, 'cats')
		const firstAt = (await counts()).last_status_at
		expect(await counts()).toMatchObject({ shown: '1', statuses_count: 1 })

		// Private, direct and boosts do not count; untagged statuses neither.
		await post(h, alice, { status: '#cats private', visibility: 'private' })
		await post(h, alice, { status: '#cats direct', visibility: 'direct' })
		await post(h, alice, { status: 'plain', visibility: 'public' })
		await act(h, alice, `/api/v1/statuses/${first.id}/reblog`)
		expect(await counts()).toMatchObject({ statuses_count: 1, last_status_at: firstAt })

		const second = await post(h, alice, { status: '#cats 2', visibility: 'unlisted' })
		const secondAt = (
			await sql<{ published_at: string }>(h.store, 'SELECT published_at FROM statuses WHERE id = ?', second.id)
		)[0]?.published_at
		expect(await counts()).toMatchObject({ statuses_count: 2, last_status_at: secondAt })

		// An edit that removes the hashtag from the newest moves the time back to the one before it; adding it back counts
		// it again.
		const edit = (id: string, status: string) =>
			h.request(`/api/v1/statuses/${id}`, bearer(alice.token, json({ status }, { method: 'PUT' })))
		expect((await edit(second.id, 'no tag')).status).toBe(200)
		expect(await counts()).toMatchObject({ statuses_count: 1, last_status_at: firstAt })
		expect((await edit(second.id, '#cats again')).status).toBe(200)
		expect(await counts()).toMatchObject({ statuses_count: 2, last_status_at: secondAt })
		// An edit that keeps it changes nothing.
		expect((await edit(second.id, '#Cats still')).status).toBe(200)
		expect(await counts()).toMatchObject({ statuses_count: 2, last_status_at: secondAt })

		// Deleting the newest moves the time back; deleting an older one keeps it; the last leaves none.
		expect((await send(h, alice, 'DELETE', `/api/v1/statuses/${second.id}`)).status).toBe(200)
		await settle(h.store)
		expect(await counts()).toMatchObject({ statuses_count: 1, last_status_at: firstAt })
		expect((await send(h, alice, 'DELETE', `/api/v1/statuses/${first.id}`)).status).toBe(200)
		await settle(h.store)
		expect(await counts()).toMatchObject({ shown: '0', statuses_count: 0, last_status_at: null })
	})

	it('keeps the time of another status published at the same moment when one is deleted or untagged', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// Both posts are published at the harness's fixed time.
		const first = await post(h, alice, { status: '#cats 1', visibility: 'public' })
		await post(h, alice, { status: '#cats 2', visibility: 'public' })
		await feature(h, alice, 'cats')
		const counts = async () =>
			(
				await sql<{ statuses_count: number; last_status_at: string | null }>(
					h.store,
					'SELECT statuses_count, last_status_at FROM featured_tags'
				)
			)[0]
		const at = (await counts())?.last_status_at
		expect(at).not.toBeNull()
		const edited = await h.request(
			`/api/v1/statuses/${first.id}`,
			bearer(alice.token, json({ status: 'no tag' }, { method: 'PUT' }))
		)
		expect(edited.status).toBe(200)
		expect(await counts()).toEqual({ statuses_count: 1, last_status_at: at })
		const back = await h.request(
			`/api/v1/statuses/${first.id}`,
			bearer(alice.token, json({ status: '#cats back' }, { method: 'PUT' }))
		)
		expect(back.status).toBe(200)
		expect(await counts()).toEqual({ statuses_count: 2, last_status_at: at })
		expect((await send(h, alice, 'DELETE', `/api/v1/statuses/${first.id}`)).status).toBe(200)
		await settle(h.store)
		expect(await counts()).toEqual({ statuses_count: 1, last_status_at: at })
	})

	it('suggests the hashtags of the viewer’s recent statuses that they do not feature, the most used first', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await post(h, alice, { status: '#b #c', visibility: 'public' })
		await post(h, alice, { status: '#c #a', visibility: 'direct' })
		await post(h, alice, { status: '#c #featured', visibility: 'private' })
		await post(h, bob, { status: '#bob #bob2 #bob3', visibility: 'public' })
		await feature(h, alice, 'featured')
		await act(h, alice, '/api/v1/tags/a/follow')
		const { status, body } = await getJson<Tag[]>(h, '/api/v1/featured_tags/suggestions', alice.token)
		expect(status).toBe(200)
		expect(body.map((tag) => [tag.name, tag.following, tag.featuring])).toEqual([
			['c', false, false],
			['a', true, false],
			['b', false, false],
		])
	})

	it('shows an account’s featured hashtags to anyone, none of an unavailable account, and 404 for no account', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const created = (await (await feature(h, alice, 'cats')).json()) as FeaturedTag
		expect(await getJson(h, `/api/v1/accounts/${alice.id}/featured_tags`)).toEqual({ status: 200, body: [created] })
		const remote = await remoteAccount(h.store, 'carol')
		expect(await getJson(h, `/api/v1/accounts/${remote}/featured_tags`)).toEqual({ status: 200, body: [] })
		expect(await getJson(h, '/api/v1/accounts/999999999999999999/featured_tags')).toEqual({
			status: 404,
			body: { error: 'Record not found' },
		})
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?', '2026-01-01', alice.id)
		expect(await getJson(h, `/api/v1/accounts/${alice.id}/featured_tags`)).toEqual({ status: 200, body: [] })
	})

	it('takes the scopes Mastodon asks for, and a user (AUTH-2)', async () => {
		const h = await community(['alice'])
		for (const scope of ['read:accounts', 'read']) {
			const token = await scopedToken(h, scope)
			expect((await h.request('/api/v1/featured_tags', bearer(token))).status).toBe(200)
			expect((await h.request('/api/v1/featured_tags/suggestions', bearer(token))).status).toBe(200)
		}
		expect((await h.request('/api/v1/featured_tags', bearer(await scopedToken(h, 'write')))).status).toBe(403)
		expect((await h.request('/api/v1/featured_tags', bearer(await appToken(h)))).status).toBe(422)
		for (const scope of ['write:accounts', 'write']) {
			const created = await h.request(
				'/api/v1/featured_tags',
				bearer(await scopedToken(h, scope), json({ name: scope.replace(':', '') }))
			)
			expect(created.status).toBe(200)
		}
		const readOnly = bearer(await scopedToken(h, 'read'), json({ name: 'x' }))
		expect((await h.request('/api/v1/featured_tags', readOnly)).status).toBe(403)
		expect((await h.request('/api/v1/featured_tags', json({}))).status).toBe(401)
	})

	it('reads the account’s featured hashtags, not its statuses (RES-7)', async () => {
		const measure = async (statuses: number) => {
			const h = await community(['alice'])
			const { alice } = h.users
			for (let i = 0; i < MAX_FEATURED_TAGS; i++) {
				await feature(h, alice, `t${i}`)
			}
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
				INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT CAST(300000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/s' || i, ?1, 'public', '2026-01-01T00:00:00.000Z'
				FROM n`,
				alice.id,
				statuses
			)
			await sql(h.store, "INSERT INTO status_tags (status_id, name, public) SELECT id, 't0', 1 FROM statuses")
			return rowsRead(h, accountFeaturedTags, { id: alice.id, present: { origin: 'https://kopje.test' } })
		}
		const few = await measure(20)
		const many = await measure(2000)
		expect(many).toBeLessThanOrEqual(few + 10)
	}, 60_000)
})

describe("a remote account's featured hashtags with stale statistics (RES-7)", () => {
	it('counts its window by status id, the statuses grown after ANALYZE', async () => {
		const h = await community(['alice'])
		const carol = await remoteAccount(h.store, 'carol')
		const dave = await remoteAccount(h.store, 'dave')
		// Statuses of `account` from `base`, each tagged #cats.
		const statuses = async (account: string, base: bigint, n: number) => {
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?3 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT CAST(?2 + i AS TEXT), 'https://remote.example/o/' || (?2 + i), ?1, 'public', '2026-01-01T00:00:00.000Z' FROM n`,
				account,
				String(base),
				n
			)
			await sql(
				h.store,
				"INSERT INTO status_tags (status_id, name) SELECT id, 'cats' FROM statuses WHERE account_id = ?1 AND id >= ?2",
				account,
				String(base)
			)
		}
		await statuses(carol, 300000000000000000n, 3)
		await sql(
			h.store,
			"INSERT INTO featured_tags (id, account_id, name, display_name) VALUES ('400000000000000000', ?1, 'cats', 'Cats')",
			carol
		)
		const run = () =>
			plannedRun(h, /FROM featured_tags f\b/, accountFeaturedTags, {
				id: carol,
				present: { origin: 'https://kopje.test' },
			})
		const { before, after } = await staleStatistics(h, {
			capture: () => run(),
			grow: async () => {
				await statuses(dave, 500000000000000000n, 20_000)
				// Other remote accounts' featured hashtags.
				await remoteAccounts(h, 10, 100)
				await sql(
					h.store,
					`INSERT INTO featured_tags (id, account_id, name, display_name)
					SELECT CAST(410000000000000000 + rowid AS TEXT), id, 'cats', 'Cats' FROM accounts WHERE domain LIKE 'd%'`
				)
			},
		})
		expect(after.result).toEqual(before.result)
		expect(after.result).toMatchObject([{ name: 'Cats', statuses_count: '3', last_status_at: '2026-01-01' }])
		expect(after.plans).toHaveLength(1)
		const { plan, rows } = after.plans[0]!
		// The count and the newest: each window through statuses_account, each status of it by id.
		expect(plan.filter((d) => d === 'SEARCH s USING INDEX sqlite_autoindex_statuses_1 (id=?)')).toHaveLength(2)
		expect(
			plan.filter((d) => /^SEARCH statuses USING (COVERING )?INDEX statuses_account \(account_id=\?\)$/.test(d))
		).toHaveLength(2)
		expect(plan[0]).toBe('SEARCH f USING INDEX sqlite_autoindex_featured_tags_2 (account_id=?)')
		expect(scansOf(plan, ['f', 'a', 's', 'statuses'])).toEqual([])
		// One entry past the account's own in each index at most.
		expect(rows - before.plans[0]!.rows).toBeLessThanOrEqual(1)
	}, 60_000)
})

describe('featured hashtags over ActivityPub', () => {
	async function setup() {
		const h = await community(['alice'])
		const fan = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, fan, h.users.alice.id)
		return h
	}

	it('sends the followers an Add when a hashtag is featured and a Remove when it no longer is', async () => {
		const h = await setup()
		const { alice } = h.users
		await feature(h, alice, 'Cats')
		await act(h, alice, '/api/v1/tags/dogs/feature')
		await act(h, alice, '/api/v1/tags/cats/unfeature')
		const created = (await getJson<FeaturedTag[]>(h, '/api/v1/featured_tags', alice.token)).body[0]
		await send(h, alice, 'DELETE', `/api/v1/featured_tags/${created?.id ?? ''}`)
		const actor = 'https://kopje.test/ap/users/alice'
		const sent = (await outbound(h.store))
			.filter(({ activity }) => activity.type !== 'Update')
			.map(({ activity, audience }) => ({ activity, audience }))
		const change = (type: string, name: string, href: string) => ({
			activity: {
				'@context': ['https://www.w3.org/ns/activitystreams', { Hashtag: 'as:Hashtag' }],
				id: expect.stringMatching(new RegExp(`^${actor}#featured_tags/\\d{18}$`)),
				type,
				actor,
				target: `${actor}/collections/featured`,
				object: { type: 'Hashtag', href: `https://kopje.test/@alice/tagged/${href}`, name },
			},
			audience: { followers: true, accounts: [] },
		})
		expect(sent).toEqual([
			change('Add', '#Cats', 'cats'),
			change('Add', '#dogs', 'dogs'),
			change('Remove', '#Cats', 'cats'),
			change('Remove', '#dogs', 'dogs'),
		])
		const deliveries = await sql<{ type: string; inbox_url: string }>(
			h.store,
			`SELECT json_extract(o.body, '$.activity.type') AS type, d.inbox_url FROM deliveries d
			JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
		)
		expect(deliveries.filter((d) => d.type !== 'Update').map((d) => d.inbox_url)).toEqual(
			Array(4).fill('https://fans.example/inbox')
		)
		// Featuring again what is featured sends nothing.
		await act(h, alice, '/api/v1/tags/birds/feature')
		await act(h, alice, '/api/v1/tags/birds/feature')
		expect((await outbound(h.store)).length).toBe(6)
	})

	it('sends the actor, with its featured collections, before its first Add, once', async () => {
		const h = await setup()
		const { alice } = h.users
		await feature(h, alice, 'cats')
		await act(h, alice, '/api/v1/tags/cats/unfeature')
		await feature(h, alice, 'dogs')
		const types = (await outbound(h.store)).map(({ activity }) => activity.type)
		expect(types).toEqual(['Update', 'Add', 'Remove', 'Add'])
		const [update] = await outbound(h.store)
		expect(update?.activity.object).toMatchObject({
			featured: 'https://kopje.test/ap/users/alice/collections/featured',
			featuredTags: 'https://kopje.test/ap/users/alice/collections/tags',
		})
	})

	it('sends no extra Update for an account whose actor was sent with its featured collections', async () => {
		const h = await setup()
		const { alice } = h.users
		const edit = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(alice.token, json({ display_name: 'Alice' }, { method: 'PATCH' }))
		)
		expect(edit.status).toBe(200)
		expect(await sql(h.store, 'SELECT featured_announced FROM local_accounts WHERE account_id = ?', alice.id)).toEqual([
			{ featured_announced: 1 },
		])
		// The profile Update is delivered, so nothing waits that a later Update could replace.
		const claimed = await h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'drain' })
		expect(claimed.deliveries).toHaveLength(1)
		for (const delivery of claimed.deliveries) {
			await h.store.completeDelivery(BUILD, {
				id: delivery.id,
				leaseToken: 'drain',
				now: NOW,
				outcome: { kind: 'delivered', status: 202 },
			})
		}
		expect(await sql(h.store, 'SELECT id FROM deliveries')).toEqual([])
		await feature(h, alice, 'cats')
		const queued = await sql<{ type: string }>(
			h.store,
			`SELECT json_extract(o.body, '$.activity.type') AS type FROM deliveries d
			JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
		)
		expect(queued.map((row) => row.type)).toEqual(['Add'])
	})
})
