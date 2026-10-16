import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

import { type DocumentLoader, verifyRequestDetailed } from '@fedify/fedify'
import { describe, expect, it, vi } from 'vitest'

import { bearer, json, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { fixtureKeyGen, LEGACY } from './federation-helpers'
import { scopedToken } from './read-helpers'
import { block, community, outbound, remoteAccount, seedStatus, type User } from './status-helpers'
import { Db } from '../src/db/sql'
import { PURGE_BATCH, purgeBatch } from '../src/domain/inbox'
import { MAX_FORWARD_DOMAINS, MAX_REPORT_STATUSES } from '../src/domain/reports'
import { deliveryRound } from '../src/jobs/deliver'
import type { StoreStub } from '../src/platform/store-client'
import { bytesToBase64 } from '../src/security/key-wrap'

// POST /api/v1/reports (Mastodon 4.5's ReportService; R34, R11, R23, DATA-7): the answer, Report's validations, the
// statuses a reporter may name, and the Flag a forwarded report sends, signed by the instance actor.

type ReportBody = Record<string, unknown> & {
	id: string
	category: string
	forwarded: boolean
	status_ids: string[]
	rule_ids: string[] | null
	target_account: { id: string; acct: string }
}

const INSTANCE_ACTOR = 'https://kopje.test/actor'

async function report(
	h: { request: (path: string, init?: RequestInit) => Promise<Response> },
	user: User,
	body: Record<string, unknown>
) {
	const response = await h.request('/api/v1/reports', bearer(user.token, json(body)))
	return { status: response.status, body: (await response.json()) as ReportBody & { error?: string } }
}

// The instance actor's document as a receiver fetches it, with the given public key.
function instanceActorLoader(publicKeyPem: string): DocumentLoader {
	return (url) =>
		Promise.resolve({
			contextUrl: null,
			documentUrl: url,
			document: {
				'@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
				id: INSTANCE_ACTOR,
				type: 'Application',
				inbox: `${INSTANCE_ACTOR}/inbox`,
				publicKey: { id: `${INSTANCE_ACTOR}#main-key`, owner: INSTANCE_ACTOR, publicKeyPem },
			},
		})
}

async function count(store: StoreStub, query: string, ...params: SqlStorageValue[]): Promise<number> {
	return (await sql(store, query, ...params)).length
}

// A local reporter, alice, and carol on remote.example with a public status.
async function reporting() {
	const h = await community(['alice', 'bob'])
	const carol = await remoteAccount(h.store, 'carol')
	const status = await seedStatus(h.store, { accountId: carol, visibility: 'public' })
	return { h, alice: h.users.alice, bob: h.users.bob, carol, status }
}

describe('POST /api/v1/reports', () => {
	it('stores the report and answers it as REST::ReportSerializer does', async () => {
		const { h, alice, carol, status } = await reporting()
		const { status: code, body } = await report(h, alice, {
			account_id: carol,
			status_ids: [status],
			comment: 'reasons',
			category: 'spam',
		})
		expect(code).toBe(200)
		expect(Object.keys(body)).toEqual([
			'id',
			'action_taken',
			'action_taken_at',
			'category',
			'comment',
			'forwarded',
			'created_at',
			'status_ids',
			'rule_ids',
			'target_account',
		])
		expect(body).toMatchObject({
			id: expect.stringMatching(/^\d+$/),
			action_taken: false,
			action_taken_at: null,
			category: 'spam',
			comment: 'reasons',
			forwarded: false,
			created_at: new Date(NOW).toISOString(),
			status_ids: [status],
			rule_ids: null,
			target_account: { id: carol, acct: 'carol@remote.example' },
		})
		expect(
			await sql(
				h.store,
				'SELECT CAST(id AS TEXT) AS id, account_id, target_account_id, status_ids, comment, category, rule_ids, forwarded FROM reports'
			)
		).toEqual([
			{
				id: body.id,
				account_id: alice.id,
				target_account_id: carol,
				status_ids: JSON.stringify([status]),
				comment: 'reasons',
				category: 'spam',
				rule_ids: null,
				forwarded: 0,
			},
		])
		// Without forward nothing federates.
		expect(await outbound(h.store)).toEqual([])
	})

	it('takes a blank comment and category as empty and other, and repeated status ids once', async () => {
		const { h, alice, carol, status } = await reporting()
		const { status: code, body } = await report(h, alice, {
			account_id: carol,
			status_ids: [status, status],
			comment: '  ',
			category: '',
		})
		expect(code).toBe(200)
		expect(body).toMatchObject({ comment: '', category: 'other', status_ids: [status] })
	})

	it('needs a token with write:reports bound to a user', async () => {
		const { h, carol } = await reporting()
		const read = await scopedToken(h, 'read')
		const refused = await h.request('/api/v1/reports', bearer(read, json({ account_id: carol })))
		expect(refused.status).toBe(403)
		const scoped = await scopedToken(h, 'write:reports')
		expect((await h.request('/api/v1/reports', bearer(scoped, json({ account_id: carol })))).status).toBe(200)
		expect(await count(h.store, 'SELECT 1 FROM reports')).toBe(1)
	})

	it('answers validation errors as Mastodon does, and stores nothing', async () => {
		const { h, alice, carol } = await reporting()
		const cases: [Record<string, unknown>, string][] = [
			[{ comment: 'x'.repeat(1001) }, 'Validation failed: Comment is too long (maximum is 1000 characters)'],
			[{ category: 'violation' }, 'Validation failed: Rule ids does not reference valid rules'],
			// Kopje has no rules unless the instance sets them: any rule id names none.
			[{ rule_ids: ['1'] }, 'Validation failed: Rule ids does not reference valid rules'],
			[
				{ comment: 'x'.repeat(1001), category: 'violation' },
				'Validation failed: Comment is too long (maximum is 1000 characters), Rule ids does not reference valid rules',
			],
			// Mastodon raises on an unknown category (500); Kopje refuses it.
			[{ category: 'rude' }, 'Validation failed: Category is not included in the list'],
			[
				{ status_ids: Array.from({ length: MAX_REPORT_STATUSES + 1 }, (_, i) => String(i)) },
				`Validation failed: Status ids is too long (maximum is ${MAX_REPORT_STATUSES} statuses)`,
			],
			[
				{ forward_to_domains: Array.from({ length: MAX_FORWARD_DOMAINS + 1 }, (_, i) => `d${i}.example`) },
				`Validation failed: Forward to domains is too long (maximum is ${MAX_FORWARD_DOMAINS} domains)`,
			],
		]
		for (const [extra, error] of cases) {
			const { status, body } = await report(h, alice, { account_id: carol, ...extra })
			expect([extra, status, body]).toEqual([extra, 422, { error }])
		}
		expect(await count(h.store, 'SELECT 1 FROM reports')).toBe(0)
		// A comment of 1,000 characters is kept, counted as characters (an emoji is one).
		const long = await report(h, alice, { account_id: carol, comment: `${'x'.repeat(999)}🙂` })
		expect([long.status, [...(long.body.comment as string)].length]).toEqual([200, 1000])
	})

	it('answers 404 for an unknown or unavailable account', async () => {
		const { h, alice, bob, carol } = await reporting()
		const dave = await remoteAccount(h.store, 'dave')
		await sql(h.store, 'UPDATE accounts SET deleted_at = ? WHERE id = ?', new Date(NOW).toISOString(), dave)
		await sql(
			h.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			new Date(NOW).toISOString(),
			bob.id
		)
		for (const account of [undefined, '', '999999999999999999', dave, bob.id]) {
			const { status, body } = await report(h, alice, account === undefined ? {} : { account_id: account })
			expect([account, status, body]).toEqual([account, 404, { error: 'Record not found' }])
		}
		expect(await count(h.store, 'SELECT 1 FROM reports')).toBe(0)
		// An available remote account is.
		expect((await report(h, alice, { account_id: carol })).status).toBe(200)
	})

	it('refuses the whole report when a status is not one of the account’s the reporter may see (R11)', async () => {
		const { h, alice, bob, carol, status } = await reporting()
		const followersOnly = await seedStatus(h.store, { accountId: carol, visibility: 'private' })
		const mentioning = await seedStatus(h.store, {
			accountId: carol,
			visibility: 'direct',
			mentions: [{ accountId: alice.id }],
		})
		const toBob = await seedStatus(h.store, {
			accountId: carol,
			visibility: 'direct',
			mentions: [{ accountId: bob.id }],
		})
		const dave = await remoteAccount(h.store, 'dave', 'far.example')
		const daves = await seedStatus(h.store, { accountId: dave, visibility: 'public' })
		const refused = async (ids: string[]) => {
			const { status: code } = await report(h, alice, { account_id: carol, status_ids: ids })
			return code
		}
		// A private status of an account alice does not follow, a direct one to someone else, another account's status
		// and an unknown id are not found, even beside a status she may see.
		for (const ids of [[followersOnly], [status, toBob], [daves], [status, '999999999999999999']]) {
			expect([ids, await refused(ids)]).toEqual([ids, 404])
		}
		expect(await count(h.store, 'SELECT 1 FROM reports')).toBe(0)
		// A direct status that mentions her is hers to see.
		expect(await refused([status, mentioning])).toBe(200)
		// Once she follows carol, the private status too.
		await sql(
			h.store,
			"INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?, ?, 'accepted', ?)",
			alice.id,
			carol,
			new Date(NOW).toISOString()
		)
		expect(await refused([followersOnly])).toBe(200)
	})

	it('lets a reporter who blocks the account name its statuses, but not one whom the account blocks', async () => {
		const { h, alice, carol, status } = await reporting()
		await block(h.store, alice.id, carol)
		expect((await report(h, alice, { account_id: carol, status_ids: [status] })).status).toBe(200)
		await sql(h.store, 'DELETE FROM blocks')
		await block(h.store, carol, alice.id)
		expect((await report(h, alice, { account_id: carol, status_ids: [status] })).status).toBe(404)
		// The account itself may still be reported.
		expect((await report(h, alice, { account_id: carol })).status).toBe(200)
	})

	it('leaves out a boost of an original the reporter may not see or filters', async () => {
		const { h, alice, carol } = await reporting()
		const dave = await remoteAccount(h.store, 'dave', 'far.example')
		const original = await seedStatus(h.store, { accountId: dave, visibility: 'public' })
		const boost = await seedStatus(h.store, { accountId: carol, visibility: 'public', reblogOfId: original })
		expect((await report(h, alice, { account_id: carol, status_ids: [boost] })).status).toBe(200)
		await block(h.store, alice.id, dave)
		expect((await report(h, alice, { account_id: carol, status_ids: [boost] })).status).toBe(404)
	})

	it('makes rule_ids a violation, checked against the instance rules', async () => {
		const { h, alice, carol } = await reporting()
		await setSetting(h.store, 'rules', JSON.stringify([{ id: '7', text: 'Be kind' }, 'No spam']))
		expect(await (await h.request('/api/v1/instance/rules')).json()).toEqual([
			{ id: '7', text: 'Be kind' },
			{ id: '2', text: 'No spam' },
		])
		const forced = await report(h, alice, { account_id: carol, category: 'spam', rule_ids: ['7', '2'] })
		expect([forced.status, forced.body.category, forced.body.rule_ids]).toEqual([200, 'violation', ['7', '2']])
		expect(await sql(h.store, 'SELECT category, rule_ids FROM reports')).toEqual([
			{ category: 'violation', rule_ids: '["7","2"]' },
		])
		// A rule named twice, or one that does not exist, is not valid (rules.size == rule_ids.size).
		for (const ruleIds of [
			['7', '7'],
			['7', '3'],
		]) {
			const { status, body } = await report(h, alice, { account_id: carol, rule_ids: ruleIds })
			expect([ruleIds, status, body]).toEqual([
				ruleIds,
				422,
				{ error: 'Validation failed: Rule ids does not reference valid rules' },
			])
		}
		// An empty list names no rule: the category stands.
		const none = await report(h, alice, { account_id: carol, category: 'legal', rule_ids: [] })
		expect([none.status, none.body.category, none.body.rule_ids]).toEqual([200, 'legal', null])
	})

	it('keeps a report whose status is deleted later, naming the status', async () => {
		const { h, alice, carol, status } = await reporting()
		expect((await report(h, alice, { account_id: carol, status_ids: [status] })).status).toBe(200)
		await sql(h.store, 'DELETE FROM statuses WHERE id = ?', status)
		expect(await sql(h.store, 'SELECT status_ids FROM reports')).toEqual([{ status_ids: JSON.stringify([status]) }])
	})
})

describe('forwarding a report (R23, DATA-7)', () => {
	it('sends no Flag without forward, or for a local account', async () => {
		const { h, alice, bob, carol, status } = await reporting()
		for (const forward of [undefined, false, '0']) {
			const { body } = await report(h, alice, { account_id: carol, status_ids: [status], forward })
			expect([forward, body.forwarded]).toEqual([forward, false])
		}
		const local = await report(h, alice, { account_id: bob.id, forward: true })
		expect([local.status, local.body.forwarded]).toEqual([200, false])
		expect(await outbound(h.store)).toEqual([])
		expect(await count(h.store, 'SELECT 1 FROM deliveries')).toBe(0)
	})

	it('sends a Flag from the instance actor to the account’s server', async () => {
		const { h, alice, carol, status } = await reporting()
		const { body } = await report(h, alice, {
			account_id: carol,
			status_ids: [status],
			comment: 'spam again',
			forward: true,
		})
		expect(body.forwarded).toBe(true)
		const [uri] = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM reports')).map((r) => r.uri)
		expect(uri).toMatch(/^https:\/\/kopje\.test\/actor#reports\/[0-9a-f-]{36}$/)
		const [statusUri] = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM statuses WHERE id = ?', status)).map(
			(r) => r.uri
		)
		const [carolUri] = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM accounts WHERE id = ?', carol)).map(
			(r) => r.uri
		)
		// ActivityPub::FlagSerializer: id, type, actor, content and the account with its statuses as the object. The
		// intent is in alice's lane, signed by the instance actor.
		expect(await outbound(h.store)).toEqual([
			{
				signer: alice.id,
				signedBy: 'instance',
				activity: {
					'@context': 'https://www.w3.org/ns/activitystreams',
					id: uri,
					type: 'Flag',
					actor: INSTANCE_ACTOR,
					content: 'spam again',
					object: [carolUri, statusUri],
				},
				audience: { followers: false, accounts: [carol] },
			},
		])
		// The Flag has no to, so it goes to the server's shared inbox, as a Follow does.
		expect(await sql(h.store, 'SELECT inbox_url FROM deliveries')).toEqual([
			{ inbox_url: 'https://remote.example/inbox' },
		])
		// Nothing of alice is in what is sent.
		expect(JSON.stringify((await outbound(h.store))[0]?.activity)).not.toContain('alice')
	})

	it('also sends it to the servers the statuses reply to on the listed domains, not repeating the account’s', async () => {
		const { h, alice, carol } = await reporting()
		const dave = await remoteAccount(h.store, 'dave', 'far.example')
		const erin = await remoteAccount(h.store, 'erin', 'other.example')
		const frank = await remoteAccount(h.store, 'frank')
		const replies: string[] = []
		for (const partner of [dave, erin, frank, alice.id]) {
			const reply = await seedStatus(h.store, { accountId: carol, visibility: 'public' })
			await sql(h.store, 'UPDATE statuses SET in_reply_to_account_id = ? WHERE id = ?', partner, reply)
			replies.push(reply)
		}
		// A status that replies to no one listed adds no one.
		const { body } = await report(h, alice, {
			account_id: carol,
			status_ids: replies,
			forward: true,
			forward_to_domains: ['remote.example', ' FAR.example/ ', 'not a domain'],
		})
		expect(body.forwarded).toBe(true)
		// carol and dave: erin's domain is not listed, frank's inbox is carol's server's, and alice is local.
		const [flag] = await outbound(h.store)
		expect(flag?.audience).toEqual({ followers: false, accounts: [carol, dave].sort() })
		expect((flag?.activity.object as string[]).length).toBe(1 + replies.length)
		expect(
			(await sql<{ inbox_url: string }>(h.store, 'SELECT inbox_url FROM deliveries ORDER BY inbox_url')).map(
				(r) => r.inbox_url
			)
		).toEqual(['https://far.example/inbox', 'https://remote.example/inbox'])
	})

	it('sends it to the replied-to servers alone when the account’s domain is not listed', async () => {
		const { h, alice, carol } = await reporting()
		const dave = await remoteAccount(h.store, 'dave', 'far.example')
		const reply = await seedStatus(h.store, { accountId: carol, visibility: 'public' })
		await sql(h.store, 'UPDATE statuses SET in_reply_to_account_id = ? WHERE id = ?', dave, reply)
		const { body } = await report(h, alice, {
			account_id: carol,
			status_ids: [reply],
			forward: true,
			forward_to_domains: ['far.example'],
		})
		expect(body.forwarded).toBe(false)
		expect((await outbound(h.store)).map((o) => o.audience.accounts)).toEqual([[dave]])
		expect(await sql(h.store, 'SELECT inbox_url FROM deliveries')).toEqual([{ inbox_url: 'https://far.example/inbox' }])
		// An empty list forwards to no one.
		await sql(h.store, 'DELETE FROM outbound_activities')
		const none = await report(h, alice, {
			account_id: carol,
			status_ids: [reply],
			forward: true,
			forward_to_domains: [],
		})
		expect([none.status, none.body.forwarded]).toEqual([200, false])
		expect(await outbound(h.store)).toEqual([])
	})

	it('posts the Flag signed with the instance actor’s key', async () => {
		const { h, alice, carol, status } = await reporting()
		await setSetting(
			h.store,
			'instance_actor_key',
			JSON.stringify({
				privkey: bytesToBase64(LEGACY.privkey),
				salt: bytesToBase64(LEGACY.salt),
				pubkey: LEGACY.pubkey,
			})
		)
		await report(h, alice, { account_id: carol, status_ids: [status], forward: true })
		const sent: Request[] = []
		const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(new Request(input, init))
			return new Response(null, { status: 202 })
		}) as unknown as typeof globalThis.fetch
		const result = await deliveryRound({ ...env, USER_KEK: LEGACY.kek } as unknown as Env, {
			build: () => env.CF_VERSION_METADATA.id,
			store: () => h.store,
			now: () => NOW,
			fetch,
			checkHost: () => Promise.resolve(),
		})
		expect(result).toMatchObject({ claimed: 1, settled: ['delivered'] })
		const [request] = sent
		expect(request?.url).toBe('https://remote.example/inbox')
		expect(request?.headers.get('signature')).toContain(`keyId="${INSTANCE_ACTOR}#main-key"`)
		expect(
			await verifyRequestDetailed(request!.clone(), { documentLoader: instanceActorLoader(LEGACY.pubkey) })
		).toMatchObject({ verified: true })
		expect(JSON.parse(await request!.text())).toMatchObject({ type: 'Flag', actor: INSTANCE_ACTOR })
	})

	it('creates the instance actor’s key when no fetch has yet, and posts the Flag signed with it', async () => {
		const { h, alice, carol, status } = await reporting()
		// A fresh instance that knows carol through a personal inbox alone has never signed as the instance actor.
		expect(await sql(h.store, "SELECT 1 FROM instance_settings WHERE name = 'instance_actor_key'")).toEqual([])
		await report(h, alice, { account_id: carol, status_ids: [status], forward: true })
		const sent: Request[] = []
		const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(new Request(input, init))
			return new Response(null, { status: 202 })
		}) as unknown as typeof globalThis.fetch
		const result = await deliveryRound({ ...env, USER_KEK: LEGACY.kek } as unknown as Env, {
			build: () => env.CF_VERSION_METADATA.id,
			store: () => h.store,
			now: () => NOW,
			fetch,
			checkHost: () => Promise.resolve(),
			keygen: fixtureKeyGen,
		})
		expect(result).toMatchObject({ claimed: 1, settled: ['delivered'] })
		const [stored] = await sql<{ value: string }>(
			h.store,
			"SELECT value FROM instance_settings WHERE name = 'instance_actor_key'"
		)
		const { pubkey } = JSON.parse(stored!.value) as { pubkey: string }
		const [request] = sent
		expect(request?.url).toBe('https://remote.example/inbox')
		expect(request?.headers.get('signature')).toContain(`keyId="${INSTANCE_ACTOR}#main-key"`)
		expect(
			await verifyRequestDetailed(request!.clone(), { documentLoader: instanceActorLoader(pubkey) })
		).toMatchObject({ verified: true })
		expect(JSON.parse(await request!.text())).toMatchObject({ type: 'Flag', actor: INSTANCE_ACTOR })
		expect(await count(h.store, 'SELECT 1 FROM deliveries')).toBe(0)
	})
})

describe('a reported remote account’s purge (RES-6)', () => {
	it('deletes the reports of it in batches of at most PURGE_BATCH rows, then the account', async () => {
		const { h, alice, carol, status } = await reporting()
		expect((await report(h, alice, { account_id: carol, status_ids: [status] })).status).toBe(200)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO reports (account_id, target_account_id, uri, created_at)
			SELECT ?, ?, 'https://kopje.test/actor#reports/' || i, '2026-10-12T00:00:00.000Z' FROM n`,
			PURGE_BATCH + 100,
			alice.id,
			carol
		)
		const [uri] = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM accounts WHERE id = ?', carol)).map(
			(r) => r.uri
		)
		const batches: number[] = []
		for (let i = 0; i < 10; i++) {
			const { wrote, remaining } = await runInDurableObject(h.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				const more = state.storage.transactionSync(() => purgeBatch(db, uri!, NOW))
				return { wrote: changes() - before, remaining: more }
			})
			batches.push(wrote)
			if (!remaining) {
				break
			}
		}
		expect(batches.length).toBeGreaterThan(1)
		expect(batches.every((wrote) => wrote <= PURGE_BATCH)).toBe(true)
		expect(await count(h.store, 'SELECT 1 FROM reports')).toBe(0)
		expect(await count(h.store, 'SELECT 1 FROM accounts WHERE id = ?', carol)).toBe(0)
	})
})
