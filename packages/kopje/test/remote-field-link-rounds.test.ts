import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { apiHarness, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { actorDefaults } from './inbox-helpers'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { Db } from '../src/db/sql'
import type { Account } from '../src/domain/accounts'
import {
	claimFieldLinks,
	FIELD_LINK_CLAIM_WALK,
	FIELD_LINK_HOLD_MS,
	type FieldLinksClaim,
	finishFieldLinks,
	recordFieldLink,
} from '../src/domain/field-links'
import { type RemoteActorInput, upsertRemoteActor } from '../src/domain/inbox'
import {
	REMOTE_LINK_CLAIM_WALK,
	REMOTE_LINK_EXPIRE_BATCH,
	REMOTE_LINK_EXPIRE_MS,
	REMOTE_LINK_RECHECK_MS,
} from '../src/domain/remote-field-links'
import { suspendRemote } from '../src/domain/remote-suspension'
import { type FieldLinksDeps, fieldLinksRound } from '../src/federation/field-links'
import type { StoreStub } from '../src/platform/store-client'

// The verification half of remote field links (domain/remote-field-links.ts) in the shared field-links round
// (domain/field-links.ts, federation/field-links.ts): claimed after local accounts, fenced by the row's generation and
// availability, expired after a day.

const ORIGIN = 'https://kopje.test'
const URI = 'https://remote.example/users/a'
const PROFILE = 'https://remote.example/@a'
const A = 'https://a.example/'
const B = 'https://b.example/'
const HTML = { 'content-type': 'text/html; charset=utf-8' }
const link = (href: string) => `<a href="${href}">${href}</a>`

type Route = (request: Request) => Response | Promise<Response>
type Remote = Extract<FieldLinksClaim, { target: 'remote' }>

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

const page = (body: string) => () => new Response(body, { headers: HTML })
const relMe = (href: string) => page(`<a rel="me" href="${href}">me</a>`)

function actor(hrefs: string[], uri = URI): RemoteActorInput {
	return {
		...actorDefaults(),
		uri,
		username: 'a',
		domain: 'remote.example',
		displayName: 'a',
		inboxUrl: `${uri}/inbox`,
		url: uri === URI ? PROFILE : null,
		movedTo: null,
		raw: JSON.stringify({
			id: uri,
			attachment: hrefs.map((href, i) => ({ type: 'PropertyValue', name: `f${i}`, value: link(href) })),
		}),
	}
}

async function world() {
	const h = await apiHarness()
	const clock = { t: NOW }
	h.now.mockImplementation(() => clock.t)
	const requests: { line: string; agent: string | null }[] = []
	let routes: Record<string, Route> = {}
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		requests.push({ line: `${request.method} ${request.url}`, agent: request.headers.get('user-agent') })
		const route = routes[request.url]
		return Promise.resolve(route === undefined ? new Response('missing', { status: 404 }) : route(request))
	}
	const deps = (store: () => StoreStub = () => h.store): FieldLinksDeps => ({
		build: () => BUILD,
		store,
		now: () => clock.t,
		keygen: () => Promise.reject(new Error('no keys')),
		loader: { fetch, checkHost: () => Promise.resolve() },
	})
	const put = (input: RemoteActorInput) =>
		runInDurableObject(h.store, (_instance, state) =>
			state.storage.transactionSync(() => upsertRemoteActor(new Db(state.storage.sql), input, ORIGIN, clock.t))
		)
	const op = <I, O>(operation: { run: (sql: SqlStorage, input: I) => O }, input: I) =>
		runInDurableObject(h.store, (_instance, s) => operation.run(s.storage.sql, input))
	const row = async (uri = URI) =>
		(
			await sql<{
				links: string
				generation: number
				claim: number
				attempts: number
				due_at: number | null
				armed_at: number | null
				hold_until: number | null
				checked_at: number | null
			}>(
				h.store,
				`SELECT r.links, r.generation, r.claim, r.attempts, r.due_at, r.armed_at, r.hold_until, r.checked_at
				FROM remote_field_links r JOIN accounts a ON a.id = r.account_id WHERE a.uri = ?`,
				uri
			)
		)[0]
	const links = async (uri = URI) => {
		const found = await row(uri)
		return found === undefined ? undefined : (JSON.parse(found.links) as unknown[])
	}
	return {
		h,
		clock,
		requests,
		setRoutes: (next: Record<string, Route>) => {
			routes = next
		},
		deps,
		round: (store?: () => StoreStub) => fieldLinksRound(h.env, deps(store)),
		put,
		op,
		row,
		links,
	}
}

type World = Awaited<ReturnType<typeof world>>

// `n` remote accounts with one row each, armed at `armedAt` and due at `due`, with `extra` columns set by SQL (a
// fixture: imported or long-lived rows).
async function seedRows(w: World, n: number, armedAt: number, due: number, extra = '') {
	await sql(
		w.h.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain) SELECT printf('3%017d', i), 'https://seed.example/u/' || i, 'u' || i,
			'seed.example' FROM n`,
		n
	)
	await sql(
		w.h.store,
		`INSERT INTO remote_field_links (account_id, link_back, links, generation, due_at, armed_at)
		SELECT id, uri, '[[0,"https://a.example/",null,0]]', 1, ?1, ?2 FROM accounts WHERE domain = 'seed.example'`,
		due,
		armedAt
	)
	if (extra !== '') {
		await sql(w.h.store, `UPDATE remote_field_links SET ${extra} WHERE account_id GLOB '3*'`)
	}
}

const armed = async (w: World) =>
	(await sql<{ n: number }>(w.h.store, 'SELECT count(*) AS n FROM remote_field_links WHERE due_at IS NOT NULL'))[0]!.n

describe('remote field verification witnesses', () => {
	it('verifies a remote field whose page links back to the profile, with the instance’s User-Agent', async () => {
		const w = await world()
		w.setRoutes({ [A]: relMe(PROFILE), [B]: page('<p>no</p>') })
		await w.put(actor([A, B]))
		const result = await w.round()
		expect(result).toMatchObject({ claimed: true, target: 'remote', verified: 1, unchecked: 0, finished: true })
		expect(await w.links()).toEqual([
			[0, A, '2026-10-12T00:00:00.000Z', 1],
			[1, B, null, 1],
		])
		expect(await w.row()).toMatchObject({ due_at: null, armed_at: null, attempts: 0, checked_at: NOW })
		expect(w.requests.map((r) => r.line)).toEqual([`GET ${A}`, `GET ${B}`])
		expect(w.requests.every((r) => r.agent?.includes(`(+${ORIGIN}/)`) === true)).toBe(true)
		// Presented: the verified field's time, and its value as Mastodon's shortened link; the other field as it was.
		const id = (await sql<{ id: string }>(w.h.store, 'SELECT id FROM accounts WHERE uri = ?', URI))[0]!.id
		const shown = await (await w.h.request(`/api/v1/accounts/${id}`)).json<Account>()
		expect(shown.fields).toEqual([
			{
				name: 'f0',
				value:
					'<a href="https://a.example/" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible">https://</span><span class="">a.example/</span><span class="invisible"></span></a>',
				verified_at: '2026-10-12T00:00:00.000+00:00',
			},
			{ name: 'f1', value: expect.not.stringContaining('ellipsis') as unknown as string, verified_at: null },
		])
	})

	it('serves local accounts first: a remote row waits while a local account is due', async () => {
		const w = await world()
		const local = await seedAccount(w.h.store, { username: 'alice' })
		await sql(
			w.h.store,
			`UPDATE local_accounts SET fields = '[{"name":"s","value":"https://site.example/"}]', links_due_at = ?
			WHERE account_id = ?`,
			NOW,
			local
		)
		await w.put(actor([A]))
		expect(await w.round()).toMatchObject({ claimed: true, target: 'local' })
		expect(await w.round()).toMatchObject({ claimed: true, target: 'remote' })
	})
})

describe('remote field verification fences', () => {
	it('refuses an old claim’s record and finish once the candidates were removed and the row recreated', async () => {
		const w = await world()
		await w.put(actor([A]))
		const old = (await w.op(claimFieldLinks, { now: w.clock.t })) as Remote
		expect(old).toMatchObject({ target: 'remote', values: [A], linkBack: PROFILE, origin: ORIGIN })
		await w.put(actor([]))
		expect(await w.row()).toBeUndefined()
		await w.put(actor([A]))
		const current = (await w.op(claimFieldLinks, { now: w.clock.t })) as Remote
		expect(current.target).toBe('remote')
		expect(current.generation).not.toBe(old.generation)
		const fence = { target: 'remote' as const, accountId: old.accountId, token: old.token, generation: old.generation }
		expect(await w.op(recordFieldLink, { ...fence, value: A, verified: true, now: w.clock.t })).toEqual({
			held: false,
			recorded: false,
		})
		expect(await w.op(finishFieldLinks, { ...fence, claimed: [A], unchecked: [], now: w.clock.t })).toEqual({
			held: false,
			pending: false,
		})
		expect(await w.links()).toEqual([[0, A, null, 0]])
		expect(await w.row()).toMatchObject({ attempts: 1 })
	})

	it.each(['an actor update', 'a suspension'] as const)(
		'records nothing after %s during a GET, and stops the round',
		async (change) => {
			const w = await world()
			const gate = deferred()
			const reached = deferred()
			w.setRoutes({
				[A]: async () => {
					reached.resolve()
					await gate.promise
					return relMe(PROFILE)()
				},
				[B]: relMe(PROFILE),
			})
			const { id } = (await w.put(actor([A, B])))!
			const running = w.round()
			await reached.promise
			if (change === 'an actor update') {
				await w.put(actor([B, A]))
			} else {
				await runInDurableObject(w.h.store, (_instance, state) => {
					state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), id, null, w.clock.t))
				})
			}
			gate.resolve()
			expect(await running).toMatchObject({ claimed: true, target: 'remote', verified: 0, finished: false })
			expect(w.requests.map((r) => r.line)).toEqual([`GET ${A}`])
			const left = (await w.links())!
			expect(left.every((entry) => (entry as unknown[])[2] === null)).toBe(true)
		}
	)

	it('keeps a negative check across a store with the same candidates during the claim (AM13)', async () => {
		const w = await world()
		const gate = deferred()
		const reached = deferred()
		w.setRoutes({
			[A]: page('<p>no</p>'),
			[B]: async () => {
				reached.resolve()
				await gate.promise
				return page('<p>no</p>')()
			},
		})
		await w.put(actor([A, B]))
		const running = w.round()
		// A's negative record has committed once B's GET is reached.
		await reached.promise
		w.clock.t += 1000
		await w.put(actor([A, B]))
		gate.resolve()
		expect(await running).toMatchObject({ claimed: true, verified: 0, unchecked: 0, finished: true })
		expect(await w.row()).toMatchObject({ due_at: null, checked_at: NOW + 1000 })
		// Not retried before a day has passed since the last negative check, at a store or a round.
		w.clock.t = NOW + REMOTE_LINK_RECHECK_MS - 1
		await w.put(actor([A, B]))
		expect(await w.row()).toMatchObject({ due_at: null })
		expect(await w.round()).toMatchObject({ claimed: false })
		w.clock.t = NOW + 1000 + REMOTE_LINK_RECHECK_MS
		await w.put(actor([A, B]))
		expect(await w.row()).toMatchObject({ due_at: w.clock.t })
	})

	it('leaves a value whose policy read failed unchecked, and checks it after the hold', async () => {
		const w = await world()
		w.setRoutes({ [A]: relMe(PROFILE) })
		await w.put(actor([A]))
		const failing = new Proxy(w.h.store, {
			get: (target, key) =>
				key === 'webHopRefused'
					? () => Promise.reject(new Error('policy unreadable'))
					: (Reflect.get(target, key) as unknown),
		})
		expect(await w.round(() => failing)).toMatchObject({ claimed: true, target: 'remote', unchecked: 1 })
		expect(await w.row()).toMatchObject({ due_at: NOW + FIELD_LINK_HOLD_MS, attempts: 0 })
		w.clock.t += FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: true, target: 'remote', verified: 1 })
	})

	it('gives up after two claims that never finished, at most one claim per hold', async () => {
		const w = await world()
		await w.put(actor([A]))
		const claim = () => w.op(claimFieldLinks, { now: w.clock.t })
		expect(await claim()).toMatchObject({ kind: 'claimed', target: 'remote' })
		expect(await claim()).toEqual({ kind: 'none', givenUp: 0, expired: 0 })
		w.clock.t += FIELD_LINK_HOLD_MS
		expect(await claim()).toMatchObject({ kind: 'claimed', target: 'remote' })
		w.clock.t += FIELD_LINK_HOLD_MS
		expect(await claim()).toEqual({ kind: 'none', givenUp: 1, expired: 0 })
		expect(await w.row()).toMatchObject({ due_at: null, attempts: 0, claim: 2 })
	})
})

describe('remote field verification bounds', () => {
	it(
		'expires the oldest REMOTE_LINK_EXPIRE_BATCH rows a call, and the walk the 501st',
		{ timeout: 60_000 },
		async () => {
			const w = await world()
			await seedRows(w, REMOTE_LINK_EXPIRE_BATCH + 1, NOW - REMOTE_LINK_EXPIRE_MS - 1, NOW)
			const result = await w.op(claimFieldLinks, { now: w.clock.t })
			// The batch disarms 500; the walk meets the 501st past the cutoff and disarms it, never claims it.
			expect(result).toEqual({ kind: 'none', givenUp: 0, expired: REMOTE_LINK_EXPIRE_BATCH })
			expect(await armed(w)).toBe(0)
		}
	)

	it('expires rows whose hold is NULL, and keeps an expired due row with an open hold and its claim (AM14)', async () => {
		const w = await world()
		// 500 oldest rows with an attempt and no hold (trigger-valid), then one more expired row.
		await seedRows(
			w,
			REMOTE_LINK_EXPIRE_BATCH + 1,
			NOW - REMOTE_LINK_EXPIRE_MS - 2,
			NOW + FIELD_LINK_HOLD_MS,
			'attempts = 1'
		)
		await sql(
			w.h.store,
			"UPDATE remote_field_links SET armed_at = armed_at + 1 WHERE account_id = printf('3%017d', 501)"
		)
		expect(await w.op(claimFieldLinks, { now: w.clock.t })).toMatchObject({ expired: REMOTE_LINK_EXPIRE_BATCH })
		expect(await w.op(claimFieldLinks, { now: w.clock.t })).toMatchObject({ expired: 1 })
		expect(await armed(w)).toBe(0)
		// An expired, due row whose claim is open: kept by the batch, rescheduled to its hold's end by the walk.
		await w.put(actor([A]))
		await sql(
			w.h.store,
			"UPDATE remote_field_links SET armed_at = ?1, due_at = ?2, attempts = 1, claim = 7, hold_until = ?3 WHERE account_id NOT GLOB '3*'",
			NOW - REMOTE_LINK_EXPIRE_MS - 1,
			NOW,
			NOW + 1000
		)
		expect(await w.op(claimFieldLinks, { now: w.clock.t })).toEqual({ kind: 'none', givenUp: 0, expired: 0 })
		expect(await w.row()).toMatchObject({ due_at: NOW + 1000, attempts: 1, claim: 7, hold_until: NOW + 1000 })
	})

	it('expires remote rows while the local walk uses its whole allowance, and claims no remote row then', async () => {
		const w = await world()
		for (let i = 0; i < FIELD_LINK_CLAIM_WALK + 1; i++) {
			await seedAccount(w.h.store, { username: `l${i}` })
		}
		// 64 local rows due with nothing to verify, then a 65th claimable one; a remote row due, and an expired one.
		await sql(w.h.store, 'UPDATE local_accounts SET links_due_at = ?', NOW)
		const last = (
			await sql<{ id: string }>(
				w.h.store,
				'SELECT id FROM accounts WHERE username = ? AND domain IS NULL',
				`l${FIELD_LINK_CLAIM_WALK}`
			)
		)[0]!.id
		await sql(
			w.h.store,
			`UPDATE local_accounts SET fields = '[{"name":"s","value":"https://site.example/"}]', links_due_at = ?
			WHERE account_id = ?`,
			NOW + 1,
			last
		)
		await w.put(actor([A]))
		await seedRows(w, 1, NOW - REMOTE_LINK_EXPIRE_MS - 1, NOW + FIELD_LINK_HOLD_MS)
		w.clock.t = NOW + 1
		expect(await w.op(claimFieldLinks, { now: w.clock.t })).toEqual({ kind: 'none', givenUp: 0, expired: 1 })
		expect(await w.row()).toMatchObject({ due_at: NOW, attempts: 0 })
		expect(await w.op(claimFieldLinks, { now: w.clock.t })).toMatchObject({ kind: 'claimed', target: 'local' })
		expect(await w.op(claimFieldLinks, { now: w.clock.t })).toMatchObject({ kind: 'claimed', target: 'remote' })
	})

	it('reads at most REMOTE_LINK_CLAIM_WALK due rows a claim, each making progress', { timeout: 60_000 }, async () => {
		const w = await world()
		await seedRows(w, REMOTE_LINK_CLAIM_WALK + 6, NOW, NOW)
		// Nothing left to check: each row read is disarmed.
		await sql(w.h.store, `UPDATE remote_field_links SET links = '[[0,"https://a.example/",null,1]]'`)
		expect(await w.op(claimFieldLinks, { now: w.clock.t })).toEqual({ kind: 'none', givenUp: 0, expired: 0 })
		expect(await armed(w)).toBe(6)
		expect(await w.op(claimFieldLinks, { now: w.clock.t })).toEqual({ kind: 'none', givenUp: 0, expired: 0 })
		expect(await armed(w)).toBe(0)
	})

	it(
		'seeks the expiry, the walk and the fences by their indexes and keys, after ANALYZE and growth',
		{ timeout: 120_000 },
		async () => {
			const w = await world()
			await w.put(actor([A]))
			const { after, before } = await staleStatistics(w.h, {
				capture: async () => {
					await sql(
						w.h.store,
						"UPDATE remote_field_links SET due_at = 0, armed_at = ?, attempts = 0, hold_until = NULL WHERE account_id NOT GLOB '3*'",
						NOW
					)
					return (await plannedRun(w.h, /remote_field_links/, claimFieldLinks, { now: w.clock.t })).plans
				},
				// Many rows armed later and many expired ones with open holds the expiry skips.
				grow: () =>
					seedRows(
						w,
						5_000,
						NOW - REMOTE_LINK_EXPIRE_MS - 1,
						NOW + 10 * FIELD_LINK_HOLD_MS,
						`attempts = 1, hold_until = ${NOW + 10 * FIELD_LINK_HOLD_MS}`
					),
			})
			for (const plans of [before, after]) {
				expect(plans.length).toBeGreaterThan(2)
				for (const { query, plan } of plans) {
					expect(
						scansOf(plan, ['remote_field_links', 'r', 'pl', 'pa', 'accounts']),
						`${query}\n${plan.join('\n')}`
					).toEqual([])
				}
				const expiry = plans.find(({ query }) => query.includes('remote_field_links_expiry'))!
				expect(expiry.plan.join('\n')).toMatch(/remote_field_links_expiry/)
				const walk = plans.find(
					({ query }) => query.includes('INDEXED BY remote_field_links_due') && query.startsWith('SELECT')
				)!
				expect(walk.plan.join('\n')).toMatch(/remote_field_links_due/)
			}
			// The claimed row came first in the walk, before the grown rows.
			expect(await w.row()).toMatchObject({ attempts: 1 })
		}
	)
})
