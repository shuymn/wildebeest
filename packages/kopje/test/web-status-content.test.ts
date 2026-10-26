import { jsx } from 'hono/jsx'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { acceptQuote } from './budget-helpers'
import { pathOf } from './media-helpers'
import { community, post, seedStatus } from './status-helpers'
import { attr, classes, elements, one, parseHtml, query, text } from './web-dom'
import { account, media, ORIGIN, poll, render, SITE, status } from './web-fixtures'
import type { MediaAttachment, Status } from '../src/domain/status-presenter'
import { EmbedPage } from '../src/web/pages/embed'
import { ProfilePage } from '../src/web/pages/profile'
import { StatusPage } from '../src/web/pages/status'
import { TagPage } from '../src/web/pages/tag'

// A status's content on the public pages (design §11 "Media by type", Poll, Quote; §13 "Images and media";
// amendments A3 and A7; POLL-2; R35 for the anonymous viewer).

const statusPage = (focal: Status) => render(jsx(StatusPage, { status: focal, parent: null, site: SITE }))

const feedPage = (statuses: Status[]) =>
	render(
		jsx(TagPage, {
			tag: 'walks',
			statuses,
			stub: null,
			parents: {},
			cursor: null,
			paging: { newest: null, oldest: null, more: false },
			site: SITE,
		})
	)

const occurrences = (html: string, needle: string) => html.split(needle).length - 1

describe('media by type (design §11, amendments A3 and A7)', () => {
	const noPreview = (id: string, type: string, fields: Partial<MediaAttachment> = {}) =>
		media(id, { type, url: `${ORIGIN}/media/${id}/full.bin`, preview_url: `${ORIGIN}/media/${id}/full.bin`, ...fields })

	it('plays video, gifv and audio inline, loading nothing before play, with a poster only from a real preview', async () => {
		const page = await feedPage([
			status('1', {
				media_attachments: [
					media('11', { type: 'video', url: `${ORIGIN}/media/11/full.mp4` }),
					// No preview (the presenter stands the url in) and no small size: no poster, the 16/9 box.
					noPreview('12', 'video', { meta: null, description: null }),
					media('13', { type: 'gifv', url: `${ORIGIN}/media/13/full.mp4` }),
					noPreview('14', 'gifv'),
				],
			}),
			status('2', { media_attachments: [noPreview('21', 'audio'), media('22', { type: 'audio' })] }),
		])
		const doc = parseHtml(page)
		const videos = query(doc, 'video')
		expect(
			videos.map((video) => ({
				src: attr(video, 'src'),
				poster: attr(video, 'poster'),
				box: classes(video).includes('box'),
				size: [attr(video, 'width'), attr(video, 'height')],
				muted: attr(video, 'muted') !== null,
				loop: attr(video, 'loop') !== null,
				name: attr(video, 'aria-label'),
			}))
		).toEqual([
			{
				src: `${ORIGIN}/media/11/full.mp4`,
				poster: `${ORIGIN}/media/11/small.png`,
				box: false,
				size: ['640', '360'],
				muted: false,
				loop: false,
				name: 'Attachment 11',
			},
			{
				src: `${ORIGIN}/media/12/full.bin`,
				poster: null,
				box: true,
				size: [null, null],
				muted: false,
				loop: false,
				name: null,
			},
			{
				src: `${ORIGIN}/media/13/full.mp4`,
				poster: `${ORIGIN}/media/13/small.png`,
				box: false,
				size: ['640', '360'],
				muted: true,
				loop: true,
				name: 'Attachment 13',
			},
			{
				src: `${ORIGIN}/media/14/full.bin`,
				poster: null,
				box: false,
				size: ['640', '360'],
				muted: true,
				loop: true,
				name: 'Attachment 14',
			},
		])
		const audios = query(doc, 'audio')
		expect(audios.map((audio) => [attr(audio, 'src'), attr(audio, 'aria-label')])).toEqual([
			[`${ORIGIN}/media/21/full.bin`, 'Attachment 21'],
			[`${ORIGIN}/media/22/full.png`, 'Attachment 22'],
		])
		for (const player of [...videos, ...audios]) {
			expect(attr(player, 'preload')).toBe('none')
			expect(attr(player, 'controls')).not.toBeNull()
			expect(attr(player, 'autoplay')).toBeNull()
			expect(attr(player, 'loading')).toBeNull()
		}
		expect(videos.every((video) => attr(video, 'playsinline') !== null)).toBe(true)
		// A3: a file without its own preview is named once, as the player's source, never as an image or a poster.
		for (const id of ['12', '14', '21']) {
			expect(occurrences(page, `${ORIGIN}/media/${id}/full.bin`), id).toBe(1)
		}
		// The video without a description is marked visibly, as an image is.
		expect(text(query(doc, 'div', 'media-item')[1]!)).toBe('No description')
		// No image is the page's high-priority request on a feed.
		expect(page).not.toContain('fetchpriority')
	})

	it('shows an attachment of another type as a link, and nothing of a URL that is not http(s)', async () => {
		const page = await statusPage(
			status('1', {
				media_attachments: [
					media('31', { type: 'unknown', url: 'https://files.example/doc.pdf', description: null }),
					media('32', { type: '<script>alert(1)</script>', url: `${ORIGIN}/media/32/x.bin`, preview_url: null }),
					media('33', { url: 'javascript:alert(1)', preview_url: 'javascript:alert(2)' }),
					media('34', { type: 'video', url: 'data:video/mp4;base64,AAAA', preview_url: null }),
					media('35', { type: 'video', url: `${ORIGIN}/media/35/full.mp4`, preview_url: 'javascript:alert(3)' }),
				],
			})
		)
		const doc = parseHtml(page)
		const links = query(doc, 'a').filter((a) => classes(a).includes('media-file'))
		expect(links.map((a) => [attr(a, 'href'), attr(a, 'rel'), text(a)])).toEqual([
			['https://files.example/doc.pdf', 'nofollow noopener', 'Attachment'],
			['/media/32/x.bin', null, 'Attachment 32'],
		])
		expect(query(doc, 'video').map((video) => [attr(video, 'src'), attr(video, 'poster')])).toEqual([
			[`${ORIGIN}/media/35/full.mp4`, null],
		])
		for (const absent of ['javascript:', 'data:video', '<script>alert', 'alert(1)']) {
			expect(page).not.toContain(absent)
		}
	})

	it('loads the focal post’s first visible attachment first: an image itself, a video’s real poster by preload', async () => {
		const priority = (html: string) => {
			const doc = parseHtml(html)
			return {
				preloads: query(doc, 'link')
					.filter((link) => attr(link, 'rel') === 'preload')
					.map((link) => [attr(link, 'as'), attr(link, 'href'), attr(link, 'fetchpriority')]),
				high: elements(doc)
					.filter((e) => attr(e, 'fetchpriority') === 'high')
					.map((e) => e.tagName),
				lazyPlayers: query(doc, 'video').filter((video) => attr(video, 'loading') !== null).length,
			}
		}
		const poster = `${ORIGIN}/media/41/small.png`
		expect(priority(await statusPage(status('1', { media_attachments: [media('41', { type: 'video' })] })))).toEqual({
			preloads: [['image', poster, 'high']],
			high: ['link'],
			lazyPlayers: 0,
		})
		expect(priority(await statusPage(status('1', { media_attachments: [media('42', { type: 'gifv' })] })))).toEqual({
			preloads: [['image', `${ORIGIN}/media/42/small.png`, 'high']],
			high: ['link'],
			lazyPlayers: 0,
		})
		// Without a real thumbnail (A3) nothing is preloaded, and nothing else takes its place.
		const bare = media('43', { type: 'video', preview_url: `${ORIGIN}/media/43/full.png` })
		expect(priority(await statusPage(status('1', { media_attachments: [bare] })))).toEqual({
			preloads: [],
			high: [],
			lazyPlayers: 0,
		})
		expect(priority(await statusPage(status('1', { media_attachments: [media('44')] })))).toEqual({
			preloads: [],
			high: ['img'],
			lazyPlayers: 0,
		})
		// Covered by a warning or marked sensitive, or not first: nothing is loaded first.
		for (const covered of [
			status('1', { spoiler_text: 'careful', media_attachments: [media('45', { type: 'video' })] }),
			status('1', { sensitive: true, media_attachments: [media('46', { type: 'video' })] }),
			status('1', { media_attachments: [media('47', { type: 'audio' }), media('48', { type: 'video' })] }),
		]) {
			expect(priority(await statusPage(covered))).toEqual({ preloads: [], high: [], lazyPlayers: 0 })
		}
		// The embed and the feeds load nothing first.
		const embed = await render(
			jsx(EmbedPage, { status: status('1', { media_attachments: [media('49')] }), domain: 'kopje.test' })
		)
		expect(embed).not.toContain('fetchpriority')
	})
})

describe('polls (design §11, POLL-2)', () => {
	const options = (html: string) =>
		query(one(parseHtml(html), 'ul', 'opts'), 'li').map((li) => ({
			text: text(li),
			bar: query(li, 'rect').map((rect) => [attr(rect, 'width'), classes(rect).includes('lead')])[0] ?? null,
		}))
	const footer = (html: string) => text(one(one(parseHtml(html), 'div', 'poll'), 'p', 'meta'))

	it('shows each choice’s share as text and as an SVG bar, with the turnout and the end', async () => {
		const open = await statusPage(status('1', { poll: poll() }))
		expect(options(open)).toEqual([
			{ text: 'Yes70%', bar: ['70%', true] },
			{ text: 'No30%', bar: ['30%', false] },
		])
		expect(footer(open)).toBe('10 people · Ends Oct 30, 2026, 00:00 UTC')
		const time = one(one(parseHtml(open), 'div', 'poll'), 'time')
		expect([attr(time, 'datetime'), attr(time, 'data-local')]).toEqual(['2026-10-30T00:00:00.000Z', ''])
		// The bars are decorative SVG, sized by their attributes (no inline style, §6.8).
		for (const svg of query(one(parseHtml(open), 'ul', 'opts'), 'svg')) {
			expect([attr(svg, 'aria-hidden'), attr(svg, 'focusable'), attr(svg, 'style')]).toEqual(['true', 'false', null])
		}
		const closed = await statusPage(status('1', { poll: poll({ expired: true, voters_count: null, votes_count: 1 }) }))
		expect(footer(closed)).toBe('1 vote · Closed')
	})

	it('divides a multiple-choice poll by its voters, and shows nothing counted as 0%', async () => {
		const multiple = poll({
			multiple: true,
			votes_count: 9,
			voters_count: 6,
			options: [
				{ title: 'A', votes_count: 6 },
				{ title: 'B', votes_count: 3 },
				{ title: 'C', votes_count: 0 },
			],
		})
		expect(options(await statusPage(status('1', { poll: multiple })))).toEqual([
			{ text: 'A100%', bar: ['100%', true] },
			{ text: 'B50%', bar: ['50%', false] },
			{ text: 'C0%', bar: ['0%', false] },
		])
		// A choice whose count is hidden hides every share (the presenter hides all or none, POLL-2).
		const partial = poll({
			options: [
				{ title: 'A', votes_count: 3 },
				{ title: 'B', votes_count: null },
			],
		})
		expect(options(await statusPage(status('1', { poll: partial })))).toEqual([
			{ text: 'A', bar: null },
			{ text: 'B', bar: null },
		])
		const none = poll({ votes_count: 0, voters_count: 0, options: [{ title: 'A', votes_count: 0 }] })
		expect(options(await statusPage(status('1', { poll: none })))).toEqual([{ text: 'A0%', bar: ['0%', false] }])
	})

	it('holds every choice’s count until a hide_totals poll ends, and then shows them (whole page)', async () => {
		const h = await community(['alice'])
		const polled = await post(h, h.users.alice, {
			status: 'which?',
			poll: { options: ['left', 'right'], expires_in: 600, hide_totals: true },
		})
		await sql(
			h.store,
			'UPDATE polls SET tallies = ?, votes_count = 1000, voters_count = 1000 WHERE status_id = ?',
			JSON.stringify([777, 223]),
			String(polled.id)
		)
		const path = pathOf(String(polled.url))
		const pages = async () => ({
			status: await (await h.request(path)).text(),
			profile: await (await h.request('/@alice')).text(),
			embed: await (await h.request(`${path}/embed`)).text(),
		})
		for (const [name, html] of Object.entries(await pages())) {
			// The choices are shown (so the poll was rendered), but no count or share of any of them.
			expect(text(one(parseHtml(html), 'ul', 'opts')), name).toBe('leftright')
			for (const absent of ['777', '223', '78%', '22%', '<rect']) {
				expect(html, `${name} ${absent}`).not.toContain(absent)
			}
		}
		h.now.mockReturnValue(NOW + 601_000)
		for (const [name, html] of Object.entries(await pages())) {
			expect(text(one(parseHtml(html), 'ul', 'opts')), name).toBe('left78%right22%')
			expect(footer(html), name).toBe('1,000 people · Closed')
		}
	})
})

describe('quotes (design §11, R35)', () => {
	it('nests an accepted quote and shows any other state as text', async () => {
		const quoted = status('9', {
			account: account({
				id: '2',
				username: 'bob',
				acct: 'bob@remote.example',
				display_name: 'Bob',
				url: 'https://remote.example/@bob',
			}),
			url: 'https://remote.example/@bob/9',
			content: '<p>The quoted words.</p>',
			poll: poll(),
			media_attachments: [media('91')],
			quote: { state: 'accepted', quoted_status_id: '8' },
		})
		const page = await statusPage(
			status('1', {
				content: '<p>Quoting. <span class="quote-inline">RE: link</span></p>',
				quote: { state: 'accepted', quoted_status: quoted },
			})
		)
		const doc = parseHtml(page)
		const nested = one(doc, 'div', 'quote')
		expect(text(one(nested, 'a', 'name'))).toBe('Bob')
		expect(text(one(nested, 'div', 'body'))).toBe('The quoted words.')
		expect(query(nested, 'ul', 'opts')).toHaveLength(1)
		expect(query(nested, 'img').map((img) => attr(img, 'loading'))).toContain('lazy')
		// The quoted post links to its origin, and shows no quote of its own.
		expect(attr(query(query(nested, 'p', 'meta')[0]!, 'a')[0]!, 'href')).toBe('https://remote.example/@bob/9')
		expect(query(nested, 'div', 'quote')).toHaveLength(0)
		expect(query(nested, 'p', 'gone')).toHaveLength(0)
		// The quoting post's fallback line is kept in its content, for the stylesheet to hide.
		expect(classes(query(doc, 'div', 'body')[0]!)).toEqual(['body', 'quoting'])

		const states: [Status['quote'], string][] = [
			[{ state: 'pending', quoted_status: null }, "The quoted post is waiting for its author's approval."],
			[{ state: 'rejected', quoted_status: null }, 'The author of the quoted post removed it from this quote.'],
			[{ state: 'revoked', quoted_status: null }, 'The author of the quoted post removed it from this quote.'],
			[{ state: 'deleted', quoted_status: null }, 'The quoted post is not available.'],
			[{ state: 'unauthorized', quoted_status: null }, 'The quoted post is not available.'],
			[{ state: 'accepted', quoted_status: null }, 'The quoted post is not available.'],
		]
		for (const [quote, message] of states) {
			const html = await statusPage(status('1', { quote }))
			expect(text(one(parseHtml(html), 'p', 'gone')), quote?.state).toBe(message)
			expect(query(parseHtml(html), 'div', 'quote'), quote?.state).toHaveLength(0)
		}
	})

	it('never shows a post the anonymous viewer may not see, on the status page, the profile or the embed', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const shown = await post(h, bob, { status: 'a public word' })
		const hidden = await post(h, bob, { status: 'a private word', visibility: 'private' })
		const later = await post(h, bob, { status: 'a word awaiting approval' })
		const gone = await seedStatus(h.store, {
			accountId: bob.id,
			visibility: 'public',
			content: '<p>a deleted word</p>',
		})
		const quoting = async (target: string, state: string) => {
			const quote = await post(h, alice, { status: `quoting ${state}` })
			await acceptQuote(h, String(quote.id), target)
			await sql(h.store, 'UPDATE quotes SET state = ? WHERE status_id = ?', state, String(quote.id))
			return pathOf(String(quote.url))
		}
		const pages: [string, string][] = [
			[await quoting(String(shown.id), 'accepted'), 'nested'],
			[await quoting(String(hidden.id), 'accepted'), 'The quoted post is not available.'],
			[await quoting(String(later.id), 'pending'), "The quoted post is waiting for its author's approval."],
			[await quoting(String(shown.id), 'revoked'), 'The author of the quoted post removed it from this quote.'],
		]
		await sql(h.store, 'UPDATE statuses SET withdrawn = 1 WHERE id = ?', gone)
		pages.push([await quoting(gone, 'accepted'), 'The quoted post is not available.'])
		for (const [path, expected] of pages) {
			for (const shownAt of [path, `${path}/embed`]) {
				const html = await (await h.request(shownAt)).text()
				const doc = parseHtml(html)
				if (expected === 'nested') {
					expect(text(one(one(doc, 'div', 'quote'), 'div', 'body')), shownAt).toBe('a public word')
				} else {
					expect(text(one(doc, 'p', 'gone')), shownAt).toBe(expected)
				}
				for (const absent of [
					'a private word',
					'a word awaiting approval',
					'a deleted word',
					String(hidden.id),
					gone,
				]) {
					expect(html, `${shownAt} ${absent}`).not.toContain(absent)
				}
			}
		}
		// The profile lists the five quoting posts with the same states, and none of the hidden words.
		const profile = await (await h.request('/@alice')).text()
		expect(query(parseHtml(profile), 'div', 'quote')).toHaveLength(1)
		expect(query(parseHtml(profile), 'p', 'gone')).toHaveLength(4)
		for (const absent of ['a private word', 'a word awaiting approval', 'a deleted word']) {
			expect(profile).not.toContain(absent)
		}
	})
})

describe('the status content on every page that shows posts (design §17, PR 7)', () => {
	it('renders media, polls and quotes in the feeds, on the profile and in the embed', async () => {
		const rich = status('1', {
			media_attachments: [media('51', { type: 'video' })],
			poll: poll(),
			quote: { state: 'pending', quoted_status: null },
		})
		const pages = {
			tag: await feedPage([rich]),
			profile: await render(
				jsx(ProfilePage, {
					account: account(),
					tab: { kind: 'posts' },
					pins: [],
					statuses: [rich],
					stub: null,
					parents: {},
					cursor: null,
					paging: { newest: '1', oldest: '1', more: false },
					site: SITE,
					actorUri: `${ORIGIN}/users/alice`,
				})
			),
			embed: await render(jsx(EmbedPage, { status: rich, domain: 'kopje.test' })),
		}
		for (const [name, html] of Object.entries(pages)) {
			const doc = parseHtml(html)
			expect([
				name,
				query(doc, 'video').length,
				query(doc, 'ul', 'opts').length,
				query(doc, 'p', 'gone').length,
			]).toEqual([name, 1, 1, 1])
		}
	})
})
