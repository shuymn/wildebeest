import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { harness, inboxDeps, NOW } from './app-helpers'
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from './federation-helpers'
import { BUILD, completeSetup, migratedStore } from './helpers'
import { MASTODON, mastodonActor, RemoteWeb, signedInit, type TestActor } from './inbox-helpers'
import { ALICE, ALICE_URI, AS, create, mastodonNote, nextId, PUBLIC, token } from './inbox-status-helpers'
import { verifyQuotes } from '../src/federation/quotes'
import { deliveryRound } from '../src/jobs/deliver'

// Interoperability of a Kopje user's quote of a Mastodon post (design §5.6, §8): the activities Kopje delivers, as
// received by another Kopje instance through its real inbox and its real verification rounds, and by a model of
// Mastodon 4.5.11's handlers. The second Kopje instance (kopje-b.test) runs in the same test: a router sends each
// fetch and POST to the app of its host, and everything of mastodon.example to an in-memory web.

const B = 'https://kopje-b.test'
const CAROL_B = '333333333333333333'
const QUOTE_CONTEXT = [
	AS,
	{
		QuoteAuthorization: 'https://w3id.org/fep/044f#QuoteAuthorization',
		gts: 'https://gotosocial.org/ns#',
		interactingObject: { '@id': 'gts:interactingObject', '@type': '@id' },
		interactionTarget: { '@id': 'gts:interactionTarget', '@type': '@id' },
	},
]

type App = ReturnType<typeof harness>

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
	const route = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : new Request(input, init)
		const host = new URL(request.url).host
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
	await seedLocalAccount(storeB, 'kopje-b.test', { id: CAROL_B, username: 'carol', key: LEGACY_EMPTY_KEK })
	apps.a = harness(storeA, {}, undefined, { keygen: fixtureKeyGen, loader }, () => NOW)
	// B's clock is the real one: A's deliveries are signed at the real time (security/keyring.ts), as in production.
	apps.b = harness(storeB, {}, undefined, { keygen: fixtureKeyGen, loader }, () => Date.now())
	const a = apps.a
	const b = apps.b
	const aliceToken = await token(storeA, ALICE)
	const carolToken = await token(storeB, CAROL_B)
	const bob = await mastodonActor(web, 'bob')
	const postToA = async (actor: TestActor, activity: unknown) =>
		(await a.request('/inbox', await signedInit(actor, '/inbox', activity, { at: NOW }))).status
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
		let n = 0
		const deps = {
			build: () => BUILD,
			store: () => storeA,
			now: () => NOW,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init)
				sent.push({ inbox: request.url, json: JSON.parse(await request.clone().text()) as Record<string, unknown> })
				// mastodon.example takes every POST (its answers are modelled below); B's inbox answers for real.
				return new URL(request.url).host === 'kopje-b.test' ? route(request) : new Response(null, { status: 202 })
			}) as typeof fetch,
			checkHost: () => Promise.resolve(),
			leaseToken: () => `lease-${++n}`,
		}
		for (let round = 0; round < 40; round++) {
			const result = await deliveryRound(a.env, deps)
			if (result.claimed === 0 && (result.nextDueAt === null || result.nextDueAt > NOW)) {
				return
			}
		}
	}
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
		web.serve(uri, {
			'@context': QUOTE_CONTEXT,
			type: 'QuoteAuthorization',
			id: uri,
			attributedTo: bob.uri,
			interactingObject: quoting,
			interactionTarget: target,
		})
	return { web, bob, note, postToA, deliver, verifyB, quoteAtB, quote, serveStamp, sent }
}

const accept = (bob: TestActor, quoting: string, result: string) => ({
	'@context': [AS, { QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest' }],
	id: `${bob.uri}#accepts/quote_requests/${nextId()}`,
	type: 'Accept',
	actor: bob.uri,
	object: `${quoting}#quote-request`,
	result,
})

const reject = (bob: TestActor, quoting: string) => ({
	'@context': [AS, { QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest' }],
	id: `${bob.uri}#rejects/quote_requests/${nextId()}`,
	type: 'Reject',
	actor: bob.uri,
	object: `${quoting}#quote-request`,
})

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
		const toCarol = () => w.sent.filter((s) => s.inbox.startsWith(B)).map((s) => s.json)
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
				v.sent.filter((s) => s.inbox.startsWith(B)).map((s) => s.json),
				theirs.uri,
				fetchBad
			)
			expect(['pending', 'rejected'], kind).toContain(held?.state)
		}
	})
})
