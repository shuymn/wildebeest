import { describe, expect, it } from 'vitest'

import { apiHarness, bearer, json, seedAccount, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { appToken, remoteAccounts, rowsRead, scopedToken } from './read-helpers'
import { block, community, follow, getJson, mute, remoteFollows } from './status-helpers'
import {
	FAMILIAR_FOLLOWERS_WINDOW,
	familiarFollowers,
	MAX_FAMILIAR_FOLLOWERS,
	MAX_FAMILIAR_FOLLOWERS_IDS,
} from '../src/domain/accounts'
import { sha256Hex } from '../src/security/tokens'

// GET /api/v1/preferences and /api/v1/accounts/familiar_followers: shapes, scopes (AUTH-2), accepted follows only
// (VIS-8), and bounds (RES-3, RES-7).

describe('preferences', () => {
	it('shows the posting defaults and Mastodon’s reading defaults', async () => {
		const h = await community(['alice'])
		const { token } = h.users.alice
		expect(await getJson(h, '/api/v1/preferences', token)).toEqual({
			status: 200,
			body: {
				'posting:default:visibility': 'public',
				'posting:default:sensitive': false,
				'posting:default:language': null,
				'reading:expand:media': 'default',
				'reading:expand:spoilers': false,
			},
		})
		await h.request(
			'/api/v1/accounts/update_credentials',
			bearer(token, json({ source: { privacy: 'private', sensitive: true, language: 'ja' } }, { method: 'PATCH' }))
		)
		expect((await getJson(h, '/api/v1/preferences', token)).body).toMatchObject({
			'posting:default:visibility': 'private',
			'posting:default:sensitive': true,
			'posting:default:language': 'ja',
		})
	})

	it('needs read:accounts and a user (AUTH-2)', async () => {
		const h = await apiHarness()
		await seedAccount(h.store, { username: 'alice', email: 'alice@example.com' })
		expect((await h.request('/api/v1/preferences')).status).toBe(401)
		expect((await h.request('/api/v1/preferences', bearer('nope'))).status).toBe(401)
		expect((await h.request('/api/v1/preferences', bearer(await scopedToken(h, 'read:statuses')))).status).toBe(403)
		expect((await h.request('/api/v1/preferences', bearer(await scopedToken(h, 'read:accounts')))).status).toBe(200)
		expect((await h.request('/api/v1/preferences', bearer(await appToken(h)))).status).toBe(422)
	})
})

describe('familiar followers', () => {
	async function fixture() {
		const h = await community(['alice', 'bob', 'carol', 'dave'])
		const { alice, bob, carol, dave } = h.users
		const remote = await seedAccount(h.store, { username: 'erin', domain: 'remote.example' })
		// alice follows bob, carol and dave; bob, carol and dave follow erin; only bob and dave follow carol.
		for (const target of [bob.id, carol.id, dave.id]) {
			await follow(h, alice, target)
		}
		for (const follower of [bob.id, carol.id, dave.id]) {
			await remoteFollows(h.store, follower, remote)
		}
		await follow(h, bob, carol.id)
		await follow(h, dave, carol.id)
		return { h, remote }
	}

	const path = (...ids: string[]) =>
		`/api/v1/accounts/familiar_followers?${ids.map((id) => `id[]=${encodeURIComponent(id)}`).join('&')}`

	it('lists, for each account, the accounts the viewer follows that follow it', async () => {
		const { h, remote } = await fixture()
		const { alice, bob, carol, dave } = h.users
		const { status, body } = await getJson<{ id: string; accounts: { id: string; acct: string }[] }[]>(
			h,
			path(remote, carol.id, 'unknown', remote),
			alice.token
		)
		expect(status).toBe(200)
		expect(body.map((entry) => ({ id: entry.id, accounts: entry.accounts.map((account) => account.id) }))).toEqual([
			{ id: remote, accounts: [dave.id, carol.id, bob.id] },
			{ id: carol.id, accounts: [dave.id, bob.id] },
		])
		// Full Account entities.
		expect(body[1]?.accounts[0]).toMatchObject({ id: dave.id, acct: 'dave', url: 'https://kopje.test/@dave' })
	})

	it('counts accepted follows only (VIS-8)', async () => {
		const { h, remote } = await fixture()
		const { alice, bob, carol } = h.users
		await sql(
			h.store,
			"UPDATE follows SET state = 'pending' WHERE account_id = ? AND target_account_id = ?",
			bob.id,
			remote
		)
		await sql(
			h.store,
			"UPDATE follows SET state = 'pending' WHERE account_id = ? AND target_account_id = ?",
			alice.id,
			carol.id
		)
		const { body } = await getJson<{ accounts: { id: string }[] }[]>(h, path(remote), alice.token)
		expect(body[0]?.accounts.map((account) => account.id)).toEqual([h.users.dave.id])
	})

	it('leaves out accounts the viewer blocks or mutes, suspended followers and suspended accounts', async () => {
		const { h, remote } = await fixture()
		const { alice, bob, carol, dave } = h.users
		await block(h.store, alice.id, bob.id)
		await mute(h.store, alice.id, carol.id)
		const filtered = await getJson<{ accounts: { id: string }[] }[]>(h, path(remote), alice.token)
		expect(filtered.body[0]?.accounts.map((account) => account.id)).toEqual([dave.id])

		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?', '2026-01-01', dave.id)
		expect((await getJson<{ accounts: unknown[] }[]>(h, path(remote), alice.token)).body).toEqual([
			{ id: remote, accounts: [] },
		])
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?', '2026-01-01', carol.id)
		expect((await getJson(h, path(carol.id), alice.token)).body).toEqual([])
	})

	it('needs read:follows and a user (AUTH-2)', async () => {
		const { h, remote } = await fixture()
		expect((await h.request(path(remote))).status).toBe(401)
		expect((await h.request(path(remote), bearer(await scopedToken(h, 'read:accounts')))).status).toBe(403)
		expect((await h.request(path(remote), bearer(await scopedToken(h, 'read:follows')))).status).toBe(200)
		expect((await h.request(path(remote), bearer(await appToken(h)))).status).toBe(422)
	})

	it('bounds the ids, the followers read and the accounts shown (RES-3, RES-7)', async () => {
		// `count` remote accounts follow the target and are followed by alice, plus more accounts to ask about.
		const setup = async (count: number) => {
			const h = await community(['alice'])
			const { alice } = h.users
			await remoteAccounts(h, 1, count + MAX_FAMILIAR_FOLLOWERS_IDS + 6)
			const ids = (
				await sql<{ id: string }>(h.store, 'SELECT id FROM accounts WHERE domain IS NOT NULL ORDER BY id')
			).map((row) => row.id)
			const target = ids[0] ?? ''
			const followers = ids.slice(1, count + 1)
			await sql(
				h.store,
				"INSERT INTO follows (account_id, target_account_id, state) SELECT value, ?, 'accepted' FROM json_each(?)",
				target,
				JSON.stringify(followers)
			)
			await sql(
				h.store,
				"INSERT INTO follows (account_id, target_account_id, state) SELECT ?, value, 'accepted' FROM json_each(?)",
				alice.id,
				JSON.stringify(followers)
			)
			const read = await rowsRead(h, familiarFollowers, {
				credential: { tokenHash: await sha256Hex(alice.token), scope: 'read:follows', now: NOW },
				ids: [target],
				present: { origin: 'https://kopje.test' },
			})
			return { h, alice, ids, target, followers, read }
		}
		const { h, alice, ids, target, followers, read } = await setup(FAMILIAR_FOLLOWERS_WINDOW + 200)
		const { body } = await getJson<unknown[]>(h, path(...ids.slice(followers.length + 1)), alice.token)
		expect(body).toHaveLength(MAX_FAMILIAR_FOLLOWERS_IDS)
		const shown = await getJson<{ id: string; accounts: { id: string }[] }[]>(h, path(target), alice.token)
		// The newest follows first.
		expect(shown.body[0]?.accounts.map((account) => account.id)).toEqual(
			followers.slice(-MAX_FAMILIAR_FOLLOWERS).reverse()
		)
		// Twice the followers read about as many rows: only the window is read.
		const larger = await setup(FAMILIAR_FOLLOWERS_WINDOW * 2)
		expect(larger.read).toBeLessThan(read * 1.2)
	}, 120_000)
})
