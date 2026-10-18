import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { BUILD } from './helpers'
import { AP, mastodonActor, type TestActor } from './inbox-helpers'
import {
	ALICE,
	AS,
	create,
	followed,
	localStatus,
	mastodonNote,
	type Note,
	type Setup,
	setup,
	statuses,
	update,
} from './inbox-status-helpers'
import { block, domainBlock, outbound } from './status-helpers'
import { Db } from '../src/db/sql'
import { MAX_REMOTE_OPTIONS, type Poll } from '../src/domain/polls'
import { recordEdit } from '../src/domain/statuses'
import { endPolls } from '../src/jobs/scheduled'
import { MAX_REMOTE_OPTION_LENGTH, pollOptionsSql } from '../src/platform/stored-bounds'

// Polls over ActivityPub (domain/polls.ts, remote-statuses.ts, activities.ts), as Mastodon 4.5 federates them: a
// Question stored with its poll, an Update(Question) refreshing its counts, a vote Note counted in a local poll and
// never stored as a status, a local vote in a remote poll delivered as Mastodon's vote Note, and a local poll served
// and sent as a Question. Federation runs against the synthetic remote web of the inbox tests only.

function question(actor: TestActor, extra: Record<string, unknown> = {}): Note {
	return mastodonNote(actor, {
		type: 'Question',
		content: '<p>which?</p>',
		endTime: '2026-10-12T01:00:00Z',
		votersCount: 3,
		oneOf: [
			{ type: 'Note', name: 'cats', replies: { type: 'Collection', totalItems: 2 } },
			{ type: 'Note', name: 'dogs', replies: { type: 'Collection', totalItems: 1 } },
		],
		...extra,
	})
}

function implicitUpdate(actor: TestActor, object: Note, n: number) {
	return { '@context': AS, id: `${object.id}#updates/poll-${n}`, type: 'Update', actor: actor.uri, object }
}

function voteNote(actor: TestActor, statusUri: string, name: string, n: number) {
	const id = `${actor.uri}#votes/${n}`
	return {
		'@context': AS,
		id: `${id}/activity`,
		type: 'Create',
		actor: actor.uri,
		to: [`${new URL(statusUri).origin}/ap/users/alice`],
		object: { id, type: 'Note', name, attributedTo: actor.uri, inReplyTo: statusUri, to: [] },
	}
}

async function api<T>(t: Setup, path: string, init: RequestInit = {}) {
	const response = await t.request(path, {
		...init,
		headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
	})
	return { status: response.status, body: (await response.json()) as T }
}

async function remotePoll(t: Setup, bob: TestActor, object: Note) {
	expect(await t.post(bob, create(bob, object))).toBe(202)
	const [row] = await sql<{ id: string }>(t.store, 'SELECT id FROM statuses WHERE uri = ?', object.id)
	return row!.id
}

describe('a remote Question', () => {
	it('is stored with its poll, and a local vote in it is sent to its author as a vote Note', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const object = question(bob)
		const id = await remotePoll(t, bob, object)
		const { body } = await api<{ poll: Poll }>(t, `/api/v1/statuses/${id}`)
		expect(body.poll).toEqual({
			id,
			expires_at: '2026-10-12T01:00:00.000Z',
			expired: false,
			multiple: false,
			votes_count: 3,
			voters_count: 3,
			options: [
				{ title: 'cats', votes_count: 2 },
				{ title: 'dogs', votes_count: 1 },
			],
			emojis: [],
			voted: false,
			own_votes: [],
		})
		const voted = await api<Poll>(t, `/api/v1/polls/${id}/votes`, {
			method: 'POST',
			body: JSON.stringify({ choices: ['1'] }),
		})
		expect(voted.body).toMatchObject({ votes_count: 4, voters_count: 4, own_votes: [1] })
		const sent = (await outbound(t.store)).filter((o) => (o.activity.object as { name?: string })?.name === 'dogs')
		expect(sent).toEqual([
			{
				signer: ALICE,
				activity: {
					'@context': AS,
					id: expect.stringMatching(/^https:\/\/kopje\.test\/ap\/users\/alice#votes\/\d+\/activity$/),
					type: 'Create',
					actor: 'https://kopje.test/ap/users/alice',
					to: [bob.uri],
					object: {
						id: expect.stringMatching(/#votes\/\d+$/),
						type: 'Note',
						name: 'dogs',
						attributedTo: 'https://kopje.test/ap/users/alice',
						inReplyTo: object.id,
						to: [bob.uri],
					},
				},
				audience: { followers: false, accounts: [expect.any(String)] },
			},
		])
	})

	it('takes the counts, voters and end of an Update(Question) that names no new version, but not new choices', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const object = question(bob)
		const id = await remotePoll(t, bob, object)
		const refreshed = question(bob, {
			id: object.id,
			votersCount: 7,
			closed: '2026-10-12T00:30:00Z',
			oneOf: [
				{ type: 'Note', name: 'cats', replies: { type: 'Collection', totalItems: 5 } },
				{ type: 'Note', name: 'dogs', replies: { type: 'Collection', totalItems: 2 } },
			],
		})
		expect(await t.post(bob, implicitUpdate(bob, refreshed, 1))).toBe(202)
		expect(await sql(t.store, 'SELECT tallies, votes_count, voters_count, expires_at FROM polls')).toEqual([
			{ tallies: '[5,2]', votes_count: 7, voters_count: 7, expires_at: '2026-10-12T00:30:00.000Z' },
		])
		// New choices need a newer version (an edit), which drops the votes cast.
		const changed = {
			...refreshed,
			oneOf: [
				{ type: 'Note', name: 'birds' },
				{ type: 'Note', name: 'fish' },
			],
		}
		await t.post(bob, implicitUpdate(bob, changed, 2))
		expect(await sql(t.store, 'SELECT options FROM polls')).toEqual([{ options: '["cats","dogs"]' }])
		await api(t, `/api/v1/polls/${id}/votes`, { method: 'POST', body: JSON.stringify({ choices: ['0'] }) })
		expect(await t.post(bob, update(bob, changed, '2026-10-11T12:30:00Z'))).toBe(202)
		expect(await sql(t.store, 'SELECT options, votes_count FROM polls')).toEqual([
			{ options: '["birds","fish"]', votes_count: 0 },
		])
		expect((await api<Poll>(t, `/api/v1/polls/${id}`)).body).toMatchObject({ voted: false, own_votes: [] })
		// The dropped votes go in the cron's next round.
		await endPolls(t.env, { build: () => BUILD, now: () => NOW, store: () => t.store })
		expect(await sql(t.store, 'SELECT count(*) AS n FROM poll_votes')).toEqual([{ n: 0 }])
		const history = await api<{ poll: unknown }[]>(t, `/api/v1/statuses/${id}/history`)
		expect(history.body.map((entry) => entry.poll)).toEqual([
			{ options: [{ title: 'cats' }, { title: 'dogs' }] },
			{ options: [{ title: 'birds' }, { title: 'fish' }] },
		])
	})

	it('leaves the poll alone for an Update older than the stored version, reordered or replayed', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const object = question(bob)
		await remotePoll(t, bob, object)
		const counts = (cats: number, dogs: number, voters: number, end: string) =>
			question(bob, {
				id: object.id,
				votersCount: voters,
				endTime: end,
				oneOf: [
					{ type: 'Note', name: 'cats', replies: { type: 'Collection', totalItems: cats } },
					{ type: 'Note', name: 'dogs', replies: { type: 'Collection', totalItems: dogs } },
				],
			})
		const v1 = update(bob, counts(3, 1, 4, '2026-10-12T02:00:00Z'), '2026-10-11T12:10:00Z')
		const v2 = update(bob, counts(5, 5, 10, '2026-10-12T03:00:00Z'), '2026-10-11T12:20:00Z')
		const stored = () => sql(t.store, 'SELECT tallies, votes_count, voters_count, expires_at FROM polls')
		expect(await t.post(bob, v2)).toBe(202)
		const after2 = [{ tallies: '[5,5]', votes_count: 10, voters_count: 10, expires_at: '2026-10-12T03:00:00.000Z' }]
		expect(await stored()).toEqual(after2)
		// V1 after V2, and V1 again: nothing.
		await t.post(bob, v1)
		await t.post(bob, { ...v1, id: `${v1.id}-again` })
		expect(await stored()).toEqual(after2)
		// The same version as stored with newer counts is an implicit update.
		const same = update(bob, counts(6, 5, 11, '2026-10-12T03:00:00Z'), '2026-10-11T12:20:00Z')
		await t.post(bob, { ...same, id: `${same.id}-counts` })
		expect(await stored()).toEqual([
			{ tallies: '[6,5]', votes_count: 11, voters_count: 11, expires_at: '2026-10-12T03:00:00.000Z' },
		])
	})

	it('keeps the first 100 choices of a larger poll, taking count updates and edits of them, and votes in them', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const choices = (names: (i: number) => string, counts: (i: number) => number) =>
			Array.from({ length: MAX_REMOTE_OPTIONS + 1 }, (_, i) => ({
				type: 'Note',
				name: names(i),
				replies: { type: 'Collection', totalItems: counts(i) },
			}))
		const object = question(bob, {
			oneOf: undefined,
			anyOf: choices(
				(i) => `c${i}`,
				() => 1
			),
		})
		const id = await remotePoll(t, bob, object)
		const stored = async () =>
			(await sql<{ options: string; tallies: string }>(t.store, 'SELECT options, tallies FROM polls'))[0]!
		expect(JSON.parse((await stored()).options) as string[]).toHaveLength(MAX_REMOTE_OPTIONS)
		// A vote in the last choice kept is counted; the one past it does not exist.
		const vote = (choice: number) =>
			api(t, `/api/v1/polls/${id}/votes`, { method: 'POST', body: JSON.stringify({ choices: [String(choice)] }) })
		expect((await vote(MAX_REMOTE_OPTIONS)).status).toBe(422)
		expect((await vote(MAX_REMOTE_OPTIONS - 1)).status).toBe(200)
		// New counts for the same choices (and the one past the bound) are an implicit update: the vote stays.
		const counted = question(bob, {
			id: object.id,
			oneOf: undefined,
			anyOf: choices(
				(i) => `c${i}`,
				(i) => i + 2
			),
		})
		expect(await t.post(bob, implicitUpdate(bob, counted, 1))).toBe(202)
		expect(JSON.parse((await stored()).tallies)).toEqual(Array.from({ length: MAX_REMOTE_OPTIONS }, (_, i) => i + 2))
		expect((await api<Poll>(t, `/api/v1/polls/${id}`)).body).toMatchObject({ own_votes: [MAX_REMOTE_OPTIONS - 1] })
		// A change of the last choice kept is an edit, which drops the votes cast.
		const edited = question(bob, {
			id: object.id,
			oneOf: undefined,
			anyOf: choices(
				(i) => (i === MAX_REMOTE_OPTIONS - 1 ? 'changed' : `c${i}`),
				() => 0
			),
		})
		expect(await t.post(bob, update(bob, edited, '2026-10-11T12:30:00Z'))).toBe(202)
		expect((JSON.parse((await stored()).options) as string[]).at(-1)).toBe('changed')
		expect((await api<Poll>(t, `/api/v1/polls/${id}`)).body).toMatchObject({ voted: false, own_votes: [] })
	})

	// RES-2: choices are stored well-formed and cut without splitting a pair, and an edit's snapshot holds P of them as
	// SQLite projects them (recordEdit), never a value read into the Worker and bound again.
	it('snapshots choices of lone surrogates or a split pair as fixed points of their projection', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const lone = '\ud800'.repeat(MAX_REMOTE_OPTION_LENGTH)
		const split = `${'a'.repeat(MAX_REMOTE_OPTION_LENGTH - 1)}\u{1F600}`
		const choices = [lone, split].map((name) => ({
			type: 'Note',
			name,
			replies: { type: 'Collection', totalItems: 0 },
		}))
		const object = question(bob, { oneOf: choices })
		const id = await remotePoll(t, bob, object)
		const edited = question(bob, { id: object.id, content: '<p>which, now?</p>', oneOf: choices })
		expect(await t.post(bob, update(bob, edited, '2026-10-11T12:30:00Z'))).toBe(202)
		const expected = ['\ufffd'.repeat(MAX_REMOTE_OPTION_LENGTH), 'a'.repeat(MAX_REMOTE_OPTION_LENGTH - 1)]
		const [poll] = await sql<{ options: string; cut_options: string }>(
			t.store,
			'SELECT options, cut_options FROM polls'
		)
		expect([JSON.parse(poll!.options), JSON.parse(poll!.cut_options)]).toEqual([expected, [0, 1]])
		const snapshots = await sql<{ options: string; fixed: number }>(
			t.store,
			`SELECT poll_options AS options, (${pollOptionsSql('poll_options')}) IS poll_options AS fixed FROM status_edits`
		)
		expect(snapshots).toEqual([
			{ options: JSON.stringify(expected), fixed: 1 },
			{ options: JSON.stringify(expected), fixed: 1 },
		])
		// A choice stored with lone surrogates (an earlier version's row) is snapshotted inside SQLite all the same.
		const raw = `["${lone}","${split}"]`
		const fixed = await runInDurableObject(t.store, (_instance, state) =>
			state.storage.transactionSync(() => {
				const db = new Db(state.storage.sql)
				db.run('UPDATE polls SET options = ? WHERE status_id = ?', raw, id)
				recordEdit(db, id, '2026-10-11T13:00:00.000Z')
				return db.all<{ fixed: number; bytes: number }>(
					`SELECT (${pollOptionsSql('poll_options')}) IS poll_options AS fixed,
						length(CAST(poll_options AS BLOB)) AS bytes FROM status_edits ORDER BY id DESC LIMIT 1`
				)
			})
		)
		// Three bytes per lone surrogate as stored, 999 + 4 for the other choice, and the array's 7.
		expect(fixed).toEqual([{ fixed: 1, bytes: 3 * MAX_REMOTE_OPTION_LENGTH + 1003 + 7 }])
	})

	it('keeps a long choice Mastodon allows whole, and refuses a vote in a choice it had to cut', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		// 50 grapheme clusters, as Mastodon counts them, of 11 code units each.
		const family = '👨‍👩‍👧‍👦'.repeat(50)
		const tooLong = 'x'.repeat(1001)
		const object = question(bob, {
			oneOf: [
				{ type: 'Note', name: family },
				{ type: 'Note', name: tooLong },
			],
		})
		const id = await remotePoll(t, bob, object)
		const vote = (choice: string) =>
			api<{ error?: string }>(t, `/api/v1/polls/${id}/votes`, {
				method: 'POST',
				body: JSON.stringify({ choices: [choice] }),
			})
		expect(await vote('1')).toEqual({
			status: 422,
			body: { error: 'Validation failed: The chosen vote option does not exist' },
		})
		expect(await sql(t.store, 'SELECT count(*) AS n FROM poll_votes')).toEqual([{ n: 0 }])
		expect((await vote('0')).status).toBe(200)
		const names = (await outbound(t.store)).map((o) => (o.activity.object as { name?: string } | undefined)?.name)
		expect(names.filter((name) => name !== undefined)).toEqual([family])
	})

	it('refuses a vote in a poll on a domain the voter blocks, recording and sending nothing (R27)', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const id = await remotePoll(t, bob, question(bob))
		await domainBlock(t.store, ALICE, new URL(bob.uri).host)
		const before = (await outbound(t.store)).length
		const refused = await api(t, `/api/v1/polls/${id}/votes`, {
			method: 'POST',
			body: JSON.stringify({ choices: ['0'] }),
		})
		expect(refused).toEqual({ status: 403, body: { error: 'This action is not allowed' } })
		expect(await sql(t.store, 'SELECT count(*) AS n FROM poll_votes')).toEqual([{ n: 0 }])
		expect(await sql(t.store, 'SELECT votes_count FROM polls')).toEqual([{ votes_count: 3 }])
		expect(await outbound(t.store)).toHaveLength(before)
	})

	it('refuses a vote in a choice an edit lengthened past the cut, though its stored title stays the same', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		await followed(t, bob)
		const exact = 'x'.repeat(1000)
		const object = question(bob, {
			oneOf: [
				{ type: 'Note', name: exact },
				{ type: 'Note', name: 'b' },
			],
		})
		const id = await remotePoll(t, bob, object)
		const lengthened = {
			...object,
			oneOf: [
				{ type: 'Note', name: `${exact}y` },
				{ type: 'Note', name: 'b' },
			],
		}
		expect(await t.post(bob, update(bob, lengthened, '2026-10-11T12:30:00Z'))).toBe(202)
		expect(
			await sql(t.store, 'SELECT options = ? AS same, cut_options FROM polls', JSON.stringify([exact, 'b']))
		).toEqual([{ same: 1, cut_options: '[0]' }])
		const refused = await api(t, `/api/v1/polls/${id}/votes`, {
			method: 'POST',
			body: JSON.stringify({ choices: ['0'] }),
		})
		expect(refused.status).toBe(422)
		expect(await sql(t.store, 'SELECT count(*) AS n FROM poll_votes')).toEqual([{ n: 0 }])
		// The same version shortening it back is a change of choices too, which only a newer version makes.
		const shortened = { ...object, id: object.id }
		await t.post(bob, { ...update(bob, shortened, '2026-10-11T12:30:00Z'), id: `${object.id}#updates/again` })
		expect(await sql(t.store, 'SELECT cut_options FROM polls')).toEqual([{ cut_options: '[0]' }])
	})

	it('notifies its local voters when it ends', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const bobId = await followed(t, bob)
		const id = await remotePoll(t, bob, question(bob))
		await api(t, `/api/v1/polls/${id}/votes`, { method: 'POST', body: JSON.stringify({ choices: ['0'] }) })
		await endPolls(t.env, { build: () => BUILD, now: () => NOW + 2 * 3_600_000, store: () => t.store })
		expect(
			await sql(t.store, "SELECT account_id, from_account_id, status_id FROM notifications WHERE type = 'poll'")
		).toEqual([{ account_id: ALICE, from_account_id: bobId, status_id: id }])
	})
})

describe('a remote vote in a local poll', () => {
	async function localPoll(t: Setup, poll: Record<string, unknown> = {}) {
		return localStatus(t, { status: 'which?', poll: { options: ['cats', 'dogs'], expires_in: 3600, ...poll } })
	}

	it('counts once, as Mastodon counts it, and is never stored as a status', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const status = await localPoll(t)
		expect(await t.post(bob, voteNote(bob, status.uri, 'dogs', 1))).toBe(202)
		// Again, another choice of a single-choice poll, and a choice it does not have: none counts.
		await t.post(bob, voteNote(bob, status.uri, 'dogs', 2))
		await t.post(bob, voteNote(bob, status.uri, 'cats', 3))
		await t.post(bob, voteNote(bob, status.uri, 'birds', 4))
		expect(await sql(t.store, 'SELECT tallies, votes_count, voters_count FROM polls')).toEqual([
			{ tallies: '[0,1]', votes_count: 1, voters_count: 1 },
		])
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([status.uri])
		// The Update of the counts falls due.
		expect(await sql(t.store, 'SELECT update_due_at IS NOT NULL AS due FROM polls')).toEqual([{ due: 1 }])
	})

	it("sends the voter's server the Update of the counts, not a Create, though no delivery of the status is recorded", async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const status = await localPoll(t)
		await t.post(bob, voteNote(bob, status.uri, 'dogs', 1))
		await endPolls(t.env, { build: () => BUILD, now: () => NOW + 3 * 60_000, store: () => t.store })
		const [inbox] = await sql<{ inbox: string }>(
			t.store,
			"SELECT COALESCE(NULLIF(shared_inbox_url, ''), inbox_url) AS inbox FROM accounts WHERE uri = ?",
			bob.uri
		)
		const sent = await sql<{ type: string }>(
			t.store,
			`SELECT json_extract(o.body, '$.activity.type') AS type FROM outbound_activities o
			WHERE EXISTS (SELECT 1 FROM deliveries d WHERE d.activity_id = o.id AND d.inbox_url = ?1)
				OR EXISTS (SELECT 1 FROM outbound_targets c, json_each(c.targets) x
					WHERE c.activity_id = o.id AND json_extract(x.value, '$.inbox') = ?1)`,
			inbox!.inbox
		)
		expect(sent).toEqual([{ type: 'Update' }])
	})

	it('drops a vote that arrives after an edit removed the poll, storing and counting nothing', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const status = await localPoll(t)
		const edited = await t.request(`/api/v1/statuses/${(status as { id: string }).id}`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${t.tokens.alice}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'no poll now' }),
		})
		expect(edited.status).toBe(200)
		expect(await t.post(bob, voteNote(bob, status.uri, 'dogs', 1))).toBe(202)
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([status.uri])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM poll_votes')).toEqual([{ n: 0 }])
	})

	it('is refused from an account the author blocks (R27), and after the poll ends', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const carol = await mastodonActor(t.web, 'carol', { key: 1 })
		const status = await localPoll(t, { expires_in: 300 })
		await t.post(bob, voteNote(bob, status.uri, 'dogs', 1))
		const [bobRow] = await sql<{ id: string }>(t.store, 'SELECT id FROM accounts WHERE uri = ?', bob.uri)
		await sql(t.store, 'DELETE FROM poll_votes')
		await sql(t.store, "UPDATE polls SET tallies = '[0,0]', votes_count = 0, voters_count = 0")
		await block(t.store, ALICE, bobRow!.id)
		await t.post(bob, voteNote(bob, status.uri, 'dogs', 2))
		await sql(t.store, "UPDATE polls SET expires_at = '2026-01-01T00:00:00.000Z'")
		await t.post(carol, voteNote(carol, status.uri, 'cats', 3))
		expect(await sql(t.store, 'SELECT votes_count FROM polls')).toEqual([{ votes_count: 0 }])
		expect((await statuses(t.store)).map((s) => s.uri)).toEqual([status.uri])
	})
})

describe('a local poll over ActivityPub', () => {
	it('is served and sent as a Question, its counts hidden while hide_totals hides them', async () => {
		const t = await setup()
		const status = await localStatus(t, {
			status: 'which?',
			poll: { options: ['cats', 'dogs'], expires_in: 3600, multiple: true, hide_totals: true },
		})
		const response = await t.request(new URL(status.uri).pathname, { headers: { accept: AP } })
		expect(response.status).toBe(200)
		const served = (await response.json()) as Record<string, unknown>
		expect(served).toMatchObject({
			type: 'Question',
			anyOf: [
				{ type: 'Note', name: 'cats', replies: { type: 'Collection' } },
				{ type: 'Note', name: 'dogs', replies: { type: 'Collection' } },
			],
			endTime: '2026-10-12T01:00:00.000Z',
			votersCount: 0,
		})
		expect(JSON.stringify(served)).not.toContain('totalItems')
		expect(served).not.toHaveProperty('closed')
	})
})
