import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { LEGACY } from './federation-helpers'
import { PNG_PLAIN } from './fixtures/images'
import { bytes, mediaForm, pathOf, TestCodec, uploaded } from './media-helpers'
import { community, post, remoteAccount, seedStatus } from './status-helpers'
import { ORIGIN } from './web-helpers'
import { PROFILE_PAGE_SIZE } from '../src/domain/web-pages'

// The public pages (B5): /@user and /@user/:id. VIS-4: an anonymous viewer sees only public and unlisted statuses of
// local accounts that are not suspended; everything else is the same 404. HTML-1, HTML-3: stored HTML is sanitized at
// the sink and links are http(s). WEB-2, WEB-3, WEB-5: headers.

const AP = { headers: { accept: 'application/activity+json' } }

async function page(h: Awaited<ReturnType<typeof community>>, path: string, init?: RequestInit) {
	const response = await h.request(path, init)
	return { response, html: await response.text() }
}

function statusPath(status: Record<string, unknown>): string {
	return new URL(String(status.url)).pathname
}

describe('public pages: headers (WEB-2, WEB-3, WEB-5)', () => {
	it('sends a CSP without script, denies framing, declares the type and opens no CORS', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'hello' })
		for (const path of ['/@alice', statusPath(status), '/@nobody']) {
			const response = await h.request(path, { headers: { origin: 'https://evil.example' } })
			expect(response.headers.get('content-type'), path).toBe('text/html; charset=UTF-8')
			expect(response.headers.get('x-content-type-options')).toBe('nosniff')
			expect(response.headers.get('x-frame-options')).toBe('DENY')
			const csp = response.headers.get('content-security-policy') ?? ''
			expect(csp).toContain("default-src 'none'")
			expect(csp).toContain("frame-ancestors 'none'")
			expect(csp).toContain("style-src 'self'")
			expect(csp).not.toContain('script-src')
			expect(csp).not.toContain('unsafe-inline')
			expect(response.headers.get('access-control-allow-origin')).toBeNull()
			expect(response.headers.get('vary')).toBe('Accept')
			expect(await response.text()).not.toContain('<script')
		}
	})

	it('answers 503 until setup has fixed the domain (SETUP-1)', async () => {
		const h = await community(['alice'])
		await sql(h.store, "DELETE FROM instance_settings WHERE name = 'domain'")
		expect((await h.request('/@alice')).status).toBe(503)
		expect((await h.request('/login')).status).toBe(503)
	})
})

describe('profile page', () => {
	it('shows the profile and the public and unlisted posts, newest first, without replies to others or boosts', async () => {
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
		for (const hidden of ['for followers', 'secret', 'reply to bob', 'bob speaks']) {
			expect(html, hidden).not.toContain(hidden)
		}
		// OpenGraph and the actor.
		expect(html).toContain('<meta property="og:type" content="profile"/>')
		expect(html).toContain('<meta property="og:url" content="https://kopje.test/@alice"/>')
		expect(html).toContain('<meta property="og:image" content="https://kopje.test/assets/avatar.png"/>')
		expect(html).toContain(
			'<link rel="alternate" type="application/activity+json" href="https://kopje.test/ap/users/alice"/>'
		)
		expect(html).toContain('<link rel="stylesheet" href="/assets/kopje.css"/>')
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
		const url = new URL(((await featured.json()) as { url: string }).url)
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
		expect(html).toContain('<h2>#cats</h2>')
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
		for (const unsafe of ['<script', 'onclick', 'onerror', '<iframe', '<img src="x"', 'javascript:', 'data:image']) {
			expect(html, unsafe).not.toContain(unsafe)
		}
		expect(html).toContain('<p>hi<a rel="nofollow noopener" target="_blank">j</a></p>')
		expect(html).toContain('https://kopje.test/assets/avatar.png')
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
		expect(html).toContain('<details class="cw"><summary><span class="spoiler">spoilers ahead</span>')
		expect(html).toContain('the &lt;reply&gt;')
		expect(html).toContain('<details class="sensitive">')
		expect(html).toContain(`src="${media.preview_url}"`)
		expect(html).toContain('alt="a &lt;plain&gt; square"')
		expect((await h.request(pathOf(media.url))).status).toBe(200)
		expect(html).toContain(`In reply to <a href="${String(parent.url)}">@alice</a>`)
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
