import { runInDurableObject } from 'cloudflare:test'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ApiHarness, bearer, seedAccount, sql, userToken } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { appToken, DAY_MS, plannedRun, remoteAccounts, scansOf, staleStatistics } from './read-helpers'
import { storeWith } from './setup-helpers'
import { community } from './status-helpers'
import { signIn } from './web-helpers'
import { lookupAccount } from '../src/domain/accounts'
import { noteActivity } from '../src/domain/auth'
import { INSTANCE_COUNTS_SQL, instanceInfo } from '../src/domain/instance'
import { ACTIVITY_MEMO_LIMIT, ActivityMemo } from '../src/mastodon/activity'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

// RES-6: activity recording (domain/auth.ts noteActivity, mastodon/activity.ts). At most one Store call per isolate,
// token and UTC day after the response, at most one row write per account and UTC day, by key only; what it may not
// write, and how a failure leaves the day to a later request.

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

// The Store with noteActivity counted, and failing while `fail` returns an error to throw.
function counted(fail: () => Error | null = () => null) {
	const calls: unknown[] = []
	const wrap = (store: StoreStub): StoreStub =>
		storeWith(store, {
			noteActivity: (build, input) => {
				calls.push(input)
				const error = fail()
				return error === null ? store.noteActivity(build as string, input as never) : Promise.reject(error)
			},
		})
	return { calls, wrap }
}

const activeOn = async (h: Pick<ApiHarness, 'store'>, accountId: string) =>
	(
		await sql<{ active_on: string | null }>(
			h.store,
			'SELECT active_on FROM local_accounts WHERE account_id = ?',
			accountId
		)
	)[0]?.active_on

const preferences = (h: ApiHarness, token: string) => h.request('/api/v1/preferences', bearer(token))

afterEach(() => {
	vi.restoreAllMocks()
})

describe('activity recording', () => {
	it("records a token's first request of the UTC day, then sends no call until the next day", async () => {
		const { calls, wrap } = counted()
		const h = await community(['alice'], 'read write', { wrapStore: wrap })
		const { id, token } = h.users.alice
		expect(await activeOn(h, id)).toBeNull()
		expect((await preferences(h, token)).status).toBe(200)
		expect(await activeOn(h, id)).toBe(day(NOW))
		expect(calls).toHaveLength(1)
		expect((await preferences(h, token)).status).toBe(200)
		expect((await h.request('/api/v1/accounts/verify_credentials', bearer(token))).status).toBe(200)
		expect(calls).toHaveLength(1)
		h.now.mockReturnValue(NOW + DAY_MS)
		expect((await preferences(h, token)).status).toBe(200)
		expect(calls).toHaveLength(2)
		expect(await activeOn(h, id)).toBe(day(NOW + DAY_MS))
	})

	it('records nothing for an app token or an answer of 400 and above', async () => {
		const { calls, wrap } = counted()
		const h = await community(['alice'], 'read write', { wrapStore: wrap })
		const app = await appToken(h)
		expect((await h.request('/api/v1/apps/verify_credentials', bearer(app))).status).toBe(200)
		expect(calls).toHaveLength(1)
		expect((await preferences(h, 'nope')).status).toBe(401)
		expect((await h.request('/api/v1/statuses/1', bearer(h.users.alice.token))).status).toBe(404)
		expect(calls).toHaveLength(1)
		expect(await activeOn(h, h.users.alice.id)).toBeNull()
	})

	it('writes nothing in the Store for an unknown, app, expired or stale-epoch token', async () => {
		const h = await community(['alice', 'bob'])
		const note = async (token: string, now = NOW) =>
			h.store.noteActivity(BUILD, { tokenHash: await sha256Hex(token), now })
		await note('nope')
		await note(await appToken(h))
		await sql(h.store, 'UPDATE oauth_tokens SET expires_at = ? WHERE account_id = ?', day(NOW), h.users.alice.id)
		await note(h.users.alice.token)
		await sql(
			h.store,
			'UPDATE local_accounts SET credential_epoch = credential_epoch + 1 WHERE account_id = ?',
			h.users.bob.id
		)
		await note(h.users.bob.token)
		expect(await sql(h.store, 'SELECT active_on FROM local_accounts')).toEqual([
			{ active_on: null },
			{ active_on: null },
		])
	})

	it('only moves the day forward, and writes one row per account and day whichever token asks', async () => {
		const h = await community(['alice'])
		const { id, token } = h.users.alice
		const other = await userToken(h, 'alice@example.com', 'read')
		const writes: number[] = []
		const run = (t: string, now: number) =>
			runInDurableObject(h.store, async (_instance, state) => {
				const real = state.storage.sql
				const observed = {
					exec: (query: string, ...params: SqlStorageValue[]) => {
						const cursor = real.exec(query, ...params)
						if (/^UPDATE local_accounts/.test(query)) {
							writes.push(cursor.rowsWritten)
						}
						return cursor
					},
				} as unknown as SqlStorage
				noteActivity.run(observed, { tokenHash: await sha256Hex(t), now })
			})
		// Day D+1 commits first; a delayed request of day D leaves D+1.
		await run(token, NOW + DAY_MS)
		await run(token, NOW)
		expect(await activeOn(h, id)).toBe(day(NOW + DAY_MS))
		// Another token of the account, the same day: no row written.
		await run(other, NOW + DAY_MS)
		expect(writes.map((n) => n > 0)).toEqual([true, false, false])
	})

	it('drops a refusal during a dump silently, and a later request of the day records', async () => {
		const h = await community(['alice'])
		const error = vi.spyOn(console, 'error')
		const started = await h.store.dumpStart(BUILD)
		if (!started.ok) throw new Error(started.message)
		expect((await preferences(h, h.users.alice.token)).status).toBe(200)
		expect(await activeOn(h, h.users.alice.id)).toBeNull()
		expect(
			error.mock.calls.filter(([entry]) => (entry as { event?: string })?.event === 'kopje.activity.failed')
		).toEqual([])
		expect(await h.store.dumpFinish(BUILD, started.cursor, true)).toMatchObject({ ok: true })
		expect((await preferences(h, h.users.alice.token)).status).toBe(200)
		expect(await activeOn(h, h.users.alice.id)).toBe(day(NOW))
	})

	it('logs another failure, and a later request of the day records', async () => {
		let failures = 1
		const { calls, wrap } = counted(() => (failures-- > 0 ? new Error('transient') : null))
		const h = await community(['alice'], 'read write', { wrapStore: wrap })
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect((await preferences(h, h.users.alice.token)).status).toBe(200)
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.activity.failed' }))
		expect(await activeOn(h, h.users.alice.id)).toBeNull()
		expect((await preferences(h, h.users.alice.token)).status).toBe(200)
		expect(calls).toHaveLength(2)
		expect(await activeOn(h, h.users.alice.id)).toBe(day(NOW))
	})

	it('records a signed-in settings page', async () => {
		const h = await community(['alice'])
		// The web session is an access token of the web client, read from its cookie.
		const browser = await signIn(h)
		expect(await activeOn(h, h.users.alice.id)).toBeNull()
		expect((await h.request('/settings', { headers: { cookie: browser.cookie } })).status).toBe(200)
		expect(await activeOn(h, h.users.alice.id)).toBe(day(NOW))
	})
})

// A promise settled by hand: the gate a test holds a call at.
function gate() {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('ActivityMemo', () => {
	it('sends once per token and day, and clears at the day change and at ACTIVITY_MEMO_LIMIT tokens', async () => {
		const memo = new ActivityMemo()
		const send = vi.fn(() => Promise.resolve())
		expect(memo.note('a', NOW, send)).not.toBeNull()
		expect(memo.note('a', NOW + 1000, send)).toBeNull()
		expect(memo.note('a', NOW + DAY_MS, send)).not.toBeNull()
		expect(memo.size).toBe(1)
		for (let i = 1; i < ACTIVITY_MEMO_LIMIT; i++) {
			void memo.note(`t${i}`, NOW + DAY_MS, send)
		}
		expect(memo.size).toBe(ACTIVITY_MEMO_LIMIT)
		void memo.note('one more', NOW + DAY_MS, send)
		expect(memo.size).toBe(1)
		expect(memo.note('a', NOW + DAY_MS, send)).not.toBeNull()
		expect(send).toHaveBeenCalledTimes(ACTIVITY_MEMO_LIMIT + 3)
	})

	it('forgets a failed token so the next request sends again', async () => {
		const memo = new ActivityMemo()
		await expect(memo.note('a', NOW, () => Promise.reject(new Error('x')))).rejects.toThrow('x')
		expect(memo.has('a')).toBe(false)
		expect(memo.note('a', NOW, () => Promise.resolve())).not.toBeNull()
	})

	for (const [crossing, cross] of [
		['a day change', (memo: ActivityMemo) => void memo.note('b', NOW + DAY_MS, () => Promise.resolve())],
		[
			'a cap reset',
			(memo: ActivityMemo) => {
				for (let i = 0; i < ACTIVITY_MEMO_LIMIT; i++) {
					void memo.note(`t${i}`, NOW, () => Promise.resolve())
				}
			},
		],
	] as const) {
		it(`never adds back a late success's token cleared by ${crossing}`, async () => {
			const memo = new ActivityMemo()
			const held = gate()
			const late = memo.note('a', NOW, () => held.promise)
			cross(memo)
			expect(memo.has('a')).toBe(false)
			held.resolve()
			await late
			expect(memo.has('a')).toBe(false)
		})

		it(`never removes a newer entry on a late failure across ${crossing}`, async () => {
			const memo = new ActivityMemo()
			const held = gate()
			const late = memo.note('a', NOW, () => held.promise)
			cross(memo)
			const now = crossing === 'a day change' ? NOW + DAY_MS : NOW
			expect(memo.note('a', now, () => Promise.resolve())).not.toBeNull()
			held.reject(new Error('late'))
			await expect(late).rejects.toThrow('late')
			expect(memo.has('a')).toBe(true)
			expect(memo.note('a', now, () => Promise.resolve())).toBeNull()
		})
	}
})

describe('activity plans with stale statistics (RES-7)', () => {
	it('seeks the token, its client and the account by key, all grown after ANALYZE', async () => {
		const h = await community(['alice', 'bob'])
		const tokenHash = await sha256Hex(h.users.alice.token)
		let now = NOW
		const { after } = await staleStatistics(h, {
			capture: () => plannedRun(h, /oauth_tokens|local_accounts/, noteActivity, { tokenHash, now: (now += DAY_MS) }),
			grow: async () => {
				await sql(
					h.store,
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
					INSERT INTO oauth_clients (id, secret, name, redirect_uris, website, scopes, created_at)
					SELECT 'grown-' || i, 's', 'Grown', 'https://client.test/cb', NULL, 'read', '2026-10-01T00:00:00.000Z' FROM n`
				)
				await remoteAccounts(h, 50, 40)
				for (let i = 0; i < 30; i++) {
					await seedAccount(h.store, { username: `u${i}`, email: `u${i}@example.com` })
				}
			},
		})
		const plans = after.plans.map((p) => p.plan)
		expect(plans).toHaveLength(2)
		expect(plans[0]).toEqual([
			'SEARCH t USING PRIMARY KEY (token_hash=?)',
			'SEARCH c USING INDEX sqlite_autoindex_oauth_clients_1 (id=?)',
			'SEARCH l USING INDEX sqlite_autoindex_local_accounts_1 (account_id=?) LEFT-JOIN',
		])
		expect(plans[1]).toEqual(['SEARCH local_accounts USING INDEX sqlite_autoindex_local_accounts_1 (account_id=?)'])
		expect(plans.flatMap((plan) => scansOf(plan, ['t', 'c', 'l', 'local_accounts']))).toEqual([])
		expect(await activeOn(h, h.users.alice.id)).toBe(day(now))
	}, 60_000)

	it("counts the active users in the users count's one scan, and seeks the contact by its index", async () => {
		const h = await community(['alice'])
		await seedAccount(h.store, { username: 'bob', domain: 'remote.test' })
		const present = { origin: 'https://kopje.test' }
		const CONTACTS = [
			['alice', 'accounts_local_username'],
			['bob@remote.test', 'accounts_domain_username'],
		] as const
		const { after } = await staleStatistics(h, {
			capture: async () => {
				const runs = []
				for (const [contact] of CONTACTS) {
					await sql(
						h.store,
						"INSERT OR REPLACE INTO instance_settings (name, value) VALUES ('contact_username', ?)",
						contact
					)
					runs.push(await plannedRun(h, /local_accounts l|INDEXED BY accounts_/, instanceInfo, { now: NOW, present }))
				}
				return runs
			},
			grow: async () => {
				await remoteAccounts(h, 20, 20)
				for (let i = 0; i < 30; i++) {
					await seedAccount(h.store, { username: `u${i}`, email: `u${i}@example.com` })
				}
			},
		})
		for (const [i, [contact, index]] of CONTACTS.entries()) {
			const { result, plans } = after[i]!
			expect(result.contactAccount).toMatchObject({ username: contact.split('@')[0] })
			const [counts, lookup] = plans
			expect(counts?.query).toBe(INSTANCE_COUNTS_SQL)
			expect(scansOf(counts!.plan, ['l', 'local_accounts'])).toEqual(['SCAN l'])
			expect(lookup?.plan.filter((detail) => /^(SEARCH|SCAN) [al] /.test(detail))).toEqual([
				expect.stringMatching(new RegExp(`^SEARCH a USING INDEX ${index} `)),
				'SEARCH l USING INDEX sqlite_autoindex_local_accounts_1 (account_id=?) LEFT-JOIN',
			])
		}
	}, 60_000)

	it('reads one row of an address many remote actors share, whatever their number', async () => {
		const h = await community(['alice'])
		const present = { origin: 'https://kopje.test' }
		// Distinct actors (ingestion keys accounts by actor id) with one username and domain, inserted in id order.
		const duplicates = (from: number, count: number) =>
			sql(
				h.store,
				`WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2 - 1)
				INSERT INTO accounts (id, uri, username, domain)
				SELECT printf('8%017d', i), 'https://remote.test/actors/' || i, CASE i % 2 WHEN 0 THEN 'dup' ELSE 'Dup' END,
					'remote.test' FROM n`,
				from,
				count
			)
		// Each statement on the address index: rows materialized (returned to the Worker) and rows read.
		const lookup = () =>
			runInDurableObject(h.store, (_instance, state) => {
				const real = state.storage.sql
				const seen: { materialized: number; read: number }[] = []
				const observed = {
					exec: (query: string, ...params: SqlStorageValue[]) => {
						const cursor = real.exec(query, ...params)
						if (!query.includes('INDEXED BY accounts_domain_username')) {
							return cursor
						}
						return {
							toArray: () => {
								const rows = cursor.toArray()
								seen.push({ materialized: rows.length, read: cursor.rowsRead })
								return rows
							},
						}
					},
				} as unknown as SqlStorage
				const account = lookupAccount.run(observed, { username: 'DUP', domain: 'remote.test', present })
				const info = instanceInfo.run(observed, { now: NOW, present })
				return { id: account?.id, contact: info.contactAccount?.id, seen }
			})
		await sql(h.store, "INSERT INTO instance_settings (name, value) VALUES ('contact_username', 'dup@remote.test')")
		await duplicates(1, 1)
		const one = await lookup()
		await duplicates(2, 199)
		const many = await lookup()
		expect(many).toEqual(one)
		expect(many.id).toBe('800000000000000001')
		expect(many.contact).toBe('800000000000000001')
		expect(many.seen.map((s) => s.materialized)).toEqual([1, 1])
	}, 60_000)
})
