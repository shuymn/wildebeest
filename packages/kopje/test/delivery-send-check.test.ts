import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ApiHarness, bearer, form, login, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { LEGACY } from './federation-helpers'
import { BUILD, freshStore, testKernel } from './helpers'
import { deferred, deliveryDeps } from './quote-helpers'
import { community, post, remoteAccount, remoteFollows, type User } from './status-helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { Db } from '../src/db/sql'
import { type Claim, claimDeliveries, enqueueActivity, LEASE_MS, PROVENANCE_MAX } from '../src/domain/deliveries'
import { setHostPolicyForTests } from '../src/domain/host-policy'
import { moderationRound, REACH_ROUND, suspendLocal, unsuspendLocal } from '../src/domain/suspension'
import { deliveryRound } from '../src/jobs/deliver'
import { endPolls } from '../src/jobs/scheduled'
import type { StoreStub } from '../src/platform/store-client'

// VIS-30's delivery plumbing (deliveries.ts): the provenance each staged target carries (the recipients behind it,
// merged across followers, addressed accounts and poll voters), the send-time check at the claim and at confirmation
// (sendRefused), and the fallback of a row without provenance to the inbox host rule. Before remote suspension (B1b)
// and instance domain blocks (B2a), a recipient is made unavailable by its deletion (an inbound Delete of the actor and
// its purge), and the host rule by the test hook of host-policy.ts.

type Row = {
	id: string
	inbox: string
	type: string
	state: string
	accounts: string | null
	domains: string | null
	many: number | null
}

function rows(store: StoreStub): Promise<Row[]> {
	return sql<Row>(
		store,
		`SELECT CAST(d.id AS TEXT) AS id, d.inbox_url AS inbox, json_extract(o.body, '$.activity.type') AS type, d.state,
			d.recipient_accounts AS accounts, d.recipient_domains AS domains, d.recipients_many AS many
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
	)
}

function claim(store: StoreStub, leaseToken: string): Promise<Claim> {
	return store.claimDeliveries(BUILD, { now: NOW, leaseToken })
}

// The remote account's deletion through the inbox (an inbound Delete of the actor), its purge run to the end: the
// account row is gone.
async function purge(store: StoreStub, accountId: string): Promise<void> {
	const [account] = await sql<{ uri: string }>(store, 'SELECT uri FROM accounts WHERE id = ?', accountId)
	const uri = account!.uri
	await store.receiveActivity(BUILD, {
		now: NOW,
		origin: 'https://kopje.test',
		actorUri: uri,
		actor: null,
		activity: { type: 'DeleteActor', id: `${uri}#delete` },
	})
	for (let call = 0; (await store.runInboundJobs(BUILD, { now: NOW })).pending; call++) {
		expect(call).toBeLessThan(50)
	}
	expect(await sql(store, 'SELECT id FROM accounts WHERE id = ?', accountId)).toEqual([])
}

// Claims until nothing is due; the activity type and inbox of each row claimed (and completed), in order.
async function drain(store: StoreStub): Promise<[string, string][]> {
	const sent: [string, string][] = []
	for (let round = 0; round < 20; round++) {
		const leaseToken = `drain-${round}`
		const claimed = await claim(store, leaseToken)
		for (const delivery of claimed.deliveries) {
			const confirmation = await store.confirmDelivery(BUILD, { id: delivery.id, leaseToken, now: NOW })
			expect(confirmation.status).toBe('send')
			sent.push([(JSON.parse(delivery.body) as { type: string }).type, delivery.inbox])
			await store.completeDelivery(BUILD, {
				id: delivery.id,
				leaseToken,
				now: NOW,
				outcome: { kind: 'delivered', status: 202 },
			})
		}
		if (claimed.deliveries.length === 0 && claimed.nextDueAt === null) {
			return sent
		}
	}
	throw new Error('the deliveries did not drain')
}

const sorted = (ids: string[]) => JSON.stringify([...ids].sort())

afterEach(() => {
	setHostPolicyForTests(null)
})

describe('provenance (VIS-30)', () => {
	it.each([
		['both', ['a', 'b'], []],
		['one', ['a'], [['Create', 'https://shared.example/inbox']]],
	] as const)('two followers share an inbox: content is dropped when %s of them is gone', async (_, gone, expected) => {
		const h = await community(['alice'])
		const ids = {
			a: await remoteAccount(h.store, 'a', 'shared.example'),
			b: await remoteAccount(h.store, 'b', 'shared.example'),
		}
		await remoteFollows(h.store, ids.a, h.users.alice.id)
		await remoteFollows(h.store, ids.b, h.users.alice.id)
		await post(h, h.users.alice, { status: 'hello' })
		expect((await rows(h.store)).map((r) => ({ ...r, id: 'any' }))).toEqual([
			{
				id: 'any',
				inbox: 'https://shared.example/inbox',
				type: 'Create',
				state: 'pending',
				accounts: sorted([ids.a, ids.b]),
				domains: '["shared.example"]',
				many: null,
			},
		])
		for (const name of gone) {
			await purge(h.store, ids[name])
		}
		expect(await drain(h.store)).toEqual(expected)
		expect(await rows(h.store)).toEqual([])
	})

	it('merges the recipients behind an inbox across followers, addressed accounts and silent copies', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const fan = await remoteAccount(h.store, 'fan', 'shared.example')
		const named = await remoteAccount(h.store, 'named', 'shared.example')
		await remoteFollows(h.store, fan, alice.id)
		await post(h, alice, { status: '@named@shared.example hi' })
		// The follower and the named account share the shared inbox; the Create names both.
		expect((await rows(h.store)).map((r) => [r.inbox, r.accounts])).toEqual([
			['https://shared.example/inbox', sorted([fan, named])],
		])
	})

	it.each([
		['both', ['a', 'b'], []],
		['one', ['a'], ['Update']],
	] as const)(
		'two poll voters share an inbox: the poll Update is dropped when %s of them is gone',
		async (_, gone, expected) => {
			const h = await community(['alice'])
			const { alice } = h.users
			const fan = await remoteAccount(h.store, 'fan', 'fans.example')
			await remoteFollows(h.store, fan, alice.id)
			const status = await post(h, alice, { status: 'which?', poll: { options: ['x', 'y'], expires_in: 3600 } })
			const ids = {
				a: await remoteAccount(h.store, 'a', 'voters.example'),
				b: await remoteAccount(h.store, 'b', 'voters.example'),
			}
			for (const voter of [ids.a, ids.b]) {
				await sql(h.store, 'INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, 0)', status.id, voter)
				// A voter holds a row per choice.
				await sql(h.store, 'INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, 1)', status.id, voter)
			}
			await sql(h.store, 'UPDATE polls SET update_due_at = ?', new Date(NOW).toISOString())
			await endPolls(h.env, { build: () => BUILD, now: () => NOW, store: () => h.store, doorbell: vi.fn() })
			const voters = (await rows(h.store)).filter((r) => r.inbox === 'https://voters.example/inbox')
			// Voters hold the status already, so they get the Update alone (deliveries.ts).
			expect(voters.map((r) => [r.type, r.accounts, r.domains])).toEqual([
				['Update', sorted([ids.a, ids.b]), '["voters.example"]'],
			])
			for (const name of gone) {
				await purge(h.store, ids[name])
			}
			const sent = await drain(h.store)
			expect(sent.filter(([, inbox]) => inbox === 'https://voters.example/inbox').map(([type]) => type)).toEqual(
				expected
			)
			expect(sent.filter(([, inbox]) => inbox === 'https://fans.example/inbox')).not.toEqual([])
		}
	)

	it.each([
		[PROVENANCE_MAX, false],
		[PROVENANCE_MAX + 1, true],
	])('%i followers at one inbox, all being deleted: sent is %s ("many" above the bound)', async (count, sent) => {
		const h = await community(['alice'])
		const ids: string[] = []
		for (let i = 0; i < count; i++) {
			ids.push(await remoteAccount(h.store, `u${i}`, 'crowd.example'))
			await remoteFollows(h.store, ids.at(-1)!, h.users.alice.id)
		}
		await post(h, h.users.alice, { status: 'to the crowd' })
		expect((await rows(h.store)).map((r) => [r.accounts, r.domains, r.many])).toEqual([
			sent ? [null, '["crowd.example"]', 1] : [sorted(ids), '["crowd.example"]', null],
		])
		// Their deletion starts (the first transaction of each purge), before their follows are removed.
		await sql(h.store, "UPDATE accounts SET deleted_at = ? WHERE domain = 'crowd.example'", new Date(NOW).toISOString())
		expect((await drain(h.store)).length).toBe(sent ? 1 : 0)
	})
})

describe('the send-time check (VIS-30)', () => {
	it('drops content to a purged recipient and sends the retraction behind it, in lane order', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const far = await remoteAccount(h.store, 'far', 'far.example')
		await remoteFollows(h.store, far, alice.id)
		const status = await post(h, alice, { status: 'soon gone' })
		const deleted = await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: 'DELETE' }))
		expect(deleted.status).toBe(200)
		expect((await rows(h.store)).map((r) => [r.type, r.state])).toEqual([
			['Create', 'pending'],
			['Delete', 'queued'],
		])
		await purge(h.store, far)
		// The Create is dropped at its claim, which promotes the Delete; the next claim sends it.
		const first = await claim(h.store, 'first')
		expect(first.deliveries).toEqual([])
		expect(first.nextDueAt).toBe(NOW)
		expect((await rows(h.store)).map((r) => [r.type, r.state])).toEqual([['Delete', 'pending']])
		expect(await drain(h.store)).toEqual([['Delete', 'https://far.example/inbox']])
		// No receipt is written for a dropped row.
		expect(await sql(h.store, 'SELECT * FROM outbound_receipts')).toEqual([])
	})

	it('refuses by the inbox host and by the recipient hosts through the host policy, and never a retraction', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// gated lives on blocked.example behind a gateway's shared inbox; mixed shares the gateway with an open account.
		const gated = await remoteAccount(h.store, 'gated', 'blocked.example')
		await sql(h.store, "UPDATE accounts SET shared_inbox_url = 'https://gateway.example/inbox' WHERE id = ?", gated)
		const direct = await remoteAccount(h.store, 'direct', 'blocked.example')
		const open = await remoteAccount(h.store, 'open', 'open.example')
		await sql(h.store, "UPDATE accounts SET shared_inbox_url = 'https://mixed.example/inbox' WHERE id = ?", open)
		const mixed = await remoteAccount(h.store, 'mixed', 'blocked.example')
		await sql(h.store, "UPDATE accounts SET shared_inbox_url = 'https://mixed.example/inbox' WHERE id = ?", mixed)
		for (const follower of [gated, direct, open, mixed]) {
			await remoteFollows(h.store, follower, alice.id)
		}
		await post(h, alice, { status: 'to all' })
		expect((await rows(h.store)).map((r) => [r.inbox, r.domains])).toEqual([
			['https://blocked.example/inbox', '["blocked.example"]'],
			['https://gateway.example/inbox', '["blocked.example"]'],
			['https://mixed.example/inbox', '["blocked.example","open.example"]'],
		])
		await runInDurableObject(h.store, () => {
			setHostPolicyForTests((_db, host) => host === 'blocked.example')
		})
		const status = (await post(h, alice, { status: 'to all, again' })).id
		await h.request(`/api/v1/statuses/${status}`, bearer(alice.token, { method: 'DELETE' }))
		const sent = await drain(h.store)
		// The inbox on blocked.example and the gateway serving only it get no content; the mixed inbox does. The Delete
		// reaches every inbox the Create was queued to.
		expect(sent.filter(([type]) => type === 'Create').map(([, inbox]) => inbox)).toEqual([
			'https://mixed.example/inbox',
			'https://mixed.example/inbox',
		])
		expect(
			sent
				.filter(([type]) => type === 'Delete')
				.map(([, inbox]) => inbox)
				.sort()
		).toEqual(['https://blocked.example/inbox', 'https://gateway.example/inbox', 'https://mixed.example/inbox'])
	})
})

describe('the personal-inbox fallback (VIS-30)', () => {
	it('moves content to an available recipient, never to one the check would refuse', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		// Both on one server, A first by id: A's deletion has started, B is available.
		const a = await remoteAccount(h.store, 'a', 'shared.example')
		const b = await remoteAccount(h.store, 'b', 'shared.example')
		await runInDurableObject(h.store, (_instance, state) =>
			state.storage.transactionSync(() =>
				enqueueActivity(
					new Db(state.storage.sql),
					alice.id,
					{
						// An activity without to, as a forwarded Flag naming both is.
						activity: {
							type: 'Flag',
							id: 'https://kopje.test/ap/flags/1',
							actor: 'https://kopje.test/actor',
							object: ['https://shared.example/users/a', 'https://shared.example/users/b'],
						},
						audience: { followers: false, accounts: [a, b] },
					},
					NOW
				)
			)
		)
		expect((await rows(h.store)).map((r) => [r.inbox, r.accounts])).toEqual([
			['https://shared.example/inbox', sorted([a, b])],
		])
		await sql(h.store, 'UPDATE accounts SET deleted_at = ? WHERE id = ?', new Date(NOW).toISOString(), a)
		const first = await claim(h.store, 'shared')
		expect(first.deliveries.map((d) => d.inbox)).toEqual(['https://shared.example/inbox'])
		// The shared inbox is missing (404): the row moves to B's personal inbox, not A's.
		expect(
			await h.store.completeDelivery(BUILD, {
				id: first.deliveries[0]!.id,
				leaseToken: 'shared',
				now: NOW,
				outcome: { kind: 'failed', status: 404, error: 'HTTP 404', permanent: true },
			})
		).toMatchObject({ status: 'retry' })
		expect((await rows(h.store)).map((r) => [r.inbox, r.accounts])).toEqual([
			['https://shared.example/users/b/inbox', JSON.stringify([b])],
		])
		expect(await drain(h.store)).toEqual([['Flag', 'https://shared.example/users/b/inbox']])
	})
})

describe('rows queued before migration 0043', () => {
	it('fall back to the inbox host rule only', async () => {
		const store = freshStore()
		const at = MIGRATIONS.findIndex((m) => m.name === '0043_delivery_provenance')
		const result = await runInDurableObject(store, async (_instance, state) => {
			const sql = state.storage.sql
			await testKernel(state, MIGRATIONS.slice(0, at)).upgrade()
			// A local sender, and a remote recipient whose deletion has started.
			sql.exec(
				`INSERT INTO accounts (id, uri, username, domain, inbox_url, deleted_at) VALUES
				('100000000000000001', 'https://kopje.test/ap/users/alice', 'alice', NULL, NULL, NULL),
				('100000000000000002', 'https://open.example/users/gone', 'gone', 'open.example',
					'https://open.example/users/gone/inbox', '2026-10-12T00:00:00.000Z')`
			)
			sql.exec(
				`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
				VALUES ('100000000000000001', 'alice@example.com', X'00', X'00', 'test')`
			)
			const body = JSON.stringify({
				activity: {
					type: 'Create',
					id: 'https://kopje.test/ap/o/1/activity',
					object: { id: 'https://kopje.test/ap/o/1' },
				},
				audience: { followers: true, accounts: [] },
			})
			sql.exec(
				`INSERT INTO outbound_activities (id, account_id, body, object_uri, retracts, created_at)
				VALUES (1, '100000000000000001', ?, 'https://kopje.test/ap/o/1', 0, ?)`,
				body,
				NOW
			)
			for (const [id, inbox] of [
				[1, 'https://blocked.example/inbox'],
				[2, 'https://open.example/users/gone/inbox'],
			] as const) {
				sql.exec(
					`INSERT INTO deliveries (id, activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
					VALUES (?, 1, '100000000000000001', ?, ?, 'pending', ?, ?)`,
					id,
					inbox,
					new URL(inbox).origin,
					NOW,
					NOW
				)
			}
			await testKernel(state).upgrade()
			setHostPolicyForTests((_db, host) => host === 'blocked.example')
			const claimed = claimDeliveries.run(sql, { now: NOW, leaseToken: 'after' })
			return {
				claimed: claimed.deliveries.map((d) => d.inbox),
				left: sql.exec('SELECT id, recipient_accounts, recipients_many FROM deliveries').toArray(),
			}
		})
		// Without provenance, the recipient being deleted is unknown to the check: only the host rule applies.
		expect(result).toEqual({
			claimed: ['https://open.example/users/gone/inbox'],
			left: [{ id: 2, recipient_accounts: null, recipients_many: null }],
		})
	})
})

// ---------------------------------------------------------------------------------------------------------------
// The Worker's round (jobs/deliver.ts): confirmation between the host check and the signed POST
// ---------------------------------------------------------------------------------------------------------------

const testEnv = { ...env, USER_KEK: LEGACY.kek } as unknown as Env

// alice signs with the legacy fixture key, so the round can load her signer.
async function signedAlice(): Promise<ApiHarness & { users: { alice: User } }> {
	const h = await community(['alice'])
	await sql(
		h.store,
		'UPDATE local_accounts SET privkey = ?, privkey_salt = ?, pubkey = ? WHERE account_id = ?',
		LEGACY.privkey.slice().buffer,
		LEGACY.salt.slice().buffer,
		LEGACY.pubkey,
		h.users.alice.id
	)
	return h
}

function recordingFetch() {
	const sent: { url: string; body: string }[] = []
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		sent.push({ url: request.url, body: await request.text() })
		return new Response(null, { status: 202 })
	})
	return { fetch: fetch as unknown as typeof globalThis.fetch, sent }
}

// A host check that holds every delivery of the round (after the claim, before confirmation) until released.
function gatedHost() {
	const reached = deferred()
	const release = deferred()
	const checkHost = async () => {
		reached.resolve()
		await release.promise
	}
	return { checkHost, reached: reached.promise, release: release.resolve }
}

describe('confirmDelivery in the round (VIS-30)', () => {
	async function followedAlice() {
		const h = await signedAlice()
		const far = await remoteAccount(h.store, 'far', 'far.example')
		await remoteFollows(h.store, far, h.users.alice.id)
		return { h, far }
	}

	it('sends nothing for a row whose recipient goes between the claim and confirmation, and promotes its lane', async () => {
		const { h, far } = await followedAlice()
		await post(h, h.users.alice, { status: 'first' })
		await post(h, h.users.alice, { status: 'second' })
		const { fetch, sent } = recordingFetch()
		const gate = gatedHost()
		const round = deliveryRound(testEnv, {
			...deliveryDeps(
				() => h.store,
				fetch,
				() => NOW
			),
			checkHost: gate.checkHost,
		})
		await gate.reached
		expect((await rows(h.store)).map((r) => r.state)).toEqual(['leased', 'queued'])
		await purge(h.store, far)
		gate.release()
		expect(await round).toEqual({ claimed: 1, settled: ['dropped'], nextDueAt: NOW })
		expect(sent).toEqual([])
		expect((await rows(h.store)).map((r) => [r.type, r.state])).toEqual([['Create', 'pending']])
	})

	it('sends a row confirmed before its recipient goes', async () => {
		const { h, far } = await followedAlice()
		await post(h, h.users.alice, { status: 'confirmed' })
		const { fetch, sent } = recordingFetch()
		const reached = deferred()
		const release = deferred()
		// The Store answers the confirmation, and the answer is held before it reaches the round.
		const store = new Proxy(h.store, {
			get: (target, name) =>
				name === 'confirmDelivery'
					? async (...args: Parameters<StoreStub['confirmDelivery']>) => {
							const confirmation = await target.confirmDelivery(...args)
							reached.resolve()
							await release.promise
							return confirmation
						}
					: (Reflect.get(target, name) as unknown),
		})
		const round = deliveryRound(
			testEnv,
			deliveryDeps(
				() => store,
				fetch,
				() => NOW
			)
		)
		await reached.promise
		await purge(h.store, far)
		release.resolve()
		expect(await round).toMatchObject({ claimed: 1, settled: ['delivered'] })
		expect(sent.map((s) => s.url)).toEqual(['https://far.example/inbox'])
		const body = JSON.parse(sent[0]!.body) as { type: string; object: { content: string } }
		expect([body.type, body.object.content]).toEqual(['Create', '<p>confirmed</p>'])
	})

	it('sends nothing when the row was claimed again before the confirmation, nor when the confirmation fails', async () => {
		const { h } = await followedAlice()
		await post(h, h.users.alice, { status: 'once' })
		const { fetch, sent } = recordingFetch()
		const gate = gatedHost()
		const late = deliveryRound(testEnv, {
			...deliveryDeps(
				() => h.store,
				fetch,
				() => NOW,
				'late'
			),
			checkHost: gate.checkHost,
		})
		await gate.reached
		// The lease runs out; another round claims the row again and delivers it.
		expect(
			await deliveryRound(
				testEnv,
				deliveryDeps(
					() => h.store,
					fetch,
					() => NOW + LEASE_MS,
					'again'
				)
			)
		).toMatchObject({ claimed: 1, settled: ['delivered'] })
		gate.release()
		expect(await late).toMatchObject({ claimed: 1, settled: [] })
		expect(sent).toHaveLength(1)

		await post(h, h.users.alice, { status: 'unconfirmed' })
		const failing = new Proxy(h.store, {
			get: (target, name) =>
				name === 'confirmDelivery'
					? () => Promise.reject(new Error('Network connection lost.'))
					: (Reflect.get(target, name) as unknown),
		})
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(
			await deliveryRound(
				testEnv,
				deliveryDeps(
					() => failing,
					fetch,
					() => NOW + LEASE_MS,
					'failing'
				)
			)
		).toMatchObject({ claimed: 1, settled: [] })
		expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.delivery.confirm.failed' }))
		errors.mockRestore()
		expect(sent).toHaveLength(1)
		// The row stays leased until its lease ends, and is claimed again then.
		expect((await rows(h.store)).map((r) => r.state)).toEqual(['leased'])
	})

	it('costs one Store call per delivery: the claim, then a confirmation and a completion each', async () => {
		const h = await signedAlice()
		for (const domain of ['one.example', 'two.example']) {
			await remoteFollows(h.store, await remoteAccount(h.store, 'fan', domain), h.users.alice.id)
		}
		await post(h, h.users.alice, { status: 'counted' })
		const calls: string[] = []
		const counted = new Proxy(h.store, {
			get: (target, name) => {
				const value = Reflect.get(target, name) as unknown
				return typeof value === 'function'
					? (...args: unknown[]) => {
							calls.push(String(name))
							return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[String(name)]!(...args)
						}
					: value
			},
		})
		const { fetch, sent } = recordingFetch()
		expect(
			await deliveryRound(
				testEnv,
				deliveryDeps(
					() => counted,
					fetch,
					() => NOW
				)
			)
		).toMatchObject({
			claimed: 2,
			settled: ['delivered', 'delivered'],
		})
		expect(sent).toHaveLength(2)
		expect(calls.sort()).toEqual([
			'claimDeliveries',
			'completeDelivery',
			'completeDelivery',
			'confirmDelivery',
			'confirmDelivery',
		])
	})

	it('sends the document of a profile edit made between the claim and confirmation', async () => {
		const h = await signedAlice()
		const { alice } = h.users
		// More inboxes than one round of the restoration's staging writes, so it is still staging when claimed.
		const followers = REACH_ROUND + 1
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
			SELECT CAST(700000000000000000 + i AS TEXT), 'https://f' || i || '.example/users/f', 'f', 'f' || i || '.example',
				'https://f' || i || '.example/users/f/inbox', 'https://f' || i || '.example/inbox' FROM n`,
			followers
		)
		await sql(
			h.store,
			`INSERT INTO follows (account_id, target_account_id, state)
			SELECT id, ?, 'accepted' FROM accounts WHERE domain LIKE 'f%.example'`,
			alice.id
		)
		// Suspended and unsuspended at once: the restoration's Update supersedes the suspension's, which never stages.
		const staging = await runInDurableObject(h.store, (_instance, state) =>
			state.storage.transactionSync(() => {
				const db = new Db(state.storage.sql)
				suspendLocal(db, alice.id, null, NOW)
				unsuspendLocal(db, alice.id, NOW)
				for (let round = 0; round < 50; round++) {
					moderationRound(db, NOW)
					const intent = db.first<{ staged: string | null }>(
						`SELECT o.staged FROM outbound_activities o WHERE o.account_id = ? AND o.superseded = 0
							AND EXISTS (SELECT 1 FROM outbound_targets c WHERE c.activity_id = o.id)`,
						alice.id
					)
					if (intent !== undefined) {
						return intent.staged !== null
					}
				}
				return false
			})
		)
		expect(staging).toBe(true)
		const { fetch, sent } = recordingFetch()
		const gate = gatedHost()
		const round = deliveryRound(testEnv, {
			...deliveryDeps(
				() => h.store,
				fetch,
				() => NOW
			),
			checkHost: gate.checkHost,
		})
		await gate.reached
		const { token } = await login(h, { email: 'alice@example.com', scope: 'read write' })
		const edited = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(token, form({ display_name: 'Alice again' }, { method: 'PATCH' }))
		)
		expect(edited.status).toBe(200)
		gate.release()
		const result = await round
		expect(result.claimed).toBeGreaterThan(0)
		expect(sent).toHaveLength(result.claimed)
		for (const { body } of sent) {
			expect(JSON.parse(body)).toMatchObject({ type: 'Update', object: { name: 'Alice again' } })
		}
	})
})
