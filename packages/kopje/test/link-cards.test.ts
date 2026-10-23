import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { community, post, remoteAccount } from './status-helpers'
import { selectSql } from '../src/db/columns'
import { Db } from '../src/db/sql'
import { jsonBytes } from '../src/domain/answer-budget'
import { deleteStatusBatch, PURGE_BATCH } from '../src/domain/inbox'
import { CARD_CANDIDATES, localCardLink } from '../src/domain/link-cards'
import { CARD_JSON_MAX, cardIframe, type CardRow, presentCard } from '../src/domain/status-presenter'
import { CARD_COLUMN_MAP } from '../src/domain/status-rows'
import { parseRemoteStatus } from '../src/federation/remote-status'
import { WEB_PAGE_URL_LIMIT } from '../src/federation/web-page'
import type { StoreStub } from '../src/platform/store-client'
import {
	BLURHASH_BYTES,
	CARD_DIMENSION_MAX,
	CARD_EMBED_SRC_BYTES,
	CARD_EMBED_SRC_ESCAPED_BYTES,
	CARD_IMAGE_DESCRIPTION_JSON_BYTES,
	CARD_IMAGE_TOKEN_BYTES,
	CARD_IMAGE_URL_BYTES,
	CARD_LANGUAGE_BYTES,
	CARD_OPTIONAL_URL_LIMIT,
	CARD_TEXTS,
	CARD_URL_LIMIT,
	presentedCardText,
	presentedCardUrl,
	OEMBED_TEMPLATE_BYTES,
} from '../src/platform/stored-bounds'

// A link of 0 by 0 without an embed, as 0069_card_embeds defaults a row.
const LINK_ROW = {
	card_type: 0,
	width: 0,
	height: 0,
	embed_src: '',
	iframe_width: null,
	iframe_height: null,
	image_description: '',
	image_token: null,
	image_width: null,
	image_height: null,
	blurhash: null,
}
const presentFor = (card: Partial<Omit<CardRow, 'status_id'>> & Pick<CardRow, 'url' | 'title'>, origin = ORIGIN) =>
	presentCard(
		{ visibility: 'public' },
		{ status_id: '1', ...boundCard('ascii'), ...LINK_ROW, ...card } as CardRow,
		origin
	)

// Status cards (domain/link-cards.ts, federation/link-cards.ts): Mastodon's FetchLinkCardService (v4.5.11) as one
// copy per status, fetched by the cron's round through the web-page sink (NET-3).

const ORIGIN = 'https://kopje.test'
const AS = 'https://www.w3.org/ns/activitystreams'
const PUBLIC = `${AS}#Public`
const CAROL = 'https://remote.example/users/carol'

let sequence = 0

function note(
	content: string,
	extra: Record<string, unknown> = {}
): Record<string, unknown> & { id: string; content: string } {
	const id = `${CAROL}/statuses/${++sequence}`
	return {
		id,
		type: 'Note',
		attributedTo: CAROL,
		published: '2026-10-11T12:00:00Z',
		to: [PUBLIC],
		cc: [`${CAROL}/followers`],
		content,
		...extra,
	}
}

async function world() {
	const h = await community(['alice'])
	const carol = await remoteAccount(h.store, 'carol')
	const receive = async (
		object: Record<string, unknown> & { id: string },
		type: 'Create' | 'UpdateStatus' = 'Create',
		at = NOW
	) => {
		const status = parseRemoteStatus(object)
		expect(status).not.toBeNull()
		return h.store.receiveActivity(BUILD, {
			now: at,
			origin: ORIGIN,
			actorUri: CAROL,
			actor: null,
			recipient: 'alice',
			activity: { type, id: `${object.id}/activity/${at}`, object: status! },
		})
	}
	const statusOf = async (uri: string) =>
		(await sql<{ id: string }>(h.store, 'SELECT id FROM statuses WHERE uri = ?', uri))[0]?.id
	const card = async (statusId: string | undefined) =>
		(
			await sql<{
				url: string
				due_at: number | null
				attempts: number
				generation: number
				fetched_at: number | null
			}>(
				h.store,
				'SELECT url, due_at, attempts, generation, fetched_at FROM status_cards WHERE status_id = ?',
				statusId ?? ''
			)
		)[0]
	return { h, carol, receive, statusOf, card }
}

describe('link choice', () => {
	it("takes a remote status's first anchor that is not a hashtag's, and refuses an http one without advancing", async () => {
		const { receive, statusOf, card } = await world()
		// fetch_link_card_service_spec.rb, "with a remote status": the anchor without href and the rel=tag one are
		// skipped, and the first left is http://, which Mastodon fetches; the sink fetches https only, so no card.
		const spec = note(`Habt ihr ein paar gute Links zu <a>foo</a>
#<span class="tag"><a href="https://quitter.se/tag/wannacry" rel="tag noopener noreferrer">Wannacry</a></span> herumfliegen?
Ich will mal unter <br> <a href="http://example.com/not-found" rel="noopener noreferrer">http://example.com/not-found</a> was sammeln. !
<a href="https://sn.jonkman.ca/group/416/id" rel="noopener noreferrer">security</a>&nbsp;`)
		await receive(spec)
		expect(await card(await statusOf(spec.id))).toBeUndefined()
		const https = note(spec.content.replace('http://example.com/not-found', 'https://example.com/not-found'))
		await receive(https)
		expect(await card(await statusOf(https.id))).toMatchObject({
			url: 'https://example.com/not-found',
			due_at: NOW,
			attempts: 0,
			fetched_at: null,
		})
	})

	it('skips a microformats class, a non-http(s) anchor and the instance authority, but not another port of it', async () => {
		const { receive, statusOf, card } = await world()
		const skipped = [
			'<a class="u-url mention" href="https://a.example/x">a</a>',
			'<a class="xh-cardx" href="https://b.example/x">b</a>',
			'<a href="mailto:x@example.com">m</a>',
			'<a href="/relative">r</a>',
			'<a href="//other.example/x">no scheme</a>',
			`<a href="${ORIGIN}/@alice">local</a>`,
			`<a href="${ORIGIN}:443/x">default port</a>`,
		].join(' ')
		const first = note(`${skipped} <a href="https://kopje.test:8443/a">port</a> <a href="https://c.example/">c</a>`)
		await receive(first)
		// Mastodon's local_url? compares the host with a non-default port: kopje.test:8443 is not the instance.
		expect(await card(await statusOf(first.id))).toMatchObject({ url: 'https://kopje.test:8443/a' })
		const second = note(`${skipped} <a href="https://c.example/">c</a>`)
		await receive(second)
		expect(await card(await statusOf(second.id))).toMatchObject({ url: 'https://c.example/' })
	})

	it("skips an anchor whose raw href is, by bytes, a mentioned account's URL", async () => {
		const { h, receive, statusOf, card } = await world()
		const dan = await remoteAccount(h.store, 'dan', 'other.example')
		await sql(h.store, "UPDATE accounts SET url = 'https://other.example/@Dan' WHERE id = ?", dan)
		const mention = { type: 'Mention', href: 'https://other.example/users/dan', name: '@dan@other.example' }
		const object = note(
			'<a href="https://other.example/@dan">@dan</a> <a href="https://other.example/@Dan">@Dan</a> <a href="https://d.example/">d</a>',
			{ tag: [mention] }
		)
		await receive(object)
		// Only the exact spelling is the mention's: the lowercased one is a link.
		expect(await card(await statusOf(object.id))).toMatchObject({ url: 'https://other.example/@dan' })
		const exact = note('<a href="https://other.example/@Dan">@Dan</a> <a href="https://d.example/">d</a>', {
			tag: [mention],
		})
		await receive(exact)
		expect(await card(await statusOf(exact.id))).toMatchObject({ url: 'https://d.example/' })
	})

	it('refuses an unparsable or over-long first link, and keeps at most CARD_CANDIDATES anchors', async () => {
		const { receive, statusOf, card } = await world()
		const invalid = note('<a href="https://exa mple.com/">x</a> <a href="https://e.example/">e</a>')
		await receive(invalid)
		expect(await card(await statusOf(invalid.id))).toBeUndefined()
		const long = `https://e.example/${'a'.repeat(CARD_URL_LIMIT)}`
		const over = note(`<a href="${long}">x</a> <a href="https://e.example/">e</a>`)
		await receive(over)
		expect(await card(await statusOf(over.id))).toBeUndefined()
		const tags = Array.from({ length: CARD_CANDIDATES }, (_, i) => `<a href="mailto:${i}@x.example">${i}</a>`).join(' ')
		const late = note(`${tags} <a href="https://e.example/">e</a>`)
		await receive(late)
		expect(await card(await statusOf(late.id))).toBeUndefined()
		const inTime = note(`${tags.split(' ').slice(1).join(' ')} <a href="https://e.example/">e</a>`)
		await receive(inTime)
		expect(await card(await statusOf(inTime.id))).toMatchObject({ url: 'https://e.example/' })
	})

	it("takes a local post's first link that is not the instance's", async () => {
		expect(CARD_URL_LIMIT).toBe(WEB_PAGE_URL_LIMIT)
		const domain = 'kopje.test'
		expect(localCardLink('see https://kopje.test/@bob then https://e.example/a?b#c', domain)).toBe(
			'https://e.example/a?b#c'
		)
		expect(localCardLink('http://e.example/ and https://f.example/', domain)).toBe('http://e.example/')
		expect(localCardLink('https://kopje.test:8443/', domain)).toBe('https://kopje.test:8443/')
		expect(localCardLink('no link, @bob@e.example #tag', domain)).toBeNull()
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'https://kopje.test/@bob https://e.example/x' })
		expect(await sql(h.store, 'SELECT url, due_at FROM status_cards WHERE status_id = ?', status.id)).toEqual([
			{ url: 'https://e.example/x', due_at: NOW },
		])
	})
})

describe('enqueue and reset', () => {
	it('enqueues public and unlisted posts only, and resets on a text edit', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const cardOf = async (id: string) =>
			(
				await sql<{ url: string; generation: number }>(
					h.store,
					'SELECT url, generation FROM status_cards WHERE status_id = ?',
					id
				)
			)[0]
		for (const visibility of ['private', 'direct']) {
			const status = await post(h, alice, { status: 'https://e.example/', visibility })
			expect(await cardOf(status.id), visibility).toBeUndefined()
		}
		const unlisted = await post(h, alice, { status: 'https://e.example/u', visibility: 'unlisted' })
		expect(await cardOf(unlisted.id)).toMatchObject({ url: 'https://e.example/u' })
		const status = await post(h, alice, { status: 'one https://e.example/1' })
		const queued = await cardOf(status.id)
		expect(queued).toMatchObject({ url: 'https://e.example/1' })
		await sql(
			h.store,
			"UPDATE status_cards SET due_at = NULL, fetched_at = 1, title = 't', attempts = 0 WHERE status_id = ?",
			status.id
		)
		const edit = (body: Record<string, unknown>) =>
			h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, json(body, { method: 'PUT' })))
		// No text change: the card stays.
		expect((await edit({ status: 'one https://e.example/1', sensitive: true })).status).toBe(200)
		expect(await sql(h.store, 'SELECT fetched_at FROM status_cards WHERE status_id = ?', status.id)).toEqual([
			{ fetched_at: 1 },
		])
		// A text change keeping the URL fetches again (a declared deviation: no shared cache entry to reuse here).
		expect((await edit({ status: 'two https://e.example/1' })).status).toBe(200)
		const reset = await sql<{ url: string; due_at: number; fetched_at: null; title: string; generation: number }>(
			h.store,
			'SELECT url, due_at, fetched_at, title, generation FROM status_cards WHERE status_id = ?',
			status.id
		)
		expect(reset).toEqual([
			{ url: 'https://e.example/1', due_at: NOW, fetched_at: null, title: '', generation: expect.any(Number) },
		])
		// A text change to no link deletes the row.
		expect((await edit({ status: 'three, no link' })).status).toBe(200)
		expect(await cardOf(status.id)).toBeUndefined()
	})

	it('enqueues no status with a shown attachment or a quote, and one whose media an edit removed', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const media = await sql<{ id: string }>(
			h.store,
			`INSERT INTO media_attachments (id, account_id, type, url, created_at)
			VALUES ('100000000000000777', ?, 'image', 'https://kopje.test/files/m', '2026-10-12T00:00:00.000Z') RETURNING id`,
			alice.id
		)
		const withMedia = await post(h, alice, { status: 'https://e.example/', media_ids: [media[0]!.id] })
		expect(await sql(h.store, 'SELECT * FROM status_cards WHERE status_id = ?', withMedia.id)).toEqual([])
		// The media removed, then the text edited: enqueued (Mastodon's with_media? reads the current attachments).
		const edit = (body: Record<string, unknown>) =>
			h.request(`/api/v1/statuses/${withMedia.id}`, bearer(alice.token, json(body, { method: 'PUT' })))
		expect((await edit({ status: 'https://e.example/', media_ids: [] })).status).toBe(200)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM status_cards')).toEqual([{ n: 0 }])
		expect((await edit({ status: 'now https://e.example/', media_ids: [] })).status).toBe(200)
		expect(await sql(h.store, 'SELECT url FROM status_cards WHERE status_id = ?', withMedia.id)).toEqual([
			{ url: 'https://e.example/' },
		])
		// A quote: no card.
		const quoted = await post(h, alice, { status: 'quoted' })
		const quoting = await post(h, alice, { status: 'q https://e.example/q', quoted_status_id: quoted.id })
		expect(await sql(h.store, 'SELECT * FROM status_cards WHERE status_id = ?', quoting.id)).toEqual([])
	})

	it('enqueues a remote status on creation, resets it on a significant update only, never a private one', async () => {
		const { receive, statusOf, card } = await world()
		const object = note('<p><a href="https://e.example/1">1</a></p>')
		await receive(object)
		const id = await statusOf(object.id)
		const first = await card(id)
		expect(first).toMatchObject({ url: 'https://e.example/1', due_at: NOW })
		await receive(
			{ ...object, updated: '2026-10-11T13:00:00Z', content: '<p><a href="https://e.example/2">2</a></p>' },
			'UpdateStatus',
			NOW + 1
		)
		expect(await card(id)).toMatchObject({ url: 'https://e.example/2', due_at: NOW + 1 })
		// Not significant (the content unchanged): nothing reset.
		await receive(
			{
				...object,
				updated: '2026-10-11T14:00:00Z',
				content: '<p><a href="https://e.example/2">2</a></p>',
				sensitive: true,
			},
			'UpdateStatus',
			NOW + 2
		)
		expect(await card(id)).toMatchObject({ url: 'https://e.example/2', due_at: NOW + 1 })
		for (const [to, cc] of [
			[[`${CAROL}/followers`], []],
			[['https://kopje.test/ap/users/alice'], []],
		]) {
			const hidden = note('<a href="https://e.example/p">p</a>', {
				to,
				cc,
				tag: [{ type: 'Mention', href: 'https://kopje.test/ap/users/alice' }],
			})
			await receive(hidden)
			const stored = await statusOf(hidden.id)
			expect(stored).toBeDefined()
			expect(await card(stored)).toBeUndefined()
		}
	})
})

describe('the hide step of a remote delete', () => {
	// deleteStatusBatch hides a status with three rows left: the status, the account's last status (0021_directory) and
	// its card row; with two left it waits for the next batch.
	it.each([3, 2])('deletes the card with the hide when %i rows are left', async (left) => {
		const { h, carol } = await world()
		const status = await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const id = '100000000000000500'
			db.run(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				VALUES (?, 'https://remote.example/s/500', ?, 'public', 'x', '2026-10-12T00:00:00.000Z')`,
				id,
				carol
			)
			db.run(
				"INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation) VALUES (?, 'https://e.example/', 1, 1, 1)",
				id
			)
			return id
		})
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('6%017d', i), 'https://many.example/users/m' || i, 'm' || i, 'many.example' FROM n`,
			PURGE_BATCH - left
		)
		await sql(
			h.store,
			"INSERT INTO status_mentions (status_id, account_id) SELECT ?, id FROM accounts WHERE id GLOB '6*'",
			status
		)
		const wrote = await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
			const before = changes()
			state.storage.transactionSync(() => deleteStatusBatch(db, status, NOW))
			return changes() - before
		})
		const hidden = await sql<{ visibility: string }>(h.store, 'SELECT visibility FROM statuses WHERE id = ?', status)
		expect(hidden).toEqual([{ visibility: left === 3 ? 'direct' : 'public' }])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM status_cards')).toEqual([{ n: left === 3 ? 0 : 1 }])
		expect(wrote).toBe(left === 3 ? PURGE_BATCH : PURGE_BATCH - 2)
	})
})

// A card at its stored bounds, each text filled with `fill` to its JSON bound (escaped: six JSON bytes a character, the
// rest of the bound in ASCII; astral: four UTF-8 bytes; ascii: one), its URLs printable ASCII at their bounds.
function boundCard(fill: 'escaped' | 'astral' | 'ascii') {
	const text = (bytes: number) =>
		fill === 'escaped'
			? '\u0001'.repeat(Math.floor((bytes - 2) / 6)) + 'a'.repeat((bytes - 2) % 6)
			: fill === 'astral'
				? '\u{1f600}'.repeat(Math.floor((bytes - 2) / 4))
				: 'a'.repeat(bytes - 2)
	const url = (prefix: string, limit = CARD_OPTIONAL_URL_LIMIT) => prefix.padEnd(limit, 'u')
	// The src at its escaped bound: in the escaped fill, as many & as fit (each five bytes escaped).
	const ampersands = Math.floor((CARD_EMBED_SRC_ESCAPED_BYTES - 'https://v.example/?'.length) / 5)
	const src =
		fill === 'escaped'
			? `https://v.example/?${'&'.repeat(ampersands)}`.padEnd(CARD_EMBED_SRC_ESCAPED_BYTES - 4 * ampersands, 'u')
			: url('https://v.example/', CARD_EMBED_SRC_BYTES)
	return {
		card_type: 2,
		width: CARD_DIMENSION_MAX,
		height: CARD_DIMENSION_MAX,
		embed_src: src,
		iframe_width: CARD_DIMENSION_MAX,
		iframe_height: CARD_DIMENSION_MAX,
		url: url('https://card.example/', CARD_URL_LIMIT),
		title: text(CARD_TEXTS.title),
		description: text(CARD_TEXTS.description),
		author_name: text(CARD_TEXTS.author_name),
		author_url: url('https://author.example/'),
		provider_name: text(CARD_TEXTS.provider_name),
		provider_url: url('http://provider.example/'),
		language: 'mn-Mong',
		published_at: '2026-10-12T00:00:00.000Z',
		// 0070_card_images: a stored image of a 64-byte token, a 5 × 5 blurhash, the alt text at its bound.
		image_description: text(CARD_IMAGE_DESCRIPTION_JSON_BYTES),
		image_token: 't'.repeat(CARD_IMAGE_TOKEN_BYTES),
		image_width: CARD_DIMENSION_MAX,
		image_height: CARD_DIMENSION_MAX,
		blurhash: `e${'0'.repeat(BLURHASH_BYTES - 1)}`,
	}
}

// An origin of a 253-byte host (four labels of 63 bytes and one of 1), so a card image's URL is at its bound.
const LONG_ORIGIN = `https://${['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(59), 'e'].join('.')}`

async function attach(store: StoreStub, statusId: string, card: Record<string, string | null>): Promise<void> {
	await sql(
		store,
		`INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, description, author_name, author_url,
			provider_name, provider_url, language, published_at, fetched_at)
		VALUES (?1, ?2, 0, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)
		ON CONFLICT (status_id) DO UPDATE SET url = ?2, due_at = NULL, title = ?3, description = ?4, author_name = ?5,
			author_url = ?6, provider_name = ?7, provider_url = ?8, language = ?9, published_at = ?10, fetched_at = 1`,
		statusId,
		card.url ?? null,
		card.title ?? null,
		card.description ?? '',
		card.author_name ?? '',
		card.author_url ?? '',
		card.provider_name ?? '',
		card.provider_url ?? '',
		card.language ?? null,
		card.published_at ?? null
	)
}

describe('presentation', () => {
	const SHAPE = {
		url: 'https://e.example/a',
		title: 'T',
		description: 'D',
		language: 'ja',
		type: 'link',
		author_name: 'Ann',
		author_url: 'https://e.example/ann',
		provider_name: 'P',
		provider_url: 'https://e.example/',
		html: '',
		width: 0,
		height: 0,
		image: null,
		image_description: '',
		embed_url: '',
		blurhash: null,
		published_at: '2026-10-11T00:00:00.000Z',
		authors: [{ name: 'Ann', url: 'https://e.example/ann', account: null }],
	}
	const stored = {
		url: SHAPE.url,
		title: 'T',
		description: 'D',
		author_name: 'Ann',
		author_url: SHAPE.author_url,
		provider_name: 'P',
		provider_url: SHAPE.provider_url,
		language: 'ja',
		published_at: SHAPE.published_at,
	}

	it("shows a card as Mastodon's PreviewCardSerializer, on the status and its boost's original, not as a quoted status", async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const status = await post(h, alice, { status: 'card https://e.example/a' })
		await attach(h.store, status.id, stored)
		const get = async (id: string, token = alice.token) =>
			(await h.request(`/api/v1/statuses/${id}`, bearer(token))).json<Record<string, unknown>>()
		expect((await get(status.id)).card).toEqual(SHAPE)
		const boost = await (
			await h.request(`/api/v1/statuses/${status.id}/reblog`, bearer(bob.token, { method: 'POST' }))
		).json<{ id: string }>()
		const boosted = await get(boost.id, bob.token)
		expect(boosted.card).toBeNull()
		expect((boosted.reblog as { card: unknown }).card).toEqual(SHAPE)
		const quoting = await post(h, bob, { status: 'quoting', quoted_status_id: status.id })
		const shown = await get(quoting.id, bob.token)
		expect(shown.card).toBeNull()
		// A quoted status shows no card (a declared deviation: Mastodon's ShallowStatusSerializer shows one).
		expect((shown.quote as { quoted_status: { card: unknown } }).quoted_status.card).toBeNull()
		// The timeline shows the same.
		const home = await (
			await h.request('/api/v1/timelines/home', bearer(alice.token))
		).json<{ id: string; card: unknown }[]>()
		expect(home.find((s) => s.id === status.id)?.card).toEqual(SHAPE)
	})

	it('shows no card on a status that is not public or unlisted, even from an imported row (AM8)', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		for (const visibility of ['private', 'direct']) {
			const status = await post(h, alice, { status: `x https://e.example/${visibility}`, visibility })
			await attach(h.store, status.id, stored)
			const shown = await (
				await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token))
			).json<{ card: unknown }>()
			expect(shown.card, visibility).toBeNull()
		}
		const unlisted = await post(h, alice, { status: 'x', visibility: 'unlisted' })
		await attach(h.store, unlisted.id, stored)
		const shown = await (
			await h.request(`/api/v1/statuses/${unlisted.id}`, bearer(alice.token))
		).json<{ card: unknown }>()
		expect(shown.card).toEqual(SHAPE)
	})

	it('builds authors from the presented values: a name alone, or a URL alone (AM21)', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = await post(h, alice, { status: 'x' })
		const card = async () =>
			(
				await (
					await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token))
				).json<{ card: Record<string, unknown> | null }>()
			).card
		await attach(h.store, status.id, { ...stored, author_url: '', provider_url: '' })
		expect(await card()).toMatchObject({
			author_url: '',
			provider_url: '',
			authors: [{ name: 'Ann', url: '', account: null }],
		})
		await attach(h.store, status.id, { ...stored, author_name: ' 　', author_url: '' })
		expect(await card()).toMatchObject({ author_name: ' 　', authors: [] })
		await attach(h.store, status.id, { ...stored, author_name: '' })
		expect(await card()).toMatchObject({ authors: [{ name: '', url: SHAPE.author_url, account: null }] })
		// A blank title is no card.
		await attach(h.store, status.id, { ...stored, title: '　' })
		expect(await card()).toBeNull()
	})

	it('judges every presented text and URL as decoded, then as normalized', () => {
		const bytes = (b: number[]) => new TextDecoder().decode(new Uint8Array(b))
		const title = CARD_TEXTS.title
		expect(presentedCardText('a'.repeat(title - 2), title)).toBe('a'.repeat(title - 2))
		expect(presentedCardText('a'.repeat(title - 1), title)).toBe('')
		const escaped = Math.floor((title - 2) / 6)
		const astral = Math.floor((title - 2) / 4)
		expect(presentedCardText('\u0001'.repeat(escaped), title)).toHaveLength(escaped)
		expect(presentedCardText('\u0001'.repeat(escaped + 1), title)).toBe('')
		expect(presentedCardText('\u{1f600}'.repeat(astral), title)).toHaveLength(2 * astral)
		expect(presentedCardText('\u{1f600}'.repeat(astral + 1), title)).toBe('')
		// Malformed UTF-8 within the raw bytes decodes to U+FFFD, three bytes each: past the bound once decoded.
		expect(presentedCardText(bytes(Array(title - 2).fill(0x80)), title)).toBe('')
		expect(presentedCardText('a\u0000', title)).toBe('')
		expect(presentedCardText('\ud800', title)).toBe('')
		expect(presentedCardText(7, title)).toBe('')
		const url = 'https://e.example/'.padEnd(CARD_URL_LIMIT, 'u')
		expect(presentedCardUrl(url)).toBe(url)
		const optional = 'https://e.example/'.padEnd(CARD_OPTIONAL_URL_LIMIT, 'u')
		expect(presentedCardUrl(optional, CARD_OPTIONAL_URL_LIMIT)).toBe(optional)
		expect(presentedCardUrl(`${optional}u`, CARD_OPTIONAL_URL_LIMIT)).toBeNull()
		expect(presentedCardUrl(`${url}u`)).toBeNull()
		for (const refused of ['\u0000', '\u0085', ' ', ' ', '�', ' ', '"', '<', '\\', '^', '`', '{', '|', '}']) {
			expect(presentedCardUrl(`https://e.example/${refused}`), JSON.stringify(refused)).toBeNull()
		}
		expect(presentedCardUrl('ftp://e.example/')).toBeNull()
		expect(presentedCardUrl(`https://e.example/${bytes([0xe2, 0x82])}`)).toBeNull()
		// Normalization may shorten a URL (dot segments, the default port) or lengthen it (percent-encoding).
		expect(presentedCardUrl('HTTPS://E.EXAMPLE:443/a/./b')).toBe('https://e.example/a/b')
		expect(
			presentedCardUrl(`https://e.example/${"'".repeat(CARD_URL_LIMIT - 'https://e.example/'.length)}`)
		).toHaveLength(CARD_URL_LIMIT)
		// Non-ASCII is not refused as decoded (the triggers refuse it as stored); the normalized form is ASCII.
		expect(presentedCardUrl('https://e.example/?\u00e9')).toBe('https://e.example/?%C3%A9')
	})

	it('reads only text within its raw bounds out of SQLite, whatever the row stores', async () => {
		const h = await community(['alice'])
		const rows = await runInDurableObject(h.store, (_instance, state) =>
			[
				[new TextEncoder().encode('https://e.example/').buffer as ArrayBuffer, 7],
				['x'.repeat(CARD_URL_LIMIT + 1), 'y'.repeat(CARD_TEXTS.title - 1)],
			].map(([url, title]) =>
				state.storage.sql
					.exec(
						`SELECT ${selectSql(CARD_COLUMN_MAP)} FROM (SELECT '1' AS value) j,
							(SELECT ?1 AS url, ?2 AS title, ?2 AS description, ?2 AS author_name, ?1 AS author_url,
								?2 AS provider_name, ?1 AS provider_url, ?2 AS language, ?2 AS published_at, ?1 AS card_type,
								?2 AS width, ?3 AS height, ?1 AS embed_src, ?3 AS iframe_width, -1 AS iframe_height,
								?1 AS image_description) c,
							(SELECT ?2 AS token, ?3 AS width, ?1 AS height, ?1 AS blurhash) i`,
						url!,
						title!,
						CARD_DIMENSION_MAX + 1
					)
					.one()
			)
		)
		expect(rows[0]).toMatchObject({ url: null, title: null, author_url: null, language: null, published_at: null })
		// Each new column as read (0069_card_embeds): a blob, a text, a real (workerd binds every number as one) or an
		// integer out of range is NULL.
		const embed = {
			card_type: null,
			width: null,
			height: null,
			embed_src: null,
			iframe_width: null,
			iframe_height: null,
		}
		expect(rows[0]).toMatchObject(embed)
		expect(rows[1]).toMatchObject(embed)
		// 0070_card_images: the alt text and the stored image's columns, each NULL past its stored bound.
		const image = { image_description: null, image_token: null, image_width: null, image_height: null, blurhash: null }
		expect(rows[0]).toMatchObject(image)
		expect(rows[1]).toMatchObject({ image_description: null, image_token: null, image_width: null, blurhash: null })
		expect(rows[1]).toMatchObject({
			url: null,
			title: null,
			description: 'y'.repeat(CARD_TEXTS.title - 1),
			language: null,
		})
	})

	it('presents a video from its fixed template, a photo without an image, and judges each stored value again', () => {
		const card = { url: 'https://e.example/a', title: 'T' }
		const src = 'https://v.example/e?a=1&b=2'
		expect(
			presentFor({ ...card, card_type: 2, width: 640, height: 360, embed_src: src, iframe_width: 560 })
		).toMatchObject({
			type: 'video',
			width: 640,
			height: 360,
			embed_url: '',
			image: null,
			html: `<iframe src="https://v.example/e?a=1&amp;b=2" width="560" allowfullscreen="true" scrolling="no" frameborder="0" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"></iframe>`,
		})
		expect(presentFor({ ...card, card_type: 1, width: 10, height: 20 })).toMatchObject({
			type: 'photo',
			width: 10,
			height: 20,
			html: '',
			image: null,
		})
		// A video whose src the presenter refuses as decoded is a link without html; a type or dimension that is not
		// read (NULL) is a link and 0.
		for (const embed of [
			null,
			'',
			'javascript:alert(1)',
			'/relative',
			'https://v.example/"',
			`${src}\u0000`,
			'https://v.example/\ufffd',
		]) {
			expect(presentFor({ ...card, card_type: 2, embed_src: embed }), String(embed)).toMatchObject({
				type: 'link',
				html: '',
			})
		}
		expect(presentFor({ ...card, card_type: null, width: null, height: null })).toMatchObject({
			type: 'link',
			width: 0,
			height: 0,
		})
		// The escaped bound: one & more than fits is refused once escaped.
		const most = Math.floor((CARD_EMBED_SRC_ESCAPED_BYTES - 19) / 5)
		expect(presentFor({ ...card, card_type: 2, embed_src: `https://v.example/?${'&'.repeat(most)}` })!.type).toBe(
			'video'
		)
		expect(presentFor({ ...card, card_type: 2, embed_src: `https://v.example/?${'&'.repeat(most + 1)}` })!.type).toBe(
			'link'
		)
	})

	it('presents a stored image on the instance origin with its blurhash, and a link card at its size (0070)', () => {
		const card = { url: 'https://e.example/a', title: 'T' }
		const token = 'k'.repeat(43)
		const stored = { image_token: token, image_width: 743, image_height: 309, blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' }
		expect(presentFor({ ...card, ...stored, width: 1, height: 2, image_description: 'Alt' })).toMatchObject({
			type: 'link',
			image: `https://kopje.test/media/${token}/full.webp`,
			blurhash: stored.blurhash,
			image_description: 'Alt',
			width: 743,
			height: 309,
		})
		// A photo or a video keeps its own size.
		expect(presentFor({ ...card, ...stored, card_type: 1, width: 10, height: 20 })).toMatchObject({
			type: 'photo',
			width: 10,
			height: 20,
			image: `https://kopje.test/media/${token}/full.webp`,
		})
		// No image (pending, gone, or a token or size past its rule): null image and blurhash, the alt text all the same,
		// and the card's own size.
		for (const missing of [
			{ image_token: null },
			{ image_token: 'short' },
			{ image_token: `${'k'.repeat(42)}/` },
			{ image_width: null },
			{ image_height: 0 },
		]) {
			expect(
				presentFor({ ...card, ...stored, ...missing, width: 1, height: 2, image_description: 'Alt' }),
				JSON.stringify(missing)
			).toMatchObject({ image: null, blurhash: null, image_description: 'Alt', width: 1, height: 2 })
		}
		// A blurhash the stored rule refuses is null; an origin that makes the URL too long gives no image.
		expect(presentFor({ ...card, ...stored, blurhash: 'x' })).toMatchObject({ blurhash: null })
		expect(presentFor({ ...card, ...stored }, `https://${'a'.repeat(300)}`)).toMatchObject({
			image: null,
			blurhash: null,
		})
		// The alt text is judged as decoded (presentedCardText).
		for (const refused of ['a\u0000', '\ud800', '"'.repeat(128)]) {
			expect(presentFor({ ...card, image_description: refused })?.image_description).toBe('')
		}
	})

	it('derives CARD_JSON_MAX from the bounds, at or above every fill', () => {
		expect(new URL(LONG_ORIGIN).hostname).toHaveLength(253)
		const full = presentFor(boundCard('ascii'), LONG_ORIGIN)!
		expect(full.image).toHaveLength(CARD_IMAGE_URL_BYTES)
		expect(full.blurhash).toHaveLength(BLURHASH_BYTES)
		expect(full.type).toBe('video')
		const skeleton = jsonBytes(
			JSON.parse(
				JSON.stringify(full, (key, value: unknown) => (typeof value === 'string' && key !== 'type' ? '' : value))
			)
		)
		// The iframe html at its most: the template's constant bytes, the src at its escaped bound and both dimensions,
		// as a JSON string (each of its quotes escaped).
		const html = jsonBytes(cardIframe('s'.repeat(CARD_EMBED_SRC_ESCAPED_BYTES), CARD_DIMENSION_MAX, CARD_DIMENSION_MAX))
		const max =
			skeleton +
			CARD_URL_LIMIT +
			3 * CARD_OPTIONAL_URL_LIMIT +
			(CARD_TEXTS.title - 2) +
			(CARD_TEXTS.description - 2) +
			2 * (CARD_TEXTS.author_name - 2) +
			(CARD_TEXTS.provider_name - 2) +
			CARD_LANGUAGE_BYTES +
			24 +
			(html - 2) +
			CARD_IMAGE_URL_BYTES +
			BLURHASH_BYTES +
			(CARD_IMAGE_DESCRIPTION_JSON_BYTES - 2)
		// An embed's growth over a link card's 8,513: the html, "video" for "link" and two dimensions of five digits for 0.
		const growth = html - 2 + 1 + 2 * (String(CARD_DIMENSION_MAX).length - 1)
		// The fields of 0070_card_images: the image for null, the blurhash for null and the alt text for ''.
		const images =
			CARD_IMAGE_URL_BYTES +
			2 -
			jsonBytes(null) +
			(BLURHASH_BYTES + 2 - jsonBytes(null)) +
			CARD_IMAGE_DESCRIPTION_JSON_BYTES -
			2
		expect({ skeleton, html, growth, images, max, perStatus: max - jsonBytes(null) }).toEqual({
			skeleton: 305,
			html: 733,
			growth: 740,
			images: 646,
			max: CARD_JSON_MAX,
			perStatus: 9_895,
		})
		expect(CARD_JSON_MAX).toBe(8_513 + 740 + 646)
		const measured = (['escaped', 'astral', 'ascii'] as const).map((fill) =>
			jsonBytes(presentFor(boundCard(fill), LONG_ORIGIN))
		)
		expect(measured[0]).toBe(CARD_JSON_MAX)
		for (const bytes of measured) {
			expect(bytes).toBeLessThanOrEqual(CARD_JSON_MAX)
		}
		// The template bound equals the sink's URL bound (stored-bounds.ts repeats it).
		expect(OEMBED_TEMPLATE_BYTES).toBe(WEB_PAGE_URL_LIMIT)
	})
})
