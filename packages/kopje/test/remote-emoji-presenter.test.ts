import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { MASTODON, mastodonActor } from './inbox-helpers'
import { create, followed, mastodonNote } from './inbox-status-helpers'
import { scansOf, staleStatistics } from './read-helpers'
import { emojiTag, mediaWorld, noteEmoji, snapshot } from './remote-media-helpers'
import { emojiCacheOf, presentEmojis } from '../src/domain/custom-emojis'
import { EMOJI_CACHE_LIMIT, emojiCacheSql, STATUS_EMOJIS_BYTES } from '../src/platform/stored-bounds'

// The presented custom emoji over the cache (custom-emojis.ts emojiCacheOf and presentEmojis, platform/stored-bounds.ts
// emojiCacheSql): the cached copies of a row's first entries, read with the row, and the remote URLs of the rest.

const ORIGIN = 'https://kopje.test'

describe('the presented emoji', () => {
	it('show the cached file and its still for the first entries, the remote URL past them or uncached', async () => {
		const w = await mediaWorld()
		const bob = await mastodonActor(w.t.web, 'bob')
		await followed(w.t, bob)
		const names = Array.from({ length: EMOJI_CACHE_LIMIT + 2 }, (_, i) => `e${i}`)
		const tags = names.map((name) => emojiTag(name))
		const content = `<p>${names.map((name) => `:${name}:`).join(' ')}</p>`
		const posted = mastodonNote(bob, { content, tag: tags })
		expect(await w.t.post(bob, create(bob, posted))).toBe(202)
		// Every emoji cached but the second.
		await sql(
			w.t.store,
			`UPDATE remote_media SET token = lower(hex(randomblob(32))), ext = 'gif', still_ext = 'png', stored_at = 1,
				due_at = NULL WHERE kind = 'emoji' AND url <> ?`,
			`${MASTODON}/emoji/e1.png`
		)
		await sql(
			w.t.store,
			'UPDATE remote_media_usage SET pending = (SELECT count(*) FROM remote_media WHERE due_at IS NOT NULL)'
		)
		const [row] = await sql<{ id: string }>(w.t.store, 'SELECT id FROM statuses WHERE uri = ?', posted.id)
		const { body } = await w.t.api<{ emojis: { shortcode: string; url: string; static_url: string }[] }>(
			`/api/v1/statuses/${row!.id}`
		)
		const tokens = new Map(
			(
				await sql<{ url: string; token: string }>(
					w.t.store,
					"SELECT url, token FROM remote_media WHERE kind = 'emoji' AND token IS NOT NULL"
				)
			).map((s) => [s.url, s.token])
		)
		expect(body.emojis).toHaveLength(names.length)
		body.emojis.forEach((emoji, i) => {
			const remote = `${MASTODON}/emoji/${emoji.shortcode}.png`
			const token = tokens.get(remote)
			if (i < EMOJI_CACHE_LIMIT && token !== undefined) {
				expect(emoji).toMatchObject({
					url: `${ORIGIN}/media/r/${token}/full.gif`,
					static_url: `${ORIGIN}/media/r/${token}/still.png`,
				})
			} else {
				expect(emoji, emoji.shortcode).toMatchObject({ url: remote, static_url: remote })
			}
		})
		expect(body.emojis[1]!.url).toBe(`${MASTODON}/emoji/e1.png`)
		expect(body.emojis[EMOJI_CACHE_LIMIT]!.url).toBe(`${MASTODON}/emoji/e${EMOJI_CACHE_LIMIT}.png`)
	})

	it('show a poll’s cached emoji alone and in a vote’s answer as in its status', async () => {
		const w = await mediaWorld()
		const bob = await mastodonActor(w.t.web, 'bob')
		await followed(w.t, bob)
		const question = mastodonNote(bob, {
			type: 'Question',
			content: '<p>which :q:</p>',
			endTime: '2099-01-01T00:00:00Z',
			oneOf: [
				{ type: 'Note', name: ':yes: yes', replies: { type: 'Collection', totalItems: 0 } },
				{ type: 'Note', name: 'no', replies: { type: 'Collection', totalItems: 0 } },
			],
			tag: [emojiTag('q'), emojiTag('yes')],
		})
		expect(await w.t.post(bob, create(bob, question))).toBe(202)
		await sql(
			w.t.store,
			`UPDATE remote_media SET token = lower(hex(randomblob(32))), ext = 'gif', still_ext = 'png', stored_at = 1,
				due_at = NULL WHERE kind = 'emoji'`
		)
		await sql(w.t.store, 'UPDATE remote_media_usage SET pending = 0')
		const [row] = await sql<{ id: string }>(w.t.store, 'SELECT id FROM statuses WHERE uri = ?', question.id)
		type Shown = { url: string; static_url: string }
		const { body: status } = await w.t.api<{ poll: { id: string; emojis: Shown[] } }>(`/api/v1/statuses/${row!.id}`)
		expect(status.poll.emojis).toHaveLength(1)
		expect(status.poll.emojis[0]!.url).toMatch(/^https:\/\/kopje\.test\/media\/r\/[0-9a-f]{64}\/full\.gif$/)
		const alone = await w.t.api<{ emojis: Shown[] }>(`/api/v1/polls/${status.poll.id}`)
		expect(alone.body.emojis).toEqual(status.poll.emojis)
		const voted = await w.t.request(`/api/v1/polls/${status.poll.id}/votes`, {
			method: 'POST',
			headers: { authorization: `Bearer ${w.t.tokens.alice}`, 'content-type': 'application/x-www-form-urlencoded' },
			body: 'choices[]=0',
		})
		expect(voted.status).toBe(200)
		expect(((await voted.json()) as { emojis: Shown[] }).emojis).toEqual(status.poll.emojis)
	})

	it('admits entries by the presented local URL, within the snapshot’s byte bound', () => {
		const remote = 'https://a.co/e.png'
		const stored = JSON.stringify(Array.from({ length: 64 }, (_, i) => [`e${i}`, `${remote}?${i}`]))
		const packed = `${'T'.repeat(64)}:webp:webp`
		const cache = emojiCacheOf(JSON.stringify(Array.from({ length: EMOJI_CACHE_LIMIT }, (_, i) => [i, packed])), ORIGIN)
		const plain = presentEmojis(stored, 2_000)
		const cached = presentEmojis(stored, 2_000, cache)
		// The local URLs are longer, so fewer entries fit the same bound.
		expect(cached.length).toBeLessThan(plain.length)
		expect(JSON.stringify(cached).length).toBeLessThanOrEqual(2_000)
		expect(JSON.stringify(presentEmojis(stored, STATUS_EMOJIS_BYTES, cache)).length).toBeLessThanOrEqual(
			STATUS_EMOJIS_BYTES
		)
		expect(cached[0]).toMatchObject({ url: `${ORIGIN}/media/r/${'T'.repeat(64)}/full.webp` })
	})

	it('reads an entry past the limit, or a malformed cache, as the remote URL', () => {
		const stored = JSON.stringify([['a', 'https://a.co/a.png']])
		for (const value of ['not json', '[[0,"bad"]]', `[[${EMOJI_CACHE_LIMIT},"${'T'.repeat(43)}:png:"]]`, '{}']) {
			const shown = presentEmojis(stored, STATUS_EMOJIS_BYTES, emojiCacheOf(value, ORIGIN))
			expect(shown, value).toEqual([
				{ shortcode: 'a', url: 'https://a.co/a.png', static_url: 'https://a.co/a.png', visible_in_picker: true },
			])
		}
	})

	it(
		'reads a row’s cached emoji with its row, one seek of remote_media_emoji an entry, after ANALYZE and growth',
		{ timeout: 120_000 },
		async () => {
			const w = await mediaWorld()
			const emojis = snapshot(...Array.from({ length: 20 }, (_, i) => `https://a.example/e/${i}.png`))
			await sql(
				w.t.store,
				"INSERT INTO accounts (id, uri, username, domain, emojis) VALUES ('699999999999999990', 'https://a.example/u', 'u', 'a.example', ?)",
				emojis
			)
			await noteEmoji(w, emojis, 'a.example')
			await sql(
				w.t.store,
				"UPDATE remote_media SET token = lower(hex(randomblob(32))), ext = 'png', stored_at = 1, due_at = NULL WHERE kind = 'emoji'"
			)
			const query = `SELECT ${emojiCacheSql('a.emojis', 'a.domain')} AS cache FROM accounts a WHERE a.id = '699999999999999990'`
			const capture = async () => ({
				plan: (await sql<{ detail: string }>(w.t.store, `EXPLAIN QUERY PLAN ${query}`)).map((r) => r.detail),
				cache: JSON.parse((await sql<{ cache: string }>(w.t.store, query))[0]!.cache) as [number, string][],
			})
			const { before, after } = await staleStatistics(w.t, {
				capture,
				grow: () =>
					// 20,000 emoji slots of other domains, stored.
					sql(
						w.t.store,
						`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
						INSERT INTO remote_media (kind, domain, url, host, category, lane, generation, enqueued_at, seen_at, token,
							ext, stored_at)
						SELECT 'emoji', 'g' || (i % 50) || '.example', 'https://g.example/' || i || '.png', 'g.example', 'image', 0,
							0, 1, 1, printf('G%042d', i), 'png', 1 FROM n`
					),
			})
			for (const { plan, cache } of [before, after]) {
				expect(scansOf(plan, ['ce', 'remote_media']), plan.join('\n')).toEqual([])
				expect(plan.join('\n')).toContain('remote_media_emoji')
				// The first EMOJI_CACHE_LIMIT entries only, in snapshot order.
				expect(cache.map(([index]) => index)).toEqual(Array.from({ length: EMOJI_CACHE_LIMIT }, (_, i) => i))
			}
		}
	)
})
