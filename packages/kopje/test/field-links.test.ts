import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it, vi } from 'vitest'

import { apiHarness, bearer, json, login, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import { BUILD } from './helpers'
import { Db } from '../src/db/sql'
import { type Account, type CredentialAccount, VERIFIED_AT_JSON_BYTES } from '../src/domain/accounts'
import {
	claimFieldLinks,
	FIELD_LINK_CLAIM_WALK,
	FIELD_LINK_HOLD_MS,
	type FieldLinksClaim,
	finishFieldLinks,
	recordFieldLink,
} from '../src/domain/field-links'
import { suspendLocal, unsuspendLocal } from '../src/domain/suspension'
import {
	FIELD_LINK_OUTPUT_MAX_UNITS,
	FIELD_LINK_ROUND_MS,
	FIELD_LINK_STORE_CALLS,
	FIELD_LINK_SUBREQUESTS,
	type FieldLinksDeps,
	fieldLinksRound,
} from '../src/federation/field-links'
import { createWebPageSink, DNS_CHECK_SUBREQUESTS, WEB_PAGE_BODY_LIMIT } from '../src/federation/web-page'
import { DeadlinePassed } from '../src/platform/deadline'
import { createScanner, outputMaxUnits, SCAN_LIMITS } from '../src/platform/html-scan'
import type { StoreStub } from '../src/platform/store-client'
import { StoreUnavailableError } from '../src/platform/store-errors'
import {
	FIELD_LINK_VALUE_BYTES,
	LOCAL_FIELDS,
	LOCAL_FIELDS_BYTES,
	VERIFIED_LINKS_BYTES,
} from '../src/platform/stored-bounds'

// Account fields[].verified_at of local accounts (domain/field-links.ts, federation/field-links.ts): Mastodon's
// VerifyAccountLinksWorker and VerifyLinkService (v4.5.11) over the web-page sink (NET-3).

const LINK_BACK = 'https://kopje.test/@alice'
const SITE = 'https://site.example/'
const HTML = { 'content-type': 'text/html; charset=utf-8' }

type Route = (request: Request) => Response | Promise<Response>

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

const page =
	(body: string, headers: Record<string, string> = HTML) =>
	() =>
		new Response(body, { headers })
const relMe = (href: string, tag: 'a' | 'link' = 'a', rel = 'me') =>
	page(tag === 'a' ? `<a rel="${rel}" href="${href}">me</a>` : `<head><link rel="${rel}" href="${href}"></head>`)
const moved =
	(location: string | null, status = 301) =>
	() =>
		new Response(null, { status, headers: location === null ? {} : { location } })

async function world() {
	const h = await apiHarness()
	const alice = await seedAccount(h.store, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' })
	const { token } = await login(h, { scope: 'read write' })
	const clock = { t: NOW }
	h.now.mockImplementation(() => clock.t)
	const requests: string[] = []
	let routes: Record<string, Route> = {}
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		requests.push(`${request.method} ${request.url}`)
		const route = routes[request.url]
		return Promise.resolve(route === undefined ? new Response('missing', { status: 404 }) : route(request))
	}
	const deps = (extra: Partial<FieldLinksDeps> = {}, store: () => StoreStub = () => h.store): FieldLinksDeps => ({
		build: () => BUILD,
		store,
		now: () => clock.t,
		keygen: () => Promise.reject(new Error('no keys')),
		loader: { fetch, checkHost: () => Promise.resolve() },
		...extra,
	})
	const save = async (fields: { name: string; value: string }[]) => {
		const response = await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(token, { ...json({ fields_attributes: fields }), method: 'PATCH' })
		)
		expect(response.status).toBe(200)
		return response.json<CredentialAccount>()
	}
	const credentials = async () =>
		(await h.request('/api/v1/accounts/verify_credentials', bearer(token))).json<CredentialAccount>()
	const account = async () => (await h.request(`/api/v1/accounts/${alice}`, bearer(token))).json<Account>()
	const state = async () =>
		(
			await sql<{
				links_due_at: number | null
				links_hold_until: number | null
				links_claim: number
				links_attempts: number
				verified_links: string | null
			}>(
				h.store,
				`SELECT links_due_at, links_hold_until, links_claim, links_attempts, verified_links FROM local_accounts
				WHERE account_id = ?`,
				alice
			)
		)[0]!
	const round = (extra: Partial<FieldLinksDeps> = {}) => fieldLinksRound(h.env as unknown as Env, deps(extra))
	const op = <I, O>(operation: { run: (sql: SqlStorage, input: I) => O }, input: I) =>
		runInDurableObject(h.store, (_instance, s) => operation.run(s.storage.sql, input))
	return {
		h,
		alice,
		clock,
		requests,
		setRoutes: (next: Record<string, Route>) => {
			routes = next
		},
		deps,
		save,
		credentials,
		account,
		state,
		round,
		op,
	}
}

type World = Awaited<ReturnType<typeof world>>

const shown = (t: number) => `${new Date(t).toISOString().slice(0, -1)}+00:00`
const verifiedAt = (fields: { verified_at: string | null }[]) => fields.map((field) => field.verified_at)

async function verifiedBy(w: World, routes: Record<string, Route>, value = SITE): Promise<boolean> {
	w.setRoutes(routes)
	await w.save([{ name: 'Site', value }])
	w.clock.t += FIELD_LINK_HOLD_MS
	const result = await w.round()
	expect(result.claimed).toBe(true)
	return (await w.credentials()).fields[0]?.verified_at !== null
}

describe('field verification witnesses', () => {
	// Regression witness: before this, both presenters hard-coded null.
	it('verifies a field whose page links back with rel=me, in account entities and source.fields', async () => {
		const w = await world()
		w.setRoutes({ [SITE]: relMe(LINK_BACK) })
		const saved = await w.save([
			{ name: 'Site', value: SITE },
			{ name: 'Note', value: 'not a link' },
		])
		expect(verifiedAt(saved.fields)).toEqual([null, null])
		expect((await w.state()).links_due_at).toBe(NOW)
		const outbound = async () =>
			(await sql<{ n: number }>(w.h.store, 'SELECT count(*) AS n FROM outbound_activities'))[0]!.n
		const sent = await outbound()
		const result = await w.round()
		expect(result).toMatchObject({ claimed: true, verified: 1, unchecked: 0, finished: true })
		const credentials = await w.credentials()
		expect(verifiedAt(credentials.fields)).toEqual([shown(NOW), null])
		expect(verifiedAt(credentials.source.fields)).toEqual([shown(NOW), null])
		expect(verifiedAt((await w.account()).fields)).toEqual([shown(NOW), null])
		expect(shown(NOW)).toBe('2026-10-12T00:00:00.000+00:00')
		expect(await w.state()).toMatchObject({ links_due_at: null, links_attempts: 0 })
		expect(w.requests).toEqual([`GET ${SITE}`])
		// The actor document carries no verification: nothing is delivered.
		expect(await outbound()).toBe(sent)
	})

	it.each([
		['a <link rel="me"> in head', relMe(LINK_BACK, 'link'), true],
		['an href with a character reference', relMe('https://kopje.test/&#64;alice'), true],
		['a case-different href', relMe('HTTPS://KOPJE.TEST/@ALICE'), true],
		['the rel token ME', relMe(LINK_BACK, 'a', 'ME'), true],
		['the rel token Me among others', relMe(LINK_BACK, 'a', 'nofollow Me'), true],
		['a trailing slash', relMe(`${LINK_BACK}/`), false],
		['no rel=me', page(`<a href="${LINK_BACK}">me</a>`), false],
		['a rel=me after a noscript', page(`<noscript></noscript><a rel=me href="${LINK_BACK}">`), false],
		['a rel=me after a select', page(`<select></select><a rel=me href="${LINK_BACK}">`), false],
		['a rel=me inside svg', page(`<svg><a rel=me href="${LINK_BACK}"></a></svg>`), false],
		['a rel=me after math', page(`<math></math><a rel=me href="${LINK_BACK}">`), false],
		['a frameset page', page(`<a rel=me href="${LINK_BACK}"><frameset></frameset>`), false],
		['a 404', () => new Response(`<a rel=me href="${LINK_BACK}">`, { status: 404, headers: HTML }), false],
		['JSON', page(`<a rel=me href="${LINK_BACK}">`, { 'content-type': 'application/json' }), false],
		['a deflate body', page(`<a rel=me href="${LINK_BACK}">`, { ...HTML, 'content-encoding': 'deflate' }), false],
	])('decides %s', async (_label, route, verified) => {
		const w = await world()
		expect(await verifiedBy(w, { [SITE]: route })).toBe(verified)
	})

	it.each([
		['a 301 with the exact Location', moved(LINK_BACK), true],
		['a 200 with the exact Location', moved(LINK_BACK, 200), true],
		['a case-different Location', moved('https://kopje.test/@Alice'), false],
		['a relative Location', moved('/@alice'), false],
		['no Location', moved(null), false],
	])('HEADs the first rel=me link and decides %s', async (_label, route, verified) => {
		const w = await world()
		const short = 'https://short.example/a'
		const routes = {
			[SITE]: page(`<a rel=me href="${short}"></a><a rel=me href="https://other.example/">`),
			[short]: route,
		}
		expect(await verifiedBy(w, routes)).toBe(verified)
		expect(w.requests).toEqual([`GET ${SITE}`, `HEAD ${short}`])
	})

	it.each([
		['missing', '<a rel=me>x</a>'],
		['relative', '<a rel=me href="/elsewhere">x</a>'],
		['http', '<a rel=me href="http://short.example/a">x</a>'],
		['a literal IP', '<a rel=me href="https://192.0.2.1/a">x</a>'],
		['on a non-default port', '<a rel=me href="https://short.example:8443/a">x</a>'],
		['past the scan bound', `<a rel=me href="https://short.example/${'a'.repeat(SCAN_LIMITS.valueChars)}">x</a>`],
	])('sends no HEAD when the first rel=me href is %s', async (_label, body) => {
		const w = await world()
		expect(await verifiedBy(w, { [SITE]: page(`${body}<a rel=me href="https://short.example/b">`) })).toBe(false)
		expect(w.requests).toEqual([`GET ${SITE}`])
	})

	it('never arms or fetches a value that is not a verifiable link', async () => {
		const w = await world()
		for (const value of [
			'http://site.example/',
			'https://Site.example/',
			'https://site.example./',
			'site',
			'https://[::1]/',
		]) {
			await w.save([{ name: 'x', value }])
			expect((await w.state()).links_due_at, value).toBeNull()
		}
		expect(await w.round()).toMatchObject({ claimed: false })
		expect(w.requests).toEqual([])
	})

	it('refuses hosts and redirects the sink refuses before any request, and logs the host only', async () => {
		const w = await world()
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		w.setRoutes({ [SITE]: moved('https://198.51.100.7/x') })
		await w.save([
			{ name: 'a', value: 'https://127.0.0.1/' },
			{ name: 'b', value: SITE },
			{ name: 'c', value: 'https://site.example:443/p?q=1' },
		])
		w.setRoutes({
			[SITE]: moved('https://198.51.100.7/x'),
			'https://site.example/p?q=1': moved('http://site.example/'),
		})
		const result = await w.round()
		expect(result).toMatchObject({ claimed: true, verified: 0, finished: true })
		expect(w.requests).toEqual([`GET ${SITE}`, 'GET https://site.example/p?q=1'])
		const events = log.mock.calls.map(([entry]) => entry as Record<string, unknown>)
		expect(events.filter((e) => e.event === 'kopje.field_links.unverified')).toEqual([
			{ event: 'kopje.field_links.unverified', step: 'get', kind: 'refused', reason: 'ip-literal', host: null },
			{
				event: 'kopje.field_links.unverified',
				step: 'get',
				kind: 'refused',
				reason: 'ip-literal',
				host: 'site.example',
			},
			{ event: 'kopje.field_links.unverified', step: 'get', kind: 'refused', reason: 'scheme', host: 'site.example' },
		])
		log.mockRestore()
	})

	it('never contacts a host the domain policy refuses', async () => {
		const w = await world()
		await blockDomain(w.h.store, 'site.example')
		expect(await verifiedBy(w, { [SITE]: relMe(LINK_BACK) })).toBe(false)
		expect(w.requests).toEqual([])
	})

	it('carries the verification over while the value stays, and checks a changed value again', async () => {
		const w = await world()
		const other = 'https://other.example/'
		w.setRoutes({ [SITE]: relMe(LINK_BACK), [other]: relMe(LINK_BACK) })
		await w.save([{ name: 'Site', value: SITE }])
		await w.round()
		// The name and position change, the value stays: it keeps its time, and nothing is due.
		w.clock.t += 1000
		const renamed = await w.save([
			{ name: 'Other', value: 'text' },
			{ name: 'Renamed', value: SITE },
		])
		expect(verifiedAt(renamed.fields)).toEqual([null, shown(NOW)])
		expect((await w.state()).links_due_at).toBeNull()
		// A changed value loses it, and is checked once the last claim's hold has ended.
		const changed = await w.save([{ name: 'Renamed', value: other }])
		expect(verifiedAt(changed.fields)).toEqual([null])
		expect(await w.state()).toMatchObject({ links_due_at: NOW + FIELD_LINK_HOLD_MS, verified_links: null })
		expect(await w.round()).toMatchObject({ claimed: false })
		w.clock.t = NOW + FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: true, verified: 1 })
		expect(verifiedAt((await w.credentials()).fields)).toEqual([shown(NOW + FIELD_LINK_HOLD_MS)])
	})

	it('does not retry an unproven value until the next save', async () => {
		const w = await world()
		w.setRoutes({ [SITE]: page('<p>nothing</p>') })
		await w.save([{ name: 'Site', value: SITE }])
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, finished: true })
		expect((await w.state()).links_due_at).toBeNull()
		w.clock.t += 10 * FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: false })
		await w.save([{ name: 'Site', value: SITE }])
		expect((await w.state()).links_due_at).toBe(w.clock.t)
	})
})

describe('field verification rate and fences', () => {
	it('coalesces saves into one claim, at most one per account per hold', async () => {
		const w = await world()
		w.setRoutes({ [SITE]: page('<p>nothing</p>') })
		let claims = 0
		// A save and a cron tick every 5 minutes for an hour: 12 saves, at most 12 claims.
		for (let tick = 0; tick < 12; tick++) {
			await w.save([{ name: 'Site', value: SITE }])
			await w.save([{ name: 'Site', value: SITE }])
			claims += (await w.round()).claimed ? 1 : 0
			w.clock.t += FIELD_LINK_HOLD_MS
		}
		expect(claims).toBe(12)
		expect((await w.state()).links_claim).toBe(12)
		// A save within a hold is due at its end.
		await w.save([{ name: 'Site', value: SITE }])
		await w.round()
		w.clock.t += 1000
		await w.save([{ name: 'Site', value: SITE }])
		expect((await w.state()).links_due_at).toBe(w.clock.t - 1000 + FIELD_LINK_HOLD_MS)
		expect(await w.round()).toMatchObject({ claimed: false })
	})

	it('lets an overlapping round claim nothing, and a round outliving its hold write nothing', async () => {
		const w = await world()
		const gate = deferred()
		const reached = deferred()
		let first = true
		w.setRoutes({
			[SITE]: async () => {
				if (first) {
					first = false
					reached.resolve()
					await gate.promise
				}
				return relMe(LINK_BACK)()
			},
		})
		await w.save([{ name: 'Site', value: SITE }])
		const late = w.round()
		await reached.promise
		// The gated round holds the claim: a second round within the hold claims nothing.
		expect(await w.round()).toMatchObject({ claimed: false })
		// Past the hold, a new claim takes it (a new token) and finishes; the gated round's record is fenced out.
		w.clock.t += FIELD_LINK_HOLD_MS
		w.setRoutes({ [SITE]: page('<p>moved away</p>') })
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, finished: true })
		w.setRoutes({ [SITE]: relMe(LINK_BACK) })
		gate.resolve()
		// Its deadline passed long before the hold did: it starts no Store call (and a record would be fenced out,
		// "discards a late record and finish from an older claim").
		await expect(late).rejects.toBeInstanceOf(DeadlinePassed)
		expect(await w.state()).toMatchObject({ links_claim: 2, links_attempts: 0, verified_links: null })
	})

	it('gives up after two claims that never finished', async () => {
		const w = await world()
		await w.save([{ name: 'Site', value: SITE }])
		const claim = () => w.op(claimFieldLinks, { now: w.clock.t })
		expect((await claim()).kind).toBe('claimed')
		w.clock.t += FIELD_LINK_HOLD_MS
		expect((await claim()).kind).toBe('claimed')
		w.clock.t += FIELD_LINK_HOLD_MS
		expect(await claim()).toEqual({ kind: 'none', givenUp: 1, more: false })
		expect(await w.state()).toMatchObject({ links_due_at: null, links_attempts: 0, links_claim: 2 })
	})

	it('schedules a value added during the claim, and nothing when every claimed value failed', async () => {
		const w = await world()
		const other = 'https://other.example/'
		const gate = deferred()
		const reached = deferred()
		w.setRoutes({
			[SITE]: async () => {
				reached.resolve()
				await gate.promise
				return page('<p>no</p>')()
			},
			[other]: page('<p>no</p>'),
		})
		// Claim [A]; a save adds B while A's GET is held; A fails: B is pending, after the hold.
		await w.save([{ name: 'A', value: SITE }])
		const running = w.round()
		await reached.promise
		w.clock.t += 1000
		await w.save([
			{ name: 'A', value: SITE },
			{ name: 'B', value: other },
		])
		gate.resolve()
		expect(await running).toMatchObject({ claimed: true, finished: true })
		expect((await w.state()).links_due_at).toBe(NOW + FIELD_LINK_HOLD_MS)
		// Claim [A, B]; both fail: nothing is pending.
		w.clock.t = NOW + FIELD_LINK_HOLD_MS
		w.setRoutes({ [SITE]: page('<p>no</p>'), [other]: page('<p>no</p>') })
		const claimed = (await w.round()) as { claimed: boolean }
		expect(claimed.claimed).toBe(true)
		expect((await w.state()).links_due_at).toBeNull()
	})

	it('stamps nothing for an account suspended during a GET, nor once it is unsuspended', async () => {
		const w = await world()
		const gate = deferred()
		const reached = deferred()
		w.setRoutes({
			[SITE]: async () => {
				reached.resolve()
				await gate.promise
				return relMe(LINK_BACK)()
			},
			'https://second.example/': relMe(LINK_BACK),
		})
		await w.save([
			{ name: 'A', value: SITE },
			{ name: 'B', value: 'https://second.example/' },
		])
		const running = w.round()
		await reached.promise
		await runInDurableObject(w.h.store, (_instance, s) => {
			const db = new Db(s.storage.sql)
			suspendLocal(db, w.alice, null, w.clock.t)
			unsuspendLocal(db, w.alice, w.clock.t + 1)
		})
		gate.resolve()
		expect(await running).toMatchObject({ claimed: true, verified: 0, finished: false })
		// The round stopped at the lost fence: the second value was never requested.
		expect(w.requests).toEqual([`GET ${SITE}`])
		expect(await w.state()).toMatchObject({ links_due_at: null, links_attempts: 0, verified_links: null })
		w.clock.t += 10 * FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: false })
	})

	it('retries a round the Store refused during a GET once its hold ends', async () => {
		const w = await world()
		const gate = deferred()
		const reached = deferred()
		w.setRoutes({
			[SITE]: async () => {
				reached.resolve()
				await gate.promise
				return relMe(LINK_BACK)()
			},
		})
		await w.save([{ name: 'Site', value: SITE }])
		const running = w.round()
		await reached.promise
		await w.h.store.setMaintenance(BUILD, true)
		gate.resolve()
		await expect(running).rejects.toBeInstanceOf(StoreUnavailableError)
		// In maintenance the claim, a write, is refused before any request.
		await expect(w.round()).rejects.toBeInstanceOf(StoreUnavailableError)
		expect(w.requests).toEqual([`GET ${SITE}`])
		await w.h.store.setMaintenance(BUILD, false)
		expect(await w.state()).toMatchObject({ links_attempts: 1 })
		w.clock.t += FIELD_LINK_HOLD_MS
		w.setRoutes({ [SITE]: relMe(LINK_BACK) })
		expect(await w.round()).toMatchObject({ claimed: true, verified: 1, finished: true })
	})

	it('discards a late record and finish from an older claim', async () => {
		const w = await world()
		await w.save([{ name: 'Site', value: SITE }])
		const old = (await w.op(claimFieldLinks, { now: w.clock.t })) as Extract<FieldLinksClaim, { kind: 'claimed' }>
		w.clock.t += FIELD_LINK_HOLD_MS
		const current = (await w.op(claimFieldLinks, { now: w.clock.t })) as Extract<FieldLinksClaim, { kind: 'claimed' }>
		expect(current.token).toBe(old.token + 1)
		const fence = { accountId: w.alice, token: old.token, epoch: old.epoch }
		expect(await w.op(recordFieldLink, { ...fence, value: SITE, verified: true, now: w.clock.t })).toEqual({
			held: false,
			recorded: false,
		})
		expect(await w.op(finishFieldLinks, { ...fence, claimed: [SITE], unchecked: [], now: w.clock.t })).toEqual({
			held: false,
			pending: false,
		})
		expect(await w.state()).toMatchObject({ links_attempts: 2, verified_links: null })
	})
})

describe('field verification bounds', () => {
	it('derives the scan output and the budgets of a round', () => {
		expect(FIELD_LINK_OUTPUT_MAX_UNITS).toBe(outputMaxUnits({ ...SCAN_LIMITS, links: 0, metas: 0, jsonLd: 0 }))
		expect(FIELD_LINK_OUTPUT_MAX_UNITS).toBe(67_648)
		expect([FIELD_LINK_SUBREQUESTS, FIELD_LINK_STORE_CALLS]).toEqual([60, 20])
		expect(FIELD_LINK_HOLD_MS).toBeGreaterThanOrEqual(2 * FIELD_LINK_ROUND_MS)
	})

	// Kopje's writer at its worst (four fields, names and values of 255 characters that JSON escapes to six bytes
	// each, or of astral characters), within what verification reads.
	it("holds the writer's largest fields within LOCAL_FIELDS_BYTES", () => {
		const utf8 = (text: string) => new TextEncoder().encode(text).length
		const worst = Math.max(
			...['\u0001', '"', '\u{1F600}'].map((c) =>
				utf8(
					JSON.stringify(Array.from({ length: LOCAL_FIELDS }, () => ({ name: c.repeat(255), value: c.repeat(255) })))
				)
			)
		)
		expect(worst).toBe(12_333)
		expect(worst).toBeLessThanOrEqual(LOCAL_FIELDS_BYTES)
	})

	it('runs a maximum round within its budget and deadline', { timeout: 60_000 }, async () => {
		const w = await world()
		const values = Array.from({ length: LOCAL_FIELDS }, (_, i) => `https://v${i}.example/`)
		const routes: Record<string, Route> = {}
		const filler = 'x'.repeat(WEB_PAGE_BODY_LIMIT)
		for (const value of values) {
			routes[value] = moved(`${value}1`)
			routes[`${value}1`] = moved(`${value}2`)
			routes[`${value}2`] = moved(`${value}3`)
			routes[`${value}3`] = page(`<a rel=me href="${value}h"></a>${filler}`)
			routes[`${value}h`] = moved('https://kopje.test/@nobody')
		}
		w.setRoutes(routes)
		let dns = 0
		let policy = 0
		const store = w.h.store
		const counting = new Proxy(store, {
			get: (target, key) =>
				key === 'fetchRefused'
					? (...args: unknown[]) => {
							policy++
							return (target.fetchRefused as (...a: unknown[]) => Promise<boolean>)(...args)
						}
					: (Reflect.get(target, key) as unknown),
		})
		await w.save(values.map((value, i) => ({ name: `f${i}`, value })))
		const started = Date.now()
		const result = await fieldLinksRound(
			w.h.env as unknown as Env,
			w.deps(
				{
					loader: {
						fetch: (input, init) => {
							const request = input instanceof Request ? input : new Request(input, init)
							w.requests.push(`${request.method} ${request.url}`)
							const route = routes[request.url]
							return Promise.resolve(route === undefined ? new Response('', { status: 404 }) : route(request))
						},
						checkHost: () => {
							dns++
							return Promise.resolve()
						},
					},
				},
				() => counting
			)
		)
		expect(Date.now() - started).toBeLessThan(FIELD_LINK_ROUND_MS)
		expect(result).toMatchObject({ claimed: true, verified: 0, unchecked: 0, finished: true })
		// Every value: four GET hops and a HEAD, each with its DNS check and domain policy read.
		expect(w.requests).toHaveLength(LOCAL_FIELDS * 5)
		expect(dns * DNS_CHECK_SUBREQUESTS + w.requests.length).toBe(FIELD_LINK_SUBREQUESTS)
		expect(policy).toBe(FIELD_LINK_STORE_CALLS)
	})

	it('marks values past the budget unchecked and checks them after the hold', async () => {
		const w = await world()
		const values = Array.from({ length: LOCAL_FIELDS }, (_, i) => `https://v${i}.example/`)
		w.setRoutes(Object.fromEntries(values.map((value) => [value, page('<p>no</p>')])))
		await w.save(values.map((value, i) => ({ name: `f${i}`, value })))
		w.clock.t += 1
		// A round whose deadline has passed after the first GET.
		const slow = w.deps()
		let calls = 0
		const result = await fieldLinksRound(w.h.env as unknown as Env, {
			...slow,
			now: () => (calls++ < 4 ? w.clock.t : w.clock.t + FIELD_LINK_ROUND_MS),
		})
		expect(result.claimed).toBe(true)
		expect(result.unchecked).toBeGreaterThan(0)
		expect((await w.state()).links_due_at).toBe(NOW + 1 + FIELD_LINK_HOLD_MS)
	})

	it('holds a held scan past the deadline as unchecked', async () => {
		const w = await world()
		const release = deferred()
		const sink = createWebPageSink({ scan: createScanner(() => release.promise) })
		w.setRoutes({ [SITE]: page(`<a rel=me href="${LINK_BACK}">${'x'.repeat(200_000)}`) })
		await w.save([{ name: 'Site', value: SITE }])
		let late = false
		const running = fieldLinksRound(w.h.env as unknown as Env, {
			...w.deps({ sink }),
			now: () => (late ? w.clock.t + FIELD_LINK_ROUND_MS : w.clock.t),
		})
		await new Promise((resolve) => setTimeout(resolve, 50))
		late = true
		release.resolve()
		expect(await running).toMatchObject({ claimed: true, verified: 0, unchecked: 1, finished: true })
		expect((await w.state()).links_due_at).toBe(NOW + FIELD_LINK_HOLD_MS)
	})

	it('presents at most VERIFIED_AT_JSON_BYTES more per verified field: 108 per Account, 216 per CredentialAccount', async () => {
		const w = await world()
		const values = Array.from({ length: LOCAL_FIELDS }, (_, i) => `https://v${i}.example/`)
		w.setRoutes(Object.fromEntries(values.map((value) => [value, relMe(LINK_BACK)])))
		const before = await w.save(values.map((value, i) => ({ name: `f${i}`, value })))
		const accountBefore = await w.account()
		await w.round()
		const after = await w.credentials()
		const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
		const perField = VERIFIED_AT_JSON_BYTES - bytes(null)
		expect(bytes(shown(NOW))).toBe(VERIFIED_AT_JSON_BYTES)
		expect(LOCAL_FIELDS * perField).toBe(108)
		expect(bytes(await w.account()) - bytes(accountBefore)).toBe(LOCAL_FIELDS * perField)
		expect(bytes(after) - bytes(before)).toBe(2 * LOCAL_FIELDS * perField)
	})

	it('reads converted or imported fields past LOCAL_FIELDS_BYTES or LOCAL_FIELDS as before, never verified', async () => {
		const w = await world()
		w.setRoutes({ [SITE]: relMe(LINK_BACK) })
		const stamp = JSON.stringify([[SITE, '2026-10-01T00:00:00.000Z']])
		const fieldsOf = (pad: number, count = 1) =>
			JSON.stringify([
				{ name: 'p'.repeat(pad), value: SITE },
				...Array.from({ length: count - 1 }, (_, i) => ({ name: `n${i}`, value: 'v' })),
			])
		const atBound = fieldsOf(0)
		const exact = fieldsOf(LOCAL_FIELDS_BYTES - new TextEncoder().encode(atBound).length)
		expect(new TextEncoder().encode(exact).length).toBe(LOCAL_FIELDS_BYTES)
		for (const [label, fields, verified] of [
			['exactly LOCAL_FIELDS_BYTES', exact, true],
			['one byte more', fieldsOf(LOCAL_FIELDS_BYTES - new TextEncoder().encode(atBound).length + 1), false],
			['five elements', fieldsOf(0, 5), false],
		] as const) {
			await sql(
				w.h.store,
				'UPDATE local_accounts SET fields = ?, verified_links = ?, links_due_at = ? WHERE account_id = ?',
				fields,
				stamp,
				w.clock.t,
				w.alice
			)
			const fieldsShown = (await w.account()).fields
			expect(fieldsShown[0]?.verified_at ?? null, label).toBe(verified ? '2026-10-01T00:00:00.000+00:00' : null)
			expect(fieldsShown.length, label).toBe(JSON.parse(fields).length)
			await sql(w.h.store, 'UPDATE local_accounts SET verified_links = NULL WHERE account_id = ?', w.alice)
			const result = await w.round()
			expect(result.claimed, label).toBe(verified)
			expect((await sql<{ fields: string }>(w.h.store, 'SELECT fields FROM local_accounts'))[0]!.fields).toBe(fields)
			w.clock.t += FIELD_LINK_HOLD_MS
		}
	})

	it('drops a verification that would pass the stored bound, and never fails the write', async () => {
		const w = await world()
		w.setRoutes({ [SITE]: relMe(LINK_BACK) })
		await w.save([{ name: 'Site', value: SITE }])
		// An imported verified_links of four values the fields do not hold, within its bound.
		const imported = JSON.stringify(
			Array.from({ length: 4 }, (_, i) => [`https://gone${i}.example/`, '2026-10-01T00:00:00.000Z'])
		)
		await sql(w.h.store, 'UPDATE local_accounts SET verified_links = ? WHERE account_id = ?', imported, w.alice)
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, finished: true })
		expect((await w.state()).verified_links).toBe(imported)
		expect(new TextEncoder().encode(imported).length).toBeLessThanOrEqual(VERIFIED_LINKS_BYTES)
	})

	it('skips, without rewriting, a row whose epoch or username is outside its bound', async () => {
		const w = await world()
		await w.save([{ name: 'Site', value: SITE }])
		const claim = () => w.op(claimFieldLinks, { now: w.clock.t })
		await sql(w.h.store, "UPDATE local_accounts SET credential_epoch = 'x' WHERE account_id = ?", w.alice)
		expect(await claim()).toEqual({ kind: 'none', givenUp: 0, more: false })
		expect(
			await sql(w.h.store, 'SELECT credential_epoch, links_due_at FROM local_accounts WHERE account_id = ?', w.alice)
		).toEqual([{ credential_epoch: 'x', links_due_at: null }])
		await sql(
			w.h.store,
			'UPDATE local_accounts SET credential_epoch = ?, links_due_at = ? WHERE account_id = ?',
			2 ** 53 - 1,
			w.clock.t,
			w.alice
		)
		expect(await claim()).toMatchObject({ kind: 'claimed', epoch: 2 ** 53 - 1, linkBack: LINK_BACK })
		w.clock.t += FIELD_LINK_HOLD_MS
		await sql(
			w.h.store,
			'UPDATE local_accounts SET links_claim = ?, links_due_at = ?, links_attempts = 0 WHERE account_id = ?',
			2 ** 53 - 1,
			w.clock.t,
			w.alice
		)
		expect(await claim()).toEqual({ kind: 'none', givenUp: 0, more: false })
		expect((await w.state()).links_claim).toBe(2 ** 53 - 1)
		await sql(
			w.h.store,
			'UPDATE local_accounts SET links_claim = 0, links_due_at = ?, links_hold_until = NULL WHERE account_id = ?',
			w.clock.t,
			w.alice
		)
		await sql(w.h.store, "UPDATE accounts SET username = 'al ice' WHERE id = ?", w.alice)
		expect(await claim()).toEqual({ kind: 'none', givenUp: 0, more: false })
		expect((await sql(w.h.store, 'SELECT username FROM accounts WHERE id = ?', w.alice))[0]).toEqual({
			username: 'al ice',
		})
	})

	it('reads at most FIELD_LINK_CLAIM_WALK due rows a claim, each making progress', async () => {
		const w = await world()
		const total = FIELD_LINK_CLAIM_WALK + 6
		for (let i = 0; i < total; i++) {
			await seedAccount(w.h.store, { username: `u${i}` })
		}
		// Due rows with nothing to verify: each claim disarms the ones it reads.
		await sql(w.h.store, 'UPDATE local_accounts SET links_due_at = ?', w.clock.t)
		const claim = () => w.op(claimFieldLinks, { now: w.clock.t })
		expect(await claim()).toEqual({ kind: 'none', givenUp: 0, more: true })
		const left = async () =>
			(
				await sql<{ n: number }>(w.h.store, 'SELECT count(*) AS n FROM local_accounts WHERE links_due_at IS NOT NULL')
			)[0]!.n
		expect(await left()).toBe(total + 1 - FIELD_LINK_CLAIM_WALK)
		expect(await claim()).toEqual({ kind: 'none', givenUp: 0, more: false })
		expect(await left()).toBe(0)
	})

	it('keeps the claimed values within their bound', async () => {
		const w = await world()
		const longest = `https://site.example/${'a'.repeat(FIELD_LINK_VALUE_BYTES - 'https://site.example/'.length)}`
		await w.save([{ name: 'a', value: longest }])
		const claimed = (await w.op(claimFieldLinks, { now: w.clock.t })) as Extract<FieldLinksClaim, { kind: 'claimed' }>
		expect(claimed.values).toEqual([longest])
		expect(longest.length).toBe(FIELD_LINK_VALUE_BYTES)
	})
})

describe('field verification dispatch', () => {
	it('runs from the cron only outside maintenance, and logs a failed round', async () => {
		const { scheduledFieldLinks } = await import('../src/jobs/scheduled')
		const w = await world()
		w.setRoutes({ [SITE]: relMe(LINK_BACK) })
		await w.save([{ name: 'Site', value: SITE }])
		await scheduledFieldLinks({ ...w.h.env, MAINTENANCE: 'on' } as unknown as Env, w.deps())
		expect(w.requests).toEqual([])
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const failing = new Proxy(w.h.store, {
			get: (target, key) =>
				key === 'claimFieldLinks' ? () => Promise.reject(new Error('boom')) : (Reflect.get(target, key) as unknown),
		})
		await scheduledFieldLinks(
			{ ...w.h.env, MAINTENANCE: 'off' } as unknown as Env,
			w.deps({}, () => failing)
		)
		expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'kopje.scheduled.field_links_failed' }))
		error.mockRestore()
		await scheduledFieldLinks({ ...w.h.env, MAINTENANCE: 'off' } as unknown as Env, w.deps())
		expect(verifiedAt((await w.credentials()).fields)).toEqual([shown(NOW)])
	})
})
