import { jsx } from 'hono/jsx'
import sanitizeHtml from 'sanitize-html'
import { describe, expect, it } from 'vitest'

import { attr, elements, one, parseHtml, query, text } from './web-dom'
import { account, emoji, poll, render, SITE, status } from './web-fixtures'
import { sanitizeRemoteHtmlFiltered } from '../src/security/html'
import { Emoji } from '../src/web/components/post'
import { ProfilePage } from '../src/web/pages/profile'
import { StatusPage } from '../src/web/pages/status'
import { sanitizedWithEmoji } from '../src/web/safe-html'
import {
	EMOJI_FIELD_IMAGES,
	EMOJI_PAGE_BYTES,
	EMOJI_PAGE_IMAGES,
	emojiAllowance,
	emojiField,
	emojiHtml,
} from '../src/web/view/emoji'

// Custom emoji on the pages (design §2 "Emoji allowance", §12; HTML-1, HTML-3): the sanitizer's text filter, the
// image markup, the checks at the sink and the allowance.

const URL_A = 'https://emoji.example/a.png?size=20&v=1'

describe('the sanitizer text filter (design §12, R10)', () => {
	it('gets each run of text escaped and writes what it returns unescaped', () => {
		// sanitize-html itself, as the dependency is pinned.
		const runs: string[] = []
		const plain = sanitizeHtml('<p>1 &lt; 2 &amp; "3" <i>x</i></p>', {
			allowedTags: ['p', 'i'],
			textFilter: (text) => {
				runs.push(text)
				return text === 'x' ? '<b>!</b>' : text
			},
		})
		// A text node comes in runs split at its character references, each run escaped.
		expect(runs).toEqual(['1 ', '&lt;', ' 2 ', '&amp;', ' "3" ', 'x'])
		expect(plain).toBe('<p>1 &lt; 2 &amp; "3" <i><b>!</b></i></p>')

		// Kopje's allowlist: attribute values and text dropped with its element never reach the filter.
		const seen: string[] = []
		const out = sanitizeRemoteHtmlFiltered(
			'<p>a &lt;b&gt; <a href="https://x.example/:a:">:a:</a></p><script>:a:</script><style>:a:</style>',
			(text) => {
				seen.push(text)
				return text.replaceAll(':a:', '<mark>')
			}
		)
		expect(seen).toEqual(['a ', '&lt;', 'b', '&gt;', ' ', ':a:'])
		expect(out).toBe(
			'<p>a &lt;b&gt; <a href="https://x.example/:a:" rel="nofollow noopener" target="_blank"><mark></a></p>'
		)
	})
})

describe('emoji images (design §11, HTML-3)', () => {
	it('are written as the Emoji component writes them, attributes escaped', async () => {
		for (const ref of [
			{ shortcode: 'a_b-c+d', url: URL_A },
			{ shortcode: `x"'<>&`, url: `https://emoji.example/q?a='"<>&` },
		]) {
			expect(await render(jsx(Emoji, { emoji: ref }))).toBe(emojiHtml(ref))
		}
		expect(emojiHtml({ shortcode: 'a', url: URL_A })).toBe(
			'<img class="emoji" src="https://emoji.example/a.png?size=20&amp;v=1" alt=":a:" width="20" height="20" loading="lazy" decoding="async"/>'
		)
	})

	it('replace a reference in text and in sanitized HTML, and nothing else', () => {
		const field = () => emojiField([emoji('a', URL_A)], emojiAllowance())
		expect(field().text(':a: and :a:b: but not :b: or : a: or :a')).toEqual([
			{ shortcode: 'a', url: URL_A },
			' and ',
			{ shortcode: 'a', url: URL_A },
			'b: but not :b: or : a: or :a',
		])
		const html = sanitizedWithEmoji(
			'<p>:a: &amp; <a href="https://x.example/:a:/">:a:</a> <code>x:a:y</code></p><script>:a:</script>',
			field()
		).html
		const doc = parseHtml(html)
		expect(query(doc, 'img').map((img) => attr(img, 'src'))).toEqual([URL_A, URL_A, URL_A])
		expect(attr(one(doc, 'a'), 'href')).toBe('https://x.example/:a:/')
		expect(html).toContain(' &amp; ')
		expect(html).not.toContain('script')
	})

	it('are refused at the sink for a shortcode or url the stored bounds would refuse', async () => {
		// Each is offered as the status's, its author's and its quoted status's emoji; none passes the checks at the sink.
		const hostile = [
			emoji('"><script>alert(1)</script>', URL_A),
			emoji('x"onerror="alert(1)', URL_A),
			emoji('x y', URL_A),
			emoji('a'.repeat(129), URL_A),
			emoji('js', 'javascript:alert(1)'),
			emoji('data', 'data:image/png;base64,AAAA'),
			emoji('lt', 'https://emoji.example/<script>'),
			emoji('quote', 'https://emoji.example/x" onerror="alert(1)'),
			emoji('long', `https://emoji.example/${'x'.repeat(512)}`),
			emoji('host', 'https://EMOJI.example/a.png'),
		]
		const names = ['x"onerror="alert(1)', 'x y', 'a'.repeat(129), 'js', 'data', 'lt', 'quote', 'long', 'host']
		const refs = names.map((name) => `:${name}:`).join(' ')
		const page = await render(
			jsx(StatusPage, {
				status: status('1', {
					account: account({ display_name: `Alice ${refs}`, emojis: hostile }),
					spoiler_text: `Warning ${refs}`,
					content: `<p>Content ${refs} :&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;:</p>`,
					emojis: hostile,
					poll: poll({ options: [{ title: `Choice ${refs}`, votes_count: 1 }] }),
				}),
				parent: null,
				site: SITE,
			})
		)
		const doc = parseHtml(page)
		expect(query(doc, 'img').filter((img) => attr(img, 'class') === 'emoji')).toEqual([])
		for (const absent of ['javascript:', 'data:image', '<script>', 'xxxxxxxxxx', 'EMOJI.example']) {
			expect(page).not.toContain(absent)
		}
		// The quote in a shortcode stays text: no element gains an attribute from it.
		expect(elements(doc).filter((e) => e.attrs.some((a) => a.name.startsWith('on')))).toEqual([])
		// Each reference stays as escaped text, so the checks ran on it.
		expect(text(one(doc, 'h1'))).toBe(`Alice ${refs}`)
		expect(text(one(doc, 'span', 'spoiler'))).toBe(`Warning ${refs}`)
		expect(text(one(doc, 'div', 'body'))).toBe(`Content ${refs} :"><script>alert(1)</script>:`)
		expect(text(one(doc, 'ul', 'opts'))).toContain(`Choice ${refs}`)
	})
})

describe('the emoji allowance (design §2)', () => {
	it('is 64 images a field, 512 a page and 512 × 650 bytes of their markup', () => {
		expect([EMOJI_FIELD_IMAGES, EMOJI_PAGE_IMAGES, EMOJI_PAGE_BYTES]).toEqual([64, 512, 332_800])
	})

	it('stops at the field cap, then at the page cap, in the order the fields are built', () => {
		const allowance = emojiAllowance()
		const refs = (n: number) => ':a:'.repeat(n)
		const first = emojiField([emoji('a', URL_A)], allowance).text(refs(EMOJI_FIELD_IMAGES + 1))
		expect(first.filter((part) => typeof part !== 'string')).toHaveLength(EMOJI_FIELD_IMAGES)
		expect(first.at(-1)).toBe(':a:')
		let shown = EMOJI_FIELD_IMAGES
		for (let i = 0; i < 8; i++) {
			const html = emojiField([emoji('a', URL_A)], allowance).html(refs(EMOJI_FIELD_IMAGES))
			shown += html.split('<img ').length - 1
		}
		expect(shown).toBe(EMOJI_PAGE_IMAGES)
		expect(allowance.images).toBe(0)
		// Past it, a reference is text in either form.
		expect(emojiField([emoji('a', URL_A)], allowance).text(':a:')).toEqual([':a:'])
		expect(emojiField([emoji('a', URL_A)], allowance).html(':a:')).toBe(':a:')
	})

	it('charges each image its escaped markup and stops within EMOJI_PAGE_BYTES (amendment A5)', () => {
		// The longest url the stored bounds keep, ampersands throughout: each escapes to five bytes.
		const url = `https://emoji.example/?${'&'.repeat(512 - 23)}`
		expect(url).toHaveLength(512)
		const shortcode = 'e'.repeat(128)
		const each = emojiHtml({ shortcode, url }).length
		expect(each).toBeGreaterThan(2_500)
		const allowance = emojiAllowance()
		let images = 0
		let markup = 0
		for (let i = 0; i < EMOJI_PAGE_IMAGES / EMOJI_FIELD_IMAGES; i++) {
			const html = emojiField([emoji(shortcode, url)], allowance).html(`:${shortcode}:`.repeat(EMOJI_FIELD_IMAGES))
			const shown = html.split('<img ').length - 1
			images += shown
			markup += shown * each
		}
		// Fewer than EMOJI_PAGE_IMAGES: the bytes ran out first, within the bound.
		expect(images).toBe(Math.floor(EMOJI_PAGE_BYTES / each))
		expect(images).toBeLessThan(EMOJI_PAGE_IMAGES)
		expect(markup).toBeLessThanOrEqual(EMOJI_PAGE_BYTES)
		expect(allowance.bytes).toBeLessThan(each)
	})

	it('shows a booster’s emoji in the boost label, through the page’s allowance', async () => {
		const booster = account({
			id: '3',
			username: 'carol',
			acct: 'carol',
			display_name: 'Carol :a:',
			emojis: [emoji('a', URL_A)],
		})
		const original = status('9', { content: '<p>:a:</p>', emojis: [emoji('a', URL_A)] })
		const page = await render(
			jsx(ProfilePage, {
				account: booster,
				tab: { kind: 'posts' },
				pins: [],
				statuses: [status('10', { account: booster, content: '', reblog: original })],
				stub: null,
				parents: {},
				cursor: null,
				paging: { newest: '10', oldest: '10', more: false },
				site: SITE,
				actorUri: booster.uri,
			})
		)
		const label = one(parseHtml(page), 'p', 'label')
		expect(text(label)).toBe('Carol boosted')
		expect(query(label, 'img').map((img) => [attr(img, 'class'), attr(img, 'alt'), attr(img, 'src')])).toEqual([
			['emoji', ':a:', URL_A],
		])
	})

	it('leaves a booster’s emoji as text once the profile card spent the page’s allowance', async () => {
		const many = `:a:`.repeat(EMOJI_FIELD_IMAGES)
		const author = account({
			display_name: many,
			note: `<p>${many}</p>`,
			fields: Array.from({ length: 6 }, (_, i) => ({ name: `${i}${many}`, value: '', verified_at: null })),
			emojis: [emoji('a', URL_A)],
		})
		const original = status('9', { account: account({ id: '4', username: 'dan', acct: 'dan' }) })
		const page = await render(
			jsx(ProfilePage, {
				account: author,
				tab: { kind: 'posts' },
				pins: [],
				statuses: [status('10', { account: author, content: '', reblog: original })],
				stub: null,
				parents: {},
				cursor: null,
				paging: { newest: '10', oldest: '10', more: false },
				site: SITE,
				actorUri: author.uri,
			})
		)
		const doc = parseHtml(page)
		// The card took all 512 (name, bio and six field names, 64 each); the label's reference stays text.
		expect(query(one(doc, 'section', 'profile'), 'img').filter((img) => attr(img, 'class') === 'emoji')).toHaveLength(
			EMOJI_PAGE_IMAGES
		)
		const label = one(doc, 'p', 'label')
		expect(query(label, 'img')).toEqual([])
		expect(text(label)).toBe(`${many} boosted`)
	})

	it('goes to the profile card before the posts on a page', async () => {
		const many = `:a:`.repeat(EMOJI_FIELD_IMAGES)
		const author = account({
			display_name: many,
			note: `<p>${many}</p>`,
			fields: Array.from({ length: 6 }, (_, i) => ({ name: `${i}${many}`, value: many, verified_at: null })),
			emojis: [emoji('a', URL_A)],
		})
		const page = await render(
			jsx(ProfilePage, {
				account: author,
				tab: { kind: 'posts' },
				pins: [],
				statuses: [status('2', { account: author, content: `<p>${many}</p>`, emojis: [emoji('a', URL_A)] })],
				stub: null,
				parents: {},
				cursor: null,
				paging: { newest: '2', oldest: '2', more: false },
				site: SITE,
				actorUri: author.uri,
			})
		)
		const doc = parseHtml(page)
		const images = query(doc, 'img').filter((img) => attr(img, 'class') === 'emoji')
		expect(images).toHaveLength(EMOJI_PAGE_IMAGES)
		// The card's name, bio and six fields' names took them all (8 × 64); the post shows its references as text.
		const card = one(doc, 'section', 'profile')
		expect(query(card, 'img').filter((img) => attr(img, 'class') === 'emoji')).toHaveLength(EMOJI_PAGE_IMAGES)
		expect(text(one(one(doc, 'article'), 'div', 'body'))).toBe(many)
	})
})
