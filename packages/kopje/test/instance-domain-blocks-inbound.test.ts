import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { blockDomain } from './domain-block-helpers'
import { mastodonActor, type TestActor } from './inbox-helpers'
import {
	accountId,
	ALICE,
	announce,
	AS,
	create,
	DAVE_URI,
	followed,
	mastodonNote,
	OTHER,
	type Setup,
	setup,
	statuses,
	statusRow,
} from './inbox-status-helpers'
import { quoting, serveStamp } from './quote-helpers'
import { verifyQuotes } from '../src/federation/quotes'

// An instance domain block through the real inbound and fetch paths (R38, VIS-30; decisions 1 and 6): a request held
// at a fetch (RemoteWeb.hold) while the block commits, then released; and, once the block stands, what the Worker
// still fetches. The writes decide (upsertRemoteActor, storeRemoteStatus and the Store's gate); the Worker's policy
// read keeps requests away from the blocked host.

const DAY_MS = 86_400_000
const BLOCKED = 'mastodon.example'

const follows = (store: Setup['store']) =>
	sql<{ account_id: string; target_account_id: string }>(store, 'SELECT account_id, target_account_id FROM follows')

const requestsTo = (t: Setup, host: string, from = 0) =>
	t.web.fetched.slice(from).filter((url) => new URL(url).host === host)

function follow(actor: TestActor, n: number) {
	return { '@context': AS, id: `${actor.uri}#follows/${n}`, type: 'Follow', actor: actor.uri, object: DAVE_URI }
}

describe('a block that commits while an inbound request is at its fetch (rows 5, 6)', () => {
	it('stores no account and no follow for a Follow held at its key fetch, and fetches nothing from the host after', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const keyFetch = t.web.hold(bob.uri)
		const response = t.post(bob, follow(bob, 1))
		await keyFetch.reached
		await blockDomain(t.store, BLOCKED)
		keyFetch.release()
		expect(await response).toBe(202)
		expect(await accountId(t.store, bob.uri)).toBeUndefined()
		expect(await follows(t.store)).toEqual([])
		// Once the block stands, the Worker refuses the Follow before any fetch.
		const fetched = t.web.fetched.length
		expect(await t.post(bob, follow(bob, 2))).toBe(202)
		expect(t.web.fetched.slice(fetched)).toEqual([])
		expect(await follows(t.store)).toEqual([])
	})

	it("ignores round 2 of an Announce whose actor's domain is blocked during its fetch of the original", async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const carol = await mastodonActor(t.web, 'carol', { origin: OTHER, key: 2 })
		const note = mastodonNote(carol)
		t.web.serve(note.id, { '@context': AS, ...note })
		const original = t.web.hold(note.id)
		const response = t.post(bob, announce(bob, note.id))
		await original.reached
		await blockDomain(t.store, BLOCKED)
		original.release()
		expect(await response).toBe(202)
		expect(await statuses(t.store)).toEqual([])
		expect(await accountId(t.store, carol.uri)).toBeUndefined()
	})

	it('stores neither the original nor its author when their domain is blocked during that fetch', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const carol = await mastodonActor(t.web, 'carol', { origin: OTHER, key: 2 })
		const note = mastodonNote(carol)
		t.web.serve(note.id, { '@context': AS, ...note })
		const original = t.web.hold(note.id)
		const response = t.post(bob, announce(bob, note.id))
		await original.reached
		await blockDomain(t.store, 'other.example')
		original.release()
		expect(await response).toBe(202)
		expect(await statuses(t.store)).toEqual([])
		expect(await accountId(t.store, carol.uri)).toBeUndefined()
		// After the block, another Announce of a status there fetches nothing from it.
		const fetched = t.web.fetched.length
		const later = mastodonNote(carol)
		t.web.serve(later.id, { '@context': AS, ...later })
		expect(await t.post(bob, announce(bob, later.id))).toBe(202)
		expect(requestsTo(t, 'other.example', fetched)).toEqual([])
		expect(await statuses(t.store)).toEqual([])
	})
})

describe("a blocked domain's cleanups are verified with stored keys only (row 8, decision 1)", () => {
	it('applies a Delete signed with a key stored before the block, fetching nothing; refuses one that needs a fetch', async () => {
		const clock = { now: NOW }
		const t = await setup(clock)
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		const kept = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		expect(await t.post(bob, create(bob, kept))).toBe(202)
		expect(await statusRow(t.store, note.id)).toBeDefined()
		await blockDomain(t.store, BLOCKED)
		// Three days on, the stored key is past its 24 hours.
		clock.now = NOW + 3 * DAY_MS
		const fetched = t.web.fetched.length
		const keysBefore = await sql(t.store, 'SELECT key_id, pem, fetched_at FROM remote_keys')
		const deletion = (object: string) => ({
			'@context': AS,
			id: `${object}#delete`,
			type: 'Delete',
			actor: bob.uri,
			object: { id: object, type: 'Tombstone' },
		})
		expect(await t.post(bob, deletion(note.id))).toBe(202)
		expect(await statusRow(t.store, note.id)).toBeUndefined()
		// A key the Store does not hold (rotated): refused, and nothing fetched to learn it.
		const next = await mastodonActor(t.web, 'bob', { key: 5 })
		const keyId = `${bob.uri}#key-2`
		t.web.serve(bob.uri, { ...next.document, publicKey: { id: keyId, owner: bob.uri, publicKeyPem: next.pem } })
		expect(await t.post(bob, deletion(kept.id), { keyId, privateKey: next.privateKey })).toBe(401)
		expect(await statusRow(t.store, kept.id)).toBeDefined()
		// Anything but a cleanup is ignored before any fetch.
		expect(await t.post(bob, create(bob, mastodonNote(bob)))).toBe(202)
		expect(
			await t.post(bob, {
				'@context': AS,
				id: `${bob.uri}#quote-requests/1`,
				type: 'QuoteRequest',
				actor: bob.uri,
				object: `${'https://kopje.test'}/ap/users/alice/statuses/1`,
				instrument: mastodonNote(bob).id,
			})
		).toBe(202)
		expect(t.web.fetched.slice(fetched)).toEqual([])
		expect(await sql(t.store, 'SELECT key_id, pem, fetched_at FROM remote_keys')).toEqual(keysBefore)
	})
})

describe("a covered actor's activities that Kopje does not read are judged before verification (decision 1)", () => {
	// A Flag (a type Kopje does not read) and a Create whose object is malformed, each signed with a key on another,
	// unblocked host: verification would fetch that key. bob is covered by his host, or, stored, by his stored domain.
	it.each(['host', 'stored domain'] as const)('fetches nothing for them when bob is covered by his %s', async (by) => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { origin: OTHER, key: 2 })
		if (by === 'host') {
			await blockDomain(t.store, BLOCKED)
		} else {
			await followed(t, bob)
			await sql(t.store, "UPDATE accounts SET domain = 'covered.example' WHERE uri = ?", bob.uri)
			await blockDomain(t.store, 'covered.example')
		}
		const signer = { keyId: carol.keyId, privateKey: carol.privateKey }
		const fetched = t.web.fetched.length
		const flag = { '@context': AS, id: `${bob.uri}#flags/1`, type: 'Flag', actor: bob.uri, object: DAVE_URI }
		const malformed = {
			'@context': AS,
			id: `${bob.uri}/statuses/9/activity`,
			type: 'Create',
			actor: bob.uri,
			object: 7,
		}
		expect(await t.post(bob, flag, signer)).toBe(202)
		expect(await t.post(bob, malformed, signer)).toBe(202)
		expect(t.web.fetched.slice(fetched)).toEqual([])
	})
})

describe('fetches outside the inbox after a block (rows 9, 10)', () => {
	it('stores no account for a resolve held at its fetch, and requests nothing from the host afterwards', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const query = `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(bob.uri)}`
		const held = t.web.hold(bob.uri)
		const response = t.api<{ accounts: unknown[] }>(query)
		await held.reached
		await blockDomain(t.store, BLOCKED)
		held.release()
		expect(await response).toMatchObject({ status: 200, body: { accounts: [] } })
		expect(await accountId(t.store, bob.uri)).toBeUndefined()
		const fetched = t.web.fetched.length
		expect(await t.api<{ accounts: unknown[] }>(query)).toMatchObject({ status: 200, body: { accounts: [] } })
		const note = mastodonNote(bob)
		t.web.serve(note.id, { '@context': AS, ...note })
		expect(
			await t.api<{ statuses: unknown[] }>(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`)
		).toMatchObject({ status: 200, body: { statuses: [] } })
		expect(requestsTo(t, BLOCKED, fetched)).toEqual([])
	})

	// Job rounds as the Queue and cron run them, until no quote's work is due; how many it took.
	async function rounds(t: Setup): Promise<number> {
		const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW }
		let n = 1
		while (await verifyQuotes(t.env, deps)) {
			n++
			expect(n).toBeLessThan(20)
		}
		return n
	}

	// bob's quote of erin's status, whose author the round does not know yet.
	async function quoted(t: Setup) {
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 7 })
		const target = mastodonNote(erin)
		t.web.serve(target.id, { '@context': AS, ...target })
		const stamp = `${erin.uri}/quote_authorizations/1`
		const quote = quoting(bob, target.id, stamp)
		serveStamp(t.web, stamp, erin, quote.id, target.id)
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		return { erin, target }
	}

	it('ends the quote work when the block commits at the author fetch: no account, no loop', async () => {
		const t = await setup()
		const { erin, target } = await quoted(t)
		const author = t.web.hold(erin.uri)
		const running = rounds(t)
		await author.reached
		await blockDomain(t.store, 'other.example')
		author.release()
		expect(await running).toBeLessThan(5)
		expect(await sql(t.store, 'SELECT state, verify_after FROM quotes')).toEqual([
			{ state: 'pending', verify_after: null },
		])
		expect(await accountId(t.store, erin.uri)).toBeUndefined()
		expect(await statusRow(t.store, target.id)).toBeUndefined()
	})

	it('ends the quote work with no request to the host once the block stands', async () => {
		const t = await setup()
		const { erin } = await quoted(t)
		await blockDomain(t.store, 'other.example')
		const fetched = t.web.fetched.length
		expect(await rounds(t)).toBeLessThan(5)
		expect(requestsTo(t, 'other.example', fetched)).toEqual([])
		expect(await sql(t.store, 'SELECT state, verify_after FROM quotes')).toEqual([
			{ state: 'pending', verify_after: null },
		])
		expect(await accountId(t.store, erin.uri)).toBeUndefined()
		expect(await sql(t.store, 'SELECT account_id FROM follows WHERE account_id = ?', ALICE)).toHaveLength(1)
	})
})
