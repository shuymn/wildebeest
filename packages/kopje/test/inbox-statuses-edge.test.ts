import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { harness, inboxDeps, NOW } from './app-helpers'
import { fixtureKeyGen } from './federation-helpers'
import { BUILD } from './helpers'
import {
	AP,
	LOCAL,
	MASTODON,
	mastodonActor,
	MISSKEY_CONTEXT,
	misskeyActor,
	signedInit,
	type TestActor,
} from './inbox-helpers'
import {
	accountId,
	ALICE,
	ALICE_URI,
	announce,
	AS,
	create,
	DAVE,
	DAVE_URI,
	followed,
	like,
	localStatus,
	mastodonNote,
	misskeyNote,
	type Note,
	notifications,
	OTHER,
	PUBLIC,
	remove,
	type Setup,
	setup,
	statuses,
	statusRow,
	undo,
	update,
} from './inbox-status-helpers'
import { Db } from '../src/db/sql'
import { MAX_REMOTE_FIELDS } from '../src/domain/accounts'
import { deleteStatusBatch, MAX_RETRACTIONS_PER_ACTOR, PURGE_BATCH } from '../src/domain/inbox'
import { MAX_LINKED_REPLIES, MAX_STATUS_MENTION_ROWS, VERSION_SKEW_MS } from '../src/domain/remote-statuses'
import { MAX_STATUS_EDITS } from '../src/domain/statuses'
import { handleQueue } from '../src/jobs/queue'
import type { StoreStub } from '../src/platform/store-client'
import { sha256Hex } from '../src/security/tokens'

// B1b-2's boundaries and orderings (review round 2): the Update watermark, retractions at the cap, Undo of a Like
// stored under another id, the deletion job's per-batch budget and its interplay with an actor's purge, the wrapper
// audience of boosts, bounds at their limits, contexts past the JSON bounds, the Store's request rounds, search
// without a valid token, and the canonical WebFinger domain. Test names cite the invariants.

const at = (minutes: number) => new Date(Date.parse('2026-10-11T12:00:00Z') + minutes * 60_000).toISOString()

async function retractionsAtCap(t: Setup, actor: TestActor): Promise<void> {
	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/filler/' || i, ? FROM n`,
		MAX_RETRACTIONS_PER_ACTOR,
		actor.uri,
		actor.uri,
		NOW + 86_400_000
	)
}

async function remoteAccounts(t: Setup, count: number, host = 'many.example'): Promise<string[]> {
	await sql(
		t.store,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO accounts (id, uri, username, domain) SELECT printf('4%017d', i), 'https://' || ? || '/u/' || i,
			'u' || i, ? FROM n`,
		count,
		host,
		host
	)
	return Array.from({ length: count }, (_, i) => `https://${host}/u/${i + 1}`)
}

describe('ID-7: the Update watermark', () => {
	it('ignores an older content Update after a newer metadata-only one', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		await t.post(bob, create(bob, note))
		await t.post(bob, update(bob, { ...note, sensitive: true }, at(60)))
		await t.post(bob, update(bob, { ...note, content: '<p>older</p>' }, at(30)))
		const row = (await statusRow(t.store, note.id))!
		expect(row).toMatchObject({ content: note.content, sensitive: 1, edited_at: null })
		expect(await sql(t.store, 'SELECT remote_version FROM statuses WHERE id = ?', row.id)).toEqual([
			{ remote_version: '2026-10-11T13:00:00.000Z' },
		])
		expect(await sql(t.store, 'SELECT * FROM status_edits')).toEqual([])
	})

	it('accepts a future-dated version once, clamped to now plus the skew, and not again', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		await t.post(bob, create(bob, note))
		const future = update(bob, { ...note, content: '<p>from the future</p>' }, '2030-01-01T00:00:00Z')
		await t.post(bob, future)
		const row = (await statusRow(t.store, note.id))!
		expect(row).toMatchObject({ content: '<p>from the future</p>', edited_at: new Date(NOW).toISOString() })
		expect(await sql(t.store, 'SELECT remote_version FROM statuses WHERE id = ?', row.id)).toEqual([
			{ remote_version: new Date(NOW + VERSION_SKEW_MS).toISOString() },
		])
		// A replay, and a later version still within the clamp, change nothing.
		await t.post(bob, update(bob, { ...note, content: '<p>replayed</p>' }, '2030-01-01T00:00:00Z'))
		await t.post(bob, update(bob, { ...note, content: '<p>soon</p>' }, new Date(NOW + 60_000).toISOString()))
		expect((await statusRow(t.store, note.id))?.content).toBe('<p>from the future</p>')
		expect(await sql(t.store, 'SELECT count(*) AS n FROM status_edits')).toEqual([{ n: 2 }])
	})

	it('leaves nothing for every order of Create, Update and Delete', async () => {
		const orders = ['CUD', 'CDU', 'UCD', 'UDC', 'DCU', 'DUC']
		for (const order of orders) {
			const t = await setup()
			const bob = await mastodonActor(t.web, 'bob')
			await followed(t, bob)
			const note = mastodonNote(bob)
			const activities = {
				C: create(bob, note),
				U: update(bob, { ...note, content: '<p>edited</p>' }, at(60)),
				D: remove(bob, note.id),
			}
			for (const step of order) {
				expect(await t.post(bob, activities[step as 'C' | 'U' | 'D']), `${order} ${step}`).toBe(202)
			}
			// Settle a deletion job the order may have left.
			const deps = inboxDeps(() => t.store, t.web.loader)
			await t.queue.deliver((batch) => handleQueue(batch, { ...t.env, MAINTENANCE: 'off' } as Env, deps))
			expect(await statuses(t.store), order).toEqual([])
			expect(await sql(t.store, 'SELECT * FROM status_edits'), order).toEqual([])
			expect(await sql(t.store, 'SELECT target_uri FROM inbound_retractions'), order).toEqual([{ target_uri: note.id }])
		}
	})
})

describe('ID-7: retractions at the per-actor cap', () => {
	it('answers 503 to a Delete or Undo it cannot record, and changes nothing', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		await t.post(bob, create(bob, note))
		const local = await localStatus(t, { status: 'liked', visibility: 'public' })
		const liked = like(bob, local.uri)
		await t.post(bob, liked)
		await retractionsAtCap(t, bob)

		expect(await t.post(bob, remove(bob, note.id))).toBe(503)
		expect((await statuses(t.store)).map((s) => s.uri)).toContain(note.id)
		expect(await t.post(bob, undo(bob, { id: liked.id, type: 'Like', actor: bob.uri, object: local.uri }))).toBe(503)
		expect(await sql(t.store, 'SELECT uri FROM favourites')).toEqual([{ uri: liked.id }])
		// A Delete of an unknown object at the cap is answered 202 and not recorded (as documented).
		expect(await t.post(bob, remove(bob, `${bob.uri}/statuses/unknown`))).toBe(202)
		expect(
			await sql(t.store, 'SELECT * FROM inbound_retractions WHERE target_uri = ?', `${bob.uri}/statuses/unknown`)
		).toEqual([])
	})
})

describe('ID-7: an embedded Undo of a Like stored under another id', () => {
	it('retracts both ids, so a replay of the stored Like does not restore the favourite', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const local = await localStatus(t, { status: 'liked twice', visibility: 'public' })
		const first = like(bob, local.uri)
		const second = like(bob, local.uri)
		await t.post(bob, first)
		await t.post(bob, second)
		await t.post(bob, undo(bob, { id: second.id, type: 'Like', actor: bob.uri, object: local.uri }))
		expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
		expect(
			(await sql<{ target_uri: string }>(t.store, 'SELECT target_uri FROM inbound_retractions'))
				.map((r) => r.target_uri)
				.sort()
		).toEqual([first.id, second.id].sort())
		await t.post(bob, first)
		expect(await sql(t.store, 'SELECT * FROM favourites')).toEqual([])
		expect((await statusRow(t.store, local.uri))?.favourites_count).toBe(0)
		expect(await notifications(t.store)).toEqual([])
	})
})

describe('RES-6: the deletion job', () => {
	it('writes at most PURGE_BATCH rows per batch, hiding included', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		await t.post(bob, create(bob, note))
		const row = (await statusRow(t.store, note.id))!
		await remoteAccounts(t, PURGE_BATCH + 100)
		await sql(
			t.store,
			`INSERT INTO status_mentions (status_id, account_id, silent)
			SELECT ?, id, 1 FROM accounts WHERE domain = 'many.example' ORDER BY id LIMIT ?`,
			row.id,
			MAX_STATUS_MENTION_ROWS
		)
		await sql(
			t.store,
			`INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, published_at)
			SELECT printf('5%017d', CAST(substr(id, 2) AS INTEGER)), uri || '/boost', id, ?, 'public', '2026-10-11T13:00:00.000Z'
			FROM accounts WHERE domain = 'many.example'`,
			row.id
		)
		await sql(
			t.store,
			"INSERT INTO inbound_jobs (kind, key, actor_uri, created_at) VALUES ('delete', ?, ?, ?)",
			row.id,
			bob.uri,
			NOW
		)
		const written: number[] = []
		for (let batch = 0; batch < 10; batch++) {
			const result = await runInDurableObject(t.store, (_instance, state) => {
				const db = new Db(state.storage.sql)
				const before = db.first<{ n: number }>('SELECT total_changes() AS n')!.n
				const pending = deleteStatusBatch(db, row.id, NOW)
				return { pending, changes: db.first<{ n: number }>('SELECT total_changes() AS n')!.n - before }
			})
			written.push(result.changes)
			if (batch === 0) {
				// Hidden by the first batch: no content, no audience.
				expect(await statusRow(t.store, note.id)).toMatchObject({ visibility: 'direct', content: '' })
				expect(await sql(t.store, 'SELECT count(*) AS n FROM status_mentions WHERE status_id = ?', row.id)).toEqual([
					{ n: 0 },
				])
			}
			if (!result.pending) {
				break
			}
		}
		expect(written.length).toBeGreaterThan(1)
		expect(Math.max(...written)).toBeLessThanOrEqual(PURGE_BATCH)
		expect(await statuses(t.store)).toEqual([])
	})

	it('withdraws a local boost once when a status Delete and its author’s purge both reach it', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		await t.post(bob, create(bob, note))
		const row = (await statusRow(t.store, note.id))!
		const boosted = await t.request(`/api/v1/statuses/${row.id}/reblog`, {
			method: 'POST',
			headers: { authorization: `Bearer ${t.tokens.alice}` },
		})
		expect(boosted.status).toBe(200)
		const boost = (
			await sql<{ id: string; uri: string }>(t.store, 'SELECT id, uri FROM statuses WHERE reblog_of_id = ?', row.id)
		)[0]!
		// More receipts than one batch can stage, so the withdrawal spans batches.
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 70000)
			INSERT INTO outbound_receipts (status_id, inbox_url, account_id, delivered_at)
			SELECT ?, 'https://r' || i || '.example/inbox', ?, ? FROM n`,
			boost.id,
			ALICE,
			NOW
		)
		const intents = () =>
			sql<{ n: number }>(
				t.store,
				'SELECT count(*) AS n FROM outbound_activities WHERE object_uri = ? AND retracts = 1',
				boost.uri
			)
		expect(await t.post(bob, remove(bob, note.id))).toBe(202)
		expect(await intents()).toEqual([{ n: 1 }])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses WHERE id = ?', boost.id)).toEqual([{ n: 1 }])

		// The author deletes itself while the Undo is still staging.
		t.web.fail(bob.uri, 410)
		const deletion = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, deletion)).toBe(202)
		expect(await intents()).toEqual([{ n: 1 }])
		expect(
			await sql(
				t.store,
				'SELECT count(*) AS n FROM outbound_activities WHERE object_uri = ? AND retracts = 1 AND superseded = 1',
				boost.uri
			)
		).toEqual([{ n: 0 }])

		// The receipts go a batch at a time once the Undo is staged (as cron or the Queue would run the jobs).
		for (let round = 0; round < 100; round++) {
			if (!(await t.store.runInboundJobs(BUILD, { now: NOW })).pending) {
				break
			}
		}
		expect(await statuses(t.store)).toEqual([])
		expect(await intents()).toEqual([{ n: 1 }])
	})
})

describe('VIS-6: the audience of a boost', () => {
	it('notifies a local author of a private boost only if they may see the boost', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		await followed(t, bob, DAVE)
		await followed(t, carol, DAVE)
		const local = await localStatus(t, { status: 'public post', visibility: 'public' })
		// bob boosts it for his followers (dave): alice neither follows bob nor is addressed.
		await t.post(bob, announce(bob, local.uri, { to: [`${bob.uri}/followers`], cc: [] }))
		// carol boosts it for her followers and addresses alice.
		await t.post(carol, announce(carol, local.uri, { to: [`${carol.uri}/followers`], cc: [ALICE_URI] }))
		const carolId = (await accountId(t.store, carol.uri))!
		expect(await sql(t.store, 'SELECT account_id, type, from_account_id FROM notifications')).toEqual([
			{ account_id: ALICE, type: 'reblog', from_account_id: carolId },
		])
		expect((await statuses(t.store)).filter((s) => s.reblog_of_id !== null).map((s) => s.visibility)).toEqual([
			'private',
			'private',
		])
		const listed = await t.api<{ type: string; account: { id: string } }[]>('/api/v1/notifications')
		expect(listed.body.map((n) => n.account.id)).toEqual([carolId])
		// alice follows bob now: his boost is visible to her, but no notification was written for it.
		const bobId = (await accountId(t.store, bob.uri))!
		await sql(
			t.store,
			"INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
			ALICE,
			bobId
		)
		expect((await t.api<unknown[]>('/api/v1/notifications')).body).toHaveLength(1)
	})
})

describe('VIS-2: edits never add recipients to a direct or limited status', () => {
	it('keeps a direct status and a Misskey specified note to their recipients', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const direct = mastodonNote(bob, { to: [ALICE_URI], cc: [], tag: [{ type: 'Mention', href: ALICE_URI }] })
		await t.post(bob, create(bob, direct))
		const widened = (note: Note) => ({
			...note,
			to: [...note.to, DAVE_URI, PUBLIC],
			tag: [
				{ type: 'Mention', href: ALICE_URI },
				{ type: 'Mention', href: DAVE_URI },
			],
			content: '<p>now @dave too</p>',
		})
		await t.post(bob, update(bob, widened(direct), at(60)))
		const neko = await misskeyActor(t.web, '9abcdefghi', 'neko')
		const specified = misskeyNote(neko, { to: [ALICE_URI], cc: [] })
		await t.post(neko, create(neko, specified, MISSKEY_CONTEXT))
		await t.post(neko, { ...update(neko, widened(specified), at(60)), '@context': MISSKEY_CONTEXT })
		for (const [uri, visibility] of [
			[direct.id, 'direct'],
			[specified.id, 'limited'],
		] as const) {
			const row = (await statusRow(t.store, uri))!
			expect(row.visibility).toBe(visibility)
			expect(row.content).toBe('<p>now @dave too</p>')
			expect(await sql(t.store, 'SELECT account_id FROM status_mentions WHERE status_id = ?', row.id)).toEqual([
				{ account_id: ALICE },
			])
			expect((await t.api(`/api/v1/statuses/${row.id}`, 'dave')).status).toBe(404)
		}
		expect((await notifications(t.store)).filter((n) => n.account_id === DAVE)).toEqual([])
	})

	it('notifies a local account newly mentioned and addressed by an edit of a public status, as a Create would', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		await t.post(bob, create(bob, note))
		await t.post(
			bob,
			update(
				bob,
				{
					...note,
					cc: [...note.cc, ALICE_URI],
					tag: [
						{ type: 'Mention', href: ALICE_URI },
						{ type: 'Mention', href: DAVE_URI },
					],
				},
				at(60)
			)
		)
		// alice is addressed and mentioned; dave is only tagged, so he is not notified.
		expect(await notifications(t.store)).toEqual([{ account_id: ALICE, type: 'mention' }])
	})
})

describe('RES-4: bounds at their limits', () => {
	it(`keeps ${MAX_STATUS_EDITS} versions of history: the 101st replaces the newest`, async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const note = mastodonNote(bob)
		await t.post(bob, create(bob, note))
		const id = (await statusRow(t.store, note.id))!.id
		for (let i = 1; i < MAX_STATUS_EDITS; i++) {
			await t.post(bob, update(bob, { ...note, content: `<p>v${i}</p>` }, at(i)))
		}
		expect(await sql(t.store, 'SELECT count(*) AS n FROM status_edits WHERE status_id = ?', id)).toEqual([
			{ n: MAX_STATUS_EDITS },
		])
		await t.post(bob, update(bob, { ...note, content: '<p>latest</p>' }, at(MAX_STATUS_EDITS)))
		const history = await sql<{ content: string }>(
			t.store,
			'SELECT content FROM status_edits WHERE status_id = ? ORDER BY id',
			id
		)
		expect(history).toHaveLength(MAX_STATUS_EDITS)
		expect(history[0]?.content).toBe(note.content)
		expect(history.at(-2)?.content).toBe(`<p>v${MAX_STATUS_EDITS - 2}</p>`)
		expect(history.at(-1)?.content).toBe('<p>latest</p>')
	})

	it(`stores at most ${MAX_STATUS_MENTION_ROWS} recipients, local first, and keeps the bound on redelivery`, async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const many = await remoteAccounts(t, MAX_STATUS_MENTION_ROWS + 50)
		const note = mastodonNote(bob, { to: [PUBLIC], cc: [...many, ALICE_URI] })
		await t.post(bob, create(bob, note))
		const id = (await statusRow(t.store, note.id))!.id
		const count = () => sql(t.store, 'SELECT count(*) AS n FROM status_mentions WHERE status_id = ?', id)
		expect(await count()).toEqual([{ n: MAX_STATUS_MENTION_ROWS }])
		expect(
			await sql(t.store, 'SELECT 1 AS x FROM status_mentions WHERE status_id = ? AND account_id = ?', id, ALICE)
		).toHaveLength(1)
		expect(await t.post(bob, create(bob, note), { path: '/ap/users/dave/inbox' })).toBe(202)
		expect(await count()).toEqual([{ n: MAX_STATUS_MENTION_ROWS }])
		expect(
			await sql(t.store, 'SELECT silent FROM status_mentions WHERE status_id = ? AND account_id = ?', id, DAVE)
		).toEqual([{ silent: 1 }])
	})

	it(`links at most ${MAX_LINKED_REPLIES} earlier replies to an arriving parent`, async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const parent = mastodonNote(bob)
		await sql(
			t.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO statuses (id, uri, account_id, in_reply_to_uri, visibility, published_at)
			SELECT printf('6%017d', i), ? || '/replies/' || i, ?, ?, 'public', '2026-10-11T13:00:00.000Z' FROM n`,
			MAX_LINKED_REPLIES + 50,
			bob.uri,
			bobId,
			parent.id
		)
		await t.post(bob, create(bob, parent))
		expect(await sql(t.store, 'SELECT count(*) AS n FROM statuses WHERE in_reply_to_id IS NOT NULL')).toEqual([
			{ n: MAX_LINKED_REPLIES },
		])
		expect((await statusRow(t.store, parent.id))?.replies_count).toBe(MAX_LINKED_REPLIES)
	})

	it(`shows at most ${MAX_REMOTE_FIELDS} profile fields`, async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob', {
			extra: {
				attachment: Array.from({ length: MAX_REMOTE_FIELDS + 4 }, (_, i) => ({
					type: 'PropertyValue',
					name: `f${i}`,
					value: `v${i}`,
				})),
			},
		})
		const bobId = await followed(t, bob)
		const shown = await t.api<{ fields: { name: string }[] }>(`/api/v1/accounts/${bobId}`)
		expect(shown.body.fields.map((f) => f.name)).toEqual(Array.from({ length: MAX_REMOTE_FIELDS }, (_, i) => `f${i}`))
	})
})

describe('RES-2: JSON-LD contexts past the JSON bounds', () => {
	const big = {
		'@context': Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [`t${i}`, `https://ex.example/${i}`])),
	}

	it('refuses a cached context past the bounds, and never caches one', async () => {
		const t = await setup()
		const cachedUrl = 'https://ctx.example/cached'
		await sql(
			t.store,
			'INSERT INTO fedify_kv (key, value, expires_at) VALUES (?, ?, NULL)',
			JSON.stringify(['_fedify', 'remoteDocument', cachedUrl]),
			JSON.stringify({ contextUrl: null, document: big, documentUrl: cachedUrl })
		)
		const bob = await mastodonActor(t.web, 'bob')
		bob.document['@context'] = [AS, 'https://w3id.org/security/v1', cachedUrl]
		t.web.serve(bob.uri, bob.document)
		expect(await t.post(bob, like(bob, `${LOCAL}/ap/o/x`))).toBe(401)

		const fresh = 'https://ctx.example/fresh'
		t.web.serve(fresh, big, 'application/ld+json')
		const carol = await mastodonActor(t.web, 'carol', { key: 2 })
		carol.document['@context'] = [AS, 'https://w3id.org/security/v1', fresh]
		t.web.serve(carol.uri, carol.document)
		expect(await t.post(carol, like(carol, `${LOCAL}/ap/o/x`))).toBe(401)
		expect(t.web.fetched).toContain(fresh)
		expect(
			await sql(
				t.store,
				'SELECT key FROM fedify_kv WHERE key = ?',
				JSON.stringify(['_fedify', 'remoteDocument', fresh])
			)
		).toEqual([])
	})
})

describe('the Store asks for documents at most three times per activity', () => {
	it('answers 202 after the third round without a fourth', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		let calls = 0
		const store = t.store as unknown as Record<string | symbol, (...args: unknown[]) => unknown>
		const wrapped = new Proxy(store, {
			get: (target, prop) =>
				prop === 'receiveActivity'
					? () => {
							calls++
							return Promise.resolve({
								applied: false,
								reason: 'need-object',
								jobsPending: false,
								need: { kind: 'status', uri: `${OTHER}/objects/${calls}` },
							})
						}
					: (...args: unknown[]) => target[prop]!(...args),
		}) as unknown as StoreStub
		const h = harness(wrapped, {}, undefined, { keygen: fixtureKeyGen, loader: t.web.loader })
		const response = await h.request('/inbox', await signedInit(bob, '/inbox', announce(bob, `${OTHER}/objects/0`)))
		expect(response.status).toBe(202)
		expect(calls).toBe(3)
		expect(t.web.fetched.filter((url) => url.startsWith(`${OTHER}/objects/`))).toEqual([
			`${OTHER}/objects/1`,
			`${OTHER}/objects/2`,
			`${OTHER}/objects/3`,
		])
	})
})

describe('NET-4: search resolution fetches nothing without a valid token', () => {
	it('answers an invalid, revoked or wrong-scope token without fetching', async () => {
		const t = await setup()
		const q = encodeURIComponent(`${MASTODON}/users/bob`)
		const revoked = t.tokens.dave
		await sql(t.store, 'DELETE FROM oauth_tokens WHERE account_id = ?', DAVE)
		const writeOnly = 'token-write-only'
		await sql(
			t.store,
			"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'test', ?, 'write')",
			await sha256Hex(writeOnly),
			ALICE
		)
		const statusesOf = []
		for (const value of ['not-a-token', revoked, writeOnly]) {
			const response = await t.request(`/api/v2/search?resolve=true&q=${q}`, {
				headers: { authorization: `Bearer ${value}` },
			})
			statusesOf.push(response.status)
		}
		expect(statusesOf).toEqual([401, 401, 403])
		expect(t.web.fetched).toEqual([])
	})
})

describe('the canonical WebFinger domain', () => {
	function webfinger(t: Setup, resource: string, host: string, actor: string) {
		t.web.serve(
			`https://${host}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`,
			{ subject: resource, links: [{ rel: 'self', type: AP, href: actor }] },
			'application/jrd+json'
		)
	}

	it('stores the WebFinger domain when the actor confirms it, and inbound activity keeps it', async () => {
		const t = await setup()
		const alice = await mastodonActor(t.web, 'ali', { origin: 'https://social.example.org', key: 3 })
		webfinger(t, 'acct:al@example.org', 'example.org', alice.uri)
		// The actor's own username at the domain names the same actor (one more lookup).
		webfinger(t, 'acct:ali@example.org', 'example.org', alice.uri)
		const found = await t.api<{ accounts: { acct: string }[] }>('/api/v2/search?resolve=true&q=al%40example.org')
		expect(found.body.accounts.map((a) => a.acct)).toEqual(['ali@example.org'])
		const webfingers = t.web.fetched
			.map((url, i) => [url, t.web.signers[i]])
			.filter(([url]) => url!.includes('webfinger'))
		expect(webfingers.map(([, signer]) => signer)).toEqual(['unsigned', 'unsigned'])
		// An inbound activity of the actor refreshes it from its document, and keeps the confirmed domain.
		await t.post(alice, {
			'@context': AS,
			id: `${alice.uri}#follow`,
			type: 'Follow',
			actor: alice.uri,
			object: DAVE_URI,
		})
		expect(await sql(t.store, 'SELECT domain FROM accounts WHERE uri = ?', alice.uri)).toEqual([
			{ domain: 'example.org' },
		])
		const exact = await t.api<{ accounts: { acct: string }[] }>('/api/v2/search?q=ali%40example.org&type=accounts')
		expect(exact.body.accounts.map((a) => a.acct)).toEqual(['ali@example.org'])
	})

	it('keeps the actor’s host when the reverse lookup does not confirm the domain', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		webfinger(t, 'acct:impostor@example.net', 'example.net', bob.uri)
		const found = await t.api<{ accounts: { acct: string }[] }>('/api/v2/search?resolve=true&q=impostor%40example.net')
		expect(found.body.accounts.map((a) => a.acct)).toEqual(['bob@mastodon.example'])
		expect(t.web.fetched).toContain(
			`https://example.net/.well-known/webfinger?resource=${encodeURIComponent('acct:bob@example.net')}`
		)
		expect(await sql(t.store, 'SELECT domain FROM accounts WHERE uri = ?', bob.uri)).toEqual([
			{ domain: 'mastodon.example' },
		])
	})
})
