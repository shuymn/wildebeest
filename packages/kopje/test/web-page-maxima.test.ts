import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { acceptQuote } from './budget-helpers'
import { BUILD } from './helpers'
import { community, remoteAccount } from './status-helpers'
import { attr, parseHtml, query } from './web-dom'
import { jsonBytes } from '../src/domain/answer-budget'
import { MAX_STATUS_MEDIA } from '../src/domain/status-bounds'
import {
	ACCOUNT_EMOJIS_BYTES,
	BIO_JSON_BYTES,
	DISPLAY_NAME_LIMIT,
	EMOJI_ENTRY_BYTES,
	EMOJI_URL_LIMIT,
	MAX_FIELD_NAME,
	MAX_FIELD_VALUE,
	MAX_FIELDS,
	MAX_MEDIA_DESCRIPTION_LENGTH,
	MAX_REMOTE_OPTION_LENGTH,
	MAX_EMOJIS,
	MAX_REMOTE_OPTIONS,
	MEDIA_URL_LIMIT,
	STATUS_EMOJIS_BYTES,
} from '../src/platform/stored-bounds'
import { SPOILER_BYTES, STATUS_CONTENT_BYTES } from '../src/security/html'
import { EMOJI_FIELD_IMAGES, EMOJI_PAGE_BYTES, EMOJI_PAGE_IMAGES, emojiHtml } from '../src/web/view/emoji'

// The rendered pages at the maxima (design §2 "Emoji allowance", §13 "CI budgets"): the status page and the feeds with
// every part a page renders at its stored bound at once, in three fills. `emoji`: every text that can hold emoji is
// references to the field's own emoji, as many as its bound holds, with short emoji URLs, so each field and the page
// reach their image counts; `emoji-escaped`: the same with emoji URLs of EMOJI_URL_LIMIT bytes of ampersands
// (amendment A5), so the page reaches its allowance's bytes; `escape`: every rendered text is ampersands, the
// character HTML escapes the most against its JSON (five bytes for one). In each, the attachments' URLs
// (MEDIA_URL_LIMIT) are ampersands after their prefix, the emoji snapshots hold as many entries as their bounds
// allow, and the parts no page renders (mentions, hashtags past one, cards) are left empty, so the JSON holds nothing
// the HTML does not show.

type Fill = 'emoji' | 'emoji-escaped' | 'escape'

const KIB = 1024

let sequence = 800_000_000_000_000_000n
const nextId = () => String(sequence++)

// `length` code units of `fill`: references to the emoji `a` (three code units each, none past the length) or
// ampersands.
function text(fill: Fill, length: number): string {
	return fill === 'escape' ? '&'.repeat(length) : ':a:'.repeat(Math.floor(length / 3))
}

// A URL of exactly `bytes` bytes: the prefix, then a query of ampersands (which normalization keeps, and HTML escapes
// to five bytes each).
const ampersands = (prefix: string, bytes: number) => `${prefix}?`.padEnd(bytes, '&')

// The emoji `a` (an account's and a status's alike) at the fill's URL.
const emojiUrl = (fill: Fill) =>
	fill === 'emoji' ? 'https://emoji.example/0.png' : ampersands('https://emoji.example/0', EMOJI_URL_LIMIT)

// As many emoji as a snapshot of `bytes` holds (presented bytes 1 + Σ(EMOJI_ENTRY_BYTES + n + 2·url), at most
// MAX_EMOJIS), each at the fill's URL: names a, b, c, …, then two-letter names.
function snapshot(fill: Fill, bytes: number): string {
	const url = emojiUrl(fill)
	const pairs: [string, string][] = []
	let size = 1
	for (let i = 0; pairs.length < MAX_EMOJIS; i++) {
		const name =
			i < 26
				? String.fromCharCode(97 + i)
				: `${String.fromCharCode(97 + Math.floor(i / 26) - 1)}${String.fromCharCode(97 + (i % 26))}`
		size += EMOJI_ENTRY_BYTES + name.length + 2 * url.length
		if (size > bytes) {
			break
		}
		pairs.push([name, url])
	}
	return JSON.stringify(pairs)
}

type Harness = Awaited<ReturnType<typeof community>>

// The account `id` with its name, bio, fields and emoji at their bounds.
async function maximalAccount(h: Harness, id: string, fill: Fill, local: boolean): Promise<void> {
	await sql(
		h.store,
		'UPDATE accounts SET display_name = ?, note = ?, emojis = ? WHERE id = ?',
		text(fill, DISPLAY_NAME_LIMIT),
		`<p>${fill === 'emoji' ? text(fill, BIO_JSON_BYTES - 9) : '&amp;'.repeat((BIO_JSON_BYTES - 9) / 5)}</p>`,
		snapshot(fill, ACCOUNT_EMOJIS_BYTES),
		id
	)
	if (local) {
		await sql(
			h.store,
			'UPDATE local_accounts SET fields = ? WHERE account_id = ?',
			JSON.stringify(
				Array.from({ length: MAX_FIELDS }, () => ({
					name: text(fill, MAX_FIELD_NAME),
					value: text(fill, MAX_FIELD_VALUE),
				}))
			),
			id
		)
	}
}

// A public status of `author` with its warning, content, attachments, poll and emoji at their bounds, carrying the
// hashtag `walks`.
async function maximalStatus(h: Harness, author: string, fill: Fill, remote: boolean): Promise<string> {
	const id = nextId()
	await sql(
		h.store,
		`INSERT INTO statuses (id, uri, url, account_id, visibility, spoiler_text, content, published_at, emojis)
		VALUES (?, ?, ?, ?, 'public', ?, ?, ?, ?)`,
		id,
		remote ? `https://remote.example/objects/${id}` : `https://kopje.test/ap/o/${id}`,
		remote ? `https://remote.example/@bob/${id}` : null,
		author,
		text(fill, SPOILER_BYTES - 2),
		`<p>${fill === 'emoji' ? text(fill, STATUS_CONTENT_BYTES - 9) : '&amp;'.repeat((STATUS_CONTENT_BYTES - 9) / 5)}</p>`,
		new Date(NOW - 60_000).toISOString(),
		snapshot(fill, STATUS_EMOJIS_BYTES)
	)
	const types = ['video', 'gifv', 'image', 'audio']
	for (let i = 0; i < MAX_STATUS_MEDIA; i++) {
		await sql(
			h.store,
			`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description, meta)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			nextId(),
			author,
			id,
			i,
			types[i % types.length]!,
			ampersands(`https://media.example/${id}/${i}/full`, MEDIA_URL_LIMIT),
			ampersands(`https://media.example/${id}/${i}/small`, MEDIA_URL_LIMIT),
			'&'.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
			JSON.stringify({ small: { width: 640, height: 360 } })
		)
	}
	await sql(
		h.store,
		`INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
		VALUES (?, ?, ?, 999999999, 999999999, ?)`,
		id,
		JSON.stringify(Array.from({ length: MAX_REMOTE_OPTIONS }, () => text(fill, MAX_REMOTE_OPTION_LENGTH))),
		JSON.stringify(Array.from({ length: MAX_REMOTE_OPTIONS }, () => 9_999_999)),
		new Date(NOW + 86_400_000).toISOString()
	)
	await sql(h.store, "INSERT INTO status_tags (status_id, name, public) VALUES (?, 'walks', 1)", id)
	return id
}

async function fixture(fill: Fill) {
	const h = await community(['alice'])
	const { alice } = h.users
	const bob = await remoteAccount(h.store, 'bob')
	await maximalAccount(h, alice.id, fill, true)
	await maximalAccount(h, bob, fill, false)
	// Each post quotes a remote post at the same bounds, which the page nests.
	const posts: string[] = []
	for (let i = 0; i < 3; i++) {
		const quoted = await maximalStatus(h, bob, fill, true)
		const post = await maximalStatus(h, alice.id, fill, false)
		await acceptQuote(h, post, quoted)
		posts.push(post)
	}
	return { h, posts }
}

type Measured = { path: string; json: number; html: number; images: number; perField: number }

async function measure(h: Harness, path: string, json: unknown): Promise<Measured> {
	const response = await h.request(path)
	expect(response.status, path).toBe(200)
	const html = await response.text()
	const doc = parseHtml(html)
	const emoji = query(doc, 'img').filter((img) => attr(img, 'class') === 'emoji')
	// The most images one rendered field holds: the emoji of each field's element (names, warnings, bodies, choices).
	const fields = [
		...query(doc, 'div', 'body'),
		...query(doc, 'span', 'spoiler'),
		...query(doc, 'ul', 'opts').flatMap((list) => query(list, 'li')),
		...query(doc, 'dt'),
		...query(doc, 'dd'),
		...query(doc, 'h1'),
		...query(doc, 'a', 'name'),
	]
	const perField = Math.max(
		0,
		...fields.map((f) => query(f, 'img').filter((img) => attr(img, 'class') === 'emoji').length)
	)
	return { path, json: jsonBytes(json), html: new TextEncoder().encode(html).length, images: emoji.length, perField }
}

describe('the pages at the maxima (design §2, §13)', () => {
	for (const fill of ['emoji', 'emoji-escaped', 'escape'] as const) {
		it(`bound the HTML by its read and the emoji allowance, ${fill} fill`, async () => {
			const { h, posts } = await fixture(fill)
			const focal = posts.at(-1)!
			const statusRead = await h.store.webStatusPage(BUILD, { handle: 'alice', id: focal, now: NOW })
			expect(statusRead.status).toBe('ok')
			const profileRead = await h.store.webProfilePage(BUILD, {
				handle: 'alice',
				tab: { kind: 'posts' },
				cursor: null,
				now: NOW,
			})
			const tagRead = await h.store.webTagPage(BUILD, { name: 'walks', cursor: null, now: NOW })
			if (profileRead.status !== 'ok' || tagRead.status !== 'ok' || statusRead.status !== 'ok') {
				throw new Error('a page read failed')
			}
			// The reads hold what the bound is about: the quote nested, its poll at MAX_REMOTE_OPTIONS choices, and feeds
			// of posts at their bounds (each page as many as its answer budget admits).
			expect(statusRead.value.quote).toMatchObject({ state: 'accepted' })
			expect(statusRead.value.poll?.options).toHaveLength(MAX_REMOTE_OPTIONS)
			expect(statusRead.value.media_attachments).toHaveLength(MAX_STATUS_MEDIA)
			expect(profileRead.statuses.length + (profileRead.stub === null ? 0 : 1)).toBeGreaterThan(0)
			expect(tagRead.statuses.length).toBeGreaterThan(0)
			const pages = [
				await measure(h, `/@alice/${focal}`, statusRead),
				await measure(h, '/@alice', profileRead),
				await measure(h, '/tags/walks', tagRead),
				await measure(h, `/@alice/${focal}/embed`, statusRead),
			]
			console.info(`Pages at the maxima, ${fill} fill: ${JSON.stringify(pages)}`)
			for (const page of pages) {
				// At most 512 images a page and 64 a field (design §2).
				expect(page.images, page.path).toBeLessThanOrEqual(512)
				expect(page.perField, page.path).toBeLessThanOrEqual(64)
				if (fill !== 'escape') {
					// Every field offers more references than the allowance: the page reaches it, by count or by bytes.
					const each = emojiHtml({ shortcode: 'a', url: emojiUrl(fill) }).length
					expect(page.images, page.path).toBe(Math.min(EMOJI_PAGE_IMAGES, Math.floor(EMOJI_PAGE_BYTES / each)))
					expect(page.perField, page.path).toBe(EMOJI_FIELD_IMAGES)
					// The design's ceiling (§2).
					expect(page.html, page.path).toBeLessThanOrEqual(1.5 * page.json + 512 * KIB)
				} else {
					expect(page.images, page.path).toBe(0)
				}
				// The ceiling every fill holds: no rendered byte of the read grows past five as HTML (an ampersand), plus the
				// emoji allowance and a fixed share for the markup.
				expect(page.html, page.path).toBeLessThanOrEqual(5 * page.json + EMOJI_PAGE_BYTES + 512 * KIB)
			}
		}, 300_000)
	}
})
