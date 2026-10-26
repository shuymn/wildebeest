import { runInDurableObject } from 'cloudflare:test'
import { env as workersEnv } from 'cloudflare:workers'

import { parseFragment } from 'parse5'
import { describe, expect, it, vi } from 'vitest'

import { apiHarness, bearer, json, login, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import { BUILD } from './helpers'
import { observedSql } from './read-helpers'
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
	FIELD_LINK_ADMISSIONS,
	FIELD_LINK_CHECKS_MS,
	FIELD_LINK_OUTPUT_MAX_UNITS,
	FIELD_LINK_ROUND_MS,
	FIELD_LINK_STORE_CALLS,
	FIELD_LINK_SUBREQUESTS,
	type FieldLinksDeps,
	fieldLinksRound,
} from '../src/federation/field-links'
import {
	createWebPageSink,
	DNS_CHECK_SUBREQUESTS,
	REDIRECT_PROBE_TIMEOUT_MS,
	WEB_PAGE_BODY_LIMIT,
	WEB_PAGE_TIMEOUT_MS,
} from '../src/federation/web-page'
import { DeadlinePassed } from '../src/platform/deadline'
import { createScanner, outputMaxUnits, SCAN_LIMITS } from '../src/platform/html-scan'
import type { StoreStub } from '../src/platform/store-client'
import { StoreUnavailableError } from '../src/platform/store-errors'
import {
	FIELD_LINK_VALUE_BYTES,
	LOCAL_FIELDS,
	LOCAL_FIELDS_BYTES,
	UNVERIFIED_LINKS_BYTES,
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
				unverified_links: string | null
			}>(
				h.store,
				`SELECT links_due_at, links_hold_until, links_claim, links_attempts, verified_links, unverified_links
				FROM local_accounts WHERE account_id = ?`,
				alice
			)
		)[0]!
	const round = (extra: Partial<FieldLinksDeps> = {}, store?: StoreStub) =>
		fieldLinksRound(h.env as unknown as Env, deps(extra, store === undefined ? undefined : () => store))
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

// A presented field value's text, its link markup removed.
function htmlText(html: string): string {
	const text = (node: object): string =>
		'value' in node && typeof node.value === 'string'
			? node.value
			: 'childNodes' in node && Array.isArray(node.childNodes)
				? node.childNodes.map(text).join('')
				: ''
	return text(parseFragment(html))
}

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

const VALUES = Array.from({ length: LOCAL_FIELDS }, (_, i) => `https://v${i}.example/`)
const fieldsOf = (values: readonly string[]) => values.map((value, i) => ({ name: `f${i}`, value }))
const NOWHERE = 'https://kopje.test/@nobody'

// Each value's check at its ceiling: its GET takes just under WEB_PAGE_TIMEOUT_MS and finds a rel=me elsewhere, whose
// HEAD takes just under REDIRECT_PROBE_TIMEOUT_MS and redirects to the link back for the values in `verified` only.
function slowRoutes(w: World, values: readonly string[], verified: readonly string[] = []): Record<string, Route> {
	const routes: Record<string, Route> = {}
	for (const [i, value] of values.entries()) {
		const probe = `https://probe${i}.example/`
		routes[value] = () => {
			w.clock.t += WEB_PAGE_TIMEOUT_MS - 1
			return relMe(probe)()
		}
		routes[probe] = () => {
			w.clock.t += REDIRECT_PROBE_TIMEOUT_MS - 1
			return moved(verified.includes(value) ? LINK_BACK : NOWHERE)()
		}
	}
	return routes
}

const gets = (w: World) => w.requests.filter((request) => request.startsWith('GET '))

describe('field verification witnesses', () => {
	// Regression witness: a presenter that hard-codes null fails here.
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
		expect(await w.state()).toMatchObject({ links_due_at: null, unverified_links: JSON.stringify([SITE]) })
		w.clock.t += 10 * FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: false })
		// Due by hand, the claim reads the row and finds no candidate: it disarms it and requests nothing.
		await sql(w.h.store, 'UPDATE local_accounts SET links_due_at = ? WHERE account_id = ?', w.clock.t, w.alice)
		expect(await w.round()).toMatchObject({ claimed: false })
		expect((await w.state()).links_due_at).toBeNull()
		expect(w.requests).toEqual([`GET ${SITE}`])
		await w.save([{ name: 'Site', value: SITE }])
		expect(await w.state()).toMatchObject({ links_due_at: w.clock.t, unverified_links: null })
	})
})

describe('field verification progress', () => {
	// Regression witness (#1259): before unverified_links, every claim checked the slow negatives first again, the
	// finish re-armed with its attempts reset, and the last value was never checked.
	it('checks the values a round could not reach, and not those it checked, after the hold', async () => {
		const w = await world()
		w.setRoutes(slowRoutes(w, VALUES, [VALUES[3]!]))
		await w.save(fieldsOf(VALUES))
		const start = w.clock.t
		const rounds = []
		for (let claim = 1; claim <= LOCAL_FIELDS + 1; claim++) {
			const result = await w.round()
			rounds.push(result)
			if (!result.claimed) {
				break
			}
			w.clock.t = start + claim * FIELD_LINK_HOLD_MS
		}
		// The first value at its ceiling fits the window: three are checked, the fourth runs past the deadline.
		expect(rounds).toEqual([
			expect.objectContaining({ claimed: true, verified: 0, unchecked: 1, finished: true }),
			expect.objectContaining({ claimed: true, verified: 1, unchecked: 0, finished: true }),
			expect.objectContaining({ claimed: false }),
		])
		expect(gets(w)).toEqual([...VALUES, VALUES[3]!].map((value) => `GET ${value}`))
		expect(verifiedAt((await w.credentials()).fields)).toEqual([
			null,
			null,
			null,
			shown(start + FIELD_LINK_HOLD_MS + WEB_PAGE_TIMEOUT_MS + REDIRECT_PROBE_TIMEOUT_MS - 2),
		])
		expect((await w.state()).links_due_at).toBeNull()
	})

	it('checks every value once per save when every value is slow and unverified', async () => {
		const w = await world()
		w.setRoutes(slowRoutes(w, VALUES))
		await w.save(fieldsOf(VALUES))
		const start = w.clock.t
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, unchecked: 1, finished: true })
		expect(await w.state()).toMatchObject({
			links_due_at: start + FIELD_LINK_HOLD_MS,
			links_attempts: 0,
			unverified_links: JSON.stringify(VALUES.slice(0, 3)),
		})
		w.clock.t = start + FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, unchecked: 0, finished: true })
		expect(await w.state()).toMatchObject({ links_due_at: null, unverified_links: JSON.stringify(VALUES) })
		w.clock.t = start + 2 * FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: false })
		expect(gets(w)).toEqual([...VALUES, VALUES[3]!].map((value) => `GET ${value}`))
		// A save of the same fields asks for every value again, from the first.
		w.requests.length = 0
		await w.save(fieldsOf(VALUES))
		expect(await w.state()).toMatchObject({ links_due_at: w.clock.t, unverified_links: null })
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, unchecked: 1 })
		expect(gets(w)[0]).toBe(`GET ${VALUES[0]}`)
	})

	// An imported row may hold values the fields no longer do, in either column, up to its bound: each record keeps only
	// the current ones, so every value is still checked once.
	it('checks every value once over imported columns full of values the fields do not hold', async () => {
		const w = await world()
		w.setRoutes(slowRoutes(w, VALUES, [VALUES[3]!]))
		await w.save(fieldsOf(VALUES))
		const gone = Array.from({ length: LOCAL_FIELDS }, (_, i) => `https://gone${i}.example/`)
		await sql(
			w.h.store,
			'UPDATE local_accounts SET verified_links = ?, unverified_links = ? WHERE account_id = ?',
			JSON.stringify(gone.map((value) => [value, '2026-10-01T00:00:00.000Z'])),
			JSON.stringify(gone),
			w.alice
		)
		const start = w.clock.t
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, unchecked: 1, finished: true })
		expect(await w.state()).toMatchObject({
			links_due_at: start + FIELD_LINK_HOLD_MS,
			unverified_links: JSON.stringify(VALUES.slice(0, 3)),
		})
		w.clock.t = start + FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: true, verified: 1, unchecked: 0, finished: true })
		const at = new Date(start + FIELD_LINK_HOLD_MS + WEB_PAGE_TIMEOUT_MS + REDIRECT_PROBE_TIMEOUT_MS - 2).toISOString()
		expect(await w.state()).toMatchObject({
			links_due_at: null,
			verified_links: JSON.stringify([[VALUES[3], at]]),
			unverified_links: JSON.stringify(VALUES.slice(0, 3)),
		})
		w.clock.t = start + 2 * FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: false })
		expect(gets(w)).toEqual([...VALUES, VALUES[3]!].map((value) => `GET ${value}`))
	})

	// Imported entries of current values may be escaped up to the column's bound: a record writes them back canonical,
	// so the append still fits, and no copy of the stored JSON passes the bound.
	it('records a value beside imported entries escaped up to the bound', async () => {
		const base = 'https://a.example/'
		const long = (i: number) => `${base}${'a'.repeat(FIELD_LINK_VALUE_BYTES - base.length - 1)}${i}`
		const values = Array.from({ length: LOCAL_FIELDS }, (_, i) => long(i))
		const utf8 = (text: string) => new TextEncoder().encode(text).length
		// The first `count` letters a of each value written \u0061.
		const escaped = (value: string, count: number) => {
			let left = count
			return JSON.stringify(value).replace(/a/g, (a) => (left-- > 0 ? '\\u0061' : a))
		}
		for (const verified of [true, false]) {
			const w = await world()
			w.setRoutes({ [values[3]!]: verified ? relMe(LINK_BACK) : page('<p>no</p>') })
			await w.save(fieldsOf(values))
			const time = '"2026-10-01T00:00:00.000Z"'
			const entry = (value: string, count: number) =>
				verified ? `[${escaped(value, count)},${time}]` : escaped(value, count)
			const stored = (count: number) =>
				`[${values
					.slice(0, 3)
					.map((value) => entry(value, count))
					.join(',')}]`
			const bound = verified ? VERIFIED_LINKS_BYTES : UNVERIFIED_LINKS_BYTES
			// The most escapes that fit, so a copy of the stored entries with the new one appended passes the bound.
			let count = 0
			while (utf8(stored(count + 1)) <= bound) {
				count++
			}
			const imported = stored(count)
			const appended = verified ? `,["${values[3]}",${time}]` : `,"${values[3]}"`
			expect(utf8(imported), `${verified}`).toBeGreaterThan(bound - 100)
			expect(utf8(imported) + utf8(appended), `${verified}`).toBeGreaterThan(bound)
			await sql(
				w.h.store,
				`UPDATE local_accounts SET ${verified ? 'verified_links' : 'unverified_links'} = ? WHERE account_id = ?`,
				imported,
				w.alice
			)
			expect(await w.round(), `${verified}`).toMatchObject({
				claimed: true,
				verified: verified ? 1 : 0,
				unchecked: 0,
				finished: true,
			})
			const state = await w.state()
			expect(state.links_due_at, `${verified}`).toBeNull()
			expect(verified ? state.verified_links : state.unverified_links, `${verified}`).toBe(
				JSON.stringify(
					verified
						? [
								...values.slice(0, 3).map((value) => [value, JSON.parse(time) as string]),
								[values[3], new Date(w.clock.t).toISOString()],
							]
						: values
				)
			)
			expect(gets(w), `${verified}`).toEqual([`GET ${values[3]}`])
		}
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
		expect(await claim()).toEqual({ kind: 'none', givenUp: 1, expired: 0 })
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
		expect((await w.state()).unverified_links).toBe(JSON.stringify([SITE]))
		// Claim [B] (A's outcome, recorded after the save, holds until the next save); B fails: nothing is pending.
		w.clock.t = NOW + FIELD_LINK_HOLD_MS
		w.setRoutes({ [SITE]: page('<p>no</p>'), [other]: page('<p>no</p>') })
		const claimed = (await w.round()) as { claimed: boolean }
		expect(claimed.claimed).toBe(true)
		expect(await w.state()).toMatchObject({ links_due_at: null, unverified_links: JSON.stringify([SITE, other]) })
		expect(w.requests).toEqual([`GET ${SITE}`, `GET ${other}`])
	})

	it('keeps a value due when a save during the claim clears its negative', async () => {
		const w = await world()
		const [first, second] = VALUES as [string, string]
		const gate = deferred()
		const reached = deferred()
		w.setRoutes({
			[first]: page('<p>no</p>'),
			[second]: async () => {
				reached.resolve()
				await gate.promise
				return page('<p>no</p>')()
			},
		})
		await w.save(fieldsOf([first, second]))
		const running = w.round()
		await reached.promise
		// The first value's negative is recorded; a save of the same fields clears it while the second's GET is held.
		expect((await w.state()).unverified_links).toBe(JSON.stringify([first]))
		w.clock.t += 1000
		await w.save(fieldsOf([first, second]))
		expect((await w.state()).unverified_links).toBeNull()
		gate.resolve()
		expect(await running).toMatchObject({ claimed: true, verified: 0, unchecked: 0, finished: true })
		expect(await w.state()).toMatchObject({
			links_due_at: NOW + FIELD_LINK_HOLD_MS,
			links_attempts: 0,
			unverified_links: JSON.stringify([second]),
		})
		w.clock.t = NOW + FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, unchecked: 0, finished: true })
		expect(w.requests).toEqual([`GET ${first}`, `GET ${second}`, `GET ${first}`])
		expect(await w.state()).toMatchObject({ links_due_at: null, unverified_links: JSON.stringify([second, first]) })
	})

	it('keeps a negative whose reply came late, and checks only the values after it', async () => {
		const w = await world()
		const [first, second] = VALUES as [string, string]
		w.setRoutes({ [first]: page('<p>no</p>'), [second]: page('<p>no</p>') })
		await w.save(fieldsOf([first, second]))
		const committed = deferred()
		const release = deferred()
		const store = new Proxy(w.h.store, {
			get: (target, key) =>
				key === 'recordFieldLink'
					? async (...args: unknown[]) => {
							const result = await (target.recordFieldLink as (...a: unknown[]) => Promise<unknown>)(...args)
							committed.resolve()
							await release.promise
							return result
						}
					: (Reflect.get(target, key) as unknown),
		})
		const running = w.round({}, store)
		await committed.promise
		expect((await w.state()).unverified_links).toBe(JSON.stringify([first]))
		// The reply arrives at the checks' deadline: the round treats the value and the rest as unchecked.
		w.clock.t = NOW + FIELD_LINK_CHECKS_MS
		release.resolve()
		expect(await running).toMatchObject({ claimed: true, verified: 0, unchecked: 2, finished: true })
		expect(w.requests).toEqual([`GET ${first}`])
		expect(await w.state()).toMatchObject({
			links_due_at: NOW + FIELD_LINK_HOLD_MS,
			links_attempts: 0,
			unverified_links: JSON.stringify([first]),
		})
		w.clock.t = NOW + FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, unchecked: 0, finished: true })
		expect(w.requests).toEqual([`GET ${first}`, `GET ${second}`])
		expect(await w.state()).toMatchObject({ links_due_at: null, unverified_links: JSON.stringify([first, second]) })
	})

	it('refuses a negative record that runs after its claim finished, and keeps the value due', async () => {
		const w = await world()
		const reached = deferred()
		const gate = deferred()
		w.setRoutes({
			[SITE]: () => {
				// The GET ends just before the checks' deadline, so the record's wait is given up at once.
				w.clock.t = NOW + FIELD_LINK_CHECKS_MS - 5
				return page('<p>no</p>')()
			},
		})
		await w.save([{ name: 'Site', value: SITE }])
		let delayed: Promise<unknown> | undefined
		const store = new Proxy(w.h.store, {
			get: (target, key) =>
				key === 'recordFieldLink'
					? (...args: unknown[]) => {
							delayed = (async () => {
								reached.resolve()
								await gate.promise
								return (target.recordFieldLink as (...a: unknown[]) => Promise<unknown>)(...args)
							})()
							return delayed
						}
					: (Reflect.get(target, key) as unknown),
		})
		const running = w.round({}, store)
		await reached.promise
		// The round gives the record up and finishes while the record has not reached the Store.
		expect(await running).toMatchObject({ claimed: true, verified: 0, unchecked: 1, finished: true })
		expect(await w.state()).toMatchObject({ links_attempts: 0, links_due_at: NOW + FIELD_LINK_HOLD_MS })
		gate.resolve()
		expect(await delayed).toEqual({ held: false, recorded: false })
		expect(await w.state()).toMatchObject({
			links_attempts: 0,
			links_due_at: NOW + FIELD_LINK_HOLD_MS,
			unverified_links: null,
		})
		w.clock.t = NOW + FIELD_LINK_HOLD_MS
		w.setRoutes({ [SITE]: page('<p>no</p>') })
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, unchecked: 0, finished: true })
		expect(w.requests).toEqual([`GET ${SITE}`, `GET ${SITE}`])
	})

	it('checks after the hold only what a round that died had not recorded', async () => {
		const w = await world()
		const [first, second] = VALUES as [string, string]
		w.setRoutes({ [first]: page('<p>no</p>'), [second]: page('<p>no</p>') })
		await w.save(fieldsOf([first, second]))
		const reached = deferred()
		const gate = deferred()
		let records = 0
		const store = new Proxy(w.h.store, {
			get: (target, key) =>
				key === 'recordFieldLink'
					? async (...args: unknown[]) => {
							if (++records === 2) {
								reached.resolve()
								await gate.promise
								throw new Error('round died')
							}
							return (target.recordFieldLink as (...a: unknown[]) => Promise<unknown>)(...args)
						}
					: (Reflect.get(target, key) as unknown),
		})
		const running = w.round({}, store)
		await reached.promise
		expect(await w.state()).toMatchObject({ links_attempts: 1, unverified_links: JSON.stringify([first]) })
		gate.resolve()
		await expect(running).rejects.toThrow('round died')
		expect(await w.state()).toMatchObject({ links_attempts: 1, links_due_at: NOW + FIELD_LINK_HOLD_MS })
		w.clock.t = NOW + FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: true, verified: 0, unchecked: 0, finished: true })
		expect(w.requests).toEqual([`GET ${first}`, `GET ${second}`, `GET ${second}`])
		expect(await w.state()).toMatchObject({
			links_attempts: 0,
			links_due_at: null,
			unverified_links: JSON.stringify([first, second]),
		})
	})

	it('refuses a negative record of a claim that has finished', async () => {
		const w = await world()
		await w.save([{ name: 'Site', value: SITE }])
		const claim = (await w.op(claimFieldLinks, { now: w.clock.t })) as Extract<FieldLinksClaim, { target: 'local' }>
		const fence = { target: 'local' as const, accountId: w.alice, token: claim.token, epoch: claim.epoch }
		// The fence held for the finish: the record after it is refused by the closed claim alone.
		expect(await w.op(finishFieldLinks, { ...fence, now: w.clock.t })).toEqual({ held: true, pending: true })
		expect(await w.op(recordFieldLink, { ...fence, value: SITE, verified: false, now: w.clock.t })).toEqual({
			held: false,
			recorded: false,
		})
		expect(await w.state()).toMatchObject({ links_attempts: 0, unverified_links: null })
	})

	it('records no negative for a value that is not a candidate, nor for an outcome that is not a boolean', async () => {
		const w = await world()
		await w.save([{ name: 'Site', value: SITE }])
		const claim = (await w.op(claimFieldLinks, { now: w.clock.t })) as Extract<FieldLinksClaim, { target: 'local' }>
		const fence = { target: 'local' as const, accountId: w.alice, token: claim.token, epoch: claim.epoch }
		const record = (value: string, verified: unknown) =>
			w.op(recordFieldLink, { ...fence, value, verified: verified as boolean, now: w.clock.t })
		// A bounded https URL no field holds, then a candidate with an outcome of another type: the fence holds for both.
		expect(await record('https://fresh.example/', false)).toEqual({ held: true, recorded: false })
		expect(await record(SITE, 0)).toEqual({ held: true, recorded: false })
		expect((await w.state()).unverified_links).toBeNull()
		expect(await record(SITE, false)).toEqual({ held: true, recorded: false })
		expect((await w.state()).unverified_links).toBe(JSON.stringify([SITE]))
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

	it('starts no request and follows no redirect once maintenance is entered during a DNS check', async () => {
		for (const redirect of [false, true]) {
			const w = await world()
			const gate = deferred()
			const reached = deferred()
			const target = redirect ? 'https://next.example/' : SITE
			w.setRoutes({ [SITE]: redirect ? moved(target, 302) : relMe(LINK_BACK), [target]: relMe(LINK_BACK) })
			await w.save([{ name: 'Site', value: SITE }])
			const running = w.round({
				loader: {
					fetch: w.deps().loader.fetch,
					checkHost: async (url) => {
						if (url.href === target) {
							reached.resolve()
							await gate.promise
						}
					},
				},
			})
			await reached.promise
			await w.h.store.setMaintenance(BUILD, true)
			gate.resolve()
			// The value is left unchecked; the finish, a write, is refused: the claim stays open.
			await expect(running).rejects.toBeInstanceOf(StoreUnavailableError)
			expect(w.requests, `redirect: ${redirect}`).toEqual(redirect ? [`GET ${SITE}`] : [])
			await w.h.store.setMaintenance(BUILD, false)
			expect(await w.state()).toMatchObject({ links_attempts: 1, verified_links: null })
		}
	})

	it.each([
		['before', 0],
		['after', 1],
		['before the HEAD', 2],
		['after the HEAD', 3],
	])('leaves a value unchecked when a policy RPC fails %s the DNS check', async (_position, failing) => {
		const w = await world()
		const short = 'https://short.example/a'
		w.setRoutes({ [SITE]: page(`<a rel=me href="${short}"></a>`), [short]: moved(LINK_BACK) })
		await w.save([{ name: 'Site', value: SITE }])
		let n = 0
		const store = new Proxy(w.h.store, {
			get: (target, key) =>
				key === 'webHopRefused'
					? (...args: unknown[]) =>
							n++ === failing
								? Promise.reject(new Error('policy unreadable'))
								: (target.webHopRefused as (...a: unknown[]) => Promise<boolean>)(...args)
					: (Reflect.get(target, key) as unknown),
		})
		expect(await w.round({ store: () => store })).toMatchObject({
			claimed: true,
			verified: 0,
			unchecked: 1,
			finished: true,
		})
		expect(w.requests).toEqual(failing < 2 ? [] : [`GET ${SITE}`])
		expect(await w.state()).toMatchObject({ links_due_at: NOW + FIELD_LINK_HOLD_MS, verified_links: null })
		w.clock.t += FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: true, verified: 1 })
	})

	it('discards a late record and finish from an older claim', async () => {
		const w = await world()
		await w.save([{ name: 'Site', value: SITE }])
		type Local = Extract<FieldLinksClaim, { target: 'local' }>
		const old = (await w.op(claimFieldLinks, { now: w.clock.t })) as Local
		w.clock.t += FIELD_LINK_HOLD_MS
		const current = (await w.op(claimFieldLinks, { now: w.clock.t })) as Local
		expect(current.token).toBe(old.token + 1)
		const fence = { target: 'local' as const, accountId: w.alice, token: old.token, epoch: old.epoch }
		for (const verified of [true, false]) {
			expect(await w.op(recordFieldLink, { ...fence, value: SITE, verified, now: w.clock.t }), `${verified}`).toEqual({
				held: false,
				recorded: false,
			})
		}
		expect(await w.op(finishFieldLinks, { ...fence, now: w.clock.t })).toEqual({ held: false, pending: false })
		expect(await w.state()).toMatchObject({ links_attempts: 2, verified_links: null, unverified_links: null })
		// The current claim's fence records the same value.
		const now = { ...fence, token: current.token }
		expect(await w.op(recordFieldLink, { ...now, value: SITE, verified: false, now: w.clock.t })).toEqual({
			held: true,
			recorded: false,
		})
		expect((await w.state()).unverified_links).toBe(JSON.stringify([SITE]))
	})
})

describe('field verification bounds', () => {
	it('derives the scan output and the budgets of a round', () => {
		expect(FIELD_LINK_OUTPUT_MAX_UNITS).toBe(outputMaxUnits({ ...SCAN_LIMITS, links: 0, metas: 0, jsonLd: 0 }))
		expect(FIELD_LINK_OUTPUT_MAX_UNITS).toBe(67_648)
		expect([FIELD_LINK_SUBREQUESTS, FIELD_LINK_STORE_CALLS, FIELD_LINK_ADMISSIONS]).toEqual([60, 20, 20])
		expect(FIELD_LINK_HOLD_MS).toBeGreaterThanOrEqual(2 * FIELD_LINK_ROUND_MS)
		// One value's check at its ceiling fits the checks' window (the load-time assertion's rule).
		expect(WEB_PAGE_TIMEOUT_MS + REDIRECT_PROBE_TIMEOUT_MS).toBe(15_000)
		expect(WEB_PAGE_TIMEOUT_MS + REDIRECT_PROBE_TIMEOUT_MS).toBeLessThan(FIELD_LINK_CHECKS_MS)
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

	// The compressed page is test-node/web-page-fixtures.ts's gzip bomb through workerd's fetch path (decoded there):
	// its rel=me first, then 16 MiB of zeros, read up to the 1 MiB cap.
	const fixtures = (workersEnv as unknown as { WEB_PAGE_FIXTURES: Fetcher }).WEB_PAGE_FIXTURES
	const bomb: Route = async () => {
		const served = await fixtures.fetch(new Request('https://fixtures.example/bomb', { redirect: 'manual' }))
		return new Response(served.body, { status: served.status, headers: served.headers })
	}
	it.each([
		['identity', 'https://actor.example/u/a'],
		['gzip', 'https://actor.example/u/a'],
	])('runs a maximum round within its budget and deadline, %s bodies', { timeout: 60_000 }, async (encoding, head) => {
		const w = await world()
		const values = Array.from({ length: LOCAL_FIELDS }, (_, i) => `https://v${i}.example/`)
		const routes: Record<string, Route> = { [head]: moved('https://kopje.test/@nobody') }
		const filler = 'x'.repeat(WEB_PAGE_BODY_LIMIT)
		for (const value of values) {
			routes[value] = moved(`${value}1`)
			routes[`${value}1`] = moved(`${value}2`)
			routes[`${value}2`] = moved(`${value}3`)
			routes[`${value}3`] = encoding === 'gzip' ? bomb : page(`<a rel=me href="${head}"></a>${filler}`)
		}
		w.setRoutes(routes)
		let dns = 0
		let policy = 0
		const store = w.h.store
		const counting = new Proxy(store, {
			get: (target, key) =>
				key === 'webHopRefused'
					? (...args: unknown[]) => {
							policy++
							return (target.webHopRefused as (...a: unknown[]) => Promise<boolean>)(...args)
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
		expect(Date.now() - started).toBeLessThan(FIELD_LINK_CHECKS_MS)
		expect(result).toMatchObject({ claimed: true, verified: 0, unchecked: 0, finished: true })
		// Every value: four GET hops and a HEAD, each with its DNS check and its domain policy before and after it.
		expect(w.requests).toHaveLength(LOCAL_FIELDS * 5)
		expect(dns * DNS_CHECK_SUBREQUESTS + w.requests.length).toBe(FIELD_LINK_SUBREQUESTS)
		expect(policy).toBe(FIELD_LINK_STORE_CALLS + FIELD_LINK_ADMISSIONS)
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
			now: () => (calls++ < 4 ? w.clock.t : w.clock.t + FIELD_LINK_CHECKS_MS),
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
			now: () => (late ? w.clock.t + FIELD_LINK_CHECKS_MS : w.clock.t),
		})
		await new Promise((resolve) => setTimeout(resolve, 50))
		late = true
		release.resolve()
		expect(await running).toMatchObject({ claimed: true, verified: 0, unchecked: 1, finished: true })
		expect((await w.state()).links_due_at).toBe(NOW + FIELD_LINK_HOLD_MS)
	})

	it('ends the whole round within 60 seconds, its finish included', async () => {
		const w = await world()
		w.setRoutes({ [SITE]: page('<p>no</p>') })
		await w.save([{ name: 'Site', value: SITE }])
		// The checks end just before their deadline; the finish would start at the round's end: it is not started, and
		// the claim stays open, claimed again after its hold.
		let late = false
		const store = new Proxy(w.h.store, {
			get: (target, key) =>
				key === 'recordFieldLink'
					? async (...args: unknown[]) => {
							const result = await (target.recordFieldLink as (...a: unknown[]) => Promise<unknown>)(...args)
							late = true
							return result
						}
					: (Reflect.get(target, key) as unknown),
		})
		const round = fieldLinksRound(w.h.env as unknown as Env, {
			...w.deps({}, () => store),
			now: () => (late ? w.clock.t + FIELD_LINK_ROUND_MS : w.clock.t),
		})
		await expect(round).rejects.toBeInstanceOf(DeadlinePassed)
		expect(await w.state()).toMatchObject({ links_attempts: 1, links_due_at: NOW + FIELD_LINK_HOLD_MS })
		// A claim whose answer arrives past the checks' deadline is not used: no request is sent.
		w.clock.t += FIELD_LINK_HOLD_MS
		let slow = false
		const slowClaim = new Proxy(w.h.store, {
			get: (target, key) =>
				key === 'claimFieldLinks'
					? async (...args: unknown[]) => {
							const result = await (target.claimFieldLinks as (...a: unknown[]) => Promise<unknown>)(...args)
							slow = true
							return result
						}
					: (Reflect.get(target, key) as unknown),
		})
		const requested = w.requests.length
		await expect(
			fieldLinksRound(w.h.env as unknown as Env, {
				...w.deps({}, () => slowClaim),
				now: () => (slow ? w.clock.t + FIELD_LINK_CHECKS_MS : w.clock.t),
			})
		).rejects.toBeInstanceOf(DeadlinePassed)
		expect(w.requests.length).toBe(requested)
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

	// Converted or imported fields (Kopje's writer stores at most four within the limits): presented by one rule
	// (fieldSources), verified and shown verified by their own projection (boundedLocalFieldsSql: five entries are past
	// it), their bytes kept either way.
	it('presents converted or imported fields by the presentation rule, verifies only bounded ones', async () => {
		const w = await world()
		w.setRoutes({ [SITE]: relMe(LINK_BACK) })
		const stamp = JSON.stringify([[SITE, '2026-10-01T00:00:00.000Z']])
		const site = { name: 'Site', value: SITE }
		const short = (i: number) => ({ name: `n${i}`, value: `v${i}` })
		const one = JSON.stringify([site])
		const padded = (bytes: number) => one + ' '.repeat(bytes - new TextEncoder().encode(one).length)
		const at = '2026-10-01T00:00:00.000+00:00'
		for (const [label, fields, shown, claimed] of [
			['padded to exactly LOCAL_FIELDS_BYTES', padded(LOCAL_FIELDS_BYTES), [[SITE, at]], true],
			['valid JSON one byte past LOCAL_FIELDS_BYTES', padded(LOCAL_FIELDS_BYTES + 1), [], false],
			[
				'five short fields',
				JSON.stringify([site, short(1), short(2), short(3), short(4)]),
				[
					[SITE, null],
					['v1', null],
					['v2', null],
					['v3', null],
				],
				false,
			],
			[
				'an over-long name and an over-long value',
				JSON.stringify([
					{ name: 'n'.repeat(256), value: 'x' },
					site,
					{ name: 'y', value: '\u{1F600}'.repeat(256) },
					short(3),
				]),
				[
					[SITE, at],
					['v3', null],
				],
				true,
			],
			// SQLite's json_valid accepts valid JSON followed by a raw NUL and more; JSON.parse does not.
			['a raw NUL after valid JSON', `${one}\u0000junk`, [], false],
		] as const) {
			await sql(
				w.h.store,
				'UPDATE local_accounts SET fields = ?, verified_links = ?, links_due_at = ? WHERE account_id = ?',
				fields,
				stamp,
				w.clock.t,
				w.alice
			)
			const pairs = (list: { value: string; verified_at: string | null }[]) => list.map((f) => [f.value, f.verified_at])
			const account = (await w.account()).fields
			expect(
				account.map((f) => [htmlText(f.value), f.verified_at]),
				label
			).toEqual(shown)
			expect(pairs((await w.credentials()).source.fields), label).toEqual(shown)
			await sql(w.h.store, 'UPDATE local_accounts SET verified_links = NULL WHERE account_id = ?', w.alice)
			expect((await w.round()).claimed, label).toBe(claimed)
			expect((await sql<{ fields: string }>(w.h.store, 'SELECT fields FROM local_accounts'))[0]!.fields).toBe(fields)
			w.clock.t += FIELD_LINK_HOLD_MS
		}
	})

	it('records a verification beside an imported verified_links of values the fields do not hold', async () => {
		const w = await world()
		w.setRoutes({ [SITE]: relMe(LINK_BACK) })
		await w.save([{ name: 'Site', value: SITE }])
		// An imported verified_links of four values the fields do not hold, within its bound: the record keeps none.
		const imported = JSON.stringify(
			Array.from({ length: 4 }, (_, i) => [`https://gone${i}.example/`, '2026-10-01T00:00:00.000Z'])
		)
		expect(new TextEncoder().encode(imported).length).toBeLessThanOrEqual(VERIFIED_LINKS_BYTES)
		await sql(w.h.store, 'UPDATE local_accounts SET verified_links = ? WHERE account_id = ?', imported, w.alice)
		expect(await w.round()).toMatchObject({ claimed: true, verified: 1, finished: true })
		expect(await w.state()).toMatchObject({
			links_due_at: null,
			verified_links: JSON.stringify([[SITE, new Date(NOW).toISOString()]]),
		})
		w.clock.t += 10 * FIELD_LINK_HOLD_MS
		expect(await w.round()).toMatchObject({ claimed: false })
		expect(w.requests).toEqual([`GET ${SITE}`])
	})

	it('drops a verification that would pass the stored bound, and never fails the write', async () => {
		const w = await world()
		await w.save([{ name: 'Site', value: SITE }])
		const claim = (await w.op(claimFieldLinks, { now: w.clock.t })) as Extract<FieldLinksClaim, { target: 'local' }>
		const fence = { target: 'local' as const, accountId: w.alice, token: claim.token, epoch: claim.epoch }
		// A time past year 9999 has no 24-byte ISO form (isoTimeSql): the trigger would refuse it, the writer drops it.
		const late = Date.UTC(10_000, 0, 1)
		expect(new Date(late).toISOString()).toBe('+010000-01-01T00:00:00.000Z')
		expect(await w.op(recordFieldLink, { ...fence, value: SITE, verified: true, now: late })).toEqual({
			held: true,
			recorded: false,
		})
		expect((await w.state()).verified_links).toBeNull()
		expect(await w.op(recordFieldLink, { ...fence, value: SITE, verified: true, now: w.clock.t })).toEqual({
			held: true,
			recorded: true,
		})
	})

	it('skips, without rewriting, a row whose epoch or username is outside its bound', async () => {
		const w = await world()
		await w.save([{ name: 'Site', value: SITE }])
		const claim = () => w.op(claimFieldLinks, { now: w.clock.t })
		await sql(w.h.store, "UPDATE local_accounts SET credential_epoch = 'x' WHERE account_id = ?", w.alice)
		expect(await claim()).toEqual({ kind: 'none', givenUp: 0, expired: 0 })
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
		expect(await claim()).toEqual({ kind: 'none', givenUp: 0, expired: 0 })
		expect((await w.state()).links_claim).toBe(2 ** 53 - 1)
		await sql(
			w.h.store,
			'UPDATE local_accounts SET links_claim = 0, links_due_at = ?, links_hold_until = NULL WHERE account_id = ?',
			w.clock.t,
			w.alice
		)
		// A space outside the format, and raw NULs that GLOB stops at and the projection would cut to another name.
		for (const username of ['al ice', 'alice\u0000evil', '\u0000evil']) {
			await sql(w.h.store, 'UPDATE accounts SET username = ? WHERE id = ?', username, w.alice)
			await sql(w.h.store, 'UPDATE local_accounts SET links_due_at = ? WHERE account_id = ?', w.clock.t, w.alice)
			expect(await claim(), JSON.stringify(username)).toEqual({ kind: 'none', givenUp: 0, expired: 0 })
			expect(await w.state(), JSON.stringify(username)).toMatchObject({ links_due_at: null, links_claim: 0 })
			expect((await sql(w.h.store, 'SELECT username FROM accounts WHERE id = ?', w.alice))[0]).toEqual({ username })
		}
	})

	it('reads at most FIELD_LINK_CLAIM_WALK due rows a claim, each making progress', async () => {
		const w = await world()
		const total = FIELD_LINK_CLAIM_WALK + 6
		for (let i = 0; i < total; i++) {
			await seedAccount(w.h.store, { username: `u${i}` })
		}
		// Due rows with nothing to verify: each claim disarms the ones it reads.
		await sql(w.h.store, 'UPDATE local_accounts SET links_due_at = ?', w.clock.t)
		// The rows the walk's query returns, counted as SQLite hands them over.
		const claim = () =>
			runInDurableObject(w.h.store, (_instance, s) => {
				let read = 0
				const counted = observedSql(s.storage.sql, (rows, query) => {
					if (query.includes('links_hold_until AS hold')) {
						read += rows.length
					}
				})
				return { result: claimFieldLinks.run(counted, { now: w.clock.t }), read }
			})
		expect(await claim()).toEqual({ result: { kind: 'none', givenUp: 0, expired: 0 }, read: FIELD_LINK_CLAIM_WALK })
		const left = async () =>
			(
				await sql<{ n: number }>(w.h.store, 'SELECT count(*) AS n FROM local_accounts WHERE links_due_at IS NOT NULL')
			)[0]!.n
		expect(await left()).toBe(total + 1 - FIELD_LINK_CLAIM_WALK)
		expect(await claim()).toEqual({
			result: { kind: 'none', givenUp: 0, expired: 0 },
			read: total + 1 - FIELD_LINK_CLAIM_WALK,
		})
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
