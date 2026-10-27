import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { blockDomain } from './domain-block-helpers'
import { JPEG_SERIAL } from './fixtures/images'
import { MASTODON, mastodonActor } from './inbox-helpers'
import { create, followed, mastodonNote, update } from './inbox-status-helpers'
import { bytes } from './media-helpers'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { GIF, mediaWorld, type MediaWorld } from './remote-media-helpers'
import {
	EMOJI_SEEN_STEP_MS,
	EMOJI_UNSEEN_MS,
	FAILED_RESET_MS,
	maintainRemoteMedia,
	noteEmojiSnapshot,
	REMOTE_MEDIA_PENDING_LIMIT,
	STATUS_BACKFILL_WINDOW,
} from '../src/domain/remote-media'

// Remote custom emoji in the cache of remote media (domain/remote-media.ts noteEmojiSnapshot, the (domain, url) slots,
// the backfill's emoji phases, the round): what is enqueued from the three writers of a remote snapshot, what a domain
// block and time retire, and what the round stores. Their presentation: test/remote-emoji-presenter.test.ts.

const CAP = 4 * 1024 * 1024 * 1024
const MASTODON_HOST = new URL(MASTODON).host

const emojiTag = (name: string, url = `${MASTODON}/emoji/${name}.png`) => ({
	id: `${MASTODON}/emojis/${name}`,
	type: 'Emoji',
	name: `:${name}:`,
	updated: '2026-10-01T00:00:00Z',
	icon: { type: 'Image', mediaType: 'image/png', url },
})

type EmojiSlot = { domain: string; url: string; due_at: number | null; failed_at: number | null; seen_at: number }

const emojiSlots = (w: MediaWorld) =>
	sql<EmojiSlot>(
		w.t.store,
		"SELECT domain, url, due_at, failed_at, seen_at FROM remote_media WHERE kind = 'emoji' ORDER BY domain, url"
	)

const snapshot = (...urls: string[]) => JSON.stringify(urls.map((url, i) => [`e${i}`, url]))

const note = (w: MediaWorld, value: string | null, domain: string | null, from?: number) =>
	w.db((d) => noteEmojiSnapshot(d, value, domain, w.clock.now, from === undefined ? {} : { from }))

const maintain = (w: MediaWorld, retentionDays = 14) =>
	w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt: null, cap: CAP, retentionDays })

// The backfill done for this release (as after its last pass), so only the writers enqueue.
const backfillDone = (w: MediaWorld) =>
	sql(
		w.t.store,
		`INSERT OR REPLACE INTO kopje_state (name, value)
		VALUES ('remote_media_backfill', '{"v":2,"phase":"statuses","cursor":"","partial":null,"done":true}')`
	)

describe('the writers of a remote snapshot', () => {
	it('enqueue the emoji of a stored Note, a newer Update and an Update(Person), by the author’s domain', async () => {
		const w = await mediaWorld()
		await backfillDone(w)
		const bob = await mastodonActor(w.t.web, 'bob')
		await followed(w.t, bob)
		const first = mastodonNote(bob, { content: '<p>:one:</p>', tag: [emojiTag('one')] })
		expect(await w.t.post(bob, create(bob, first))).toBe(202)
		expect((await emojiSlots(w)).map((s) => [s.domain, s.url])).toEqual([[MASTODON_HOST, `${MASTODON}/emoji/one.png`]])
		// An Update introducing an unseen URL enqueues it.
		const edited = { ...first, content: '<p>:one: :two:</p>', tag: [emojiTag('one'), emojiTag('two')] }
		expect(await w.t.post(bob, update(bob, edited, '2026-10-11T12:10:00Z'))).toBe(202)
		// So does the actor's document, stored on Update(Person).
		const document = { ...bob.document, name: 'bob :three:', tag: [emojiTag('three')] }
		w.t.web.serve(bob.uri, document)
		const person = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			type: 'Update',
			id: `${bob.uri}#update`,
			actor: bob.uri,
			object: document,
		}
		expect(await w.t.post(bob, person)).toBe(202)
		expect((await emojiSlots(w)).map((s) => s.url)).toEqual(
			['one', 'three', 'two'].map((name) => `${MASTODON}/emoji/${name}.png`)
		)
		expect((await emojiSlots(w)).every((s) => s.domain === MASTODON_HOST && s.due_at !== null)).toBe(true)
		await w.exact()
	})
})

describe('emoji slots (noteEmojiSnapshot)', () => {
	it('keeps one slot a domain and url, in either arrival order, and a block of one domain retires only its own', async () => {
		const w = await mediaWorld()
		const url = 'https://files.example/shared.png'
		await note(w, snapshot(url), 'a.example')
		await note(w, snapshot(url), 'b.example')
		const w2 = await mediaWorld()
		await note(w2, snapshot(url), 'b.example')
		await note(w2, snapshot(url), 'a.example')
		for (const world of [w, w2]) {
			expect((await emojiSlots(world)).map((s) => [s.domain, s.url])).toEqual([
				['a.example', url],
				['b.example', url],
			])
			await blockDomain(world.t.store, 'b.example', 'suspend')
			expect((await maintain(world)).counts.retired).toBe(1)
			expect((await emojiSlots(world)).map((s) => s.domain)).toEqual(['a.example'])
			// Nothing more is enqueued for the blocked domain.
			await note(world, snapshot('https://files.example/other.png'), 'b.example')
			expect((await emojiSlots(world)).map((s) => s.domain)).toEqual(['a.example'])
			await world.exact()
		}
	})

	it('enqueues nothing for a local or unset domain, a covered host or a URL the fetch refuses', async () => {
		const w = await mediaWorld()
		await blockDomain(w.t.store, 'blocked.example', 'suspend')
		await note(w, snapshot('https://files.example/a.png'), null)
		await note(
			w,
			snapshot('http://files.example/plain.png', 'https://blocked.example/b.png', 'https://kopje.test/own.png'),
			'a.example'
		)
		expect(await emojiSlots(w)).toEqual([])
		await w.exact()
	})

	it('resets a failed emoji at a later sighting after a day, within the pending limit only', async () => {
		const w = await mediaWorld()
		const url = 'https://files.example/fails.png'
		await note(w, snapshot(url), 'a.example')
		await sql(w.t.store, "UPDATE remote_media SET due_at = NULL, failed_at = ? WHERE kind = 'emoji'", w.clock.now)
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = pending - 1')
		// Within the day: it stays failed.
		w.clock.now += FAILED_RESET_MS - 1
		await note(w, snapshot(url), 'a.example')
		expect((await emojiSlots(w))[0]).toMatchObject({ due_at: null })
		// At the pending limit: it stays failed, until a sighting below it.
		w.clock.now += 2
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = ?', REMOTE_MEDIA_PENDING_LIMIT)
		await note(w, snapshot(url), 'a.example')
		expect((await emojiSlots(w))[0]).toMatchObject({ due_at: null })
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = 0')
		await note(w, snapshot(url), 'a.example')
		expect((await emojiSlots(w))[0]).toMatchObject({ due_at: w.clock.now, failed_at: null })
		await w.exact()
	})

	it('records a sighting at most once a day, and retires an emoji unseen for 90 days', async () => {
		const w = await mediaWorld()
		const url = 'https://files.example/seen.png'
		const start = w.clock.now
		await note(w, snapshot(url), 'a.example')
		w.clock.now += EMOJI_SEEN_STEP_MS
		await note(w, snapshot(url), 'a.example')
		expect((await emojiSlots(w))[0]!.seen_at).toBe(start)
		w.clock.now += 1
		await note(w, snapshot(url), 'a.example')
		const seen = w.clock.now
		expect((await emojiSlots(w))[0]!.seen_at).toBe(seen)
		w.clock.now = seen + EMOJI_UNSEEN_MS
		expect((await maintain(w)).counts.retired).toBe(0)
		w.clock.now += 1
		await sql(w.t.store, "UPDATE kopje_state SET value = '0' WHERE name = 'remote_media_walk'")
		expect((await maintain(w)).counts.retired).toBe(1)
		expect(await emojiSlots(w)).toEqual([])
		await w.exact()
	})
})

describe('the backfill of emoji', () => {
	const backfill = async (w: MediaWorld) =>
		JSON.parse(
			(
				await sql<{ value: string }>(w.t.store, "SELECT value FROM kopje_state WHERE name = 'remote_media_backfill'")
			)[0]!.value
		) as { v: number; phase: string; cursor: string; partial: { id: string; at: number } | null; done: boolean }

	it('starts again after the profile pass, covers emoji-only accounts and remote statuses arrived within retention', async () => {
		const w = await mediaWorld()
		// The profile images' pass of the earlier release, finished.
		await sql(
			w.t.store,
			`INSERT OR REPLACE INTO kopje_state (name, value)
			VALUES ('remote_media_backfill', '{"v":1,"cursor":"000000000000000001","done":true}')`
		)
		// An account with emoji and no profile image, rows as an import or a conversion leaves them.
		await sql(
			w.t.store,
			"INSERT INTO accounts (id, uri, username, domain, emojis) VALUES ('699999999999999990', 'https://a.example/u', 'u', 'a.example', ?)",
			snapshot('https://a.example/e/account.png')
		)
		// Retention is judged by arrival (created_at), not by the id `published` gave: an old post that arrived a minute
		// ago is taken, a recent one that arrived a month ago is not.
		const idAt = (ms: number) => (BigInt(ms) << 16n).toString()
		const minuteAgo = w.clock.now - 60_000
		const monthAgo = w.clock.now - 30 * 24 * 60 * 60 * 1000
		for (const [id, arrived, url] of [
			[idAt(monthAgo), minuteAgo, 'https://a.example/e/old-published.png'],
			[idAt(minuteAgo), monthAgo, 'https://a.example/e/old-arrival.png'],
		] as const) {
			await sql(
				w.t.store,
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at, emojis)
				VALUES (?1, 'https://a.example/s/' || ?1, '699999999999999990', 'public', '<p>x</p>', '2026-10-01T00:00:00.000Z',
					?2, ?3)`,
				id,
				new Date(arrived).toISOString(),
				snapshot(url)
			)
		}
		for (let i = 0; i < 5; i++) {
			await maintain(w, 14)
			const state = await backfill(w)
			if (state.v === 2 && state.done) {
				break
			}
		}
		expect(await backfill(w)).toMatchObject({ v: 2, done: true })
		expect((await emojiSlots(w)).map((s) => s.url)).toEqual([
			'https://a.example/e/account.png',
			'https://a.example/e/old-published.png',
		])
		await w.exact()
	})

	it.each(['account', 'status'] as const)(
		'walks a %s snapshot an Update replaced after the stop from its first entry',
		async (kind) => {
			const w = await mediaWorld()
			const before = Array.from({ length: 6 }, (_, i) => `https://a.example/e/before-${i}.png`)
			const after = Array.from({ length: 6 }, (_, i) => `https://a.example/e/after-${i}.png`)
			await sql(
				w.t.store,
				"INSERT INTO accounts (id, uri, username, domain, emojis) VALUES ('699999999999999990', 'https://a.example/u', 'u', 'a.example', ?)",
				kind === 'account' ? snapshot(...before) : null
			)
			const status = (BigInt(w.clock.now) << 16n).toString()
			if (kind === 'status') {
				await sql(
					w.t.store,
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at, emojis)
					VALUES (?1, 'https://a.example/s/1', '699999999999999990', 'public', '<p>x</p>', ?2, ?2, ?3)`,
					status,
					new Date(w.clock.now).toISOString(),
					snapshot(...before)
				)
				// The accounts phase done first.
				await maintain(w)
			}
			await sql(w.t.store, 'UPDATE remote_media_usage SET pending = ?', REMOTE_MEDIA_PENDING_LIMIT - 3)
			await maintain(w)
			expect((await backfill(w)).partial).toMatchObject({ at: 3 })
			// An Update replaces the snapshot while the backfill waits (its own enqueue stopped at the limit).
			await sql(
				w.t.store,
				kind === 'account'
					? 'UPDATE accounts SET emojis = ?2 WHERE id = ?1'
					: 'UPDATE statuses SET emojis = ?2 WHERE id = ?1',
				kind === 'account' ? '699999999999999990' : status,
				snapshot(...after)
			)
			await sql(w.t.store, 'UPDATE remote_media_usage SET pending = 3')
			await maintain(w)
			// Every entry of the new snapshot is enqueued, its first three included.
			expect((await emojiSlots(w)).map((s) => s.url).filter((url) => url.includes('/after-'))).toEqual(after)
			await w.exact()
		}
	)

	it(
		'reads the statuses phase by its id window, retention a residual condition, after ANALYZE and growth',
		{ timeout: 120_000 },
		async () => {
			const w = await mediaWorld()
			await sql(
				w.t.store,
				"INSERT INTO accounts (id, uri, username, domain) VALUES ('699999999999999990', 'https://a.example/u', 'u', 'a.example')"
			)
			const statuses = (from: number, n: number, arrived: string) =>
				sql(
					w.t.store,
					`WITH RECURSIVE k(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM k WHERE i < ?1 + ?2 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, created_at, emojis)
					SELECT '1' || printf('%017d', i), 'https://a.example/s/' || i, '699999999999999990', 'public',
						'<p>x</p>', ?3, ?3, '[["a","https://a.example/e/a.png"]]' FROM k`,
					from,
					n,
					arrived
				)
			await statuses(1, 20, new Date(w.clock.now).toISOString())
			const phase = () =>
				sql(
					w.t.store,
					`INSERT OR REPLACE INTO kopje_state (name, value)
					VALUES ('remote_media_backfill', '{"v":2,"phase":"statuses","cursor":"9999999999999999999","partial":null,"done":false}')`
				)
			const capture = async () => {
				await phase()
				const { plans } = await plannedRun(w.t, /FROM statuses INDEXED BY/, maintainRemoteMedia, {
					now: w.clock.now,
					restoredAt: null,
					cap: CAP,
					retentionDays: 14,
				})
				return plans
			}
			const { before, after } = await staleStatistics(w.t, {
				capture,
				// 20,000 more statuses that arrived long ago, newer by id.
				grow: () => statuses(1000, 20_000, '2020-01-01T00:00:00.000Z'),
			})
			for (const plans of [before, after]) {
				expect(plans.length).toBeGreaterThanOrEqual(2)
				for (const { plan, rows } of plans) {
					// The window (w) is materialized, at most STATUS_BACKFILL_WINDOW ids, and sorted within that bound.
					expect(scansOf(plan, ['statuses', 's', 'au']), plan.join('\n')).toEqual([])
					// A window id, its status and its author each at most, whatever the Store holds besides.
					expect(rows).toBeLessThanOrEqual(3 * STATUS_BACKFILL_WINDOW + 1)
				}
			}
		}
	)

	it('stops inside a snapshot at the pending limit and resumes at the entry it stopped at', async () => {
		const w = await mediaWorld()
		const urls = Array.from({ length: 6 }, (_, i) => `https://a.example/e/${i}.png`)
		await sql(
			w.t.store,
			"INSERT INTO accounts (id, uri, username, domain, emojis) VALUES ('699999999999999990', 'https://a.example/u', 'u', 'a.example', ?)",
			snapshot(...urls)
		)
		// Room for three slots below the limit.
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = ?', REMOTE_MEDIA_PENDING_LIMIT - 3)
		await maintain(w)
		expect(await backfill(w)).toMatchObject({ phase: 'accounts', partial: { id: '699999999999999990', at: 3 } })
		expect((await emojiSlots(w)).map((s) => s.url)).toEqual(urls.slice(0, 3))
		// Room again a day later: the next round resumes at the fourth entry, not the first (the first three are not
		// sighted again).
		const first = (await emojiSlots(w)).map((s) => s.seen_at)
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = 3')
		w.clock.now += EMOJI_SEEN_STEP_MS + 1
		await maintain(w)
		const slots = await emojiSlots(w)
		expect(slots.map((s) => s.url)).toEqual(urls)
		expect(slots.slice(0, 3).map((s) => s.seen_at)).toEqual(first)
		expect((await backfill(w)).partial).toBeNull()
	})
})

describe('the round over emoji', () => {
	it('stores an emoji with its still, and fails a JPEG one for good', async () => {
		const w = await mediaWorld()
		const animated = 'https://files.example/e/animated.gif'
		const jpeg = 'https://files.example/e/photo.jpg'
		await note(w, snapshot(animated, jpeg), 'a.example')
		w.serve(animated, GIF)
		w.serve(jpeg, bytes(JPEG_SERIAL))
		const out = await w.round()
		expect(out).toMatchObject({ claimed: 2, stored: 1, failed: 1 })
		const slots = await sql<{ url: string; ext: string | null; still_ext: string | null; failed_at: number | null }>(
			w.t.store,
			"SELECT url, ext, still_ext, failed_at FROM remote_media WHERE kind = 'emoji' ORDER BY url"
		)
		expect(slots).toMatchObject([
			{ url: animated, ext: 'gif', still_ext: 'gif' },
			{ url: jpeg, ext: null, failed_at: expect.any(Number) as unknown },
		])
		await w.exact()
	})
})
