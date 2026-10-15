import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import {
	act,
	community,
	follow,
	getJson,
	post,
	remoteAccount,
	seedStatus,
	type Status,
	type User,
} from './status-helpers'
import { Db } from '../src/db/sql'
import {
	filterTextLimits,
	MAX_FILTER_KEYWORDS,
	MAX_FILTER_REQUEST_TEXT,
	MAX_FILTER_TEXT,
	MAX_FILTERS,
} from '../src/domain/filters'
import { deleteStatusBatch, PURGE_BATCH } from '../src/domain/inbox'

// Filters through the API (domain/filters.ts, mastodon/filters.ts), as Mastodon 4.5 has them: the v2 endpoints with
// their keywords and statuses, the v1 layer over the same rows, their errors, and the filters applied where statuses
// are presented (warn and blur in `filtered`, hide leaving the status out, each in the contexts the filter names).

type Filter = {
	id: string
	title: string
	context: string[]
	expires_at: string | null
	filter_action: string
	keywords: { id: string; keyword: string; whole_word: boolean }[]
	statuses: { id: string; status_id: string }[]
}

type FilterResult = {
	filter: Omit<Filter, 'keywords' | 'statuses'>
	keyword_matches: string[] | null
	status_matches: string[] | null
}

function send(h: ApiHarness, user: User, method: string, path: string, body: Record<string, unknown> = {}) {
	return h.request(path, bearer(user.token, json(body, { method })))
}

async function answer(response: Response): Promise<{ status: number; body: unknown }> {
	return { status: response.status, body: await response.json() }
}

async function createFilter(h: ApiHarness, user: User, body: Record<string, unknown>): Promise<Filter> {
	const response = await act(h, user, '/api/v2/filters', body)
	expect(response.status, await response.clone().text()).toBe(200)
	return response.json()
}

async function timeline(h: ApiHarness, path: string, token: string): Promise<Status[]> {
	const { status, body } = await getJson<Status[]>(h, path, token)
	expect(status, JSON.stringify(body)).toBe(200)
	return body
}

describe('filters API', () => {
	it('creates, shows, updates and deletes a filter with its keywords, as REST::FilterSerializer shows it', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const created = await createFilter(h, alice, {
			title: 'Spoilers',
			context: ['home', ' public ', ''],
			filter_action: 'hide',
			expires_in: 3600,
			keywords_attributes: [{ keyword: 'finale' }, { keyword: 'ending', whole_word: false }, { keyword: '' }],
		})
		expect(created).toEqual({
			id: expect.stringMatching(/^\d{18}$/),
			title: 'Spoilers',
			context: ['home', 'public'],
			expires_at: new Date(NOW + 3600_000).toISOString(),
			filter_action: 'hide',
			keywords: [
				{ id: expect.stringMatching(/^\d{18}$/), keyword: 'finale', whole_word: true },
				{ id: expect.stringMatching(/^\d{18}$/), keyword: 'ending', whole_word: false },
			],
			statuses: [],
		})
		expect(await getJson(h, `/api/v2/filters/${created.id}`, alice.token)).toEqual({ status: 200, body: created })
		expect(await getJson(h, '/api/v2/filters', alice.token)).toEqual({ status: 200, body: [created] })

		const [finale, ending] = created.keywords
		const updated = await answer(
			await send(h, alice, 'PUT', `/api/v2/filters/${created.id}`, {
				title: 'Plot',
				filter_action: 'blur',
				expires_in: '',
				keywords_attributes: [
					{ id: finale!.id, keyword: 'Finale', whole_word: 'false' },
					{ id: ending!.id, _destroy: '1' },
					{ keyword: 'twist' },
					{ keyword: 'skipped', _destroy: true },
				],
			})
		)
		expect(updated).toEqual({
			status: 200,
			body: {
				...created,
				title: 'Plot',
				filter_action: 'blur',
				expires_at: null,
				keywords: [
					{ id: finale!.id, keyword: 'Finale', whole_word: false },
					{ id: expect.stringMatching(/^\d{18}$/), keyword: 'twist', whole_word: true },
				],
			},
		})
		// PATCH is the same update; what is not sent stays.
		const patched = await answer(
			await send(h, alice, 'PATCH', `/api/v2/filters/${created.id}`, { context: ['thread'] })
		)
		expect(patched.body).toMatchObject({ title: 'Plot', context: ['thread'], filter_action: 'blur' })

		expect(await answer(await send(h, alice, 'DELETE', `/api/v2/filters/${created.id}`))).toEqual({
			status: 200,
			body: {},
		})
		expect((await getJson(h, `/api/v2/filters/${created.id}`, alice.token)).status).toBe(404)
		expect(await sql(h.store, 'SELECT id FROM filter_keywords')).toEqual([])
	})

	it("answers 422 with Mastodon's validation messages", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const refused = async (method: string, path: string, body: Record<string, unknown>) =>
			answer(await send(h, alice, method, path, body))
		expect(await refused('POST', '/api/v2/filters', {})).toEqual({
			status: 422,
			body: {
				error:
					"Validation failed: Title can't be blank, Context can't be blank, Context None or invalid context supplied",
			},
		})
		expect(
			await refused('POST', '/api/v2/filters', {
				title: 't'.repeat(257),
				context: ['home', 'everywhere'],
				filter_action: 'delete',
				keywords_attributes: [{ keyword: 'k'.repeat(513) }, { whole_word: true }],
			})
		).toEqual({
			status: 422,
			body: {
				error:
					'Validation failed: Action is not included in the list, Keywords keyword is too long (maximum is 512 characters), ' +
					"Keywords keyword can't be blank, Title is too long (maximum is 256 characters), " +
					'Context None or invalid context supplied',
			},
		})
		// 256 characters and a 512-character keyword are allowed, counted as code points.
		const filter = await createFilter(h, alice, {
			title: '🙂'.repeat(256),
			context: ['home'],
			keywords_attributes: [{ keyword: '🙂'.repeat(512) }],
		})
		expect(
			await refused('PUT', `/api/v2/filters/${filter.id}`, { keywords_attributes: [{ id: '1', keyword: 'x' }] })
		).toEqual({
			status: 404,
			body: { error: 'Record not found' },
		})
		expect(await refused('PUT', `/api/v2/filters/${filter.id}`, { expires_in: '9'.repeat(30) })).toEqual({
			status: 422,
			body: { error: 'Invalid date supplied' },
		})
		expect(await refused('POST', `/api/v2/filters/${filter.id}/keywords`, { keyword: ' ' })).toEqual({
			status: 422,
			body: { error: "Validation failed: Keyword can't be blank" },
		})
		expect(await refused('POST', `/api/v2/filters/${filter.id}/statuses`, {})).toEqual({
			status: 422,
			body: { error: 'Validation failed: Status must exist' },
		})
		// Nothing of a refused request was written.
		expect(await sql(h.store, 'SELECT count(*) AS n FROM filters')).toEqual([{ n: 1 }])
	})

	it('manages keywords and statuses on their own endpoints', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const filter = await createFilter(h, alice, { title: 'f', context: ['home'] })
		const keyword = await answer(
			await act(h, alice, `/api/v2/filters/${filter.id}/keywords`, { keyword: 'cat', whole_word: false })
		)
		expect(keyword).toEqual({
			status: 200,
			body: { id: expect.stringMatching(/^\d{18}$/), keyword: 'cat', whole_word: false },
		})
		const keywordId = (keyword.body as { id: string }).id
		expect(await getJson(h, `/api/v2/filters/keywords/${keywordId}`, alice.token)).toEqual(keyword)
		expect(
			await answer(await send(h, alice, 'PUT', `/api/v2/filters/keywords/${keywordId}`, { keyword: 'dog' }))
		).toEqual({
			status: 200,
			body: { id: keywordId, keyword: 'dog', whole_word: false },
		})
		expect(await getJson(h, `/api/v2/filters/${filter.id}/keywords`, alice.token)).toEqual({
			status: 200,
			body: [{ id: keywordId, keyword: 'dog', whole_word: false }],
		})

		const status = await post(h, bob, { status: 'hello', visibility: 'public' })
		const added = await answer(await act(h, alice, `/api/v2/filters/${filter.id}/statuses`, { status_id: status.id }))
		expect(added).toEqual({ status: 200, body: { id: expect.stringMatching(/^\d{18}$/), status_id: status.id } })
		const filterStatusId = (added.body as { id: string }).id
		expect(
			await answer(await act(h, alice, `/api/v2/filters/${filter.id}/statuses`, { status_id: status.id }))
		).toEqual({
			status: 422,
			body: { error: 'Validation failed: Status has already been taken' },
		})
		expect(await getJson(h, `/api/v2/filters/statuses/${filterStatusId}`, alice.token)).toEqual(added)
		expect(await getJson(h, `/api/v2/filters/${filter.id}/statuses`, alice.token)).toEqual({
			status: 200,
			body: [added.body],
		})
		expect((await getJson<Filter>(h, `/api/v2/filters/${filter.id}`, alice.token)).body).toMatchObject({
			keywords: [{ id: keywordId }],
			statuses: [added.body],
		})

		expect((await send(h, alice, 'DELETE', `/api/v2/filters/keywords/${keywordId}`)).status).toBe(200)
		expect((await send(h, alice, 'DELETE', `/api/v2/filters/statuses/${filterStatusId}`)).status).toBe(200)
		expect((await getJson(h, `/api/v2/filters/keywords/${keywordId}`, alice.token)).status).toBe(404)
		expect((await getJson(h, `/api/v2/filters/statuses/${filterStatusId}`, alice.token)).status).toBe(404)
		// The filter stays without them.
		expect((await getJson<Filter>(h, `/api/v2/filters/${filter.id}`, alice.token)).body).toMatchObject({
			keywords: [],
			statuses: [],
		})
	})

	it("never shows or changes another account's filter, keyword or filter status", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const status = await post(h, alice, { status: 'mine', visibility: 'public' })
		const filter = await createFilter(h, alice, {
			title: 'f',
			context: ['home'],
			keywords_attributes: [{ keyword: 'secret' }],
		})
		const keywordId = filter.keywords[0]!.id
		const filterStatus = (
			await (
				await act(h, alice, `/api/v2/filters/${filter.id}/statuses`, { status_id: status.id })
			).json<{
				id: string
			}>()
		).id
		const notFound = { status: 404, body: { error: 'Record not found' } }
		for (const [method, path] of [
			['GET', `/api/v2/filters/${filter.id}`],
			['PUT', `/api/v2/filters/${filter.id}`],
			['DELETE', `/api/v2/filters/${filter.id}`],
			['GET', `/api/v2/filters/${filter.id}/keywords`],
			['POST', `/api/v2/filters/${filter.id}/keywords`],
			['GET', `/api/v2/filters/${filter.id}/statuses`],
			['POST', `/api/v2/filters/${filter.id}/statuses`],
			['GET', `/api/v2/filters/keywords/${keywordId}`],
			['PUT', `/api/v2/filters/keywords/${keywordId}`],
			['DELETE', `/api/v2/filters/keywords/${keywordId}`],
			['GET', `/api/v2/filters/statuses/${filterStatus}`],
			['DELETE', `/api/v2/filters/statuses/${filterStatus}`],
			['GET', `/api/v1/filters/${keywordId}`],
			['PUT', `/api/v1/filters/${keywordId}`],
			['DELETE', `/api/v1/filters/${keywordId}`],
		] as const) {
			const body = { title: 'x', keyword: 'x', phrase: 'x', status_id: status.id }
			const response =
				method === 'GET'
					? await h.request(path, bearer(bob.token))
					: await send(h, bob, method, path, method === 'DELETE' ? {} : body)
			expect({ path: `${method} ${path}`, ...(await answer(response)) }).toEqual({
				path: `${method} ${path}`,
				...notFound,
			})
		}
		expect(await getJson(h, '/api/v2/filters', bob.token)).toEqual({ status: 200, body: [] })
		expect(await getJson(h, '/api/v1/filters', bob.token)).toEqual({ status: 200, body: [] })
		expect((await getJson<Filter>(h, `/api/v2/filters/${filter.id}`, alice.token)).body).toMatchObject({
			title: 'f',
			keywords: [{ id: keywordId, keyword: 'secret' }],
			statuses: [{ id: filterStatus }],
		})
	})

	it('refuses a filter status for a status the viewer may not see as a missing one, and lists one that became invisible by id', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const filter = await createFilter(h, alice, { title: 'f', context: ['home'] })
		const hidden = await post(h, bob, { status: 'only for bob', visibility: 'direct' })
		// Refused as a missing status is, so the two cannot be told apart.
		const refused = { status: 422, body: { error: 'Validation failed: Status must exist' } }
		expect(
			await answer(await act(h, alice, `/api/v2/filters/${filter.id}/statuses`, { status_id: hidden.id }))
		).toEqual(refused)
		expect(
			await answer(await act(h, alice, `/api/v2/filters/${filter.id}/statuses`, { status_id: '999999999999999999' }))
		).toEqual(refused)

		await follow(h, alice, bob.id)
		const privateStatus = await post(h, bob, { status: 'followers', visibility: 'private' })
		const added = await (
			await act(h, alice, `/api/v2/filters/${filter.id}/statuses`, { status_id: privateStatus.id })
		).json<{ id: string }>()
		expect((await act(h, alice, `/api/v1/accounts/${bob.id}/unfollow`)).status).toBe(200)
		// Alice may no longer see it: the filter status is listed by its ids only, as Mastodon lists it.
		expect((await getJson(h, `/api/v1/statuses/${privateStatus.id}`, alice.token)).status).toBe(404)
		expect(await getJson(h, `/api/v2/filters/${filter.id}/statuses`, alice.token)).toEqual({
			status: 200,
			body: [{ id: added.id, status_id: privateStatus.id }],
		})
		// A deleted status takes its filter statuses with it.
		expect((await send(h, bob, 'DELETE', `/api/v1/statuses/${privateStatus.id}`)).status).toBe(200)
		expect(await getJson(h, `/api/v2/filters/${filter.id}/statuses`, alice.token)).toEqual({ status: 200, body: [] })
	})

	it('maps the v1 API onto the same filters and keywords', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const created = await answer(
			await act(h, alice, '/api/v1/filters', { phrase: 'cat', context: ['home', 'notifications'], irreversible: true })
		)
		expect(created).toEqual({
			status: 200,
			body: {
				id: expect.stringMatching(/^\d{18}$/),
				phrase: 'cat',
				context: ['home', 'notifications'],
				whole_word: true,
				expires_at: null,
				irreversible: true,
			},
		})
		const v1 = created.body as { id: string }
		const [v2] = (await getJson<Filter[]>(h, '/api/v2/filters', alice.token)).body
		expect(v2).toMatchObject({
			title: 'cat',
			context: ['home', 'notifications'],
			filter_action: 'hide',
			keywords: [{ id: v1.id, keyword: 'cat', whole_word: true }],
		})
		expect(await getJson(h, '/api/v1/filters', alice.token)).toEqual({ status: 200, body: [created.body] })
		expect(await getJson(h, `/api/v1/filters/${v1.id}`, alice.token)).toEqual(created)

		const updated = await answer(
			await send(h, alice, 'PUT', `/api/v1/filters/${v1.id}`, { phrase: 'dog', whole_word: false, irreversible: false })
		)
		expect(updated).toEqual({
			status: 200,
			body: { ...(created.body as object), phrase: 'dog', whole_word: false, irreversible: false },
		})
		expect((await getJson<Filter>(h, `/api/v2/filters/${v2!.id}`, alice.token)).body).toMatchObject({
			title: 'dog',
			filter_action: 'warn',
		})

		// A filter with more keywords takes keyword changes, but not changes of the filter itself.
		await act(h, alice, `/api/v2/filters/${v2!.id}/keywords`, { keyword: 'bird' })
		expect(await answer(await send(h, alice, 'PUT', `/api/v1/filters/${v1.id}`, { whole_word: true }))).toMatchObject({
			status: 200,
			body: { phrase: 'dog', whole_word: true },
		})
		expect(await answer(await send(h, alice, 'PUT', `/api/v1/filters/${v1.id}`, { phrase: 'fish' }))).toEqual({
			status: 422,
			body: {
				error:
					'These parameters cannot be changed from this application because they apply to more than one filter keyword. Use a more recent application or the web interface.',
			},
		})
		expect((await getJson<{ phrase: string }>(h, `/api/v1/filters/${v1.id}`, alice.token)).body.phrase).toBe('dog')

		expect(await answer(await act(h, alice, '/api/v1/filters', { phrase: '', context: ['home'] }))).toEqual({
			status: 422,
			body: { error: "Validation failed: Title can't be blank" },
		})
		// Deleting a v1 filter deletes the keyword; the filter stays with its other keyword.
		expect((await send(h, alice, 'DELETE', `/api/v1/filters/${v1.id}`)).status).toBe(200)
		expect((await getJson<Filter>(h, `/api/v2/filters/${v2!.id}`, alice.token)).body.keywords).toEqual([
			expect.objectContaining({ keyword: 'bird' }),
		])
	})

	it('caps the filters of an account and the keywords of a filter', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO filters (id, account_id, title, context) SELECT printf('7%017d', i), ?1, 'f' || i, '["home"]' FROM n`,
			alice.id,
			MAX_FILTERS - 1
		)
		const last = await createFilter(h, alice, {
			title: 'last',
			context: ['home'],
			keywords_attributes: Array.from({ length: MAX_FILTER_KEYWORDS }, (_, i) => ({ keyword: `k${i}` })),
		})
		expect(last.keywords).toHaveLength(MAX_FILTER_KEYWORDS)
		expect(await answer(await act(h, alice, '/api/v2/filters', { title: 'over', context: ['home'] }))).toEqual({
			status: 422,
			body: { error: 'Validation failed: You have reached the maximum number of filters' },
		})
		expect(await answer(await act(h, alice, '/api/v1/filters', { phrase: 'over', context: ['home'] }))).toEqual({
			status: 422,
			body: { error: 'Validation failed: You have reached the maximum number of filters' },
		})
		const tooMany = {
			status: 422,
			body: { error: 'Validation failed: You have reached the maximum number of keywords for this filter' },
		}
		expect(await answer(await act(h, alice, `/api/v2/filters/${last.id}/keywords`, { keyword: 'over' }))).toEqual(
			tooMany
		)
		expect(
			await answer(
				await send(h, alice, 'PUT', `/api/v2/filters/${last.id}`, { keywords_attributes: [{ keyword: 'over' }] })
			)
		).toEqual(tooMany)
		// Replacing a keyword in the same request stays within the cap.
		expect(
			await answer(
				await send(h, alice, 'PUT', `/api/v2/filters/${last.id}`, {
					keywords_attributes: [{ id: last.keywords[0]!.id, _destroy: true }, { keyword: 'swap' }],
				})
			)
		).toMatchObject({ status: 200 })
	})
})

describe('filters applied', () => {
	async function setup() {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, alice, bob.id)
		return { h, alice, bob }
	}

	it('reports every active filter that matches, whatever its context and action, and removes nothing', async () => {
		const { h, alice, bob } = await setup()
		const plain = await post(h, bob, { status: 'nothing here', visibility: 'public' })
		const cat = await post(h, bob, { status: 'The Cat sat', visibility: 'public' })
		const dog = await post(h, bob, { status: 'a dog barked', visibility: 'public' })
		const warn = await createFilter(h, alice, {
			title: 'cats',
			context: ['public'],
			keywords_attributes: [{ keyword: 'cat' }],
		})
		const hide = await createFilter(h, alice, {
			title: 'animals',
			context: ['notifications'],
			filter_action: 'hide',
			keywords_attributes: [{ keyword: 'dog' }, { keyword: 'cat' }],
		})
		await act(h, alice, `/api/v2/filters/${hide.id}/statuses`, { status_id: plain.id })
		const entity = (f: Filter) => ({
			id: f.id,
			title: f.title,
			context: f.context,
			expires_at: null,
			filter_action: f.filter_action,
		})
		const results = {
			[plain.id]: [{ filter: entity(hide), keyword_matches: null, status_matches: [plain.id] }],
			[cat.id]: [
				{ filter: entity(warn), keyword_matches: ['Cat'], status_matches: null },
				{ filter: entity(hide), keyword_matches: ['Cat'], status_matches: [] },
			],
			[dog.id]: [{ filter: entity(hide), keyword_matches: ['dog'], status_matches: [] }],
		}
		const response = await h.request('/api/v1/timelines/home?limit=3', bearer(alice.token))
		const page = await response.json<Status[]>()
		expect(page.map((s) => [s.id, s.filtered])).toEqual([dog, cat, plain].map((s) => [s.id, results[s.id]]))
		expect(response.headers.get('link')).toContain(`max_id=${plain.id}>; rel="next"`)

		// Everywhere Mastodon's StatusSerializer has it for a signed-in viewer.
		expect((await getJson<Status>(h, `/api/v1/statuses/${cat.id}`, alice.token)).body.filtered).toEqual(results[cat.id])
		const favourited = await act(h, alice, `/api/v1/statuses/${dog.id}/favourite`)
		expect((await favourited.json<Status>()).filtered).toEqual(results[dog.id])
		await act(h, alice, `/api/v1/statuses/${cat.id}/bookmark`)
		expect((await timeline(h, '/api/v1/favourites', alice.token)).map((s) => s.filtered)).toEqual([results[dog.id]])
		expect((await timeline(h, '/api/v1/bookmarks', alice.token)).map((s) => s.filtered)).toEqual([results[cat.id]])
		expect((await timeline(h, '/api/v1/timelines/public', alice.token)).map((s) => s.id)).toEqual([
			dog.id,
			cat.id,
			plain.id,
		])
		// Another viewer is not filtered by alice's filters, and an anonymous one has no `filtered`.
		expect((await timeline(h, '/api/v1/timelines/public', bob.token)).map((s) => s.filtered)).toEqual([[], [], []])
		expect((await getJson<Status>(h, `/api/v1/statuses/${cat.id}`)).body).not.toHaveProperty('filtered')
	})

	it('never matches an expired filter', async () => {
		const { h, alice, bob } = await setup()
		const status = await post(h, bob, { status: 'spoiler ahead', visibility: 'public' })
		await createFilter(h, alice, {
			title: 'spoilers',
			context: ['home'],
			filter_action: 'hide',
			keywords_attributes: [{ keyword: 'spoiler' }],
		})
		expect((await timeline(h, '/api/v1/timelines/home', alice.token))[0]!.filtered).toHaveLength(1)
		await sql(h.store, 'UPDATE filters SET expires_at = ?', new Date(NOW - 1000).toISOString())
		expect((await timeline(h, '/api/v1/timelines/home', alice.token)).map((s) => [s.id, s.filtered])).toEqual([
			[status.id, []],
		])
		// expires_in=0 expires at once.
		await act(h, alice, '/api/v2/filters', {
			title: 'gone',
			context: ['home'],
			expires_in: 0,
			keywords_attributes: [{ keyword: 'spoiler' }],
		})
		expect((await timeline(h, '/api/v1/timelines/home', alice.token))[0]!.filtered).toEqual([])
	})

	it('matches whole words as Mastodon builds its regex, over spoiler text, text and media descriptions', async () => {
		const { h, alice, bob } = await setup()
		const statuses = {
			inside: await post(h, bob, { status: 'concatenate', visibility: 'public' }),
			word: await post(h, bob, { status: 'my CAT!', visibility: 'public' }),
			spoiler: await post(h, bob, { status: 'body', spoiler_text: 'cat inside', visibility: 'public' }),
			unicode: await post(h, bob, { status: 'caté', visibility: 'public' }),
			hashtag: await post(h, bob, { status: 'see #cats', visibility: 'public' }),
			symbol: await post(h, bob, { status: 'price: $5!', visibility: 'public' }),
		}
		const media = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', content: '<p>photo</p>' })
		await sql(
			h.store,
			"INSERT INTO media_attachments (id, account_id, status_id, type, url, description) VALUES ('900000000000000001', ?, ?, 'image', 'https://remote.example/a.png', 'a cat on a mat')",
			bob.id,
			media
		)
		await createFilter(h, alice, {
			title: 'cats',
			context: ['account'],
			keywords_attributes: [{ keyword: 'cat' }, { keyword: '$5', whole_word: true }],
		})
		const shown = await timeline(h, `/api/v1/accounts/${bob.id}/statuses?limit=40`, alice.token)
		const matched = (id: string) =>
			(shown.find((s) => s.id === id)!.filtered as FilterResult[]).map((r) => r.keyword_matches)
		expect(matched(statuses.inside.id)).toEqual([])
		expect(matched(statuses.word.id)).toEqual([['CAT']])
		expect(matched(statuses.spoiler.id)).toEqual([['cat']])
		expect(matched(statuses.unicode.id)).toEqual([])
		expect(matched(statuses.hashtag.id)).toEqual([])
		// A keyword that starts and ends with a non-word character has no boundary to keep.
		expect(matched(statuses.symbol.id)).toEqual([['$5']])
		expect(matched(media)).toEqual([['cat']])

		await createFilter(h, alice, {
			title: 'substrings',
			context: ['account'],
			keywords_attributes: [{ keyword: 'CAT', whole_word: false }],
		})
		const again = await timeline(h, `/api/v1/accounts/${bob.id}/statuses?limit=40`, alice.token)
		expect(
			(again.find((s) => s.id === statuses.inside.id)!.filtered as FilterResult[]).map((r) => r.keyword_matches)
		).toEqual([['cat']])
	})

	it("matches a keyword in a poll's choices (Status#searchable_text), for a boost on its original's", async () => {
		const { h, alice, bob } = await setup()
		const polled = await post(h, bob, {
			status: 'which pet?',
			visibility: 'public',
			poll: { options: ['dog', 'cat'], expires_in: 600 },
		})
		const plain = await post(h, bob, { status: 'no poll here', visibility: 'public' })
		const boost = await act(h, alice, `/api/v1/statuses/${polled.id}/reblog`)
		expect(boost.status).toBe(200)
		await createFilter(h, alice, { title: 'cats', context: ['home'], keywords_attributes: [{ keyword: 'cat' }] })
		const shown = await timeline(h, '/api/v1/timelines/home?limit=40', alice.token)
		const matches = (s: Status) => (s.filtered as FilterResult[]).map((r) => r.keyword_matches)
		expect(matches(shown.find((s) => s.id === polled.id)!)).toEqual([['cat']])
		expect(matches(shown.find((s) => s.id === plain.id)!)).toEqual([])
		const reblog = shown.find((s) => s.reblog !== null)!
		expect(matches(reblog)).toEqual([['cat']])
	})

	it('matches a status a filter names, and a boost of it, with the original carrying the same results', async () => {
		const { h, alice, bob } = await setup()
		const remote = await remoteAccount(h.store, 'carol')
		const original = await seedStatus(h.store, { accountId: remote, visibility: 'public', content: '<p>news</p>' })
		const boost = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', reblogOfId: original })
		const filter = await createFilter(h, alice, { title: 'this one', context: ['home'] })
		await act(h, alice, `/api/v2/filters/${filter.id}/statuses`, { status_id: original })
		const [shown] = await timeline(h, '/api/v1/timelines/home', alice.token)
		expect(shown!.id).toBe(boost)
		const results = [
			{
				filter: { id: filter.id, title: 'this one', context: ['home'], expires_at: null, filter_action: 'warn' },
				keyword_matches: null,
				status_matches: [original],
			},
		]
		expect(shown!.filtered).toEqual(results)
		expect(shown!.reblog!.filtered).toEqual(results)

		// A hide filter is reported too; the client hides the status.
		await send(h, alice, 'PUT', `/api/v2/filters/${filter.id}`, { filter_action: 'hide' })
		const [again] = await timeline(h, '/api/v1/timelines/home', alice.token)
		expect((again!.filtered as FilterResult[]).map((r) => r.filter.filter_action)).toEqual(['hide'])
	})

	it("reports matches on a notification's status and removes no notification", async () => {
		const { h, alice, bob } = await setup()
		const mention = await post(h, bob, { status: '@alice secret plans', visibility: 'public' })
		await createFilter(h, alice, {
			title: 'plans',
			context: ['notifications'],
			filter_action: 'hide',
			keywords_attributes: [{ keyword: 'plans' }],
		})
		const listed = await getJson<{ id: string; status?: Status }[]>(h, '/api/v1/notifications', alice.token)
		expect(listed.body.map((n) => n.status?.id)).toEqual([mention.id])
		expect((listed.body[0]!.status!.filtered as FilterResult[]).map((r) => r.keyword_matches)).toEqual([['plans']])
		expect((await getJson(h, `/api/v1/notifications/${listed.body[0]!.id}`, alice.token)).status).toBe(200)
	})
})

describe('filter matching work', () => {
	it('matches a page of the longest texts against filters at the caps within a generous time (RES-2)', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'carol')
		for (let i = 0; i < 40; i++) {
			await seedStatus(h.store, {
				accountId: remote,
				visibility: 'public',
				content: `<p>${'a'.repeat(20_000)}</p><p>${'ab '.repeat(5_000)}</p>`,
			})
		}
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
			INSERT INTO filters (id, account_id, title, context, action) SELECT printf('7%017d', i), ?1, 'f' || i, '["account"]', 'hide' FROM n`,
			alice.id,
			MAX_FILTERS
		)
		// Keywords that run along the text before they fail: long ones of a's ending in digits, and short ones of a's that
		// occur everywhere but never as a whole word.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO filter_keywords (id, filter_id, keyword, whole_word)
			SELECT printf('8%017d', f.rowid * 1000 + n.i), f.id,
				CASE WHEN n.i % 2 = 0 THEN substr(hex(zeroblob(253)), 1, 506) || printf('%06d', f.rowid * 1000 + n.i)
					ELSE substr(hex(zeroblob(64)), 1, n.i) END,
				1
			FROM filters f CROSS JOIN n`,
			MAX_FILTER_KEYWORDS
		)
		await sql(h.store, "UPDATE filter_keywords SET keyword = replace(keyword, '0', 'a') WHERE length(keyword) < 512")
		await sql(
			h.store,
			"UPDATE filter_keywords SET keyword = replace(substr(keyword, 1, 506), '0', 'a') || substr(keyword, 507) WHERE length(keyword) = 512"
		)
		const started = performance.now()
		const shown = await timeline(h, `/api/v1/accounts/${remote}/statuses?limit=40`, alice.token)
		const elapsed = performance.now() - started
		expect(shown.map((s) => s.filtered)).toEqual(Array.from({ length: 40 }, () => []))
		// Bounded matching takes about a second locally and several on a busy CI runner; a regression to unbounded
		// matching (uncut texts, or a pattern that backtracks) multiplies that many times over, so the bound leaves room
		// for the runner and still fails on the regression.
		expect(elapsed).toBeLessThan(20_000)
	}, 60_000)

	it('matches a status on its first MAX_FILTER_TEXT code units only', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'carol')
		const early = await seedStatus(h.store, {
			accountId: remote,
			visibility: 'public',
			content: `<p>${'x '.repeat(MAX_FILTER_TEXT / 2 - 10)}needle</p>`,
		})
		const late = await seedStatus(h.store, {
			accountId: remote,
			visibility: 'public',
			content: `<p>${'x '.repeat(MAX_FILTER_TEXT / 2)}needle</p>`,
		})
		await createFilter(h, alice, {
			title: 'needle',
			context: ['account'],
			filter_action: 'hide',
			keywords_attributes: [{ keyword: 'needle' }],
		})
		const shown = await timeline(h, `/api/v1/accounts/${remote}/statuses`, alice.token)
		expect(shown.map((s) => [s.id, (s.filtered as FilterResult[]).length])).toEqual([
			[late, 0],
			[early, 1],
		])
	})
})

describe('filter review fixes', () => {
	it('stores each context once, however often it is sent', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const many = Array.from({ length: 100_000 }, () => 'home')
		const v2 = await act(h, alice, '/api/v2/filters', { title: 't', context: [...many, 'public'] })
		const v2Text = await v2.text()
		expect(v2.status).toBe(200)
		expect(JSON.parse(v2Text)).toMatchObject({ context: ['home', 'public'] })
		expect(v2Text.length).toBeLessThan(1_000)
		const v1 = await act(h, alice, '/api/v1/filters', { phrase: 'p', context: many })
		expect(await v1.json()).toMatchObject({ context: ['home'] })
		expect(await answer(await act(h, alice, '/api/v2/filters', { title: 't', context: [...many, 'nowhere'] }))).toEqual(
			{
				status: 422,
				body: { error: 'Validation failed: Context None or invalid context supplied' },
			}
		)
	})

	it('applies repeated keywords_attributes entries of one keyword in order, as Rails does', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const filter = await createFilter(h, alice, {
			title: 't',
			context: ['home'],
			keywords_attributes: [{ keyword: 'cat' }],
		})
		const id = filter.keywords[0]!.id
		const updated = await answer(
			await send(h, alice, 'PUT', `/api/v2/filters/${filter.id}`, {
				keywords_attributes: [
					{ id, keyword: 'dog' },
					{ id, whole_word: false },
				],
			})
		)
		expect(updated).toMatchObject({ status: 200, body: { keywords: [{ id, keyword: 'dog', whole_word: false }] } })
		const destroyed = await answer(
			await send(h, alice, 'PUT', `/api/v2/filters/${filter.id}`, {
				keywords_attributes: [
					{ id, _destroy: true },
					{ id, keyword: 'bird' },
				],
			})
		)
		expect(destroyed).toMatchObject({ status: 200, body: { keywords: [] } })
	})

	it('creates and deletes v1 filters without using up the filter cap', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		for (let i = 0; i < 60; i++) {
			const created = await act(h, alice, '/api/v1/filters', { phrase: `p${i}`, context: ['home'] })
			expect(created.status, await created.clone().text()).toBe(200)
			const { id } = await created.json<{ id: string }>()
			expect((await send(h, alice, 'DELETE', `/api/v1/filters/${id}`)).status).toBe(200)
		}
		expect(await sql(h.store, 'SELECT count(*) AS n FROM filters')).toEqual([{ n: 0 }])
		// A filter that keeps another keyword, or a status, stays.
		const kept = await createFilter(h, alice, {
			title: 'kept',
			context: ['home'],
			keywords_attributes: [{ keyword: 'a' }, { keyword: 'b' }],
		})
		expect((await send(h, alice, 'DELETE', `/api/v1/filters/${kept.keywords[0]!.id}`)).status).toBe(200)
		expect((await getJson<Filter>(h, `/api/v2/filters/${kept.id}`, alice.token)).body.keywords).toHaveLength(1)
	})

	it('folds case as the iu flags do, and keeps whole-word boundaries at Unicode word characters', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'carol')
		const texts = ['ΟΔΟΣ', 'οδος', 'οδός', 'kıta', 'KITA', 'Iıİi']
		const ids: string[] = []
		for (const text of texts) {
			ids.push(await seedStatus(h.store, { accountId: remote, visibility: 'public', content: `<p>${text}</p>` }))
		}
		await createFilter(h, alice, {
			title: 'sigma',
			context: ['account'],
			keywords_attributes: [{ keyword: 'οδοσ' }, { keyword: 'kıta' }],
		})
		const shown = await timeline(h, `/api/v1/accounts/${remote}/statuses`, alice.token)
		const matches = (i: number) =>
			((shown.find((s) => s.id === ids[i])!.filtered ?? []) as FilterResult[]).map((r) => r.keyword_matches)
		// σ, ς and Σ fold together; ό does not fold to ο.
		expect([matches(0), matches(1), matches(2)]).toEqual([[['ΟΔΟΣ']], [['οδος']], []])
		// Dotless ı folds to nothing else (as in Ruby): kıta matches itself, not KITA.
		expect([matches(3), matches(4)]).toEqual([[['kıta']], []])
	})

	it('matches a remote status on its lines as Mastodon extracts them, never across a line break', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'carol')
		const broken = await seedStatus(h.store, {
			accountId: remote,
			visibility: 'public',
			content: '<p>breaking<br>news</p><p>more</p>',
		})
		const joined = await seedStatus(h.store, {
			accountId: remote,
			visibility: 'public',
			content: '<p>breaking news</p>',
		})
		await createFilter(h, alice, {
			title: 'news',
			context: ['account'],
			keywords_attributes: [
				{ keyword: 'breaking news', whole_word: false },
				{ keyword: 'news\nmore', whole_word: false },
			],
		})
		const shown = await timeline(h, `/api/v1/accounts/${remote}/statuses`, alice.token)
		const matches = (id: string) =>
			(shown.find((s) => s.id === id)!.filtered as FilterResult[]).map((r) => r.keyword_matches)
		expect(matches(broken)).toEqual([['news\nmore']])
		expect(matches(joined)).toEqual([['breaking news']])
	})

	it("shares the text budget evenly over a thread's statuses, and matches every status on its beginning", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'carol')
		// Each status's text is about 10,000 code units with "needle" at its end; the last reply starts with "pin".
		const deep = `${'x '.repeat(MAX_FILTER_TEXT / 2 - 10)}needle`
		const chain: string[] = []
		for (let i = 0; i < 25; i++) {
			chain.push(
				await seedStatus(h.store, {
					accountId: remote,
					visibility: 'public',
					content: `<p>${deep}</p>`,
					...(i === 0 ? {} : { inReplyToId: chain[i - 1] }),
				})
			)
		}
		const middle = chain[12]!
		for (let i = 0; i < 25; i++) {
			await seedStatus(h.store, {
				accountId: remote,
				visibility: 'public',
				content: `<p>${i === 24 ? 'pin ' : ''}${deep}</p>`,
				inReplyToId: middle,
			})
		}
		await createFilter(h, alice, {
			title: 'n',
			context: ['thread'],
			filter_action: 'hide',
			keywords_attributes: [{ keyword: 'needle' }, { keyword: 'pin' }],
		})
		const { body } = await getJson<{ ancestors: Status[]; descendants: Status[] }>(
			h,
			`/api/v1/statuses/${middle}/context`,
			alice.token
		)
		const all = [...body.ancestors, ...body.descendants]
		expect(all).toHaveLength(49)
		// 49 statuses share MAX_FILTER_REQUEST_TEXT: about 8,163 code units each, short of every "needle", while the
		// last status's "pin", at its beginning, is matched.
		const matched = all.map((s) => (s.filtered as FilterResult[]).flatMap((r) => r.keyword_matches ?? []))
		expect(matched.slice(0, -1)).toEqual(Array.from({ length: 48 }, () => []))
		expect(matched.at(-1)).toEqual(['pin'])

		// A page of 40 such statuses is matched in full.
		const page = await timeline(h, `/api/v1/accounts/${remote}/statuses?limit=40`, alice.token)
		await createFilter(h, alice, { title: 'a', context: ['account'], keywords_attributes: [{ keyword: 'needle' }] })
		const again = await timeline(h, `/api/v1/accounts/${remote}/statuses?limit=40`, alice.token)
		expect(page).toHaveLength(40)
		expect(again.map((s) => (s.filtered as FilterResult[]).length > 0)).toEqual(Array.from({ length: 40 }, () => true))
	}, 60_000)
})

describe('filter text budget and word characters', () => {
	it('gives the budget a short status leaves to the long ones (water-filling)', () => {
		expect(filterTextLimits([10, 20, 30])).toEqual([10, 20, 30])
		// 41 texts at the cap: each gets an even share of the budget.
		const even = filterTextLimits(Array.from({ length: 41 }, () => MAX_FILTER_TEXT))
		expect(new Set(even)).toEqual(new Set([Math.floor(MAX_FILTER_REQUEST_TEXT / 41)]))
		// Short texts are matched whole, and the long ones share what they leave.
		const mixed = filterTextLimits([5, ...Array.from({ length: 50 }, () => MAX_FILTER_TEXT)])
		expect(mixed[0]).toBe(5)
		expect(mixed[1]).toBe(Math.floor((MAX_FILTER_REQUEST_TEXT - 5) / 50))
		expect(mixed.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_FILTER_REQUEST_TEXT)
	})

	it('matches a needle deep in the one long reply among a thousand short ones', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'carol')
		const root = await seedStatus(h.store, { accountId: remote, visibility: 'public', content: '<p>root</p>' })
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
			INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id, visibility,
				content, published_at)
			SELECT printf('3%017d', i), 'https://remote.example/objects/r' || i, ?1, s.uri, s.id, ?1, 'public',
				'<p>hello</p>', s.published_at
			FROM n, statuses s WHERE s.id = ?2`,
			remote,
			root
		)
		const long = await seedStatus(h.store, {
			accountId: remote,
			visibility: 'public',
			content: `<p>${'x'.repeat(468)} needle</p>`,
			inReplyToId: root,
		})
		await createFilter(h, alice, { title: 'n', context: ['thread'], keywords_attributes: [{ keyword: 'needle' }] })
		const { body } = await getJson<{ ancestors: Status[]; descendants: Status[] }>(
			h,
			`/api/v1/statuses/${root}/context`,
			alice.token
		)
		expect(body.descendants).toHaveLength(1001)
		const matched = body.descendants.filter((s) => (s.filtered as FilterResult[]).length > 0).map((s) => s.id)
		expect(matched).toEqual([long])
	}, 60_000)

	it("decides word characters as Onigmo's [[:word:]] does: Alphabetic, marks, Nd, Pc and join controls", async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'carol')
		const cases = {
			half: '1½ cups',
			circled: 'xⒶ',
			circledAlone: 'Ⓐ!',
			roman: 'XⅫ',
			romanAlone: '(Ⅻ)',
			zwj: 'ab‍cd',
			ascii: 'abc def',
		}
		const ids = new Map<string, string>()
		for (const [name, text] of Object.entries(cases)) {
			ids.set(name, await seedStatus(h.store, { accountId: remote, visibility: 'public', content: `<p>${text}</p>` }))
		}
		await createFilter(h, alice, {
			title: 'w',
			context: ['account'],
			keywords_attributes: [
				{ keyword: '½' },
				{ keyword: 'Ⓐ' },
				{ keyword: 'Ⅻ' },
				{ keyword: 'ab' },
				{ keyword: 'def' },
			],
		})
		const shown = await timeline(h, `/api/v1/accounts/${remote}/statuses?limit=40`, alice.token)
		const matched = (name: string) =>
			(shown.find((s) => s.id === ids.get(name))!.filtered as FilterResult[]).flatMap((r) => r.keyword_matches ?? [])
		// ½ is not a word character (No): no boundary is added, so it matches inside "1½".
		expect(matched('half')).toEqual(['½'])
		// Ⓐ and Ⅻ are Alphabetic: whole-word boundaries apply.
		expect([matched('circled'), matched('circledAlone')]).toEqual([[], ['Ⓐ']])
		expect([matched('roman'), matched('romanAlone')]).toEqual([[], ['Ⅻ']])
		// A zero-width joiner continues the word, so "ab" is not a whole word in "ab‍cd".
		expect(matched('zwj')).toEqual([])
		expect(matched('ascii')).toEqual(['def'])
	})
})

describe('filter matching at a cut, and filter statuses in batched deletes', () => {
	it('never takes the cut of a text for a word boundary', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'carol')
		const root = await seedStatus(h.store, { accountId: remote, visibility: 'public', content: '<p>root</p>' })
		// 41 replies at the cap share the budget at 9,756 code units each: their searchable text is "\n\n" + the text,
		// so "cat" of "cats" ends exactly at the cut.
		const atShare = `${'y '.repeat(4875)} cats ${'z '.repeat(200)}`
		expect(2 + atShare.indexOf('cats') + 3).toBe(Math.floor(400_000 / 41))
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 41)
			INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id, visibility,
				content, published_at)
			SELECT printf('3%017d', i), 'https://remote.example/objects/c' || i, ?1, s.uri, s.id, ?1, 'public', ?3,
				s.published_at
			FROM n, statuses s WHERE s.id = ?2`,
			remote,
			root,
			`<p>${atShare}</p>`
		)
		// Alone, a status is cut at MAX_FILTER_TEXT: here right after the "cat" of "cats".
		const atCap = `${'y '.repeat(4997)} cats more`
		expect(2 + atCap.indexOf('cats') + 3).toBe(MAX_FILTER_TEXT)
		const capped = await seedStatus(h.store, { accountId: remote, visibility: 'public', content: `<p>${atCap}</p>` })
		await createFilter(h, alice, { title: 'c', context: ['thread'], keywords_attributes: [{ keyword: 'cat' }] })

		const { body } = await getJson<{ descendants: Status[] }>(h, `/api/v1/statuses/${root}/context`, alice.token)
		expect(body.descendants).toHaveLength(41)
		expect(body.descendants.map((s) => s.filtered)).toEqual(Array.from({ length: 41 }, () => []))
		const alone = await getJson<Status>(h, '/api/v1/statuses/300000000000000001', alice.token)
		expect(alone.body.filtered).toEqual([])
		expect((await getJson<Status>(h, `/api/v1/statuses/${capped}`, alice.token)).body.filtered).toEqual([])
	})

	it('stops at a cut next to or inside an astral code point, matching nothing past it', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const remote = await remoteAccount(h.store, 'carol')
		// Cut at MAX_FILTER_TEXT: the emoji starts right at the cut, or straddles it (its high surrogate before the cut).
		const after = `${'y '.repeat(4999)}😀 more`
		const inside = `${'y '.repeat(4998)}y😀 more`
		expect([2 + after.indexOf('😀'), 2 + inside.indexOf('😀')]).toEqual([MAX_FILTER_TEXT, MAX_FILTER_TEXT - 1])
		const ids = [
			await seedStatus(h.store, { accountId: remote, visibility: 'public', content: `<p>${after}</p>` }),
			await seedStatus(h.store, { accountId: remote, visibility: 'public', content: `<p>${inside}</p>` }),
		]
		await createFilter(h, alice, {
			title: 'e',
			context: ['home'],
			keywords_attributes: [{ keyword: '😀' }, { keyword: 'y😀', whole_word: false }],
		})
		for (const id of ids) {
			expect((await getJson<Status>(h, `/api/v1/statuses/${id}`, alice.token)).body.filtered).toEqual([])
		}
	})

	it('deletes the filter statuses of a remote status over batches, each within PURGE_BATCH', async () => {
		const h = await community(['alice'])
		const remote = await remoteAccount(h.store, 'carol')
		const status = await seedStatus(h.store, { accountId: remote, visibility: 'public', content: '<p>x</p>' })
		// 12 accounts, each with 50 filters naming the status: 600 rows, more than a batch writes.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12)
			INSERT INTO accounts (id, uri, username) SELECT printf('5%017d', i), 'https://kopje.test/ap/users/f' || i, 'f' || i FROM n`
		)
		await sql(
			h.store,
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '5*'`
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
			INSERT INTO filters (id, account_id, title, context)
			SELECT printf('6%017d', CAST(substr(a.id, 2) AS INTEGER) * 100 + i), a.id, 'f', '["home"]'
			FROM accounts a, n WHERE a.id GLOB '5*'`
		)
		await sql(
			h.store,
			`INSERT INTO filter_statuses (id, filter_id, status_id) SELECT printf('7%017d', rowid), id, ? FROM filters`,
			status
		)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM filter_statuses')).toEqual([{ n: 600 }])
		const batches: number[] = []
		for (let i = 0; i < 10; i++) {
			const { wrote, remaining } = await runInDurableObject(h.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				const more = state.storage.transactionSync(() => deleteStatusBatch(db, status, NOW))
				return { wrote: changes() - before, remaining: more }
			})
			batches.push(wrote)
			if (!remaining) {
				break
			}
		}
		expect(batches.length).toBeGreaterThan(1)
		expect(batches.every((wrote) => wrote <= PURGE_BATCH)).toBe(true)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', status)).toEqual([{ n: 0 }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM filter_statuses')).toEqual([{ n: 0 }])
	})
})
