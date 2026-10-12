import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { harness, NOW } from './app-helpers'
import { fixtureKeyGen } from './federation-helpers'
import { BUILD } from './helpers'
import { mastodonActor, RemoteWeb, signedInit, type TestActor } from './inbox-helpers'
import { community } from './status-helpers'
import { MAX_RETRACTIONS_PER_ACTOR } from '../src/domain/inbox'
import type { StoreStub } from '../src/platform/store-client'

// Regressions from the fourth verification of B1b-1: a Block undone by a pair-shaped id, and the Block id change at
// the retraction cap (ID-7).

const AS = 'https://www.w3.org/ns/activitystreams'
const DAY = 24 * 60 * 60 * 1000

let sequence = 0
const nextId = (actor: TestActor) => `${new URL(actor.uri).origin}/activities/v${++sequence}`

const count = async (store: StoreStub, query: string, ...params: SqlStorageValue[]) =>
	(await sql<{ n: number }>(store, `SELECT count(*) AS n FROM (${query})`, ...params))[0]!.n

async function together() {
	const h = await community(['alice'])
	const alice = h.users.alice
	const aliceUri = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM accounts WHERE id = ?', alice.id))[0]!.uri
	const web = new RemoteWeb()
	const inbox = harness(h.store, {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader })
	const post = async (actor: TestActor, activity: unknown) =>
		(await inbox.request('/inbox', await signedInit(actor, '/inbox', activity))).status
	const follow = (actor: TestActor, id = nextId(actor)) => ({
		'@context': AS,
		id,
		type: 'Follow',
		actor: actor.uri,
		object: aliceUri,
	})
	const block = (actor: TestActor, id: string) => ({
		'@context': AS,
		id,
		type: 'Block',
		actor: actor.uri,
		object: aliceUri,
	})
	const undo = (actor: TestActor, object: unknown) => ({
		'@context': AS,
		id: nextId(actor),
		type: 'Undo',
		actor: actor.uri,
		object,
	})
	return { h, alice, aliceUri, web, post, follow, block, undo }
}

describe('ID-7: an Undo records a Block whatever the shape of its id', () => {
	it('keeps a Block with a pair-shaped id undone when it is delivered again', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		const b = t.block(bob, 'https://mastodon.example/follows/a/b')
		await t.post(bob, b)
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(1)
		await t.post(bob, t.undo(bob, { id: b.id, type: 'Block', actor: bob.uri, object: t.aliceUri }))
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
		expect(await t.post(bob, b)).toBe(202)
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
	})

	it('keeps an untyped Undo of a stored pair-shaped Block from letting it come back', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		const b = t.block(bob, 'https://mastodon.example/follows/a/b')
		await t.post(bob, b)
		await t.post(bob, t.undo(bob, b.id))
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
		await t.post(bob, b)
		expect(await count(t.h.store, 'SELECT 1 FROM blocks')).toBe(0)
	})

	// Coverage: the old code already refused this change; nothing pinned it.
	it('changes nothing when a Block takes a new id at the retraction cap', async () => {
		const t = await together()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, t.follow(bob))
		const b1 = t.block(bob, `${bob.uri}#blocks/1`)
		await t.post(bob, b1)
		await sql(
			t.h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/seeded/' || i, ? FROM n`,
			MAX_RETRACTIONS_PER_ACTOR,
			bob.uri,
			bob.uri,
			NOW + DAY
		)
		const snapshot = async () => ({
			blocks: await sql(t.h.store, 'SELECT account_id, target_account_id, uri FROM blocks ORDER BY id'),
			follows: await sql(t.h.store, 'SELECT account_id, target_account_id, state, uri FROM follows ORDER BY id'),
			deliveries: await sql(t.h.store, 'SELECT id, inbox_url, state FROM deliveries ORDER BY id'),
			intents: await sql(t.h.store, 'SELECT id FROM outbound_activities ORDER BY id'),
		})
		const before = await snapshot()
		expect(before.blocks).toEqual([expect.objectContaining({ uri: b1.id })])
		expect(await t.post(bob, t.block(bob, `${bob.uri}#blocks/2`))).toBe(202)
		expect(await snapshot()).toEqual(before)
	})
})
