import { runInDurableObject } from 'cloudflare:test'

import { jsx } from 'hono/jsx'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import { cardLink, cursorOf, cursorsOf, expectCursors, pagerLinks, viaRoute, walkPages } from './profile-page-helpers'
import { type PlannedStatement, plannedSql, scansOf, staleStatistics } from './read-helpers'
import { community, remoteAccount, seedStatus, type SeedStatus } from './status-helpers'
import { attr, one, parseHtml, query, text } from './web-dom'
import { render, SITE } from './web-fixtures'
import { Db } from '../src/db/sql'
import { jsonBytes } from '../src/domain/answer-budget'
import { LONGEST_STATUS_STUB, WEB_PAGE_BYTES } from '../src/domain/web-pages/budget'
import { LONGEST_PAGING } from '../src/domain/web-pages/paging'
import type { Site } from '../src/domain/web-pages/site'
import { REPLIES_PAGE_SIZE, statusPageWithin, WEB_HISTORY_BYTES } from '../src/domain/web-pages/status'
import { StatusPage } from '../src/web/pages/status'
import { STRINGS } from '../src/web/strings'
import { repliesPager } from '../src/web/view/pager'

// A status page's thread (design §2, §3, §4, §17 PR 8): its ancestors above it (ThreadUp), nearest 40 an anonymous
// viewer may see, oldest first; its direct replies an anonymous viewer may see below it, oldest first, 20 a page,
// paged both ways by status id ("Earlier replies" by max_id, "Later replies" by min_id).

type Harness = Awaited<ReturnType<typeof community>>

const TEXTS = { newer: STRINGS.pager.earlierReplies, older: STRINGS.pager.laterReplies }

// What a status page shows of its thread: its ancestors' links, oldest first; its replies' links (each card's, or a
// stub's), oldest first; its pager's links (`newer` earlier replies, `older` later ones, as walkPages follows them);
// and every cursor any link of the page names.
function shownThread(html: string) {
	const main = one(parseHtml(html), 'main')
	const up = query(main, 'ol', 'thread')[0]
	const list = query(main, 'ul', 'feed')[0]
	return {
		ancestors: up === undefined ? [] : query(up, 'article').map(cardLink),
		items: list === undefined ? [] : query(list, 'article').map(cardLink),
		...pagerLinks(main, TEXTS),
		cursors: cursorsOf(main),
		empty: query(main, 'p', 'muted').map(text),
	}
}

// Seeds statuses in time order, one second apart from `start` (after any status the harness wrote, so ids follow
// their time and lie apart). A shown one is recorded with its card's link; a hidden one by its reason: by its
// visibility, or as no reply of the page's status (never a candidate, so no page names its id), or by its author's
// availability (a public or unlisted candidate, whose id a pager may name, never a card); 'none' records nothing (the
// page's own status).
function seeder(h: Harness, start = NOW) {
	let published = start
	const shown: { id: string; href: string }[] = []
	const hidden: string[] = []
	const unavailable: string[] = []
	const add = async (
		status: Omit<SeedStatus, 'published'>,
		shows: 'local' | 'remote' | 'hidden' | 'unavailable' | 'none'
	) => {
		published += 1000
		const id = await seedStatus(h.store, { ...status, published })
		if (shows === 'none') {
			return id
		}
		if (shows === 'hidden') {
			hidden.push(id)
		} else if (shows === 'unavailable') {
			unavailable.push(id)
		} else {
			const [{ username }] = (await sql<{ username: string }>(
				h.store,
				'SELECT username FROM accounts WHERE id = ?',
				status.accountId
			)) as [{ username: string }]
			shown.push({
				id,
				href: shows === 'local' ? `/@${username}/${id}` : `https://remote.example/objects/${id}`,
			})
		}
		return id
	}
	const oldestFirst = () => shown.toSorted((a, b) => (a.id < b.id ? -1 : 1)).map((seed) => seed.href)
	return { add, shown, hidden, unavailable, oldestFirst }
}

// alice, bob and carol (remote) post; dave is suspended and erin's server is blocked.
async function people() {
	const h = await community(['alice', 'bob', 'dave'])
	const carol = await remoteAccount(h.store, 'carol', 'carol.example')
	const erin = await remoteAccount(h.store, 'erin', 'blocked.example')
	await blockDomain(h.store, 'blocked.example')
	await sql(
		h.store,
		'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
		new Date(NOW).toISOString(),
		h.users.dave.id
	)
	return { h, ...h.users, carol, erin }
}

// The partners of the replies, as a writer records them.
async function partners(h: Harness) {
	await sql(
		h.store,
		`UPDATE statuses SET in_reply_to_account_id = (SELECT p.account_id FROM statuses p WHERE p.id = statuses.in_reply_to_id)
		WHERE in_reply_to_id IS NOT NULL`
	)
}

describe('a status page’s replies (design §2, §4)', () => {
	// Visible replies (local public and unlisted, remote public) among every kind the tab leaves out: private, direct
	// and limited replies (never candidates), replies of a suspended account and of a blocked server (candidates the
	// rule hides), 130 private replies in a row and 200 of the suspended account in a row (more than a window,
	// readWindow(20) = 60, so pages pass empty), replies to other statuses and statuses that reply to nothing.
	it('walks to both ends in the order seeded, and names nothing hidden', async () => {
		const { h, alice, bob, dave, carol, erin } = await people()
		const s = seeder(h)
		const focal = await s.add({ accountId: alice.id, visibility: 'public', content: '<p>the focal post</p>' }, 'none')
		const other = await s.add({ accountId: bob.id, visibility: 'public' }, 'none')
		for (let i = 0; i < 70; i++) {
			const [author, shows] =
				i % 5 === 2 ? [carol, 'remote' as const] : [i % 2 === 0 ? alice.id : bob.id, 'local' as const]
			await s.add(
				{
					accountId: author,
					visibility: i % 3 === 1 ? 'unlisted' : 'public',
					inReplyToId: focal,
					content: `<p>reply ${i}</p>`,
				},
				shows
			)
			if (i % 6 === 0) {
				for (const visibility of ['private', 'direct', 'limited'] as const) {
					await s.add(
						{ accountId: bob.id, visibility, inReplyToId: focal, content: `<p>HIDDEN ${visibility}</p>` },
						'hidden'
					)
				}
				await s.add(
					{ accountId: erin, visibility: 'public', inReplyToId: focal, content: '<p>BLOCKED</p>' },
					'unavailable'
				)
				await s.add({ accountId: alice.id, visibility: 'public', inReplyToId: other }, 'hidden')
				await s.add({ accountId: alice.id, visibility: 'public' }, 'hidden')
			}
			if (i === 20) {
				for (let j = 0; j < 200; j++) {
					await s.add(
						{ accountId: dave.id, visibility: 'public', inReplyToId: focal, content: `<p>SUSPENDED ${j}</p>` },
						'unavailable'
					)
				}
			}
			if (i === 40) {
				for (let j = 0; j < 130; j++) {
					await s.add(
						{ accountId: alice.id, visibility: 'private', inReplyToId: focal, content: `<p>HIDDEN private ${j}</p>` },
						'hidden'
					)
				}
			}
		}
		await partners(h)
		const expected = s.oldestFirst()
		expect(expected.length).toBeGreaterThan(3 * REPLIES_PAGE_SIZE)
		// Every cursor a page names is a public or unlisted reply's id (a candidate: shown, or hidden by its author's
		// availability), or a boundary one step from the page's own cursor (pager.ts); never a hidden reply's.
		const candidates = new Set([...s.shown.map((seed) => seed.id), ...s.unavailable])
		const walked = await walkPages(viaRoute(h), `/@alice/${focal}`, shownThread, (url, page) => {
			expectCursors(url, page.cursors, candidates)
			expect(page.ancestors).toEqual([])
		})
		expect(walked.down).toEqual(expected)
		expect(walked.up).toEqual(expected)
		// The 200 replies of the suspended account pass more than one window with nothing shown, and each such page
		// still links on.
		expect(walked.sizes.join(' ')).toMatch(/\b0 0\b/)
		for (const html of walked.pages) {
			// The whole HTML (meta tags, pager URLs, cards) names nothing hidden by visibility, and no reply to another
			// status.
			for (const id of s.hidden) {
				expect(html.includes(id) ? id : null).toBeNull()
			}
			expect(html).not.toContain('HIDDEN')
			// A candidate hidden by its author's availability shows nothing but, at most, a cursor.
			expect(html).not.toContain('SUSPENDED')
			expect(html).not.toContain('BLOCKED')
			expect(html).not.toContain('@dave')
			expect(html).not.toContain('erin')
		}
		// The guarded branches ran: the hidden replies are replies of the status, and the unavailable ones public.
		const [rows] = (await sql<{ hidden: number; unavailable: number }>(
			h.store,
			`SELECT sum(visibility IN ('private', 'direct', 'limited')) AS hidden, sum(visibility = 'public') AS unavailable
			FROM statuses WHERE in_reply_to_id = ? AND id IN (SELECT value FROM json_each(?))`,
			focal,
			JSON.stringify([...s.hidden, ...s.unavailable])
		)) as [{ hidden: number; unavailable: number }]
		expect(rows).toEqual({ hidden: 12 * 3 + 130, unavailable: 12 + 200 })
	}, 300_000)

	// An imported public or unlisted reply may be withdrawn (statuses.withdrawn, its removal under way): such a row is a
	// candidate of its author's reads only (RES-7), so more withdrawn replies in a row than a window (60) never move a
	// pager, and no page names one.
	it('names no withdrawn reply, past more of them than a window', async () => {
		const { h, alice, bob } = await people()
		const s = seeder(h)
		const focal = await s.add({ accountId: alice.id, visibility: 'public' }, 'none')
		for (let i = 0; i < 3; i++) {
			await s.add({ accountId: bob.id, visibility: 'public', inReplyToId: focal }, 'local')
			for (let j = 0; j < 70; j++) {
				const id = await s.add(
					{
						accountId: j % 2 === 0 ? bob.id : alice.id,
						visibility: j % 3 === 0 ? 'unlisted' : 'public',
						inReplyToId: focal,
						content: '<p>WITHDRAWN</p>',
					},
					'hidden'
				)
				await sql(h.store, 'UPDATE statuses SET withdrawn = 1 WHERE id = ?', id)
			}
		}
		await partners(h)
		const walked = await walkPages(viaRoute(h), `/@alice/${focal}`, shownThread)
		expect(walked.down).toEqual(s.oldestFirst())
		expect(walked.up).toEqual(s.oldestFirst())
		for (const html of walked.pages) {
			for (const id of s.hidden) {
				expect(html.includes(id) ? id : null).toBeNull()
			}
			expect(html).not.toContain('WITHDRAWN')
		}
		// The guarded branch ran: the withdrawn replies are public or unlisted replies of the status.
		const [rows] = (await sql<{ n: number }>(
			h.store,
			`SELECT count(*) AS n FROM statuses WHERE in_reply_to_id = ? AND withdrawn = 1
				AND visibility IN ('public', 'unlisted')`,
			focal
		)) as [{ n: number }]
		expect(rows.n).toBe(210)
	}, 300_000)

	// Replies whose ids end at the largest a status takes (18 nines): the walk back from the empty page past them starts
	// above every id, so it reaches the last reply too.
	it('walks back from past the largest id to every reply', async () => {
		const { h, alice, bob } = await people()
		const focal = await seedStatus(h.store, { accountId: alice.id, visibility: 'public' })
		const ids: string[] = []
		for (let i = REPLIES_PAGE_SIZE - 1; i >= 0; i--) {
			const id = String(10n ** 18n - 1n - BigInt(i))
			await sql(
				h.store,
				`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, visibility, content, published_at)
				SELECT ?1, 'https://kopje.test/ap/o/' || ?1, ?2, uri, id, 'public', '<p>reply</p>', ?3 FROM statuses WHERE id = ?4`,
				id,
				bob.id,
				new Date(NOW).toISOString(),
				focal
			)
			ids.push(`/@bob/${id}`)
		}
		const walked = await walkPages(viaRoute(h), `/@alice/${focal}`, shownThread)
		expect(walked.down).toEqual(ids)
		expect(walked.up).toEqual(ids)
		// The full first page links on to the empty page above it, whose earlier link starts above every id.
		expect(walked.sizes).toEqual([REPLIES_PAGE_SIZE, 0])
		expect(shownThread(walked.pages[1]!).newer).toBe(`/@alice/${focal}?max_id=1000000000000000000`)
	})

	it('shows the tab with its count, marks a cursor page noindex and names the first page canonical', async () => {
		const { h, alice, bob } = await people()
		const s = seeder(h)
		const focal = await s.add({ accountId: alice.id, visibility: 'public' }, 'none')
		const reply = await s.add({ accountId: bob.id, visibility: 'public', inReplyToId: focal }, 'local')
		await sql(h.store, 'UPDATE statuses SET replies_count = 1 WHERE id = ?', focal)
		const head = async (path: string) => {
			const html = await viaRoute(h)(path)
			const doc = parseHtml(html)
			const tabs = one(doc, 'nav', 'tabs')
			return {
				tabs: [
					attr(tabs, 'aria-label'),
					...query(tabs, 'a').map((a) => [attr(a, 'href'), text(a), attr(a, 'aria-current')]),
				],
				robots: query(doc, 'meta')
					.filter((m) => attr(m, 'name') === 'robots')
					.map((m) => attr(m, 'content')),
				canonical: query(doc, 'link')
					.filter((l) => attr(l, 'rel') === 'canonical')
					.map((l) => attr(l, 'href')),
				shown: shownThread(html),
			}
		}
		const tabs = [
			STRINGS.a11y.statusSections,
			[`/@alice/${focal}`, '1 reply', 'page'],
			[`/@alice/${focal}/reblogs`, '0 boosts', null],
			[`/@alice/${focal}/favourites`, '0 favourites', null],
			[`/@alice/${focal}/quotes`, '0 quotes', null],
		]
		const canonical = [`https://kopje.test/@alice/${focal}`]
		const first = await head(`/@alice/${focal}`)
		expect([first.tabs, first.robots, first.canonical, first.shown.items]).toEqual([
			tabs,
			[],
			canonical,
			[`/@bob/${reply}`],
		])
		// Past the last reply: no card, no empty line (a page lies before it), and its earlier link reaches the reply.
		const later = await head(`/@alice/${focal}?min_id=${reply}`)
		expect([later.tabs, later.robots, later.canonical]).toEqual([tabs, ['noindex, follow'], canonical])
		expect([later.shown.items, later.shown.empty, later.shown.newer, later.shown.older]).toEqual([
			[],
			[],
			`/@alice/${focal}?max_id=${BigInt(reply) + 1n}`,
			null,
		])
		// A status with no replies shows the empty line and no pager; an invalid cursor serves the first page.
		const lone = await s.add({ accountId: alice.id, visibility: 'public' }, 'none')
		const empty = shownThread(await (await h.request(`/@alice/${lone}?max_id=x`)).text())
		expect([empty.items, empty.empty, empty.newer, empty.older]).toEqual([[], [STRINGS.post.noReplies], null, null])
		// The embed shows no thread.
		const embedded = await h.request(`/@bob/${reply}/embed`)
		expect(embedded.status).toBe(200)
		const embed = await embedded.text()
		expect(embed).not.toContain('<ol')
		expect(embed).not.toContain(STRINGS.a11y.statusSections)
	})
})

describe('the replies pager (design §4, "Replies (oldest first)")', () => {
	it('links by the read’s ends and its direction, never by how many items it shows', () => {
		const paging = (newest: string | null, oldest: string | null, more: boolean) => ({ newest, oldest, more })
		const cases: [Parameters<typeof repliesPager>[1], ReturnType<typeof paging>, string | null, string | null][] = [
			[null, paging('9', '5', true), null, '/p?min_id=9'],
			[null, paging('9', '5', false), null, null],
			[null, paging(null, null, false), null, null],
			[{ minId: '3' }, paging('9', '5', true), '/p?max_id=5', '/p?min_id=9'],
			[{ minId: '3' }, paging('9', '5', false), '/p?max_id=5', null],
			// Nothing above X: the earlier page holds the replies up to X itself.
			[{ minId: '3' }, paging(null, null, false), '/p?max_id=4', null],
			[{ minId: '9999999999999999999' }, paging(null, null, false), '/p?max_id=9999999999999999999', null],
			[{ maxId: '20' }, paging('9', '5', true), '/p?max_id=5', '/p?min_id=9'],
			[{ maxId: '20' }, paging('9', '5', false), null, '/p?min_id=9'],
			// Nothing below X: the later page starts at X itself, or is the first page for X = 0.
			[{ maxId: '20' }, paging(null, null, false), null, '/p?min_id=19'],
			[{ maxId: '0' }, paging(null, null, false), null, '/p'],
			// Nothing lies below id 0: no earlier page is offered at it.
			[{ maxId: '20' }, paging('9', '000000000000000000', true), null, '/p?min_id=9'],
			[{ minId: '3' }, paging('9', '0', true), null, '/p?min_id=9'],
		]
		for (const [cursor, read, earlier, later] of cases) {
			expect([cursor, read, repliesPager('/p', cursor, read)]).toEqual([cursor, read, { earlier, later }])
		}
	})
})

describe('a status page’s ancestors (design §2, ThreadUp)', () => {
	// A chain of 45 statuses above the focal post, nearest last: local public and unlisted ones, remote ones, private
	// ones and the suspended account's. The page shows the visible ones among the 40 nearest, oldest first, and
	// nothing of the others; each shown local one's page continues the thread above it.
	it('shows the visible among the 40 nearest, and each one’s page goes on up', async () => {
		const { h, alice, bob, dave, carol } = await people()
		const s = seeder(h)
		const chain: string[] = []
		for (let i = 0; i < 45; i++) {
			const parent = chain.at(-1)
			const reply = parent === undefined ? {} : { inReplyToId: parent }
			const kind = i % 7 === 3 ? 'private' : i % 7 === 5 ? 'suspended' : i % 5 === 1 ? 'remote' : 'local'
			const id =
				kind === 'private'
					? await s.add(
							{ accountId: alice.id, visibility: 'private', content: '<p>HIDDEN private</p>', ...reply },
							'hidden'
						)
					: kind === 'suspended'
						? await s.add(
								{ accountId: dave.id, visibility: 'public', content: '<p>HIDDEN dave</p>', ...reply },
								'hidden'
							)
						: kind === 'remote'
							? await s.add({ accountId: carol, visibility: 'public', ...reply }, 'remote')
							: await s.add(
									{
										accountId: i % 2 === 0 ? alice.id : bob.id,
										visibility: i % 3 === 0 ? 'unlisted' : 'public',
										...reply,
									},
									'local'
								)
			chain.push(id)
		}
		const focal = await seedStatus(h.store, {
			accountId: alice.id,
			visibility: 'public',
			inReplyToId: chain.at(-1)!,
			published: NOW - 1000,
		})
		await partners(h)
		const hrefOf = new Map(s.shown.map((seed) => [seed.id, seed.href]))
		const visible = (ids: string[]) => ids.flatMap((id) => hrefOf.get(id) ?? [])
		const html = await viaRoute(h)(`/@alice/${focal}`)
		const page = shownThread(html)
		// The 40 nearest, oldest first, less the hidden ones; the five farthest are past the bound.
		expect(page.ancestors).toEqual(visible(chain.slice(5)))
		expect(page.ancestors.length).toBeLessThan(40)
		expect(page.ancestors.some((href) => href.startsWith('https://remote.example/'))).toBe(true)
		// The thread is an ordered list named from the catalogue.
		expect(attr(one(parseHtml(html), 'ol', 'thread'), 'aria-label')).toBe(STRINGS.a11y.thread)
		// The whole HTML names no hidden ancestor: no id, no URL, no text.
		for (const id of s.hidden) {
			expect(html.includes(id) ? id : null).toBeNull()
		}
		expect(html).not.toContain('HIDDEN')
		expect(html).not.toContain('@dave')
		// The guarded branch ran: hidden ancestors lie within the 40 nearest.
		expect(s.hidden.filter((id) => chain.slice(5).includes(id)).length).toBeGreaterThan(5)
		// The farthest local ancestor shown: its own page shows the visible ones above it, the five farthest among them.
		const farthest = chain.slice(5).find((id) => hrefOf.get(id)?.startsWith('/@') === true)!
		const above = shownThread(await viaRoute(h)(hrefOf.get(farthest)!))
		expect(above.ancestors).toEqual(visible(chain.slice(0, chain.indexOf(farthest))))
		expect(above.ancestors.length).toBeGreaterThan(0)
		// And from an ancestor down: the nearest one's page lists the focal post among its replies.
		const nearest = chain.at(-1)!
		expect(shownThread(await viaRoute(h)(hrefOf.get(nearest)!)).items).toEqual([`/@alice/${focal}`])
	}, 120_000)

	it('leaves out a hidden parent, and links nothing of it', async () => {
		const { h, alice, bob } = await people()
		const s = seeder(h)
		const root = await s.add({ accountId: bob.id, visibility: 'public' }, 'local')
		const parent = await s.add(
			{ accountId: bob.id, visibility: 'private', inReplyToId: root, content: '<p>HIDDEN parent</p>' },
			'hidden'
		)
		const focal = await seedStatus(h.store, { accountId: alice.id, visibility: 'public', inReplyToId: parent })
		await partners(h)
		const html = await viaRoute(h)(`/@alice/${focal}`)
		expect(shownThread(html).ancestors).toEqual([`/@bob/${root}`])
		expect(query(one(parseHtml(html), 'article', 'focal'), 'p', 'reply-to')).toEqual([])
		expect(html).not.toContain(parent)
		expect(html).not.toContain('HIDDEN')
	})
})

// The frame a status page's answer reserves with its thread and history (design §2), stated apart from the read's own.
function statusFrameBytes(site: Site): number {
	return jsonBytes({
		status: 'ok',
		value: null,
		parent: null,
		thread: {
			ancestors: [],
			list: { kind: 'replies', statuses: [], stub: LONGEST_STATUS_STUB },
			paging: LONGEST_PAGING,
		},
		history: { versions: [], leftOut: Number.MAX_SAFE_INTEGER },
		site,
	})
}

// A walk of the read within `extra` bytes past its frame and head, rendered as the route renders it; each answer within
// its budget.
function within(h: Harness, focal: string, extra: number) {
	let answerBytes = 0
	return async (path: string) => {
		const cursor = cursorOf(path)
		const read = (bytes: number) =>
			runInDurableObject(h.store, (_instance, state) =>
				statusPageWithin(
					new Db(state.storage.sql),
					{ handle: 'alice', id: focal, now: NOW, tab: { kind: 'replies', cursor } },
					SITE,
					bytes
				)
			)
		if (answerBytes === 0) {
			const full = await read(WEB_PAGE_BYTES)
			if (full.status !== 'ok') {
				throw new Error(full.status)
			}
			answerBytes = statusFrameBytes(SITE) + jsonBytes(full.value) + jsonBytes(full.parent) + extra
		}
		const page = await read(answerBytes)
		if (page.status !== 'ok' || page.thread === null) {
			throw new Error(page.status)
		}
		expect(jsonBytes({ ...page, site: SITE })).toBeLessThanOrEqual(answerBytes)
		return render(
			jsx(StatusPage, {
				status: page.value,
				parent: page.parent,
				history: page.history,
				site: SITE,
				thread: { ...page.thread, cursor },
			})
		)
	}
}

// A post of `chars` characters of content.
const sized = (chars: number, label: string) => `<p>${label} ${'x'.repeat(chars)}</p>`

describe('a status page within its page budget (design §2, §4)', () => {
	// A budget that holds about 25 kB past the head: small replies (about 2 kB of JSON) fill a page before 20, so pages
	// are cut by bytes, underfilled; large ones (about 30 kB) are stubbed when they come first and end a page when they
	// come later. The ancestors take at most half of what the first reply leaves, nearest first.
	it('walks to both ends through byte cuts and stubs, and trims the farthest ancestors first', async () => {
		const { h, alice, bob } = await people()
		const s = seeder(h)
		const chain: string[] = []
		for (let i = 0; i < 12; i++) {
			const parent = chain.at(-1)
			chain.push(
				await s.add(
					{
						accountId: bob.id,
						visibility: 'public',
						content: sized(3_000, `ancestor ${i}`),
						...(parent === undefined ? {} : { inReplyToId: parent }),
					},
					'local'
				)
			)
		}
		const ancestors = s.oldestFirst()
		s.shown.length = 0
		const focal = await seedStatus(h.store, {
			accountId: alice.id,
			visibility: 'public',
			inReplyToId: chain.at(-1)!,
			published: NOW - 3_600_000,
		})
		const replies = seeder(h, NOW - 3_000_000)
		for (let i = 0; i < 60; i++) {
			const large = i % 7 === 3
			await replies.add(
				{
					accountId: i % 2 === 0 ? alice.id : bob.id,
					visibility: 'public',
					inReplyToId: focal,
					content: sized(large ? 30_000 : 1_000, `reply ${i}`),
				},
				'local'
			)
		}
		await partners(h)
		const walked = await walkPages(within(h, focal, 25_000), `/@alice/${focal}`, shownThread, (url, page) => {
			// Each page's ancestors are the nearest of the chain, oldest first: a suffix of it, never all of it.
			expect(ancestors.slice(ancestors.length - page.ancestors.length)).toEqual(page.ancestors)
			expect(page.ancestors.length).toBeLessThan(ancestors.length)
		})
		expect(walked.down).toEqual(replies.oldestFirst())
		expect(walked.up).toEqual(replies.oldestFirst())
		// Cut by bytes: pages that link on with fewer than 20.
		expect(walked.sizes.slice(0, -1).some((size) => size > 0 && size < REPLIES_PAGE_SIZE)).toBe(true)
		// Stubbed first replies: rows without an author block.
		const stubs = walked.pages.flatMap((html) =>
			query(parseHtml(html), 'ul', 'feed')
				.flatMap((list) => query(list, 'article'))
				.filter((article) => query(article, 'div', 'who').length === 0)
		)
		expect(stubs.length).toBeGreaterThan(0)
		// Some pages showed ancestors: the half the first reply leaves holds a few.
		expect(walked.pages.some((html) => shownThread(html).ancestors.length > 0)).toBe(true)
	}, 300_000)
})

describe('a status page’s thread beside its edit history (design §2)', () => {
	// An edited post with a thread: the history is admitted last, newest version first, each whole while it fits the
	// lesser of what the thread leaves and WEB_HISTORY_BYTES, and every version after the first that does not is
	// counted as left out. The thread is the same as with no history at all: the history takes only what it leaves.
	it('admits the history after the thread, within what it leaves and its own share', async () => {
		const { h, alice, bob } = await people()
		const s = seeder(h)
		const chain: string[] = []
		for (let i = 0; i < 6; i++) {
			const parent = chain.at(-1)
			chain.push(
				await s.add(
					{
						accountId: bob.id,
						visibility: 'public',
						content: sized(3_000, `ancestor ${i}`),
						...(parent === undefined ? {} : { inReplyToId: parent }),
					},
					'local'
				)
			)
		}
		const focal = await s.add(
			{ accountId: alice.id, visibility: 'public', inReplyToId: chain.at(-1)!, content: '<p>now</p>' },
			'none'
		)
		for (let i = 0; i < 30; i++) {
			await s.add(
				{ accountId: bob.id, visibility: 'public', inReplyToId: focal, content: sized(1_000, `reply ${i}`) },
				'none'
			)
		}
		await partners(h)
		// Twelve recorded versions of about 100 kB each: more than WEB_HISTORY_BYTES (512 KiB) together.
		const VERSIONS = 12
		await sql(h.store, 'UPDATE statuses SET edited_at = ? WHERE id = ?', new Date(NOW).toISOString(), focal)
		for (let i = 0; i < VERSIONS; i++) {
			await sql(
				h.store,
				'INSERT INTO status_edits (status_id, content, created_at) VALUES (?, ?, ?)',
				focal,
				sized(100_000, `version ${i}`),
				new Date(NOW - (VERSIONS - i) * 60_000).toISOString()
			)
		}
		const read = (bytes: number) =>
			runInDurableObject(h.store, (_instance, state) =>
				statusPageWithin(
					new Db(state.storage.sql),
					{ handle: 'alice', id: focal, now: NOW, tab: { kind: 'replies', cursor: null } },
					SITE,
					bytes
				)
			)
		const versionBytes = (versions: readonly unknown[]) =>
			versions.reduce<number>((sum, version) => sum + jsonBytes(version) + 1, 0)
		const full = await read(WEB_PAGE_BYTES)
		if (full.status !== 'ok' || full.thread === null || full.history === null) {
			throw new Error(full.status)
		}
		// Within the page budget the history stops at its own share, the thread whole beside it.
		expect(full.thread.ancestors).toHaveLength(6)
		expect(full.thread.list.kind === 'replies' && full.thread.list.statuses).toHaveLength(REPLIES_PAGE_SIZE)
		expect(versionBytes(full.history.versions)).toBeLessThanOrEqual(WEB_HISTORY_BYTES)
		expect(full.history.versions.length).toBeGreaterThan(0)
		expect(full.history.versions.length + full.history.leftOut).toBe(VERSIONS)
		expect(full.history.leftOut).toBeGreaterThan(0)
		// Within a small budget the history takes only what the thread leaves; the thread is what it would be with no
		// history, and the versions that do not fit are counted.
		const small = statusFrameBytes(SITE) + jsonBytes(full.value) + jsonBytes(full.parent) + 250_000
		const tight = await read(small)
		if (tight.status !== 'ok' || tight.thread === null || tight.history === null) {
			throw new Error(tight.status)
		}
		expect(jsonBytes({ ...tight, site: SITE })).toBeLessThanOrEqual(small)
		expect(tight.history.versions.length).toBeLessThan(full.history.versions.length)
		expect(tight.history.versions.length + tight.history.leftOut).toBe(VERSIONS)
		// Newest first: the versions admitted are the newest ones, in that order.
		expect(tight.history.versions.map((version) => version.created_at)).toEqual(
			full.history.versions.slice(0, tight.history.versions.length).map((version) => version.created_at)
		)
		await sql(h.store, 'DELETE FROM status_edits WHERE status_id = ?', focal)
		const without = await read(small)
		if (without.status !== 'ok' || without.thread === null) {
			throw new Error(without.status)
		}
		expect(without.history).toBeNull()
		expect(tight.thread).toEqual(without.thread)
		// The guarded branch ran: the thread held posts in the small budget, so the history competed with them.
		expect(
			tight.thread.list.kind === 'replies' && tight.thread.list.statuses.length + tight.thread.ancestors.length
		).toBeGreaterThan(0)
	}, 120_000)
})

describe('a status page’s reads (RES-7, docs/visibility.md "Read bounds")', () => {
	// The page's statements on statuses with statistics taken before the Store grew, read in both directions: the
	// replies' window seeks statuses_public_replies from the cursor, never scanning statuses, and fills its cap
	// (readWindow(20), 60 candidates: 120 public and unlisted replies, a third of them shown and the rest by a suspended
	// account), and the page reads the same rows with 40 or 4,000 private, direct, limited and withdrawn replies among
	// its candidates, and 1,000 more replies to other statuses.
	it('seeks the public replies’ index from the cursor both ways, with stale statistics', async () => {
		const { h, alice, bob, dave } = await people()
		const focal = await seedStatus(h.store, { accountId: alice.id, visibility: 'public', published: NOW - 86_400_000 })
		const other = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: NOW - 86_300_000 })
		// The candidates a second apart after NOW, so their ids are apart too (ids are allocated in order).
		const candidates: { id: string; shown: boolean }[] = []
		for (let i = 0; i < 6 * REPLIES_PAGE_SIZE; i++) {
			const shown = i % 3 === 0
			candidates.push({
				id: await seedStatus(h.store, {
					accountId: shown ? (i % 2 === 0 ? bob.id : alice.id) : dave.id,
					visibility: i % 4 === 1 ? 'unlisted' : 'public',
					inReplyToId: focal,
					published: NOW + 60_000 + i * 1000,
				}),
				shown,
			})
		}
		// Replies that are never candidates between the candidates (each by an id one past a candidate's: seeding
		// allocates ids in order): private, direct, limited, and public ones withdrawn.
		let n = 0
		const hidden = async (count: number) => {
			for (let i = 0; i < count; i++, n++) {
				const gaps = candidates.length - 1
				const id = String(BigInt(candidates[n % gaps]!.id) + 1n + BigInt(Math.floor(n / gaps)))
				const kind = (['private', 'direct', 'limited', 'withdrawn'] as const)[n % 4]!
				await sql(
					h.store,
					`INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, in_reply_to_id, visibility, withdrawn, content,
						published_at)
					SELECT ?1, 'https://kopje.test/ap/o/' || ?1, ?2, uri, id, ?3, ?4, '<p>hidden</p>', ?5 FROM statuses WHERE id = ?6`,
					id,
					bob.id,
					kind === 'withdrawn' ? 'public' : kind,
					kind === 'withdrawn' ? 1 : 0,
					new Date(NOW).toISOString(),
					focal
				)
			}
		}
		await hidden(40)
		await seedStatus(h.store, { accountId: alice.id, visibility: 'public', inReplyToId: other, published: NOW - 1000 })
		// From the third candidate up, and from the third from the end down: each a full window of 60 candidates, of
		// which the page shows the 20 shown ones, oldest first.
		const cursors = [
			{ cursor: { minId: candidates[2]!.id }, window: candidates.slice(3, 63) },
			{ cursor: { maxId: candidates.at(-3)!.id }, window: candidates.slice(-63, -3) },
		]
		const capture = async () => {
			let rows = 0
			for (const { cursor, window } of cursors) {
				const run = await runInDurableObject(h.store, (_instance, state) => {
					const plans: PlannedStatement[] = []
					const page = statusPageWithin(
						new Db(plannedSql(state.storage.sql, /\bstatuses s\b/, plans)),
						{ handle: 'alice', id: focal, now: NOW, tab: { kind: 'replies', cursor } },
						SITE,
						WEB_PAGE_BYTES
					)
					return { plans, page }
				})
				if (run.page.status !== 'ok' || run.page.thread === null) {
					throw new Error(run.page.status)
				}
				expect(
					run.page.thread.list.kind === 'replies' && run.page.thread.list.statuses.map((status) => status.id)
				).toEqual(window.flatMap((c) => (c.shown ? [c.id] : [])))
				expect(run.page.thread.paging.more).toBe(true)
				for (const statement of run.plans) {
					expect(scansOf(statement.plan, ['s', 'statuses'])).toEqual([])
				}
				const seek = run.plans.find((statement) =>
					statement.plan.some((d) => /USING (?:COVERING )?INDEX statuses_public_replies/.test(d))
				)
				// The window read its cap of candidates.
				expect(seek?.rows).toBe(60)
				rows += run.plans.reduce((sum, statement) => sum + statement.rows, 0)
			}
			return rows
		}
		const { before, after } = await staleStatistics(h, {
			capture,
			grow: async () => {
				await hidden(3960)
				for (let i = 0; i < 1000; i++) {
					await seedStatus(h.store, {
						accountId: alice.id,
						visibility: 'public',
						inReplyToId: other,
						published: NOW - 80_000_000 + i * 50 + 7,
					})
				}
			},
		})
		expect(after).toBe(before)
		// The guarded branch ran: the hidden replies lie between the candidates the pages read.
		const [rows] = (await sql<{ n: number; withdrawn: number }>(
			h.store,
			`SELECT count(*) AS n, sum(withdrawn) AS withdrawn FROM statuses WHERE in_reply_to_id = ?
				AND (visibility IN ('private', 'direct', 'limited') OR withdrawn = 1) AND id > ? AND id < ?`,
			focal,
			candidates[0]!.id,
			candidates.at(-1)!.id
		)) as [{ n: number; withdrawn: number }]
		expect(rows).toEqual({ n: 4000, withdrawn: 1000 })
	}, 600_000)
})
