import { strict as assert } from 'node:assert/strict'

import { createTestUser, makeDB, makeDOCache } from '@wildebeest/backend/test/utils'
import type { InboxMessageBody, MessageBody } from '@wildebeest/backend/types'

import { legacyInboxMessage, legacyRecipient } from '../../kopje/src/federation/legacy-inbox'
import consumer, { Env } from '../src'

// The legacy side of a Kopje cutover rollback (packages/kopje/docs/cutover-runbook.md): the requests Kopje accepted
// during the cutover window reach this consumer as inbox messages built by Kopje's own function, before anything newer,
// so a later Undo or Delete applies on top of them. Kopje's side (verification, order, nothing left to replay) is in
// packages/kopje/test/cutover-rollback.test.ts.

const domain = 'cloudflare.com'
const userKEK = 'test_kek_rollback'
const remote = 'https://example.com/users/carol'

let acceptFails = false

function mockRemote() {
	acceptFails = false
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
			return new Response('', { status: acceptFails ? 503 : 202 })
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

async function consume(
	db: ReturnType<typeof makeDB>,
	recipient: string,
	activity: Record<string, unknown>,
	outcome: 'ack' | 'retry' = 'ack'
) {
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
	assert.equal(message.ack.mock.calls.length, outcome === 'ack' ? 1 : 0)
	assert.equal(message.retry.mock.calls.length, outcome === 'retry' ? 1 : 0)
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

	// The ordered lane sends the Undo only once the Follow is acknowledged: a Follow whose Accept failed is retried
	// first, and the Undo then applies on top of it.
	test('a Follow retried after a failed Accept, then its Undo, leaves no relationship', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		try {
			const db = makeDB()
			const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const follow = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `${remote}#follows/2`,
				type: 'Follow',
				actor: remote,
				object: local.id.toString(),
			}
			acceptFails = true
			await consume(db, local.id.toString(), follow, 'retry')
			acceptFails = false
			await consume(db, local.id.toString(), follow)
			await consume(db, local.id.toString(), {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `${remote}#follows/2/undo`,
				type: 'Undo',
				actor: remote,
				object: follow,
			})
			const row = await db
				.prepare('SELECT count(*) AS n FROM actor_following WHERE actor_id = ? AND target_actor_id = ?')
				.bind(remote, local.id.toString())
				.first<{ n: number }>()
			assert.equal(row?.n, 0)
		} finally {
			consoleError.mockRestore()
		}
	})

	// Legacy acknowledges a message whose recipient does not exist without applying it, so the drain chooses only among
	// the legacy accounts.
	test('a shared-inbox Create to a missing account and an existing one reaches the existing one', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		try {
			const db = makeDB()
			const local = await createTestUser(domain, db, userKEK, 'sven@cloudflare.com')
			const ghost = `https://${domain}/ap/users/ghost`
			const note = `${remote}/statuses/2`
			const create = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `${note}/activity`,
				type: 'Create',
				actor: remote,
				to: [ghost, local.id.toString()],
				cc: [],
				object: {
					id: note,
					type: 'Note',
					attributedTo: remote,
					to: [ghost, local.id.toString()],
					cc: [],
					content: '<p>hello</p>',
					attachment: [],
					published: '2026-10-12T00:00:00Z',
				},
			}
			const accounts = new Set(['sven'])
			const stored = () =>
				db.prepare('SELECT count(*) AS n FROM objects WHERE original_object_id = ?').bind(note).first<{ n: number }>()

			// The missing account as the recipient: legacy drops the message unapplied.
			await consume(db, ghost, create)
			assert.equal((await stored())?.n, 0)

			// The drain's choice: the existing account; a missing fallback is never chosen.
			assert.equal(legacyRecipient('/inbox', create, domain, accounts, 'ghost'), local.id.toString())
			assert.equal(legacyRecipient('/inbox', { ...create, to: [ghost], object: {} }, domain, accounts, 'ghost'), null)
			await consume(db, local.id.toString(), create)
			assert.equal((await stored())?.n, 1)
		} finally {
			consoleWarn.mockRestore()
		}
	})
})
