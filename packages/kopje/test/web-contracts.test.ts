import { describe, expect, it } from 'vitest'

import { type App, bearer, json, login, setSetting } from './api-helpers'
import { PNG_PLAIN } from './fixtures/images'
import { bytes, mediaForm, pathOf, TestCodec, uploaded } from './media-helpers'
import { community, post, remoteAccount, seedStatus } from './status-helpers'
import { attr, classes, closest, one, parseHtml, query, text } from './web-dom'
import { ICONS } from '../src/web/icons'
import { linkTo } from '../src/web/view/link'

// Page contracts besides accessibility: links through linkTo, no visibility marker and no application name, and how
// images load.

type Harness = Awaited<ReturnType<typeof community>>

async function html(h: Harness, path: string): Promise<string> {
	const response = await h.request(path)
	expect(response.status, path).toBe(200)
	return response.text()
}

describe('linkTo (HTML-3)', () => {
	const domain = 'kopje.test'

	it('shortens a URL of this host to its path and query', () => {
		expect(linkTo('https://kopje.test/@alice/1?x=1', domain)).toEqual({
			href: '/@alice/1?x=1',
			external: false,
			host: 'kopje.test',
		})
		expect(linkTo('https://kopje.test/', domain)).toEqual({ href: '/', external: false, host: 'kopje.test' })
	})

	it('keeps a same-host URL absolute when its path starts with // or the short form would not resolve back', () => {
		for (const url of [
			'https://kopje.test//evil.example/x',
			'https://kopje.test///x',
			'http://kopje.test/@alice',
			'https://user@kopje.test/@alice',
			'https://kopje.test/@alice#top',
		]) {
			const link = linkTo(url, domain)
			expect(link?.href, url).toBe(new URL(url).href)
			expect(link?.href.startsWith('//'), url).toBe(false)
		}
	})

	it('keeps another host absolute and marks it external', () => {
		expect(linkTo('https://remote.example/@carol/1', domain)).toEqual({
			href: 'https://remote.example/@carol/1',
			external: true,
			host: 'remote.example',
		})
		expect(linkTo('https://kopje.test:8443/x', domain)).toMatchObject({ external: true, host: 'kopje.test:8443' })
	})

	it('links nothing that is not http(s)', () => {
		for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://kopje.test/x', '/@alice', 'not a url', '']) {
			expect(linkTo(url, domain), url).toBeNull()
		}
		expect(linkTo(null, domain)).toBeNull()
		expect(linkTo(undefined, domain)).toBeNull()
	})
})

describe('no visibility marker and no application name', () => {
	it('shows neither on the status page, the profile or the embed', async () => {
		const h = await community(['alice'])
		const registered = await h.request(
			'/api/v1/apps',
			json({
				client_name: 'Unique App Name',
				redirect_uris: 'https://client.test/callback',
				scopes: 'read write follow push',
				website: 'https://unique-app.example',
			})
		)
		const app = await registered.json<App>()
		const { token } = await login(h, { app, email: 'alice@example.com', scope: 'read write follow' })
		const status = await post(h, { id: h.users.alice.id, token }, { status: 'quietly said', visibility: 'unlisted' })
		expect((status.application as { name: string } | null)?.name).toBe('Unique App Name')
		for (const path of [pathOf(String(status.url)), '/@alice', `${pathOf(String(status.url))}/embed`]) {
			const page = await html(h, path)
			expect(page, path).toContain('quietly said')
			expect(page, path).not.toContain('Unique App Name')
			expect(page, path).not.toContain('unique-app.example')
			expect(text(one(parseHtml(page), 'body')), path).not.toMatch(/unlisted|public|followers only/i)
			expect(page, path).not.toContain(ICONS.lock)
		}
	})
})

describe('images', () => {
	it('size every image, load one first and every other lazily', async () => {
		const codec = new TestCodec()
		const h = await community(['alice'], 'read write follow', { images: () => codec })
		const { alice } = h.users
		const media = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), { description: 'one' }, 'a.png', 'image/png'))
		const second = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), { description: 'two' }, 'b.png', 'image/png'))
		const status = await post(h, alice, { status: 'with media', media_ids: [media.id, second.id] })
		for (let i = 0; i < 3; i++) {
			await post(h, alice, { status: `more ${i}`, media_ids: [] })
		}
		await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(alice.token, { ...json({ note: 'bio' }), method: 'PATCH' })
		)
		const pages = {
			profile: parseHtml(await html(h, '/@alice')),
			status: parseHtml(await html(h, pathOf(String(status.url)))),
		}
		for (const [name, doc] of Object.entries(pages)) {
			const images = query(doc, 'img')
			expect(images.length, name).toBeGreaterThan(1)
			const first = images.filter((img) => attr(img, 'fetchpriority') === 'high')
			expect(first.length, name).toBe(1)
			for (const img of images) {
				const box = classes(img).some((c) => ['banner', 'box'].includes(c))
				expect(
					box || (attr(img, 'width') !== null && attr(img, 'height') !== null),
					`${name} ${attr(img, 'src')}`
				).toBe(true)
				// The only eager images: the likely LCP image, the profile's avatar and the focal post's author
				// avatar, the 44px one in the focal card.
				const eager =
					first.includes(img) ||
					(name === 'profile' && classes(img).includes('av88')) ||
					(name === 'status' &&
						classes(img).includes('av44') &&
						closest(img, (e) => classes(e).includes('focal')) !== null)
				expect(attr(img, 'loading'), `${name} ${attr(img, 'src')}`).toBe(eager ? null : 'lazy')
			}
		}
		// On the status page, the focal post's first visible preview is the one loaded first.
		const priority = query(pages.status, 'img').find((img) => attr(img, 'fetchpriority') === 'high')
		expect(priority && attr(priority, 'alt')).toBe('one')
		// On the profile, the banner.
		const banner = query(pages.profile, 'img').find((img) => attr(img, 'fetchpriority') === 'high')
		expect(banner && classes(banner)).toContain('banner')
	})
})

describe('the reply-to line', () => {
	it('links a visible remote parent as external, through linkTo', async () => {
		const h = await community(['alice'])
		const carol = await remoteAccount(h.store, 'carol', 'remote.example')
		const parent = await seedStatus(h.store, {
			accountId: carol,
			visibility: 'public',
			uri: 'https://remote.example/statuses/1',
		})
		const reply = await post(h, h.users.alice, { status: 'a reply', in_reply_to_id: parent })
		const line = one(parseHtml(await html(h, pathOf(String(reply.url)))), 'p', 'reply-to')
		const [link] = query(line, 'a')
		expect(link && attr(link, 'href')).toBe('https://remote.example/statuses/1')
		expect(link && attr(link, 'rel')).toBe('nofollow noopener')
		// The server is named in hidden text, with no icon (LinkTo).
		expect(link && text(link)).toBe('@carol@remote.example Open on remote.example')
		expect(link && text(one(link, 'span', 'vh'))).toBe('Open on remote.example')
		expect(link && query(link, 'svg')).toEqual([])
	})
})

describe('display names', () => {
	it('fall back to the username when only whitespace, wherever the name labels a link or a heading', async () => {
		const h = await community(['alice'])
		await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(h.users.alice.token, { ...json({ display_name: ' \u3000 ' }), method: 'PATCH' })
		)
		const status = await post(h, h.users.alice, { status: 'named' })
		const profile = parseHtml(await html(h, '/@alice'))
		expect(text(one(profile, 'h1'))).toBe('alice')
		expect(text(one(one(profile, 'article'), 'a', 'name'))).toBe('alice')
		const page = parseHtml(await html(h, pathOf(String(status.url))))
		expect(text(one(page, 'h1'))).toBe('alice')
		expect(text(one(page, 'title'))).toBe('alice (@alice@kopje.test)')
		const embed = parseHtml(await html(h, `${pathOf(String(status.url))}/embed`))
		expect(text(one(embed, 'a', 'name'))).toBe('alice')
	})
})

describe('rich content', () => {
	it('keeps text and links of one paragraph in one paragraph, and the disclosures show their state', async () => {
		const h = await community(['alice'])
		await setSetting(
			h.store,
			'terms_of_service',
			'<p>Read <a href="https://example.com/">these terms</a> carefully.</p>'
		)
		await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
		const doc = parseHtml(await html(h, '/terms-of-service'))
		const body = one(doc, 'div', 'body')
		// One paragraph holding the text, the link and the text after it; the stylesheet spaces block children only
		// (a visual check of the line is the browser job's).
		const paragraphs = query(body, 'p')
		expect(paragraphs.map(text)).toEqual(['Read these terms carefully.'])
		expect(query(paragraphs[0]!, 'a').map(text)).toEqual(['these terms'])
		const status = await post(h, h.users.alice, { status: 'hidden text', spoiler_text: 'careful' })
		const summary = query(one(parseHtml(await html(h, pathOf(String(status.url)))), 'details', 'cw'), 'summary')[0]!
		expect(
			query(summary, 'span')
				.filter((s) => ['show', 'hide'].includes(attr(s, 'class') ?? ''))
				.map(text)
		).toEqual(['Show', 'Hide'])
	})
})
