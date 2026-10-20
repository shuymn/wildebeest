import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, form, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { watchedCursor } from './read-helpers'
import {
	act,
	block,
	community,
	follow,
	getJson,
	ids,
	outbound,
	post,
	remoteAccount,
	remoteFollows,
	seedStatus,
	type Status,
} from './status-helpers'
import { postStatus, type ScheduleInput } from '../src/domain/scheduled-statuses'
import { MAX_RAW_LENGTH } from '../src/domain/status-text'
import { MAX_STATUS_EDITS } from '../src/domain/statuses'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

const HOUR = 60 * 60 * 1000

// Puts the pending Creates in flight and records their servers as having the object (the receipt a delivered Create
// leaves): an edit then goes to them as an Update (a server without a receipt gets a Create of the current version
// first, a leased Create included: it may still give up).
async function createsInFlight(store: StoreStub): Promise<void> {
	await store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'in-flight' })
	await sql(
		store,
		`INSERT OR IGNORE INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
		SELECT s.id, d.inbox_url, o.account_id, 0 FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
			JOIN statuses s ON s.uri = o.object_uri
		WHERE json_extract(o.body, '$.activity.type') = 'Create'`
	)
}

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
			quotes_count: 0,
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
			quote: null,
			quote_approval: { automatic: ['public'], manual: [], current_user: 'automatic' },
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
		// For an hour after the status (PostStatusService's setex 3_600); then the key posts anew and moves to it.
		h.now.mockReturnValue(NOW + HOUR - 1)
		expect((await (await send('three')).json<Status>()).id).toBe(first.id)
		h.now.mockReturnValue(NOW + HOUR)
		const third = await (await send('three')).json<Status>()
		expect(third.id).not.toBe(first.id)
		expect(await sql(h.store, 'SELECT id, client_key FROM statuses ORDER BY id')).toEqual([
			{ id: first.id, client_key: null },
			{ id: third.id, client_key: await sha256Hex('k-1') },
		])
		expect((await (await send('four')).json<Status>()).id).toBe(third.id)
	})

	it('counts a restored created_at that is not a time Kopje writes as expired', async () => {
		for (const stored of ["'now'", "'not a time'", "created_at || char(0) || 'x'", "'2026-10-12T12:34:56.789+00:00'"]) {
			const h = await community(['alice'])
			const send = (text: string) =>
				h.request(
					'/api/v1/statuses',
					bearer(h.users.alice.token, json({ status: text }, { headers: { 'idempotency-key': 'k-1' } }))
				)
			const first = await (await send('one')).json<Status>()
			await sql(h.store, `UPDATE statuses SET created_at = ${stored}`)
			const second = await (await send('two')).json<Status>()
			expect(second.id, stored).not.toBe(first.id)
			expect(await sql(h.store, 'SELECT client_key FROM statuses ORDER BY id')).toEqual([
				{ client_key: null },
				{ client_key: await sha256Hex('k-1') },
			])
		}
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

	// Stored text has U+0000 removed (src/platform/stored-bounds.ts storedText), so text of only U+0000 is blank.
	it('refuses a post or an edit whose text is only U+0000 as blank', async () => {
		const h = await community(['alice'])
		const { token } = h.users.alice
		const blank = { status: 422, body: { error: "Validation failed: Text can't be blank" } }
		const posted = await h.request('/api/v1/statuses', bearer(token, json({ status: '\u0000 \u0000' })))
		expect({ status: posted.status, body: await posted.json() }).toEqual(blank)
		expect(await sql(h.store, 'SELECT id FROM statuses')).toEqual([])
		const status = await post(h, h.users.alice, { status: 'first' })
		const edited = await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(token, json({ status: '\u0000' }, { method: 'PUT' }))
		)
		expect({ status: edited.status, body: await edited.json() }).toEqual(blank)
		expect(await sql(h.store, 'SELECT source_text FROM statuses')).toEqual([{ source_text: 'first' }])
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

	it('gives the source for editing to the author only (StatusPolicy#update?)', async () => {
		const h = await community(['alice', 'bob'])
		const status = await post(h, h.users.alice, { status: 'a <b> @nobody', spoiler_text: 'cw' })
		const author = await getJson(h, `/api/v1/statuses/${status.id}/source`, h.users.alice.token)
		expect(author).toEqual({ status: 200, body: { id: status.id, text: 'a <b> @nobody', spoiler_text: 'cw' } })
		// bob may see the public status, but not its source.
		expect((await getJson(h, `/api/v1/statuses/${status.id}`, h.users.bob.token)).status).toBe(200)
		expect((await getJson(h, `/api/v1/statuses/${status.id}/source`, h.users.bob.token)).status).toBe(404)
		expect((await getJson(h, `/api/v1/statuses/${status.id}/source`)).status).toBe(401)
		// A boost has no source of its own.
		const boost = await (await act(h, h.users.bob, `/api/v1/statuses/${status.id}/reblog`)).json<Status>()
		expect((await getJson(h, `/api/v1/statuses/${boost.id}/source`, h.users.bob.token)).status).toBe(404)
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
		await createsInFlight(h.store)
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

describe('review regressions', () => {
	const put = (h: Awaited<ReturnType<typeof community>>, token: string, id: string, body: Record<string, unknown>) =>
		h.request(`/api/v1/statuses/${id}`, bearer(token, json(body, { method: 'PUT' })))

	it('never truncates an Idempotency-Key, keys are per account, and a retry has no second side effect', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const remote = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, remote, alice.id)
		const prefix = 'k'.repeat(300)
		const send = (token: string, key: string, text: string) =>
			h.request('/api/v1/statuses', bearer(token, json({ status: text }, { headers: { 'idempotency-key': key } })))
		const first = await (await send(alice.token, `${prefix}a`, '@bob one')).json<Status>()
		const retry = await (await send(alice.token, `${prefix}a`, '@bob one')).json<Status>()
		const other = await (await send(alice.token, `${prefix}b`, 'two')).json<Status>()
		const bobs = await (await send(bob.token, `${prefix}a`, 'bob')).json<Status>()
		expect(retry.id).toBe(first.id)
		expect(new Set([first.id, other.id, bobs.id]).size).toBe(3)
		expect(await sql(h.store, "SELECT id FROM notifications WHERE type = 'mention'")).toHaveLength(1)
		expect((await outbound(h.store)).filter((o) => o.activity.type === 'Create')).toHaveLength(2)
		expect((await getJson<{ statuses_count: number }>(h, `/api/v1/accounts/${alice.id}`)).body.statuses_count).toBe(2)
		// Expired, the same key posts anew for each account, and each account's key moves to its new status.
		h.now.mockReturnValue(NOW + HOUR)
		const later = await (await send(alice.token, `${prefix}a`, 'later')).json<Status>()
		const bobLater = await (await send(bob.token, `${prefix}a`, 'bob later')).json<Status>()
		expect(new Set([first.id, bobs.id, later.id, bobLater.id]).size).toBe(4)
		expect(
			await sql(h.store, 'SELECT id FROM statuses WHERE client_key = ? ORDER BY id', await sha256Hex(`${prefix}a`))
		).toEqual([{ id: later.id }, { id: bobLater.id }])
	})

	it('gives two edits in the same millisecond distinct Update ids', async () => {
		const h = await community(['alice'])
		const remote = await remoteAccount(h.store, 'fan', 'fans.example')
		await remoteFollows(h.store, remote, h.users.alice.id)
		const status = await post(h, h.users.alice, { status: 'v1' })
		await createsInFlight(h.store)
		await put(h, h.users.alice.token, status.id, { status: 'v2' })
		await put(h, h.users.alice.token, status.id, { status: 'v3' })
		const updates = (await outbound(h.store)).filter((o) => o.activity.type === 'Update').map((o) => o.activity.id)
		expect(updates).toHaveLength(2)
		expect(new Set(updates).size).toBe(2)
	})

	it('applies media_attributes descriptions on edit, records them in history, and only for own attached media', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		for (const [id, owner] of [
			['100000000000000001', alice.id],
			['100000000000000002', bob.id],
		] as const) {
			await sql(
				h.store,
				"INSERT INTO media_attachments (id, account_id, type, url, description) VALUES (?, ?, 'image', 'https://kopje.test/m.png', 'old')",
				id,
				owner
			)
		}
		const status = await post(h, alice, { status: 'pic', media_ids: ['100000000000000001'] })
		const response = await put(h, alice.token, status.id, {
			status: 'pic',
			media_ids: ['100000000000000001'],
			media_attributes: [
				{ id: '100000000000000001', description: 'new' },
				{ id: '100000000000000002', description: 'hijack' },
			],
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			media_attachments: [{ description: 'new' }],
			edited_at: expect.any(String),
		})
		const history = await getJson<{ media_attachments: { description: string }[] }[]>(
			h,
			`/api/v1/statuses/${status.id}/history`
		)
		expect(history.body.map((e) => e.media_attachments.map((m) => m.description))).toEqual([['old'], ['new']])
		expect(await sql(h.store, "SELECT description FROM media_attachments WHERE id = '100000000000000002'")).toEqual([
			{ description: 'old' },
		])
		// Form encoding works too, and a too-long description is refused.
		const tooLong = await h.request(
			`/api/v1/statuses/${status.id}`,
			bearer(
				alice.token,
				form(
					{
						status: 'pic',
						'media_ids[]': '100000000000000001',
						'media_attributes[][id]': '100000000000000001',
						'media_attributes[][description]': 'x'.repeat(1501),
					},
					{ method: 'PUT' }
				)
			)
		)
		expect(tooLong.status).toBe(422)
	})

	it('bounds the edit history at write time', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'v0' })
		let last = 200
		let edits = 0
		for (let i = 1; i <= MAX_STATUS_EDITS + 1 && last === 200; i++) {
			last = (await put(h, h.users.alice.token, status.id, { status: `v${i}` })).status
			if (last === 200) {
				edits++
			}
		}
		expect(last).toBe(422)
		const history = await getJson<unknown[]>(h, `/api/v1/statuses/${status.id}/history`)
		expect(history.body).toHaveLength(MAX_STATUS_EDITS)
		expect(edits).toBe(MAX_STATUS_EDITS - 1)
	})

	it('deletes media with delete_media, and lets a redraft attach the media again otherwise', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const media = (id: string) =>
			sql(
				h.store,
				"INSERT INTO media_attachments (id, account_id, type, url) VALUES (?, ?, 'image', 'u')",
				id,
				alice.id
			)
		await media('100000000000000001')
		await media('100000000000000002')
		const keep = await post(h, alice, { status: 'keep', media_ids: ['100000000000000001'] })
		const drop = await post(h, alice, { status: 'drop', media_ids: ['100000000000000002'] })
		await h.request(`/api/v1/statuses/${keep.id}`, bearer(alice.token, { method: 'DELETE' }))
		await h.request(`/api/v1/statuses/${drop.id}?delete_media=true`, bearer(alice.token, { method: 'DELETE' }))
		expect(await sql(h.store, 'SELECT id FROM media_attachments')).toEqual([{ id: '100000000000000001' }])
		const redraft = await post(h, alice, { status: 'keep', media_ids: ['100000000000000001'] })
		expect(redraft.media_attachments).toMatchObject([{ id: '100000000000000001' }])
	})

	it('boosting a boost boosts the original', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const status = await post(h, h.users.alice, { status: 'x' })
		const boost = await (await act(h, h.users.bob, `/api/v1/statuses/${status.id}/reblog`)).json<Status>()
		const again = await (await act(h, h.users.carol, `/api/v1/statuses/${boost.id}/reblog`)).json<Status>()
		expect(again.reblog?.id).toBe(status.id)
		expect(await sql(h.store, 'SELECT reblog_of_id FROM statuses WHERE id = ?', again.id)).toEqual([
			{ reblog_of_id: status.id },
		])
	})

	it('a mention added by editing a direct status adds no recipient (deliberate: audiences never widen)', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		const remote = await remoteAccount(h.store, 'dave', 'remote.example')
		const status = await post(h, alice, { status: '@bob secret', visibility: 'direct' })
		const edited = await put(h, alice.token, status.id, { status: '@bob @carol @dave@remote.example harmless' })
		const body = await edited.json<Status>()
		// The new mentions are links, but not mentions of the status.
		expect(body.content).toContain('@<span>carol</span>')
		expect(body.mentions.map((m) => m.id)).toEqual([bob.id])
		for (const path of ['', '/history', '/context']) {
			expect((await getJson(h, `/api/v1/statuses/${status.id}${path}`, carol.token)).status).toBe(404)
		}
		expect(await ids(h, '/api/v1/notifications', carol.token)).toEqual([])
		expect(await outbound(h.store)).toEqual([])
		expect(remote).not.toBe('')
	})

	it('a mention added by editing a public status is a mention, as in Mastodon', async () => {
		const h = await community(['alice', 'carol'])
		const status = await post(h, h.users.alice, { status: 'hello' })
		await put(h, h.users.alice.token, status.id, { status: 'hello @carol' })
		expect((await getJson<Status>(h, `/api/v1/statuses/${status.id}`)).body.mentions.map((m) => m.id)).toEqual([
			h.users.carol.id,
		])
		expect(await ids(h, '/api/v1/notifications', h.users.carol.token)).toHaveLength(1)
	})

	it('deleting an own boost shows the original only if still visible, and never its source', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const visible = await post(h, alice, { status: 'visible' })
		const boost = await (await act(h, bob, `/api/v1/statuses/${visible.id}/reblog`)).json<Status>()
		const deleted = await (
			await h.request(`/api/v1/statuses/${boost.id}`, bearer(bob.token, { method: 'DELETE' }))
		).json<Status>()
		expect(deleted.reblog).toMatchObject({ id: visible.id, content: '<p>visible</p>' })
		expect(deleted.reblog).not.toHaveProperty('text')
		const hidden = await post(h, alice, { status: 'hidden' })
		const second = await (await act(h, bob, `/api/v1/statuses/${hidden.id}/reblog`)).json<Status>()
		await block(h.store, alice.id, bob.id)
		const response = await h.request(`/api/v1/statuses/${second.id}`, bearer(bob.token, { method: 'DELETE' }))
		expect(response.status).toBe(200)
		const gone = await response.json<Status>()
		expect(gone).toMatchObject({ id: second.id, reblog: null })
		expect(JSON.stringify(gone)).not.toContain('hidden')
		expect(await sql(h.store, 'SELECT id FROM statuses WHERE id = ?', second.id)).toEqual([])
	})

	it('lists only public and unlisted boosts in reblogged_by', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const status = await post(h, h.users.alice, { status: 'x' })
		await act(h, h.users.bob, `/api/v1/statuses/${status.id}/reblog`, { visibility: 'private' })
		await act(h, h.users.carol, `/api/v1/statuses/${status.id}/reblog`, { visibility: 'unlisted' })
		expect(await ids(h, `/api/v1/statuses/${status.id}/reblogged_by`)).toEqual([h.users.carol.id])
	})

	it('does not reveal direct activity through last_status_at', async () => {
		const h = await community(['alice', 'bob'])
		await post(h, h.users.alice, { status: '@bob psst', visibility: 'direct' })
		const { body } = await getJson<{ last_status_at: string | null }>(h, `/api/v1/accounts/${h.users.alice.id}`)
		expect(body.last_status_at).toBeNull()
	})

	it('keeps parent references of a visible reply but never the hidden parent itself (Mastodon parity)', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await follow(h, bob, alice.id)
		const parent = await post(h, alice, { status: 'members only', visibility: 'private' })
		const reply = await post(h, bob, { status: 'public answer', in_reply_to_id: parent.id })
		const seen = await getJson<Status>(h, `/api/v1/statuses/${reply.id}`, carol.token)
		expect(seen.body).toMatchObject({ in_reply_to_id: parent.id, in_reply_to_account_id: alice.id })
		expect((await getJson(h, `/api/v1/statuses/${parent.id}`, carol.token)).status).toBe(404)
		const context = await getJson<{ ancestors: Status[] }>(h, `/api/v1/statuses/${reply.id}/context`, carol.token)
		expect(context.body.ancestors).toEqual([])
		expect(JSON.stringify(seen.body)).not.toContain('members only')
	})
})

describe('edits never widen a non-public audience', () => {
	const put = (h: Awaited<ReturnType<typeof community>>, token: string, id: string, body: Record<string, unknown>) =>
		h.request(`/api/v1/statuses/${id}`, bearer(token, json(body, { method: 'PUT' })))

	for (const visibility of ['private', 'limited'] as const) {
		it(`${visibility}: an existing remote recipient keeps the audience; new mentions get nothing`, async () => {
			const h = await community(['alice', 'bob', 'dave'])
			const { alice, bob, dave } = h.users
			const carol = await remoteAccount(h.store, 'carol', 'remote.example')
			const erin = await remoteAccount(h.store, 'erin', 'other.example')
			let id: string
			if (visibility === 'private') {
				id = (await post(h, alice, { status: '@carol@remote.example @bob secret', visibility: 'private' })).id
				await createsInFlight(h.store)
			} else {
				// A limited status (silent recipient) is not something the API posts; write it as an inbound one would be.
				id = await seedStatus(h.store, {
					accountId: alice.id,
					visibility: 'limited',
					uri: 'https://kopje.test/ap/o/limited',
					mentions: [{ accountId: carol }, { accountId: bob.id, silent: true }],
				})
				await remoteFollows(h.store, carol, alice.id)
				// remote.example has it already, as if its Create had been delivered.
				await sql(
					h.store,
					"INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at) VALUES (?, 'https://remote.example/inbox', ?, 0)",
					id,
					alice.id
				)
			}
			const audienceBefore = (await outbound(h.store)).map((o) => o.audience)
			const edited = await put(h, alice.token, id, {
				status: '@carol@remote.example @dave @erin@other.example harmless',
			})
			expect(edited.status).toBe(200)
			const updates = (await outbound(h.store)).filter((o) => o.activity.type === 'Update')
			expect(updates).toHaveLength(1)
			// Followers only for private; the addressed accounts as before, never dave or erin.
			const expected = {
				followers: visibility === 'private',
				accounts: [carol, bob.id].sort(),
			}
			expect({ ...updates[0]?.audience, accounts: [...(updates[0]?.audience.accounts ?? [])].sort() }).toEqual(expected)
			// The new mentions are only linked in the content: they are not addressed or tagged.
			const activity = updates[0]?.activity as { to: string[]; cc: string[]; object: { tag: { href: string }[] } }
			const addressed = [...activity.to, ...activity.cc, ...activity.object.tag.map((t) => t.href)]
			expect(addressed.filter((uri) => uri.includes('erin') || uri.includes('/dave'))).toEqual([])
			for (const path of ['', '/history']) {
				expect((await getJson(h, `/api/v1/statuses/${id}${path}`, dave.token)).status).toBe(404)
				expect((await getJson(h, `/api/v1/statuses/${id}${path}`, bob.token)).status).toBe(200)
			}
			expect(await ids(h, '/api/v1/notifications', dave.token)).toEqual([])
			expect(
				await sql(
					h.store,
					'SELECT account_id FROM status_mentions WHERE status_id = ? AND account_id IN (?, ?)',
					id,
					dave.id,
					erin
				)
			).toEqual([])
			expect(audienceBefore.length).toBeGreaterThanOrEqual(visibility === 'private' ? 1 : 0)
		})
	}
})

describe('reblogged_by pages after filtering', () => {
	it('skips a newer private boost when paging', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const status = await post(h, h.users.alice, { status: 'x' })
		await act(h, h.users.carol, `/api/v1/statuses/${status.id}/reblog`, { visibility: 'unlisted' })
		await act(h, h.users.bob, `/api/v1/statuses/${status.id}/reblog`, { visibility: 'private' })
		expect(await ids(h, `/api/v1/statuses/${status.id}/reblogged_by?limit=1`)).toEqual([h.users.carol.id])
	})
})

// The plans and rows read of the statements a postStatus run makes whose SQL matches `pattern`, each as EXPLAIN QUERY
// PLAN shows the production statement with its parameters.
async function postPlans(
	h: Awaited<ReturnType<typeof community>>,
	token: string,
	input: Partial<ScheduleInput>,
	pattern: RegExp
): Promise<{ result: unknown; plans: { query: string; plan: string[]; rows: number }[] }> {
	const tokenHash = await sha256Hex(token)
	return runInDurableObject(h.store, (_instance, state) => {
		const real = state.storage.sql
		const plans: { query: string; plan: string[]; rows: number }[] = []
		const capturing = {
			exec: (query: string, ...params: SqlStorageValue[]) => {
				if (!pattern.test(query)) {
					return real.exec(query, ...params)
				}
				const plan = real
					.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
					.toArray()
					.map((row) => row.detail)
				const cursor = real.exec(query, ...params)
				const entry = { query, plan, rows: 0 }
				plans.push(entry)
				return watchedCursor(cursor, () => (entry.rows += cursor.rowsRead))
			},
		} as unknown as SqlStorage
		const result = postStatus.run(capturing, {
			credential: { tokenHash, scope: 'write:statuses', now: NOW },
			text: 'plan',
			spoilerText: '',
			mediaIds: [],
			objectId: crypto.randomUUID(),
			now: NOW,
			present: { origin: 'https://kopje.test' },
			...input,
		})
		return { result, plans }
	})
}

describe('Idempotency-Key reads and releases through the unique indexes (RES-7)', () => {
	it('probes and frees the key by index, with stale statistics and many keyed rows', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await sql(h.store, 'ANALYZE')
		// Many expired keyed statuses and scheduled statuses of the account, and one of each with the key.
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 5000 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, client_key, created_at)
			SELECT CAST(300000000000000000 + i AS TEXT), 'https://kopje.test/ap/o/k' || i, ?1, 'public', '', ?2, 'key' || i, ?2
			FROM n`,
			alice.id,
			'2026-01-01T00:00:00.000Z'
		)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 300 - 1)
			INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params, client_key, created_at)
			SELECT CAST(400000000000000000 + i AS TEXT), ?1, '2027-01-01T00:00:00.000Z', '{}', 'key' || i, ?2 FROM n`,
			alice.id,
			'2026-01-01T00:00:00.000Z'
		)
		const { plans } = await postPlans(h, alice.token, { idempotencyKey: 'key7' }, /client_key/)
		const planOf = (pattern: RegExp) => plans.find((entry) => pattern.test(entry.query))?.plan ?? []
		expect(planOf(/^SELECT id FROM statuses WHERE account_id = \?1 AND client_key/)).toEqual([
			'SEARCH statuses USING INDEX statuses_client_key (account_id=? AND client_key=?)',
		])
		expect(planOf(/FROM scheduled_statuses ss WHERE/).join(' | ')).toMatch(
			/SEARCH ss USING INDEX sqlite_autoindex_scheduled_statuses_\d \(account_id=\? AND client_key=\?\)/
		)
		expect(planOf(/^UPDATE statuses SET client_key = NULL/)).toEqual([
			'SEARCH statuses USING INDEX statuses_client_key (account_id=? AND client_key=?)',
		])
		expect(planOf(/^UPDATE scheduled_statuses SET client_key = NULL/)).toEqual([
			expect.stringMatching(
				/^SEARCH scheduled_statuses USING INDEX sqlite_autoindex_scheduled_statuses_\d \(account_id=\? AND client_key=\?\)$/
			),
		])
		for (const entry of plans) {
			expect(entry.plan.filter((detail) => /^SCAN (statuses|ss|scheduled_statuses)\b/.test(detail))).toEqual([])
		}
		expect(await sql(h.store, "SELECT count(*) AS n FROM statuses WHERE client_key = 'key7'")).toEqual([{ n: 1 }])
		expect(await sql(h.store, "SELECT count(*) AS n FROM scheduled_statuses WHERE client_key = 'key7'")).toEqual([
			{ n: 0 },
		])
	}, 60_000)
})
