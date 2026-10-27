import { runInDurableObject } from 'cloudflare:test'

import { jsx } from 'hono/jsx'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import { pagerLinks, viaRoute, walkPages } from './profile-page-helpers'
import { type PlannedStatement, plannedSql, scansOf, staleStatistics } from './read-helpers'
import { community, seedStatus } from './status-helpers'
import { attr, type Element, one, parseHtml, query, text } from './web-dom'
import { SITE } from './web-fixtures'
import { countedHarness } from './web-helpers'
import { Db } from '../src/db/sql'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { LONGEST_STATUS_STUB, WEB_PAGE_BYTES } from '../src/domain/web-pages/budget'
import { LONGEST_PAGING, pageCursor } from '../src/domain/web-pages/paging'
import {
	INTERACTORS_PAGE_SIZE,
	QUOTES_PAGE_SIZE,
	statusPageWithin,
	type StatusTabKind,
	type TabList,
} from '../src/domain/web-pages/status'
import { StatusPage } from '../src/web/pages/status'
import { STRINGS } from '../src/web/strings'

// A status page's interaction tabs (design §2, §3, §4, §17 PR 9; issue #1185 §5): who boosted it (public and unlisted
// boosts only), who favourited it, and its accepted quotes whose two statuses an anonymous viewer may see (VIS-4,
// VIS-6, VIS-27, VIS-28), each newest first by the API's own cursor and paged both ways; and its counts, which link to
// them.

type Harness = Awaited<ReturnType<typeof community>>
type Kind = Exclude<StatusTabKind, 'replies'>

const ACCOUNT_TEXTS = { newer: STRINGS.pager.newerFollows, older: STRINGS.pager.olderFollows }

let nextAccount = 730_000_000_000_000_000n

// A remote account written directly: its id. Its profile link derives from its actor id (https://<domain>/@<name>).
function remoteIn(
	sqlStorage: SqlStorage,
	name: string,
	domain = 'remote.example',
	displayName = '',
	suspended = false
) {
	const id = String(nextAccount++)
	sqlStorage.exec(
		'INSERT INTO accounts (id, uri, username, domain, display_name) VALUES (?, ?, ?, ?, ?)',
		id,
		`https://${domain}/users/${name}`,
		name,
		domain,
		displayName
	)
	if (suspended) {
		sqlStorage.exec(
			"UPDATE accounts SET suspended_at = '2026-01-01T00:00:00.000Z', suspension_source = 'account' WHERE id = ?",
			id
		)
	}
	return id
}

// A status row written directly, by `id` (above every status the harness wrote, so ids follow the seeding order).
function statusIn(
	sqlStorage: SqlStorage,
	row: { id: string; account: string; local: boolean; visibility: string; content?: string; reblogOf?: string }
) {
	sqlStorage.exec(
		`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		row.id,
		row.local ? `https://kopje.test/ap/o/${row.id}` : `https://remote.example/objects/${row.id}`,
		row.account,
		row.reblogOf ?? null,
		row.visibility,
		row.reblogOf === undefined ? (row.content ?? `<p>status ${row.id}</p>`) : '',
		new Date(NOW).toISOString()
	)
}

// A quote by the status `id` of the status `quoted`, in `state`.
function quoteIn(sqlStorage: SqlStorage, id: string, quoted: string, state: string) {
	sqlStorage.exec(
		`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
		SELECT ?, uri, id, account_id, ?, ? FROM statuses WHERE id = ?`,
		id,
		state,
		new Date(NOW).toISOString(),
		quoted
	)
}

// Every cursor a page names (its pager's and any other link's).
function cursorsOf(main: Element): string[] {
	return query(main, 'a').flatMap((a) => {
		const params = new URL(attr(a, 'href') ?? '', 'https://kopje.test').searchParams
		return ['max_id', 'min_id'].flatMap((name) => params.getAll(name))
	})
}

// What an account tab shows: each row's profile link, the pager's links, every cursor it names and its empty line.
function shownAccountTab(html: string) {
	const main = one(parseHtml(html), 'main')
	const list = query(main, 'ul', 'accounts')[0]
	const items =
		list === undefined
			? []
			: query(list, 'li').map((li) => {
					const link = query(li, 'a', 'name')[0]
					expect(link, 'a row links its account').toBeDefined()
					return attr(link!, 'href') ?? ''
				})
	return {
		items,
		...pagerLinks(main, ACCOUNT_TEXTS),
		cursors: cursorsOf(main),
		empty: query(main, 'p', 'empty').map(text),
	}
}

// What the Quotes tab shows: each card's link (its date link, or a stub's), the pager's links, every cursor and the
// links of the cards' reply-to lines.
function shownQuoteTab(html: string) {
	const main = one(parseHtml(html), 'main')
	const list = query(main, 'ul', 'feed')[0]
	const items =
		list === undefined
			? []
			: query(list, 'article').map((article) => {
					const link = query(query(article, 'p', 'meta')[0] ?? article, 'a')[0]
					expect(link, 'a card links its post').toBeDefined()
					return attr(link!, 'href') ?? ''
				})
	const replyTo = query(main, 'p', 'reply-to').flatMap((p) => query(p, 'a').map((a) => attr(a, 'href') ?? ''))
	return {
		items,
		...pagerLinks(main, STRINGS.pager),
		cursors: cursorsOf(main),
		replyTo,
		empty: query(main, 'p', 'empty').map(text),
	}
}

// The URL's cursor, as the route reads it.
function cursorOf(url: string) {
	const params = new URL(url, 'https://kopje.test').searchParams
	return pageCursor(params.get('max_id'), params.get('min_id'))
}

// Whether every cursor of the page at `url` is one of `candidates` or a boundary one step from the page's own cursor
// (src/web/view/pager.ts): never another id.
function expectCursors(url: string, cursors: readonly string[], candidates: ReadonlySet<string>) {
	const own = cursorOf(url)
	const x = own === null ? null : BigInt('maxId' in own ? own.maxId : own.minId)
	for (const cursor of cursors) {
		const boundary = x !== null && (BigInt(cursor) === x + 1n || BigInt(cursor) === x - 1n)
		expect([url, cursor, candidates.has(cursor) || boundary]).toEqual([url, cursor, true])
	}
}

// alice's public post, its boosts and its favourites, each in id order: rows each tab shows (remote accounts and bob)
// between runs of rows it leaves out, one run longer than three candidate windows (readWindow(40) = 120): accounts the
// instance suspended, accounts on a domain it blocks, and its suspended local account (their boosts are public, so
// candidates; never shown). Boosts no candidate window reads: private, direct and limited ones. And a public boost
// withdrawn (its removal under way), which is a candidate the rule leaves out.
async function interactions() {
	const h = await community(['alice', 'bob', 'secretcarol'])
	const { alice, bob, secretcarol } = h.users
	await sql(
		h.store,
		'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
		new Date(NOW).toISOString(),
		secretcarol.id
	)
	await blockDomain(h.store, 'blocked.example')
	const focal = await seedStatus(h.store, {
		accountId: alice.id,
		visibility: 'public',
		content: '<p>the focal post</p>',
	})
	const seeded = await runInDurableObject(h.store, (_instance, state) => {
		const s = state.storage.sql
		const expected: Record<Kind & ('reblogs' | 'favourites'), string[]> = { reblogs: [], favourites: [] }
		const candidates = { reblogs: new Set<string>(), favourites: new Set<string>() }
		const neverCandidates: string[] = []
		let nextStatus = BigInt(focal) + 1000n
		let n = 0
		const add = (account: string, href: string | null, visibility = 'public', withdrawn = false) => {
			const id = String(nextStatus++)
			statusIn(s, { id, account, local: false, visibility, reblogOf: focal })
			if (withdrawn) {
				s.exec('UPDATE statuses SET withdrawn = 1 WHERE id = ?', id)
			}
			if (visibility === 'public' || visibility === 'unlisted') {
				candidates.reblogs.add(id)
			} else {
				neverCandidates.push(id)
				return
			}
			s.exec('INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', account, focal)
			const favourite = String(s.exec<{ id: number }>('SELECT last_insert_rowid() AS id').one().id)
			candidates.favourites.add(favourite)
			if (href !== null) {
				expected.favourites.unshift(href)
				if (!withdrawn) {
					expected.reblogs.unshift(href)
				}
			}
		}
		const visible = (count: number) => {
			for (let i = 0; i < count; i++) {
				const name = `v${n++}`
				add(remoteIn(s, name), `https://remote.example/@${name}`, i % 3 === 1 ? 'unlisted' : 'public')
			}
		}
		const hidden = (count: number) => {
			for (let i = 0; i < count; i++) {
				const name = `secret${n++}`
				const suspended = i % 3 !== 0
				add(remoteIn(s, name, suspended ? 'remote.example' : 'blocked.example', `HIDDEN ${name}`, suspended), null)
				if (i % 50 === 0) {
					for (const visibility of ['private', 'direct', 'limited']) {
						add(remoteIn(s, `secret${n++}`, 'remote.example', 'HIDDEN boost'), null, visibility)
					}
				}
			}
		}
		visible(30)
		add(bob.id, '/@bob', 'unlisted')
		add(secretcarol.id, null)
		// A withdrawn boost by an account the tab would otherwise list: its favourite shows, its boost does not.
		add(remoteIn(s, 'withdrawn'), 'https://remote.example/@withdrawn', 'public', true)
		hidden(400)
		visible(25)
		hidden(130)
		visible(30)
		return {
			expected,
			candidates: { reblogs: [...candidates.reblogs], favourites: [...candidates.favourites] },
			neverCandidates,
		}
	})
	return { h, focal, ...seeded }
}

// What no page of a tab may name: a left-out account's name, and the id of a boost no window reads.
function leaks(html: string, neverCandidates: readonly string[]): string[] {
	return [
		...['HIDDEN', 'secret'].filter((word) => html.includes(word)),
		...neverCandidates.filter((id) => html.includes(id)),
	]
}

describe('a status page’s Boosts and Favourites tabs (design §2, §4)', () => {
	it('walk to both ends in the order seeded, past runs of left-out accounts longer than two windows, naming nothing hidden', async () => {
		const { h, focal, expected, candidates, neverCandidates } = await interactions()
		for (const kind of ['reblogs', 'favourites'] as const) {
			const allowed = new Set(candidates[kind])
			const walked = await walkPages(viaRoute(h), `/@alice/${focal}/${kind}`, shownAccountTab, (url, page) =>
				expectCursors(url, page.cursors, allowed)
			)
			expect(expected[kind].length).toBeGreaterThan(2 * INTERACTORS_PAGE_SIZE)
			expect([kind, walked.down]).toEqual([kind, expected[kind]])
			expect([kind, walked.up]).toEqual([kind, expected[kind]])
			// The runs of left-out accounts pass more than one window with nothing shown, and each such page links on.
			expect([kind, walked.sizes.join(' ')]).toEqual([kind, expect.stringMatching(/\b0 0\b/)])
			for (const html of walked.pages) {
				expect([kind, leaks(html, neverCandidates)]).toEqual([kind, []])
			}
		}
		// The withdrawn boost's account shows on the Favourites tab only.
		expect(expected.favourites).toContain('https://remote.example/@withdrawn')
		expect(expected.reblogs).not.toContain('https://remote.example/@withdrawn')
		// The guarded branches ran: the boosts no window reads are boosts of the post, and the left-out accounts' boosts
		// are public.
		const [rows] = (await sql<{ hidden: number; unavailable: number }>(
			h.store,
			`SELECT sum(visibility IN ('private', 'direct', 'limited')) AS hidden,
				sum(visibility = 'public' AND account_id IN (SELECT id FROM accounts WHERE username LIKE 'secret%')) AS unavailable
			FROM statuses WHERE reblog_of_id = ?`,
			focal
		)) as [{ hidden: number; unavailable: number }]
		expect(rows.hidden).toBe(3 * 11)
		expect(rows.unavailable).toBeGreaterThan(400)
	}, 300_000)

	// VIS-6: a withdrawn boost (its Undo recorded, its removal under way) is gone for everyone, for the page and for
	// GET /api/v1/statuses/:id/reblogged_by alike, as Mastodon lists kept boosts only.
	it('leave out a withdrawn boost, as the API does', async () => {
		const h = await community(['alice', 'bob'])
		const focal = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
		const kept = await runInDurableObject(h.store, (_instance, state) => {
			const s = state.storage.sql
			const withdrawn = remoteIn(s, 'withdrawn')
			const carol = remoteIn(s, 'carol')
			statusIn(s, {
				id: String(BigInt(focal) + 1n),
				account: withdrawn,
				local: false,
				visibility: 'public',
				reblogOf: focal,
			})
			s.exec('UPDATE statuses SET withdrawn = 1 WHERE id = ?', String(BigInt(focal) + 1n))
			statusIn(s, {
				id: String(BigInt(focal) + 2n),
				account: carol,
				local: false,
				visibility: 'unlisted',
				reblogOf: focal,
			})
			return carol
		})
		expect(shownAccountTab(await viaRoute(h)(`/@alice/${focal}/reblogs`)).items).toEqual([
			'https://remote.example/@carol',
		])
		const api = await h.request(`/api/v1/statuses/${focal}/reblogged_by`)
		expect((await api.json<{ id: string }[]>()).map((account) => account.id)).toEqual([kept])
		// The guarded branch: the withdrawn boost is public, a candidate of the window.
		expect(
			await sql(
				h.store,
				"SELECT count(*) AS n FROM statuses WHERE reblog_of_id = ? AND visibility = 'public' AND withdrawn = 1",
				focal
			)
		).toEqual([{ n: 1 }])
	})
})

// alice's public post and its quotes, each in id order: quotes the tab shows (accepted, public or unlisted, by alice,
// bob or a remote account) among every kind it leaves out: quotes in any other state, accepted quotes by private,
// direct, limited or withdrawn statuses (never candidates), accepted public quotes by a suspended account and by a
// blocked server (candidates the rule hides; 130 of them in a row, more than six windows of 20), 60 private ones in a
// row, and accepted quotes of another post. Some quotes reply to a post: a public one, linked, or a private one, not.
async function quotes() {
	const h = await community(['alice', 'bob', 'dave'])
	const { alice, bob, dave } = h.users
	await sql(
		h.store,
		'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
		new Date(NOW).toISOString(),
		dave.id
	)
	await blockDomain(h.store, 'blocked.example')
	const focal = await seedStatus(h.store, {
		accountId: alice.id,
		visibility: 'public',
		content: '<p>the focal post</p>',
	})
	const other = await seedStatus(h.store, { accountId: bob.id, visibility: 'public' })
	const parent = await seedStatus(h.store, { accountId: bob.id, visibility: 'public' })
	const secretParent = await seedStatus(h.store, {
		accountId: bob.id,
		visibility: 'private',
		content: '<p>HIDDEN parent</p>',
	})
	const seeded = await runInDurableObject(h.store, (_instance, state) => {
		const s = state.storage.sql
		const carol = remoteIn(s, 'carol')
		const erin = remoteIn(s, 'erin', 'blocked.example', 'HIDDEN erin')
		const expected: string[] = []
		const candidates = new Set<string>()
		const neverCandidates: string[] = []
		let nextStatus = BigInt(focal) + 1000n
		// `shows`: the card's link (ID standing for the quote's id), 'hidden' (never a candidate) or 'unavailable' (a
		// candidate the rule hides).
		const quote = (
			row: { account: string; local: boolean; visibility: string; content?: string },
			state: 'accepted' | 'pending' | 'rejected' | 'revoked' | 'deleted',
			shows: string,
			quoted = focal
		) => {
			const id = String(nextStatus++)
			statusIn(s, { id, ...row })
			quoteIn(s, id, quoted, state)
			if (shows === 'hidden') {
				neverCandidates.push(id)
			} else {
				candidates.add(id)
				if (shows !== 'unavailable') {
					expected.unshift(shows.replace('ID', id))
				}
			}
			return id
		}
		for (let i = 0; i < 70; i++) {
			const [account, local, href] =
				i % 5 === 2
					? [carol, false, 'https://remote.example/objects/ID']
					: i % 2 === 0
						? [alice.id, true, '/@alice/ID']
						: [bob.id, true, '/@bob/ID']
			const id = quote(
				{ account, local, visibility: i % 3 === 1 ? 'unlisted' : 'public', content: `<p>quote ${i}</p>` },
				'accepted',
				href
			)
			if (i % 10 === 3) {
				s.exec(
					'UPDATE statuses SET in_reply_to_id = ?1, in_reply_to_uri = (SELECT uri FROM statuses WHERE id = ?1) WHERE id = ?2',
					i % 20 === 3 ? parent : secretParent,
					id
				)
			}
			if (i % 6 === 0) {
				for (const kind of ['pending', 'rejected', 'revoked', 'deleted'] as const) {
					quote(
						{ account: bob.id, local: true, visibility: 'public', content: `<p>HIDDEN ${kind}</p>` },
						kind,
						'hidden'
					)
				}
				for (const visibility of ['private', 'direct', 'limited']) {
					quote(
						{ account: bob.id, local: true, visibility, content: `<p>HIDDEN ${visibility}</p>` },
						'accepted',
						'hidden'
					)
				}
				const withdrawn = quote(
					{ account: bob.id, local: true, visibility: 'public', content: '<p>HIDDEN withdrawn</p>' },
					'accepted',
					'hidden'
				)
				s.exec('UPDATE statuses SET withdrawn = 1 WHERE id = ?', withdrawn)
				quote(
					{ account: erin, local: false, visibility: 'public', content: '<p>HIDDEN blocked</p>' },
					'accepted',
					'unavailable'
				)
				quote(
					{ account: alice.id, local: true, visibility: 'public', content: '<p>HIDDEN of another post</p>' },
					'accepted',
					'hidden',
					other
				)
			}
			if (i === 20) {
				for (let j = 0; j < 130; j++) {
					quote(
						{ account: dave.id, local: true, visibility: 'public', content: `<p>HIDDEN suspended ${j}</p>` },
						'accepted',
						'unavailable'
					)
				}
			}
			if (i === 40) {
				for (let j = 0; j < 60; j++) {
					quote(
						{ account: alice.id, local: true, visibility: 'private', content: `<p>HIDDEN private ${j}</p>` },
						'accepted',
						'hidden'
					)
				}
			}
		}
		return { expected, candidates, neverCandidates }
	})
	return { h, focal, parent, secretParent, ...seeded }
}

describe('a status page’s Quotes tab (design §2, §4, VIS-27, VIS-28)', () => {
	it('walks to both ends in the order seeded, and names nothing hidden', async () => {
		const { h, focal, parent, secretParent, expected, candidates, neverCandidates } = await quotes()
		const walked = await walkPages(viaRoute(h), `/@alice/${focal}/quotes`, shownQuoteTab, (url, page) => {
			expectCursors(url, page.cursors, candidates)
			// A reply-to line names only the public parent.
			for (const link of page.replyTo) {
				expect(link).toBe(`/@bob/${parent}`)
			}
		})
		expect(expected.length).toBeGreaterThan(3 * QUOTES_PAGE_SIZE)
		expect(walked.down).toEqual(expected)
		expect(walked.up).toEqual(expected)
		// The 130 quotes of the suspended account pass more than one window with nothing shown, and each such page links
		// on.
		expect(walked.sizes.join(' ')).toMatch(/\b0 0\b/)
		const all = walked.pages.join('')
		expect(all).toContain(`/@bob/${parent}`)
		for (const html of walked.pages) {
			// The whole HTML (meta tags, pager URLs, cards) names no quote the tab leaves out, by text or id, and not the
			// private parent.
			expect(html).not.toContain('HIDDEN')
			expect(html).not.toContain('@dave')
			expect(html).not.toContain('erin')
			expect(html.includes(secretParent)).toBe(false)
			for (const id of neverCandidates) {
				expect(html.includes(id) ? id : null).toBeNull()
			}
		}
		// The guarded branches ran: the quotes left out are quotes of the post (or of another), in every state, and the
		// replies' parents are set.
		const states = await sql<{ state: string; visibility: string; withdrawn: number; n: number }>(
			h.store,
			`SELECT q.state, s.visibility, s.withdrawn, count(*) AS n FROM quotes q JOIN statuses s ON s.id = q.status_id
			WHERE q.status_id IN (SELECT value FROM json_each(?)) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
			JSON.stringify(neverCandidates)
		)
		expect(states.map((row) => `${row.state} ${row.visibility} ${row.withdrawn}`)).toEqual([
			'accepted direct 0',
			'accepted limited 0',
			'accepted private 0',
			'accepted public 0',
			'accepted public 1',
			'deleted public 0',
			'pending public 0',
			'rejected public 0',
			'revoked public 0',
		])
		expect(
			await sql(h.store, 'SELECT count(*) AS n FROM statuses WHERE in_reply_to_id IN (?, ?)', parent, secretParent)
		).toEqual([{ n: 7 }])
	}, 300_000)
})

// The page read rendered as the route renders it, within `answerBytes`; each answer within its budget.
function within(h: Harness, focal: string, kind: Kind, answerBytes: number) {
	return async (path: string) => {
		const cursor = cursorOf(path)
		const page = await runInDurableObject(h.store, (_instance, state) =>
			statusPageWithin(
				new Db(state.storage.sql),
				{ handle: 'alice', id: focal, now: NOW, tab: { kind, cursor } },
				SITE,
				answerBytes
			)
		)
		if (page.status !== 'ok' || page.thread === null) {
			throw new Error(page.status)
		}
		expect(jsonBytes({ ...page, site: SITE })).toBeLessThanOrEqual(answerBytes)
		return String(
			await jsx(StatusPage, {
				status: page.value,
				parent: page.parent,
				history: page.history,
				site: SITE,
				thread: { ...page.thread, cursor },
			}).toString()
		)
	}
}

// The frame a tab's answer reserves, stated apart from the read's own: the list's stub for a list of statuses, none
// for a list of accounts.
function frameBytes(kind: Kind): number {
	const list: TabList =
		kind === 'quotes' ? { kind, statuses: [], stub: LONGEST_STATUS_STUB, parents: {} } : { kind, accounts: [] }
	return jsonBytes({
		status: 'ok',
		value: null,
		parent: null,
		thread: { ancestors: [], list, paging: LONGEST_PAGING },
		history: { versions: [], leftOut: Number.MAX_SAFE_INTEGER },
		site: SITE,
	})
}

describe('a status page’s interaction tabs within the page budget (design §2, §4)', () => {
	// 70 boosters and favouriters of about 3 kB of JSON each, every seventh about 20 kB, and 30 quotes of about 5 kB,
	// every fifth about 30 kB: within 45 kB past the head, pages cut short by bytes, each continuing from its last
	// item; a quote past what the head leaves is its stub, and the next page starts past it.
	it('walk to both ends through byte cuts and stubs', async () => {
		const h = await community(['alice', 'bob'])
		const focal = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
		const expected = await runInDurableObject(h.store, (_instance, state) => {
			const s = state.storage.sql
			const accounts: string[] = []
			const statuses: string[] = []
			let nextStatus = BigInt(focal) + 1000n
			for (let i = 0; i < 70; i++) {
				const id = remoteIn(s, `m${i}`)
				s.exec('UPDATE accounts SET note = ? WHERE id = ?', `<p>${'x'.repeat(i % 7 === 3 ? 20_000 : 3_000)}</p>`, id)
				statusIn(s, { id: String(nextStatus++), account: id, local: false, visibility: 'public', reblogOf: focal })
				s.exec('INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', id, focal)
				accounts.unshift(`https://remote.example/@m${i}`)
			}
			for (let i = 0; i < 30; i++) {
				const id = String(nextStatus++)
				const chars = i === 12 ? 60_000 : i % 5 === 2 ? 30_000 : 5_000
				statusIn(s, {
					id,
					account: h.users.bob.id,
					local: true,
					visibility: 'public',
					content: `<p>${'x'.repeat(chars)}</p>`,
				})
				quoteIn(s, id, focal, 'accepted')
				statuses.unshift(`/@bob/${id}`)
			}
			return { accounts, statuses }
		})
		const head = await runInDurableObject(h.store, (_instance, state) =>
			statusPageWithin(
				new Db(state.storage.sql),
				{ handle: 'alice', id: focal, now: NOW, tab: null },
				SITE,
				ANSWER_BYTES
			)
		)
		if (head.status !== 'ok') {
			throw new Error(head.status)
		}
		const headBytes = jsonBytes(head.value) + jsonBytes(head.parent)
		for (const kind of ['reblogs', 'favourites', 'quotes'] as const) {
			const get = within(h, focal, kind, frameBytes(kind) + headBytes + 45_000)
			const shown = kind === 'quotes' ? shownQuoteTab : shownAccountTab
			const walked = await walkPages(get, `/@alice/${focal}/${kind}`, shown)
			const want = kind === 'quotes' ? expected.statuses : expected.accounts
			expect([kind, walked.down]).toEqual([kind, want])
			expect([kind, walked.up]).toEqual([kind, want])
			// Cut by bytes: pages that link on with fewer than a page.
			const size = kind === 'quotes' ? QUOTES_PAGE_SIZE : INTERACTORS_PAGE_SIZE
			expect([kind, walked.sizes.slice(0, -1).some((n) => n > 0 && n < size)]).toEqual([kind, true])
			if (kind === 'quotes') {
				// The quote past 45 kB is its page's one item, a stub (a compact row: no body), on both walks.
				const stubs = walked.pages.map((html) => {
					const feed = query(one(parseHtml(html), 'main'), 'ul', 'feed')[0]
					const cards = feed === undefined ? [] : query(feed, 'article')
					return cards.filter((card) => query(card, 'div', 'body').length === 0).length
				})
				expect(stubs.filter((n) => n > 0)).toEqual([1, 1])
			}
		}
	}, 120_000)

	// The rule of the account tabs (budget.ts accountList): the first account is admitted whatever the head leaves, and
	// the rest strictly, so a page whose head passes its page budget holds the head and one account, and moves on past
	// it. Its ceiling, the head and an account each at its derived bound beside the frame, is derived in
	// test/status-bounds.test.ts ("keeps the profile feed within WEB_PAGE_BYTES, …").
	it('admit the first account beside a head past the page budget', async () => {
		const h = await community(['alice'])
		const focal = await seedStatus(h.store, {
			accountId: h.users.alice.id,
			visibility: 'public',
			content: `<p>${'x'.repeat(50_000)}</p>`,
		})
		await runInDurableObject(h.store, (_instance, state) => {
			const s = state.storage.sql
			for (let i = 0; i < 3; i++) {
				const id = remoteIn(s, `big${i}`)
				statusIn(s, {
					id: String(BigInt(focal) + 1n + BigInt(i)),
					account: id,
					local: false,
					visibility: 'public',
					reblogOf: focal,
				})
			}
		})
		const page = await runInDurableObject(h.store, (_instance, state) =>
			statusPageWithin(
				new Db(state.storage.sql),
				{ handle: 'alice', id: focal, now: NOW, tab: { kind: 'reblogs', cursor: null } },
				SITE,
				frameBytes('reblogs') + 10_000
			)
		)
		if (page.status !== 'ok' || page.thread === null || page.thread.list.kind !== 'reblogs') {
			throw new Error(page.status)
		}
		expect(page.thread.list.accounts.map((account) => account.username)).toEqual(['big2'])
		expect(page.thread.paging).toEqual({
			newest: String(BigInt(focal) + 3n),
			oldest: String(BigInt(focal) + 3n),
			more: true,
		})
	})
})

describe('a status page’s tabs as pages (design §3, §4, §5, §14)', () => {
	it('name each tab by its count, link the focal post’s counts to them, and mark the current one', async () => {
		const h = await community(['alice', 'bob'])
		const focal = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
		await sql(
			h.store,
			'UPDATE statuses SET replies_count = 2, reblogs_count = 3, favourites_count = 0 WHERE id = ?',
			focal
		)
		const base = `/@alice/${focal}`
		for (const [path, current] of [
			[base, base],
			[`${base}/reblogs`, `${base}/reblogs`],
			[`${base}/favourites`, `${base}/favourites`],
			[`${base}/quotes`, `${base}/quotes`],
		] as const) {
			const doc = parseHtml(await viaRoute(h)(path))
			const tabs = one(doc, 'nav', 'tabs')
			expect([
				path,
				attr(tabs, 'aria-label'),
				query(tabs, 'a').map((a) => [attr(a, 'href'), text(a), attr(a, 'aria-current')]),
			]).toEqual([
				path,
				STRINGS.a11y.statusSections,
				[
					[base, '2 replies', current === base ? 'page' : null],
					[`${base}/reblogs`, '3 boosts', current.endsWith('/reblogs') ? 'page' : null],
					[`${base}/favourites`, '0 favourites', current.endsWith('/favourites') ? 'page' : null],
					[`${base}/quotes`, '0 quotes', current.endsWith('/quotes') ? 'page' : null],
				],
			])
			// The focal post's counts link to the tabs, each named by its label (quotes, at 0, are not shown).
			const counts = query(one(doc, 'article', 'focal'), 'div', 'counts')[0]!
			expect(query(counts, 'a').map((a) => [attr(a, 'href'), attr(a, 'aria-label')])).toEqual([
				[base, '2 replies'],
				[`${base}/reblogs`, '3 boosts'],
				[`${base}/favourites`, '0 favourites'],
			])
		}
		// Each empty tab shows its empty line, and no pager link.
		for (const [kind, line] of [
			['reblogs', STRINGS.post.noBoosts],
			['favourites', STRINGS.post.noFavourites],
		] as const) {
			expect(shownAccountTab(await viaRoute(h)(`${base}/${kind}`))).toEqual({
				items: [],
				newer: null,
				older: null,
				cursors: [],
				empty: [line],
			})
		}
		expect(shownQuoteTab(await viaRoute(h)(`${base}/quotes`)).empty).toEqual([STRINGS.post.noQuotes])
		// Past the oldest: only the pager, back to the items above it.
		expect(shownAccountTab(await viaRoute(h)(`${base}/reblogs?max_id=5`))).toEqual({
			items: [],
			newer: `${base}/reblogs?min_id=4`,
			older: null,
			cursors: ['4'],
			empty: [],
		})
	})

	it('mark a page with a cursor noindex, follow, with the tab’s cursor-less URL canonical, and load the L1 bundle', async () => {
		const h = await community(['alice'])
		const focal = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
		const replies = await h.request(`/@alice/${focal}`)
		const csp = replies.headers.get('content-security-policy')
		await replies.arrayBuffer()
		for (const kind of ['reblogs', 'favourites', 'quotes'] as const) {
			const path = `/@alice/${focal}/${kind}`
			for (const [q, robots] of [
				['', []],
				['?max_id=200000000000000000', ['noindex, follow']],
				['?min_id=1', ['noindex, follow']],
				['?max_id=x1', []],
			] as const) {
				const response = await h.request(path + q)
				const doc = parseHtml(await response.text())
				expect([path + q, response.status]).toEqual([path + q, 200])
				expect(
					query(doc, 'meta')
						.filter((m) => attr(m, 'name') === 'robots')
						.map((m) => attr(m, 'content'))
				).toEqual(robots)
				expect(
					query(doc, 'link')
						.filter((l) => attr(l, 'rel') === 'canonical')
						.map((l) => attr(l, 'href'))
				).toEqual([`https://kopje.test${path}`])
				// The same headers as the Replies tab: the L1 bundle's CSP, cached as a public page, varying with Accept.
				expect(response.headers.get('content-security-policy')).toBe(csp)
				expect(query(doc, 'script')).toHaveLength(1)
				expect(response.headers.get('cache-control')).toBe('public, max-age=60')
				expect(response.headers.get('vary')).toBe('Accept')
			}
			// HTML only: an ActivityPub client is served the same page.
			const activityPub = await h.request(path, { headers: { accept: 'application/activity+json' } })
			expect([path, activityPub.status, activityPub.headers.get('content-type')]).toEqual([
				path,
				200,
				'text/html; charset=UTF-8',
			])
		}
		expect(csp).toContain('script-src')
	})

	it('answer the same 404 bytes for every hidden or unknown status, and move a legacy id to the same tab', async () => {
		const h = await community(['alice', 'bob'])
		const { alice } = h.users
		const missing = await (await h.request('/@nobody')).text()
		const hidden: string[] = []
		for (const visibility of ['private', 'direct', 'limited'] as const) {
			hidden.push(await seedStatus(h.store, { accountId: alice.id, visibility }))
		}
		const shown = await seedStatus(h.store, { accountId: alice.id, visibility: 'public' })
		hidden.push(await seedStatus(h.store, { accountId: alice.id, visibility: 'public', reblogOfId: shown }))
		for (const kind of ['reblogs', 'favourites', 'quotes'] as const) {
			for (const path of [
				...hidden.map((id) => `/@alice/${id}/${kind}`),
				`/@bob/${shown}/${kind}`,
				`/@alice/1/${kind}`,
				`/@alice@other.example/${shown}/${kind}`,
			]) {
				const response = await h.request(path)
				expect([path, response.status, await response.text()]).toEqual([path, 404, missing])
			}
			// The guarded branch: the same shape of a status the page shows answers.
			expect((await h.request(`/@alice/${shown}/${kind}`)).status).toBe(200)
		}
		const legacy = '0123abcd-0000-4000-8000-000000000001'
		await sql(h.store, 'UPDATE statuses SET legacy_id = ? WHERE id = ?', legacy, shown)
		for (const kind of ['reblogs', 'favourites', 'quotes'] as const) {
			const response = await h.request(`/@alice/${legacy}/${kind}`)
			expect([kind, response.status, response.headers.get('location')]).toEqual([kind, 301, `/@alice/${shown}/${kind}`])
		}
	})

	it('read each page and the site facts in one Store call', async () => {
		const { h, calls } = await countedHarness(['alice'])
		const focal = await seedStatus(h.store, { accountId: h.users.alice.id, visibility: 'public' })
		for (const [path, status] of [
			[`/@alice/${focal}/reblogs`, 200],
			[`/@alice/${focal}/favourites?max_id=1`, 200],
			[`/@alice/${focal}/quotes?min_id=1`, 200],
			[`/@alice/1/quotes`, 404],
		] as const) {
			expect([path, await calls(path)]).toEqual([path, { status, calls: ['webStatusPage'] }])
		}
	})
})

describe('a status page’s interaction tabs’ reads (RES-7, docs/visibility.md "Read bounds")', () => {
	// Each tab's statements with statistics taken before the Store grew: the window seeks its index from the cursor
	// (statuses_reblogged_by, favourites_status, quotes_accepted), never scanning statuses, favourites or quotes, and
	// fills its cap (readWindow(40) = 120 for the accounts, 20 for the quotes: candidates a third of them shown, the rest
	// by a suspended account); a page reads the same rows with 40 or 4,000 boosts no window reads (private, direct and
	// limited), favourites and accepted quotes of other posts, and quotes of the post in other states, among them.
	it('seek each tab’s index from the cursor both ways, with stale statistics', async () => {
		const h = await community(['alice', 'bob', 'dave'])
		const { alice, bob, dave } = h.users
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			dave.id
		)
		const focal = await seedStatus(h.store, { accountId: alice.id, visibility: 'public', published: NOW - 86_400_000 })
		const other = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: NOW - 86_300_000 })
		const spacing = 100_000n
		const base = BigInt(focal) + 1_000_000n
		const windows = { reblogs: 120, favourites: 120, quotes: 20 }
		const seeded = await runInDurableObject(h.store, (_instance, state) => {
			const s = state.storage.sql
			const boosts: { id: string; shown: boolean }[] = []
			const favourites: { id: string; shown: boolean }[] = []
			const quoting: { id: string; shown: boolean }[] = []
			for (let i = 0; i < 6 * 40; i++) {
				const shown = i % 3 === 0
				const account = shown ? remoteIn(s, `r${i}`) : remoteIn(s, `s${i}`, 'remote.example', '', true)
				const boost = String(base + BigInt(i) * spacing)
				statusIn(s, {
					id: boost,
					account,
					local: false,
					visibility: i % 4 === 1 ? 'unlisted' : 'public',
					reblogOf: focal,
				})
				boosts.push({ id: boost, shown })
				s.exec('INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', account, focal)
				favourites.push({ id: String(s.exec<{ id: number }>('SELECT last_insert_rowid() AS id').one().id), shown })
				if (i < 6 * 20) {
					const id = String(base + BigInt(i) * spacing + 1n)
					statusIn(s, { id, account: shown ? bob.id : dave.id, local: true, visibility: 'public' })
					quoteIn(s, id, focal, 'accepted')
					quoting.push({ id, shown })
				}
			}
			return { reblogs: boosts, favourites, quotes: quoting }
		})
		// Rows no window of the post reads, between the candidates (each by an id past a candidate's).
		let n = 0
		const hidden = async (count: number) => {
			await runInDurableObject(h.store, (_instance, state) => {
				const s = state.storage.sql
				for (let i = 0; i < count; i++, n++) {
					const gap = seeded.reblogs[n % (seeded.reblogs.length - 1)]!.id
					const id = String(BigInt(gap) + 2n + BigInt(Math.floor(n / (seeded.reblogs.length - 1))))
					const account = remoteIn(s, `h${n}`)
					const kind = n % 4
					if (kind < 3) {
						statusIn(s, {
							id,
							account,
							local: false,
							visibility: ['private', 'direct', 'limited'][kind]!,
							reblogOf: focal,
						})
					} else {
						statusIn(s, { id, account, local: false, visibility: 'public' })
						quoteIn(s, id, n % 8 === 3 ? other : focal, n % 8 === 3 ? 'accepted' : 'pending')
					}
					s.exec('INSERT INTO favourites (account_id, status_id) VALUES (?, ?)', account, other)
				}
			})
		}
		await hidden(40)
		const capture = async () => {
			let rows = 0
			for (const kind of ['reblogs', 'favourites', 'quotes'] as const) {
				const candidates = seeded[kind]
				const size = windows[kind]
				const cursors = [
					{ cursor: { maxId: candidates.at(-3)!.id }, window: candidates.slice(-3 - size, -3).toReversed() },
					{ cursor: { minId: candidates[2]!.id }, window: candidates.slice(3, 3 + size) },
				]
				for (const { cursor, window } of cursors) {
					const run = await runInDurableObject(h.store, (_instance, state) => {
						const plans: PlannedStatement[] = []
						const page = statusPageWithin(
							new Db(plannedSql(state.storage.sql, /\b(?:statuses [ers]|favourites [ef]|quotes q)\b/, plans)),
							{ handle: 'alice', id: focal, now: NOW, tab: { kind, cursor } },
							SITE,
							WEB_PAGE_BYTES
						)
						return { plans, page }
					})
					if (run.page.status !== 'ok' || run.page.thread === null) {
						throw new Error(run.page.status)
					}
					const { list } = run.page.thread
					const shownCount = window.filter((c) => c.shown).length
					expect([kind, 'accounts' in list ? list.accounts.length : list.statuses.length]).toEqual([
						kind,
						Math.min(shownCount, kind === 'quotes' ? QUOTES_PAGE_SIZE : INTERACTORS_PAGE_SIZE),
					])
					expect([kind, run.page.thread.paging.more]).toEqual([kind, true])
					const index = {
						reblogs: 'statuses_reblogged_by',
						favourites: 'favourites_status',
						quotes: 'quotes_accepted',
					}[kind]
					const seek = run.plans.find((statement) =>
						statement.plan.some((d) => new RegExp(`USING (?:COVERING )?INDEX ${index}`).test(d))
					)
					// The quotes' window reads each candidate's index entry and its status's row (its audience).
					expect([kind, seek?.rows]).toEqual([kind, kind === 'quotes' ? 2 * size : size])
					for (const statement of run.plans) {
						expect([
							kind,
							scansOf(statement.plan, ['r', 'f', 'q', 'e', 's', 'statuses', 'favourites', 'quotes']),
						]).toEqual([kind, []])
					}
					rows += run.plans.reduce((sum, statement) => sum + statement.rows, 0)
				}
			}
			return rows
		}
		const { before, after } = await staleStatistics(h, { capture, grow: () => hidden(3960) })
		expect(after).toBe(before)
		// The guarded branch ran: the rows past the candidates are boosts of the post no window reads, and quotes and
		// favourites the windows skip.
		const [counts] = (await sql<{ boosts: number; quotes: number; favourites: number }>(
			h.store,
			`SELECT (SELECT count(*) FROM statuses WHERE reblog_of_id = ?1 AND visibility IN ('private', 'direct', 'limited')) AS boosts,
				(SELECT count(*) FROM quotes WHERE quoted_status_id = ?1 AND state = 'pending') AS quotes,
				(SELECT count(*) FROM favourites WHERE status_id = ?2) AS favourites`,
			focal,
			other
		)) as [{ boosts: number; quotes: number; favourites: number }]
		expect(counts).toEqual({ boosts: 3000, quotes: 500, favourites: 4000 })
	}, 300_000)
})
