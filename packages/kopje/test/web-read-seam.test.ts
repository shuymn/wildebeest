import { runInDurableObject } from 'cloudflare:test'

import { jsx } from 'hono/jsx'
import { describe, expect, it } from 'vitest'

import { bearer, setSetting, sql } from './api-helpers'
import { countingStore, NOW } from './app-helpers'
import { bigStatus, C } from './budget-helpers'
import { BUILD } from './helpers'
import { MAX_BIO } from './profile-fixtures'
import { profileFrameBytes, walkProfile } from './profile-page-helpers'
import { community, post, remoteAccount, seedStatus } from './status-helpers'
import { attr, one, parseHtml, query, text } from './web-dom'
import { olderOf, postsTab, signIn } from './web-helpers'
import { Db } from '../src/db/sql'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { contextOf } from '../src/domain/auth'
import { accountStatusesWithin } from '../src/domain/timelines'
import {
	admitHead,
	LINK_ACCT_JSON_BYTES,
	LONGEST_STATUS_STUB,
	pageBudget,
	PARENT_ENTRY_BYTES,
	statusList,
} from '../src/domain/web-pages/budget'
import { listParents } from '../src/domain/web-pages/parents'
import { profilePageWithin } from '../src/domain/web-pages/profile'
import type { Site } from '../src/domain/web-pages/site'
import type { StoreStub } from '../src/platform/store-client'
import { STYLESHEET } from '../src/web/asset-versions'
import { ProfilePage } from '../src/web/pages/profile'

// The read seam of the public pages (design §2, §3, §5): one Store call a page, the site facts with it, the composite
// budget and its stubs, parent links an anonymous viewer may see, the HTML 404 for every page shape no route serves,
// and the stylesheet preload.

type Harness = Awaited<ReturnType<typeof community>>

// A harness whose app calls the Store through a counter: `calls` lists the Store methods each request called.
async function counted(names: readonly string[] = ['alice']) {
	let counter: ReturnType<typeof countingStore> | undefined
	const h = await community(names, 'read write follow', {
		wrapStore: (store: StoreStub) => (counter ??= countingStore(store)).stub,
	})
	const calls = async (path: string, init?: RequestInit) => {
		const before = counter?.calls.length ?? 0
		const response = await h.request(path, init)
		await response.arrayBuffer()
		return { status: response.status, calls: (counter?.calls ?? []).slice(before) }
	}
	return { h, calls }
}

function statusPath(status: Record<string, unknown>): string {
	return new URL(String(status.url)).pathname
}

const SITE: Site = { domain: 'kopje.test', documents: { privacyPolicy: false, termsOfService: false } }

describe('one Store call a page (design §2, §13 "CI budgets")', () => {
	it('reads each page and the site facts in one call', async () => {
		const { h, calls } = await counted(['alice'])
		const alice = h.users.alice!
		const status = await post(h, alice, { status: '#cats hello' })
		await setSetting(h.store, 'privacy_policy', '<p>Policy</p>')
		const path = statusPath(status)
		// Each page, its answer and the calls it makes.
		const expected: [string, number, string[]][] = [
			['/', 302, []],
			['/about', 200, ['webAbout']],
			['/privacy-policy', 200, ['webDocument']],
			['/terms-of-service', 404, ['webDocument']],
			['/@alice', 200, ['webProfilePage']],
			['/@alice/tagged/cats', 200, ['webProfilePage']],
			['/@alice/with_replies', 200, ['webProfilePage']],
			['/@alice/media', 200, ['webProfilePage']],
			[`/@alice?max_id=${String(status.id)}`, 200, ['webProfilePage']],
			[`/@alice/with_replies?min_id=1`, 200, ['webProfilePage']],
			['/@nobody/media', 404, ['webProfilePage']],
			['/@alice/featured', 200, ['webFeaturedPage']],
			['/@alice/featured?max_id=1', 200, ['webFeaturedPage']],
			['/@nobody/featured', 404, ['webFeaturedPage']],
			[path, 200, ['webStatusPage']],
			[`${path}/embed`, 200, ['webStatusPage']],
			['/@nobody', 404, ['webProfilePage']],
			['/@alice/100000000000000001', 404, ['webStatusPage']],
			['/@alice/no-such-page', 404, ['webSite']],
			['/tags/cats', 200, ['webTagPage']],
			['/tags/Cats?max_id=1', 200, ['webTagPage']],
			['/tags/a-b', 404, ['webTagPage']],
			['/tags/cats/x', 404, ['webSite']],
		]
		for (const [page, status, names] of expected) {
			expect([page, await calls(page)]).toEqual([page, { status, calls: names }])
		}
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		for (const page of ['/@alice', '/@alice/with_replies', '/@alice/media', '/@alice/tagged/cats']) {
			expect([page, await calls(page)]).toEqual([page, { status: 410, calls: ['webProfilePage'] }])
		}
		expect(await calls('/@alice/featured')).toEqual({ status: 410, calls: ['webFeaturedPage'] })
	})

	it('answers 503 before setup from the same one call, and redirects / without one', async () => {
		const { h, calls } = await counted(['alice'])
		await sql(h.store, "DELETE FROM instance_settings WHERE name = 'domain'")
		for (const [page, name] of [
			['/about', 'webAbout'],
			['/privacy-policy', 'webDocument'],
			['/@alice', 'webProfilePage'],
			['/@alice/1', 'webStatusPage'],
			['/@alice/1/embed', 'webStatusPage'],
			['/tags/cats', 'webTagPage'],
			['/@alice/featured', 'webFeaturedPage'],
			['/@alice/no-such-page', 'webSite'],
			['/login', 'webSite'],
		] as const) {
			expect([page, await calls(page)]).toEqual([page, { status: 503, calls: [name] }])
		}
		const root = await h.request('/')
		expect(root.status).toBe(302)
		expect(root.headers.get('location')).toBe('/about')
		expect(root.headers.get('cache-control')).toBe('public, max-age=60')
		expect(root.headers.get('vary')).toBeNull()
	})
})

describe('headers (design §5)', () => {
	it('preloads the fingerprinted stylesheet each page links, and keeps the CSP and caching', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'hello' })
		const preload = `<${STYLESHEET}>; rel=preload; as=style`
		expect(preload).toMatch(/^<\/assets\/kopje\.[0-9a-f]{10}\.css>; rel=preload; as=style$/)
		const browser = await signIn(h)
		for (const [path, cookie, cache, vary] of [
			['/about', null, 'public, max-age=60', 'Accept'],
			['/@alice', null, 'public, max-age=60', 'Accept'],
			[statusPath(status), null, 'public, max-age=60', 'Accept'],
			['/@alice/no-such-page', null, 'public, max-age=60', 'Accept'],
			[`${statusPath(status)}/embed`, null, 'public, max-age=180', null],
			['/settings', browser.cookie, 'no-store', null],
		] as const) {
			const response = await h.request(path, cookie === null ? {} : { headers: { cookie } })
			const html = await response.text()
			expect([path, response.headers.get('link')]).toEqual([path, preload])
			expect(response.headers.get('cache-control'), path).toBe(cache)
			expect(response.headers.get('vary'), path).toBe(vary)
			// The page links the stylesheet its header preloads.
			expect(
				[...html.matchAll(/<link rel="stylesheet" href="([^"]*)"/g)].map((m) => m[1]),
				path
			).toEqual([STYLESHEET])
			if (path.endsWith('/embed')) {
				expect(response.headers.get('content-security-policy')).toBe(
					"default-src 'none'; script-src https://kopje.test/assets/embed-status.js; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'"
				)
			} else {
				expect(response.headers.get('content-security-policy'), path).toBe(
					"default-src 'none'; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
				)
			}
		}
	})

	it('serves the same page with and without a session', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'hello' })
		// What only the session's own account may see: a page that read as the session would show these.
		const own = await post(h, h.users.alice, { status: 'only for followers', visibility: 'private' })
		await post(h, h.users.alice, { status: 'only for the mentioned', visibility: 'direct' })
		await post(h, h.users.alice, { status: 'a private reply', visibility: 'private', in_reply_to_id: own.id })
		await setSetting(h.store, 'privacy_policy', '<p>Policy</p>')
		const browser = await signIn(h)
		// The session is the author's: the API shows it the private post.
		expect((await h.request(`/api/v1/statuses/${String(own.id)}`, bearer(h.users.alice.token))).status).toBe(200)
		for (const path of [
			'/',
			'/about',
			'/privacy-policy',
			'/@alice',
			'/@alice/tagged/cats',
			'/@alice/with_replies',
			'/@alice/media',
			'/@alice/featured',
			`/@alice?max_id=${String(status.id)}`,
			statusPath(status),
			`${statusPath(status)}/embed`,
			statusPath(own),
			'/@nobody',
			'/@alice/no-such-page',
		]) {
			const without = await h.request(path)
			const withSession = await h.request(path, { headers: { cookie: browser.cookie } })
			expect([path, withSession.status]).toEqual([path, without.status])
			const body = await withSession.text()
			expect(body, path).toBe(await without.text())
			for (const hidden of ['only for followers', 'only for the mentioned', 'a private reply', String(own.id)]) {
				expect(body, `${path}: ${hidden}`).not.toContain(hidden)
			}
			expect([...withSession.headers.entries()], path).toEqual([...without.headers.entries()])
		}
	})
})

describe('the footer of every page (design §1, snapshot)', () => {
	it('links the documents that exist from every page', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'hello' })
		await setSetting(h.store, 'terms_of_service', '<p>Terms</p>')
		await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
		const browser = await signIn(h)
		const footer = async (path: string, cookie?: string) => {
			const response = await h.request(path, cookie === undefined ? {} : { headers: { cookie } })
			return query(one(parseHtml(await response.text()), 'footer'), 'a').map((a) => attr(a, 'href'))
		}
		for (const path of ['/@alice', statusPath(status), '/terms-of-service', '/@nobody', '/@alice/x/y', '/tags/x']) {
			expect([path, await footer(path)]).toEqual([path, ['/about', '/terms-of-service']])
		}
		expect(await footer('/settings', browser.cookie)).toEqual(['/about', '/terms-of-service'])
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		expect(await footer('/@alice')).toEqual(['/about', '/terms-of-service'])
	})
})

describe('the HTML 404 (design §3)', () => {
	it('answers the same 404 bytes for every hidden or unknown page', async () => {
		const h = await community(['alice', 'bob'])
		const { alice } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		const hidden = await post(h, alice, { status: 'followers only', visibility: 'private' })
		const remote = await seedStatus(h.store, { accountId: carol, visibility: 'public' })
		const missing = await h.request('/@nobody')
		const bytes = await missing.text()
		expect(missing.status).toBe(404)
		expect(text(one(parseHtml(bytes), 'h1'))).toBe('Not found')
		const paths = [
			'/@alice/100000000000000001',
			statusPath(hidden),
			`${statusPath(hidden)}/embed`,
			`/@alice/${remote}`,
			`/@carol@carol.example/${remote}`,
			'/@carol@carol.example',
			'/@alice/tagged/a-b',
			'/@nobody/tagged/cats',
			'/@zed@nowhere.example/tagged/cats',
			'/@nobody/with_replies',
			'/@nobody/media',
			'/@carol@carol.example/with_replies',
			'/@carol@carol.example/media',
			'/@alice/with_replies/x',
			'/@alice/media/x',
			'/privacy-policy',
			'/terms-of-service/2026-11-01',
			// Shapes no route serves.
			'/@',
			'/@/x',
			'/@alice/',
			'/@alice/tagged',
			'/@alice/featured-nothing',
			'/@alice/12345678901234567890',
			'/@alice/123x',
			`${statusPath(hidden)}/reblogs-nothing`,
			'/@alice/1/embed/x',
			'/tags',
			'/tags/cats/x',
			// A hashtag page for a name that is not a hashtag, or past the bound of the hashtags Kopje lists.
			'/tags/a-b',
			'/tags/%23cats',
			'/tags/%20',
			`/tags/${'a'.repeat(257)}`,
		]
		for (const path of paths) {
			const response = await h.request(path)
			expect([path, response.status]).toEqual([path, 404])
			expect(response.headers.get('content-type'), path).toBe('text/html; charset=UTF-8')
			expect(response.headers.get('cache-control'), path).toBe('public, max-age=60')
			expect(await response.text(), path).toBe(bytes)
		}
	})
})

describe('parent links (design §2)', () => {
	it('links only the parents an anonymous viewer may see', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		const shown = await post(h, alice, { status: 'the visible parent' })
		const secret = await post(h, alice, { status: 'the private parent', visibility: 'private' })
		const toShown = await post(h, alice, { status: 'reply to the visible one', in_reply_to_id: shown.id })
		const toSecret = await post(h, alice, { status: 'reply to the private one', in_reply_to_id: secret.id })
		const remote = await seedStatus(h.store, { accountId: carol, visibility: 'public' })
		const toRemote = await post(h, alice, { status: '@carol@carol.example hi', in_reply_to_id: remote })

		// The profile's feed: a reply-to line for the visible parent only, by its local path.
		const profile = await (await h.request('/@alice')).text()
		const cards = query(one(parseHtml(profile), 'main'), 'article')
		const replyTo = (needle: string) => {
			const card = cards.find((article) => text(article).includes(needle))
			expect(card, needle).toBeDefined()
			return query(card!, 'p', 'reply-to').flatMap((p) => query(p, 'a').map((a) => attr(a, 'href')))
		}
		expect(replyTo('reply to the visible one')).toEqual([statusPath(shown)])
		expect(replyTo('reply to the private one')).toEqual([])
		// The private parent leaves nothing in the page: not its id, its text or its URL.
		for (const trace of [String(secret.id), 'the private parent', statusPath(secret)]) {
			expect(profile, trace).not.toContain(trace)
		}
		// The status pages: the focal post's parent by the same rule, a remote one linked at its origin.
		const remotePage = parseHtml(await (await h.request(statusPath(toRemote))).text())
		const external = query(one(one(remotePage, 'main'), 'p', 'reply-to'), 'a')
		expect(external.map((a) => [attr(a, 'href'), attr(a, 'rel')])).toEqual([
			[`https://remote.example/objects/${remote}`, 'nofollow noopener'],
		])
		expect(text(one(one(remotePage, 'main'), 'p', 'reply-to'))).toContain('@carol@carol.example')
		const secretPage = await (await h.request(statusPath(toSecret))).text()
		expect(secretPage).not.toContain('In reply to')
		expect(secretPage).not.toContain(String(secret.id))
		const shownPage = parseHtml(await (await h.request(statusPath(toShown))).text())
		expect(query(one(one(shownPage, 'main'), 'p', 'reply-to'), 'a').map((a) => attr(a, 'href'))).toEqual([
			statusPath(shown),
		])

		// The read itself: an entry for the visible parent only, and none for the private one.
		const read = await h.store.webProfilePage(BUILD, postsTab('alice', null, NOW))
		expect(read.status === 'ok' ? Object.keys(read.parents) : null).toEqual([String(shown.id)])
	})
})

// A local account whose profile is at the bounds its columns take (RES-2): the bio of MAX_BIO and a display name of
// 2,048 escaping characters.
async function largeProfile(h: Harness, id: string) {
	await sql(h.store, 'UPDATE accounts SET note = ?, display_name = ? WHERE id = ?', MAX_BIO, C.repeat(2048), id)
}

describe('the composite budget (design §2, RES-3)', () => {
	// Inputs at their cap: the account's bio and display name; each post's content, poll, attachments and emoji
	// (bigStatus, about 0.98 MB of JSON each). Not at its cap: a post's unit maximum (a quote of a quote, "Maxima of
	// presented units"), which no admission figure here depends on, since every part is admitted only while it fits.
	it('keeps the real RPC answer within ANSWER_BYTES at large posts, and every page walk advances', async () => {
		const h = await community(['bob'])
		const { bob } = h.users
		await largeProfile(h, bob.id)
		const posts: string[] = []
		for (let i = 0; i < 24; i++) {
			// Every other post a reply to the one before it, so each page reserves parent links.
			const reply = i % 2 === 1 ? { inReplyToId: posts.at(-1) } : {}
			posts.push(await bigStatus(h, bob.id, NOW - (30 - i) * 60_000, reply))
		}
		// Self-replies, which the posts tab keeps (a seeded reply names no parent account).
		await sql(h.store, 'UPDATE statuses SET in_reply_to_account_id = account_id WHERE in_reply_to_id IS NOT NULL')
		const walked = await walkProfile(async (maxId) => {
			const read = await h.store.webProfilePage(BUILD, postsTab('bob', maxId, NOW))
			if (read.status !== 'ok') {
				throw new Error(read.status)
			}
			expect(jsonBytes(read)).toBeLessThanOrEqual(ANSWER_BYTES)
			return read
		})
		expect(walked.seen).toEqual(posts.toReversed())
		// Cut by bytes: no page holds all 20 of a full page.
		expect(walked.pages.every((page) => page.shown < 20 && !page.stub)).toBe(true)
		expect(walked.pages.length).toBeGreaterThan(2)
	}, 300_000)

	it('stubs a first post that does not fit beside the account, and continues past it', async () => {
		const h = await community(['bob'])
		const { bob } = h.users
		const posts: string[] = []
		for (let i = 0; i < 6; i++) {
			const big = i % 3 === 0
			posts.push(
				big
					? await bigStatus(h, bob.id, NOW - (10 - i) * 60_000)
					: await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: NOW - (10 - i) * 60_000 })
			)
		}
		// A budget that fits the account and small posts, but no big one: each big post is stubbed when it comes
		// first, and ends the page when it comes later.
		const answerBytes = 400_000
		const walked = await walkProfile((maxId) =>
			runInDurableObject(h.store, (_instance, state) => {
				const page = profilePageWithin(new Db(state.storage.sql), postsTab('bob', maxId, NOW), SITE, answerBytes)
				if (page.status !== 'ok') {
					throw new Error(page.status)
				}
				expect(jsonBytes({ ...page, site: SITE })).toBeLessThanOrEqual(answerBytes)
				return page
			})
		)
		expect(walked.seen).toEqual(posts.toReversed())
		expect(walked.pages.filter((page) => page.stub)).toHaveLength(2)
		// Rendered: the stub's row names the author and links the post twice (its date and "Open"); the page offers the
		// posts after it.
		// The second page starts at the newer big post (posts[3]).
		const page = await runInDurableObject(h.store, (_instance, state) =>
			profilePageWithin(new Db(state.storage.sql), postsTab('bob', posts[4]!, NOW), SITE, answerBytes)
		)
		if (page.status !== 'ok' || page.stub === null) {
			throw new Error('expected a stubbed first post')
		}
		const html = String(
			await jsx(ProfilePage, {
				account: page.account,
				tab: { kind: 'posts' },
				pins: page.pins,
				statuses: page.statuses,
				stub: page.stub,
				parents: page.parents,
				cursor: { maxId: posts[4]! },
				paging: page.paging,
				site: SITE,
				actorUri: 'https://kopje.test/ap/users/bob',
			}).toString()
		)
		const row = query(one(parseHtml(html), 'main'), 'article', 'post')[0]!
		expect(text(row)).toContain('@bob@kopje.test')
		expect(query(row, 'a').map((a) => [attr(a, 'href'), text(a)])).toEqual([
			[`/@bob/${posts[3]!}`, expect.any(String)],
			[`/@bob/${posts[3]!}`, 'Open'],
		])
		expect(html).toContain(`/@bob?max_id=${posts[3]!}`)
	}, 300_000)

	it('stubs a boost by its original (amendment A2), local or remote', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		const local = await post(h, alice, { status: 'the local original' })
		const remote = await seedStatus(h.store, { accountId: carol, visibility: 'public' })
		for (const original of [String(local.id), remote]) {
			await h.request(`/api/v1/statuses/${original}/reblog`, bearer(bob.token, { method: 'POST' }))
		}
		const stubs = await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const seen: unknown[] = []
			let maxId: string | undefined
			for (let i = 0; i < 4; i++) {
				// Nothing fits beside the head: each page is its first item's stub.
				const list = statusList(pageBudget({}, 2))
				const read = accountStatusesWithin(
					db,
					{
						account: bob.id,
						page: { limit: 20, ...(maxId === undefined ? {} : { maxId }) },
						onlyMedia: false,
						excludeReplies: true,
						excludeReblogs: false,
						pinned: false,
						tagged: null,
						present: { origin: 'https://kopje.test' },
					},
					contextOf(null, NOW),
					list.admission
				)
				const stub = list.stub()
				if (stub === null) {
					expect(read?.page.items).toEqual([])
					break
				}
				seen.push(stub)
				expect(read?.page.oldest).toBe(stub.id)
				maxId = stub.id
			}
			return seen
		})
		expect(stubs).toEqual([
			{
				id: expect.any(String),
				url: `https://remote.example/objects/${remote}`,
				acct: 'carol@carol.example',
				created_at: expect.any(String),
			},
			{ id: expect.any(String), url: String(local.url), acct: 'alice', created_at: String(local.created_at) },
		])
		// The stub's figure in the frame bounds every stub.
		for (const stub of stubs) {
			expect(jsonBytes(stub)).toBeLessThanOrEqual(jsonBytes(LONGEST_STATUS_STUB))
		}
	})
})

describe('the composite budget at its boundaries (design §2)', () => {
	const FRAME = profileFrameBytes(SITE)

	const profileWithin = (h: Harness, bytes: number, maxId: string | null = null) =>
		runInDurableObject(h.store, (_instance, state) =>
			profilePageWithin(new Db(state.storage.sql), postsTab('bob', maxId, NOW), SITE, bytes)
		)

	it('admits the first post at exactly what the frame, the account and its parent link leave, and stubs it below', async () => {
		const h = await community(['bob'])
		const { bob } = h.users
		const parent = await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: NOW - 120_000 })
		const reply = await seedStatus(h.store, {
			accountId: bob.id,
			visibility: 'public',
			inReplyToId: parent,
			published: NOW - 60_000,
		})
		await sql(h.store, 'UPDATE statuses SET in_reply_to_account_id = account_id WHERE id = ?', reply)
		const full = await profileWithin(h, ANSWER_BYTES)
		if (full.status !== 'ok') {
			throw new Error(full.status)
		}
		const [first] = full.statuses
		expect(first?.id).toBe(reply)
		const head = FRAME + jsonBytes(full.account)
		const fits = head + jsonBytes(first) + 1 + PARENT_ENTRY_BYTES
		const at = await profileWithin(h, fits)
		expect(at.status === 'ok' && [at.statuses[0]?.id, at.stub, Object.keys(at.parents)]).toEqual([
			reply,
			null,
			[parent],
		])
		expect(jsonBytes({ ...at, site: SITE })).toBeLessThanOrEqual(fits)
		const below = await profileWithin(h, fits - 1)
		expect(below.status === 'ok' && [below.statuses, below.stub?.id, olderOf(below)]).toEqual([[], reply, reply])
		expect(jsonBytes({ ...below, site: SITE })).toBeLessThanOrEqual(fits - 1)
		// The head itself must fit: one byte less is refused rather than answered past the budget.
		await expect(profileWithin(h, head - 1)).rejects.toThrow('a page head passed its answer budget')
		expect((await profileWithin(h, head)).status).toBe('ok')
	})

	it('charges a stub its measured bytes past the reservation', () => {
		// Stored status ids are 18 digits (their CHECK), so no stored stub passes LONGEST_STATUS_STUB; the charge holds
		// the budget even when a reservation is short, as here: a stub of 100 bytes against a reservation of 40.
		const stub = { of: () => 'x'.repeat(98), reserved: 40 }
		const roomy = { remaining: 60 }
		expect(admitHead(roomy, 'item', stub, () => 1_000)).toEqual({ stub: 'x'.repeat(98) })
		expect(roomy.remaining).toBe(0)
		expect(() => admitHead({ remaining: 59 }, 'item', stub, () => 1_000)).toThrow('a stub passed its answer budget')
		// An item that fits is admitted and charged its size; no stub is made.
		const fits = { remaining: 1_000 }
		expect(admitHead(fits, 'item', stub, () => 1_000)).toEqual({ item: 'item', bytes: 1_000 })
		expect(fits.remaining).toBe(0)
	})

	it('stubs the first post read oldest first (min_id), and continues past it', async () => {
		const h = await community(['bob'])
		const { bob } = h.users
		const posts: string[] = []
		for (let i = 0; i < 3; i++) {
			posts.push(
				await seedStatus(h.store, { accountId: bob.id, visibility: 'public', published: NOW - (10 - i) * 1000 })
			)
		}
		const stubs = await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const seen: string[] = []
			let minId = '0'
			for (let i = 0; i < 5; i++) {
				const list = statusList(pageBudget({}, 2))
				const read = accountStatusesWithin(
					db,
					{
						account: bob.id,
						page: { limit: 20, minId },
						onlyMedia: false,
						excludeReplies: true,
						excludeReblogs: true,
						pinned: false,
						tagged: null,
						present: { origin: 'https://kopje.test' },
					},
					contextOf(null, NOW),
					list.admission
				)
				const stub = list.stub()
				if (stub === null) {
					expect(read?.page.items).toEqual([])
					break
				}
				// Ascending, the continuation is the page's newest end: the stubbed post.
				expect(read?.page.newest).toBe(stub.id)
				seen.push(stub.id)
				minId = stub.id
			}
			return seen
		})
		expect(stubs).toEqual(posts)
	})
})

describe('imported values in a page’s links (docs/engineering.md, stored values)', () => {
	it('leaves out a time that does not parse, so a stub stays within the budget', async () => {
		const h = await community(['bob'])
		const { bob } = h.users
		const id = await seedStatus(h.store, { accountId: bob.id, visibility: 'public' })
		// A converted row's published_at, which no stored bound holds: 1,500,000 control characters, each six bytes as
		// JSON, so the post alone passes the answer budget and comes as a stub.
		await sql(h.store, 'UPDATE statuses SET published_at = ? WHERE id = ?', '\u0001'.repeat(1_500_000), id)
		const page = await h.store.webProfilePage(BUILD, postsTab('bob', null, NOW))
		expect(page.status === 'ok' && [page.statuses, page.stub]).toEqual([
			[],
			{ id, url: `https://kopje.test/@bob/${id}`, acct: 'bob', created_at: null },
		])
		expect(jsonBytes(page)).toBeLessThanOrEqual(ANSWER_BYTES)
	})

	it('links no parent whose author’s domain passes the link bound', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// A domain whose acct passes LINK_ACCT_JSON_BYTES (a username and an actor id's host, each byte escaped to six),
		// which no stored bound refuses: accounts.domain has none.
		const domain = `${'d'.repeat(20_000)}.example`
		expect(jsonBytes(`carol@${domain}`)).toBeGreaterThan(LINK_ACCT_JSON_BYTES)
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		await sql(h.store, 'UPDATE accounts SET domain = ? WHERE id = ?', domain, carol)
		const parent = await seedStatus(h.store, { accountId: carol, visibility: 'public' })
		const reply = await seedStatus(h.store, { accountId: alice.id, visibility: 'public', inReplyToId: parent })
		await sql(h.store, 'UPDATE statuses SET in_reply_to_account_id = ? WHERE id = ?', carol, reply)
		const page = await h.store.webStatusPage(BUILD, { handle: 'alice', id: reply, now: NOW })
		expect(page.status === 'ok' && page.parent).toBeNull()
		const html = await (await h.request(`/@alice/${reply}`)).text()
		expect(html).not.toContain('In reply to')
		expect(html).not.toContain(domain)
		// The same parent in a list: no entry, and the reservation comes back whole.
		const listed = await runInDurableObject(h.store, (_instance, state) => {
			const db = new Db(state.storage.sql)
			const budget = pageBudget({})
			const list = statusList(budget)
			const read = accountStatusesWithin(
				db,
				{
					account: alice.id,
					page: { limit: 20 },
					onlyMedia: false,
					excludeReplies: false,
					excludeReblogs: true,
					pinned: false,
					tagged: null,
					present: { origin: 'https://kopje.test' },
				},
				contextOf(null, NOW),
				list.admission
			)
			const items = read?.page.items ?? []
			const after = budget.remaining
			return { ids: items.map((s) => s.id), parents: listParents(db, budget, items), refund: budget.remaining - after }
		})
		expect(listed).toEqual({ ids: [reply], parents: {}, refund: PARENT_ENTRY_BYTES })
	})
})
