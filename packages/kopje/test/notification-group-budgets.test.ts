import { describe, expect, it } from 'vitest'

import { type ApiHarness, sql } from './api-helpers'
import { NOW } from './app-helpers'
import {
	acceptQuote,
	type Answer,
	answer,
	bigStatus,
	expectByteCutWalk,
	maximalAccounts,
	type Walked,
} from './budget-helpers'
import { community, mute, remoteAccount, seedStatus, type User } from './status-helpers'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { GROUP_WALK } from '../src/domain/notification-groups'

// RES-3: a page of grouped notifications is within ANSWER_BYTES. Groups are admitted in discovery order, each with
// the accounts and statuses it adds; a page cut by bytes continues from its last admitted group's discovery position
// (never a group's member range), its range fields and cursors those of the groups kept, and a walk's continuation
// at GROUP_WALK is kept only when no group was left out by bytes before it.

type Group = {
	group_key: string
	notifications_count: number
	most_recent_notification_id: number
	page_min_id: string
	page_max_id: string
	sample_account_ids: string[]
}

type Grouped = {
	accounts: { id: string }[]
	partial_accounts?: { id: string }[]
	statuses: { id: string }[]
	notification_groups: Group[]
}

// A favourite of `status` by `from`, in the status's group; its id.
async function favourite(h: ApiHarness, recipient: string, from: string, status: string): Promise<string> {
	const [row] = await sql<{ id: string }>(
		h.store,
		`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, group_key)
		VALUES (?, 'favourite', ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
		recipient,
		from,
		status,
		new Date(NOW).toISOString(),
		`favourite-${status}-1`
	)
	return row!.id
}

// `count` notifications from `from`, each of its own type, which a mute with notifications hides.
async function hidden(h: ApiHarness, recipient: string, from: string, count: number): Promise<void> {
	await sql(
		h.store,
		`INSERT INTO notifications (account_id, type, from_account_id, created_at)
		WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?4 - 1)
		SELECT ?1, 'hidden' || i, ?2, ?3 FROM n`,
		recipient,
		from,
		new Date(NOW).toISOString(),
		count
	)
}

// Walks the grouped list by its Link header, each group by its most recent notification's id.
async function walkGroups(h: ApiHarness, path: string, rel: 'next' | 'prev', token: string) {
	const walked: Walked & { groups: Group[][] } = { ids: [], pages: [], groups: [] }
	for (let at: string | null = path; at !== null;) {
		const page: Answer<Grouped> = await answer<Grouped>(h, at, token)
		expect(page.status).toBe(200)
		expect(page.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		const shown = page.body.notification_groups.map((group) => String(group.most_recent_notification_id))
		if (shown.length === 0) {
			break
		}
		const link: string | null = page[rel]
		const cursor =
			link === null ? null : new URLSearchParams(link.split('?')[1]).get(rel === 'next' ? 'max_id' : 'min_id')
		walked.pages.push({ shown, bytes: page.bytes, cursor })
		walked.groups.push(page.body.notification_groups)
		walked.ids.push(...(rel === 'next' ? shown : shown.toReversed()))
		at = link
		expect(walked.pages.length).toBeLessThan(20)
	}
	return walked
}

async function groupBytes(h: ApiHarness, user: User, key: string): Promise<number> {
	return (await answer<unknown>(h, `/api/v2/notifications/${key}`, user.token)).bytes
}

async function markers(h: ApiHarness, user: User) {
	return (await answer<unknown>(h, '/api/v1/markers?timeline[]=notifications', user.token)).body
}

describe('grouped notifications within ANSWER_BYTES (RES-3)', () => {
	it('walk every group once in both directions, cut by bytes before a walk continuation too', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan')
		const muted = await remoteAccount(h.store, 'muted')
		await mute(h.store, alice.id, muted)
		// Ten groups, more hidden notifications than a walk reads, ten groups: each group one favourite of a big status.
		const ids: string[] = []
		for (let i = 0; i < 20; i++) {
			if (i === 10) {
				await hidden(h, alice.id, muted, GROUP_WALK + 100)
			}
			ids.push(await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - (20 - i) * 60_000)))
		}
		const [first] = await sql<{ status_id: string }>(
			h.store,
			'SELECT status_id FROM notifications WHERE id = ?',
			ids[0]!
		)
		const size = await groupBytes(h, alice, `favourite-${first!.status_id}-1`)
		const unread = await answer<{ count: number }>(h, '/api/v2/notifications/unread_count', alice.token)
		const marked = await markers(h, alice)
		const newest = ids.toReversed()
		const older = await walkGroups(h, '/api/v2/notifications?limit=20', 'next', alice.token)
		expectByteCutWalk('grouped', older, newest, 'next', size)
		const newer = await walkGroups(h, '/api/v2/notifications?limit=20&min_id=0', 'prev', alice.token)
		expectByteCutWalk('grouped', newer, ids, 'prev', size)
		for (const walked of [older, newer]) {
			// The first page found ten groups before the walk stopped at GROUP_WALK, and was cut by bytes before them:
			// its link continues from its last group, not from the walk's continuation.
			expect(walked.pages[0]!.shown.length).toBeLessThan(10)
			// The next page found the rest of those ten and stopped at GROUP_WALK: its link continues from the walk.
			const second = walked.pages[1]!
			expect(second.shown.length + walked.pages[0]!.shown.length).toBe(10)
			expect(second.cursor).not.toBe(walked === older ? second.shown.at(-1) : second.shown[0])
		}
		// Each group's range fields are its own notification.
		for (const group of older.groups.flat()) {
			expect(group.page_min_id).toBe(String(group.most_recent_notification_id))
			expect(group.page_max_id).toBe(String(group.most_recent_notification_id))
		}
		expect(await answer(h, '/api/v2/notifications/unread_count', alice.token)).toMatchObject({ body: unread.body })
		// The count's walk, oldest first, stops at GROUP_WALK past the oldest ten.
		expect(unread.body.count).toBe(10)
		expect(await markers(h, alice)).toEqual(marked)
	}, 600_000)

	it('continue from discovery positions with interleaved groups, the range fixed by the groups kept', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fans = await Promise.all(['f1', 'f2', 'f3', 'f4'].map((name) => remoteAccount(h.store, name)))
		const big = async (minutes: number) => bigStatus(h, alice.id, NOW - minutes * 60_000)
		// Six groups below, then C, A, B, A again (A@100, B@95, A@90, C@80 from the newest), and six groups above:
		// eight groups of about 0.97 MB fit, the ninth does not.
		const pad = async () => favourite(h, alice.id, fans[0]!, await big(100))
		for (let i = 0; i < 6; i++) {
			await pad()
		}
		const [a, b, c] = [await big(90), await big(90), await big(90)]
		const c80 = await favourite(h, alice.id, fans[0]!, c)
		const a90 = await favourite(h, alice.id, fans[1]!, a)
		const b95 = await favourite(h, alice.id, fans[2]!, b)
		const a100 = await favourite(h, alice.id, fans[3]!, a)
		for (let i = 0; i < 6; i++) {
			await pad()
		}
		const groupOf = (page: Grouped, status: string) =>
			page.notification_groups.find((group) => group.group_key === `favourite-${status}-1`)
		// Newest first: six groups, A (at 100), B; C does not fit. The page continues from B's position, and A counts
		// both of its notifications up to the page's upper end, its oldest from B up.
		const down = await answer<Grouped>(h, '/api/v2/notifications?limit=20', alice.token)
		expect(down.body.notification_groups).toHaveLength(8)
		expect(groupOf(down.body, c)).toBeUndefined()
		expect(groupOf(down.body, a)).toMatchObject({
			notifications_count: 2,
			page_max_id: a100,
			page_min_id: a100,
			most_recent_notification_id: Number(a100),
		})
		expect(down.next).toContain(`max_id=${b95}`)
		// The next page finds A again (at 90) and C.
		const below = await answer<Grouped>(h, down.next!, alice.token)
		expect(groupOf(below.body, a)).toMatchObject({ notifications_count: 1, page_max_id: a90 })
		expect(groupOf(below.body, c)).toBeDefined()
		// Oldest first: six groups, C, A (at 90); B does not fit. The page continues from A's position, and its range
		// ends there: A counts its notification at 90 alone.
		const up = await answer<Grouped>(h, '/api/v2/notifications?limit=20&min_id=0', alice.token)
		expect(up.body.notification_groups).toHaveLength(8)
		expect(groupOf(up.body, b)).toBeUndefined()
		expect(groupOf(up.body, a)).toMatchObject({ notifications_count: 1, page_max_id: a90, page_min_id: a90 })
		expect(up.prev).toContain(`min_id=${a90}`)
		expect(groupOf(up.body, c)).toMatchObject({ page_max_id: c80 })
		const above = await answer<Grouped>(h, up.prev!, alice.token)
		expect(groupOf(above.body, b)).toMatchObject({ page_max_id: b95 })
		expect(groupOf(above.body, a)).toMatchObject({ notifications_count: 2, page_max_id: a100 })
		for (const page of [down, below, up, above]) {
			expect(page.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
		}
	}, 300_000)

	it('drops the last groups when the range of the groups kept samples larger accounts', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan')
		const large = await maximalAccounts(h, 'large', 8)
		const small = await Promise.all(Array.from({ length: 8 }, (_, i) => remoteAccount(h.store, `small${i}`)))
		const a = await bigStatus(h, alice.id, NOW - 60_000)
		// A's seven oldest favourites, from large accounts, lie below min_id; then seven groups, A's eighth large
		// favourite, a group B, and eight favourites of A from small accounts.
		let min = ''
		for (const account of large.slice(0, 7)) {
			min = await favourite(h, alice.id, account, a)
		}
		const pads: string[] = []
		for (let i = 0; i < 7; i++) {
			pads.push(await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000)))
		}
		await favourite(h, alice.id, large[7]!, a)
		await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000))
		for (const account of small) {
			await favourite(h, alice.id, account, a)
		}
		// Walked up from min_id, B does not fit after the seven groups and A, which samples the small accounts up to
		// the walk's end. Over the range the kept groups fix, which ends at A's discovery position, A samples the eight
		// large accounts and no longer fits either: the page is the seven groups, continuing from the last.
		const up = await answer<Grouped>(h, `/api/v2/notifications?limit=20&min_id=${min}`, alice.token)
		expect(up.body.notification_groups.map((group) => String(group.most_recent_notification_id))).toEqual(
			pads.toReversed()
		)
		expect(up.prev).toContain(`min_id=${pads.at(-1)!}`)
		expect(up.bytes).toBeLessThanOrEqual(ANSWER_BYTES)
	}, 300_000)

	it('answers its first group alone after two passes over the kept groups still do not fit', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan')
		const large = await maximalAccounts(h, 'large', 8)
		const small = await Promise.all(Array.from({ length: 8 }, (_, i) => remoteAccount(h.store, `small${i}`)))
		// A, a quote of about 1.94 MB, and B, a small status. Below min_id, seven favourites of each from large
		// accounts. Above it, walked oldest first: six groups of about 0.97 MB, A's eighth large favourite and eight
		// small ones, B's eighth large favourite, a group C, and eight small favourites of B.
		const a = await bigStatus(h, alice.id, NOW - 60_000)
		await acceptQuote(h, a, await bigStatus(h, alice.id, NOW - 90_000))
		const b = await seedStatus(h.store, { accountId: alice.id, visibility: 'public' })
		let min = ''
		for (const account of large.slice(0, 7)) {
			await favourite(h, alice.id, account, a)
			min = await favourite(h, alice.id, account, b)
		}
		const pads: string[] = []
		for (let i = 0; i < 6; i++) {
			pads.push(await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000)))
		}
		await favourite(h, alice.id, large[7]!, a)
		for (const account of small) {
			await favourite(h, alice.id, account, a)
		}
		await favourite(h, alice.id, large[7]!, b)
		await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000))
		for (const account of small) {
			await favourite(h, alice.id, account, b)
		}
		// The first pass keeps the six groups, A and B (C does not fit). Over their range, ending at B's position, B
		// samples the large accounts and does not fit; over the range ending at A's, A samples them and does not fit
		// either. After those two passes the page is its first group alone.
		const up = await answer<Grouped>(h, `/api/v2/notifications?limit=20&min_id=${min}`, alice.token)
		expect(up.body.notification_groups.map((group) => String(group.most_recent_notification_id))).toEqual([pads[0]])
		expect(up.body.notification_groups[0]).toMatchObject({ page_min_id: pads[0], page_max_id: pads[0] })
		expect(up.prev).toContain(`min_id=${pads[0]!}`)
		// It continues from there: the next page starts at the second group.
		const next = await answer<Grouped>(h, up.prev!, alice.token)
		expect(String(next.body.notification_groups.at(-1)!.most_recent_notification_id)).toBe(pads[1])
	}, 300_000)

	it('refunds a partial account a later group promotes, so a page that fits only with the refund is whole', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan')
		const [x, y] = await maximalAccounts(h, 'promoted', 2)
		// Walked oldest first: G1 (x, then y: y shown whole, x partial), eight groups of about 0.97 MB, a group T whose
		// poll tunes the answer's size, and G2 (x alone), which shows x whole in place of its partial account.
		const s1 = await seedStatus(h.store, { accountId: alice.id, visibility: 'public' })
		await favourite(h, alice.id, x!, s1)
		await favourite(h, alice.id, y!, s1)
		for (let i = 0; i < 8; i++) {
			await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000))
		}
		const tuner = await bigStatus(h, alice.id, NOW - 120_000)
		const options = (texts: string[]) =>
			sql(h.store, 'UPDATE polls SET options = ? WHERE status_id = ?', JSON.stringify(texts), tuner)
		await options(Array.from({ length: 100 }, () => ''))
		await favourite(h, alice.id, fan, tuner)
		const s2 = await seedStatus(h.store, { accountId: alice.id, visibility: 'public' })
		await favourite(h, alice.id, x!, s2)
		const path = '/api/v2/notifications?limit=20&min_id=0&expand_accounts=partial_avatars'
		const groupsOf = (page: Answer<Grouped>) => page.body.notification_groups.map((group) => group.group_key)
		const before = await answer<Grouped>(h, path, alice.token)
		expect(groupsOf(before)).toContain(`favourite-${s2}-1`)
		// x's partial account, as G1 and the next group show it.
		const alone = await answer<Grouped>(
			h,
			'/api/v2/notifications?limit=2&min_id=0&expand_accounts=partial_avatars',
			alice.token
		)
		const partial = jsonBytes(alone.body.partial_accounts!.find((account) => account.id === x))
		// Grow T's poll until the answer is within 100 bytes of ANSWER_BYTES: each choice's title adds its JSON bytes
		// (six for a control character, one for ASCII).
		const delta = ANSWER_BYTES - 100 - before.bytes
		expect(delta).toBeGreaterThan(0)
		expect(delta).toBeLessThan(100 * 6 * 1_000)
		const each = Math.floor(delta / 100)
		const title = (bytes: number) => '\u0001'.repeat(Math.floor(bytes / 6)) + 'x'.repeat(bytes % 6)
		await options(Array.from({ length: 100 }, (_, i) => title(each + (i === 0 ? delta - 100 * each : 0))))
		const after = await answer<Grouped>(h, path, alice.token)
		expect(after.bytes).toBe(ANSWER_BYTES - 100)
		// Counted without the refund, x's partial account would pass the budget and leave G2 out.
		expect(after.bytes + partial + 1).toBeGreaterThan(ANSWER_BYTES)
		expect(groupsOf(after)).toEqual(groupsOf(before))
		expect(after.body.accounts.map((account) => account.id)).toContain(x)
		expect(after.body.partial_accounts!.map((account) => account.id)).not.toContain(x)
	}, 300_000)

	it('moves a partial account to the accounts when a later group shows it first', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const [x, y] = await maximalAccounts(h, 'sampled', 2)
		const s1 = await bigStatus(h, alice.id, NOW - 60_000)
		const s2 = await bigStatus(h, alice.id, NOW - 120_000)
		// Newest first: G1 (y, then x), G2 (x alone).
		const g2 = await favourite(h, alice.id, x!, s2)
		await favourite(h, alice.id, x!, s1)
		await favourite(h, alice.id, y!, s1)
		const partial = await answer<Grouped>(h, '/api/v2/notifications?expand_accounts=partial_avatars', alice.token)
		expect(partial.body.notification_groups.map((group) => group.sample_account_ids)).toEqual([[y, x], [x]])
		expect(partial.body.accounts.map((account) => account.id)).toEqual([y, x])
		expect(partial.body.partial_accounts).toEqual([])
		const full = await answer<Grouped>(h, '/api/v2/notifications', alice.token)
		expect(full.body.accounts.map((account) => account.id)).toEqual([y, x])
		expect(full.body).not.toHaveProperty('partial_accounts')
		// Without G2, x stays partial, read with its partial columns only.
		const only = await answer<Grouped & { partial_accounts: Record<string, unknown>[] }>(
			h,
			`/api/v2/notifications?expand_accounts=partial_avatars&since_id=${g2}`,
			alice.token
		)
		expect(only.body.notification_groups).toHaveLength(1)
		expect(only.body.partial_accounts.map((account) => Object.keys(account).toSorted())).toEqual([
			['acct', 'avatar', 'avatar_static', 'bot', 'id', 'locked', 'url'],
		])
	}, 300_000)
})
