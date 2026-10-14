import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { NOW } from './app-helpers'
import { migratedStore } from './helpers'
import { accountId, statusId, worldArb, writeWorld } from './policy-world'
import { rowsRead } from './read-helpers'
import { type Page, type PageQuery } from '../src/domain/accounts'
import { listableSql } from '../src/domain/audience'
import type { Status } from '../src/domain/status-presenter'
import { normalizeTag } from '../src/domain/tag-name'
import { tagTimeline, type TagTimelineInput } from '../src/domain/timelines'

// The hashtag timeline reads each name in status id order from the index of public hashtags and stops at a page
// (RES-7), and shows what the query it replaced showed: the same statuses, in the same order, page by page.

const PRESENT = { origin: 'https://kopje.test' }
const TOKEN_PREFIX = 'tag-timeline-token-'
const MEDIA_BASE = 500000000000000000n

type Query = Pick<TagTimelineInput, 'tag' | 'any' | 'all' | 'none' | 'local' | 'remote' | 'onlyMedia'>

const QUERIES: Query[] = [
	{ tag: 'cats', any: [], all: [], none: [], local: false, remote: false, onlyMedia: false },
	{ tag: 'CATS', any: ['dogs'], all: [], none: [], local: false, remote: false, onlyMedia: false },
	{ tag: 'dogs', any: ['birds', 'cats'], all: [], none: ['birds'], local: false, remote: false, onlyMedia: false },
	{ tag: 'cats', any: ['dogs'], all: ['birds'], none: [], local: false, remote: false, onlyMedia: false },
	{ tag: 'cats', any: ['dogs'], all: [], none: [], local: true, remote: false, onlyMedia: false },
	{ tag: 'cats', any: ['birds'], all: [], none: [], local: false, remote: true, onlyMedia: true },
]

// A list of names as the query binds it: normalized, each once.
const unique = (names: string[]) => JSON.stringify([...new Set(names.map(normalizeTag))])

// The query before the per-name reads, as it was, with publicConditions spelled out.
function previousSql(q: Query, ascending: boolean): string {
	return `SELECT s.id FROM statuses s JOIN accounts pa ON pa.id = s.account_id
		WHERE s.id IN (SELECT status_id FROM status_tags WHERE name IN (SELECT value FROM json_each(?5)))
			AND NOT EXISTS (SELECT 1 FROM json_each(?6) t
				WHERE NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id AND st.name = t.value))
			AND NOT EXISTS (SELECT 1 FROM status_tags st WHERE st.status_id = s.id AND st.name IN (SELECT value FROM json_each(?7)))
			AND s.visibility = 'public' AND s.reblog_of_id IS NULL
			${q.local ? 'AND pa.domain IS NULL' : ''} ${q.remote ? 'AND pa.domain IS NOT NULL' : ''}
			${q.onlyMedia ? 'AND EXISTS (SELECT 1 FROM media_attachments pm WHERE pm.status_id = s.id)' : ''}
			AND ${listableSql('s', '?1', '?8')}
			AND (?2 IS NULL OR s.id < ?2) AND (?3 IS NULL OR s.id > ?3)
		ORDER BY s.id ${ascending ? 'ASC' : 'DESC'} LIMIT ?4`
}

function pageOf(output: unknown): Page<Status> {
	const result = output as { status: string; value: Page<Status> }
	expect(result.status).toBe('ok')
	return result.value
}

describe('hashtag timeline', () => {
	it('shows what the previous query showed, page by page in both directions, on mixed worlds', async () => {
		const store = await migratedStore()
		const worlds = fc.sample(worldArb, { numRuns: 25, seed: 20261016 })
		await runInDurableObject(store, (_instance, state) => {
			const sql = state.storage.sql
			let compared = 0
			for (const world of worlds) {
				sql.exec('DELETE FROM oauth_tokens')
				sql.exec('DELETE FROM oauth_clients')
				sql.exec('DELETE FROM media_attachments')
				writeWorld(sql, world)
				// More hashtags, on originals and boosts alike, marked as the writers mark them; media on some statuses.
				world.statuses.forEach((status, i) => {
					const names = [...(i % 3 === 0 ? ['dogs'] : []), ...(i % 4 === 1 ? ['birds'] : [])]
					for (const name of names) {
						sql.exec(
							'INSERT INTO status_tags (status_id, name, public) VALUES (?, ?, ?)',
							statusId(i),
							name,
							status.visibility === 'public' ? 1 : 0
						)
					}
					if (i % 2 === 0) {
						sql.exec(
							"INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES (?, ?, ?, 'image', 'u')",
							String(MEDIA_BASE + BigInt(i)),
							accountId(status.author),
							statusId(i)
						)
					}
				})
				sql.exec(
					"INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('c', 's', 'n', 'urn:ietf:wg:oauth:2.0:oob', 'read')"
				)
				const now = Date.parse(world.now)
				const viewers: (number | null)[] = [null]
				world.accounts.forEach((account, x) => {
					if (account.local && !account.suspended) {
						sql.exec(
							"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'c', ?, 'read')",
							`${TOKEN_PREFIX}${x}`,
							accountId(x)
						)
						viewers.push(x)
					}
				})
				for (const viewer of viewers) {
					const credential = viewer === null ? null : { tokenHash: `${TOKEN_PREFIX}${viewer}`, scope: 'read', now }
					for (const q of QUERIES) {
						const previous = (page: PageQuery) => {
							const ascending = page.minId !== undefined
							const ids = sql
								.exec<{ id: string }>(
									previousSql(q, ascending),
									viewer === null ? null : accountId(viewer),
									page.maxId ?? null,
									page.minId ?? null,
									page.limit,
									unique([q.tag, ...q.any]),
									unique(q.all),
									unique(q.none),
									world.now
								)
								.toArray()
								.map((row) => row.id)
							return ascending ? ids.reverse() : ids
						}
						const current = (page: PageQuery) =>
							pageOf(
								tagTimeline.run(sql, {
									...q,
									credential,
									now,
									page,
									present: PRESENT,
								} as never)
							).items.map((status) => status.id)
						// Every page down from the newest, then every page up from the oldest.
						let page: PageQuery = { limit: 2 }
						const all: string[] = []
						for (;;) {
							const ids = current(page)
							expect(ids, JSON.stringify({ q, viewer, page })).toEqual(previous(page))
							compared += ids.length
							all.push(...ids)
							if (ids.length < page.limit) {
								break
							}
							page = { limit: 2, maxId: ids.at(-1) }
						}
						expect(all).toEqual(previous({ limit: 40 }))
						page = { limit: 2, minId: '0' }
						for (;;) {
							const ids = current(page)
							expect(ids, JSON.stringify({ q, viewer, page })).toEqual(previous(page))
							if (ids.length < page.limit) {
								break
							}
							page = { limit: 2, minId: ids[0] }
						}
					}
				}
			}
			// The worlds show statuses, so the comparison is not of empty pages only.
			expect(compared).toBeGreaterThan(100)
		})
	}, 120_000)

	it('reads a page, however many public statuses the tags have (RES-7)', async () => {
		const BASE = 200000000000000000n
		const input = (q: Partial<Query>, page: PageQuery) => ({
			credential: null,
			now: NOW,
			page,
			present: PRESENT,
			tag: 'cats',
			any: [],
			all: [],
			none: [],
			local: false,
			remote: false,
			onlyMedia: false,
			...q,
		})
		const cases: [string, Partial<Query>, () => PageQuery][] = [
			['the newest page', {}, () => ({ limit: 20 })],
			['the newest page of any of three tags', { any: ['dogs', 'birds'] }, () => ({ limit: 20 })],
			// The same 80 statuses below the cursor, and 20 or 1,920 above it.
			['a page below a cursor', { any: ['dogs', 'birds'] }, () => ({ limit: 20, maxId: String(BASE + 80n) })],
			['a page up from the oldest', { any: ['dogs'] }, () => ({ limit: 20, minId: String(BASE) })],
		]
		const measure = async (count: number) => {
			const store = await migratedStore()
			// `count` public statuses of a remote account, ids from BASE up. They carry cats; every other one dogs too,
			// every third birds.
			await runInDurableObject(store, (_instance, state) => {
				const sql = state.storage.sql
				sql.exec(
					`INSERT INTO accounts (id, uri, username, domain)
					VALUES ('100000000000000001', 'https://remote.example/users/bob', 'bob', 'remote.example')`
				)
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(?1 + i AS TEXT), 'https://remote.example/s/' || (?1 + i), '100000000000000001', 'public', '<p>x</p>',
						'2026-10-01T00:00:00.000Z' FROM n`,
					String(BASE),
					count
				)
				sql.exec("INSERT INTO status_tags (status_id, name, public) SELECT id, 'cats', 1 FROM statuses")
				sql.exec(
					"INSERT INTO status_tags (status_id, name, public) SELECT id, 'dogs', 1 FROM statuses WHERE CAST(id AS INTEGER) % 2 = 0"
				)
				sql.exec(
					"INSERT INTO status_tags (status_id, name, public) SELECT id, 'birds', 1 FROM statuses WHERE CAST(id AS INTEGER) % 3 = 0"
				)
			})
			const reads: number[] = []
			for (const [, q, page] of cases) {
				const shown = await runInDurableObject(
					store,
					(_instance, state) => pageOf(tagTimeline.run(state.storage.sql, input(q, page()) as never)).items.length
				)
				expect(shown).toBe(20)
				reads.push(await rowsRead({ store }, tagTimeline, input(q, page()) as never))
			}
			return reads
		}
		const few = await measure(100)
		const many = await measure(2000)
		const grown = cases.flatMap(([name], i) =>
			(many[i] ?? 0) > (few[i] ?? 0) + 10 ? [`${name}: ${few[i]} -> ${many[i]}`] : []
		)
		expect(grown).toEqual([])
	}, 60_000)
})
