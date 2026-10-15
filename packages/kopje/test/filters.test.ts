import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import {
	act,
	community,
	follow,
	getJson,
	ids,
	post,
	remoteAccount,
	seedStatus,
	type Status,
	type User,
} from './status-helpers'
import { MAX_FILTER_KEYWORDS, MAX_FILTERS } from '../src/domain/filters'

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

	it('refuses a filter status for a status the viewer may not see, and lists one that became invisible by id', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const filter = await createFilter(h, alice, { title: 'f', context: ['home'] })
		const hidden = await post(h, bob, { status: 'only for bob', visibility: 'direct' })
		const notFound = { status: 404, body: { error: 'Record not found' } }
		expect(
			await answer(await act(h, alice, `/api/v2/filters/${filter.id}/statuses`, { status_id: hidden.id }))
		).toEqual(notFound)
		expect(
			await answer(await act(h, alice, `/api/v2/filters/${filter.id}/statuses`, { status_id: '999999999999999999' }))
		).toEqual(notFound)

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

	it('marks warned statuses with filtered and leaves hidden ones out of home, keeping the cursors of the page read', async () => {
		const { h, alice, bob } = await setup()
		const plain = await post(h, bob, { status: 'nothing here', visibility: 'public' })
		const warned = await post(h, bob, { status: 'The Cat sat', visibility: 'public' })
		const hidden = await post(h, bob, { status: 'a dog barked', visibility: 'public' })
		const warn = await createFilter(h, alice, {
			title: 'cats',
			context: ['home'],
			keywords_attributes: [{ keyword: 'cat' }],
		})
		await createFilter(h, alice, {
			title: 'dogs',
			context: ['home'],
			filter_action: 'hide',
			keywords_attributes: [{ keyword: 'dog' }],
		})
		const response = await h.request('/api/v1/timelines/home?limit=3', bearer(alice.token))
		const page = await response.json<Status[]>()
		expect(page.map((s) => s.id)).toEqual([warned.id, plain.id])
		expect(page[0]!.filtered).toEqual([
			{
				filter: { id: warn.id, title: 'cats', context: ['home'], expires_at: null, filter_action: 'warn' },
				keyword_matches: ['Cat'],
				status_matches: null,
			},
		])
		expect(page[1]!.filtered).toEqual([])
		// The cursors are those of the page read: the hidden status is the newest of it.
		expect(response.headers.get('link')).toContain(`min_id=${hidden.id}>; rel="prev"`)
		expect(response.headers.get('link')).toContain(`max_id=${plain.id}>; rel="next"`)

		// A page of hidden statuses only is empty, and its cursors still move on.
		const onlyHidden = await h.request(`/api/v1/timelines/home?limit=1`, bearer(alice.token))
		expect(await onlyHidden.json()).toEqual([])
		expect(onlyHidden.headers.get('link')).toContain(`max_id=${hidden.id}>; rel="next"`)
	})

	it('applies a filter only in the contexts it names, and never once it has expired', async () => {
		const { h, alice, bob } = await setup()
		const status = await post(h, bob, { status: 'spoiler ahead #show', visibility: 'public' })
		const reply = await post(h, bob, { status: 'more spoiler', visibility: 'public', in_reply_to_id: status.id })
		await createFilter(h, alice, {
			title: 'public only',
			context: ['public', 'thread'],
			filter_action: 'hide',
			keywords_attributes: [{ keyword: 'spoiler' }],
		})
		expect((await timeline(h, '/api/v1/timelines/home', alice.token)).map((s) => s.id)).toEqual([reply.id, status.id])
		expect(await timeline(h, '/api/v1/timelines/public', alice.token)).toEqual([])
		expect(await timeline(h, '/api/v1/timelines/tag/show', alice.token)).toEqual([])
		expect((await timeline(h, `/api/v1/accounts/${bob.id}/statuses`, alice.token)).map((s) => s.id)).toEqual([
			reply.id,
			status.id,
		])
		expect((await getJson(h, `/api/v1/statuses/${status.id}/context`, alice.token)).body).toEqual({
			ancestors: [],
			descendants: [],
		})
		// The single status is not a filtered context; another viewer is not filtered by alice's filters.
		expect((await getJson<Status>(h, `/api/v1/statuses/${status.id}`, alice.token)).body.filtered).toEqual([])
		expect((await timeline(h, '/api/v1/timelines/public', bob.token)).map((s) => s.id)).toEqual([reply.id, status.id])

		await sql(h.store, 'UPDATE filters SET expires_at = ?', new Date(NOW - 1000).toISOString())
		expect((await timeline(h, '/api/v1/timelines/public', alice.token)).map((s) => s.id)).toEqual([reply.id, status.id])
		// expires_in=0 expires at once.
		await act(h, alice, '/api/v2/filters', {
			title: 'gone',
			context: ['account'],
			filter_action: 'hide',
			expires_in: 0,
			keywords_attributes: [{ keyword: 'spoiler' }],
		})
		expect(await timeline(h, `/api/v1/accounts/${bob.id}/statuses`, alice.token)).toHaveLength(2)
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

		await send(h, alice, 'PUT', `/api/v2/filters/${filter.id}`, { filter_action: 'hide' })
		expect(await timeline(h, '/api/v1/timelines/home', alice.token)).toEqual([])
	})

	it('hides notifications whose status a hide filter of the notifications context matches', async () => {
		const { h, alice, bob } = await setup()
		const mine = await post(h, alice, { status: 'hello', visibility: 'public' })
		await act(h, bob, `/api/v1/statuses/${mine.id}/favourite`)
		const mention = await post(h, bob, { status: '@alice secret plans', visibility: 'public' })
		const before = await getJson<{ id: string; status?: Status }[]>(h, '/api/v1/notifications', alice.token)
		expect(before.body.map((n) => n.status?.id)).toEqual([mention.id, mine.id])
		await createFilter(h, alice, {
			title: 'plans',
			context: ['notifications'],
			filter_action: 'hide',
			keywords_attributes: [{ keyword: 'plans' }],
		})
		const after = await getJson<{ id: string; status?: Status }[]>(h, '/api/v1/notifications', alice.token)
		expect(after.body.map((n) => n.status?.id)).toEqual([mine.id])
		expect((await getJson(h, `/api/v1/notifications/${before.body[0]!.id}`, alice.token)).status).toBe(404)
		// Home is another context: the mention is still there.
		expect(await ids(h, '/api/v1/timelines/home', alice.token)).toContain(mention.id)
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
		expect(shown).toHaveLength(40)
		expect(elapsed).toBeLessThan(5_000)
	}, 60_000)
})
