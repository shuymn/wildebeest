import { describe, expect, it } from 'vitest'

import {
	type ApiHarness,
	apiHarness,
	bearer,
	consentPage,
	decide,
	exchange,
	json,
	registerApp,
	seedAccount,
	sql,
} from './api-helpers'
import { NOW } from './app-helpers'
import { fixtureKeyGen } from './federation-helpers'
import { BUILD } from './helpers'
import { ACCESS, accessAdminStore } from './ops-helpers'
import { appTokenWith, plannedRun, remoteAccounts, scansOf, staleStatistics } from './read-helpers'
import { addInvitation, createInvitedAccount } from '../src/domain/account-invitations'
import type { StoreStub } from '../src/platform/store-client'
import { INVITATION_EMAIL_BYTES, MAX_ACCOUNT_INVITATIONS } from '../src/platform/stored-bounds'
import type { KeyGen } from '../src/security/key-wrap'

// MD-1 and AUTH-9: the Access admin invites an email with a username (domain/account-invitations.ts), and that
// identity's first sign-in through Access makes its account; nothing else does.

const add = (store: StoreStub, email: string, username: string, authority: object = ACCESS) =>
	store.addInvitation(BUILD, { authority: authority as typeof ACCESS, email, username, now: NOW })

async function log(store: StoreStub) {
	return sql<{ action: string; target_type: string; target_id: string }>(
		store,
		"SELECT action, target_type, target_id FROM admin_actions WHERE target_type = 'AccountInvitation' ORDER BY id"
	)
}

describe('the Access admin’s invitations', () => {
	it('adds, lists and removes invitations, each logged', async () => {
		const store = await accessAdminStore()
		expect(await add(store, '  Bob@Example.com ', 'bob')).toEqual({
			ok: true,
			invitation: { email: 'Bob@Example.com', username: 'bob', created_at: new Date(NOW).toISOString() },
		})
		expect(await add(store, 'carol@example.com', 'Carol_1')).toMatchObject({ ok: true })
		expect((await store.listInvitations(BUILD)).invitations.map((i) => i.username)).toEqual(['bob', 'Carol_1'])
		expect(await store.removeInvitation(BUILD, { authority: ACCESS, email: 'BOB@example.com', now: NOW })).toEqual({
			ok: true,
			removed: { email: 'Bob@Example.com', username: 'bob', created_at: new Date(NOW).toISOString() },
		})
		expect(
			await store.removeInvitation(BUILD, { authority: ACCESS, email: 'bob@example.com', now: NOW })
		).toMatchObject({ ok: false, code: 'invitation-not-found' })
		expect((await store.listInvitations(BUILD)).invitations.map((i) => i.username)).toEqual(['Carol_1'])
		expect(await log(store)).toEqual([
			{ action: 'create', target_type: 'AccountInvitation', target_id: 'bob' },
			{ action: 'create', target_type: 'AccountInvitation', target_id: 'Carol_1' },
			{ action: 'destroy', target_type: 'AccountInvitation', target_id: 'bob' },
		])
	})

	it('refuses every authority but the Access admin, writing nothing', async () => {
		const store = await accessAdminStore()
		for (const authority of [
			{ kind: 'import-token' },
			{ kind: 'import-session', secret: 'x' },
			{ ...ACCESS, email: 'someone@kopje.test' },
		]) {
			expect(await add(store, 'bob@example.com', 'bob', authority), JSON.stringify(authority)).toMatchObject({
				ok: false,
				code: 'wrong-authority',
			})
		}
		expect(await sql(store, 'SELECT 1 FROM account_invitations')).toEqual([])
		// The same write by the admin passes: the refusal was the authority's.
		expect(await add(store, 'bob@example.com', 'bob')).toMatchObject({ ok: true })
	})

	it('refuses an email or a username past its bound, before anything is written', async () => {
		const store = await accessAdminStore()
		const local = `${'a'.repeat(INVITATION_EMAIL_BYTES - '@example.com'.length)}@example.com`
		const astral = `${'\u{1F600}'.repeat((INVITATION_EMAIL_BYTES - '@x.example'.length) / 4)}@x.example`
		expect(new TextEncoder().encode(local).length).toBe(INVITATION_EMAIL_BYTES)
		for (const email of [
			'',
			'bob',
			'@example.com',
			'bob@',
			'bob@a@example.com',
			'bo b@example.com',
			'bob\u0000@example.com',
			'bob\u0085@example.com',
			'\ud800bob@example.com',
			`a${local}`,
			`${astral}x`,
		]) {
			expect(await add(store, email, 'bob'), JSON.stringify(email)).toMatchObject({ ok: false, code: 'invalid-email' })
		}
		for (const username of ['', 'a'.repeat(31), 'bo-b', 'bób', 'bob\u0000']) {
			expect(await add(store, 'bob@example.com', username), username).toMatchObject({
				ok: false,
				code: 'invalid-username',
			})
		}
		expect(await sql(store, 'SELECT 1 FROM account_invitations')).toEqual([])
		// At the bounds: 254 bytes of ASCII, of astral characters, and a username of 30.
		expect(await add(store, local, 'a'.repeat(30))).toMatchObject({ ok: true })
		expect(new TextEncoder().encode(astral).length).toBeLessThanOrEqual(INVITATION_EMAIL_BYTES)
		expect(await add(store, astral, 'astral')).toMatchObject({ ok: true })
	})

	it('refuses an email or a username a local account or another invitation has, whatever their case', async () => {
		const store = await accessAdminStore()
		await seedAccount(store, { username: 'alice', email: 'alice@example.com' })
		expect(await add(store, 'bob@example.com', 'bob')).toMatchObject({ ok: true })
		for (const [email, username, code] of [
			['ALICE@example.com', 'alice2', 'email-taken'],
			['Bob@Example.COM', 'bob2', 'email-taken'],
			['carol@example.com', 'ALICE', 'username-taken'],
			['carol@example.com', 'Bob', 'username-taken'],
		] as const) {
			expect(await add(store, email, username), `${email} ${username}`).toMatchObject({ ok: false, code })
		}
		expect((await store.listInvitations(BUILD)).invitations).toHaveLength(1)
		expect(await add(store, 'carol@example.com', 'carol')).toMatchObject({ ok: true })
	})

	it(`keeps at most ${MAX_ACCOUNT_INVITATIONS}, refused before the cap trigger would`, async () => {
		const store = await accessAdminStore()
		for (let i = 0; i < MAX_ACCOUNT_INVITATIONS; i++) {
			expect(await add(store, `u${i}@example.com`, `u${i}`)).toMatchObject({ ok: true })
		}
		expect(await add(store, 'over@example.com', 'over')).toMatchObject({ ok: false, code: 'too-many-invitations' })
		await store.removeInvitation(BUILD, { authority: ACCESS, email: 'u0@example.com', now: NOW })
		expect(await add(store, 'over@example.com', 'over')).toMatchObject({ ok: true })
	})
})

// An identity the sign-in application's Access admits, on an instance whose admin may invite.
async function instance(keygen: KeyGen = fixtureKeyGen) {
	const h = await apiHarness({}, { federation: { keygen } })
	for (const [name, value] of [
		['access_admin_aud', ACCESS.aud],
		['admin_email', ACCESS.email],
	] as const) {
		await sql(h.store, 'INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', name, value)
	}
	const admin = { ...ACCESS, teamDomain: h.team.teamDomain }
	const invite = (email: string, username: string) =>
		h.store.addInvitation(BUILD, { authority: admin, email, username, now: NOW })
	return { ...h, invite, app: await registerApp(h) }
}

const accounts = (h: ApiHarness) =>
	sql<{ username: string; email: string }>(
		h.store,
		'SELECT a.username, l.email FROM accounts a JOIN local_accounts l ON l.account_id = a.id ORDER BY a.id'
	)

async function signIn(h: Awaited<ReturnType<typeof instance>>, email: string) {
	const response = await decide(h, h.app, 'approve', { email })
	expect(response.status, await response.clone().text()).toBe(302)
	const code = new URL(response.headers.get('location')!).searchParams.get('code')!
	const token = await (await exchange(h, h.app, code)).json<{ access_token: string }>()
	return (await h.request('/api/v1/accounts/verify_credentials', bearer(token.access_token))).json<{
		id: string
		username: string
	}>()
}

describe('the first sign-in of an invited identity', () => {
	it('shows the invited username on the consent page and writes nothing there', async () => {
		const h = await instance()
		expect((await h.invite('bob@example.com', 'bob')).ok).toBe(true)
		const page = await consentPage(h, h.app, { email: 'BOB@example.com' })
		expect(page.status).toBe(200)
		expect(await page.text()).toContain('@bob')
		expect(await accounts(h)).toEqual([])
		expect(await sql(h.store, 'SELECT username FROM account_invitations')).toEqual([{ username: 'bob' }])
	})

	it('makes the account on approval, removes the invitation, and signs the same account in again', async () => {
		const h = await instance()
		await h.invite('bob@example.com', 'bob')
		const first = await signIn(h, 'bob@example.com')
		expect(first.username).toBe('bob')
		expect(await accounts(h)).toEqual([{ username: 'bob', email: 'bob@example.com' }])
		expect(await sql(h.store, 'SELECT 1 FROM account_invitations')).toEqual([])
		// Its actor is served under the domain, with the key made for it.
		const actor = await h.request('/ap/users/bob', { headers: { accept: 'application/activity+json' } })
		expect(actor.status).toBe(200)
		expect(await sql(h.store, "SELECT value FROM activity_counts WHERE kind = 'registrations'")).toEqual([{ value: 1 }])
		// A later sign-in, in another case, is the same account; no invitation is needed any more.
		expect(await signIn(h, 'Bob@Example.com')).toMatchObject({ id: first.id, username: 'bob' })
		expect(await accounts(h)).toHaveLength(1)
		// Removing the invitation now finds none, and leaves the account.
		const removed = await h.store.removeInvitation(BUILD, {
			authority: { ...ACCESS, teamDomain: h.team.teamDomain },
			email: 'bob@example.com',
			now: NOW,
		})
		expect(removed).toMatchObject({ ok: false, code: 'invitation-not-found' })
		expect(await accounts(h)).toHaveLength(1)
	})

	it('matches an email by ASCII case only, as the login does, and gives the account the invitation’s spelling', async () => {
		const h = await instance()
		await h.invite('Bob@Example.com', 'bob')
		await h.invite('kim@example.com', 'kim')
		await h.invite('straße@example.com', 'strasse')
		await h.invite('iris@example.com', 'iris')
		// Unicode case variants are other emails (oauth.ts loginEmailMatchSql): the Kelvin sign U+212A, the capital
		// sharp s U+1E9E and the dotted capital I U+0130. Each is refused on the page and at approval, making nothing.
		for (const email of ['\u212Aim@example.com', 'STRA\u1E9EE@example.com', '\u0130ris@example.com']) {
			for (const response of [await consentPage(h, h.app, { email }), await decide(h, h.app, 'approve', { email })]) {
				expect(new URL(response.headers.get('location')!).searchParams.get('error'), email).toBe('access_denied')
			}
		}
		expect(await accounts(h)).toEqual([])
		// An ASCII case variant is the same email; the account keeps the spelling the admin invited.
		expect((await signIn(h, 'bob@EXAMPLE.com')).username).toBe('bob')
		expect(await accounts(h)).toEqual([{ username: 'bob', email: 'Bob@Example.com' }])
		// The same rule decides what the add refuses: an ASCII variant is taken, a Unicode one is another email.
		expect(await h.invite('BOB@example.com', 'bob2')).toMatchObject({ ok: false, code: 'email-taken' })
		expect(await h.invite('KIM@example.com', 'kim2')).toMatchObject({ ok: false, code: 'email-taken' })
		expect(await h.invite('\u212Aim@example.com', 'kelvin')).toMatchObject({ ok: true })
	})

	it('refuses an identity without an invitation, and keeps registration through the API closed', async () => {
		const h = await instance()
		await h.invite('bob@example.com', 'bob')
		for (const response of [
			await consentPage(h, h.app, { email: 'carol@example.com', state: 'st' }),
			await decide(h, h.app, 'approve', { email: 'carol@example.com', state: 'st' }),
		]) {
			expect(response.status).toBe(302)
			expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
		}
		// With the app token Mastodon's sign-up takes, for the invited email itself (MD-1).
		const registration = await h.request(
			'/api/v1/accounts',
			json(
				{ username: 'bob', email: 'bob@example.com', password: 'x'.repeat(12), agreement: true, locale: 'en' },
				bearer(await appTokenWith(h, 'write:accounts'))
			)
		)
		expect(registration.status).toBe(403)
		expect(await registration.json()).toEqual({ error: 'Forbidden' })
		// The Store refuses it too, where it writes, whatever the Worker read before.
		const key = { privkey: new Uint8Array(1), salt: new Uint8Array(1), pubkey: 'k' }
		expect(await h.store.createInvitedAccount(BUILD, { email: 'carol@example.com', key, now: NOW })).toEqual({
			status: 'no_account',
		})
		expect(await accounts(h)).toEqual([])
		expect(await sql(h.store, 'SELECT username FROM account_invitations')).toEqual([{ username: 'bob' }])
	})

	it('refuses an invited email without a valid Access assertion, making nothing', async () => {
		const h = await instance()
		await h.invite('bob@example.com', 'bob')
		const cases: [string, string | null][] = [
			['no assertion', null],
			['another key', await h.team.assertion({ email: 'bob@example.com' }, h.team.otherKey)],
			['expired', await h.team.assertion({ email: 'bob@example.com', exp: Math.floor(NOW / 1000) - 3600 })],
		]
		for (const [label, assertion] of cases) {
			expect((await decide(h, h.app, 'approve', { email: 'bob@example.com', assertion })).status, label).toBe(403)
		}
		expect(await accounts(h)).toEqual([])
		// The same request with a valid assertion makes it: each refusal was the assertion's.
		expect((await signIn(h, 'bob@example.com')).username).toBe('bob')
	})

	it('refuses a decision posted from another origin, making nothing (WEB-1)', async () => {
		const h = await instance()
		await h.invite('bob@example.com', 'bob')
		const assertion = await h.team.assertion({ email: 'bob@example.com' })
		const response = await h.request('/oauth/authorize', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'cf-access-jwt-assertion': assertion,
				origin: 'https://evil.example',
			},
			body: new URLSearchParams({
				client_id: h.app.client_id,
				redirect_uri: h.app.redirect_uri,
				scope: 'read',
				decision: 'approve',
			}).toString(),
		})
		expect(response.status).toBe(403)
		expect(await accounts(h)).toEqual([])
	})

	it('refuses, writing nothing, when a local account took the username after the invitation', async () => {
		const h = await instance()
		await h.invite('bob@example.com', 'bob')
		// Only an import or a restore can bring it: the invitation refused the username while it was free.
		await seedAccount(h.store, { username: 'BOB', email: 'other@example.com' })
		const response = await decide(h, h.app, 'approve', { email: 'bob@example.com' })
		expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
		expect((await accounts(h)).map((a) => a.email)).toEqual(['other@example.com'])
		expect(await sql(h.store, 'SELECT username FROM account_invitations')).toEqual([{ username: 'bob' }])
	})

	it('makes one account when two first sign-ins of the same identity overlap', async () => {
		let reached!: () => void
		const atKey = new Promise<void>((resolve) => (reached = resolve))
		let release!: () => void
		const held = new Promise<void>((resolve) => (release = resolve))
		let calls = 0
		// The first sign-in stops after reading the invitation, while it makes its key; the second runs to the end.
		const keygen: KeyGen = async () => {
			if (++calls === 1) {
				reached()
				await held
			}
			return fixtureKeyGen()
		}
		const h = await instance(keygen)
		await h.invite('bob@example.com', 'bob')
		const first = decide(h, h.app, 'approve', { email: 'bob@example.com' })
		await atKey
		const second = await signIn(h, 'bob@example.com')
		expect(await accounts(h)).toEqual([{ username: 'bob', email: 'bob@example.com' }])
		release()
		const response = await first
		expect(response.status).toBe(302)
		const code = new URL(response.headers.get('location')!).searchParams.get('code')!
		const token = await (await exchange(h, h.app, code)).json<{ access_token: string }>()
		const me = await h.request('/api/v1/accounts/verify_credentials', bearer(token.access_token))
		expect(await me.json()).toMatchObject({ id: second.id, username: 'bob' })
		expect(calls).toBe(2)
		expect(await accounts(h)).toHaveLength(1)
		expect(await sql(h.store, "SELECT value FROM activity_counts WHERE kind = 'registrations'")).toEqual([{ value: 1 }])
	})
})

describe('invitation reads with stale statistics (RES-7)', () => {
	it('seeks the invitation and the username by their indexes, remote namesakes grown after ANALYZE', async () => {
		const h = await instance()
		// Every input at its worst: MAX_ACCOUNT_INVITATIONS invitations, the newest sought, and remote accounts of every
		// invited username (u0 to u9) in 100 domains, grown after ANALYZE.
		for (let i = 0; i < MAX_ACCOUNT_INVITATIONS; i++) {
			expect((await h.invite(`u${i}@example.com`, `u${i}`)).ok).toBe(true)
		}
		const key = { privkey: new Uint8Array(1), salt: new Uint8Array(1), pubkey: 'k' }
		// Before the growth an identity without an invitation (it reads and writes nothing); after it, the newest
		// invitation's, which goes on to seek its username, copy its email and remove it.
		const run = (email: string) =>
			plannedRun(h, /account_invitations|accounts_local_username/, createInvitedAccount, { email, key, now: NOW }, true)
		const { before, after } = await staleStatistics(h, {
			capture: (phase) => run(phase === 'before' ? 'nobody@example.com' : 'U9@example.com'),
			grow: () => remoteAccounts(h, 100, 10),
		})
		expect(before.result).toEqual({ status: 'no_account' })
		expect(after.result).toMatchObject({ status: 'ok', username: 'u9' })
		const kind = (query: string) =>
			query.includes('account_invitations_email')
				? 'invitation'
				: query.includes('accounts_local_username')
					? 'username'
					: query.startsWith('UPDATE')
						? 'copy'
						: 'remove'
		expect(before.plans.map((p) => kind(p.query))).toEqual(['invitation'])
		expect(after.plans.map((p) => kind(p.query))).toEqual(['invitation', 'username', 'copy', 'remove'])
		const plans = Object.fromEntries(after.plans.map((p) => [kind(p.query), p]))
		expect(plans.invitation?.plan).toEqual([
			'SEARCH account_invitations USING INDEX account_invitations_email (<expr>=?)',
		])
		expect(plans.username?.plan).toEqual(['SEARCH accounts USING INDEX accounts_local_username (<expr>=?)'])
		expect(plans.remove?.plan).toEqual(['SEARCH account_invitations USING INTEGER PRIMARY KEY (rowid=?)'])
		for (const [name, planned] of Object.entries(plans)) {
			expect(scansOf(planned.plan, ['account_invitations', 'accounts', 'local_accounts']), name).toEqual([])
		}
		expect(plans.invitation?.rows).toBeLessThanOrEqual(1)
		expect(plans.username?.rows).toBeLessThanOrEqual(1)
	}, 60_000)

	it('reads at most the cap of invitations, twice, when one is added', async () => {
		const h = await instance()
		// The table at its cap: the add reads every row (for the usernames and the count), then refuses.
		for (let i = 0; i < MAX_ACCOUNT_INVITATIONS; i++) {
			await h.invite(`u${i}@example.com`, `u${i}`)
		}
		const authority = { ...ACCESS, teamDomain: h.team.teamDomain }
		const { result, plans } = await plannedRun(
			h,
			/FROM account_invitations ORDER BY/,
			addInvitation,
			{ authority, email: 'last@example.com', username: 'last', now: NOW },
			true
		)
		expect(result).toMatchObject({ ok: false, code: 'too-many-invitations' })
		expect(plans).toHaveLength(1)
		expect(plans[0]?.plan).toEqual(['SCAN account_invitations', 'USE TEMP B-TREE FOR ORDER BY'])
		// Each row read once by the scan and once by the sort.
		expect(plans[0]?.rows).toBe(2 * MAX_ACCOUNT_INVITATIONS)
	})
})
