import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer } from './api-helpers'
import { NOW } from './app-helpers'
import { appToken } from './read-helpers'
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

describe('a group keeps the notification its walk found behind its hidden newest ones', () => {
	it('shows group A by its one visible notification below 400 hidden ones, on a page of two', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = (await post(h, alice, { status: 'hello' })).id
		await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			// A's senders: 400 alice mutes (600 to 999) and one she does not (599); B's sender (1000).
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 402 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?1 + i AS TEXT), 'https://far.example/users/g' || i, 'g' || i, 'far.example' FROM n`,
				String(HIDDEN_BASE)
			)
			const sender = (n: number) => String(HIDDEN_BASE + BigInt(n - 599))
			sql.exec(
				'INSERT INTO mutes (account_id, target_account_id) SELECT ?, id FROM accounts WHERE id > ? AND id <= ?',
				alice.id,
				sender(599),
				sender(999)
			)
			for (let n = 599; n <= 999; n++) {
				sql.exec(
					"INSERT INTO notifications (id, account_id, type, from_account_id, status_id, group_key) VALUES (?, ?, 'favourite', ?, ?, 'favourite-a')",
					n,
					alice.id,
					sender(n),
					status
				)
			}
			sql.exec(
				"INSERT INTO notifications (id, account_id, type, from_account_id, group_key) VALUES (1000, ?, 'follow', ?, 'follow-b')",
				alice.id,
				sender(1000)
			)
		})
		const response = await h.request('/api/v2/notifications?limit=2', bearer(alice.token))
		const body = await response.json<{
			notification_groups: { group_key: string; notifications_count: number; sample_account_ids: string[] }[]
		}>()
		expect(
			body.notification_groups.map(({ group_key, notifications_count, sample_account_ids }) => ({
				group_key,
				notifications_count,
				sample_account_ids,
			}))
		).toEqual([
			{ group_key: 'follow-b', notifications_count: 1, sample_account_ids: [String(HIDDEN_BASE + 401n)] },
			{ group_key: 'favourite-a', notifications_count: 1, sample_account_ids: [String(HIDDEN_BASE)] },
		])
	}, 60_000)
})

// The quotes list (R35) as an outsider reads it: a remote status quoted by 5 public statuses, then by 60 private, 60
// direct and 60 limited ones, newer, that the reader may not see. Neither a user token nor an app token learns their
// ids, in the body or the Link header, and following next reaches the public quotes.
describe('the quotes list never answers an id of a quote the reader may not see', () => {
	it('keeps private, direct and limited quotes out of the body and the Link, for a user token and an app token', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const QUOTED = '740000000000000000'
		const QUOTER = '740000000000000001'
		const OTHER = '740000000000000002'
		const TARGET = '741000000000000000'
		const visible = ids(742000000000000000n, 5)
		const hidden = new Set<string>()
		await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			const at = new Date(NOW).toISOString()
			for (const [id, name] of [
				[QUOTED, 'quoted'],
				[QUOTER, 'quoter'],
				[OTHER, 'other'],
			]) {
				sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'far.example')",
					id,
					`https://far.example/users/${name}`,
					name
				)
			}
			const status = (id: string, author: string, visibility: string) =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at) VALUES (?, ?, ?, ?, '<p>q</p>', ?)`,
					id,
					`https://far.example/objects/${id}`,
					author,
					visibility,
					at
				)
			status(TARGET, QUOTED, 'public')
			const quote = (id: string) =>
				sql.exec(
					`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
					VALUES (?, ?, ?, ?, 'accepted', ?)`,
					id,
					`https://far.example/objects/${TARGET}`,
					TARGET,
					QUOTED,
					at
				)
			for (const id of visible) {
				status(id, QUOTER, 'public')
				quote(id)
			}
			for (const [base, visibility] of [
				[743000000000000000n, 'private'],
				[744000000000000000n, 'direct'],
				[745000000000000000n, 'limited'],
			] as const) {
				for (const id of ids(base, 60)) {
					status(id, QUOTER, visibility)
					quote(id)
					hidden.add(id)
					if (visibility !== 'private') {
						sql.exec(
							'INSERT INTO status_mentions (status_id, account_id, silent) VALUES (?, ?, ?)',
							id,
							OTHER,
							visibility === 'limited' ? 1 : 0
						)
					}
				}
			}
		})
		for (const token of [alice.token, await appToken(h)]) {
			const seen: string[] = []
			let next: string | null = `/api/v1/statuses/${TARGET}/quotes`
			while (next !== null) {
				expect(seen.length).toBeLessThan(1000)
				const response = await h.request(next, bearer(token))
				expect(response.status).toBe(200)
				const text = (await response.text()) + (response.headers.get('link') ?? '')
				const leaked = (text.match(/\d{18}/g) ?? []).filter((id) => hidden.has(id))
				expect(leaked).toEqual([])
				const body = JSON.parse(text.slice(0, text.length - (response.headers.get('link') ?? '').length)) as {
					id: string
				}[]
				seen.push(...body.map((status) => status.id))
				next = linkOf(response, 'next')
			}
			expect(seen).toEqual([...visible].reverse())
		}
	}, 60_000)
})

describe('a group the list shows is found on its own', () => {
	it('answers the group behind 400 newer notifications of it from muted senders', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = (await post(h, alice, { status: 'hello' })).id
		const GROUP = 'favourite-shown'
		await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 401 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?1 + i AS TEXT), 'https://far.example/users/m' || i, 'm' || i, 'far.example' FROM n`,
				String(HIDDEN_BASE)
			)
			// The first sender's favourite is shown; the 400 after it are from senders alice mutes.
			sql.exec(
				'INSERT INTO mutes (account_id, target_account_id) SELECT ?, id FROM accounts WHERE id > ? AND domain = ?',
				alice.id,
				String(HIDDEN_BASE),
				'far.example'
			)
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key)
				SELECT ?, 'favourite', id, ?, ? FROM accounts WHERE domain = 'far.example' ORDER BY id`,
				alice.id,
				status,
				GROUP
			)
		})
		const list = await h.request('/api/v2/notifications', bearer(alice.token))
		const listed = await list.json<{ notification_groups: { group_key: string; sample_account_ids: string[] }[] }>()
		expect(listed.notification_groups).toMatchObject([{ group_key: GROUP, sample_account_ids: [String(HIDDEN_BASE)] }])
		const one = await h.request(`/api/v2/notifications/${GROUP}`, bearer(alice.token))
		expect(one.status).toBe(200)
		expect(
			await one.json<{ notification_groups: { group_key: string; notifications_count: number }[] }>()
		).toMatchObject({ notification_groups: [{ group_key: GROUP, notifications_count: 1 }] })
	}, 60_000)
})

// limit=0 answers a list the viewer keeps whole (up to its answer cap), however many of its entries are unavailable:
// 5 available accounts below 3,000 being deleted, as members of alice's list and as her endorsements.
describe('limit=0 answers the whole of a list the viewer keeps', () => {
	it('lists the available members and endorsements below 3,000 unavailable ones', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const list = (
			await (
				await h.request(
					'/api/v1/lists',
					bearer(alice.token, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ title: 'all' }),
					})
				)
			).json<{ id: string }>()
		).id
		await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			for (const [base, count, deleting] of [
				[OLDER_BASE, 5, null],
				[HIDDEN_BASE, 3_000, new Date(NOW).toISOString()],
			] as const) {
				sql.exec(
					`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
					INSERT INTO accounts (id, uri, username, domain, deleted_at)
					SELECT CAST(?2 + i AS TEXT), 'https://far.example/users/z' || (?2 + i), 'z' || (?2 + i), 'far.example', ?3 FROM n`,
					count,
					String(base),
					deleting
				)
			}
			sql.exec(
				"INSERT INTO list_accounts (list_id, account_id) SELECT ?, id FROM accounts WHERE domain = 'far.example'",
				list
			)
			sql.exec(
				"INSERT INTO account_pins (account_id, target_account_id) SELECT ?, id FROM accounts WHERE domain = 'far.example'",
				alice.id
			)
		})
		const expected = ids(OLDER_BASE, 5).reverse()
		for (const path of [`/api/v1/lists/${list}/accounts?limit=0`, '/api/v1/endorsements?limit=0']) {
			const response = await h.request(path, bearer(alice.token))
			expect(response.status).toBe(200)
			expect([path, listed(await response.json())]).toEqual([path, expected])
		}
	}, 60_000)
})

describe('a group the list shows on a later page is found on its own', () => {
	it('answers the group behind 2,500 newer notifications of it from muted senders', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const status = (await post(h, alice, { status: 'hello' })).id
		const GROUP = 'favourite-deep'
		const HIDDEN = 2_500
		await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(
				`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(?1 + i AS TEXT), 'https://far.example/users/d' || i, 'd' || i, 'far.example' FROM n`,
				String(HIDDEN_BASE),
				HIDDEN
			)
			sql.exec(
				'INSERT INTO mutes (account_id, target_account_id) SELECT ?, id FROM accounts WHERE id > ? AND domain = ?',
				alice.id,
				String(HIDDEN_BASE),
				'far.example'
			)
			sql.exec(
				`INSERT INTO notifications (account_id, type, from_account_id, status_id, group_key)
				SELECT ?, 'favourite', id, ?, ? FROM accounts WHERE domain = 'far.example' ORDER BY id`,
				alice.id,
				status,
				GROUP
			)
		})
		// The list reaches the group past its walk's first 2,000, on a later page.
		const { pages } = await follow(h, alice.token, '/api/v2/notifications', 'next', grouped)
		expect(pages.flat()).toEqual([String(HIDDEN_BASE)])
		const one = await h.request(`/api/v2/notifications/${GROUP}`, bearer(alice.token))
		expect(one.status).toBe(200)
		expect(
			await one.json<{ notification_groups: { group_key: string; notifications_count: number }[] }>()
		).toMatchObject({ notification_groups: [{ group_key: GROUP, notifications_count: 1 }] })
	}, 60_000)
})
