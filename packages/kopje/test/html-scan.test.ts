import fc from 'fast-check'
import { type DefaultTreeAdapterMap, html as parse5Html, parse } from 'parse5'
import { describe, expect, it } from 'vitest'

import { runs } from './policy-world'
import {
	OUTPUT_MAX_UNITS,
	outputMaxUnits,
	type PageScan,
	RAW_VALUE_CHARS,
	REL_CHARS,
	SCAN_LIMITS,
	type ScanFailure,
	type ScanLimits,
	scanHtml,
} from '../src/platform/html-scan'

const UTF8 = { label: 'utf-8', bomLength: 0 }
const encode = (text: string) => new TextEncoder().encode(text)

async function scan(page: string | Uint8Array, limits?: Partial<ScanLimits>): Promise<PageScan> {
	const result = await scanHtml(typeof page === 'string' ? encode(page) : page, UTF8, limits)
	if ('failed' in result) {
		throw new Error(`scan failed: ${result.failed}`)
	}
	return result
}

function scanOrFailure(page: string): Promise<PageScan | ScanFailure> {
	return scanHtml(encode(page), UTF8)
}

type Node = DefaultTreeAdapterMap['node']

// The oracle: the rel=me hrefs a spec parser with scripting off (as Mastodon's Nokogiri HTML5 parse) finds, in
// document order, template contents included; HTML namespace only; the token "me" among all tokens, ASCII
// case-insensitively, as Mastodon's NokogiriHandler.link_rel_include downcases the token list and the token.
function parse5RelMe(page: string): string[] {
	const found: string[] = []
	const walk = (node: Node) => {
		if ('tagName' in node) {
			const attribute = (name: string) => node.attrs.find((a) => a.name === name)?.value
			const rel = attribute('rel')
			if (
				node.namespaceURI === parse5Html.NS.HTML &&
				(node.tagName === 'a' || node.tagName === 'link') &&
				rel !== undefined &&
				rel
					.split(/[\t\n\f\r ]+/)
					.map((token) => token.replace(/[A-Z]+/g, (upper) => upper.toLowerCase()))
					.includes('me')
			) {
				found.push(attribute('href') ?? '')
			}
			if (node.tagName === 'template' && 'content' in node) {
				walk(node.content)
			}
		}
		if ('childNodes' in node) {
			for (const child of node.childNodes) {
				walk(child)
			}
		}
	}
	walk(parse(page, { scriptingEnabled: false }))
	return found
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength

function strings(result: PageScan): string[] {
	return [
		...(result.lang === null ? [] : [result.lang]),
		...(result.title === null ? [] : [result.title]),
		...result.relMe.filter((href) => href !== null),
		...result.links.flatMap((link) => [...link.rel, link.href ?? '', link.type ?? '']),
		...result.metas.flatMap((meta) => [meta.property ?? '', meta.name ?? '', meta.content ?? '']),
		...result.jsonLd,
	]
}

function unitsOf(result: PageScan): number {
	return strings(result).reduce((sum, text) => sum + text.length, 0)
}

describe('scanHtml collection', () => {
	it('collects rel=me hrefs in document order from a and link, by the ASCII case-insensitive token', async () => {
		const page =
			'<a rel="nofollow me" href="h1"></a><link rel=me href=h2><a rel="mee" href="h3"></a>' +
			'<a rel="\tme\n" href="h4"></a><a href="h5" rel="author"></a><a rel="ME" href="h7"></a>' +
			'<link rel="Me" href="h8"><a rel="m&#101;" href="h9"></a><div><p><a rel="me noopener" href="h6">'
		const result = await scan(page)
		expect(result.relMe).toEqual(['h1', 'h2', 'h4', 'h7', 'h8', 'h9', 'h6'])
		expect(result.relMe).toEqual(parse5RelMe(page))
		// links[].rel is lowercased, for card extraction.
		expect(result.links.map((link) => link.rel)).toEqual([['me'], ['me']])
	})

	it('finds the token me past the first relTokens tokens of a rel, so the first rel=me stays first', async () => {
		const tokens = Array.from({ length: SCAN_LIMITS.relTokens }, (_, i) => `t${i}`).join(' ')
		const page = `<a rel="${tokens} ME" href="first"></a><a rel=me href="second"></a><link rel="${tokens} me" href=l>`
		const result = await scan(page)
		expect(result.relMe).toEqual(['first', 'second', 'l'])
		expect(result.relMe).toEqual(parse5RelMe(page))
		expect(result.links[0]?.rel).toHaveLength(SCAN_LIMITS.relTokens)
	})

	it('collects no rel=me at or after a rel past REL_CHARS', async () => {
		const long = `${'x '.repeat(REL_CHARS / 2)}me`
		const page = `<a rel=me href=before></a><a rel="${long}" href="first"></a><a rel=me href="second"></a>`
		expect(parse5RelMe(page)).toEqual(['before', 'first', 'second'])
		const result = await scan(page)
		expect(result.relMe).toEqual(['before'])
		expect(result.relMeAfterLongRel).toBe(true)
		expect(result.dropped.relMe).toBe(2)
		// A link's oversized rel likewise, its links[] entry kept with no tokens.
		const linked = await scan(`<link rel="${long}" href=l><a rel=me href=after>`)
		expect(linked).toMatchObject({ relMe: [], relMeAfterLongRel: true, links: [{ rel: [], href: 'l' }] })
		// At exactly REL_CHARS decoded units the rel is tokenized whole.
		const atCap = `${'x'.repeat(REL_CHARS - 3)} me`
		expect((await scan(`<a rel="${atCap}" href=h>`)).relMe).toEqual(['h'])
	})

	it('keeps a null slot for a missing or oversized href', async () => {
		const result = await scan(
			`<a rel=me></a><a rel=me href="${'x'.repeat(SCAN_LIMITS.valueChars + 1)}"></a><a rel=me href="ok"></a>`
		)
		expect(result.relMe).toEqual([null, null, 'ok'])
		expect(result.dropped.values).toBe(1)
	})

	it('collects metas with property or name, keys lowercased, an oversized value dropped and counted', async () => {
		const result = await scan(
			'<meta property="OG:Title" content="One"><meta name="Description" content="Two">' +
				`<meta property="og:image" content="${'y'.repeat(SCAN_LIMITS.valueChars + 1)}">` +
				'<meta charset="utf-8"><meta itemprop="x" content="z">'
		)
		expect(result.metas).toEqual([
			{ property: 'og:title', name: null, content: 'One' },
			{ property: null, name: 'description', content: 'Two' },
			{ property: 'og:image', name: null, content: null },
		])
		expect(result.dropped.values).toBe(1)
	})

	it('collects every link with its rel tokens, href and type', async () => {
		const result = await scan(
			'<link rel="alternate" type="application/json+oembed" href="https://a.example/o">' +
				'<link rel="Canonical" href="/c"><link href="/no-rel">'
		)
		expect(result.links).toEqual([
			{ rel: ['alternate'], href: 'https://a.example/o', type: 'application/json+oembed' },
			{ rel: ['canonical'], href: '/c', type: null },
			{ rel: [], href: '/no-rel', type: null },
		])
	})

	it('caps rel tokens by count and length', async () => {
		const tokens = Array.from({ length: 20 }, (_, i) => `t${i}`)
		const long = 'l'.repeat(SCAN_LIMITS.relTokenChars + 1)
		const result = await scan(`<link rel="${long} ${tokens.join(' ')}" href="x">`)
		expect(result.links[0]?.rel).toEqual(tokens.slice(0, SCAN_LIMITS.relTokens))
	})

	it('takes the first html lang', async () => {
		expect((await scan('<html lang="ja"><html lang="en">')).lang).toBe('ja')
		expect((await scan('<p lang="en">')).lang).toBeNull()
	})

	it('takes the first HTML title whose end tag was seen, untrimmed', async () => {
		expect((await scan('<title> Page </title><title>Second</title>')).title).toBe(' Page ')
		// lol-html reports an SVG title as XHTML: no title after an svg or math start tag is taken.
		expect((await scan('<svg><title>icon</title></svg><title>Page</title>')).title).toBeNull()
		expect((await scan('<math></math><title>Page</title>')).title).toBeNull()
		expect((await scan('<title>never closed')).title).toBeNull()
	})

	it('keeps only completed JSON-LD scripts of the exact type, raw', async () => {
		const result = await scan(
			'<script type="application/ld+json">{"a":"&amp;"}</script>' +
				'<script type="Application/LD+JSON">{"b":1}</script><script>{"c":1}</script>' +
				`<script type="application/ld+json">${'z'.repeat(SCAN_LIMITS.jsonLdChars + 1)}</script>` +
				'<script type="application/ld+json">{"cut":'
		)
		expect(result.jsonLd).toEqual(['{"a":"&amp;"}'])
		expect(result.dropped.jsonLd).toBe(1)
	})

	it('lets a caller only lower the limits', async () => {
		const page = '<a rel=me href=1></a><a rel=me href=2></a><a rel=me href=3></a>'
		expect((await scan(page, { relMe: 2 })).relMe).toEqual(['1', '2'])
		expect((await scan(page, { relMe: 1_000 })).relMe).toEqual(['1', '2', '3'])
	})
})

describe('scanHtml references and normalization', () => {
	it('decodes attribute references in attribute mode', async () => {
		const result = await scan('<a rel=me href="?a=1&amp;b=2&copy=3&notit;&lt&#x41;&#66"></a>')
		expect(result.relMe).toEqual(['?a=1&b=2&copy=3&notit;<AB'])
	})

	it('decodes text references in text mode, once', async () => {
		expect((await scan('<title>&amp;amp; &notit; &lt</title>')).title).toBe('&amp; ¬it; <')
	})

	it('replaces NUL, surrogate and out-of-range references, and maps C1 references', async () => {
		const result = await scan('<a rel=me href="&#0;|&#xD800;|&#x110000;|&#128;|&#x9F;|&#1;"></a>')
		expect(result.relMe).toEqual(['�|�|�|€|Ÿ|\u0001'])
	})

	it('replaces a raw NUL and normalizes raw CR and CRLF to LF, while an encoded CR stays', async () => {
		const result = await scan('<a rel=me href="a\0b\r\nc\rd&#13;e"></a><title>x\r\ny\0</title>')
		expect(result.relMe).toEqual(['a�b\nc\nd\re'])
		expect(result.title).toBe('x\ny�')
	})
})

describe('scanHtml against a scripting-off parser', () => {
	// Markup where a naive reading would find an anchor that the spec parser does not, and some where it does.
	it.each([
		['script double escape', '<script><!--<script></script><a rel=me href=x></script>'],
		['DOCTYPE quoted public id', '<!DOCTYPE html PUBLIC "<a rel=me href=x>">'],
		['svg a', '<svg><a rel=me href=x></a></svg>'],
		['svg CDATA', '<svg><![CDATA[<a rel=me href=x>]]></svg>'],
		['math mi a', '<math><mi><a rel=me href=x></a></mi></math>'],
		['svg foreignObject a', '<svg><foreignObject><a rel=me href=x></a></foreignObject></svg>'],
		['mismatched </svg>', '<svg><g></svg><a rel=me href=x>'],
		['an HTML start tag breaking out of svg', '<svg><g><p><a rel=me href=x>'],
		['</svg> underflow', '</svg></svg><svg><a rel=me href=x>'],
		['end tag with quoted attributes', '</p title="<a rel=me href=x>">'],
		['comment ended by --!>', '<!-- --!> <a rel=me href=x> -->'],
		['abruptly closed comment', '<!---><a rel=me href=x>'],
		['comment with --', '<!-- -- <a rel=me href=x> -->'],
		['duplicate rel attributes', '<a rel=nofollow rel=me href=x>'],
		['textarea', '<textarea><a rel=me href=x></textarea>'],
		['title', '<title><a rel=me href=x></title>'],
		['xmp', '<xmp><a rel=me href=x></xmp>'],
		['iframe', '<iframe><a rel=me href=x></iframe>'],
		['noembed', '<noembed><a rel=me href=x></noembed>'],
		['noframes', '<noframes><a rel=me href=x></noframes>'],
		['style', '<style><a rel=me href=x></style>'],
		['plaintext', '<plaintext><a rel=me href=x>'],
		['template', '<template><a rel=me href=x></a></template>'],
		['mixed-case ME', '<a rel=ME href=x>'],
		['mixed-case Me link', '<link rel="nofollow Me" href=x>'],
	])('finds no rel=me the parser does not on %s', async (_label, page) => {
		const result = await scanOrFailure(page)
		const relMe = 'failed' in result ? [] : result.relMe
		const oracle = parse5RelMe(page)
		for (const href of relMe) {
			expect(oracle).toContain(href)
		}
	})

	it.each([
		['<select><template></select></template><a rel=me href=x>', 'relMeAfterSelect'],
		['<select><template></select></template><link rel=me href=x>', 'relMeAfterSelect'],
		['<math><mtext></mi><title><head><a rel=me href=x>', 'relMeAfterForeign'],
		['<svg><template><foreignObject></template><a rel=me href=x>', 'relMeAfterForeign'],
	])('refuses the counterexample %s', async (page, flag) => {
		expect(parse5RelMe(page)).toEqual([])
		expect(await scan(page)).toMatchObject({ relMe: [], [flag]: true })
	})

	it('collects no rel=me after a noscript start tag, which it reads as raw text', async () => {
		const counterexample = '<body><noscript><!--</noscript><a rel=me href="https://actor.example/u/a">--></noscript>'
		expect(parse5RelMe(counterexample)).toEqual([])
		const result = await scan(counterexample)
		expect(result.relMe).toEqual([])
		expect(result.relMeAfterNoscript).toBe(true)
		expect(result.dropped.relMe).toBe(1)
	})

	it('keeps a rel=me before the first noscript and the card metadata after it', async () => {
		const result = await scan(
			'<a rel=me href=before></a><noscript></noscript><a rel=me href=after></a><link rel=me href=after2>' +
				'<meta property="og:title" content="t"><link rel=canonical href=c><title>T</title>'
		)
		expect(result.relMe).toEqual(['before'])
		expect(result.relMeAfterNoscript).toBe(true)
		expect(result.dropped.relMe).toBe(2)
		expect(result.metas).toHaveLength(1)
		expect(result.links.map((link) => link.href)).toEqual(['after2', 'c'])
		expect(result.title).toBe('T')
	})

	it('collects no rel=me after a select start tag', async () => {
		const page =
			'<a rel=me href=before></a><select><a rel=me href=in><link rel=me href=in2></select><a rel=me href=out>'
		expect(parse5RelMe(page)).toEqual(['before', 'out'])
		const result = await scan(page)
		expect(result.relMe).toEqual(['before'])
		expect(result.relMeAfterSelect).toBe(true)
		expect(result.dropped.relMe).toBe(3)
	})

	it('returns no rel=me from a page with a frameset, which can replace the body', async () => {
		for (const page of [
			'<a rel=me href=x></a><frameset>',
			'<frameset><a rel=me href=x>',
			'<a rel=me href=x></a><noscript><FRAMESET></noscript>',
		]) {
			expect(parse5RelMe(page)).toEqual([])
			const result = await scan(page)
			expect(result).toMatchObject({ relMe: [], relMeWithFrameset: true, outputUnits: 0 })
		}
		// Read from the bytes, so a frameset in a comment or in SVG refuses too: that only misses.
		expect((await scan('<!-- <frameset> --><a rel=me href=x>')).relMe).toEqual([])
		expect((await scan('<a rel=me href=x></a><frame>')).relMe).toEqual(['x'])
	})

	it('collects no rel=me after an svg or math start tag', async () => {
		for (const page of [
			'<math><svg><desc><a rel=me href=x>',
			'<svg><math><mtext><a rel=me href=x>',
			'<svg></svg><a rel=me href=x>',
		]) {
			expect(await scan(page)).toMatchObject({ relMe: [], relMeAfterForeign: true })
		}
		expect((await scan('<a rel=me href=x></a><svg></svg>')).relMe).toEqual(['x'])
	})

	// A token soup of the constructs above; Kopje may miss a rel=me the oracle finds, never find one it does not.
	const FRAGMENTS = [
		'<a rel=me href=ID>',
		'<A REL="me nofollow" HREF=ID>',
		'<a rel=ME href=ID>',
		'<link rel="Me" href=ID>',
		'<mtext>',
		'</mi>',
		'<link rel=me href=ID>',
		'<a rel=me href=ID/>',
		'<form>',
		'</form>',
		'<li>',
		'<p>',
		'<html>',
		'<isindex>',
		'<marquee>',
		'<applet>',
		'</a>',
		'<svg>',
		'</svg>',
		'<math>',
		'<mi>',
		'</math>',
		'<foreignObject>',
		'<script>',
		'</script>',
		'<!--',
		'-->',
		'--!>',
		'<noscript>',
		'</noscript>',
		'<textarea>',
		'</textarea>',
		'<title>',
		'</title>',
		'<template>',
		'</template>',
		'<select>',
		'</select>',
		'<table>',
		'<tr>',
		'<![CDATA[',
		']]>',
		'<!DOCTYPE html PUBLIC "',
		'"',
		"'",
		'<style>',
		'</style>',
		'<xmp>',
		'<iframe>',
		'<p title="',
		'</p>',
		'<option>',
		'<desc>',
		'<frameset>',
		'<frame>',
		'<input>',
		'<keygen>',
		'<td>',
		'</table>',
		'<caption>',
		'<colgroup>',
		'<head>',
		'</head>',
		'<body>',
		'</body>',
		'</html>',
		'<image>',
		'<object>',
		'<annotation-xml encoding="text/html">',
		'<font color=red>',
		'<b>',
		'</b>',
		'<button>',
		'<noembed>',
		'<plaintext>',
		'<optgroup>',
		'<hr>',
		'<math><mtext>',
		'<svg><desc>',
		'&lt;',
		'text',
		' ',
		'>',
		'<',
		'/',
	]

	it('never finds a rel=me the scripting-off parser does not', { timeout: 120_000 }, async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 40 }), async (parts) => {
				let id = 0
				const page = parts.map((part) => part.replace('ID', () => `h${id++}`)).join('')
				const result = await scanOrFailure(page)
				if ('failed' in result) {
					return
				}
				const oracle = parse5RelMe(page)
				for (const href of result.relMe) {
					expect(href === null || oracle.includes(href), `${href} in ${JSON.stringify(page)}`).toBe(true)
				}
			}),
			runs(5000)
		)
	})
})

describe('scanHtml failures', () => {
	it('fails on a parsing ambiguity, returning nothing collected', async () => {
		expect(await scanOrFailure('<a rel=me href=x></a><select><xmp><a rel=me href=y></xmp></select>')).toEqual({
			failed: 'ambiguity',
		})
	})

	it('fails when a buffered tag passes the rewriter memory limit', { timeout: 60_000 }, async () => {
		expect(await scanOrFailure(`<a rel=me href=x></a><a href="${'x'.repeat(4 * 1024 * 1024)}`)).toEqual({
			failed: 'memory',
		})
	})

	it('fails on a label the rewriter cannot decode natively', async () => {
		expect(await scanHtml(encode('<a>'), { label: 'no-such-label', bomLength: 0 })).toEqual({ failed: 'parser' })
	})

	it('stops a scan that is still pumping when aborted, and returns nothing', { timeout: 60_000 }, async () => {
		const page = encode('<a rel=me href=x></a>'.repeat(50_000))
		const started = Date.now()
		await scanHtml(page, UTF8)
		const whole = Date.now() - started
		const controller = new AbortController()
		const running = scanHtml(page, UTF8, undefined, controller.signal)
		setTimeout(() => controller.abort(new Error('deadline')), 0)
		await expect(running).rejects.toThrow('deadline')
		expect(Date.now() - started - whole).toBeLessThan(whole + 1000)
	})

	it('rejects with the abort reason and returns nothing once aborted', async () => {
		const controller = new AbortController()
		controller.abort(new Error('stop'))
		await expect(scanHtml(encode('<a rel=me href=x>'), UTF8, undefined, controller.signal)).rejects.toThrow('stop')
	})
})

describe('scanHtml charset', () => {
	it('does not re-sniff a meta charset that disagrees with the chosen label', async () => {
		const page = new Uint8Array([...encode('<meta charset="utf-8"><title>'), 0xe9, ...encode('</title>')])
		const result = await scanHtml(page, { label: 'windows-1252', bomLength: 0 })
		expect(result).toMatchObject({ title: 'é' })
	})

	it('decodes Shift_JIS natively', async () => {
		const page = new Uint8Array([...encode('<title>'), 0x82, 0xa0, ...encode('</title>')])
		expect(await scanHtml(page, { label: 'shift_jis', bomLength: 0 })).toMatchObject({ title: 'あ' })
	})

	it.each(['utf-16le', 'utf-16be'])('transcodes %s to UTF-8 first, BOM removed', async (label) => {
		const text = '<title>ü</title><a rel=me href=x>'
		const units = [...text].map((c) => c.charCodeAt(0))
		const bytes = new Uint8Array(2 + units.length * 2)
		bytes.set(label === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff])
		units.forEach((unit, i) => {
			const [hi, lo] = [unit >> 8, unit & 0xff]
			bytes.set(label === 'utf-16le' ? [lo, hi] : [hi, lo], 2 + i * 2)
		})
		expect(await scanHtml(bytes, { label, bomLength: 2 })).toMatchObject({ title: 'ü', relMe: ['x'] })
	})

	it('transcodes ISO-2022-JP to UTF-8 first', async () => {
		// ESC $ B 0x24 0x22 ESC ( B is あ.
		const page = new Uint8Array([
			...encode('<title>'),
			0x1b,
			0x24,
			0x42,
			0x24,
			0x22,
			0x1b,
			0x28,
			0x42,
			...encode('</title>'),
		])
		expect(await scanHtml(page, { label: 'iso-2022-jp', bomLength: 0 })).toMatchObject({ title: 'あ' })
	})
})

describe('scanHtml bounds', () => {
	it('derives the output maximum from the limits', () => {
		const l = SCAN_LIMITS
		const expected =
			l.relMe * l.valueChars +
			l.links * (l.valueChars + l.keyChars + l.relTokens * l.relTokenChars) +
			l.metas * (l.keyChars + l.keyChars + l.valueChars) +
			l.valueChars +
			l.langChars +
			l.jsonLd * l.jsonLdChars
		expect(OUTPUT_MAX_UNITS).toBe(expected)
		expect(OUTPUT_MAX_UNITS).toBe(698_432)
		expect(OUTPUT_MAX_UNITS * 3).toBe(2_095_296)
		expect(OUTPUT_MAX_UNITS * 6).toBe(4_190_592)
		expect(outputMaxUnits({ ...l, relMe: 0 })).toBe(expected - l.relMe * l.valueChars)
	})

	// One value of `units` decoded UTF-16 code units at its worst for JSON: &#1; escapes to \u0001 (6 bytes), a raw
	// NUL decodes to U+FFFD (3 UTF-8 bytes) and &quot; to an escaped quote; an astral character is 2 units, 4 bytes.
	const worst = (units: number) => '&#1;'.repeat(units - 2) + '\0&quot;'
	const astral = (units: number) => '😀'.repeat(units / 2)

	it('saturates every field at its cap within the derived bounds', { timeout: 60_000 }, async () => {
		const l = SCAN_LIMITS
		const parts: string[] = [`<html lang="${worst(l.langChars)}">`]
		parts.push(`<title>${worst(l.valueChars)}</title>`)
		for (let i = 0; i < l.relMe; i++) {
			parts.push(`<a rel=me href="${i % 2 === 0 ? worst(l.valueChars) : astral(l.valueChars)}"></a>`)
		}
		const tokens = Array.from({ length: l.relTokens }, (_, i) => `${i}`.padEnd(l.relTokenChars, 'r')).join(' ')
		for (let i = 0; i < l.links; i++) {
			parts.push(`<link rel="${tokens}" href="${worst(l.valueChars)}" type="${worst(l.keyChars)}">`)
		}
		for (let i = 0; i < l.metas; i++) {
			parts.push(`<meta property="${worst(l.keyChars)}" name="${worst(l.keyChars)}" content="${worst(l.valueChars)}">`)
		}
		for (let i = 0; i < l.jsonLd; i++) {
			parts.push(`<script type="application/ld+json">${'\u0001'.repeat(l.jsonLdChars)}</script>`)
		}
		// One more of each, past its cap.
		parts.push('<a rel=me href=x></a><link rel=x href=y><meta name=n content=c>')
		parts.push('<script type="application/ld+json">{}</script>')
		const result = await scan(parts.join(''))
		expect(result.relMe).toHaveLength(l.relMe)
		expect(result.links).toHaveLength(l.links)
		expect(result.metas).toHaveLength(l.metas)
		expect(result.jsonLd).toHaveLength(l.jsonLd)
		expect(result.title?.length).toBe(l.valueChars)
		expect(result.lang?.length).toBe(l.langChars)
		expect(result.dropped).toMatchObject({ relMe: 1, links: 1, metas: 1, jsonLd: 1, values: 0 })
		expect(result.outputUnits).toBe(unitsOf(result))
		expect(result.outputUnits).toBe(OUTPUT_MAX_UNITS)
		const payload = strings(result)
		const utf8 = payload.reduce((sum, text) => sum + utf8Bytes(text), 0)
		expect(utf8).toBeLessThanOrEqual(OUTPUT_MAX_UNITS * 3)
		const escaped = payload.reduce((sum, text) => sum + utf8Bytes(JSON.stringify(text)) - 2, 0)
		expect(escaped).toBeLessThanOrEqual(OUTPUT_MAX_UNITS * 6)
		// The structure around the strings, from a skeleton with every entry at its cap, every string empty (or null,
		// the longer) and every number at its longest.
		const big = Number.MAX_SAFE_INTEGER
		const skeleton: PageScan = {
			lang: null,
			title: null,
			relMe: Array.from({ length: l.relMe }, () => null),
			relMeAfterNoscript: false,
			relMeAfterSelect: false,
			relMeAfterForeign: false,
			relMeAfterLongRel: false,
			relMeWithFrameset: false,
			links: Array.from({ length: l.links }, () => ({
				rel: Array.from({ length: l.relTokens }, () => ''),
				href: null,
				type: null,
			})),
			metas: Array.from({ length: l.metas }, () => ({ property: null, name: null, content: null })),
			jsonLd: Array.from({ length: l.jsonLd }, () => ''),
			dropped: { relMe: big, links: big, metas: big, jsonLd: big, values: big },
			outputUnits: big,
			work: { elements: big, textChunks: big },
		}
		const structure = utf8Bytes(JSON.stringify(skeleton))
		expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(OUTPUT_MAX_UNITS * 6 + structure)
	})
})

describe('scanHtml on hostile 1 MiB pages', () => {
	const MiB = 1024 * 1024
	const fill = (unit: string, prefix = '', suffix = '') =>
		prefix + unit.repeat(Math.floor((MiB - prefix.length - suffix.length) / unit.length)) + suffix

	// Unclosed elements stay on lol-html's stack of open elements: past its memory limit the scan fails, whole.
	it.each([
		['deep nesting', fill('<div>', '', '<a rel=me href=deep>'), 'memory'],
		['150k unclosed rel=me anchors', fill('<a rel=me>'), 'memory'],
		['70k closed rel=me anchors', fill('<a rel=me></a>'), 'scanned'],
		['a 1 MiB attribute', fill('x', '<a rel=me href="', '">'), 'scanned'],
		['10k attributes on one tag', fill(' a=b', '<a rel=me href=x', '>'), 'scanned'],
		['an unterminated tag', fill(' x', '<a rel=me href=y'), 'scanned'],
		['an unterminated quote', fill('x', '<a rel=me href="'), 'scanned'],
		['an unterminated comment', fill('x', '<!--<a rel=me href=c>'), 'scanned'],
		['an unterminated script', fill('<a rel=me href=s>', '<script>'), 'scanned'],
		['an unterminated title', fill('&amp;', '<title>'), 'scanned'],
		['a reference flood in an attribute', fill('&amp;', '<a rel=me href="', '">'), 'scanned'],
		['80k links', fill('<link rel=me>'), 'scanned'],
		['80k metas', fill('<meta name=a>'), 'scanned'],
		['many JSON-LD scripts', fill('<script type="application/ld+json">{}</script>'), 'scanned'],
		['many titles', fill('<title>t</title>'), 'scanned'],
	])('stays within the caps on %s', { timeout: 60_000 }, async (_label, page, outcome) => {
		const bytes = encode(page)
		expect(bytes.byteLength).toBeLessThanOrEqual(MiB)
		const result = await scanOrFailure(page)
		if ('failed' in result) {
			expect(result.failed).toBe(outcome)
			return
		}
		expect(outcome).toBe('scanned')
		expect(result.relMe.length).toBeLessThanOrEqual(SCAN_LIMITS.relMe)
		expect(result.links.length).toBeLessThanOrEqual(SCAN_LIMITS.links)
		expect(result.metas.length).toBeLessThanOrEqual(SCAN_LIMITS.metas)
		expect(result.jsonLd.length).toBeLessThanOrEqual(SCAN_LIMITS.jsonLd)
		expect(result.outputUnits).toBe(unitsOf(result))
		expect(result.outputUnits).toBeLessThanOrEqual(OUTPUT_MAX_UNITS)
		// A matched start tag is at least 6 bytes ("<link>"), and a text chunk at least one.
		expect(result.work.elements).toBeLessThanOrEqual(bytes.byteLength / 6)
		expect(result.work.textChunks).toBeLessThanOrEqual(bytes.byteLength)
	})

	it('reads invalid UTF-8 as replacement characters without failing', async () => {
		const bytes = new Uint8Array(MiB)
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = (i * 7919) % 256
		}
		const result = await scanHtml(bytes, UTF8)
		expect('failed' in result ? result.failed : 'scanned').toMatch(/scanned|ambiguity/)
	})

	it('keeps the raw read of a value at RAW_VALUE_CHARS', async () => {
		const result = await scan(`<a rel=me href="${'&#1;'.repeat(RAW_VALUE_CHARS / 4 + 1)}">`)
		expect(result.relMe).toEqual([null])
	})

	it('never throws and keeps its caps on arbitrary input', { timeout: 120_000 }, async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 300 }), async (page) => {
				const result = await scanOrFailure(page)
				if ('failed' in result) {
					return
				}
				expect(result.outputUnits).toBe(unitsOf(result))
				expect(result.relMe.length).toBeLessThanOrEqual(SCAN_LIMITS.relMe)
			}),
			runs(300)
		)
	})
})
