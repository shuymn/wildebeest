import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { setSetting, sql } from './api-helpers'
import { mastodonFlag, mastodonInstanceActor, misskeyFlag, misskeySystemActor } from './fixtures/flags'
import { LOCAL, MASTODON, mastodonActor, type TestActor } from './inbox-helpers'
import { accountId, ALICE, ALICE_URI, DAVE, DAVE_URI, type Setup, setup } from './inbox-status-helpers'
import { storeReceive } from './inbox-store-helpers'
import { seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import { FOLLOWER_PROBE, remoteReportStatusIds } from '../src/domain/audience'
import type { InboundActivity } from '../src/domain/inbox'
import { MAX_REMOTE_REPORT_COMMENT, MAX_REPORT_STATUSES, MAX_UNRESOLVED_REMOTE_REPORTS } from '../src/domain/reports'
import { ACTIVITY_ID_LIMIT, withinIdentityBound } from '../src/platform/identity-bounds'
import { sha256Hex } from '../src/security/tokens'

// Inbound Flags (Mastodon 4.5.11's ActivityPub::Activity::Flag and ReportService; src/domain/reports.ts
// fileRemoteReports, migration 0054_remote_reports): remote servers report local accounts and statuses to the OAuth
// admin. R34, R37, ID-6, ID-7, RES-2 and RES-7 (docs/threat-model.md, docs/visibility.md).

type ReportRow = {
	id: number
	account_id: string
	target_account_id: string
	status_ids: string
	comment: string
	category: string
	rule_ids: string | null
	forwarded: number
	uri: string
	action_taken_at: string | null
}

const reports = (t: Setup) =>
	sql<ReportRow>(
		t.store,
		`SELECT id, account_id, target_account_id, status_ids, comment, category, rule_ids, forwarded, uri, action_taken_at
		FROM reports ORDER BY id`
	)

// What a refused Flag must leave as it was.
async function snapshot(t: Setup) {
	return {
		reports: await sql(t.store, 'SELECT * FROM reports ORDER BY id'),
		notifications: await sql(t.store, 'SELECT * FROM notifications ORDER BY id'),
		pushes: await sql(t.store, 'SELECT * FROM push_deliveries ORDER BY id'),
	}
}

// alice is the OAuth admin (R37), subscribed to admin.report pushes; dave is the reported local account.
async function world() {
	const t = await setup()
	await setSetting(t.store, 'admin_email', 'alice@mail.example')
	await sql(
		t.store,
		`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts)
		VALUES (?, 'https://push.example/alice', 'p256dh', 'auth', '{"admin.report":true}')`,
		await sha256Hex(t.tokens.alice)
	)
	return t
}

// A status of `account` (local by default), with its uri.
async function statusOf(
	t: Setup,
	visibility: 'public' | 'unlisted' | 'private' | 'direct',
	account = DAVE,
	extra: { mentions?: { accountId: string }[]; uri?: string } = {}
): Promise<{ id: string; uri: string }> {
	const uri = extra.uri ?? `${LOCAL}/ap/o/${crypto.randomUUID()}`
	const id = await seedStatus(t.store, { accountId: account, visibility, uri, mentions: extra.mentions })
	return { id, uri }
}

// The Store's receive of a Flag by `actor` (stored), as the Worker hands it on.
function flagOf(id: string, objects: string[], content = ''): Extract<InboundActivity, { type: 'Flag' }> {
	return { type: 'Flag', id, objects, content }
}

// Stores the actor (a Flag naming nothing Kopje holds files nothing) and returns its account id.
async function stored(t: Setup, actor: TestActor): Promise<string> {
	expect(await t.post(actor, mastodonFlag(actor, [`${LOCAL}/ap/users/nobody`], ''))).toBe(202)
	return (await accountId(t.store, actor.uri))!
}

// An id of the actor's origin whose JSON-escaped UTF-8 bytes are exactly `bytes`, filled with `fill`.
function idOfBytes(origin: string, bytes: number, fill: string): string {
	const prefix = `${origin}/payloads/`
	const unit = new TextEncoder().encode(JSON.stringify(fill)).length - 2
	const count = Math.floor((bytes - prefix.length) / unit)
	const id = `${prefix}${'a'.repeat(bytes - prefix.length - count * unit)}${fill.repeat(count)}`
	expect(new TextEncoder().encode(JSON.stringify(id)).length - 2).toBe(bytes)
	return id
}

describe('Flag: what a report links (R34)', () => {
	it("files a Mastodon instance actor's report of an account and its statuses, with one admin.report and push", async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const s1 = await statusOf(t, 'public')
		const s2 = await statusOf(t, 'unlisted')
		const flag = mastodonFlag(actor, [DAVE_URI, s1.uri, s2.uri], 'Spam from this account')
		expect(await t.post(actor, flag)).toBe(202)
		const reporter = await accountId(t.store, actor.uri)
		expect(await reports(t)).toEqual([
			expect.objectContaining({
				account_id: reporter,
				target_account_id: DAVE,
				status_ids: JSON.stringify([s1.id, s2.id].sort()),
				comment: 'Spam from this account',
				category: 'other',
				rule_ids: null,
				forwarded: 0,
				uri: flag.id,
				action_taken_at: null,
			}),
		])
		const [report] = await reports(t)
		expect(
			await sql(t.store, 'SELECT account_id, type, from_account_id, report_id FROM notifications ORDER BY id')
		).toEqual([{ account_id: ALICE, type: 'admin.report', from_account_id: reporter, report_id: report!.id }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM push_deliveries')).toEqual([{ n: 1 }])
	})

	it("files a Misskey system actor's report (a string object, to the personal inbox) with no statuses", async () => {
		const t = await world()
		const actor = await misskeySystemActor(t.web)
		expect(await t.post(actor, misskeyFlag(actor, DAVE_URI, 'スパム'), { path: '/ap/users/dave/inbox' })).toBe(202)
		expect(await reports(t)).toEqual([
			expect.objectContaining({ target_account_id: DAVE, status_ids: '[]', comment: 'スパム', forwarded: 0 }),
		])
	})

	it('writes nothing for a redelivery; one Flag naming two local accounts files two reports with its id', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const flag = mastodonFlag(actor, [DAVE_URI, ALICE_URI], 'two')
		expect(await t.post(actor, flag)).toBe(202)
		expect((await reports(t)).map((r) => [r.target_account_id, r.uri])).toEqual([
			[DAVE, flag.id],
			[ALICE, flag.id],
		])
		const before = await snapshot(t)
		expect(await t.post(actor, flag)).toBe(202)
		expect(await storeReceive(t.store, actor.uri, flagOf(flag.id, [DAVE_URI, ALICE_URI]))).toMatchObject({
			applied: false,
			reason: 'duplicate',
		})
		expect(await snapshot(t)).toEqual(before)
		// Each account's first unresolved report notifies; alice's own is from the reporter, not from herself.
		expect(await sql(t.store, "SELECT count(*) AS n FROM notifications WHERE type = 'admin.report'")).toEqual([
			{ n: 2 },
		])
	})

	it('reports a remote account only with a named status of it that replies to a local account (flag.rb:15-17)', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const carol = await mastodonActor(t.web, 'carol', { origin: 'https://other.example', key: 3 })
		const reporter = await stored(t, actor)
		await sql(
			t.store,
			"INSERT INTO accounts (id, uri, username, domain) VALUES ('333333333333333333', ?, 'carol', 'other.example')",
			carol.uri
		)
		const plain = await statusOf(t, 'public', '333333333333333333', { uri: `${carol.uri}/statuses/1` })
		const reply = await statusOf(t, 'public', '333333333333333333', { uri: `${carol.uri}/statuses/2` })
		await sql(t.store, 'UPDATE statuses SET in_reply_to_account_id = ? WHERE id = ?', ALICE, reply.id)
		const without = flagOf(`${MASTODON}/payloads/without`, [carol.uri, plain.uri])
		expect(await storeReceive(t.store, actor.uri, without)).toMatchObject({ applied: false, reason: 'no-target' })
		const withReply = flagOf(`${MASTODON}/payloads/with`, [carol.uri, plain.uri, reply.uri])
		expect(await storeReceive(t.store, actor.uri, withReply)).toMatchObject({ applied: true, reason: 'reported' })
		expect(await reports(t)).toEqual([
			expect.objectContaining({
				account_id: reporter,
				target_account_id: '333333333333333333',
				status_ids: JSON.stringify([plain.id, reply.id].sort()),
			}),
		])
	})
})

describe('Flag: refusals write nothing', () => {
	const block = (t: Setup, domain: string, severity: 'suspend' | 'noop', rejectReports: boolean) =>
		sql(
			t.store,
			`INSERT INTO instance_domain_blocks (domain, severity, reject_reports, created_at, updated_at)
			VALUES (?, ?, ?, 'x', 'x')`,
			domain,
			severity,
			rejectReports ? 1 : 0
		)

	it('reject_reports: on the domain, on a parent, and not under a nearer noop without it', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const social = await mastodonActor(t.web, 'social', { origin: 'https://social.mastodon.example', key: 4 })
		const nearer = await mastodonActor(t.web, 'near', { origin: 'https://near.mastodon.example', key: 5 })
		await block(t, 'mastodon.example', 'noop', true)
		await block(t, 'near.mastodon.example', 'noop', false)
		for (const reporter of [actor, social]) {
			expect(await t.post(reporter, mastodonFlag(reporter, [DAVE_URI], 'x'))).toBe(202)
			expect(
				await storeReceive(t.store, reporter.uri, flagOf(`${new URL(reporter.uri).origin}/f`, [DAVE_URI]))
			).toMatchObject({ applied: false, reason: 'reports-rejected' })
		}
		expect(await reports(t)).toEqual([])
		expect(await t.post(nearer, mastodonFlag(nearer, [DAVE_URI], 'x'))).toBe(202)
		expect(await reports(t)).toHaveLength(1)
	})

	it('a suspended domain: answered 202 before anything is fetched', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		await block(t, 'mastodon.example', 'suspend', false)
		const fetched = t.web.fetched.length
		expect(await t.post(actor, mastodonFlag(actor, [DAVE_URI], 'x'))).toBe(202)
		expect(t.web.fetched.length).toBe(fetched)
		expect(await reports(t)).toEqual([])
	})

	it('a suspended or deleted actor, an unavailable target, and only unknown objects', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const reporter = await stored(t, actor)
		const flag = (n: number, objects = [DAVE_URI]) => flagOf(`${MASTODON}/payloads/${n}`, objects)
		expect(await storeReceive(t.store, actor.uri, flag(1, [`${LOCAL}/ap/users/nobody`]))).toMatchObject({
			reason: 'no-target',
		})
		await sql(t.store, "UPDATE local_accounts SET suspended_at = 'x' WHERE account_id = ?", DAVE)
		expect(await storeReceive(t.store, actor.uri, flag(2))).toMatchObject({ applied: false, reason: 'no-target' })
		await sql(t.store, 'UPDATE local_accounts SET suspended_at = NULL WHERE account_id = ?', DAVE)
		await sql(t.store, "UPDATE accounts SET suspended_at = 'x', suspension_source = 'account' WHERE id = ?", reporter)
		expect(await storeReceive(t.store, actor.uri, flag(3))).toMatchObject({ applied: false, reason: 'actor-suspended' })
		await sql(t.store, 'UPDATE accounts SET suspended_at = NULL, suspension_source = NULL WHERE id = ?', reporter)
		expect(await storeReceive(t.store, actor.uri, { type: 'DeleteActor', id: `${actor.uri}#delete` })).toMatchObject({
			applied: true,
		})
		expect(await storeReceive(t.store, actor.uri, flag(4))).toMatchObject({ applied: false, reason: 'actor-deleted' })
		expect(await reports(t)).toEqual([])
	})
})

describe('Flag: the remote reporter status rule (R34, remoteReportableSql)', () => {
	const reported = async (t: Setup, actor: TestActor, statuses: { uri: string }[], n: number) => {
		await storeReceive(
			t.store,
			actor.uri,
			flagOf(`${MASTODON}/payloads/rule-${n}`, [DAVE_URI, ...statuses.map((s) => s.uri)])
		)
		const row = (await reports(t)).find((r) => r.uri === `${MASTODON}/payloads/rule-${n}`)
		return JSON.parse(row!.status_ids) as string[]
	}

	it('attaches public and unlisted statuses; a private one with a follower on the domain; a direct one it mentions', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const reporter = await stored(t, actor)
		const open = [await statusOf(t, 'public'), await statusOf(t, 'unlisted')]
		const closed = await statusOf(t, 'private')
		const direct = await statusOf(t, 'direct')
		const mentioning = await statusOf(t, 'direct', DAVE, { mentions: [{ accountId: reporter }] })
		expect(await reported(t, actor, [...open, closed, direct, mentioning], 1)).toEqual(
			[...open, mentioning].map((s) => s.id).sort()
		)
		// A follower on the domain admits the private status; the direct one stays out though another status mentions
		// the domain (the mention is the status's own, where Mastodon's is any).
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			reporter,
			DAVE
		)
		expect(await reported(t, actor, [closed, direct], 2)).toEqual([closed.id])
	})

	it('drops a status of another account, a boost and an unknown one', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		await stored(t, actor)
		const own = await statusOf(t, 'public')
		const others = await statusOf(t, 'public', ALICE)
		await seedStatus(t.store, {
			accountId: DAVE,
			visibility: 'public',
			reblogOfId: others.id,
			uri: `${LOCAL}/ap/o/boost`,
		})
		expect(
			await reported(t, actor, [own, others, { uri: `${LOCAL}/ap/o/boost` }, { uri: `${LOCAL}/ap/o/x` }], 1)
		).toEqual([own.id])
	})

	it('finds a follower by either probe, and excludes a private status once both are exhausted (RES-7)', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const reporter = await stored(t, actor)
		const closed = await statusOf(t, 'private')
		// More than a probe's followers of dave, none on the domain, ahead of any follow from it.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(400000000000000000 + i AS TEXT), 'https://far.example/users/f' || i, 'f' || i, 'far.example' FROM n`
		)
		await sql(
			t.store,
			`INSERT INTO follows (account_id, target_account_id, state)
				SELECT id, ?, 'accepted' FROM accounts WHERE domain = 'far.example'`,
			DAVE
		)
		// The domain's accounts probe finds the reporter's follow past the followers' window.
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			reporter,
			DAVE
		)
		expect(await reported(t, actor, [closed], 1)).toEqual([closed.id])
		// More than a probe's accounts on the domain ahead of the reporter (by username), none following dave: both
		// probes are exhausted and the private status is left out, though the reporter follows.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT CAST(410000000000000000 + i AS TEXT), 'https://mastodon.example/users/a' || i, 'a' || i,
					'mastodon.example' FROM n`
		)
		expect(await reported(t, actor, [closed], 2)).toEqual([])
		// A follower among the domain's first accounts is found again.
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES ('410000000000000001', ?, 'accepted')",
			DAVE
		)
		expect(await reported(t, actor, [closed], 3)).toEqual([closed.id])
	}, 60_000)
})

describe('Flag: the follower probe reads a bounded window (RES-7, hasFollowerOn)', () => {
	it('reads the same rows with 1,000 or 100,000 followers of the account, none on the domain', async () => {
		const measure = async (followers: number) => {
			const t = await world()
			const closed = await statusOf(t, 'private')
			await sql(
				t.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
					INSERT INTO accounts (id, uri, username, domain)
					SELECT CAST(400000000000000000 + i AS TEXT), 'https://far.example/users/f' || i, 'f' || i, 'far.example' FROM n`,
				followers
			)
			await sql(
				t.store,
				`INSERT INTO follows (account_id, target_account_id, state)
					SELECT id, ?, 'accepted' FROM accounts WHERE domain = 'far.example'`,
				DAVE
			)
			return runInDurableObject(t.store, (_instance, state) => {
				let read = 0
				const real = state.storage.sql
				const counting = {
					exec: (query: string, ...params: SqlStorageValue[]) => {
						const cursor = real.exec(query, ...params)
						return {
							toArray: () => {
								const rows = cursor.toArray()
								read += cursor.rowsRead
								return rows
							},
						}
					},
				} as unknown as SqlStorage
				expect(remoteReportStatusIds(new Db(counting), 'mastodon.example', DAVE, [closed.id])).toEqual([])
				return read
			})
		}
		const few = await measure(1_000)
		const many = await measure(100_000)
		expect(many).toBe(few)
		expect(few).toBeLessThanOrEqual(2 * FOLLOWER_PROBE + 2 * MAX_REPORT_STATUSES + 20)
	}, 120_000)
})

describe('Flag: the per-actor cap of unresolved reports (RES-7)', () => {
	// `count` unresolved reports by the account `reporter`, each of dave under its own uri.
	const unresolved = (t: Setup, reporter: string, count: number) =>
		sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO reports (account_id, target_account_id, uri, created_at)
			SELECT ?2, ?3, ?4 || '/seeded/' || ?2 || '/' || i, 'x' FROM n`,
			count,
			reporter,
			DAVE,
			MASTODON
		)

	it('counts only new targets: 99 then one, not two; 100 with a redelivery or with an old and a new one', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const reporter = await stored(t, actor)
		await unresolved(t, reporter, MAX_UNRESOLVED_REMOTE_REPORTS - 1)
		const two = flagOf(`${MASTODON}/payloads/two`, [DAVE_URI, ALICE_URI])
		const before = await snapshot(t)
		expect(await storeReceive(t.store, actor.uri, two)).toMatchObject({ applied: false, reason: 'report-limit' })
		expect(await snapshot(t)).toEqual(before)
		const one = flagOf(`${MASTODON}/payloads/one`, [DAVE_URI])
		expect(await storeReceive(t.store, actor.uri, one)).toMatchObject({ applied: true, reason: 'reported' })
		// 100 unresolved: the redelivery is a duplicate; with a new target it is refused whole.
		expect(await storeReceive(t.store, actor.uri, one)).toMatchObject({ applied: false, reason: 'duplicate' })
		const grown = flagOf(`${MASTODON}/payloads/one`, [DAVE_URI, ALICE_URI])
		expect(await storeReceive(t.store, actor.uri, grown)).toMatchObject({ applied: false, reason: 'report-limit' })
		// A resolution makes room: the refused Flag files its new target alone.
		await sql(
			t.store,
			"UPDATE reports SET action_taken_at = 'x' WHERE id = (SELECT min(id) FROM reports WHERE account_id = ?)",
			reporter
		)
		expect(await storeReceive(t.store, actor.uri, grown)).toMatchObject({ applied: true })
		expect(await sql(t.store, 'SELECT count(*) AS n FROM reports WHERE uri = ?', grown.id)).toEqual([{ n: 2 }])
	})

	it('is per actor: two actors of one domain each reach it', async () => {
		const t = await world()
		const first = await mastodonInstanceActor(t.web)
		const second = await mastodonActor(t.web, 'moderator', { key: 6 })
		for (const actor of [first, second]) {
			await unresolved(t, await stored(t, actor), MAX_UNRESOLVED_REMOTE_REPORTS - 1)
			const flag = flagOf(`${actor.uri}/flags/last`, [DAVE_URI])
			expect(await storeReceive(t.store, actor.uri, flag)).toMatchObject({ applied: true })
			const past = flagOf(`${actor.uri}/flags/past`, [DAVE_URI])
			expect(await storeReceive(t.store, actor.uri, past)).toMatchObject({ reason: 'report-limit' })
		}
	})
})

describe('Flag: bounds (RES-2, RES-7)', () => {
	const FILLS = ['\u0001', '"', '\u{1F600}']

	it.each(FILLS)('takes an id of 4,096 JSON-escaped bytes and refuses 4,097, filled with %j', async (fill) => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const at = idOfBytes(MASTODON, ACTIVITY_ID_LIMIT, fill)
		const past = idOfBytes(MASTODON, ACTIVITY_ID_LIMIT + 1, fill)
		await stored(t, actor)
		expect(withinIdentityBound(at, ACTIVITY_ID_LIMIT)).toBe(true)
		expect(withinIdentityBound(past, ACTIVITY_ID_LIMIT)).toBe(false)
		// Through the Worker: past the bound it is unsupported, and reaches no Store write.
		expect(await t.post(actor, mastodonFlag(actor, [DAVE_URI], 'x', past))).toBe(202)
		expect(await reports(t)).toEqual([])
		// Through the Store directly: id-past-bound, nothing written and nothing thrown.
		const before = await snapshot(t)
		expect(await storeReceive(t.store, actor.uri, flagOf(past, [DAVE_URI]))).toMatchObject({
			applied: false,
			reason: 'id-past-bound',
		})
		expect(await snapshot(t)).toEqual(before)
		expect(await t.post(actor, mastodonFlag(actor, [DAVE_URI], 'x', at))).toBe(202)
		expect((await reports(t)).map((r) => r.uri)).toEqual([at])
	})

	it.each(FILLS)('skips an object id past 4,096 JSON-escaped bytes, filled with %j', async (fill) => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		await stored(t, actor)
		const long = idOfBytes(LOCAL, ACTIVITY_ID_LIMIT + 1, fill)
		await sql(
			t.store,
			"INSERT INTO accounts (id, uri, username, domain) VALUES ('444444444444444444', ?, 'long', NULL)",
			long
		)
		await sql(
			t.store,
			"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES ('444444444444444444', 'l@x', X'00', X'00', 'k')"
		)
		expect(await storeReceive(t.store, actor.uri, flagOf(`${MASTODON}/p/long`, [long]))).toMatchObject({
			reason: 'no-target',
		})
	})

	it('reads the first 101 object entries: a target at entry 101 is reported, at entry 102 it is not', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const fillers = (n: number) => Array.from({ length: n }, (_, i) => `${LOCAL}/ap/o/unknown-${i}`)
		expect(await t.post(actor, mastodonFlag(actor, [...fillers(101), DAVE_URI], 'x'))).toBe(202)
		expect(await reports(t)).toEqual([])
		expect(await t.post(actor, mastodonFlag(actor, [...fillers(100), DAVE_URI], 'x'))).toBe(202)
		expect(await reports(t)).toHaveLength(1)
	})

	it('cuts the comment to 5,000 code points, NUL and astral ones included, and reads anything else as none', async () => {
		const t = await world()
		const actor = await mastodonInstanceActor(t.web)
		const emoji = '\u{1F600}'
		const cases: [unknown, string][] = [
			[emoji.repeat(MAX_REMOTE_REPORT_COMMENT), emoji.repeat(MAX_REMOTE_REPORT_COMMENT)],
			[emoji.repeat(MAX_REMOTE_REPORT_COMMENT + 1), emoji.repeat(MAX_REMOTE_REPORT_COMMENT)],
			['\u0000' + emoji.repeat(6000), '\u0000' + emoji.repeat(MAX_REMOTE_REPORT_COMMENT - 1)],
			['a\uD800b', 'a�b'],
			['   \n\t', ''],
			[{ text: 'object' }, ''],
			[42, ''],
		]
		for (const [n, [content, expected]] of cases.entries()) {
			const flag = { ...mastodonFlag(actor, [DAVE_URI], ''), id: `${MASTODON}/payloads/comment-${n}`, content }
			expect(await t.post(actor, flag)).toBe(202)
			const rows = await sql<{ comment: string; bytes: number }>(
				t.store,
				'SELECT comment, length(CAST(comment AS BLOB)) AS bytes FROM reports WHERE uri = ?',
				flag.id
			)
			expect(rows.map((row) => row.comment)).toEqual([expected])
			expect(rows[0]!.bytes).toBe(new TextEncoder().encode(expected).length)
		}
		// The NUL-prefixed fill: 1 + 4,999 × 4 bytes.
		expect(new TextEncoder().encode('\u0000' + emoji.repeat(MAX_REMOTE_REPORT_COMMENT - 1)).length).toBe(19_997)
	})

	it('refuses a stored comment past 20,000 bytes and more than 100 status ids, as an import writes them', async () => {
		const t = await world()
		const insert = (comment: string, statusIds: string) =>
			sql(
				t.store,
				`INSERT INTO reports (account_id, target_account_id, status_ids, comment, uri, created_at)
				VALUES (?, ?, ?, ?, ?, 'x')`,
				ALICE,
				DAVE,
				statusIds,
				comment,
				`${LOCAL}/r/${crypto.randomUUID()}`
			)
		const ids = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => String(i)))
		await insert('\u0000' + '\u0001'.repeat(19_999), ids(100))
		await expect(insert('\u0000' + '\u0001'.repeat(20_000), '[]')).rejects.toThrow(/report_comment_within_20000_bytes/)
		await expect(insert('x'.repeat(5001), '[]')).rejects.toThrow(/report_comment_within_20000_bytes/)
		await expect(insert('', ids(101))).rejects.toThrow(/report_status_ids_at_most_100/)
	})
})
