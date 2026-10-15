import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { AP, LOCAL, MASTODON, mastodonActor, MISSKEY, MISSKEY_CONTEXT, misskeyActor, signedInit } from './inbox-helpers'
import {
	accountId,
	ALICE,
	ALICE_URI,
	announce,
	AS,
	create,
	DAVE,
	DAVE_URI,
	followed,
	like,
	localStatus,
	mastodonNote,
	misskeyNote,
	notifications,
	OTHER,
	PUBLIC,
	remove,
	setup,
	statuses,
	statusRow,
	undo,
	update,
} from './inbox-status-helpers'
import { rowsRead } from './read-helpers'
import { block, domainBlock, mute } from './status-helpers'
import { PURGE_BATCH } from '../src/domain/inbox'
import { MAX_STATUS_MEDIA, MAX_STATUS_TAGS } from '../src/domain/remote-statuses'
import { getTag } from '../src/domain/tags'
import { tagTimeline } from '../src/domain/timelines'
import { handleQueue } from '../src/jobs/queue'
import { MAX_JSON_DEPTH } from '../src/platform/json-bounds'
import { REMOTE_HTML_RAW_LIMIT } from '../src/security/html'

// Inbound statuses, favourites and boosts (B1b-2), end to end through the app: signed activities from synthetic
// Mastodon- and Misskey-shaped servers, the Store's rows, and what local users see through the API. Test names cite
// the invariants (docs/threat-model.md); the threat model's B1b negative cases owned here are unauthorized Update and
// Delete, duplicate and reordered Delete and Create, Announce of private and unlisted objects, and fetches of private
// and unlisted objects.

describe('Create (Mastodon and Misskey)', () => {
	it('stores a public Note of a followed account as Mastodon does, and shows it in the follower’s home', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const parent = mastodonNote(bob)
		await t.post(bob, create(bob, parent))
		const note = mastodonNote(bob, {
			inReplyTo: parent.id,
			published: '2026-10-11T12:05:00Z',
			summary: 'cw',
			sensitive: true,
			content: '<p>hi <a href="https://kopje.test/@alice" class="u-url mention">@alice</a> #Cats</p>',
			contentMap: { 'ja-JP': '<p>hi</p>' },
			cc: [`${bob.uri}/followers`, ALICE_URI],
			tag: [
				{ type: 'Mention', href: ALICE_URI, name: '@alice' },
				{ type: 'Hashtag', href: `${MASTODON}/tags/cats`, name: '#Cats' },
				{ type: 'Emoji', name: ':blob:', icon: { type: 'Image', url: `${MASTODON}/emoji/blob.png` } },
			],
			attachment: [
				{
					type: 'Document',
					mediaType: 'image/png',
					url: `${MASTODON}/system/media/1.png`,
					name: 'a cat',
					blurhash: 'UBL_:rOpGG-oBUNG,qRj2so|=eE1w^n4S5NH',
					focalPoint: [0.5, -0.25],
					width: 640,
					height: 480,
				},
				{ type: 'Document', mediaType: 'video/mp4', url: `${MASTODON}/system/media/2.mp4`, name: null },
			],
		})
		expect(await t.post(bob, create(bob, note))).toBe(202)

		const parentRow = (await statusRow(t.store, parent.id))!
		const row = (await statusRow(t.store, note.id))!
		expect(row).toMatchObject({
			url: note.url,
			content: (note.content as string).replace(
				'class="u-url mention"',
				'class="u-url mention" rel="nofollow noopener" target="_blank"'
			),
			spoiler_text: 'cw',
			sensitive: 1,
			language: 'ja',
			visibility: 'public',
			published_at: '2026-10-11T12:05:00.000Z',
			edited_at: null,
			in_reply_to_uri: parent.id,
			in_reply_to_id: parentRow.id,
			in_reply_to_account_id: bobId,
		})
		// The raw object is kept whole.
		expect(JSON.parse(row.raw)).toEqual(note)
		expect((await statusRow(t.store, parent.id))?.replies_count).toBe(1)
		expect(await sql(t.store, 'SELECT name FROM status_tags WHERE status_id = ?', row.id)).toEqual([{ name: 'cats' }])
		expect(await sql(t.store, 'SELECT account_id, silent FROM status_mentions WHERE status_id = ?', row.id)).toEqual([
			{ account_id: ALICE, silent: 0 },
		])
		expect(
			await sql(
				t.store,
				'SELECT type, url, description, meta, focus_x, focus_y, file_token FROM media_attachments WHERE status_id = ? ORDER BY position',
				row.id
			)
		).toEqual([
			{
				type: 'image',
				url: `${MASTODON}/system/media/1.png`,
				description: 'a cat',
				meta: '{"original":{"width":640,"height":480}}',
				focus_x: 0.5,
				focus_y: -0.25,
				file_token: null,
			},
			{
				type: 'video',
				url: `${MASTODON}/system/media/2.mp4`,
				description: '',
				meta: null,
				focus_x: 0,
				focus_y: 0,
				file_token: null,
			},
		])
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'mention' }])
		// Unknown mentions and parents are never fetched on the inbox path.
		expect(t.web.fetched.filter((url) => url.includes('/statuses/'))).toEqual([])

		const home =
			await t.api<{ uri: string; media_attachments: { url: string; meta: unknown }[] }[]>('/api/v1/timelines/home')
		expect(home.body.map((s) => s.uri)).toEqual([note.id, parent.id])
		expect(home.body[0]?.media_attachments[0]).toMatchObject({
			url: `${MASTODON}/system/media/1.png`,
			meta: { original: { width: 640, height: 480 }, focus: { x: 0.5, y: -0.25 } },
		})
	})

	it('sanitizes content by allowlist with http(s) links only, and keeps only http(s) media (HTML-1, HTML-3)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob, {
			content:
				'<p onclick="x()">hi<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a> <a href="https://ok.example/" style="color:red">ok</a></p><iframe src="https://evil.example"></iframe>',
			url: 'javascript:alert(1)',
			attachment: [
				{ type: 'Document', mediaType: 'image/png', url: 'javascript:alert(1)' },
				{ type: 'Document', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
				{ type: 'Document', mediaType: 'text/html', url: 'https://ok.example/page', icon: 'javascript:x' },
				{ type: 'Link', href: 'https://ok.example/card' },
			],
		})
		await t.post(bob, create(bob, note))
		const row = (await statusRow(t.store, note.id))!
		expect(row.content).toBe(
			'<p>hi<a rel="nofollow noopener" target="_blank">bad</a> <a href="https://ok.example/" rel="nofollow noopener" target="_blank">ok</a></p>'
		)
		expect(row.url).toBeNull()
		expect(
			await sql(t.store, 'SELECT type, url, preview_url FROM media_attachments WHERE status_id = ?', row.id)
		).toEqual([{ type: 'unknown', url: 'https://ok.example/page', preview_url: null }])
		const shown = await t.api<{ url: string }>(`/api/v1/statuses/${row.id}`)
		// The API falls back to the uri for a status without a usable url.
		expect(shown.body.url).toBe(note.id)
	})

	it('converts an Article as Mastodon does: the name as a heading, the summary, and a link', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const article = mastodonNote(bob, {
			type: 'Article',
			name: 'A <i>title</i>',
			summary: '<p>The summary</p>',
			content: '<p>The long body</p>',
			url: `${MASTODON}/articles/1`,
		})
		await t.post(bob, create(bob, article))
		expect(await statusRow(t.store, article.id)).toMatchObject({
			content:
				'<p><strong>A <i>title</i></strong></p>\n\n<p>The summary</p>\n\n<a href="https://mastodon.example/articles/1" rel="nofollow noopener" target="_blank">https://mastodon.example/articles/1</a>',
			spoiler_text: '',
		})
		// Types Mastodon neither stores nor converts are not stored.
		await t.post(bob, create(bob, mastodonNote(bob, { type: 'Collection' })))
		expect(await statuses(t.store)).toHaveLength(1)
	})

	it('keeps a Misskey note whole in raw (_misskey_content, _misskey_quote, quoteUrl) and stores its HTML', async () => {
		const t = await setup()
		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await followed(t, neko)
		const note = misskeyNote(neko)
		expect(await t.post(neko, create(neko, note, MISSKEY_CONTEXT))).toBe(202)
		const row = (await statusRow(t.store, note.id))!
		expect(row.content).toBe('<p><span>にゃーん $[x2 big]</span></p>')
		expect(
			await sql(
				t.store,
				`SELECT json_extract(raw, '$._misskey_content') AS mfm, json_extract(raw, '$._misskey_quote') AS quote,
					json_extract(raw, '$.quoteUrl') AS quote_url FROM statuses WHERE uri = ?`,
				note.id
			)
		).toEqual([{ mfm: 'にゃーん $[x2 big]', quote: `${MISSKEY}/notes/9quoted`, quote_url: `${MISSKEY}/notes/9quoted` }])
		// Quotes are not a feature yet: the quoted note is not fetched.
		expect(t.web.fetched).not.toContain(`${MISSKEY}/notes/9quoted`)
	})

	it('VIS-2: a Misskey specified note is limited: silent recipients see it as private, nobody else does', async () => {
		const t = await setup()
		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		const note = misskeyNote(neko, { to: [ALICE_URI], cc: [], _misskey_quote: undefined, quoteUrl: undefined })
		expect(await t.post(neko, create(neko, note, MISSKEY_CONTEXT))).toBe(202)
		const row = (await statusRow(t.store, note.id))!
		expect(row.visibility).toBe('limited')
		expect(await sql(t.store, 'SELECT account_id, silent FROM status_mentions WHERE status_id = ?', row.id)).toEqual([
			{ account_id: ALICE, silent: 1 },
		])
		// VIS-7: silent recipients are not notified and not listed as mentions.
		expect(await notifications(t.store)).toEqual([])
		const seen = await t.api<{ visibility: string; mentions: unknown[] }>(`/api/v1/statuses/${row.id}`)
		expect(seen.body).toMatchObject({ visibility: 'private', mentions: [] })
		expect((await t.api(`/api/v1/statuses/${row.id}`, 'dave')).status).toBe(404)

		// Delivered again to dave's personal inbox: dave joins the audience as a silent recipient (Mastodon's
		// postprocess_audience_and_deliver), and the status stays limited.
		expect(await t.post(neko, create(neko, note, MISSKEY_CONTEXT), { path: '/ap/users/dave/inbox' })).toBe(202)
		expect((await t.api(`/api/v1/statuses/${row.id}`, 'dave')).status).toBe(200)
		expect((await statusRow(t.store, note.id))?.visibility).toBe('limited')
	})

	it('a direct note mentions its recipients and notifies them; a direct note to nobody local is not stored', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const direct = mastodonNote(bob, {
			to: [ALICE_URI],
			cc: [],
			tag: [{ type: 'Mention', href: ALICE_URI, name: '@alice' }],
		})
		await t.post(bob, create(bob, direct))
		expect((await statusRow(t.store, direct.id))?.visibility).toBe('direct')
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'mention' }])
		const stray = mastodonNote(bob, { to: [`${OTHER}/users/x`], cc: [] })
		await t.post(bob, create(bob, stray))
		// A public post of an account nobody here follows, addressed to nobody here, is not stored either.
		await t.post(bob, create(bob, mastodonNote(bob)))
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([direct.id])
	})

	it('links a reply that arrived before its parent once the parent arrives, without fetching it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const parent = mastodonNote(bob)
		const reply = mastodonNote(bob, { inReplyTo: parent.id })
		await t.post(bob, create(bob, reply))
		expect(await statusRow(t.store, reply.id)).toMatchObject({ in_reply_to_uri: parent.id, in_reply_to_id: null })
		expect(t.web.fetched).not.toContain(parent.id)
		await t.post(bob, create(bob, parent))
		const parentRow = (await statusRow(t.store, parent.id))!
		expect(await statusRow(t.store, reply.id)).toMatchObject({
			in_reply_to_id: parentRow.id,
			in_reply_to_account_id: bobId,
		})
		expect((await statusRow(t.store, parent.id))?.replies_count).toBe(1)
	})

	it('notifies followers who asked for posts, and stores a reply to a local status from anyone', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		await sql(t.store, 'UPDATE follows SET notify = 1 WHERE account_id = ? AND target_account_id = ?', ALICE, bobId)
		await t.post(bob, create(bob, mastodonNote(bob)))
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'status' }])
		// A reply to a status never stored has no known partner: no post notification, as home leaves it out.
		const orphan = mastodonNote(bob, { inReplyTo: `${OTHER}/notes/unknown` })
		await t.post(bob, create(bob, orphan))
		expect(await statusRow(t.store, orphan.id)).toMatchObject({ in_reply_to_id: null, in_reply_to_account_id: null })
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'status' }])

		const local = await localStatus(t, { status: 'hello', visibility: 'public' }, 'dave')
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3 })
		const reply = mastodonNote(erin, { inReplyTo: local.uri })
		await t.post(erin, create(erin, reply))
		expect(await statusRow(t.store, reply.id)).toMatchObject({ in_reply_to_id: local.id, in_reply_to_account_id: DAVE })
	})

	it('fetches the object of a Create given by id only, from the actor’s origin only', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		t.web.serve(note.id, { '@context': AS, ...note })
		expect(await t.post(bob, { ...create(bob, note), object: note.id })).toBe(202)
		expect(await statusRow(t.store, note.id)).toBeDefined()
		const foreign = `${OTHER}/notes/1`
		t.web.serve(foreign, { '@context': AS, ...mastodonNote(bob), id: foreign })
		expect(await t.post(bob, { ...create(bob, note), id: `${bob.uri}#c2`, object: foreign })).toBe(202)
		expect(t.web.fetched).not.toContain(foreign)
	})
})

describe('ID-7: duplicate and reordered Create and Delete', () => {
	it('applies a duplicate Create once: one status, one mention notification', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const note = mastodonNote(bob, {
			to: [ALICE_URI],
			cc: [],
			tag: [{ type: 'Mention', href: ALICE_URI, name: '@alice' }],
		})
		await t.post(bob, create(bob, note))
		await t.post(bob, create(bob, note))
		expect(await statuses(t.store)).toHaveLength(1)
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'mention' }])
	})

	it('keeps a Delete that arrived first, so the Create never applies; a replayed Create after a Delete neither', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const early = mastodonNote(bob)
		expect(await t.post(bob, remove(bob, early.id))).toBe(202)
		expect(await t.post(bob, create(bob, early))).toBe(202)
		const late = mastodonNote(bob)
		await t.post(bob, create(bob, late))
		await t.post(bob, remove(bob, late.id))
		await t.post(bob, create(bob, late))
		await t.post(bob, remove(bob, late.id))
		expect(await statuses(t.store)).toEqual([])
	})

	it('a Delete of an unknown object of the actor’s origin is recorded; of another origin, nothing', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		await t.post(bob, remove(bob, `${bob.uri}/statuses/unknown`))
		await t.post(bob, remove(bob, `${OTHER}/notes/1`))
		expect(await sql(t.store, 'SELECT target_uri FROM inbound_retractions')).toEqual([
			{ target_uri: `${bob.uri}/statuses/unknown` },
		])
	})
})

describe('Update of a status (ID-6, ID-7, VIS-2)', () => {
	it('records the edit in the history, and ignores an Update that is not newer (reordering)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const local = await localStatus(t, { status: 'boost me', visibility: 'public' }, 'alice')
		const note = mastodonNote(bob)
		await t.post(bob, create(bob, note))
		const row = (await statusRow(t.store, note.id))!
		// alice boosts it, so she hears of the edit.
		await t.request(`/api/v1/statuses/${row.id}/reblog`, {
			method: 'POST',
			headers: { authorization: `Bearer ${t.tokens.alice}` },
		})
		void local
		const newer = update(bob, { ...note, content: '<p>edited</p>', summary: 'cw' }, '2026-10-11T13:00:00Z')
		const older = update(bob, { ...note, content: '<p>older</p>' }, '2026-10-11T12:30:00Z')
		expect(await t.post(bob, newer)).toBe(202)
		expect(await t.post(bob, older)).toBe(202)
		expect(await t.post(bob, newer)).toBe(202)
		expect(await statusRow(t.store, note.id)).toMatchObject({
			content: '<p>edited</p>',
			spoiler_text: 'cw',
			edited_at: '2026-10-11T13:00:00.000Z',
		})
		expect(
			await sql(
				t.store,
				'SELECT content, spoiler_text, created_at FROM status_edits WHERE status_id = ? ORDER BY id',
				row.id
			)
		).toEqual([
			{ content: note.content, spoiler_text: '', created_at: '2026-10-11T12:00:00.000Z' },
			{ content: '<p>edited</p>', spoiler_text: 'cw', created_at: '2026-10-11T13:00:00.000Z' },
		])
		expect(await notifications(t.store)).toContainEqual({ account_id: ALICE, type: 'update' })
		const history = await t.api<unknown[]>(`/api/v1/statuses/${row.id}/history`)
		expect(history.body).toHaveLength(2)
	})

	it('creates an unknown recent status from its Update (Create and Update out of order), not an old one', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const recent = mastodonNote(bob)
		await t.post(bob, update(bob, recent, '2026-10-11T13:00:00Z'))
		const old = mastodonNote(bob, { published: '2026-10-01T00:00:00Z' })
		await t.post(bob, update(bob, old, '2026-10-11T13:00:00Z'))
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([recent.id])
	})

	it('never widens a private audience: a mention added by an edit adds no recipient (VIS-2)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] })
		await t.post(bob, create(bob, note))
		const row = (await statusRow(t.store, note.id))!
		expect(row.visibility).toBe('private')
		const edit = update(
			bob,
			{
				...note,
				to: [PUBLIC],
				cc: [DAVE_URI],
				content: '<p>now @dave</p>',
				tag: [{ type: 'Mention', href: DAVE_URI, name: '@dave' }],
			},
			'2026-10-11T13:00:00Z'
		)
		await t.post(bob, edit)
		expect(await statusRow(t.store, note.id)).toMatchObject({ visibility: 'private', content: '<p>now @dave</p>' })
		expect(await sql(t.store, 'SELECT * FROM status_mentions WHERE status_id = ?', row.id)).toEqual([])
		expect((await t.api(`/api/v1/statuses/${row.id}`, 'dave')).status).toBe(404)

		// A public status takes the new mention, as Mastodon does.
		const open = mastodonNote(bob)
		await t.post(bob, create(bob, open))
		await t.post(bob, update(bob, { ...open, tag: [{ type: 'Mention', href: DAVE_URI }] }, '2026-10-11T13:00:00Z'))
		const openRow = (await statusRow(t.store, open.id))!
		expect(
			await sql(t.store, 'SELECT account_id, silent FROM status_mentions WHERE status_id = ?', openRow.id)
		).toEqual([{ account_id: DAVE, silent: 0 }])
	})

	it('ID-6: another actor of the same origin cannot update a status; nobody remote updates a local one (ID-3)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		await followed(t, bob)
		await followed(t, carol)
		const note = mastodonNote(bob)
		await t.post(bob, create(bob, note))
		const forged = update(carol, { ...note, content: '<p>pwned</p>' }, '2026-10-11T13:00:00Z')
		expect(await t.post(carol, forged)).toBe(202)
		const asCarol = update(carol, { ...note, attributedTo: carol.uri, content: '<p>pwned</p>' }, '2026-10-11T13:00:00Z')
		expect(await t.post(carol, asCarol)).toBe(202)
		expect((await statusRow(t.store, note.id))?.content).toBe(note.content)

		const local = await localStatus(t, { status: 'mine', visibility: 'public' })
		const localUpdate = update(bob, { ...note, id: local.uri, content: '<p>pwned</p>' }, '2026-10-11T13:00:00Z')
		expect(await t.post(bob, localUpdate)).toBe(202)
		expect((await sql(t.store, 'SELECT content, edited_at FROM statuses WHERE id = ?', local.id))[0]).toEqual({
			content: '<p>mine</p>',
			edited_at: null,
		})
		expect(await sql(t.store, 'SELECT * FROM status_edits')).toEqual([])
	})
})

describe('hashtags a hashtag timeline lists (status_tags.public)', () => {
	it('marks the hashtags of a public status only, on Create and on Update', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const tag = (name: string) => ({ type: 'Hashtag', name: `#${name}` })
		const open = mastodonNote(bob, { tag: [tag('cats')] })
		const unlisted = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [PUBLIC], tag: [tag('cats')] })
		const followers = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [], tag: [tag('cats')] })
		for (const note of [open, unlisted, followers]) {
			expect(await t.post(bob, create(bob, note))).toBe(202)
		}
		const rows = async () =>
			sql(
				t.store,
				`SELECT s.uri, s.visibility, t.name, t.public FROM status_tags t JOIN statuses s ON s.id = t.status_id
				ORDER BY s.uri, t.name`
			)
		const expected = (names: string[]) =>
			[
				{ uri: open.id, visibility: 'public', public: 1 },
				{ uri: unlisted.id, visibility: 'unlisted', public: 0 },
				{ uri: followers.id, visibility: 'private', public: 0 },
			]
				.flatMap((row) => names.map((name) => ({ ...row, name })))
				.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : a.name < b.name ? -1 : 1))
		expect(await rows()).toEqual(expected(['cats']))

		// An Update rewrites the hashtags; the status keeps its visibility, so its hashtags keep the mark.
		for (const note of [open, unlisted, followers]) {
			const edited = { ...note, tag: [tag('cats'), tag('dogs')] }
			expect(await t.post(bob, update(bob, edited, '2026-10-11T13:00:00Z'))).toBe(202)
		}
		expect(await rows()).toEqual(expected(['cats', 'dogs']))
	})
})

describe("mentions home's mentions stream reads (status_mentions.requires_mention)", () => {
	it('marks the mentions of direct and limited statuses only, however they are written', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		const mention = (uri: string, name: string) => ({ type: 'Mention', href: uri, name })
		// Remote Creates: public with a mention, direct to alice, followers-only addressing dave, and a Misskey specified
		// note (limited) to alice, delivered again to dave's personal inbox (a silent recipient added).
		const open = mastodonNote(bob, { cc: [`${bob.uri}/followers`, ALICE_URI], tag: [mention(ALICE_URI, '@alice')] })
		const direct = mastodonNote(bob, { to: [ALICE_URI], cc: [], tag: [mention(ALICE_URI, '@alice')] })
		const followers = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [DAVE_URI] })
		for (const note of [open, direct, followers]) {
			expect(await t.post(bob, create(bob, note))).toBe(202)
		}
		const specified = misskeyNote(neko, { to: [ALICE_URI], cc: [], _misskey_quote: undefined, quoteUrl: undefined })
		expect(await t.post(neko, create(neko, specified, MISSKEY_CONTEXT))).toBe(202)
		expect(await t.post(neko, create(neko, specified, MISSKEY_CONTEXT), { path: '/ap/users/dave/inbox' })).toBe(202)
		// A remote Update that mentions dave as well.
		const edited = { ...open, tag: [mention(ALICE_URI, '@alice'), mention(DAVE_URI, '@dave')] }
		expect(await t.post(bob, update(bob, edited, '2026-10-11T13:00:00Z'))).toBe(202)
		// A boost addressed to alice.
		const local = await localStatus(t, { status: 'public post', visibility: 'public' }, 'dave')
		expect(await t.post(bob, announce(bob, local.uri, { to: [`${bob.uri}/followers`], cc: [ALICE_URI] }))).toBe(202)
		// Local posts: public and direct, each mentioning dave.
		await localStatus(t, { status: '@dave hello', visibility: 'public' })
		await localStatus(t, { status: '@dave psst', visibility: 'direct' })

		const rows = await sql(
			t.store,
			`SELECT s.visibility, m.requires_mention FROM status_mentions m JOIN statuses s ON s.id = m.status_id
			ORDER BY s.visibility, m.requires_mention`
		)
		// Every kind of write was made, and each row is marked exactly when its status needs a mention to be seen.
		expect(new Set(rows.map((row) => row.visibility))).toEqual(new Set(['public', 'private', 'direct', 'limited']))
		expect(
			rows.filter(
				(row) => row.requires_mention !== (row.visibility === 'direct' || row.visibility === 'limited' ? 1 : 0)
			)
		).toEqual([])
		expect(rows.filter((row) => row.requires_mention === 1)).toHaveLength(4)
	})
})

describe('Delete of a status (ID-6, RES-6)', () => {
	it('deletes the author’s status with its children, and nothing of anyone else’s (ID-6, ID-3)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		await followed(t, bob)
		await followed(t, carol)
		const note = mastodonNote(bob, {
			cc: [`${bob.uri}/followers`, ALICE_URI],
			tag: [
				{ type: 'Mention', href: ALICE_URI },
				{ type: 'Hashtag', name: '#x' },
			],
			attachment: [{ type: 'Document', mediaType: 'image/png', url: `${MASTODON}/m.png` }],
		})
		await t.post(bob, create(bob, note))
		const local = await localStatus(t, { status: 'mine', visibility: 'public' })

		expect(await t.post(carol, remove(carol, note.id))).toBe(202)
		expect(await t.post(bob, remove(bob, local.uri))).toBe(202)
		expect((await statuses(t.store)).map((s) => s.uri).sort()).toEqual([local.uri, note.id].sort())
		// A refused Delete records no retraction (ID-7).
		expect(await sql(t.store, 'SELECT * FROM inbound_retractions')).toEqual([])

		expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([local.uri])
		for (const table of ['status_mentions', 'status_tags', 'media_attachments', 'notifications']) {
			expect(await sql(t.store, `SELECT * FROM ${table}`), table).toEqual([])
		}
	})

	it('deletes a status with many children in bounded batches, hidden at once and finished on the Queue', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const names = ['cats', ...Array.from({ length: 19 }, (_, i) => `t${i}`)]
		const note = mastodonNote(bob, { tag: names.map((name) => ({ type: 'Hashtag', name: `#${name}` })) })
		await t.post(bob, create(bob, note))
		const row = (await statusRow(t.store, note.id))!
		const boosts = PURGE_BATCH + 50
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('4%017d', i), 'https://many.example/u/' || i, 'u' || i,
				'many.example' FROM n`,
			boosts
		)
		await sql(
			t.store,
			`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
			SELECT printf('5%017d', CAST(substr(id, 2) AS INTEGER)), 'https://many.example/b/' || id, id, ?, 'public',
				'2026-10-11T13:00:00.000Z' FROM accounts WHERE domain = 'many.example'`,
			row.id
		)
		expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		const hidden = (await statusRow(t.store, note.id))!
		expect(hidden).toMatchObject({ visibility: 'direct', content: '' })
		expect((await t.api(`/api/v1/statuses/${row.id}`)).status).toBe(404)
		expect(t.queue.pending.map((m) => m.body)).toContainEqual({ kind: 'inbound-jobs' })
		// Its hashtags leave the tag reads with it, the ones a later batch removes included.
		const marks = await sql<{ public: number; n: number }>(
			t.store,
			'SELECT public, count(*) AS n FROM status_tags WHERE status_id = ? GROUP BY public',
			row.id
		)
		expect(marks).toEqual([{ public: 0, n: expect.any(Number) }])

		const deps = inboxDeps(() => t.store, t.web.loader)
		const env = { ...t.env, MAINTENANCE: 'off' } as Env
		await t.queue.deliver((batch) => handleQueue(batch, env, deps))
		await t.queue.deliver((batch) => handleQueue(batch, env, deps))
		expect(await statuses(t.store)).toEqual([])
		expect(await sql(t.store, "SELECT done_at IS NOT NULL AS done FROM inbound_jobs WHERE kind = 'delete'")).toEqual([
			{ done: 1 },
		])
	})

	it('takes the hashtags of statuses still being deleted out of tag reads at once (RES-7)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		// Each with more hashtags than a batch has rows left once the boosts it removes are counted; the one read sorts
		// last, so a batch's removal of hashtags reaches it last.
		const tags = [...Array.from({ length: 19 }, (_, i) => `t${i}`), 'zebra'].map((name) => ({
			type: 'Hashtag',
			name: `#${name}`,
		}))
		const notes = Array.from({ length: 20 }, () => mastodonNote(bob, { tag: tags }))
		for (const note of notes) {
			await t.post(bob, create(bob, note))
		}
		// Each with more boosts than a batch removes, so every deletion is still pending after its Delete.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('4%017d', i), 'https://many.example/u/' || i, 'u' || i,
				'many.example' FROM n`,
			PURGE_BATCH + 10
		)
		await sql(
			t.store,
			`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
			SELECT printf('5%04d%013d', o.rowid % 10000, CAST(substr(a.id, 2) AS INTEGER)), o.uri || '/b/' || a.id, a.id, o.id,
				'public', '2026-10-11T13:00:00.000Z'
			FROM statuses o CROSS JOIN accounts a WHERE o.reblog_of_id IS NULL AND a.domain = 'many.example'`
		)
		const reads = async () => ({
			timeline: await rowsRead({ store: t.store }, tagTimeline, {
				credential: null,
				now: NOW,
				page: { limit: 20 },
				local: false,
				remote: false,
				onlyMedia: false,
				present: { origin: 'https://kopje.test' },
				tag: 'zebra',
				any: [],
				all: [],
				none: [],
			}),
			history: await rowsRead({ store: t.store }, getTag, {
				credential: null,
				name: 'zebra',
				now: Date.parse('2026-10-11T18:00:00.000Z'),
				present: { origin: 'https://kopje.test' },
			}),
		})
		for (const note of notes) {
			expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		}
		expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses WHERE reblog_of_id IS NULL')).toEqual([{ n: 20 }])
		expect(
			await sql(t.store, "SELECT public, count(*) AS n FROM status_tags WHERE name = 'zebra' GROUP BY public")
		).toEqual([{ public: 0, n: 20 }])
		const pending = await reads()

		const deps = inboxDeps(() => t.store, t.web.loader)
		const env = { ...t.env, MAINTENANCE: 'off' } as Env
		for (let round = 0; round < 50 && (await statuses(t.store)).length > 0; round++) {
			await t.queue.deliver((batch) => handleQueue(batch, env, deps))
		}
		expect(await statuses(t.store)).toEqual([])
		const finished = await reads()
		expect(pending.timeline).toBeLessThanOrEqual(finished.timeline + 5)
		expect(pending.history).toBeLessThanOrEqual(finished.history + 5)
	}, 60_000)
})

describe('Like and reactions (Mastodon and Misskey)', () => {
	it('stores a Like of a local status as a favourite, once, and notifies the author; Undo removes it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const local = await localStatus(t, { status: 'like me', visibility: 'public' })
		const liked = like(bob, local.uri)
		expect(await t.post(bob, liked)).toBe(202)
		expect(await t.post(bob, liked)).toBe(202)
		const bobId = (await accountId(t.store, bob.uri))!
		expect(await sql(t.store, 'SELECT account_id, uri FROM favourites')).toEqual([{ account_id: bobId, uri: liked.id }])
		expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(1)
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'favourite' }])

		expect(await t.post(bob, undo(bob, { id: liked.id, type: 'Like', actor: bob.uri, object: local.uri }))).toBe(202)
		expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
		expect(await notifications(t.store)).toEqual([])
		expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(0)
		// A replay of the undone Like does not restore it (ID-7).
		expect(await t.post(bob, liked)).toBe(202)
		expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
	})

	it('receives Misskey reactions and EmojiReact as favourites, without the emoji', async () => {
		const t = await setup()
		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		const bob = await mastodonActor(t.web, 'bob')
		const local = await localStatus(t, { status: 'react to me', visibility: 'public' })
		const reaction = {
			...like(neko, local.uri),
			'@context': MISSKEY_CONTEXT,
			content: ':blobcat:',
			_misskey_reaction: ':blobcat:',
			tag: [
				{
					id: `${MISSKEY}/emojis/blobcat`,
					type: 'Emoji',
					name: ':blobcat:',
					icon: { type: 'Image', url: `${MISSKEY}/e/b.png` },
				},
			],
		}
		expect(await t.post(neko, reaction)).toBe(202)
		const emojiReact = { ...like(bob, local.uri), type: 'EmojiReact', content: '🍮' }
		expect(await t.post(bob, emojiReact)).toBe(202)
		expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(2)
		expect(await sql(t.store, 'SELECT uri FROM favourites ORDER BY id')).toEqual([
			{ uri: reaction.id },
			{ uri: emojiReact.id },
		])
		// Misskey undoes a reaction by the Like's id.
		expect(await t.post(neko, undo(neko, reaction.id))).toBe(202)
		expect(await sql(t.store, 'SELECT uri FROM favourites')).toEqual([{ uri: emojiReact.id }])
	})

	it('ID-6, ID-7: keeps an Undo that arrived before its Like, and ignores Likes of remote, unknown or hidden statuses (VIS-1)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const local = await localStatus(t, { status: 'early', visibility: 'public' })
		const early = like(bob, local.uri)
		await t.post(bob, undo(bob, { id: early.id, type: 'Like', actor: bob.uri, object: local.uri }))
		await t.post(bob, early)
		// VIS-1: a private status the actor may not see.
		const secret = await localStatus(t, { status: 'followers only', visibility: 'private' })
		await t.post(bob, like(bob, secret.uri))
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		await followed(t, carol)
		const remote = mastodonNote(carol)
		await t.post(carol, create(carol, remote))
		await t.post(bob, like(bob, remote.id))
		expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
		expect(await notifications(t.store)).toEqual([])
	})

	it('VIS-13, VIS-15: ignores a Like by an actor the author blocks or whose domain the author blocks', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3 })
		const local = await localStatus(t, { status: 'not for them', visibility: 'unlisted' })
		// Bob's first activity stores his account, for alice to block.
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		await block(t.store, ALICE, (await accountId(t.store, bob.uri))!)
		await domainBlock(t.store, ALICE, new URL(carol.uri).host)
		for (const actor of [bob, carol]) {
			expect(await t.post(actor, like(actor, local.uri))).toBe(202)
		}
		expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
		expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(0)
		// An actor on another domain still may.
		expect(await t.post(erin, like(erin, local.uri))).toBe(202)
		const erinId = (await accountId(t.store, erin.uri))!
		expect(await sql(t.store, 'SELECT account_id FROM favourites')).toEqual([{ account_id: erinId }])
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'favourite' }])
	})
})

describe('Announce (VIS-6, NET-4)', () => {
	it('stores a boost of a local status and notifies its author; Undo and Delete of the Announce remove it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const local = await localStatus(t, { status: 'boost me', visibility: 'public' })
		const boost = announce(bob, local.uri)
		expect(await t.post(bob, boost)).toBe(202)
		expect(await t.post(bob, boost)).toBe(202)
		const bobId = (await accountId(t.store, bob.uri))!
		// The boost's id comes from its published time, which is before the local status's.
		expect(await statuses(t.store)).toEqual([
			{ uri: boost.id, visibility: 'public', reblog_of_id: local.id },
			{ uri: local.uri, visibility: 'public', reblog_of_id: null },
		])
		expect((await statusRow(t.store, local.uri))?.reblogs_count).toBe(1)
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'reblog' }])
		const by = await t.api<{ id: string }[]>(`/api/v1/statuses/${local.id}/reblogged_by`)
		expect(by.body.map((a) => a.id)).toEqual([bobId])

		await t.post(bob, undo(bob, { id: boost.id, type: 'Announce', actor: bob.uri, object: local.uri }))
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([local.uri])
		expect(await notifications(t.store)).toEqual([])
		expect(await t.post(bob, boost)).toBe(202)
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([local.uri])

		const again = announce(bob, local.uri)
		await t.post(bob, again)
		await t.post(bob, remove(bob, again.id))
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([local.uri])
		expect((await statusRow(t.store, local.uri))?.reblogs_count).toBe(0)
	})

	it('fetches an unknown original within the budget, signed by the instance actor (NET-4), with its author', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3 })
		const original = mastodonNote(erin)
		t.web.serve(original.id, { '@context': AS, ...original })
		t.web.fetched.length = 0
		t.web.signers.length = 0
		const boost = announce(bob, original.id)
		expect(await t.post(bob, boost)).toBe(202)
		expect(t.web.fetched).toEqual([original.id, erin.uri])
		expect(new Set(t.web.signers)).toEqual(new Set([`${LOCAL}/actor#main-key`]))
		const originalRow = (await statusRow(t.store, original.id))!
		expect(await statuses(t.store)).toEqual([
			{ uri: original.id, visibility: 'public', reblog_of_id: null },
			{ uri: boost.id, visibility: 'public', reblog_of_id: originalRow.id },
		])
		const home = await t.api<{ reblog: { uri: string } | null }[]>('/api/v1/timelines/home')
		expect(home.body.map((s) => s.reblog?.uri)).toEqual([original.id])
		// A boost of a local follower's personal inbox is fetched with that follower's key.
		const other = mastodonNote(erin)
		t.web.serve(other.id, { '@context': AS, ...other })
		t.web.signers.length = 0
		await t.post(bob, announce(bob, other.id), { path: '/ap/users/alice/inbox' })
		expect(new Set(t.web.signers)).toEqual(new Set([`${ALICE_URI}#main-key`]))
	})

	it('ID-6, VIS-6: a boost of a private, direct or unfetchable object stores nothing', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3 })
		const privateNote = mastodonNote(erin, { to: [`${erin.uri}/followers`], cc: [] })
		const directNote = mastodonNote(erin, { to: [ALICE_URI], cc: [] })
		t.web.serve(privateNote.id, { '@context': AS, ...privateNote })
		t.web.serve(directNote.id, { '@context': AS, ...directNote })
		for (const object of [privateNote.id, directNote.id, `${OTHER}/statuses/gone`]) {
			expect(await t.post(bob, announce(bob, object))).toBe(202)
		}
		// An embedded copy of someone else's object is not trusted: it is fetched like any other.
		await t.post(bob, announce(bob, privateNote.id, { object: { ...privateNote, to: [PUBLIC] } }))
		expect(await statuses(t.store)).toEqual([])

		// Stored private and limited statuses of others are not boosted either.
		const stored = mastodonNote(erin, { to: [`${erin.uri}/followers`], cc: [] })
		const erinId = await followed(t, erin)
		await t.post(erin, create(erin, stored))
		await t.post(bob, announce(bob, stored.id))
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([stored.id])
		void erinId
	})

	it('VIS-6: a boost of an unlisted object stays out of the public timelines with its original', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3 })
		const unlisted = mastodonNote(erin, { to: [`${erin.uri}/followers`], cc: [PUBLIC] })
		t.web.serve(unlisted.id, { '@context': AS, ...unlisted })
		await t.post(bob, announce(bob, unlisted.id))
		expect((await statuses(t.store)).map((s) => s.visibility)).toEqual(['unlisted', 'public'])
		expect((await t.api<unknown[]>('/api/v1/timelines/public', null)).body).toEqual([])
		expect((await t.api<unknown[]>('/api/v1/timelines/public?remote=true')).body).toEqual([])
	})

	it('a self-boost embeds its own status; an Announce unrelated to this instance fetches nothing', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const own = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] })
		await t.post(bob, announce(bob, own.id, { object: own, to: [`${bob.uri}/followers`], cc: [] }))
		expect((await statuses(t.store)).map((s) => s.visibility)).toEqual(['private', 'private'])
		const stranger = await mastodonActor(t.web, 'stranger', { origin: OTHER, key: 3 })
		const elsewhere = mastodonNote(stranger)
		t.web.serve(elsewhere.id, { '@context': AS, ...elsewhere })
		await t.post(stranger, announce(stranger, elsewhere.id))
		expect(t.web.fetched).not.toContain(elsewhere.id)
		expect(await statuses(t.store)).toHaveLength(2)
	})

	it('VIS-13, VIS-15: ignores a boost by an actor the author blocks or whose domain the author blocks', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3 })
		const local = await localStatus(t, { status: 'not for them', visibility: 'public' })
		// Bob's first activity stores his account, for alice to block.
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		await block(t.store, ALICE, (await accountId(t.store, bob.uri))!)
		await domainBlock(t.store, ALICE, new URL(carol.uri).host)
		for (const actor of [bob, carol]) {
			expect(await t.post(actor, announce(actor, local.uri))).toBe(202)
		}
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([local.uri])
		expect((await statusRow(t.store, local.uri))?.reblogs_count).toBe(0)
		// An actor on another domain still may.
		const boost = announce(erin, local.uri)
		expect(await t.post(erin, boost)).toBe(202)
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([boost.id, local.uri])
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'reblog' }])
	})
})

describe('search with resolve=true (NET-4, VIS-1)', () => {
	it('answers 401 without a token and fetches nothing', async () => {
		const t = await setup()
		const response = await t.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(`${MASTODON}/users/bob`)}`)
		expect(response.status).toBe(401)
		expect(t.web.fetched).toEqual([])
	})

	it('resolves a status URL as the instance actor, stores it with its author, and returns it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const note = mastodonNote(bob, { content: '<p>found <script>x</script></p>' })
		t.web.serve(note.id, { '@context': AS, ...note })
		const found = await t.api<{ statuses: { uri: string; content: string; account: { acct: string } }[] }>(
			`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`
		)
		expect(found.body.statuses).toMatchObject([
			{ uri: note.id, content: '<p>found </p>', account: { acct: 'bob@mastodon.example' } },
		])
		expect(new Set(t.web.signers)).toEqual(new Set([`${LOCAL}/actor#main-key`]))
		// Stored, but not notified, and outside the public timelines' rules as any fetched status.
		expect(await notifications(t.store)).toEqual([])
		// A second search answers from the Store's row.
		const again = await t.api<{ statuses: { id: string }[] }>(
			`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`
		)
		expect(again.body.statuses).toHaveLength(1)
		expect(await statuses(t.store)).toHaveLength(1)
	})

	it('a fetched private object is shown only to those who may see it; an unlisted one stays unlisted', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const privateNote = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [] })
		const unlisted = mastodonNote(bob, { to: [`${bob.uri}/followers`], cc: [PUBLIC] })
		t.web.serve(privateNote.id, { '@context': AS, ...privateNote })
		t.web.serve(unlisted.id, { '@context': AS, ...unlisted })
		const hidden = await t.api<{ statuses: unknown[] }>(
			`/api/v2/search?resolve=true&q=${encodeURIComponent(privateNote.id)}`
		)
		expect(hidden.body.statuses).toEqual([])
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			ALICE,
			bobId
		)
		const shown = await t.api<{ statuses: { visibility: string }[] }>(
			`/api/v2/search?resolve=true&q=${encodeURIComponent(privateNote.id)}`
		)
		expect(shown.body.statuses).toMatchObject([{ visibility: 'private' }])
		const dave = await t.api<{ statuses: unknown[] }>(
			`/api/v2/search?resolve=true&q=${encodeURIComponent(privateNote.id)}`,
			'dave'
		)
		expect(dave.body.statuses).toEqual([])

		const open = await t.api<{ statuses: { visibility: string }[] }>(
			`/api/v2/search?resolve=true&q=${encodeURIComponent(unlisted.id)}`,
			'dave'
		)
		expect(open.body.statuses).toMatchObject([{ visibility: 'unlisted' }])
		expect((await t.api<unknown[]>('/api/v1/timelines/public', null)).body).toEqual([])
	})

	it('answers a status by the single-status rule, unless the viewer blocks its author’s domain', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const note = mastodonNote(bob, { content: '<p>found</p>' })
		t.web.serve(note.id, { '@context': AS, ...note })
		const found = async (as: 'alice' | 'dave' = 'alice') =>
			(await t.api<{ statuses: unknown[] }>(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`, as)).body
				.statuses
		expect(await found()).toHaveLength(1)
		const bobId = (await accountId(t.store, bob.uri))!
		// An explicit lookup, like GET /api/v1/statuses/:id: the viewer's own mute or block does not hide it.
		await mute(t.store, ALICE, bobId)
		await block(t.store, ALICE, bobId)
		expect(await found()).toHaveLength(1)
		// The author blocking the viewer does (VIS-1), and so does the viewer's block of the author's domain.
		await sql(t.store, 'DELETE FROM blocks')
		await block(t.store, bobId, ALICE)
		expect(await found()).toEqual([])
		await sql(t.store, 'DELETE FROM blocks')
		await domainBlock(t.store, ALICE, new URL(bob.uri).host)
		expect(await found()).toEqual([])
		expect(await found('dave')).toHaveLength(1)
	})

	it('resolves user@domain through WebFinger and an actor URL, and never fetches a local URL', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		t.web.serve(
			`${MASTODON}/.well-known/webfinger?resource=${encodeURIComponent('acct:bob@mastodon.example')}`,
			{
				subject: 'acct:bob@mastodon.example',
				links: [
					{ rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: `${MASTODON}/@bob` },
					{ rel: 'self', type: AP, href: bob.uri },
				],
			},
			'application/jrd+json'
		)
		const found = await t.api<{ accounts: { acct: string }[] }>(
			'/api/v2/search?resolve=true&q=%40bob%40mastodon.example'
		)
		expect(found.body.accounts.map((a) => a.acct)).toEqual(['bob@mastodon.example'])
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3 })
		const byUrl = await t.api<{ accounts: { acct: string }[] }>(
			`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(erin.uri)}`
		)
		expect(byUrl.body.accounts.map((a) => a.acct)).toEqual(['erin@other.example'])

		const local = await localStatus(t, { status: 'here', visibility: 'public' })
		t.web.fetched.length = 0
		const own = await t.api<{ statuses: { id: string }[] }>(
			`/api/v2/search?resolve=true&q=${encodeURIComponent(local.uri)}`
		)
		expect(own.body.statuses.map((s) => s.id)).toEqual([local.id])
		expect(t.web.fetched).toEqual([])
	})
})

describe('bounds (RES-2, RES-4)', () => {
	it('caps the attachments, tags and content one status stores', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob, {
			content: `<p>${'x'.repeat(REMOTE_HTML_RAW_LIMIT * 2)}</p>`,
			attachment: Array.from({ length: 10 }, (_, i) => ({
				type: 'Document',
				mediaType: 'image/png',
				url: `${MASTODON}/m/${i}.png`,
			})),
			tag: Array.from({ length: MAX_STATUS_TAGS + 50 }, (_, i) => ({ type: 'Hashtag', name: `#tag${i}` })),
		})
		const started = Date.now()
		expect(await t.post(bob, create(bob, note))).toBe(202)
		expect(Date.now() - started).toBeLessThan(5000)
		const row = (await statusRow(t.store, note.id))!
		expect(row.content.length).toBeLessThanOrEqual(REMOTE_HTML_RAW_LIMIT + 7)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM media_attachments')).toEqual([{ n: MAX_STATUS_MEDIA }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM status_tags')).toEqual([{ n: MAX_STATUS_TAGS }])
	})

	it('refuses an activity or a fetched document past the JSON bounds before reading it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		let nested: unknown = 'deep'
		for (let i = 0; i < MAX_JSON_DEPTH + 5; i++) {
			nested = [nested]
		}
		const deep = mastodonNote(bob, { tag: nested })
		expect(await t.post(bob, create(bob, deep))).toBe(202)
		const wide = mastodonNote(bob, { tag: Array.from({ length: 20_000 }, () => 0) })
		const started = Date.now()
		expect(await t.post(bob, create(bob, wide))).toBe(202)
		expect(Date.now() - started).toBeLessThan(5000)
		expect(await statuses(t.store)).toEqual([])

		// A fetched actor document past the bounds is never handed to JSON-LD.
		const heavy = await mastodonActor(t.web, 'heavy', {
			origin: OTHER,
			key: 3,
			extra: { attachment: Array.from({ length: 20_000 }, () => ({ type: 'PropertyValue', name: 'n', value: 'v' })) },
		})
		expect(await t.post(heavy, like(heavy, `${LOCAL}/ap/o/x`))).toBe(401)
	})
})

describe('profile fields of remote accounts (HTML-1, HTML-3)', () => {
	it('shows PropertyValue fields with sanitized values and http(s) links only', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob', {
			extra: {
				attachment: [
					{ type: 'PropertyValue', name: 'Site', value: '<a href="https://example.com" rel="me">example.com</a>' },
					{ type: 'PropertyValue', name: 'Bad', value: '<a href="javascript:alert(1)">x</a><script>y</script>' },
					{ type: 'IdentityProof', name: 'skip', signatureValue: 'x' },
				],
			},
		})
		await followed(t, bob)
		const bobId = (await accountId(t.store, bob.uri))!
		const shown = await t.api<{ fields: unknown[] }>(`/api/v1/accounts/${bobId}`)
		expect(shown.body.fields).toEqual([
			{
				name: 'Site',
				value: '<a href="https://example.com" rel="nofollow noopener" target="_blank">example.com</a>',
				verified_at: null,
			},
			{ name: 'Bad', value: '<a rel="nofollow noopener" target="_blank">x</a>', verified_at: null },
		])
	})
})

describe('WEB-5: responses declare their type', () => {
	it('sends nosniff on API, federation, inbox and error responses', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const responses = [
			await t.request('/api/v1/timelines/home', { headers: { authorization: `Bearer ${t.tokens.alice}` } }),
			await t.request('/api/v1/statuses/1'),
			await t.request('/ap/users/alice', { headers: { accept: AP } }),
			await t.request('/inbox', await signedInit(bob, '/inbox', like(bob, `${LOCAL}/ap/o/x`))),
			await t.request('/nowhere'),
		]
		expect(responses.map((r) => r.headers.get('x-content-type-options'))).toEqual(Array(5).fill('nosniff'))
		expect(responses[0]?.headers.get('content-type')).toMatch(/^application\/json/)
		expect(responses[2]?.headers.get('content-type')).toMatch(/^application\/activity\+json/)
	})
})
