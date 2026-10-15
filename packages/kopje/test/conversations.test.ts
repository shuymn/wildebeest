import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { type ApiHarness, bearer, json, sql } from './api-helpers'
import { mastodonActor, type TestActor } from './inbox-helpers'
import {
	accountId,
	ALICE_URI,
	AS,
	create,
	localStatus,
	mastodonNote,
	remove,
	type Setup,
	setup,
	statusRow,
} from './inbox-status-helpers'
import {
	act,
	community,
	getJson,
	mute,
	post,
	remoteAccount,
	seedStatus,
	type Status,
	type User,
} from './status-helpers'
import { addToConversation } from '../src/domain/conversations'
import { writeOperation } from '../src/domain/operation'

// Conversations through the API (domain/conversations.ts, mastodon/conversations.ts), as Mastodon 4.5 has them: the
// rows the write paths make (AccountConversation.add_status), what deletes and blocks take away
// (AccountConversation.remove_status, AfterBlockService), the list with its pages, and read, unread and delete.

const add = writeOperation<{ owner: string; id: string }, void>((db, { owner, id }) => addToConversation(db, owner, id))

// A direct status of a remote account to `to`, stored with its parent (a status stored, or a uri only) and added to the
// recipient's conversation as a notified mention adds it.
async function remoteDirect(
	h: ApiHarness,
	author: string,
	to: string,
	parent: { id?: string; uri?: string } = {},
	uri?: string
): Promise<string> {
	const id = String(
		BigInt((await sql<{ n: number }>(h.store, 'SELECT count(*) AS n FROM statuses'))[0]?.n ?? 0) + 300000000000000000n
	)
	await sql(
		h.store,
		`INSERT INTO statuses (id, uri, account_id, in_reply_to_id, in_reply_to_uri, visibility, content, published_at)
		VALUES (?, ?, ?, ?, ?, 'direct', '<p>hi</p>', '2026-10-01T00:00:00.000Z')`,
		id,
		uri ?? `https://remote.example/objects/${id}`,
		author,
		parent.id ?? null,
		parent.uri ?? null
	)
	await sql(h.store, 'INSERT INTO status_mentions (status_id, account_id) VALUES (?, ?)', id, to)
	await runInDurableObject(h.store, (_instance, state) => add.run(state.storage.sql, { owner: to, id }))
	return id
}

type Conversation = { id: string; unread: boolean; accounts: { id: string }[]; last_status: Status | null }

async function list(h: ApiHarness, user: User, query = ''): Promise<Conversation[]> {
	const { status, body } = await getJson<Conversation[]>(h, `/api/v1/conversations${query}`, user.token)
	expect(status).toBe(200)
	return body
}

// Each conversation as [accounts, last status, unread].
async function summary(h: ApiHarness, user: User): Promise<[string[], string | null, boolean][]> {
	return (await list(h, user)).map((c) => [c.accounts.map((a) => a.id), c.last_status?.id ?? null, c.unread])
}

function send(h: ApiHarness, user: User, method: string, path: string) {
	return h.request(path, bearer(user.token, json({}, { method })))
}

async function direct(h: ApiHarness, user: User, text: string, inReplyTo?: string): Promise<Status> {
	return post(h, user, {
		status: text,
		visibility: 'direct',
		...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }),
	})
}

describe('conversations', () => {
	it('lists a direct exchange for each participant, as REST::ConversationSerializer shows it', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const first = await direct(h, alice, '@bob hello')

		const [mine] = await list(h, alice)
		expect(Object.keys(mine ?? {})).toEqual(['id', 'unread', 'accounts', 'last_status'])
		expect(mine).toMatchObject({ id: expect.stringMatching(/^\d+$/), unread: false, accounts: [{ id: bob.id }] })
		expect(mine?.last_status).toMatchObject({ id: first.id, visibility: 'direct' })
		// The recipient's is unread, and names the author.
		expect(await summary(h, bob)).toEqual([[[alice.id], first.id, true]])

		// A reply in the thread: the same conversations, now ending with it; the author's own status reads it.
		const reply = await direct(h, bob, '@alice hi', first.id)
		expect(await summary(h, bob)).toEqual([[[alice.id], reply.id, false]])
		expect(await summary(h, alice)).toEqual([[[bob.id], reply.id, true]])
		expect((await list(h, alice))[0]?.id).toBe(mine?.id)
	})

	it('keeps threads and participants apart, and leaves out what is not a direct status', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		const one = await direct(h, alice, '@bob one')
		const two = await direct(h, alice, '@bob two')
		const both = await direct(h, alice, '@bob @carol both', one.id)
		for (const visibility of ['public', 'unlisted', 'private']) {
			await post(h, alice, { status: `@bob ${visibility}`, visibility })
		}
		const sorted = (ids: string[]) => ids.toSorted()
		expect((await summary(h, alice)).map(([accounts, last]) => [sorted(accounts), last])).toEqual([
			[sorted([bob.id, carol.id]), both.id],
			[[bob.id], two.id],
			[[bob.id], one.id],
		])
		expect((await summary(h, carol)).map(([accounts, last]) => [sorted(accounts), last])).toEqual([
			[sorted([alice.id, bob.id]), both.id],
		])
		// A direct status to nobody else lists the owner.
		const alone = await direct(h, carol, 'note to self')
		expect((await list(h, carol))[0]).toMatchObject({ accounts: [{ id: carol.id }], last_status: { id: alone.id } })
	})

	it('marks read and unread, deletes, and answers 404 for a conversation that is not the viewer’s', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await direct(h, alice, '@bob hello')
		const [theirs] = await list(h, bob)
		const id = theirs?.id ?? ''

		const read = await send(h, bob, 'POST', `/api/v1/conversations/${id}/read`)
		expect([read.status, ((await read.json()) as Conversation).unread]).toEqual([200, false])
		expect((await list(h, bob))[0]?.unread).toBe(false)
		const unread = await send(h, bob, 'POST', `/api/v1/conversations/${id}/unread`)
		expect(await unread.json()).toEqual({ ...theirs, unread: true })

		const [mine] = await list(h, alice)
		for (const [method, path] of [
			['POST', `/api/v1/conversations/${mine?.id}/read`],
			['POST', `/api/v1/conversations/${mine?.id}/unread`],
			['DELETE', `/api/v1/conversations/${mine?.id}`],
			['DELETE', '/api/v1/conversations/999999'],
			['POST', '/api/v1/conversations/x/read'],
		] as const) {
			const response = await send(h, bob, method, path)
			expect([method, path, response.status, await response.json()]).toEqual([
				method,
				path,
				404,
				{ error: 'Record not found' },
			])
		}
		expect((await list(h, alice))[0]).toEqual(mine)

		const deleted = await send(h, bob, 'DELETE', `/api/v1/conversations/${id}`)
		expect([deleted.status, await deleted.json()]).toEqual([200, {}])
		expect(await list(h, bob)).toEqual([])
		// The statuses stay, and a later one makes a new conversation.
		expect(await list(h, alice)).toEqual([mine])
		const again = await direct(h, alice, '@bob again', mine?.last_status?.id)
		const [renewed] = await list(h, bob)
		expect(renewed).toMatchObject({ unread: true, last_status: { id: again.id } })
		expect(renewed?.id).not.toBe(id)
	})

	it('moves the last status back when it is deleted, and drops a conversation with none left', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const first = await direct(h, alice, '@bob one')
		const second = await direct(h, bob, '@alice two', first.id)
		expect(await send(h, bob, 'DELETE', `/api/v1/statuses/${second.id}`).then((r) => r.status)).toBe(200)
		expect(await summary(h, alice)).toEqual([[[bob.id], first.id, true]])
		expect(await summary(h, bob)).toEqual([[[alice.id], first.id, false]])
		await send(h, alice, 'DELETE', `/api/v1/statuses/${first.id}`)
		expect(await list(h, alice)).toEqual([])
		expect(await list(h, bob)).toEqual([])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM conversation_statuses')).toEqual([{ n: 0 }])
	})

	it('keeps a thread together when a status of it is deleted, and groups replies to a status never stored', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const first = await direct(h, alice, '@bob one')
		const second = await direct(h, bob, '@alice two', first.id)
		await send(h, alice, 'DELETE', `/api/v1/statuses/${first.id}`)
		const third = await direct(h, alice, '@bob three', second.id)
		expect(await summary(h, alice)).toEqual([[[bob.id], third.id, false]])

		// Replies to a status never stored share its thread; a reply to another one does not.
		const erin = await remoteAccount(h.store, 'erin')
		const a = await remoteDirect(h, erin, bob.id, { uri: 'https://remote.example/objects/never-stored' })
		const b = await remoteDirect(h, erin, bob.id, { uri: 'https://remote.example/objects/never-stored' })
		const c = await remoteDirect(h, erin, bob.id, { uri: 'https://remote.example/objects/another' })
		expect((await summary(h, bob)).slice(0, 2)).toEqual([
			[[erin], c, true],
			[[erin], b, true],
		])
		expect(
			await sql(h.store, 'SELECT thread FROM conversations WHERE last_status_id IN (?, ?) ORDER BY thread', b, c)
		).toEqual([
			{ thread: 'https://remote.example/objects/another' },
			{ thread: 'https://remote.example/objects/never-stored' },
		])
		expect(await sql(h.store, 'SELECT count(*) AS n FROM conversation_statuses WHERE status_id = ?', a)).toEqual([
			{ n: 1 },
		])
	})

	it('keeps each status’s thread when a status above it or its conversation is deleted', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		// A public status and a public reply; Alice writes to Bob under the reply, and to Bob and Carol under the first.
		const p = await post(h, alice, { status: 'p', visibility: 'public' })
		const q = await post(h, alice, { status: 'q', visibility: 'public', in_reply_to_id: p.id })
		const d = await direct(h, alice, '@bob d', q.id)
		const g = await direct(h, alice, '@bob @carol g', p.id)
		const threads = () => sql<{ id: string; thread: string }>(h.store, 'SELECT id, thread FROM statuses ORDER BY id')
		const pUri = (await sql<{ uri: string }>(h.store, 'SELECT uri FROM statuses WHERE id = ?', p.id))[0]?.uri
		expect((await threads()).map((row) => row.thread)).toEqual([pUri, pUri, pUri, pUri])

		// Q goes, then Alice's conversation holding D: D keeps its thread, so a reply to it joins G's conversation.
		await send(h, alice, 'DELETE', `/api/v1/statuses/${q.id}`)
		const [withBob] = (await list(h, alice)).filter((c) => c.last_status?.id === d.id)
		await send(h, alice, 'DELETE', `/api/v1/conversations/${withBob?.id}`)
		expect(await threads()).toEqual([
			{ id: p.id, thread: pUri },
			{ id: d.id, thread: pUri },
			{ id: g.id, thread: pUri },
		])
		const r = await direct(h, alice, '@bob @carol r', d.id)
		expect((await summary(h, alice)).map(([accounts, last]) => [accounts.toSorted(), last])).toEqual([
			[[bob.id, carol.id].toSorted(), r.id],
		])
		expect((await summary(h, carol)).map(([, last]) => last)).toEqual([r.id])
	})

	it('keeps a reply cycle in one thread: each status keeps the thread it was stored with', async () => {
		const h = await community(['bob'])
		const { bob } = h.users
		const erin = await remoteAccount(h.store, 'erin')
		// A replies to B before B is stored; B arrives replying to A; then A is linked to B.
		const a = await remoteDirect(
			h,
			erin,
			bob.id,
			{ uri: 'https://remote.example/objects/b' },
			'https://remote.example/objects/a'
		)
		const b = await remoteDirect(
			h,
			erin,
			bob.id,
			{ id: a, uri: 'https://remote.example/objects/a' },
			'https://remote.example/objects/b'
		)
		await sql(h.store, 'UPDATE statuses SET in_reply_to_id = ? WHERE id = ?', b, a)
		expect(await sql(h.store, 'SELECT DISTINCT thread FROM statuses')).toEqual([
			{ thread: 'https://remote.example/objects/b' },
		])
		expect(await summary(h, bob)).toEqual([[[erin], b, true]])
		const c = await remoteDirect(h, erin, bob.id, { id: a, uri: 'https://remote.example/objects/a' })
		expect(await summary(h, bob)).toEqual([[[erin], c, true]])
	})

	it('adds nothing from an account the recipient blocks or mutes with notifications, as no mention is notified', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		await act(h, bob, `/api/v1/accounts/${alice.id}/block`)
		await mute(h.store, carol.id, alice.id)
		await direct(h, alice, '@carol hi')
		expect(await list(h, carol)).toEqual([])
		// A mute without notifications lets the mention through.
		await sql(h.store, 'UPDATE mutes SET hide_notifications = 0')
		const later = await direct(h, alice, '@carol again')
		expect(await summary(h, carol)).toEqual([[[alice.id], later.id, true]])
	})

	it('ends the blocker’s conversations with the blocked account, and keeps the other side’s', async () => {
		const h = await community(['alice', 'bob', 'carol'])
		const { alice, bob, carol } = h.users
		const withBob = await direct(h, alice, '@bob hi')
		const withBoth = await direct(h, alice, '@bob @carol hi')
		const withCarol = await direct(h, alice, '@carol hi')
		expect(await act(h, alice, `/api/v1/accounts/${bob.id}/block`).then((r) => r.status)).toBe(200)
		expect((await summary(h, alice)).map(([, last]) => last)).toEqual([withCarol.id])
		// Bob keeps his, but no longer sees the statuses of an author who blocks him (R2).
		expect(
			await sql(h.store, 'SELECT last_status_id FROM conversations WHERE account_id = ? ORDER BY 1 DESC', bob.id)
		).toEqual([{ last_status_id: withBoth.id }, { last_status_id: withBob.id }])
		expect(await summary(h, bob)).toEqual([
			[[alice.id, carol.id].toSorted(), null, true],
			[[alice.id], null, true],
		])
	})

	it('shows a last status its owner may no longer see as null', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		await direct(h, alice, '@bob hi')
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?', '2026-01-01', alice.id)
		const [theirs] = await list(h, bob)
		expect(theirs).toMatchObject({ unread: true, last_status: null, accounts: [{ id: alice.id, suspended: true }] })
	})

	it('pages by the last status, 20 by default and at most 40, with Link headers', async () => {
		const h = await community(['alice', 'bob'])
		const { alice, bob } = h.users
		const statuses: string[] = []
		for (let i = 0; i < 45; i++) {
			const id = await seedStatus(h.store, {
				accountId: alice.id,
				visibility: 'direct',
				mentions: [{ accountId: bob.id }],
				published: Date.parse('2026-10-01T00:00:00Z') + i * 1000,
			})
			statuses.push(id)
		}
		await sql(
			h.store,
			`INSERT INTO conversations (account_id, thread, participants, last_status_id)
			SELECT ?1, uri, json_array(?2), id FROM statuses WHERE account_id = ?1`,
			alice.id,
			bob.id
		)
		await sql(
			h.store,
			`INSERT INTO conversation_statuses (conversation_id, status_id)
			SELECT id, last_status_id FROM conversations`
		)
		const newestFirst = statuses.toReversed()
		const first = await h.request('/api/v1/conversations', bearer(alice.token))
		const page = (await first.json()) as Conversation[]
		expect(page.map((c) => c.last_status?.id)).toEqual(newestFirst.slice(0, 20))
		expect(first.headers.get('link')).toBe(
			`<https://kopje.test/api/v1/conversations?max_id=${newestFirst[19]}>; rel="next", ` +
				`<https://kopje.test/api/v1/conversations?min_id=${newestFirst[0]}>; rel="prev"`
		)
		expect((await list(h, alice, '?limit=100')).length).toBe(40)
		expect((await list(h, alice, `?max_id=${newestFirst[19]}`)).map((c) => c.last_status?.id)).toEqual(
			newestFirst.slice(20, 40)
		)
		expect((await list(h, alice, `?min_id=${newestFirst[10]}&limit=3`)).map((c) => c.last_status?.id)).toEqual(
			newestFirst.slice(7, 10)
		)
		expect((await list(h, alice, `?since_id=${newestFirst[10]}&limit=3`)).map((c) => c.last_status?.id)).toEqual(
			newestFirst.slice(0, 3)
		)
	})

	it('answers only a token with read:statuses, and writes only with write:conversations', async () => {
		const h = await community(['alice'], 'read:accounts write:statuses')
		const { alice } = h.users
		expect((await h.request('/api/v1/conversations', bearer(alice.token))).status).toBe(403)
		expect((await send(h, alice, 'DELETE', '/api/v1/conversations/1')).status).toBe(403)
		expect((await h.request('/api/v1/conversations')).status).toBe(401)
	})
})

describe('conversations of inbound statuses', () => {
	const toAlice = (bob: TestActor, extra: Record<string, unknown> = {}) =>
		mastodonNote(bob, {
			to: [ALICE_URI],
			cc: [],
			tag: [{ type: 'Mention', href: ALICE_URI, name: '@alice' }],
			...extra,
		})
	const rows = (t: Setup) =>
		t
			.api<Conversation[]>('/api/v1/conversations')
			.then(({ body }) => body.map((c) => [c.accounts.map((a) => a.id), c.last_status?.uri ?? null, c.unread]))

	it('adds an inbound direct status for its local recipient, and a reply of hers to the same conversation', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const note = toAlice(bob)
		expect(await t.post(bob, create(bob, note))).toBe(202)
		const bobId = await accountId(t.store, bob.uri)
		expect(await rows(t)).toEqual([[[bobId], note.id, true]])
		const reply = await localStatus(t, {
			status: '@bob@mastodon.example hi',
			visibility: 'direct',
			in_reply_to_id: (await statusRow(t.store, note.id))?.id,
		})
		expect(await rows(t)).toEqual([[[bobId], reply.uri, false]])
		// A limited status (Misskey's specified, a silent recipient) is not a direct message.
		await t.post(bob, create(bob, mastodonNote(bob, { to: [ALICE_URI], cc: [] })))
		expect(await rows(t)).toEqual([[[bobId], reply.uri, false]])
	})

	it('takes a status out when its author deletes it, and every status of an actor whose purge runs', async () => {
		const t = await setup()
		const bob = await mastodonActor(t.web, 'bob')
		const first = toAlice(bob)
		const second = toAlice(bob, { published: '2026-10-11T12:01:00Z' })
		await t.post(bob, create(bob, first))
		await t.post(bob, create(bob, second))
		const bobId = await accountId(t.store, bob.uri)
		expect(await rows(t)).toEqual([
			[[bobId], second.id, true],
			[[bobId], first.id, true],
		])
		expect(await t.post(bob, remove(bob, second.id))).toBe(202)
		expect(await rows(t)).toEqual([[[bobId], first.id, true]])

		t.web.fail(bob.uri, 410)
		const deletion = { '@context': AS, id: `${bob.uri}#delete`, type: 'Delete', actor: bob.uri, object: bob.uri }
		expect(await t.post(bob, deletion)).toBe(202)
		expect(await rows(t)).toEqual([])
		expect(await sql(t.store, 'SELECT count(*) AS n FROM conversations')).toEqual([{ n: 0 }])
	})
})
