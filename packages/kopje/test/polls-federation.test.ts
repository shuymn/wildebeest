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
import { block, outbound } from './status-helpers'
import type { Poll } from '../src/domain/polls'
import { endPolls } from '../src/jobs/scheduled'

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
