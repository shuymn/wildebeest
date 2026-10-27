import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { bearer, json, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { LEGACY } from './federation-helpers'
import { PNG_PLAIN } from './fixtures/images'
import { bytes, mediaForm, pathOf, TestCodec, uploaded } from './media-helpers'
import { rowsRead } from './read-helpers'
import { community, post, remoteAccount, seedStatus } from './status-helpers'
import { attr, closest, one, parseHtml, query, text } from './web-dom'
import { ICON_LINKS, iconLinksOf, olderOf, ORIGIN } from './web-helpers'
import { PROFILE_PAGE_SIZE, webProfilePage } from '../src/domain/web-pages/profile'
import { PACKAGE_VERSION, SOFTWARE_REPOSITORY } from '../src/platform/package-version'
import { L1_SCRIPT, STYLESHEET } from '../src/web/asset-versions'
import { calendarDate } from '../src/web/format'

// The public pages (B5): /@user and /@user/:id. VIS-4: an anonymous viewer sees only public and unlisted statuses of
// local accounts that are not suspended; everything else is the same 404. HTML-1, HTML-3: stored HTML is sanitized at
// the sink and links are http(s). WEB-2, WEB-3, WEB-5: headers.

const AP = { headers: { accept: 'application/activity+json' } }

async function page(h: Awaited<ReturnType<typeof community>>, path: string, init?: RequestInit) {
	const response = await h.request(path, init)
	return { response, html: await response.text() }
}

// Every <time> of a page: its datetime, its text and whether it is marked as an instant for the viewer's zone.
function times(html: string): { datetime: string | null; text: string; local: boolean }[] {
	return query(parseHtml(html), 'time').map((time) => ({
		datetime: attr(time, 'datetime'),
		text: text(time),
		local: attr(time, 'data-local') !== null,
	}))
}

function statusPath(status: Record<string, unknown>): string {
	return new URL(String(status.url)).pathname
}

describe('public pages: headers (WEB-2, WEB-3, WEB-5)', () => {
	// The exact policies, as literals (design §7.8), but for the bundle's fingerprinted path, a build value. Public
	// pages, with the bundle or without, play media (design §5); private pages do not (test/web-session.test.ts).
	const SCRIPT_FREE =
		"default-src 'none'; style-src 'self'; img-src 'self' https:; media-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
	const WITH_L1 = `default-src 'none'; script-src https://kopje.test${L1_SCRIPT}; style-src 'self'; img-src 'self' https:; media-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`

	it('sends a CSP naming only the L1 bundle on the pages that load it, and none on the others', async () => {
		expect(L1_SCRIPT).toMatch(/^\/assets\/kopje\.[0-9a-f]{10}\.js$/)
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'hello #walks' })
		await setSetting(h.store, 'privacy_policy', '<p>Policy</p>')
		await setSetting(h.store, 'terms_of_service', '<p>Terms</p>')
		await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
		const pages: [path: string, code: number, l1: boolean][] = [
			// The profile tabs, the status page and the hashtag page load the bundle.
			['/@alice', 200, true],
			['/@alice/with_replies', 200, true],
			['/@alice/media', 200, true],
			['/@alice/tagged/walks', 200, true],
			[statusPath(status), 200, true],
			['/tags/walks', 200, true],
			// Their 404s, and every other public page, are script-free.
			['/@nobody', 404, false],
			['/@alice/999999', 404, false],
			['/@alice/no-such-page', 404, false],
			[`/tags/${'a'.repeat(257)}`, 404, false],
			['/@alice/followers', 200, false],
			['/@alice/following', 200, false],
			['/about', 200, false],
			['/privacy-policy', 200, false],
			['/terms-of-service', 200, false],
			['/terms-of-service/2026-11-01', 200, false],
			['/terms-of-service/2026-11-02', 404, false],
		]
		for (const [path, code, l1] of pages) {
			const response = await h.request(path, { headers: { origin: 'https://evil.example' } })
			expect(response.status, path).toBe(code)
			expect(response.headers.get('content-type'), path).toBe('text/html; charset=UTF-8')
			expect(response.headers.get('x-content-type-options')).toBe('nosniff')
			expect(response.headers.get('x-frame-options')).toBe('DENY')
			expect(response.headers.get('content-security-policy'), path).toBe(l1 ? WITH_L1 : SCRIPT_FREE)
			expect(response.headers.get('access-control-allow-origin')).toBeNull()
			expect(response.headers.get('vary')).toBe('Accept')
			// The page loads exactly the script its CSP names, deferred, and nothing inline.
			const scripts = query(parseHtml(await response.text()), 'script').map((script) => ({
				src: attr(script, 'src'),
				defer: attr(script, 'defer') !== null,
				body: text(script),
			}))
			expect(scripts, path).toEqual(l1 ? [{ src: L1_SCRIPT, defer: true, body: '' }] : [])
		}
		// A suspended account's 410 is script-free too.
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		const gone = await h.request('/@alice')
		expect(gone.status).toBe(410)
		expect(gone.headers.get('content-security-policy')).toBe(SCRIPT_FREE)
		expect(await gone.text()).not.toContain('<script')
	})

	it('answers 503 until setup has fixed the domain (SETUP-1)', async () => {
		const h = await community(['alice'])
		await sql(h.store, "DELETE FROM instance_settings WHERE name = 'domain'")
		expect((await h.request('/@alice')).status).toBe(503)
		expect((await h.request('/login')).status).toBe(503)
		expect((await h.request('/about')).status).toBe(503)
	})
})

describe('about page', () => {
	it('shows the title, description, rules and contact address, escaped, at the URL /api/v2/instance names', async () => {
		const h = await community(['alice'])
		await setSetting(h.store, 'title', 'Kopje <Test>')
		await setSetting(h.store, 'description', 'A test & instance')
		await setSetting(h.store, 'contact_email', 'admin@kopje.test')
		await setSetting(h.store, 'rules', JSON.stringify(['Be kind', { text: '<b>No spam</b>', hint: 'No <ads>' }]))
		const { response, html } = await page(h, '/about')
		expect(response.status).toBe(200)
		expect(html).toContain('<title>Kopje &lt;Test&gt;</title>')
		const main = one(parseHtml(html), 'main')
		expect(text(one(main, 'h1'))).toBe('Kopje <Test>')
		expect(query(main, 'p').map(text)).toContain('A test & instance')
		expect(html).toContain('A test &amp; instance')
		// The rules and their hints, in order, in an ordered list; escaped (HTML-2).
		const rules = query(one(main, 'ol'), 'li').map((li) => query(li, 'p').map(text))
		expect(rules).toEqual([['Be kind'], ['<b>No spam</b>', 'No <ads>']])
		expect(html).toContain('&lt;b&gt;No spam&lt;/b&gt;')
		expect(html).not.toContain('<b>No spam')
		// No contact account: the email alone, a mailto: link in the body font.
		const details = one(main, 'dl')
		expect(query(details, 'dt').map(text)).toEqual(['Email', 'Software'])
		const email = one(query(details, 'dd')[0]!, 'a')
		expect([attr(email, 'href'), text(email)]).toEqual(['mailto:admin@kopje.test', 'admin@kopje.test'])
		const instance = await (await h.request('/api/v2/instance')).json<{ configuration: { urls: { about: string } } }>()
		expect(new URL(instance.configuration.urls.about).pathname).toBe('/about')
	})

	it('names the contact account first, linked to its profile, then the email, and the version NodeInfo gives', async () => {
		const h = await community(['alice'])
		await setSetting(h.store, 'contact_username', 'alice')
		await setSetting(h.store, 'contact_email', 'admin@kopje.test')
		const main = one(parseHtml((await page(h, '/about')).html), 'main')
		const rows = query(one(main, 'dl'), 'div').map((row) => [
			text(one(row, 'dt')),
			text(one(row, 'dd')),
			query(row, 'a').map((a) => attr(a, 'href')),
		])
		const nodeInfo = await (await h.request('/nodeinfo/2.1')).json<{ software: { version: string } }>()
		expect(rows).toEqual([
			['Contact', '@alice@kopje.test', ['/@alice']],
			['Email', 'admin@kopje.test', ['mailto:admin@kopje.test']],
			['Software', `Kopje ${nodeInfo.software.version}`, [SOFTWARE_REPOSITORY]],
		])
		expect(nodeInfo.software.version).toBe(PACKAGE_VERSION)
		// A character a URL reserves is percent-encoded in the link (RFC 6068 §6.1), and shown as written.
		await setSetting(h.store, 'contact_email', 'Mike&family@example.org')
		const encoded = one(parseHtml((await page(h, '/about')).html), 'dl')
		const mail = query(encoded, 'a').find((a) => attr(a, 'href')?.startsWith('mailto:'))!
		expect([attr(mail, 'href'), text(mail)]).toEqual(['mailto:Mike%26family@example.org', 'Mike&family@example.org'])
		// An address that is not one plain local part and domain stays text: nothing can add a header.
		await setSetting(h.store, 'contact_email', 'a@b.example?bcc=c@d.example')
		const odd = one(parseHtml((await page(h, '/about')).html), 'dl')
		expect(query(odd, 'a').map((a) => attr(a, 'href'))).toEqual(['/@alice', SOFTWARE_REPOSITORY])
		expect(text(odd)).toContain('a@b.example?bcc=c@d.example')
	})

	it('falls back to the domain as the title and leaves out what is not set', async () => {
		const h = await community(['alice'])
		const { response, html } = await page(h, '/about')
		expect(response.status).toBe(200)
		const main = one(parseHtml(html), 'main')
		expect(text(one(main, 'h1'))).toBe('kopje.test')
		// No rules, contact, extended description or documents: no list, and the details card with the software alone.
		expect(query(main, 'ol')).toEqual([])
		expect(['h2', 'h3'].flatMap((tag) => query(main, tag)).map(text)).toEqual(['Contact and details'])
		expect(query(main, 'dt').map(text)).toEqual(['Software'])
		expect(query(main, 'a').map((a) => attr(a, 'href'))).toEqual([SOFTWARE_REPOSITORY])
		for (const absent of ['Server rules', 'Email', 'Privacy policy', 'Terms of service']) {
			expect(text(main), absent).not.toContain(absent)
		}
	})

	it('shows the extended description sanitized at the sink, and links the documents while they are available', async () => {
		const h = await community(['alice'])
		await setSetting(
			h.store,
			'extended_description',
			'<p>About <a href="https://example.com/">us</a><script>alert(1)</script></p>'
		)
		await setSetting(h.store, 'privacy_policy', '<p>Policy</p>')
		const { html } = await page(h, '/about')
		expect(html).toContain(
			'<p>About <a href="https://example.com/" rel="nofollow noopener" target="_blank">us</a></p></div>'
		)
		expect(html).not.toContain('alert(1)')
		// The privacy policy is linked from the page and from the footer; the missing terms nowhere.
		const doc = parseHtml(html)
		for (const part of [one(doc, 'main'), one(doc, 'footer')]) {
			const policy = query(part, 'a').filter((a) => attr(a, 'href') === '/privacy-policy')
			expect(policy.map(text)).toEqual(['Privacy policy'])
		}
		expect(html).not.toContain('/terms-of-service')
	})
})

describe('document pages', () => {
	it('serve the privacy policy and the terms of service as stored, sanitized at the sink, and 404 without them', async () => {
		const h = await community(['alice'])
		for (const path of ['/privacy-policy', '/terms-of-service', '/terms-of-service/2026-11-01']) {
			expect((await h.request(path)).status, path).toBe(404)
		}
		const raw = '<h2>Data</h2><p>We keep <a href="https://example.com/x">little</a>.<script>alert(1)</script></p>'
		const safe =
			'<h2>Data</h2><p>We keep <a href="https://example.com/x" rel="nofollow noopener" target="_blank">little</a>.</p>'
		await setSetting(h.store, 'privacy_policy', raw)
		await setSetting(h.store, 'privacy_policy_updated_at', '2026-10-01T23:30:00.000Z')
		const policy = await page(h, '/privacy-policy')
		expect(policy.response.status).toBe(200)
		expect(text(one(parseHtml(policy.html), 'h1'))).toBe('Privacy policy')
		expect(policy.html).toContain(`${safe}</div>`)
		// The stamp is an instant, but the page loads no bundle and its time of day does not matter: shown as its UTC
		// calendar date, as Mastodon's page shows only a date.
		expect(times(policy.html)).toEqual([{ datetime: '2026-10-01', text: 'Oct 1, 2026', local: false }])
		expect(policy.html).not.toContain('alert(1)')
		await setSetting(h.store, 'terms_of_service', raw)
		// Without its date the terms of service is not available.
		expect((await h.request('/terms-of-service')).status).toBe(404)
		await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
		for (const path of ['/terms-of-service', '/terms-of-service/2026-11-01']) {
			const terms = await page(h, path)
			expect(terms.response.status, path).toBe(200)
			// The effective date is a calendar date: the same day everywhere, never marked for rewriting.
			expect(times(terms.html)).toEqual([{ datetime: '2026-11-01', text: calendarDate('2026-11-01'), local: false }])
			expect(calendarDate('2026-11-01')).toBe('Nov 1, 2026')
			expect(terms.html).toContain(`${safe}</div>`)
		}
		for (const path of ['/terms-of-service/2026-11-02', '/terms-of-service/2026-11-1']) {
			expect((await h.request(path)).status, path).toBe(404)
		}
	})
})

describe('profile page', () => {
	it('shows the profile and the public and unlisted posts and boosts, newest first, without replies to others', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(alice.token, {
				...json({
					display_name: 'Alice',
					note: 'Curiouser and curiouser',
					fields_attributes: [
						{ name: 'Site', value: 'https://alice.example/' },
						{ name: 'Mood', value: '<b>bold</b>' },
					],
				}),
				method: 'PATCH',
			})
		)
		const first = await post(h, alice, { status: 'first public' })
		await post(h, alice, { status: 'quiet one', visibility: 'unlisted' })
		await post(h, alice, { status: 'for followers', visibility: 'private' })
		await post(h, alice, { status: '@bob secret', visibility: 'direct' })
		await post(h, alice, { status: 'thread', in_reply_to_id: first.id })
		const bobs = await post(h, bob, { status: 'bob speaks' })
		await post(h, alice, { status: '@bob reply to bob', in_reply_to_id: bobs.id })
		await h.request(`/api/v1/statuses/${bobs.id}/reblog`, bearer(alice.token, { method: 'POST' }))

		const { response, html } = await page(h, '/@alice')
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('public, max-age=60')
		expect(html).toContain('Alice')
		expect(html).toContain('@alice@kopje.test')
		expect(html).toContain('<p>Curiouser and curiouser</p>')
		// Fields: rel="me" on links (HTML-3: http(s) only), values escaped (HTML-2).
		expect(html).toContain('<dt>Site</dt>')
		expect(html).toMatch(/<a href="https:\/\/alice\.example\/" rel="me nofollow noopener" target="_blank">/)
		expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
		// Posts: public, unlisted and the self-thread, newest first.
		expect(html).toContain('first public')
		expect(html).toContain('quiet one')
		expect(html).toContain('thread')
		expect(html.indexOf('thread')).toBeLessThan(html.indexOf('first public'))
		for (const hidden of ['for followers', 'secret', 'reply to bob']) {
			expect(html, hidden).not.toContain(hidden)
		}
		// The boost (VIS-6): its original under the booster's label, newest first.
		const boost = query(one(parseHtml(html), 'main'), 'article')[0]!
		expect(text(query(boost, 'p', 'label')[0]!)).toBe('Alice boosted')
		expect(text(boost)).toContain('bob speaks')
		expect(query(boost, 'a').map((a) => attr(a, 'href'))).toContain(statusPath(bobs))
		// OpenGraph and the actor.
		expect(html).toContain('<meta property="og:type" content="profile"/>')
		expect(html).toContain('<meta property="og:url" content="https://kopje.test/@alice"/>')
		expect(html).toContain('<meta property="og:image" content="https://kopje.test/assets/avatar.jpg"/>')
		expect(html).toContain(
			'<link rel="alternate" type="application/activity+json" href="https://kopje.test/ap/users/alice"/>'
		)
		// Exactly one stylesheet, by its fingerprinted name (amendment A1).
		expect([...html.matchAll(/<link rel="stylesheet" href="([^"]*)"/g)].map((m) => m[1])).toEqual([STYLESHEET])
		expect(STYLESHEET).toMatch(/^\/assets\/kopje\.[0-9a-f]{10}\.css$/)
		expect(iconLinksOf(html)).toEqual(ICON_LINKS)
	})

	it('pages older posts', async () => {
		const h = await community(['alice'])
		for (let i = 0; i <= PROFILE_PAGE_SIZE; i++) {
			await seedStatus(h.store, {
				accountId: h.users.alice.id,
				visibility: 'public',
				content: `<p>post number ${i}.</p>`,
				published: NOW - (PROFILE_PAGE_SIZE - i) * 1000,
			})
		}
		const { html } = await page(h, '/@alice')
		expect(html).toContain(`post number ${PROFILE_PAGE_SIZE}.`)
		expect(html).not.toContain('post number 0.')
		const next = /href="(\/@alice\?max_id=\d{18})"/.exec(html)?.[1]
		expect(next).toBeDefined()
		const older = await page(h, next ?? '')
		expect(older.html).toContain('post number 0.')
		expect(older.html).not.toContain(`post number ${PROFILE_PAGE_SIZE}.`)
		expect(older.html).not.toContain('max_id=')
	})

	it('serves the URL of a featured hashtag: the profile’s posts with it, paged', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const featured = await h.request('/api/v1/featured_tags', bearer(alice.token, json({ name: 'Cats' })))
		const url = new URL((await featured.json<{ url: string }>()).url)
		expect(url.pathname).toBe('/@alice/tagged/cats')
		await post(h, alice, { status: '#cats alpha' })
		await post(h, alice, { status: '#cats bravo', visibility: 'unlisted' })
		await post(h, alice, { status: '#cats charlie', visibility: 'private' })
		await post(h, alice, { status: '#dogs delta' })
		await post(h, bob, { status: '#cats echo' })
		const { response, html } = await page(h, url.pathname)
		expect(response.status).toBe(200)
		expect(html).toContain('alpha')
		expect(html).toContain('bravo')
		// The page's own headings, outside its follow dialog (design §8).
		const headings = query(one(parseHtml(html), 'main'), 'h2').filter(
			(h2) => closest(h2, (e) => e.tagName === 'dialog') === null
		)
		expect(headings.map(text)).toEqual(['#cats'])
		for (const hidden of ['charlie', 'delta', 'echo']) {
			expect(html, hidden).not.toContain(hidden)
		}
		for (let i = 0; i < PROFILE_PAGE_SIZE; i++) {
			await post(h, alice, { status: `#cats more ${i}.` })
		}
		const first = await page(h, url.pathname)
		const next = /href="(\/@alice\/tagged\/cats\?max_id=\d{18})"/.exec(first.html)?.[1]
		expect(next).toBeDefined()
		const older = await page(h, next ?? '')
		expect(older.html).toContain('alpha')
		expect(older.html).not.toContain(`more ${PROFILE_PAGE_SIZE - 1}.`)
		expect((await page(h, '/@alice/tagged/a-b')).response.status).toBe(404)
		expect((await page(h, '/@nobody/tagged/cats')).response.status).toBe(404)
	})

	it('reads the account’s own posts for a tagged page, not other accounts’ posts with the hashtag (RES-7)', async () => {
		const measure = async (others: number) => {
			const h = await community(['alice'])
			for (let i = 0; i < PROFILE_PAGE_SIZE + 5; i++) {
				await seedStatus(h.store, {
					accountId: h.users.alice.id,
					visibility: 'public',
					tags: ['cats'],
					published: NOW - 3_600_000 + i * 1000,
				})
			}
			const carol = await remoteAccount(h.store, 'carol')
			// Newer public statuses of another account with the same hashtag.
			await sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
				INSERT INTO statuses (id, uri, account_id, visibility, published_at)
				SELECT CAST(900000000000000000 + i AS TEXT), 'https://remote.example/o/' || i, ?1, 'public', '2026-01-01T00:00:00.000Z'
				FROM n`,
				carol,
				others
			)
			await sql(
				h.store,
				"INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses WHERE account_id = ?",
				carol
			)
			const input = (maxId: string | null) => ({
				handle: 'alice',
				tab: { kind: 'tagged', tag: 'cats' } as const,
				cursor: maxId === null ? null : { maxId },
				now: NOW,
			})
			const newest = await runInDurableObject(h.store, (_instance, state) =>
				webProfilePage.run(state.storage.sql, input(null))
			)
			expect(newest.status === 'ok' ? newest.statuses.length : 0).toBe(PROFILE_PAGE_SIZE)
			const maxId = newest.status === 'ok' ? olderOf(newest) : null
			expect(maxId).not.toBeNull()
			return [await rowsRead(h, webProfilePage, input(null)), await rowsRead(h, webProfilePage, input(maxId))]
		}
		const [fewNewest = 0, fewOlder = 0] = await measure(100)
		const [manyNewest = 0, manyOlder = 0] = await measure(2000)
		expect(manyNewest).toBeLessThanOrEqual(fewNewest + 10)
		expect(manyOlder).toBeLessThanOrEqual(fewOlder + 10)
	}, 60_000)

	it('sanitizes stored HTML at the sink and drops non-http links (HTML-1, HTML-3)', async () => {
		const h = await community(['alice'])
		await sql(
			h.store,
			`UPDATE accounts SET note = ?, avatar_url = 'javascript:alert(1)', header_url = 'data:image/png;base64,AA'`,
			'<p onclick="x()">hi<script>alert(1)</script><a href="javascript:alert(2)">j</a></p>'
		)
		await seedStatus(h.store, {
			accountId: h.users.alice.id,
			visibility: 'public',
			content: '<p>ok<img src=x onerror=alert(3)><iframe src="https://evil.example"></iframe></p>',
		})
		const { html } = await page(h, '/@alice')
		for (const unsafe of ['onclick', 'onerror', '<iframe', '<img src="x"', 'javascript:', 'data:image', 'alert(1)']) {
			expect(html, unsafe).not.toContain(unsafe)
		}
		// The one script is the page's own L1 bundle (design §7.5).
		expect([...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])).toEqual([`<script defer="" src="${L1_SCRIPT}">`])
		expect(html).toContain('<p>hi<a rel="nofollow noopener" target="_blank">j</a></p>')
		expect(html).toContain('https://kopje.test/assets/avatar.jpg')
	})

	it('answers 410 for a suspended account and 404 for none or a remote one', async () => {
		const h = await community(['alice'])
		await remoteAccount(h.store, 'carol', 'carol.example')
		expect((await h.request('/@nobody')).status).toBe(404)
		expect((await h.request('/@carol@carol.example')).status).toBe(404)
		expect((await h.request('/@alice@kopje.test')).status).toBe(200)
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		const gone = await page(h, '/@alice')
		expect(gone.response.status).toBe(410)
		expect(gone.html).not.toContain('@alice@')
	})

	it('serves the actor to an ActivityPub client', async () => {
		const h = await community(['alice'])
		// A real public key: the actor document publishes it.
		await sql(h.store, 'UPDATE local_accounts SET pubkey = ?', LEGACY.pubkey)
		for (const accept of [
			'application/activity+json',
			'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
		]) {
			const response = await h.request('/@alice', { headers: { accept } })
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toMatch(/^application\/activity\+json/)
			expect(response.headers.get('vary')).toContain('Accept')
			expect(await response.json()).toMatchObject({ id: 'https://kopje.test/ap/users/alice', type: 'Person' })
		}
	})
})

describe('profile over ActivityPub', () => {
	it('resolves a differently cased handle to the stored username', async () => {
		const h = await community(['alice'])
		await sql(h.store, 'UPDATE local_accounts SET pubkey = ?', LEGACY.pubkey)
		for (const path of ['/@ALICE', '/@Alice@kopje.test']) {
			const response = await h.request(path, AP)
			expect(response.status, path).toBe(200)
			expect(await response.json()).toMatchObject({ id: 'https://kopje.test/ap/users/alice' })
		}
		expect((await h.request('/@nobody', AP)).status).toBe(404)
	})

	it('serves a suspended actor redacted, with its key and suspended: true, at /@user and the actor URI', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(alice.token, {
				...json({
					display_name: 'Alice',
					note: 'bio',
					fields_attributes: [{ name: 'Site', value: 'https://a.example/' }],
				}),
				method: 'PATCH',
			})
		)
		await sql(
			h.store,
			"UPDATE accounts SET avatar_url = 'https://kopje.test/a.png', header_url = 'https://kopje.test/h.png'"
		)
		await sql(
			h.store,
			'UPDATE local_accounts SET pubkey = ?, suspended_at = ?',
			LEGACY.pubkey,
			new Date(NOW).toISOString()
		)
		for (const path of ['/@alice', '/@ALICE', '/ap/users/alice']) {
			const response = await h.request(path, AP)
			expect(response.status, path).toBe(200)
			const actor = await response.json<Record<string, unknown>>()
			expect(actor, path).toMatchObject({
				id: 'https://kopje.test/ap/users/alice',
				preferredUsername: 'alice',
				suspended: true,
				manuallyApprovesFollowers: false,
				publicKey: { id: 'https://kopje.test/ap/users/alice#main-key' },
			})
			for (const hidden of ['name', 'summary', 'icon', 'image', 'attachment', 'alsoKnownAs']) {
				expect(actor[hidden], `${path} ${hidden}`).toBeUndefined()
			}
		}
		// The HTML profile stays 410.
		expect((await h.request('/@ALICE')).status).toBe(410)
	})
})

describe('permalink (VIS-4)', () => {
	it('shows a public status with its content warning, media and the visible parent', async () => {
		const codec = new TestCodec()
		const h = await community(['alice'], 'read write follow', { images: () => codec })
		const { alice } = h.users
		const parent = await post(h, alice, { status: 'the parent' })
		const media = await uploaded(
			h,
			alice,
			mediaForm(bytes(PNG_PLAIN), { description: 'a <plain> square' }, 'p.png', 'image/png')
		)
		const status = await post(h, alice, {
			status: 'the <reply>',
			spoiler_text: 'spoilers ahead',
			in_reply_to_id: parent.id,
			media_ids: [media.id],
			sensitive: true,
		})
		const { response, html } = await page(h, statusPath(status))
		expect(response.status).toBe(200)
		const article = one(one(parseHtml(html), 'main'), 'article', 'focal')
		// The content warning: a details whose summary holds the warning, with the content and media inside.
		const cw = one(article, 'details', 'cw')
		expect(text(query(cw, 'summary')[0]!)).toContain('spoilers ahead')
		expect(text(cw)).toContain('the <reply>')
		expect(html).toContain('the &lt;reply&gt;')
		// Sensitive media inside a details of its own; the alt text is the description, escaped.
		const image = one(one(cw, 'details', 'sensitive'), 'img')
		expect(attr(image, 'src')).toBe(media.preview_url)
		expect(attr(image, 'alt')).toBe('a <plain> square')
		expect(html).toContain('alt="a &lt;plain&gt; square"')
		expect((await h.request(pathOf(media.url))).status).toBe(200)
		// The reply-to line: the catalogue text and a link to the parent, by its local path.
		const replyTo = one(article, 'p', 'reply-to')
		expect(text(replyTo)).toBe('In reply to @alice')
		expect(query(replyTo, 'a').map((a) => [attr(a, 'href'), text(a)])).toEqual([
			[new URL(String(parent.url)).pathname, '@alice'],
		])
		expect(html).toContain('<meta property="og:type" content="article"/>')
		expect(html).toContain('<meta property="og:description" content="spoilers ahead"/>')
		// A sensitive status shows no image in its preview.
		expect(html).not.toContain('og:image')
		expect(html).toContain(`<link rel="alternate" type="application/activity+json" href="${String(status.uri)}"/>`)
	})

	it('links no parent the viewer may not see', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const parent = await post(h, alice, { status: 'followers only', visibility: 'private' })
		const reply = await post(h, alice, { status: 'public reply', in_reply_to_id: parent.id })
		const { response, html } = await page(h, statusPath(reply))
		expect(response.status).toBe(200)
		expect(html).not.toContain('In reply to')
		expect(html).not.toContain(String(parent.id))
	})

	it('answers the same 404 for private, direct, limited, boosts, remote, another author and nothing', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		const missing = await page(h, '/@alice/100000000000000001')
		expect(missing.response.status).toBe(404)
		const paths: string[] = []
		for (const visibility of ['private', 'direct']) {
			paths.push(statusPath(await post(h, alice, { status: `@bob ${visibility}`, visibility })))
		}
		const limited = await seedStatus(h.store, { accountId: alice.id, visibility: 'limited', uri: `${ORIGIN}/ap/o/l` })
		paths.push(`/@alice/${limited}`)
		const bobs = await post(h, bob, { status: 'bob public' })
		const boost = await h.request(`/api/v1/statuses/${bobs.id}/reblog`, bearer(alice.token, { method: 'POST' }))
		paths.push(`/@alice/${(await boost.json<{ id: string }>()).id}`)
		paths.push(`/@alice/${String(bobs.id)}`)
		const remote = await seedStatus(h.store, { accountId: carol, visibility: 'public' })
		paths.push(`/@carol@carol.example/${remote}`, `/@alice/${remote}`, '/@alice/not-an-id')
		for (const path of paths) {
			const hidden = await page(h, path)
			expect(hidden.response.status, path).toBe(404)
			expect(hidden.html, path).toBe(missing.html)
			expect((await h.request(path, AP)).status, `${path} (AP)`).toBe(404)
		}
	})

	it('hides the statuses of a suspended account', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'before' })
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		expect((await h.request(statusPath(status))).status).toBe(404)
		expect((await h.request(statusPath(status), AP)).status).toBe(404)
	})

	it('serves the Note to an ActivityPub client and moves a legacy id', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'hello', visibility: 'unlisted' })
		const note = await h.request(statusPath(status), AP)
		expect(note.status).toBe(200)
		expect(note.headers.get('content-type')).toMatch(/^application\/activity\+json/)
		expect(await note.json()).toMatchObject({ id: status.uri, type: 'Note' })
		expect((await h.request(statusPath(status))).status).toBe(200)

		await sql(h.store, "UPDATE statuses SET legacy_id = '3f1c2b9e-0000-4000-8000-000000000001' WHERE id = ?", status.id)
		// The target uses the stored username, never the request's spelling (WEB-4).
		const moved = await h.request('/@ALICE/3f1c2b9e-0000-4000-8000-000000000001')
		expect(moved.status).toBe(301)
		expect(moved.headers.get('location')).toBe(statusPath(status))
	})
})
