import { runInDurableObject } from 'cloudflare:test'

import { exportSpki, signJsonLd, signObject } from '@fedify/fedify'
import { CryptographicKey, Delete, Multikey, Person } from '@fedify/vocab'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { BUILD } from './helpers'
import {
	actorDefaults,
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
import { contexts, deferred, QUOTE_CONTEXT, quoting, serveStamp } from './quote-helpers'
import { Db } from '../src/db/sql'
import { ACCOUNT_STALE_MS, PURGE_BATCH, receiveActivity, RETRACTION_TTL_MS, runInboundJobs } from '../src/domain/inbox'
import {
	MAX_LINKED_QUOTES,
	QUOTE_BACKOFF_MS,
	QUOTE_HOPS,
	QUOTE_LEASE_MS,
	QUOTE_ROUND,
	QUOTE_STAGES,
	type QuoteVerification,
	type QuoteWork,
} from '../src/domain/quotes'
import { syncCollections } from '../src/federation/collections'
import { REQUEST_DEADLINE_MS } from '../src/federation/loader'
import { verifyQuotes } from '../src/federation/quotes'
import { parseRemoteStatus } from '../src/federation/remote-status'
import { StoreUnavailableError } from '../src/platform/store-errors'
import { RSA_ALGORITHM } from '../src/security/key-wrap'

// Quotes received from remote servers (Mastodon 4.5's Quote, StatusParser's quote properties, VerifyQuoteService and the
// Delete of a QuoteAuthorization; FEP-044f): stored with every status that names one, verified inline or by the job
// rounds, and revoked by the quoted author's Delete of the stamp, also when another server relays it with the author's
// proof. What clients are shown of them is test/quotes-api.test.ts.

const OTHER = 'https://other.example'
const RELAY = 'https://relay.example'

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

// The app, where each inbox request is followed by the job rounds it asks the Queue for (only rounds verify quotes);
// postOnly posts without them.
async function settled(clock = { now: NOW }) {
	const t = await setup(clock)
	const postOnly = t.post
	const post = async (...args: Parameters<typeof postOnly>) => {
		const status = await postOnly(...args)
		await rounds(t, clock.now)
		return status
	}
	return Object.assign(t, { post, postOnly })
}

// bob (followed by alice) and carol, a quoted author on another server.
async function world(clock = { now: NOW }) {
	const t = await settled(clock)
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
			embedded: null,
		})
		// An object stands for its id; quote wins over the others.
		expect(parse({ quote: { id: q, type: 'Note' }, _misskey_quote: `${q}x` })).toMatchObject({ uri: q, legacy: false })
		// Misskey's and Fedibird's properties only: a legacy quote.
		for (const key of ['_misskey_quote', 'quoteUrl', 'quoteUri']) {
			expect(parse({ [key]: q })).toEqual({ uri: q, legacy: true, tombstone: false, approvalUri: null, embedded: null })
		}
		expect(parse({ quoteUrl: `${q}a`, _misskey_quote: `${q}b` })?.uri).toBe(`${q}b`)
		// Only http(s): an unusable quote falls through to the next property, and an unusable stamp is dropped.
		expect(parse({ quote: 'ftp://x.example/1', quoteUri: q })).toMatchObject({ uri: q, legacy: false })
		expect(parse({ quote: q, quoteAuthorization: 'did:web:x' })?.approvalUri).toBeNull()
		expect(parse({ quote: q, quoteAuthorization: [stamp, `${stamp}2`] })?.approvalUri).toBe(stamp)
	})

	it('keeps an embedded quoted Note one level deep, and nothing else embedded', () => {
		const carol = { uri: 'https://other.example/users/carol' } as TestActor
		const inner = mastodonNote(carol, { id: q, quote: { ...mastodonNote(carol), id: `${q}/deeper` } })
		const read = parse({ quote: inner })
		expect(read).toMatchObject({ uri: q, embedded: { uri: q, attributedTo: carol.uri } })
		// The embedded Note's own embedded quote is not kept: one level only.
		expect(read?.embedded?.quote).toMatchObject({ uri: `${q}/deeper`, embedded: null })
		// A Link or an id is no embedded Note.
		expect(parse({ quote: { type: 'Link', href: q, id: q } })?.embedded).toBeNull()
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
		// The inbox request only records the work; the round it asks for charges the failure.
		expect(await t.postOnly(bob, create(bob, flaky.quote))).toBe(202)
		expect(await quoteOf(t, flaky.quote.id)).toMatchObject({ state: 'pending', attempts: 0, verify_after: NOW })
		expect(await rounds(t, NOW)).toBe(1)
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
		// The round after the inbox request is the first try; five retries follow.
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
		expect(await t.postOnly(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ attempts: 0, verify_after: NOW, hops: QUOTE_HOPS })
	})

	it('stores a legacy quote (no quote property) pending, and accepts it only as a self-quote', async () => {
		const t = await settled()
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
			return new Set(t.web.fetched.filter((url) => notes.some((note) => note.id === url))).size
		}
		const short = await chain(3)
		const long = await chain(50)
		expect(short).toBe(2)
		expect(long).toBe(short)
	})
})

describe('durable work on every ingestion path', () => {
	it('leaves an inbox Create’s quote due and asks for a round, which verifies it', async () => {
		const { t, bob, carol } = await world()
		const { target, quote } = quotedPair(t, bob, carol)
		// The Store's part: the work is recorded with the status, and a job round asked for.
		const result = await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: LOCAL,
			actorUri: bob.uri,
			actor: null,
			activity: { type: 'Create', id: `${quote.id}/activity`, object: parseRemoteStatus(quote)! },
		})
		expect(result).toMatchObject({ applied: true, jobsPending: true })
		expect(await quoteOf(t, quote.id)).toMatchObject({
			state: 'pending',
			verify_after: NOW,
			hops: QUOTE_HOPS,
			fetch_as: ALICE,
		})
		// Through the inbox: nothing is fetched for the quote in the request; the Queue is asked for a round.
		const other = quotedPair(t, bob, carol)
		t.send.mockClear()
		t.web.fetched.length = 0
		expect(await t.postOnly(bob, create(bob, other.quote))).toBe(202)
		expect(t.web.fetched).not.toContain(other.stamp)
		expect(await quoteOf(t, other.quote.id)).toMatchObject({ state: 'pending', verify_after: NOW, attempts: 0 })
		expect(t.send).toHaveBeenCalledWith({ kind: 'inbound-jobs' }, expect.anything())
		await rounds(t, NOW)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
		expect(await quoteOf(t, other.quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
		expect(await quotesCount(t, target.id)).toBe(1)
		expect(await quotesCount(t, other.target.id)).toBe(1)
	})

	it('records work for a boosted original and a search result, and asks for a round', async () => {
		const { t, bob, carol } = await world()
		const pair = quotedPair(t, bob, carol)
		// erin's boost of bob's quote, the original fetched: verified by the round the request asks for.
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
		// Received at alice's inbox: the work is due, with alice to fetch it.
		expect(await t.postOnly(bob, create(bob, quote), { path: '/ap/users/alice/inbox' })).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'pending', verify_after: NOW, fetch_as: ALICE })
		t.web.signers.length = 0
		t.web.fetched.length = 0
		await rounds(t, NOW)
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

	it('on an Add of the cached status to its author’s featured collection', async () => {
		const { t, carol, middle } = await cached()
		await followed(t, carol)
		const add = {
			'@context': AS,
			id: `${carol.uri}#add-${nextId()}`,
			type: 'Add',
			actor: carol.uri,
			target: `${carol.uri}/collections/featured`,
			object: middle.id,
		}
		expect(await t.post(carol, add)).toBe(202)
		expect(await quoteOf(t, middle.id)).toMatchObject({ state: 'accepted', hops: QUOTE_HOPS })
	})

	it('on a sync of its author’s featured collection that lists the cached status', async () => {
		const { t, carol, middle } = await cached()
		await followed(t, carol)
		t.web.serve(`${carol.uri}/collections/featured`, {
			'@context': AS,
			id: `${carol.uri}/collections/featured`,
			type: 'OrderedCollection',
			orderedItems: [middle.id],
		})
		const deps = inboxDeps(() => t.store, t.web.loader)
		for (let round = 0; round < 5 && (await syncCollections(t.env, deps)); round++) {
			// Another phase waits.
		}
		expect(await sql(t.store, 'SELECT count(*) AS n FROM status_pins')).toEqual([{ n: 1 }])
		expect(await quoteOf(t, middle.id)).toMatchObject({ verify_after: NOW, hops: QUOTE_HOPS })
		await rounds(t, NOW)
		expect(await quoteOf(t, middle.id)).toMatchObject({ state: 'accepted' })
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
					storeNow: NOW,
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

describe('review round 1 regressions', () => {
	// A redirect chain of `hops` same-origin hops ending at `document`, served at `uri`.
	function redirected(web: RemoteWeb, uri: string, document: unknown, hops: number) {
		for (let i = 0; i < hops; i++) {
			web.redirect(i === 0 ? uri : `${uri}/r${i}`, `${uri}/r${i + 1}`)
		}
		web.serve(`${uri}/r${hops}`, document)
	}

	it('keys a revocation by the author: another actor’s Delete of the same stamp URI revokes nothing of theirs', async () => {
		const { t, bob, carol } = await world()
		const mallory = await mastodonActor(t.web, 'mallory', { origin: OTHER, key: 5 })
		await followed(t, mallory)
		const pair = quotedPair(t, bob, carol)
		// Before the legitimate quote: mallory self-quotes naming carol's stamp URI, then deletes that URI.
		const own = mastodonNote(mallory)
		expect(await t.post(mallory, create(mallory, own))).toBe(202)
		const poison = quoting(mallory, own.id, pair.stamp)
		expect(await t.post(mallory, create(mallory, poison))).toBe(202)
		expect(await t.post(mallory, remove(mallory, pair.stamp))).toBe(202)
		expect(await quoteOf(t, poison.id)).toMatchObject({ state: 'revoked' })
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted' })
		// After it: poisoned again (a second self-quote), then checked again through an unproven relay of carol's
		// Delete, while carol's stamp still holds: still accepted.
		const again = quoting(mallory, own.id, pair.stamp)
		expect(await t.post(mallory, create(mallory, again))).toBe(202)
		expect(await t.post(mallory, remove(mallory, pair.stamp))).toBe(202)
		const dan = await mastodonActor(t.web, 'dan', { origin: RELAY, key: 6 })
		const relay = {
			'@context': AS,
			id: `${carol.uri}#delete-${nextId()}`,
			type: 'Delete',
			actor: carol.uri,
			object: pair.stamp,
		}
		expect(await t.post(dan, relay)).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
		expect(await quotesCount(t, pair.target.id)).toBe(1)
	})

	it('makes progress across rounds when the stages need more than a budget, and starves no other quote', async () => {
		const { t, bob } = await world()
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 7 })
		// erin's status and her actor document each behind five redirects (six fetches each), her stamp behind two.
		const target = mastodonNote(erin)
		redirected(t.web, target.id, { '@context': AS, ...target }, 5)
		redirected(t.web, erin.uri, erin.document, 5)
		const stamp = stampUri(erin)
		const heavy = quoting(bob, target.id, stamp)
		redirected(
			t.web,
			stamp,
			{
				'@context': QUOTE_CONTEXT,
				type: 'QuoteAuthorization',
				id: stamp,
				attributedTo: erin.uri,
				interactingObject: heavy.id,
				interactionTarget: target.id,
			},
			2
		)
		expect(await t.postOnly(bob, create(bob, heavy))).toBe(202)
		// A healthy self-quote of bob's, due too, behind the heavy one.
		const own = mastodonNote(bob)
		const healthy = quoting(bob, own.id, null)
		t.web.serve(own.id, { '@context': AS, ...own })
		expect(await t.postOnly(bob, create(bob, healthy))).toBe(202)
		const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW }
		// One round, each stage with a whole budget: the heavy quote (due first) is accepted, and the healthy one beside it.
		await verifyQuotes(t.env, deps)
		expect(await quoteOf(t, heavy.id)).toMatchObject({ state: 'accepted', verify_after: null, attempts: 0 })
		expect(await quoteOf(t, healthy.id)).toMatchObject({ state: 'accepted' })
		expect(await quotesCount(t, target.id)).toBe(1)
	})

	it('gives up a stage that never fits a whole budget, asking for no round until the backoff ends', async () => {
		const { t, bob } = await world()
		// erin's document behind five redirects, naming a JSON-LD context behind two: nine fetches, one more than a budget.
		const context = `${OTHER}/contexts/erin.jsonld`
		redirected(t.web, context, { '@context': { pad: `${OTHER}/terms/pad` } }, 2)
		const erin = await mastodonActor(t.web, 'erin', {
			origin: OTHER,
			key: 7,
			extra: { '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1', context] },
		})
		redirected(t.web, erin.uri, erin.document, 5)
		const pair = quotedPair(t, bob, erin)
		expect(await t.postOnly(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ attempts: 0, verify_after: NOW })
		let at = NOW
		const round = () => verifyQuotes(t.env, { ...inboxDeps(() => t.store, t.web.loader), now: () => at })
		// A round that only fails asks for no other: the backoff says when the work is due again.
		expect(await round()).toBe(false)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ attempts: 1, verify_after: NOW + QUOTE_BACKOFF_MS[0]! })
		for (const delay of QUOTE_BACKOFF_MS) {
			at += delay
			expect(await round()).toBe(false)
		}
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({
			state: 'pending',
			attempts: QUOTE_BACKOFF_MS.length + 1,
			verify_after: null,
		})
	})

	it('charges a failing author fetch an attempt, and gives up after the last', async () => {
		const { t, bob } = await world()
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 7 })
		const pair = quotedPair(t, bob, erin)
		t.web.fail(erin.uri, 503)
		// The round after the inbox request is the first try; five retries follow.
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending', attempts: 1 })
		let at = NOW
		for (const delay of QUOTE_BACKOFF_MS) {
			at += delay
			await rounds(t, at)
		}
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({
			state: 'pending',
			attempts: QUOTE_BACKOFF_MS.length + 1,
			verify_after: null,
		})
		expect(await sql(t.store, 'SELECT count(*) AS n FROM quotes WHERE need_author IS NOT NULL')).toEqual([{ n: 0 }])
	})

	it('verifies with the local follower’s key a followers-only self-quote received at the shared inbox', async () => {
		const { t, bob } = await world()
		const followers = `${bob.uri}/followers`
		const own = mastodonNote(bob, { to: [followers], cc: [] })
		t.web.serve(own.id, { '@context': AS, ...own })
		t.web.signedOnly.set(own.id, `${ALICE_URI}#main-key`)
		const quote = quoting(bob, own.id, null, { to: [followers], cc: [] })
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', fetch_as: ALICE })
		expect(t.web.signers[t.web.fetched.indexOf(own.id)]).toBe(`${ALICE_URI}#main-key`)
	})

	it.each([
		['a Tombstone', () => ({ type: 'Tombstone' })],
		['a status Kopje does not have', () => `${OTHER}/users/carol/statuses/unknown`],
	])('takes an accepted quote off its target when an Update replaces it with %s', async (_name, replacement) => {
		const { t, bob, carol } = await world()
		const { target, quote } = quotedPair(t, bob, carol)
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		expect(await quotesCount(t, target.id)).toBe(1)
		const replaced = { ...quote, quote: replacement(), _misskey_quote: undefined, quoteUri: undefined }
		expect(await t.post(bob, update(bob, replaced as Note, '2026-10-11T12:30:00Z'))).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ quoted_status_id: null })
		expect(await quotesCount(t, target.id)).toBe(0)
	})

	it('verifies the quotes past the linking window by their uri', async () => {
		const { t, carol } = await world()
		await followed(t, carol)
		const target = mastodonNote(carol)
		const carolId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', carol.uri))[0]!.id
		// 101 self-quotes of carol's that arrived before the status they quote, their work done for now.
		const count = MAX_LINKED_QUOTES + 1
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('8%017d', i), ?2 || '/q' || i, ?3, 'public', '', '2026-10-11T12:00:00.000Z' FROM n`,
			count,
			`${carol.uri}/statuses`,
			carolId
		)
		await sql(
			t.store,
			`INSERT INTO quotes (status_id, quoted_uri, state, hops, updated_at)
			SELECT id, ?1, 'pending', 2, '2026-10-11T12:00:00.000Z' FROM statuses WHERE id GLOB '8*'`,
			target.id
		)
		t.web.serve(target.id, { '@context': AS, ...target })
		expect(await t.post(carol, create(carol, target))).toBe(202)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM quotes WHERE quoted_status_id IS NULL')).toEqual([{ n: 1 }])
		// The last one's work comes due (its status arriving again, say).
		await sql(t.store, 'UPDATE quotes SET verify_after = ? WHERE quoted_status_id IS NULL', NOW)
		await rounds(t, NOW)
		expect(await sql(t.store, 'SELECT state, count(*) AS n FROM quotes GROUP BY state')).toEqual([
			{ state: 'accepted', n: count },
		])
		expect(await quotesCount(t, target.id)).toBe(count)
	}, 60_000)

	it('stores an embedded quoted Note of the sender’s own, and only that', async () => {
		const { t, bob, carol } = await world()
		const followers = `${bob.uri}/followers`
		// bob's followers-only status, served to nobody, embedded in his quote of it.
		const own = mastodonNote(bob, { to: [followers], cc: [] })
		const quote = quoting(bob, own.id, null, { quote: own, to: [followers], cc: [] })
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		expect(await statusRow(t.store, own.id)).toMatchObject({ visibility: 'private' })
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted' })
		expect(t.web.fetched).not.toContain(own.id)
		// carol's Note embedded in bob's quote is not bob's to vouch for: it is fetched (gone here), never stored.
		const hers = mastodonNote(carol)
		const foreign = quoting(bob, hers.id, null, { quote: hers })
		expect(await t.post(bob, create(bob, foreign))).toBe(202)
		expect(await statusRow(t.store, hers.id)).toBeUndefined()
		expect(await quoteOf(t, foreign.id)).toMatchObject({ state: 'pending', quoted_status_id: null })
		expect(t.web.fetched).toContain(hers.id)
	})

	it('stores a quoted status from a fresh fetch only: a stage never resumes from an old copy', async () => {
		const { t, bob } = await world()
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 7 })
		const pair = quotedPair(t, bob, erin)
		// The status is public when first fetched; its author cannot be fetched yet.
		t.web.fail(erin.uri, 503)
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending', attempts: 1 })
		expect(await sql(t.store, 'SELECT need_author FROM quotes')).toEqual([{ need_author: erin.uri }])
		// Before the next round its server makes it followers-only (and keeps the stamp).
		t.web.serve(erin.uri, erin.document)
		t.web.serve(pair.target.id, { '@context': AS, ...pair.target, to: [`${erin.uri}/followers`], cc: [] })
		await rounds(t, NOW + QUOTE_BACKOFF_MS[0]!)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending', verify_after: null })
		expect(await statusRow(t.store, pair.target.id)).toBeUndefined()
		expect(await quotesCount(t, pair.target.id)).toBeUndefined()
	})

	it('fails only the quote whose stage the Store cannot apply, charged and given up, and verifies the others', async () => {
		const { t, bob, carol } = await world()
		const bad = quotedPair(t, bob, carol)
		const good = quotedPair(t, bob, carol)
		// Both stored with their work due, without inline verification (as a Worker that died would leave them).
		for (const quote of [bad.quote, good.quote]) {
			await t.store.receiveActivity(BUILD, {
				now: NOW,
				origin: LOCAL,
				actorUri: bob.uri,
				actor: null,
				activity: { type: 'Create', id: `${quote.id}/activity`, object: parseRemoteStatus(quote)! },
			})
		}
		const badId = (await statusRow(t.store, bad.quote.id))!.id
		// A Store that cannot apply the bad quote's stage (as a document past the row size limit would make it).
		const stub = t.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
		const failing = new Proxy(t.store, {
			get(_target, key: string) {
				return (...args: unknown[]) =>
					key === 'completeQuote' && (args[1] as { statusId: string }).statusId === badId
						? Promise.reject(new Error('string or blob too big: SQLITE_TOOBIG'))
						: stub[key]!(...args)
			},
		})
		let at = NOW
		const round = () => verifyQuotes(t.env, { ...inboxDeps(() => failing, t.web.loader), now: () => at })
		await round()
		expect(await quoteOf(t, good.quote.id)).toMatchObject({ state: 'accepted' })
		expect(await quoteOf(t, bad.quote.id)).toMatchObject({ state: 'pending', attempts: 1 })
		for (const delay of QUOTE_BACKOFF_MS) {
			at += delay
			await round()
		}
		expect(await quoteOf(t, bad.quote.id)).toMatchObject({
			state: 'pending',
			attempts: QUOTE_BACKOFF_MS.length + 1,
			verify_after: null,
		})
	})

	it('takes an embedded target an Update brings for a quote it does not change', async () => {
		const { t, bob } = await world()
		const followers = `${bob.uri}/followers`
		// A self-quote naming bob's followers-only status by URI: unfetchable, so pending.
		const own = mastodonNote(bob, { to: [followers], cc: [] })
		const quote = quoting(bob, own.id, null, { to: [followers], cc: [] })
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'pending', verify_after: null })
		// A newer Update embeds it, the quote otherwise unchanged.
		expect(await t.post(bob, update(bob, { ...quote, quote: own }, '2026-10-11T12:30:00Z'))).toBe(202)
		expect(await statusRow(t.store, own.id)).toMatchObject({ visibility: 'private' })
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted' })
	})

	it('refetches the quoted status for the stage that stores it, never from the first stage’s fetch', async () => {
		const { t, bob } = await world()
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 7 })
		const pair = quotedPair(t, bob, erin)
		// Stored without inline verification; the round runs every stage. Right after the first fetch of the status, its
		// server makes it followers-only.
		await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: LOCAL,
			actorUri: bob.uri,
			actor: null,
			activity: { type: 'Create', id: `${pair.quote.id}/activity`, object: parseRemoteStatus(pair.quote)! },
		})
		const loader = {
			...t.web.loader,
			fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
				const response = t.web.fetch(input, init)
				const url = new URL(input instanceof Request ? input.url : input.toString())
				if (url.href === pair.target.id) {
					t.web.serve(pair.target.id, { '@context': AS, ...pair.target, to: [`${erin.uri}/followers`], cc: [] })
				}
				return response
			}) as typeof fetch,
		}
		await verifyQuotes(t.env, { ...inboxDeps(() => t.store, loader), now: () => NOW })
		expect(t.web.fetched.filter((url) => url === pair.target.id)).toHaveLength(2)
		expect(await statusRow(t.store, pair.target.id)).toBeUndefined()
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending' })
	})

	// The quote stored with its work due and no inline verification, and the Store's calls a verifier makes.
	async function stored(t: Setup, quote: Note) {
		await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: LOCAL,
			actorUri: quote.attributedTo as string,
			actor: null,
			activity: { type: 'Create', id: `${quote.id}/activity`, object: parseRemoteStatus(quote)! },
		})
		const id = (await statusRow(t.store, quote.id))!.id
		const work = async () => (await t.store.quoteWork(BUILD, { statusId: id, now: NOW }))!
		const complete = async (read: QuoteWork, outcome: Partial<QuoteVerification>) =>
			t.store.completeQuote(BUILD, {
				statusId: id,
				now: NOW,
				origin: LOCAL,
				quotedUri: read.quotedUri,
				approvalUri: read.approvalUri,
				generation: read.generation,
				stage: read.stage,
				fetch: read.fetch,
				...outcome,
			})
		return { id, work, complete }
	}

	it('discards a stage’s outcome once another path moved the stage on, and leaves the new stage due', async () => {
		const { t, bob } = await world()
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 7 })
		const pair = quotedPair(t, bob, erin)
		const { work, complete } = await stored(t, pair.quote)
		await complete(await work(), {
			quoted: { kind: 'ok', value: parseRemoteStatus({ '@context': AS, ...pair.target })! },
		})
		const fetching = await work()
		expect(fetching).toMatchObject({ stage: 'author', fetch: erin.uri })
		// While that verifier fetches erin, another request stores her: the stage is now the quoted status again.
		await sql(
			t.store,
			`INSERT INTO accounts (id, uri, username, domain, fetched_at)
			VALUES ('977000000000000001', ?, 'erin', 'other.example', ?)`,
			erin.uri,
			new Date(NOW).toISOString()
		)
		expect(await work()).toMatchObject({ stage: 'quoted', generation: fetching.generation })
		// Its late 404 for erin is an outcome of a stage the work left: discarded, the work due.
		await complete(fetching, { author: { kind: 'gone' } })
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending', verify_after: NOW, attempts: 0 })
		await rounds(t, NOW)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted' })
	})

	it('redraws the generation when a relayed Delete renews the check: an older fetch’s outcome is discarded', async () => {
		const { t, bob, carol } = await world()
		const pair = quotedPair(t, bob, carol)
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		const id = (await statusRow(t.store, pair.quote.id))!.id
		// A verifier reads the accepted quote's stamp stage (an earlier check), and its fetch is still on its way.
		const old = (await t.store.quoteWork(BUILD, { statusId: id, now: NOW }))!
		expect(old.stage).toBe('stamp')
		// An unproven relay of carol's Delete renews the check; the stamp is gone now.
		await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: LOCAL,
			actorUri: carol.uri,
			actor: null,
			activity: { type: 'RelayedDelete', id: `${carol.uri}#delete-${nextId()}`, object: pair.stamp, proven: false },
		})
		t.web.fail(pair.stamp, 404)
		// The older fetch's valid stamp arrives first: discarded, so the renewed check still runs.
		const stamp = { context: true, types: ['QuoteAuthorization'], id: pair.stamp, attributedTo: carol.uri }
		await t.store.completeQuote(BUILD, {
			statusId: id,
			now: NOW,
			origin: LOCAL,
			quotedUri: old.quotedUri,
			approvalUri: old.approvalUri,
			generation: old.generation,
			stage: old.stage,
			fetch: old.fetch,
			stamp: {
				kind: 'ok',
				value: { ...stamp, interactingObject: pair.quote.id, interactionTarget: pair.target.id },
			},
		})
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted', verify_after: NOW })
		await rounds(t, NOW)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'revoked' })
	})

	it('redraws the generation when a promotion renews the work: an older failure charges nothing', async () => {
		const { t, bob, carol } = await world()
		await followed(t, carol)
		const pair = quotedPair(t, bob, carol)
		const { work, complete } = await stored(t, pair.quote)
		await complete(await work(), {
			quoted: { kind: 'ok', value: parseRemoteStatus({ '@context': AS, ...pair.target })! },
		})
		// A verifier fetches the stamp; the fetch will fail.
		const fetching = await work()
		expect(fetching.stage).toBe('stamp')
		// Meanwhile the quote's status arrives again as a root (the Store's part alone): its work is renewed.
		await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: LOCAL,
			actorUri: bob.uri,
			actor: null,
			activity: { type: 'Create', id: `${pair.quote.id}/activity`, object: parseRemoteStatus(pair.quote)! },
		})
		expect((await work()).generation).not.toBe(fetching.generation)
		// The older fetch's failure arrives late: it charges nothing to the renewed work.
		await complete(fetching, { stamp: { kind: 'transient' } })
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending', attempts: 0, verify_after: NOW })
	})

	it('charges a failed Store stage only to the work and stage it read', async () => {
		const { t, bob } = await world()
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 7 })
		const pair = quotedPair(t, bob, erin)
		const { id, work } = await stored(t, pair.quote)
		const read = await work()
		// An Update replaces the quote before the charge.
		const other = mastodonNote(erin)
		expect(
			await t.post(
				bob,
				update(
					bob,
					{ ...pair.quote, quote: other.id, _misskey_quote: other.id, quoteUri: other.id },
					'2026-10-11T12:30:00Z'
				)
			)
		).toBe(202)
		const before = await quoteOf(t, pair.quote.id)
		await t.store.chargeQuote(BUILD, {
			statusId: id,
			generation: read.generation,
			stage: read.stage,
			fetch: read.fetch,
			now: NOW,
		})
		expect(await quoteOf(t, pair.quote.id)).toEqual(before)
		expect(before).toMatchObject({ quoted_uri: other.id, attempts: 0 })
	})

	it('stops a round on a Store refusal inside a loader, charging nothing', async () => {
		const { t, bob } = await world()
		const followers = `${bob.uri}/followers`
		const own = mastodonNote(bob, { to: [followers], cc: [] })
		t.web.serve(own.id, { '@context': AS, ...own })
		const quote = quoting(bob, own.id, null, { to: [followers], cc: [] })
		// Stored for alice's personal inbox, so alice's key signs its fetches; no inline verification.
		await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: LOCAL,
			actorUri: bob.uri,
			actor: null,
			recipient: 'alice',
			activity: { type: 'Create', id: `${quote.id}/activity`, object: parseRemoteStatus(quote)! },
		})
		expect(await quoteOf(t, quote.id)).toMatchObject({ fetch_as: ALICE, attempts: 0 })
		// The Store refuses the signing key's read (maintenance) but would take the outcome.
		const stub = t.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
		const refusing = new Proxy(t.store, {
			get(_target, key: string) {
				return (...args: unknown[]) =>
					key === 'signingKey' ? Promise.reject(new StoreUnavailableError('maintenance')) : stub[key]!(...args)
			},
		})
		await expect(
			verifyQuotes(t.env, { ...inboxDeps(() => refusing, t.web.loader), now: () => NOW })
		).rejects.toBeInstanceOf(StoreUnavailableError)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'pending', attempts: 0 })
	})

	type Work = {
		verify_after: number | null
		lease_until: number | null
		generation: number
		attempts: number
		recheck: number
	}
	const workOf = async (t: Setup, uri: string) =>
		(
			await sql<Work>(
				t.store,
				`SELECT q.verify_after, q.lease_until, q.generation, q.attempts, q.recheck
				FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?`,
				uri
			)
		)[0]!

	// An accepted quote, and an unproven relay of carol's Delete of its stamp through the inbox (dan relays it).
	async function relayed() {
		const w = await world()
		const pair = quotedPair(w.t, w.bob, w.carol)
		expect(await w.t.post(w.bob, create(w.bob, pair.quote))).toBe(202)
		expect(await quoteOf(w.t, pair.quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
		const dan = await mastodonActor(w.t.web, 'dan', { origin: RELAY, key: 6 })
		const replay = async () =>
			expect(
				await w.t.postOnly(dan, {
					'@context': AS,
					id: `${w.carol.uri}#delete-${nextId()}`,
					type: 'Delete',
					actor: w.carol.uri,
					object: pair.stamp,
				})
			).toBe(202)
		return { ...w, ...pair, replay }
	}

	// A round whose every fetch of the stamp first runs `during` (the work leased), then answers as the web does.
	function roundWith(t: Setup, stamp: string, during: () => Promise<void>, now = NOW) {
		const loader = {
			...t.web.loader,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : input.toString())
				if (url.href === stamp) {
					await during()
				}
				return t.web.fetch(input, init)
			}) as typeof fetch,
		}
		return () => verifyQuotes(t.env, { ...inboxDeps(() => t.store, loader), now: () => now })
	}

	it('coalesces replayed unproven Deletes: a 404 revokes, whatever is replayed during each fetch', async () => {
		const { t, quote, stamp, replay } = await relayed()
		// The first relay renews the idle check.
		await replay()
		const due = await workOf(t, quote.id)
		expect(due).toMatchObject({ verify_after: NOW, attempts: 0, recheck: 0 })
		// Replays while it is due change nothing.
		await replay()
		expect(await workOf(t, quote.id)).toEqual(due)
		// Each round's fetch is preceded by a replay, which leaves the lease, generation and due time as they were and only
		// marks the recheck. The first round's fetch fails in a way that may pass; the second finds the stamp gone.
		let leased: Work | undefined
		const during = async () => {
			const before = await workOf(t, quote.id)
			expect(before.lease_until).not.toBeNull()
			expect(before.verify_after).toBe(before.lease_until)
			await replay()
			const after = await workOf(t, quote.id)
			expect(after).toEqual({ ...before, recheck: 1 })
			leased = after
		}
		t.web.fail(stamp, 503)
		await roundWith(t, stamp, during)()
		// The claim drew a new generation; the replay during the fetch kept it.
		expect(leased?.generation).not.toBe(due.generation)
		expect(await quoteOf(t, quote.id)).toMatchObject({
			state: 'accepted',
			attempts: 1,
			verify_after: NOW + QUOTE_BACKOFF_MS[0]!,
		})
		// Backing off, a replay changes nothing either.
		const backingOff = await workOf(t, quote.id)
		await replay()
		expect(await workOf(t, quote.id)).toEqual(backingOff)
		t.web.fail(stamp, 404)
		await roundWith(t, stamp, during, NOW + QUOTE_BACKOFF_MS[0]!)()
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'revoked', verify_after: null })
	})

	it('checks a valid stamp once more when a relayed Delete raced its leased fetch, and then stops', async () => {
		const { t, quote, stamp, replay } = await relayed()
		await replay()
		let raced = false
		const round = roundWith(t, stamp, async () => {
			if (!raced) {
				raced = true
				const before = await workOf(t, quote.id)
				await replay()
				expect(await workOf(t, quote.id)).toEqual({ ...before, recheck: 1 })
			}
		})
		// The round's fetch finds the stamp valid; the Delete that raced it asks for one more check, due at once.
		expect(await round()).toBe(true)
		expect(raced).toBe(true)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', verify_after: NOW, attempts: 0 })
		expect((await workOf(t, quote.id)).recheck).toBe(0)
		expect(await round()).toBe(false)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
	})

	// A pending quote of carol's (known) status, stored with its work due and no round run yet.
	async function pendingQuote() {
		const w = await world()
		await followed(w.t, w.carol)
		const pair = quotedPair(w.t, w.bob, w.carol)
		expect(await w.t.postOnly(w.bob, create(w.bob, pair.quote))).toBe(202)
		expect(await quoteOf(w.t, pair.quote.id)).toMatchObject({
			state: 'pending',
			quoted_status_id: null,
			verify_after: NOW,
		})
		return { ...w, ...pair }
	}

	it('keeps a round’s lease when its own stage stores the quoted status and links the quote', async () => {
		const { t, quote, stamp } = await pendingQuote()
		let checked = false
		await roundWith(t, stamp, async () => {
			// The round's first stage stored the quoted status, which linked this quote: the lease still holds, and no other
			// round can claim the work.
			expect(await quoteOf(t, quote.id)).toMatchObject({ quoted_status_id: expect.any(String) })
			const work = await workOf(t, quote.id)
			expect(work.lease_until).not.toBeNull()
			expect(work.verify_after).toBe(work.lease_until)
			expect(await t.store.claimQuotes(BUILD, { now: NOW, limit: QUOTE_ROUND })).toMatchObject({ ids: [] })
			checked = true
		})()
		expect(checked).toBe(true)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
	})

	it('discards the late outcome of a round whose lease expired and whose work another round claimed', async () => {
		const { t, quote, stamp } = await pendingQuote()
		const later = NOW + QUOTE_LEASE_MS + 1
		const claimedAgain = deferred()
		const firstDone = deferred()
		let second: Promise<boolean> | undefined
		// The second round claims the work once the first's lease has expired, and its fetch finds the stamp gone, but only
		// after the first round, whose fetch found it valid, has finished.
		const secondRound = roundWith(
			t,
			stamp,
			async () => {
				claimedAgain.resolve()
				await firstDone.promise
				t.web.fail(stamp, 404)
			},
			later
		)
		await roundWith(t, stamp, async () => {
			const before = await workOf(t, quote.id)
			second = secondRound()
			await claimedAgain.promise
			// Claimed again: a new generation and a new lease.
			const after = await workOf(t, quote.id)
			expect(after.generation).not.toBe(before.generation)
			expect(after.lease_until).toBe(later + QUOTE_LEASE_MS)
		})()
		// The first round's valid stamp was for a generation that is gone: nothing changed.
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'pending', verify_after: later + QUOTE_LEASE_MS })
		firstDone.resolve()
		await second
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'rejected', verify_after: null })
	})

	it('checks a pending quote once more when a relayed Delete raced its first stamp fetch', async () => {
		const { t, carol, quote, stamp } = await pendingQuote()
		const dan = await mastodonActor(t.web, 'dan', { origin: RELAY, key: 6 })
		let raced = false
		const round = roundWith(t, stamp, async () => {
			if (raced) {
				return
			}
			raced = true
			const before = await workOf(t, quote.id)
			const relay = {
				'@context': AS,
				id: `${carol.uri}#delete-${nextId()}`,
				type: 'Delete',
				actor: carol.uri,
				object: stamp,
			}
			expect(await t.postOnly(dan, relay)).toBe(202)
			// Leased: the generation, lease and due time are kept; only the recheck is marked.
			expect(await workOf(t, quote.id)).toEqual({ ...before, recheck: 1 })
		})
		// The fetch found the stamp valid: accepted, and checked once more at once.
		expect(await round()).toBe(true)
		expect(raced).toBe(true)
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', verify_after: NOW })
		t.web.fail(stamp, 404)
		await round()
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'revoked', verify_after: null })
	})

	it('concludes two quotes of one claimed batch that name the same target, which the first one stores', async () => {
		const { t, bob, carol } = await world()
		await followed(t, carol)
		const target = mastodonNote(carol)
		t.web.serve(target.id, { '@context': AS, ...target })
		const quotes = [0, 1].map(() => {
			const stamp = stampUri(carol)
			const quote = quoting(bob, target.id, stamp)
			serveStamp(t.web, stamp, carol, quote.id, target.id)
			return quote
		})
		for (const quote of quotes) {
			expect(await t.postOnly(bob, create(bob, quote))).toBe(202)
		}
		// One round claims both; the first stores the target, and the second, held by the same round, is not stranded.
		await verifyQuotes(t.env, { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW })
		for (const quote of quotes) {
			expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
		}
		expect(await quotesCount(t, target.id)).toBe(2)
	})

	it('marks a leased pending quote for a recheck however many idle pending quotes name the stamp', async () => {
		const { t, bob, carol } = await world()
		await followed(t, carol)
		const carolId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', carol.uri))[0]!.id
		const bobId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', bob.uri))[0]!.id
		const pair = quotedPair(t, bob, carol)
		// Before the quote arrives, 150 idle pending quotes of another of carol's statuses name the same stamp.
		await sql(
			t.store,
			`INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			VALUES ('978000000000000000', ?, ?, 'public', '', '2026-10-11T12:00:00.000Z')`,
			`${carol.uri}/statuses/other`,
			carolId
		)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('979%015d', i), ?1 || '/idle' || i, ?2, 'public', '', '2026-10-11T12:00:00.000Z' FROM n`,
			`${bob.uri}/statuses`,
			bobId
		)
		await sql(
			t.store,
			`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, approval_uri, updated_at)
			SELECT id, ?1, '978000000000000000', ?2, 'pending', ?3, '2026-10-11T12:00:00.000Z' FROM statuses WHERE id GLOB '979*'`,
			`${carol.uri}/statuses/other`,
			carolId,
			pair.stamp
		)
		expect(await t.postOnly(bob, create(bob, pair.quote))).toBe(202)
		const dan = await mastodonActor(t.web, 'dan', { origin: RELAY, key: 6 })
		let marked = false
		await roundWith(t, pair.stamp, async () => {
			const relay = {
				'@context': AS,
				id: `${carol.uri}#delete-${nextId()}`,
				type: 'Delete',
				actor: carol.uri,
				object: pair.stamp,
			}
			expect(await t.postOnly(dan, relay)).toBe(202)
			marked = (await workOf(t, pair.quote.id)).recheck === 1
		})()
		expect(marked).toBe(true)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted', verify_after: NOW })
		// The idle ones are left as they were.
		expect(
			await sql(
				t.store,
				"SELECT count(*) AS n FROM quotes WHERE status_id GLOB '979*' AND recheck = 0 AND verify_after IS NULL"
			)
		).toEqual([{ n: 150 }])
	})

	it('marks the second quote of a batch, held with its target found by its uri, when a relayed Delete races its fetch', async () => {
		const { t, bob, carol } = await world()
		await followed(t, carol)
		const target = mastodonNote(carol)
		t.web.serve(target.id, { '@context': AS, ...target })
		const pairs = [0, 1].map(() => {
			const stamp = stampUri(carol)
			const quote = quoting(bob, target.id, stamp)
			serveStamp(t.web, stamp, carol, quote.id, target.id)
			return { stamp, quote }
		})
		for (const { quote } of pairs) {
			expect(await t.postOnly(bob, create(bob, quote))).toBe(202)
		}
		const [, second] = pairs as [unknown, { stamp: string; quote: Note }]
		const dan = await mastodonActor(t.web, 'dan', { origin: RELAY, key: 6 })
		let marked = false
		await roundWith(t, second.stamp, async () => {
			// The first quote stored the target; this one is held by the round, its target not linked yet.
			expect(
				await sql(
					t.store,
					'SELECT quoted_account_id FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?',
					second.quote.id
				)
			).toEqual([{ quoted_account_id: null }])
			const relay = {
				'@context': AS,
				id: `${carol.uri}#delete-${nextId()}`,
				type: 'Delete',
				actor: carol.uri,
				object: second.stamp,
			}
			expect(await t.postOnly(dan, relay)).toBe(202)
			marked = (await workOf(t, second.quote.id)).recheck === 1
		})()
		expect(marked).toBe(true)
		// The valid stamp accepted it, and the raced Delete has it checked once more.
		expect(await quoteOf(t, second.quote.id)).toMatchObject({ state: 'accepted', verify_after: NOW })
	})

	it('rechecks the quote a stamp accepted, not a self-quote that names the same stamp', async () => {
		const { t, bob, carol } = await world()
		await followed(t, carol)
		const pair = quotedPair(t, bob, carol)
		// carol's self-quote names the stamp too (accepted without it), and arrives first.
		const own = mastodonNote(carol)
		expect(await t.post(carol, create(carol, own))).toBe(202)
		const self = quoting(carol, own.id, pair.stamp)
		expect(await t.post(carol, create(carol, self))).toBe(202)
		expect(await quoteOf(t, self.id)).toMatchObject({ state: 'accepted', verify_after: null })
		expect(await t.post(bob, create(bob, pair.quote))).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted', verify_after: null })
		// An unproven relay of carol's Delete renews the check of bob's quote, the one the stamp accepted.
		const dan = await mastodonActor(t.web, 'dan', { origin: RELAY, key: 6 })
		const relay = {
			'@context': AS,
			id: `${carol.uri}#delete-${nextId()}`,
			type: 'Delete',
			actor: carol.uri,
			object: pair.stamp,
		}
		expect(await t.postOnly(dan, relay)).toBe(202)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted', verify_after: NOW })
		expect(await quoteOf(t, self.id)).toMatchObject({ verify_after: null })
	})

	// erin, a quoted author on another server stored by an accepted quote of hers, aged a day; her document served again
	// with a new avatar.
	async function staleQuoted(t: Setup, bob: TestActor) {
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 7 })
		const first = quotedPair(t, bob, erin)
		expect(await t.post(bob, create(bob, first.quote))).toBe(202)
		expect(await quoteOf(t, first.quote.id)).toMatchObject({ state: 'accepted' })
		await sql(
			t.store,
			'UPDATE accounts SET fetched_at = ? WHERE uri = ?',
			new Date(NOW - ACCOUNT_STALE_MS).toISOString(),
			erin.uri
		)
		const avatar = `${OTHER}/system/avatars/erin-2.png`
		await mastodonActor(t.web, 'erin', {
			origin: OTHER,
			key: 7,
			extra: { icon: { type: 'Image', mediaType: 'image/png', url: avatar } },
		})
		t.web.fetched.length = 0
		return { erin, avatar }
	}
	const erinRow = async (t: Setup, uri: string) =>
		(
			await sql<{ avatar_url: string | null; fetched_at: string | null }>(
				t.store,
				'SELECT avatar_url, fetched_at FROM accounts WHERE uri = ?',
				uri
			)
		)[0]!

	// One job round whose quoteWork reads are recorded as stage:fetch.
	async function recordedRound(t: Setup, now = NOW): Promise<string[]> {
		const stages: string[] = []
		const store = t.store
		const spy = new Proxy(store, {
			get(target, property) {
				if (property === 'quoteWork') {
					return async (build: string, input: { statusId: string; now: number }) => {
						const work = await target.quoteWork(build, input)
						stages.push(work === null ? 'none' : `${work.stage}:${work.fetch}`)
						return work
					}
				}
				// The stub's RPC methods are called on the stub itself.
				return (...args: unknown[]) =>
					(target as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>)[property]!(...args)
			},
		})
		await verifyQuotes(t.env, { ...inboxDeps(() => spy, t.web.loader), now: () => now })
		return stages
	}

	it('refreshes a stale quoted author before storing the quoted status', async () => {
		const { t, bob } = await world()
		const { erin, avatar } = await staleQuoted(t, bob)
		const pair = quotedPair(t, bob, erin)
		await stored(t, pair.quote)
		expect(await recordedRound(t)).toEqual([
			`quoted:${pair.target.id}`,
			`author:${erin.uri}`,
			`quoted:${pair.target.id}`,
			`stamp:${pair.stamp}`,
		])
		expect(t.web.fetched).toEqual([pair.target.id, erin.uri, pair.target.id, pair.stamp])
		expect(await erinRow(t, erin.uri)).toEqual({ avatar_url: avatar, fetched_at: new Date(NOW).toISOString() })
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted', attempts: 0 })
		const quote = (await statusRow(t.store, pair.quote.id))!
		const shown = await t.api<{ quote: { quoted_status: { account: { avatar: string } } } }>(
			`/api/v1/statuses/${quote.id}`
		)
		expect(shown.body.quote.quoted_status.account.avatar).toBe(avatar)
	})

	it.each([
		['a 500', (web: RemoteWeb, uri: string) => web.fail(uri, 500)],
		['unusable', (web: RemoteWeb, uri: string) => web.serve(uri, { id: `${uri}/other`, type: 'Person' })],
	])(
		'a stale quoted author’s refresh that is %s stores the status under the stored profile, uncharged',
		async (_name, failure) => {
			const { t, bob } = await world()
			const { erin } = await staleQuoted(t, bob)
			const profile = await erinRow(t, erin.uri)
			failure(t.web, erin.uri)
			const pair = quotedPair(t, bob, erin)
			await stored(t, pair.quote)
			expect(await recordedRound(t)).toContain(`author:${erin.uri}`)
			expect(await erinRow(t, erin.uri)).toEqual({ ...profile, fetched_at: new Date(NOW).toISOString() })
			expect(await statusRow(t.store, pair.target.id)).toBeDefined()
			expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted', attempts: 0 })
		}
	)

	it.each([404, 410])(
		'a stale quoted author’s refresh answering %i leaves the quote pending, its work done, and stamps nothing',
		async (status) => {
			const { t, bob } = await world()
			const { erin } = await staleQuoted(t, bob)
			const profile = await erinRow(t, erin.uri)
			t.web.fail(erin.uri, status)
			const pair = quotedPair(t, bob, erin)
			await stored(t, pair.quote)
			expect(await recordedRound(t)).toEqual([`quoted:${pair.target.id}`, `author:${erin.uri}`])
			expect(await erinRow(t, erin.uri)).toEqual(profile)
			expect(await statusRow(t.store, pair.target.id)).toBeUndefined()
			expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending', attempts: 0, verify_after: null })
		}
	)

	it('an outcome of a stale-author stage whose generation was replaced stamps and upserts nothing', async () => {
		const { t, bob } = await world()
		const { erin } = await staleQuoted(t, bob)
		const profile = await erinRow(t, erin.uri)
		const pair = quotedPair(t, bob, erin)
		const { work, complete } = await stored(t, pair.quote)
		await complete(await work(), {
			quoted: { kind: 'ok', value: parseRemoteStatus({ '@context': AS, ...pair.target })! },
		})
		const fetching = await work()
		expect(fetching).toMatchObject({ stage: 'author', fetch: erin.uri })
		// A round claims the work meanwhile: a new generation.
		await t.store.claimQuotes(BUILD, { now: NOW, limit: QUOTE_ROUND })
		expect((await work()).generation).not.toBe(fetching.generation)
		await complete(fetching, { author: { kind: 'transient' } })
		const document = {
			...actorDefaults(),
			uri: erin.uri,
			username: 'erin',
			domain: 'other.example',
			displayName: 'erin 2',
			inboxUrl: `${erin.uri}/inbox`,
			movedTo: null,
			avatarUrl: `${OTHER}/system/avatars/erin-3.png`,
		}
		await complete(fetching, { author: { kind: 'ok', value: document } })
		expect(await erinRow(t, erin.uri)).toEqual(profile)
	})

	it('an inbound refresh during the stale-author stage moves the work on', async () => {
		const { t, bob } = await world()
		const { erin, avatar } = await staleQuoted(t, bob)
		const pair = quotedPair(t, bob, erin)
		const { work, complete } = await stored(t, pair.quote)
		await complete(await work(), {
			quoted: { kind: 'ok', value: parseRemoteStatus({ '@context': AS, ...pair.target })! },
		})
		const fetching = await work()
		expect(fetching).toMatchObject({ stage: 'author', fetch: erin.uri })
		// While that verifier fetches erin, a boost of another note of hers refreshes her.
		const other = mastodonNote(erin)
		t.web.serve(other.id, { '@context': AS, ...other })
		expect(await t.postOnly(bob, announce(bob, other.id))).toBe(202)
		expect(await erinRow(t, erin.uri)).toEqual({ avatar_url: avatar, fetched_at: new Date(NOW).toISOString() })
		expect(await work()).toMatchObject({ stage: 'quoted', generation: fetching.generation })
		// The late outcome belongs to a stage the work left: discarded, the work due, nothing charged.
		await complete(fetching, { author: { kind: 'gone' } })
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'pending', verify_after: NOW, attempts: 0 })
		await rounds(t, NOW)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted' })
	})

	// A documented limitation (docs/mastodon-deviations.md, Accounts): a 404 that arrives after another request's failed
	// refetch of the same author finds her stamped, and the quoted status is stored under the stored row.
	it('a 404 for a stale-author stage that a failure stamp moved on is not applied', async () => {
		const { t, bob } = await world()
		const { erin } = await staleQuoted(t, bob)
		const profile = await erinRow(t, erin.uri)
		const pair = quotedPair(t, bob, erin)
		const { work, complete } = await stored(t, pair.quote)
		await complete(await work(), {
			quoted: { kind: 'ok', value: parseRemoteStatus({ '@context': AS, ...pair.target })! },
		})
		const fetching = await work()
		expect(fetching).toMatchObject({ stage: 'author', fetch: erin.uri })
		// A boost's refetch of erin fails meanwhile and stamps her.
		t.web.fail(erin.uri, 500)
		const other = mastodonNote(erin)
		t.web.serve(other.id, { '@context': AS, ...other })
		expect(await t.postOnly(bob, announce(bob, other.id))).toBe(202)
		expect(await erinRow(t, erin.uri)).toEqual({ ...profile, fetched_at: new Date(NOW).toISOString() })
		t.web.fail(erin.uri, 404)
		await complete(fetching, { author: { kind: 'gone' } })
		await rounds(t, NOW)
		expect(await statusRow(t.store, pair.target.id)).toBeDefined()
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted' })
	})

	it('a quoted author fetched within a day takes no author stage', async () => {
		const { t, bob } = await world()
		const { erin } = await staleQuoted(t, bob)
		await sql(
			t.store,
			'UPDATE accounts SET fetched_at = ? WHERE uri = ?',
			new Date(NOW - ACCOUNT_STALE_MS + 1).toISOString(),
			erin.uri
		)
		const pair = quotedPair(t, bob, erin)
		await stored(t, pair.quote)
		expect(await recordedRound(t)).toEqual([`quoted:${pair.target.id}`, `stamp:${pair.stamp}`])
		expect(t.web.fetched).not.toContain(erin.uri)
		expect(await quoteOf(t, pair.quote.id)).toMatchObject({ state: 'accepted' })
	})

	it('leases a claim for longer than a round can run', () => {
		// A round: QUOTE_ROUND quotes of QUOTE_STAGES stages, each stage's fetches ending by its budget's deadline.
		expect(QUOTE_LEASE_MS).toBeGreaterThanOrEqual(2 * QUOTE_ROUND * QUOTE_STAGES * REQUEST_DEADLINE_MS)
	})
})
