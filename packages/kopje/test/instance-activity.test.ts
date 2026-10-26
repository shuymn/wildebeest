import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ApiHarness, apiHarness, bearer, json, setSetting, sql, userToken } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD, completeSetup, migratedStore } from './helpers'
import { ACCESS, copyConfig, dumpViaRpc, importViaRpc, setAccess } from './ops-helpers'
import { appToken, DAY_MS, plannedRun, rowsRead, scansOf, staleStatistics } from './read-helpers'
import { storeWith } from './setup-helpers'
import { community } from './status-helpers'
import { setInstanceSettings } from '../src/domain/instance'
import {
	ACTIVITY_LOGIN_ROWS,
	ACTIVITY_PRUNE_ROWS,
	ACTIVITY_RETENTION_DAYS,
	ACTIVITY_WEEKS,
	ACTIVITY_WINDOW_DAYS,
	ACTIVITY_WINDOW_SQL,
	type ActivityWeek,
	countStatus,
	instanceActivity,
	keepInstanceActivity,
	madeInstanceActivity,
	pruneActivity,
} from '../src/domain/instance-activity'
import { publishScheduled } from '../src/jobs/scheduled'
import type { StoreStub } from '../src/platform/store-client'
import { ACTIVITY_VALUE_MAX, isActivityAccountId, utcDay } from '../src/platform/stored-bounds'
import { sha256Hex } from '../src/security/tokens'

// GET /api/v1/instance/activity (domain/instance-activity.ts): Mastodon's 12 weeks of 6 UTC days, what the counters
// and logins record, the day's kept answer, the retention prune, and the read's bounds (RES-3, RES-4, RES-7).

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const WEEK_MS = 7 * DAY_MS
const CACHE = 'public, max-age=300, stale-while-revalidate=30, stale-if-error=86400'
const ACTIVITY = '/api/v1/instance/activity'

const counts = (store: StoreStub) =>
	sql<{ kind: string; day: string; value: number }>(store, 'SELECT kind, day, value FROM activity_counts ORDER BY 1, 2')
const logins = (store: StoreStub) =>
	sql<{ day: string; account_id: string }>(store, 'SELECT day, account_id FROM activity_logins ORDER BY 1, 2')
const statusCount = async (store: StoreStub) =>
	(await counts(store)).filter((row) => row.kind === 'statuses').reduce((sum, row) => sum + row.value, 0)
const keptRow = (store: StoreStub) =>
	sql<{ value: string }>(store, "SELECT value FROM kopje_state WHERE name = 'activity_answer'")

// The answer made at `now`, without the kept one.
const made = (store: StoreStub, now: number) =>
	runInDurableObject(store, (_instance, state) => {
		const body = madeInstanceActivity.run(state.storage.sql, { now })
		return body === null ? null : (JSON.parse(body) as ActivityWeek[])
	})

const answer = async (h: Pick<ApiHarness, 'request'>) => {
	const response = await h.request(ACTIVITY)
	expect(response.status).toBe(200)
	return response.json<ActivityWeek[]>()
}

const post = (h: ApiHarness, token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
	h.request('/api/v1/statuses', bearer(token, json(body, { headers })))

async function posted(h: ApiHarness, token: string, body: Record<string, unknown>): Promise<string> {
	const response = await post(h, token, body)
	expect(response.status, JSON.stringify(body)).toBe(200)
	return (await response.json<{ id: string }>()).id
}

// A promise settled by hand: the gate a test holds a call at.
function gate() {
	let open!: () => void
	const promise = new Promise<void>((resolve) => {
		open = resolve
	})
	return { promise, open }
}

// The app's Store with `method` held at `held` (after it is called, before it reaches the Store), counting its calls.
function holding(method: string, held: Promise<void>) {
	const calls: unknown[] = []
	const wrap = (store: StoreStub): StoreStub =>
		storeWith(store, {
			[method]: async (build, input) => {
				calls.push(input)
				await held
				return (store as unknown as Record<string, (b: unknown, i: unknown) => Promise<unknown>>)[method]!(build, input)
			},
		})
	return { calls, wrap }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('instance activity: the answer', () => {
	it("answers Mastodon's 12 weeks, the same for every caller, with its Cache-Control and no Vary", async () => {
		const h = await community(['alice'])
		const app = await appToken(h)
		const bodies: unknown[] = []
		for (const init of [undefined, bearer('stale'), bearer(h.users.alice.token), bearer(app)]) {
			const response = await h.request(ACTIVITY, init)
			expect(response.status).toBe(200)
			expect(response.headers.get('cache-control')).toBe(CACHE)
			expect(response.headers.get('vary')).toBeNull()
			expect(response.headers.get('content-type')).toMatch(/^application\/json/)
			const body = await response.json<Record<string, unknown>[]>()
			expect(body).toHaveLength(ACTIVITY_WEEKS)
			for (const [i, week] of body.entries()) {
				expect(Object.keys(week).sort()).toEqual(['logins', 'registrations', 'statuses', 'week'])
				expect(Object.values(week).every((value) => typeof value === 'string' && /^\d+$/.test(value))).toBe(true)
				expect(week.week).toBe(String((NOW - i * WEEK_MS) / 1000))
			}
			bodies.push(body)
		}
		expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1)
		// A public route: no token records a login.
		expect(await logins(h.store)).toEqual([])
	})

	it('answers an empty 404 without reading the counts or the kept answer when activity_api_enabled is false', async () => {
		const h = await apiHarness()
		await setSetting(h.store, 'activity_api_enabled', 'false')
		const read: string[] = []
		const lookup = await runInDurableObject(h.store, (_instance, state) => {
			const real = state.storage.sql
			const observed = {
				exec: (query: string, ...params: SqlStorageValue[]) => {
					read.push(query)
					return real.exec(query, ...params)
				},
			} as unknown as SqlStorage
			return instanceActivity.run(observed, { now: NOW })
		})
		// The guarded branch ran: the setting was read, and nothing else.
		expect(lookup).toEqual({ status: 'disabled' })
		expect(read).toHaveLength(1)
		expect(read[0]).toContain("name = 'activity_api_enabled'")
		for (const init of [undefined, bearer('stale')]) {
			const response = await h.request(ACTIVITY, init)
			expect(response.status).toBe(404)
			expect(response.headers.get('cache-control')).toBeNull()
			expect(response.headers.get('vary')).toBeNull()
			expect(await response.text()).toBe('')
		}
		expect(await keptRow(h.store)).toEqual([])
		// 'true' and a deleted row (Mastodon's default) answer.
		await setSetting(h.store, 'activity_api_enabled', 'true')
		expect((await h.request(ACTIVITY)).status).toBe(200)
		await sql(h.store, "DELETE FROM instance_settings WHERE name = 'activity_api_enabled'")
		await sql(h.store, "DELETE FROM kopje_state WHERE name = 'activity_answer'")
		expect((await h.request(ACTIVITY)).status).toBe(200)
	})

	it('keeps the answer for its UTC day: a later post shows the next day, and turning the API off and on remakes it', async () => {
		const h = await community(['alice'])
		const { token } = h.users.alice
		await posted(h, token, { status: 'one', visibility: 'public' })
		const first = await answer(h)
		expect(first[0]).toMatchObject({ statuses: '1' })
		await posted(h, token, { status: 'two', visibility: 'public' })
		// The same day, any time: the kept answer, so repeated reads do not time today's posts or logins.
		h.now.mockReturnValue(NOW + DAY_MS - 1)
		expect(await answer(h)).toEqual(first)
		expect((await made(h.store, NOW))![0]).toMatchObject({ statuses: '2' })
		// The next UTC day makes it again at its own time.
		h.now.mockReturnValue(NOW + DAY_MS)
		const next = await answer(h)
		expect(next[0]).toMatchObject({ week: String((NOW + DAY_MS) / 1000), statuses: '0' })
		expect(next[1]).toMatchObject({ statuses: '0' })
		// The setting written through the admin path forgets the kept answer.
		h.now.mockReturnValue(NOW)
		await setAccess(h.store)
		await runInDurableObject(h.store, (_instance, state) => {
			for (const value of ['false', 'true']) {
				expect(
					setInstanceSettings.run(state.storage.sql, {
						authority: ACCESS,
						values: { activity_api_enabled: value },
						now: NOW,
					})
				).toMatchObject({ ok: true })
				expect(state.storage.sql.exec("SELECT name FROM kopje_state WHERE name = 'activity_answer'").toArray()).toEqual(
					[]
				)
			}
		})
		expect((await answer(h))[0]).toMatchObject({ statuses: '2' })
	})

	it('keeps the answer while the Store is readonly, and makes it without keeping it during a dump', async () => {
		const h = await community(['alice'])
		await posted(h, h.users.alice.token, { status: 'one', visibility: 'public' })
		const started = await h.store.dumpStart(BUILD)
		if (!started.ok) throw new Error(started.message)
		expect((await answer(h))[0]).toMatchObject({ statuses: '1' })
		expect(await keptRow(h.store)).toEqual([])
		expect(await h.store.dumpFinish(BUILD, started.cursor, true)).toMatchObject({ ok: true })
		expect(await h.store.setMaintenance(BUILD, true)).toMatchObject({ maintenance: true })
		expect((await answer(h))[0]).toMatchObject({ statuses: '1' })
		expect(await keptRow(h.store)).toHaveLength(1)
	})

	it('makes the answer again when the publication state changes (an import verified or published)', async () => {
		const h = await apiHarness()
		expect((await answer(h))[0]).toMatchObject({ registrations: '0' })
		await sql(h.store, "INSERT INTO activity_counts (kind, day, value) VALUES ('registrations', ?, 1)", day(NOW))
		expect((await answer(h))[0]).toMatchObject({ registrations: '0' })
		await sql(h.store, "INSERT INTO kopje_state (name, value) VALUES ('unpublished', '{\"at\":1}')")
		expect((await answer(h))[0]).toMatchObject({ registrations: '1' })
	})

	it('presents a kept row it did not write as no kept answer', async () => {
		const h = await apiHarness()
		for (const value of ['not json', '{"key":1,"body":2}', 'null']) {
			await sql(h.store, "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('activity_answer', ?)", value)
			expect(await answer(h)).toHaveLength(ACTIVITY_WEEKS)
		}
		await sql(h.store, "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('activity_answer', X'00')")
		expect(await answer(h)).toHaveLength(ACTIVITY_WEEKS)
	})
})

describe('instance activity: the weeks', () => {
	// Week i holds the 6 UTC days D-7i to D-7i+5 (ActivityTracker#sum over week_edge_days' exclusive range): today in
	// week 0 alone, and the day before each week's start (1, 8, 15, ..., 71 days ago) in none.
	const expectedWeek = (ago: number): number | null => {
		if (ago === 0) {
			return 0
		}
		const week = Math.ceil(ago / 7)
		return ago > 0 && ago % 7 !== 1 && week < ACTIVITY_WEEKS ? week : null
	}

	it('places each day in its week, at the first and the last millisecond of the UTC day', async () => {
		const h = await apiHarness()
		expect([0, 2, 7, 72, 77].map(expectedWeek)).toEqual([0, 1, 1, 11, 11])
		expect([1, 8, 15, 71, 78, 84, 85, -1].map(expectedWeek)).toEqual([null, null, null, null, null, null, null, null])
		for (const now of [NOW, NOW + DAY_MS - 1]) {
			await sql(h.store, 'DELETE FROM activity_counts')
			await sql(h.store, 'DELETE FROM activity_logins')
			// Day `ago` holds 2^k statuses and registrations for its k, and the login of its own account.
			const days = Array.from({ length: 93 }, (_, k) => k - 2)
			for (const [k, ago] of days.entries()) {
				for (const kind of ['statuses', 'registrations']) {
					await sql(
						h.store,
						'INSERT INTO activity_counts (kind, day, value) VALUES (?, ?, ?)',
						kind,
						day(now - ago * DAY_MS),
						k + 1
					)
				}
				await sql(
					h.store,
					'INSERT INTO activity_logins (day, account_id) VALUES (?, ?)',
					day(now - ago * DAY_MS),
					String(100000000000000000n + BigInt(k))
				)
			}
			const weeks = (await made(h.store, now))!
			for (let i = 0; i < ACTIVITY_WEEKS; i++) {
				const members = days.flatMap((ago, k) => (expectedWeek(ago) === i ? [k + 1] : []))
				const sum = String(members.reduce((total, value) => total + value, 0))
				expect(weeks[i], `week ${i} at ${new Date(now).toISOString()}`).toEqual({
					week: String(Math.floor((now - i * WEEK_MS) / 1000)),
					statuses: sum,
					logins: String(members.length),
					registrations: sum,
				})
			}
			expect(weeks[0]!.logins).toBe('1')
			expect(weeks[11]!.logins).toBe(String(ACTIVITY_WINDOW_DAYS))
		}
	})

	it('counts one login per account in a window, whatever its days and tokens', async () => {
		const h = await community(['alice', 'bob'])
		const second = await userToken(h, 'alice@example.com', 'read')
		for (const offset of [-3 * DAY_MS, -2 * DAY_MS, 0]) {
			h.now.mockReturnValue(NOW + offset)
			for (const token of [h.users.alice.token, second]) {
				expect((await h.request('/api/v1/preferences', bearer(token))).status).toBe(200)
			}
		}
		expect(await logins(h.store)).toEqual(
			[NOW - 3 * DAY_MS, NOW - 2 * DAY_MS, NOW].map((at) => ({ day: day(at), account_id: h.users.alice.id }))
		)
		const weeks = (await made(h.store, NOW + 3 * DAY_MS))!
		// Today + 3 is week 0; the three days are in week 1 (3 to 6 days before).
		expect(weeks.slice(0, 2).map((week) => week.logins)).toEqual(['0', '1'])
	})
})

describe('instance activity: what counts', () => {
	it('counts local public and unlisted statuses and boosts once, at creation, and nothing else', async () => {
		const h = await community(['alice', 'bob'])
		const { token } = h.users.alice
		const bob = h.users.bob.token
		const original = await posted(h, token, { status: 'public', visibility: 'public' })
		await posted(h, token, { status: 'unlisted', visibility: 'unlisted' })
		expect(await statusCount(h.store)).toBe(2)
		const own = await posted(h, token, { status: 'private', visibility: 'private' })
		await posted(h, token, { status: '@bob direct', visibility: 'direct' })
		expect(await statusCount(h.store)).toBe(2)
		// A quote of a private status is private (PostStatusService#preprocess_attributes!), whatever was asked.
		await posted(h, token, { status: 'quoting', visibility: 'public', quoted_status_id: own })
		expect(await statusCount(h.store)).toBe(2)
		// An Idempotency-Key repeat answers with the first status.
		for (let i = 0; i < 2; i++) {
			expect((await post(h, token, { status: 'keyed' }, { 'idempotency-key': 'k' })).status).toBe(200)
		}
		expect(await statusCount(h.store)).toBe(3)
		// Boosts by their own visibility; a repeated boost answers with the first; an unboosted one boosts again.
		const reblog = (visibility?: string) =>
			h.request(`/api/v1/statuses/${original}/reblog`, bearer(bob, json(visibility ? { visibility } : {})))
		expect((await reblog()).status).toBe(200)
		expect((await reblog()).status).toBe(200)
		expect(await statusCount(h.store)).toBe(4)
		expect((await h.request(`/api/v1/statuses/${original}/unreblog`, bearer(bob, json({})))).status).toBe(200)
		expect((await reblog('private')).status).toBe(200)
		expect(await statusCount(h.store)).toBe(4)
		expect((await h.request(`/api/v1/statuses/${original}/unreblog`, bearer(bob, json({})))).status).toBe(200)
		expect((await reblog('unlisted')).status).toBe(200)
		expect(await statusCount(h.store)).toBe(5)
		// Edits, poll votes and deletions change nothing.
		const poll = await posted(h, token, { status: 'poll', poll: { options: ['a', 'b'], expires_in: 3600 } })
		expect(await statusCount(h.store)).toBe(6)
		const pollId = (await (await h.request(`/api/v1/statuses/${poll}`, bearer(bob))).json<{ poll: { id: string } }>())
			.poll.id
		expect((await h.request(`/api/v1/polls/${pollId}/votes`, bearer(bob, json({ choices: [0] })))).status).toBe(200)
		expect(
			(await h.request(`/api/v1/statuses/${original}`, bearer(token, json({ status: 'edited' }, { method: 'PUT' }))))
				.status
		).toBe(200)
		expect((await h.request(`/api/v1/statuses/${original}`, bearer(token, { method: 'DELETE' }))).status).toBe(200)
		expect(await counts(h.store)).toEqual([{ kind: 'statuses', day: day(NOW), value: 6 }])
		// limited is never distributable.
		await runInDurableObject(h.store, async (_instance, state) => {
			const { Db } = await import('../src/db/sql')
			countStatus(new Db(state.storage.sql), 'limited', NOW)
		})
		expect(await statusCount(h.store)).toBe(6)
	})

	it('counts a scheduled status on the day it is published, once, after a failed round', async () => {
		const h = await community(['alice'])
		const at = NOW + 2 * DAY_MS
		expect(
			(
				await post(h, h.users.alice.token, {
					status: 'later',
					visibility: 'public',
					scheduled_at: new Date(at).toISOString(),
				})
			).status
		).toBe(200)
		expect(await counts(h.store)).toEqual([])
		const publish = () =>
			publishScheduled(h.env, {
				build: () => BUILD,
				now: () => at,
				store: () => h.store,
				doorbell: () => Promise.resolve(),
			})
		await sql(
			h.store,
			"CREATE TRIGGER fail_publish BEFORE INSERT ON statuses BEGIN SELECT RAISE(ABORT, 'injected'); END"
		)
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		await publish()
		// The round ran and failed: rolled back, nothing counted.
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.scheduled.publish_failed' }))
		expect(await counts(h.store)).toEqual([])
		await sql(h.store, 'DROP TRIGGER fail_publish')
		const [retry] = await sql<{ next_attempt_at: string }>(h.store, 'SELECT next_attempt_at FROM scheduled_statuses')
		const again = Date.parse(retry!.next_attempt_at)
		for (let i = 0; i < 2; i++) {
			await publishScheduled(h.env, {
				build: () => BUILD,
				now: () => again,
				store: () => h.store,
				doorbell: () => Promise.resolve(),
			})
		}
		expect(await sql(h.store, 'SELECT id FROM scheduled_statuses')).toEqual([])
		expect(await counts(h.store)).toEqual([{ kind: 'statuses', day: day(again), value: 1 }])
	})

	it('counts no remote status', async () => {
		const { setup, mastodonNote, create, followed } = await import('./inbox-status-helpers')
		const { mastodonActor } = await import('./inbox-helpers')
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		expect(await sql(t.store, 'SELECT id FROM statuses WHERE uri = ?', note.id)).toHaveLength(1)
		expect(await counts(t.store)).toEqual([])
	})

	it('records the logins of user tokens only: no app, expired or suspended one', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const app = await appToken(h)
		expect((await h.request('/api/v1/apps/verify_credentials', bearer(app))).status).toBe(200)
		await sql(h.store, 'UPDATE oauth_tokens SET expires_at = ? WHERE account_id = ?', day(NOW), h.users.bob.id)
		expect((await h.request('/api/v1/preferences', bearer(h.users.bob.token))).status).toBe(401)
		await h.store.suspendAccount(BUILD, { accountId: h.users.carol.id, now: NOW })
		await h.store.noteActivity(BUILD, { tokenHash: await sha256Hex(h.users.carol.token), now: NOW })
		expect((await h.request('/api/v1/preferences', bearer(h.users.carol.token))).status).toBe(403)
		expect(await logins(h.store)).toEqual([])
		// The guarded branch: alice's token records.
		expect((await h.request('/api/v1/preferences', bearer(h.users.alice.token))).status).toBe(200)
		expect(await logins(h.store)).toEqual([{ day: day(NOW), account_id: h.users.alice.id }])
	})

	it('records a login when an imported active_on is later than today, and after a dump refused one', async () => {
		const h = await community(['alice'])
		await sql(h.store, "UPDATE local_accounts SET active_on = '2099-01-01'")
		const started = await h.store.dumpStart(BUILD)
		if (!started.ok) throw new Error(started.message)
		expect((await h.request('/api/v1/preferences', bearer(h.users.alice.token))).status).toBe(200)
		expect(await logins(h.store)).toEqual([])
		expect(await h.store.dumpFinish(BUILD, started.cursor, true)).toMatchObject({ ok: true })
		expect((await h.request('/api/v1/preferences', bearer(h.users.alice.token))).status).toBe(200)
		expect(await logins(h.store)).toEqual([{ day: day(NOW), account_id: h.users.alice.id }])
		expect(await sql(h.store, 'SELECT active_on FROM local_accounts')).toEqual([{ active_on: '2099-01-01' }])
	})

	it('records nothing for an account id outside the stored form, and still stamps active_on', async () => {
		const h = await community(['alice'])
		await runInDurableObject(h.store, async (_instance, state) => {
			const { Db } = await import('../src/db/sql')
			const { recordLogin } = await import('../src/domain/instance-activity')
			const db = new Db(state.storage.sql)
			for (const id of ['1', '1000000000000000000', '10000000000000000x', '10000000000000000\u0000']) {
				recordLogin(db, id, NOW)
			}
			recordLogin(db, h.users.alice.id, 8.64e15 + 1)
			recordLogin(db, h.users.alice.id, Date.parse('+010000-01-01T00:00:00.000Z'))
		})
		expect(await logins(h.store)).toEqual([])
	})
})

describe('instance activity: concurrency', () => {
	it('records a login and a post that commits while the login call is held at its Store call', async () => {
		const held = gate()
		const { calls, wrap } = holding('noteActivity', held.promise)
		const h = await community(['alice', 'bob'], 'read write', { wrapStore: wrap })
		const request = h.request('/api/v1/preferences', bearer(h.users.alice.token))
		await vi.waitFor(() => expect(calls).toHaveLength(1))
		// bob's post commits meanwhile (its own login call is held too).
		const posting = post(h, h.users.bob.token, { status: 'meanwhile', visibility: 'public' })
		await vi.waitFor(() => expect(calls).toHaveLength(2))
		expect(await statusCount(h.store)).toBe(1)
		held.open()
		expect((await request).status).toBe(200)
		expect((await posting).status).toBe(200)
		expect((await logins(h.store)).map((row) => row.account_id).sort()).toEqual(
			[h.users.alice.id, h.users.bob.id].sort()
		)
	})

	it('records no login when the account is suspended or the token expires while the call is held', async () => {
		for (const change of ['suspend', 'expire'] as const) {
			const held = gate()
			const { calls, wrap } = holding('noteActivity', held.promise)
			const h = await community(['alice'], 'read write', { wrapStore: wrap })
			const request = h.request('/api/v1/preferences', bearer(h.users.alice.token))
			await vi.waitFor(() => expect(calls).toHaveLength(1))
			if (change === 'suspend') {
				await h.store.suspendAccount(BUILD, { accountId: h.users.alice.id, now: NOW })
			} else {
				await sql(h.store, 'UPDATE oauth_tokens SET expires_at = ?', new Date(NOW - 1).toISOString())
			}
			held.open()
			expect((await request).status).toBe(200)
			expect(await logins(h.store), change).toEqual([])
		}
	})

	it('records one row for two tokens of an account whose calls are held and released together', async () => {
		const held = gate()
		const { calls, wrap } = holding('noteActivity', held.promise)
		const h = await community(['alice'], 'read write', { wrapStore: wrap })
		const second = await userToken(h, 'alice@example.com', 'read')
		const requests = [h.users.alice.token, second].map((token) => h.request('/api/v1/preferences', bearer(token)))
		await vi.waitFor(() => expect(calls).toHaveLength(2))
		held.open()
		expect((await Promise.all(requests)).map((response) => response.status)).toEqual([200, 200])
		expect(await logins(h.store)).toEqual([{ day: day(NOW), account_id: h.users.alice.id }])
	})

	it('answers the same weeks when the prune commits while the read is held: no window reads a pruned day', async () => {
		expect((ACTIVITY_WEEKS - 1) * 7).toBeLessThan(ACTIVITY_RETENTION_DAYS)
		const held = gate()
		const { calls, wrap } = holding('instanceActivity', held.promise)
		const h = await apiHarness({}, { wrapStore: wrap })
		for (const ago of [0, 3, 77, ACTIVITY_RETENTION_DAYS, ACTIVITY_RETENTION_DAYS + 1, 300]) {
			await sql(
				h.store,
				"INSERT INTO activity_counts (kind, day, value) VALUES ('statuses', ?, 1)",
				day(NOW - ago * DAY_MS)
			)
		}
		const expected = await made(h.store, NOW)
		const request = h.request(ACTIVITY)
		await vi.waitFor(() => expect(calls).toHaveLength(1))
		expect(await h.store.pruneActivity(BUILD, { now: NOW })).toEqual({ counts: 2, logins: 0 })
		held.open()
		const response = await request
		expect(await response.json()).toEqual(expected)
		expect(expected![0]!.statuses).toBe('1')
	})
})

describe('instance activity: retention', () => {
	it('keeps today, the 184 days before it and tomorrow, and the cutoff moves with the day', async () => {
		const h = await apiHarness()
		// Days relative to today: the last kept on each side, and the first deleted.
		const edges = [ACTIVITY_RETENTION_DAYS + 1, ACTIVITY_RETENTION_DAYS, 0, -1, -2]
		for (const ago of edges) {
			const at = day(NOW - ago * DAY_MS)
			for (const kind of ['statuses', 'registrations']) {
				await sql(h.store, 'INSERT INTO activity_counts (kind, day, value) VALUES (?, ?, 1)', kind, at)
			}
			await sql(h.store, 'INSERT INTO activity_logins (day, account_id) VALUES (?, ?)', at, '1'.repeat(18))
		}
		const days = async () => ({
			counts: [...new Set((await counts(h.store)).map((row) => row.day))],
			logins: (await logins(h.store)).map((row) => row.day),
		})
		const kept = (agos: number[]) => agos.map((ago) => day(NOW - ago * DAY_MS)).sort()
		expect(await h.store.pruneActivity(BUILD, { now: NOW + DAY_MS - 1 })).toEqual({ counts: 4, logins: 2 })
		expect(await days()).toEqual({ counts: kept([184, 0, -1]), logins: kept([184, 0, -1]) })
		expect(await h.store.pruneActivity(BUILD, { now: NOW + DAY_MS - 1 })).toEqual({ counts: 0, logins: 0 })
		// A day later, the oldest kept day is past the cutoff.
		expect(await h.store.pruneActivity(BUILD, { now: NOW + DAY_MS })).toEqual({ counts: 2, logins: 1 })
		expect(await days()).toEqual({ counts: kept([0, -1]), logins: kept([0, -1]) })
	})

	it('runs in the cron, and waits while the Store is readonly', async () => {
		const { handleScheduled } = await import('../src/jobs/scheduled')
		const h = await apiHarness()
		await sql(h.store, "INSERT INTO activity_counts (kind, day, value) VALUES ('statuses', '2000-01-01', 1)")
		const run = () =>
			handleScheduled({ ...h.env, MAINTENANCE: 'off' } as unknown as Env, {
				build: () => BUILD,
				now: () => NOW,
				store: () => h.store,
			})
		expect(await h.store.setMaintenance(BUILD, true)).toMatchObject({ maintenance: true })
		await run()
		expect(await counts(h.store)).toHaveLength(1)
		expect(await h.store.setMaintenance(BUILD, false)).toMatchObject({ maintenance: false })
		await run()
		expect(await counts(h.store)).toEqual([])
	})
})

describe('instance activity: dumps', () => {
	it('round-trip as stored, orphan ids, old and later days included; the restore counts nothing', async () => {
		const source = await migratedStore()
		await setAccess(source)
		await completeSetup(source)
		const rows = [
			['statuses', day(NOW), 7],
			['statuses', day(NOW - 300 * DAY_MS), 2],
			['registrations', day(NOW - 3 * DAY_MS), 1],
			['registrations', day(NOW + 5 * DAY_MS), ACTIVITY_VALUE_MAX],
		] as const
		for (const [kind, at, value] of rows) {
			await sql(source, 'INSERT INTO activity_counts (kind, day, value) VALUES (?, ?, ?)', kind, at, value)
		}
		await sql(
			source,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
			INSERT INTO activity_logins (day, account_id) SELECT ?1, printf('%018d', 900000000000000000 + i) FROM n`,
			day(NOW - 400 * DAY_MS),
			ACTIVITY_PRUNE_ROWS + 1
		)
		await sql(
			source,
			'INSERT INTO activity_logins (day, account_id) VALUES (?, ?)',
			day(NOW - 2 * DAY_MS),
			'9'.repeat(18)
		)
		await sql(
			source,
			'INSERT INTO activity_logins (day, account_id) VALUES (?, ?)',
			day(NOW + 3 * DAY_MS),
			'9'.repeat(18)
		)
		const { text } = await dumpViaRpc(source)
		const target = await migratedStore()
		await copyConfig(source, target)
		expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true, problems: [] })
		expect(await counts(target)).toEqual(await counts(source))
		expect(await logins(target)).toEqual(await logins(source))
		const weeks = (await made(target, NOW))!
		expect(weeks[0]).toMatchObject({ statuses: '7', logins: '0', registrations: '0' })
		expect(weeks[1]).toMatchObject({ statuses: '0', logins: '1', registrations: '1' })
		// Once published, the cron's rounds clear the old and later rows, a round's worth at a time.
		expect(await target.publish(BUILD, ACCESS)).toMatchObject({ ok: true })
		expect(await target.pruneActivity(BUILD, { now: NOW })).toEqual({ counts: 2, logins: ACTIVITY_PRUNE_ROWS })
		expect(await target.pruneActivity(BUILD, { now: NOW })).toEqual({ counts: 0, logins: 2 })
		expect(await logins(target)).toEqual([{ day: day(NOW - 2 * DAY_MS), account_id: '9'.repeat(18) }])
	}, 120_000)
})

// The worst case, every input the read takes at its worst at once (RES-3, RES-7): ACCOUNTS (past the login cap) logged
// in on every kept day, tomorrow and later days, both counters at ACTIVITY_VALUE_MAX on each of those days, and an
// expired backlog past a prune round in both tables; the statistics taken while the tables were empty.
const ACCOUNTS = 700
const LATER_DAYS = 9

async function worstCase(h: Pick<ApiHarness, 'store'>) {
	const first = -(ACTIVITY_RETENTION_DAYS + 3)
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT ?2 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
		INSERT INTO activity_counts (kind, day, value) SELECT k.kind, date(?1, n.i || ' days'), ?4
		FROM n, (SELECT 'statuses' AS kind UNION ALL SELECT 'registrations') k`,
		day(NOW),
		first,
		1 + LATER_DAYS,
		ACTIVITY_VALUE_MAX
	)
	await sql(
		h.store,
		`WITH RECURSIVE n(i) AS (SELECT ?2 UNION ALL SELECT i + 1 FROM n WHERE i < ?3),
		a(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM a WHERE j < ?4 - 1)
		INSERT INTO activity_logins (day, account_id) SELECT date(?1, n.i || ' days'), printf('%018d', 100000000000000000 + a.j)
		FROM n, a`,
		day(NOW),
		first,
		1 + LATER_DAYS,
		ACCOUNTS
	)
}

describe('instance activity: bounds', () => {
	// The largest answer, from the column maxima: `week` Unix seconds of a Date (at most 8.64e15 ms: 13 digits), each
	// sum of 6 days at ACTIVITY_VALUE_MAX, and logins at most ACTIVITY_LOGIN_ROWS; all digits, so JSON escapes nothing.
	const MAX_WEEK = {
		week: '9'.repeat(String(Math.floor(8.64e15 / 1000)).length),
		statuses: String(ACTIVITY_WINDOW_DAYS * ACTIVITY_VALUE_MAX),
		logins: String(ACTIVITY_LOGIN_ROWS),
		registrations: String(ACTIVITY_WINDOW_DAYS * ACTIVITY_VALUE_MAX),
	}
	const MAX_ANSWER_BYTES = new TextEncoder().encode(JSON.stringify(Array(ACTIVITY_WEEKS).fill(MAX_WEEK))).length
	// Each window: the login cap, and each sum's 6 days plus the row that ends its range.
	const WINDOW_ROWS = ACTIVITY_LOGIN_ROWS + 2 * (ACTIVITY_WINDOW_DAYS + 1)

	it('derives the largest answer from the column maxima', () => {
		expect(Number.isSafeInteger(ACTIVITY_WINDOW_DAYS * ACTIVITY_VALUE_MAX)).toBe(true)
		expect(MAX_WEEK.statuses).toHaveLength(13)
		expect(MAX_ANSWER_BYTES).toBe(1189)
		// The figures the tests' names and docs/threat-model.md state.
		expect([WINDOW_ROWS, ACTIVITY_RETENTION_DAYS, ACTIVITY_PRUNE_ROWS]).toEqual([614, 184, 500])
	})

	it('reads each window by key within 614 rows at the worst case, with stale statistics', async () => {
		const h = await apiHarness()
		const { after } = await staleStatistics(h, {
			capture: () => plannedRun(h, /FROM activity_/, madeInstanceActivity, { now: NOW }),
			grow: () => worstCase(h),
		})
		const { result, plans } = after
		expect(plans).toHaveLength(ACTIVITY_WEEKS)
		for (const { query, plan, rows } of plans) {
			expect(query).toBe(ACTIVITY_WINDOW_SQL)
			expect(plan.filter((detail) => /activity_/.test(detail))).toEqual([
				'SEARCH activity_counts USING PRIMARY KEY (kind=? AND day>? AND day<?)',
				'SEARCH activity_logins USING PRIMARY KEY (day>? AND day<?)',
				'SEARCH activity_counts USING PRIMARY KEY (kind=? AND day>? AND day<?)',
			])
			expect(scansOf(plan, ['activity_counts', 'activity_logins'])).toEqual([])
			expect(rows).toBeLessThanOrEqual(WINDOW_ROWS)
		}
		// The login cap is reached in every window (the guard), and so is every sum's maximum.
		expect(plans.slice(1).every((plan) => plan.rows === WINDOW_ROWS)).toBe(true)
		const weeks = JSON.parse(result!) as ActivityWeek[]
		expect(weeks.map((week) => [week.statuses, week.logins, week.registrations])).toEqual(
			weeks.map((_, i) => {
				const sum = String((i === 0 ? 1 : ACTIVITY_WINDOW_DAYS) * ACTIVITY_VALUE_MAX)
				return [sum, String(ACTIVITY_LOGIN_ROWS), sum]
			})
		)
		expect(new TextEncoder().encode(result!).length).toBeLessThanOrEqual(MAX_ANSWER_BYTES)
		// The request's whole path: the lookup, then the read that keeps the answer.
		const lookup = await rowsRead(h, instanceActivity, { now: NOW })
		const keep = await rowsRead(h, keepInstanceActivity, { now: NOW })
		expect(lookup).toBeLessThanOrEqual(4)
		expect(keep).toBeLessThanOrEqual(4 + ACTIVITY_WEEKS * WINDOW_ROWS)
		// A day's answer is read again, not made: the lookup alone.
		expect(
			await runInDurableObject(h.store, (_i, state) => instanceActivity.run(state.storage.sql, { now: NOW }))
		).toEqual({ status: 'kept', body: result })
	}, 120_000)

	it('prunes by key at most 500 rows a table a run at the worst case, with stale statistics', async () => {
		const h = await apiHarness()
		const { after } = await staleStatistics(h, {
			capture: () => plannedRun(h, /activity_/, pruneActivity, { now: NOW }),
			grow: () => worstCase(h),
		})
		// 3 expired and 9 later days of each kind; 2,100 expired and 6,300 later login rows.
		expect(after.result).toEqual({ counts: 2 * (3 + LATER_DAYS), logins: ACTIVITY_PRUNE_ROWS })
		for (const { plan } of after.plans) {
			expect(plan.filter((detail) => /^(SEARCH|SCAN) /.test(detail))).toEqual([
				expect.stringMatching(
					/^SEARCH activity_(counts|logins) USING PRIMARY KEY \((kind=\? AND day=\?|day=\? AND account_id=\?)\)$/
				),
				expect.stringMatching(/^SEARCH activity_(counts|logins) USING PRIMARY KEY \((kind=\? AND )?day[<>]\?\)$/),
			])
		}
		// Each row deleted is found by its key's range and deleted by its key: at most 6 rows read for it.
		const rows = after.plans.reduce((total, plan) => total + plan.rows, 0)
		expect(rows).toBeLessThanOrEqual(2 * 6 * ACTIVITY_PRUNE_ROWS)
		// The next runs finish the backlog, a full round each, then find nothing.
		const rounds = []
		for (;;) {
			const round = await h.store.pruneActivity(BUILD, { now: NOW })
			if (round.counts === 0 && round.logins === 0) break
			rounds.push(round)
		}
		const backlog = (3 + LATER_DAYS) * ACCOUNTS - ACTIVITY_PRUNE_ROWS
		expect(rounds).toEqual(
			Array.from({ length: Math.ceil(backlog / ACTIVITY_PRUNE_ROWS) }, (_, i) => ({
				counts: 0,
				logins: Math.min(ACTIVITY_PRUNE_ROWS, backlog - i * ACTIVITY_PRUNE_ROWS),
			}))
		)
		expect(await sql(h.store, 'SELECT count(*) AS n FROM activity_logins')).toEqual([
			{ n: (ACTIVITY_RETENTION_DAYS + 2) * ACCOUNTS },
		])
	}, 120_000)
})

describe('instance activity: stored bounds', () => {
	it("writes only what the CHECKs accept: utcDay's days and isActivityAccountId's ids are theirs", async () => {
		const h = await apiHarness()
		await runInDurableObject(h.store, (_instance, state) => {
			const sql = state.storage.sql
			// Whether `run` passes the CHECKs; rolled back either way.
			const ROLLBACK = new Error('rollback')
			const accepted = (run: () => void) => {
				try {
					state.storage.transactionSync(() => {
						run()
						throw ROLLBACK
					})
				} catch (error) {
					return error === ROLLBACK
				}
				return false
			}
			fc.assert(
				fc.property(
					fc.oneof(fc.integer({ min: -9e15, max: 9e15 }), fc.constantFrom(-62167219200001, 253402300800000)),
					(now) => {
						const day = utcDay(now)
						const stored = accepted(() =>
							sql.exec("INSERT INTO activity_counts (kind, day, value) VALUES ('statuses', ?, 1)", day)
						)
						expect(stored, String(now)).toBe(day !== null)
						if (day !== null) {
							expect(day).toBe(new Date(now).toISOString().slice(0, 10))
						}
					}
				),
				{ numRuns: 300, examples: [[0], [-62167219200000], [253402300799999]] }
			)
			fc.assert(
				fc.property(
					fc.oneof(
						fc.stringMatching(/^[0-9]{16,20}$/),
						fc.string({ unit: 'binary', maxLength: 20 }),
						fc.stringMatching(/^[0-9]{17}$/).map((s) => `${s}\u0000`)
					),
					(id) => {
						const stored = accepted(() =>
							sql.exec("INSERT INTO activity_logins (day, account_id) VALUES ('2026-10-12', ?)", id)
						)
						expect(stored, JSON.stringify(id)).toBe(isActivityAccountId(id))
					}
				),
				{ numRuns: 500 }
			)
		})
	})
})
