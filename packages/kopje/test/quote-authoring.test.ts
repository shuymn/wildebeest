import { type DocumentLoader, signJsonLd, verifyJsonLd } from '@fedify/fedify'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { MASTODON, mastodonActor, type TestActor } from './inbox-helpers'
import {
	ALICE,
	ALICE_URI,
	AS,
	create,
	DAVE,
	followed,
	localStatus,
	mastodonNote,
	nextId,
	PUBLIC,
	remove,
	setup,
	type Setup,
	update,
} from './inbox-status-helpers'
import { contexts } from './quote-helpers'
import { outbound } from './status-helpers'
import { RETRACTION_TTL_MS } from '../src/domain/inbox'
import { MAX_QUOTED_UPDATES } from '../src/domain/quotes'
import { deliveryRound } from '../src/jobs/deliver'

// Authoring quotes (design §5.6 and "Concurrency (PR 3)", VIS-28, R35, R36): local users quoting local and remote
// statuses, with Mastodon's posting rules; the Note's quote properties; the quoted author's Accept and Reject of our
// QuoteRequest; their stamp Delete, revoking our quote and forwarded once when proven; quoted_update. Receivers are
// modelled as Mastodon 4.5.11, Kopje and Misskey apply what they receive. Interleavings use the operation queue, held
// delivery leases and the remote web's gates, never timers.

const FEP = 'https://w3id.org/fep/044f#QuoteRequest'
const NOT_FOUND = 'The post you are trying to quote does not appear to exist.'
const NOT_MENTIONED = 'Validation failed: Cannot quote a non-mentioned user in a Private Mention post.'

type Posted = {
	id: string
	uri: string
	url: string
	content: string
	visibility: string
	quote: { state: string; quoted_status: { id: string } | null } | null
}

async function postRaw(t: Setup, body: Record<string, unknown>, as: 'alice' | 'dave' = 'alice') {
	const response = await t.request('/api/v1/statuses', {
		method: 'POST',
		headers: { authorization: `Bearer ${t.tokens[as]}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function quotePost(t: Setup, quoted: string, body: Record<string, unknown> = {}, as: 'alice' | 'dave' = 'alice') {
	const answer = await postRaw(t, { status: 'look', ...body, quoted_status_id: quoted }, as)
	expect(answer.status, JSON.stringify(answer.body)).toBe(200)
	return answer.body as unknown as Posted
}

async function api(t: Setup, method: string, path: string, body?: unknown, as: 'alice' | 'dave' = 'alice') {
	const response = await t.request(path, {
		method,
		headers: { authorization: `Bearer ${t.tokens[as]}`, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function statusId(t: Setup, uri: string): Promise<string> {
	return (await sql<{ id: string }>(t.store, 'SELECT id FROM statuses WHERE uri = ?', uri))[0]!.id
}

type Row = {
	state: string
	local: number
	approval_uri: string | null
	authorization_id: string | null
	activity_uri: string | null
	quoted_status_id: string | null
	quoted_account_id: string | null
	verify_after: number | null
	hops: number
}

async function quoteRow(t: Setup, uri: string): Promise<Row | undefined> {
	return (
		await sql<Row>(
			t.store,
			`SELECT q.state, q.local, q.approval_uri, q.authorization_id, q.activity_uri, q.quoted_status_id,
				q.quoted_account_id, q.verify_after, q.hops
			FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?`,
			uri
		)
	)[0]
}

async function recorded(t: Setup, type?: string) {
	return (await outbound(t.store)).filter((row) => type === undefined || row.activity.type === type)
}

// A remote status by `actor`, delivered, stating `automatic` as who may quote it (none: no policy at all).
async function remoteStatus(t: Setup, actor: TestActor, automatic: string[] | null = [PUBLIC]) {
	const note = mastodonNote(
		actor,
		automatic === null ? {} : { interactionPolicy: { canQuote: { automaticApproval: automatic } } }
	)
	expect(await t.post(actor, create(actor, note))).toBe(202)
	t.web.serve(note.id, { '@context': AS, ...note })
	return { uri: note.id, id: await statusId(t, note.id), note }
}

// alice follows bob, a Mastodon account whose status says anyone may quote it; carol follows alice from mastodon.
async function world() {
	const t = await setup()
	const bob = await mastodonActor(t.web, 'bob')
	await followed(t, bob)
	const theirs = await remoteStatus(t, bob)
	return { t, bob, theirs }
}

function accept(actor: TestActor, quoting: string, result: string | null, extra: Record<string, unknown> = {}) {
	return {
		'@context': [AS, { QuoteRequest: FEP }],
		id: `${actor.uri}#accepts/quote_requests/${nextId()}`,
		type: 'Accept',
		actor: actor.uri,
		object: `${quoting}#quote-request`,
		...(result === null ? {} : { result }),
		...extra,
	}
}

function reject(actor: TestActor, quoting: string, extra: Record<string, unknown> = {}) {
	return {
		'@context': [AS, { QuoteRequest: FEP }],
		id: `${actor.uri}#rejects/quote_requests/${nextId()}`,
		type: 'Reject',
		actor: actor.uri,
		object: `${quoting}#quote-request`,
		...extra,
	}
}

function stampOf(actor: TestActor): string {
	return `${actor.uri}/quote_authorizations/${nextId()}`
}

function stampDelete(actor: TestActor, stamp: string) {
	return {
		'@context': [AS, 'https://w3id.org/security/v1'],
		id: `${stamp}#delete-${nextId()}`,
		type: 'Delete',
		actor: actor.uri,
		to: [PUBLIC],
		object: stamp,
	}
}

// The Delete as Mastodon's always_sign writes it: RsaSignature2017 by the actor's key.
function signed(actor: TestActor, json: Record<string, unknown>) {
	return signJsonLd(json, actor.privateKey, new URL(actor.keyId), { contextLoader: contexts }) as Promise<
		Record<string, unknown>
	>
}

// alice's quote of bob's status, accepted by bob's Accept of the request: the quoting status and the stamp.
async function acceptedQuote(t: Setup, bob: TestActor, quoted: string, body: Record<string, unknown> = {}) {
	const mine = await quotePost(t, quoted, body)
	const stamp = stampOf(bob)
	expect(await t.post(bob, accept(bob, mine.uri, stamp))).toBe(202)
	expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'accepted', approval_uri: stamp })
	return { mine, stamp }
}

type Delivered = { inbox: string; body: string; json: Record<string, unknown> }

// Delivery rounds until nothing is due: every POST answered by `answer` (202 unless it says otherwise) and kept.
async function deliver(
	t: Setup,
	answer: (url: string, body: string) => Promise<number> | number = () => 202,
	now = NOW
): Promise<Delivered[]> {
	const sent: Delivered[] = []
	let n = 0
	const deps = {
		build: () => BUILD,
		store: () => t.store,
		now: () => now,
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			const body = await request.text()
			const status = await answer(request.url, body)
			if (status < 300) {
				sent.push({ inbox: request.url, body, json: JSON.parse(body) as Record<string, unknown> })
			}
			return new Response(null, { status })
		}) as typeof fetch,
		checkHost: () => Promise.resolve(),
		leaseToken: () => `lease-${++n}`,
	}
	for (let round = 0; round < 40; round++) {
		if ((await deliveryRound(t.env, deps)).claimed === 0) {
			return sent
		}
	}
	throw new Error('delivery did not settle')
}

const idOf = (value: unknown) => (typeof value === 'string' ? value : (value as { id: string }).id)

function label(activity: Record<string, unknown>): string {
	return `${String(activity.type)} ${idOf(activity.object)}`
}

describe('posting a quote (PostStatusService, R36)', () => {
	it('accepts a quote of a local status at once: a fresh authorization, the silent mention, the notification', async () => {
		const t = await setup()
		const theirs = await localStatus(t, { status: 'quote me', visibility: 'public' }, 'dave')
		const mine = await quotePost(t, theirs.id)
		expect(mine.quote).toMatchObject({ state: 'accepted', quoted_status: { id: theirs.id } })
		const row = await quoteRow(t, mine.uri)
		expect(row).toMatchObject({ state: 'accepted', local: 1, activity_uri: null, verify_after: null, hops: 0 })
		expect(row?.authorization_id).toMatch(/^[0-9a-f]{32}$/)
		expect(await sql(t.store, 'SELECT account_id, silent FROM status_mentions WHERE status_id = ?', mine.id)).toEqual([
			{ account_id: DAVE, silent: 1 },
		])
		expect(
			await sql(t.store, "SELECT account_id, from_account_id, status_id FROM notifications WHERE type = 'quote'")
		).toEqual([{ account_id: DAVE, from_account_id: ALICE, status_id: mine.id }])
		expect(await sql(t.store, 'SELECT quotes_count FROM statuses WHERE id = ?', theirs.id)).toEqual([
			{ quotes_count: 1 },
		])
		// The stamp is served under dave, and the Note names it.
		const stamp = `${new URL(ALICE_URI).origin}/ap/users/dave/quote_authorizations/${row!.authorization_id}`
		const served = await t.request(new URL(stamp).pathname, { headers: { accept: 'application/activity+json' } })
		expect(served.status).toBe(200)
		const note = (await (
			await t.request(new URL(mine.uri).pathname, { headers: { accept: 'application/activity+json' } })
		).json()) as Record<string, unknown>
		expect(note).toMatchObject({
			quote: theirs.uri,
			_misskey_quote: theirs.uri,
			quoteUri: theirs.uri,
			quoteAuthorization: stamp,
		})
		// No QuoteRequest for a local quoted status.
		expect(await recorded(t, 'QuoteRequest')).toEqual([])
	})

	it('accepts a self-quote with no authorization and no notification', async () => {
		const t = await setup()
		const own = await localStatus(t, { status: 'mine', visibility: 'public' })
		const again = await quotePost(t, own.id)
		expect(await quoteRow(t, again.uri)).toMatchObject({ state: 'accepted', authorization_id: null })
		expect(await sql(t.store, "SELECT id FROM notifications WHERE type = 'quote'")).toEqual([])
		expect(await sql(t.store, 'SELECT account_id FROM status_mentions WHERE status_id = ?', again.id)).toEqual([])
	})

	it('leaves a quote of a remote status pending and records its QuoteRequest after the Create', async () => {
		const { t, bob, theirs } = await world()
		const mine = await quotePost(t, theirs.id)
		expect(mine.quote).toEqual({ state: 'pending', quoted_status: null })
		expect(await quoteRow(t, mine.uri)).toMatchObject({
			state: 'pending',
			local: 1,
			approval_uri: null,
			authorization_id: null,
			activity_uri: `${mine.uri}#quote-request`,
			verify_after: null,
			hops: 0,
		})
		// (The Accept is of bob's Follow of dave, from world().)
		const activities = (await recorded(t)).filter((a) => a.activity.type !== 'Accept')
		expect(activities.map((a) => a.activity.type)).toEqual(['Create', 'QuoteRequest'])
		const [createActivity, request] = activities
		expect(createActivity?.activity.object).toMatchObject({
			quote: theirs.uri,
			_misskey_quote: theirs.uri,
			quoteUri: theirs.uri,
		})
		expect(createActivity?.activity.object).not.toHaveProperty('quoteAuthorization')
		expect(request?.activity).toMatchObject({
			id: `${mine.uri}#quote-request`,
			type: 'QuoteRequest',
			actor: ALICE_URI,
			object: theirs.uri,
			instrument: { id: mine.uri, type: 'Note', quote: theirs.uri },
		})
		expect(request?.activity).not.toHaveProperty('to')
		expect(request?.audience).toEqual({ followers: false, accounts: [await statusAuthor(t, theirs.id)] })
		// Its delivery subject is its own id (row 5).
		expect(
			await sql(
				t.store,
				"SELECT object_uri FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'QuoteRequest'"
			)
		).toEqual([{ object_uri: `${mine.uri}#quote-request` }])
		// The quoted author is a silent recipient: the Create reaches bob's personal inbox.
		expect(await sql(t.store, 'SELECT silent FROM status_mentions WHERE status_id = ?', mine.id)).toEqual([
			{ silent: 1 },
		])
	})

	it('answers 404 with Mastodon’s message for anything R36 refuses, and quotes a boost’s original', async () => {
		const { t, bob, theirs } = await world()
		const nobody = await remoteStatus(t, bob, [bob.uri])
		const unstated = await remoteStatus(t, bob, null)
		const followersOnly = await remoteStatus(t, bob, [`${bob.uri}/followers`])
		const daves = await localStatus(t, { status: 'dave', visibility: 'private' }, 'dave')
		const refused = ['999999999999999999', nobody.id, unstated.id, daves.id]
		for (const id of refused) {
			expect(await postRaw(t, { status: 'x', quoted_status_id: id }), id).toEqual({
				status: 404,
				body: { error: NOT_FOUND },
			})
		}
		// Open to bob's followers: alice follows him, dave does not.
		expect((await postRaw(t, { status: 'y', quoted_status_id: followersOnly.id }, 'dave')).status).toBe(404)
		expect((await postRaw(t, { status: 'y', quoted_status_id: followersOnly.id })).status).toBe(200)
		// Blocks either way.
		const davesPublic = await localStatus(t, { status: 'dave public', visibility: 'public' }, 'dave')
		expect((await api(t, 'POST', `/api/v1/accounts/${DAVE}/block`)).status).toBe(200)
		expect((await postRaw(t, { status: 'x', quoted_status_id: davesPublic.id })).status).toBe(404)
		expect((await api(t, 'POST', `/api/v1/accounts/${DAVE}/unblock`)).status).toBe(200)
		expect((await api(t, 'POST', `/api/v1/accounts/${ALICE}/block`, undefined, 'dave')).status).toBe(200)
		expect((await postRaw(t, { status: 'x', quoted_status_id: davesPublic.id })).status).toBe(404)
		expect(await sql(t.store, "SELECT id FROM statuses WHERE source_text = 'x'")).toEqual([])
		// A boost stands for its original.
		const boost = await api(t, 'POST', `/api/v1/statuses/${theirs.id}/reblog`, undefined, 'dave')
		const viaBoost = await quotePost(t, String(boost.body.id), {}, 'dave')
		expect(await quoteRow(t, viaBoost.uri)).toMatchObject({ quoted_status_id: theirs.id })
	})

	it('makes a quote of a private status private, and refuses a direct quote that does not mention its author', async () => {
		const t = await setup()
		const secret = await localStatus(t, { status: 'secret', visibility: 'private' })
		for (const visibility of ['public', 'unlisted', 'private']) {
			expect((await quotePost(t, secret.id, { visibility })).visibility).toBe('private')
		}
		// A self-quote may be direct; someone else's needs its author mentioned (not silently).
		expect((await quotePost(t, secret.id, { visibility: 'direct' })).visibility).toBe('direct')
		const daves = await localStatus(t, { status: 'dave', visibility: 'public' }, 'dave')
		expect(await postRaw(t, { status: 'psst', visibility: 'direct', quoted_status_id: daves.id })).toEqual({
			status: 422,
			body: { error: NOT_MENTIONED },
		})
		expect((await quotePost(t, daves.id, { status: '@dave psst', visibility: 'direct' })).visibility).toBe('direct')
	})

	it('takes an empty text with a quote, and refuses it without one', async () => {
		const t = await setup()
		const daves = await localStatus(t, { status: 'dave', visibility: 'public' }, 'dave')
		const bare = await quotePost(t, daves.id, { status: '' })
		expect(bare.content).toMatch(
			new RegExp(`^<p class="quote-inline">RE: <a href="https://kopje.test/@dave/${daves.id}" [^>]*>.*</a></p>$`)
		)
		expect(await postRaw(t, { status: ' ' })).toEqual({
			status: 422,
			body: { error: "Validation failed: Text can't be blank" },
		})
	})
})

async function statusAuthor(t: Setup, id: string): Promise<string> {
	return (await sql<{ account_id: string }>(t.store, 'SELECT account_id FROM statuses WHERE id = ?', id))[0]!.account_id
}

describe('the content fallback (TextFormatter#add_quote_fallback)', () => {
	it('starts with a quote-inline RE: line unless the text links the quoted status, and keeps it through edits', async () => {
		const { t, theirs } = await world()
		const plain = await quotePost(t, theirs.id, { status: 'hello' })
		const link = String(theirs.note.url)
		expect(plain.content).toMatch(
			new RegExp(`^<p class="quote-inline">RE: <a href="${link}"[^>]*>.*</a></p><p>hello</p>$`)
		)
		// The text links the url, or the uri: no line.
		for (const linked of [link, theirs.uri]) {
			const with_ = await quotePost(t, theirs.id, { status: `see ${linked}` })
			expect(with_.content).not.toContain('quote-inline')
		}
		// An edit keeps the line (and the quote).
		const edited = await api(t, 'PUT', `/api/v1/statuses/${plain.id}`, { status: 'hello again' })
		expect(String(edited.body.content)).toMatch(/^<p class="quote-inline">RE: .*<p>hello again<\/p>$/)
		const blank = await api(t, 'PUT', `/api/v1/statuses/${plain.id}`, { status: '' })
		expect(blank.status).toBe(200)
	})
})

describe('scheduled quotes (PublishScheduledStatusWorker)', () => {
	async function schedule(t: Setup, quoted: string, text: string) {
		const answer = await postRaw(t, {
			status: text,
			quoted_status_id: quoted,
			scheduled_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
		})
		expect(answer.status).toBe(200)
		return answer.body as { id: string; params: Record<string, unknown> }
	}

	async function publish(t: Setup) {
		const { publishScheduled } = await import('../src/jobs/scheduled')
		await publishScheduled(t.env, {
			build: () => BUILD,
			now: () => NOW + 2 * 60 * 60 * 1000,
			store: () => t.store,
			doorbell: () => Promise.resolve(),
		})
	}

	it('keeps quoted_status_id, judges R36 again at publication, and drops what it refuses (row 19)', async () => {
		const { t, bob, theirs } = await world()
		const kept = await schedule(t, theirs.id, 'kept')
		expect(kept.params.quoted_status_id).toBe(theirs.id)
		const gone = await remoteStatus(t, bob)
		const narrowed = await remoteStatus(t, bob)
		const daves = await localStatus(t, { status: 'dave', visibility: 'public' }, 'dave')
		await schedule(t, gone.id, 'gone')
		await schedule(t, narrowed.id, 'narrowed')
		await schedule(t, daves.id, 'blocked')
		// At scheduling, R36 already applies.
		expect(
			await postRaw(t, {
				status: 'never',
				quoted_status_id: '999999999999999999',
				scheduled_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
			})
		).toEqual({ status: 404, body: { error: NOT_FOUND } })
		expect(await t.post(bob, remove(bob, gone.uri))).toBe(202)
		expect(
			await t.post(
				bob,
				update(
					bob,
					{ ...narrowed.note, interactionPolicy: { canQuote: { automaticApproval: [bob.uri] } } },
					'2026-10-11T13:00:00Z'
				)
			)
		).toBe(202)
		expect((await api(t, 'POST', `/api/v1/accounts/${ALICE}/block`, undefined, 'dave')).status).toBe(200)
		await publish(t)
		expect(
			await sql(
				t.store,
				"SELECT source_text FROM statuses WHERE account_id = ? AND source_text IN ('kept', 'gone', 'narrowed', 'blocked')",
				ALICE
			)
		).toEqual([{ source_text: 'kept' }])
		expect(await sql(t.store, 'SELECT id FROM scheduled_statuses')).toEqual([])
		expect((await recorded(t, 'QuoteRequest')).length).toBe(1)
	})

	it('publishes once whichever of the publication and the DELETE comes first, never with two QuoteRequests', async () => {
		for (const order of ['publish first', 'delete first']) {
			const { t, theirs } = await world()
			const scheduled = await schedule(t, theirs.id, 'once')
			const del = () => api(t, 'DELETE', `/api/v1/scheduled_statuses/${scheduled.id}`)
			if (order === 'publish first') {
				await Promise.all([publish(t), del()])
			} else {
				await Promise.all([del(), publish(t)])
			}
			const made = await sql(t.store, "SELECT id FROM statuses WHERE source_text = 'once'")
			expect(made.length).toBeLessThanOrEqual(1)
			expect((await recorded(t, 'QuoteRequest')).length).toBe(made.length)
		}
	})
})

describe('remote quote policies (StatusParser#quote_policy, row 2)', () => {
	it('stores the policy at first store and on every Update, never from a Create of a known status', async () => {
		const { t, bob, theirs } = await world()
		expect((await postRaw(t, { status: 'a', quoted_status_id: theirs.id })).status).toBe(200)
		// An implicit Update (no newer version) to nobody.
		const nobody = { ...theirs.note, interactionPolicy: { canQuote: { automaticApproval: [bob.uri] } } }
		expect(
			await t.post(bob, { ...update(bob, nobody, String(theirs.note.published)), id: `${theirs.uri}#updates/implicit` })
		).toBe(202)
		expect(await sql(t.store, 'SELECT quote_policy FROM statuses WHERE id = ?', theirs.id)).toEqual([
			{ quote_policy: 0 },
		])
		expect((await postRaw(t, { status: 'b', quoted_status_id: theirs.id })).status).toBe(404)
		// A replayed Create carrying public leaves nobody.
		expect(await t.post(bob, { ...create(bob, theirs.note), id: `${theirs.uri}/activity-again` })).toBe(202)
		expect(await sql(t.store, 'SELECT quote_policy FROM statuses WHERE id = ?', theirs.id)).toEqual([
			{ quote_policy: 0 },
		])
		// An explicit Update back to followers and following, with something unsupported: Mastodon's flags.
		const mixed = {
			...theirs.note,
			interactionPolicy: {
				canQuote: {
					automaticApproval: [`${bob.uri}/followers`, `${bob.uri}/following`],
					manualApproval: [PUBLIC, 'https://elsewhere.example/users/x'],
				},
			},
		}
		expect(await t.post(bob, update(bob, mixed, '2026-10-11T14:00:00Z'))).toBe(202)
		expect(await sql(t.store, 'SELECT quote_policy FROM statuses WHERE id = ?', theirs.id)).toEqual([
			{ quote_policy: ((4 | 8) << 16) | 2 | 1 },
		])
	})
})

describe('the Note’s quote properties', () => {
	it('names a quoted status that is gone as a Tombstone, and carries the JSON-LD terms', async () => {
		const t = await setup()
		const daves = await localStatus(t, { status: 'dave', visibility: 'public' }, 'dave')
		const mine = await quotePost(t, daves.id)
		expect((await api(t, 'DELETE', `/api/v1/statuses/${daves.id}`, undefined, 'dave')).status).toBe(200)
		const note = (await (
			await t.request(new URL(mine.uri).pathname, { headers: { accept: 'application/activity+json' } })
		).json()) as Record<string, unknown>
		expect(note.quote).toEqual({ type: 'Tombstone' })
		expect(note).not.toHaveProperty('_misskey_quote')
		expect(note).not.toHaveProperty('quoteAuthorization')
		const [, terms] = note['@context'] as [string, Record<string, unknown>]
		expect(terms).toMatchObject({
			quote: { '@id': 'https://w3id.org/fep/044f#quote', '@type': '@id' },
			quoteUri: 'http://fedibird.com/ns#quoteUri',
			_misskey_quote: 'https://misskey-hub.net/ns#_misskey_quote',
			quoteAuthorization: { '@id': 'https://w3id.org/fep/044f#quoteAuthorization', '@type': '@id' },
		})
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'deleted', authorization_id: null })
	})
})

export {
	accept,
	acceptedQuote,
	deliver,
	label,
	MASTODON,
	reject,
	signed,
	stampDelete,
	stampOf,
	verifyJsonLd,
	RETRACTION_TTL_MS,
	MAX_QUOTED_UPDATES,
}
export type { DocumentLoader }
