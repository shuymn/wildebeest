import { runInDurableObject } from 'cloudflare:test'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD, migratedStore } from './helpers'
import { LOCAL, MASTODON, mastodonActor, misskeyActor, type TestActor } from './inbox-helpers'
import {
	accountId,
	ALICE,
	create,
	followed,
	like,
	localStatus,
	mastodonNote,
	notifications,
	OTHER,
	type Setup,
	setup,
	statusRow,
	undo,
} from './inbox-status-helpers'
import { copyConfig, dumpViaRpc, importViaRpc, tableSnapshot } from './ops-helpers'
import { seedStatus } from './status-helpers'
import { Db } from '../src/db/sql'
import {
	deleteStatusBatch,
	type InboundActivity,
	LIKE_RETIRE_AFTER_MS,
	MAX_RETRACTIONS_PER_ACTOR,
	MAX_TRACKED_LIKES,
	PURGE_BATCH,
	purgeBatch,
	type ReceiveResult,
} from '../src/domain/inbox'
import { sha256Hex } from '../src/security/tokens'

// Remote favourites that track their outstanding Like ids (migration 0052_favourite_likes; src/domain/inbox.ts like
// and undoInteraction): a server that replaces a reaction undoes the old Like and sends a new one, every reaction with
// its own id, and its deliveries arrive in any order. ID-6, ID-7, VIS-10 and RES-6 (docs/threat-model.md).

const DAY = 24 * 60 * 60 * 1000

// The tracked Like ids of the favourites of the status `uri`, in the order they were tracked.
async function tracked(t: Setup, uri: string): Promise<string[]> {
	const rows = await sql<{ uri: string }>(
		t.store,
		`SELECT l.uri FROM favourite_likes l JOIN favourites f ON f.id = l.favourite_id JOIN statuses s ON s.id = f.status_id
		WHERE s.uri = ? ORDER BY l.id`,
		uri
	)
	return rows.map((row) => row.uri)
}

// The rows a refused activity must leave as they were.
async function state(t: Setup) {
	return {
		favourites: await sql(t.store, 'SELECT * FROM favourites ORDER BY id'),
		likes: await sql(t.store, 'SELECT * FROM favourite_likes ORDER BY id'),
		retractions: await sql(t.store, 'SELECT * FROM inbound_retractions ORDER BY actor_uri, target_uri'),
		notifications: await sql(t.store, 'SELECT * FROM notifications ORDER BY id'),
		counts: await sql(t.store, 'SELECT id, favourites_count FROM statuses ORDER BY id'),
		accounts: await sql(t.store, 'SELECT * FROM accounts ORDER BY id'),
	}
}

async function retractionsAtCap(t: Setup, actor: TestActor): Promise<void> {
	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/filler/' || i, ? FROM n`,
		MAX_RETRACTIONS_PER_ACTOR,
		actor.uri,
		actor.uri,
		NOW + DAY
	)
}

// The Store's receive, as the Worker calls it once it has verified and parsed the activity (the actor stored).
function receiver(t: Setup, actor: TestActor) {
	return (activity: InboundActivity, now = NOW): Promise<ReceiveResult> =>
		t.store.receiveActivity(BUILD, { now, origin: LOCAL, actorUri: actor.uri, actor: null, activity })
}

const likeOf = (actor: TestActor, object: string, n: string): Extract<InboundActivity, { type: 'Like' }> => ({
	type: 'Like',
	id: `${new URL(actor.uri).origin}/likes/${n}`,
	object,
})

const undoOf = (actor: TestActor, liked: { id: string; object: string }): InboundActivity => ({
	type: 'Undo',
	id: `${liked.id}/undo`,
	object: { id: liked.id, type: 'Like', actor: actor.uri, object: liked.object },
})

// A local status of alice's, seeded as a fixture (the cases below need many), with its uri.
async function seededLocal(t: Setup): Promise<string> {
	const id = await seedStatus(t.store, { accountId: ALICE, visibility: 'public' })
	return (await sql<{ uri: string }>(t.store, 'SELECT uri FROM statuses WHERE id = ?', id))[0]!.uri
}

describe('ID-6, ID-7: Like, EmojiReact and EmojiReaction, through the inbox', () => {
	it.each(['Like', 'EmojiReact', 'EmojiReaction'])(
		'%s: creates a favourite, is undone by its own Undo, and a replay does not restore it',
		async (type) => {
			const t = await setup()
			const bob = await mastodonActor(t.web, 'bob')
			const local = await localStatus(t, { status: 'react', visibility: 'public' })
			const liked = { ...like(bob, local.uri), type, content: '🍮' }
			expect(await t.post(bob, liked)).toBe(202)
			expect(await t.post(bob, liked)).toBe(202)
			expect(await tracked(t, local.uri)).toEqual([liked.id])
			expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(1)
			expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'favourite' }])
			expect(await t.post(bob, undo(bob, { id: liked.id, type, actor: bob.uri, object: local.uri }))).toBe(202)
			expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
			expect(await notifications(t.store)).toEqual([])
			expect(await t.post(bob, liked)).toBe(202)
			expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
			expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(0)
		}
	)

	it.each(['Like', 'EmojiReact', 'EmojiReaction'])(
		'%s: an Undo that arrives first keeps its Like from applying; another actor’s or another origin’s Undo changes nothing',
		async (type) => {
			const t = await setup()
			const bob = await mastodonActor(t.web, 'bob')
			const carol = await mastodonActor(t.web, 'carol', { key: 2 })
			const local = await localStatus(t, { status: 'react', visibility: 'public' })
			const early = { ...like(bob, local.uri), type }
			expect(await t.post(bob, undo(bob, { id: early.id, type, actor: bob.uri, object: local.uri }))).toBe(202)
			expect(await sql(t.store, 'SELECT target_uri FROM inbound_retractions')).toEqual([{ target_uri: early.id }])
			expect(await t.post(bob, early)).toBe(202)
			expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])

			const liked = { ...like(bob, local.uri), type }
			await t.post(bob, liked)
			const before = await state(t)
			// ID-6: carol's Undo of bob's Like.
			expect(await t.post(carol, undo(carol, { id: liked.id, type, actor: bob.uri, object: local.uri }))).toBe(202)
			// The undone id on another origin than the actor's.
			const foreign = `${OTHER}/likes/1`
			expect(await t.post(bob, undo(bob, { id: foreign, type, actor: bob.uri, object: local.uri }))).toBe(202)
			expect(await state(t)).toEqual({ ...before, accounts: expect.anything() })
			expect(await tracked(t, local.uri)).toEqual([liked.id])
		}
	)

	it('answers 503 to a Like past MAX_TRACKED_LIKES, rolling back the refreshed actor too', async () => {
		const t = await setup()
		const bob = await misskeyActor(t.web, '9abcdefghi', 'neko')
		const local = await localStatus(t, { status: 'react', visibility: 'public' })
		const likes = Array.from({ length: MAX_TRACKED_LIKES + 1 }, () => like(bob, local.uri))
		for (const liked of likes.slice(0, MAX_TRACKED_LIKES)) {
			expect(await t.post(bob, liked)).toBe(202)
		}
		await sql(t.store, 'UPDATE remote_keys SET fetched_at = 0')
		bob.document.name = 'renamed'
		t.web.serve(bob.uri, bob.document)
		const before = await state(t)
		expect(await t.post(bob, likes.at(-1))).toBe(503)
		expect(await state(t)).toEqual(before)
		// The Undo it waits for frees the room; the redelivered Like is tracked.
		expect(await t.post(bob, undo(bob, likes[0]!.id))).toBe(202)
		expect(await t.post(bob, likes.at(-1))).toBe(202)
		expect(await tracked(t, local.uri)).toEqual(likes.slice(1).map((liked) => liked.id))
		expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(1)
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'favourite' }])
	})
})

describe('ID-7: reaction changes in every arrival order', () => {
	// The model: a Like is outstanding once it arrived, unless its Undo arrived (before or after it). The favourite
	// exists exactly while one is outstanding; its tracked ids are the outstanding ones, in arrival order.
	function permutations<T>(items: readonly T[]): T[][] {
		return items.length <= 1
			? [[...items]]
			: items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [item, ...p]))
	}

	type Step = { kind: 'like' | 'undo'; n: number }

	async function replay(t: Setup, bob: TestActor, order: readonly Step[]): Promise<void> {
		const receive = receiver(t, bob)
		const uri = await seededLocal(t)
		const key = order.map((step) => `${step.kind[0]}${step.n}`).join('')
		const likes = new Map([1, 2, 3].map((n) => [n, likeOf(bob, uri, `${key}-${n}`)]))
		const arrived: number[] = []
		const undone = new Set<number>()
		for (const step of order) {
			const liked = likes.get(step.n)!
			expect((await receive(step.kind === 'like' ? liked : undoOf(bob, liked))).retry).toBeUndefined()
			if (step.kind === 'like' && !undone.has(step.n)) {
				arrived.push(step.n)
			} else if (step.kind === 'undo') {
				undone.add(step.n)
			}
			const outstanding = arrived.filter((n) => !undone.has(n)).map((n) => likes.get(n)!.id)
			const [row] = await sql<{ likes: string; count: number; notified: number }>(
				t.store,
				`SELECT (SELECT json_group_array(uri) FROM (SELECT l.uri FROM favourite_likes l JOIN favourites f ON f.id = l.favourite_id
					WHERE f.status_id = s.id ORDER BY l.id)) AS likes, s.favourites_count AS count,
					(SELECT count(*) FROM notifications n WHERE n.status_id = s.id AND n.type = 'favourite') AS notified
				FROM statuses s WHERE s.uri = ?`,
				uri
			)
			expect({ order: key, ...row, likes: JSON.parse(row!.likes) as string[] }).toEqual({
				order: key,
				likes: outstanding,
				count: outstanding.length > 0 ? 1 : 0,
				notified: outstanding.length > 0 ? 1 : 0,
			})
		}
	}

	const L = (n: number): Step => ({ kind: 'like', n })
	const U = (n: number): Step => ({ kind: 'undo', n })

	it('keeps the favourite exactly while the last Like is outstanding: every order of L1 U1 L2 U2 L3', async () => {
		const t = await setup()
		const bob = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		for (const order of permutations([L(1), U(1), L(2), U(2), L(3)])) {
			await replay(t, bob, order)
		}
	}, 120_000)

	it('removes it once every Like is undone: every order of L1 U1 L2 U2 L3 U3', async () => {
		const t = await setup()
		const bob = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		for (const order of permutations([L(1), U(1), L(2), U(2), L(3), U(3)])) {
			await replay(t, bob, order)
		}
	}, 600_000)

	it('keeps the current Like that arrived first while the old ones and their Undos follow (L5, L1-L3, U1-U3)', async () => {
		const t = await setup()
		const bob = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		const receive = receiver(t, bob)
		const uri = await seededLocal(t)
		const [l1, l2, l3, l5] = ['1', '2', '3', '5'].map((n) => likeOf(bob, uri, n))
		for (const activity of [l5!, l1!, l2!, l3!, undoOf(bob, l1!), undoOf(bob, l2!), undoOf(bob, l3!)]) {
			expect(await receive(activity)).toMatchObject({ applied: true })
		}
		expect(await tracked(t, uri)).toEqual([l5!.id])
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'favourite' }])
	})

	it('answers 503 to a fifth outstanding Like, and tracks it when it is delivered again after an Undo (L1-L4, L5)', async () => {
		const t = await setup()
		const bob = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		const receive = receiver(t, bob)
		const uri = await seededLocal(t)
		const [l1, l2, l3, l4, l5] = ['1', '2', '3', '4', '5'].map((n) => likeOf(bob, uri, n))
		for (const liked of [l1!, l2!, l3!, l4!]) {
			expect(await receive(liked)).toMatchObject({ applied: true })
		}
		const before = await state(t)
		expect(await receive(l5!)).toEqual({
			applied: false,
			reason: 'like-tracking-cap',
			jobsPending: false,
			retry: true,
		})
		expect(await state(t)).toEqual(before)
		expect(await receive(undoOf(bob, l1!))).toMatchObject({ applied: true, reason: 'like-undone' })
		expect(await receive(l5!)).toMatchObject({ applied: true, reason: 'favourite-kept' })
		for (const liked of [l2!, l3!, l4!]) {
			expect(await receive(undoOf(bob, liked))).toMatchObject({ applied: true })
		}
		expect(await tracked(t, uri)).toEqual([l5!.id])
		expect((await statusRow(t.store, uri))?.favourites_count).toBe(1)
	})

	// A burst of changes (each an Undo of the reaction before and a Like of the next, the last one perhaps removed), in
	// any arrival order; a 503 is delivered again later, as the sending server retries it. Transient 503s are valid
	// (five Likes can overtake their Undos); the state once everything is delivered is the last reaction.
	it('ends at the last reaction whatever order a burst arrives in, retrying what was answered 503', async () => {
		const t = await setup()
		const bob = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		const receive = receiver(t, bob)
		let run = 0
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 8 }),
				fc.boolean(),
				fc.array(fc.nat(), { minLength: 16, maxLength: 16 }),
				async (reactions, removed, keys) => {
					const uri = await seededLocal(t)
					run++
					const likes = Array.from({ length: reactions }, (_, n) => likeOf(bob, uri, `${run}-${n}`))
					const activities: InboundActivity[] = likes.flatMap((liked, n) =>
						n === 0 ? [liked] : [undoOf(bob, likes[n - 1]!), liked]
					)
					if (removed) {
						activities.push(undoOf(bob, likes.at(-1)!))
					}
					// The arrival order: by the generated keys, ties in sending order.
					const queue = activities
						.map((activity, i) => ({ activity, key: keys[i % keys.length]! + i / 100 }))
						.sort((a, b) => a.key - b.key)
						.map((entry) => entry.activity)
					let deliveries = 0
					for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
						expect(++deliveries).toBeLessThan(100)
						if ((await receive(next)).retry === true) {
							queue.push(next)
						}
					}
					expect(await tracked(t, uri)).toEqual(removed ? [] : [likes.at(-1)!.id])
					expect((await statusRow(t.store, uri))?.favourites_count).toBe(removed ? 0 : 1)
					expect(
						await sql(
							t.store,
							"SELECT count(*) AS n FROM notifications WHERE type = 'favourite' AND status_id = (SELECT id FROM statuses WHERE uri = ?)",
							uri
						)
					).toEqual([{ n: removed ? 0 : 1 }])
				}
			),
			{ numRuns: 60 }
		)
	}, 300_000)
})

describe('ID-7: a tracked Like whose Undo was lost', () => {
	it('is retired to make room once older than LIKE_RETIRE_AFTER_MS, and a younger one never is', async () => {
		const t = await setup()
		const bob = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		const receive = receiver(t, bob)
		const uri = await seededLocal(t)
		await sql(
			t.store,
			`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts)
			VALUES (?, 'https://push.example/alice', 'p256dh', 'auth', '{"favourite":true}')`,
			await sha256Hex(t.tokens.alice)
		)
		const pushes = async () =>
			(await sql<{ seq: number }>(t.store, "SELECT seq FROM sqlite_sequence WHERE name = 'push_deliveries'"))[0]?.seq ??
			0
		// Four reactions whose Undos never arrived (the sending server gave up), then a young one.
		const lost = ['1', '2', '3'].map((n) => likeOf(bob, uri, n))
		for (const liked of lost) {
			await receive(liked)
		}
		const young = likeOf(bob, uri, 'young')
		await receive(young, NOW + 6 * DAY)
		expect(await pushes()).toBe(1)
		// Within the window the pair waits: 503, nothing written.
		const fresh = ['a', 'b', 'c', 'd'].map((n) => likeOf(bob, uri, n))
		expect(await receive(fresh[0]!, NOW + LIKE_RETIRE_AFTER_MS - 1)).toMatchObject({ retry: true })
		// Past it, each new Like retires the earliest aged id; the aggregate, its count and notification stay.
		const later = NOW + LIKE_RETIRE_AFTER_MS
		for (const [i, liked] of fresh.slice(0, 3).entries()) {
			expect(await receive(liked, later)).toMatchObject({ applied: true, reason: 'favourite-kept' })
			expect(await tracked(t, uri)).toEqual([
				...lost.slice(i + 1).map((l) => l.id),
				young.id,
				...fresh.slice(0, i + 1).map((l) => l.id),
			])
		}
		// Only young ids are left: the next Like waits.
		const before = await state(t)
		expect(await receive(fresh[3]!, later)).toMatchObject({ retry: true, reason: 'like-tracking-cap' })
		expect(await state(t)).toEqual(before)
		expect((await statusRow(t.store, uri))?.favourites_count).toBe(1)
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'favourite' }])
		expect(await pushes()).toBe(1)
		// The retired ids' late Undos only record their tombstones.
		expect(await receive(undoOf(bob, lost[0]!), later)).toMatchObject({ reason: 'retraction-recorded' })
		expect(await tracked(t, uri)).toHaveLength(MAX_TRACKED_LIKES)
	})
})

describe('ID-7: Undos at the retraction cap', () => {
	it('answers 503 to a typed or untyped Undo of a tracked Like and to an untyped unknown one; a pair id records nothing', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const local = await localStatus(t, { status: 'react', visibility: 'public' })
		const liked = like(bob, local.uri)
		await t.post(bob, liked)
		await retractionsAtCap(t, bob)
		const before = await state(t)
		expect(await t.post(bob, undo(bob, { id: liked.id, type: 'Like', actor: bob.uri, object: local.uri }))).toBe(503)
		expect(await t.post(bob, undo(bob, liked.id))).toBe(503)
		// An untyped Undo of an id nothing stored names may be of a Like on its way.
		expect(await t.post(bob, undo(bob, `${MASTODON}/likes/unknown`))).toBe(503)
		expect(await state(t)).toEqual(before)
		// A pair-shaped id names every generation of a follow and is never recorded (ID-7's documented exception).
		expect(await t.post(bob, undo(bob, `${MASTODON}/follows/a/b`))).toBe(202)
		// An Undo of a reaction to another server's note is ignored before the cap is read.
		expect(
			await t.post(bob, undo(bob, { id: `${MASTODON}/likes/x`, type: 'Like', actor: bob.uri, object: `${OTHER}/n/1` }))
		).toBe(202)
		expect(await state(t)).toEqual(before)
	})
})

describe('ID-7: an Undo of a reaction to a status that is not local', () => {
	it('records no tombstone, unless a stored favourite needs it removed (converted rows)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		await followed(t, carol)
		const remote = mastodonNote(carol)
		await t.post(carol, create(carol, remote))
		const other = mastodonNote(carol)
		await t.post(carol, create(carol, other))
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		const bobId = (await accountId(t.store, bob.uri))!
		// Unmatched: an Undo naming a stored remote status, and one naming an unknown note elsewhere.
		const unmatched = `${MASTODON}/likes/unmatched`
		expect(await t.post(bob, undo(bob, { id: unmatched, type: 'Like', actor: bob.uri, object: remote.id }))).toBe(202)
		expect(
			await t.post(bob, undo(bob, { id: `${unmatched}-2`, type: 'Like', actor: bob.uri, object: `${OTHER}/n/9` }))
		).toBe(202)
		expect(await sql(t.store, 'SELECT * FROM inbound_retractions')).toEqual([])
		// A converted favourite of each remote status: one legacy (the cutover keeps no remote Like id), one tracking
		// the id 0052_favourite_likes moved out of favourites.uri.
		const ids = await sql<{ id: string; uri: string }>(
			t.store,
			'SELECT id, uri FROM statuses WHERE uri IN (?, ?)',
			remote.id,
			other.id
		)
		const statusId = (uri: string) => ids.find((row) => row.uri === uri)!.id
		await sql(
			t.store,
			'INSERT INTO favourites (account_id, status_id, created_at) VALUES (?1, ?2, ?4), (?1, ?3, ?4)',
			bobId,
			statusId(remote.id),
			statusId(other.id),
			new Date(NOW).toISOString()
		)
		const moved = `${MASTODON}/likes/moved`
		await sql(
			t.store,
			'INSERT INTO favourite_likes (favourite_id, uri, received_at) SELECT id, ?, 0 FROM favourites WHERE status_id = ?',
			moved,
			statusId(other.id)
		)
		await sql(
			t.store,
			'UPDATE statuses SET favourites_count = 1 WHERE id IN (?, ?)',
			statusId(remote.id),
			statusId(other.id)
		)
		const legacyUndo = `${MASTODON}/likes/legacy`
		expect(await t.post(bob, undo(bob, { id: legacyUndo, type: 'Like', actor: bob.uri, object: remote.id }))).toBe(202)
		expect(await t.post(bob, undo(bob, { id: moved, type: 'Like', actor: bob.uri, object: other.id }))).toBe(202)
		expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
		expect(await sql(t.store, 'SELECT * FROM favourite_likes')).toEqual([])
		expect((await statusRow(t.store, remote.id))?.favourites_count).toBe(0)
		expect((await statusRow(t.store, other.id))?.favourites_count).toBe(0)
		expect(
			(
				await sql<{ target_uri: string }>(t.store, 'SELECT target_uri FROM inbound_retractions ORDER BY target_uri')
			).map((row) => row.target_uri)
		).toEqual([legacyUndo, moved])
	})
})

describe('ID-7: a legacy favourite of a local status (no tracked id)', () => {
	async function legacy(t: Setup, bob: TestActor) {
		const local = await localStatus(t, { status: 'converted', visibility: 'public' })
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			"INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
			bobId,
			local.id
		)
		await sql(t.store, 'UPDATE statuses SET favourites_count = 1 WHERE id = ?', local.id)
		await sql(
			t.store,
			"INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'favourite', ?, ?)",
			ALICE,
			bobId,
			local.id
		)
		return local
	}

	it('is removed by an Undo naming its status, with its notification', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const local = await legacy(t, bob)
		const id = `${MASTODON}/likes/before-cutover`
		expect(await t.post(bob, undo(bob, { id, type: 'Like', actor: bob.uri, object: local.uri }))).toBe(202)
		expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
		expect(await notifications(t.store)).toEqual([])
		expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(0)
		expect(await sql(t.store, 'SELECT target_uri FROM inbound_retractions')).toEqual([{ target_uri: id }])
	})

	it('becomes tracked by a Like, without a recount or a second notification (VIS-10); then only its Undo removes it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const local = await legacy(t, bob)
		const liked = like(bob, local.uri)
		expect(await t.post(bob, liked)).toBe(202)
		expect(await tracked(t, local.uri)).toEqual([liked.id])
		expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(1)
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'favourite' }])
		// Tracked now: an Undo of another id naming the status only records that id.
		const other = `${MASTODON}/likes/other`
		expect(await t.post(bob, undo(bob, { id: other, type: 'Like', actor: bob.uri, object: local.uri }))).toBe(202)
		expect(await tracked(t, local.uri)).toEqual([liked.id])
		expect(await t.post(bob, undo(bob, { id: liked.id, type: 'Like', actor: bob.uri, object: local.uri }))).toBe(202)
		expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
	})
})

describe('VIS-10: the favourite notification follows the aggregate', () => {
	it.each([
		['an Undo, then the new Like: removed, then notified and pushed again', 'undo-first', 2],
		['the new Like, then the Undo: one notification and one push', 'like-first', 1],
	] as const)('%s', async (_name, order, expectedPushes) => {
		const t = await setup()
		const bob = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		await sql(
			t.store,
			`INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts)
			VALUES (?, 'https://push.example/alice', 'p256dh', 'auth', '{"favourite":true}')`,
			await sha256Hex(t.tokens.alice)
		)
		const receive = receiver(t, bob)
		const uri = await seededLocal(t)
		const [first, second] = ['1', '2'].map((n) => likeOf(bob, uri, n))
		await receive(first!)
		const notified = await sql<{ id: number }>(t.store, 'SELECT id FROM notifications')
		const steps = order === 'undo-first' ? [undoOf(bob, first!), second!] : [second!, undoOf(bob, first!)]
		for (const step of steps) {
			await receive(step)
		}
		const rows = await sql<{ id: number }>(t.store, "SELECT id FROM notifications WHERE type = 'favourite'")
		expect(rows).toHaveLength(1)
		expect(rows[0]!.id === notified[0]!.id).toBe(order === 'like-first')
		expect(
			(await sql<{ seq: number }>(t.store, "SELECT seq FROM sqlite_sequence WHERE name = 'push_deliveries'"))[0]?.seq
		).toBe(expectedPushes)
	})
})

describe('RES-6: tracked Like ids in bounded deletions', () => {
	async function batches(t: Setup, step: (db: Db) => boolean): Promise<number[]> {
		const wrote: number[] = []
		for (let i = 0; i < 50; i++) {
			const { n, more } = await runInDurableObject(t.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const changes = () => db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const before = changes()
				const more = state.storage.transactionSync(() => step(db))
				return { n: changes() - before, more }
			})
			wrote.push(n)
			if (!more) {
				break
			}
		}
		return wrote
	}

	it('purges an actor whose favourites each track MAX_TRACKED_LIKES ids, every batch within PURGE_BATCH', async () => {
		const t = await setup()
		const bob = await misskeyActor(t.web, '9abcdefghi', 'neko')
		await t.post(bob, like(bob, `${LOCAL}/ap/o/unknown`))
		const receive = receiver(t, bob)
		// 150 favourites through the inbox, 600 tracked ids: more than a batch writes.
		for (let s = 0; s < 150; s++) {
			const uri = await seededLocal(t)
			for (let n = 0; n < MAX_TRACKED_LIKES; n++) {
				expect(await receive(likeOf(bob, uri, `${s}-${n}`))).toMatchObject({ applied: true })
			}
		}
		// And 100 converted ones of remote statuses, legacy, which the purge reaches in the same window.
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i <= 100)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT printf('7%017d', i), 'https://misskey.example/notes/c' || i, ?1, 'public', '2026-01-01T00:00:00Z' FROM n`,
			bobId
		)
		await sql(
			t.store,
			`INSERT INTO favourites (account_id, status_id, created_at)
			SELECT ?1, id, '2026-01-01T00:00:00.000Z' FROM statuses WHERE id GLOB '7*'`,
			bobId
		)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM favourite_likes')).toEqual([{ n: 600 }])
		const wrote = await batches(t, (db) => purgeBatch(db, bob.uri, NOW))
		expect(wrote.length).toBeGreaterThan(2)
		expect(wrote.every((n) => n <= PURGE_BATCH)).toBe(true)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM favourite_likes')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM favourites')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM accounts WHERE uri = ?', bob.uri)).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT max(favourites_count) AS n FROM statuses')).toEqual([{ n: 0 }])
	}, 120_000)

	it('removes a deleted remote status whose converted favourites track MAX_TRACKED_LIKES ids, within PURGE_BATCH', async () => {
		const t = await setup()
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		await followed(t, carol)
		const note = mastodonNote(carol)
		await t.post(carol, create(carol, note))
		const statusId = (await sql<{ id: string }>(t.store, 'SELECT id FROM statuses WHERE uri = ?', note.id))[0]!.id
		// 200 remote favourites of it with 4 ids each, as 0052_favourite_likes moves them from earlier rows.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i <= 200)
			INSERT INTO accounts (id, uri, username, domain) SELECT printf('6%017d', i), 'https://many.example/u/' || i, 'u' || i,
				'many.example' FROM n`
		)
		await sql(
			t.store,
			`INSERT INTO favourites (account_id, status_id, created_at)
			SELECT id, ?, '2026-01-01T00:00:00.000Z' FROM accounts WHERE id GLOB '6*'`,
			statusId
		)
		await sql(
			t.store,
			`WITH RECURSIVE k(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM k WHERE j < ?2)
			INSERT INTO favourite_likes (favourite_id, uri, received_at)
			SELECT f.id, 'https://many.example/likes/' || f.id || '-' || k.j, 0 FROM favourites f, k WHERE f.status_id = ?1`,
			statusId,
			MAX_TRACKED_LIKES
		)
		const wrote = await batches(t, (db) => deleteStatusBatch(db, statusId, NOW))
		expect(wrote.length).toBeGreaterThan(1)
		expect(wrote.every((n) => n <= PURGE_BATCH)).toBe(true)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', statusId)).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM favourite_likes')).toEqual([{ n: 0 }])
	}, 60_000)
})

describe('a dump round trip of tracked and legacy favourites', () => {
	it('restores both as they were, and an import past MAX_TRACKED_LIKES per favourite is refused', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const local = await localStatus(t, { status: 'react', visibility: 'public' })
		const legacyOf = await localStatus(t, { status: 'converted', visibility: 'public' })
		const likes = Array.from({ length: MAX_TRACKED_LIKES }, () => like(bob, local.uri))
		for (const liked of likes) {
			await t.post(bob, liked)
		}
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			"INSERT INTO favourites (account_id, status_id, created_at) VALUES (?, ?, 'x')",
			bobId,
			legacyOf.id
		)
		const { text } = await dumpViaRpc(t.store)
		const target = await migratedStore()
		await copyConfig(t.store, target)
		const { report } = await importViaRpc(target, text)
		expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0 })
		const snapshot = await tableSnapshot(target)
		const source = await tableSnapshot(t.store)
		for (const table of ['favourites', 'favourite_likes']) {
			expect(snapshot[table]).toEqual(source[table])
		}
		expect(source.favourite_likes).toHaveLength(MAX_TRACKED_LIKES)

		// A fifth id for the same favourite, in a file built by hand: the trigger refuses its chunk.
		const line = text.split('\n').find((l) => l.startsWith('INSERT INTO "favourite_likes"'))!
		const fifth = line.replace(/VALUES \(\d+,/, 'VALUES (99,').replace(likes[0]!.id, `${likes[0]!.id}-fifth`)
		const crafted = text.replace(`${line}\n`, `${line}\n${fifth}\n`)
		const refused = await migratedStore()
		await copyConfig(t.store, refused)
		await expect(importViaRpc(refused, crafted)).rejects.toThrow(/more than 4 Like ids for one favourite/)
	})
})
