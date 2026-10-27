import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { acceptQuote } from './budget-helpers'
import { BUILD } from './helpers'
import { community, remoteAccount } from './status-helpers'
import { attr, parseHtml, query, text as textOf } from './web-dom'
import { itemBytes, jsonBytes } from '../src/domain/answer-budget'
import { MAX_STATUS_MEDIA } from '../src/domain/status-bounds'
import { MAX_STATUS_EDITS, type StatusEdit } from '../src/domain/statuses'
import { WEB_PAGE_BYTES } from '../src/domain/web-pages/budget'
import { PROFILE_PAGE_SIZE } from '../src/domain/web-pages/profile'
import { REPLIES_PAGE_SIZE, WEB_HISTORY_BYTES } from '../src/domain/web-pages/status'
import { TAG_PAGE_SIZE } from '../src/domain/web-pages/tags'
import {
	ACCOUNT_EMOJIS_BYTES,
	BIO_JSON_BYTES,
	CONTENT_JSON_BYTES,
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
	SPOILER_JSON_BYTES,
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

// The status page's tab: its Replies at their first page.
const REPLIES = { kind: 'replies', cursor: null } as const

// Capped posts on the feeds: more than one answer admits (each post with its quote takes about 0.8 MB of
// WEB_PAGE_BYTES, amendment A11), so the byte budget, not the page size, stops admission.
const CAPPED_POSTS = 4

async function fixture(fill: Fill) {
	const h = await community(['alice'])
	const { alice } = h.users
	const bob = await remoteAccount(h.store, 'bob')
	await maximalAccount(h, alice.id, fill, true)
	await maximalAccount(h, bob, fill, false)
	// Each post quotes a remote post at the same bounds, which the page nests.
	const posts: string[] = []
	for (let i = 0; i < CAPPED_POSTS; i++) {
		const quoted = await maximalStatus(h, bob, fill, true)
		const post = await maximalStatus(h, alice.id, fill, false)
		await acceptQuote(h, post, quoted)
		posts.push(post)
	}
	return { h, posts }
}

// A post of the compact feed: the most markup for the fewest JSON bytes. Empty warning, one emoji reference as its
// content, MAX_STATUS_MEDIA attachments of each played type at short URLs without descriptions (each a player and a
// "No description" marker), and a poll of MAX_REMOTE_OPTIONS one-character choices (each a row, a share and a bar).
async function compactStatus(h: Harness, author: string, remote: boolean): Promise<string> {
	const id = nextId()
	await sql(
		h.store,
		`INSERT INTO statuses (id, uri, url, account_id, visibility, spoiler_text, content, published_at, emojis)
		VALUES (?, ?, ?, ?, 'public', '', '<p>:a:</p>', ?, ?)`,
		id,
		remote ? `https://remote.example/objects/${id}` : `https://kopje.test/ap/o/${id}`,
		remote ? `https://remote.example/@bob/${id}` : null,
		author,
		new Date(NOW - 60_000).toISOString(),
		JSON.stringify([['a', 'https://e.example/a.png']])
	)
	const types = ['video', 'gifv', 'audio', 'video']
	for (let i = 0; i < MAX_STATUS_MEDIA; i++) {
		await sql(
			h.store,
			`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description)
			VALUES (?, ?, ?, ?, ?, ?, ?, '')`,
			nextId(),
			author,
			id,
			i,
			types[i]!,
			`https://m.example/${i}`,
			`https://m.example/p${i}`
		)
	}
	await sql(
		h.store,
		`INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
		VALUES (?, ?, ?, 999999999, 999999999, ?)`,
		id,
		JSON.stringify(Array.from({ length: MAX_REMOTE_OPTIONS }, (_, i) => String.fromCodePoint(0x4e00 + i))),
		JSON.stringify(Array.from({ length: MAX_REMOTE_OPTIONS }, (_, i) => i)),
		new Date(NOW + 86_400_000).toISOString()
	)
	await sql(h.store, "INSERT INTO status_tags (status_id, name, public) VALUES (?, 'walks', 1)", id)
	return id
}

// alice and the remote bob, each named by one emoji reference, and compactPost: a compact post of an author quoting a
// compact remote post of bob's, which the page nests.
async function compactWorld() {
	const h = await community(['alice'])
	const { alice } = h.users
	const bob = await remoteAccount(h.store, 'bob')
	await sql(
		h.store,
		'UPDATE accounts SET display_name = ?, emojis = ? WHERE id IN (?, ?)',
		':a:',
		JSON.stringify([['a', 'https://e.example/a.png']]),
		alice.id,
		bob
	)
	const compactPost = async (author: string, remote: boolean) => {
		const id = await compactStatus(h, author, remote)
		await acceptQuote(h, id, await compactStatus(h, bob, true))
		return id
	}
	return { h, alice, bob, compactPost }
}

// Amendment A10: a page's HTML is at most 5 × its read's JSON + the emoji allowance (332,800 bytes) + 512 KiB, a
// guard on the Worker's memory and the response's size (§13's weight targets for ordinary pages are separate).
const A10 = (json: number) => 5 * json + 332_800 + 512 * KIB

type Measured = {
	path: string
	json: number
	html: number
	images: number
	perField: number
	quotes: number
	bars: number
}

async function measure(h: Harness, path: string, json: unknown): Promise<Measured> {
	return (await measured(h, path, json)).figures
}

// The page's figures with the HTML they were read from, as served and parsed, for a test's own checks.
async function measured(h: Harness, path: string, json: unknown) {
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
	const figures: Measured = {
		path,
		json: jsonBytes(json),
		html: new TextEncoder().encode(html).length,
		images: emoji.length,
		perField,
		quotes: query(doc, 'div', 'quote').length,
		bars: query(doc, 'svg', 'track').length,
	}
	return { figures, html, doc }
}

describe('the pages at the maxima (design §2, §13)', () => {
	for (const fill of ['emoji', 'emoji-escaped', 'escape'] as const) {
		it(`bound the HTML by its read and the emoji allowance, ${fill} fill`, async () => {
			const { h, posts } = await fixture(fill)
			const focal = posts.at(-1)!
			const statusRead = await h.store.webStatusPage(BUILD, {
				handle: 'alice',
				id: focal,
				now: NOW,
				tab: { kind: 'replies', cursor: null },
			})
			const embedRead = await h.store.webStatusPage(BUILD, { handle: 'alice', id: focal, now: NOW, tab: null })
			expect([statusRead.status, embedRead.status]).toEqual(['ok', 'ok'])
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
			// Each feed admitted capped posts until its byte budget (WEB_PAGE_BYTES, amendment A11) stopped it, short of its
			// page size and of the posts seeded, with more to follow.
			for (const [read, size] of [
				[profileRead, PROFILE_PAGE_SIZE],
				[tagRead, TAG_PAGE_SIZE],
			] as const) {
				const shown = read.statuses.length + (read.stub === null ? 0 : 1)
				expect(shown).toBeGreaterThan(0)
				expect(shown).toBeLessThan(Math.min(size, CAPPED_POSTS))
				expect(read.paging.more).toBe(true)
				expect(jsonBytes(read)).toBeLessThanOrEqual(WEB_PAGE_BYTES)
			}
			const pages = [
				await measure(h, `/@alice/${focal}`, statusRead),
				await measure(h, '/@alice', profileRead),
				await measure(h, '/tags/walks', tagRead),
				await measure(h, `/@alice/${focal}/embed`, embedRead),
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
					// The 1.5× figure holds for emoji fills (amendment A10 keeps it as a measurement).
					expect(page.html, page.path).toBeLessThanOrEqual(1.5 * page.json + 512 * KIB)
				} else {
					expect(page.images, page.path).toBe(0)
				}
				// A10, the ceiling every fill holds: 5 × the read's JSON (an ampersand is five HTML bytes), the emoji
				// allowance (332,800 bytes) and 512 KiB for the markup.
				expect(page.html, page.path).toBeLessThanOrEqual(A10(page.json))
				// Every read here is within WEB_PAGE_BYTES (the status page's head too, at about 0.8 MB), so each page is
				// within A10 at WEB_PAGE_BYTES, about 5.8 MiB (amendment A11).
				expect(page.json, page.path).toBeLessThanOrEqual(WEB_PAGE_BYTES)
				expect(page.html, page.path).toBeLessThanOrEqual(A10(WEB_PAGE_BYTES))
			}
		}, 600_000)
	}

	// The status page's other tabs with every part at its stored bound: its Quotes tab, the other capped posts quoting
	// it (each nesting the focal post), and its Boosts and Favourites tabs, accounts at their profile bounds. The head
	// (about 0.8 MB) leaves no room for a capped quote, which is its stub, and room for some of the 12 accounts, which
	// the page budget cuts.
	for (const fill of ['emoji', 'escape'] as const) {
		it(`bound the interaction tabs by A10 and their budget, ${fill} fill`, async () => {
			const { h, posts } = await fixture(fill)
			const focal = posts.at(-1)!
			await sql(
				h.store,
				`UPDATE quotes SET quoted_status_id = ?1, quoted_uri = (SELECT uri FROM statuses WHERE id = ?1),
					quoted_account_id = (SELECT account_id FROM statuses WHERE id = ?1)
				WHERE status_id IN (SELECT value FROM json_each(?2))`,
				focal,
				JSON.stringify(posts.slice(0, -1))
			)
			for (let i = 0; i < 12; i++) {
				const booster = await remoteAccount(h.store, `booster${i}`)
				await maximalAccount(h, booster, fill, false)
				await sql(
					h.store,
					`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
					VALUES (?1, 'https://remote.example/boosts/' || ?1, ?2, ?3, 'public', '', ?4)`,
					nextId(),
					booster,
					focal,
					new Date(NOW).toISOString()
				)
				await sql(h.store, 'INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', booster, focal)
			}
			for (const kind of ['quotes', 'reblogs', 'favourites'] as const) {
				const read = await h.store.webStatusPage(BUILD, {
					handle: 'alice',
					id: focal,
					now: NOW,
					tab: { kind, cursor: null },
				})
				if (read.status !== 'ok' || read.thread === null) {
					throw new Error('a page read failed')
				}
				const { list } = read.thread
				// The guarded branches: a capped quote is stubbed; the accounts are cut by the page budget.
				const shown = 'accounts' in list ? list.accounts.length : list.stub === null ? -1 : 0
				expect([kind, shown > ('accounts' in list ? 0 : -1) && shown < 12]).toEqual([kind, true])
				expect([kind, read.thread.paging.more]).toEqual([kind, true])
				expect(jsonBytes(read), kind).toBeLessThanOrEqual(WEB_PAGE_BYTES)
				const page = await measure(h, `/@alice/${focal}/${kind}`, read)
				console.info(`An interaction tab at the maxima, ${fill} fill: ${JSON.stringify(page)}`)
				expect(page.images, kind).toBeLessThanOrEqual(512)
				expect(page.perField, kind).toBeLessThanOrEqual(64)
				expect(page.html, kind).toBeLessThanOrEqual(A10(page.json))
			}
		}, 600_000)
	}

	// The status page's thread with its caps filled by compact posts (each quoting a compact remote post): more
	// ancestors than the walk visits (40) and more replies than a page shows (20), so the page holds as many of each as
	// its budget admits, in design §2's order.
	it('bound a status page with a full compact thread by A10', async () => {
		const { h, alice, bob, compactPost } = await compactWorld()
		const replyTo = (id: string, parent: string) =>
			sql(
				h.store,
				`UPDATE statuses SET in_reply_to_id = ?2, in_reply_to_uri = (SELECT uri FROM statuses WHERE id = ?2)
				WHERE id = ?1`,
				id,
				parent
			)
		let parent: string | null = null
		for (let i = 0; i < 41; i++) {
			const id = await compactPost(i % 2 === 0 ? alice.id : bob, i % 2 === 1)
			if (parent !== null) {
				await replyTo(id, parent)
			}
			parent = id
		}
		const focal = await compactPost(alice.id, false)
		await replyTo(focal, parent!)
		for (let i = 0; i < REPLIES_PAGE_SIZE + 5; i++) {
			await replyTo(await compactPost(i % 2 === 0 ? alice.id : bob, i % 2 === 1), focal)
		}
		const read = await h.store.webStatusPage(BUILD, {
			handle: 'alice',
			id: focal,
			now: NOW,
			tab: { kind: 'replies', cursor: null },
		})
		if (read.status !== 'ok' || read.thread === null) {
			throw new Error('a page read failed')
		}
		expect(jsonBytes(read)).toBeLessThanOrEqual(WEB_PAGE_BYTES)
		expect(read.thread.ancestors.length).toBeGreaterThan(0)
		expect(read.thread.ancestors.length).toBeLessThanOrEqual(40)
		const replies = read.thread.list.kind === 'replies' ? read.thread.list : null
		expect(replies!.statuses.length + (replies!.stub === null ? 0 : 1)).toBeGreaterThan(0)
		expect(read.thread.paging.more).toBe(true)
		const page = await measure(h, `/@alice/${focal}`, read)
		console.info(
			`A status page with a compact thread: ${JSON.stringify(page)}, ancestors ${read.thread.ancestors.length}, replies ${replies!.statuses.length}`
		)
		expect(page.images).toBeLessThanOrEqual(512)
		expect(page.perField).toBeLessThanOrEqual(64)
		expect(page.html).toBeLessThanOrEqual(A10(page.json))
	}, 600_000)

	it('bound a full compact feed, stopped by its page size, by A10', async () => {
		const { h, alice, compactPost } = await compactWorld()
		// More posts than a page holds, each quoting a compact remote post the page nests.
		for (let i = 0; i < PROFILE_PAGE_SIZE + 5; i++) {
			await compactPost(alice.id, false)
		}
		const profileRead = await h.store.webProfilePage(BUILD, {
			handle: 'alice',
			tab: { kind: 'posts' },
			cursor: null,
			now: NOW,
		})
		const tagRead = await h.store.webTagPage(BUILD, { name: 'walks', cursor: null, now: NOW })
		if (profileRead.status !== 'ok' || tagRead.status !== 'ok') {
			throw new Error('a page read failed')
		}
		// The page size stopped admission: a full page within WEB_PAGE_BYTES, more to follow.
		for (const read of [profileRead, tagRead]) {
			expect(jsonBytes(read)).toBeLessThanOrEqual(WEB_PAGE_BYTES)
			expect(read.statuses).toHaveLength(20)
			expect(read.paging.more).toBe(true)
			expect(read.statuses.every((status) => status.quote !== null && status.poll?.options.length === 100)).toBe(true)
		}
		const pages = [await measure(h, '/@alice', profileRead), await measure(h, '/tags/walks', tagRead)]
		console.info(`A full compact feed: ${JSON.stringify(pages)}`)
		for (const page of pages) {
			// The repeated markup is on the page: 20 nested quotes, and a bar for each of the 100 choices of the 20 posts'
			// and the 20 quotes' polls.
			expect([page.path, page.quotes, page.bars]).toEqual([page.path, 20, 4_000])
			// Each post's and quote's 100 choices are shown with their bars: the repeated markup is on the page.
			expect(page.html, page.path).toBeGreaterThan(page.json)
			expect(page.images, page.path).toBeLessThanOrEqual(512)
			expect(page.html, page.path).toBeLessThanOrEqual(A10(page.json))
		}
	}, 600_000)
})

// `count` recorded versions of the status `id` (status_edits rows, oldest first, a second apart from NOW). 'content':
// only the content, at its bound in the escape fill. 'compact': the most markup for the fewest JSON bytes, as the
// compact feed's posts: one emoji reference as the content, MAX_STATUS_MEDIA videos at short URLs without descriptions
// and MAX_REMOTE_OPTIONS one-character choices. 'all': every part a version presents at its bound at once, its
// text of the character JSON escapes the most (U+0001, six bytes): the content and the warning at their JSON bounds,
// MAX_STATUS_MEDIA attachments with their URLs and descriptions, MAX_REMOTE_OPTIONS choices, the emoji snapshot. The
// first row is written whole and the others copied from it inside SQLite.
async function versions(h: Harness, id: string, count: number, parts: 'content' | 'all' | 'compact'): Promise<void> {
	const all = parts === 'all'
	const compact = parts === 'compact'
	const media = (description: string | null, type: string, url: (i: number, size: string) => string) =>
		Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => ({
			id: String(i),
			type,
			url: url(i, 'full'),
			preview_url: url(i, 'small'),
			description,
			meta: { small: { width: 640, height: 360 } },
		}))
	const first = await sql<{ id: number }>(
		h.store,
		`INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, poll_options, created_at, emojis)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		id,
		all
			? `<p>${C.repeat(Math.floor((CONTENT_JSON_BYTES - 9) / 6))}</p>`
			: compact
				? '<p>:a:</p>'
				: `<p>${'&amp;'.repeat((STATUS_CONTENT_BYTES - 9) / 5)}</p>`,
		all ? C.repeat(Math.floor((SPOILER_JSON_BYTES - 2) / 6)) : '',
		all ? 1 : 0,
		JSON.stringify(
			all
				? media(C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH), 'image', (i, size) =>
						ampersands(`https://media.example/${id}/${i}/${size}`, MEDIA_URL_LIMIT)
					)
				: compact
					? media(null, 'video', (i, size) => `https://m.example/${i}/${size}`)
					: []
		),
		all || compact
			? JSON.stringify(
					Array.from({ length: MAX_REMOTE_OPTIONS }, (_, i) =>
						compact ? String.fromCodePoint(0x4e00 + i) : C.repeat(MAX_REMOTE_OPTION_LENGTH)
					)
				)
			: null,
		new Date(NOW - count * 1000).toISOString(),
		all ? snapshot('escape', STATUS_EMOJIS_BYTES) : compact ? JSON.stringify([['a', 'https://e.example/a.png']]) : null
	)
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
		INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, poll_options, created_at, emojis)
		SELECT e.status_id, e.content, e.spoiler_text, e.sensitive, e.media_json, e.poll_options,
			strftime('%Y-%m-%dT%H:%M:%fZ', e.created_at, '+' || n.i || ' seconds'), e.emojis
		FROM n, status_edits e WHERE e.id = ?1 ORDER BY n.i`,
		first[0]!.id,
		count
	)
	await sql(h.store, 'UPDATE statuses SET edited_at = ? WHERE id = ?', new Date(NOW).toISOString(), id)
}

const C = '\u0001'

// The status's versions as the API's edit history presents them (statusHistory, within ANSWER_BYTES), newest first and
// without their account: the values the page's history must hold whole.
async function apiVersions(h: Harness, id: string): Promise<Omit<StatusEdit, 'account'>[]> {
	const response = await h.request(`/api/v1/statuses/${id}/history`)
	expect(response.status).toBe(200)
	return (await response.json<StatusEdit[]>()).toReversed().map((version) => {
		const { account, ...rest } = version
		expect(account.username).toBe('alice')
		return rest
	})
}

// The page's frame reserves the count of left-out versions at its longest (Number.MAX_SAFE_INTEGER): what a read with
// `leftOut` holds less than its frame did.
const leftOutSlack = (leftOut: number) => String(Number.MAX_SAFE_INTEGER).length - String(leftOut).length

describe('the edit history at the maxima (design §2, step 6; amendments A10, A11)', () => {
	it('admits whole versions newest first within WEB_HISTORY_BYTES and counts the rest', async () => {
		const h = await community(['alice'])
		// A short head, so the share, not the page budget, stops admission: MAX_STATUS_EDITS versions, each with its
		// content at its bound.
		const focal = await maximalStatusHead(h, h.users.alice.id, 'short')
		await versions(h, focal, MAX_STATUS_EDITS, 'content')
		const read = await h.store.webStatusPage(BUILD, { handle: 'alice', id: focal, now: NOW, tab: REPLIES })
		if (read.status !== 'ok' || read.history === null) {
			throw new Error('the status page read failed')
		}
		const { history } = read
		const expected = await apiVersions(h, focal)
		const shown = history.versions.length
		const taken = history.versions.reduce((sum, version) => sum + itemBytes(version), 0)
		// Three whole versions, the newest, fit the share; a fourth would pass it.
		expect(shown).toBe(3)
		expect(history.versions).toEqual(expected.slice(0, shown))
		expect(taken).toBeLessThanOrEqual(WEB_HISTORY_BYTES)
		expect(taken + itemBytes(expected[shown])).toBeGreaterThan(WEB_HISTORY_BYTES)
		expect(history.leftOut).toBe(MAX_STATUS_EDITS - shown)
		expect(jsonBytes(read)).toBeLessThanOrEqual(WEB_PAGE_BYTES)
		const { figures: page, html, doc } = await measured(h, `/@alice/${focal}`, read)
		const dialog = query(doc, 'dialog').filter((d) => attr(d, 'id') === 'history')
		expect(dialog).toHaveLength(1)
		// The oldest shown is not the original, and the notice counts the rest.
		expect(query(dialog[0]!, 'strong').map((label) => textOf(label))).toEqual(['Current', 'Edited', 'Edited'])
		expect(html).toContain(`${MAX_STATUS_EDITS - shown} older versions are not shown.`)
		console.info(`History within its share: ${JSON.stringify({ shown, taken, ...page })}`)
		expect(page.html).toBeLessThanOrEqual(A10(page.json))
	}, 600_000)

	it('leaves out every version past its share: versions with every part at its bound', async () => {
		const h = await community(['alice'])
		const focal = await maximalStatusHead(h, h.users.alice.id, 'short')
		await versions(h, focal, MAX_STATUS_EDITS, 'all')
		const [newest] = await apiVersions(h, focal)
		// The witness: one version at every bound passes the share alone.
		expect(itemBytes(newest)).toBeGreaterThan(WEB_HISTORY_BYTES)
		const read = await h.store.webStatusPage(BUILD, { handle: 'alice', id: focal, now: NOW, tab: REPLIES })
		expect(read.status === 'ok' && read.history).toEqual({ versions: [], leftOut: MAX_STATUS_EDITS })
		const { figures: page, html, doc } = await measured(h, `/@alice/${focal}`, read)
		expect(html).toContain(`${MAX_STATUS_EDITS} older versions are not shown.`)
		expect(query(doc, 'ol')).toHaveLength(0)
		console.info(`History of versions at every bound: ${JSON.stringify({ version: itemBytes(newest), ...page })}`)
		expect(page.json).toBeLessThanOrEqual(WEB_PAGE_BYTES)
		expect(page.html).toBeLessThanOrEqual(A10(page.json))
	}, 600_000)

	it('bounds a full history of compact versions by A10', async () => {
		const h = await community(['alice'])
		const focal = await maximalStatusHead(h, h.users.alice.id, 'short')
		await versions(h, focal, MAX_STATUS_EDITS, 'compact')
		const read = await h.store.webStatusPage(BUILD, { handle: 'alice', id: focal, now: NOW, tab: REPLIES })
		expect(read.status === 'ok' && read.history?.versions.length).toBe(MAX_STATUS_EDITS)
		const { figures: page, doc } = await measured(h, `/@alice/${focal}`, read)
		// Every version's players and choices are on the page.
		expect(query(doc, 'video')).toHaveLength(MAX_STATUS_EDITS * MAX_STATUS_MEDIA)
		expect(query(doc, 'ul', 'opts').flatMap((list) => query(list, 'li'))).toHaveLength(
			MAX_STATUS_EDITS * MAX_REMOTE_OPTIONS
		)
		console.info(`A full history of compact versions: ${JSON.stringify(page)}`)
		expect(page.images).toBeLessThanOrEqual(512)
		expect(page.html).toBeLessThanOrEqual(A10(page.json))
	}, 600_000)

	it('admits no version beside a head past WEB_PAGE_BYTES, and counts them all', async () => {
		const h = await community(['alice'])
		// The head at its bounds with its quote, its poll's choices and its attachments' descriptions then filled with
		// the character JSON escapes the most: the head alone passes the page budget.
		const focal = await maximalStatusHead(h, h.users.alice.id, 'capped')
		await sql(
			h.store,
			'UPDATE polls SET options = ? WHERE status_id = ?',
			JSON.stringify(Array.from({ length: MAX_REMOTE_OPTIONS }, () => C.repeat(MAX_REMOTE_OPTION_LENGTH))),
			focal
		)
		await sql(
			h.store,
			'UPDATE media_attachments SET description = ? WHERE status_id = ?',
			C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
			focal
		)
		// Versions that would fit anywhere else: a full history of compact ones.
		await versions(h, focal, MAX_STATUS_EDITS, 'compact')
		const read = await h.store.webStatusPage(BUILD, { handle: 'alice', id: focal, now: NOW, tab: REPLIES })
		if (read.status !== 'ok') {
			throw new Error('the status page read failed')
		}
		expect(jsonBytes(read.value) + jsonBytes(read.parent)).toBeGreaterThan(WEB_PAGE_BYTES)
		expect(read.history).toEqual({ versions: [], leftOut: MAX_STATUS_EDITS })
		const page = await measure(h, `/@alice/${focal}`, read)
		console.info(`History beside a head past the page budget: ${JSON.stringify(page)}`)
		expect(page.html).toBeLessThanOrEqual(A10(page.json))
	}, 600_000)

	it('takes no more than the page budget leaves beside a head at its bounds (A11)', async () => {
		const h = await community(['alice'])
		// The head at its bounds with its quote nested: less than the share is left of WEB_PAGE_BYTES.
		const focal = await maximalStatusHead(h, h.users.alice.id, 'capped')
		await versions(h, focal, MAX_STATUS_EDITS, 'content')
		const read = await h.store.webStatusPage(BUILD, { handle: 'alice', id: focal, now: NOW, tab: REPLIES })
		if (read.status !== 'ok' || read.history === null) {
			throw new Error('the status page read failed')
		}
		const { history } = read
		const expected = await apiVersions(h, focal)
		const shown = history.versions.length
		const json = jsonBytes(read)
		const taken = history.versions.reduce((sum, version) => sum + itemBytes(version), 0)
		expect(WEB_PAGE_BYTES - (json - taken)).toBeLessThan(WEB_HISTORY_BYTES)
		expect(history.versions).toEqual(expected.slice(0, shown))
		expect(history.leftOut).toBe(MAX_STATUS_EDITS - shown)
		// Within the page budget, and the next version would pass what it left (the frame reserved leftOutSlack more).
		expect(json).toBeLessThanOrEqual(WEB_PAGE_BYTES)
		expect(json + itemBytes(expected[shown]) + leftOutSlack(history.leftOut)).toBeGreaterThan(WEB_PAGE_BYTES)
		const page = await measure(h, `/@alice/${focal}`, read)
		console.info(`History beside a head at its bounds: ${JSON.stringify({ shown, taken, ...page })}`)
		expect(page.html).toBeLessThanOrEqual(A10(page.json))
	}, 600_000)
})

// alice's public status for the history tests: 'short', a one-line post; 'capped', every part at its bound in the
// escape fill with a quote at the same bounds, as the page maxima above.
async function maximalStatusHead(h: Harness, alice: string, head: 'short' | 'capped'): Promise<string> {
	if (head === 'capped') {
		const bob = await remoteAccount(h.store, 'bob')
		await maximalAccount(h, alice, 'escape', true)
		await maximalAccount(h, bob, 'escape', false)
		const quoted = await maximalStatus(h, bob, 'escape', true)
		const focal = await maximalStatus(h, alice, 'escape', false)
		await acceptQuote(h, focal, quoted)
		return focal
	}
	const id = nextId()
	await sql(
		h.store,
		`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		VALUES (?, ?, ?, 'public', '<p>now</p>', ?)`,
		id,
		`https://kopje.test/ap/o/${id}`,
		alice,
		new Date(NOW - 3_600_000).toISOString()
	)
	return id
}
