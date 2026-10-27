import { describe, expect, it } from 'vitest'

import { bearer, json, seedFollows, setSetting, sql } from './api-helpers'
import { community, post } from './status-helpers'

// HTML weight of the fixture pages (design §13, "CI budgets"): raw UTF-8 bytes and gzip bytes (CompressionStream) of
// each page's body as served. Each bound is the measured size (below) plus 25%, never above the design's ceiling for
// the page.

type Bound = { raw: number; gzip: number }

const KIB = 1024

// Measured (raw / gzip): profile 33,044 / 2,572 (with its follow dialog); tag 29,806 / 1,563; status (the post, its
// four tabs, its dialogs with the embed code twice, shown and in its copy button, and 20 replies) 36,546 / 3,100;
// about 2,144 / 822; follow list (40 accounts) 23,318 / 1,396.
const BOUNDS: Record<'profile' | 'status' | 'tag' | 'about' | 'follows', Bound> = {
	profile: { raw: 41_305, gzip: 3_215 },
	tag: { raw: 37_258, gzip: 1_954 },
	status: { raw: 45_682, gzip: 3_875 },
	about: { raw: 2_680, gzip: 1_028 },
	follows: { raw: 29_148, gzip: 1_745 },
}

const CEILINGS: Record<keyof typeof BOUNDS, Bound> = {
	profile: { raw: 64 * KIB, gzip: 12 * KIB },
	status: { raw: 64 * KIB, gzip: 12 * KIB },
	tag: { raw: 60 * KIB, gzip: 12 * KIB },
	about: { raw: 16 * KIB, gzip: 5 * KIB },
	follows: { raw: 48 * KIB, gzip: 8 * KIB },
}

type Harness = Awaited<ReturnType<typeof community>>

async function gzipBytes(bytes: Uint8Array): Promise<number> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
	return (await new Response(stream).arrayBuffer()).byteLength
}

async function measure(h: Harness, path: string): Promise<{ raw: number; gzip: number }> {
	const response = await h.request(path)
	expect(response.status, path).toBe(200)
	const bytes = new Uint8Array(await response.arrayBuffer())
	return { raw: bytes.byteLength, gzip: await gzipBytes(bytes) }
}

async function fixtures() {
	const h = await community(['alice', 'bob'])
	const { alice, bob } = h.users
	await h.request(
		'/api/v1/accounts/update_credentials',
		bearer(alice.token, {
			...json({
				display_name: 'Alice Liddell',
				note: 'Curiouser and curiouser. Notes on small servers and slow software.',
				fields_attributes: [
					{ name: 'Web', value: 'https://alice.example/' },
					{ name: 'Location', value: 'Wonderland' },
				],
			}),
			method: 'PATCH',
		})
	)
	let last: Record<string, unknown> = {}
	for (let i = 0; i < 20; i++) {
		last = await post(h, alice, { status: `A short post, number ${i}, about servers and the walk home.` })
	}
	// The status page's post has 20 replies, a full page of them (bob's, so alice's pages list none).
	for (let i = 0; i < 20; i++) {
		await post(h, bob, { status: `A short reply, number ${i}, about the walk home.`, in_reply_to_id: last.id })
	}
	// The same 20 posts carry a hashtag, so its page lists them (its rows written as a post's hashtags are).
	await sql(
		h.store,
		"INSERT INTO status_tags (status_id, name, public) SELECT id, 'walks', 1 FROM statuses WHERE account_id = ?",
		alice.id
	)
	await setSetting(h.store, 'title', 'kopje.test')
	await setSetting(h.store, 'description', 'A small server for one person.')
	await setSetting(h.store, 'contact_email', 'admin@kopje.test')
	await setSetting(h.store, 'extended_description', '<p>One person runs this server.</p><p>Sign-ups are closed.</p>')
	await setSetting(
		h.store,
		'rules',
		JSON.stringify(
			Array.from({ length: 5 }, (_, i) => ({ text: `Rule number ${i + 1}`, hint: `A hint for rule ${i + 1}.` }))
		)
	)
	await setSetting(h.store, 'privacy_policy', '<p>Policy</p>')
	// 40 followers on another server, a full page of the follow list.
	await seedFollows(h.store, alice.id, 40, { direction: 'followers', domain: 'social.example', base: 600_000 })
	return { h, status: new URL(String(last.url)).pathname }
}

describe('HTML weight (design §13)', () => {
	it('keeps every fixture page within its bound, and every bound within its ceiling', async () => {
		const { h, status } = await fixtures()
		const sizes: Record<keyof typeof BOUNDS, Bound> = {
			profile: await measure(h, '/@alice'),
			status: await measure(h, status),
			tag: await measure(h, '/tags/walks'),
			about: await measure(h, '/about'),
			follows: await measure(h, '/@alice/followers'),
		}
		for (const page of Object.keys(BOUNDS) as (keyof typeof BOUNDS)[]) {
			expect(BOUNDS[page].raw, page).toBeLessThanOrEqual(CEILINGS[page].raw)
			expect(BOUNDS[page].gzip, page).toBeLessThanOrEqual(CEILINGS[page].gzip)
			expect(sizes[page].raw, `${page} raw`).toBeLessThanOrEqual(BOUNDS[page].raw)
			expect(sizes[page].gzip, `${page} gzip`).toBeLessThanOrEqual(BOUNDS[page].gzip)
		}
		// The profile fixture is the page the bound is about: 20 posts, each a card.
		const profile = await (await h.request('/@alice')).text()
		expect(profile.match(/<article /g)).toHaveLength(20)
		expect((await (await h.request('/tags/walks')).text()).match(/<article /g)).toHaveLength(20)
		// The status fixture: the post and its 20 replies.
		expect((await (await h.request(status)).text()).match(/<article /g)).toHaveLength(21)
		// The follow list fixture: 40 rows.
		expect((await (await h.request('/@alice/followers')).text()).match(/<li><div class="who">/g)).toHaveLength(40)
		// The inline icons' share of the gzip size (§13, "HTML weight"): the page's gzip size with and without its SVG
		// markup, 1,693 against 1,337 bytes (21%). A per-page sprite measured larger on gzip (each icon keeps its <svg>
		// wrapper, and gzip already shares the repeated paths), so the icons stay inline; 0.27 is the measured share
		// plus 25%, catching their growth.
		const encode = (text: string) => new TextEncoder().encode(text)
		const icons = profile.match(/<svg[\s\S]*?<\/svg>/g) ?? []
		const whole = await gzipBytes(encode(profile))
		const without = await gzipBytes(encode(profile.replace(/<svg[\s\S]*?<\/svg>/g, '')))
		// The 20 cards' count icons, the site's, the pager's two (a full page offers older posts, design §4), and the
		// follow button's and its dialog's two (close and copy, design §8).
		expect(icons.length).toBe(66)
		expect((whole - without) / whole).toBeLessThanOrEqual(0.27)
	})
})
