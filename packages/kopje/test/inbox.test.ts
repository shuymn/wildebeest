import { describe, expect, it } from 'vitest'

import { seedFollows, sql } from './api-helpers'
import { harness, inboxDeps, NOW } from './app-helpers'
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from './federation-helpers'
import { BUILD, completeSetup, migratedStore } from './helpers'
import {
	AP,
	LOCAL,
	MASTODON,
	mastodonActor,
	MISSKEY,
	MISSKEY_CONTEXT,
	misskeyActor,
	RemoteWeb,
	type SignOptions,
	signedInit,
	type TestActor,
} from './inbox-helpers'
import { MAX_RETRACTIONS_PER_ACTOR, PURGE_BATCH, RETRACTION_TTL_MS, SWEEP_BATCH } from '../src/domain/inbox'
import { handleQueue } from '../src/jobs/queue'
import { sha256Hex } from '../src/platform/sha256'
import type { StoreStub } from '../src/platform/store-client'

// Inbound activities about actors and relationships (B1b-1), end to end through the app: signed requests from
// synthetic Mastodon- and Misskey-shaped servers, the Store's effects, and the threat model's B1b negative cases. Test
// names cite the invariants (docs/threat-model.md).

const AS = 'https://www.w3.org/ns/activitystreams'
const ALICE = '111111111111111111'
const ALICE_URI = `${LOCAL}/ap/users/alice`
const DAVE = '222222222222222222'
const DAVE_URI = `${LOCAL}/ap/users/dave`

async function setup(options: { locked?: boolean; env?: Record<string, unknown> } = {}) {
	const store = await migratedStore()
	await completeSetup(store)
	await seedLocalAccount(store, 'kopje.test', {
		id: ALICE,
		username: 'alice',
		key: LEGACY_EMPTY_KEK,
		locked: options.locked ?? false,
	})
	await seedLocalAccount(store, 'kopje.test', { id: DAVE, username: 'dave', key: LEGACY_EMPTY_KEK })
	const web = new RemoteWeb()
	const h = harness(store, options.env ?? {}, BUILD, { keygen: fixtureKeyGen, loader: web.loader })
	const send = async (actor: TestActor, activity: unknown, options: SignOptions & { path?: string } = {}) => {
		const path = options.path ?? '/inbox'
		return (await h.request(path, await signedInit(actor, path, activity, options))).status
	}
	return { store, web, ...h, post: send }
}

type Setup = Awaited<ReturnType<typeof setup>>

let sequence = 0
function activityId(origin: string): string {
	return `${origin}/activities/${++sequence}`
}

function follow(actor: TestActor, object = ALICE_URI, id = activityId(new URL(actor.uri).origin)) {
	return { '@context': AS, id, type: 'Follow', actor: actor.uri, object }
}

function undo(actor: TestActor, object: unknown, id = activityId(new URL(actor.uri).origin)) {
	return { '@context': AS, id, type: 'Undo', actor: actor.uri, object }
}

const follows = (store: StoreStub) =>
	sql<{ account_id: string; target_account_id: string; state: string; uri: string | null }>(
		store,
		'SELECT account_id, target_account_id, state, uri FROM follows ORDER BY id'
	)
const notifications = (store: StoreStub) =>
	sql<{ account_id: string; type: string }>(store, 'SELECT account_id, type FROM notifications ORDER BY id')
const outbound = async (store: StoreStub) =>
	(await sql<{ body: string }>(store, 'SELECT body FROM outbound_activities ORDER BY id')).map(
		(row) => JSON.parse(row.body) as { activity: Record<string, unknown>; audience: unknown }
	)
const accountId = async (store: StoreStub, uri: string) =>
	(await sql<{ id: string }>(store, 'SELECT id FROM accounts WHERE uri = ?', uri))[0]?.id
const counts = async (store: StoreStub, id: string) =>
	(
		await sql<{ followers_count: number; following_count: number }>(
			store,
			'SELECT followers_count, following_count FROM accounts WHERE id = ?',
			id
		)
	)[0]

// Nothing at all changed in the tables an activity writes.
async function untouched(store: StoreStub): Promise<void> {
	for (const table of ['follows', 'blocks', 'notifications', 'outbound_activities', 'inbound_retractions', 'mutes']) {
		expect(await sql(store, `SELECT * FROM ${table}`), table).toEqual([])
	}
	expect(await sql(store, 'SELECT uri FROM accounts WHERE domain IS NOT NULL')).toEqual([])
}

// Our pending follow of a remote actor, as the follow API leaves it.
async function ourFollow(t: Setup, remote: TestActor, follower = ALICE): Promise<string> {
	await t.post(remote, follow(remote, DAVE_URI))
	const id = (await accountId(t.store, remote.uri))!
	await sql(
		t.store,
		"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'pending')",
		follower,
		id
	)
	return id
}

describe('Follow of a local account (Mastodon and Misskey)', () => {
	it('accepts an unlocked account at once: the follow, a notification, an Accept intent, the counts', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const activity = follow(bob)
		expect(await t.post(bob, activity)).toBe(202)

		const bobId = (await accountId(t.store, bob.uri))!
		expect(await follows(t.store)).toEqual([
			{ account_id: bobId, target_account_id: ALICE, state: 'accepted', uri: activity.id },
		])
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'follow' }])
		expect(await outbound(t.store)).toEqual([
			{
				activity: {
					'@context': AS,
					id: `${ALICE_URI}#accepts/follows/${sha256Hex(activity.id)}`,
					type: 'Accept',
					actor: ALICE_URI,
					object: { id: activity.id, type: 'Follow', actor: bob.uri, object: ALICE_URI },
				},
				audience: { followers: false, accounts: [bobId] },
			},
		])
		expect(await counts(t.store, ALICE)).toEqual({ followers_count: 1, following_count: 0 })
	})

	it('keeps a request pending for a locked account, with a follow_request notification and no Accept', async () => {
		const t = await setup({ locked: true })
		const bob = await mastodonActor(t.web, 'bob')
		expect(await t.post(bob, follow(bob))).toBe(202)

		expect((await follows(t.store)).map((f) => f.state)).toEqual(['pending'])
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'follow_request' }])
		expect(await outbound(t.store)).toEqual([])
		expect(await counts(t.store, ALICE)).toEqual({ followers_count: 0, following_count: 0 })
	})

	it('stores the remote actor from its verified document (HTML-1 bio, plain display name, HTML-3 URLs)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob', {
			extra: {
				summary: '<p onclick="x()">Hi <script>alert(1)</script><a href="javascript:alert(1)">bad</a> <h2>T</h2></p>',
				url: 'javascript:alert(1)',
				icon: { type: 'Image', url: 'data:image/png;base64,AAAA' },
			},
		})
		expect(await t.post(bob, follow(bob))).toBe(202)

		expect(
			await sql(
				t.store,
				`SELECT username, domain, actor_type, display_name, note, url, avatar_url, header_url, locked, discoverable,
					inbox_url, shared_inbox_url, json_extract(raw, '$.followers') AS followers, fetched_at
				FROM accounts WHERE uri = ?`,
				bob.uri
			)
		).toEqual([
			{
				username: 'bob',
				domain: 'mastodon.example',
				actor_type: 'Person',
				display_name: 'bob <b>display</b>',
				// A heading closes the open <p>, and the stray </p> is an empty paragraph, as a browser reads them.
				note: '<p>Hi <a rel="nofollow noopener" target="_blank">bad</a> </p><p><strong>T</strong></p><p></p>',
				url: null,
				avatar_url: null,
				header_url: `${MASTODON}/system/headers/bob.png`,
				locked: 0,
				discoverable: 1,
				inbox_url: `${bob.uri}/inbox`,
				shared_inbox_url: `${MASTODON}/inbox`,
				followers: `${bob.uri}/followers`,
				fetched_at: new Date(NOW).toISOString(),
			},
		])
	})

	it("reads a Misskey actor with its quirks (_misskey_* fields, isCat, a Key-typed key) and Misskey's Follow", async () => {
		const t = await setup()
		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		const activity = {
			'@context': MISSKEY_CONTEXT,
			id: `${MISSKEY}/follows/9abcdefghi/${ALICE}`,
			type: 'Follow',
			actor: neko.uri,
			object: ALICE_URI,
		}
		expect(await t.post(neko, activity)).toBe(202)

		const nekoId = (await accountId(t.store, neko.uri))!
		expect(await follows(t.store)).toEqual([
			{ account_id: nekoId, target_account_id: ALICE, state: 'accepted', uri: activity.id },
		])
		expect(
			await sql(
				t.store,
				`SELECT username, domain, display_name, note, url, avatar_url, header_url, shared_inbox_url,
					json_extract(raw, '$.isCat') AS is_cat, json_extract(raw, '$._misskey_summary') AS mfm FROM accounts WHERE id = ?`,
				nekoId
			)
		).toEqual([
			{
				username: 'neko',
				domain: 'misskey.example',
				display_name: 'みすきー :cat:',
				note: '<p><span>にゃーん</span><br><a href="https://misskey.example/@friend" class="u-url mention" rel="nofollow noopener" target="_blank">@friend</a></p>',
				url: `${MISSKEY}/@neko`,
				avatar_url: `${MISSKEY}/files/avatar-9abcdefghi.webp`,
				header_url: null,
				shared_inbox_url: `${MISSKEY}/inbox`,
				is_cat: 1,
				mfm: 'にゃーん\n@friend',
			},
		])
	})

	it('accepts on a personal inbox, fetching with the recipient’s key (DATA-7)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		expect(await t.post(bob, follow(bob), { path: '/ap/users/alice/inbox' })).toBe(202)
		expect(new Set(t.web.signers)).toEqual(new Set([`${ALICE_URI}#main-key`]))
		expect(await follows(t.store)).toHaveLength(1)
	})
})

describe('Undo, Accept and Reject (Mastodon and Misskey)', () => {
	it('removes a follow on a Mastodon Undo with the embedded Follow, with its notification and count', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const activity = follow(bob)
		await t.post(bob, activity)
		expect(await t.post(bob, undo(bob, { ...activity, '@context': undefined }))).toBe(202)

		expect(await follows(t.store)).toEqual([])
		expect(await notifications(t.store)).toEqual([])
		expect(await counts(t.store, ALICE)).toEqual({ followers_count: 0, following_count: 0 })
	})

	it("removes a follow on Misskey's Undo, and on an Undo naming the Follow by id only", async () => {
		const t = await setup()
		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		const followId = `${MISSKEY}/follows/9abcdefghi/${ALICE}`
		const misskeyFollow = { id: followId, type: 'Follow', actor: neko.uri, object: ALICE_URI }
		await t.post(neko, { '@context': MISSKEY_CONTEXT, ...misskeyFollow })
		const misskeyUndo = {
			'@context': MISSKEY_CONTEXT,
			type: 'Undo',
			id: `${MISSKEY}/a1`,
			actor: neko.uri,
			object: misskeyFollow,
		}
		expect(await t.post(neko, misskeyUndo)).toBe(202)
		expect(await follows(t.store)).toEqual([])

		const bob = await mastodonActor(t.web, 'bob')
		const byId = follow(bob)
		await t.post(bob, byId)
		expect(await t.post(bob, undo(bob, byId.id))).toBe(202)
		expect(await follows(t.store)).toEqual([])
	})

	it('accepts our pending follow on a Mastodon Accept and a Misskey Accept (embedded Follow)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await ourFollow(t, bob)
		const mastodonAccept = {
			'@context': AS,
			id: `${bob.uri}#accepts/follows/77`,
			type: 'Accept',
			actor: bob.uri,
			object: { id: `${LOCAL}/some-follow`, type: 'Follow', actor: ALICE_URI, object: bob.uri },
		}
		expect(await t.post(bob, mastodonAccept)).toBe(202)
		expect((await follows(t.store)).find((f) => f.target_account_id === bobId)?.state).toBe('accepted')
		expect(await counts(t.store, ALICE)).toEqual({ followers_count: 0, following_count: 1 })

		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		const nekoId = await ourFollow(t, neko)
		const misskeyAccept = {
			'@context': MISSKEY_CONTEXT,
			type: 'Accept',
			id: `${MISSKEY}/9zzz`,
			actor: neko.uri,
			object: { id: `${MISSKEY}/follows/${ALICE}/9abcdefghi`, type: 'Follow', actor: ALICE_URI, object: neko.uri },
		}
		expect(await t.post(neko, misskeyAccept)).toBe(202)
		expect((await follows(t.store)).find((f) => f.target_account_id === nekoId)?.state).toBe('accepted')
	})

	it('removes our follow on a Reject, pending or accepted, as Mastodon does', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await ourFollow(t, bob)
		await sql(t.store, "UPDATE follows SET state = 'accepted' WHERE target_account_id = ?", bobId)
		const reject = {
			'@context': AS,
			id: `${bob.uri}#rejects/follows/1`,
			type: 'Reject',
			actor: bob.uri,
			object: { type: 'Follow', actor: ALICE_URI, object: bob.uri },
		}
		expect(await t.post(bob, reject)).toBe(202)
		expect((await follows(t.store)).filter((f) => f.target_account_id === bobId)).toEqual([])
	})
})

describe('Update and Delete of an actor', () => {
	it('refreshes the actor from a fresh fetch on Update (Mastodon and Misskey)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob))
		const updated = { ...bob.document, name: 'Bob 2', summary: '<p>new</p>', manuallyApprovesFollowers: true }
		t.web.serve(bob.uri, updated)
		const update = { '@context': AS, id: `${bob.uri}#updates/1`, type: 'Update', actor: bob.uri, object: updated }
		expect(await t.post(bob, update)).toBe(202)

		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await t.post(neko, follow(neko))
		const nekoUpdated = { ...neko.document, name: 'ねこ', isCat: false }
		t.web.serve(neko.uri, nekoUpdated)
		const misskeyUpdate = {
			'@context': MISSKEY_CONTEXT,
			type: 'Update',
			id: `${MISSKEY}/9upd`,
			actor: neko.uri,
			object: nekoUpdated,
			published: '2026-10-11T23:59:00.000Z',
			to: [`${AS}#Public`],
		}
		expect(await t.post(neko, misskeyUpdate)).toBe(202)

		expect(
			await sql(
				t.store,
				"SELECT display_name, note, locked, json_extract(raw, '$.isCat') AS cat FROM accounts WHERE domain IS NOT NULL ORDER BY uri"
			)
		).toEqual([
			{ display_name: 'Bob 2', note: '<p>new</p>', locked: 1, cat: null },
			{ display_name: 'ねこ', note: expect.any(String), locked: 0, cat: 0 },
		])
	})

	it('suspends and removes a deleted actor with the key it stored, and keeps it out for 30 days (ID-7)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob))
		await ourFollow(t, bob, DAVE)
		t.web.fail(bob.uri, 410)
		const deletion = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, deletion)).toBe(202)

		expect(await sql(t.store, 'SELECT uri FROM accounts WHERE domain IS NOT NULL')).toEqual([])
		expect(await follows(t.store)).toEqual([])
		expect(await notifications(t.store)).toEqual([])
		expect(await counts(t.store, ALICE)).toEqual({ followers_count: 0, following_count: 0 })

		// The actor comes back (its key served again): a Follow is ignored while the retraction lasts.
		t.web.serve(bob.uri, bob.document)
		expect(await t.post(bob, follow(bob))).toBe(202)
		expect(await follows(t.store)).toEqual([])
	})

	it('answers 202 to the Delete of an unknown actor whose key is gone, and stores nothing', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		t.web.fail(bob.uri, 410)
		const deletion = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, deletion)).toBe(202)
		await untouched(t.store)
	})

	it('purges a large account in bounded batches, continued on the Queue (RES-6)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob))
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT printf('3%017d', i), ? || '/statuses/' || i, ?, 'public', '2026-10-01T00:00:00.000Z' FROM n`,
			PURGE_BATCH * 2 + 1,
			bob.uri,
			bobId
		)
		t.web.fail(bob.uri, 410)
		const deletion = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, deletion)).toBe(202)
		// One batch writes at most PURGE_BATCH rows in all (relationships first, then statuses).
		const left = (await sql<{ n: number }>(t.store, 'SELECT count(*) AS n FROM statuses'))[0]!.n
		expect(left).toBeGreaterThanOrEqual(PURGE_BATCH + 1)
		expect(left).toBeLessThan(PURGE_BATCH * 2 + 1)
		expect(t.queue.pending.map((m) => m.body)).toContainEqual({ kind: 'inbound-jobs' })

		const deps = inboxDeps(() => t.store, t.web.loader)
		const env = { ...t.env, MAINTENANCE: 'off' } as Env
		await t.queue.deliver((batch) => handleQueue(batch, env, deps))
		await t.queue.deliver((batch) => handleQueue(batch, env, deps))
		expect(t.queue.pending.filter((m) => (m.body as { kind: string }).kind === 'inbound-jobs')).toEqual([])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses')).toEqual([{ n: 0 }])
		expect(await accountId(t.store, bob.uri)).toBeUndefined()
	})
})

describe('Block and Move', () => {
	it('records a Block, ends both follows, and removes it on Undo; a repeat changes nothing', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob))
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			ALICE,
			bobId
		)
		const block = { '@context': AS, id: `${bob.uri}#blocks/1`, type: 'Block', actor: bob.uri, object: ALICE_URI }
		expect(await t.post(bob, block)).toBe(202)
		expect(await t.post(bob, block)).toBe(202)

		expect(await follows(t.store)).toEqual([])
		expect(await sql(t.store, 'SELECT account_id, target_account_id, uri FROM blocks')).toEqual([
			{ account_id: bobId, target_account_id: ALICE, uri: block.id },
		])
		expect(await counts(t.store, ALICE)).toEqual({ followers_count: 0, following_count: 0 })

		expect(await t.post(bob, undo(bob, { id: block.id, type: 'Block', actor: bob.uri, object: ALICE_URI }))).toBe(202)
		expect(await sql(t.store, 'SELECT * FROM blocks')).toEqual([])
	})

	it('rejects a Follow from an account the target blocks, once (ID-7)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await t.post(bob, follow(bob, DAVE_URI))
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(t.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', ALICE, bobId)
		const activity = follow(bob)
		await t.post(bob, activity)
		await t.post(bob, activity)

		expect((await follows(t.store)).filter((f) => f.target_account_id === ALICE)).toEqual([])
		const rejects = (await outbound(t.store)).filter((o) => o.activity.type === 'Reject')
		expect(rejects).toHaveLength(1)
		expect(rejects[0]!.activity.object).toEqual({ id: activity.id, type: 'Follow', actor: bob.uri, object: ALICE_URI })
	})

	it('moves local followers to an aliased target and carries blocks and mutes over (ID-4)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bob2 = await mastodonActor(t.web, 'bob2', { origin: 'https://new.example', key: 2, extra: {} })
		t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] })
		await t.post(bob, follow(bob, DAVE_URI))
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			ALICE,
			bobId
		)
		await sql(t.store, 'INSERT INTO mutes (account_id, target_account_id) VALUES (?, ?)', DAVE, bobId)
		const move = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: bob2.uri,
		}
		expect(await t.post(bob, move)).toBe(202)
		expect(await t.post(bob, move)).toBe(202)

		const bob2Id = (await accountId(t.store, bob2.uri))!
		expect((await follows(t.store)).filter((f) => f.account_id === ALICE)).toEqual([
			{
				account_id: ALICE,
				target_account_id: bob2Id,
				state: 'pending',
				uri: expect.stringMatching(`^${ALICE_URI}#follows/`),
			},
		])
		expect(await sql(t.store, 'SELECT account_id, target_account_id FROM mutes ORDER BY id')).toEqual([
			{ account_id: DAVE, target_account_id: bobId },
			{ account_id: DAVE, target_account_id: bob2Id },
		])
	})

	it('carries an active mute over an expired one of the target, never over an active one', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bob2 = await mastodonActor(t.web, 'bob2', { origin: 'https://new.example', key: 2, extra: {} })
		t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] })
		await t.post(bob, follow(bob, DAVE_URI))
		const bobId = (await accountId(t.store, bob.uri))!
		const bob2Id = '333333333333333333'
		await sql(
			t.store,
			"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'bob2', 'new.example')",
			bob2Id,
			bob2.uri
		)
		// More expired mutes than one sweep removes, all older than dave's expired mute of bob2, so it survives the Move's sweep.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO accounts (id, uri, username, domain)
			SELECT printf('%018d', CAST('400000000000000000' AS INTEGER) + i), 'https://x.example/users/x' || i, 'x' || i, 'x.example' FROM n`,
			SWEEP_BATCH + 50
		)
		await sql(
			t.store,
			`INSERT INTO mutes (account_id, target_account_id, expires_at)
			SELECT ?, id, '2026-01-01T00:00:00.000Z' FROM accounts WHERE domain = 'x.example'`,
			DAVE
		)
		await sql(
			t.store,
			`INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at) VALUES
				(?1, ?3, 1, NULL), (?1, ?4, 0, '2026-06-01T00:00:00.000Z'),
				(?2, ?3, 1, NULL), (?2, ?4, 0, '2027-01-01T00:00:00.000Z')`,
			DAVE,
			ALICE,
			bobId,
			bob2Id
		)
		const move = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: bob2.uri,
		}
		expect(await t.post(bob, move)).toBe(202)

		expect(
			await sql(
				t.store,
				'SELECT account_id, hide_notifications, expires_at FROM mutes WHERE target_account_id = ? ORDER BY account_id',
				bob2Id
			)
		).toEqual([
			{ account_id: ALICE, hide_notifications: 0, expires_at: '2027-01-01T00:00:00.000Z' },
			{ account_id: DAVE, hide_notifications: 1, expires_at: null },
		])
	})

	it('ignores a Move whose target does not list the actor, or that moves someone else (ID-4, ID-6)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		const evil = await mastodonActor(t.web, 'evil', { origin: 'https://evil.example', key: 3 })
		await t.post(bob, follow(bob, DAVE_URI))
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			ALICE,
			bobId
		)

		const unaliased = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: evil.uri,
		}
		expect(await t.post(bob, unaliased)).toBe(202)
		t.web.serve(evil.uri, { ...evil.document, alsoKnownAs: [bob.uri] })
		const ofAnother = {
			'@context': AS,
			id: `${carol.uri}#moves/1`,
			type: 'Move',
			actor: carol.uri,
			object: bob.uri,
			target: evil.uri,
		}
		expect(await t.post(carol, ofAnother)).toBe(202)

		expect((await follows(t.store)).filter((f) => f.account_id === ALICE)).toEqual([
			{ account_id: ALICE, target_account_id: bobId, state: 'accepted', uri: null },
		])
	})
})

describe('ID-1: an inbound activity acts only for its signer', () => {
	it('refuses an unsigned request, a tampered body and a stale signature with 401', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const activity = follow(bob)
		expect(
			(await t.request('/inbox', { method: 'POST', headers: { 'content-type': AP }, body: JSON.stringify(activity) }))
				.status
		).toBe(401)
		const signed = await signedInit(bob, '/inbox', activity)
		const tampered = { ...signed, body: JSON.stringify({ ...activity, object: DAVE_URI }) }
		expect((await t.request('/inbox', tampered)).status).toBe(401)
		expect(await t.post(bob, activity, { at: NOW - 2 * 60 * 60 * 1000 })).toBe(401)
		await untouched(t.store)
	})

	it('refuses a wrong signer: another server’s key for this actor', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const mallory = await mastodonActor(t.web, 'mallory', { origin: 'https://evil.example', key: 3 })
		expect(await t.post(bob, follow(bob), { keyId: mallory.keyId, privateKey: mallory.privateKey })).toBe(401)
		await untouched(t.store)
	})

	it('refuses the same origin with a different actor', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		// Signed by carol's own key, in bob's name.
		expect(await t.post(bob, follow(bob), { keyId: carol.keyId, privateKey: carol.privateKey })).toBe(401)
		await untouched(t.store)
	})

	it('refuses a key whose document names another owner, even when that owner lists it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const keyUri = `${MASTODON}/keys/shared`
		t.web.serve(keyUri, {
			...bob.document,
			id: keyUri,
			preferredUsername: 'shared',
			publicKey: { id: `${keyUri}#main-key`, owner: keyUri, publicKeyPem: bob.pem },
		})
		t.web.serve(bob.uri, {
			...bob.document,
			publicKey: [bob.document.publicKey, { id: `${keyUri}#main-key`, owner: keyUri, publicKeyPem: bob.pem }],
		})
		expect(await t.post(bob, follow(bob), { keyId: `${keyUri}#main-key` })).toBe(401)
		await untouched(t.store)
	})

	it('ignores a foreign activity id and records nothing (ID-6, ID-7)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		expect(await t.post(bob, follow(bob, ALICE_URI, 'https://evil.example/follows/1'))).toBe(202)
		const deletion = {
			'@context': AS,
			id: 'https://evil.example/d',
			type: 'Delete',
			actor: bob.uri,
			object: `${bob.uri}/statuses/1`,
		}
		expect(await t.post(bob, deletion)).toBe(202)
		expect(await follows(t.store)).toEqual([])
		expect(await sql(t.store, 'SELECT * FROM inbound_retractions')).toEqual([])
	})

	it('refuses a JSON string root and an array root (ID-8)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		expect(await t.post(bob, JSON.stringify(`${MASTODON}/activities/1`))).toBe(202)
		expect(await t.post(bob, JSON.stringify([follow(bob)]))).toBe(202)
		await untouched(t.store)
	})

	it('refuses a non-ActivityStreams content type with 415, signed or not (ID-8)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		for (const contentType of [
			'application/json',
			'text/html',
			'application/ld+json',
			'application/activity+json, text/plain',
		]) {
			expect(await t.post(bob, follow(bob), { contentType }), contentType).toBe(415)
		}
		expect(
			await t.post(bob, follow(bob), {
				contentType: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
			})
		).toBe(202)
	})

	it('answers 503 while the actor’s server fails transiently, and changes nothing', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		t.web.fail(bob.uri, 502)
		expect(await t.post(bob, follow(bob))).toBe(503)
		await untouched(t.store)
	})
})

describe('ID-6: the authorization table, one negative case per row', () => {
	it('Follow: the object must be a local account (exact URI)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		expect(await t.post(bob, follow(bob, `${LOCAL}/ap/users/Alice`))).toBe(202)
		expect(await t.post(bob, follow(bob, `${MASTODON}/users/carol`))).toBe(202)
		expect(await follows(t.store)).toEqual([])
	})

	it('Accept: only the target of our Follow accepts it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		const bobId = await ourFollow(t, bob)
		const accept = (object: unknown) => ({
			'@context': AS,
			id: activityId(MASTODON),
			type: 'Accept',
			actor: carol.uri,
			object,
		})
		expect(await t.post(carol, accept({ type: 'Follow', actor: ALICE_URI, object: bob.uri }))).toBe(202)
		expect(await t.post(carol, accept({ type: 'Follow', actor: ALICE_URI, object: carol.uri }))).toBe(202)
		expect((await follows(t.store)).find((f) => f.target_account_id === bobId)?.state).toBe('pending')
	})

	it('Reject: only the target of our Follow rejects it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		const bobId = await ourFollow(t, bob)
		const reject = {
			'@context': AS,
			id: activityId(MASTODON),
			type: 'Reject',
			actor: carol.uri,
			object: { type: 'Follow', actor: ALICE_URI, object: bob.uri },
		}
		expect(await t.post(carol, reject)).toBe(202)
		expect((await follows(t.store)).find((f) => f.target_account_id === bobId)?.state).toBe('pending')
	})

	it('Undo: only the actor of the undone activity undoes it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		const bobFollow = follow(bob)
		await t.post(bob, bobFollow)
		expect(await t.post(carol, undo(carol, { ...bobFollow, '@context': undefined }))).toBe(202)
		expect(await t.post(carol, undo(carol, bobFollow.id))).toBe(202)
		expect(await t.post(carol, undo(carol, { type: 'Follow', actor: carol.uri, object: ALICE_URI }))).toBe(202)
		expect((await follows(t.store)).map((f) => f.uri)).toEqual([bobFollow.id])
		expect(await notifications(t.store)).toHaveLength(1)
	})

	it('Block: the object must be a local account', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const block = {
			'@context': AS,
			id: `${bob.uri}#blocks/1`,
			type: 'Block',
			actor: bob.uri,
			object: `${MASTODON}/users/carol`,
		}
		expect(await t.post(bob, block)).toBe(202)
		expect(await sql(t.store, 'SELECT * FROM blocks')).toEqual([])
	})

	it('Update: an actor updates only itself; Delete: an actor deletes only itself (ID-3)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		await t.post(bob, follow(bob))
		const update = {
			'@context': AS,
			id: `${carol.uri}#updates/1`,
			type: 'Update',
			actor: carol.uri,
			object: { ...bob.document, name: 'pwned' },
		}
		expect(await t.post(carol, update)).toBe(202)
		const deletion = { '@context': AS, id: `${carol.uri}#delete`, type: 'Delete', actor: carol.uri, object: bob.uri }
		expect(await t.post(carol, deletion)).toBe(202)
		const local = { '@context': AS, id: `${carol.uri}#delete2`, type: 'Delete', actor: carol.uri, object: ALICE_URI }
		expect(await t.post(carol, local)).toBe(202)

		expect(await sql(t.store, 'SELECT display_name FROM accounts WHERE uri = ?', bob.uri)).toEqual([
			{ display_name: 'bob <b>display</b>' },
		])
		expect((await follows(t.store)).length).toBe(1)
		expect(await sql(t.store, 'SELECT username, display_name FROM accounts WHERE id = ?', ALICE)).toEqual([
			{ username: 'alice', display_name: '' },
		])
	})

	it('a local actor URI is never written as a remote account (ID-3)', async () => {
		const t = await setup()
		const result = await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: LOCAL,
			actorUri: ALICE_URI,
			actor: null,
			activity: { type: 'Follow', id: `${LOCAL}/x`, object: DAVE_URI },
		})
		expect(result).toMatchObject({ applied: false, reason: 'local-actor' })
		const forged = await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: 'https://other.example',
			actorUri: ALICE_URI,
			actor: {
				uri: ALICE_URI,
				username: 'alice',
				domain: 'kopje.test',
				actorType: 'Person',
				displayName: 'pwned',
				note: '',
				url: null,
				avatarUrl: null,
				headerUrl: null,
				locked: false,
				discoverable: null,
				inboxUrl: null,
				sharedInboxUrl: null,
				published: null,
				keys: [],
				emojiTags: [],
				raw: '{}',
			},
			activity: { type: 'UpdateActor', id: `${LOCAL}/u` },
		})
		expect(forged).toMatchObject({ applied: false })
		expect(await sql(t.store, 'SELECT domain, display_name FROM accounts WHERE id = ?', ALICE)).toEqual([
			{ domain: null, display_name: '' },
		])
	})
})

describe('ID-7: replay changes nothing twice', () => {
	it('applies a duplicate Follow once: one follow, one notification, one Accept', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const activity = follow(bob)
		for (let i = 0; i < 3; i++) {
			expect(await t.post(bob, activity)).toBe(202)
		}
		expect(await follows(t.store)).toHaveLength(1)
		expect(await notifications(t.store)).toHaveLength(1)
		expect(await outbound(t.store)).toHaveLength(1)
		expect(await counts(t.store, ALICE)).toEqual({ followers_count: 1, following_count: 0 })
	})

	it('re-sends the Accept for a new Follow id (Mastodon fast-forward), but not for a replay of the old one', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const first = follow(bob)
		const second = follow(bob)
		await t.post(bob, first)
		await t.post(bob, second)
		await t.post(bob, first)
		await t.post(bob, second)
		expect((await follows(t.store)).map((f) => f.uri)).toEqual([second.id])
		// The first Accept, never claimed, is cancelled by the second Follow (cancelFollowAnswers).
		expect((await outbound(t.store)).map((o) => (o.activity.object as { id: string }).id)).toEqual([second.id])
		expect(await notifications(t.store)).toHaveLength(1)
	})

	it('keeps an Undo that arrives before its Follow, so the Follow never applies (reordered)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const activity = follow(bob)
		expect(await t.post(bob, undo(bob, { id: activity.id, type: 'Follow', actor: bob.uri, object: ALICE_URI }))).toBe(
			202
		)
		expect(await t.post(bob, activity)).toBe(202)
		await t.post(bob, activity)
		expect(await follows(t.store)).toEqual([])
		expect(await notifications(t.store)).toEqual([])
		expect(await outbound(t.store)).toEqual([])
	})

	it('keeps a Delete that arrives before its object for 30 days, and only for the actor’s own origin', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const note = `${bob.uri}/statuses/1`
		const deletion = {
			'@context': AS,
			id: `${note}#delete`,
			type: 'Delete',
			actor: bob.uri,
			object: { id: note, type: 'Tombstone' },
		}
		expect(await t.post(bob, deletion)).toBe(202)
		expect(await t.post(bob, deletion)).toBe(202)
		const foreign = {
			'@context': AS,
			id: `${bob.uri}#delete-foreign`,
			type: 'Delete',
			actor: bob.uri,
			object: 'https://other.example/notes/1',
		}
		expect(await t.post(bob, foreign)).toBe(202)
		expect(await sql(t.store, 'SELECT actor_uri, target_uri, expires_at FROM inbound_retractions')).toEqual([
			{ actor_uri: bob.uri, target_uri: note, expires_at: NOW + RETRACTION_TTL_MS },
		])
	})

	it('records no retraction for input that fails ID-1', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		const deletion = {
			'@context': AS,
			id: `${bob.uri}#d`,
			type: 'Delete',
			actor: bob.uri,
			object: `${bob.uri}/statuses/1`,
		}
		// Signed by another actor, a Delete is a relay (a stamp's revocation forwarded, test/quotes.test.ts): without bob's
		// own proof it is applied to nothing, and records nothing.
		expect(await t.post(bob, deletion, { keyId: carol.keyId, privateKey: carol.privateKey })).toBe(202)
		await untouched(t.store)
		expect(await t.post(bob, { ...deletion, type: 'Undo' }, { keyId: carol.keyId, privateKey: carol.privateKey })).toBe(
			401
		)
		await untouched(t.store)
	})

	it('expires retractions after 30 days and caps them per actor (RES-4)', async () => {
		const t = await setup()
		const bob = 'https://mastodon.example/users/bob'
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/' || i, ? FROM n`,
			MAX_RETRACTIONS_PER_ACTOR,
			bob,
			bob,
			NOW + RETRACTION_TTL_MS
		)
		await sql(
			t.store,
			'INSERT INTO inbound_retractions VALUES (?, ?, ?)',
			'https://old.example/a',
			'https://old.example/b',
			NOW - 1
		)
		const result = await t.store.receiveActivity(BUILD, {
			now: NOW,
			origin: LOCAL,
			actorUri: bob,
			actor: null,
			activity: { type: 'Delete', id: `${bob}#d`, object: `${bob}/over-the-cap` },
		})
		expect(result.reason).toBe('unknown-actor')
		expect(
			await sql(t.store, "SELECT count(*) AS n FROM inbound_retractions WHERE actor_uri LIKE 'https://old%'")
		).toEqual([{ n: 0 }])
	})
})

describe('OPS-1: spooled requests are verified on replay against their spool time', () => {
	async function spooledFollow(t: Setup, bob: TestActor, at = NOW) {
		const maintenance = harness(t.store, { MAINTENANCE: 'readonly' }, BUILD, {
			keygen: fixtureKeyGen,
			loader: t.web.loader,
		})
		const response = await maintenance.request('/inbox', await signedInit(bob, '/inbox', follow(bob), { at }))
		expect(response.status).toBe(202)
		return maintenance.queue
	}

	it('applies a spooled Follow once, however often the message is delivered', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const queue = await spooledFollow(t, bob)
		const message = queue.pending[0]!
		// Replayed three hours later: the signature is judged by the spool time.
		const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW + 3 * 60 * 60 * 1000 }
		queue.pending.push({ ...message, id: 'duplicate' })
		await queue.deliver((batch) => handleQueue(batch, { ...t.env, MAINTENANCE: 'off' } as Env, deps))

		expect(queue.pending).toEqual([])
		expect(await follows(t.store)).toHaveLength(1)
		expect(await notifications(t.store)).toHaveLength(1)
		expect(await outbound(t.store)).toHaveLength(1)
	})

	it('drops a spooled request whose signature was already stale when spooled', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const queue = await spooledFollow(t, bob, NOW - 2 * 60 * 60 * 1000)
		await queue.deliver((batch) =>
			handleQueue(
				batch,
				{ ...t.env, MAINTENANCE: 'off' } as Env,
				inboxDeps(() => t.store, t.web.loader)
			)
		)
		expect(queue.pending).toEqual([])
		expect(queue.retries).toBe(0)
		await untouched(t.store)
	})

	it('retries a replay whose remote fetch failed transiently', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const queue = await spooledFollow(t, bob)
		t.web.fail(bob.uri, 503)
		const deps = inboxDeps(() => t.store, t.web.loader)
		await queue.deliver((batch) => handleQueue(batch, { ...t.env, MAINTENANCE: 'off' } as Env, deps))
		expect(queue.retries).toBe(1)
		t.web.serve(bob.uri, bob.document)
		await queue.deliver((batch) => handleQueue(batch, { ...t.env, MAINTENANCE: 'off' } as Env, deps))
		expect(await follows(t.store)).toHaveLength(1)
	})
})

// List members leave with the follow, whatever ends it (migration 0007_list_members); a Move carries them to the
// target (FollowMigrationService#migrate_list_accounts!).
describe('list members and inbound activities', () => {
	const LIST = '800000000000000001'
	const OTHER_LIST = '800000000000000002'

	// Alice's lists: LIST holds alice herself and the accounts, OTHER_LIST is dave's and holds them too.
	async function lists(t: Setup, members: string[]): Promise<void> {
		await sql(
			t.store,
			"INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'l'), (?, ?, 'd')",
			LIST,
			ALICE,
			OTHER_LIST,
			DAVE
		)
		for (const member of [ALICE, ...members]) {
			await sql(t.store, 'INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', LIST, member)
		}
		for (const member of members) {
			await sql(t.store, 'INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)', OTHER_LIST, member)
		}
	}

	const members = (t: Setup) =>
		sql<{ list_id: string; account_id: string }>(
			t.store,
			'SELECT list_id, account_id FROM list_accounts ORDER BY list_id, account_id'
		)

	it('leave on a Reject and on a Block; the follower of the other side keeps them', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol')
		const bobId = await ourFollow(t, bob)
		const carolId = await ourFollow(t, carol)
		await sql(t.store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", ALICE)
		for (const id of [bobId, carolId]) {
			await sql(
				t.store,
				"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
				DAVE,
				id
			)
		}
		await lists(t, [bobId, carolId])
		const reject = {
			'@context': AS,
			id: `${bob.uri}#rejects/follows/1`,
			type: 'Reject',
			actor: bob.uri,
			object: { type: 'Follow', actor: ALICE_URI, object: bob.uri },
		}
		expect(await t.post(bob, reject)).toBe(202)
		const block = { '@context': AS, id: `${carol.uri}#blocks/1`, type: 'Block', actor: carol.uri, object: ALICE_URI }
		expect(await t.post(carol, block)).toBe(202)
		expect(await members(t)).toEqual([
			{ list_id: LIST, account_id: ALICE },
			{ list_id: OTHER_LIST, account_id: [bobId, carolId].toSorted()[0] },
			{ list_id: OTHER_LIST, account_id: [bobId, carolId].toSorted()[1] },
		])
	})

	it('leave when the account is deleted', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await ourFollow(t, bob)
		await lists(t, [bobId])
		t.web.fail(bob.uri, 410)
		const deletion = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, deletion)).toBe(202)
		expect(await members(t)).toEqual([{ list_id: LIST, account_id: ALICE }])
	})

	it("stay, with the follow, for a follower who may not follow the Move's target", async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bob2 = await mastodonActor(t.web, 'bob2', { origin: 'https://new.example', key: 2, extra: {} })
		t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] })
		const bobId = await ourFollow(t, bob)
		await sql(t.store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", ALICE)
		await lists(t, [bobId])
		const bob2Id = '333333333333333333'
		await sql(
			t.store,
			"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'bob2', 'new.example')",
			bob2Id,
			bob2.uri
		)
		// Alice blocks the target: FollowService refuses, so Mastodon's UnfollowService never runs for her.
		await sql(t.store, 'INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)', ALICE, bob2Id)
		const move = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: bob2.uri,
		}
		expect(await t.post(bob, move)).toBe(202)
		expect(
			(await follows(t.store)).filter((f) => f.account_id === ALICE).map((f) => [f.target_account_id, f.state])
		).toEqual([[bobId, 'accepted']])
		expect((await outbound(t.store)).filter((o) => o.activity.type === 'Undo')).toEqual([])
		expect(await members(t)).toEqual(
			[
				{ list_id: LIST, account_id: ALICE },
				{ list_id: LIST, account_id: bobId },
				{ list_id: OTHER_LIST, account_id: bobId },
			].toSorted((a, b) => (a.list_id + a.account_id).localeCompare(b.list_id + b.account_id))
		)
	})

	it("move with a Move into the followers' lists that held the source, the follow requested", async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bob2 = await mastodonActor(t.web, 'bob2', { origin: 'https://new.example', key: 2, extra: {} })
		t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] })
		const bobId = await ourFollow(t, bob)
		await sql(t.store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", ALICE)
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			DAVE,
			bobId
		)
		await lists(t, [bobId])
		const move = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: bob2.uri,
		}
		expect(await t.post(bob, move)).toBe(202)
		const bob2Id = (await accountId(t.store, bob2.uri))!
		expect(
			(await follows(t.store)).filter((f) => f.target_account_id !== ALICE && f.target_account_id !== DAVE)
		).toMatchObject([
			{ account_id: ALICE, target_account_id: bob2Id, state: 'pending' },
			{ account_id: DAVE, target_account_id: bob2Id, state: 'pending' },
		])
		expect(await members(t)).toEqual(
			[
				{ list_id: LIST, account_id: ALICE },
				{ list_id: LIST, account_id: bob2Id },
				{ list_id: OTHER_LIST, account_id: bob2Id },
			].toSorted((a, b) => (a.list_id + a.account_id).localeCompare(b.list_id + b.account_id))
		)
	})
})

// An endorsement goes with our follow, whatever inbound activity ends it (migration 0014_account_notes_and_pins).
describe('endorsements and inbound activities', () => {
	const pins = (t: Setup) =>
		sql<{ account_id: string; target_account_id: string }>(
			t.store,
			'SELECT account_id, target_account_id FROM account_pins ORDER BY account_id, target_account_id'
		)

	async function endorsed(t: Setup, follower: string, ...targets: string[]): Promise<void> {
		for (const target of targets) {
			await sql(
				t.store,
				`INSERT INTO follows (account_id, target_account_id, state) VALUES (?1, ?2, 'accepted')
				ON CONFLICT (account_id, target_account_id) DO UPDATE SET state = 'accepted'`,
				follower,
				target
			)
			await sql(t.store, 'INSERT INTO account_pins (account_id, target_account_id) VALUES (?, ?)', follower, target)
		}
	}

	it('go on a Reject and on a Block of the endorsed account; another follower keeps theirs', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol')
		const bobId = await ourFollow(t, bob)
		const carolId = await ourFollow(t, carol)
		await endorsed(t, ALICE, bobId, carolId)
		await endorsed(t, DAVE, bobId, carolId)
		const reject = {
			'@context': AS,
			id: `${bob.uri}#rejects/follows/1`,
			type: 'Reject',
			actor: bob.uri,
			object: { type: 'Follow', actor: ALICE_URI, object: bob.uri },
		}
		expect(await t.post(bob, reject)).toBe(202)
		const block = { '@context': AS, id: `${carol.uri}#blocks/1`, type: 'Block', actor: carol.uri, object: ALICE_URI }
		expect(await t.post(carol, block)).toBe(202)
		expect(await pins(t)).toEqual(
			[bobId, carolId].toSorted().map((target) => ({ account_id: DAVE, target_account_id: target }))
		)
	})

	it('go when the endorsed account moves, and are not carried to its target', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bob2 = await mastodonActor(t.web, 'bob2', { origin: 'https://new.example', key: 2, extra: {} })
		t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] })
		const bobId = await ourFollow(t, bob)
		await endorsed(t, ALICE, bobId)
		const move = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: bob2.uri,
		}
		expect(await t.post(bob, move)).toBe(202)
		expect((await follows(t.store)).filter((f) => f.account_id === ALICE).map((f) => f.state)).toEqual(['pending'])
		expect(await pins(t)).toEqual([])
	})

	it('go, with the notes on it, when the endorsed account is deleted', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await ourFollow(t, bob)
		await endorsed(t, ALICE, bobId)
		await sql(
			t.store,
			"INSERT INTO account_notes (account_id, target_account_id, comment) VALUES (?, ?, 'bob')",
			DAVE,
			bobId
		)
		t.web.fail(bob.uri, 410)
		const deletion = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, deletion)).toBe(202)
		expect(await pins(t)).toEqual([])
		expect(await sql(t.store, 'SELECT * FROM account_notes')).toEqual([])
		expect(await accountId(t.store, bob.uri)).toBeUndefined()
	})
})

// Mastodon's follow limit applies to the follow API only: a remote Accept (FollowRequest#authorize!) and a Move's
// follower transfer (FollowMigrationService) bypass it, so they go through for a follower past it.
describe('the follow limit and inbound activities', () => {
	const MANY = { direction: 'following', domain: 'many.example', base: 700_000_000_000_000_000 } as const

	it('does not stop a remote Accept of our request', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await ourFollow(t, bob)
		await seedFollows(t.store, ALICE, 7_500, MANY)
		const accept = {
			'@context': AS,
			id: `${bob.uri}#accepts/follows/1`,
			type: 'Accept',
			actor: bob.uri,
			object: { id: `${LOCAL}/some-follow`, type: 'Follow', actor: ALICE_URI, object: bob.uri },
		}
		expect(await t.post(bob, accept)).toBe(202)
		expect((await follows(t.store)).find((f) => f.target_account_id === bobId)?.state).toBe('accepted')
		expect((await counts(t.store, ALICE))?.following_count).toBe(7_501)
	})

	it("moves a follower past the limit to the Move's target", async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bob2 = await mastodonActor(t.web, 'bob2', { origin: 'https://new.example', key: 2, extra: {} })
		t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri] })
		const bobId = await ourFollow(t, bob)
		await sql(t.store, "UPDATE follows SET state = 'accepted' WHERE account_id = ?", ALICE)
		await seedFollows(t.store, ALICE, 7_499, MANY)
		expect((await counts(t.store, ALICE))?.following_count).toBe(7_500)
		const move = {
			'@context': AS,
			id: `${bob.uri}#moves/1`,
			type: 'Move',
			actor: bob.uri,
			object: bob.uri,
			target: bob2.uri,
		}
		expect(await t.post(bob, move)).toBe(202)
		const bob2Id = (await accountId(t.store, bob2.uri))!
		// The source is unfollowed and the target requested, though the request is past the limit.
		const moved = (await follows(t.store)).filter(
			(f) => f.account_id === ALICE && (f.target_account_id === bobId || f.target_account_id === bob2Id)
		)
		expect(moved).toMatchObject([{ target_account_id: bob2Id, state: 'pending' }])
	})
})
