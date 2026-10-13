import { strict as assert } from 'node:assert/strict'

import { createTestUser, makeDB, makeDOCache } from '@wildebeest/backend/test/utils'
import type { InboxMessageBody, MessageBody } from '@wildebeest/backend/types'

import { legacyInboxMessage } from '../../kopje/src/federation/legacy-inbox'
import consumer, { Env } from '../src'

// The legacy side of a Kopje cutover rollback (packages/kopje/docs/cutover-runbook.md): the requests Kopje accepted
// during the cutover window reach this consumer as inbox messages built by Kopje's own function, before anything newer,
// so a later Undo or Delete applies on top of them. Kopje's side (verification, order, nothing left to replay) is in
// packages/kopje/test/cutover-rollback.test.ts.

const domain = 'cloudflare.com'
const userKEK = 'test_kek_rollback'
const remote = 'https://example.com/users/carol'

function mockRemote() {
	globalThis.fetch = async (input) => {
		const request = new Request(input)
		if (request.url === remote) {
			return Response.json({
				id: remote,
				type: 'Person',
				preferredUsername: 'carol',
				inbox: 'https://example.com/inbox',
				outbox: 'https://example.com/outbox',
				following: 'https://example.com/following',
				followers: 'https://example.com/followers',
			})
		}
		if (request.url === 'https://example.com/inbox' && request.method === 'POST') {
			return new Response('', { status: 202 })
		}
		throw new Error('unexpected request to ' + request.url)
	}
}

function env(db: ReturnType<typeof makeDB>) {
	return {
		DATABASE: db,
		DOMAIN: domain,
		ADMIN_EMAIL: 'admin@cloudflare.com',
		DO_CACHE: makeDOCache(),
		SENTRY_DSN: '',
		SENTRY_ACCESS_CLIENT_ID: '',
		SENTRY_ACCESS_CLIENT_SECRET: '',
	} as unknown as Env
}

async function consume(db: ReturnType<typeof makeDB>, recipient: string, activity: Record<string, unknown>) {
	const body = legacyInboxMessage({ activity, recipient, signer: remote, userKek: userKEK, vapidKeys: {} })
	const message = {
		id: crypto.randomUUID(),
		timestamp: new Date(),
		attempts: 1,
		body: body as unknown as InboxMessageBody,
		ack: vi.fn(),
		retry: vi.fn(),
	}
	const batch = { queue: 'legacy', messages: [message], ackAll: vi.fn(), retryAll: vi.fn() }
	await consumer.queue(batch as unknown as MessageBatch<MessageBody>, env(db), {} as ExecutionContext)
	assert.equal(message.ack.mock.calls.length, 1)
	assert.equal(message.retry.mock.calls.length, 0)
}

describe('a cutover rollback drain into the legacy consumer', () => {
	beforeEach(mockRemote)

	test('a drained Follow is a relationship, and a later Undo removes it', async () => {
		const db = makeDB()
		const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const follow = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `${remote}#follows/1`,
			type: 'Follow',
			actor: remote,
			object: local.id.toString(),
		}
		await consume(db, local.id.toString(), follow)
		const followers = () =>
			db
				.prepare('SELECT count(*) AS n FROM actor_following WHERE actor_id = ? AND target_actor_id = ?')
				.bind(remote, local.id.toString())
				.first<{ n: number }>()
		assert.equal((await followers())?.n, 1)

		await consume(db, local.id.toString(), {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `${remote}#follows/1/undo`,
			type: 'Undo',
			actor: remote,
			object: follow,
		})
		assert.equal((await followers())?.n, 0)
	})

	test('a drained Create is a status, and a later Delete removes it', async () => {
		const db = makeDB()
		const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
		const note = `${remote}/statuses/1`
		await consume(db, local.id.toString(), {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `${note}/activity`,
			type: 'Create',
			actor: remote,
			to: ['https://www.w3.org/ns/activitystreams#Public'],
			cc: [local.id.toString()],
			object: {
				id: note,
				type: 'Note',
				attributedTo: remote,
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				cc: [local.id.toString()],
				content: '<p>hello</p>',
				attachment: [],
				published: '2026-10-12T00:00:00Z',
			},
		})
		const stored = () =>
			db.prepare('SELECT count(*) AS n FROM objects WHERE original_object_id = ?').bind(note).first<{ n: number }>()
		assert.equal((await stored())?.n, 1)

		await consume(db, local.id.toString(), {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: `${note}#delete`,
			type: 'Delete',
			actor: remote,
			object: { id: note, type: 'Tombstone' },
		})
		assert.equal((await stored())?.n, 0)
	})
})
