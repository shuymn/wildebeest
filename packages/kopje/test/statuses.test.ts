import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import {
	act,
	community,
	follow,
	getJson,
	outbound,
	post,
	remoteAccount,
	remoteFollows,
	seedStatus,
	type Status,
} from './status-helpers'
import { MAX_RAW_LENGTH } from '../src/domain/status-text'

describe('POST /api/v1/statuses', () => {
	it('posts a status in the Mastodon 4.0.2 shape', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const response = await h.request('/api/v1/statuses', bearer(alice.token, json({ status: 'Hello <world>' })))
		expect(response.status).toBe(200)
		const status = await response.json<Status>()
		expect(status).toEqual({
			id: expect.stringMatching(/^\d{18}$/),
			created_at: new Date(NOW).toISOString(),
			in_reply_to_id: null,
			in_reply_to_account_id: null,
			sensitive: false,
			spoiler_text: '',
			visibility: 'public',
			language: null,
			uri: expect.stringMatching(/^https:\/\/kopje\.test\/ap\/o\/[0-9a-f-]{36}$/),
			url: `https://kopje.test/@alice/${status.id}`,
			replies_count: 0,
			reblogs_count: 0,
			favourites_count: 0,
			edited_at: null,
			favourited: false,
			reblogged: false,
			muted: false,
			bookmarked: false,
			pinned: false,
			filtered: [],
			content: '<p>Hello &lt;world&gt;</p>',
			reblog: null,
			account: expect.objectContaining({ id: alice.id, acct: 'alice', statuses_count: 1 }),
			media_attachments: [],
			mentions: [],
			tags: [],
			emojis: [],
			card: null,
			poll: null,
		})
	})

	it('links URLs, known mentions and hashtags, and leaves unknown mentions as text', async () => {
		const h = await community(['alice', 'bob'])
		const carolId = await remoteAccount(h.store, 'carol', 'remote.example')
		const status = await post(h, h.users.alice, {
			status: 'hi @bob @carol@remote.example @nobody@nowhere.example #Kopje https://example.com/a?b=1&c=<2>',
		})
		expect(status.content).toBe(
			'<p>hi <span class="h-card"><a href="https://kopje.test/@bob" class="u-url mention">@<span>bob</span></a></span> ' +
				'<span class="h-card"><a href="https://remote.example/@carol" class="u-url mention">@<span>carol</span></a></span> ' +
				'@nobody@nowhere.example ' +
				'<a href="https://kopje.test/tags/kopje" class="mention hashtag" rel="tag">#<span>Kopje</span></a> ' +
				'<a href="https://example.com/a?b=1&amp;c=" target="_blank" rel="nofollow noopener noreferrer">' +
				'<span class="invisible">https://</span><span class="">example.com/a?b=1&amp;c=</span><span class="invisible"></span></a>' +
				'&lt;2&gt;</p>'
		)
		expect(status.mentions).toEqual(
			[
				{ id: h.users.bob.id, username: 'bob', url: 'https://kopje.test/@bob', acct: 'bob' },
				{ id: carolId, username: 'carol', url: 'https://remote.example/@carol', acct: 'carol@remote.example' },
			].sort((a, b) => a.id.localeCompare(b.id))
		)
		expect(status.tags).toEqual([{ name: 'kopje', url: 'https://kopje.test/tags/kopje' }])
	})

	it("reads a mention of the instance's own host as a local mention", async () => {
		const h = await community(['alice', 'bob'])
		const status = await post(h, h.users.alice, { status: '@bob@kopje.test @BOB' })
		expect(status.content).toBe(
			'<p><span class="h-card"><a href="https://kopje.test/@bob" class="u-url mention">@<span>bob</span></a></span> ' +
				'<span class="h-card"><a href="https://kopje.test/@bob" class="u-url mention">@<span>bob</span></a></span></p>'
		)
		expect(status.mentions.map((m) => m.id)).toEqual([h.users.bob.id])
	})

	it('answers a repeated Idempotency-Key with the first status', async () => {
		const h = await community(['alice'])
		const send = (text: string) =>
			h.request(
				'/api/v1/statuses',
				bearer(h.users.alice.token, json({ status: text }, { headers: { 'idempotency-key': 'k-1' } }))
			)
		const first = await (await send('one')).json<Status>()
		const second = await (await send('two')).json<Status>()
		expect(second.id).toBe(first.id)
		expect(second.content).toBe('<p>one</p>')
		expect(await sql(h.store, 'SELECT id FROM statuses')).toHaveLength(1)
	})

	it('refuses what Mastodon refuses', async () => {
		const h = await community(['alice'])
		const { token } = h.users.alice
		const cases: [Record<string, unknown>, number, string][] = [
			[{ status: '' }, 422, "Validation failed: Text can't be blank"],
			[{ status: 'x'.repeat(501) }, 422, 'Validation failed: Text character limit of 500 exceeded'],
			[{ status: 'x', visibility: 'everyone' }, 422, 'Validation failed: Visibility is not included in the list'],
			[{ status: 'x', media_ids: ['1', '2', '3', '4', '5'] }, 422, 'Cannot attach more than 4 files'],
			[{ status: 'x', in_reply_to_id: '123' }, 404, 'The post you are trying to reply to does not appear to exist.'],
		]
		for (const [body, status, error] of cases) {
			const response = await h.request('/api/v1/statuses', bearer(token, json(body)))
			expect({ status: response.status, body: await response.json() }).toEqual({ status, body: { error } })
		}
	})

	it('refuses raw text over the bound even when its counted length is short, and takes text at the bound', async () => {
		const h = await community(['alice'])
		const url = (n: number) => `https://example.com/${'p'.repeat(n)}`
		// 10 URLs of about 1,000 characters each count as 239 characters but are over 10,000 raw.
		const over = Array.from({ length: 10 }, () => url(1000)).join(' ')
		expect(over.length).toBeGreaterThan(MAX_RAW_LENGTH)
		const refused = await h.request('/api/v1/statuses', bearer(h.users.alice.token, json({ status: over })))
		expect({ status: refused.status, body: await refused.json() }).toEqual({
			status: 422,
			body: { error: 'Validation failed: Text character limit of 500 exceeded' },
		})
		const spoiler = await h.request(
			'/api/v1/statuses',
			bearer(h.users.alice.token, json({ status: 'x'.repeat(MAX_RAW_LENGTH - 5), spoiler_text: 'y'.repeat(6) }))
		)
		expect(spoiler.status).toBe(422)
		// Exactly at the bound: 10 URLs filling 10,000 code units.
		const joined = Array.from({ length: 10 }, () => url(979)).join(' ')
		const atCap = joined + 'x'.repeat(MAX_RAW_LENGTH - joined.length)
		expect(atCap.length).toBe(MAX_RAW_LENGTH)
		const status = await post(h, h.users.alice, { status: atCap })
		const edit = await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(h.users.alice.token, json({ status: `${atCap}x` }, { method: 'PUT' }))
		)
		expect(edit.status).toBe(422)
	})

	it('handles the worst case at the bound within a generous time', async () => {
		const h = await community(['alice'])
		await remoteAccount(h.store, 'u', `${'d'.repeat(40)}.example`)
		// Many long-domain mentions, hashtags and URLs, mixed, up to the bound.
		const unit = `@u@${'d'.repeat(40)}.example #t${'a'.repeat(20)} https://example.com/${'q'.repeat(40)} `
		const worst = unit.repeat(Math.floor(MAX_RAW_LENGTH / unit.length))
		const longUrls = Array.from({ length: 20 }, () => `https://example.com/${'r'.repeat(470)}`).join(' ')
		const started = Date.now()
		// The first is refused by its counted length after parsing; the second is accepted. Each request awaits Store
		// I/O, so the clock has advanced by the time it returns.
		expect((await h.request('/api/v1/statuses', bearer(h.users.alice.token, json({ status: worst })))).status).toBe(422)
		expect((await h.request('/api/v1/statuses', bearer(h.users.alice.token, json({ status: longUrls })))).status).toBe(
			200
		)
		expect(Date.now() - started).toBeLessThan(2000)
	})

	it('counts a URL as 23 characters and a remote mention by its username', async () => {
		const h = await community(['alice'])
		await remoteAccount(h.store, 'carol', 'a-very-long-remote-domain-name.example')
		const url = `https://example.com/${'p'.repeat(600)}`
		const status = await post(h, h.users.alice, {
			status: `${'x'.repeat(400)} ${url} @carol@a-very-long-remote-domain-name.example`,
		})
		expect(status.id).toMatch(/^\d{18}$/)
	})

	it('authenticates before validating, and needs write:statuses', async () => {
		const h = await community(['alice'], 'read')
		const invalid = await h.request('/api/v1/statuses', bearer('nope', json({ status: '' })))
		expect(invalid.status).toBe(401)
		const readOnly = await h.request('/api/v1/statuses', bearer(h.users.alice.token, json({ status: 'x' })))
		expect(readOnly.status).toBe(403)
	})

	it('attaches own unattached media in order and ignores anything else', async () => {
		const h = await community(['alice', 'bob'])
		const media = async (accountId: string, id: string) =>
			sql(
				h.store,
				"INSERT INTO media_attachments (id, account_id, type, url, description) VALUES (?, ?, 'image', ?, 'alt')",
				id,
				accountId,
				`https://kopje.test/media/${id}.png`
			)
		await media(h.users.alice.id, '100000000000000001')
		await media(h.users.alice.id, '100000000000000002')
		await media(h.users.bob.id, '100000000000000003')
		const status = await post(h, h.users.alice, {
			status: '',
			media_ids: ['100000000000000002', '100000000000000001', '100000000000000003'],
		})
		expect(status.media_attachments).toEqual([
			{
				id: '100000000000000002',
				type: 'image',
				url: 'https://kopje.test/media/100000000000000002.png',
				preview_url: 'https://kopje.test/media/100000000000000002.png',
				remote_url: null,
				preview_remote_url: null,
				text_url: null,
				meta: null,
				description: 'alt',
				blurhash: null,
			},
			expect.objectContaining({ id: '100000000000000001' }),
		])
		// Attached media cannot be attached again.
		const again = await h.request(
			'/api/v1/statuses',
			bearer(h.users.alice.token, json({ status: '', media_ids: ['100000000000000001'] }))
		)
		expect(again.status).toBe(422)
	})

	it('uses the account defaults and marks a spoiler sensitive', async () => {
		const h = await community(['alice'])
		await sql(
			h.store,
			"UPDATE local_accounts SET default_visibility = 'unlisted', default_language = 'ja' WHERE account_id = ?",
			h.users.alice.id
		)
		const status = await post(h, h.users.alice, { status: 'x', spoiler_text: 'cw' })
		expect(status).toMatchObject({ visibility: 'unlisted', language: 'ja', sensitive: true, spoiler_text: 'cw' })
		const explicit = await post(h, h.users.alice, { status: 'y', visibility: 'private', language: 'en' })
		expect(explicit).toMatchObject({ visibility: 'private', language: 'en', sensitive: false })
	})

	it('replies, counting public replies on the parent', async () => {
		const h = await community(['alice', 'bob'])
		const parent = await post(h, h.users.alice, { status: 'parent' })
		const reply = await post(h, h.users.bob, { status: '@alice reply', in_reply_to_id: parent.id })
		expect(reply).toMatchObject({ in_reply_to_id: parent.id, in_reply_to_account_id: h.users.alice.id })
		await post(h, h.users.bob, { status: 'quiet', in_reply_to_id: parent.id, visibility: 'private' })
		const { body } = await getJson<Status>(h, `/api/v1/statuses/${parent.id}`)
		expect(body.replies_count).toBe(1)
	})
})

describe('status reads', () => {
	it('gets a status without a token and with one', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'x' })
		const anonymous = await getJson<Status>(h, `/api/v1/statuses/${status.id}`)
		expect(anonymous.status).toBe(200)
		expect(anonymous.body).not.toHaveProperty('favourited')
		const signedIn = await getJson<Status>(h, `/api/v1/statuses/${status.id}`, h.users.alice.token)
		expect(signedIn.body).toMatchObject({ favourited: false, bookmarked: false })
		expect((await getJson(h, '/api/v1/statuses/999999999999999999')).status).toBe(404)
		expect((await getJson(h, '/api/v1/statuses/nope')).status).toBe(404)
		expect((await getJson(h, `/api/v1/statuses/${status.id}`, 'bad-token')).status).toBe(401)
	})

	it('resolves a legacy id to the status', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'x' })
		await sql(h.store, "UPDATE statuses SET legacy_id = '7f0c2b9e-legacy' WHERE id = ?", status.id)
		const { body } = await getJson<Status>(h, '/api/v1/statuses/7f0c2b9e-legacy')
		expect(body.id).toBe(status.id)
	})

	it('builds the context: ancestors oldest first, descendants depth first', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const root = await post(h, alice, { status: 'root' })
		const a = await post(h, alice, { status: 'a', in_reply_to_id: root.id })
		const a1 = await post(h, alice, { status: 'a1', in_reply_to_id: a.id })
		const b = await post(h, alice, { status: 'b', in_reply_to_id: root.id })
		const a2 = await post(h, alice, { status: 'a2', in_reply_to_id: a.id })
		const { body } = await getJson<{ ancestors: Status[]; descendants: Status[] }>(
			h,
			`/api/v1/statuses/${a1.id}/context`
		)
		expect(body.ancestors.map((s) => s.id)).toEqual([root.id, a.id])
		expect(body.descendants).toEqual([])
		const fromRoot = await getJson<{ ancestors: Status[]; descendants: Status[] }>(
			h,
			`/api/v1/statuses/${root.id}/context`
		)
		expect(fromRoot.body.descendants.map((s) => s.id)).toEqual([a.id, a1.id, a2.id, b.id])
	})

	it('gives the source for editing', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'a <b> @nobody', spoiler_text: 'cw' })
		const { body } = await getJson(h, `/api/v1/statuses/${status.id}/source`, h.users.alice.token)
		expect(body).toEqual({ id: status.id, text: 'a <b> @nobody', spoiler_text: 'cw' })
		expect((await getJson(h, `/api/v1/statuses/${status.id}/source`)).status).toBe(401)
	})
})

describe('editing', () => {
	it('edits, keeping the original as the first history entry', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await post(h, alice, { status: 'first', language: 'en' })
		const unedited = await getJson<unknown[]>(h, `/api/v1/statuses/${status.id}/history`)
		expect(unedited.body).toEqual([expect.objectContaining({ content: '<p>first</p>', sensitive: false })])
		h.now.mockReturnValue(NOW + 60_000)
		const response = await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(alice.token, json({ status: 'second', spoiler_text: 'cw' }, { method: 'PUT' }))
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			id: status.id,
			content: '<p>second</p>',
			spoiler_text: 'cw',
			sensitive: true,
			language: 'en',
			edited_at: new Date(NOW + 60_000).toISOString(),
		})
		const history = await getJson<{ content: string; created_at: string }[]>(h, `/api/v1/statuses/${status.id}/history`)
		expect(history.body.map((e) => [e.content, e.created_at])).toEqual([
			['<p>first</p>', new Date(NOW).toISOString()],
			['<p>second</p>', new Date(NOW + 60_000).toISOString()],
		])
		expect((await getJson(h, `/api/v1/statuses/${status.id}/source`, alice.token)).body).toMatchObject({
			text: 'second',
		})
	})

	it('does not record an edit that changes nothing', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'same' })
		const response = await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(h.users.alice.token, json({ status: 'same' }, { method: 'PUT' }))
		)
		expect(await response.json()).toMatchObject({ edited_at: null })
		expect(await sql(h.store, 'SELECT id FROM status_edits')).toEqual([])
	})

	it("keeps a removed mention as a silent one, and cannot edit someone else's status", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const status = await post(h, alice, { status: '@bob secret', visibility: 'direct' })
		await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(alice.token, json({ status: 'no mention' }, { method: 'PUT' }))
		)
		// bob was addressed: he still sees the status, but is no longer listed as mentioned.
		const seen = await getJson<Status>(h, `/api/v1/statuses/${status.id}`, bob.token)
		expect(seen.status).toBe(200)
		expect(seen.body.mentions).toEqual([])
		const other = await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(bob.token, json({ status: 'x' }, { method: 'PUT' }))
		)
		expect(other.status).toBe(404)
	})

	it('notifies local accounts that boosted an edited status', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const status = await post(h, alice, { status: 'v1' })
		await act(h, bob, `/api/v1/statuses/${status.id}/reblog`)
		await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, json({ status: 'v2' }, { method: 'PUT' })))
		await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, json({ status: 'v3' }, { method: 'PUT' })))
		const { body } = await getJson<{ type: string; status: Status }[]>(h, '/api/v1/notifications', bob.token)
		expect(body.map((n) => [n.type, n.status.content])).toEqual([['update', '<p>v3</p>']])
	})
})

describe('deleting', () => {
	it('answers with the source and detaches media for a redraft', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await sql(
			h.store,
			"INSERT INTO media_attachments (id, account_id, type, url) VALUES ('100000000000000001', ?, 'image', 'https://kopje.test/m.png')",
			alice.id
		)
		const status = await post(h, alice, { status: 'bye #tag', media_ids: ['100000000000000001'] })
		await act(h, bob, `/api/v1/statuses/${status.id}/favourite`)
		await act(h, bob, `/api/v1/statuses/${status.id}/reblog`)
		const response = await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: 'DELETE' }))
		expect(response.status).toBe(200)
		const deleted = await response.json<Status>()
		expect(deleted).toMatchObject({
			id: status.id,
			text: 'bye #tag',
			media_attachments: [{ id: '100000000000000001' }],
		})
		expect(deleted).not.toHaveProperty('content')
		expect((await getJson(h, `/api/v1/statuses/${status.id}`)).status).toBe(404)
		expect(await sql(h.store, 'SELECT status_id FROM media_attachments')).toEqual([{ status_id: null }])
		// The boost, the favourite and the notifications went with it; the counters follow.
		expect(await sql(h.store, 'SELECT id FROM statuses')).toEqual([])
		expect(await sql(h.store, 'SELECT id FROM notifications')).toEqual([])
		const account = await getJson<{ statuses_count: number }>(h, `/api/v1/accounts/${bob.id}`)
		expect(account.body.statuses_count).toBe(0)
		// Only the author can delete.
		const again = await post(h, alice, { status: 'mine' })
		expect((await h.request(`/api/v1/statuses/${again.id}`, bearer(bob.token, { method: 'DELETE' }))).status).toBe(404)
	})
})

describe('favourite, reblog, bookmark', () => {
	it('favourites and unfavourites, keeping counts and notifications in step', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const status = await post(h, alice, { status: 'x' })
		const favourited = await act(h, bob, `/api/v1/statuses/${status.id}/favourite`)
		expect(await favourited.json()).toMatchObject({ favourited: true, favourites_count: 1 })
		await act(h, bob, `/api/v1/statuses/${status.id}/favourite`)
		const notifications = await getJson<{ type: string }[]>(h, '/api/v1/notifications', alice.token)
		expect(notifications.body.map((n) => n.type)).toEqual(['favourite'])
		const who = await getJson<{ id: string }[]>(h, `/api/v1/statuses/${status.id}/favourited_by`)
		expect(who.body.map((a) => a.id)).toEqual([bob.id])
		const unfavourited = await act(h, bob, `/api/v1/statuses/${status.id}/unfavourite`)
		expect(await unfavourited.json()).toMatchObject({ favourited: false, favourites_count: 0 })
		expect((await getJson<unknown[]>(h, '/api/v1/notifications', alice.token)).body).toEqual([])
	})

	it('reblogs a status once and answers with the boost', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const status = await post(h, alice, { status: 'x' })
		const first = await (await act(h, bob, `/api/v1/statuses/${status.id}/reblog`)).json<Status>()
		expect(first).toMatchObject({
			account: { id: bob.id },
			content: '',
			reblogged: false,
			reblog: { id: status.id, reblogged: true, reblogs_count: 1 },
		})
		const second = await (await act(h, bob, `/api/v1/statuses/${status.id}/reblog`)).json<Status>()
		expect(second.id).toBe(first.id)
		// Acting on the boost acts on the original.
		const viaBoost = await (await act(h, bob, `/api/v1/statuses/${first.id}/favourite`)).json<Status>()
		expect(viaBoost).toMatchObject({ id: status.id, favourited: true })
		const who = await getJson<{ id: string }[]>(h, `/api/v1/statuses/${status.id}/reblogged_by`)
		expect(who.body.map((a) => a.id)).toEqual([bob.id])
		const undone = await (await act(h, bob, `/api/v1/statuses/${status.id}/unreblog`)).json<Status>()
		expect(undone).toMatchObject({ id: status.id, reblogged: false, reblogs_count: 0 })
		expect((await getJson(h, `/api/v1/statuses/${first.id}`)).status).toBe(404)
	})

	it('refuses to boost direct and others’ private statuses (StatusPolicy#reblog?)', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, bob, alice.id)
		const privateStatus = await post(h, alice, { status: 'p', visibility: 'private' })
		const direct = await post(h, alice, { status: '@bob d', visibility: 'direct' })
		expect((await act(h, bob, `/api/v1/statuses/${privateStatus.id}/reblog`)).status).toBe(403)
		expect((await act(h, bob, `/api/v1/statuses/${direct.id}/reblog`)).status).toBe(403)
		// The author may boost their own private status; it stays private.
		const own = await (await act(h, alice, `/api/v1/statuses/${privateStatus.id}/reblog`)).json<Status>()
		expect(own.visibility).toBe('private')
	})

	it('bookmarks and lists bookmarks', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await post(h, alice, { status: 'x' })
		expect(await (await act(h, alice, `/api/v1/statuses/${status.id}/bookmark`)).json()).toMatchObject({
			bookmarked: true,
		})
		expect((await getJson<Status[]>(h, '/api/v1/bookmarks', alice.token)).body.map((s) => s.id)).toEqual([status.id])
		expect(await (await act(h, alice, `/api/v1/statuses/${status.id}/unbookmark`)).json()).toMatchObject({
			bookmarked: false,
		})
		expect((await getJson<Status[]>(h, '/api/v1/bookmarks', alice.token)).body).toEqual([])
	})
})

describe('outbound intents', () => {
	it('records nothing when no remote account can be reached', async () => {
		const h = await community(['alice', 'bob'])
		await follow(h, h.users.bob, h.users.alice.id)
		await post(h, h.users.alice, { status: 'local only' })
		expect(await outbound(h.store)).toEqual([])
	})

	it('records Create, Update and Delete for the original audience only', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const follower = await remoteAccount(h.store, 'fan', 'fans.example')
		const carol = await remoteAccount(h.store, 'carol', 'remote.example')
		await remoteFollows(h.store, follower, alice.id)
		const direct = await post(h, alice, { status: '@carol@remote.example psst', visibility: 'direct' })
		h.now.mockReturnValue(NOW + 1000)
		await h.request(`/api/v1/statuses/${direct.id}`, bearer(alice.token, json({ status: 'edited' }, { method: 'PUT' })))
		await h.request(`/api/v1/statuses/${direct.id}`, bearer(alice.token, { method: 'DELETE' }))
		const activities = await outbound(h.store)
		expect(activities.map((a) => a.activity.type)).toEqual(['Create', 'Update', 'Delete'])
		for (const { signer, activity, audience } of activities) {
			expect(signer).toBe(alice.id)
			// Never the followers, never Public: only carol, who stays addressed after the edit removed her mention.
			expect(audience).toEqual({ followers: false, accounts: [carol] })
			expect(JSON.stringify(activity)).not.toContain('#Public')
			expect(JSON.stringify(activity)).not.toContain('/followers')
		}
		const [create, update, remove] = activities
		expect(create?.activity.to).toEqual(['https://remote.example/users/carol'])
		expect(update?.activity.to).toEqual([])
		expect(remove?.activity.object).toEqual({
			id: direct.uri,
			type: 'Tombstone',
			atomUri: direct.uri,
		})
	})

	it('records a public Create to the followers, and Like and Announce to a remote author', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const follower = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, follower, alice.id)
		const status = await post(h, alice, { status: 'hello #tag' })
		const remote = await remoteAccount(h.store, 'dave', 'remote.example')
		const theirs = await seedStatus(h.store, {
			accountId: remote,
			visibility: 'public',
			uri: 'https://remote.example/n/1',
		})
		await act(h, alice, `/api/v1/statuses/${theirs}/favourite`)
		await act(h, alice, `/api/v1/statuses/${theirs}/reblog`)
		await act(h, alice, `/api/v1/statuses/${theirs}/unfavourite`)
		await act(h, alice, `/api/v1/statuses/${theirs}/unreblog`)
		const activities = await outbound(h.store)
		expect(activities.map((a) => [a.activity.type, a.audience])).toEqual([
			['Create', { followers: true, accounts: [] }],
			['Like', { followers: false, accounts: [remote] }],
			['Announce', { followers: true, accounts: [remote] }],
			['Undo', { followers: false, accounts: [remote] }],
			['Undo', { followers: true, accounts: [remote] }],
		])
		const create = activities[0]?.activity
		expect(create).toMatchObject({
			type: 'Create',
			actor: 'https://kopje.test/ap/users/alice',
			to: ['https://www.w3.org/ns/activitystreams#Public'],
			cc: ['https://kopje.test/ap/users/alice/followers'],
			object: {
				id: status.uri,
				type: 'Note',
				attributedTo: 'https://kopje.test/ap/users/alice',
				tag: [{ type: 'Hashtag', href: 'https://kopje.test/tags/tag', name: '#tag' }],
			},
		})
		expect(activities[1]?.activity).toMatchObject({ type: 'Like', object: 'https://remote.example/n/1' })
		expect(activities[2]?.activity).toMatchObject({ type: 'Announce', object: 'https://remote.example/n/1' })
	})
})
