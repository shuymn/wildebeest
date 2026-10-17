import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { describe, expect, it } from 'vitest'

import { bearer, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain, setSeverity, unblockDomain } from './domain-block-helpers'
import { LEGACY } from './federation-helpers'
import { BUILD } from './helpers'
import { deferred, deliveryDeps, gatedHost, recordingFetch } from './quote-helpers'
import { rowsRead } from './read-helpers'
import { adminEntity, uriOf, world } from './remote-suspension-helpers'
import { community, post, remoteAccount, remoteFollows } from './status-helpers'
import { Db } from '../src/db/sql'
import { ACCOUNT_FROM, getAccounts, MAX_ACCOUNTS_BY_ID } from '../src/domain/accounts'
import { activeSql, availableJoinedSql, availableSql, MAX_BLOCK_LABELS } from '../src/domain/audience'
import { enqueueActivity } from '../src/domain/deliveries'
import {
	createInstanceDomainBlock,
	deleteInstanceDomainBlock,
	fetchRefused,
	updateInstanceDomainBlock,
} from '../src/domain/instance-domain-blocks'
import { deliveryRound } from '../src/jobs/deliver'
import type { StoreStub } from '../src/platform/store-client'

// Instance domain blocks (R38, VIS-30): the Store operations, the precedence of the longest matching block, the live
// availability predicate on both keys of an account, account presentation, and the send-time check by domain.

const FIELDS = {
	rejectMedia: false,
	rejectReports: false,
	obfuscate: false,
	privateComment: null,
	publicComment: null,
}

// R1 through availableSql itself, the predicate every read and decision uses.
const available = async (store: StoreStub, id: string) =>
	(await sql<{ yes: number }>(store, `SELECT ${availableSql('?1')} AS yes`, id))[0]!.yes === 1

// Moves the remote account's actor id to another host, keeping its stored domain (a domain confirmed elsewhere).
const hostedOn = (store: StoreStub, id: string, host: string) =>
	sql(store, "UPDATE accounts SET uri = 'https://' || ? || '/users/' || username WHERE id = ?", host, id)

describe('the Store operations', () => {
	it('creates a normalized block, refuses a deeper one, a duplicate and a weaker child, and never reuses an id', async () => {
		const h = await community([])
		const run = <T>(fn: (sql: SqlStorage) => T) => runInDurableObject(h.store, (_i, state) => fn(state.storage.sql))
		const create = (domain: string, severity: 'suspend' | 'noop') =>
			run((s) => createInstanceDomainBlock.run(s, { ...FIELDS, domain, severity, now: NOW }))
		const first = await create(' Blocked.Example./', 'suspend')
		expect(first).toMatchObject({ ok: true, block: { domain: 'blocked.example', severity: 'suspend' } })
		expect(await create('blocked.example', 'noop')).toMatchObject({ ok: false, error: 'exists' })
		// Mastodon refuses a child that is not stricter than the block that rules it.
		expect(await create('a.blocked.example', 'noop')).toMatchObject({
			ok: false,
			error: 'exists',
			existing: { domain: 'blocked.example' },
		})
		expect(await create('a.blocked.example', 'suspend')).toMatchObject({ ok: true })
		expect(await create('not a domain', 'suspend')).toEqual({ ok: false, error: 'invalid-domain' })
		const labels = (n: number) => [...Array.from({ length: n - 1 }, (_, i) => `l${i}`), 'example'].join('.')
		expect(await create(labels(MAX_BLOCK_LABELS + 1), 'suspend')).toEqual({ ok: false, error: 'too-deep' })
		expect(await create(labels(MAX_BLOCK_LABELS), 'suspend')).toMatchObject({ ok: true })
		// The table refuses a deeper domain too, whatever writes it.
		await expect(
			sql(
				h.store,
				"INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at) VALUES (?, 'noop', 'x', 'x')",
				labels(MAX_BLOCK_LABELS + 1)
			)
		).rejects.toThrow(/CHECK constraint failed/)
		if (!first.ok) {
			throw new Error('unreachable')
		}
		const id = first.block.id
		expect(
			await run((s) =>
				updateInstanceDomainBlock.run(s, { ...FIELDS, id, severity: 'noop', publicComment: 'why', now: NOW + 1 })
			)
		).toMatchObject({ id, domain: 'blocked.example', severity: 'noop', public_comment: 'why' })
		expect(await run((s) => deleteInstanceDomainBlock.run(s, { id }))).toMatchObject({ id })
		expect(await run((s) => deleteInstanceDomainBlock.run(s, { id }))).toBeNull()
		expect(await run((s) => updateInstanceDomainBlock.run(s, { ...FIELDS, id, severity: 'noop', now: NOW }))).toBeNull()
		// The newest id deleted is not given again (AUTOINCREMENT).
		const newest = (await sql<{ id: number }>(h.store, 'SELECT max(id) AS id FROM instance_domain_blocks'))[0]!.id
		await run((s) => deleteInstanceDomainBlock.run(s, { id: newest }))
		const again = await create('again.example', 'suspend')
		expect(again.ok && again.block.id).toBe(newest + 1)
	})
})

describe('precedence: the longest matching block rules (Mastodon DomainBlock.rule_for)', () => {
	it('keeps a child noop exempt when its parent is suspended after it', async () => {
		const h = await community([])
		const child = await remoteAccount(h.store, 'c', 'a.blocked.example')
		const deep = await remoteAccount(h.store, 'deep', 'x.a.blocked.example')
		const parent = await remoteAccount(h.store, 'p', 'blocked.example')
		const sibling = await remoteAccount(h.store, 's', 'b.blocked.example')
		await blockDomain(h.store, 'a.blocked.example', 'noop')
		await blockDomain(h.store, 'blocked.example')
		expect(await Promise.all([child, deep, parent, sibling].map((id) => available(h.store, id)))).toEqual([
			true,
			true,
			false,
			false,
		])
	})

	it('makes a child available when its suspend becomes a noop while the parent stays suspended', async () => {
		const h = await community([])
		const child = await remoteAccount(h.store, 'c', 'a.blocked.example')
		const parent = await remoteAccount(h.store, 'p', 'blocked.example')
		await blockDomain(h.store, 'blocked.example')
		const block = await blockDomain(h.store, 'a.blocked.example')
		expect([await available(h.store, child), await available(h.store, parent)]).toEqual([false, false])
		await setSeverity(h.store, block.id, 'noop')
		expect([await available(h.store, child), await available(h.store, parent)]).toEqual([true, false])
		await setSeverity(h.store, block.id, 'suspend')
		expect(await available(h.store, child)).toBe(false)
		await unblockDomain(h.store, block.id)
		expect(await available(h.store, child)).toBe(false)
	})

	it('covers an account by either key: its stored domain or its actor host', async () => {
		const h = await community([])
		// Stored on blocked.example, hosted on free.example; and the reverse.
		const byDomain = await remoteAccount(h.store, 'd', 'blocked.example')
		await hostedOn(h.store, byDomain, 'free.example')
		const byHost = await remoteAccount(h.store, 'u', 'free.example')
		await hostedOn(h.store, byHost, 'social.blocked.example')
		// An exempt stored domain does not lift a covered host, nor an exempt host a covered stored domain; an account
		// whose keys are both exempt stays available.
		const exemptDomain = await remoteAccount(h.store, 'e', 'exempt.blocked.example')
		await hostedOn(h.store, exemptDomain, 'social.blocked.example')
		const exemptHost = await remoteAccount(h.store, 'x', 'blocked.example')
		await hostedOn(h.store, exemptHost, 'exempt.blocked.example')
		const exempt = await remoteAccount(h.store, 'y', 'exempt.blocked.example')
		await blockDomain(h.store, 'exempt.blocked.example', 'noop')
		await blockDomain(h.store, 'blocked.example')
		expect(
			await Promise.all([byDomain, byHost, exemptDomain, exemptHost, exempt].map((id) => available(h.store, id)))
		).toEqual([false, false, false, false, true])
	})

	it('matches a host deeper than MAX_BLOCK_LABELS by its suffixes, and keeps local accounts out', async () => {
		const h = await community(['alice'])
		const host = `${Array.from({ length: 12 }, (_, i) => `l${i}`).join('.')}.blocked.example`
		const deep = await remoteAccount(h.store, 'deep', host)
		await blockDomain(h.store, 'blocked.example')
		expect(await available(h.store, deep)).toBe(false)
		await blockDomain(h.store, 'kopje.test')
		expect(await available(h.store, h.users.alice.id)).toBe(true)
		expect(
			await runInDurableObject(h.store, (_i, state) => [
				fetchRefused.run(state.storage.sql, { host }),
				fetchRefused.run(state.storage.sql, { host: 'blocked.example.org' }),
				fetchRefused.run(state.storage.sql, { host: 'notblocked.example' }),
			])
		).toEqual([true, false, false])
	})
})

describe("the predicate's cost (availableSql)", () => {
	// Rows read by one statement judging `count` remote accounts, a tenth of them on blocked.example.
	async function judged(count: number, blocks: [string, 'suspend' | 'noop'][]) {
		const h = await community([])
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://' || iif(i % 10 = 0, 'blocked', 'd' || (i % 10)) ||
				'.example/users/u' || i, 'u' || i, iif(i % 10 = 0, 'blocked', 'd' || (i % 10)) || '.example' FROM n`,
			count
		)
		for (const [domain, severity] of blocks) {
			await blockDomain(h.store, domain, severity)
		}
		return runInDurableObject(h.store, (_instance, state) => {
			const cursor = state.storage.sql.exec<{ n: number }>(
				`SELECT count(*) AS n FROM accounts a WHERE a.id GLOB '5*' AND ${availableSql('a.id')}`
			)
			const [{ n }] = cursor.toArray() as [{ n: number }]
			return { available: n, read: cursor.rowsRead }
		})
	}

	it('adds one read per statement while no suspend block exists, and a bounded number per account otherwise', async () => {
		const none = await judged(1_000, [])
		const noop = await judged(1_000, [['blocked.example', 'noop']])
		expect(noop).toEqual(none)
		const fewer = await judged(100, [])
		// The accounts' scan, and one read of the suspend blocks' index for the statement.
		expect(none.read - fewer.read).toBe(900)
		const blocked = await judged(1_000, [['blocked.example', 'suspend']])
		const blockedFewer = await judged(100, [['blocked.example', 'suspend']])
		expect([blocked.available, blockedFewer.available]).toEqual([900, 90])
		// Per account: its row, the walk of its two-label domain, and its seeks: measured at 6 rows.
		expect(blocked.read - blockedFewer.read).toBeLessThanOrEqual(900 * 8)
	})
})

describe('the no-block fast path in result columns (account presentation)', () => {
	// `count` remote accounts whose domain and actor host have `labels` labels, and the rows read by a projection of
	// availability over them, by each form, and by the bulk account read (getAccounts) of 40 of them.
	async function projected(labels: number, blocks: [string, 'suspend' | 'noop'][]) {
		const h = await community([])
		const domain = [...Array.from({ length: labels - 2 }, (_, i) => `l${i}`), 'far', 'example'].join('.')
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(500000000000000000 + i AS TEXT), 'https://' || ?1 || '/users/u' || i, 'u' || i, ?1 FROM n`,
			domain
		)
		for (const [blocked, severity] of blocks) {
			await blockDomain(h.store, blocked, severity)
		}
		const read = (query: string) =>
			runInDurableObject(h.store, (_instance, state) => {
				const cursor = state.storage.sql.exec(query)
				cursor.toArray()
				return cursor.rowsRead
			})
		const where = "WHERE a.id GLOB '5*'"
		const ids = Array.from({ length: MAX_ACCOUNTS_BY_ID }, (_, i) => String(500000000000000000n + BigInt(i)))
		return {
			joined: await read(`SELECT a.id, ${availableJoinedSql('a', 'l')} AS v FROM ${ACCOUNT_FROM} ${where}`),
			// The joined form without domain coverage: what account presentation read before it.
			before: await read(
				`SELECT a.id, (l.suspended_at IS NULL AND ${activeSql('a')}) AS v FROM ${ACCOUNT_FROM} ${where}`
			),
			single: await read(`SELECT a.id, ${availableSql('a.id')} AS v FROM accounts a ${where}`),
			bulk: await rowsRead({ store: h.store }, getAccounts, { ids, present: { origin: 'https://kopje.test' } }),
		}
	}

	// Rows read do not count the walk of a host no block names, so they cannot tell whether a projection ran it; the
	// walk itself is counted by execution in test-node/domain-coverage-cost.test.ts.
	it('reads as before while no suspend block exists, however deep the hosts', async () => {
		const shallow = await projected(2, [])
		const deep = await projected(MAX_BLOCK_LABELS + 4, [])
		expect(deep).toEqual(shallow)
		expect(await projected(2, [['far.example', 'noop']])).toEqual(shallow)
		// One read of the suspend blocks' index per emitted predicate.
		expect(shallow.joined - shallow.before).toBeLessThanOrEqual(1)
		// Covered or not, a suspend block elsewhere makes each account pay its walk.
		const walked = await projected(2, [['elsewhere.example', 'suspend']])
		expect(walked.joined).toBeGreaterThan(shallow.joined + 1_000)
	})
})

describe('account presentation reads domain coverage live', () => {
	it('shows the account suspended in the ordinary, bulk and admin reads right after a block, and not after its delete', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r', 'blocked.example')
		const reads = async () => {
			const single = await (await w.h.request(`/api/v1/accounts/${r}`, bearer(w.alice.token))).json()
			const bulk = await (await w.h.request(`/api/v1/accounts?id[]=${r}`, bearer(w.alice.token))).json<unknown[]>()
			const admin = await adminEntity(w, r)
			return [single, bulk[0], admin.account].map((entity) => (entity as { suspended?: boolean }).suspended ?? false)
		}
		expect(await reads()).toEqual([false, false, false])
		const block = await blockDomain(w.h.store, 'blocked.example')
		expect(await reads()).toEqual([true, true, true])
		await unblockDomain(w.h.store, block.id)
		expect(await reads()).toEqual([false, false, false])
	})
})

// ---------------------------------------------------------------------------------------------------------------
// VIS-30 by domain: the send-time check at the claim and at confirmation
// ---------------------------------------------------------------------------------------------------------------

type Row = { id: string; inbox: string; type: string; state: string }

const deliveries = (store: StoreStub) =>
	sql<Row>(
		store,
		`SELECT CAST(d.id AS TEXT) AS id, d.inbox_url AS inbox, json_extract(o.body, '$.activity.type') AS type, d.state
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
	)

// Claims until nothing is due; the activity type and inbox of each row sent, in order.
async function drain(store: StoreStub): Promise<[string, string][]> {
	const sent: [string, string][] = []
	for (let round = 0; round < 1_000; round++) {
		const leaseToken = `drain-${round}`
		const claimed = await store.claimDeliveries(BUILD, { now: NOW, leaseToken })
		for (const delivery of claimed.deliveries) {
			const confirmation = await store.confirmDelivery(BUILD, { id: delivery.id, leaseToken, now: NOW })
			if (confirmation.status === 'send') {
				sent.push([(JSON.parse(confirmation.body) as { type: string }).type, delivery.inbox])
				await store.completeDelivery(BUILD, {
					id: delivery.id,
					leaseToken,
					now: NOW,
					outcome: { kind: 'delivered', status: 202 },
				})
			}
		}
		if (claimed.deliveries.length === 0 && claimed.nextDueAt === null) {
			return sent
		}
	}
	throw new Error('the deliveries did not drain')
}

describe('deliveries to a blocked domain (VIS-30)', () => {
	it('drops content at the claim, by inbox host and by a gateway inbox serving the domain, and sends the retractions', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r', 'blocked.example')
		await remoteFollows(w.h.store, r, w.alice.id)
		// g lives on blocked.example behind a gateway's inboxes.
		const g = await remoteAccount(w.h.store, 'g', 'blocked.example')
		await sql(
			w.h.store,
			"UPDATE accounts SET inbox_url = 'https://gateway.example/users/g', shared_inbox_url = 'https://gateway.example/inbox' WHERE id = ?",
			g
		)
		await remoteFollows(w.h.store, g, w.alice.id)
		const status = await post(w.h, w.alice, { status: 'to followers' })
		expect((await deliveries(w.h.store)).map((row) => [row.type, row.inbox])).toEqual([
			['Create', 'https://blocked.example/inbox'],
			['Create', 'https://gateway.example/inbox'],
		])
		await blockDomain(w.h.store, 'blocked.example')
		expect(await drain(w.h.store)).toEqual([])
		expect(await deliveries(w.h.store)).toEqual([])
		// No receipt was written, so the Delete goes where the Create was queued: by the activity's own reach, which
		// still holds the block's followers, since a block severs no follow.
		const deleted = await w.h.request(`/api/v1/statuses/${status.id}`, bearer(w.alice.token, { method: 'DELETE' }))
		expect(deleted.status).toBe(200)
		expect(new Set((await drain(w.h.store)).map(([type]) => type))).toEqual(new Set(['Delete']))
	})

	it('falls back to the inbox host for a row without provenance: dropped on the domain, sent to a gateway', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r', 'blocked.example')
		await remoteFollows(w.h.store, r, w.alice.id)
		const g = await remoteAccount(w.h.store, 'g', 'blocked.example')
		await sql(
			w.h.store,
			"UPDATE accounts SET inbox_url = 'https://gateway.example/users/g', shared_inbox_url = 'https://gateway.example/inbox' WHERE id = ?",
			g
		)
		await remoteFollows(w.h.store, g, w.alice.id)
		await post(w.h, w.alice, { status: 'queued long ago' })
		await sql(w.h.store, 'UPDATE deliveries SET recipient_accounts = NULL, recipient_domains = NULL')
		await blockDomain(w.h.store, 'blocked.example')
		// The accepted residual of docs/visibility.md: a gateway inbox without provenance is judged by its own host.
		expect(await drain(w.h.store)).toEqual([['Create', 'https://gateway.example/inbox']])
	})

	it('sends to an exempt child under a suspended parent', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r', 'a.blocked.example')
		await remoteFollows(w.h.store, r, w.alice.id)
		await blockDomain(w.h.store, 'a.blocked.example', 'noop')
		await blockDomain(w.h.store, 'blocked.example')
		await post(w.h, w.alice, { status: 'to the exempt child' })
		expect(await drain(w.h.store)).toEqual([['Create', 'https://a.blocked.example/inbox']])
	})

	it('drains a lane of 500 rows to the blocked domain, each claim deleting at least one', async () => {
		const w = await world()
		const r = await remoteAccount(w.h.store, 'r', 'blocked.example')
		await remoteFollows(w.h.store, r, w.alice.id)
		const aliceUri = await uriOf(w.h.store, w.alice.id)
		await runInDurableObject(w.h.store, (_instance, state) =>
			state.storage.transactionSync(() => {
				const db = new Db(state.storage.sql)
				for (let i = 0; i < 500; i++) {
					enqueueActivity(
						db,
						w.alice.id,
						{
							activity: {
								id: `${aliceUri}#likes/${i}`,
								type: 'Like',
								actor: aliceUri,
								object: `https://blocked.example/statuses/${i}`,
							},
							audience: { followers: false, accounts: [r] },
						},
						NOW
					)
				}
			})
		)
		expect(await sql(w.h.store, 'SELECT count(*) AS n FROM deliveries')).toEqual([{ n: 500 }])
		await blockDomain(w.h.store, 'blocked.example')
		let left = 500
		for (let round = 0; left > 0; round++) {
			expect(round).toBeLessThan(500)
			const claimed = await w.h.store.claimDeliveries(BUILD, { now: NOW, leaseToken: `lane-${round}` })
			expect(claimed.deliveries).toEqual([])
			const [{ n }] = (await sql<{ n: number }>(w.h.store, 'SELECT count(*) AS n FROM deliveries')) as [{ n: number }]
			expect(n).toBeLessThan(left)
			left = n
		}
	})

	describe('the send boundary is confirmation', () => {
		const testEnv = { ...env, USER_KEK: LEGACY.kek } as unknown as Env

		async function signed() {
			const w = await world()
			await sql(
				w.h.store,
				'UPDATE local_accounts SET privkey = ?, privkey_salt = ?, pubkey = ? WHERE account_id = ?',
				LEGACY.privkey.slice().buffer,
				LEGACY.salt.slice().buffer,
				LEGACY.pubkey,
				w.alice.id
			)
			const r = await remoteAccount(w.h.store, 'r', 'blocked.example')
			await remoteFollows(w.h.store, r, w.alice.id)
			return w
		}

		it('sends nothing when the block commits between the claim and confirmation, and promotes the lane', async () => {
			const w = await signed()
			await post(w.h, w.alice, { status: 'first' })
			await post(w.h, w.alice, { status: 'second' })
			const { fetch, sent } = recordingFetch()
			// Held at its host check: after the claim and the signer load, before confirmation.
			const gate = gatedHost()
			const round = deliveryRound(testEnv, {
				...deliveryDeps(
					() => w.h.store,
					fetch,
					() => NOW
				),
				checkHost: gate.checkHost,
			})
			await gate.reached
			expect((await deliveries(w.h.store)).map((row) => row.state)).toEqual(['leased', 'queued'])
			await blockDomain(w.h.store, 'blocked.example')
			gate.release()
			expect(await round).toEqual({ claimed: 1, settled: ['dropped'], nextDueAt: NOW })
			expect(sent).toEqual([])
			expect((await deliveries(w.h.store)).map((row) => row.state)).toEqual(['pending'])
		})

		it('sends a row confirmed before the block commits', async () => {
			const w = await signed()
			await post(w.h, w.alice, { status: 'confirmed' })
			const { fetch, sent } = recordingFetch()
			const reached = deferred()
			const release = deferred()
			const store = new Proxy(w.h.store, {
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
			await blockDomain(w.h.store, 'blocked.example')
			release.resolve()
			expect(await round).toMatchObject({ claimed: 1, settled: ['delivered'] })
			expect(sent).toEqual(['https://blocked.example/inbox'])
		})
	})
})
