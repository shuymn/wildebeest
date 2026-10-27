import { html as HTML } from 'parse5'
import { describe, expect, it } from 'vitest'

import { bearer, json, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { acceptQuote } from './budget-helpers'
import { PNG_PLAIN } from './fixtures/images'
import { bytes, mediaForm, pathOf, TestCodec, uploaded } from './media-helpers'
import { setupHarness, setupLogin } from './setup-helpers'
import { community, post, remoteAccount } from './status-helpers'
import {
	accessibleName,
	attr,
	byId,
	closest,
	type Document,
	type Element,
	elements,
	one,
	parseHtml,
	query,
	text,
} from './web-dom'
import { signIn } from './web-helpers'

// The structural accessibility contracts (design §14, "Enforced"), checked with parse5 over every page the web UI
// serves: the public pages, the embed, settings, a sign-in message and /setup, each in standards mode. Contrast is the
// stylesheet test's (test-node/stylesheet.test.ts); the rendered checks are the browser job's (§10.11). The
// inline-style ban (§6.8) is checked on the same pages.

type Page = { name: string; html: string; embed?: boolean }

// A role-less element whose aria-label no assistive technology announces (ARIA 1.2, "generic").
const GENERIC = new Set(['div', 'span', 'p', 'b', 'i', 'strong', 'em', 'small', 'code', 'pre'])
const FOCUSABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])
const UNLABELLED_INPUTS = new Set(['hidden', 'submit', 'button', 'reset'])
const TAB_ROLES = new Set(['tab', 'tablist', 'tabpanel'])

export function a11yProblems(html: string, { embed = false }: { embed?: boolean } = {}): string[] {
	const doc: Document = parseHtml(html)
	const problems: string[] = []
	const all = elements(doc)
	const body = all.find((e) => e.tagName === 'body')
	const inBody = body === undefined ? [] : elements(body)
	const describe = (e: Element) => `<${e.tagName}${attr(e, 'class') === null ? '' : `.${attr(e, 'class')}`}>`
	const count = (tag: string) => inBody.filter((e) => e.tagName === tag).length

	// A page without a doctype renders in quirks mode (HTML, "the DOCTYPE").
	if (doc.mode !== HTML.DOCUMENT_MODE.NO_QUIRKS) {
		problems.push(`the page renders in ${doc.mode} mode`)
	}
	if (
		!(
			attr(
				all.find((e) => e.tagName === 'html')!,
				'lang'
			) ?? ''
		).trim()
	) {
		problems.push('html has no lang')
	}
	// Landmarks, the skip link and headings; the embed has no landmarks and no h1.
	const headings = inBody.filter((e) => /^h[1-6]$/.test(e.tagName)).map((e) => Number(e.tagName[1]))
	if (embed) {
		for (const tag of ['header', 'main', 'footer', 'nav', 'h1']) {
			if (count(tag) > 0) {
				problems.push(`the embed has a ${tag}`)
			}
		}
	} else {
		for (const tag of ['header', 'main', 'footer']) {
			if (count(tag) !== 1) {
				problems.push(`${count(tag)} ${tag} elements`)
			}
		}
		const first = inBody.find((e) => FOCUSABLE.has(e.tagName) && attr(e, 'type') !== 'hidden')
		if (first === undefined || first.tagName !== 'a' || attr(first, 'href') !== '#content') {
			problems.push('the first focusable element is not the skip link to #content')
		}
		if (byId(doc, 'content')?.tagName !== 'main') {
			problems.push('#content is not the main element')
		}
		if (headings.filter((level) => level === 1).length !== 1) {
			problems.push(`${headings.filter((level) => level === 1).length} h1 elements`)
		}
	}
	headings.forEach((level, index) => {
		const before = index === 0 ? (embed ? level : 0) : headings[index - 1]!
		if (level > before + 1) {
			problems.push(`heading h${level} skips a level after h${before}`)
		}
	})

	const ids = new Map<string, number>()
	for (const e of all) {
		const id = attr(e, 'id')
		if (id !== null) {
			ids.set(id, (ids.get(id) ?? 0) + 1)
		}
	}
	for (const [id, n] of ids) {
		if (n > 1) {
			problems.push(`id ${id} is used ${n} times`)
		}
	}

	// The inline-style ban (§6.8) covers the whole document: the head, html and body included.
	for (const e of all) {
		if (attr(e, 'style') !== null) {
			problems.push(`${describe(e)} has a style attribute`)
		}
		if (e.tagName === 'style') {
			problems.push('a style element')
		}
	}

	for (const e of inBody) {
		const name = () => accessibleName(e, doc)
		if (/^h[1-6]$/.test(e.tagName) && name() === '') {
			problems.push(`${describe(e)} has no name`)
		}
		const role = attr(e, 'role')
		if (attr(e, 'title') !== null) {
			problems.push(`${describe(e)} is named by title`)
		}
		if (attr(e, 'aria-label') !== null && GENERIC.has(e.tagName) && role === null) {
			problems.push(`${describe(e)} is generic and has an aria-label`)
		}
		for (const ref of ['aria-labelledby', 'aria-describedby']) {
			for (const id of (attr(e, ref) ?? '').split(/\s+/).filter((part) => part !== '')) {
				if (!ids.has(id)) {
					problems.push(`${describe(e)} ${ref} names no element: ${id}`)
				}
			}
		}
		const current = attr(e, 'aria-current')
		if (current !== null && (e.tagName !== 'a' || current !== 'page')) {
			problems.push(`${describe(e)} has aria-current="${current}"`)
		}
		if (role !== null && TAB_ROLES.has(role)) {
			problems.push(`${describe(e)} has the role ${role}`)
		}
		if (attr(e, 'autofocus') !== null && closest(e, (a) => a.tagName === 'dialog') === null) {
			problems.push(`${describe(e)} has autofocus outside a dialog`)
		}
		if (Number(attr(e, 'tabindex') ?? '0') > 0) {
			problems.push(`${describe(e)} has a positive tabindex`)
		}
		switch (e.tagName) {
			case 'a':
				if (attr(e, 'href') === null) {
					problems.push('a link without href')
				} else if (name() === '') {
					problems.push(`a link to ${attr(e, 'href')} has no name`)
				}
				break
			case 'button':
				if (!['submit', 'button', 'reset'].includes(attr(e, 'type') ?? '')) {
					problems.push(`a button without an explicit type: ${name()}`)
				}
				if (name() === '') {
					problems.push('a button has no name')
				}
				break
			case 'summary':
				if (name() === '') {
					problems.push('a summary has no name')
				}
				break
			case 'details': {
				const first = e.childNodes.find((child): child is Element => 'tagName' in child)
				if (first?.tagName !== 'summary') {
					problems.push('a details without a summary first')
				}
				break
			}
			case 'nav':
				if (name() === '' || (attr(e, 'aria-label') === null && attr(e, 'aria-labelledby') === null)) {
					problems.push('a nav without a name')
				}
				break
			case 'dialog':
				if (attr(e, 'aria-labelledby') === null && attr(e, 'aria-label') === null) {
					problems.push('a dialog without a name')
				}
				break
			case 'img':
				if (attr(e, 'alt') === null) {
					problems.push(`an img without alt: ${attr(e, 'src')}`)
				}
				break
			case 'svg': {
				const labelled = role === 'img' && (attr(e, 'aria-label') ?? '').trim() !== ''
				const decorative = attr(e, 'aria-hidden') === 'true' && attr(e, 'focusable') === 'false'
				if (labelled === decorative) {
					problems.push('an svg that is neither a labelled image nor decorative')
				}
				break
			}
			case 'input':
			case 'select':
			case 'textarea':
				if (!UNLABELLED_INPUTS.has(attr(e, 'type') ?? '') && name() === '') {
					problems.push(`${describe(e)} ${attr(e, 'name')} has no label`)
				}
				break
		}
	}
	return problems
}

async function publicPages(): Promise<{ pages: Page[]; h: Awaited<ReturnType<typeof community>> }> {
	const codec = new TestCodec()
	const h = await community(['alice', 'bob', 'carol'], 'read write follow', { images: () => codec })
	const { alice, bob, carol } = h.users
	await h.request(
		'/api/v1/accounts/update_credentials',
		bearer(alice.token, {
			...json({
				display_name: 'Alice',
				note: 'Curiouser and curiouser, <a href="https://example.com/">a link</a>',
				fields_attributes: [
					{ name: 'Site', value: 'https://alice.example/' },
					{ name: 'Mood', value: 'curious' },
				],
			}),
			method: 'PATCH',
		})
	)
	const described = await uploaded(
		h,
		alice,
		mediaForm(bytes(PNG_PLAIN), { description: 'a square' }, 'a.png', 'image/png')
	)
	const bare = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), {}, 'b.png', 'image/png'))
	const parent = await post(h, alice, { status: 'the parent', media_ids: [described.id] })
	const reply = await post(h, alice, {
		status: 'the reply',
		spoiler_text: 'careful',
		in_reply_to_id: parent.id,
		media_ids: [bare.id],
		sensitive: true,
	})
	await h.request('/api/v1/featured_tags', bearer(alice.token, json({ name: 'cats' })))
	const tagged = await post(h, alice, { status: '#cats here' })
	// A pin and a boost, so the profile shows both labels.
	await h.request(`/api/v1/statuses/${String(tagged.id)}/pin`, bearer(alice.token, { method: 'POST' }))
	await h.request(`/api/v1/statuses/${String(parent.id)}/reblog`, bearer(alice.token, { method: 'POST' }))
	await post(h, bob, { status: 'bob speaks' })
	// A post with an emoji, a poll, a quote of the parent and media of every other type (design §11, PR 7).
	const rich = await post(h, alice, {
		status: 'which :blob: one?',
		poll: { options: ['the first :blob:', 'the second'], expires_in: 600 },
	})
	await sql(
		h.store,
		'UPDATE statuses SET emojis = ? WHERE id = ?',
		JSON.stringify([['blob', 'https://kopje.test/assets/avatar.png']]),
		String(rich.id)
	)
	await acceptQuote(h, String(rich.id), String(parent.id))
	for (const [i, type] of ['video', 'gifv', 'audio', 'unknown'].entries()) {
		await sql(
			h.store,
			`INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			`90000000000000000${i}`,
			alice.id,
			String(rich.id),
			i,
			type,
			`https://kopje.test/media/${i}/full.bin`,
			i === 0 ? 'https://kopje.test/media/0/small.png' : null,
			i === 2 ? '' : `a ${type}`
		)
	}
	// A post edited twice, the first version behind a warning: its page holds the history dialog (design §8).
	const edited = await post(h, alice, { status: 'first words', spoiler_text: 'a warning' })
	for (const status of ['second words', 'last words']) {
		await h.request(`/api/v1/statuses/${String(edited.id)}`, bearer(alice.token, json({ status }, { method: 'PUT' })))
	}
	// Followers of alice: a remote account, carol, and bob (suspended below, so left out); carol hides her network.
	const dan = await remoteAccount(h.store, 'dan')
	for (const follower of [dan, carol.id, bob.id]) {
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			follower,
			alice.id
		)
	}
	await sql(h.store, 'UPDATE local_accounts SET hide_collections = 1 WHERE account_id = ?', carol.id)
	// alice endorses dan, whom she follows: the Featured tab lists him beside her featured hashtag.
	await sql(
		h.store,
		"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
		alice.id,
		dan
	)
	await sql(h.store, 'INSERT INTO account_pins (account_id, target_account_id) VALUES (?, ?)', alice.id, dan)
	await sql(
		h.store,
		'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
		new Date(NOW).toISOString(),
		bob.id
	)
	await setSetting(h.store, 'description', 'A small server.')
	await setSetting(h.store, 'contact_email', 'admin@kopje.test')
	await setSetting(h.store, 'extended_description', '<p>One person runs it.</p>')
	await setSetting(h.store, 'rules', JSON.stringify(['Be kind', { text: 'No spam', hint: 'None at all' }]))
	await setSetting(h.store, 'privacy_policy', '<h2>Data</h2><p>Little.</p>')
	await setSetting(h.store, 'privacy_policy_updated_at', '2026-10-01T12:30:00.000Z')
	await setSetting(h.store, 'terms_of_service', '<p>Terms.</p>')
	await setSetting(h.store, 'terms_of_service_effective_date', '2026-11-01')
	const pages: Page[] = []
	const add = async (name: string, status: number, request: string, init?: RequestInit, embed = false) => {
		const response = await h.request(request, init)
		expect(response.status, name).toBe(status)
		pages.push({ name, html: await response.text(), embed })
	}
	await add('profile', 200, '/@alice')
	await add('tagged', 200, '/@alice/tagged/cats')
	await add('posts and replies', 200, '/@alice/with_replies')
	await add('media', 200, '/@alice/media')
	await add('older posts', 200, `/@alice?max_id=${String(parent.id)}`)
	await add('followers', 200, '/@alice/followers')
	await add('hidden follows', 200, '/@carol/following')
	await add('featured', 200, '/@alice/featured')
	await add('featured, empty', 200, '/@carol/featured')
	await add('hashtag', 200, '/tags/cats')
	await add('hashtag, older posts', 200, `/tags/cats?max_id=${String(tagged.id)}`)
	await add('status with media', 200, pathOf(String(parent.url)))
	await add('status, a page of its replies', 200, `${pathOf(String(parent.url))}?min_id=${String(reply.id)}`)
	await add('status with a poll, a quote and media', 200, pathOf(String(rich.url)))
	await add('reply with a warning and sensitive media', 200, pathOf(String(reply.url)))
	await add('edited status with its history', 200, pathOf(String(edited.url)))
	await add('about', 200, '/about')
	await add('privacy policy', 200, '/privacy-policy')
	await add('terms of service', 200, '/terms-of-service')
	await add('404', 404, '/@nobody')
	await add('410', 410, '/@bob')
	await add('embed', 200, `${pathOf(String(reply.url))}/embed`, undefined, true)
	// The handoff pages (design §8): the form, the form refusing a server, and the link to one.
	await add('follow handoff form', 200, '/@alice/interact')
	await add('follow handoff refused', 400, '/@alice/interact?server=192.0.2.1')
	await add('status handoff', 200, `${pathOf(String(parent.url))}/interact?server=social.example`)
	const browser = await signIn(h)
	await add('settings', 200, '/settings', { headers: { cookie: browser.cookie } })
	await add('interaction', 200, `/authorize_interaction?uri=${encodeURIComponent(String(parent.uri))}`, {
		headers: { cookie: browser.cookie },
	})
	// What a look-up of a stored status finds (nothing is fetched for a local URI), with the follow form.
	const csrf = /name="csrf" value="([^"]+)"/.exec(pages.at(-1)!.html)?.[1] ?? ''
	await add('interaction result', 200, '/authorize_interaction', {
		method: 'POST',
		headers: {
			cookie: browser.cookie,
			origin: 'https://kopje.test',
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({ uri: String(parent.uri), csrf }).toString(),
	})
	await add('sign-in message', 400, '/auth/callback')
	return { pages, h }
}

describe('accessibility contracts (design §14)', () => {
	it('hold on every page the web UI serves', async () => {
		const { pages } = await publicPages()
		const setup = await setupHarness()
		const browser = await setupLogin(setup)
		for (const [name, path, cookie] of [
			['setup sign-in', '/setup', ''],
			['setup wizard', '/setup', browser.cookie],
			['setup checklist', '/setup/checklist', ''],
		] as const) {
			const response = await setup.request(path, { headers: { cookie } })
			expect(response.status, name).toBe(200)
			pages.push({ name, html: await response.text() })
		}
		expect(pages).toHaveLength(32)
		// The pages hold what the contracts are about: forms, media, a content warning, a pager-free feed.
		const controls = (name: string) =>
			['input', 'select', 'textarea'].flatMap((tag) => query(parseHtml(pages.find((p) => p.name === name)!.html), tag))
		expect(controls('settings').length).toBeGreaterThan(10)
		expect(controls('interaction').length).toBeGreaterThan(1)
		expect(controls('interaction result').length).toBeGreaterThan(2)
		expect(controls('follow handoff refused')).toHaveLength(1)
		expect(controls('setup sign-in').length).toBeGreaterThan(0)
		expect(controls('setup wizard').length).toBeGreaterThan(5)
		// The profile holds the tabs, a pinned post and a boost, each under its label.
		const profile = parseHtml(pages.find((p) => p.name === 'profile')!.html)
		expect(query(profile, 'p', 'label').map(text)).toEqual(['Pinned', 'Alice boosted'])
		expect(query(profile, 'nav', 'tabs')).toHaveLength(1)
		// The followers page lists its two available members, each row an account's name linked.
		const followers = parseHtml(pages.find((p) => p.name === 'followers')!.html)
		expect(query(followers, 'ul', 'accounts').flatMap((list) => query(list, 'li'))).toHaveLength(2)
		// The post with an emoji, a poll, a quote and players: each of them, so the contracts cover them.
		const rich = parseHtml(pages.find((p) => p.name === 'status with a poll, a quote and media')!.html)
		expect(query(rich, 'img').filter((img) => attr(img, 'class') === 'emoji')).toHaveLength(2)
		expect(query(rich, 'ul', 'opts')).toHaveLength(1)
		expect(query(rich, 'div', 'quote')).toHaveLength(1)
		expect([query(rich, 'video').length, query(rich, 'audio').length, query(rich, 'a', 'media-file').length]).toEqual([
			2, 1, 1,
		])
		// A reply's page holds its thread (its parent above it), and its parent's page its tab, its reply and, at a
		// cursor past them, only its pager.
		const reply = parseHtml(pages.find((p) => p.name === 'reply with a warning and sensitive media')!.html)
		expect(query(one(reply, 'ol', 'thread'), 'article')).toHaveLength(1)
		const thread = parseHtml(pages.find((p) => p.name === 'status with media')!.html)
		expect(query(thread, 'nav', 'tabs')).toHaveLength(1)
		expect(query(one(thread, 'ul', 'feed'), 'article').length).toBeGreaterThan(0)
		const later = parseHtml(pages.find((p) => p.name === 'status, a page of its replies')!.html)
		expect([query(later, 'ul', 'feed').length, query(later, 'nav', 'pager').length]).toEqual([0, 1])
		// The Featured tab lists its hashtag and its endorsed account; the empty one only its headings and empty lines.
		const featured = parseHtml(pages.find((p) => p.name === 'featured')!.html)
		expect(query(featured, 'ul', 'hashtags').flatMap((list) => query(list, 'li'))).toHaveLength(1)
		expect(query(featured, 'ul', 'accounts').flatMap((list) => query(list, 'li'))).toHaveLength(1)
		expect(query(parseHtml(pages.find((p) => p.name === 'featured, empty')!.html), 'p', 'empty')).toHaveLength(2)
		// The edited post's page holds its history dialog, its opener and its three versions, the oldest behind its
		// warning, beside the dialogs to open it on another server and to embed it, each with its opener.
		const history = parseHtml(pages.find((p) => p.name === 'edited status with its history')!.html)
		expect(query(history, 'dialog').map((d) => attr(d, 'id'))).toEqual(['history', 'interact', 'embed'])
		expect(query(history, 'button').filter((b) => attr(b, 'command') === 'show-modal')).toHaveLength(3)
		expect(query(history, 'ol', 'versions').flatMap((list) => query(list, 'li'))).toHaveLength(3)
		expect(query(history, 'dialog').flatMap((dialog) => query(dialog, 'details', 'cw'))).toHaveLength(1)
		// The hashtag page holds its post, and its older page only its pager.
		expect(query(parseHtml(pages.find((p) => p.name === 'hashtag')!.html), 'article')).toHaveLength(1)
		expect(query(parseHtml(pages.find((p) => p.name === 'hashtag, older posts')!.html), 'nav', 'pager')).toHaveLength(1)
		for (const page of pages) {
			expect(a11yProblems(page.html, { embed: page.embed }), page.name).toEqual([])
			const doc = parseHtml(page.html)
			// Styled lists keep their list semantics (list-style: none drops them in WebKit), and main takes the skip
			// link's focus (amendment A7).
			for (const list of elements(doc).filter((e) => ['ul', 'ol'].includes(e.tagName))) {
				const styled = (attr(list, 'class') ?? '')
					.split(' ')
					.some((c) => ['feed', 'stats', 'rules', 'apps', 'accounts', 'versions'].includes(c))
				if (styled) {
					expect(attr(list, 'role'), `${page.name} ${attr(list, 'class')}`).toBe('list')
				}
			}
			if (page.embed !== true) {
				expect(attr(query(doc, 'main')[0]!, 'tabindex'), page.name).toBe('-1')
			}
		}
	}, 60_000)

	it('give media their descriptions as alt, and mark a missing one visibly', async () => {
		const { pages } = await publicPages()
		const images = (name: string) =>
			query(one(parseHtml(pages.find((page) => page.name === name)!.html), 'article', 'focal'), 'a')
				.filter((a) => attr(a, 'class') === 'media-item')
				.map((a) => ({ alt: attr(query(a, 'img')[0]!, 'alt'), name: accessibleName(a, parseHtml('')) }))
		expect(images('status with media')).toEqual([{ alt: 'a square', name: 'a square' }])
		expect(images('reply with a warning and sensitive media')).toEqual([{ alt: '', name: 'No description' }])
		// Video and audio are named by their descriptions (§14.7); one without shows the marker beside its player.
		const rich = parseHtml(pages.find((page) => page.name === 'status with a poll, a quote and media')!.html)
		expect(
			query(rich, 'div', 'media-item').map((item) => ({
				player: query(item, 'video').length + query(item, 'audio').length,
				name: attr([...query(item, 'video'), ...query(item, 'audio')][0]!, 'aria-label'),
				marker: text(item),
			}))
		).toEqual([
			{ player: 1, name: 'a video', marker: '' },
			{ player: 1, name: 'a gifv', marker: '' },
			{ player: 1, name: null, marker: 'No description' },
		])
	}, 60_000)

	it('are checked by a checker that flags what it must', () => {
		const page = (main: string, extra = '') =>
			`<!doctype html><html lang="en"><head><title>t</title></head><body><a href="#content">Skip</a><header></header>` +
			`<main id="content"><h1>Title</h1>${main}</main><footer></footer>${extra}</body></html>`
		expect(a11yProblems(page(''))).toEqual([])
		const cases: [string, string][] = [
			['<h3>x</h3>', 'heading h3 skips a level after h1'],
			['<h1>again</h1>', '2 h1 elements'],
			['<div aria-label="x">x</div>', '<div> is generic and has an aria-label'],
			['<a>x</a>', 'a link without href'],
			['<a href="/x"><svg aria-hidden="true" focusable="false"></svg></a>', 'a link to /x has no name'],
			['<button>Go</button>', 'a button without an explicit type: Go'],
			['<input type="text" name="q">', '<input> q has no label'],
			['<input type="file" name="file">', '<input> file has no label'],
			['<p style="color:red">x</p>', '<p> has a style attribute'],
			['<h2> </h2>', '<h2> has no name'],
			['<h2><span aria-hidden="true">x</span></h2>', '<h2> has no name'],
			['<a href="/"><span hidden>Name</span></a>', 'a link to / has no name'],
			['<span title="x">x</span>', '<span> is named by title'],
			['<svg></svg>', 'an svg that is neither a labelled image nor decorative'],
			['<img src="x">', 'an img without alt: x'],
			['<nav><a href="/">x</a></nav>', 'a nav without a name'],
			['<details><p>x</p></details>', 'a details without a summary first'],
			['<p aria-describedby="none">x</p>', '<p> aria-describedby names no element: none'],
			['<p id="a"></p><p id="a"></p>', 'id a is used 2 times'],
			['<p aria-current="page">x</p>', '<p> has aria-current="page"'],
			['<a href="/" aria-current="true">x</a>', '<a> has aria-current="true"'],
			['<div role="tablist"></div>', '<div> has the role tablist'],
			['<input type="text" autofocus aria-label="q">', '<input> has autofocus outside a dialog'],
			['<a href="/" tabindex="1">x</a>', '<a> has a positive tabindex'],
			['<dialog></dialog>', 'a dialog without a name'],
		]
		for (const [markup, problem] of cases) {
			expect(a11yProblems(page(markup)), markup).toContain(problem)
		}
		expect(a11yProblems(page('', '<main></main>'))).toContain('2 main elements')
		expect(a11yProblems(page('<label>Query <input type="text" name="q"></label>'))).toEqual([])
		expect(a11yProblems(page('<label for="q">Query</label><input id="q" type="text" name="q">'))).toEqual([])
		expect(
			a11yProblems('<html lang="en"><body><article><h1>x</h1></article></body></html>', { embed: true })
		).toContain('the embed has a h1')
		expect(a11yProblems('<html><body><a href="/">x</a></body></html>')).toContain('html has no lang')
		expect(a11yProblems(page('').replace('<!doctype html>', ''))).toContain('the page renders in quirks mode')
		// The style ban reaches the head and the html and body elements themselves.
		expect(a11yProblems(page('').replace('<title>t</title>', '<title>t</title><style>p{}</style>'))).toContain(
			'a style element'
		)
		expect(a11yProblems(page('').replace('<body>', '<body style="margin:0">'))).toContain(
			'<body> has a style attribute'
		)
		expect(a11yProblems(page('').replace('<html lang="en">', '<html lang="en" style="color:red">'))).toContain(
			'<html> has a style attribute'
		)
	})
})
