import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { announcementHarness, mentionFill, seedAnnouncement } from './announcement-helpers'
import { seedAccount, sql } from './api-helpers'
import { BUILD } from './helpers'
import { localSnapshotAtCap, seedEmojiRow } from './local-emoji-helpers'
import { observedSql, rowsRead, type SqlRow } from './read-helpers'
import { getJson } from './status-helpers'
import { Db } from '../src/db/sql'
import {
	adminAnnouncements,
	announcementRound,
	ANNOUNCEMENT_CONTENT_BYTES,
	listAnnouncements,
	MAX_ANNOUNCEMENT_MENTIONS,
	MAX_ANNOUNCEMENT_TAGS,
	MAX_MENTION_REFS,
	reactToAnnouncement,
	updateAnnouncement,
} from '../src/domain/announcements'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { parseStatusText, renderStatusHtml } from '../src/domain/status-text'
import { streamAnnouncement } from '../src/domain/streaming'
import { MAX_LIVE_ANNOUNCEMENTS, STATUS_EMOJIS_BYTES } from '../src/platform/stored-bounds'
import { sha256Hex } from '../src/security/tokens'

// RES-3: an announcement's presented parts at their bounds, each measured at the most a 10,000-byte text can reach
// (no one text reaches every part's bound at once: 16 mentions of the widest accounts alone need more), the
// conservative sum of the measured parts, the list of MAX_LIVE_ANNOUNCEMENTS through the Store RPC, the rendering
// budget (A7 of the design: a text of repeated references never builds its links past the budget), and the query
// plans at saturation with stale statistics (docs/threat-model.md "Maxima of presented units").

const ORIGIN = 'https://kopje.test'
const id = (n: number) => String(200_000_000_000_000_000n + BigInt(n))
const bytes = (text: string) => new TextEncoder().encode(text).length

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

describe('an announcement’s content (RES-3)', () => {
	it('is refused past 64 KiB of JSON when written, and admitted at exactly 65,536 bytes', async () => {
		const h = await announcementHarness(['alice'])
		// 600 hashtags, then plain characters up to the budget.
		const tags = '#a '.repeat(600)
		let pad = 0
		while (hashtagContentBytes(`${tags}${'x'.repeat(pad + 1)}`) <= ANNOUNCEMENT_CONTENT_BYTES) {
			pad++
		}
		const fits = `${tags}${'x'.repeat(pad)}`
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

	it('shows a stored text past the budget escaped, never building its links (A7), within 60,009 bytes', async () => {
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
				const capturing = {
					exec: (query: string, ...params: SqlStorageValue[]) => {
						if (/accounts_domain_username/.test(query)) {
							found = state.storage.sql
								.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
								.toArray()
								.map((row) => row.detail)
								.join(' | ')
						}
						return state.storage.sql.exec(query, ...params)
					},
				} as unknown as SqlStorage
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
	// Each part at the most one 10,000-byte text reaches, through the Store and the API.
	async function fills() {
		const h = await announcementHarness(['alice'])
		const token = h.users.alice.token
		const measured: Record<string, number> = {}
		const part = async (key: 'content' | 'mentions' | 'tags' | 'emojis' | 'reactions', text: string) => {
			const { id: announcement } = await h.admin.create({ text })
			const entity = (await listed(h, token)).find((a) => a.id === announcement)!
			measured[key] = Math.max(measured[key] ?? 0, jsonBytes(entity[key]))
			await h.admin.remove(announcement)
			return entity
		}
		// Content: exactly the budget (the content witness above), and the escaped fallback.
		const tags = '#a '.repeat(600)
		let pad = 0
		while (hashtagContentBytes(`${tags}${'x'.repeat(pad + 1)}`) <= ANNOUNCEMENT_CONTENT_BYTES) {
			pad++
		}
		await part('content', `${tags}${'x'.repeat(pad)}`)
		const mentionText = await mentionFill(h.store)
		expect(bytes(mentionText)).toBeLessThanOrEqual(10_000)
		const mentioned = await part('mentions', mentionText)
		expect(mentioned.mentions).toHaveLength(MAX_ANNOUNCEMENT_MENTIONS)
		// Hashtags: 16 of 207 three-byte characters (623 bytes of text each).
		const tagged = await part(
			'tags',
			Array.from({ length: MAX_ANNOUNCEMENT_TAGS }, (_, i) => `#${String.fromCharCode(0x65e5 + i).repeat(207)}`).join(
				' '
			)
		)
		expect(tagged.tags).toHaveLength(MAX_ANNOUNCEMENT_TAGS)
		// Emoji: the local emoji the text references, at their presented bound.
		const snapshot = JSON.parse(await localSnapshotAtCap(h.store, h.users.alice.id, STATUS_EMOJIS_BYTES)) as [
			string,
			string,
		][]
		const emojied = await part('emojis', snapshot.map(([name]) => `:${name}:`).join(' '))
		expect(jsonBytes(emojied.emojis)).toBe(STATUS_EMOJIS_BYTES)
		// Reactions: 8 custom emoji of 128-character shortcodes and 512-byte URLs (imported), by the viewer.
		const { id: reacted } = await h.admin.create({ text: 'reactions' })
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
			await sql(
				h.store,
				'INSERT INTO announcement_reactions (announcement_id, account_id, name, custom_emoji_id) VALUES (?, ?, ?, ?)',
				reacted,
				h.users.alice.id,
				shortcode,
				String(300_000_000_000_000_000n + BigInt(i))
			)
		}
		const withReactions = (await listed(h, token)).find((a) => a.id === reacted)!
		expect(withReactions.reactions).toHaveLength(8)
		measured.reactions = jsonBytes(withReactions.reactions)
		// The rest: keys, the id, the times at their 24 bytes (a range set), flags, `read` and "statuses":[].
		await h.admin.update(reacted, {
			text: 'x',
			startsAt: '2026-11-01T00:00:00.000Z',
			endsAt: '2026-11-02T00:00:00.000Z',
		})
		const bare = (await listed(h, token)).find((a) => a.id === reacted)!
		measured.rest =
			jsonBytes({ ...bare, content: '', mentions: [], tags: [], emojis: [], reactions: [] }) -
			jsonBytes('') -
			4 * jsonBytes([])
		await h.admin.remove(reacted)
		return { h, measured, mentionText }
	}

	it('measures each part at its reachable fill and keeps their conservative sum within 85% of an answer', async () => {
		const { h, measured, mentionText } = await fills()
		const sum = Object.values(measured).reduce((a, b) => a + b, 0)
		console.log(JSON.stringify({ event: 'announcement-maxima', measured, conservative: sum }))
		expect(measured).toEqual({
			content: ANNOUNCEMENT_CONTENT_BYTES,
			mentions: 47_767,
			tags: 40_465,
			emojis: STATUS_EMOJIS_BYTES,
			reactions: 9673,
			rest: 282,
		})
		expect(sum).toBe(176_011)
		expect(sum).toBeLessThanOrEqual(0.85 * ANSWER_BYTES)
		// The list: 16 announcements at the largest fill (the mentions'), through the real Store RPC.
		for (let i = 0; i < MAX_LIVE_ANNOUNCEMENTS; i++) {
			await h.admin.create({ text: mentionText })
		}
		const credential = { tokenHash: await sha256Hex(h.users.alice.token), scope: null, now: Date.now() }
		const started = Date.now()
		const answer = await h.store.listAnnouncements(BUILD, { credential, origin: ORIGIN })
		const ms = Date.now() - started
		expect(answer.status).toBe('ok')
		const items = (answer as { value: Entity[] }).value
		expect(items).toHaveLength(MAX_LIVE_ANNOUNCEMENTS)
		const listBytes = jsonBytes(items)
		console.log(
			JSON.stringify({ event: 'announcement-list', bytes: listBytes, ms, bound: MAX_LIVE_ANNOUNCEMENTS * sum + 1 })
		)
		expect(listBytes).toBeLessThanOrEqual(MAX_LIVE_ANNOUNCEMENTS * sum + 1)
		expect(ms).toBeLessThan(2000)
	}, 120_000)

	it('reads a bounded heap of rows for the list: per-column maxima over every row it reads', async () => {
		const { h, mentionText } = await fills()
		for (let i = 0; i < MAX_LIVE_ANNOUNCEMENTS; i++) {
			await h.admin.create({ text: mentionText })
		}
		const credential = { tokenHash: await sha256Hex(h.users.alice.token), scope: null, now: Date.now() }
		// The heap model's meter (docs/threat-model.md "Heap at 8 MiB"): per row 64 B, per value 32 B and twice its UTF-8
		// bytes; the most any one statement's rows hold at once, and the presented answer at three times its JSON.
		const heap = await runInDurableObject(h.store, (_instance, state) => {
			let statement = 0
			let peak = 0
			const meter = (rows: readonly SqlRow[]) => {
				const held = rows.reduce(
					(sum, row) =>
						sum +
						64 +
						Object.values(row).reduce<number>(
							(s, v) => s + 32 + (typeof v === 'string' ? 2 * bytes(v) : v instanceof ArrayBuffer ? v.byteLength : 8),
							0
						),
					0
				)
				statement = Math.max(statement, held)
				peak = Math.max(peak, held)
			}
			const answer = listAnnouncements.run(observedSql(state.storage.sql, meter), { credential, origin: ORIGIN })
			const json = jsonBytes(answer)
			return { rows: peak, answer: json, statement }
		})
		// The rendering of one announcement at a time: its linked HTML and its fallback (at most the budget and 60,009
		// bytes of JSON), two bytes a code unit; the links are summed one at a time and dropped (A7).
		const transient = 2 * 2 * (ANNOUNCEMENT_CONTENT_BYTES + 60_009)
		const total = heap.rows * 1.25 + 3 * heap.answer + transient
		console.log(JSON.stringify({ event: 'announcement-heap', ...heap, transient, model: Math.round(total) }))
		expect(total).toBeLessThan(64 * 1024 * 1024)
	}, 120_000)
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
				({
					exec: (query: string, ...params: SqlStorageValue[]) => {
						if (pattern.test(query)) {
							;(seen[label] ??= []).push(
								real
									.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
									.toArray()
									.map((row) => row.detail)
									.join(' | ')
							)
						}
						return real.exec(query, ...params)
					},
				}) as unknown as SqlStorage
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
			streamAnnouncement(new Db(capturing('journal', /FROM stream_events WHERE id >/)), 'announcement', id(1), 'now')
			const plan = (query: string) =>
				real
					.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
					.toArray()
					.map((row) => row.detail)
					.join(' | ')
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
		expect(seen.journal!.join()).toMatch(/SEARCH stream_events USING INTEGER PRIMARY KEY \(rowid>\?\)/)
		expect(seen.live![0]).toMatch(/SCAN announcements USING COVERING INDEX announcements_published/)
		expect(seen.live![0]).toMatch(/(SCAN|SEARCH) announcements USING COVERING INDEX announcements_scheduled/)
		expect(seen.total![0]).toMatch(/SCAN announcements USING COVERING INDEX/)
	}, 120_000)
})
