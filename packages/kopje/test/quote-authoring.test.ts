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
import { rowsRead } from './read-helpers'
import { outbound } from './status-helpers'
import { RETRACTION_TTL_MS } from '../src/domain/inbox'
import { readOperation } from '../src/domain/operation'
import { holdsLocalStamp, MAX_QUOTED_UPDATES, quotedUpdates } from '../src/domain/quotes'
import { deliveryRound } from '../src/jobs/deliver'
import { publishScheduled } from '../src/jobs/scheduled'

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
	// A claim that only drops refused rows (a suspended sender's) claims nothing but leaves the next row due.
	for (let round = 0; round < 40; round++) {
		const result = await deliveryRound(t.env, deps)
		if (result.claimed === 0 && (result.nextDueAt === null || result.nextDueAt > now)) {
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

// ---------------------------------------------------------------------------------------------------------------
// Concurrency (PR 3): the test table, as changed by both design reviews
// ---------------------------------------------------------------------------------------------------------------

type Lane = { type: string; object_uri: string | null; inbox: string; addressee: string | null; state: string }

// The delivery rows of every lane at `origin`, in id order (a lane is delivered in that order).
async function lane(t: Setup, origin: string): Promise<Lane[]> {
	return sql<Lane>(
		t.store,
		`SELECT json_extract(o.body, '$.activity.type') AS type, o.object_uri, d.inbox_url AS inbox, d.addressee, d.state
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE d.inbox_url LIKE ?1 || '%'
		ORDER BY d.id`,
		origin
	)
}

// `actor` follows alice (an accepted inbound Follow).
async function fan(t: Setup, actor: TestActor): Promise<void> {
	expect(
		await t.post(actor, {
			'@context': AS,
			id: `${actor.uri}#follows/${nextId()}`,
			type: 'Follow',
			actor: actor.uri,
			object: ALICE_URI,
		})
	).toBe(202)
}

async function suspend(t: Setup, id: string, suspended: boolean): Promise<void> {
	await sql(
		t.store,
		'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?',
		suspended ? new Date(NOW).toISOString() : null,
		id
	)
}

async function jobsUntilDone(t: Setup, now = NOW): Promise<void> {
	for (let round = 0; round < 50; round++) {
		if (!(await t.store.runInboundJobs(BUILD, { now })).pending) {
			return
		}
	}
	throw new Error('jobs did not finish')
}

// `count` pending quotes of `quotedId` by remote statuses of `actor`'s server, each naming `stamp`.
async function remoteQuotesNaming(
	t: Setup,
	bobUri: string,
	quotedUri: string,
	quotedId: string,
	stamp: string | null,
	count: number,
	prefix = '7'
) {
	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		SELECT printf('${prefix}%017d', i), ?2 || '/q' || i, (SELECT id FROM accounts WHERE uri = ?2), 'public', '',
			'2026-10-11T12:00:00.000Z' FROM n`,
		count,
		bobUri
	)
	await sql(
		t.store,
		`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, approval_uri, updated_at)
		SELECT id, ?1, ?2, (SELECT account_id FROM statuses WHERE id = ?2), 'pending', ?3, '2026-10-11T12:00:00.000Z'
		FROM statuses WHERE id GLOB '${prefix}*' AND length(id) = 18`,
		quotedUri,
		quotedId,
		stamp
	)
}

describe('Concurrency (PR 3)', () => {
	it('1: a quoted status deleted before the post refuses it; one deleted after leaves the quote pending for good', async () => {
		const { t, bob, theirs } = await world()
		const other = await remoteStatus(t, bob)
		expect(await t.post(bob, remove(bob, theirs.uri))).toBe(202)
		expect(await postRaw(t, { status: 'x', quoted_status_id: theirs.id })).toEqual({
			status: 404,
			body: { error: NOT_FOUND },
		})
		const mine = await quotePost(t, other.id)
		expect(await t.post(bob, remove(bob, other.uri))).toBe(202)
		await jobsUntilDone(t)
		expect(await quoteRow(t, mine.uri)).toMatchObject({
			state: 'pending',
			quoted_status_id: null,
			quoted_account_id: null,
		})
		const before = (await recorded(t, 'Update')).length
		expect(await t.post(bob, accept(bob, mine.uri, stampOf(bob)))).toBe(202)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'pending' })
		expect((await recorded(t, 'Update')).length).toBe(before)
	})

	it('3: Bob quotes Alice: Alice’s revoke reaches Bob’s receipts with her signed Delete; Bob’s delete ends the stamp', async () => {
		const t = await setup()
		const carol = await mastodonActor(t.web, 'carol', { origin: 'https://fans.example', key: 3 })
		await fan(t, carol)
		const daves = await localStatus(t, { status: 'dave', visibility: 'public' }, 'dave')
		const mine = await quotePost(t, daves.id)
		const authorization = (await quoteRow(t, mine.uri))!.authorization_id!
		const stamp = `${LOCAL_ORIGIN}/ap/users/dave/quote_authorizations/${authorization}`
		// carol's server receives alice's quote (a receipt), then dave revokes.
		await deliver(t)
		const revoked = await api(t, 'POST', `/api/v1/statuses/${daves.id}/quotes/${mine.id}/revoke`, undefined, 'dave')
		expect(revoked.status).toBe(200)
		const sent = await deliver(t)
		const deletes = sent.filter((s) => s.json.type === 'Delete' && s.json.object === stamp)
		expect(deletes.map((s) => s.inbox)).toContain('https://fans.example/inbox')
		expect(deletes[0]?.json).toMatchObject({
			actor: `${LOCAL_ORIGIN}/ap/users/dave`,
			signature: { type: 'RsaSignature2017' },
		})
		// Accepted again by a new quote, then Bob (alice) deletes it: the stamp answers 404.
		const again = await quotePost(t, daves.id)
		const second = (await quoteRow(t, again.uri))!.authorization_id!
		const path = `/ap/users/dave/quote_authorizations/${second}`
		expect((await t.request(path, { headers: { accept: 'application/activity+json' } })).status).toBe(200)
		expect((await api(t, 'DELETE', `/api/v1/statuses/${again.id}`)).status).toBe(200)
		expect((await t.request(path, { headers: { accept: 'application/activity+json' } })).status).toBe(404)
	})

	it('4: the quoted server’s lane holds the Create, the QuoteRequest, then the Accept’s Update', async () => {
		const { t, bob, theirs } = await world()
		const carol = await mastodonActor(t.web, 'carol', { key: 3 })
		await fan(t, carol)
		await sql(t.store, 'DELETE FROM deliveries')
		const mine = await quotePost(t, theirs.id)
		expect((await lane(t, MASTODON)).map((d) => [d.type, d.inbox])).toEqual([
			['Create', `${MASTODON}/users/bob/inbox`],
			['Create', `${MASTODON}/inbox`],
			['QuoteRequest', `${MASTODON}/inbox`],
		])
		// The lane's head is in flight when the Accept comes: what waits behind it is replaced by the pair (the current
		// Create, then the Update), always after the QuoteRequest.
		await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'held' })
		expect(await t.post(bob, accept(bob, mine.uri, stampOf(bob)))).toBe(202)
		expect((await lane(t, MASTODON)).map((d) => [d.type, d.inbox])).toEqual([
			['Create', `${MASTODON}/users/bob/inbox`],
			['QuoteRequest', `${MASTODON}/inbox`],
			['Create', `${MASTODON}/users/bob/inbox`],
			['Create', `${MASTODON}/inbox`],
			['Update', `${MASTODON}/users/bob/inbox`],
			['Update', `${MASTODON}/inbox`],
		])
		// A receiver that has not had the Create can take the inlined instrument: the full Note, the author's own.
		const [request] = await recorded(t, 'QuoteRequest')
		expect(request?.activity.instrument).toMatchObject({ id: mine.uri, attributedTo: ALICE_URI, quote: theirs.uri })
	})

	it('5: an edit before any claim keeps the QuoteRequest, after the current Create and the Update', async () => {
		const { t, theirs } = await world()
		await sql(t.store, 'DELETE FROM deliveries')
		const mine = await quotePost(t, theirs.id)
		expect((await api(t, 'PUT', `/api/v1/statuses/${mine.id}`, { status: 'fixed' })).status).toBe(200)
		const types = (await lane(t, MASTODON)).map((d) => `${d.type} ${d.object_uri}`)
		expect(types).toContain(`QuoteRequest ${mine.uri}#quote-request`)
		expect(types.filter((x) => x.startsWith('Update'))).not.toEqual([])
	})

	it('6: deleting the status keeps lane order Create, QuoteRequest, Delete; a given-up request is retried after it', async () => {
		const { t, theirs } = await world()
		await sql(t.store, 'DELETE FROM deliveries')
		const mine = await quotePost(t, theirs.id)
		await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'held' })
		expect((await api(t, 'DELETE', `/api/v1/statuses/${mine.id}`)).status).toBe(200)
		// The Delete to each of the server's inboxes (bob's personal one and the one the Create was in flight to) follows.
		const rows = (await lane(t, MASTODON)).map((d) => [d.type, d.state])
		expect(rows.slice(0, 2)).toEqual([
			['Create', 'leased'],
			['QuoteRequest', 'queued'],
		])
		expect(rows.slice(2).map(([type]) => type)).toEqual(expect.arrayContaining(['Delete']))
		expect(new Set(rows.slice(2).map(([type]) => type))).toEqual(new Set(['Delete']))
		// Variant: the request gave up before the delete, and the operator retries everything.
		const v = await world()
		const other = await quotePost(v.t, v.theirs.id)
		await sql(
			v.t.store,
			`UPDATE deliveries SET state = 'gave_up' WHERE activity_id IN (SELECT id FROM outbound_activities
				WHERE json_extract(body, '$.activity.type') = 'QuoteRequest')`
		)
		expect((await api(v.t, 'DELETE', `/api/v1/statuses/${other.id}`)).status).toBe(200)
		await v.t.store.retryDeliveries(BUILD, { ids: 'all', now: NOW })
		const sent = await deliver(v.t)
		expect(sent.filter((s) => s.json.type === 'QuoteRequest').length).toBe(1)
	})

	it('7: Accept and Reject are each one compare-and-set', async () => {
		const { t, bob, theirs } = await world()
		const mine = await quotePost(t, theirs.id)
		const stamp = stampOf(bob)
		const one = accept(bob, mine.uri, stamp)
		// Two copies at once, through the operation queue: one transition, one Update.
		expect(await Promise.all([t.post(bob, one), t.post(bob, { ...one, id: `${one.id}-copy` })])).toEqual([202, 202])
		expect((await recorded(t, 'Update')).length).toBe(1)
		// A second result changes nothing.
		expect(await t.post(bob, accept(bob, mine.uri, stampOf(bob)))).toBe(202)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'accepted', approval_uri: stamp })
		// Reject after Accept: revoked. Accept after: stays revoked.
		expect(await t.post(bob, reject(bob, mine.uri))).toBe(202)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'revoked' })
		expect(await t.post(bob, accept(bob, mine.uri, stampOf(bob)))).toBe(202)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'revoked' })
		// Accept after Reject: stays rejected.
		const later = await quotePost(t, theirs.id)
		expect(await t.post(bob, reject(bob, later.uri))).toBe(202)
		expect(await t.post(bob, accept(bob, later.uri, stampOf(bob)))).toBe(202)
		expect(await quoteRow(t, later.uri)).toMatchObject({ state: 'rejected' })
		// A wrong actor, a result on another origin, or none: ignored.
		const third = await quotePost(t, theirs.id)
		const eve = await mastodonActor(t.web, 'eve', { key: 4 })
		expect(await t.post(eve, accept(eve, third.uri, stampOf(eve)))).toBe(202)
		expect(await t.post(bob, accept(bob, third.uri, 'https://other.example/stamp'))).toBe(202)
		expect(await t.post(bob, accept(bob, third.uri, null))).toBe(202)
		expect(await quoteRow(t, third.uri)).toMatchObject({ state: 'pending', approval_uri: null })
		// The inlined form matches too (Mastodon's quote_from_request_json).
		const inlined = accept(bob, third.uri, stampOf(bob), {
			object: { type: 'QuoteRequest', id: 'https://other.example/any', object: theirs.uri, instrument: third.uri },
		})
		expect(await t.post(bob, inlined)).toBe(202)
		expect(await quoteRow(t, third.uri)).toMatchObject({ state: 'accepted' })
	})

	it('8: an Accept of a stamp its author deleted leaves the quote pending, until the retraction expires', async () => {
		const clock = { now: NOW }
		const t = await setup(clock)
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const theirs = await remoteStatus(t, bob)
		// (a) Delete(S) while pending, then Accept(S).
		const a = await quotePost(t, theirs.id)
		const s1 = stampOf(bob)
		expect(await t.post(bob, stampDelete(bob, s1))).toBe(202)
		expect(await t.post(bob, accept(bob, a.uri, s1))).toBe(202)
		expect(await quoteRow(t, a.uri)).toMatchObject({ state: 'pending' })
		// (b) A received quote names S too: its revocation is recorded, whatever its batches still have to do.
		const b = await quotePost(t, theirs.id)
		const s2 = stampOf(bob)
		await remoteQuotesNaming(t, bob.uri, theirs.uri, theirs.id, s2, 3)
		expect(await t.post(bob, stampDelete(bob, s2))).toBe(202)
		expect(await t.post(bob, accept(bob, b.uri, s2))).toBe(202)
		expect(await quoteRow(t, b.uri)).toMatchObject({ state: 'pending' })
		// (c) Past RETRACTION_TTL_MS and the sweep, the retraction alone is gone: the Accept applies (Mastodon parity).
		clock.now = NOW + RETRACTION_TTL_MS + 60_000
		expect(await t.post(bob, accept(bob, a.uri, s1))).toBe(202)
		expect(await quoteRow(t, a.uri)).toMatchObject({ state: 'accepted', approval_uri: s1 })
	})

	it('9: one stamp accepts one local quote', async () => {
		const { t, bob, theirs } = await world()
		const first = await quotePost(t, theirs.id)
		const second = await quotePost(t, theirs.id)
		const stamp = stampOf(bob)
		expect(await t.post(bob, accept(bob, first.uri, stamp))).toBe(202)
		expect(await t.post(bob, accept(bob, second.uri, stamp))).toBe(202)
		expect(await quoteRow(t, first.uri)).toMatchObject({ state: 'accepted' })
		expect(await quoteRow(t, second.uri)).toMatchObject({ state: 'pending', approval_uri: null })
	})

	it('10: a proven Delete revokes our quote and records one forward in its first transaction; replays add nothing', async () => {
		const { t, bob, theirs } = await world()
		const carol = await mastodonActor(t.web, 'carol', { origin: 'https://fans.example', key: 3 })
		await fan(t, carol)
		const { mine, stamp } = await acceptedQuote(t, bob, theirs.id)
		await remoteQuotesNaming(t, bob.uri, theirs.uri, theirs.id, stamp, 300)
		await deliver(t)
		const body = await signed(bob, stampDelete(bob, stamp))
		expect(await t.post(bob, body)).toBe(202)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'revoked', approval_uri: null })
		const forwards = (await recorded(t, 'Delete')).filter((a) => a.activity.object === stamp)
		expect(forwards).toHaveLength(1)
		expect(forwards[0]).toMatchObject({ signer: ALICE, immutable: true, activity: body })
		const reach = (forwards[0] as unknown as { reachOf: { object: string }[] }).reachOf
		expect(reach.map((r) => r.object)).toEqual([mine.uri])
		// The batches meet received quotes only, and record nothing outbound.
		const before = (await outbound(t.store)).length
		await jobsUntilDone(t)
		expect(await sql(t.store, "SELECT count(*) AS n FROM quotes WHERE state = 'rejected'")).toEqual([{ n: 300 }])
		expect((await outbound(t.store)).length).toBe(before)
		// A replay records nothing more.
		expect(await t.post(bob, body)).toBe(202)
		expect((await outbound(t.store)).length).toBe(before)
		// The body delivered to every destination is the one bob signed, byte for byte, and verifies.
		const sent = (await deliver(t)).filter((s) => s.json.type === 'Delete' && s.json.object === stamp)
		expect([...new Set(sent.map((s) => s.inbox))].sort()).toEqual([
			'https://fans.example/inbox',
			`${MASTODON}/users/bob/inbox`,
		])
		expect(new Set(sent.map((s) => s.body)).size).toBe(1)
		const documentLoader: DocumentLoader = (url) =>
			Promise.resolve({ document: bob.document, documentUrl: url, contextUrl: null })
		for (const s of sent) {
			expect(await verifyJsonLd(s.json, { documentLoader, contextLoader: contexts })).toBe(true)
		}
	})

	it('10: without a proof, the Delete revokes our quote and forwards nothing', async () => {
		const { t, bob, theirs } = await world()
		const { mine, stamp } = await acceptedQuote(t, bob, theirs.id)
		expect(await t.post(bob, stampDelete(bob, stamp))).toBe(202)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'revoked', approval_uri: stamp })
		expect((await recorded(t, 'Delete')).filter((a) => a.activity.object === stamp)).toEqual([])
		// A later proven Delete forwards it once.
		expect(await t.post(bob, await signed(bob, stampDelete(bob, stamp)))).toBe(202)
		expect((await recorded(t, 'Delete')).filter((a) => a.activity.object === stamp)).toHaveLength(1)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ approval_uri: null })
	})

	it('11: Delete then Reject, or Reject then Delete: one stamp-free Update and one forward either way', async () => {
		for (const order of ['delete first', 'reject first']) {
			const { t, bob, theirs } = await world()
			const { mine, stamp } = await acceptedQuote(t, bob, theirs.id)
			const deletion = await signed(bob, stampDelete(bob, stamp))
			if (order === 'delete first') {
				expect(await t.post(bob, deletion)).toBe(202)
				expect(await t.post(bob, reject(bob, mine.uri))).toBe(202)
			} else {
				expect(await t.post(bob, reject(bob, mine.uri))).toBe(202)
				expect(await t.post(bob, deletion)).toBe(202)
			}
			// The stamp-free Update supersedes (and so replaces) the Accept's.
			const updates = await recorded(t, 'Update')
			expect(
				updates.map((u) => 'quoteAuthorization' in (u.activity.object as object)),
				order
			).toEqual([false])
			expect(
				(await recorded(t, 'Delete')).filter((a) => a.activity.object === stamp),
				order
			).toHaveLength(1)
			expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'revoked', approval_uri: null })
		}
	})

	it('11: the stale Accept Update given up is superseded; a follower gone and a suspended quoter still get the forward', async () => {
		const { t, bob, theirs } = await world()
		const carol = await mastodonActor(t.web, 'carol', { origin: 'https://fans.example', key: 3 })
		await fan(t, carol)
		const mine = await quotePost(t, theirs.id)
		await deliver(t)
		const stamp = stampOf(bob)
		expect(await t.post(bob, accept(bob, mine.uri, stamp))).toBe(202)
		// The Accept's Update gives up everywhere.
		await deliver(t, () => 410)
		// carol leaves, and alice is suspended.
		await sql(
			t.store,
			'DELETE FROM follows WHERE target_account_id = ? AND account_id = (SELECT id FROM accounts WHERE uri = ?)',
			ALICE,
			carol.uri
		)
		await suspend(t, ALICE, true)
		expect(await t.post(bob, await signed(bob, stampDelete(bob, stamp)))).toBe(202)
		const retried = await t.store.retryDeliveries(BUILD, { ids: 'all', now: NOW })
		expect(retried).toBeDefined()
		const sent = await deliver(t)
		// No Note with the stamp goes out again; the forward reaches carol's server, which had the status.
		expect(
			sent.filter((s) => typeof s.json.object === 'object' && JSON.stringify(s.json.object).includes(stamp))
		).toEqual([])
		expect(sent.filter((s) => s.json.type === 'Delete' && s.json.object === stamp).map((s) => s.inbox)).toContain(
			'https://fans.example/inbox'
		)
		// The stamp-free Update is dropped while alice is suspended.
		expect(sent.filter((s) => s.json.type === 'Update')).toEqual([])
	})

	it('12: Updates of an edit, an Accept and a policy change go in commit order; the last carries the stamp', async () => {
		const { t, bob, theirs } = await world()
		const mine = await quotePost(t, theirs.id)
		await deliver(t)
		expect((await api(t, 'PUT', `/api/v1/statuses/${mine.id}`, { status: 'edited' })).status).toBe(200)
		const stamp = stampOf(bob)
		expect(await t.post(bob, accept(bob, mine.uri, stamp))).toBe(202)
		expect(
			(await api(t, 'PUT', `/api/v1/statuses/${mine.id}/interaction_policy`, { quote_approval_policy: 'nobody' }))
				.status
		).toBe(200)
		const updates = (await deliver(t)).filter((s) => s.json.type === 'Update' && s.inbox.startsWith(MASTODON))
		const last = updates.at(-1)?.json.object as Record<string, unknown>
		expect(last).toMatchObject({ content: expect.stringContaining('edited'), quoteAuthorization: stamp })
		expect(last.interactionPolicy).toEqual({ canQuote: { automaticApproval: [ALICE_URI] } })
		// Two Accept Updates at the same now get distinct ids.
		const a = await quotePost(t, theirs.id)
		const b = await quotePost(t, theirs.id)
		expect(await t.post(bob, accept(bob, a.uri, stampOf(bob)))).toBe(202)
		expect(await t.post(bob, accept(bob, b.uri, stampOf(bob)))).toBe(202)
		const ids = (await recorded(t, 'Update')).map((u) => u.activity.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('13: a leased Create does not hold the status: the pair goes too, and a server ends at the current version', async () => {
		const { t, bob, theirs } = await world()
		const x = await mastodonActor(t.web, 'x', { origin: 'https://x.example', key: 3 })
		const y = await mastodonActor(t.web, 'y', { origin: 'https://y.example', key: 4 })
		await fan(t, x)
		await fan(t, y)
		await sql(t.store, 'DELETE FROM deliveries')
		const mine = await quotePost(t, theirs.id)
		// Lease everything once (x's Create is in flight), then accept.
		const claim = await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'held' })
		const stamp = stampOf(bob)
		expect(await t.post(bob, accept(bob, mine.uri, stamp))).toBe(202)
		for (const origin of ['https://x.example', 'https://y.example', MASTODON]) {
			const types = (await lane(t, origin)).map((d) => d.type)
			expect(types.slice(-2), origin).toEqual(['Create', 'Update'])
		}
		// The leased Creates give up; the pair delivers the current version (with the stamp).
		for (const d of claim.deliveries) {
			await t.store.completeDelivery(BUILD, {
				id: d.id,
				leaseToken: 'held',
				now: NOW,
				outcome: { kind: 'failed', status: 410, error: 'gone', permanent: true },
			})
		}
		const sent = await deliver(t)
		const toX = sent.filter((s) => s.inbox === 'https://x.example/inbox')
		expect(toX.map((s) => s.json.type)).toEqual(['Create', 'Update'])
		expect(toX[0]?.json.object).toMatchObject({ quoteAuthorization: stamp })
		// An operator retry of the old Create reaches a server that holds the status: a Mastodon receiver ignores it.
		await t.store.retryDeliveries(BUILD, { ids: 'all', now: NOW })
		const again = (await deliver(t)).filter((s) => s.inbox === 'https://x.example/inbox')
		expect(again.every((s) => s.json.type === 'Create')).toBe(true)
	})

	it('14: an answer after the quoting status’s delete finds nothing; the delete supersedes a waiting Accept Update', async () => {
		const { t, bob, theirs } = await world()
		const gone = await quotePost(t, theirs.id)
		expect((await api(t, 'DELETE', `/api/v1/statuses/${gone.id}`)).status).toBe(200)
		const before = (await recorded(t, 'Update')).length
		expect(await t.post(bob, accept(bob, gone.uri, stampOf(bob)))).toBe(202)
		expect((await recorded(t, 'Update')).length).toBe(before)
		const mine = await quotePost(t, theirs.id)
		expect(await t.post(bob, accept(bob, mine.uri, stampOf(bob)))).toBe(202)
		expect((await api(t, 'DELETE', `/api/v1/statuses/${mine.id}`)).status).toBe(200)
		expect(
			await sql(
				t.store,
				`SELECT superseded FROM outbound_activities WHERE object_uri = ? AND json_extract(body, '$.activity.type') = 'Update'`,
				mine.uri
			)
		).toEqual([{ superseded: 1 }])
		// Everything gives up; the operator's retry of everything never sends the superseded Update, only the Delete.
		await deliver(t, () => 410)
		await t.store.retryDeliveries(BUILD, { ids: 'all', now: NOW })
		const sent = await deliver(t)
		expect(sent.filter((s) => s.json.type === 'Update' && idOf(s.json.object) === mine.uri)).toEqual([])
		expect(sent.some((s) => s.json.type === 'Delete' && idOf(s.json.object) === mine.uri)).toBe(true)
	})

	it('15: an Accept between detach batches is undone by the detach; one after it is ignored', async () => {
		const { t, bob, theirs } = await world()
		// 600 other quotes first: the detach reaches them first (quotes_quoted, in row order), ours in a later batch.
		await remoteQuotesNaming(t, bob.uri, theirs.uri, theirs.id, null, 600)
		const mine = await quotePost(t, theirs.id)
		await sql(t.store, "UPDATE quotes SET state = 'accepted' WHERE status_id GLOB '7*'")
		const count = async () =>
			(await sql<{ quotes_count: number }>(t.store, 'SELECT quotes_count FROM statuses WHERE id = ?', theirs.id))[0]
				?.quotes_count
		await sql(t.store, 'UPDATE statuses SET quotes_count = 600 WHERE id = ?', theirs.id)
		expect(await t.post(bob, remove(bob, theirs.uri))).toBe(202)
		// Batch 1 ran in the request; the detach has not reached our row yet.
		expect(await quoteRow(t, mine.uri)).toMatchObject({ quoted_status_id: theirs.id })
		expect(await t.post(bob, accept(bob, mine.uri, stampOf(bob)))).toBe(202)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'accepted' })
		await jobsUntilDone(t)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'deleted', quoted_status_id: null })
		expect(await count()).toBeUndefined()
		const late = await quotePost(t, (await remoteStatus(t, bob)).id)
		expect(await t.post(bob, remove(bob, (await quoteRowTarget(t, late.uri))!))).toBe(202)
		await jobsUntilDone(t)
		expect(await t.post(bob, accept(bob, late.uri, stampOf(bob)))).toBe(202)
		expect(await quoteRow(t, late.uri)).toMatchObject({ state: 'pending' })
	})

	it('16: an edit notifies at most 100 local quoters, newest first; later acceptances and revocations change that', async () => {
		const { t, bob, theirs } = await world()
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT printf('6%017d', i), 'https://kopje.test/ap/o/q' || i, ?1, 'public', '', '2026-10-11T12:00:00.000Z' FROM n`,
			ALICE
		)
		await sql(
			t.store,
			`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, approval_uri, updated_at)
			SELECT id, ?1, ?2, (SELECT account_id FROM statuses WHERE id = ?2), 'accepted', 1, 'https://mastodon.example/s/' || id,
				'2026-10-11T12:00:00.000Z' FROM statuses WHERE id GLOB '6*'`,
			theirs.uri,
			theirs.id
		)
		const late = await quotePost(t, theirs.id)
		expect(await t.post(bob, update(bob, { ...theirs.note, content: '<p>edited</p>' }, '2026-10-11T15:00:00Z'))).toBe(
			202
		)
		const notified = await sql<{ status_id: string }>(
			t.store,
			"SELECT status_id FROM notifications WHERE type = 'quoted_update' ORDER BY status_id DESC"
		)
		expect(notified).toHaveLength(MAX_QUOTED_UPDATES)
		expect(notified[0]?.status_id).toBe('600000000000000150')
		expect(notified.at(-1)?.status_id).toBe('600000000000000051')
		// Accepted after the edit: nothing for it.
		expect(await t.post(bob, accept(bob, late.uri, stampOf(bob)))).toBe(202)
		expect(
			await sql(t.store, "SELECT id FROM notifications WHERE type = 'quoted_update' AND status_id = ?", late.id)
		).toEqual([])
		// Revoked after it: the notification is hidden (R15's quoted_update arm).
		await sql(t.store, "UPDATE quotes SET state = 'revoked' WHERE status_id = '600000000000000150'")
		const listed = await t.api<{ type: string; status: { id: string } }[]>(
			'/api/v1/notifications?types[]=quoted_update&limit=40'
		)
		expect(listed.body.map((n) => n.status.id)).not.toContain('600000000000000150')
		expect(listed.body[0]?.type).toBe('quoted_update')
	})

	it('17: no round ever holds a local quoting row', async () => {
		const clock = { now: NOW }
		const t = await setup(clock)
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const theirs = await remoteStatus(t, bob)
		const { mine, stamp } = await acceptedQuote(t, bob, theirs.id)
		const idle = async () => {
			expect(await quoteRow(t, mine.uri)).toMatchObject({ verify_after: null })
			expect(await t.store.claimQuotes(BUILD, { now: NOW + 1, limit: 10 })).toMatchObject({ ids: [] })
		}
		// (a) A local user resolves our quoting status's uri.
		await t.api(`/api/v2/search?q=${encodeURIComponent(mine.uri)}&resolve=true&type=statuses`)
		await idle()
		// (b) An unsigned relay of a Delete of our stamp.
		const relay = await mastodonActor(t.web, 'relay', { origin: 'https://relay.example', key: 5 })
		expect(await t.post(relay, stampDelete(bob, stamp))).toBe(202)
		await idle()
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'accepted' })
		// (c) Detach, then the same uri stored again after its retraction expired: relinked with no work.
		const target = await remoteStatus(t, bob)
		const other = await quotePost(t, target.id)
		expect(await t.post(bob, remove(bob, target.uri))).toBe(202)
		await jobsUntilDone(t)
		expect(await quoteRow(t, other.uri)).toMatchObject({ quoted_status_id: null })
		clock.now = NOW + RETRACTION_TTL_MS + 60_000
		expect(await t.post(bob, { ...create(bob, target.note), id: `${target.uri}/activity-again` })).toBe(202)
		expect(await quoteRow(t, other.uri)).toMatchObject({
			quoted_status_id: await statusId(t, target.uri),
			verify_after: null,
			hops: 0,
		})
		expect(await t.store.claimQuotes(BUILD, { now: clock.now, limit: 10 })).toMatchObject({ ids: [] })
	})

	it('18: a suspension drops the QuoteRequest and the Accept’s Update, never the forward', async () => {
		const { t, bob, theirs } = await world()
		const mine = await quotePost(t, theirs.id)
		await suspend(t, ALICE, true)
		const stamp = stampOf(bob)
		expect(await t.post(bob, accept(bob, mine.uri, stamp))).toBe(202)
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'accepted' })
		expect(await t.post(bob, await signed(bob, stampDelete(bob, stamp)))).toBe(202)
		const sent = await deliver(t)
		expect(sent.filter((s) => ['QuoteRequest', 'Update', 'Create'].includes(String(s.json.type)))).toEqual([])
		expect(sent.filter((s) => s.json.type === 'Delete' && s.json.object === stamp)).not.toEqual([])
	})

	it('20: Queue and cron rounds interleaved send each delivery once per lease, one forward, and claim no quote', async () => {
		const { t, bob, theirs } = await world()
		const carol = await mastodonActor(t.web, 'carol', { origin: 'https://fans.example', key: 3 })
		await fan(t, carol)
		const mine = await quotePost(t, theirs.id)
		const seen: string[] = []
		const answer = (url: string, body: string) => {
			const json = JSON.parse(body) as Record<string, unknown>
			seen.push(`${url} ${String(json.id)}`)
			return 202
		}
		await Promise.all([deliver(t, answer), t.store.runInboundJobs(BUILD, { now: NOW })])
		const stamp = stampOf(bob)
		expect(await t.post(bob, accept(bob, mine.uri, stamp))).toBe(202)
		expect((await api(t, 'PUT', `/api/v1/statuses/${mine.id}`, { status: 'edit' })).status).toBe(200)
		await Promise.all([deliver(t, answer), deliver(t, answer), t.store.claimQuotes(BUILD, { now: NOW, limit: 10 })])
		expect(await t.post(bob, await signed(bob, stampDelete(bob, stamp)))).toBe(202)
		await Promise.all([deliver(t, answer), jobsUntilDone(t), deliver(t, answer)])
		expect(new Set(seen).size).toBe(seen.length)
		expect(seen.filter((s) => s.includes(`${stamp}#delete`) && s.startsWith('https://fans.example'))).toHaveLength(1)
		expect(await t.store.claimQuotes(BUILD, { now: NOW + 1, limit: 10 })).toMatchObject({ ids: [] })
	})
})

const LOCAL_ORIGIN = 'https://kopje.test'

async function quoteRowTarget(t: Setup, uri: string): Promise<string | undefined> {
	return (
		await sql<{ quoted_uri: string }>(
			t.store,
			'SELECT q.quoted_uri FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?',
			uri
		)
	)[0]?.quoted_uri
}

// What a receiver holds of our quoting status `uri` after `activities` in the order they arrive: the Note it keeps and
// whether it takes our quote as accepted. Mastodon 4.5.11 and Kopje store a Create of a status they lack, apply an
// Update of one they hold, and take the quote as accepted only while the Note they hold names a stamp that was not
// deleted (their own verification of a changed stamp, and Delete#revoke_quote). Misskey ignores Note Updates
// (ApInboxService#update): it keeps the first version it imported, and reads no stamp at all.
function receiver(kind: 'mastodon' | 'kopje' | 'misskey', activities: Record<string, unknown>[], uri: string) {
	let note: Record<string, unknown> | null = null
	const deleted = new Set<string>()
	for (const activity of activities) {
		const object = activity.object
		if (activity.type === 'Delete' && typeof object === 'string') {
			deleted.add(object)
		}
		if (typeof object !== 'object' || object === null || (object as { id?: string }).id !== uri) {
			continue
		}
		if (activity.type === 'Create' && note === null) {
			note = object as Record<string, unknown>
		} else if (activity.type === 'Update' && note !== null && kind !== 'misskey') {
			note = object as Record<string, unknown>
		}
	}
	const stamp = note?.quoteAuthorization
	return {
		note,
		accepted: kind !== 'misskey' && typeof stamp === 'string' && !deleted.has(stamp),
	}
}

describe('receivers of our quote (Mastodon, Kopje, Misskey)', () => {
	it('Mastodon and Kopje converge on the stamp, then on its revocation; Misskey keeps the first version', async () => {
		const { t, bob, theirs } = await world()
		const mine = await quotePost(t, theirs.id)
		const first = await deliver(t)
		const stamp = stampOf(bob)
		expect(await t.post(bob, accept(bob, mine.uri, stamp))).toBe(202)
		const second = await deliver(t)
		const toBob = (sent: Delivered[]) => sent.filter((s) => s.inbox.startsWith(MASTODON)).map((s) => s.json)
		for (const kind of ['mastodon', 'kopje'] as const) {
			expect(receiver(kind, [...toBob(first), ...toBob(second)], mine.uri).accepted, kind).toBe(true)
		}
		// Misskey imported the first Create: _misskey_quote, and nothing of the stamp.
		const misskey = receiver('misskey', [...toBob(first), ...toBob(second)], mine.uri)
		expect(misskey).toMatchObject({ accepted: false, note: { _misskey_quote: theirs.uri } })
		expect(misskey.note).not.toHaveProperty('quoteAuthorization')
		// Reject: the stamp-free Update reaches them; a receiver that held accepted ends not accepted.
		expect(await t.post(bob, reject(bob, mine.uri))).toBe(202)
		const third = await deliver(t)
		for (const kind of ['mastodon', 'kopje'] as const) {
			expect(receiver(kind, [...toBob(first), ...toBob(second), ...toBob(third)], mine.uri).accepted, kind).toBe(false)
		}
	})

	it('a lost acknowledgement of the Create sends the pair: Misskey stays at the first version, the others update', async () => {
		const { t, theirs } = await world()
		const mine = await quotePost(t, theirs.id)
		// The Create's POST succeeds but its completion is lost: no receipt, so the edit goes as the pair.
		const claim = await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: 'lost' })
		const create = claim.deliveries.find((d) => (JSON.parse(d.body) as { type: string }).type === 'Create')
		expect(create).toBeDefined()
		expect((await api(t, 'PUT', `/api/v1/statuses/${mine.id}`, { status: 'second' })).status).toBe(200)
		const later = (await deliver(t, () => 202, NOW + 120_000))
			.filter((s) => s.inbox === create!.inbox)
			.map((s) => s.json)
		const arrived = [JSON.parse(create!.body) as Record<string, unknown>, ...later]
		expect(String(receiver('misskey', arrived, mine.uri).note?.content)).toContain('look')
		expect(String(receiver('mastodon', arrived, mine.uri).note?.content)).toContain('second')
	})
})

describe('bounds of the new reads (RES-7)', () => {
	it('finds the local quote of a stamp in one seek, however many received quotes name it', async () => {
		const lookup = readOperation<{ actor: string; stamp: string }, boolean>((db, input) =>
			holdsLocalStamp(db, { id: input.actor }, input.stamp)
		)
		const measure = async (remote: number) => {
			const { t, bob, theirs } = await world()
			const { stamp } = await acceptedQuote(t, bob, theirs.id)
			await remoteQuotesNaming(t, bob.uri, theirs.uri, theirs.id, stamp, remote)
			const actor = await statusAuthor(t, theirs.id)
			return rowsRead(t, lookup, { actor, stamp })
		}
		expect(await measure(2000)).toBe(await measure(20))
	})

	it('reads the same rows for quoted_update with 150 local quoters, whatever the received quotes', async () => {
		const read = readOperation<{ id: string }, number>((db, input) => quotedUpdates(db, input.id).length)
		const measure = async (remote: number) => {
			const { t, bob, theirs } = await world()
			await remoteQuotesNaming(t, bob.uri, theirs.uri, theirs.id, null, remote)
			await sql(t.store, "UPDATE quotes SET state = 'accepted' WHERE local = 0 AND status_id GLOB '7*'")
			await sql(
				t.store,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT printf('6%017d', i), 'https://kopje.test/ap/o/q' || i, ?1, 'public', '', '2026-10-11T12:00:00.000Z' FROM n`,
				ALICE
			)
			await sql(
				t.store,
				`INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, local, updated_at)
				SELECT id, ?1, ?2, (SELECT account_id FROM statuses WHERE id = ?2), 'accepted', 1, '2026-10-11T12:00:00.000Z'
				FROM statuses WHERE id GLOB '6*'`,
				theirs.uri,
				theirs.id
			)
			return rowsRead(t, read, { id: theirs.id })
		}
		expect(await measure(2000)).toBe(await measure(0))
	})
})

describe('review fixes', () => {
	it('a Reject leaves the stamp’s Delete to revoke the received quotes naming it, in batches, and forwards once', async () => {
		const { t, bob, theirs } = await world()
		const { mine, stamp } = await acceptedQuote(t, bob, theirs.id)
		await remoteQuotesNaming(t, bob.uri, theirs.uri, theirs.id, stamp, 300)
		expect(await t.post(bob, reject(bob, mine.uri))).toBe(202)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM quote_revocations')).toEqual([{ n: 0 }])
		expect(await t.post(bob, await signed(bob, stampDelete(bob, stamp)))).toBe(202)
		expect((await recorded(t, 'Delete')).filter((a) => a.activity.object === stamp)).toHaveLength(1)
		await jobsUntilDone(t)
		expect(
			await sql(t.store, "SELECT state, count(*) AS n FROM quotes WHERE status_id GLOB '7*' GROUP BY state")
		).toEqual([{ state: 'rejected', n: 300 }])
		expect(await sql(t.store, 'SELECT pending FROM quote_revocations')).toEqual([{ pending: 0 }])
	})

	it('after a Reject with no Delete, the stamp still accepts no other local quote', async () => {
		const { t, bob, theirs } = await world()
		const { mine, stamp } = await acceptedQuote(t, bob, theirs.id)
		expect(await t.post(bob, reject(bob, mine.uri))).toBe(202)
		const second = await quotePost(t, theirs.id)
		expect(await t.post(bob, accept(bob, second.uri, stamp))).toBe(202)
		expect(await quoteRow(t, second.uri)).toMatchObject({ state: 'pending', approval_uri: null })
		expect(await quoteRow(t, mine.uri)).toMatchObject({ state: 'revoked', approval_uri: stamp })
	})
})
