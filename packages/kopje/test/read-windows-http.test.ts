import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer } from './api-helpers'
import { NOW } from './app-helpers'
import { community, post, type User } from './status-helpers'

// Candidate windows through the routes (src/domain/windows.ts, docs/visibility.md "Read bounds"): an empty page cut at
// its window still answers the Link that moves on, so a client following Link reaches the visible rows behind a hidden
// range. The world: alice and one status of hers; 30 older remote accounts, `hidden` accounts alice and bob mute (bob
// reads alice's followers and following, which she sees whole), and 5 newer
// accounts, each in that order following alice, followed by her, favouriting and boosting her status, and notifying her
// of a follow.

const OLDER = 30
const NEWER = 5
const OLDER_BASE = 710000000000000000n
const HIDDEN_BASE = 720000000000000000n
const NEWER_BASE = 730000000000000000n
const ids = (base: bigint, count: number) => Array.from({ length: count }, (_, i) => String(base + BigInt(i)))

async function world(hidden: number): Promise<{ h: ApiHarness; alice: User; bob: User; status: string }> {
	const h = await community(['alice', 'bob'])
	const { alice, bob } = h.users
	const status = (await post(h, alice, { status: 'hello' })).id
	await runInDurableObject(h.store, (_instance, state) => {
		const sql = state.storage.sql
		const at = new Date(NOW).toISOString()
		for (const [base, count, boosts] of [
			[OLDER_BASE, OLDER, 750000000000000000n],
			[HIDDEN_BASE, hidden, 760000000000000000n],
			[NEWER_BASE, NEWER, 770000000000000000n],
		] as const) {
			const each = (query: string, ...params: SqlStorageValue[]) =>
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1) ${query}`,
					count,
					String(base),
					...params
				)
			each(
				`INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?2 + i AS TEXT), 'https://far.example/users/u' || (?2 + i), 'u' || (?2 + i), 'far.example' FROM n`
			)
			each(
				`INSERT INTO follows (account_id, target_account_id, state) SELECT CAST(?2 + i AS TEXT), ?3, 'accepted' FROM n`,
				alice.id
			)
			each(
				`INSERT INTO follows (account_id, target_account_id, state) SELECT ?3, CAST(?2 + i AS TEXT), 'accepted' FROM n`,
				alice.id
			)
			each('INSERT INTO favourites (account_id, status_id) SELECT CAST(?2 + i AS TEXT), ?3 FROM n', status)
			each(
				`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, reblog_of_id)
				SELECT CAST(?3 + i AS TEXT), 'https://far.example/boosts/' || (?3 + i), CAST(?2 + i AS TEXT), 'public', '', ?4, ?5
				FROM n`,
				String(boosts),
				at,
				status
			)
			each(
				`INSERT INTO notifications (account_id, type, from_account_id) SELECT ?3, 'follow', CAST(?2 + i AS TEXT) FROM n`,
				alice.id
			)
			if (base === HIDDEN_BASE) {
				for (const viewer of [alice.id, bob.id]) {
					each('INSERT INTO mutes (account_id, target_account_id) SELECT ?3, CAST(?2 + i AS TEXT) FROM n', viewer)
				}
			}
		}
	})
	return { h, alice, bob, status }
}

function linkOf(response: Response, rel: 'next' | 'prev'): string | null {
	const header = response.headers.get('link') ?? ''
	const match = new RegExp(`<([^>]+)>; rel="${rel}"`).exec(header)
	if (match?.[1] === undefined) {
		return null
	}
	const url = new URL(match[1])
	return url.pathname + url.search
}

// Every page from `path`, following the `rel` link, with the account ids each page shows in the order it shows them.
async function follow(
	h: ApiHarness,
	token: string,
	path: string,
	rel: 'next' | 'prev',
	accounts: (body: unknown) => string[]
): Promise<{ pages: string[][]; empty: number }> {
	const pages: string[][] = []
	let empty = 0
	let next: string | null = path
	while (next !== null) {
		expect(pages.length).toBeLessThan(200)
		const response = await h.request(next, bearer(token))
		expect(response.status).toBe(200)
		const shown = accounts(await response.json())
		pages.push(shown)
		empty += shown.length === 0 ? 1 : 0
		next = linkOf(response, rel)
		if (rel === 'prev' && shown.length === 0 && next === null) {
			break
		}
	}
	return { pages, empty }
}

const listed = (body: unknown) => (body as { id: string }[]).map((account) => account.id)
const notified = (body: unknown) => (body as { account: { id: string } }[]).map((n) => n.account.id)
const grouped = (body: unknown) =>
	(body as { notification_groups: { sample_account_ids: string[] }[] }).notification_groups.flatMap(
		(group) => group.sample_account_ids
	)

describe('routes answer the Link of a page cut at its window', () => {
	it('pages notifications, followers, following and interactors through 1,000 muted accounts by the next link', async () => {
		const { h, alice, bob, status } = await world(1_000)
		const expected = [...ids(NEWER_BASE, NEWER).reverse(), ...ids(OLDER_BASE, OLDER).reverse()]
		for (const [path, accounts, reader] of [
			['/api/v1/notifications', notified, alice],
			[`/api/v1/accounts/${alice.id}/followers`, listed, bob],
			[`/api/v1/accounts/${alice.id}/following`, listed, bob],
			[`/api/v1/statuses/${status}/favourited_by`, listed, alice],
			[`/api/v1/statuses/${status}/reblogged_by`, listed, alice],
		] as const) {
			const { pages, empty } = await follow(h, reader.token, path, 'next', accounts)
			expect([path, pages.flat()]).toEqual([path, expected])
			// Pages inside the muted range were empty, and their next link still led on.
			expect([path, empty > 0]).toEqual([path, true])
		}
	}, 120_000)

	it('pages grouped notifications through 2,000 hidden ones in both directions', async () => {
		const { h, alice } = await world(2_000)
		const older = await follow(h, alice.token, '/api/v2/notifications', 'next', grouped)
		expect(older.pages.flat()).toEqual([...ids(NEWER_BASE, NEWER).reverse(), ...ids(OLDER_BASE, OLDER).reverse()])
		expect(older.empty).toBeGreaterThan(0)
		// Walking up from just above the older notifications: the hidden range, then the newer ones.
		const lastOlder = (
			await runInDurableObject(h.store, (_instance, state) =>
				state.storage.sql
					.exec<{ id: string }>(
						'SELECT CAST(max(id) AS TEXT) AS id FROM notifications WHERE from_account_id < ?',
						String(HIDDEN_BASE)
					)
					.toArray()
			)
		)[0]?.id
		const newer = await follow(h, alice.token, `/api/v2/notifications?min_id=${lastOlder}`, 'prev', grouped)
		expect(newer.pages.flat().sort()).toEqual(ids(NEWER_BASE, NEWER))
		expect(newer.empty).toBeGreaterThan(0)
	}, 120_000)
})
