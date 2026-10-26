import { runInDurableObject } from 'cloudflare:test'

import { jsx } from 'hono/jsx'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import { shownFeed, tagFrameBytes, viaRoute, walkFeed as walk } from './profile-page-helpers'
import { type PlannedStatement, plannedSql, scansOf, staleStatistics } from './read-helpers'
import { community, post, remoteAccount, seedStatus, type SeedStatus } from './status-helpers'
import { attr, one, parseHtml, query, text } from './web-dom'
import { Db } from '../src/db/sql'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { pageCursor } from '../src/domain/web-pages/paging'
import type { Site } from '../src/domain/web-pages/site'
import { TAG_PAGE_SIZE, tagPageWithin } from '../src/domain/web-pages/tags'
import { TagPage } from '../src/web/pages/tag'
import { STRINGS } from '../src/web/strings'

// The hashtag page (design §3, §4, §17 PR 4): /tags/:name lists the hashtag's local public posts to an anonymous
// viewer (VIS-4), newest first, paged both ways by status id.

type Harness = Awaited<ReturnType<typeof community>>

const SITE: Site = { domain: 'kopje.test', documents: { privacyPolicy: false, termsOfService: false } }

// A walk of the read within `answerBytes`, rendered as the route renders it; each answer within its budget.
function within(h: Harness, answerBytes: number) {
	return async (path: string) => {
		const url = new URL(path, 'https://kopje.test')
		const name = decodeURIComponent(url.pathname.replace(/^\/tags\//, ''))
		const cursor = pageCursor(url.searchParams.get('max_id'), url.searchParams.get('min_id'))
		const page = await runInDurableObject(h.store, (_instance, state) =>
			tagPageWithin(new Db(state.storage.sql), { name, cursor, now: NOW }, SITE, answerBytes)
		)
		if (page.status !== 'ok') {
			throw new Error(page.status)
		}
		expect(jsonBytes({ ...page, site: SITE })).toBeLessThanOrEqual(answerBytes)
		return String(await jsx(TagPage, { ...page, cursor, site: SITE }).toString())
	}
}

// Seeds statuses in time order, one second apart. A visible one is recorded with its card's link; a hidden one by its
// reason: by its visibility or its server (never a candidate, so no page names it) or by its author's availability (a
// candidate, whose id a pager may name, never a card).
function seeder(h: Harness) {
	let published = NOW - 86_400_000
	const visible: { id: string; href: string }[] = []
	const hidden: string[] = []
	const unavailable: string[] = []
	const add = async (
		status: Omit<SeedStatus, 'published'>,
		shows: { username: string } | 'hidden' | 'unavailable' | 'other'
	) => {
		published += 1000
		const id = await seedStatus(h.store, { ...status, published })
		if (shows === 'hidden') {
			hidden.push(id)
		} else if (shows === 'unavailable') {
			unavailable.push(id)
		} else if (shows !== 'other') {
			visible.push({ id, href: `/@${shows.username}/${id}` })
		}
		return id
	}
	const expected = () => visible.toSorted((a, b) => (a.id < b.id ? 1 : -1)).map((seed) => seed.href)
	return { add, visible, hidden, unavailable, expected }
}

// Visible #cats posts among every kind the page leaves out. The 200 posts of a suspended account in a row are
// candidates the rule hides, longer than a candidate window (streamWindow(20) = 40), so consecutive pages pass empty.
async function world() {
	const h = await community(['alice', 'bob', 'dave'])
	const { alice, bob, dave } = h.users
	const carol = await remoteAccount(h.store, 'carol', 'carol.example')
	const erin = await remoteAccount(h.store, 'erin', 'blocked.example')
	await blockDomain(h.store, 'blocked.example')
	await sql(
		h.store,
		'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
		new Date(NOW).toISOString(),
		dave.id
	)
	const s = seeder(h)
	const privateParent = await s.add(
		{ accountId: bob.id, visibility: 'private', content: '<p>HIDDEN private parent</p>' },
		'hidden'
	)
	let previous: string | null = null
	for (let i = 0; i < 70; i++) {
		const [author, username] = i % 3 === 0 ? [bob, 'bob'] : [alice, 'alice']
		const reply =
			i % 8 === 1 && previous !== null ? { inReplyToId: previous } : i % 9 === 4 ? { inReplyToId: privateParent } : {}
		const id = await s.add(
			{ accountId: author.id, visibility: 'public', tags: ['cats'], content: `<p>shown ${i}</p>`, ...reply },
			{ username }
		)
		if (i % 5 === 0) {
			for (const visibility of ['unlisted', 'private', 'direct', 'limited'] as const) {
				await s.add(
					{ accountId: alice.id, visibility, tags: ['cats'], content: `<p>HIDDEN ${visibility}</p>` },
					'hidden'
				)
			}
		}
		if (i % 6 === 2) {
			for (const remote of [carol, erin]) {
				await s.add(
					{ accountId: remote, visibility: 'public', tags: ['cats'], content: '<p>HIDDEN remote</p>' },
					'hidden'
				)
			}
		}
		if (i % 10 === 3) {
			await s.add({ accountId: bob.id, visibility: 'public', tags: ['dogs'], content: '<p>HIDDEN dogs</p>' }, 'other')
			await s.add({ accountId: bob.id, visibility: 'public', reblogOfId: id, tags: ['cats'] }, 'hidden')
		}
		if (i === 20) {
			for (let j = 0; j < 200; j++) {
				await s.add(
					{ accountId: dave.id, visibility: 'public', tags: ['cats'], content: `<p>HIDDEN suspended ${j}</p>` },
					'unavailable'
				)
			}
		}
		if (i === 30) {
			for (let j = 0; j < 130; j++) {
				await s.add(
					{ accountId: alice.id, visibility: 'private', tags: ['cats'], content: `<p>HIDDEN private ${j}</p>` },
					'hidden'
				)
			}
		}
		previous = id
	}
	// The partners of the replies, as a writer records them.
	await sql(
		h.store,
		`UPDATE statuses SET in_reply_to_account_id = (SELECT p.account_id FROM statuses p WHERE p.id = statuses.in_reply_to_id)
		WHERE in_reply_to_id IS NOT NULL`
	)
	return { h, ...s, privateParent }
}

describe('the hashtag page (design §3, §4)', () => {
	it('walks to both ends in the order seeded, and names nothing hidden', async () => {
		const w = await world()
		const expected = w.expected()
		expect(expected.length).toBeGreaterThan(3 * TAG_PAGE_SIZE)
		const walked = await walk(viaRoute(w.h), '/tags/cats')
		expect(walked.down).toEqual(expected)
		expect(walked.up).toEqual(expected)
		// The 200 posts of the suspended account pass more than one window with nothing shown, and each such page
		// still links on.
		expect(walked.sizes.join(' ')).toMatch(/\b0 0\b/)
		const replyTo = walked.pages.flatMap((html) => shownFeed(html).replyTo)
		// A reply's visible parent is linked; a hidden one is not.
		expect(replyTo.length).toBeGreaterThan(0)
		for (const html of walked.pages) {
			// The whole HTML (meta tags, pager URLs, alt text) names nothing hidden by visibility or server.
			for (const id of w.hidden) {
				expect(html.includes(id) ? id : null).toBeNull()
			}
			expect(html).not.toContain('HIDDEN')
			const cards = query(one(parseHtml(html), 'main'), 'article').map(
				(article) => JSON.stringify(article.attrs) + text(article)
			)
			for (const id of w.unavailable) {
				expect(cards.some((card) => card.includes(id)) ? id : null).toBeNull()
			}
		}
		// The guarded branches ran: the hidden posts are rows of the hashtag, public ones among them.
		const [rows] = (await sql<{ n: number }>(
			w.h.store,
			`SELECT count(*) AS n FROM status_tags WHERE name = 'cats' AND public = 1 AND status_id IN (SELECT value FROM json_each(?))`,
			JSON.stringify([...w.hidden, ...w.unavailable])
		)) as [{ n: number }]
		expect(rows.n).toBeGreaterThan(200)
	}, 300_000)

	it('serves any spelling of a name, its normalized path canonical, and marks a cursor page noindex', async () => {
		const h = await community(['alice'])
		await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public', tags: ['cafe'] })
		await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public', tags: ['自宅サーバー'] })
		const head = async (path: string) => {
			const response = await h.request(path)
			expect([path, response.status]).toEqual([path, 200])
			const doc = parseHtml(await response.text())
			const meta = (name: string) =>
				query(doc, 'meta')
					.filter((m) => attr(m, 'name') === name || attr(m, 'property') === name)
					.map((m) => attr(m, 'content'))
			return {
				h1: text(one(doc, 'h1')),
				title: text(one(doc, 'title')),
				ogTitle: meta('og:title'),
				cards: query(doc, 'article').length,
				robots: meta('robots'),
				ogUrl: meta('og:url'),
				canonical: query(doc, 'link')
					.filter((l) => attr(l, 'rel') === 'canonical')
					.map((l) => attr(l, 'href')),
			}
		}
		const cafe = 'https://kopje.test/tags/cafe'
		for (const path of ['/tags/cafe', '/tags/CAFE', `/tags/${encodeURIComponent('Café')}`]) {
			expect([path, await head(path)]).toEqual([
				path,
				{ h1: 'cafe', title: '#cafe', ogTitle: ['#cafe'], cards: 1, robots: [], ogUrl: [cafe], canonical: [cafe] },
			])
		}
		const jp = `https://kopje.test/tags/${encodeURIComponent('自宅サーバー')}`
		expect(await head(`/tags/${encodeURIComponent('自宅サーバー')}`)).toEqual({
			h1: '自宅サーバー',
			title: '#自宅サーバー',
			ogTitle: ['#自宅サーバー'],
			cards: 1,
			robots: [],
			ogUrl: [jp],
			canonical: [jp],
		})
		for (const cursor of ['?max_id=900000000000000000', '?min_id=1']) {
			expect([cursor, await head(`/tags/CAFE${cursor}`)]).toEqual([
				cursor,
				{
					h1: 'cafe',
					title: '#cafe',
					ogTitle: ['#cafe'],
					cards: 1,
					robots: ['noindex, follow'],
					ogUrl: [cafe],
					canonical: [cafe],
				},
			])
		}
		// An invalid cursor serves the first page.
		expect((await head('/tags/cafe?max_id=x1')).robots).toEqual([])
		// A name at the bound of the hashtags Kopje lists (256 code points) is a page; past it, the same 404 as any
		// other miss (test/web-read-seam.test.ts).
		expect((await head(`/tags/${'a'.repeat(256)}`)).h1).toBe('a'.repeat(256))
		expect((await h.request(`/tags/${'a'.repeat(257)}`)).status).toBe(404)
	})

	// What the page shows of a hashtag whose posts are all hidden: none of them, as for a hashtag never used. With no
	// more hidden candidates than a window, the pages are the same bytes; past a window, its pager may still move on by
	// the id of a public post whose author is unavailable (a candidate, RES-7), and shows nothing else of it.
	it('shows nothing of a hashtag whose posts are all hidden', async () => {
		const h = await community(['alice', 'dave'])
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			h.users.dave.id
		)
		const seeded: string[] = []
		for (const visibility of ['unlisted', 'private', 'direct', 'limited'] as const) {
			seeded.push(await seedStatus(h.store, { accountId: h.users.alice.id, visibility, tags: ['secret'] }))
		}
		seeded.push(await seedStatus(h.store, { accountId: carol, visibility: 'public', tags: ['secret'] }))
		seeded.push(await seedStatus(h.store, { accountId: h.users.dave.id, visibility: 'public', tags: ['secret'] }))
		const [rows] = (await sql<{ n: number }>(
			h.store,
			"SELECT count(*) AS n FROM status_tags WHERE name = 'secret'"
		)) as [{ n: number }]
		expect(rows.n).toBe(seeded.length)
		const secret = await h.request('/tags/secret')
		const nothing = await h.request('/tags/nothing')
		expect([secret.status, nothing.status]).toEqual([200, 200])
		const html = await secret.text()
		expect(html.replaceAll('secret', 'nothing')).toBe(await nothing.text())
		expect(query(one(parseHtml(html), 'main'), 'p', 'empty').map(text)).toEqual([STRINGS.tag.noPosts])
		// 41 public posts of the suspended account fill a window (streamWindow(20) = 40) and pass it: every page shows
		// no post, no text and no name of theirs, and the walk ends.
		for (let i = 0; i < 41; i++) {
			await seedStatus(h.store, {
				accountId: h.users.dave.id,
				visibility: 'public',
				tags: ['secret'],
				content: `<p>HIDDEN suspended ${i}</p>`,
				published: NOW - 1_000_000 + i * 1000,
			})
		}
		const walked = await walk(viaRoute(h), '/tags/secret')
		expect(walked.down).toEqual([])
		expect(walked.up).toEqual([])
		expect(walked.pages.length).toBeGreaterThan(1)
		for (const page of walked.pages) {
			expect(page).not.toContain('HIDDEN')
			expect(page).not.toContain('@dave')
			expect(query(one(parseHtml(page), 'main'), 'article')).toEqual([])
		}
	})

	it('reads the key posting stores for a name that normalizes differently twice', async () => {
		// U+1100 U+0301 U+1161: normalized once (as posting stores the hashtag), U+1100 U+1161; normalized again, U+AC00.
		// The page reads the key of one normalization, so the post is on the page its own text names.
		const h = await community(['alice'])
		const name = '\u1100\u0301\u1161'
		const key = '\u1100\u1161'
		const status = await post(h, h.users.alice, { status: `#${name} hi` })
		expect(await sql(h.store, 'SELECT name FROM status_tags WHERE status_id = ?', String(status.id))).toEqual([
			{ name: key },
		])
		const response = await h.request(`/tags/${encodeURIComponent(name)}`)
		expect(response.status).toBe(200)
		const doc = parseHtml(await response.text())
		expect(query(doc, 'article')).toHaveLength(1)
		expect(
			query(doc, 'link')
				.filter((l) => attr(l, 'rel') === 'canonical')
				.map((l) => attr(l, 'href'))
		).toEqual([`https://kopje.test/tags/${encodeURIComponent(key)}`])
	})
})

// A post of `chars` characters of content.
const sized = (chars: number, label: string) => `<p>${label} ${'x'.repeat(chars)}</p>`

describe('the hashtag page within a page budget (design §2, §4)', () => {
	// A budget that holds about 25 kB beside the frame: small posts (about 2 kB of JSON) fill a page before 20, so pages
	// are cut by bytes, underfilled; large ones (about 30 kB) are stubbed when they come first and end a page when they
	// come later.
	it('walks to both ends through byte cuts and stubs', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const s = seeder(h)
		let previous: string | null = null
		for (let i = 0; i < 60; i++) {
			const large = i % 7 === 3
			const reply = i % 6 === 1 && previous !== null ? { inReplyToId: previous } : {}
			previous = await s.add(
				{
					accountId: alice.id,
					visibility: 'public',
					tags: ['cats'],
					content: sized(large ? 30_000 : 1_000, `alice ${i}`),
					...reply,
				},
				{ username: 'alice' }
			)
		}
		const walked = await walk(within(h, tagFrameBytes('cats', SITE) + 25_000), '/tags/cats')
		expect(walked.down).toEqual(s.expected())
		expect(walked.up).toEqual(s.expected())
		// Cut by bytes: pages that link on with fewer than 20.
		expect(walked.sizes.slice(0, -1).some((size) => size > 0 && size < TAG_PAGE_SIZE)).toBe(true)
		// Stubbed first posts: rows without an author block.
		const stubs = walked.pages.flatMap((html) =>
			query(one(parseHtml(html), 'main'), 'article').filter((article) => query(article, 'div', 'who').length === 0)
		)
		expect(stubs.length).toBeGreaterThan(0)
	}, 300_000)
})

describe('the hashtag page’s reads (RES-7, docs/visibility.md "Read bounds")', () => {
	// The page's statements on status_tags and statuses with statistics taken before the Store grew: the hashtag's
	// stream seeks status_tags_public from the cursor, never scanning either table, and a page below a fixed cursor reads
	// the same rows with 20 or 2,000 newer posts (local and remote, public and private, all with the hashtag) above it.
	it('seeks from the cursor through the public hashtags’ index, with stale statistics', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		let published = NOW - 86_400_000
		const add = (status: Omit<SeedStatus, 'published' | 'tags'>) => {
			published += 1000
			return seedStatus(h.store, { ...status, tags: ['cats'], published })
		}
		const below: string[] = []
		for (let i = 0; i < 2 * TAG_PAGE_SIZE; i++) {
			below.push(await add({ accountId: alice.id, visibility: 'public' }))
		}
		const cursor = { maxId: below.at(-1)! }
		const newer = async (n: number) => {
			for (let i = 0; i < n; i++) {
				await add({ accountId: i % 3 === 2 ? carol : alice.id, visibility: i % 2 === 0 ? 'public' : 'private' })
			}
		}
		await newer(20)
		const capture = async () => {
			const run = await runInDurableObject(h.store, (_instance, state) => {
				const plans: PlannedStatement[] = []
				const page = tagPageWithin(
					new Db(plannedSql(state.storage.sql, /status_tags|FROM (?:main\.)?statuses s\b/, plans)),
					{ name: 'cats', cursor, now: NOW },
					SITE,
					ANSWER_BYTES
				)
				return { plans, page }
			})
			if (run.page.status !== 'ok') {
				throw new Error(run.page.status)
			}
			expect(run.page.statuses.map((status) => status.id)).toEqual(below.slice(0, -1).toReversed().slice(0, 20))
			for (const statement of run.plans) {
				expect(scansOf(statement.plan, ['t', 's', 'st', 'status_tags', 'statuses'])).toEqual([])
			}
			expect(
				run.plans.some((statement) =>
					statement.plan.some((d) => /USING (?:COVERING )?INDEX status_tags_public/.test(d))
				)
			).toBe(true)
			return run.plans.reduce((sum, statement) => sum + statement.rows, 0)
		}
		const { before, after } = await staleStatistics(h, { capture, grow: () => newer(2000) })
		expect(after).toBe(before)
	}, 120_000)
})
