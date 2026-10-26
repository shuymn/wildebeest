import { runInDurableObject } from 'cloudflare:test'

import { jsx } from 'hono/jsx'
import { describe, expect, it } from 'vitest'

import { setSetting, sql } from './api-helpers'
import { countingStore, NOW } from './app-helpers'
import { C } from './budget-helpers'
import { blockDomain } from './domain-block-helpers'
import { accountAtCap } from './emoji-fixtures'
import { BUILD } from './helpers'
import { fullestFields, MAX_BIO, movedAtCaps } from './profile-fixtures'
import { pagerLinks, viaRoute, walkPages } from './profile-page-helpers'
import { observedSql, type PlannedStatement, plannedSql, scansOf, staleStatistics } from './read-helpers'
import { community } from './status-helpers'
import { accessibleName, attr, one, parseHtml, query, text } from './web-dom'
import { Db } from '../src/db/sql'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { MAX_FEATURED_TAGS } from '../src/domain/featured-tags'
import { USERNAME_LIMIT } from '../src/domain/profile-bounds'
import { TAG_NAME_JSON_BYTES } from '../src/domain/tag-bounds'
import {
	ENDORSEMENTS_PAGE_SIZE,
	type FeaturedPage as FeaturedAnswer,
	featuredPageWithin,
	type FeaturedTagLink,
} from '../src/domain/web-pages/featured'
import { LONGEST_PAGING, pageCursor } from '../src/domain/web-pages/paging'
import type { Site } from '../src/domain/web-pages/site'
import { ACTOR_URI_LIMIT, DOMAIN_BYTES } from '../src/platform/identity-bounds'
import type { StoreStub } from '../src/platform/store-client'
import {
	MAX_ACCOUNT_COUNT,
	MAX_FIELD_NAME,
	MAX_FIELD_VALUE,
	MAX_FIELDS,
	PROFILE_URL_LIMIT,
	VERIFIED_LINKS_BYTES,
} from '../src/platform/stored-bounds'
import { FeaturedPage } from '../src/web/pages/featured'
import { STRINGS } from '../src/web/strings'

// The profile's Featured tab (design §3, §4, §17 PR 6): /@user/featured shows a local account's featured hashtags and
// the accounts it endorses, to an anonymous viewer (VIS-4, R28), the endorsements paged both ways by account id.

type Harness = Awaited<ReturnType<typeof community>>

const SITE: Site = { domain: 'kopje.test', documents: { privacyPolicy: false, termsOfService: false } }

// The conservative JSON of one presented account, every column at its bound ("Maxima of presented units" in
// docs/threat-model.md; test/status-bounds.test.ts, "keeps the conservative JSON of every shape within 85%").
const ACCOUNT_JSON_MAX = 147_990

// The most one featured hashtag of a page takes, from the bounds of what it presents (featured-tags.ts presentFeatured,
// web-pages/featured.ts): an id of 18 digits; a name within the list's bound (TAG_NAME_JSON_BYTES as JSON); its tagged
// URL on the instance origin, a username of USERNAME_LIMIT escaping characters and the stored name percent-encoded (at
// most 1,024 UTF-8 bytes, 3 bytes each); a count of 16 digits; a date cut to 10 UTF-16 code units, each escaped to 6
// bytes; and the hashtag page's name within the same bound as the name.
const FEATURED_TAG_JSON_MAX =
	jsonBytes({
		featured: {
			id: '9'.repeat(18),
			name: '',
			url: `https://${SITE.domain}/@${C.repeat(USERNAME_LIMIT)}/tagged/${'%FF'.repeat(1024)}`,
			statuses_count: '9'.repeat(16),
			last_status_at: C.repeat(10),
		},
		tag: '',
	}) +
	2 * TAG_NAME_JSON_BYTES +
	1

const NOW_ISO = new Date(NOW).toISOString()

let nextAccount = 700_000_000_000_000_000n

// A remote account of `domain`, its id; its profile link derives from its actor id.
async function remote(h: Harness, username: string, domain = 'remote.example', displayName = ''): Promise<string> {
	const id = String(nextAccount++)
	await sql(
		h.store,
		'INSERT INTO accounts (id, uri, username, domain, display_name) VALUES (?, ?, ?, ?, ?)',
		id,
		`https://${domain}/users/${username}`,
		username,
		domain,
		displayName
	)
	return id
}

// `owner` endorses `target`, with the accepted follow an endorsement needs.
async function endorse(h: Harness, owner: string, target: string) {
	await sql(
		h.store,
		"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
		owner,
		target
	)
	await sql(h.store, 'INSERT INTO account_pins (account_id, target_account_id) VALUES (?, ?)', owner, target)
}

// A featured hashtag row of `owner`, as a writer or an import leaves it.
async function feature(
	h: Harness,
	owner: string,
	id: number,
	tag: { name: string; display: string; count?: number; last?: string | null }
) {
	await sql(
		h.store,
		`INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count, last_status_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		String(800_000_000_000_000_000n + BigInt(id)),
		owner,
		tag.name,
		tag.display,
		tag.count ?? 0,
		tag.last ?? null
	)
}

// What a page shows: its hashtags (name, link, count), its endorsed accounts (each row's profile link), its pager and
// its empty lines.
function shown(html: string) {
	const main = one(parseHtml(html), 'main')
	const tags = query(main, 'ul', 'hashtags')[0]
	const list = query(main, 'ul', 'accounts')[0]
	return {
		tags:
			tags === undefined
				? []
				: query(tags, 'li').map((li) => {
						const link = query(li, 'a')[0]
						return {
							name: text(link ?? query(li, 'span', 'name')[0]!),
							href: link === undefined ? null : attr(link, 'href'),
							count: text(query(li, 'span', 'count')[0]!),
						}
					}),
		items:
			list === undefined
				? []
				: query(list, 'li').map((li) => {
						const link = query(li, 'a', 'name')[0]
						expect(link, 'a row links its account').toBeDefined()
						return attr(link!, 'href') ?? ''
					}),
		...pagerLinks(main, { newer: STRINGS.featured.previous, older: STRINGS.featured.next }),
		empty: query(main, 'p', 'empty').map(text),
	}
}

const walk = (get: (url: string) => Promise<string>, base: string) => walkPages(get, base, shown)

type FeaturedOk = Extract<FeaturedAnswer, { status: 'ok' }>

function readWithin(h: Harness, path: string, answerBytes: number): Promise<FeaturedOk> {
	const url = new URL(path, 'https://kopje.test')
	const cursor = pageCursor(url.searchParams.get('max_id'), url.searchParams.get('min_id'))
	return runInDurableObject(h.store, (_instance, state) => {
		const page = featuredPageWithin(new Db(state.storage.sql), { handle: 'alice', cursor }, SITE, answerBytes)
		if (page.status !== 'ok') {
			throw new Error(page.status)
		}
		return page
	})
}

// A walk of the read within `answerBytes`, rendered as the route renders it; each answer within its budget.
function within(h: Harness, answerBytes: number) {
	return async (path: string) => {
		const url = new URL(path, 'https://kopje.test')
		const page = await readWithin(h, path, answerBytes)
		expect(jsonBytes({ ...page, site: SITE })).toBeLessThanOrEqual(answerBytes)
		return String(
			await jsx(FeaturedPage, {
				account: page.account,
				tags: page.tags,
				accounts: page.accounts,
				cursor: pageCursor(url.searchParams.get('max_id'), url.searchParams.get('min_id')),
				paging: page.paging,
				site: SITE,
			}).toString()
		)
	}
}

// The frame a Featured answer reserves (design §2), stated apart from the read's own.
function frameBytes(site: Site): number {
	return jsonBytes({ status: 'ok', account: null, tags: [], accounts: [], paging: LONGEST_PAGING, site })
}

// Every account the API lists of alice's endorsements to an anonymous client, by its own pages (limit 40) and their
// next links, an empty page's included.
async function apiEndorsements(h: Harness, alice: string): Promise<string[]> {
	const ids: string[] = []
	let path: string | null = `/api/v1/accounts/${alice}/endorsements`
	for (let i = 0; path !== null; i++) {
		expect(i).toBeLessThan(100)
		const response: Response = await h.request(path)
		expect(response.status).toBe(200)
		const page = await response.json<{ id: string }[]>()
		ids.push(...page.map((account) => account.id))
		const next = /<([^>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
		path = next === undefined ? null : new URL(next).pathname + new URL(next).search
	}
	return ids
}

// alice's endorsements, with what each shows: available accounts (local, remote and one that moved) between runs of
// accounts R28 leaves out, one run longer than two candidate windows (readWindow(40) = 120): remote accounts suspended
// by the instance, accounts on a domain the instance blocks, and a suspended local account.
async function world() {
	const h = await community(['alice', 'bob', 'secretcarol'])
	const { alice, bob, secretcarol } = h.users
	await sql(
		h.store,
		'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
		new Date(NOW).toISOString(),
		secretcarol.id
	)
	await blockDomain(h.store, 'blocked.example')
	const visible: { id: string; href: string }[] = []
	const hiddenIds: string[] = []
	let n = 0
	const shownRun = async (count: number) => {
		for (let i = 0; i < count; i++) {
			const name = `v${n++}`
			const id = await remote(h, name)
			await endorse(h, alice.id, id)
			visible.push({ id, href: `https://remote.example/@${name}` })
		}
	}
	const hiddenRun = async (count: number) => {
		for (let i = 0; i < count; i++) {
			const name = `secret${n++}`
			const suspended = i % 3 !== 0
			const id = await remote(h, name, suspended ? 'remote.example' : 'blocked.example', `HIDDEN ${name}`)
			if (suspended) {
				await sql(
					h.store,
					"UPDATE accounts SET suspended_at = '2026-01-01T00:00:00.000Z', suspension_source = 'account' WHERE id = ?",
					id
				)
			}
			hiddenIds.push(id)
			await endorse(h, alice.id, id)
		}
	}
	await shownRun(30)
	await endorse(h, alice.id, bob.id)
	visible.push({ id: bob.id, href: '/@bob' })
	await endorse(h, alice.id, secretcarol.id)
	hiddenIds.push(secretcarol.id)
	await hiddenRun(300)
	await shownRun(25)
	// An account that moved is listed, as the API lists it.
	const moved = await remote(h, 'movedaway')
	await movedAtCaps(h.store, [moved], 760_000_000_000_000_000n)
	await endorse(h, alice.id, moved)
	visible.push({ id: moved, href: 'https://remote.example/@movedaway' })
	await hiddenRun(130)
	await shownRun(30)
	const expected = visible.toSorted((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
	return { h, expected, hiddenIds }
}

// What `html` names of the accounts no page may show: their names anywhere, their ids anywhere but a pager's links. A
// pager's cursor is the API's, a candidate's account id: a window cut in a run of left-out accounts continues from
// its last candidate (docs/visibility.md, "Read bounds"), as the API's Link header does.
function leaks(html: string, hiddenIds: readonly string[]): string[] {
	const pager = query(one(parseHtml(html), 'main'), 'nav', 'pager').flatMap((nav) =>
		query(nav, 'a').map((a) => attr(a, 'href') ?? '')
	)
	let rest = html
	for (const href of pager) {
		rest = rest.replaceAll(`href="${href}"`, '')
	}
	return [...['HIDDEN', 'secret'].filter((word) => html.includes(word)), ...hiddenIds.filter((id) => rest.includes(id))]
}

describe('the Featured tab’s endorsed accounts (design §3, §4, R28)', () => {
	it('walk to both ends in account id order, past runs of left-out accounts longer than two windows', async () => {
		const { h, expected, hiddenIds } = await world()
		expect(expected.length).toBeGreaterThan(2 * ENDORSEMENTS_PAGE_SIZE)
		const walked = await walk(viaRoute(h), '/@alice/featured')
		expect(walked.down).toEqual(expected.map((account) => account.href))
		expect(walked.up).toEqual(expected.map((account) => account.href))
		// The runs of left-out accounts pass more than one window with nothing shown, and each such page links on.
		expect(walked.sizes.join(' ')).toMatch(/\b0 0\b/)
		// The whole HTML of every page names no left-out account (leaks).
		for (const html of walked.pages) {
			expect(leaks(html, hiddenIds)).toEqual([])
		}
		// The API lists the same accounts in the same order to an anonymous client, and the left-out ones are rows of
		// alice's endorsements (the guarded branch ran).
		expect(await apiEndorsements(h, h.users.alice.id)).toEqual(expected.map((account) => account.id))
		const [rows] = (await sql<{ n: number }>(
			h.store,
			'SELECT count(*) AS n FROM account_pins WHERE account_id = ? AND target_account_id IN (SELECT value FROM json_each(?))',
			h.users.alice.id,
			JSON.stringify(hiddenIds)
		)) as [{ n: number }]
		expect(rows.n).toBe(hiddenIds.length)
	}, 300_000)

	it('walk through byte cuts, each page continuing from its last account', async () => {
		const h = await community(['alice'])
		const expected: string[] = []
		for (let i = 0; i < 70; i++) {
			const name = `m${i}`
			const id = await remote(h, name)
			// About 3 kB of JSON each, every seventh about 20 kB.
			await sql(
				h.store,
				'UPDATE accounts SET note = ? WHERE id = ?',
				`<p>${'x'.repeat(i % 7 === 3 ? 20_000 : 3_000)}</p>`,
				id
			)
			await endorse(h, h.users.alice.id, id)
			expected.unshift(`https://remote.example/@${name}`)
		}
		await feature(h, h.users.alice.id, 1, { name: 'cats', display: 'Cats', count: 3 })
		const first = await readWithin(h, '/@alice/featured', ANSWER_BYTES)
		const get = within(h, frameBytes(SITE) + jsonBytes(first.account) + jsonBytes(first.tags) + 45_000)
		const walked = await walk(get, '/@alice/featured')
		expect(walked.down).toEqual(expected)
		expect(walked.up).toEqual(expected)
		// Cut by bytes: pages that link on with fewer than 40.
		expect(walked.sizes.slice(0, -1).some((size) => size > 0 && size < ENDORSEMENTS_PAGE_SIZE)).toBe(true)
		// The hashtags lead every page.
		for (const html of walked.pages) {
			expect(shown(html).tags.map((tag) => tag.name)).toEqual(['Cats'])
		}
	}, 120_000)
})

describe('the Featured tab’s hashtags (design §3)', () => {
	it('shows at most ten, as the API lists them, each linked to its hashtag page with the API’s count', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// Twelve rows, as an import may hold (a writer keeps ten): the page shows the first ten by id. Among them a
		// spelling of a name (its page is the normalized one) and an imported name that is not a hashtag (no page).
		const rows = [
			{ name: 'cafe', display: 'Café', count: 1, last: '2026-10-01T00:00:00.000Z' },
			{ name: 'ab', display: 'a-b', count: 0 },
			...Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, display: `T${i}`, count: 1000 + i })),
		]
		for (const [i, row] of rows.entries()) {
			await feature(h, alice.id, i + 1, row)
		}
		const html = await (await h.request('/@alice/featured')).text()
		const page = shown(html)
		expect(page.tags).toEqual(
			rows.slice(0, MAX_FEATURED_TAGS).map((row, i) => ({
				name: row.display,
				href: i === 1 ? null : `/tags/${row.name}`,
				count: STRINGS.featured.posts(row.count),
			}))
		)
		expect(page.tags.map((tag) => tag.count).slice(0, 3)).toEqual(['1 post', '0 posts', '1,000 posts'])
		// The API answers every row, unchanged; the page's counts are its counts.
		const api = await (
			await h.request(`/api/v1/accounts/${alice.id}/featured_tags`)
		).json<{ name: string; statuses_count: string; url: string; last_status_at: string | null }[]>()
		expect(api.map((tag) => tag.name)).toEqual(rows.map((row) => row.display))
		expect(api.slice(0, MAX_FEATURED_TAGS).map((tag) => STRINGS.featured.posts(Number(tag.statuses_count)))).toEqual(
			page.tags.map((tag) => tag.count)
		)
		expect(api[0]).toEqual({
			id: '800000000000000001',
			name: 'Café',
			url: 'https://kopje.test/@alice/tagged/cafe',
			statuses_count: '1',
			last_status_at: '2026-10-01',
		})
		// The link opens the hashtag's page.
		expect((await h.request('/tags/cafe')).status).toBe(200)
		expect((await h.request('/tags/a-b')).status).toBe(404)
	})
})

describe('the Featured tab as a page (design §3, §4, §5, §14)', () => {
	it('shows its headings and empty lines only when nothing is featured, and is the profile’s current tab', async () => {
		const h = await community(['alice'])
		const doc = parseHtml(await (await h.request('/@alice/featured')).text())
		const main = one(doc, 'main')
		expect(query(main, 'h2').map(text)).toEqual([STRINGS.featured.hashtags, STRINGS.featured.accounts])
		expect(query(main, 'p', 'empty').map(text)).toEqual([STRINGS.featured.noHashtags, STRINGS.featured.noAccounts])
		// No other text than the profile card's, the tabs', the headings and the empty lines: no pager, no sentence.
		expect(query(main, 'nav', 'pager')).toEqual([])
		expect(
			query(main, 'p')
				.map((p) => attr(p, 'class'))
				.filter((name) => name !== 'empty' && name !== 'handle')
		).toEqual([])
		const nav = one(main, 'nav', 'tabs')
		expect(accessibleName(nav, doc)).toBe(STRINGS.a11y.profileSections)
		expect(query(nav, 'a').map((a) => [attr(a, 'href'), text(a), attr(a, 'aria-current')])).toEqual([
			['/@alice', 'Posts', null],
			['/@alice/with_replies', 'Posts and replies', null],
			['/@alice/media', 'Media', null],
			['/@alice/featured', 'Featured', 'page'],
		])
		expect(text(one(doc, 'h1'))).toBe('alice')
		// An empty page past the last shows only its pager, back to the accounts above it.
		const bob = await remote(h, 'bob')
		await endorse(h, h.users.alice.id, bob)
		expect(shown(await (await h.request(`/@alice/featured?max_id=${bob}`)).text())).toEqual({
			tags: [],
			items: [],
			newer: `/@alice/featured?min_id=${BigInt(bob) - 1n}`,
			older: null,
			empty: [STRINGS.featured.noHashtags],
		})
	})

	it('marks a page with a cursor noindex, follow, with its cursor-less URL canonical, and sends no script', async () => {
		const h = await community(['alice'])
		for (const [search, robots] of [
			['', []],
			['?max_id=900000000000000000', ['noindex, follow']],
			['?min_id=1', ['noindex, follow']],
			['?max_id=x1', []],
		] as const) {
			const path = `/@alice/featured${search}`
			const response = await h.request(path)
			const doc = parseHtml(await response.text())
			expect([path, response.status]).toEqual([path, 200])
			expect(
				query(doc, 'meta')
					.filter((m) => attr(m, 'name') === 'robots')
					.map((m) => attr(m, 'content'))
			).toEqual(robots)
			expect(
				query(doc, 'link')
					.filter((l) => attr(l, 'rel') === 'canonical')
					.map((l) => attr(l, 'href'))
			).toEqual(['https://kopje.test/@alice/featured'])
			expect(query(doc, 'script')).toEqual([])
			expect(response.headers.get('cache-control')).toBe('public, max-age=60')
			expect(response.headers.get('vary')).toBe('Accept')
			expect(response.headers.get('content-security-policy')).toBe(
				"default-src 'none'; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
			)
		}
		// HTML for an ActivityPub client too.
		const ap = await h.request('/@alice/featured', { headers: { accept: 'application/activity+json' } })
		expect([ap.status, ap.headers.get('content-type')]).toEqual([200, 'text/html; charset=UTF-8'])
	})

	it('answers the same 404 bytes for every account it does not serve, 410 for a suspended one', async () => {
		const h = await community(['alice', 'bob'])
		await remote(h, 'carol')
		const missing = await (await h.request('/@nobody')).text()
		for (const path of [
			'/@nobody/featured',
			'/@carol@remote.example/featured',
			'/@alice@other.example/featured',
			'/@/featured',
		]) {
			const response = await h.request(path)
			expect([path, response.status, await response.text()]).toEqual([path, 404, missing])
		}
		// The guarded branch: the same shapes of a served account answer.
		expect((await h.request('/@alice@kopje.test/featured')).status).toBe(200)
		expect((await h.request('/@ALICE/featured')).status).toBe(200)
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			h.users.bob.id
		)
		const gone = await h.request('/@bob')
		const goneBody = await gone.text()
		expect(gone.status).toBe(410)
		const response = await h.request('/@bob/featured')
		expect([response.status, await response.text()]).toEqual([410, goneBody])
	})

	it('reads each page and the site facts in one Store call', async () => {
		let counter: ReturnType<typeof countingStore> | undefined
		const h = await community(['alice', 'bob'], 'read write follow', {
			wrapStore: (store: StoreStub) => (counter ??= countingStore(store)).stub,
		})
		await endorse(h, h.users.alice.id, h.users.bob.id)
		await feature(h, h.users.alice.id, 1, { name: 'cats', display: 'cats' })
		const calls = async (path: string) => {
			const before = counter?.calls.length ?? 0
			const response = await h.request(path)
			await response.arrayBuffer()
			return { status: response.status, calls: (counter?.calls ?? []).slice(before) }
		}
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			h.users.bob.id
		)
		for (const [path, status] of [
			['/@alice/featured', 200],
			['/@alice/featured?max_id=1', 200],
			['/@alice/featured?min_id=1', 200],
			['/@nobody/featured', 404],
			['/@bob/featured', 410],
		] as const) {
			expect([path, await calls(path)]).toEqual([path, { status, calls: ['webFeaturedPage'] }])
		}
	})
})

describe('the Featured tab at its maxima (design §2, RES-3)', () => {
	// The ceiling: the frame, the account, MAX_FEATURED_TAGS hashtags and a full page of endorsed accounts, each at its
	// maximum (ACCOUNT_JSON_MAX, FEATURED_TAG_JSON_MAX), fit ANSWER_BYTES, so strict admission never leaves a page
	// without an account.
	it('fits ten hashtags and a full page of accounts at their maxima beside the account', () => {
		expect(
			frameBytes(SITE) +
				ACCOUNT_JSON_MAX +
				MAX_FEATURED_TAGS * FEATURED_TAG_JSON_MAX +
				ENDORSEMENTS_PAGE_SIZE * (ACCOUNT_JSON_MAX + 1)
		).toBeLessThanOrEqual(ANSWER_BYTES)
	})

	// A witness through the real Store RPC, every input the page reads filled to its cap at once where one fill can hold
	// it (the ceiling above is the bound). The owner: display name and bio at their caps, profile URL and images at
	// PROFILE_URL_LIMIT, emoji at their presented cap, counts at MAX_ACCOUNT_COUNT, MAX_FIELDS local fields of escaping
	// names and linked values at their limits, each verified. Its username is the page's own handle (a local name, never
	// escaping) and it cannot have moved (a local row holds no moved_to_account_id, migration 0060). Ten hashtags of 256
	// four-byte characters (the name bound in characters and bytes, and a hashtag page's name at the same bound), counts
	// at MAX_ACCOUNT_COUNT and a stored time of escaping characters past its cut. A name of escaping characters would
	// present more JSON but is no hashtag, so its page link is null instead: the two caps exclude each other, and the
	// ceiling counts both. 41 endorsed accounts, each with an actor id at ACTOR_URI_LIMIT, a username at USERNAME_LIMIT
	// on a domain of DOMAIN_BYTES, display name and bio at their caps, profile URL and images at PROFILE_URL_LIMIT, the
	// fullest remote fields, emoji at their presented cap, counts at MAX_ACCOUNT_COUNT, and moved to an account at every
	// cap of a moved-to account.
	it('keeps a real RPC answer at every cap within ANSWER_BYTES, uncut, each account within its maximum', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const atLimit = (prefix: string, limit: number) => prefix.padEnd(limit, 'u')
		await sql(
			h.store,
			`UPDATE accounts SET note = ?, display_name = ?, url = ?, avatar_url = ?, header_url = ?, emojis = ?,
				followers_count = ?7, following_count = ?7, statuses_count = ?7 WHERE id = ?8`,
			MAX_BIO,
			C.repeat(2048),
			atLimit('https://kopje.test/@alice/', PROFILE_URL_LIMIT),
			atLimit('https://kopje.test/a/alice/', PROFILE_URL_LIMIT),
			atLimit('https://kopje.test/h/alice/', PROFILE_URL_LIMIT),
			JSON.stringify(accountAtCap()),
			MAX_ACCOUNT_COUNT,
			alice.id
		)
		// A local field value at its limit that renderFieldValue links: a URL whose path is '&', escaped twice.
		const linked = (i: number) => `https://x.test/${i}`.padEnd(MAX_FIELD_VALUE, '&')
		await sql(
			h.store,
			'UPDATE local_accounts SET fields = ?, verified_links = ? WHERE account_id = ?',
			JSON.stringify(
				Array.from({ length: MAX_FIELDS }, (_, i) => ({ name: C.repeat(MAX_FIELD_NAME), value: linked(i) }))
			),
			JSON.stringify(Array.from({ length: MAX_FIELDS }, (_, i) => [linked(i), NOW_ISO])).padEnd(
				VERIFIED_LINKS_BYTES,
				' '
			),
			alice.id
		)
		await setSetting(h.store, 'privacy_policy', '<p>p</p>')
		await setSetting(h.store, 'terms_of_service', '<p>t</p>')
		await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
		for (let i = 0; i < MAX_FEATURED_TAGS; i++) {
			const name = String.fromCodePoint(0x20000 + i).repeat(256)
			await feature(h, alice.id, i + 1, { name, display: name, count: MAX_ACCOUNT_COUNT, last: C.repeat(1000) })
		}
		const endorsed: string[] = []
		for (let i = 0; i <= ENDORSEMENTS_PAGE_SIZE; i++) {
			const id = String(nextAccount++)
			const domain = `${'d'.repeat(DOMAIN_BYTES - 4)}.com`
			await sql(
				h.store,
				`INSERT INTO accounts (id, uri, username, domain, display_name, note, url, avatar_url, header_url, raw, emojis,
					followers_count, following_count, statuses_count)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?12, ?12, ?12)`,
				id,
				atLimit(`https://${domain}/users/${id}/`, ACTOR_URI_LIMIT),
				`${'u'.repeat(USERNAME_LIMIT - id.length)}${id}`,
				domain,
				C.repeat(2048),
				MAX_BIO,
				atLimit(`https://${domain}/@${id}/`, PROFILE_URL_LIMIT),
				atLimit(`https://${domain}/a/${id}/`, PROFILE_URL_LIMIT),
				atLimit(`https://${domain}/h/${id}/`, PROFILE_URL_LIMIT),
				JSON.stringify({ type: 'Person', attachment: fullestFields() }),
				JSON.stringify(accountAtCap()),
				MAX_ACCOUNT_COUNT
			)
			endorsed.push(id)
		}
		await movedAtCaps(h.store, endorsed, 770_000_000_000_000_000n)
		for (const id of endorsed) {
			await endorse(h, alice.id, id)
		}
		const first = await h.store.webFeaturedPage(BUILD, { handle: 'alice', cursor: null })
		if (first.status !== 'ok') {
			throw new Error(first.status)
		}
		expect(first.site.documents).toEqual({ privacyPolicy: true, termsOfService: true })
		expect(jsonBytes(first)).toBeLessThanOrEqual(ANSWER_BYTES)
		expect(jsonBytes(first.account)).toBeLessThanOrEqual(ACCOUNT_JSON_MAX)
		expect(first.account.fields).toHaveLength(MAX_FIELDS)
		expect(first.tags).toHaveLength(MAX_FEATURED_TAGS)
		for (const tag of first.tags) {
			expect(jsonBytes(tag)).toBeLessThanOrEqual(FEATURED_TAG_JSON_MAX)
			expect([tag.tag, tag.featured.statuses_count, tag.featured.last_status_at]).toEqual([
				tag.featured.name,
				String(MAX_ACCOUNT_COUNT),
				C.repeat(10),
			])
		}
		expect([first.accounts.length, first.paging.more]).toEqual([ENDORSEMENTS_PAGE_SIZE, true])
		for (const account of first.accounts) {
			expect(account.moved).toBeDefined()
			expect(account.followers_count).toBe(MAX_ACCOUNT_COUNT)
			expect(jsonBytes(account)).toBeGreaterThan(100_000)
			expect(jsonBytes(account)).toBeLessThanOrEqual(ACCOUNT_JSON_MAX)
		}
		const second = await h.store.webFeaturedPage(BUILD, { handle: 'alice', cursor: { maxId: first.paging.oldest! } })
		expect(second.status === 'ok' ? second.accounts.length : second.status).toBe(1)
		const tags: FeaturedTagLink[] = second.status === 'ok' ? second.tags : []
		expect(tags).toEqual(first.tags)
	}, 300_000)
})

describe('the Featured tab’s hashtags as imported (RES-2, RES-7)', () => {
	// featured_tags.statuses_count's CHECK (>= 0) admits a TEXT or REAL of any size under INTEGER affinity, and
	// last_status_at has no bound: an import's values. Each read projects them in SQL (presentedCountSql: an integer from
	// 0 to MAX_ACCOUNT_COUNT, else 0; the time cut to its first 40 bytes), so the rows that leave SQLite are small, and
	// the page and the API answer within their budgets.
	it('reads a stored count or time of any size within its bound, for the page and the API', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const huge = '9'.repeat(1 << 20)
		for (let i = 0; i < MAX_FEATURED_TAGS; i++) {
			await feature(h, alice.id, i + 1, { name: `t${i}`, display: `t${i}`, last: `2026-10-0${i % 9}T${huge}` })
		}
		const counts = [huge, '1.5', 'x'.repeat(1 << 20), '18446744073709551616', String(MAX_ACCOUNT_COUNT + 1)]
		for (const [i, count] of counts.entries()) {
			await sql(
				h.store,
				'UPDATE featured_tags SET statuses_count = CAST(? AS TEXT) WHERE id = ?',
				count,
				String(800_000_000_000_000_001n + BigInt(i))
			)
		}
		// The guarded branch: the stored values are past their bounds (a REAL, a TEXT of 1 MiB, an integer past
		// MAX_ACCOUNT_COUNT; each time over 1 MiB).
		const stored = await sql<{ type: string; count: number; time: number }>(
			h.store,
			`SELECT typeof(statuses_count) AS type, length(CAST(statuses_count AS BLOB)) AS count,
				length(CAST(last_status_at AS BLOB)) AS time FROM featured_tags ORDER BY id`
		)
		expect(new Set(stored.map((row) => row.type))).toEqual(new Set(['integer', 'real', 'text']))
		expect(Math.max(...stored.map((row) => row.count))).toBeGreaterThanOrEqual(1 << 20)
		expect(stored[4]!).toEqual({ type: 'integer', count: 16, time: expect.any(Number) })
		expect(Math.min(...stored.map((row) => row.time))).toBeGreaterThan(1 << 20)
		// What leaves SQLite: the rows of every featured_tags read, each within a few hundred bytes.
		const largest = await runInDurableObject(h.store, (_instance, state) => {
			let most = 0
			const db = new Db(
				observedSql(state.storage.sql, (rows, query) => {
					if (/featured_tags f\b/.test(query)) {
						for (const row of rows) {
							most = Math.max(most, jsonBytes(row))
						}
					}
				})
			)
			const page = featuredPageWithin(db, { handle: 'alice', cursor: null }, SITE, ANSWER_BYTES)
			expect(page.status === 'ok' ? page.tags.length : page.status).toBe(MAX_FEATURED_TAGS)
			return most
		})
		expect(largest).toBeLessThan(400)
		const page = await h.request('/@alice/featured')
		expect(page.status).toBe(200)
		expect(shown(await page.text()).tags.map((tag) => tag.count)).toEqual(
			Array.from({ length: MAX_FEATURED_TAGS }, () => STRINGS.featured.posts(0))
		)
		const api = await h.request(`/api/v1/accounts/${alice.id}/featured_tags`)
		const body = await api.text()
		expect(api.status).toBe(200)
		expect(body.length).toBeLessThan(4096)
		expect(
			(JSON.parse(body) as { statuses_count: string; last_status_at: string }[]).map((tag) => [
				tag.statuses_count,
				tag.last_status_at,
			])
		).toEqual(Array.from({ length: MAX_FEATURED_TAGS }, (_, i) => ['0', `2026-10-0${i % 9}`]))
	})

	// The page's hashtag read with statistics taken before the owner's hashtags grew: it seeks featured_tags_account_id
	// from the owner and stops after MAX_FEATURED_TAGS, so it reads the same rows with 12 or 2,012 hashtags of the same
	// owner (an import's; a writer keeps ten), all of them after the first ten in id order.
	it('reads no more rows as the same owner’s imported hashtags grow, with stale statistics', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const grow = async (from: number, count: number) => {
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?3 - 1)
				INSERT INTO featured_tags (id, account_id, name, display_name, statuses_count)
				SELECT printf('%018d', 800000000000000000 + CAST(?2 AS INTEGER) + i), ?1, 'g' || (CAST(?2 AS INTEGER) + i),
					'g' || (CAST(?2 AS INTEGER) + i), i FROM n`,
				alice.id,
				from,
				count
			)
		}
		await grow(1, 12)
		const capture = async () => {
			const run = await runInDurableObject(h.store, (_instance, state) => {
				const plans: PlannedStatement[] = []
				const page = featuredPageWithin(
					new Db(plannedSql(state.storage.sql, /featured_tags f\b/, plans)),
					{ handle: 'alice', cursor: null },
					SITE,
					ANSWER_BYTES
				)
				return { plans, page }
			})
			expect(run.page.status === 'ok' ? run.page.tags.map((tag) => tag.featured.name) : run.page.status).toEqual(
				Array.from({ length: MAX_FEATURED_TAGS }, (_, i) => `g${i + 1}`)
			)
			expect(run.plans).toHaveLength(1)
			const [{ plan, rows }] = run.plans as [PlannedStatement]
			expect(plan).toContain('SEARCH featured_tags USING COVERING INDEX featured_tags_account_id (account_id=?)')
			expect(scansOf(plan, ['f', 'featured_tags', 'a', 'accounts'])).toEqual([])
			return rows
		}
		const { before, after } = await staleStatistics(h, { capture, grow: () => grow(13, 2000) })
		expect(after).toBe(before)
		// The API still answers every row, in id order.
		const api = await (await h.request(`/api/v1/accounts/${alice.id}/featured_tags`)).json<{ name: string }[]>()
		expect(api.map((tag) => tag.name)).toEqual(Array.from({ length: 2012 }, (_, i) => `g${i + 1}`))
	}, 120_000)
})

describe('the Featured tab’s reads (RES-7, docs/visibility.md "Read bounds")', () => {
	// The page's statements on account_pins and featured_tags with statistics taken before the Store grew: the window
	// seeks alice's endorsements from the cursor through account_pins' primary key, the hashtags seek her featured_tags
	// through its (account_id, name) key, never scanning either table or accounts, and a page below a fixed cursor reads
	// the same rows with 20 or 2,020 newer endorsements (most of them of suspended accounts) above it.
	it('seeks from the cursor through the endorsements’ key, with stale statistics', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		for (let i = 0; i < MAX_FEATURED_TAGS; i++) {
			await feature(h, alice.id, i + 1, { name: `t${i}`, display: `t${i}`, count: i })
		}
		for (let i = 0; i < 2 * ENDORSEMENTS_PAGE_SIZE; i++) {
			await endorse(h, alice.id, await remote(h, `below${i}`))
		}
		const [{ id: cursor }] = (await sql<{ id: string }>(
			h.store,
			'SELECT max(target_account_id) AS id FROM account_pins'
		)) as [{ id: string }]
		const newer = async (count: number, base: string) => {
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain, suspended_at, suspension_source)
				SELECT printf('%018d', CAST(?2 AS INTEGER) + i), 'https://grown.example/users/g' || i || '-' || ?2, 'g' || i || 'x' || ?2, 'grown.example',
					CASE WHEN i % 4 = 0 THEN NULL ELSE '2026-01-01T00:00:00.000Z' END,
					CASE WHEN i % 4 = 0 THEN NULL ELSE 'account' END FROM n`,
				count,
				base
			)
			await sql(
				h.store,
				`INSERT INTO account_pins (account_id, target_account_id)
				SELECT ?1, a.id FROM accounts a WHERE a.domain = 'grown.example' AND a.id > printf('%018d', CAST(?2 AS INTEGER))`,
				alice.id,
				base
			)
		}
		await newer(20, '780000000000000000')
		const capture = async () => {
			const run = await runInDurableObject(h.store, (_instance, state) => {
				const plans: PlannedStatement[] = []
				const page = featuredPageWithin(
					new Db(
						plannedSql(
							state.storage.sql,
							/account_pins p\b|featured_tags f\b|json_each\(\?1\) c CROSS JOIN accounts a ON/,
							plans
						)
					),
					{ handle: 'alice', cursor: { maxId: cursor } },
					SITE,
					ANSWER_BYTES
				)
				return { plans, page }
			})
			expect(run.page.status === 'ok' ? [run.page.tags.length, run.page.accounts.length] : run.page.status).toEqual([
				MAX_FEATURED_TAGS,
				ENDORSEMENTS_PAGE_SIZE,
			])
			expect(run.plans).toHaveLength(3)
			for (const statement of run.plans) {
				expect(scansOf(statement.plan, ['p', 'account_pins', 'f', 'featured_tags', 'a', 'accounts'])).toEqual([])
			}
			return run.plans.reduce((sum, statement) => sum + statement.rows, 0)
		}
		const { before, after } = await staleStatistics(h, { capture, grow: () => newer(2000, '790000000000000000') })
		expect(after).toBe(before)
	}, 120_000)
})
