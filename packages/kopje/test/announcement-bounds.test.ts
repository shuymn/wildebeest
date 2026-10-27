import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import {
	announcementHarness,
	derivedAnnouncementMaxima,
	idnMentionFill,
	mentionFill,
	seedAnnouncement,
	tagFill,
} from './announcement-helpers'
import { seedAccount, sql } from './api-helpers'
import { BUILD } from './helpers'
import { localSnapshotAtCap, seedEmojiRow } from './local-emoji-helpers'
import { rowsRead } from './read-helpers'
import { getJson } from './status-helpers'
import { Db, rowHeapBytes } from '../src/db/sql'
import {
	adminAnnouncements,
	ANNOUNCEMENT_ROW_CAPS,
	announcementRound,
	ANNOUNCEMENT_CONTENT_BYTES,
	listAnnouncements,
	MAX_ANNOUNCEMENT_MENTIONS,
	MAX_ANNOUNCEMENT_TAGS,
	MAX_MENTION_REFS,
	meteredContentBytes,
	reactToAnnouncement,
	updateAnnouncement,
} from '../src/domain/announcements'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { parseStatusText, renderSegmentHtml, renderStatusHtml } from '../src/domain/status-text'
import { streamAnnouncement } from '../src/domain/streaming'
import { MAX_LIVE_ANNOUNCEMENTS, STATUS_EMOJIS_BYTES } from '../src/platform/stored-bounds'
import { sha256Hex } from '../src/security/tokens'

// RES-3: derive conservative maxima from column and presentation caps; fills witness reachable sizes.
// Check Store RPC delivery, bounded rendering and query plans with stale statistics.

const ORIGIN = 'https://kopje.test'
const id = (n: number) => String(200_000_000_000_000_000n + BigInt(n))
const bytes = (text: string) => new TextEncoder().encode(text).length
// The conservative maxima, derived from the caps (announcement-helpers.ts derivedAnnouncementMaxima).
const DERIVED = derivedAnnouncementMaxima()
const DERIVED_MENTIONS = 107_329
const DERIVED_TAGS = 53_761
const DERIVED_REACTIONS = 9801
const DERIVED_REST = 282
const DERIVED_ENTITY = 248_997

type Entity = Record<string, unknown> & {
	id: string
	content: string
	mentions: unknown[]
	tags: { name: string }[]
	emojis: unknown[]
	reactions: unknown[]
}

async function listed(h: Awaited<ReturnType<typeof announcementHarness>>, token: string): Promise<Entity[]> {
	const { status, body } = await getJson<Entity[]>(h, '/api/v1/announcements', token)
	expect(status).toBe(200)
	return body
}

// The content of `text` with hashtags linked and no mention resolved, as JSON bytes.
function hashtagContentBytes(text: string): number {
	return jsonBytes(
		renderStatusHtml(parseStatusText(text).segments, {
			mention: () => undefined,
			tagUrl: (name) => `${ORIGIN}/tags/${encodeURIComponent(name)}`,
		})
	)
}

// 600 hashtags, then plain characters up to exactly the content budget.
function contentAtCap(): string {
	const tags = '#a '.repeat(600)
	let pad = 0
	while (hashtagContentBytes(`${tags}${'x'.repeat(pad + 1)}`) <= ANNOUNCEMENT_CONTENT_BYTES) {
		pad++
	}
	return `${tags}${'x'.repeat(pad)}`
}

// A SqlStorage over `real` that hands `capture` the joined EXPLAIN QUERY PLAN of each statement matching `pattern`,
// then runs the statement.
function planCapturing(real: SqlStorage, pattern: RegExp, capture: (plan: string) => void): SqlStorage {
	return {
		exec: (query: string, ...params: SqlStorageValue[]) => {
			if (pattern.test(query)) {
				capture(explained(real, query, ...params))
			}
			return real.exec(query, ...params)
		},
	} as unknown as SqlStorage
}

function explained(real: SqlStorage, query: string, ...params: SqlStorageValue[]): string {
	return real
		.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
		.toArray()
		.map((row) => row.detail)
		.join(' | ')
}

describe('an announcement’s content (RES-3)', () => {
	it('is refused past 64 KiB of JSON when written, and admitted at exactly 65,536 bytes', async () => {
		const h = await announcementHarness(['alice'])
		const fits = contentAtCap()
		expect(hashtagContentBytes(fits)).toBe(ANNOUNCEMENT_CONTENT_BYTES)
		expect(bytes(fits)).toBeLessThanOrEqual(10_000)
		await h.admin.create({ text: fits })
		const [entity] = await listed(h, h.users.alice.token)
		expect(jsonBytes(entity!.content)).toBe(ANNOUNCEMENT_CONTENT_BYTES)
		expect(entity!.content).toContain('class="mention hashtag"')
		expect(
			await h.store.createAnnouncement(BUILD, {
				authority: h.authority,
				text: `${fits}x`,
				startsAt: null,
				endsAt: null,
				allDay: false,
				scheduledAt: null,
			})
		).toMatchObject({ ok: false, code: 'content-too-large' })
	})

	it('shows a stored text past the budget escaped, never building its links, within 60,009 bytes', async () => {
		const h = await announcementHarness(['alice'])
		const u = await seedAccount(h.store, { username: 'u', email: 'u@example.com' })
		// 2,048 bytes of profile URL, each & escaped to five bytes in an href.
		await sql(h.store, 'UPDATE accounts SET url = ? WHERE id = ?', `https://r.example/?${'&'.repeat(2029)}`, u)
		const text = `日 ${'@u '.repeat(3332)}`
		expect(bytes(text)).toBe(10_000)
		await seedAnnouncement(h.store, { id: id(1), text })
		// The largest fallback: 10,000 quotes, each escaped to six bytes.
		await seedAnnouncement(h.store, { id: id(2), text: '"'.repeat(10_000) })
		const started = Date.now()
		const [repeated, quoted] = await listed(h, h.users.alice.token)
		const ms = Date.now() - started
		expect(repeated!.content).toBe(`<p>日 ${'@u '.repeat(3331)}@u</p>`)
		expect(repeated!.mentions).toEqual([
			{ id: u, username: 'u', url: `https://r.example/?${'&'.repeat(2029)}`, acct: 'u' },
		])
		expect(jsonBytes(repeated!.content)).toBe(10_008)
		expect(jsonBytes(quoted!.content)).toBe(60_009)
		expect(ms).toBeLessThan(2000)
		// A text written within the budget whose mentioned account's url grows later is shown escaped too.
		await sql(h.store, 'DELETE FROM announcements WHERE id IN (?, ?)', id(1), id(2))
		await sql(h.store, 'UPDATE accounts SET url = NULL WHERE id = ?', u)
		await h.admin.create({ text: '@u '.repeat(30) })
		const [linked] = await listed(h, h.users.alice.token)
		expect(linked!.content).toContain('<span class="h-card">')
		await sql(h.store, 'UPDATE accounts SET url = ? WHERE id = ?', `https://r.example/?${'&'.repeat(2029)}`, u)
		const [fallen] = await listed(h, h.users.alice.token)
		expect(fallen!.content).toBe(`<p>${'@u '.repeat(29)}@u</p>`)
		expect(fallen!.mentions).toHaveLength(1)
	}, 60_000)
})

describe('the content meter', () => {
	const options = {
		mention: (ref: { username: string }) =>
			ref.username === 'u' ? { url: `https://r.example/?${'&'.repeat(40)}"\\`, username: 'u' } : undefined,
		tagUrl: (name: string) => `${ORIGIN}/tags/${encodeURIComponent(name)}`,
	}
	it('gives the size renderStatusHtml makes, for texts of every paragraph shape', () => {
		const texts = [
			'',
			'plain',
			'  lead and trail  ',
			'a\nb',
			'a\n\nb',
			'a\n\n\n\nb',
			'a\n \nb',
			'\n\n\na\n\n',
			' \u3000a\u00a0\n\u2028b\ufeff ',
			'tab\there "quote" \\ back <b>&</b> \u0001 \ud83d lone',
			'@u and @nobody #Tag https://example.com/a?b="c" \u{1F600}',
			'#a '.repeat(50) + '\n\n' + '@u\n'.repeat(20),
			'日 '.repeat(100) + '\n',
		]
		for (const text of texts) {
			const { segments } = parseStatusText(text)
			expect(meteredContentBytes(segments, options), JSON.stringify(text.slice(0, 20))).toBe(
				jsonBytes(renderStatusHtml(segments, options))
			)
		}
	})

	it('measures the largest single segment, the one segment built past the budget', () => {
		const text = `#${'\uFDFA'.repeat(3333)}`
		expect(bytes(text)).toBe(10_000)
		const [segment] = parseStatusText(text).segments
		const single = jsonBytes(renderSegmentHtml(segment!, options))
		console.log(JSON.stringify({ event: 'announcement-largest-segment', bytes: single }))
		expect(single).toBe(310_064)
	})

	it('shows the review’s texts escaped through the list, stopping at the segment that passes the budget', async () => {
		const h = await announcementHarness(['alice'])
		const wide = `#${'\uFDFA'.repeat(3333)}`
		const quoted = `${'#a '.repeat(600)}${'"'.repeat(8200)}`
		expect([bytes(wide), bytes(quoted)]).toEqual([10_000, 10_000])
		await seedAnnouncement(h.store, { id: id(1), text: wide })
		await seedAnnouncement(h.store, { id: id(2), text: quoted })
		const [first, second] = await listed(h, h.users.alice.token)
		expect(first!.content).toBe(`<p>#${'\uFDFA'.repeat(3333)}</p>`)
		expect(second!.content).toBe(`<p>${'#a '.repeat(599)}#a ${'&quot;'.repeat(8200)}</p>`)
		expect(first!.tags).toEqual([])
		expect(second!.tags).toEqual([{ name: 'a', url: `${ORIGIN}/tags/a` }])
	})
})

describe('an announcement’s mentions and hashtags (MD-4)', () => {
	it('keeps 16 accounts, looks up the first 64 references, and links only the accounts kept', async () => {
		const h = await announcementHarness(['alice'])
		for (let i = 0; i < 18; i++) {
			await seedAccount(h.store, { username: `m${i}`, domain: 'r.example' })
		}
		const refs = Array.from({ length: 17 }, (_, i) => `@m${i}@r.example`).join(' ')
		await h.admin.create({ text: refs })
		const [entity] = await listed(h, h.users.alice.token)
		expect(entity!.mentions).toHaveLength(MAX_ANNOUNCEMENT_MENTIONS)
		expect(entity!.content).toContain('@<span>m15</span>')
		expect(entity!.content).not.toContain('@<span>m16</span>')
		expect(entity!.content).toContain('@m16@r.example')
		// 64 references that resolve to nobody, then one that would: never looked up.
		const unknown = Array.from({ length: MAX_MENTION_REFS }, (_, i) => `@x${i}`).join(' ')
		await h.admin.update(entity!.id, { text: `${unknown} @m17@r.example` })
		const [late] = await listed(h, h.users.alice.token)
		expect(late!.mentions).toEqual([])
		await h.admin.update(entity!.id, { text: `${unknown.split(' ').slice(1).join(' ')} @m17@r.example` })
		expect((await listed(h, h.users.alice.token))[0]!.mentions).toHaveLength(1)
	})

	it('judges at most 8 accounts of one handle, however many unavailable ones share it (R1, RES-2)', async () => {
		// `n` remote accounts of @dup@dup.example whose deletion has started, then an available one after them.
		const measure = async (n: number) => {
			const h = await announcementHarness(['alice'])
			await sql(
				h.store,
				`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1)
				INSERT INTO accounts (id, uri, username, domain, deleted_at)
				SELECT CAST(130000000000000000 + i AS TEXT), 'https://dup.example/users/' || i, 'dup', 'dup.example', ?2 FROM k`,
				n,
				'2026-10-12T00:00:00.000Z'
			)
			const late = await seedAccount(h.store, { username: 'Dup', domain: 'dup.example' })
			await h.admin.create({ text: '@dup@dup.example' })
			const [entity] = await listed(h, h.users.alice.token)
			const credential = { tokenHash: await sha256Hex(h.users.alice.token), scope: null, now: Date.now() }
			const read = await rowsRead(h, listAnnouncements, { credential, origin: ORIGIN })
			const plan = await runInDurableObject(h.store, (_instance, state) => {
				let found = ''
				const capturing = planCapturing(state.storage.sql, /accounts_domain_username/, (plan) => {
					found = plan
				})
				listAnnouncements.run(capturing, { credential, origin: ORIGIN })
				return found
			})
			return { entity: entity!, read, plan, late }
		}
		const few = await measure(3)
		const many = await measure(20_000)
		// With 3 unavailable, the available fourth is among the first 8 and is linked; past 8, the handle stays text.
		expect(few.entity.mentions).toEqual([expect.objectContaining({ id: few.late })])
		expect(many.entity.mentions).toEqual([])
		expect(many.entity.content).toBe('<p>@dup@dup.example</p>')
		console.log(
			JSON.stringify({ event: 'announcement-mention-probe', few: few.read, many: many.read, plan: many.plan })
		)
		expect(many.read - few.read).toBeLessThanOrEqual(16)
		expect(many.plan).toMatch(/SEARCH a USING INTEGER PRIMARY KEY \(rowid=\?\)/)
		expect(many.plan).toMatch(/SEARCH b USING INDEX accounts_domain_username \(domain=\? AND <expr>=\? AND rowid<\?\)/)
		expect(many.plan).toMatch(/SEARCH c USING COVERING INDEX accounts_domain_username \(domain=\? AND <expr>=\?\)/)
		expect(many.plan).not.toMatch(/SCAN a\b|SCAN b\b|SCAN c\b/)
	}, 120_000)

	it('keeps 16 hashtags, each within 256 code units, and links every one', async () => {
		const h = await announcementHarness(['alice'])
		const names = Array.from({ length: 17 }, (_, i) => `t${String.fromCharCode(97 + i)}`)
		const { id: announcement } = await h.admin.create({ text: names.map((n) => `#${n}`).join(' ') })
		const [entity] = await listed(h, h.users.alice.token)
		expect(entity!.tags.map((t) => t.name)).toEqual(names.slice(0, MAX_ANNOUNCEMENT_TAGS))
		expect(entity!.content).toContain('#<span>tq</span>')
		await h.admin.update(announcement, { text: `#${'a'.repeat(256)} #${'b'.repeat(257)}` })
		const [long] = await listed(h, h.users.alice.token)
		expect(long!.tags.map((t) => t.name.length)).toEqual([256])
		expect(long!.content).toContain(`#<span>${'b'.repeat(257)}</span>`)
	})
})

describe('the maxima of an announcement (RES-3)', () => {
	// Each part at the widest one 10,000-byte text reaches, JSON escapes and NFKC expansion at their worst, as imported
	// rows (the admin's content check would refuse some of them; the presenter shows them as stored). The viewer, Alice,
	// has not reacted (`me` is false, a byte longer than true).
	async function fills() {
		const h = await announcementHarness(['alice', 'bob'])
		const token = h.users.alice.token
		const measured: Record<string, number> = {}
		let n = 0
		const part = async (key: 'content' | 'mentions' | 'tags' | 'emojis' | 'reactions', text: string) => {
			const announcement = id(++n)
			await seedAnnouncement(h.store, { id: announcement, text })
			const entity = (await listed(h, token)).find((a) => a.id === announcement)!
			measured[key] = Math.max(measured[key] ?? 0, jsonBytes(entity[key]))
			return { announcement, entity }
		}
		// Content: exactly the budget (the content witness above).
		await part('content', contentAtCap())
		// Mentions: 16 of the widest accounts, their URLs of backslashes.
		const mentionText = await mentionFill(h.store)
		expect(bytes(mentionText)).toBeLessThanOrEqual(10_000)
		const mentioned = await part('mentions', mentionText)
		expect(mentioned.entity.mentions).toHaveLength(MAX_ANNOUNCEMENT_MENTIONS)
		// The same with a domain the text spells in Unicode, which IDNA makes 966 ASCII bytes.
		const idnText = await idnMentionFill(h.store)
		expect(bytes(idnText)).toBeLessThanOrEqual(10_000)
		const idn = await part('mentions', idnText)
		expect(idn.entity.mentions).toHaveLength(MAX_ANNOUNCEMENT_MENTIONS)
		await sql(h.store, 'DELETE FROM announcements')
		// Hashtags: 16 names of 256 three-byte code units after NFKC.
		const tagged = await part('tags', tagFill())
		expect(tagged.entity.tags.map((t) => t.name.length)).toEqual(Array.from({ length: 16 }, () => 256))
		// Emoji: the local emoji the text references, at their presented bound.
		const snapshot = JSON.parse(await localSnapshotAtCap(h.store, h.users.alice.id, STATUS_EMOJIS_BYTES)) as [
			string,
			string,
		][]
		const emojiText = snapshot.map(([name]) => `:${name}:`).join(' ')
		const emojied = await part('emojis', emojiText)
		expect(jsonBytes(emojied.entity.emojis)).toBe(STATUS_EMOJIS_BYTES)
		// Reactions: 8 custom emoji of 128-character shortcodes and 512-byte URLs (whose alphabet needs no escape), by
		// Bob.
		const shortcodes: string[] = []
		for (let i = 0; i < 8; i++) {
			const shortcode = `${i}${'s'.repeat(127)}`
			const url = `https://kopje.test/media/${i}${'t'.repeat(477)}/full.png`
			expect(url.length).toBe(512)
			await seedEmojiRow(h.store, {
				id: String(300_000_000_000_000_000n + BigInt(i)),
				shortcode,
				owner: h.users.alice.id,
				url,
			})
			shortcodes.push(shortcode)
		}
		const react = async (announcement: string) => {
			for (const [i, shortcode] of shortcodes.entries()) {
				await sql(
					h.store,
					'INSERT INTO announcement_reactions (announcement_id, account_id, name, custom_emoji_id) VALUES (?, ?, ?, ?)',
					announcement,
					h.users.bob.id,
					shortcode,
					String(300_000_000_000_000_000n + BigInt(i))
				)
			}
		}
		const reacted = id(++n)
		await seedAnnouncement(h.store, { id: reacted, text: 'reactions' })
		await react(reacted)
		const withReactions = (await listed(h, token)).find((a) => a.id === reacted)!
		expect(withReactions.reactions).toHaveLength(8)
		measured.reactions = jsonBytes(withReactions.reactions)
		// The rest: keys, the id, the times at their 24 bytes (a range set), flags at `false`, `read` and "statuses":[].
		const bare = id(++n)
		await seedAnnouncement(h.store, {
			id: bare,
			text: 'x',
			starts_at: '2026-11-01T00:00:00.000Z',
			ends_at: '2026-11-02T00:00:00.000Z',
		})
		const plain = (await listed(h, token)).find((a) => a.id === bare)!
		measured.rest =
			jsonBytes({ ...plain, content: '', mentions: [], tags: [], emojis: [], reactions: [] }) -
			jsonBytes('') -
			4 * jsonBytes([])
		await sql(h.store, 'DELETE FROM announcements')
		// The widest of these one text holds together: the hashtags, the emoji, and as many mentions as fit.
		const tags = tagFill()
		const room = 10_000 - bytes(tags) - bytes(emojiText) - 2
		const fitting = Math.floor((room + 1) / (bytes(mentionText.split(' ')[0]!) + 1))
		const combo = [tags, emojiText, await mentionFill(h.store, fitting, 16)].join(' ')
		expect(bytes(combo)).toBeLessThanOrEqual(10_000)
		return { h, measured, combo, react }
	}

	it('derives each part’s maximum from the caps, which every measured fill stays within', async () => {
		const { h, measured, combo, react } = await fills()
		console.log(JSON.stringify({ event: 'announcement-maxima', measured, derived: DERIVED }))
		expect(DERIVED).toEqual({
			parts: {
				content: ANNOUNCEMENT_CONTENT_BYTES,
				mentions: DERIVED_MENTIONS,
				tags: DERIVED_TAGS,
				emojis: STATUS_EMOJIS_BYTES,
				reactions: DERIVED_REACTIONS,
				rest: DERIVED_REST,
			},
			entity: DERIVED_ENTITY,
			list: DERIVED_ENTITY * 16 + 17,
			stream: DERIVED_ENTITY * 2 + 2,
		})
		for (const [key, value] of Object.entries(measured)) {
			expect(value, key).toBeLessThanOrEqual(DERIVED.parts[key as keyof typeof DERIVED.parts])
		}
		expect(DERIVED.entity).toBeLessThanOrEqual(0.85 * ANSWER_BYTES)
		expect(DERIVED.stream).toBeLessThan(512 * 1024)
		// The list: 16 announcements of the widest combined text, each with 8 reactions, through the real Store RPC.
		for (let i = 0; i < MAX_LIVE_ANNOUNCEMENTS; i++) {
			await seedAnnouncement(h.store, { id: id(100 + i), text: combo })
			await react(id(100 + i))
		}
		const credential = { tokenHash: await sha256Hex(h.users.alice.token), scope: null, now: Date.now() }
		const started = Date.now()
		const answer = await h.store.listAnnouncements(BUILD, { credential, origin: ORIGIN })
		const ms = Date.now() - started
		expect(answer.status).toBe('ok')
		const items = (answer as { value: Entity[] }).value
		expect(items).toHaveLength(MAX_LIVE_ANNOUNCEMENTS)
		const listBytes = jsonBytes(items)
		const each = Math.max(...items.map((item) => jsonBytes(item)))
		console.log(JSON.stringify({ event: 'announcement-list', bytes: listBytes, each, ms, bound: DERIVED.list }))
		expect(each).toBeLessThanOrEqual(DERIVED.entity)
		expect(listBytes).toBeLessThanOrEqual(DERIVED.list)
		expect(ms).toBeLessThan(2000)
	}, 120_000)

	it('bounds the rows the list reads by per-column maxima, with the RowMeter backstop at that bound', () => {
		// Each read's widest row, column by column (the bounds ANNOUNCEMENT_ROW_CAPS names), measured as RowMeter does.
		const text = (units: number) => 'x'.repeat(units)
		const time = text(24)
		const listRow = {
			id: text(18),
			text: text(10_000),
			starts_at: time,
			ends_at: time,
			all_day: 0,
			published: 1,
			published_at: time,
			scheduled_at: time,
			created_at: time,
			updated_at: time,
		}
		const dismissal = { id: text(18) }
		const mention = { i: 63, id: text(18), username: text(255), domain: text(2040), url: text(2048), uri: text(2048) }
		const emoji = { i: 1023, shortcode: text(128), url: text(2048) }
		const reaction = { name: text(128), count: 1, me: 1, url: text(2048) }
		const list = 16 * rowHeapBytes(listRow) + 16 * rowHeapBytes(dismissal)
		const presentation = 64 * rowHeapBytes(mention) + 1024 * rowHeapBytes(emoji) + 8 * rowHeapBytes(reaction)
		expect(ANNOUNCEMENT_ROW_CAPS).toEqual({ list, presentation })
		// The heap model ("Heap at 8 MiB"): rows with 25% headroom (the list's, held throughout, and one presentation's at
		// a time), the presented answer at three times its JSON, and one rendering: the budget, the one segment built
		// past it and the fallback, two bytes a code unit.
		const answer = DERIVED.list
		const transient = 2 * (ANNOUNCEMENT_CONTENT_BYTES + 310_064 + 60_009)
		const heap = 1.25 * (list + presentation) + 3 * answer + transient
		console.log(JSON.stringify({ event: 'announcement-heap', list, presentation, answer, transient, heap }))
		expect(heap).toBeLessThan(64 * 1024 * 1024)
	})

	it('shows an announcement escaped, with nothing read for it, once its reads pass the RowMeter cap', async () => {
		const h = await announcementHarness(['alice', 'bob'])
		await h.admin.create({ text: 'Hi @bob #tag' })
		const cap = ANNOUNCEMENT_ROW_CAPS.presentation
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		ANNOUNCEMENT_ROW_CAPS.presentation = 100
		try {
			const [entity] = await listed(h, h.users.alice.token)
			expect(entity).toMatchObject({
				content: '<p>Hi @bob #tag</p>',
				mentions: [],
				tags: [],
				emojis: [],
				reactions: [],
			})
			expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.announcements.row-cap-exceeded' }))
		} finally {
			ANNOUNCEMENT_ROW_CAPS.presentation = cap
			warn.mockRestore()
		}
		expect((await listed(h, h.users.alice.token))[0]!.mentions).toHaveLength(1)
	})
})

describe('announcement query plans at saturation, with stale statistics', () => {
	it('reads each production query through its index', async () => {
		const h = await announcementHarness(['alice', 'bob'])
		// Statistics taken while the tables were empty, then 1,000 announcements (8 published, 8 scheduled), 8 names of
		// 20 local accounts' reactions on each live one, every dismissal, 20,000 remote accounts of one username, and a
		// journal of 4,096 rows.
		await sql(h.store, 'ANALYZE')
		await runInDurableObject(h.store, (_instance, state) => {
			const s = state.storage.sql
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
				INSERT INTO accounts (id, uri, username) SELECT CAST(100000000000000000 + i AS TEXT),
					'https://kopje.test/ap/users/l' || i, 'l' || i FROM n`
			)
			s.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts WHERE id < '100000000000000100'`
			)
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
				INSERT INTO accounts (id, uri, username, domain) SELECT CAST(120000000000000000 + i AS TEXT),
					'https://d' || i || '.example/users/same', 'same', 'd' || i || '.example' FROM n`
			)
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
				INSERT INTO announcements (id, text, published, published_at, scheduled_at, ends_at, starts_at, created_at,
					updated_at)
				SELECT CAST(200000000000000000 + i AS TEXT), 'text ' || i, i <= 8, CASE WHEN i <= 8 THEN ?1 END,
					CASE WHEN i > 8 AND i <= 16 THEN ?1 END, ?1, ?1, ?1, ?1 FROM n`,
				'2026-10-12T00:00:00.000Z'
			)
			s.exec(
				`INSERT INTO announcement_reactions (announcement_id, account_id, name)
				SELECT a.id, l.account_id, n.value FROM announcements a CROSS JOIN local_accounts l
					CROSS JOIN json_each('["1⃣","2⃣","3⃣","4⃣","5⃣","6⃣","7⃣","8⃣"]') n
				WHERE a.published = 1 OR a.scheduled_at IS NOT NULL`
			)
			s.exec(
				`INSERT INTO announcement_dismissals (account_id, announcement_id)
				SELECT l.account_id, a.id FROM local_accounts l CROSS JOIN announcements a`
			)
			s.exec(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4096)
				INSERT INTO stream_events (id, kind, subject, created_at) SELECT i, 'status', i, ?1 FROM n`,
				'2026-10-12T00:00:00.000Z'
			)
		})
		const alice = await sha256Hex(h.users.alice.token)
		const authority = h.authority
		const plans = await runInDurableObject(h.store, (_instance, state) => {
			const real = state.storage.sql
			const seen: Record<string, string[]> = {}
			const capturing = (label: string, pattern: RegExp) =>
				planCapturing(real, pattern, (plan) => (seen[label] ??= []).push(plan))
			const credential = { tokenHash: alice, scope: null, now: Date.now() }
			const user = { tokenHash: alice, scope: 'write:favourites' as const, now: Date.now() }
			listAnnouncements.run(capturing('list', /INDEXED BY announcements_published/), { credential, origin: ORIGIN })
			listAnnouncements.run(capturing('read', /announcement_dismissals d/), { credential, origin: ORIGIN })
			listAnnouncements.run(capturing('reactions', /GROUP BY name/), { credential, origin: ORIGIN })
			const probe = `@same@d10000.example @same@d1.example ${Array.from({ length: 62 }, (_, i) => `@l${i}`).join(' ')}`
			updateAnnouncement.run(real, { authority, id: id(1), changes: { text: probe }, now: Date.now() })
			listAnnouncements.run(capturing('mentions', /accounts_domain_username/), { credential, origin: ORIGIN })
			reactToAnnouncement.run(capturing('names', /count\(DISTINCT name\)/), { credential: user, id: id(1), name: '1⃣' })
			reactToAnnouncement.run(capturing('repeat', /AND account_id = \?/), { credential: user, id: id(1), name: '1⃣' })
			reactToAnnouncement.run(capturing('emoji', /custom_emojis_enabled/), {
				credential: user,
				id: id(1),
				name: 'blob',
			})
			adminAnnouncements.run(capturing('admin', /ORDER BY id DESC/), { before: id(500) })
			const round = announcementRound.run(capturing('round', /INDEXED BY announcements_(scheduled|published)/), {
				now: Date.parse('2027-01-01T00:00:00.000Z'),
			})
			real.exec("INSERT INTO stream_subscriptions (account_id, stream_key, sockets) VALUES ('1', 'user', 1)")
			streamAnnouncement(new Db(capturing('journal', /max\(id\) FROM stream_events/)), 'announcement', id(1), 'now')
			const plan = (query: string) => explained(real, query)
			seen.live = [
				plan(`SELECT (SELECT count(*) FROM announcements WHERE published = 1)
					+ (SELECT count(*) FROM announcements WHERE scheduled_at IS NOT NULL) AS n`),
			]
			seen.total = [plan('SELECT count(*) AS n FROM announcements')]
			return { seen, round }
		})
		const { seen, round } = plans
		console.log(JSON.stringify({ event: 'announcement-plans', ...seen }))
		// The 8 due are published, then all 16 published have ended.
		expect(round).toEqual({ published: 8, expired: 16 })
		expect(seen.list).toEqual([expect.stringMatching(/^SCAN a USING INDEX announcements_published$/)])
		// The dismissals by key: the primary key, or the announcement's index, which holds the key too.
		expect(seen.read).toEqual([
			expect.stringMatching(
				/^SCAN j VIRTUAL TABLE .* \| SEARCH d USING (PRIMARY KEY|COVERING INDEX announcement_dismissals_announcement) \((account_id=\? AND announcement_id=\?|announcement_id=\? AND account_id=\?)\)$/
			),
		])
		expect(seen.reactions?.length).toBeGreaterThan(0)
		expect(seen.mentions?.length).toBeGreaterThan(0)
		for (const reactions of seen.reactions ?? []) {
			expect(reactions).toMatch(
				/SEARCH announcement_reactions USING COVERING INDEX announcement_reactions_name \(announcement_id=\?\)/
			)
			expect(reactions).not.toMatch(/TEMP B-TREE FOR GROUP BY/)
			expect(reactions).toMatch(/SEARCH r USING INTEGER PRIMARY KEY \(rowid=\?\)/)
		}
		for (const mentions of seen.mentions ?? []) {
			expect(mentions).toMatch(/SEARCH a USING INTEGER PRIMARY KEY \(rowid=\?\)/)
			expect(mentions).toMatch(/SEARCH b USING INDEX accounts_domain_username \(domain=\? AND <expr>=\? AND rowid<\?\)/)
			expect(mentions).not.toMatch(/SCAN a\b/)
		}
		expect(seen.names!.join()).toMatch(/announcement_reactions_name \(announcement_id=\?/)
		expect(seen.repeat!.join()).toMatch(
			/SEARCH announcement_reactions USING COVERING INDEX announcement_reactions_name \(announcement_id=\? AND name=\? AND account_id=\?\)/
		)
		expect(seen.emoji!.join()).toMatch(/custom_emojis_enabled \(shortcode=\?\)/)
		expect(seen.admin!.join()).toMatch(/SEARCH announcements USING INDEX sqlite_autoindex_announcements_1 \(id<\?\)/)
		expect(seen.admin!.join()).not.toMatch(/TEMP B-TREE/)
		expect(seen.round!.join(' / ')).toMatch(
			/SEARCH announcements USING (COVERING )?INDEX announcements_scheduled \(scheduled_at<\?\)/
		)
		expect(seen.round!.join(' / ')).toMatch(/announcements_published/)
		// The journal's span, each end one seek (journalFull).
		expect(seen.journal).toHaveLength(1)
		expect(seen.journal!.join()).not.toMatch(/SCAN stream_events/)
		expect(seen.live![0]).toMatch(/SCAN announcements USING COVERING INDEX announcements_published/)
		expect(seen.live![0]).toMatch(/(SCAN|SEARCH) announcements USING COVERING INDEX announcements_scheduled/)
		expect(seen.total![0]).toMatch(/SCAN announcements USING COVERING INDEX/)
	}, 120_000)
})
