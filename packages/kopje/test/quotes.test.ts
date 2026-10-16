import { runInDurableObject } from 'cloudflare:test'

import { type DocumentLoader, exportSpki, preloadedContexts, signJsonLd, signObject } from '@fedify/fedify'
import { CryptographicKey, Delete, Multikey, Person } from '@fedify/vocab'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { BUILD } from './helpers'
import {
	LOCAL,
	MASTODON,
	mastodonActor,
	misskeyActor,
	MISSKEY_CONTEXT,
	type RemoteWeb,
	type TestActor,
} from './inbox-helpers'
import {
	ALICE,
	ALICE_URI,
	announce,
	AS,
	create,
	followed,
	localStatus,
	mastodonNote,
	misskeyNote,
	type Note,
	nextId,
	PUBLIC,
	remove,
	type Setup,
	setup,
	statusRow,
	update,
} from './inbox-status-helpers'
import { Db } from '../src/db/sql'
import { PURGE_BATCH, receiveActivity, RETRACTION_TTL_MS, runInboundJobs } from '../src/domain/inbox'
import { QUOTE_BACKOFF_MS, QUOTE_HOPS } from '../src/domain/quotes'
import { verifyQuotes } from '../src/federation/quotes'
import { parseRemoteStatus } from '../src/federation/remote-status'
import { RSA_ALGORITHM } from '../src/security/key-wrap'

// Quotes received from remote servers (Mastodon 4.5's Quote, StatusParser's quote properties, VerifyQuoteService and the
// Delete of a QuoteAuthorization; FEP-044f): stored with every status that names one, verified inline or by the job
// rounds, and revoked by the quoted author's Delete of the stamp, also when another server relays it with the author's
// proof. Nothing is shown to clients yet.

const OTHER = 'https://other.example'
const RELAY = 'https://relay.example'
const QUOTE_CONTEXT = [
	AS,
	{
		QuoteAuthorization: 'https://w3id.org/fep/044f#QuoteAuthorization',
		gts: 'https://gotosocial.org/ns#',
		interactingObject: { '@id': 'gts:interactingObject', '@type': '@id' },
		interactionTarget: { '@id': 'gts:interactionTarget', '@type': '@id' },
	},
]

// JSON-LD contexts as Kopje's own loader serves them: the preloaded ones, nothing fetched.
const contexts: DocumentLoader = (url) => {
	const document = (preloadedContexts as Record<string, unknown>)[url]
	return document === undefined
		? Promise.reject(new Error(`no context ${url}`))
		: Promise.resolve({ document, documentUrl: url, contextUrl: null })
}

type QuoteRow = {
	quoted_uri: string | null
	quoted_status_id: string | null
	state: string
	legacy: number
	approval_uri: string | null
	verify_after: number | null
	attempts: number
	hops: number
	fetch_as: string | null
}

async function quoteOf(t: Setup, uri: string): Promise<QuoteRow | undefined> {
	return (
		await sql<QuoteRow>(
			t.store,
			`SELECT q.quoted_uri, q.quoted_status_id, q.state, q.legacy, q.approval_uri, q.verify_after, q.attempts, q.hops,
				q.fetch_as
			FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?`,
			uri
		)
	)[0]
}

async function quotesCount(t: Setup, uri: string): Promise<number | undefined> {
	return (await sql<{ n: number }>(t.store, 'SELECT quotes_count AS n FROM statuses WHERE uri = ?', uri))[0]?.n
}

// Job rounds as the Queue and cron run them, until no quote's work is due at `now`.
async function rounds(t: Setup, now: number): Promise<number> {
	const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => now }
	let n = 1
	while (await verifyQuotes(t.env, deps)) {
		n++
		expect(n).toBeLessThan(20)
	}
	return n
}

function stampUri(quoted: TestActor): string {
	return `${quoted.uri}/quote_authorizations/${nextId()}`
}

// A stamp as Mastodon's QuoteAuthorizationSerializer renders it, served on the web.
function serveStamp(web: RemoteWeb, uri: string, quoted: TestActor, quoting: string, target: string, extra = {}) {
	web.serve(uri, {
		'@context': QUOTE_CONTEXT,
		type: 'QuoteAuthorization',
		id: uri,
		attributedTo: quoted.uri,
		interactingObject: quoting,
		interactionTarget: target,
		...extra,
	})
}

// A Note quoting `target` as Mastodon 4.5 writes it (quote, _misskey_quote, quoteUri, quoteAuthorization).
function quoting(actor: TestActor, target: string, stamp: string | null, extra: Record<string, unknown> = {}): Note {
	return mastodonNote(actor, {
		quote: target,
		_misskey_quote: target,
		quoteUri: target,
		...(stamp === null ? {} : { quoteAuthorization: stamp }),
		...extra,
	})
}

// bob (followed by alice) and carol, a quoted author on another server.
async function world(clock = { now: NOW }) {
	const t = await setup(clock)
	const bob = await mastodonActor(t.web, 'bob')
	await followed(t, bob)
	const carol = await mastodonActor(t.web, 'carol', { origin: OTHER, key: 2 })
	return { t, bob, carol, clock }
}

// carol's public Note, served (not stored), and bob's quote of it with a valid stamp.
function quotedPair(t: Setup, bob: TestActor, carol: TestActor) {
	const target = mastodonNote(carol)
	t.web.serve(target.id, { '@context': AS, ...target })
	const stamp = stampUri(carol)
	const quote = quoting(bob, target.id, stamp)
	serveStamp(t.web, stamp, carol, quote.id, target.id)
	return { target, stamp, quote }
}

describe('parsing quotes (StatusParser#quote_uri, #legacy_quote?, #deleted_quote?, #quote_approval_uri)', () => {
	const bob = { uri: `${MASTODON}/users/bob` } as TestActor
	const parse = (extra: Record<string, unknown>) => parseRemoteStatus(mastodonNote(bob, extra))!.quote
	const q = 'https://other.example/users/carol/statuses/1'
	const stamp = 'https://other.example/users/carol/quote_authorizations/1'

	it('reads every property form in Mastodon’s order', () => {
		expect(parse({})).toBeNull()
		expect(parse({ quote: q, quoteAuthorization: stamp })).toEqual({
			uri: q,
			legacy: false,
			tombstone: false,
			approvalUri: stamp,
		})
		// An object stands for its id; quote wins over the others.
		expect(parse({ quote: { id: q, type: 'Note' }, _misskey_quote: `${q}x` })).toMatchObject({ uri: q, legacy: false })
		// Misskey's and Fedibird's properties only: a legacy quote.
		for (const key of ['_misskey_quote', 'quoteUrl', 'quoteUri']) {
			expect(parse({ [key]: q })).toEqual({ uri: q, legacy: true, tombstone: false, approvalUri: null })
		}
		expect(parse({ quoteUrl: `${q}a`, _misskey_quote: `${q}b` })?.uri).toBe(`${q}b`)
		// Only http(s): an unusable quote falls through to the next property, and an unusable stamp is dropped.
		expect(parse({ quote: 'ftp://x.example/1', quoteUri: q })).toMatchObject({ uri: q, legacy: false })
		expect(parse({ quote: q, quoteAuthorization: 'did:web:x' })?.approvalUri).toBeNull()
		expect(parse({ quote: q, quoteAuthorization: [stamp, `${stamp}2`] })?.approvalUri).toBe(stamp)
	})

	it('reads a Tombstone as a deleted quote, with or without an id', () => {
		expect(parse({ quote: { type: 'Tombstone' } })).toEqual({
			uri: null,
			legacy: false,
			tombstone: true,
			approvalUri: null,
		})
		expect(parse({ quote: { type: 'Tombstone', id: q } })).toMatchObject({ uri: q, tombstone: true })
		expect(parse({ quote: { type: 'Tombstone' }, _misskey_quote: q, quoteAuthorization: stamp })).toEqual({
			uri: q,
			legacy: false,
			tombstone: true,
			approvalUri: null,
		})
	})
})

describe('storing and verifying a received quote (VerifyQuoteService)', () => {
	it('accepts a quote whose stamp passes every check, inline, fetching the quoted status and its author', async () => {
		const { t, bob, carol } = await world()
		const { target, stamp, quote } = quotedPair(t, bob, carol)
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		const target_ = (await statusRow(t.store, target.id))!
		expect(await quoteOf(t, quote.id)).toMatchObject({
			quoted_uri: target.id,
			quoted_status_id: target_.id,
			state: 'accepted',
			legacy: 0,
			approval_uri: stamp,
			verify_after: null,
		})
		expect(t.web.fetched).toEqual(expect.arrayContaining([target.id, carol.uri, stamp]))
		expect(await quotesCount(t, target.id)).toBe(1)
	})

	it('accepts a self-quote without a stamp, and only once its target is known', async () => {
		const { t, bob } = await world()
		const own = mastodonNote(bob)
		const quote = quoting(bob, own.id, null)
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		// The quoted status is not served: the quote stays pending, its work done.
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'pending', quoted_status_id: null, verify_after: null })
		// Delivered later, it is linked, and the quote verified as a root's.
		expect(await t.post(bob, create(bob, own))).toBe(202)
		await rounds(t, NOW)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
		expect(await quotesCount(t, own.id)).toBe(1)
	})

	type Forgery = [string, (pair: ReturnType<typeof quotedPair>, t: Setup, bob: TestActor, carol: TestActor) => void]
	const forgeries: Forgery[] = [
		['attributed to another actor', (p, t, bob) => serveStamp(t.web, p.stamp, bob, p.quote.id, p.target.id)],
		[
			'on another host than its author',
			(p, t, _bob, carol) => {
				const elsewhere = `https://third.example/stamps/${nextId()}`
				serveStamp(t.web, elsewhere, carol, p.quote.id, p.target.id)
				p.quote.quoteAuthorization = elsewhere
			},
		],
		[
			'naming another quoting status',
			(p, t, _bob, carol) => serveStamp(t.web, p.stamp, carol, `${p.quote.id}0`, p.target.id),
		],
		[
			'naming another quoted status',
			(p, t, _bob, carol) => serveStamp(t.web, p.stamp, carol, p.quote.id, `${p.target.id}0`),
		],
		[
			'of another type',
			(p, t, _bob, carol) => serveStamp(t.web, p.stamp, carol, p.quote.id, p.target.id, { type: 'Note' }),
		],
		[
			'with another id',
			(p, t, _bob, carol) => serveStamp(t.web, p.stamp, carol, p.quote.id, p.target.id, { id: `${p.stamp}0` }),
		],
		[
			'without the ActivityStreams context',
			(p, t, _bob, carol) =>
				serveStamp(t.web, p.stamp, carol, p.quote.id, p.target.id, { '@context': QUOTE_CONTEXT[1] }),
		],
	]

	it.each(forgeries)('leaves a quote pending when its stamp is %s', async (_name, forge) => {
		const { t, bob, carol } = await world()
		const pair = quotedPair(t, bob, carol)
		forge(pair, t, bob, carol)
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending', verify_after: null })
		expect(await quotesCount(t, pair.target.id)).toBe(0)
	})

	it('rejects a quote whose stamp is gone, and retries one that may pass', async () => {
		const clock = { now: NOW }
		const { t, bob, carol } = await world(clock)
		const gone = quotedPair(t, bob, carol)
		t.web.fail(gone.stamp, 410)
		expect(await t.post(bob, create(bob, gone.quote))).toBe(202)
		expect(await quoteOf(t, gone.quote.id)).toMatchObject({ state: 'rejected', verify_after: null })

		const flaky = quotedPair(t, bob, carol)
		const served = t.web.served.get(flaky.stamp)!
		t.web.fail(flaky.stamp, 503)
		expect(await t.post(bob, create(bob, flaky.quote))).toBe(202)
		expect(await quoteOf(t, flaky.quote.id)).toMatchObject({
			state: 'pending',
			attempts: 1,
			verify_after: NOW + QUOTE_BACKOFF_MS[0]!,
		})
		// Not due yet: a round takes nothing. Once due, it is fetched again and accepted.
		t.web.served.set(flaky.stamp, served)
		await rounds(t, NOW + QUOTE_BACKOFF_MS[0]! - 1)
		expect(await quoteOf(t, flaky.quote.id)).toMatchObject({ state: 'pending', attempts: 1 })
		await rounds(t, NOW + QUOTE_BACKOFF_MS[0]!)
		expect(await quoteOf(t, flaky.quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
	})

	it('gives a quote up after five failed attempts until its status arrives again', async () => {
		const { t, bob, carol } = await world()
		const pair = quotedPair(t, bob, carol)
		t.web.fail(pair.stamp, 503)
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		let at = NOW
		for (const delay of QUOTE_BACKOFF_MS) {
			at += delay
			await rounds(t, at)
		}
		// The first try and five retries (Mastodon's RefetchAndVerifyQuoteWorker retries five times).
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({
			state: 'pending',
			attempts: QUOTE_BACKOFF_MS.length + 1,
			verify_after: null,
		})
		// Delivered again (a root), it starts over.
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ attempts: 1, hops: QUOTE_HOPS })
	})

	it('stores a legacy quote (no quote property) pending, and accepts it only as a self-quote', async () => {
		const t = await setup()
		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await followed(t, neko)
		const own = misskeyNote(neko, { _misskey_quote: undefined, quoteUrl: undefined, quoteUri: undefined })
		t.web.serve(own.id, { '@context': MISSKEY_CONTEXT, ...own })
		const self = misskeyNote(neko, { _misskey_quote: own.id, quoteUrl: own.id, quoteUri: own.id })
		expect(await t.post(neko, create(neko, self, MISSKEY_CONTEXT))).toBe(202)
		expect(await quoteOf(t, self.id)).toMatchObject({ state: 'accepted', legacy: 1 })
		const carol = await mastodonActor(t.web, 'carol', { origin: OTHER, key: 2 })
		const other = mastodonNote(carol)
		t.web.serve(other.id, { '@context': AS, ...other })
		const legacy = misskeyNote(neko, { _misskey_quote: other.id, quoteUrl: other.id, quoteUri: other.id })
		expect(await t.post(neko, create(neko, legacy, MISSKEY_CONTEXT))).toBe(202)
		expect(await quoteOf(t, legacy.id)).toMatchObject({ state: 'pending', legacy: 1, verify_after: null })
	})

	it('stores a quote of a Tombstone as deleted, with no work, whether or not it has an id', async () => {
		const { t, bob } = await world()
		const anonymous = mastodonNote(bob, { quote: { type: 'Tombstone' } })
		const named = mastodonNote(bob, { quote: { type: 'Tombstone', id: `${OTHER}/users/carol/statuses/9` } })
		expect(await t.post(bob, create(bob, anonymous))).toBe(202)
		expect(await t.post(bob, create(bob, named))).toBe(202)
		expect(await quoteOf(t, anonymous.id)).toMatchObject({ quoted_uri: null, state: 'deleted', verify_after: null })
		expect(await quoteOf(t, named.id)).toMatchObject({
			quoted_uri: `${OTHER}/users/carol/statuses/9`,
			state: 'deleted',
		})
		expect(t.web.fetched).not.toContain(`${OTHER}/users/carol/statuses/9`)
	})

	it('follows an Update: a new stamp is verified again, a new target starts over, no quote removes it', async () => {
		const { t, bob, carol } = await world()
		const { target, stamp, quote } = quotedPair(t, bob, carol)
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		expect(await quotesCount(t, target.id)).toBe(1)
		// An implicit Update (no newer version) with another stamp: pending again, verified again (gone: rejected).
		const second = stampUri(carol)
		t.web.fail(second, 404)
		expect(
			await t.post(bob, { ...update(bob, { ...quote, quoteAuthorization: second }, ''), id: `${quote.id}#u1` })
		).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ approval_uri: second, state: 'rejected' })
		expect(await quotesCount(t, target.id)).toBe(0)
		// An explicit Update that names no quote removes it.
		const { quote: _q, _misskey_quote: _m, quoteUri: _u, quoteAuthorization: _a, ...plain } = quote
		expect(await t.post(bob, update(bob, plain as Note, '2026-10-11T12:30:00Z'))).toBe(202)
		expect(await quoteOf(t, quote.id)).toBeUndefined()
		expect(stamp).not.toBe(second)
	})

	it('verifies a chain two levels below the status that arrived, however long the chain', async () => {
		async function chain(length: number) {
			const { t, bob, carol } = await world()
			// carol's statuses n-1 ... 0, each quoting the next (self-quotes: no stamps), served; bob quotes the first.
			const notes = Array.from({ length }, () => mastodonNote(carol))
			notes.forEach((note, i) => {
				const next = notes[i + 1]
				const body = next === undefined ? note : { ...note, quote: next.id }
				t.web.serve(note.id, { '@context': AS, ...body })
			})
			const quote = quoting(bob, notes[0]!.id, null)
			expect(await t.post(bob, create(bob, quote))).toBe(202)
			await rounds(t, NOW)
			return t.web.fetched.filter((url) => notes.some((note) => note.id === url)).length
		}
		const short = await chain(3)
		const long = await chain(50)
		expect(short).toBe(2)
		expect(long).toBe(short)
	})
})

describe('durable work on every ingestion path', () => {
	it('records due work with the status, which a round completes if the Worker never verifies inline', async () => {
		const { t, bob, carol } = await world()
		const { target, quote } = quotedPair(t, bob, carol)
		const bobId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', bob.uri))[0]!.id
		// The Store's transaction alone, as a Worker that died after it would leave it.
		const result = await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: LOCAL,
			actorUri: bob.uri,
			actor: null,
			activity: { type: 'Create', id: `${quote.id}/activity`, object: parseRemoteStatus(quote)! },
		})
		expect(result).toMatchObject({ applied: true, verify: expect.any(String) })
		expect(await quoteOf(t, quote.id)).toMatchObject({
			state: 'pending',
			verify_after: NOW,
			hops: QUOTE_HOPS,
			fetch_as: ALICE,
		})
		expect(bobId).toBeDefined()
		await rounds(t, NOW)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
		expect(await quotesCount(t, target.id)).toBe(1)
	})

	it('records work for a boosted original and a search result, and asks for a round', async () => {
		const { t, bob, carol } = await world()
		const pair = quotedPair(t, bob, carol)
		// dave's boost of bob's quote, the original fetched: verified inline with what the request has left.
		const erin = await mastodonActor(t.web, 'erin', { key: 3 })
		await followed(t, erin)
		t.web.serve(pair.quote.id, { '@context': AS, ...pair.quote })
		expect(await t.post(erin, announce(erin, pair.quote.id))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted' })

		// A status resolved by search: stored with due work, and a job round asked for.
		const searched = quotedPair(t, bob, carol)
		t.web.serve(searched.quote.id, { '@context': AS, ...searched.quote })
		const found = await t.api<{ statuses: { uri: string }[] }>(
			`/api/v2/search?q=${encodeURIComponent(searched.quote.id)}&resolve=true&type=statuses`
		)
		expect(found.body.statuses.map((status) => status.uri)).toEqual([searched.quote.id])
		expect(await quoteOf(t, searched.quote.id)).toMatchObject({ state: 'pending', verify_after: NOW })
		expect(t.send).toHaveBeenCalledWith({ kind: 'inbound-jobs' }, expect.anything())
		await rounds(t, NOW)
		expect(await quoteOf(t, searched.quote.id)).toMatchObject({ state: 'accepted' })
	})

	it('verifies a followers-only self-quote with its recipient’s key when the instance actor is refused', async () => {
		const { t, bob } = await world()
		const followers = `${bob.uri}/followers`
		const own = mastodonNote(bob, { to: [followers], cc: [] })
		t.web.serve(own.id, { '@context': AS, ...own })
		t.web.signedOnly.set(own.id, `${ALICE_URI}#main-key`)
		t.web.fail(`${own.id}x`, 404)
		const quote = quoting(bob, own.id, null, { to: [followers], cc: [] })
		// The first fetch fails in a way that may pass: the work stays, with alice (whose inbox received it) to fetch.
		const served = t.web.served.get(own.id)!
		t.web.fail(own.id, 503)
		expect(await t.post(bob, create(bob, quote), { path: '/ap/users/alice/inbox' })).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'pending', attempts: 1, fetch_as: ALICE })
		t.web.served.set(own.id, served)
		t.web.signers.length = 0
		t.web.fetched.length = 0
		await rounds(t, NOW + QUOTE_BACKOFF_MS[0]!)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted' })
		expect(t.web.signers[t.web.fetched.indexOf(own.id)]).toBe(`${ALICE_URI}#main-key`)
	})
})

describe('promotion: a status cached as a quoted target verifies its quote when it arrives as a root', () => {
	// carol's status quotes dan's (both on the other server, with a valid stamp), and is first stored only as the
	// target of bob's quote two levels down, with no work of its own. Each root path then promotes it.
	async function cached() {
		const { t, bob, carol } = await world()
		const dan = await mastodonActor(t.web, 'dan', { origin: OTHER, key: 4 })
		const deep = mastodonNote(dan)
		t.web.serve(deep.id, { '@context': AS, ...deep })
		const middle = quoting(carol, deep.id, null)
		const stamp = stampUri(dan)
		middle.quoteAuthorization = stamp
		serveStamp(t.web, stamp, dan, middle.id, deep.id)
		t.web.serve(middle.id, { '@context': AS, ...middle })
		// bob's quote of middle, stored as a target with one hop: its own quote gets hops 1 and is verified too. Make it
		// hops 0 to stand for a status two levels down.
		const top = quoting(bob, middle.id, null)
		expect(await t.post(bob, create(bob, top))).toBe(202)
		await sql(
			t.store,
			"UPDATE quotes SET state = 'pending', hops = 0, verify_after = NULL WHERE status_id = (SELECT id FROM statuses WHERE uri = ?)",
			middle.id
		)
		await sql(t.store, 'UPDATE statuses SET quotes_count = 0 WHERE uri = ?', deep.id)
		expect(await quoteOf(t, middle.id)).toMatchObject({ state: 'pending', hops: 0, verify_after: null })
		return { t, bob, carol, middle, deep }
	}

	it('on a delivered Create of the known status', async () => {
		const { t, carol, middle } = await cached()
		await followed(t, carol)
		expect(await t.post(carol, create(carol, middle))).toBe(202)
		expect(await quoteOf(t, middle.id)).toMatchObject({ state: 'accepted', hops: QUOTE_HOPS })
	})

	it('on a boost of the cached original', async () => {
		const { t, middle } = await cached()
		const erin = await mastodonActor(t.web, 'erin', { key: 3 })
		await followed(t, erin)
		expect(await t.post(erin, announce(erin, middle.id))).toBe(202)
		expect(await quoteOf(t, middle.id)).toMatchObject({ state: 'accepted', hops: QUOTE_HOPS })
	})

	it.each([
		['the fetched answer', true],
		['the stored status (nothing fetched)', false],
	])('on search resolution through %s', async (_name, served) => {
		const { t, middle } = await cached()
		if (!served) {
			t.web.fail(middle.id, 404)
		}
		const found = await t.api<{ statuses: { uri: string }[] }>(
			`/api/v2/search?q=${encodeURIComponent(middle.id)}&resolve=true&type=statuses`
		)
		expect(found.body.statuses.map((status) => status.uri)).toEqual([middle.id])
		expect(await quoteOf(t, middle.id)).toMatchObject({ verify_after: NOW, hops: QUOTE_HOPS })
		await rounds(t, NOW)
		expect(await quoteOf(t, middle.id)).toMatchObject({ state: 'accepted' })
	})
})

describe('revocation: the Delete of a stamp', () => {
	async function accepted() {
		const w = await world()
		const pair = quotedPair(w.t, w.bob, w.carol)
		expect(await w.t.post(w.bob, create(w.bob, pair.quote))).toBe(202)
		expect(await quoteOf(w.t, pair.quote.id)).toMatchObject({ state: 'accepted' })
		return { ...w, ...pair }
	}

	const revocations = (t: Setup) =>
		sql(t.store, 'SELECT authorization, actor_uri, pending FROM quote_revocations ORDER BY authorization')

	it('revokes an accepted quote once, for good: a repeated Delete adds nothing, a later quote never verifies', async () => {
		const { t, bob, carol, target, stamp, quote, clock } = await accepted()
		expect(await t.post(carol, remove(carol, stamp))).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'revoked', verify_after: null })
		expect(await quotesCount(t, target.id)).toBe(0)
		expect(await revocations(t)).toEqual([{ authorization: stamp, actor_uri: carol.uri, pending: 0 }])
		expect(await t.post(carol, remove(carol, stamp))).toBe(202)
		expect(await revocations(t)).toHaveLength(1)
		// The stamp is still served (as a server that keeps it would): another quote naming it stays pending.
		const again = quoting(bob, target.id, stamp)
		serveStamp(t.web, stamp, carol, again.id, target.id)
		expect(await t.post(bob, create(bob, again))).toBe(202)
		expect(await quoteOf(t, again.id)).toMatchObject({ state: 'pending' })
		expect(t.web.fetched.filter((url) => url === stamp)).toHaveLength(1)
		// Also once the retraction has expired: the revocation is permanent.
		clock.now = NOW + RETRACTION_TTL_MS + 1
		const later = quoting(bob, target.id, stamp)
		serveStamp(t.web, stamp, carol, later.id, target.id)
		expect(await t.post(bob, create(bob, later))).toBe(202)
		expect(await quoteOf(t, later.id)).toMatchObject({ state: 'pending' })
	})

	it('wins over a quote that arrives after it (the retraction)', async () => {
		const { t, bob, carol } = await world()
		const pair = quotedPair(t, bob, carol)
		expect(await t.post(carol, remove(carol, pair.stamp))).toBe(202)
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending' })
		expect(await revocations(t)).toEqual([])
	})

	it('is not taken from anyone but the quoted author', async () => {
		const { t, bob, stamp, quote } = await accepted()
		const mallory = await mastodonActor(t.web, 'mallory', { origin: OTHER, key: 5 })
		await followed(t, mallory)
		expect(await t.post(mallory, remove(mallory, stamp))).toBe(202)
		expect(await t.post(bob, remove(bob, stamp))).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted' })
		expect(await revocations(t)).toEqual([])
	})

	it.each([3, 3000])(
		'processes %i quotes naming the stamp in bounded batches',
		async (count) => {
			const { t, carol, target, stamp } = await accepted()
			const carolId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', carol.uri))[0]!.id
			const targetId = (await statusRow(t.store, target.id))!.id
			// `count` more pending quotes naming the stamp, by bob's server's other accounts.
			await sql(
				t.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('7%017d', i), 'https://mastodon.example/users/bob/statuses/q' || i,
				(SELECT id FROM accounts WHERE uri = ?2), 'public', '', '2026-10-11T12:00:00.000Z' FROM n`,
				count,
				`${MASTODON}/users/bob`
			)
			await sql(
				t.store,
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, approval_uri, updated_at)
			SELECT id, ?1, ?2, ?4, 'pending', ?3, '2026-10-11T12:00:00.000Z' FROM statuses WHERE id GLOB '7*'`,
				target.id,
				targetId,
				stamp,
				carolId
			)
			const deletion = remove(carol, stamp)
			const changes = async (run: (sql: SqlStorage) => unknown) =>
				runInDurableObject(t.store, (_instance, state) => {
					const db = new Db(state.storage.sql)
					const total = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
					const before = total()
					const result = state.storage.transactionSync(() => run(state.storage.sql))
					return { wrote: total() - before, result }
				})
			const request = await changes((sql) =>
				receiveActivity.run(sql, {
					now: NOW,
					origin: LOCAL,
					actorUri: carol.uri,
					actor: null,
					activity: { type: 'Delete', id: deletion.id, object: stamp },
				})
			)
			expect(request.wrote).toBeLessThanOrEqual(PURGE_BATCH)
			let jobRounds = 0
			for (let more = (request.result as { jobsPending: boolean }).jobsPending; more; jobRounds++) {
				const round = await changes((sql) => runInboundJobs.run(sql, { now: NOW }))
				expect(round.wrote).toBeLessThanOrEqual(PURGE_BATCH)
				more = (round.result as { pending: boolean }).pending
				expect(jobRounds).toBeLessThan(count)
			}
			// Each batch takes half its budget in rows (a row and the count trigger it may fire).
			expect(jobRounds).toBe(Math.max(0, Math.ceil((count + 1) / (PURGE_BATCH / 2)) - 1))
			expect(
				await sql(
					t.store,
					'SELECT state, count(*) AS n FROM quotes WHERE approval_uri = ? GROUP BY state ORDER BY state',
					stamp
				)
			).toEqual([
				{ state: 'rejected', n: count },
				{ state: 'revoked', n: 1 },
			])
			expect(await revocations(t)).toEqual([{ authorization: stamp, actor_uri: carol.uri, pending: 0 }])
			expect(carolId).toBeDefined()
		},
		60_000
	)
})

// A server relaying carol's Delete of her stamp (Mastodon forwards it signed with a local sharer's key): dan's.
describe('relayed revocations (ID-1’s one exception)', () => {
	async function relayWorld() {
		const w = await world()
		const pair = quotedPair(w.t, w.bob, w.carol)
		expect(await w.t.post(w.bob, create(w.bob, pair.quote))).toBe(202)
		const dan = await mastodonActor(w.t.web, 'dan', { origin: RELAY, key: 6 })
		return { ...w, ...pair, dan }
	}

	function deletion(actor: TestActor, object: string) {
		return {
			'@context': [AS, 'https://w3id.org/security/v1'],
			id: `${actor.uri}#delete-${nextId()}`,
			type: 'Delete',
			actor: actor.uri,
			to: [PUBLIC],
			object,
		}
	}

	// An RsaSignature2017 as Mastodon's always_sign writes it, by `signer`'s key under `keyId`.
	function ldSigned(json: Record<string, unknown>, signer: TestActor, keyId = signer.keyId) {
		return signJsonLd(json, signer.privateKey, new URL(keyId), { contextLoader: contexts }) as Promise<
			Record<string, unknown>
		>
	}

	it('applies the author’s LD-signed Delete as the author’s', async () => {
		const { t, carol, dan, stamp, quote, target } = await relayWorld()
		const signed = await ldSigned(deletion(carol, stamp), carol)
		expect(await t.post(dan, signed)).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'revoked' })
		expect(await quotesCount(t, target.id)).toBe(0)
	})

	it.each([
		['a forged signature (another key under the author’s key id)', 'forged'],
		['a proof by another actor’s key', 'other'],
		['a proof covering another object', 'tampered'],
	])('refuses %s', async (_name, kind) => {
		const { t, carol, dan, stamp, quote } = await relayWorld()
		let body: Record<string, unknown>
		if (kind === 'forged') {
			body = await ldSigned(deletion(carol, stamp), { ...carol, privateKey: dan.privateKey })
		} else if (kind === 'other') {
			body = await ldSigned(deletion(carol, stamp), dan)
		} else {
			body = { ...(await ldSigned(deletion(carol, `${stamp}0`), carol)), object: stamp }
		}
		expect(await t.post(dan, body)).toBe(401)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted' })
	})

	it('refuses an author proof on any other activity, and applies none to a status', async () => {
		const { t, carol, dan, target } = await relayWorld()
		const boost = await ldSigned({ ...deletion(carol, target.id), type: 'Announce' }, carol)
		expect(await t.post(dan, boost)).toBe(401)
		// carol's Delete of her status, relayed with her proof: not a stamp, so nothing happens to the status.
		const statusDelete = await ldSigned(deletion(carol, target.id), carol)
		expect(await t.post(dan, statusDelete)).toBe(202)
		expect(await statusRow(t.store, target.id)).toBeDefined()
	})

	it('without a proof, only verifies the quote again: kept while the stamp holds, revoked once it is gone', async () => {
		const { t, carol, dan, stamp, quote } = await relayWorld()
		expect(await t.post(dan, deletion(carol, stamp))).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
		expect(await sql(t.store, 'SELECT count(*) AS n FROM quote_revocations')).toEqual([{ n: 0 }])
		t.web.fail(stamp, 404)
		expect(await t.post(dan, deletion(carol, stamp))).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'revoked' })
	})

	it('applies the author’s FEP-8b32 proof', async () => {
		const { t, bob, dan } = await relayWorld()
		// erin, whose document carries an Ed25519 assertion method (Multikey), quoted by bob with a stamp.
		const rsa = (await crypto.subtle.generateKey(
			{ ...RSA_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
			true,
			['sign', 'verify']
		)) as CryptoKeyPair
		const ed = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
		const uri = `${OTHER}/users/erin`
		const person = new Person({
			id: new URL(uri),
			preferredUsername: 'erin',
			inbox: new URL(`${uri}/inbox`),
			publicKey: new CryptographicKey({
				id: new URL(`${uri}#main-key`),
				owner: new URL(uri),
				publicKey: rsa.publicKey,
			}),
			assertionMethods: [
				new Multikey({ id: new URL(`${uri}#ed25519-key`), controller: new URL(uri), publicKey: ed.publicKey }),
			],
		})
		const document = await person.toJsonLd({ format: 'compact', contextLoader: contexts })
		t.web.serve(uri, document)
		const erin: TestActor = {
			uri,
			keyId: `${uri}#main-key`,
			privateKey: rsa.privateKey,
			pem: await exportSpki(rsa.publicKey),
			document: document as Record<string, unknown>,
		}
		const pair = quotedPair(t, bob, erin)
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted' })
		const unsigned = new Delete({
			id: new URL(`${uri}#delete-${nextId()}`),
			actor: new URL(uri),
			object: new URL(pair.stamp),
		})
		const signed = await signObject(unsigned, ed.privateKey, new URL(`${uri}#ed25519-key`), {
			contextLoader: contexts,
			documentLoader: contexts,
		})
		const json = (await signed.toJsonLd({ format: 'compact', contextLoader: contexts })) as Record<string, unknown>
		// Tampered, it is refused; as signed, applied.
		expect(await t.post(dan, { ...json, object: `${pair.stamp}0` })).toBe(401)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted' })
		expect(await t.post(dan, json)).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'revoked' })
	})
})

describe('deleting a quoted or quoting status', () => {
	it('detaches the quotes of a remote status its author deletes, and removes its own', async () => {
		const { t, bob, carol } = await world()
		const { target, quote } = quotedPair(t, bob, carol)
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		await followed(t, carol)
		expect(await t.post(carol, remove(carol, target.id))).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ quoted_status_id: null, state: 'deleted', verify_after: null })
		// bob deletes his quote: its row goes with it.
		expect(await t.post(bob, remove(bob, quote.id))).toBe(202)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM quotes')).toEqual([{ n: 0 }])
	})

	it('detaches the quotes of a local status deleted by its author, and uncounts a quote it made', async () => {
		const { t, bob } = await world()
		const mine = await localStatus(t, { status: 'quotable', visibility: 'public' })
		const theirs = mastodonNote(bob)
		expect(await t.post(bob, create(bob, theirs))).toBe(202)
		// bob's accepted quote of alice's status (as a later PR's QuoteRequest would accept it), and a pending one; and
		// alice's status quoting bob's (as a later PR's authoring would write it), accepted.
		const accepted = quoting(bob, mine.uri, null)
		const pending = quoting(bob, mine.uri, null)
		expect(await t.post(bob, create(bob, accepted))).toBe(202)
		expect(await t.post(bob, create(bob, pending))).toBe(202)
		await sql(
			t.store,
			"UPDATE quotes SET state = 'accepted' WHERE status_id = (SELECT id FROM statuses WHERE uri = ?)",
			accepted.id
		)
		await sql(
			t.store,
			`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
			SELECT ?1, uri, id, account_id, 'accepted', '2026-10-12T00:00:00.000Z' FROM statuses WHERE uri = ?2`,
			mine.id,
			theirs.id
		)
		expect(await quotesCount(t, mine.uri)).toBe(1)
		expect(await quotesCount(t, theirs.id)).toBe(1)
		const deleted = await t.request(`/api/v1/statuses/${mine.id}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${t.tokens.alice}` },
		})
		expect(deleted.status).toBe(200)
		expect(await quoteOf(t, accepted.id)).toMatchObject({
			quoted_status_id: null,
			state: 'deleted',
			verify_after: null,
		})
		expect(await quoteOf(t, pending.id)).toMatchObject({ quoted_status_id: null, state: 'pending', verify_after: null })
		expect(await quotesCount(t, theirs.id)).toBe(0)
	})
})

describe('local Notes', () => {
	it('advertise that nobody but their author may quote them', async () => {
		const t = await setup()
		const mine = await localStatus(t, { status: 'mine', visibility: 'public' })
		const response = await t.request(new URL(mine.uri).pathname, { headers: { accept: 'application/activity+json' } })
		const note = (await response.json()) as Record<string, unknown>
		expect(note.interactionPolicy).toEqual({ canQuote: { automaticApproval: [ALICE_URI] } })
		expect(JSON.stringify(note['@context'])).toContain('gts:canQuote')
		expect(ALICE).toBeDefined()
	})
})
