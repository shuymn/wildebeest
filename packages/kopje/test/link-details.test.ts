import { describe, expect, it } from 'vitest'

import {
	CARD_OUTPUT_MAX_UNITS,
	CARD_SCAN,
	decodeEntities,
	linkDetails,
	publishedTime,
	validUrl,
} from '../src/federation/link-details'
import { type PageScan, SCAN_LIMITS, scanHtml } from '../src/platform/html-scan'

// The card extractor (federation/link-details.ts) over pages scanned as the round scans them (CARD_SCAN): Mastodon's
// spec/lib/link_details_extractor_spec.rb (v4.5.11) ported, then Kopje's rules for what Mastodon leaves open.

const ORIGINAL = 'https://example.com/dog.html?tracking=123'

async function details(html: string, url = ORIGINAL) {
	const scan = await scanHtml(new TextEncoder().encode(html), { label: 'utf-8', bomLength: 0 }, CARD_SCAN)
	if ('failed' in scan) {
		throw new Error(`scan failed: ${scan.failed}`)
	}
	return linkDetails(scan, url)
}

const LD_JSON = JSON.stringify({
	'@context': 'https://schema.org',
	'@type': 'NewsArticle',
	headline: 'Man bites dog',
	description: "A dog's tale",
	datePublished: '2022-01-31T19:53:00+00:00',
	author: { '@type': 'Organization', name: 'Charlie Brown' },
	publisher: { '@type': 'NewsMediaOrganization', name: 'Pet News', url: 'https://example.com' },
	inLanguage: { name: 'English', alternateName: 'en' },
})

// 'structured data' of the spec: Rails casts datePublished to a time, which Kopje stores in the 24-byte form.
const STRUCTURED = {
	title: 'Man bites dog',
	description: "A dog's tale",
	publishedAt: '2022-01-31T19:53:00.000Z',
	authorName: 'Charlie Brown',
	providerName: 'Pet News',
	language: 'en',
}

const body = (scripts: string) => `<!doctype html>
<html>
<body>
${scripts}
</body>
</html>`

describe('link details: the Mastodon spec', () => {
	it('extracts the expected values from html metadata when only basic metadata is present', async () => {
		expect(
			await details(`<!doctype html>
<html lang="en">
<head>
  <title>Man bites dog</title>
  <meta name="descripTION" content="A dog&#39;s tale">
  <link rel="pretty IcoN" href="/favicon.ico">
</head>
</html>`)
		).toMatchObject({ title: 'Man bites dog', description: "A dog's tale", language: 'en' })
	})

	it('reads structured data wrapped in CDATA tags', async () => {
		expect(
			await details(`<!doctype html>
<html>
  <head>
    <script type="application/ld+json">
      //<![CDATA[
      ${LD_JSON}
      //]]>
    </script>
  </head>
</html>`)
		).toMatchObject(STRUCTURED)
	})

	it.each([
		['the first tag is invalid JSON', 'invalid LD+JSON'],
		['the first tag is null', 'null'],
		[
			'a preceding block of unsupported LD+JSON',
			JSON.stringify([
				{
					'@context': 'https://schema.org',
					'@type': 'ItemList',
					url: 'https://example.com/cat.html',
					name: 'Man bites cat',
				},
				{
					'@context': 'https://schema.org',
					'@type': 'BreadcrumbList',
					itemListElement: [
						{ '@type': 'ListItem', position: 1, item: { '@id': 'https://www.example.com', name: 'Cat News' } },
					],
				},
			]),
		],
	])('reads structured data when %s', async (_name, first) => {
		expect(
			await details(
				body(
					`<script type="application/ld+json">\n${first}\n</script>\n<script type="application/ld+json">\n${LD_JSON}\n</script>`
				)
			)
		).toMatchObject(STRUCTURED)
	})

	it('reads structured data after an unsupported object in the same block', async () => {
		const block = `[{"@context": "https://schema.org", "@type": "ItemList", "name": "Man bites cat"}, ${LD_JSON}]`
		expect(await details(body(`<script type="application/ld+json">${block}</script>`))).toMatchObject(STRUCTURED)
	})

	it('joins author names given as an array', async () => {
		const ld = JSON.stringify({
			'@context': 'https://schema.org',
			'@type': 'NewsArticle',
			headline: 'A lot of authors',
			description: 'But we decided to cram them into one',
			author: { '@type': 'Person', name: ['Author 1', 'Author 2'] },
		})
		expect((await details(body(`<script type="application/ld+json">${ld}</script>`))).authorName).toBe(
			'Author 1, Author 2'
		)
	})

	it('finds the author and the publisher in embedded arrays', async () => {
		const ld = JSON.stringify({
			'@context': 'https://schema.org',
			'@type': 'NewsArticle',
			headline: 'A lot of authors',
			description: 'But we decided to cram them into one',
			author: [[{ '@type': 'Person', name: ['Author 1'] }]],
			publisher: [[{ '@type': 'NewsMediaOrganization', name: 'Pet News', url: 'https://example.com' }]],
		})
		expect(await details(body(`<script type="application/ld+json">${ld}</script>`))).toMatchObject({
			authorName: 'Author 1',
			providerName: 'Pet News',
		})
	})

	it('extracts the expected values from open graph data', async () => {
		expect(
			await details(`<!doctype html>
<html>
<head>
  <meta property="og:url" content="https://example.com/dog.html">
  <meta property="og:title" content="Man bites dog">
  <meta property="OG:description" content="A dog's tale">
  <meta property="article:published_time" content="2022-01-31T19:53:00+00:00">
  <meta property="og:author" content="Charlie Brown">
  <meta property="og:locale" content="en">
  <meta property="og:image" content="https://example.com/snoopy.jpg">
  <meta property="og:image:alt" content="A good boy">
  <meta property="og:site_name" content="Pet News">
</head>
</html>`)
		).toMatchObject({ ...STRUCTURED, title: 'Man bites dog' })
	})

	// The spec's canonical "null" and "undefined" cases: valid_url_or_nil refuses both literals (and blank) before it
	// resolves, where new URL would read them as paths. Kopje does not read the canonical URL; valid_url_or_nil is also
	// og:site's, after host_to_url, which makes a bare "null" the host http://null as Mastodon does.
	it.each(['null', 'undefined', '', '  '])('refuses %j before resolving it', (value) => {
		expect(validUrl(value, ORIGINAL)).toBeNull()
		expect(validUrl(`${value}x`, ORIGINAL)).toMatch(/^https:\/\/example\.com\//)
	})

	it('reads og:site through host_to_url, so a bare "null" names a host', async () => {
		expect((await details('<meta property="og:site" content="null">')).providerUrl).toBe('http://null/')
		expect((await details('<meta property="og:site" content="">')).providerUrl).toBe('')
	})
})

describe('link details: the rules Kopje follows', () => {
	it('falls back only when a source is absent: an empty string stops the chain', async () => {
		const page = `<title>Fallback</title><meta property="og:title" content="">`
		expect((await details(page)).title).toBe('')
		const ld = (fields: object) =>
			`<script type="application/ld+json">${JSON.stringify({ '@type': 'WebPage', ...fields })}</script>`
		expect((await details(`${ld({ headline: '' })}<meta property="og:title" content="og">`)).title).toBe('')
		expect((await details(`${ld({})}<meta property="og:title" content="og">`)).title).toBe('og')
		// A meta with no content ends the lookup, as Mastodon's nil attribute does, and the next source is read.
		expect(
			(await details(`<meta property="og:title"><meta property="og:title" content="later"><title>t</title>`)).title
		).toBe('t')
		// A value that is not a string reads as absent (a declared deviation).
		expect((await details(`${ld({ headline: 7 })}<title>t</title>`)).title).toBe('t')
	})

	it('decodes the texts a second time, references closed by a semicolon only', async () => {
		expect(
			await details('<title>a &amp;amp; b &amp;lt c</title><meta name="description" content="&amp;quot;x&amp;quot;">')
		).toMatchObject({
			title: 'a & b &lt c',
			description: '"x"',
		})
	})

	it('decodes numeric references a second time to their code points, as HTMLEntities does', async () => {
		// &amp;#0; is a NUL after the second decode, which strip removes: a blank title, so no card.
		expect((await details('<title>&amp;#0;</title>')).title).toBe('')
		expect((await details('<title> &amp;#x00; </title>')).title).toBe('')
		// C1 references stay C1 (HTML5 would read &#128; as the euro sign); the writer's stored rule then applies.
		expect(
			await details('<title>a&amp;#128;b</title><meta name="description" content="&amp;#x9F;&amp;#0;d">')
		).toMatchObject({
			title: 'a\u0080b',
			description: '\u009f\u0000d',
		})
		// A surrogate or a code point past U+10FFFF stays as written; a named reference decodes by its name.
		expect((await details('<title>&amp;#xD800;&amp;#1114112;&amp;amp;&amp;copy;</title>')).title).toBe(
			'&#xD800;&#1114112;&\u00a9'
		)
		expect(decodeEntities('&#0;&#X41;&#x1F600;&unknownname;')).toBe('\u0000A\u{1f600}&unknownname;')
	})

	it("strips the title as Ruby's String#strip, and only the title", async () => {
		expect(await details('<title>\u000b\t t \n</title><meta name="description" content=" d ">')).toMatchObject({
			title: 't',
			description: ' d ',
		})
		// The scan reads a NUL in markup as U+FFFD, which strip keeps; one in JSON-LD stays a NUL, which it removes.
		expect((await details('<title>t \u0000</title>')).title).toBe('t \ufffd')
		const ld = JSON.stringify({ '@type': 'WebPage', headline: '\u0000 t \u0000' })
		expect((await details(`<script type="application/ld+json">${ld}</script>`)).title).toBe('t')
		// U+00A0 is not Ruby's whitespace.
		expect((await details('<title> t</title>')).title).toBe(' t')
	})

	it('takes the first HTML <title> anywhere', async () => {
		expect((await details('<body><title>late</title></body><title>later</title>')).title).toBe('late')
	})

	it('reads inLanguage from an array or a language object, matches exactly first, then strips the region', async () => {
		const ld = (inLanguage: unknown) =>
			`<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', inLanguage })}</script>`
		expect((await details(ld(['ja', 'en']))).language).toBe('ja')
		expect((await details(ld([{ name: 'de' }]))).language).toBe('de')
		expect((await details(ld('zh-TW'))).language).toBe('zh-TW')
		expect((await details(ld('mn-Mong'))).language).toBe('mn-Mong')
		expect((await details(ld('en_US'))).language).toBe('en')
		expect((await details(ld('pt-BR'))).language).toBe('pt')
		expect((await details(ld('xx-YY'))).language).toBeNull()
		expect((await details('<html lang="fr-CA"><title>t</title>')).language).toBe('fr')
		expect((await details('<meta property="og:locale" content=""><html lang="fr">')).language).toBeNull()
	})

	it('resolves og:site against the page, a bare host given http', async () => {
		expect((await details('<meta property="og:site" content="example.org">')).providerUrl).toBe('http://example.org/')
		expect((await details('<meta property="og:site" content="https://example.org/x">')).providerUrl).toBe(
			'https://example.org/x'
		)
		expect((await details('<meta property="og:site" content="ftp://example.org/">')).providerUrl).toBe(
			'http://ftp//example.org/'
		)
	})

	it('keeps an absolute http(s) author URL only', async () => {
		const ld = (url: unknown) =>
			`<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', author: { name: 'a', url } })}</script>`
		expect((await details(ld('https://example.org/a'))).authorUrl).toBe('https://example.org/a')
		expect((await details(ld('/a'))).authorUrl).toBe('')
		expect((await details(ld('javascript:alert(1)'))).authorUrl).toBe('')
		expect((await details(ld(7))).authorUrl).toBe('')
	})

	it('skips malformed JSON-LD shapes rather than failing (a declared deviation)', async () => {
		const scripts = [
			'[1, "NewsArticle", [{"@type": "WebPage"}]]',
			'{"@type": ["NewsArticle"], "headline": "array type"}',
			'{"@type": "NewsArticle", "headline": "first", "author": "John name"}',
		]
		const page = scripts.map((s) => `<script type="application/ld+json">${s}</script>`).join('')
		expect(await details(page)).toMatchObject({ title: 'first', authorName: '' })
		// A deep nesting is flattened without recursion.
		const deep = `${'['.repeat(8000)}{"name":"deep"}${']'.repeat(8000)}`
		const nested = `<script type="application/ld+json">{"@type":"NewsArticle","author":${deep}}</script>`
		expect((await details(nested)).authorName).toBe('deep')
	})

	it('casts published times as Rails would, ISO 8601 only', () => {
		expect(publishedTime('2022-01-31T19:53:00+00:00')).toBe('2022-01-31T19:53:00.000Z')
		expect(publishedTime('2022-01-31T19:53:00.5-0130')).toBe('2022-01-31T21:23:00.500Z')
		expect(publishedTime('2022-01-31')).toBe('2022-01-31T00:00:00.000Z')
		expect(publishedTime('2022-01-31 19:53')).toBe('2022-01-31T19:53:00.000Z')
		for (const refused of [
			'2022-02-30',
			'2022-13-01',
			'2022-01-31T24:00',
			'2022-01-31T19:53:00+24:00',
			'2022-01-31T19:53:00+01:60',
			'2022-01-31T19:53:00+99:99',
			'Jan 31, 2022',
			'',
			null,
		]) {
			expect(publishedTime(refused), String(refused)).toBeNull()
		}
	})

	it('derives the scan output maximum from the scan limits', () => {
		expect(CARD_OUTPUT_MAX_UNITS).toBe(
			SCAN_LIMITS.links *
				(SCAN_LIMITS.valueChars + SCAN_LIMITS.keyChars + SCAN_LIMITS.relTokens * SCAN_LIMITS.relTokenChars) +
				SCAN_LIMITS.metas * (2 * SCAN_LIMITS.keyChars + SCAN_LIMITS.valueChars) +
				SCAN_LIMITS.valueChars +
				SCAN_LIMITS.langChars +
				SCAN_LIMITS.jsonLd * SCAN_LIMITS.jsonLdChars
		)
		// The links' term: 64 × 3,200 more than without them (AM10).
		expect(CARD_OUTPUT_MAX_UNITS).toBe(428_096 + 64 * 3200)
		expect(SCAN_LIMITS.links).toBe(64)
	})

	it('reads no rel=me, and the links for an oEmbed endpoint', async () => {
		const scan: PageScan = (await scanHtml(
			new TextEncoder().encode(
				'<link rel="canonical me" href="https://example.org/"><a rel="me" href="/x"><link type="text/json+oembed" href="/o">'
			),
			{ label: 'utf-8', bomLength: 0 },
			CARD_SCAN
		)) as PageScan
		expect(scan.links).toEqual([
			{ rel: ['canonical', 'me'], href: 'https://example.org/', type: null },
			{ rel: [], href: '/o', type: 'text/json+oembed' },
		])
		expect(scan.relMe).toEqual([])
	})
})

describe('link details: the image (0070_card_images)', () => {
	it('reads og:image as a valid https URL and og:image:alt decoded, else none', async () => {
		const page = (image: string, alt?: string) =>
			`<title>t</title><meta property="og:image" content="${image}">${alt === undefined ? '' : `<meta property="og:image:alt" content="${alt}">`}`
		expect(await details(page('https://cdn.example/a.jpg', 'A &amp;amp; B'))).toMatchObject({
			imageUrl: 'https://cdn.example/a.jpg',
			imageDescription: 'A &amp; B',
		})
		expect((await details(page('/img/a.png'))).imageUrl).toBe('https://example.com/img/a.png')
		expect((await details(page('/img/a.png'), 'http://example.com/a')).imageUrl).toBe('')
		// The strict https predicate (S1): http and other schemes, and the literals valid_url_or_nil refuses, are none.
		for (const refused of ['http://cdn.example/a.jpg', 'httpsfoo://x', 'https://', 'null', '', 'data:image/png,x']) {
			expect((await details(page(refused))).imageUrl, refused).toBe('')
		}
		expect(await details('<title>t</title>')).toMatchObject({ imageUrl: '', imageDescription: '' })
		// The alt text is read without an image too (Mastodon presents it either way).
		expect((await details('<meta property="og:image:alt" content="alt">')).imageDescription).toBe('alt')
	})
})
