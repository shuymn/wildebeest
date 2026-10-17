import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'

import { signRequest } from '@fedify/fedify'
import { Temporal } from 'temporal-polyfill'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { harness, inboxDeps } from './app-helpers'
import { LEGACY, LEGACY_EMPTY_KEK, seedLocalAccount } from './federation-helpers'
import { completeSetup, migratedStore } from './helpers'
import { AP, MASTODON, mastodonActor, RemoteWeb, signedInit, type TestActor } from './inbox-helpers'
import { ALICE, ALICE_URI, AS, create, mastodonNote, nextId, PUBLIC, token } from './inbox-status-helpers'
import {
	deliveryDeps,
	quoteAccept as accept,
	quoteReject as reject,
	type RoundDeps,
	serveStamp as sharedServeStamp,
} from './quote-helpers'
import { verifyQuotes } from '../src/federation/quotes'
import { deliveryRound } from '../src/jobs/deliver'
import { type KeyGen, RSA_ALGORITHM } from '../src/security/key-wrap'

// Interoperability of a Kopje user's quote of a Mastodon post (design §5.6, §8): the activities Kopje delivers, as
// received by another Kopje instance through its real inbox and its real verification rounds, and by a model of
// Mastodon 4.5.11's handlers. The second Kopje instance (kopje-b.test) runs in the same test: a router sends each
// fetch and POST to the app of its host, and everything of mastodon.example to an in-memory web.

const B = 'https://kopje-b.test'
const CAROL_B = '333333333333333333'

type App = ReturnType<typeof harness>

// Delivery rounds until nothing is due (a claim that only drops a refused row leaves the next one due).
async function rounds(env: Env, deps: RoundDeps): Promise<void> {
	for (let round = 0; round < 40; round++) {
		const result = await deliveryRound(env, deps)
		if (result.claimed === 0 && (result.nextDueAt === null || result.nextDueAt > Date.now())) {
			return
		}
	}
}

// An instance actor key generated for one server, the same on every call (its keygen runs at most once anyway).
function instanceKeyGen(): KeyGen {
	let pair: Promise<CryptoKeyPair> | undefined
	return () =>
		(pair ??= crypto.subtle.generateKey(
			{ ...RSA_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
			true,
			['sign', 'verify']
		) as Promise<CryptoKeyPair>)
}

async function through(app: App, request: Request): Promise<Response> {
	const ctx = createExecutionContext()
	const response = await app.app.fetch(request, app.env, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

// Kopje A (alice, kopje.test), Kopje B (carol, kopje-b.test, following alice), and bob on mastodon.example, whose
// public status anyone may quote and whom alice follows.
async function world() {
	const web = new RemoteWeb()
	const apps: { a?: App; b?: App } = {}
	const gets: string[] = []
	const route = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		const host = new URL(request.url).host
		if (request.method === 'GET') {
			gets.push(request.url)
		}
		if (host === 'kopje.test') {
			return through(apps.a!, request)
		}
		if (host === 'kopje-b.test') {
			return through(apps.b!, request)
		}
		return web.fetch(request)
	}) as typeof fetch
	const loader = { fetch: route, checkHost: () => Promise.resolve() }
	const storeA = await migratedStore()
	await completeSetup(storeA)
	await seedLocalAccount(storeA, 'kopje.test', { id: ALICE, username: 'alice', key: LEGACY_EMPTY_KEK })
	const storeB = await migratedStore()
	await runInDurableObject(storeB, (_instance, state) => {
		state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje-b.test')")
	})
	// Each server has keys of its own: A's users the empty-KEK fixture, B's the other fixture under B's own KEK, and
	// each instance actor a key generated for it.
	await seedLocalAccount(storeB, 'kopje-b.test', { id: CAROL_B, username: 'carol', key: LEGACY })
	// Both clocks are the real one: deliveries are signed at the real time (security/keyring.ts), as in production.
	apps.a = harness(storeA, { USER_KEK: '' }, undefined, { keygen: instanceKeyGen(), loader }, () => Date.now())
	apps.b = harness(storeB, { USER_KEK: LEGACY.kek }, undefined, { keygen: instanceKeyGen(), loader }, () => Date.now())
	const a = apps.a
	const b = apps.b
	const aliceToken = await token(storeA, ALICE)
	const carolToken = await token(storeB, CAROL_B)
	const bob = await mastodonActor(web, 'bob')
	const postToA = async (actor: TestActor, activity: unknown) =>
		(await a.request('/inbox', await signedInit(actor, '/inbox', activity, { at: Date.now() }))).status
	// bob is known to A (his Follow of nobody: a Create is stored once alice follows him).
	expect(
		await postToA(bob, {
			'@context': AS,
			id: `${bob.uri}#follows/${nextId()}`,
			type: 'Follow',
			actor: bob.uri,
			object: ALICE_URI,
		})
	).toBe(202)
	await sql(
		storeA,
		"INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts WHERE uri = ?",
		ALICE,
		bob.uri
	)
	const note = mastodonNote(bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } })
	web.serve(note.id, { '@context': AS, ...note })
	expect(await postToA(bob, create(bob, note))).toBe(202)
	// carol (B) resolves alice and follows her; A records carol as a follower.
	const resolved = await through(
		b,
		new Request(`${B}/api/v2/search?q=${encodeURIComponent(ALICE_URI)}&resolve=true&type=accounts`, {
			headers: { authorization: `Bearer ${carolToken}` },
		})
	)
	expect(resolved.status).toBe(200)
	await sql(
		storeB,
		"INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts WHERE uri = ?",
		CAROL_B,
		ALICE_URI
	)
	await sql(
		storeA,
		`INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
		VALUES ('444444444444444444', ?, 'carol', 'kopje-b.test', ?, ?)`,
		`${B}/ap/users/carol`,
		`${B}/ap/users/carol/inbox`,
		`${B}/inbox`
	)
	await sql(
		storeA,
		"INSERT INTO follows (account_id, target_account_id, state) VALUES ('444444444444444444', ?, 'accepted')",
		ALICE
	)
	const sent: { inbox: string; json: Record<string, unknown> }[] = []
	// A's delivery rounds until nothing is due, through the router (B's inbox answers for real).
	const deliver = async () => {
		const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			sent.push({ inbox: request.url, json: JSON.parse(await request.clone().text()) as Record<string, unknown> })
			// mastodon.example takes every POST (its answers are modelled below); B's inbox answers for real.
			return new URL(request.url).host === 'kopje-b.test' ? route(request) : new Response(null, { status: 202 })
		}) as typeof globalThis.fetch
		await rounds(
			a.env,
			deliveryDeps(
				() => storeA,
				fetch,
				() => Date.now()
			)
		)
	}
	// B's delivery rounds, every POST through the router to the app of its host (A's inbox answers for real).
	const deliverB = async () => {
		const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			sentByB.push({ inbox: request.url, json: JSON.parse(await request.clone().text()) as Record<string, unknown> })
			return new URL(request.url).host === 'kopje.test' ? route(request) : new Response(null, { status: 202 })
		}) as typeof globalThis.fetch
		await rounds(
			b.env,
			deliveryDeps(
				() => storeB,
				fetch,
				() => Date.now(),
				'b-lease'
			)
		)
	}
	// A's delivery rounds keeping, rather than sending, what goes to B: signed requests to replay in any order.
	const captureForB = async () => {
		const held: Request[] = []
		const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			if (new URL(request.url).host === 'kopje-b.test') {
				held.push(request.clone())
			}
			return new Response(null, { status: 202 })
		}) as typeof globalThis.fetch
		await rounds(
			a.env,
			deliveryDeps(
				() => storeA,
				fetch,
				() => Date.now(),
				'c-lease'
			)
		)
		return held
	}
	const sentByB: { inbox: string; json: Record<string, unknown> }[] = []
	// B's verification rounds (its real VerifyQuoteService), until none is due.
	const verifyB = async () => {
		const deps = { ...inboxDeps(() => storeB, loader), now: () => Date.now() + 60 * 60 * 1000 }
		for (let n = 0; n < 20 && (await verifyQuotes(b.env, deps)); n++) {
			// another round
		}
	}
	const quoteAtB = async (uri: string) =>
		(
			await sql<{ state: string; approval_uri: string | null }>(
				storeB,
				'SELECT q.state, q.approval_uri FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?',
				uri
			)
		)[0]
	const quote = async (text: string) => {
		const id = (await sql<{ id: string }>(storeA, 'SELECT id FROM statuses WHERE uri = ?', note.id))[0]!.id
		const response = await a.request('/api/v1/statuses', {
			method: 'POST',
			headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: text, quoted_status_id: id }),
		})
		expect(response.status).toBe(200)
		return (await response.json()) as { id: string; uri: string }
	}
	const serveStamp = (uri: string, quoting: string, target = note.id) =>
		sharedServeStamp(web, uri, bob, quoting, target)
	const quoteAtA = async (uri: string) =>
		(
			await sql<{ state: string; approval_uri: string | null }>(
				storeA,
				'SELECT q.state, q.approval_uri FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?',
				uri
			)
		)[0]
	return {
		web,
		bob,
		note,
		a,
		b,
		storeA,
		storeB,
		aliceToken,
		carolToken,
		route,
		postToA,
		deliver,
		deliverB,
		captureForB,
		sentByB,
		gets,
		verifyB,
		quoteAtA,
		quoteAtB,
		quote,
		serveStamp,
		sent,
	}
}

describe('a second Kopje instance receiving our quote (its real inbox and verification)', () => {
	it('stores it pending, accepts it once the approving Update carries a valid stamp, and drops it on the Reject', async () => {
		const w = await world()
		const mine = await w.quote('quoting bob')
		await w.deliver()
		await w.verifyB()
		expect(await w.quoteAtB(mine.uri)).toMatchObject({ state: 'pending', approval_uri: null })
		const stamp = `${w.bob.uri}/quote_authorizations/${nextId()}`
		w.serveStamp(stamp, mine.uri)
		expect(await w.postToA(w.bob, accept(w.bob, mine.uri, stamp))).toBe(202)
		await w.deliver()
		await w.verifyB()
		expect(await w.quoteAtB(mine.uri)).toMatchObject({ state: 'accepted', approval_uri: stamp })
		// The Reject's stamp-free Update: B no longer holds it accepted.
		expect(await w.postToA(w.bob, reject(w.bob, mine.uri))).toBe(202)
		await w.deliver()
		await w.verifyB()
		expect(['pending', 'rejected', 'revoked']).toContain((await w.quoteAtB(mine.uri))?.state)
	})

	it.each([
		['a stamp for another status', 'other'],
		['a stamp that is gone', 'gone'],
	])('never ends accepted with %s', async (_name, kind) => {
		const w = await world()
		const mine = await w.quote('quoting bob')
		await w.deliver()
		const stamp = `${w.bob.uri}/quote_authorizations/${nextId()}`
		if (kind === 'other') {
			w.serveStamp(stamp, `${ALICE_URI.replace('/ap/users/alice', '')}/ap/o/someone-else`)
		} else {
			w.web.fail(stamp, 404)
		}
		expect(await w.postToA(w.bob, accept(w.bob, mine.uri, stamp))).toBe(202)
		await w.deliver()
		await w.verifyB()
		expect(['pending', 'rejected']).toContain((await w.quoteAtB(mine.uri))?.state)
	})
})

// ---------------------------------------------------------------------------------------------------------------
// Mastodon 4.5.11 as a receiver, modelled on the pinned handlers it runs for what Kopje sends:
//   - ActivityPub::Activity::QuoteRequest (app/lib/activitypub/activity/quote_request.rb): the request's id on the
//     actor's host; the quoted status its own; the instrument the stored status first, else the inlined one when it is
//     on the actor's host (else fetched); it must quote that status and be the actor's; then Accept.
//   - Create and Update of a quoting Note (create.rb, process_status_update_service.rb update_quote_approval!) with
//     ActivityPub::VerifyQuoteService: a stamp is fetched and must be a QuoteAuthorization on its attributedTo's host,
//     attributed to the quoted author, naming this status as interactingObject and the quoted status as
//     interactionTarget; one that cannot be fetched rejects the quote. A Note with no quoteAuthorization leaves an
//     accepted quote's approval cleared (Quote#reject! on a changed stamp).
//   - Delete of a stamp (delete.rb revoke_quote): the quote holding that approval is revoked.
// ---------------------------------------------------------------------------------------------------------------

type MastodonQuote = { state: 'pending' | 'accepted' | 'rejected' | 'revoked'; approval: string | null }

function hostOf(uri: string): string {
	return new URL(uri).host
}

// Mastodon as the quoted server: whether it answers the QuoteRequest with an Accept, after `activities` in order.
function mastodonAnswers(activities: Record<string, unknown>[], quotedUri: string): boolean {
	const stored = new Map<string, Record<string, unknown>>()
	let accepted = false
	for (const activity of activities) {
		const object = activity.object as Record<string, unknown> | string
		if (activity.type === 'Create' && typeof object === 'object' && !stored.has(String(object.id))) {
			stored.set(String(object.id), object)
		}
		if (activity.type === 'QuoteRequest') {
			const actor = String(activity.actor)
			if (hostOf(String(activity.id)) !== hostOf(actor) || object !== quotedUri) {
				continue
			}
			const instrument = activity.instrument as Record<string, unknown> | string
			const id = typeof instrument === 'string' ? instrument : String(instrument.id)
			const status =
				stored.get(id) ?? (typeof instrument === 'object' && hostOf(id) === hostOf(actor) ? instrument : undefined)
			if (status !== undefined && status.attributedTo === actor && status.quote === quotedUri) {
				accepted = true
			}
		}
	}
	return accepted
}

// Mastodon as a third party holding our quoting status `uri`, after `activities` in order; `fetchStamp` answers a stamp
// fetch as the web does (null for 404).
async function mastodonHolds(
	activities: Record<string, unknown>[],
	uri: string,
	fetchStamp: (stamp: string) => Promise<Record<string, unknown> | null>
): Promise<MastodonQuote | null> {
	let quote: MastodonQuote | null = null
	let held: Record<string, unknown> | null = null
	const verify = async (note: Record<string, unknown>) => {
		const stamp = note.quoteAuthorization
		if (quote === null || typeof stamp !== 'string') {
			if (quote?.state === 'accepted') {
				quote = { state: 'revoked', approval: null }
			}
			return
		}
		if (stamp === quote.approval) {
			return
		}
		const document = await fetchStamp(stamp)
		if (document === null) {
			quote = { state: quote.state === 'accepted' ? 'revoked' : 'rejected', approval: null }
			return
		}
		const attributedTo = String(document.attributedTo)
		const valid =
			document.type === 'QuoteAuthorization' &&
			document.id === stamp &&
			hostOf(stamp) === hostOf(attributedTo) &&
			attributedTo === String(note.quote).replace(/\/statuses\/.*$/, '') &&
			document.interactingObject === uri &&
			document.interactionTarget === note.quote
		if (valid) {
			quote = { state: 'accepted', approval: stamp }
		}
	}
	for (const activity of activities) {
		const object = activity.object as Record<string, unknown> | string
		if (activity.type === 'Delete' && typeof object === 'string') {
			if (quote !== null && quote.approval === object && quote.state === 'accepted') {
				quote = { state: 'revoked', approval: null }
			}
			continue
		}
		if (typeof object !== 'object' || object.id !== uri) {
			continue
		}
		if (activity.type === 'Create' && held === null) {
			held = object
			quote = { state: 'pending', approval: null }
			await verify(object)
		} else if (activity.type === 'Update' && held !== null) {
			held = object
			await verify(object)
		}
	}
	return quote
}

describe('Mastodon 4.5.11 receiving our quote (a model of its handlers)', () => {
	it('answers our QuoteRequest whether the Create or the request arrives first (row 4)', async () => {
		const w = await world()
		const mine = await w.quote('quoting bob')
		await w.deliver()
		const toBob = w.sent.filter((s) => s.inbox.startsWith(MASTODON)).map((s) => s.json)
		const request = toBob.find((a) => a.type === 'QuoteRequest')!
		const creation = toBob.find((a) => a.type === 'Create')!
		expect(mastodonAnswers([creation, request], w.note.id)).toBe(true)
		expect(mastodonAnswers([request, creation], w.note.id)).toBe(true)
		// A request whose instrument does not quote the status is not answered.
		const instrument = { ...(request.instrument as Record<string, unknown>), quote: `${w.note.id}0` }
		expect(mastodonAnswers([{ ...request, instrument }], w.note.id)).toBe(false)
		expect(mine.uri).toBe((request.instrument as { id: string }).id)
	})

	it('accepts with a valid stamp, revokes on the stamp-free Update or the Delete, and never accepts an invalid stamp', async () => {
		const w = await world()
		const fetchStamp = async (stamp: string) => {
			const response = await w.web.fetch(stamp)
			return response.status === 200 ? ((await response.json()) as Record<string, unknown>) : null
		}
		const mine = await w.quote('quoting bob')
		const stamp = `${w.bob.uri}/quote_authorizations/${nextId()}`
		w.serveStamp(stamp, mine.uri)
		expect(await w.postToA(w.bob, accept(w.bob, mine.uri, stamp))).toBe(202)
		await w.deliver()
		const toCarol = () => w.sent.filter((s) => new URL(s.inbox).origin === B).map((s) => s.json)
		expect(await mastodonHolds(toCarol(), mine.uri, fetchStamp)).toEqual({ state: 'accepted', approval: stamp })
		expect(await w.postToA(w.bob, reject(w.bob, mine.uri))).toBe(202)
		await w.deliver()
		expect((await mastodonHolds(toCarol(), mine.uri, fetchStamp))?.state).toBe('revoked')
		// The forwarded Delete alone revokes too.
		const deletion = { type: 'Delete', object: stamp }
		const creations = toCarol().filter((a) => a.type !== 'Update' || 'quoteAuthorization' in (a.object as object))
		expect((await mastodonHolds([...creations, deletion], mine.uri, fetchStamp))?.state).toBe('revoked')
		// Invalid stamps: for another status, or gone.
		for (const kind of ['other', 'gone']) {
			const v = await world()
			const theirs = await v.quote('again')
			const bad = `${v.bob.uri}/quote_authorizations/${nextId()}`
			if (kind === 'other') {
				v.serveStamp(bad, `${theirs.uri}x`)
			} else {
				v.web.fail(bad, 404)
			}
			expect(await v.postToA(v.bob, accept(v.bob, theirs.uri, bad))).toBe(202)
			await v.deliver()
			const fetchBad = async (s: string) => {
				const response = await v.web.fetch(s)
				return response.status === 200 ? ((await response.json()) as Record<string, unknown>) : null
			}
			const held = await mastodonHolds(
				v.sent.filter((s) => new URL(s.inbox).origin === B).map((s) => s.json),
				theirs.uri,
				fetchBad
			)
			expect(['pending', 'rejected'], kind).toContain(held?.state)
		}
	})
})

// A request to `url`, signed at the real time with `privateKey` under `keyId`.
async function signedPost(url: string, activity: unknown, privateKey: CryptoKey, keyId: string): Promise<Request> {
	const request = new Request(url, { method: 'POST', headers: { 'content-type': AP }, body: JSON.stringify(activity) })
	return signRequest(request, privateKey, new URL(keyId), {
		spec: 'draft-cavage-http-signatures-12',
		currentTime: Temporal.Instant.fromEpochMilliseconds(Date.now()),
	})
}

const pkcs8 = (bytes: Uint8Array) => crypto.subtle.importKey('pkcs8', bytes, RSA_ALGORITHM, true, ['sign'])

describe('the two servers’ keys', () => {
	it('refuses a delivery signed with the other server’s key, and ingests nothing of it', async () => {
		const w = await world()
		const aKey = await pkcs8(LEGACY_EMPTY_KEK.pkcs8)
		const bKey = await pkcs8(LEGACY.pkcs8)
		const carolUri = `${B}/ap/users/carol`
		const noteOf = (actor: string, origin: string) => {
			const id = `${origin}/ap/o/forged-${nextId()}`
			return {
				'@context': AS,
				id: `${id}/activity`,
				type: 'Create',
				actor,
				to: [PUBLIC],
				cc: [],
				object: { id, type: 'Note', attributedTo: actor, to: [PUBLIC], cc: [], content: '<p>x</p>' },
			}
		}
		const statusesAt = async (store: typeof w.storeA, uri: string) =>
			sql(store, 'SELECT id FROM statuses WHERE uri = ?', uri)
		// To B: alice's key id, signed with B's (carol's) key; then, as a control, with alice's own.
		const toB = noteOf(ALICE_URI, 'https://kopje.test')
		const forgedB = await through(w.b, await signedPost(`${B}/inbox`, toB, bKey, `${ALICE_URI}#main-key`))
		expect(forgedB.status).toBe(401)
		expect(await statusesAt(w.storeB, toB.object.id)).toEqual([])
		const realB = await through(w.b, await signedPost(`${B}/inbox`, toB, aKey, `${ALICE_URI}#main-key`))
		expect(realB.status).toBe(202)
		expect(await statusesAt(w.storeB, toB.object.id)).toHaveLength(1)
		// To A: carol's key id, signed with A's (alice's) key; then with carol's own.
		const toA = noteOf(carolUri, B)
		const forgedA = await through(w.a, await signedPost('https://kopje.test/inbox', toA, aKey, `${carolUri}#main-key`))
		expect(forgedA.status).toBe(401)
		expect(await statusesAt(w.storeA, toA.object.id)).toEqual([])
		const realA = await through(w.a, await signedPost('https://kopje.test/inbox', toA, bKey, `${carolUri}#main-key`))
		expect(realA.status).toBe(202)
	})
})

describe('Kopje as the quoted server (B owns the status; its real inbox, stamps and revoke)', () => {
	async function quotedAtB(order: 'create first' | 'request first' | 'request alone') {
		const w = await world()
		const carolPost = await through(
			w.b,
			new Request(`${B}/api/v1/statuses`, {
				method: 'POST',
				headers: { authorization: `Bearer ${w.carolToken}`, 'content-type': 'application/json' },
				body: JSON.stringify({ status: 'quote me', visibility: 'public' }),
			})
		)
		expect(carolPost.status).toBe(200)
		const theirs = (await carolPost.json()) as { id: string; uri: string }
		// alice finds carol's status (A fetches it from B), and quotes it.
		const found = await w.a.request(`/api/v2/search?q=${encodeURIComponent(theirs.uri)}&resolve=true&type=statuses`, {
			headers: { authorization: `Bearer ${w.aliceToken}` },
		})
		const quotedAtA = ((await found.json()) as { statuses: { id: string }[] }).statuses[0]!.id
		const response = await w.a.request('/api/v1/statuses', {
			method: 'POST',
			headers: { authorization: `Bearer ${w.aliceToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'quoting carol', quoted_status_id: quotedAtA }),
		})
		expect(response.status).toBe(200)
		const mine = (await response.json()) as { id: string; uri: string }
		expect(await w.quoteAtA(mine.uri)).toMatchObject({ state: 'pending' })
		const held = await w.captureForB()
		const typeOf = async (request: Request) => ((await request.clone().json()) as { type: string }).type
		const creates: Request[] = []
		const requests: Request[] = []
		for (const request of held) {
			;((await typeOf(request)) === 'QuoteRequest' ? requests : creates).push(request)
		}
		expect(requests).toHaveLength(1)
		expect(creates.length).toBeGreaterThan(0)
		const order_ =
			order === 'create first'
				? [...creates, ...requests]
				: order === 'request first'
					? [...requests, ...creates]
					: requests
		const getsBefore = w.gets.length
		for (const request of order_) {
			expect((await through(w.b, request.clone())).status).toBe(202)
		}
		if (order === 'request alone') {
			// B took the inlined instrument: it fetched nothing of alice's status.
			expect(w.gets.slice(getsBefore)).not.toContain(mine.uri)
			expect(await sql(w.storeB, 'SELECT id FROM statuses WHERE uri = ?', mine.uri)).toHaveLength(1)
		}
		// B's Accept, and the stamp it serves.
		const accepts = (await sql<{ body: string }>(w.storeB, 'SELECT body FROM outbound_activities'))
			.map((row) => (JSON.parse(row.body) as { activity: Record<string, unknown> }).activity)
			.filter((activity) => activity.type === 'Accept')
		expect(accepts).toHaveLength(1)
		const stamp = String(accepts[0]!.result)
		expect(stamp).toMatch(new RegExp(`^${B}/ap/users/carol/quote_authorizations/[0-9a-f]{32}$`))
		expect(accepts[0]).toMatchObject({ actor: `${B}/ap/users/carol`, object: { id: `${mine.uri}#quote-request` } })
		const served = await through(w.b, new Request(stamp, { headers: { accept: AP } }))
		expect(served.status).toBe(200)
		expect(await served.json()).toMatchObject({
			id: stamp,
			type: 'QuoteAuthorization',
			attributedTo: `${B}/ap/users/carol`,
			interactingObject: mine.uri,
			interactionTarget: theirs.uri,
		})
		// B delivers its Accept: A ends accepted with B's stamp.
		await w.deliverB()
		expect(await w.quoteAtA(mine.uri)).toEqual({ state: 'accepted', approval_uri: stamp })
		// carol revokes on B: A ends not accepted, and B's stamp is gone.
		const quotingAtB = (await sql<{ id: string }>(w.storeB, 'SELECT id FROM statuses WHERE uri = ?', mine.uri))[0]!.id
		const revoked = await through(
			w.b,
			new Request(`${B}/api/v1/statuses/${theirs.id}/quotes/${quotingAtB}/revoke`, {
				method: 'POST',
				headers: { authorization: `Bearer ${w.carolToken}` },
			})
		)
		expect(revoked.status).toBe(200)
		await w.deliverB()
		expect(await w.quoteAtA(mine.uri)).toMatchObject({ state: 'revoked' })
		expect((await through(w.b, new Request(stamp, { headers: { accept: AP } }))).status).toBe(404)
	}

	it('answers when A’s Create arrives before the QuoteRequest', async () => {
		await quotedAtB('create first')
	})

	it('answers when the QuoteRequest arrives before the Create', async () => {
		await quotedAtB('request first')
	})

	it('answers the QuoteRequest alone from its inlined instrument', async () => {
		await quotedAtB('request alone')
	})
})
