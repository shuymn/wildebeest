import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { community, post, remoteAccount } from './status-helpers'
import { Db } from '../src/db/sql'
import { deleteStatusBatch, PURGE_BATCH } from '../src/domain/inbox'
import { CARD_CANDIDATES, localCardLink } from '../src/domain/link-cards'
import { parseRemoteStatus } from '../src/federation/remote-status'
import { WEB_PAGE_URL_LIMIT } from '../src/federation/web-page'
import { CARD_URL_LIMIT } from '../src/platform/stored-bounds'

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
