import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { inboxDeps, NOW } from './app-helpers'
import { BUILD } from './helpers'
import { LOCAL, MASTODON, mastodonActor, type TestActor } from './inbox-helpers'
import {
	accountId,
	ALICE,
	ALICE_URI,
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
	undo,
} from './inbox-status-helpers'
import { quoting, serveStamp } from './quote-helpers'
import { Db } from '../src/db/sql'
import { MOVE_BATCH } from '../src/domain/inbox'
import { suspendRemote } from '../src/domain/remote-suspension'
import { verifyQuotes } from '../src/federation/quotes'
import type { StoreStub } from '../src/platform/store-client'

// Inbound activities of an account the instance suspended (R38, VIS-30), through the real inbound path: signed requests
// verified by the Worker, then the Store's gate in every round (concurrency rows 5, 7, 8 and 10, and changes 3 and 4 of
// the phase B design). The suspension is the admin API's (domain/remote-suspension.ts), committed while the request
// is held at a fetch: a deterministic gate of the remote web (RemoteWeb.hold).

async function suspend(store: StoreStub, id: string): Promise<void> {
	await runInDurableObject(store, (_instance, state) =>
		state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), id, null, NOW))
	)
}

// The Store's jobs as the Queue runs them, until none is left.
async function settle(store: StoreStub): Promise<void> {
	for (let call = 0; (await store.runInboundJobs(BUILD, { now: NOW })).pending; call++) {
		expect(call).toBeLessThan(100)
	}
}

const row = async (store: StoreStub, id: string) =>
	(
		await sql<{ display_name: string; fetched_at: string; inbox_url: string; shared_inbox_url: string; raw: string }>(
			store,
			'SELECT display_name, fetched_at, inbox_url, shared_inbox_url, raw FROM accounts WHERE id = ?',
			id
		)
	)[0]
const keys = (store: StoreStub) =>
	sql(store, 'SELECT key_id, account_id, pem, fetched_at FROM remote_keys ORDER BY key_id')

// The actor's document now lists another key (and another name): what it signs with, and the key's id.
async function rotated(t: Setup, actor: TestActor) {
	const next = await mastodonActor(t.web, actor.uri.split('/').at(-1)!, { key: 5, extra: { name: 'Renamed' } })
	const keyId = `${actor.uri}#key-2`
	t.web.serve(actor.uri, { ...next.document, publicKey: { id: keyId, owner: actor.uri, publicKeyPem: next.pem } })
	return { keyId, privateKey: next.privateKey }
}

describe('the gate after the fetches before round 1 (rows 5 and 8)', () => {
	it('ignores a Create whose owner document was fetched before the suspension, and keeps the row frozen', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const before = await row(t.store, bobId)
		const keysBefore = await keys(t.store)
		const signer = await rotated(t, bob)
		// The new key is fetched with the owner document that lists it (one fetch): held there.
		const ownerFetch = t.web.hold(bob.uri)
		const note = mastodonNote(bob)
		const response = t.post(bob, create(bob, note), signer)
		await ownerFetch.reached
		await suspend(t.store, bobId)
		ownerFetch.release()
		expect(await response).toBe(202)
		expect(await statusRow(t.store, note.id)).toBeUndefined()
		expect(await row(t.store, bobId)).toEqual(before)
		expect(await keys(t.store)).toEqual(keysBefore)
	})

	it('applies a Delete signed with a key the suspended actor lists now, and stores nothing of that key', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const note = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		expect(await statusRow(t.store, note.id)).toBeDefined()
		await suspend(t.store, bobId)
		const before = await row(t.store, bobId)
		const keysBefore = await keys(t.store)
		const signer = await rotated(t, bob)
		const deletion = {
			'@context': AS,
			id: `${note.id}#delete`,
			type: 'Delete',
			actor: bob.uri,
			object: { id: note.id, type: 'Tombstone' },
		}
		expect(await t.post(bob, deletion, signer)).toBe(202)
		expect(await statusRow(t.store, note.id)).toBeUndefined()
		expect(await keys(t.store)).toEqual(keysBefore)
		expect(await row(t.store, bobId)).toEqual(before)
	})

	it('ignores round 2 of an Announce when the suspension commits during its fetch of the original', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const carol = await mastodonActor(t.web, 'carol', { origin: OTHER, key: 2 })
		const note = mastodonNote(carol)
		t.web.serve(note.id, { '@context': AS, ...note })
		const original = t.web.hold(note.id)
		const response = t.post(bob, announce(bob, note.id))
		await original.reached
		await suspend(t.store, bobId)
		original.release()
		expect(await response).toBe(202)
		expect(await statuses(t.store)).toEqual([])
		expect(await accountId(t.store, carol.uri)).toBeUndefined()
	})
})

describe("a suspended actor's cleanups while its job waits (row 7, change 4)", () => {
	it('takes a routing refresh only, then applies its Undo and Reject; the job’s Reject goes to the new inbox', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const followsOf = (target: string) => ({
			'@context': AS,
			id: `${bob.uri}#follows/${target.split('/').at(-1)}`,
			type: 'Follow',
			actor: bob.uri,
			object: target,
		})
		expect(await t.post(bob, followsOf(ALICE_URI))).toBe(202)
		expect(await t.post(bob, followsOf(DAVE_URI))).toBe(202)
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			ALICE,
			bobId
		)
		await suspend(t.store, bobId)
		const before = await row(t.store, bobId)
		const keysBefore = await keys(t.store)
		// bob's verified Update names a new inbox (and a new name).
		const inbox = `${MASTODON}/users/bob/inbox2`
		const moved = { ...bob.document, inbox, name: 'Renamed', endpoints: { sharedInbox: `${MASTODON}/inbox2` } }
		t.web.serve(bob.uri, moved)
		const update = { '@context': AS, id: `${bob.uri}#updates/1`, type: 'Update', actor: bob.uri, object: moved }
		expect(await t.post(bob, update)).toBe(202)
		expect(await row(t.store, bobId)).toEqual({ ...before, inbox_url: inbox, shared_inbox_url: `${MASTODON}/inbox2` })
		expect(await keys(t.store)).toEqual(keysBefore)
		// bob's Undo of its follow of alice, and its Reject of alice's follow, apply.
		expect(await t.post(bob, undo(bob, followsOf(ALICE_URI)))).toBe(202)
		const reject = {
			'@context': AS,
			id: `${bob.uri}#rejects/follows/1`,
			type: 'Reject',
			actor: bob.uri,
			object: { type: 'Follow', actor: ALICE_URI, object: bob.uri },
		}
		expect(await t.post(bob, reject)).toBe(202)
		expect(
			await sql(
				t.store,
				'SELECT account_id, target_account_id FROM follows WHERE ? IN (account_id, target_account_id)',
				bobId
			)
		).toEqual([{ account_id: bobId, target_account_id: '222222222222222222' }])
		// The job: bob's follow of dave ends with a withdrawing Reject, to the shared inbox the refresh stored alone (not
		// to the inbox its queued Accept was for), as Mastodon sends it.
		await settle(t.store)
		expect(
			await sql(
				t.store,
				`SELECT d.inbox_url AS inbox, o.retracts FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id
				WHERE json_extract(o.body, '$.activity.type') = 'Reject' ORDER BY d.id`
			)
		).toEqual([{ inbox: `${MASTODON}/inbox2`, retracts: 1 }])
		expect(await sql(t.store, 'SELECT * FROM follows WHERE ? IN (account_id, target_account_id)', bobId)).toEqual([])
	})

	it('applies a Delete of its status, withdrawing the local boost, and a DeleteActor whose purge ends the job', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const note = mastodonNote(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		const status = (await statusRow(t.store, note.id))!.id
		const boosted = await t.request(`/api/v1/statuses/${status}/reblog`, {
			method: 'POST',
			headers: { authorization: `Bearer ${t.tokens.alice}` },
		})
		expect(boosted.status).toBe(200)
		await sql(t.store, 'DELETE FROM deliveries')
		await suspend(t.store, bobId)
		const deletion = {
			'@context': AS,
			id: `${note.id}#delete`,
			type: 'Delete',
			actor: bob.uri,
			object: { id: note.id, type: 'Tombstone' },
		}
		expect(await t.post(bob, deletion)).toBe(202)
		expect(await statuses(t.store)).toEqual([])
		// The boost's Undo is a retraction: it leaves for bob's server though bob is suspended.
		const sent: string[] = []
		for (let round = 0; round < 20; round++) {
			const claimed = await t.store.claimDeliveries(BUILD, { now: NOW, leaseToken: `l${round}` })
			for (const delivery of claimed.deliveries) {
				const confirmation = await t.store.confirmDelivery(BUILD, {
					id: delivery.id,
					leaseToken: `l${round}`,
					now: NOW,
				})
				if (confirmation.status === 'send') {
					sent.push(`${(JSON.parse(confirmation.body) as { type: string }).type} ${delivery.inbox}`)
				}
				await t.store.completeDelivery(BUILD, {
					id: delivery.id,
					leaseToken: `l${round}`,
					now: NOW,
					outcome: { kind: 'delivered', status: 202 },
				})
			}
			if (claimed.deliveries.length === 0 && claimed.nextDueAt === null) {
				break
			}
		}
		expect(sent).toContain(`Undo ${MASTODON}/inbox`)
		expect(sent.filter((line) => !line.startsWith('Undo'))).toEqual([])
		// The DeleteActor, then the purge and the job's next round in the same Queue calls.
		t.web.fail(bob.uri, 410)
		const gone = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, gone)).toBe(202)
		await settle(t.store)
		expect(await accountId(t.store, bob.uri)).toBeUndefined()
		expect(await sql(t.store, 'SELECT * FROM remote_moderation_jobs')).toEqual([])
	})
})

describe('a Move whose source is suspended (change 3)', () => {
	it('moves no more followers once the source is suspended between batches', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bob2 = await mastodonActor(t.web, 'bob2', { origin: 'https://new.example', key: 2 })
		t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] })
		await t.post(bob, { '@context': AS, id: `${bob.uri}#follows/1`, type: 'Follow', actor: bob.uri, object: DAVE_URI })
		const bobId = (await accountId(t.store, bob.uri))!
		const followers = MOVE_BATCH * 2 + 10
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('5%017d', i), ? || i, 'u' || i, NULL FROM n`,
			followers,
			`${LOCAL}/ap/users/u`
		)
		await sql(
			t.store,
			`INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
			SELECT id, username || '@mail.example', x'00', x'00', 'k' FROM accounts WHERE id GLOB '5*'`
		)
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) SELECT id, ?, 'accepted' FROM accounts WHERE id GLOB '5*'",
			bobId
		)
		const moved = async () =>
			(
				await sql<{ n: number }>(
					t.store,
					'SELECT count(*) AS n FROM follows f JOIN accounts a ON a.id = f.target_account_id WHERE a.uri = ?',
					bob2.uri
				)
			)[0]!.n
		const move = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: bob2.uri,
		}
		expect(await t.post(bob, move)).toBe(202)
		expect(await moved()).toBe(MOVE_BATCH)
		await suspend(t.store, bobId)
		await settle(t.store)
		expect(await moved()).toBe(MOVE_BATCH)
		expect(await sql(t.store, "SELECT * FROM inbound_jobs WHERE kind = 'move' AND done_at IS NULL")).toEqual([])
	})
})

describe('the quote author stage (row 10)', () => {
	// Job rounds as the Queue and cron run them, until no quote's work is due at `now`; how many it took.
	async function rounds(t: Setup, now: number): Promise<number> {
		const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => now }
		let n = 1
		while (await verifyQuotes(t.env, deps)) {
			n++
			expect(n).toBeLessThan(20)
		}
		return n
	}

	it('ends the work when the author it fetched was suspended meanwhile: nothing stored, no loop', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const erin = await mastodonActor(t.web, 'erin', { origin: OTHER, key: 7 })
		const target = mastodonNote(erin)
		t.web.serve(target.id, { '@context': AS, ...target })
		const stamp = `${erin.uri}/quote_authorizations/1`
		const quote = quoting(bob, target.id, stamp)
		serveStamp(t.web, stamp, erin, quote.id, target.id)
		expect(await t.post(bob, create(bob, quote))).toBe(202)
		// The round fetches the quoted status, whose author is unknown, then the author: held there.
		const author = t.web.hold(erin.uri)
		const running = rounds(t, NOW)
		await author.reached
		// Meanwhile erin becomes known (her Follow of dave) and the admin suspends her.
		expect(
			await t.post(erin, {
				'@context': AS,
				id: `${erin.uri}#follows/1`,
				type: 'Follow',
				actor: erin.uri,
				object: DAVE_URI,
			})
		).toBe(202)
		const erinId = (await accountId(t.store, erin.uri))!
		await suspend(t.store, erinId)
		const before = await row(t.store, erinId)
		const fetched = t.web.fetched.length
		author.release()
		expect(await running).toBeLessThan(5)
		// Her arrival moves the work back to the quoted status (its author is known now), which the next stage fetches
		// once more and, its author being unavailable, does not store (storeRemoteStatus): the work ends there.
		expect(t.web.fetched.slice(fetched)).toEqual([erin.uri, target.id])
		expect(await sql(t.store, 'SELECT state, verify_after FROM quotes')).toEqual([
			{ state: 'pending', verify_after: null },
		])
		expect(await statusRow(t.store, target.id)).toBeUndefined()
		expect(await row(t.store, erinId)).toEqual(before)
	})
})
