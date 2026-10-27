import { describe, expect, it } from 'vitest'

import { login, registerApp, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { bigStatus, hugeStatus, maximalAccounts, ORIGIN } from './budget-helpers'
import { BUILD } from './helpers'
import { community, remoteAccount } from './status-helpers'
import { ANSWER_BYTES, jsonBytes } from '../src/domain/answer-budget'
import { sha256Hex } from '../src/security/tokens'

// RES-3: a maximal answer of each family with an answer budget, returned through the real Store RPC (32 MiB a return),
// is within ANSWER_BYTES: plain and grouped notifications, conversations, admin reports and the directory.

describe('the Store RPC returns a maximal answer of each family (RES-3)', () => {
	it('returns notifications, groups, conversations, reports and the directory at the budget', async () => {
		const h = await community(['owner', 'alice'])
		const { alice } = h.users
		await setSetting(h.store, 'admin_email', 'owner@example.com')
		const scope = 'read write admin:read admin:write'
		const admin = (await login(h, { app: await registerApp(h, { scopes: scope }), scope, email: 'owner@example.com' }))
			.token
		const author = await remoteAccount(h.store, 'big')
		for (let i = 0; i < 20; i++) {
			const status = await bigStatus(h, author, NOW - (20 - i) * 60_000)
			await sql(
				h.store,
				`INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at)
				VALUES (?, 'mention', ?, ?, ?)`,
				alice.id,
				author,
				status,
				new Date(NOW).toISOString()
			)
			await sql(
				h.store,
				`INSERT INTO conversations (account_id, thread, participants, last_status_id, unread, stream_seq)
				VALUES (?, ?, ?, ?, 1, 0)`,
				alice.id,
				status,
				JSON.stringify([author]),
				status
			)
		}
		const listed = await maximalAccounts(h, 'listed', 80)
		await sql(
			h.store,
			'UPDATE accounts SET discoverable = 1 WHERE id IN (SELECT value FROM json_each(?))',
			JSON.stringify(listed)
		)
		const huge = await hugeStatus(h, author, NOW - 3_600_000)
		await sql(
			h.store,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
			INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at)
			SELECT ?1, ?2, ?3, 'https://kopje.test/actor#reports/' || i, ?4 FROM n`,
			alice.id,
			author,
			JSON.stringify([huge]),
			new Date(NOW).toISOString()
		)
		const as = async (token: string, granted: string) => ({
			tokenHash: await sha256Hex(token),
			scope: granted,
			now: NOW,
		})
		const present = { origin: ORIGIN }
		const page = { limit: 40 }
		const notifications = { types: [], excludeTypes: [], includeFiltered: false, present, page }
		const answers = {
			notifications: await h.store.listNotifications(BUILD, {
				...notifications,
				credential: await as(alice.token, 'read:notifications'),
				accountId: null,
			} as never),
			groups: await h.store.listGroupedNotifications(BUILD, {
				...notifications,
				credential: await as(alice.token, 'read:notifications'),
				groupedTypes: null,
				expandAccounts: 'full',
			} as never),
			conversations: await h.store.listConversations(BUILD, {
				credential: await as(alice.token, 'read:statuses'),
				page,
				present,
			} as never),
			reports: await h.store.adminReports(BUILD, {
				credential: await as(admin, 'admin:read:reports'),
				filter: { resolved: false, accountId: null, targetAccountId: null },
				page: { limit: 100 },
				present,
			} as never),
			directory: await h.store.directory(BUILD, {
				credential: await as(alice.token, 'read'),
				order: 'new',
				local: false,
				offset: 0,
				limit: 80,
				present,
			} as never),
		}
		const sizes = Object.fromEntries(Object.entries(answers).map(([name, value]) => [name, jsonBytes(value)]))
		for (const [name, size] of Object.entries(sizes)) {
			expect([name, size > ANSWER_BYTES - 2_600_000 && size <= ANSWER_BYTES + 1_000]).toEqual([name, true])
		}
		console.info(`Store RPC answers (JSON bytes): ${JSON.stringify(sizes)}`)
	}, 600_000)
})
