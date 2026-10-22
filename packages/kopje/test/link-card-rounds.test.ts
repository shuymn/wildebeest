import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { bearer, json, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import { BUILD } from './helpers'
import { plannedRun, scansOf, staleStatistics } from './read-helpers'
import { community, post } from './status-helpers'
import { Db } from '../src/db/sql'
import {
	CARD_CLAIM_WALK,
	CARD_EXPIRE_BATCH,
	CARD_EXPIRE_MS,
	CARD_FRESH_MS,
	CARD_HOLD_MS,
	CARD_ROUND_CLAIMS,
	type CardClaims,
	claimCards,
	recordCard,
} from '../src/domain/link-cards'
import { suspendLocal, unsuspendLocal } from '../src/domain/suspension'
import {
	CARD_ACCEPT_LANGUAGE,
	CARD_ADMISSIONS,
	CARD_CONCURRENCY,
	CARD_OWN_STORE_CALLS,
	CARD_ROUND_MS,
	CARD_STORE_CALLS,
	CARD_SUBREQUESTS,
	type LinkCardsDeps,
	linkCardsRound,
} from '../src/federation/link-cards'
import { CARD_OUTPUT_MAX_UNITS } from '../src/federation/link-details'
import { WEB_PAGE_BODY_LIMIT } from '../src/federation/web-page'
import { SCAN_LIMITS } from '../src/platform/html-scan'
import type { StoreStub } from '../src/platform/store-client'
import { SAFE_INTEGER_MAX } from '../src/platform/stored-bounds'

// The cron's link card round (federation/link-cards.ts) over the Store's claim and record (domain/link-cards.ts).

// The 5-minute cron's rounds a day: the network claims a day at most.
const CARD_DAY_ROUNDS = (24 * 60) / 5

const SITE = 'https://site.example/a'
const HTML = { 'content-type': 'text/html; charset=utf-8' }
const PAGE = '<html lang="en"><head><title> Site title </title><meta name="description" content="About"></head></html>'

type Route = (request: Request) => Response | Promise<Response>

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

const page =
	(body = PAGE) =>
	() =>
		new Response(body, { headers: HTML })

type Row = {
	url: string
	due_at: number | null
	enqueued_at: number
	claim: number
	attempts: number
	generation: number
	title: string
	description: string
	fetched_at: number | null
}

async function world() {
	const h = await community(['alice'])
	const { alice } = h.users
	const clock = { t: NOW }
	h.now.mockImplementation(() => clock.t)
	const requests: string[] = []
	const headers: Headers[] = []
	let routes: Record<string, Route> = {}
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		requests.push(`${request.method} ${request.url}`)
		headers.push(request.headers)
		const route = routes[request.url]
		return Promise.resolve(route === undefined ? new Response('missing', { status: 404 }) : route(request))
	}
	const checks: string[] = []
	let checkHost: (url: URL) => Promise<void> = () => Promise.resolve()
	const deps = (store: () => StoreStub = () => h.store, extra: Partial<LinkCardsDeps> = {}): LinkCardsDeps => ({
		build: () => BUILD,
		store,
		now: () => clock.t,
		keygen: () => Promise.reject(new Error('no keys')),
		loader: {
			fetch,
			checkHost: (url) => {
				checks.push(url.href)
				return checkHost(url)
			},
		},
		...extra,
	})
	const round = (store?: () => StoreStub) => linkCardsRound(h.env as unknown as Env, deps(store))
	const postLink = async (url: string, extra: Record<string, unknown> = {}) =>
		(await post(h, alice, { status: `see ${url}`, ...extra })).id
	const row = async (id: string) =>
		(
			await sql<Row>(
				h.store,
				`SELECT url, due_at, enqueued_at, claim, attempts, generation, title, description, fetched_at FROM status_cards
				WHERE status_id = ?`,
				id
			)
		)[0]
	const op = <I, O>(operation: { run: (sql: SqlStorage, input: I) => O }, input: I) =>
		runInDurableObject(h.store, (_instance, s) => operation.run(s.storage.sql, input))
	// A Store stub whose `method` calls are replaced by `replace` (the call's index among them, from 0).
	const wrapped = (method: string, replace: (n: number, real: () => Promise<unknown>) => Promise<unknown>) => {
		let n = 0
		return new Proxy(h.store, {
			get: (target, key) => {
				const real = Reflect.get(target, key) as unknown
				if (key !== method || typeof real !== 'function') {
					return real
				}
				// An RPC stub's method is called as a method: it has no apply.
				const stub = target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
				return (...args: unknown[]) => replace(n++, () => stub[method]!(...args))
			},
		}) as StoreStub
	}
	return {
		h,
		alice,
		clock,
		requests,
		headers,
		checks,
		setRoutes: (next: Record<string, Route>) => {
			routes = next
		},
		setCheckHost: (next: (url: URL) => Promise<void>) => {
			checkHost = next
		},
		round,
		postLink,
		row,
		op,
		wrapped,
	}
}

describe('the link card round', () => {
	it("fetches a claim's page through the sink and attaches its card", async () => {
		const w = await world()
		w.setRoutes({ [SITE]: page() })
		const id = await w.postLink(SITE)
		expect(await w.round()).toEqual({ claimed: 1, attached: 1, none: 0, unattempted: 0, released: 0, lost: 0 })
		expect(w.requests).toEqual([`GET ${SITE}`])
		expect(w.headers[0]?.get('accept')).toBe('text/html')
		expect(w.headers[0]?.get('accept-language')).toBe(CARD_ACCEPT_LANGUAGE)
		expect(w.headers[0]?.get('user-agent')).toMatch(/^Kopje\/\S+ \(\+https:\/\/kopje\.test\/\) Bot$/)
		expect(await w.row(id)).toMatchObject({
			url: SITE,
			due_at: null,
			attempts: 0,
			title: 'Site title',
			description: 'About',
			fetched_at: NOW,
		})
		// Nothing more is due.
		expect(await w.round()).toMatchObject({ claimed: 0 })
	})

	it('gives no card for a blank title, a failed fetch or a refused URL, without retrying', async () => {
		const w = await world()
		w.setRoutes({
			'https://site.example/blank': page('<title> 　 </title><meta property="og:title" content="">'),
			'https://site.example/json': () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
		})
		const ids = [
			await w.postLink('https://site.example/blank'),
			await w.postLink('https://site.example/json'),
			await w.postLink('https://site.example/missing'),
			await w.postLink('https://site.example:8443/port'),
		]
		expect(await w.round()).toMatchObject({ claimed: 4, attached: 0, none: 4 })
		// The port was refused before any network step.
		expect(w.requests).toEqual([
			'GET https://site.example/blank',
			'GET https://site.example/json',
			'GET https://site.example/missing',
		])
		for (const id of ids) {
			expect(await w.row(id)).toBeUndefined()
		}
	})

	it("copies another status's fresh card at claim, and fetches when there is none", async () => {
		const w = await world()
		w.setRoutes({ [SITE]: page() })
		const first = await w.postLink(SITE)
		await w.round()
		w.clock.t += 1000
		const second = await w.postLink(SITE)
		expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ claims: [], attached: 1 })
		expect(await w.row(second)).toMatchObject({ title: 'Site title', fetched_at: NOW, due_at: null, attempts: 0 })
		expect(w.requests).toEqual([`GET ${SITE}`])
		// A copy older than CARD_FRESH_MS is not taken: the URL is fetched again for the next status.
		w.clock.t = NOW + CARD_FRESH_MS
		const third = await w.postLink(SITE)
		expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ claims: [{ statusId: third }], attached: 0 })
		expect(await w.row(first)).toMatchObject({ fetched_at: NOW })
	})

	it('claims the first CARD_ROUND_CLAIMS rows of seven and leaves the seventh untouched', async () => {
		const w = await world()
		const ids: string[] = []
		for (let i = 0; i < CARD_ROUND_CLAIMS + 1; i++) {
			ids.push(await w.postLink(`https://site${i}.example/`))
		}
		const claimed = await w.op(claimCards, { now: w.clock.t })
		expect(claimed.claims.map((c) => c.statusId)).toEqual(ids.slice(0, CARD_ROUND_CLAIMS))
		expect(await w.row(ids.at(-1)!)).toMatchObject({ due_at: NOW, claim: 0, attempts: 0 })
		for (const id of ids.slice(0, CARD_ROUND_CLAIMS)) {
			expect(await w.row(id)).toMatchObject({ due_at: NOW + CARD_HOLD_MS, claim: 1, attempts: 1 })
		}
	})

	it('defers a row whose URL another row holds, within one walk and across rounds', async () => {
		const w = await world()
		const gate = deferred()
		const reached = deferred()
		w.setRoutes({
			[SITE]: async () => {
				reached.resolve()
				await gate.promise
				return page()()
			},
		})
		const a = await w.postLink(SITE)
		const b = await w.postLink(SITE)
		const first = w.round()
		await reached.promise
		// The same walk deferred b to a's hold; a second round, while a's fetch is held, defers c as well.
		expect(await w.row(b)).toMatchObject({ due_at: NOW + CARD_HOLD_MS, attempts: 0, claim: 0 })
		w.clock.t += 1000
		const c = await w.postLink(SITE)
		expect(await w.round()).toMatchObject({ claimed: 0 })
		expect(await w.row(c)).toMatchObject({ due_at: NOW + CARD_HOLD_MS, attempts: 0 })
		gate.resolve()
		expect(await first).toMatchObject({ claimed: 1, attached: 1 })
		w.clock.t = NOW + CARD_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: 0 })
		// The copies keep the donor's fetched_at, the time a's record landed.
		for (const id of [a, b, c]) {
			expect(await w.row(id)).toMatchObject({ title: 'Site title', fetched_at: NOW + 1000, due_at: null })
		}
		expect(w.requests).toEqual([`GET ${SITE}`])
	})

	it('keeps an open hold past the expiry, so a later round still defers its URL (AM19)', async () => {
		const w = await world()
		const gate = deferred()
		const reached = deferred()
		w.setRoutes({
			[SITE]: async () => {
				reached.resolve()
				await gate.promise
				return page()()
			},
		})
		const a = await w.postLink(SITE)
		w.clock.t = NOW + CARD_EXPIRE_MS - 1000
		const first = w.round()
		await reached.promise
		w.clock.t = NOW + CARD_EXPIRE_MS + 1000
		const b = await w.postLink(SITE)
		const second = (await w.op(claimCards, { now: w.clock.t })) as CardClaims
		expect(second).toMatchObject({ expired: 0, claims: [], deferred: 1 })
		expect(await w.row(a)).toMatchObject({ attempts: 1 })
		expect(await w.row(b)).toMatchObject({ due_at: NOW + CARD_EXPIRE_MS - 1000 + CARD_HOLD_MS })
		gate.resolve()
		expect(await first).toMatchObject({ attached: 1 })
		expect(w.requests).toEqual([`GET ${SITE}`])
	})

	it('expires a pending row after a day, never claiming it', async () => {
		const w = await world()
		const id = await w.postLink(SITE)
		w.clock.t = NOW + CARD_EXPIRE_MS + 1
		expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ expired: 1, claims: [] })
		expect(await w.row(id)).toBeUndefined()
	})
})

describe('the fences of a record', () => {
	async function held(w: Awaited<ReturnType<typeof world>>) {
		const gate = deferred()
		const reached = deferred()
		w.setRoutes({
			[SITE]: async () => {
				reached.resolve()
				await gate.promise
				return page()()
			},
		})
		return { gate, reached }
	}

	it('drops the record of a claim whose status was edited or deleted during the fetch', async () => {
		const w = await world()
		const { gate, reached } = await held(w)
		const edited = await w.postLink(SITE)
		const running = w.round()
		await reached.promise
		const before = (await w.row(edited))!
		const response = await w.h.request(
			`/api/v1/statuses/${edited}`,
			bearer(w.alice.token, json({ status: `again ${SITE}` }, { method: 'PUT' }))
		)
		expect(response.status).toBe(200)
		gate.resolve()
		expect(await running).toMatchObject({ claimed: 1, attached: 0, lost: 1 })
		// The edit's reset: a new generation, pending at once, the claim token kept.
		const after = (await w.row(edited))!
		expect(after).toMatchObject({ due_at: NOW, attempts: 0, claim: before.claim, fetched_at: null, title: '' })
		expect(after.generation).not.toBe(before.generation)

		const again = await held(w)
		const deleted = await w.postLink('https://site.example/b')
		w.setRoutes({
			'https://site.example/b': async () => {
				again.reached.resolve()
				await again.gate.promise
				return page()()
			},
		})
		await sql(w.h.store, 'DELETE FROM status_cards WHERE status_id = ?', edited)
		const second = w.round()
		await again.reached.promise
		expect((await w.h.request(`/api/v1/statuses/${deleted}`, bearer(w.alice.token, { method: 'DELETE' }))).status).toBe(
			200
		)
		again.gate.resolve()
		expect(await second).toMatchObject({ claimed: 1, lost: 1 })
		expect(await sql(w.h.store, 'SELECT count(*) AS n FROM status_cards')).toEqual([{ n: 0 }])
	})

	it("records the others when one claim's record fails", async () => {
		const w = await world()
		w.setRoutes({ [SITE]: page(), 'https://site.example/b': page() })
		const a = await w.postLink(SITE)
		const b = await w.postLink('https://site.example/b')
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const failing = w.wrapped('recordCard', (n, real) => (n === 0 ? Promise.reject(new Error('boom')) : real()))
		expect(await w.round(() => failing)).toMatchObject({ claimed: 2, attached: 1, lost: 1 })
		error.mockRestore()
		const rows = [await w.row(a), await w.row(b)]
		expect(rows.filter((r) => r?.fetched_at === NOW)).toHaveLength(1)
		expect(rows.filter((r) => r?.attempts === 1 && r.fetched_at === null)).toHaveLength(1)
	})

	it('attaches the card of a status suspended and restored during the fetch (an accepted risk)', async () => {
		const w = await world()
		const { gate, reached } = await held(w)
		const id = await w.postLink(SITE)
		const running = w.round()
		await reached.promise
		await runInDurableObject(w.h.store, (_instance, s) => {
			const db = new Db(s.storage.sql)
			suspendLocal(db, w.alice.id, null, w.clock.t)
			unsuspendLocal(db, w.alice.id, w.clock.t + 1)
		})
		gate.resolve()
		expect(await running).toMatchObject({ attached: 1 })
		expect(await w.row(id)).toMatchObject({ fetched_at: NOW })
	})

	it('drops the record of a status suspended during the fetch', async () => {
		const w = await world()
		const { gate, reached } = await held(w)
		const id = await w.postLink(SITE)
		const running = w.round()
		await reached.promise
		await runInDurableObject(w.h.store, (_instance, s) => {
			suspendLocal(new Db(s.storage.sql), w.alice.id, null, w.clock.t)
		})
		gate.resolve()
		expect(await running).toMatchObject({ lost: 1 })
		expect(await w.row(id)).toMatchObject({ attempts: 1, fetched_at: null })
	})

	it('discards a late record of an older claim', async () => {
		const w = await world()
		const id = await w.postLink(SITE)
		const old = (await w.op(claimCards, { now: w.clock.t })).claims[0]!
		w.clock.t += CARD_HOLD_MS
		const current = (await w.op(claimCards, { now: w.clock.t })).claims[0]!
		expect(current.token).toBe(old.token + 1)
		const fields = { title: 't', description: '', authorName: '', authorUrl: '', providerName: '', providerUrl: '' }
		const outcome = { kind: 'card' as const, fields: { ...fields, language: null, publishedAt: null } }
		expect(await w.op(recordCard, { ...old, outcome, now: w.clock.t })).toEqual({ held: false })
		expect(await w.row(id)).toMatchObject({ attempts: 2, fetched_at: null })
		// A claim never recorded twice is given up.
		w.clock.t += CARD_HOLD_MS
		expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ givenUp: 1, claims: [] })
		expect(await w.row(id)).toBeUndefined()
	})
})

describe('the admission of each hop (AM4, AM20)', () => {
	it('starts no fetch and follows no redirect once maintenance is entered during a DNS check', async () => {
		for (const redirect of [false, true]) {
			const w = await world()
			const gate = deferred()
			const reached = deferred()
			const target = redirect ? 'https://next.example/' : SITE
			w.setRoutes({
				[SITE]: redirect ? () => new Response(null, { status: 302, headers: { location: target } }) : page(),
				[target]: page(),
			})
			w.setCheckHost(async (url) => {
				if (url.href === target) {
					reached.resolve()
					await gate.promise
				}
			})
			const id = await w.postLink(SITE)
			const error = vi.spyOn(console, 'error').mockImplementation(() => {})
			const running = w.round()
			await reached.promise
			await w.h.store.setMaintenance(BUILD, true)
			gate.resolve()
			expect(await running).toMatchObject({ claimed: 1, attached: 0, lost: 1 })
			error.mockRestore()
			expect(w.requests, `redirect: ${redirect}`).toEqual(redirect ? [`GET ${SITE}`] : [])
			await w.h.store.setMaintenance(BUILD, false)
			// The claim stays open (its release was refused too) and is claimed again after its hold.
			expect(await w.row(id)).toMatchObject({ attempts: 1, fetched_at: null })
		}
	})

	it.each([
		['before', 0],
		['after', 1],
	])('releases a claim unattempted when a policy RPC fails %s the DNS check', async (_position, failing) => {
		const w = await world()
		w.setRoutes({ [SITE]: page() })
		const id = await w.postLink(SITE)
		const store = w.wrapped('cardHopRefused', (n, real) =>
			n === failing ? Promise.reject(new Error('policy unreadable')) : real()
		)
		expect(await w.round(() => store)).toMatchObject({ claimed: 1, unattempted: 1, none: 0 })
		expect(w.requests).toEqual([])
		expect(await w.row(id)).toMatchObject({ due_at: NOW, attempts: 0, claim: 1, fetched_at: null })
	})

	it('gives no card for a host the domain policy refuses, before or after redirects', async () => {
		const w = await world()
		await blockDomain(w.h.store, 'blocked.example')
		w.setRoutes({
			[SITE]: () => new Response(null, { status: 301, headers: { location: 'https://blocked.example/' } }),
		})
		const direct = await w.postLink('https://blocked.example/x')
		const redirected = await w.postLink(SITE)
		expect(await w.round()).toMatchObject({ claimed: 2, none: 2 })
		expect(w.requests).toEqual([`GET ${SITE}`])
		expect(await w.row(direct)).toBeUndefined()
		expect(await w.row(redirected)).toBeUndefined()
		expect(w.checks).toEqual([SITE])
	})
})

describe('the bounds of a round', () => {
	it('derives its budgets and hold', () => {
		expect([CARD_SUBREQUESTS, CARD_STORE_CALLS, CARD_ADMISSIONS, CARD_OWN_STORE_CALLS]).toEqual([72, 24, 24, 7])
		expect(CARD_HOLD_MS).toBeGreaterThanOrEqual(2 * CARD_ROUND_MS)
		expect(CARD_ROUND_CLAIMS * CARD_DAY_ROUNDS).toBe(1728)
	})

	// The memory model of one fetch (AM13), held CARD_CONCURRENCY times at once: the body prefix (bytes), the scan's
	// strings (UTF-16 code units, two bytes each), one JSON-LD script being parsed (its text, decoded, two bytes per
	// unit) and its parsed value, which an estimate bounds: V8's sizes for each node (a heap number, a string of n units,
	// an array of n elements, an object of n properties), taken at the worst shapes of a script of jsonLdChars units.
	// lol-html's native buffers (its 3 MiB limit) and JSON.parse's internals are not counted. Scripts are parsed one at a
	// time and each is dropped once its fields are read (link-details.ts structuredData).
	it('computes the memory model of a round from its bounds', () => {
		const units = SCAN_LIMITS.jsonLdChars
		const model = (value: unknown): number => {
			let bytes = 0
			const stack: unknown[] = [value]
			while (stack.length > 0) {
				const node = stack.pop()
				if (typeof node === 'string') {
					bytes += 16 + 2 * node.length
				} else if (typeof node === 'number') {
					bytes += Number.isInteger(node) && Math.abs(node) < 2 ** 30 ? 0 : 16
				} else if (Array.isArray(node)) {
					bytes += 16 + 8 * node.length
					stack.push(...(node as unknown[]))
				} else if (typeof node === 'object' && node !== null) {
					const entries = Object.entries(node)
					bytes += 24 + 16 * entries.length
					for (const [key, child] of entries) {
						stack.push(key, child)
					}
				}
			}
			return bytes
		}
		const fill = (open: string, item: string, close: string) =>
			`${open}${Array.from({ length: Math.floor((units - open.length - close.length + 1) / (item.length + 1)) }, () => item).join(',')}${close}`
		const depth = Math.floor(units / 2)
		const shapes = {
			nested: `${'['.repeat(depth)}${']'.repeat(depth)}`,
			arrays: fill('[', '[]', ']'),
			objects: fill('[', '{}', ']'),
			strings: fill('[', '""', ']'),
			doubles: fill('[', '0.5', ']'),
			keys: fill('{', '"":0', '}'),
		}
		const parsed: Record<string, number> = {}
		for (const [name, text] of Object.entries(shapes)) {
			expect(text.length, name).toBeLessThanOrEqual(units)
			const value: unknown = JSON.parse(text)
			parsed[name] = model(value)
		}
		const worstParsed = Math.max(...Object.values(parsed))
		expect(parsed.nested).toBe(worstParsed)
		const perFetch = WEB_PAGE_BODY_LIMIT + 2 * CARD_OUTPUT_MAX_UNITS + 2 * units + worstParsed
		expect({ worstParsed, perFetch, round: CARD_CONCURRENCY * perFetch }).toEqual({
			worstParsed: 393_208,
			perFetch: 2_363_512,
			round: 4_727_024,
		})
	})

	it('walks at most CARD_CLAIM_WALK due rows, deleting each one given up, the 65th left for the next claim', async () => {
		const w = await world()
		const ids: string[] = []
		for (let i = 0; i < CARD_CLAIM_WALK + 1; i++) {
			ids.push(await w.postLink(`https://site.example/${i}`))
		}
		await sql(w.h.store, 'UPDATE status_cards SET attempts = 2')
		const claim = () =>
			plannedRun(w.h, /FROM status_cards INDEXED BY status_cards_due WHERE due_at <= \?1\s+ORDER BY/, claimCards, {
				now: w.clock.t,
			})
		const first = await claim()
		expect(first.result).toMatchObject({ givenUp: CARD_CLAIM_WALK, claims: [] })
		expect(first.plans[0]?.rows).toBe(CARD_CLAIM_WALK)
		expect(await w.row(ids.at(-1)!)).toMatchObject({ attempts: 2 })
		expect((await claim()).result).toMatchObject({ givenUp: 1 })
		expect(await sql(w.h.store, 'SELECT count(*) AS n FROM status_cards')).toEqual([{ n: 0 }])
	})

	it('expires at most CARD_EXPIRE_BATCH rows a claim', { timeout: 60_000 }, async () => {
		const w = await world()
		const status = await w.postLink(SITE)
		// Expired rows of statuses of their own, due far later, so only the expiry reads them.
		await sql(
			w.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('7%017d', i), 'https://kopje.test/s/' || i, ?2, 'public', 'x', '2026-10-12T00:00:00.000Z' FROM n`,
			CARD_EXPIRE_BATCH + 1,
			w.alice.id
		)
		await sql(
			w.h.store,
			`INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation)
			SELECT id, 'https://site.example/old', ?1, 0, 1 FROM statuses WHERE id GLOB '7*'`,
			NOW + 10 * CARD_EXPIRE_MS
		)
		w.clock.t = NOW + CARD_EXPIRE_MS - 1
		const first = await w.op(claimCards, { now: w.clock.t })
		expect(first).toMatchObject({ expired: CARD_EXPIRE_BATCH })
		expect(
			await sql(w.h.store, "SELECT count(*) AS n FROM status_cards WHERE url = 'https://site.example/old'")
		).toEqual([{ n: 1 }])
		expect((await w.op(claimCards, { now: w.clock.t })).expired).toBe(1)
		expect(await w.row(status)).toMatchObject({ attempts: 1 })
	})

	it('deletes a row whose next token would pass SAFE_INTEGER_MAX, and claims one that reaches it', async () => {
		const w = await world()
		const full = await w.postLink('https://site.example/full')
		const last = await w.postLink('https://site.example/last')
		await sql(
			w.h.store,
			'UPDATE status_cards SET claim = ?, generation = ? WHERE status_id = ?',
			SAFE_INTEGER_MAX,
			SAFE_INTEGER_MAX,
			full
		)
		await sql(w.h.store, 'UPDATE status_cards SET claim = ? WHERE status_id = ?', SAFE_INTEGER_MAX - 1, last)
		const claimed = await w.op(claimCards, { now: w.clock.t })
		expect(claimed.claims).toEqual([
			{ statusId: last, token: SAFE_INTEGER_MAX, generation: expect.any(Number), url: 'https://site.example/last' },
		])
		expect(await w.row(full)).toBeUndefined()
	})

	it(
		'reads a bounded number of rows for each lookup by URL, after ANALYZE and growth, hit and miss',
		{ timeout: 120_000 },
		async () => {
			const w = await world()
			const hit = await w.postLink(SITE)
			const grown = 5_000
			const statuses = (prefix: string) =>
				sql(
					w.h.store,
					`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT printf('${prefix}%017d', i), 'https://kopje.test/s/${prefix}' || i, ?2, 'public', 'x',
					'2026-10-12T00:00:00.000Z' FROM n`,
					grown,
					w.alice.id
				)
			const statements = /status_cards/
			const { before, after } = await staleStatistics(w.h, {
				capture: async () => {
					// The hit row first in the walk's order, ahead of the grown rows.
					await sql(w.h.store, 'UPDATE status_cards SET claim = 0, attempts = 0, due_at = 0 WHERE status_id = ?', hit)
					return (await plannedRun(w.h, statements, claimCards, { now: w.clock.t })).plans
				},
				grow: async () => {
					// A large prefix of expired holds and stale copies of the same URL, and many other pending rows due later.
					await statuses('8')
					await statuses('9')
					await sql(
						w.h.store,
						`INSERT INTO status_cards (status_id, url, due_at, enqueued_at, generation, claim, attempts)
					SELECT id, ?1, ?2, ?2, 1, 1, 1 FROM statuses WHERE id GLOB '8*'`,
						SITE,
						NOW - 1
					)
					await sql(
						w.h.store,
						`INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at)
					SELECT id, ?1, 0, 1, 't', ?2 FROM statuses WHERE id GLOB '9*'`,
						SITE,
						NOW - CARD_FRESH_MS - 1
					)
				},
			})
			for (const plans of [before, after]) {
				for (const { query, plan } of plans) {
					expect(
						scansOf(plan, ['status_cards', 't', 'f', 'h', 'statuses', 'es']),
						`${query}\n${plan.join('\n')}`
					).toEqual([])
				}
				// The hit row's two lookups, the first of the walk.
				const lookups = plans.filter(({ query }) => /CROSS JOIN status_cards [fh] INDEXED BY/.test(query)).slice(0, 2)
				expect(lookups.map(({ query }) => query.includes('status_cards_fresh'))).toEqual([true, false])
				// The miss of each lookup reads its target row and no holder or donor: the expired holds and stale copies of
				// the URL are not met (a range seek on due_at and on fetched_at).
				expect(lookups.map(({ rows }) => rows)).toEqual([4, 2])
			}
			// Hits: the 'after' walk claimed six of the grown rows, so their holds are open; then a copy is made fresh.
			const first = async () => {
				await sql(w.h.store, 'UPDATE status_cards SET claim = 0, attempts = 0, due_at = 0 WHERE status_id = ?', hit)
				const run = await plannedRun(w.h, /CROSS JOIN status_cards [fh] INDEXED BY/, claimCards, { now: w.clock.t })
				return run.plans.slice(0, 2).map(({ query, rows }) => [query.includes('status_cards_fresh'), rows])
			}
			expect(await first()).toEqual([
				[true, 4],
				[false, 2],
			])
			expect(await w.row(hit)).toMatchObject({ due_at: NOW + CARD_HOLD_MS, attempts: 0 })
			await sql(
				w.h.store,
				"UPDATE status_cards SET fetched_at = ?1 WHERE status_id = (SELECT min(id) FROM statuses WHERE id GLOB '9*')",
				NOW
			)
			expect((await first()).slice(0, 1)).toEqual([[true, 5]])
			expect(await w.row(hit)).toMatchObject({ due_at: null, fetched_at: NOW, title: 't' })
		}
	)
})

describe('the cron', () => {
	it('runs the round outside the env maintenance only, and logs a failed one', async () => {
		const { scheduledLinkCards } = await import('../src/jobs/scheduled')
		const w = await world()
		w.setRoutes({ [SITE]: page() })
		const id = await w.postLink(SITE)
		const deps = (store: StoreStub = w.h.store): LinkCardsDeps => ({
			build: () => BUILD,
			store: () => store,
			now: () => w.clock.t,
			keygen: () => Promise.reject(new Error('no keys')),
			loader: { fetch: (input, init) => globalThis.fetch(input, init), checkHost: () => Promise.resolve() },
		})
		await scheduledLinkCards({ ...w.h.env, MAINTENANCE: 'on' } as unknown as Env, deps())
		expect(await w.row(id)).toMatchObject({ attempts: 0 })
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const failing = w.wrapped('claimCards', () => Promise.reject(new Error('boom')))
		await scheduledLinkCards({ ...w.h.env, MAINTENANCE: 'off' } as unknown as Env, deps(failing))
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.scheduled.link_cards_failed' }))
		error.mockRestore()
	})
})
