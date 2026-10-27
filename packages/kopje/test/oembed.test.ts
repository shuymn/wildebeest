import { describe, expect, it } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { community, post, remoteAccount, seedStatus } from './status-helpers'
import { attr, one, parseHtml, query, text } from './web-dom'
import { ORIGIN } from './web-helpers'

// oEmbed (Mastodon 4.5's Api::OEmbedController and OEmbedSerializer) and the embed page it names
// (StatusesController#embed). A status is embeddable exactly when its status page shows it (VIS-4); the embed page is
// the one page other sites may frame (WEB-2).

type Harness = Awaited<ReturnType<typeof community>>

function oembed(h: Harness, url: string, extra = '') {
	return h.request(`/api/oembed?url=${encodeURIComponent(url)}${extra}`)
}

function pathOf(status: Record<string, unknown>): string {
	return new URL(String(status.url)).pathname
}

describe('GET /api/oembed', () => {
	it('answers a public status as a rich embed of its embed page, with no token', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(alice.token, { ...json({ display_name: 'Alice <b>&"' }), method: 'PATCH' })
		)
		const status = await post(h, alice, { status: 'hello' })
		const response = await oembed(h, String(status.url))
		expect(response.status).toBe(200)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		const body = await response.json<Record<string, unknown>>()
		expect(body).toEqual({
			type: 'rich',
			version: '1.0',
			author_name: 'Alice <b>&"',
			author_url: `${ORIGIN}/@alice`,
			provider_name: 'kopje.test',
			provider_url: `${ORIGIN}/`,
			cache_age: 86400,
			html: expect.any(String) as string,
			width: 400,
			height: null,
		})
		const html = String(body.html)
		expect(html).toMatch(
			new RegExp(
				`^<blockquote class="mastodon-embed" data-embed-url="${ORIGIN}/@alice/${status.id}/embed" style="background: #FCF8FF; [^"]*"> ` +
					`<a href="${ORIGIN}/@alice/${status.id}" target="_blank" style="align-items: center; [^"]*"> ` +
					`<div style="color: #787588; margin-top: 16px;">Post by @alice@kopje.test</div> ` +
					'<div style="font-weight: 500;">View on Kopje</div> </a> </blockquote> ' +
					`<script data-allowed-prefixes="${ORIGIN}/" async src="${ORIGIN}/assets/embed.js"></script>$`
			)
		)
		// The name is not in the HTML: nothing of the author's choosing reaches it.
		expect(html).not.toContain('Alice')
	})

	it('takes maxwidth and maxheight as Mastodon reads them (to_i)', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'sized' })
		const sizes = async (extra: string) => {
			const body = await (await oembed(h, String(status.url), extra)).json<{ width: number; height: number | null }>()
			return [body.width, body.height]
		}
		expect(await sizes('&maxwidth=500&maxheight=300')).toEqual([500, 300])
		expect(await sizes('&maxwidth=640px&maxheight=1_0')).toEqual([640, 10])
		expect(await sizes('&maxwidth=&maxheight=')).toEqual([0, null])
		expect(await sizes('&maxwidth=wide&maxheight=tall')).toEqual([0, 0])
		expect(await sizes('&maxheight=200')).toEqual([400, 200])
	})

	it('resolves the status page, its other spellings, the object URI and a legacy id', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'found', visibility: 'unlisted' })
		await sql(h.store, "UPDATE statuses SET legacy_id = '3f1c2b9e-0000-4000-8000-000000000001' WHERE id = ?", status.id)
		const expected = await (await oembed(h, String(status.url))).json<{ html: string }>()
		for (const url of [
			`${ORIGIN}/@alice/${status.id}/`,
			`${ORIGIN}/@ALICE/${status.id}?utm=x#top`,
			`${ORIGIN}/@alice@kopje.test/${status.id}`,
			`http://kopje.test/@alice/${status.id}`,
			`${ORIGIN}/@alice/3f1c2b9e-0000-4000-8000-000000000001`,
			String(status.uri),
		]) {
			const response = await oembed(h, url)
			expect(response.status, url).toBe(200)
			expect((await response.json<{ html: string }>()).html, url).toBe(expected.html)
		}
		expect(String(status.uri)).toMatch(/^https:\/\/kopje\.test\/ap\/o\//)
	})

	it('answers 404 for anything the status page would not show, and for any other URL', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const carol = await remoteAccount(h.store, 'carol', 'carol.example')
		const shown = await post(h, alice, { status: 'shown' })
		const urls: string[] = []
		for (const visibility of ['private', 'direct']) {
			const hidden = await post(h, alice, { status: `@bob ${visibility}`, visibility })
			urls.push(String(hidden.url), String(hidden.uri))
		}
		const limited = await seedStatus(h.store, { accountId: alice.id, visibility: 'limited', uri: `${ORIGIN}/ap/o/l` })
		urls.push(`${ORIGIN}/@alice/${limited}`, `${ORIGIN}/ap/o/l`)
		const bobs = await post(h, bob, { status: 'bob public' })
		const boost = await h.request(`/api/v1/statuses/${bobs.id}/reblog`, bearer(alice.token, { method: 'POST' }))
		urls.push(`${ORIGIN}/@alice/${(await boost.json<{ id: string }>()).id}`)
		const remote = await seedStatus(h.store, {
			accountId: carol,
			visibility: 'public',
			uri: 'https://carol.example/statuses/1',
		})
		urls.push(
			`${ORIGIN}/@alice/${remote}`,
			`${ORIGIN}/@carol@carol.example/${remote}`,
			'https://carol.example/statuses/1',
			// Another author's path, nothing, and URLs that are not a status page.
			`${ORIGIN}/@bob/${String(shown.id)}`,
			`${ORIGIN}/@alice/100000000000000001`,
			`${ORIGIN}/@alice/not-an-id`,
			`${ORIGIN}/@alice/${String(shown.id)}/embed`,
			`${ORIGIN}/@alice`,
			`${ORIGIN}/ap/o/`,
			`https://evil.example/@alice/${String(shown.id)}`,
			`https://kopje.test:8443/@alice/${String(shown.id)}`,
			`ftp://kopje.test/@alice/${String(shown.id)}`,
			`/@alice/${String(shown.id)}`,
			'not a url',
			''
		)
		for (const url of urls) {
			const response = await oembed(h, url)
			expect(response.status, url).toBe(404)
			expect(await response.json(), url).toEqual({ error: 'Record not found' })
		}
		const missing = await h.request('/api/oembed')
		expect(missing.status).toBe(404)
		expect((await oembed(h, String(shown.url))).status).toBe(200)
	})

	it('hides the statuses of a suspended account', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'before' })
		expect((await oembed(h, String(status.url))).status).toBe(200)
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ?', new Date(NOW).toISOString())
		expect((await oembed(h, String(status.url))).status).toBe(404)
		expect((await oembed(h, String(status.uri))).status).toBe(404)
		expect((await h.request(`${pathOf(status)}/embed`)).status).toBe(404)
	})
})

describe('the embed page (WEB-2)', () => {
	it('shows the status, escaped and sanitized, with one script, and may be framed by any site', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(alice.token, { ...json({ display_name: '<script>alert(1)</script>' }), method: 'PATCH' })
		)
		const status = await post(h, alice, { status: 'the <reply> & more', spoiler_text: 'careful "now"' })
		const response = await h.request(`${pathOf(status)}/embed`, { headers: { origin: 'https://evil.example' } })
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('text/html; charset=UTF-8')
		expect(response.headers.get('x-content-type-options')).toBe('nosniff')
		expect(response.headers.get('x-frame-options')).toBeNull()
		expect(response.headers.get('access-control-allow-origin')).toBeNull()
		expect(response.headers.get('cache-control')).toBe('public, max-age=180')
		expect(response.headers.get('content-security-policy')).toBe(
			"default-src 'none'; script-src https://kopje.test/assets/embed-status.js; style-src 'self'; " +
				"img-src 'self' https:; media-src 'self' https:; form-action 'self'; base-uri 'none'"
		)
		const html = await response.text()
		expect(html).toContain('the &lt;reply&gt; &amp; more')
		// The warning, escaped, is the summary's text besides the catalogue's "Show".
		expect(text(one(parseHtml(html), 'span', 'spoiler'))).toBe('careful "now"')
		expect(html).toContain('careful &quot;now&quot;')
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
		expect(html.match(/<script\b/gi)).toEqual(['<script'])
		expect(html).toContain('<script src="/assets/embed-status.js" async=""></script>')
		expect(html).toContain('<base target="_blank"/>')
		expect(html).toContain('<meta name="robots" content="noindex"/>')
		expect(html).toContain(`<a class="quiet-link" href="${pathOf(status)}">View on kopje.test</a>`)
		// The status alone: no header, footer or link to /about.
		const doc = parseHtml(html)
		expect(query(doc, 'header')).toEqual([])
		expect(query(doc, 'footer')).toEqual([])
		expect(query(doc, 'a').filter((a) => attr(a, 'href') === '/about')).toEqual([])
	})

	it('answers the unframable 404 for a hidden status, and leaves every other page unframable', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const hidden = await post(h, alice, { status: 'secret', visibility: 'private' })
		const shown = await post(h, alice, { status: 'shown' })
		for (const path of [`${pathOf(hidden)}/embed`, '/@alice/100000000000000001/embed', '/@nobody/1/embed']) {
			const response = await h.request(path)
			expect(response.status, path).toBe(404)
			expect(response.headers.get('x-frame-options'), path).toBe('DENY')
			expect(response.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'")
		}
		for (const path of [pathOf(shown), '/@alice', '/@nobody']) {
			const response = await h.request(path)
			expect(response.headers.get('x-frame-options'), path).toBe('DENY')
			expect(response.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'")
			// The embed's script runs only in the embed (the status page and profile name the L1 bundle instead, design
			// §7.5, pinned in web-pages.test.ts).
			expect(response.headers.get('content-security-policy'), path).not.toContain('embed-status.js')
		}
	})

	it('moves a legacy id to the embed page of the status id', async () => {
		const h = await community(['alice'])
		const status = await post(h, h.users.alice, { status: 'hello' })
		await sql(h.store, "UPDATE statuses SET legacy_id = '3f1c2b9e-0000-4000-8000-000000000001' WHERE id = ?", status.id)
		const moved = await h.request('/@ALICE/3f1c2b9e-0000-4000-8000-000000000001/embed')
		expect(moved.status).toBe(301)
		expect(moved.headers.get('location')).toBe(`${pathOf(status)}/embed`)
	})
})
