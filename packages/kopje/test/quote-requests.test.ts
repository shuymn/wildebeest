import { type DocumentLoader, verifyJsonLd } from '@fedify/fedify'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { harness, NOW } from './app-helpers'
import { fixtureKeyGen, LEGACY_EMPTY_KEK } from './federation-helpers'
import { BUILD } from './helpers'
import { LOCAL, mastodonActor, MASTODON, signedInit, type TestActor } from './inbox-helpers'
import {
	ALICE,
	ALICE_URI,
	announce,
	AS,
	create,
	DAVE,
	followed,
	localStatus,
	mastodonNote,
	type Note,
	nextId,
	remove,
	setup,
	type Setup,
	undo,
	update,
} from './inbox-status-helpers'
import { contexts, deferred, deliveryDeps, quoting } from './quote-helpers'
import { outbound } from './status-helpers'
import { MAX_LANE_BACKLOG } from '../src/domain/deliveries'
import { RETRACTION_TTL_MS } from '../src/domain/inbox'
import { MAX_QUOTE_REQUESTS_PER_ACTOR } from '../src/domain/quotes'
import { signAsAuthor } from '../src/federation/ld-sign'
import { deliveryRound } from '../src/jobs/deliver'
import { sha256Hex } from '../src/security/tokens'

// Being quoted (design §5.4, §5.5 and "Concurrency (PR 2)", VIS-28): remote servers' QuoteRequests for local
// statuses, answered by R36 in the inbox's final Store round; Kopje's stamps; their revocation with an LD-signed Delete
// and the Rejects of the requests answered; quoters' reach; Notes advertising the real policy. Interleavings use the
// remote web's gates (RemoteWeb.hold) and gated delivery POSTs, never timers.

const FEP = 'https://w3id.org/fep/044f#QuoteRequest'
const PRESENT = { origin: LOCAL }

// `actor`'s Note quoting `target` (no stamp), served at its id.
function quoteNote(t: Setup, actor: TestActor, target: string, extra: Record<string, unknown> = {}): Note {
	const note = quoting(actor, target, null, extra)
	t.web.serve(note.id, { '@context': AS, ...note })
	return note
}

function quoteRequest(actor: TestActor, object: string, instrument: unknown, id?: string) {
	return {
		'@context': [AS, { QuoteRequest: FEP }],
		id: id ?? `${actor.uri}/quote_requests/${nextId()}`,
		type: 'QuoteRequest',
		actor: actor.uri,
		object,
		instrument,
	}
}

type Quote = { state: string; authorization_id: string | null; activity_uri: string | null; quoted_status_id: string }

async function quoteOf(t: Setup, uri: string): Promise<Quote | undefined> {
	return (
		await sql<Quote>(
			t.store,
			`SELECT q.state, q.authorization_id, q.activity_uri, q.quoted_status_id FROM quotes q
			JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?`,
			uri
		)
	)[0]
}

type Sent = {
	id: string
	type: string
	object_uri: string | null
	inbox: string
	addressee: string | null
	state: string
}

async function deliveries(t: Setup): Promise<Sent[]> {
	return sql<Sent>(
		t.store,
		`SELECT CAST(d.id AS TEXT) AS id, json_extract(o.body, '$.activity.type') AS type, o.object_uri,
			d.inbox_url AS inbox, d.addressee, d.state
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`
	)
}

async function recorded(t: Setup, type: string): Promise<Record<string, unknown>[]> {
	return (await outbound(t.store)).map((row) => row.activity).filter((activity) => activity.type === type)
}

async function stamp(t: Setup, uri: string) {
	const response = await t.request(new URL(uri).pathname, { headers: { accept: 'application/activity+json' } })
	return {
		status: response.status,
		cache: response.headers.get('cache-control'),
		body: response.status === 200 ? ((await response.json()) as Record<string, unknown>) : null,
	}
}

async function revoke(t: Setup, quotedId: string, quotingId: string, as: 'alice' | 'dave' = 'alice') {
	const response = await t.request(`/api/v1/statuses/${quotedId}/quotes/${quotingId}/revoke`, {
		method: 'POST',
		headers: { authorization: `Bearer ${t.tokens[as]}` },
	})
	return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function statusId(t: Setup, uri: string): Promise<string> {
	return (await sql<{ id: string }>(t.store, 'SELECT id FROM statuses WHERE uri = ?', uri))[0]!.id
}

// alice's public status (default policy public), and bob, a Mastodon account that follows nobody here.
async function world() {
	const t = await setup()
	const bob = await mastodonActor(t.web, 'bob')
	const mine = await localStatus(t, { status: 'quote me', visibility: 'public' })
	return { t, bob, mine }
}

// bob's quote of alice's status, accepted through a QuoteRequest: its Note, the request and the stamp.
async function accepted(t: Setup, bob: TestActor, target: string) {
	const note = quoteNote(t, bob, target)
	const request = quoteRequest(bob, target, note.id)
	expect(await t.post(bob, request)).toBe(202)
	const quote = await quoteOf(t, note.id)
	expect(quote).toMatchObject({ state: 'accepted', activity_uri: request.id })
	return {
		note,
		request,
		authorization: quote!.authorization_id!,
		stamp: `${ALICE_URI}/quote_authorizations/${quote!.authorization_id}`,
	}
}

// Delivery rounds until nothing is due, every POST answered by `answer` (202 unless it says otherwise).
async function deliver(t: Setup, answer: (url: string, body: string) => Promise<number> | number = () => 202) {
	const answering = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		return new Response(null, { status: await answer(request.url, await request.text()) })
	}) as typeof fetch
	const deps = deliveryDeps(
		() => t.store,
		answering,
		() => NOW
	)
	for (let round = 0; round < 20; round++) {
		if ((await deliveryRound(t.env, deps)).claimed === 0) {
			return
		}
	}
	throw new Error('delivery did not settle')
}

// The activities sent to inboxes starting with `prefix` (one inbox, or a server's origin) in delivery rounds until
// nothing is due.
async function sentTo(t: Setup, prefix: string): Promise<Record<string, unknown>[]> {
	const sent: Record<string, unknown>[] = []
	await deliver(t, (url, body) => {
		if (url.startsWith(prefix)) {
			sent.push(JSON.parse(body) as Record<string, unknown>)
		}
		return 202
	})
	return sent
}

const idOf = (value: unknown) => (typeof value === 'string' ? value : (value as { id: string }).id)

function label(activity: Record<string, unknown>): string {
	return `${String(activity.type)} ${idOf(activity.object)}`
}

// Mastodon 4.5.11 as a receiver of the quote it stored for its current request `current`, applying `activities` with
// Delete first, then each Accept, then each Reject: a Delete matches the quote by its stamp (Delete#revoke_quote); an
// Accept or Reject by its object's id against the current request (quote_request_from_object), an Accept only while
// pending. A Reject whose embedded QuoteRequest matches no request falls into reject_embedded_quote_request, which
// raises a NameError (app/lib/activitypub/activity/reject.rb:39): modelled as a throw.
function mastodonReceiver(current: string, activities: Record<string, unknown>[]) {
	const receiver = { state: 'pending', approval: null as string | null }
	const ordered = ['Delete', 'Accept', 'Reject'].flatMap((type) => activities.filter((a) => a.type === type))
	for (const activity of ordered) {
		const ref = idOf(activity.object)
		if (activity.type === 'Delete') {
			if (ref === receiver.approval && ['pending', 'accepted'].includes(receiver.state)) {
				receiver.state = receiver.state === 'accepted' ? 'revoked' : 'rejected'
			}
		} else if (activity.type === 'Accept') {
			if (ref === current && receiver.state === 'pending') {
				receiver.state = 'accepted'
				receiver.approval = String(activity.result)
			}
		} else if (ref === current) {
			receiver.state = receiver.state === 'accepted' ? 'revoked' : 'rejected'
		} else if (typeof activity.object !== 'string') {
			throw new Error('NameError: undefined local variable or method `quoting_status`')
		}
	}
	return receiver
}

// What a Mastodon server holds of status `uri` after `activities`, in order: `held` its version before (V1, fetched),
// or null for none. A Create of a status it has changes nothing (Create#create_status finds it) and stores one it
// lacks; an Update replaces one it has and is ignored otherwise.
function holdsAfter(activities: Record<string, unknown>[], uri: string, held: string | null = 'V1'): string | null {
	let content = held
	for (const activity of activities) {
		const object = activity.object as { id?: string; content?: string }
		if (object?.id !== uri) {
			continue
		}
		if (activity.type === 'Create' && content === null) {
			content = String(object.content)
		} else if (activity.type === 'Update' && content !== null) {
			content = String(object.content)
		}
	}
	return content
}

async function edit(t: Setup, id: string, text: string) {
	const response = await t.request(`/api/v1/statuses/${id}`, {
		method: 'PUT',
		headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
		body: JSON.stringify({ status: text }),
	})
	expect(response.status).toBe(200)
}

function follow(actor: TestActor) {
	return { '@context': AS, id: `${actor.uri}#follows/${nextId()}`, type: 'Follow', actor: actor.uri, object: ALICE_URI }
}

describe('QuoteRequest for a local status (QuoteRequest#perform)', () => {
	it('accepts by the policy: a fresh authorization, the silent mention, the Accept, the notification', async () => {
		const { t, bob, mine } = await world()
		const note = quoteNote(t, bob, mine.uri)
		const request = quoteRequest(bob, mine.uri, note.id)
		expect(await t.post(bob, request)).toBe(202)
		const quote = await quoteOf(t, note.id)
		expect(quote).toMatchObject({ state: 'accepted', activity_uri: request.id })
		expect(quote?.authorization_id).toMatch(/^[0-9a-f]{32}$/)
		const result = `${ALICE_URI}/quote_authorizations/${quote!.authorization_id}`
		expect(await recorded(t, 'Accept')).toEqual([
			{
				'@context': [AS, { QuoteRequest: FEP }],
				id: expect.stringMatching(new RegExp(`^${ALICE_URI}#accepts/quote_requests/[0-9a-f]{64}$`)),
				type: 'Accept',
				actor: ALICE_URI,
				object: { id: request.id, type: 'QuoteRequest', actor: bob.uri, object: mine.uri, instrument: note.id },
				result,
			},
		])
		// To bob's shared inbox, as an activity without `to`; its subject is the stamp it grants.
		expect(await deliveries(t)).toEqual([
			expect.objectContaining({ type: 'Accept', object_uri: result, inbox: `${MASTODON}/inbox` }),
		])
		const quoting = await statusId(t, note.id)
		expect(await sql(t.store, 'SELECT account_id, silent FROM status_mentions WHERE status_id = ?', quoting)).toEqual([
			{ account_id: ALICE, silent: 1 },
		])
		expect(await sql(t.store, "SELECT account_id, status_id FROM notifications WHERE type = 'quote'")).toEqual([
			{ account_id: ALICE, status_id: quoting },
		])
		expect(await sql(t.store, 'SELECT quotes_count FROM statuses WHERE id = ?', mine.id)).toEqual([{ quotes_count: 1 }])
		expect(await sql(t.store, 'SELECT activity_uri, actor_uri, instrument_uri FROM quote_requests')).toEqual([
			{ activity_uri: request.id, actor_uri: bob.uri, instrument_uri: note.id },
		])
		// The stamp is served (FEP-044f), ids only, never cached.
		expect(await stamp(t, result)).toEqual({
			status: 200,
			cache: 'no-store',
			body: expect.objectContaining({
				id: result,
				type: 'QuoteAuthorization',
				attributedTo: ALICE_URI,
				interactingObject: note.id,
				interactionTarget: mine.uri,
			}),
		})
		const status = (await t.api<{ quote: unknown; quotes_count: number }>(`/api/v1/statuses/${quoting}`)).body
		expect(status.quotes_count).toBe(0)
		expect(status.quote).toMatchObject({ state: 'accepted', quoted_status: { id: mine.id } })
	})

	it('takes the instrument inlined only as the actor’s own object, else fetches it', async () => {
		const { t, bob, mine } = await world()
		const note = quoteNote(t, bob, mine.uri)
		t.web.served.delete(note.id)
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note))).toBe(202)
		expect(await quoteOf(t, note.id)).toMatchObject({ state: 'accepted' })
		expect(t.web.fetched).not.toContain(note.id)
		// Another origin's object inlined is not taken: it is fetched, and here it cannot be.
		const carol = await mastodonActor(t.web, 'carol', { origin: 'https://other.example', key: 2 })
		const theirs = mastodonNote(carol, { quote: mine.uri })
		expect(await t.post(bob, quoteRequest(bob, mine.uri, theirs))).toBe(202)
		expect(t.web.fetched).toContain(theirs.id)
		expect(await quoteOf(t, theirs.id)).toBeUndefined()
	})

	it('rejects what the policy refuses, changing nothing, and answers nothing about other statuses', async () => {
		const { t, bob, mine } = await world()
		const note = quoteNote(t, bob, mine.uri)
		await t.request(`/api/v1/statuses/${mine.id}/interaction_policy`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
			body: JSON.stringify({ quote_approval_policy: 'followers' }),
		})
		const request = quoteRequest(bob, mine.uri, note.id)
		expect(await t.post(bob, request)).toBe(202)
		expect(await quoteOf(t, note.id)).toBeUndefined()
		expect(await recorded(t, 'Reject')).toEqual([
			expect.objectContaining({
				type: 'Reject',
				actor: ALICE_URI,
				object: { id: request.id, type: 'QuoteRequest', actor: bob.uri, object: mine.uri, instrument: note.id },
			}),
		])
		expect(await sql(t.store, 'SELECT activity_uri FROM quote_requests')).toEqual([{ activity_uri: request.id }])
		// No answer at all for a private status, a boost, an unknown or a remote object, nor a request of another origin.
		const secret = await localStatus(t, { status: 'secret', visibility: 'private' })
		const boost = (
			await t.request(`/api/v1/statuses/${mine.id}/reblog`, {
				method: 'POST',
				headers: { authorization: `Bearer ${t.tokens.dave}` },
			})
		).json() as Promise<{ uri: string }>
		const unanswered = [secret.uri, (await boost).uri, `${LOCAL}/ap/o/nothing`, `${MASTODON}/users/bob/statuses/1`]
		for (const object of unanswered) {
			expect(await t.post(bob, quoteRequest(bob, object, note.id))).toBe(202)
		}
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id, 'https://other.example/requests/1'))).toBe(202)
		expect((await recorded(t, 'Reject')).length).toBe(1)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM quote_requests')).toEqual([{ n: 1 }])
	})

	it('rejects an actor the author blocks, and one that blocks the author (R36)', async () => {
		const { t, bob, mine } = await world()
		const bobId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', bob.uri))[0]
		expect(bobId).toBeUndefined()
		// bob is stored by his first request, refused here as alice blocks him.
		await t.post(bob, quoteRequest(bob, `${LOCAL}/ap/o/none`, 'x'))
		const id = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', bob.uri))[0]!.id
		await sql(
			t.store,
			'INSERT INTO blocks (account_id, target_account_id, created_at) VALUES (?, ?, ?)',
			ALICE,
			id,
			'2026-10-12T00:00:00.000Z'
		)
		const note = quoteNote(t, bob, mine.uri)
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202)
		await sql(t.store, 'DELETE FROM blocks')
		await sql(
			t.store,
			'INSERT INTO blocks (account_id, target_account_id, created_at) VALUES (?, ?, ?)',
			id,
			ALICE,
			'2026-10-12T00:00:00.000Z'
		)
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202)
		expect((await recorded(t, 'Reject')).length).toBe(2)
		expect(await recorded(t, 'Accept')).toEqual([])
	})
})

describe('the silent mention of acceptance', () => {
	it('puts a direct quote in the quoted author’s home when they follow the quoter', async () => {
		const { t, bob, mine } = await world()
		await followed(t, bob)
		// bob's direct Note quoting alice, addressed to nobody: alice reaches it only through the silent mention.
		const note = quoteNote(t, bob, mine.uri, { to: [], cc: [] })
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note))).toBe(202)
		const quoting = await statusId(t, note.id)
		expect(await sql(t.store, 'SELECT visibility FROM statuses WHERE id = ?', quoting)).toEqual([
			{ visibility: 'direct' },
		])
		const home = (await t.api<{ id: string }[]>('/api/v1/timelines/home')).body
		expect(home.map((s) => s.id)).toContain(quoting)
	})
})

describe('federation of quotes: edits reach holders, grouped notifications, the fetching signer', () => {
	it('reaches a booster’s server with an edit: it fetched the status to boost it', async () => {
		const { t, bob, mine } = await world()
		expect(await t.post(bob, announce(bob, mine.uri, { cc: [ALICE_URI] }))).toBe(202)
		await deliver(t)
		await edit(t, mine.id, 'boosted, edited')
		expect(holdsAfter(await sentTo(t, MASTODON), mine.uri)).toBe('<p>boosted, edited</p>')
	})

	it('reaches a former booster’s server with an edit: an undone boost leaves the status there', async () => {
		const { t, bob, mine } = await world()
		const boost = announce(bob, mine.uri, { cc: [ALICE_URI] })
		expect(await t.post(bob, boost)).toBe(202)
		expect(await t.post(bob, undo(bob, boost))).toBe(202)
		expect(await t.post(bob, follow(bob))).toBe(202)
		await deliver(t)
		await edit(t, mine.id, 'unboosted, edited')
		expect(holdsAfter(await sentTo(t, MASTODON), mine.uri)).toBe('<p>unboosted, edited</p>')
	})

	it('reaches a revoked quoter that follows since with an edit, though no relation says it holds the status', async () => {
		const { t, bob, mine } = await world()
		const { note } = await accepted(t, bob, mine.uri)
		await deliver(t)
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		expect(await t.post(bob, follow(bob))).toBe(202)
		await deliver(t)
		await edit(t, mine.id, 'revoked, edited')
		expect(holdsAfter(await sentTo(t, MASTODON), mine.uri)).toBe('<p>revoked, edited</p>')
	})

	it('gives a server that never held the status its current version, and later edits as an Update alone', async () => {
		const { t, bob, mine } = await world()
		// bob follows after the status was posted: nothing delivered it to his server.
		expect(await t.post(bob, follow(bob))).toBe(202)
		await deliver(t)
		await edit(t, mine.id, 'first edit')
		const first = await sentTo(t, MASTODON)
		expect(first.filter((a) => (a.object as { id?: string })?.id === mine.uri).map((a) => a.type)).toEqual([
			'Create',
			'Update',
		])
		expect(holdsAfter(first, mine.uri, null)).toBe('<p>first edit</p>')
		await edit(t, mine.id, 'second edit')
		const second = await sentTo(t, MASTODON)
		expect(second.filter((a) => (a.object as { id?: string })?.id === mine.uri).map((a) => a.type)).toEqual(['Update'])
		expect(holdsAfter(second, mine.uri, '<p>first edit</p>')).toBe('<p>second edit</p>')
	})

	it('never fetches the instrument as an author suspended after the round that asked for it', async () => {
		const { t, bob, mine } = await world()
		const note = quoteNote(t, bob, mine.uri, { to: [ALICE_URI], cc: [] })
		t.web.signedOnly.set(note.id, `${ALICE_URI}#main-key`)
		// alice is suspended between the round's need and the load of her key.
		const store = t.store as unknown as Record<string | symbol, (...args: unknown[]) => Promise<unknown>>
		const suspending = new Proxy(t.store, {
			get(_target, prop) {
				// A Store stub answers every name with an RPC method; `then` must stay undefined to keep it awaitable.
				if (prop === 'then') {
					return undefined
				}
				return async (...args: unknown[]) => {
					if (prop === 'signingKey') {
						await sql(
							t.store,
							'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
							'2026-10-12T00:00:00.000Z',
							ALICE
						)
					}
					return store[prop]!(...args)
				}
			},
		})
		const h = harness(suspending, {}, undefined, { keygen: fixtureKeyGen, loader: t.web.loader })
		const request = quoteRequest(bob, mine.uri, note.id)
		expect((await h.request('/inbox', await signedInit(bob, '/inbox', request))).status).toBe(202)
		expect(t.web.signers[t.web.fetched.lastIndexOf(note.id)]).toBe(`${LOCAL}/actor#main-key`)
		expect(await quoteOf(t, note.id)).toBeUndefined()
		expect(await recorded(t, 'Accept')).toEqual([])
	})

	it('shows the quoting status of a grouped quote notification, in the page and the group', async () => {
		const { t, bob, mine } = await world()
		const { note } = await accepted(t, bob, mine.uri)
		const quoting = await statusId(t, note.id)
		const page = (
			await t.api<{ notification_groups: { group_key: string; type: string; status_id?: string }[] }>(
				'/api/v2/notifications'
			)
		).body
		const group = page.notification_groups.find((g) => g.type === 'quote')
		expect(group?.status_id).toBe(quoting)
		const detail = (
			await t.api<{ notification_groups: { status_id?: string }[] }>(
				`/api/v2/notifications/${encodeURIComponent(group!.group_key)}`
			)
		).body
		expect(detail.notification_groups[0]?.status_id).toBe(quoting)
	})

	it('fetches the instrument as the quoted author, so a Note served to them alone is answered', async () => {
		const { t, bob, mine } = await world()
		const note = quoteNote(t, bob, mine.uri, { to: [ALICE_URI], cc: [] })
		t.web.signedOnly.set(note.id, `${ALICE_URI}#main-key`)
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202)
		expect(await quoteOf(t, note.id)).toMatchObject({ state: 'accepted' })
		expect(t.web.signers[t.web.fetched.lastIndexOf(note.id)]).toBe(`${ALICE_URI}#main-key`)
	})
})

describe('receipts and signers: a given-up Create, operator retries, suspended accounts', () => {
	// Delivery rounds where a Create fails for good (400) and everything else is taken (202); returns what was taken.
	async function failingCreates(t: Setup): Promise<Record<string, unknown>[]> {
		const taken: Record<string, unknown>[] = []
		await deliver(t, (url, body) => {
			const activity = JSON.parse(body) as Record<string, unknown>
			if (activity.type === 'Create') {
				return 400
			}
			if (url.startsWith(MASTODON)) {
				taken.push(activity)
			}
			return 202
		})
		return taken
	}

	it('counts no delivered Update as holding the status: after a given-up Create, the next edit pairs again', async () => {
		const { t, bob, mine } = await world()
		expect(await t.post(bob, follow(bob))).toBe(202)
		await deliver(t)
		const taken: Record<string, unknown>[] = []
		await edit(t, mine.id, 'V2')
		taken.push(...(await failingCreates(t)))
		expect(taken.map((a) => a.type)).toEqual(['Update'])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM outbound_receipts')).toEqual([{ n: 0 }])
		await edit(t, mine.id, 'V3')
		// The given-up Create of V2 is dropped for the pair of V3: an operator retry cannot install V2 later.
		expect((await deliveries(t)).filter((d) => d.state === 'gave_up')).toEqual([])
		taken.push(...(await sentTo(t, MASTODON)))
		expect(holdsAfter(taken, mine.uri, null)).toBe('<p>V3</p>')
	})

	it('ends at the current version when an operator retries a given-up Create before any further edit', async () => {
		const { t, bob, mine } = await world()
		expect(await t.post(bob, follow(bob))).toBe(202)
		await deliver(t)
		await edit(t, mine.id, 'V2')
		const taken = await failingCreates(t)
		const given = (await deliveries(t)).find((d) => d.type === 'Create' && d.state === 'gave_up')
		expect(given).toBeDefined()
		expect(await t.store.retryDeliveries(BUILD, { ids: [given!.id], now: NOW })).toMatchObject({ ok: true })
		taken.push(...(await sentTo(t, MASTODON)))
		expect(holdsAfter(taken, mine.uri, null)).toBe('<p>V2</p>')
		// Its delivery is the receipt: the next edit is an Update alone.
		await edit(t, mine.id, 'V3')
		expect((await sentTo(t, MASTODON)).map((a) => a.type)).toEqual(['Update'])
	})

	it('never signs a fetch for a personal inbox with a suspended recipient’s key', async () => {
		const { t, bob } = await world()
		await sql(
			t.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			'2026-10-12T00:00:00.000Z',
			ALICE
		)
		const note = mastodonNote(bob, { to: [ALICE_URI], cc: [] })
		t.web.serve(note.id, { '@context': AS, ...note })
		const activity = { '@context': AS, id: `${note.id}/activity`, type: 'Create', actor: bob.uri, object: note.id }
		expect(await t.post(bob, activity, { path: '/ap/users/alice/inbox' })).toBe(202)
		const signer = t.web.signers[t.web.fetched.lastIndexOf(note.id)]
		expect(signer).toBeDefined()
		expect(signer).not.toBe(`${ALICE_URI}#main-key`)
	})
})

describe('concurrency (design, Concurrency (PR 2): the test table)', () => {
	it('1a: a revoke while the Accept is being POSTed: the lane gets Accept, Delete, Reject in order; the stamp is gone', async () => {
		const { t, bob, mine } = await world()
		const { note, stamp: result, authorization, request } = await accepted(t, bob, mine.uri)
		const quoting = await statusId(t, note.id)
		const acceptHeld = deferred()
		const gate = deferred()
		const order: string[] = []
		const delivering = deliver(t, async (_url, body) => {
			const activity = JSON.parse(body) as { type: string }
			if (activity.type === 'Accept' && order.length === 0) {
				acceptHeld.resolve()
				await gate.promise
			}
			order.push(activity.type)
			return 202
		})
		await acceptHeld.promise
		expect((await revoke(t, mine.id, quoting)).status).toBe(200)
		gate.resolve()
		await delivering
		await deliver(t, (_url, body) => {
			order.push((JSON.parse(body) as { type: string }).type)
			return 202
		})
		// bob's server gets the Accept, then the Delete (its personal and its shared copy), then the Reject of the request.
		expect(order).toEqual(['Accept', 'Delete', 'Delete', 'Reject'])
		expect((await stamp(t, result)).status).toBe(404)
		expect(await sql(t.store, 'SELECT authorization, actor_uri, pending FROM quote_revocations')).toEqual([
			{ authorization, actor_uri: ALICE_URI, pending: 0 },
		])
	})

	it('1a: an Accept given up before the revoke is superseded: an operator retry never resends it', async () => {
		const { t, bob, mine } = await world()
		const { note } = await accepted(t, bob, mine.uri)
		await deliver(t, () => 400)
		const [given] = await deliveries(t)
		expect(given).toMatchObject({ type: 'Accept', state: 'gave_up' })
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		const retried = await t.store.retryDeliveries(BUILD, { ids: [given!.id], now: NOW })
		expect(retried).toEqual({ ok: false, code: 'superseded', ids: [given!.id] })
	})

	it('1b: a quote revoked while its request fetches the instrument is accepted again, with a new authorization', async () => {
		const { t, bob, mine } = await world()
		const first = await accepted(t, bob, mine.uri)
		expect((await revoke(t, mine.id, await statusId(t, first.note.id))).status).toBe(200)
		const note = quoteNote(t, bob, mine.uri)
		const held = t.web.hold(note.id)
		const answering = t.post(bob, quoteRequest(bob, mine.uri, note.id))
		await held.reached
		// Meanwhile the Note is delivered (a pending quote) and its author revokes it (rejected).
		expect(await t.post(bob, create(bob, note), { path: '/ap/users/alice/inbox' })).toBe(202)
		expect(await quoteOf(t, note.id)).toMatchObject({ state: 'pending', authorization_id: null })
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		expect(await quoteOf(t, note.id)).toMatchObject({ state: 'rejected' })
		held.release()
		expect(await answering).toBe(202)
		const again = await quoteOf(t, note.id)
		expect(again).toMatchObject({ state: 'accepted' })
		expect(again?.authorization_id).not.toBe(first.authorization)
		// A later request re-accepts the first quote too, with an id that differs from both (VIS-28: never reused).
		expect(await t.post(bob, quoteRequest(bob, mine.uri, first.note.id))).toBe(202)
		const third = await quoteOf(t, first.note.id)
		expect(third).toMatchObject({ state: 'accepted' })
		expect(new Set([first.authorization, again?.authorization_id, third?.authorization_id]).size).toBe(3)
		expect((await stamp(t, first.stamp)).status).toBe(404)
	})

	it('2: two copies of one request answer once; another id is answered with the same stamp; old or capped ones are refused', async () => {
		const { t, bob, mine } = await world()
		const note = quoteNote(t, bob, mine.uri)
		const request = quoteRequest(bob, mine.uri, note.id)
		const one = t.web.hold(note.id)
		const two = t.web.hold(note.id)
		const first = t.post(bob, request)
		const second = t.post(bob, request)
		await Promise.all([one.reached, two.reached])
		one.release()
		expect(await first).toBe(202)
		two.release()
		expect(await second).toBe(202)
		const authorization = (await quoteOf(t, note.id))!.authorization_id
		expect((await recorded(t, 'Accept')).length).toBe(1)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM quote_requests')).toEqual([{ n: 1 }])
		expect(await sql(t.store, "SELECT count(*) AS n FROM notifications WHERE type = 'quote'")).toEqual([{ n: 1 }])
		// A new id for the accepted quote: the same stamp, nothing else.
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202)
		const accepts = await recorded(t, 'Accept')
		expect(accepts.map((a) => a.result)).toEqual([accepts[0]!.result, accepts[0]!.result])
		expect((await quoteOf(t, note.id))!.authorization_id).toBe(authorization)
		expect(await sql(t.store, "SELECT count(*) AS n FROM notifications WHERE type = 'quote'")).toEqual([{ n: 1 }])
		// A replay signed outside the 1 h window is refused before the Store.
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id), { at: NOW - 2 * 60 * 60 * 1000 })).toBe(401)
		// At the per-actor cap a new request is refused for a retry, and no live row is evicted.
		const live = MAX_QUOTE_REQUESTS_PER_ACTOR - 2
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO quote_requests (activity_uri, actor_uri, instrument_uri, quoted_status_id, answered_at)
			SELECT ?2 || '/quote_requests/filler-' || i, ?2, ?3, ?4, ?5 FROM n`,
			live,
			bob.uri,
			note.id,
			mine.id,
			NOW
		)
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(503)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM quote_requests WHERE actor_uri = ?', bob.uri)).toEqual([
			{ n: MAX_QUOTE_REQUESTS_PER_ACTOR },
		])
	})

	it('3c/3d: an Update that moves the quote meanwhile gets no Accept; one that drops it after acceptance retires the stamp', async () => {
		const { t, bob, mine } = await world()
		const other = await localStatus(t, { status: 'other', visibility: 'public' })
		const note = quoteNote(t, bob, mine.uri)
		const held = t.web.hold(note.id)
		const answering = t.post(bob, quoteRequest(bob, mine.uri, note.id))
		await held.reached
		expect(await t.post(bob, create(bob, note), { path: '/ap/users/alice/inbox' })).toBe(202)
		const moved = { ...note, quote: other.uri, _misskey_quote: other.uri, quoteUri: other.uri }
		expect(await t.post(bob, update(bob, moved, '2026-10-11T13:00:00Z'), { path: '/ap/users/alice/inbox' })).toBe(202)
		held.release()
		expect(await answering).toBe(202)
		expect(await recorded(t, 'Accept')).toEqual([])
		expect(await quoteOf(t, note.id)).toMatchObject({ state: 'pending', authorization_id: null })
		// After acceptance, an Update with no quote retires the authorization, and sends nothing (decision 3).
		const second = await accepted(t, bob, mine.uri)
		const dropped = { ...second.note, quote: undefined, _misskey_quote: undefined, quoteUri: undefined }
		const before = (await deliveries(t)).length
		expect(await t.post(bob, update(bob, dropped as Note, '2026-10-11T14:00:00Z'))).toBe(202)
		expect(await quoteOf(t, second.note.id)).toBeUndefined()
		expect((await stamp(t, second.stamp)).status).toBe(404)
		expect(await sql(t.store, 'SELECT authorization FROM quote_revocations')).toEqual([
			{ authorization: second.authorization },
		])
		expect((await deliveries(t)).length).toBe(before)
	})

	it('4: a Delete of the quoting status meanwhile leaves the request unanswered; after acceptance it retires the stamp before its batches end', async () => {
		const { t, bob, mine } = await world()
		const note = quoteNote(t, bob, mine.uri)
		const held = t.web.hold(note.id)
		const answering = t.post(bob, quoteRequest(bob, mine.uri, note.id))
		await held.reached
		expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		held.release()
		expect(await answering).toBe(202)
		expect(await recorded(t, 'Accept')).toEqual([])
		// After acceptance: a Delete whose first batch cannot finish (600 mentions to remove) retires the stamp at once.
		const second = await accepted(t, bob, mine.uri)
		const quoting = await statusId(t, second.note.id)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
			INSERT INTO accounts (id, uri, username, domain) SELECT CAST(900000000000000000 + i AS TEXT),
				'https://filler.example/u/' || i, 'u' || i, 'filler.example' FROM n`
		)
		await sql(
			t.store,
			`INSERT INTO status_mentions (status_id, account_id, silent)
			SELECT ?, id, 1 FROM accounts WHERE domain = 'filler.example'`,
			quoting
		)
		expect(await t.post(bob, remove(bob, second.note.id))).toBe(202)
		expect(
			await sql(t.store, "SELECT count(*) AS n FROM inbound_jobs WHERE kind = 'delete' AND done_at IS NULL")
		).toEqual([{ n: 1 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', quoting)).toEqual([{ n: 1 }])
		expect((await stamp(t, second.stamp)).status).toBe(404)
		expect(await sql(t.store, 'SELECT authorization FROM quote_revocations')).toEqual([
			{ authorization: second.authorization },
		])
		expect(await sql(t.store, 'SELECT quotes_count FROM statuses WHERE id = ?', mine.id)).toEqual([{ quotes_count: 0 }])
	})

	it('5 and quoters’ reach: a quoter with no other relation receives the quoted status’s edit and deletion', async () => {
		const { t, bob, mine } = await world()
		const { authorization } = await accepted(t, bob, mine.uri)
		await deliver(t)
		const edited = await t.request(`/api/v1/statuses/${mine.id}`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'quote me, edited' }),
		})
		expect(edited.status).toBe(200)
		const reached = async (type: string) =>
			(await deliveries(t)).filter((d) => d.type === type && d.object_uri === mine.uri).map((d) => d.inbox)
		// bob's server fetched the status to quote it (no receipt), and ends with the edited version.
		expect(holdsAfter(await sentTo(t, MASTODON), mine.uri)).toBe('<p>quote me, edited</p>')
		const deleted = await t.request(`/api/v1/statuses/${mine.id}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${t.tokens.alice}` },
		})
		expect(deleted.status).toBe(200)
		expect(new Set(await reached('Delete'))).toEqual(new Set([`${bob.uri}/inbox`]))
		expect(await sql(t.store, 'SELECT authorization FROM quote_revocations')).toEqual([{ authorization }])
		expect(await sql(t.store, 'SELECT state, authorization_id FROM quotes')).toEqual([
			{ state: 'deleted', authorization_id: null },
		])
	})

	it('6: a policy change or a block meanwhile is read by the final round: Reject, no change; a later change keeps an accepted quote', async () => {
		const { t, bob, mine } = await world()
		const note = quoteNote(t, bob, mine.uri)
		const held = t.web.hold(note.id)
		const answering = t.post(bob, quoteRequest(bob, mine.uri, note.id))
		await held.reached
		await t.request(`/api/v1/statuses/${mine.id}/interaction_policy`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
			body: JSON.stringify({ quote_approval_policy: 'nobody' }),
		})
		held.release()
		expect(await answering).toBe(202)
		expect((await recorded(t, 'Reject')).length).toBe(1)
		expect(await recorded(t, 'Accept')).toEqual([])
		expect(await quoteOf(t, note.id)).toBeUndefined()
		// A change after acceptance writes no quote: it stays accepted and its stamp is served.
		const later = await localStatus(t, { status: 'later', visibility: 'public' })
		const { note: quote, stamp: result } = await accepted(t, bob, later.uri)
		await t.request(`/api/v1/statuses/${later.id}/interaction_policy`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
			body: JSON.stringify({ quote_approval_policy: 'nobody' }),
		})
		expect(await quoteOf(t, quote.id)).toMatchObject({ state: 'accepted' })
		expect((await stamp(t, result)).status).toBe(200)
	})

	it('9: the stamp read is entirely before or after a revoke', async () => {
		const { t, bob, mine } = await world()
		const { note, stamp: result } = await accepted(t, bob, mine.uri)
		const quoting = await statusId(t, note.id)
		const [read, revoked] = await Promise.all([stamp(t, result), revoke(t, mine.id, quoting)])
		expect(revoked.status).toBe(200)
		expect(read.cache).toBe('no-store')
		expect([200, 404]).toContain(read.status)
		if (read.status === 200) {
			expect(read.body).toMatchObject({ id: result, interactingObject: note.id, interactionTarget: mine.uri })
		}
		expect(await stamp(t, result)).toEqual({ status: 404, cache: 'no-store', body: null })
	})

	it('11: two revokes prepared together record one envelope; a quote retired during preparation records nothing', async () => {
		const { t, bob, mine } = await world()
		const { note } = await accepted(t, bob, mine.uri)
		const quoting = await statusId(t, note.id)
		const credential = { tokenHash: await sha256Hex(t.tokens.alice), scope: 'write:statuses' as const, now: NOW }
		const target = { credential, id: mine.id, quotingId: quoting }
		const prepare = async () => {
			const prepared = await t.store.prepareRevoke(BUILD, target)
			if (prepared.status !== 'ok' || prepared.value.status !== 'ok') {
				throw new Error('not prepared')
			}
			const { authorization, sign } = prepared.value.value
			return { expected: authorization, signed: await signAsAuthor(LEGACY_EMPTY_KEK.kek, sign!) }
		}
		const [a, b] = await Promise.all([prepare(), prepare()])
		const record = (p: typeof a) => t.store.revokeQuote(BUILD, { ...target, ...p, now: NOW, present: PRESENT })
		const results = await Promise.all([record(a), record(b)])
		expect(results.map((r) => r.status === 'ok' && r.value.status)).toEqual(['ok', 'ok'])
		expect((await recorded(t, 'Delete')).length).toBe(1)
		// Retired between preparation and recording (the quoting status's Delete): nothing is recorded.
		const second = await accepted(t, bob, mine.uri)
		const other = { ...target, quotingId: await statusId(t, second.note.id) }
		const prepared = await t.store.prepareRevoke(BUILD, other)
		if (prepared.status !== 'ok' || prepared.value.status !== 'ok') {
			throw new Error('not prepared')
		}
		const signed = await signAsAuthor(LEGACY_EMPTY_KEK.kek, prepared.value.value.sign!)
		expect(await t.post(bob, remove(bob, second.note.id))).toBe(202)
		const before = await sql(t.store, 'SELECT count(*) AS n FROM outbound_activities')
		const late = await t.store.revokeQuote(BUILD, {
			...other,
			expected: prepared.value.value.authorization,
			signed,
			now: NOW,
			present: PRESENT,
		})
		expect(late.status === 'ok' && late.value.status).not.toBe('stale')
		expect(await sql(t.store, 'SELECT count(*) AS n FROM outbound_activities')).toEqual(before)
		expect((await recorded(t, 'Delete')).filter((d) => d.actor === ALICE_URI).length).toBe(1)
	})

	it('12: a verification round never decides a quote of a local status; a late outcome is discarded', async () => {
		const { t, bob, mine } = await world()
		const note = quoteNote(t, bob, mine.uri)
		expect(await t.post(bob, create(bob, note), { path: '/ap/users/alice/inbox' })).toBe(202)
		const quoting = await statusId(t, note.id)
		// No work: no round claims it (Defaults 7).
		expect(await sql(t.store, 'SELECT verify_after FROM quotes WHERE status_id = ?', quoting)).toEqual([
			{ verify_after: null },
		])
		// A round that held it anyway (work made due by hand) and finishes after the acceptance changes nothing.
		await sql(t.store, 'UPDATE quotes SET verify_after = ? WHERE status_id = ?', NOW, quoting)
		const claim = await t.store.claimQuotes(BUILD, { now: NOW, limit: 10 })
		expect(claim.ids).toEqual([quoting])
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202)
		const authorization = (await quoteOf(t, note.id))!.authorization_id
		await t.store.completeQuote(BUILD, {
			statusId: quoting,
			now: NOW,
			origin: LOCAL,
			quotedUri: mine.uri,
			approvalUri: null,
			generation: claim.generations[0]!,
			stage: 'decide',
			fetch: null,
		})
		expect(await quoteOf(t, note.id)).toMatchObject({ state: 'accepted', authorization_id: authorization })
		// The same after a revoke: it stays revoked.
		expect((await revoke(t, mine.id, quoting)).status).toBe(200)
		await t.store.completeQuote(BUILD, {
			statusId: quoting,
			now: NOW,
			origin: LOCAL,
			quotedUri: mine.uri,
			approvalUri: null,
			generation: claim.generations[0]!,
			stage: 'decide',
			fetch: null,
		})
		expect(await quoteOf(t, note.id)).toMatchObject({ state: 'revoked', authorization_id: null })
	})

	it('8 and 15: a second revoke sends nothing; re-acceptance keeps one quote notification', async () => {
		const { t, bob, mine } = await world()
		const { note } = await accepted(t, bob, mine.uri)
		const quoting = await statusId(t, note.id)
		expect((await revoke(t, mine.id, quoting)).status).toBe(200)
		const after = (await deliveries(t)).length
		expect((await revoke(t, mine.id, quoting)).status).toBe(200)
		expect((await deliveries(t)).length).toBe(after)
		expect((await recorded(t, 'Delete')).length).toBe(1)
		expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202)
		expect(await quoteOf(t, note.id)).toMatchObject({ state: 'accepted' })
		expect(await sql(t.store, "SELECT count(*) AS n FROM notifications WHERE type = 'quote'")).toEqual([{ n: 1 }])
	})
})

describe('revoke (QuotesController#revoke, RevokeQuoteService)', () => {
	it('rejects every request answered for the quote, after the Delete, and a receiver applying the Delete first ends rejected', async () => {
		const { t, bob, mine } = await world()
		const { note, request: r1, stamp: result } = await accepted(t, bob, mine.uri)
		const r2 = quoteRequest(bob, mine.uri, note.id)
		expect(await t.post(bob, r2)).toBe(202)
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		const sent = await sentTo(t, `${MASTODON}/inbox`)
		expect(sent.map(label)).toEqual([
			`Accept ${r1.id}`,
			`Accept ${r2.id}`,
			`Delete ${result}`,
			`Reject ${r1.id}`,
			`Reject ${r2.id}`,
		])
		expect(mastodonReceiver(r2.id, sent)).toMatchObject({ state: 'revoked', approval: result })
	})

	it('delivers the Rejects as retractions: past a full lane and after the revoker’s suspension', async () => {
		const { t, bob, mine } = await world()
		const { note, stamp: result } = await accepted(t, bob, mine.uri)
		const r2 = quoteRequest(bob, mine.uri, note.id)
		expect(await t.post(bob, r2)).toBe(202)
		const earlier = await sentTo(t, MASTODON)
		// alice's lane to bob's server is full (MAX_LANE_BACKLOG active rows) when she revokes.
		await sql(
			t.store,
			`INSERT INTO outbound_activities (account_id, body, object_uri, retracts, created_at)
			VALUES (?, '{"activity":{"type":"Like"},"audience":{"followers":false,"accounts":[]}}', 'filler', 0, ?)`,
			ALICE,
			NOW
		)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
			INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, next_attempt_at, updated_at)
			SELECT (SELECT id FROM outbound_activities WHERE object_uri = 'filler'), ?1, ?2 || '/inbox', ?2, 'queued', ?4, ?4
			FROM n`,
			ALICE,
			MASTODON,
			MAX_LANE_BACKLOG,
			NOW
		)
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		const rejects = (await deliveries(t)).filter((d) => d.type === 'Reject')
		expect(rejects).toHaveLength(2)
		expect(rejects.filter((d) => d.state === 'gave_up')).toEqual([])
		// The filler goes; the lane's next row becomes its head, as a settled head promotes it.
		await sql(t.store, "DELETE FROM outbound_activities WHERE object_uri = 'filler'")
		await sql(
			t.store,
			"UPDATE deliveries SET state = 'pending' WHERE id = (SELECT min(id) FROM deliveries WHERE account_id = ? AND state = 'queued')",
			ALICE
		)
		// alice is suspended before anything more is delivered (design, Concurrency row 17): the retractions still go.
		await sql(
			t.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			'2026-10-12T00:00:00.000Z',
			ALICE
		)
		const sent = await sentTo(t, MASTODON)
		expect(sent.map(label)).toEqual([
			`Delete ${result}`,
			...earlier.filter((a) => a.type === 'Accept').map((a) => `Reject ${(a.object as { id: string }).id}`),
		])
		// A receiver that applies the Delete before the Accept of R2 still ends rejected.
		expect(mastodonReceiver(r2.id, [...earlier, ...sent])).toMatchObject({ state: 'revoked', approval: result })
	})

	it('rejects the live requests only: expired rows the sweep has not removed never crowd out the current one', async () => {
		const { t, bob, mine } = await world()
		const { note, request } = await accepted(t, bob, mine.uri)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO quote_requests (activity_uri, actor_uri, instrument_uri, quoted_status_id, answered_at)
			SELECT ?2 || '/quote_requests/expired-' || i, ?2, ?3, ?4, ?5 FROM n`,
			MAX_QUOTE_REQUESTS_PER_ACTOR,
			bob.uri,
			note.id,
			mine.id,
			NOW - RETRACTION_TTL_MS - 1
		)
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		expect((await recorded(t, 'Reject')).map((r) => r.object)).toEqual([request.id])
	})

	it('signs the Delete once: every destination receives the same bytes, and they verify as the author’s', async () => {
		const { t, bob, mine } = await world()
		// carol follows alice, so the Delete reaches the quoted status's audience too (a neutral copy at her shared inbox).
		const carol = await mastodonActor(t.web, 'carol', { origin: 'https://other.example', key: 2 })
		await t.post(carol, {
			'@context': AS,
			id: `${carol.uri}#follows/${nextId()}`,
			type: 'Follow',
			actor: carol.uri,
			object: ALICE_URI,
		})
		const { note, stamp: result } = await accepted(t, bob, mine.uri)
		await deliver(t)
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		const bodies = new Map<string, string>()
		await deliver(t, (url, body) => {
			if ((JSON.parse(body) as { type: string }).type === 'Delete') {
				bodies.set(url, body)
			}
			return 202
		})
		// bob's personal copy (the quoter, also in the quoted status's reach) and carol's neutral one (a follower).
		expect([...bodies.keys()].sort()).toEqual([`${MASTODON}/users/bob/inbox`, 'https://other.example/inbox'])
		expect(new Set(bodies.values()).size).toBe(1)
		const signed = JSON.parse([...bodies.values()][0]!) as Record<string, unknown>
		expect(signed).toMatchObject({
			type: 'Delete',
			actor: ALICE_URI,
			object: result,
			to: [`${AS}#Public`],
			signature: { type: 'RsaSignature2017', creator: `${ALICE_URI}#main-key` },
		})
		const alice = {
			'@context': [AS, 'https://w3id.org/security/v1'],
			id: ALICE_URI,
			type: 'Person',
			inbox: `${ALICE_URI}/inbox`,
			publicKey: { id: `${ALICE_URI}#main-key`, owner: ALICE_URI, publicKeyPem: LEGACY_EMPTY_KEK.pubkey },
		}
		const documentLoader: DocumentLoader = (url) =>
			Promise.resolve({ document: alice, documentUrl: url, contextUrl: null })
		expect(await verifyJsonLd(signed, { documentLoader, contextLoader: contexts })).toBe(true)
		expect(await verifyJsonLd({ ...signed, object: `${result}0` }, { documentLoader, contextLoader: contexts })).toBe(
			false
		)
	})

	it('answers 404, 404 and 403 as QuotesController does', async () => {
		const { t, bob, mine } = await world()
		const { note } = await accepted(t, bob, mine.uri)
		const quoting = await statusId(t, note.id)
		const secret = await localStatus(t, { status: 'secret', visibility: 'private' })
		expect((await revoke(t, secret.id, quoting, 'dave')).status).toBe(404)
		expect((await revoke(t, mine.id, mine.id)).status).toBe(404)
		expect((await revoke(t, mine.id, quoting, 'dave')).status).toBe(403)
		expect(await quoteOf(t, note.id)).toMatchObject({ state: 'accepted' })
	})

	it('answers a redacted Status within the bound of a uri, whatever the quoting status stores', async () => {
		const { t, bob, mine } = await world()
		const { note } = await accepted(t, bob, mine.uri)
		const quoting = await statusId(t, note.id)
		const bobId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', bob.uri))[0]!.id
		// A converted row may hold a uri past the bound the Worker stores (4,096 bytes).
		await sql(
			t.store,
			"UPDATE statuses SET visibility = 'limited', uri = ? WHERE id = ?",
			`${note.id}/${'x'.repeat(4096)}`,
			quoting
		)
		await sql(
			t.store,
			'INSERT INTO blocks (account_id, target_account_id, created_at) VALUES (?, ?, ?)',
			bobId,
			ALICE,
			'2026-10-12T00:00:00.000Z'
		)
		const { status, body } = await revoke(t, mine.id, quoting)
		expect(status).toBe(200)
		expect(body).toMatchObject({ id: quoting, uri: '', url: '' })
	})

	it('answers a revoker the quoting author blocks with a redacted Status that Android decodes', async () => {
		const { t, bob, mine } = await world()
		const { note } = await accepted(t, bob, mine.uri)
		const quoting = await statusId(t, note.id)
		const bobId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', bob.uri))[0]!.id
		await sql(t.store, "UPDATE statuses SET visibility = 'limited' WHERE id = ?", quoting)
		await sql(
			t.store,
			'INSERT INTO blocks (account_id, target_account_id, created_at) VALUES (?, ?, ?)',
			bobId,
			ALICE,
			'2026-10-12T00:00:00.000Z'
		)
		const { status, body } = await revoke(t, mine.id, quoting)
		expect(status).toBe(200)
		expect(Object.keys(body).sort()).toEqual(
			[
				'account',
				'bookmarked',
				'card',
				'content',
				'created_at',
				'edited_at',
				'emojis',
				'favourited',
				'favourites_count',
				'filtered',
				'id',
				'in_reply_to_account_id',
				'in_reply_to_id',
				'language',
				'media_attachments',
				'mentions',
				'muted',
				'poll',
				'quote',
				'quote_approval',
				'quotes_count',
				'reblog',
				'reblogged',
				'reblogs_count',
				'replies_count',
				'sensitive',
				'spoiler_text',
				'tags',
				'uri',
				'url',
				'visibility',
			].sort()
		)
		expect(body).toEqual({
			id: quoting,
			created_at: '2026-10-11T12:00:00.000Z',
			in_reply_to_id: null,
			in_reply_to_account_id: null,
			sensitive: false,
			spoiler_text: '',
			visibility: 'private',
			language: null,
			uri: note.id,
			url: note.id,
			replies_count: 0,
			reblogs_count: 0,
			favourites_count: 0,
			quotes_count: 0,
			edited_at: null,
			favourited: false,
			reblogged: false,
			muted: false,
			bookmarked: false,
			filtered: [],
			content: '',
			reblog: null,
			account: expect.objectContaining({ id: bobId, username: 'bob', acct: 'bob@mastodon.example' }),
			media_attachments: [],
			mentions: [],
			tags: [],
			emojis: [],
			quote: { state: 'revoked', quoted_status: null },
			quote_approval: null,
			card: null,
			poll: null,
		})
		// Android's required Account fields are all there.
		for (const field of ['id', 'username', 'acct', 'url', 'display_name', 'note', 'avatar', 'header', 'created_at']) {
			expect((body.account as Record<string, unknown>)[field], field).not.toBeNull()
		}
		// A revoker who may see the quoting status gets it as presented.
		const viewable = await revoke(t, mine.id, quoting)
		expect(viewable.body.id).toBe(quoting)
	})

	it('records Rejects bounded by the per-actor cap, however many rows name the quote', async () => {
		const { t, bob, mine } = await world()
		const { note } = await accepted(t, bob, mine.uri)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO quote_requests (activity_uri, actor_uri, instrument_uri, quoted_status_id, answered_at)
			SELECT ?2 || '/quote_requests/filler-' || i, ?2, ?3, ?4, ?5 FROM n`,
			2 * MAX_QUOTE_REQUESTS_PER_ACTOR,
			bob.uri,
			note.id,
			mine.id,
			NOW
		)
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		expect((await recorded(t, 'Reject')).length).toBe(MAX_QUOTE_REQUESTS_PER_ACTOR)
	})
})

describe('the stamp endpoint (QuoteAuthorizationsController)', () => {
	it('answers 404 for anything but the current authorization of an available author’s public or unlisted status', async () => {
		const { t, bob, mine } = await world()
		const { stamp: result, authorization } = await accepted(t, bob, mine.uri)
		const path = (username: string, id: string) => `${LOCAL}/ap/users/${username}/quote_authorizations/${id}`
		expect((await stamp(t, result)).status).toBe(200)
		expect((await stamp(t, path('dave', authorization))).status).toBe(404)
		expect((await stamp(t, path('alice', '0'.repeat(32)))).status).toBe(404)
		expect((await stamp(t, path('alice', 'not-an-id'))).status).toBe(404)
		await sql(t.store, "UPDATE statuses SET visibility = 'private' WHERE id = ?", mine.id)
		expect((await stamp(t, result)).status).toBe(404)
		await sql(t.store, "UPDATE statuses SET visibility = 'unlisted' WHERE id = ?", mine.id)
		expect((await stamp(t, result)).status).toBe(200)
		await sql(
			t.store,
			'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
			'2026-10-12T00:00:00.000Z',
			ALICE
		)
		expect((await stamp(t, result)).status).toBe(404)
		await sql(t.store, 'UPDATE local_accounts SET suspended_at = NULL WHERE account_id = ?', ALICE)
		// Recorded as retired, though the row still holds it (as no path leaves it): never served again.
		await sql(
			t.store,
			'INSERT INTO quote_revocations (authorization, actor_uri, revoked_at) VALUES (?, ?, ?)',
			authorization,
			ALICE_URI,
			NOW
		)
		expect((await stamp(t, result)).status).toBe(404)
		expect(DAVE).toBeDefined()
	})
})

describe('revoke Rejects bind the quoting author; the stamp hides during a purge', () => {
	it('rejects on revoke only the quoting author’s requests: a third party naming the quote’s status changes nothing', async () => {
		const { t, bob, mine } = await world()
		const { note, request } = await accepted(t, bob, mine.uri)
		// carol, whom alice blocks, asks to quote alice's status with bob's Note as her instrument: refused, and recorded
		// under carol alone.
		const carol = await mastodonActor(t.web, 'carol', { origin: 'https://other.example', key: 2 })
		await t.post(carol, quoteRequest(carol, `${LOCAL}/ap/o/none`, 'x'))
		const carolId = (await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', carol.uri))[0]!.id
		await sql(
			t.store,
			'INSERT INTO blocks (account_id, target_account_id, created_at) VALUES (?, ?, ?)',
			ALICE,
			carolId,
			'2026-10-12T00:00:00.000Z'
		)
		const third = quoteRequest(carol, mine.uri, note.id)
		expect(await t.post(carol, third)).toBe(202)
		expect(await sql(t.store, 'SELECT actor_uri FROM quote_requests WHERE activity_uri = ?', third.id)).toEqual([
			{ actor_uri: carol.uri },
		])
		// An unrefused third party naming bob's Note is not answered at all (the instrument is not hers).
		await sql(t.store, 'DELETE FROM blocks')
		const unanswered = quoteRequest(carol, mine.uri, note.id)
		expect(await t.post(carol, unanswered)).toBe(202)
		expect(
			await sql(t.store, 'SELECT count(*) AS n FROM quote_requests WHERE activity_uri = ?', unanswered.id)
		).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM quote_requests WHERE actor_uri = ?', bob.uri)).toEqual([
			{ n: 1 },
		])
		await deliver(t)
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		const rejects: string[] = []
		await deliver(t, (_url, body) => {
			const activity = JSON.parse(body) as { type: string; object: unknown }
			if (activity.type === 'Reject') {
				rejects.push(idOf(activity.object))
			}
			return 202
		})
		expect(rejects).toEqual([request.id])
	})

	it('stops serving the stamp as soon as the quoting author’s purge starts', async () => {
		const { t, bob, mine } = await world()
		const { stamp: result } = await accepted(t, bob, mine.uri)
		expect((await stamp(t, result)).status).toBe(200)
		await sql(
			t.store,
			"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('purge', ?1, ?1, ?2)",
			bob.uri,
			NOW
		)
		expect((await stamp(t, result)).status).toBe(404)
	})
})

describe('delivery subjects', () => {
	it('names an Accept of a QuoteRequest by its stamp, and leaves a Follow’s Accept and the status’s receipts alone', async () => {
		const { t, bob, mine } = await world()
		const follow = `${bob.uri}#follows/${nextId()}`
		expect(await t.post(bob, { '@context': AS, id: follow, type: 'Follow', actor: bob.uri, object: ALICE_URI })).toBe(
			202
		)
		const { note, stamp: result } = await accepted(t, bob, mine.uri)
		expect((await deliveries(t)).map((d) => [d.type, d.object_uri])).toEqual([
			['Accept', follow],
			['Accept', result],
		])
		await deliver(t)
		// The Accept leaves no receipt; the status's own receipts (from a delivered Create) stay through the revoke.
		const edited = await t.request(`/api/v1/statuses/${mine.id}`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'edited' }),
		})
		expect(edited.status).toBe(200)
		await deliver(t)
		const receipts = await sql(t.store, 'SELECT status_id, inbox_url FROM outbound_receipts ORDER BY inbox_url')
		expect(receipts.length).toBeGreaterThan(0)
		expect(new Set(receipts.map((r) => r.status_id))).toEqual(new Set([mine.id]))
		expect((await revoke(t, mine.id, await statusId(t, note.id))).status).toBe(200)
		expect(await sql(t.store, 'SELECT status_id, inbox_url FROM outbound_receipts ORDER BY inbox_url')).toEqual(
			receipts
		)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM follows WHERE uri = ?', follow)).toEqual([{ n: 1 }])
	})
})

describe('local Notes', () => {
	it('advertise the real policy, and a change of it sends an Update with no history entry', async () => {
		const t = await setup()
		const note = async (id: string, uri: string) => {
			const response = await t.request(new URL(uri).pathname, { headers: { accept: 'application/activity+json' } })
			expect(id).toBeDefined()
			return (await response.json()) as Record<string, unknown>
		}
		const pub = await localStatus(t, { status: 'public', visibility: 'public' })
		expect((await note(pub.id, pub.uri)).interactionPolicy).toEqual({
			canQuote: { automaticApproval: [`${AS}#Public`] },
		})
		const followers = await localStatus(t, { status: 'f', visibility: 'public', quote_approval_policy: 'followers' })
		expect((await note(followers.id, followers.uri)).interactionPolicy).toEqual({
			canQuote: { automaticApproval: [`${ALICE_URI}/followers`] },
		})
		const nobody = await localStatus(t, { status: 'n', visibility: 'public', quote_approval_policy: 'nobody' })
		expect((await note(nobody.id, nobody.uri)).interactionPolicy).toEqual({
			canQuote: { automaticApproval: [ALICE_URI] },
		})
		expect(JSON.stringify((await note(pub.id, pub.uri))['@context'])).toContain('gts:canQuote')
		// bob follows alice and holds her later status (its Create delivered), so a change reaches him as an Update.
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, {
			'@context': AS,
			id: `${bob.uri}#follows/${nextId()}`,
			type: 'Follow',
			actor: bob.uri,
			object: ALICE_URI,
		})
		const later = await localStatus(t, { status: 'later', visibility: 'public' })
		await deliver(t)
		const updates: Record<string, unknown>[] = []
		const capture = () =>
			deliver(t, (_url, body) => {
				const activity = JSON.parse(body) as Record<string, unknown>
				if (activity.type === 'Update') {
					updates.push(activity)
				}
				return 202
			})
		const policy = (value: string) =>
			t.request(`/api/v1/statuses/${later.id}/interaction_policy`, {
				method: 'PUT',
				headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
				body: JSON.stringify({ quote_approval_policy: value }),
			})
		expect((await policy('nobody')).status).toBe(200)
		await capture()
		// The same policy again changes nothing, and sends nothing.
		expect((await policy('nobody')).status).toBe(200)
		await capture()
		expect(updates).toHaveLength(1)
		expect(updates[0]).toMatchObject({
			object: { id: later.uri, interactionPolicy: { canQuote: { automaticApproval: [ALICE_URI] } } },
		})
		expect((updates[0]!.object as Record<string, unknown>).updated).toBeUndefined()
		expect(await sql(t.store, 'SELECT count(*) AS n FROM status_edits')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT edited_at FROM statuses WHERE id = ?', later.id)).toEqual([{ edited_at: null }])
		// An edit's quote_approval_policy alone does the same.
		const edit = await t.request(`/api/v1/statuses/${later.id}`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'later', quote_approval_policy: 'public' }),
		})
		expect(edit.status).toBe(200)
		await capture()
		expect(updates).toHaveLength(2)
		expect(updates[1]).toMatchObject({
			object: { id: later.uri, interactionPolicy: { canQuote: { automaticApproval: [`${AS}#Public`] } } },
		})
		expect(await sql(t.store, 'SELECT count(*) AS n FROM status_edits')).toEqual([{ n: 0 }])
	})
})
