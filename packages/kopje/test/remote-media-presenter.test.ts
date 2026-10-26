import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { plannedSql, scansOf, staleStatistics, type PlannedStatement } from './read-helpers'
import { mediaWorld, type MediaWorld } from './remote-media-helpers'
import { Db } from '../src/db/sql'
import { ANSWER_CHUNK, MOVED_ACCOUNT_COLUMNS, partialAccountsOf, presentAccountById } from '../src/domain/accounts'
import {
	CACHED_IMAGE_BYTES,
	CACHED_IMAGE_COLUMNS,
	CACHED_IMAGE_KINDS,
	cachedImagesOf,
} from '../src/domain/remote-media'
import { statusRowBoundSql } from '../src/domain/status-rows'

// The account presenters over the cache (domain/accounts.ts, remote-media.ts cachedImagesOf): avatar, avatar_static,
// header and header_static from the cached files of a remote account's current URLs, read once a presentation chunk.

const ORIGIN = 'https://kopje.test'
let tokens = 0

// A stored slot of `kind` for the account, with its object (as a record leaves them), its still optional.
async function cache(w: MediaWorld, id: string, kind: 'avatar' | 'header', url: string, still: string | null = null) {
	const token = `P${String(++tokens).padStart(42, '0')}`
	await sql(
		w.t.store,
		`INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at, token, ext,
			still_ext, stored_at) VALUES (?1, ?2, ?2, ?3, 'files.example', 'image', 0, 0, 1, ?4, 'gif', ?5, 1)`,
		kind,
		id,
		url,
		token,
		still
	)
	return token
}

const present = (w: MediaWorld, id: string) => w.db((d) => presentAccountById(d, id, { origin: ORIGIN }))

describe('the account presenters', () => {
	it('show the cached files of the current URLs, the still as the static, and the remote URLs otherwise', async () => {
		const w = await mediaWorld()
		const a = await w.remote({ avatar: 'https://files.example/a.gif', header: 'https://files.example/h.gif' })
		await sql(w.t.store, 'DELETE FROM remote_media')
		expect(await present(w, a.id)).toMatchObject({
			avatar: a.avatar,
			avatar_static: a.avatar,
			header: a.header,
			header_static: a.header,
		})
		const avatar = await cache(w, a.id, 'avatar', a.avatar!, 'gif')
		const header = await cache(w, a.id, 'header', a.header!)
		expect(await present(w, a.id)).toMatchObject({
			avatar: `${ORIGIN}/media/r/${avatar}/full.gif`,
			avatar_static: `${ORIGIN}/media/r/${avatar}/still.gif`,
			header: `${ORIGIN}/media/r/${header}/full.gif`,
			header_static: `${ORIGIN}/media/r/${header}/full.gif`,
		})
		// A stale URL shows nothing cached: the account's avatar moved on before its slot did.
		await sql(w.t.store, "UPDATE accounts SET avatar_url = 'https://files.example/new.gif' WHERE id = ?", a.id)
		expect(await present(w, a.id)).toMatchObject({
			avatar: 'https://files.example/new.gif',
			header: `${ORIGIN}/media/r/${header}/full.gif`,
		})
		// An unavailable account shows the defaults, cached or not.
		await sql(
			w.t.store,
			"UPDATE accounts SET suspended_at = '2026-10-01T00:00:00.000Z', suspension_source = 'account' WHERE id = ?",
			a.id
		)
		expect(await present(w, a.id)).toMatchObject({
			avatar: `${ORIGIN}/assets/avatar.png`,
			header: `${ORIGIN}/assets/header.png`,
		})
	})

	it('show the cache for a moved-to account and for a partial account', async () => {
		const w = await mediaWorld()
		const target = await w.remote({ avatar: 'https://files.example/t.gif' })
		const source = await w.remote({ avatar: 'https://files.example/s.gif' })
		await sql(w.t.store, 'DELETE FROM remote_media')
		await sql(w.t.store, 'UPDATE accounts SET moved_to_account_id = ?2 WHERE id = ?1', source.id, target.id)
		const moved = await cache(w, target.id, 'avatar', target.avatar!)
		const own = await cache(w, source.id, 'avatar', source.avatar!)
		const presented = await present(w, source.id)
		expect(presented?.avatar).toBe(`${ORIGIN}/media/r/${own}/full.gif`)
		expect(presented?.moved?.avatar).toBe(`${ORIGIN}/media/r/${moved}/full.gif`)
		const partial = await w.db((d) => [...partialAccountsOf(d, [source.id], { origin: ORIGIN })])
		expect(partial[0]).toMatchObject({ avatar: `${ORIGIN}/media/r/${own}/full.gif` })
	})

	it('never shows a slot for a local account (ID-3)', async () => {
		const w = await mediaWorld()
		const local = (await sql<{ id: string }>(w.t.store, 'SELECT account_id AS id FROM local_accounts LIMIT 1'))[0]!.id
		await sql(w.t.store, "UPDATE accounts SET avatar_url = 'https://files.example/l.gif' WHERE id = ?", local)
		await sql(
			w.t.store,
			`INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, enqueued_at, token, ext,
				stored_at) VALUES ('avatar', ?1, ?1, 'https://files.example/l.gif', 'files.example', 'image', 0, 0, 1, ?2, 'gif', 1)`,
			local,
			'L'.repeat(43)
		)
		expect(await w.db((d) => cachedImagesOf(d, [local]))).toEqual(new Map())
	})
})

describe('the per-chunk lookup (cachedImagesOf)', () => {
	it(
		'reads one chunk with one statement of one seek a slot, after ANALYZE and growth',
		{ timeout: 120_000 },
		async () => {
			const w = await mediaWorld()
			const chunk: string[] = []
			for (let i = 0; i < 3; i++) {
				const a = await w.remote({
					avatar: `https://files.example/c${i}.gif`,
					header: `https://files.example/d${i}.gif`,
				})
				chunk.push(a.id)
			}
			await sql(w.t.store, 'DELETE FROM remote_media')
			for (const id of chunk) {
				const [row] = await sql<{ avatar_url: string; header_url: string }>(
					w.t.store,
					'SELECT avatar_url, header_url FROM accounts WHERE id = ?',
					id
				)
				await cache(w, id, 'avatar', row!.avatar_url)
				await cache(w, id, 'header', row!.header_url)
			}
			const capture = () =>
				runInDurableObject(w.t.store, (_instance, state) => {
					const plans: PlannedStatement[] = []
					const found = cachedImagesOf(new Db(plannedSql(state.storage.sql, /remote_media/, plans)), chunk)
					return { found: found.size, plans }
				})
			const { before, after } = await staleStatistics(
				{ store: w.t.store },
				{
					capture,
					grow: async () => {
						// 20,000 slots of other accounts, stored and pending.
						await sql(
							w.t.store,
							`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
					INSERT INTO remote_media (kind, owner_id, account_id, url, host, category, lane, generation, due_at,
						enqueued_at)
					SELECT k.kind, printf('7%017d', i), printf('7%017d', i), 'https://files.example/g/' || i, 'files.example',
						'image', 0, 0, 1, 1
					FROM n CROSS JOIN (SELECT 'avatar' AS kind UNION ALL SELECT 'header') k`
						)
					},
				}
			)
			for (const { found, plans } of [before, after]) {
				expect(found).toBe(chunk.length)
				expect(plans).toHaveLength(1)
				expect(scansOf(plans[0]!.plan, ['cm', 'remote_media', 'eac', 'accounts']), plans[0]!.plan.join('\n')).toEqual(
					[]
				)
				// Each id and kind: the ids and kinds read, one seek of remote_media_owner and one of accounts by its key;
				// a constant a chunk id, whatever the table holds.
				expect(plans[0]!.rows).toBeLessThanOrEqual(chunk.length * (1 + CACHED_IMAGE_KINDS.length * 5))
			}
		}
	)

	it('derives the bytes a chunk of accounts reads besides its rows from the caps', () => {
		// A chunk presents at most ANSWER_CHUNK accounts and their moved-to targets, each with one packed object a kind.
		const ids = 2 * ANSWER_CHUNK
		expect({ ids, packed: CACHED_IMAGE_BYTES, chunk: ids * CACHED_IMAGE_KINDS.length * CACHED_IMAGE_BYTES }).toEqual({
			ids: 100,
			packed: 74,
			chunk: 14_800,
		})
	})
})

describe('the status row bound (status-rows.ts statusRowBoundSql)', () => {
	it('counts a cached image row for each image URL a remote author shows, and every kind for its moved-to account', async () => {
		const w = await mediaWorld()
		const author = await w.remote({ avatar: 'https://files.example/a.gif', header: null })
		const target = await w.remote({ avatar: null, header: null })
		const status = '7' + '0'.repeat(17)
		await sql(
			w.t.store,
			"INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES (?1, 'https://files.example/s', ?2, 'public', ?3)",
			status,
			author.id,
			new Date(w.clock.now).toISOString()
		)
		const bound = async () =>
			(await sql<{ bytes: number }>(w.t.store, statusRowBoundSql(), JSON.stringify([status]), null, 0))[0]!.bytes
		const avatarOnly = await bound()
		const header = 'https://files.example/h.gif'
		await sql(w.t.store, 'UPDATE accounts SET header_url = ? WHERE id = ?', header, author.id)
		// The header's own column, and one cached row at its caps.
		expect((await bound()) - avatarOnly).toBe(2 * header.length + CACHED_IMAGE_COLUMNS.rowHeap)
		const both = await bound()
		await sql(w.t.store, 'UPDATE accounts SET moved_to_account_id = ? WHERE id = ?', target.id, author.id)
		expect((await bound()) - both).toBe(
			2 * String(target.id).length +
				MOVED_ACCOUNT_COLUMNS.rowHeap +
				CACHED_IMAGE_KINDS.length * CACHED_IMAGE_COLUMNS.rowHeap
		)
	})
})
