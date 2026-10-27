import { runInDurableObject } from 'cloudflare:test'

import { jsx } from 'hono/jsx'
import { describe, expect, it } from 'vitest'

import { bearer, recountFollows, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { C, maximalAccounts } from './budget-helpers'
import { blockDomain } from './domain-block-helpers'
import { BUILD } from './helpers'
import { MAX_BIO, movedAtCaps } from './profile-fixtures'
import { shownAccounts, viaRoute, walkPages } from './profile-page-helpers'
import { type PlannedStatement, plannedSql, scansOf, staleStatistics } from './read-helpers'
import { community } from './status-helpers'
import { accessibleName, attr, elements, one, parseHtml, query, text } from './web-dom'
import { type Browser, countedHarness, csrfOf, postForm, signIn } from './web-helpers'
import { Db } from '../src/db/sql'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { WEB_PAGE_BYTES } from '../src/domain/web-pages/budget'
import {
	type FollowDirection,
	FOLLOWS_PAGE_SIZE,
	followsPageWithin,
	type FollowsPage as FollowsAnswer,
} from '../src/domain/web-pages/follows'
import { LONGEST_PAGING, pageCursor } from '../src/domain/web-pages/paging'
import type { Site } from '../src/domain/web-pages/site'
import { FollowsPage } from '../src/web/pages/follows'
import { STRINGS } from '../src/web/strings'

// The follow lists: /@user/followers and /@user/following (VIS-4, VIS-8, R13), the profile's links to them and the
// settings page's hide_collections.

type Harness = Awaited<ReturnType<typeof community>>

const SITE: Site = { domain: 'kopje.test', documents: { privacyPolicy: false, termsOfService: false } }

// The conservative JSON of one presented account, every column at its bound ("Maxima of presented units" in
// docs/threat-model.md; test/status-bounds.test.ts, "keeps the conservative JSON of every shape within 85%").
const ACCOUNT_JSON_MAX = 147_990

let nextAccount = 700_000_000_000_000_000n

// A remote account of `domain`, its id and its profile link (an actor id on its server, so the link is derived).
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

// An edge of `from` following `to`, the next follow id.
async function follow(h: Harness, from: string, to: string, state: 'accepted' | 'pending' = 'accepted') {
	await sql(h.store, 'INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, ?)', from, to, state)
}

// What a page shows: its members (each row's profile link), its pager and its empty line.
const shown = (html: string) =>
	shownAccounts(html, { newer: STRINGS.pager.newerAccounts, older: STRINGS.pager.olderAccounts })

// A follow list walked both ways (walkPages).
const walk = (get: (url: string) => Promise<string>, base: string) => walkPages(get, base, shown)

type FollowsOk = Extract<FollowsAnswer, { status: 'ok' }>

function readWithin(h: Harness, path: string, answerBytes: number): Promise<FollowsOk> {
	const url = new URL(path, 'https://kopje.test')
	const direction = url.pathname.endsWith('/followers') ? 'followers' : 'following'
	const cursor = pageCursor(url.searchParams.get('max_id'), url.searchParams.get('min_id'))
	return runInDurableObject(h.store, (_instance, state) => {
		const page = followsPageWithin(
			new Db(state.storage.sql),
			{ handle: 'alice', direction, cursor, now: NOW },
			SITE,
			answerBytes
		)
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
			await jsx(FollowsPage, {
				account: page.account,
				direction: url.pathname.endsWith('/followers') ? 'followers' : 'following',
				hidden: page.hidden,
				accounts: page.accounts,
				cursor: pageCursor(url.searchParams.get('max_id'), url.searchParams.get('min_id')),
				paging: page.paging,
				site: SITE,
			}).toString()
		)
	}
}

// The frame a follow list's answer reserves (docs/response-inventory.md), stated apart from the read's own.
function frameBytes(site: Site): number {
	return jsonBytes({ status: 'ok', account: null, hidden: true, accounts: [], paging: LONGEST_PAGING, site })
}

// alice's followers and following, each in follow order, with what each shows: available members (local and remote)
// between runs of members a page leaves out, one run longer than three candidate windows (readWindow(40) = 120):
// remote accounts suspended by the instance, accounts on a domain the instance blocks; and a local member suspended,
// a local member alice blocked (the block ends the follow) and pending follows, which are never candidates.
async function world() {
	const h = await community(['alice', 'bob', 'secretcarol', 'secretdave'])
	const { alice, bob, secretcarol, secretdave } = h.users
	await sql(
		h.store,
		'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
		new Date(NOW).toISOString(),
		secretcarol.id
	)
	await blockDomain(h.store, 'blocked.example')
	const expected: Record<FollowDirection, string[]> = { followers: [], following: [] }
	const hiddenIds: string[] = []
	let n = 0
	const add = async (direction: FollowDirection, member: string, href: string | null, state?: 'pending') => {
		if (direction === 'followers') {
			await follow(h, member, alice.id, state)
		} else {
			await follow(h, alice.id, member, state)
		}
		if (href !== null) {
			expected[direction].unshift(href)
		}
	}
	for (const direction of ['followers', 'following'] as const) {
		const visible = async (count: number) => {
			for (let i = 0; i < count; i++) {
				const name = `v${direction.slice(0, 5)}${n++}`
				await add(direction, await remote(h, name), `https://remote.example/@${name}`)
			}
		}
		const hidden = async (count: number) => {
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
				await add(direction, id, null)
				if (i % 50 === 0) {
					// A pending follow (VIS-8): never a candidate.
					const pending = await remote(h, `secretpending${n++}`, 'remote.example', 'HIDDEN pending')
					hiddenIds.push(pending)
					await add(direction, pending, null, 'pending')
				}
			}
		}
		await visible(30)
		await add(direction, bob.id, '/@bob')
		await add(direction, secretcarol.id, null)
		await hidden(400)
		await visible(25)
		await add(direction, secretdave.id, null)
		await hidden(130)
		await visible(30)
	}
	// alice blocks secretdave: the block ends both follows (blocks.ts endFollow).
	const blocked = await h.request(`/api/v1/accounts/${secretdave.id}/block`, bearer(alice.token, { method: 'POST' }))
	expect(blocked.status).toBe(200)
	expect(
		await sql(h.store, 'SELECT id FROM follows WHERE account_id = ?1 OR target_account_id = ?1', secretdave.id)
	).toEqual([])
	await recountFollows(h.store, alice.id)
	return { h, expected, hiddenIds }
}

// Whether `html` names a member that no page may show.
function leaks(html: string, hiddenIds: readonly string[]): string[] {
	return [...['HIDDEN', 'secret'].filter((word) => html.includes(word)), ...hiddenIds.filter((id) => html.includes(id))]
}

describe('the follow lists', () => {
	it('walk both lists to both ends in follow order, past runs of left-out members longer than two windows', async () => {
		const { h, expected, hiddenIds } = await world()
		for (const direction of ['followers', 'following'] as const) {
			const walked = await walk(viaRoute(h), `/@alice/${direction}`)
			expect(expected[direction].length).toBeGreaterThan(2 * FOLLOWS_PAGE_SIZE)
			expect([direction, walked.down]).toEqual([direction, expected[direction]])
			expect([direction, walked.up]).toEqual([direction, expected[direction]])
			// The runs of left-out members pass more than one window with nothing shown, and each such page links on.
			expect([direction, walked.sizes.join(' ')]).toEqual([direction, expect.stringMatching(/\b0 0\b/)])
			// The whole HTML of every page names no left-out member: no name, no id (its follow id may be a cursor, as
			// a candidate's; an account id never).
			for (const html of walked.pages) {
				expect([direction, leaks(html, hiddenIds)]).toEqual([direction, []])
			}
		}
		// The guarded branch ran: the API, as an anonymous client reads it, lists the unavailable members redacted.
		const api = await h.request(`/api/v1/accounts/${h.users.alice.id}/followers?limit=80`)
		const listed = await api.json<{ username: string; suspended?: boolean }[]>()
		expect(listed.some((account) => account.username.startsWith('secret') && account.suspended === true)).toBe(true)
	}, 300_000)

	it('walk both lists through byte cuts, each page continuing from its last member', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const expected: Record<FollowDirection, string[]> = { followers: [], following: [] }
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
			for (const direction of ['followers', 'following'] as const) {
				await (direction === 'followers' ? follow(h, id, alice.id) : follow(h, alice.id, id))
				expected[direction].unshift(`https://remote.example/@${name}`)
			}
		}
		const first = await readWithin(h, '/@alice/followers', ANSWER_BYTES)
		const get = within(h, frameBytes(SITE) + jsonBytes(first.account) + 45_000)
		for (const direction of ['followers', 'following'] as const) {
			const walked = await walk(get, `/@alice/${direction}`)
			expect([direction, walked.down]).toEqual([direction, expected[direction]])
			expect([direction, walked.up]).toEqual([direction, expected[direction]])
			// Cut by bytes: pages that link on with fewer than 40.
			expect([direction, walked.sizes.slice(0, -1).some((size) => size > 0 && size < FOLLOWS_PAGE_SIZE)]).toEqual([
				direction,
				true,
			])
		}
	}, 120_000)

	it('show the empty line only when no page lies either way, and only the pager otherwise', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, bob.id, alice.id)
		const ids = await sql<{ id: string }>(h.store, 'SELECT CAST(id AS TEXT) AS id FROM follows')
		const follower = ids[0]!.id
		expect(shown(await (await h.request('/@alice/following')).text())).toEqual({
			items: [],
			newer: null,
			older: null,
			empty: ['No follows yet.'],
		})
		expect(shown(await (await h.request('/@bob/followers')).text()).empty).toEqual(['No followers yet.'])
		expect(shown(await (await h.request('/@alice/followers')).text())).toEqual({
			items: ['/@bob'],
			newer: null,
			older: null,
			empty: [],
		})
		// Past the oldest: only the pager, back to the follows above it.
		expect(shown(await (await h.request(`/@alice/followers?max_id=${follower}`)).text())).toEqual({
			items: [],
			newer: `/@alice/followers?min_id=${BigInt(follower) - 1n}`,
			older: null,
			empty: [],
		})
		// Above the newest: only the pager, to the first page.
		expect(shown(await (await h.request(`/@alice/followers?min_id=${follower}`)).text())).toEqual({
			items: [],
			newer: null,
			older: '/@alice/followers',
			empty: [],
		})
	})
})

// An account's settings form as the page renders it, with `changes` applied: every control's value as a browser
// submits it (a checked box posts its value before its hidden false).
async function settingsForm(h: Harness, browser: Browser, changes: Record<string, boolean>) {
	const page = parseHtml(await (await h.request('/settings', { headers: { cookie: browser.cookie } })).text())
	const form = query(page, 'form').find((f) => attr(f, 'action') === '/settings/profile')!
	const fields = new URLSearchParams()
	const boxes: Record<string, boolean> = {}
	for (const control of elements(form)) {
		const name = attr(control, 'name')
		if (name === null) {
			continue
		}
		if (control.tagName === 'input' && attr(control, 'type') === 'checkbox') {
			boxes[name] = attr(control, 'checked') !== null
			if (changes[name] ?? boxes[name]) {
				fields.append(name, attr(control, 'value') ?? '')
			}
		} else if (control.tagName === 'input') {
			fields.append(name, attr(control, 'value') ?? '')
		} else if (control.tagName === 'textarea') {
			fields.append(name, text(control))
		} else if (control.tagName === 'select') {
			const selected = query(control, 'option').find((option) => attr(option, 'selected') !== null)
			fields.append(name, attr(selected!, 'value') ?? '')
		}
	}
	return { fields, boxes, page }
}

describe('hide_collections (R13)', () => {
	it('is set from the settings page, with its anti-forgery token, and then the lists show only their counts', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await follow(h, bob.id, alice.id)
		await follow(h, alice.id, await remote(h, 'carol'))
		await recountFollows(h.store, alice.id)
		const browser = await signIn(h)
		const before = await settingsForm(h, browser, {})
		// A labelled checkbox, unchecked.
		const box = query(before.page, 'input').find((input) => attr(input, 'name') === 'hide_collections')!
		expect(accessibleName(box, before.page)).toBe(STRINGS.settings.hideCollections)
		expect(before.boxes.hide_collections).toBe(false)
		const lists = async () => ({
			followers: shown(await (await h.request('/@alice/followers')).text()).items,
			following: shown(await (await h.request('/@alice/following')).text()).items,
		})
		expect(await lists()).toEqual({ followers: ['/@bob'], following: ['https://remote.example/@carol'] })

		// A forged form (no token) changes nothing.
		const forged = await settingsForm(h, browser, { hide_collections: true })
		forged.fields.delete('csrf')
		expect((await postForm(h, browser, '/settings/profile', forged.fields)).status).toBe(403)
		expect((await settingsForm(h, browser, {})).boxes.hide_collections).toBe(false)

		const hide = await settingsForm(h, browser, { hide_collections: true })
		expect(hide.fields.get('csrf')).toBe(await csrfOf(h, browser))
		const saved = await postForm(h, browser, '/settings/profile', hide.fields)
		expect([saved.status, saved.headers.get('location')]).toEqual([303, '/settings?notice=saved'])
		expect((await settingsForm(h, browser, {})).boxes.hide_collections).toBe(true)
		expect(await sql(h.store, 'SELECT hide_collections FROM local_accounts WHERE account_id = ?', alice.id)).toEqual([
			{ hide_collections: 1 },
		])

		// The pages: the account, the two tabs with their counts, and the line that says the lists are hidden: no list
		// or pager.
		for (const direction of ['followers', 'following'] as const) {
			const html = await (await h.request(`/@alice/${direction}`)).text()
			expect(html).not.toContain('bob')
			expect(html).not.toContain('carol')
			const main = one(parseHtml(html), 'main')
			expect(query(main, 'ul', 'accounts')).toEqual([])
			expect(query(main, 'nav', 'pager')).toEqual([])
			expect(
				query(main, 'p')
					.filter((p) => !(attr(p, 'class') ?? '').includes('meta'))
					.map(text)
			).toEqual(['alice hides this list.'])
			expect(query(one(main, 'nav', 'tabs'), 'a').map((a) => [text(a), attr(a, 'aria-current')])).toEqual([
				['1 following', direction === 'following' ? 'page' : null],
				['1 follower', direction === 'followers' ? 'page' : null],
			])
			expect(text(main)).toBe('alice@alice@kopje.test1 following1 followeralice hides this list.')
		}
		// A cursor shows nothing more.
		expect(shown(await (await h.request('/@alice/followers?max_id=999999')).text()).items).toEqual([])

		const show = await settingsForm(h, browser, { hide_collections: false })
		expect((await postForm(h, browser, '/settings/profile', show.fields)).status).toBe(303)
		expect(await lists()).toEqual({ followers: ['/@bob'], following: ['https://remote.example/@carol'] })
	})
})

describe('the follow lists as pages', () => {
	it('link from the profile’s counts, and back to the profile', async () => {
		const h = await community(['alice'])
		const profile = parseHtml(await (await h.request('/@alice')).text())
		expect(query(one(profile, 'ul', 'stats'), 'a').map((a) => [text(a), attr(a, 'href')])).toEqual([
			['0 following', '/@alice/following'],
			['0 followers', '/@alice/followers'],
		])
		for (const direction of ['followers', 'following'] as const) {
			const doc = parseHtml(await (await h.request(`/@alice/${direction}`)).text())
			const h1 = one(doc, 'h1')
			expect(query(h1, 'a').map((a) => attr(a, 'href'))).toEqual(['/@alice'])
			const tabs = one(doc, 'nav', 'tabs')
			expect(accessibleName(tabs, doc)).toBe(STRINGS.a11y.followLists)
			expect(query(tabs, 'a').map((a) => attr(a, 'href'))).toEqual(['/@alice/following', '/@alice/followers'])
			expect(text(one(doc, 'title'))).toBe(
				direction === 'followers'
					? 'People who follow alice (@alice@kopje.test)'
					: 'People alice follows (@alice@kopje.test)'
			)
		}
	})

	it('mark a page with a cursor noindex, follow, with its cursor-less URL canonical, and send no script', async () => {
		const h = await community(['alice'])
		for (const direction of ['followers', 'following'] as const) {
			const path = `/@alice/${direction}`
			for (const [query, robots] of [
				['', []],
				['?max_id=200000000000000000', ['noindex, follow']],
				['?min_id=1', ['noindex, follow']],
				['?max_id=x1', []],
			] as const) {
				const response = await h.request(path + query)
				const doc = parseHtml(await response.text())
				expect([path + query, response.status]).toEqual([path + query, 200])
				expect(
					elements(doc)
						.filter((e) => e.tagName === 'meta' && attr(e, 'name') === 'robots')
						.map((e) => attr(e, 'content'))
				).toEqual(robots)
				expect(
					elements(doc)
						.filter((e) => e.tagName === 'link' && attr(e, 'rel') === 'canonical')
						.map((e) => attr(e, 'href'))
				).toEqual([`https://kopje.test${path}`])
				expect(elements(doc).filter((e) => e.tagName === 'script')).toEqual([])
				expect(response.headers.get('cache-control')).toBe('public, max-age=60')
				expect(response.headers.get('vary')).toBe('Accept')
				expect(response.headers.get('content-security-policy')).toBe(
					"default-src 'none'; style-src 'self'; img-src 'self' https:; media-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
				)
			}
		}
	})

	it('answer the same 404 bytes for every account they do not serve, and 410 for a suspended one', async () => {
		const h = await community(['alice', 'bob'])
		await remote(h, 'carol')
		const missing = await (await h.request('/@nobody')).text()
		for (const path of [
			'/@nobody/followers',
			'/@nobody/following',
			'/@carol@remote.example/followers',
			'/@alice@other.example/following',
			'/@/followers',
		]) {
			const response = await h.request(path)
			expect([path, response.status, await response.text()]).toEqual([path, 404, missing])
		}
		// The guarded branch: the same shapes of a served account answer.
		expect((await h.request('/@alice@kopje.test/followers')).status).toBe(200)
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			h.users.bob.id
		)
		const gone = await (await h.request('/@bob')).text()
		for (const path of ['/@bob/followers', '/@bob/following']) {
			const response = await h.request(path)
			expect([path, response.status, await response.text()]).toEqual([path, 410, gone])
		}
	})

	it('read each page and the site facts in one Store call', async () => {
		const { h, calls } = await countedHarness(['alice', 'bob'])
		await follow(h, h.users.bob.id, h.users.alice.id)
		const expected: [string, number][] = [
			['/@alice/followers', 200],
			['/@alice/following', 200],
			['/@alice/followers?max_id=1', 200],
			['/@alice/following?min_id=1', 200],
			['/@nobody/followers', 404],
		]
		for (const [path, status] of expected) {
			expect([path, await calls(path)]).toEqual([path, { status, calls: ['webFollowsPage'] }])
		}
		await sql(h.store, 'UPDATE local_accounts SET hide_collections = 1 WHERE account_id = ?', h.users.alice.id)
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			h.users.bob.id
		)
		for (const [path, status] of [
			['/@alice/followers', 200],
			['/@bob/following', 410],
		] as const) {
			expect([path, await calls(path)]).toEqual([path, { status, calls: ['webFollowsPage'] }])
		}
	})
})

describe('the follow lists at their maxima (RES-3)', () => {
	// The ceiling: the frame, the account and one member, each at the account maximum, fit WEB_PAGE_BYTES
	// (docs/response-inventory.md), so strict admission never leaves a page without a member.
	it('fit a member at the account maximum beside the account', () => {
		expect(frameBytes(SITE) + 2 * (ACCOUNT_JSON_MAX + 1)).toBeLessThanOrEqual(WEB_PAGE_BYTES)
	})

	// A measurement, not a ceiling (the ceiling is the test above): through the real Store RPC, with the account's bio
	// and display name at their caps, and 41 followers and 41 followings, each with a bio, display name, 16 fields and
	// emoji at their bounds (maximalAccounts) and moved to an account at every cap of a moved-to account (movedAtCaps).
	// Not at their caps: the account's fields, emoji and moved-to account, and the members' URLs, images and counts.
	it('keep each real RPC answer of members at their profile caps within WEB_PAGE_BYTES, cut by bytes (a measurement)', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await sql(h.store, 'UPDATE accounts SET note = ?, display_name = ? WHERE id = ?', MAX_BIO, C.repeat(2048), alice.id)
		await setSetting(h.store, 'privacy_policy', '<p>p</p>')
		await setSetting(h.store, 'terms_of_service', '<p>t</p>')
		await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
		const members = await maximalAccounts(h, 'max', FOLLOWS_PAGE_SIZE + 1)
		await movedAtCaps(h.store, members, 710_000_000_000_000_000n)
		for (const id of members) {
			await follow(h, id, alice.id)
			await follow(h, alice.id, id)
		}
		for (const direction of ['followers', 'following'] as const) {
			// Walked to its end: every page within WEB_PAGE_BYTES, cut by bytes short of FOLLOWS_PAGE_SIZE, never empty,
			// and every member once.
			const seen: string[] = []
			let cursor: { maxId: string } | null = null
			for (let pages = 0; pages < 50; pages++) {
				const page = await h.store.webFollowsPage(BUILD, { handle: 'alice', direction, cursor, now: NOW })
				if (page.status !== 'ok') {
					throw new Error(page.status)
				}
				expect(page.site.documents).toEqual({ privacyPolicy: true, termsOfService: true })
				expect(jsonBytes(page)).toBeLessThanOrEqual(WEB_PAGE_BYTES)
				expect(page.accounts.length).toBeGreaterThan(0)
				expect(page.accounts.length).toBeLessThan(FOLLOWS_PAGE_SIZE)
				for (const account of page.accounts) {
					expect(account.moved).toBeDefined()
					expect(jsonBytes(account)).toBeGreaterThan(100_000)
				}
				seen.push(...page.accounts.map((account) => account.id))
				if (!page.paging.more) {
					break
				}
				cursor = { maxId: page.paging.oldest! }
			}
			expect(seen.toSorted()).toEqual(members.toSorted())
		}
	}, 300_000)
})

describe('the follow lists’ reads (RES-7, docs/visibility.md "Read bounds")', () => {
	// Each list's statements with statistics taken before the Store grew: the window seeks the account's follows from
	// the cursor (follows_target, follows_following), never scanning follows or accounts, and a page below a fixed
	// cursor reads the same rows with 20 or 2,020 newer follows, most of them of unavailable members, above it.
	it('seek from the cursor through the list’s index, with stale statistics', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const both = async (id: string) => {
			await follow(h, id, alice.id)
			await follow(h, alice.id, id)
		}
		for (let i = 0; i < 2 * FOLLOWS_PAGE_SIZE; i++) {
			await both(await remote(h, `below${i}`))
		}
		const [{ id: cursor }] = (await sql<{ id: string }>(
			h.store,
			'SELECT CAST(max(id) AS TEXT) AS id FROM follows'
		)) as [{ id: string }]
		const newer = async (count: number, base: number) => {
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain, suspended_at, suspension_source)
				SELECT printf('%018d', ?2 + i), 'https://grown.example/users/g' || (?2 + i), 'g' || (?2 + i), 'grown.example',
					CASE WHEN i % 4 = 0 THEN NULL ELSE '2026-01-01T00:00:00.000Z' END,
					CASE WHEN i % 4 = 0 THEN NULL ELSE 'account' END FROM n`,
				count,
				base
			)
			await sql(
				h.store,
				`INSERT INTO follows (account_id, target_account_id, state)
				SELECT a.id, ?1, 'accepted' FROM accounts a WHERE a.domain = 'grown.example' AND a.id > printf('%018d', ?2)
				UNION ALL SELECT ?1, a.id, 'accepted' FROM accounts a WHERE a.domain = 'grown.example' AND a.id > printf('%018d', ?2)`,
				alice.id,
				base
			)
		}
		await newer(20, 720_000_000)
		const capture = async () => {
			const rows: Record<string, number> = {}
			for (const direction of ['followers', 'following'] as const) {
				const run = await runInDurableObject(h.store, (_instance, state) => {
					const plans: PlannedStatement[] = []
					const page = followsPageWithin(
						new Db(plannedSql(state.storage.sql, /\bfollows f\b/, plans)),
						{ handle: 'alice', direction, cursor: { maxId: cursor }, now: NOW },
						SITE,
						ANSWER_BYTES
					)
					return { plans, page }
				})
				expect(run.page.status === 'ok' ? run.page.accounts.length : run.page.status).toBe(FOLLOWS_PAGE_SIZE)
				expect(run.plans).toHaveLength(2)
				for (const statement of run.plans) {
					expect([direction, scansOf(statement.plan, ['f', 'follows', 'a', 'accounts'])]).toEqual([direction, []])
				}
				expect([
					direction,
					run.plans.some((statement) =>
						statement.plan.some((d) =>
							new RegExp(
								`USING (?:COVERING )?INDEX ${direction === 'followers' ? 'follows_target' : 'follows_following'}`
							).test(d)
						)
					),
				]).toEqual([direction, true])
				rows[direction] = run.plans.reduce((sum, statement) => sum + statement.rows, 0)
			}
			return rows
		}
		const { before, after } = await staleStatistics(h, { capture, grow: () => newer(2000, 730_000_000) })
		expect(after).toEqual(before)
	}, 120_000)
})
