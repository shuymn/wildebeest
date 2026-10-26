import { expect } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { attr, one, parseHtml, query, text } from './web-dom'
import { olderOf } from './web-helpers'
import { jsonBytes } from '../src/domain/answer-budget'
import { LONGEST_STATUS_STUB } from '../src/domain/web-pages/budget'
import type { ProfilePage } from '../src/domain/web-pages/profile'
import type { Site } from '../src/domain/web-pages/site'
import type { StoreStub } from '../src/platform/store-client'
import { STRINGS } from '../src/web/strings'

// The profile page read in tests: walking its older pages, seeding pins and its frame; and walking a feed page's HTML
// (the profile tabs, the hashtag page) both ways.

type ProfileOk = Extract<ProfilePage, { status: 'ok' }>

// A profile tab walked by its older cursor (design §4) from the first page to the last: the ids each page showed or
// stubbed, in order, and what each page held. Every page moves on: its continuation is the last item it consumed.
export async function walkProfile(read: (maxId: string | null) => Promise<ProfileOk>, requests = 100) {
	const seen: string[] = []
	const pages: { shown: number; stub: boolean }[] = []
	let maxId: string | null = null
	for (let request = 0; ; request++) {
		expect(request).toBeLessThan(requests)
		const page = await read(maxId)
		const ids = [...(page.stub === null ? [] : [page.stub.id]), ...page.statuses.map((status) => status.id)]
		seen.push(...ids)
		pages.push({ shown: page.statuses.length, stub: page.stub !== null })
		maxId = olderOf(page)
		if (maxId === null) {
			break
		}
		expect(ids.length).toBeGreaterThan(0)
		expect(maxId).toBe(ids.at(-1))
	}
	return { seen, pages }
}

// Pins `ids` for `account` in that order, a second apart up to NOW, so the last is the newest pin.
export async function pinStatuses(store: StoreStub, account: string, ids: readonly string[]): Promise<void> {
	for (const [i, id] of ids.entries()) {
		await sql(
			store,
			'INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)',
			account,
			id,
			new Date(NOW - 1000 * (ids.length - i)).toISOString()
		)
	}
}

// The frame a profile answer reserves (design §2), stated apart from the read's own: its shape with no pins or posts,
// the longest stub, both paging ends at 19 digits, and the site facts.
export function profileFrameBytes(site: Site): number {
	return jsonBytes({
		status: 'ok',
		account: null,
		pins: [],
		statuses: [],
		stub: LONGEST_STATUS_STUB,
		parents: {},
		paging: { newest: '9'.repeat(19), oldest: '9'.repeat(19), more: true },
		site,
	})
}

// What a feed page shows: its pinned posts and its list (each card's link: its date link, or a stub's), the links of
// its reply-to lines, and its pager.
export function shownFeed(html: string) {
	const main = one(parseHtml(html), 'main')
	const pins: string[] = []
	const items: string[] = []
	for (const article of query(main, 'article')) {
		const link = query(query(article, 'p', 'meta')[0]!, 'a')[0]
		expect(link, 'a card links its post').toBeDefined()
		const label = query(article, 'p', 'label')[0]
		;(label !== undefined && text(label) === STRINGS.post.pinned ? pins : items).push(attr(link!, 'href') ?? '')
	}
	const replyTo = query(main, 'p', 'reply-to').flatMap((p) => query(p, 'a').map((a) => attr(a, 'href') ?? ''))
	const pager = query(main, 'nav', 'pager')[0]
	const link = (name: string) =>
		pager === undefined
			? null
			: (query(pager, 'a')
					.filter((a) => text(a) === name)
					.map((a) => attr(a, 'href'))[0] ?? null)
	return { pins, items, replyTo, newer: link(STRINGS.pager.newer), older: link(STRINGS.pager.older) }
}

// A feed page walked to its oldest end by its older links, and back to its newest end by its newer links (design §4):
// the items of each walk newest first, the number each page of the older walk showed, the first page's pins (pins lead
// only the first page), and every page's HTML.
export async function walkFeed(get: (url: string) => Promise<string>, base: string) {
	const pages: string[] = []
	const visited = new Set<string>()
	const open = async (url: string) => {
		expect(visited.has(url), `${url} is visited once a walk`).toBe(false)
		visited.add(url)
		expect(visited.size).toBeLessThan(200)
		const html = await get(url)
		pages.push(html)
		const page = shownFeed(html)
		expect(url === base || page.pins.length === 0, `${url} shows no pins`).toBe(true)
		return page
	}
	const down: string[] = []
	const sizes: number[] = []
	let url = base
	let page = await open(base)
	const pins = page.pins
	for (;;) {
		down.push(...page.items)
		sizes.push(page.items.length)
		if (page.older === null) {
			break
		}
		url = page.older
		page = await open(url)
	}
	visited.clear()
	visited.add(url)
	const upPages: string[][] = [page.items]
	while (page.newer !== null) {
		page = await open(page.newer)
		upPages.push(page.items)
	}
	return { down, up: upPages.toReversed().flat(), sizes, pins, pages }
}
