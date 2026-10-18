import { describe, expect, it } from 'vitest'

import { sql } from './api-helpers'
import { NOW } from './app-helpers'
import { answer, bigStatus, expectByteCutWalk, walk } from './budget-helpers'
import { community, remoteAccount } from './status-helpers'

// RES-3: the conversation list is an id-cursor answer within ANSWER_BYTES, each conversation admitted whole with its
// participants and last status, cut pages continuing from their last admitted conversation's last status.

describe('conversations within ANSWER_BYTES (RES-3)', () => {
	it('walk every conversation once in both directions, each cut by bytes', async () => {
		const h = await community(['alice'])
		const { alice } = h.users
		const author = await remoteAccount(h.store, 'big')
		const conversations: string[] = []
		const lastStatus = new Map<string, string>()
		for (let i = 0; i < 20; i++) {
			const status = await bigStatus(h, author, NOW - (20 - i) * 60_000, {
				visibility: 'direct',
				mentions: [{ accountId: alice.id }],
			})
			const [row] = await sql<{ id: string }>(
				h.store,
				`INSERT INTO conversations (account_id, thread, participants, last_status_id, unread, stream_seq)
				VALUES (?, ?, ?, ?, 1, 0) RETURNING CAST(id AS TEXT) AS id`,
				alice.id,
				status,
				JSON.stringify([author]),
				status
			)
			conversations.push(row!.id)
			lastStatus.set(row!.id, status)
		}
		const newest = conversations.toReversed()
		const one = await answer<{ id: string; last_status: unknown }[]>(h, '/api/v1/conversations?limit=1', alice.token)
		expect(one.body[0]?.last_status).not.toBeNull()
		const size = one.bytes
		const cursorOf = (id: string) => lastStatus.get(id)!
		const path = '/api/v1/conversations?limit=20'
		expectByteCutWalk('older', await walk(h, path, 'next', alice.token), newest, 'next', size, cursorOf)
		const up = await walk(h, `${path}&min_id=0`, 'prev', alice.token)
		expectByteCutWalk('newer', up, conversations, 'prev', size, cursorOf)
	}, 300_000)
})
