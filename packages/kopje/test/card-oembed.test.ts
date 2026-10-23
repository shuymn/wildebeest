import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { freshStore } from './helpers'
import { TEMPLATE_FIXTURES } from './oembed-template-fixtures'
import {
	acceptedTemplate,
	discoverOembed,
	expandTemplate,
	oembedCard,
	type OembedOutcome,
	oembedTemplate,
} from '../src/federation/card-oembed'
import { CARD_SCAN, linkDetails } from '../src/federation/link-details'
import { WEB_PAGE_URL_LIMIT, webPageUrlRefusal } from '../src/federation/web-page'
import { type PageScan, SCAN_LIMITS, scanHtml } from '../src/platform/html-scan'
import {
	CARD_DIMENSION_MAX,
	CARD_EMBED_SRC_BYTES,
	cardDimension,
	iframeDimension,
	isOembedTemplate,
	OEMBED_TEMPLATE_BYTES,
	oembedTemplatePastSql,
	presentedEmbedSrc,
} from '../src/platform/stored-bounds'
import { oembedIframe } from '../src/security/html'

// A card's oEmbed endpoint and twitter:player (federation/card-oembed.ts, link-details.ts): Mastodon's
// FetchOEmbedService and FetchLinkCardService#attempt_oembed (v4.5.11), with the rows of the card round's conversion
// table (federation/link-cards.ts).

const PAGE = 'https://site.example/post/1'
const ENDPOINT = 'https://provider.example/oembed?url=x'

async function scan(html: string): Promise<PageScan> {
	const result = await scanHtml(new TextEncoder().encode(html), { label: 'utf-8', bomLength: 0 }, CARD_SCAN)
	if ('failed' in result) {
		throw new Error(`scan failed: ${result.failed}`)
	}
	return result
}

const webPageAccepts = (url: URL) => url.protocol === 'https:' && webPageUrlRefusal(url) === null

const link = (type: string, href: string) => `<link rel="alternate" type="${type}" href="${href}">`

describe('discovery (T18)', () => {
	it('takes the first JSON link in document order, resolved against the page and upgraded to https', async () => {
		const cases: [string, string | null][] = [
			[link('application/json+oembed', 'https://p.example/a'), 'https://p.example/a'],
			[
				link('text/json+oembed', '/o?url=1') + link('application/json+oembed', 'https://p.example/a'),
				'https://site.example/o?url=1',
			],
			[link('text/xml+oembed', 'https://p.example/x') + link('text/json+oembed', 'o'), 'https://site.example/post/o'],
			[link('text/xml+oembed', 'https://p.example/x'), null],
			[link('Application/JSON+oembed', 'https://p.example/a'), null],
			[link('application/json+oembed', 'http://p.example/a'), 'https://p.example/a'],
			[link('application/json+oembed', 'http://p.example:443/a'), 'https://p.example/a'],
			[link('application/json+oembed', 'ftp://p.example/a'), null],
			[link('application/json+oembed', 'javascript:alert(1)'), null],
			[link('application/json+oembed', 'https://127.0.0.1/a'), null],
			[link('application/json+oembed', 'https://p.example:8443/a'), null],
			[link('application/json+oembed', ' '), null],
			['<link type="application/json+oembed">', null],
			[link('application/json+oembed', `https://p.example/${'a'.repeat(WEB_PAGE_URL_LIMIT)}`), null],
			// Decoded once by the scan: an entity in the href.
			[link('application/json+oembed', 'https://p.example/o?a=1&amp;url=2'), 'https://p.example/o?a=1&url=2'],
		]
		for (const [html, expected] of cases) {
			const { links } = await scan(html)
			expect(discoverOembed(links, PAGE), html).toBe(expected)
		}
	})

	it('reads the first CARD_SCAN.links links only (declared)', async () => {
		const others = (n: number) => Array.from({ length: n }, (_, i) => `<link rel="icon" href="/i${i}">`).join('')
		const endpoint = link('application/json+oembed', 'https://p.example/a')
		expect(SCAN_LIMITS.links).toBe(64)
		expect(discoverOembed((await scan(others(63) + endpoint)).links, PAGE)).toBe('https://p.example/a')
		expect(discoverOembed((await scan(others(64) + endpoint)).links, PAGE)).toBeNull()
	})
})

describe('the endpoint template (T20, AM6)', () => {
	it("derives the template by Mastodon's URL_REGEX, and keeps only one the stored rule and the sink accept", () => {
		const cases: [string, string | null][] = [
			[
				'https://p.example/oembed?url=https://site.example/post/1&format=json',
				'https://p.example/oembed?url={url}&format=json',
			],
			['https://p.example/oembed?url=http%3A%2F%2Fsite.example%2Fa', 'https://p.example/oembed?url={url}'],
			[
				'https://p.example/oembed?URL=HTTPS%3a%2f%2fsite.example&a=https://b',
				'https://p.example/oembed?URL={url}&a={url}',
			],
			['https://p.example/oembed?id=1', null],
			['https://p.example/oembed?url=ftp://site.example', null],
			// A brace the placeholder does not own, or a character the stored rule refuses.
			['https://p.example/o{x}?url=https://a', null],
			['https://p.example/o?url=https://a&b={', null],
			['https://p.example/o?q=|&url=https://a', null],
		]
		for (const [endpoint, expected] of cases) {
			expect(oembedTemplate(endpoint), endpoint).toBe(expected)
		}
		// The reader's twin: the stored rule, then the URL with x for each placeholder, which the sink must accept.
		expect(acceptedTemplate('https://p.example/o?url={url}')).toBe('https://p.example/o?url={url}')
		for (const refused of [
			'https://127.0.0.1/o?url={url}',
			'https://p.example:8443/o?url={url}',
			'https://user@p.example/o?url={url}',
			'https://p.example/o?url={url}}',
			'http://p.example/o?url={url}',
			`https://p.example/o?url={url}&${'a'.repeat(OEMBED_TEMPLATE_BYTES)}`,
			7,
			null,
		]) {
			expect(acceptedTemplate(refused), String(refused)).toBeNull()
		}
	})

	it('judges a template by one rule in SQL and in JavaScript (oembedTemplatePastSql, isOembedTemplate)', async () => {
		const fixtures = TEMPLATE_FIXTURES.map(([t]) => t)
		const store = freshStore()
		const sqlRefused = await runInDurableObject(store, (_instance, state) =>
			fixtures.map(
				(t) => state.storage.sql.exec<{ past: number }>(`SELECT ${oembedTemplatePastSql('?1')} AS past`, t).one().past
			)
		)
		// Each fixture as expected, by both sides.
		expect(fixtures.map((t, i) => [t, sqlRefused[i] === 0, isOembedTemplate(t)])).toEqual(
			TEMPLATE_FIXTURES.map(([t, accepted]) => [t, accepted, accepted])
		)
		// The Worker's twin adds the URL rules on top: the same stored rule, then the sink's.
		for (const t of fixtures.filter((f) => isOembedTemplate(f))) {
			const url = new URL(t.replaceAll('{url}', 'x'))
			expect(acceptedTemplate(t), t).toBe(webPageAccepts(url) ? t : null)
		}
	})

	it('expands as RFC 6570 simple expansion, every byte but the unreserved ones percent-encoded', () => {
		const t = 'https://p.example/o?url={url}'
		const cases: [string, string][] = [
			['https://a.example/%', 'https%3A%2F%2Fa.example%2F%25'],
			['https://a.example/?a&b', 'https%3A%2F%2Fa.example%2F%3Fa%26b'],
			['https://a.example/#x', 'https%3A%2F%2Fa.example%2F%23x'],
			["https://a.example/!'()*", 'https%3A%2F%2Fa.example%2F%21%27%28%29%2A'],
			['https://a.example/:/?=', 'https%3A%2F%2Fa.example%2F%3A%2F%3F%3D'],
			['https://a.example/-._~Az09', 'https%3A%2F%2Fa.example%2F-._~Az09'],
		]
		for (const [url, value] of cases) {
			expect(expandTemplate(t, url), url).toBe(`https://p.example/o?url=${value}`)
		}
		// encodeURIComponent keeps !'()*, which simple expansion encodes.
		expect(encodeURIComponent("!'()*")).toBe("!'()*")
		expect(expandTemplate('https://p.example/o?a={url}&b={url}', 'https://a.example/')).toBe(
			'https://p.example/o?a=https%3A%2F%2Fa.example%2F&b=https%3A%2F%2Fa.example%2F'
		)
	})

	it('computes the expansion length before building it: past OEMBED_TEMPLATE_BYTES is a miss', () => {
		const t = 'https://p.example/o?a={url}&b={url}'
		// Each placeholder (5 bytes) becomes the claim URL's encoding: 'https%3A%2F%2Fa.example%2F' and the padding.
		const encodedPrefix = 'https%3A%2F%2Fa.example%2F'.length
		const padding = Math.floor((OEMBED_TEMPLATE_BYTES - (t.length - 10)) / 2) - encodedPrefix
		const fits = `https://a.example/${'a'.repeat(padding)}`
		const expanded = expandTemplate(t, fits)
		expect(expanded?.length).toBe(OEMBED_TEMPLATE_BYTES - 1)
		expect(expandTemplate(t, `${fits}a`)).toBeNull()
		// Within the raw bound, past the sink's once normalized: each ' of the query becomes %27.
		const quoted = `https://p.example/o?q=${"'".repeat(300)}&url={url}`
		expect(acceptedTemplate(quoted)).toBe(quoted)
		const long = `https://a.example/${'a'.repeat(1474)}`
		expect(quoted.length - 5 + 26 + 1474).toBeLessThanOrEqual(OEMBED_TEMPLATE_BYTES)
		expect(expandTemplate(quoted, long)).toBeNull()
		expect(expandTemplate(quoted, 'https://a.example/')).not.toBeNull()
	})
})

describe('the iframe of a video (AM14)', () => {
	it('captures the decoded src, width and height of exactly one iframe and no other embed element', () => {
		const iframe = '<iframe src="https://v.example/e?a=1&amp;b=2" width="640" height="360" frameborder="0"></iframe>'
		expect(oembedIframe(iframe)).toEqual({ src: 'https://v.example/e?a=1&b=2', width: '640', height: '360' })
		expect(oembedIframe(`<p>text</p>${iframe}<div>more</div>`)).toEqual(oembedIframe(iframe))
		expect(oembedIframe('<IFRAME SRC="https://v.example/" SRC="https://w.example/"></IFRAME>')).toEqual({
			src: 'https://v.example/',
		})
		for (const refused of [
			iframe + iframe,
			'<video src="https://v.example/a.mp4"></video>',
			`${iframe}<source src="https://v.example/a.mp4">`,
			`<audio controls>${iframe}</audio>`,
			'<p>no embed</p>',
			'',
		]) {
			expect(oembedIframe(refused), refused).toBeNull()
		}
		// Inside a script, an iframe is text (htmlparser2 reads script as raw text, as sanitize-html does).
		expect(oembedIframe(`<script>${iframe}</script>${iframe}`)).toEqual(oembedIframe(iframe))
		// A src past the capture's bound is captured as refused.
		expect(oembedIframe(`<iframe src="https://v.example/${'a'.repeat(600)}">`)).toEqual({ src: null })
	})

	it('keeps a src only as an absolute http(s) URL within its bounds, as sanitize-html would and more strictly', () => {
		for (const refused of [
			'/relative',
			'//v.example/protocol-relative',
			'javascript:alert(1)',
			'data:text/html,x',
			' https://v.example/',
			'https://v.example/"onload="x',
			`https://v.example/${'a'.repeat(CARD_EMBED_SRC_BYTES)}`,
			null,
			undefined,
		]) {
			expect(presentedEmbedSrc(refused), String(refused)).toBeNull()
		}
		expect(presentedEmbedSrc("HTTPS://V.example/a?b='c'")).toBe('https://v.example/a?b=%27c%27')
		// Its escaped form is bounded too: each & becomes &amp;.
		const ampersands = (n: number) => `https://v.example/?${'&'.repeat(n)}`
		const most = Math.floor((CARD_EMBED_SRC_BYTES - 19) / 5)
		expect(presentedEmbedSrc(ampersands(most))).toBe(ampersands(most))
		expect(presentedEmbedSrc(ampersands(most + 1))).toBeNull()
	})

	it('reads a long run of ampersands around the iframe without building any output (the 30,000-& witness)', () => {
		const html = `<iframe src="https://v.example/"></iframe>${'&'.repeat(30_000)}`
		// sanitize-html would write each & as &amp;: 150,000 code units of output. The capture keeps the src only.
		expect(oembedIframe(html)).toEqual({ src: 'https://v.example/' })
	})
})

describe('the conversion of a document (T3-T15, AM8)', () => {
	const doc = (extra: Record<string, unknown>) => ({ version: '1.0', type: 'link', title: 'Title', ...extra })
	const card = (outcome: OembedOutcome) => {
		if (outcome.kind !== 'card') {
			throw new Error(`no card: ${outcome.kind}`)
		}
		return outcome.fields
	}

	it('validates the root, the version and the type', () => {
		const cases: [unknown, OembedOutcome['kind']][] = [
			[null, 'fallback'],
			[[], 'none'],
			['x', 'none'],
			[1, 'none'],
			[true, 'none'],
			[{}, 'fallback'],
			[doc({}), 'card'],
			[doc({ version: 1 }), 'card'],
			[JSON.parse('{"version":1.0,"type":"link","title":"t"}'), 'card'],
			[doc({ version: '1' }), 'fallback'],
			[doc({ version: 2 }), 'fallback'],
			[doc({ version: undefined }), 'fallback'],
			[doc({ type: undefined }), 'fallback'],
			[doc({ type: '' }), 'fallback'],
			[doc({ type: ' 　' }), 'fallback'],
			[doc({ type: null }), 'fallback'],
			[doc({ type: false }), 'fallback'],
			[doc({ type: [] }), 'fallback'],
			[doc({ type: 'foo' }), 'none'],
			[doc({ type: 'Link' }), 'none'],
			[doc({ type: 5 }), 'none'],
			[doc({ type: true }), 'none'],
			[doc({ type: ['link'] }), 'none'],
			[doc({ type: 'rich' }), 'fallback'],
			[doc({ type: 'photo' }), 'fallback'],
			[doc({ type: 'photo', url: ' ' }), 'fallback'],
			[doc({ type: 'photo', url: 7 }), 'fallback'],
			[doc({ type: 'photo', url: true }), 'fallback'],
			[doc({ type: 'photo', url: { x: 1 } }), 'fallback'],
			[doc({ type: 'photo', url: ['x'] }), 'fallback'],
			[doc({ type: 'photo', url: 'https://p.example/a.jpg' }), 'card'],
			[doc({ title: '' }), 'fallback'],
			[doc({ title: ' \u0085' }), 'fallback'],
			[doc({ title: '\u0000' }), 'fallback'],
			[doc({ title: 5 }), 'fallback'],
			[doc({ title: undefined }), 'fallback'],
		]
		for (const [value, kind] of cases) {
			expect(oembedCard(value, ENDPOINT).kind, JSON.stringify(value)).toBe(kind)
		}
	})

	it('maps the fields as Mastodon does: raw texts, URLs joined to the endpoint, top-level dimensions', () => {
		expect(
			card(
				oembedCard(
					doc({
						title: ' &amp; Title ',
						author_name: 'Author',
						author_url: '/users/a',
						provider_name: 7,
						provider_url: 'javascript:alert(1)',
						description: 'ignored',
						width: 640,
						height: 360,
					}),
					ENDPOINT
				)
			)
		).toEqual({
			title: ' &amp; Title ',
			description: '',
			authorName: 'Author',
			authorUrl: 'https://provider.example/users/a',
			providerName: '',
			providerUrl: '',
			language: null,
			publishedAt: null,
			type: 'link',
			width: 0,
			height: 0,
			embedSrc: '',
			iframeWidth: null,
			iframeHeight: null,
			imageUrl: '',
			imageDescription: '',
		})
		expect(card(oembedCard(doc({ type: 'photo', url: 'x', width: '640', height: 480 }), ENDPOINT))).toMatchObject({
			type: 'photo',
			width: 640,
			height: 480,
			embedSrc: '',
		})
		const html = '<iframe src="https://v.example/e/1" width="560" height="315px"></iframe>'
		expect(card(oembedCard(doc({ type: 'video', html, width: 1280, height: '720' }), ENDPOINT))).toMatchObject({
			type: 'video',
			width: 1280,
			height: 720,
			embedSrc: 'https://v.example/e/1',
			iframeWidth: 560,
			iframeHeight: null,
		})
		// A video without one accepted iframe is a link with the same fields (declared).
		for (const refused of [
			undefined,
			7,
			'<video src="https://v.example/a.mp4"></video>',
			'<iframe src="/e/1"></iframe>',
		]) {
			expect(card(oembedCard(doc({ type: 'video', html: refused, width: 1, height: 2 }), ENDPOINT))).toMatchObject({
				type: 'link',
				width: 1,
				height: 2,
				embedSrc: '',
				iframeWidth: null,
			})
		}
	})

	it('reads a dimension strictly within 0..CARD_DIMENSION_MAX (declared)', () => {
		const cases: [unknown, number, number | null][] = [
			[640, 640, 640],
			['640', 640, 640],
			[0, 0, 0],
			['00640', 640, 640],
			[CARD_DIMENSION_MAX, CARD_DIMENSION_MAX, CARD_DIMENSION_MAX],
			[String(CARD_DIMENSION_MAX), CARD_DIMENSION_MAX, CARD_DIMENSION_MAX],
			[CARD_DIMENSION_MAX + 1, 0, null],
			['65536', 0, null],
			['000001', 0, null],
			[-1, 0, null],
			['-1', 0, null],
			['+1', 0, null],
			[1.5, 0, null],
			['1.5', 0, null],
			['1e3', 0, null],
			['640px', 0, null],
			[' 640', 0, null],
			['', 0, null],
			[null, 0, null],
			[undefined, 0, null],
			[true, 0, null],
			['６４０', 0, null],
		]
		for (const [value, cardValue, iframeValue] of cases) {
			expect([cardDimension(value), iframeDimension(value)], JSON.stringify(value)).toEqual([cardValue, iframeValue])
		}
	})
})

describe('twitter:player (OpenGraph)', () => {
	const page = (metas: Record<string, string>, title = 'Title') =>
		`<title>${title}</title>${Object.entries(metas)
			.map(([property, content]) => `<meta property="${property}" content="${content}">`)
			.join('')}`

	it('makes a video of a valid player URL, its dimensions on the card and the iframe', async () => {
		const fields = linkDetails(
			await scan(page({ 'twitter:player': '/embed/1', 'twitter:player:width': '480', 'twitter:player:height': 'x' })),
			PAGE
		)
		expect(fields).toMatchObject({
			type: 'video',
			embedSrc: 'https://site.example/embed/1',
			width: 480,
			height: 0,
			iframeWidth: 480,
			iframeHeight: null,
		})
	})

	it("keeps every card's dimensions from the player's, and makes a link of a player the src rule refuses", async () => {
		for (const player of [undefined, 'javascript:alert(1)', 'null', `https://v.example/${'a'.repeat(600)}`]) {
			const metas: Record<string, string> = { 'twitter:player:width': '320', 'twitter:player:height': '240' }
			if (player !== undefined) {
				metas['twitter:player'] = player
			}
			expect(linkDetails(await scan(page(metas)), PAGE), String(player)).toMatchObject({
				type: 'link',
				width: 320,
				height: 240,
				embedSrc: '',
				iframeWidth: null,
				iframeHeight: null,
			})
		}
	})
})

describe('the image of an oEmbed card (0070_card_images)', () => {
	const doc = (extra: Record<string, unknown>) => ({ version: '1.0', type: 'link', title: 'Title', ...extra })
	const card = (outcome: OembedOutcome) => {
		if (outcome.kind !== 'card') {
			throw new Error(`no card: ${outcome.kind}`)
		}
		return outcome.fields
	}

	it("takes a link's or video's thumbnail_url and a photo's url, joined to the endpoint, https only", () => {
		const image = (fields: Record<string, unknown>) => card(oembedCard(doc(fields), ENDPOINT)).imageUrl
		expect(image({ thumbnail_url: '/t.jpg' })).toBe('https://provider.example/t.jpg')
		expect(image({ type: 'video', html: '<iframe src="https://v.example/e"></iframe>', thumbnail_url: 't.png' })).toBe(
			'https://provider.example/t.png'
		)
		expect(image({ type: 'photo', url: 'https://cdn.example/p.webp', thumbnail_url: '/t.jpg' })).toBe(
			'https://cdn.example/p.webp'
		)
		// A photo's thumbnail is not its image; a link's url is not either.
		expect(image({ url: 'https://cdn.example/p.webp' })).toBe('')
		for (const refused of ['http://cdn.example/t.jpg', 'javascript:x', ' ', '', 7, null]) {
			expect(image({ thumbnail_url: refused }), String(refused)).toBe('')
		}
		expect(image({ type: 'photo', url: 'http://cdn.example/p.webp' })).toBe('')
		// oEmbed gives no alt text.
		expect(card(oembedCard(doc({ thumbnail_url: '/t.jpg' }), ENDPOINT)).imageDescription).toBe('')
	})
})
