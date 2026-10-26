import { runInDurableObject } from 'cloudflare:test'

import { jsx } from 'hono/jsx'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { bigStatus, C, nextId } from './budget-helpers'
import { blockDomain } from './domain-block-helpers'
import { BUILD } from './helpers'
import { MAX_BIO } from './profile-fixtures'
import { pinStatuses, profileFrameBytes, walkFeed as walk, walkProfile } from './profile-page-helpers'
import { type PlannedStatement, plannedSql, scansOf, staleStatistics } from './read-helpers'
import { community, remoteAccount, seedStatus, type SeedStatus } from './status-helpers'
import { accessibleName, attr, one, parseHtml, query, text } from './web-dom'
import { Db } from '../src/db/sql'
import { PIN_LIMIT } from '../src/domain/activities'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { pageCursor } from '../src/domain/web-pages/paging'
import { PROFILE_PAGE_SIZE, profilePageWithin, type ProfileTab } from '../src/domain/web-pages/profile'
import type { Site } from '../src/domain/web-pages/site'
import { Tabs } from '../src/web/components/basics'
import { ProfilePage } from '../src/web/pages/profile'
import { newestFirstPager } from '../src/web/view/pager'

// The profile's tabs (design §3, §4, §17 PR 3): Posts with boosts (VIS-6) and pins, Posts and replies, Media and a
// featured hashtag's posts, each an anonymous page (VIS-4) paged both ways by status id.

type Harness = Awaited<ReturnType<typeof community>>

type TabName = 'posts' | 'with_replies' | 'media' | 'tagged'

const TABS: Record<TabName, { path: string; tab: ProfileTab }> = {
	posts: { path: '/@alice', tab: { kind: 'posts' } },
	with_replies: { path: '/@alice/with_replies', tab: { kind: 'with_replies' } },
	media: { path: '/@alice/media', tab: { kind: 'media' } },
	tagged: { path: '/@alice/tagged/cats', tab: { kind: 'tagged', tag: 'cats' } },
}

const SITE: Site = { domain: 'kopje.test', documents: { privacyPolicy: false, termsOfService: false } }

// A seeded status as a page shows it: the link of its card (a boost's original's), and the tabs that list it.
type Seed = { id: string; href: string; tabs: TabName[] }

// The page a URL of alice's names, as the route reads it.
function tabOf(url: URL): ProfileTab {
	const rest = url.pathname.replace(/^\/@alice/, '')
	if (rest === '') {
		return { kind: 'posts' }
	}
	if (rest === '/with_replies' || rest === '/media') {
		return { kind: rest.slice(1) as 'with_replies' | 'media' }
	}
	const tagged = /^\/tagged\/(.+)$/.exec(rest)
	if (tagged === null) {
		throw new Error(`no tab at ${url.pathname}`)
	}
	return { kind: 'tagged', tag: decodeURIComponent(tagged[1]!) }
}

// A route walk: each page answers 200.
function viaRoute(h: Harness) {
	return async (url: string) => {
		const response = await h.request(url)
		expect([url, response.status]).toEqual([url, 200])
		return response.text()
	}
}

// A walk of the read within `answerBytes`, rendered as the route renders it; each answer within its budget.
function within(h: Harness, answerBytes: number) {
	return async (path: string) => {
		const url = new URL(path, 'https://kopje.test')
		const tab = tabOf(url)
		const cursor = pageCursor(url.searchParams.get('max_id'), url.searchParams.get('min_id'))
		const page = await runInDurableObject(h.store, (_instance, state) =>
			profilePageWithin(new Db(state.storage.sql), { handle: 'alice', tab, cursor, now: NOW }, SITE, answerBytes)
		)
		if (page.status !== 'ok') {
			throw new Error(page.status)
		}
		expect(jsonBytes({ ...page, site: SITE })).toBeLessThanOrEqual(answerBytes)
		return String(
			await jsx(ProfilePage, {
				account: page.account,
				tab,
				pins: page.pins,
				statuses: page.statuses,
				stub: page.stub,
				parents: page.parents,
				cursor,
				paging: page.paging,
				site: SITE,
				actorUri: 'https://kopje.test/ap/users/alice',
			}).toString()
		)
	}
}

// Seeds statuses in time order, one second apart, and records how each shows.
function seeder(h: Harness) {
	let published = NOW - 86_400_000
	const seeds: Seed[] = []
	// Hidden by their visibility, so never a candidate: no page names them. Hidden only by availability (a boost of an
	// unavailable account's post): a candidate, whose id a pager may name, never a card.
	const hidden: string[] = []
	const unavailable: string[] = []
	const add = async (
		status: Omit<SeedStatus, 'published'>,
		shows: { href?: string; tabs: TabName[] } | 'hidden' | 'unavailable'
	) => {
		published += 1000
		const id = await seedStatus(h.store, { ...status, published })
		if (shows === 'hidden' || shows === 'unavailable') {
			;(shows === 'hidden' ? hidden : unavailable).push(id)
		} else {
			seeds.push({ id, href: shows.href ?? `/@alice/${id}`, tabs: shows.tabs })
		}
		return id
	}
	const expected = (tab: TabName) =>
		seeds
			.filter((seed) => seed.tabs.includes(tab))
			.toSorted((a, b) => (a.id < b.id ? 1 : -1))
			.map((seed) => seed.href)
	return { add, seeds, hidden, unavailable, expected }
}

async function withMedia(h: Harness, author: string, status: string) {
	await sql(
		h.store,
		`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, description)
		VALUES (?, ?, ?, 0, 'image', 'https://kopje.test/m.png', 'a picture')`,
		nextId(),
		author,
		status
	)
}

async function replyOf(h: Harness, reply: string, partner: string) {
	await sql(h.store, 'UPDATE statuses SET in_reply_to_account_id = ? WHERE id = ?', partner, reply)
}

// alice's statuses of every kind a tab lists or leaves out, with hidden ranges longer than a candidate window (60):
// her originals, some with media and some with #cats; self-replies and replies to bob; boosts of public originals of
// bob (local) and carol (remote); boosts of a suspended account's and of a blocked domain's posts, 200 in a row (the
// Posts tab's candidates, so its windows pass empty); 130 private posts in a row, and direct and limited ones; a boost
// of a private original; pins, one of them private.
async function world() {
	const h = await community(['alice', 'bob'])
	const { alice, bob } = h.users
	const carol = await remoteAccount(h.store, 'carol', 'carol.example')
	const dan = await remoteAccount(h.store, 'dan', 'dan.example')
	const erin = await remoteAccount(h.store, 'erin', 'blocked.example')
	await sql(h.store, "UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE id = ?", dan)
	await blockDomain(h.store, 'blocked.example')
	const s = seeder(h)
	const bobsPost = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: NOW - 90_000_000 })
	const bobsPrivate = await seedStatus(h.store, {
		accountId: bob.id,
		visibility: 'private',
		content: '<p>HIDDEN bob private</p>',
		published: NOW - 90_000_000,
	})
	const dansPosts: string[] = []
	for (let i = 0; i < 205; i++) {
		dansPosts.push(
			await seedStatus(h.store, {
				accountId: i % 27 === 0 ? erin : dan,
				visibility: 'public',
				content: `<p>HIDDEN unavailable ${i}</p>`,
				published: NOW - 90_000_000,
			})
		)
	}
	const pinned: string[] = []
	let previous: string | null = null
	for (let i = 0; i < 70; i++) {
		const visibility = i % 2 === 0 ? 'public' : 'unlisted'
		const tags = i % 5 === 0 ? ['cats'] : []
		const media = i % 4 === 0
		const tabs: TabName[] = [
			'posts',
			'with_replies',
			...(media ? (['media'] as const) : []),
			...(tags.length > 0 ? (['tagged'] as const) : []),
		]
		const id = await s.add({ accountId: alice.id, visibility, tags, content: `<p>alice ${i}</p>` }, { tabs })
		if (media) {
			await withMedia(h, alice.id, id)
		}
		if ([3, 27, 51, 63].includes(i)) {
			pinned.push(id)
		}
		if (i % 8 === 1 && previous !== null) {
			const self = await s.add(
				{ accountId: alice.id, visibility: 'public', inReplyToId: previous, tags },
				{ tabs: ['posts', 'with_replies', ...(tags.length > 0 ? (['tagged'] as const) : [])] }
			)
			await replyOf(h, self, alice.id)
			const toBob = await s.add(
				{ accountId: alice.id, visibility: 'public', inReplyToId: bobsPost, tags: ['cats'] },
				{ tabs: ['with_replies', 'media', 'tagged'] }
			)
			await replyOf(h, toBob, bob.id)
			await withMedia(h, alice.id, toBob)
		}
		if (i % 10 === 2) {
			const local = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: NOW - 90_000_000 })
			const remote = await seedStatus(h.store, {
				accountId: carol,
				visibility: 'unlisted',
				published: NOW - 90_000_000,
			})
			await s.add(
				{ accountId: alice.id, visibility: 'public', reblogOfId: local },
				{ href: `/@bob/${local}`, tabs: ['posts'] }
			)
			await s.add(
				{ accountId: alice.id, visibility: 'unlisted', reblogOfId: remote },
				{ href: `https://remote.example/objects/${remote}`, tabs: ['posts'] }
			)
		}
		if (i === 20) {
			for (const original of dansPosts.slice(0, 200)) {
				await s.add({ accountId: alice.id, visibility: 'public', reblogOfId: original }, 'unavailable')
			}
		}
		if (i === 30) {
			for (let j = 0; j < 130; j++) {
				const secret = await s.add(
					{ accountId: alice.id, visibility: 'private', tags: ['cats'], content: `<p>HIDDEN private ${j}</p>` },
					'hidden'
				)
				await withMedia(h, alice.id, secret)
				if (j === 0) {
					pinned.push(secret)
				}
			}
			for (const visibility of ['direct', 'limited'] as const) {
				await s.add(
					{ accountId: alice.id, visibility, tags: ['cats'], content: `<p>HIDDEN ${visibility}</p>` },
					'hidden'
				)
			}
			await s.add({ accountId: alice.id, visibility: 'public', reblogOfId: bobsPrivate }, 'hidden')
			for (const original of dansPosts.slice(200)) {
				await s.add({ accountId: alice.id, visibility: 'public', reblogOfId: original }, 'unavailable')
			}
		}
		previous = id
	}
	// Pins, newest pin first: the order they were pinned in, reversed.
	await pinStatuses(h.store, alice.id, pinned)
	const pins = pinned
		.toReversed()
		.filter((id) => !s.hidden.includes(id))
		.map((id) => `/@alice/${id}`)
	return { h, ...s, pins, hiddenOriginals: [...dansPosts, bobsPrivate] }
}

describe('the profile tabs (design §3, §4)', () => {
	it('walks every tab to both ends, each in the order seeded, past hidden ranges longer than a window', async () => {
		const w = await world()
		expect(w.pins.length).toBeLessThanOrEqual(PIN_LIMIT)
		for (const name of Object.keys(TABS) as TabName[]) {
			const walked = await walk(viaRoute(w.h), TABS[name].path)
			const expected = w.expected(name)
			expect(expected.length, name).toBeGreaterThan(PROFILE_PAGE_SIZE)
			expect([name, walked.down]).toEqual([name, expected])
			expect([name, walked.up]).toEqual([name, expected])
			if (name === 'posts') {
				// The 200 boosts of unavailable accounts' posts pass more than one window (60) with nothing shown, and
				// each such page still links on.
				expect(walked.sizes.join(' ')).toMatch(/\b0 0\b/)
			}
			// Pins on the Posts tab's first page only, and in the list too.
			expect([name, walked.pins]).toEqual([name, name === 'posts' ? w.pins : []])
			for (const pin of walked.pins) {
				expect(expected).toContain(pin)
			}
			// The whole HTML of every page names nothing hidden by visibility, and no card names a boost of an
			// unavailable account's post.
			for (const html of walked.pages) {
				for (const id of [...w.hidden, ...w.hiddenOriginals]) {
					expect(html.includes(id) ? `${name}: ${id}` : null).toBeNull()
				}
				expect(html).not.toContain('HIDDEN')
				const cards = query(one(parseHtml(html), 'main'), 'article').map(
					(article) => JSON.stringify(article.attrs) + text(article)
				)
				for (const id of w.unavailable) {
					expect(cards.some((card) => card.includes(id)) ? `${name}: ${id}` : null).toBeNull()
				}
			}
		}
	}, 300_000)
})

// A post of `chars` characters of content.
const sized = (chars: number, label: string) => `<p>${label} ${'x'.repeat(chars)}</p>`

describe('the profile tabs within a page budget (design §2, §4)', () => {
	// A budget that holds the account and about 25 kB: small posts (about 2 kB of JSON) fill a page before 20, so pages
	// are cut by bytes, underfilled; large ones (about 30 kB) are stubbed when they come first and end a page when they
	// come later. A large boost is stubbed by its original (amendment A2); of three pins, the second does not fit and
	// ends them, strictly.
	it('walks every tab to both ends through byte cuts and stubs, and admits pins strictly', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		const s = seeder(h)
		const pinned: string[] = []
		let previous: string | null = null
		let remoteStub = ''
		for (let i = 0; i < 48; i++) {
			const large = i % 7 === 3
			const media = i % 5 === 0
			const tags = i % 3 === 0 ? ['cats'] : []
			const tabs: TabName[] = [
				'posts',
				'with_replies',
				...(media ? (['media'] as const) : []),
				...(tags.length > 0 ? (['tagged'] as const) : []),
			]
			const content = sized(large ? 30_000 : 1_000, `alice ${i}`)
			const id = await s.add({ accountId: alice.id, visibility: 'public', tags, content }, { tabs })
			if (media) {
				await withMedia(h, alice.id, id)
			}
			if (i === 44 || i === 45 || i === 46) {
				// Pinned newest first: 46, then 45 (large: it ends the pins), then 44.
				pinned.push(id)
			}
			if (i % 6 === 1 && previous !== null) {
				const reply = await s.add(
					{ accountId: alice.id, visibility: 'public', inReplyToId: previous, content: sized(500, 'self') },
					{ tabs: ['posts', 'with_replies'] }
				)
				await replyOf(h, reply, alice.id)
				const parent = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: NOW - 1e8 })
				const other = await s.add(
					{ accountId: alice.id, visibility: 'public', inReplyToId: parent, content: sized(500, 'to bob') },
					{ tabs: ['with_replies'] }
				)
				await replyOf(h, other, bob.id)
			}
			if (i % 8 === 2) {
				const original = await seedStatus(h.store, {
					accountId: carol,
					visibility: 'public',
					content: sized(i % 16 === 2 ? 30_000 : 1_000, 'carol'),
					published: NOW - 1e8,
				})
				const href = `https://remote.example/objects/${original}`
				remoteStub = i % 16 === 2 ? href : remoteStub
				await s.add({ accountId: alice.id, visibility: 'public', reblogOfId: original }, { href, tabs: ['posts'] })
			}
			previous = id
		}
		await pinStatuses(h.store, alice.id, pinned)
		const full = await runInDurableObject(h.store, (_instance, state) =>
			profilePageWithin(
				new Db(state.storage.sql),
				{ handle: 'alice', tab: { kind: 'posts' }, cursor: null, now: NOW },
				SITE,
				ANSWER_BYTES
			)
		)
		if (full.status !== 'ok') {
			throw new Error(full.status)
		}
		const get = within(h, profileFrameBytes(SITE) + jsonBytes(full.account) + 25_000)
		for (const name of Object.keys(TABS) as TabName[]) {
			const walked = await walk(get, TABS[name].path)
			const expected = s.expected(name)
			expect([name, walked.down]).toEqual([name, expected])
			expect([name, walked.up]).toEqual([name, expected])
			// Cut by bytes: pages that link on with fewer than 20.
			expect([name, walked.sizes.slice(0, -1).some((size) => size > 0 && size < PROFILE_PAGE_SIZE)]).toEqual([
				name,
				true,
			])
			// The pins that fit before the one that does not, on the Posts tab's first page.
			expect([name, walked.pins]).toEqual([name, name === 'posts' ? [`/@alice/${pinned[2]!}`] : []])
			const stubs = walked.pages.flatMap((html) =>
				query(one(parseHtml(html), 'main'), 'article')
					.filter((article) => query(article, 'div', 'who').length === 0)
					.map((article) => attr(query(query(article, 'p', 'meta')[0]!, 'a')[0]!, 'href'))
			)
			expect([name, stubs.length > 0]).toEqual([name, true])
			if (name === 'posts') {
				// The large boost is stubbed by its original, on another server (amendment A2).
				expect(stubs).toContain(remoteStub)
			}
		}
	}, 300_000)
})

describe('the profile tabs at large posts (design §2, RES-3)', () => {
	// Inputs at their cap: the account's bio and display name; PIN_LIMIT pins; each post's, pin's and boosted
	// original's content, poll, attachments and emoji (bigStatus, about 0.98 MB of JSON each); every other post a reply
	// to the one before, so pages reserve parent links. Not at its cap: a post's unit maximum (a quote of a quote, the
	// maxima test in status-bounds.test.ts), which no admission figure here depends on.
	it('keeps every real RPC answer within ANSWER_BYTES with pins and boosts, and every walk advances', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		await sql(h.store, 'UPDATE accounts SET note = ?, display_name = ? WHERE id = ?', MAX_BIO, C.repeat(2048), alice.id)
		const ids: string[] = []
		let published = NOW - 3_600_000
		for (let i = 0; i < 14; i++) {
			published += 60_000
			if (i % 4 === 2) {
				const original = await bigStatus(h, carol, published - 30_000)
				ids.push(
					await seedStatus(h.store, { accountId: alice.id, visibility: 'public', reblogOfId: original, published })
				)
				continue
			}
			const reply = i % 2 === 1 && ids.length > 0 ? { inReplyToId: ids.at(-1)! } : {}
			ids.push(await bigStatus(h, alice.id, published, reply))
		}
		await sql(h.store, 'UPDATE statuses SET in_reply_to_account_id = account_id WHERE in_reply_to_id IS NOT NULL')
		const originals = ids.filter((_, i) => i % 4 !== 2)
		const pins = originals.slice(0, PIN_LIMIT)
		await pinStatuses(h.store, alice.id, pins)
		for (const name of ['posts', 'media'] as const) {
			const { seen } = await walkProfile(async (maxId) => {
				const cursor = maxId === null ? null : { maxId }
				const read = await h.store.webProfilePage(BUILD, { handle: 'alice', tab: TABS[name].tab, cursor, now: NOW })
				if (read.status !== 'ok') {
					throw new Error(read.status)
				}
				expect(jsonBytes(read)).toBeLessThanOrEqual(ANSWER_BYTES)
				if (cursor === null) {
					// Every pin fits beside the account (5 of about 0.98 MB), newest pin first.
					expect([name, read.pins.map((pin) => pin.id)]).toEqual([name, name === 'posts' ? pins.toReversed() : []])
				}
				return read
			}, 40)
			expect([name, seen]).toEqual([name, (name === 'posts' ? ids : originals).toReversed()])
		}
	}, 300_000)
})

// alice with exactly two full pages of public posts, oldest first.
async function twoFullPages() {
	const h = await community(['alice'])
	const ids: string[] = []
	for (let i = 0; i < 2 * PROFILE_PAGE_SIZE; i++) {
		const published = NOW - (2 * PROFILE_PAGE_SIZE - i) * 1000
		ids.push(await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public', published }))
	}
	return { h, ids }
}

describe('the profile tabs as pages (design §4, §14)', () => {
	const head = (html: string) => {
		const doc = parseHtml(html)
		const meta = (name: string) =>
			query(doc, 'meta')
				.filter((m) => attr(m, 'name') === name || attr(m, 'property') === name)
				.map((m) => attr(m, 'content'))
		return {
			robots: meta('robots'),
			ogUrl: meta('og:url'),
			canonical: query(doc, 'link')
				.filter((l) => attr(l, 'rel') === 'canonical')
				.map((l) => attr(l, 'href')),
		}
	}

	it('names each tab in a nav of links, the current one aria-current, and none on a hashtag’s', async () => {
		const h = await community(['alice'])
		await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public', tags: ['cats'] })
		const current: Record<TabName, string | null> = {
			posts: '/@alice',
			with_replies: '/@alice/with_replies',
			media: '/@alice/media',
			tagged: null,
		}
		for (const name of Object.keys(TABS) as TabName[]) {
			const doc = parseHtml(await (await h.request(TABS[name].path)).text())
			const nav = one(doc, 'nav', 'tabs')
			expect(accessibleName(nav, doc)).toBe('Profile sections')
			expect(
				query(nav, 'a').map((a) => [attr(a, 'href'), text(a), attr(a, 'aria-current')]),
				name
			).toEqual(
				[
					['/@alice', 'Posts'],
					['/@alice/with_replies', 'Posts and replies'],
					['/@alice/media', 'Media'],
				].map(([href, label]) => [href, label, href === current[name] ? 'page' : null])
			)
		}
		// The component alone: one link a section, the current one marked, and none when no section is current.
		const render = async (items: { href: string; text: string; current: boolean }[]) =>
			parseHtml(String(await jsx(Tabs, { label: 'Sections', items }).toString()))
		const none = await render([
			{ href: '/a', text: 'A', current: false },
			{ href: '/b', text: 'B', current: false },
		])
		expect(query(none, 'a').map((a) => attr(a, 'aria-current'))).toEqual([null, null])
	})

	it('marks a page with a cursor noindex, follow, with its cursor-less URL canonical', async () => {
		const h = await community(['alice'])
		for (let i = 0; i <= PROFILE_PAGE_SIZE; i++) {
			await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public', published: NOW - i * 1000 })
		}
		for (const name of Object.keys(TABS) as TabName[]) {
			const { path } = TABS[name]
			const canonical = `https://kopje.test${path}`
			expect([path, head(await (await h.request(path)).text())]).toEqual([
				path,
				{ robots: [], ogUrl: [canonical], canonical: [canonical] },
			])
			for (const query of ['?max_id=200000000000000000', '?min_id=1']) {
				expect([path + query, head(await (await h.request(path + query)).text())]).toEqual([
					path + query,
					{ robots: ['noindex, follow'], ogUrl: [canonical], canonical: [canonical] },
				])
			}
		}
		// An invalid cursor serves the first page.
		expect(head(await (await h.request('/@alice?max_id=x1')).text()).robots).toEqual([])
	})

	it('shows the empty line only when no page lies either way, and only the pager otherwise', async () => {
		const { h, ids } = await twoFullPages()
		const parts = async (path: string) => {
			const main = one(parseHtml(await (await h.request(path)).text()), 'main')
			return {
				empty: query(main, 'p', 'empty').map(text),
				cards: query(main, 'article').length,
				pager: query(main, 'nav', 'pager').flatMap((nav) =>
					[...query(nav, 'a'), ...query(nav, 'span', 'off')].map((e) => [text(e), attr(e, 'href')])
				),
			}
		}
		// No media: nothing either way.
		expect(await parts('/@alice/media')).toEqual({ empty: ['No posts yet.'], cards: 0, pager: [] })
		// The page past the oldest, reached from a full page: only its pager, back to the posts above it.
		expect(await parts(`/@alice?max_id=${ids[0]!}`)).toEqual({
			empty: [],
			cards: 0,
			pager: [
				['Newer posts', `/@alice?min_id=${(BigInt(ids[0]!) - 1n).toString()}`],
				['Older posts', null],
			],
		})
		// Above the newest: only its pager, to the first page.
		expect(await parts(`/@alice?min_id=${ids.at(-1)!}`)).toEqual({
			empty: [],
			cards: 0,
			pager: [
				['Older posts', '/@alice'],
				['Newer posts', null],
			],
		})
	})

	it('walks back from an empty last page through every page above it', async () => {
		// Exactly two full pages: the second offers an older page, which is empty. Its newer page starts at its own
		// cursor, so walking back passes over nothing (the first page there would skip the second).
		const { h, ids } = await twoFullPages()
		const walked = await walk(viaRoute(h), '/@alice')
		expect(walked.sizes).toEqual([20, 20, 0])
		const expected = ids.toReversed().map((id) => `/@alice/${id}`)
		expect(walked.down).toEqual(expected)
		expect(walked.up).toEqual(expected)
	})
})

describe('the profile tabs at the lowest ids', () => {
	it('walks both ways through statuses imported with ids from 0, and offers no page below 0', async () => {
		// A restored Store may hold ids from 000000000000000000 (the schema allows it): two full pages end at id 0, so
		// an older link there would open an empty page whose newer link could only be the first page, past the second.
		const h = await community(['alice'])
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 39)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT printf('%018d', i), 'https://kopje.test/imported/' || i, ?1, 'public', '2026-01-01T00:00:00.000Z' FROM n`,
			h.users.alice.id
		)
		const expected = Array.from({ length: 40 }, (_, i) => `/@alice/${String(39 - i).padStart(18, '0')}`)
		const walked = await walk(viaRoute(h), '/@alice')
		expect(walked.sizes).toEqual([20, 20])
		expect(walked.down).toEqual(expected)
		expect(walked.up).toEqual(expected)
	})
})

describe('the newest-first pager (design §4)', () => {
	it('links by the read’s ends and its direction, never by how many items it shows', () => {
		const paging = (newest: string | null, oldest: string | null, more: boolean) => ({ newest, oldest, more })
		const cases: [Parameters<typeof newestFirstPager>[1], ReturnType<typeof paging>, string | null, string | null][] = [
			[null, paging('9', '5', true), null, '/p?max_id=5'],
			[null, paging('9', '5', false), null, null],
			[{ maxId: '20' }, paging('9', '5', true), '/p?min_id=9', '/p?max_id=5'],
			[{ maxId: '20' }, paging(null, null, false), '/p?min_id=19', null],
			[{ maxId: '0' }, paging(null, null, false), '/p', null],
			[{ minId: '3' }, paging('9', '5', true), '/p?min_id=9', '/p?max_id=5'],
			[{ minId: '3' }, paging('9', '5', false), null, '/p?max_id=5'],
			[{ minId: '3' }, paging(null, null, false), null, '/p'],
			// Nothing lies below id 0: no older page is offered at it, from either direction.
			[null, paging('9', '0', true), null, null],
			[{ maxId: '20' }, paging('9', '000000000000000000', true), '/p?min_id=9', null],
			[{ minId: '3' }, paging('9', '0', true), '/p?min_id=9', null],
		]
		for (const [cursor, read, newer, older] of cases) {
			expect([cursor, read, newestFirstPager('/p', cursor, read)]).toEqual([cursor, read, { newer, older }])
		}
	})
})

describe('the profile tabs’ reads (RES-7, docs/visibility.md "Read bounds")', () => {
	// Each tab's statements on statuses with statistics taken before the Store grew: the account's window seeks
	// statuses_account (or its originals' index) from the cursor, never scanning statuses, and a page below a fixed
	// cursor reads the same rows with 20 or 2,000 newer posts (of every kind the tabs filter) above it.
	it('seek from the cursor through the account’s index, with stale statistics', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		let published = NOW - 86_400_000
		const add = async (status: Omit<SeedStatus, 'published' | 'accountId'>) => {
			published += 1000
			const id = await seedStatus(h.store, { accountId: alice.id, ...status, published })
			if (status.visibility === 'public' && status.reblogOfId === undefined) {
				await withMedia(h, alice.id, id)
			}
			return id
		}
		const below: string[] = []
		for (let i = 0; i < 2 * PROFILE_PAGE_SIZE; i++) {
			below.push(await add({ visibility: 'public', tags: ['cats'] }))
		}
		const cursor = { maxId: below.at(-1)! }
		const newer = async (n: number) => {
			for (let i = 0; i < n; i++) {
				await add({ visibility: i % 2 === 0 ? 'public' : 'private', tags: ['cats'] })
			}
		}
		await newer(20)
		const capture = async () => {
			const rows: Record<string, number> = {}
			for (const name of Object.keys(TABS) as TabName[]) {
				const run = await runInDurableObject(h.store, (_instance, state) => {
					const plans: PlannedStatement[] = []
					const page = profilePageWithin(
						new Db(plannedSql(state.storage.sql, /FROM (?:main\.)?statuses s\b|status_pins/, plans)),
						{ handle: 'alice', tab: TABS[name].tab, cursor, now: NOW },
						SITE,
						ANSWER_BYTES
					)
					return { plans, page }
				})
				expect(run.page.status).toBe('ok')
				for (const statement of run.plans) {
					expect([name, scansOf(statement.plan, ['s', 'statuses'])]).toEqual([name, []])
				}
				expect([
					name,
					run.plans.some((statement) =>
						statement.plan.some((d) => /USING (?:COVERING )?INDEX statuses_account/.test(d))
					),
				]).toEqual([name, true])
				rows[name] = run.plans.reduce((sum, statement) => sum + statement.rows, 0)
			}
			return rows
		}
		const { before, after } = await staleStatistics(h, { capture, grow: () => newer(2000) })
		for (const name of Object.keys(TABS)) {
			expect([name, after[name]]).toEqual([name, before[name]])
		}
	}, 120_000)
})
