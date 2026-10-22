import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import { mastodonActor, type TestActor } from './inbox-helpers'
import {
	announce,
	AS,
	create,
	followed,
	localStatus,
	mastodonNote,
	OTHER,
	type Setup,
	setup,
	statuses,
} from './inbox-status-helpers'
import { quoting } from './quote-helpers'
import { Db } from '../src/db/sql'
import { ACCOUNT_STALE_MS } from '../src/domain/inbox'
import { suspendRemote } from '../src/domain/remote-suspension'

// The author of a boosted original Kopje fetches (VIS-6, NET-4), refetched first when its stored document is a day
// old (ACCOUNT_STALE_MS, Mastodon's possibly_stale?): what each outcome of that refetch stores, and the outcomes that
// commit after another request's. Authors are aged through accounts.fetched_at, so the clock and the sender's key stay
// fresh and t.web.fetched holds only the fetches under test.

const iso = (at: number) => new Date(at).toISOString()
const avatar = (actor: TestActor, n: number) => `${OTHER}/system/avatars/${actor.uri.split('/').at(-1)}-${n}.png`

type AuthorRow = { avatar_url: string | null; fetched_at: string | null; domain: string; username: string }
const author = async (t: Setup, uri: string) =>
	(
		await sql<AuthorRow>(t.store, 'SELECT avatar_url, fetched_at, domain, username FROM accounts WHERE uri = ?', uri)
	)[0]!
const keys = (t: Setup, uri: string) =>
	sql<{ pem: string; fetched_at: number }>(
		t.store,
		'SELECT k.pem, k.fetched_at FROM remote_keys k JOIN accounts a ON a.id = k.account_id WHERE a.uri = ?',
		uri
	)
const age = (t: Setup, uri: string, fetchedAt: string | null) =>
	sql(t.store, 'UPDATE accounts SET fetched_at = ? WHERE uri = ?', fetchedAt, uri)

// erin's document served again with avatar `n` (and the given key and changes).
function reserve(
	t: Setup,
	erin: TestActor,
	n: number,
	options: { key?: number; extra?: Record<string, unknown> } = {}
) {
	return mastodonActor(t.web, 'erin', {
		origin: OTHER,
		key: options.key ?? 3,
		extra: { icon: { type: 'Image', mediaType: 'image/png', url: avatar(erin, n) }, ...options.extra },
	})
}

function served(t: Setup, actor: TestActor, extra: Record<string, unknown> = {}) {
	const note = mastodonNote(actor, extra)
	t.web.serve(note.id, { '@context': AS, ...note })
	return note
}

// bob, followed by alice, and erin on another server, stored by a first boost of hers and aged a day.
async function world() {
	const clock = { now: NOW }
	const t = await setup(clock)
	const bob = await mastodonActor(t.web, 'bob')
	await followed(t, bob)
	const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3 })
	const first = served(t, erin)
	expect(await t.post(bob, announce(bob, first.id))).toBe(202)
	expect(await author(t, erin.uri)).toMatchObject({ fetched_at: iso(NOW) })
	await age(t, erin.uri, iso(NOW - ACCOUNT_STALE_MS))
	t.web.fetched.length = 0
	return { t, bob, erin, clock }
}

const boosted = async (t: Setup, uri: string) => (await statuses(t.store)).some((s) => s.uri === uri)

describe('a stale author of a fetched original (VIS-6, NET-4; Mastodon possibly_stale?)', () => {
	it('refetches a stored author whose document is a day old before storing a boosted original', async () => {
		const { t, bob, erin } = await world()
		await reserve(t, erin, 2)
		const note2 = served(t, erin)
		expect(await t.post(bob, announce(bob, note2.id))).toBe(202)
		expect(t.web.fetched).toEqual([note2.id, erin.uri])
		expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW) })
		const home =
			await t.api<{ reblog: { uri: string; account: { avatar: string } } | null }[]>('/api/v1/timelines/home')
		expect(home.body.find((s) => s.reblog?.uri === note2.id)?.reblog?.account.avatar).toBe(avatar(erin, 2))
	})

	it('uses an author fetched less than a day ago as it is', async () => {
		const { t, bob, erin } = await world()
		await age(t, erin.uri, iso(NOW - ACCOUNT_STALE_MS + 1))
		await reserve(t, erin, 2)
		const note2 = served(t, erin)
		expect(await t.post(bob, announce(bob, note2.id))).toBe(202)
		expect(t.web.fetched).toEqual([note2.id])
		expect(await boosted(t, note2.id)).toBe(true)
		expect((await author(t, erin.uri)).avatar_url).not.toBe(avatar(erin, 2))
	})

	it.each([
		['no fetched_at', null],
		['an unreadable fetched_at', 'now'],
	])('an author with %s is stale', async (_name, fetchedAt) => {
		const { t, bob, erin } = await world()
		await age(t, erin.uri, fetchedAt)
		await reserve(t, erin, 2)
		const note2 = served(t, erin)
		expect(await t.post(bob, announce(bob, note2.id))).toBe(202)
		expect(t.web.fetched).toEqual([note2.id, erin.uri])
		expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW) })
	})

	it.each([404, 410])(
		'a refresh answering %i stores neither the original nor the boost, and leaves fetched_at unchanged',
		async (status) => {
			const { t, bob, erin } = await world()
			const before = await statuses(t.store)
			t.web.fail(erin.uri, status)
			const note2 = served(t, erin)
			expect(await t.post(bob, announce(bob, note2.id))).toBe(202)
			expect(t.web.fetched).toEqual([note2.id, erin.uri])
			expect(await statuses(t.store)).toEqual(before)
			expect((await author(t, erin.uri)).fetched_at).toBe(iso(NOW - ACCOUNT_STALE_MS))
			// Nothing marks the failure: a later boost refetches her.
			await reserve(t, erin, 2)
			const note3 = served(t, erin)
			expect(await t.post(bob, announce(bob, note3.id))).toBe(202)
			expect(t.web.fetched.slice(2)).toEqual([note3.id, erin.uri])
			expect(await boosted(t, note3.id)).toBe(true)
		}
	)

	it.each([
		['unusable', (t: Setup, erin: TestActor) => t.web.serve(erin.uri, { ...erin.document, id: `${erin.uri}/other` })],
		['a 500', (t: Setup, erin: TestActor) => t.web.fail(erin.uri, 500)],
		['a 429', (t: Setup, erin: TestActor) => t.web.fail(erin.uri, 429)],
		['a network failure', (t: Setup, erin: TestActor) => t.web.fail(erin.uri, 0)],
	])(
		'a refresh that is %s stores the boost under the stored profile, stamps fetched_at only, and waits a day',
		async (_name, failure) => {
			const { t, bob, erin } = await world()
			const profile = await author(t, erin.uri)
			await sql(t.store, 'UPDATE remote_keys SET fetched_at = ?', NOW - 1000)
			const stored = await keys(t, erin.uri)
			failure(t, erin)
			const note2 = served(t, erin)
			expect(await t.post(bob, announce(bob, note2.id))).toBe(202)
			expect(t.web.fetched).toEqual([note2.id, erin.uri])
			expect(await boosted(t, note2.id)).toBe(true)
			expect(await author(t, erin.uri)).toEqual({ ...profile, fetched_at: iso(NOW) })
			// Key trust is not extended by the stamp (ID-1).
			expect(await keys(t, erin.uri)).toEqual(stored)
			// Not tried again for a day.
			const note3 = served(t, erin)
			expect(await t.post(bob, announce(bob, note3.id))).toBe(202)
			expect(t.web.fetched.slice(2)).toEqual([note3.id])
			expect(await boosted(t, note3.id)).toBe(true)
		}
	)

	it('an unknown author whose fetch is transient still answers 503', async () => {
		const { t, bob } = await world()
		const frank = await mastodonActor(t.web, 'frank', { origin: OTHER, key: 4 })
		t.web.fail(frank.uri, 500)
		const before = await statuses(t.store)
		const note = served(t, frank)
		expect(await t.post(bob, announce(bob, note.id))).toBe(503)
		expect(await statuses(t.store)).toEqual(before)
		expect(await sql(t.store, 'SELECT 1 AS x FROM accounts WHERE uri = ?', frank.uri)).toEqual([])
	})

	it('never refetches a suspended stale author (R38)', async () => {
		const { t, bob, erin } = await world()
		await suspend(t, erin.uri)
		const before = await statuses(t.store)
		const note2 = served(t, erin)
		expect(await t.post(bob, announce(bob, note2.id))).toBe(202)
		expect(t.web.fetched).toEqual([note2.id])
		expect(await statuses(t.store)).toEqual(before)
	})

	type Change = [string, (t: Setup, erin: TestActor, bob: TestActor) => Promise<unknown>]
	const changes: Change[] = [
		['a suspension', (t, erin) => suspend(t, erin.uri)],
		['a domain block', (t) => blockDomain(t.store, new URL(OTHER).host)],
		[
			"the author's deletion",
			async (t, erin) => {
				t.web.fail(erin.uri, 410)
				const deletion = { '@context': AS, id: `${erin.uri}#delete`, type: 'Delete', actor: erin.uri, object: erin.uri }
				expect(await t.post(erin, deletion)).toBe(202)
			},
		],
	]
	describe.each(changes)('%s committed during the refresh', (_name, change) => {
		it.each([
			['ok', (t: Setup, erin: TestActor) => reserve(t, erin, 2)],
			['500', (t: Setup, erin: TestActor) => Promise.resolve(t.web.fail(erin.uri, 500))],
		])('stores no status and stamps nothing for an outcome %s', async (_outcome, outcome) => {
			const { t, bob, erin } = await world()
			const profile = await author(t, erin.uri)
			const before = await statuses(t.store)
			await outcome(t, erin)
			const refresh = t.web.hold(erin.uri, { snapshot: true })
			const note2 = served(t, erin)
			const response = t.post(bob, announce(bob, note2.id))
			await refresh.reached
			await change(t, erin, bob)
			refresh.release()
			expect(await response).toBe(202)
			// Nothing is added (a deletion also starts removing erin's statuses and row).
			const after = await statuses(t.store)
			expect(after.filter((s) => !before.some((b) => b.uri === s.uri))).toEqual([])
			const row = await sql<AuthorRow>(
				t.store,
				'SELECT avatar_url, fetched_at, domain, username FROM accounts WHERE uri = ?',
				erin.uri
			)
			expect(row.length === 0 ? profile : row[0]).toEqual(profile)
		})
	})

	it('a self-boost of a fetched private status by a sender with a stale row reads the refreshed followers URI', async () => {
		const { t, bob } = await world()
		const followers = `${bob.uri}/followers2`
		await age(t, bob.uri, iso(NOW - ACCOUNT_STALE_MS))
		await mastodonActor(t.web, 'bob', { extra: { followers } })
		const own = served(t, bob, { to: [followers], cc: [] })
		t.web.fetched.length = 0
		expect(await t.post(bob, announce(bob, own.id, { to: [followers], cc: [] }))).toBe(202)
		expect(t.web.fetched).toEqual([own.id, bob.uri])
		const rows = await statuses(t.store)
		expect(rows.find((s) => s.uri === own.id)?.visibility).toBe('private')
	})

	it('a refresh keeps the confirmed domain while the username is unchanged and falls back to the host when it changes', async () => {
		const { t, bob, erin } = await world()
		await sql(
			t.store,
			"UPDATE accounts SET domain = 'erin.example', confirmed_username = 'erin' WHERE uri = ?",
			erin.uri
		)
		const note2 = served(t, erin)
		expect(await t.post(bob, announce(bob, note2.id))).toBe(202)
		expect(await author(t, erin.uri)).toMatchObject({ domain: 'erin.example', username: 'erin', fetched_at: iso(NOW) })
		await age(t, erin.uri, iso(NOW - ACCOUNT_STALE_MS))
		await mastodonActor(t.web, 'erin', { origin: OTHER, key: 3, extra: { preferredUsername: 'erin2' } })
		const note3 = served(t, erin)
		expect(await t.post(bob, announce(bob, note3.id))).toBe(202)
		expect(await author(t, erin.uri)).toMatchObject({ domain: 'other.example', username: 'erin2' })
	})

	it('VIS-6: a private original by a stale author stores no status or boost; the author is refreshed', async () => {
		const { t, bob, erin } = await world()
		const before = await statuses(t.store)
		await reserve(t, erin, 2)
		const note2 = served(t, erin, { to: [`${erin.uri}/followers`], cc: [] })
		expect(await t.post(bob, announce(bob, note2.id))).toBe(202)
		expect(t.web.fetched).toEqual([note2.id, erin.uri])
		expect(await statuses(t.store)).toEqual(before)
		expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW) })
	})
})

async function suspend(t: Setup, uri: string): Promise<void> {
	const id = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', uri))[0]!.id
	await runInDurableObject(t.store, (_instance, state) =>
		state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), id, null, NOW))
	)
}

describe('refreshes of one stale author by two requests (hold)', () => {
	// A's boost reaches its refetch of erin and is held there; B's boost of another note by erin runs meanwhile, at a
	// later clock; A is answered after B committed, at a later clock still.
	async function race(
		between: (t: Setup, erin: TestActor) => Promise<unknown>,
		options: { snapshot?: boolean; beforeB?: (t: Setup, erin: TestActor) => unknown } = {}
	) {
		const { t, bob, erin, clock } = await world()
		const noteA = served(t, erin)
		const noteB = served(t, erin)
		const held = t.web.hold(erin.uri, { snapshot: options.snapshot === true })
		const a = t.post(bob, announce(bob, noteA.id))
		await held.reached
		await options.beforeB?.(t, erin)
		clock.now = NOW + 1
		expect(await t.post(bob, announce(bob, noteB.id))).toBe(202)
		await between(t, erin)
		clock.now = NOW + 2
		held.release()
		expect(await a).toBe(202)
		return { t, erin, noteA, noteB }
	}

	it('a delayed old document never replaces a refresh another request committed', async () => {
		let erin2: TestActor | undefined
		const { t, erin, noteA, noteB } = await race(() => Promise.resolve(), {
			snapshot: true,
			beforeB: async (t, erin) => {
				erin2 = await reserve(t, erin, 2, { key: 4 })
			},
		})
		expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW + 1) })
		expect((await keys(t, erin.uri)).map((k) => k.pem)).toEqual([erin2!.pem])
		expect(await boosted(t, noteA.id)).toBe(true)
		expect(await boosted(t, noteB.id)).toBe(true)
	})

	it('a failure that commits after a successful refresh stamps nothing', async () => {
		const { t, erin, noteA } = await race((t, erin) => Promise.resolve(t.web.fail(erin.uri, 500)), {
			beforeB: (t, erin) => reserve(t, erin, 2),
		})
		expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW + 1) })
		expect(await boosted(t, noteA.id)).toBe(true)
	})

	it('a 404 that commits after a successful refresh refuses nothing: the status is stored under the refreshed row', async () => {
		const { t, erin, noteA } = await race((t, erin) => Promise.resolve(t.web.fail(erin.uri, 404)), {
			beforeB: (t, erin) => reserve(t, erin, 2),
		})
		expect(await author(t, erin.uri)).toMatchObject({ avatar_url: avatar(erin, 2), fetched_at: iso(NOW + 1) })
		expect(await boosted(t, noteA.id)).toBe(true)
	})

	// A documented limitation (docs/mastodon-deviations.md, Accounts): a 404 or 410 that arrives after another request's
	// failed refetch of the same account finds the row stamped, and is not applied.
	it('a 404 that commits after a failure stamp is not applied: the status is stored under the stored row', async () => {
		let profile: AuthorRow | undefined
		const { t, erin, noteA, noteB } = await race((t, erin) => Promise.resolve(t.web.fail(erin.uri, 404)), {
			beforeB: async (t, erin) => {
				profile = await author(t, erin.uri)
				t.web.fail(erin.uri, 500)
			},
		})
		expect(await author(t, erin.uri)).toEqual({ ...profile!, fetched_at: iso(NOW + 1) })
		expect(await boosted(t, noteA.id)).toBe(true)
		expect(await boosted(t, noteB.id)).toBe(true)
	})
})

describe('statuses stored under their sender (Create, Add, QuoteRequest: no change)', () => {
	it('a Create, an Add pin and a QuoteRequest instrument of a sender with a stale row and a fresh key fetch no actor', async () => {
		const { t, bob } = await world()
		await age(t, bob.uri, iso(NOW - ACCOUNT_STALE_MS))
		const note = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		const pinned = served(t, bob)
		const add = {
			'@context': AS,
			id: `${bob.uri}#add-${pinned.id.split('/').at(-1)}`,
			type: 'Add',
			actor: bob.uri,
			target: `${bob.uri}/collections/featured`,
			object: pinned.id,
		}
		expect(await t.post(bob, add)).toBe(202)
		const mine = await localStatus(t, { status: 'quote me', visibility: 'public' })
		const quote = quoting(bob, mine.uri, null)
		t.web.serve(quote.id, { '@context': AS, ...quote })
		const request = {
			'@context': [AS, { QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest' }],
			id: `${bob.uri}/quote_requests/${quote.id.split('/').at(-1)}`,
			type: 'QuoteRequest',
			actor: bob.uri,
			object: mine.uri,
			instrument: quote.id,
		}
		expect(await t.post(bob, request)).toBe(202)
		expect(t.web.fetched).toEqual([pinned.id, quote.id])
		const uris = (await statuses(t.store)).map((s) => s.uri)
		expect(uris).toEqual(expect.arrayContaining([note.id, pinned.id, quote.id]))
		expect((await author(t, bob.uri)).fetched_at).toBe(iso(NOW - ACCOUNT_STALE_MS))
	})
})
