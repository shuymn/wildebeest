import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { seedAccount, setSetting, sql } from './api-helpers'
import { NOW } from './app-helpers'
import { community, getJson } from './status-helpers'
import { recordingSql } from './status-row-fixtures'
import { selectSql } from '../src/db/columns'
import { Db, RowMeter } from '../src/db/sql'
import { type Account, credentialAccount, presentAccountById } from '../src/domain/accounts'
import { adminAccountIdOnce, LOCAL_EMAIL_COLUMNS } from '../src/domain/admin-authority'
import { suspendLocal, unsuspendLocal } from '../src/domain/suspension'
import { ACTOR_URI_LIMIT } from '../src/platform/identity-bounds'

// Account#uri, #roles and #noindex as REST::AccountSerializer shows them (Mastodon v4.5.11): the actor id for every
// account, also an unavailable one (RES-2: '' past ACTOR_URI_LIMIT in UTF-8 bytes, raw or JSON-escaped); and, for a
// local account only, its highlighted role (the OAuth admin's Owner) and noindex false.

const OWNER = [{ id: '3', name: 'Owner', color: '' }]
const ORIGIN = 'https://kopje.test'
const utf8 = (value: string) => new TextEncoder().encode(value).length

async function fixture() {
	const h = await community(['alice', 'bob'])
	await setSetting(h.store, 'admin_email', 'alice@example.com')
	const remote = await seedAccount(h.store, { username: 'erin', domain: 'remote.example' })
	return { h, remote }
}

const account = async (h: Awaited<ReturnType<typeof fixture>>['h'], id: string) =>
	(await getJson<Account>(h, `/api/v1/accounts/${id}`, h.users.bob.token)).body

describe('uri', () => {
	it('is the actor id of a local and a remote account, also of a suspended one', async () => {
		const { h, remote } = await fixture()
		expect((await account(h, h.users.bob.id)).uri).toBe('https://kopje.test/ap/users/bob')
		expect((await account(h, remote)).uri).toBe('https://remote.example/users/erin')
		await sql(
			h.store,
			"UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE id = ?",
			remote
		)
		expect(await account(h, remote)).toMatchObject({ suspended: true, uri: 'https://remote.example/users/erin' })
	})

	// Imported rows: the actor id is never cut, so one past the bound reads as '' (RES-2).
	it("is '' past ACTOR_URI_LIMIT bytes, raw or once escaped, NUL and astral characters measured in UTF-8", async () => {
		const { h } = await fixture()
		const base = 'https://x.example/'
		// Each NUL escapes to \u0000 (6 bytes); each astral character is 4 bytes and is not escaped.
		const nul = (pad: number) => `${base}${'a'.repeat(pad)}\u0000`
		const astral = (extra: number) => `${base}${'𠀀'.repeat(507)}${'a'.repeat(extra)}`
		const control = `${base}${'\u0001'.repeat(ACTOR_URI_LIMIT - base.length)}`
		const cases: [string, boolean][] = [
			[nul(ACTOR_URI_LIMIT - base.length - 6), true],
			[nul(ACTOR_URI_LIMIT - base.length - 5), false],
			[astral(2), true],
			[astral(3), false],
			[control, false],
			[`${base}${'a'.repeat(ACTOR_URI_LIMIT - base.length + 1)}`, false],
		]
		expect(cases.map(([uri]) => [utf8(uri), utf8(JSON.stringify(uri)) - 2])).toEqual([
			[2043, 2048],
			[2044, 2049],
			[2048, 2048],
			[2049, 2049],
			[2048, 12_198],
			[2049, 2049],
		])
		for (const [i, [uri, shown]] of cases.entries()) {
			const id = await seedAccount(h.store, { username: `imported${i}`, domain: 'x.example' })
			await sql(h.store, 'UPDATE accounts SET uri = ? WHERE id = ?', uri, id)
			const presented = await account(h, id)
			expect(presented.uri, String(i)).toBe(shown ? uri : '')
			expect(presented.acct).toBe(`imported${i}@x.example`)
		}
	})
})

describe('roles and noindex', () => {
	it("show a local account's role and noindex false, and leave both out for a remote one", async () => {
		const { h, remote } = await fixture()
		const { alice, bob } = h.users
		expect(await account(h, alice.id)).toMatchObject({ roles: OWNER, noindex: false })
		expect(await account(h, bob.id)).toMatchObject({ roles: [], noindex: false })
		const other = await account(h, remote)
		expect('roles' in other || 'noindex' in other).toBe(false)
		// The credential account carries the same.
		for (const [user, roles] of [
			[alice, OWNER],
			[bob, []],
		] as const) {
			const { body } = await getJson<Account>(h, '/api/v1/accounts/verify_credentials', user.token)
			expect(body).toMatchObject({ roles, noindex: false, uri: `https://kopje.test/ap/users/${body.username}` })
		}
	})

	it('show no Owner when the match is suspended, ambiguous or unset, and keep noindex for a suspended account', async () => {
		const { h } = await fixture()
		const { alice } = h.users
		await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-01-01' WHERE account_id = ?", alice.id)
		expect(await account(h, alice.id)).toMatchObject({ suspended: true, roles: [], noindex: false })
		await sql(h.store, 'UPDATE local_accounts SET suspended_at = NULL WHERE account_id = ?', alice.id)
		expect((await account(h, alice.id)).roles).toEqual(OWNER)
		// local_accounts.email is unique only case-sensitively: two matches are no admin.
		await seedAccount(h.store, { username: 'carol', email: 'ALICE@example.com' })
		expect((await account(h, alice.id)).roles).toEqual([])
		await sql(h.store, "DELETE FROM instance_settings WHERE name = 'admin_email'")
		expect((await account(h, alice.id)).roles).toEqual([])
	})
})

// adminAccountIdOnce holds one lookup per operation, across its metered views, until a writer of the match forgets it
// after its write (A6: the memo warmed first).
describe('the Owner role within one operation', () => {
	it("is read once for a credential account's role and roles", async () => {
		const { h } = await fixture()
		const { alice } = h.users
		const result = await runInDurableObject(h.store, (_instance, state) => {
			const { sql: recording, reads } = recordingSql(state.storage.sql)
			const account = credentialAccount(new Db(recording), alice.id, { origin: ORIGIN })!
			return {
				role: account.role.name,
				roles: account.roles,
				scans: reads.filter((query) => query.includes(selectSql(LOCAL_EMAIL_COLUMNS))).length,
			}
		})
		expect(result).toEqual({ role: 'Owner', roles: OWNER, scans: 1 })
	})

	it('is gone after the admin is suspended, and back after an unsuspension, in the same operation', async () => {
		const { h } = await fixture()
		const { alice } = h.users
		const result = await runInDurableObject(h.store, (_instance, state) =>
			state.storage.transactionSync(() => {
				const db = new Db(state.storage.sql)
				const metered = db.metered(new RowMeter(Infinity))
				const roles = (from: Db) => presentAccountById(from, alice.id, { origin: ORIGIN })!.roles
				// Warmed through a metered view: the root's memo serves the operation.
				const before = roles(metered)
				const warm = adminAccountIdOnce(db)
				suspendLocal(db, alice.id, null, NOW)
				const suspended = adminAccountIdOnce(metered)
				const whileSuspended = roles(db)
				unsuspendLocal(db, alice.id, NOW + 1)
				return { before, warm, suspended, whileSuspended, after: roles(metered.metered(new RowMeter(Infinity))) }
			})
		)
		expect(result).toEqual({
			before: OWNER,
			warm: alice.id,
			suspended: null,
			whileSuspended: [],
			after: OWNER,
		})
	})
})
