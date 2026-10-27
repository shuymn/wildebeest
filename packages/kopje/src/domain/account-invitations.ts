import { instanceDomainOf } from './actors'
import { accessAdminRefusal } from './admin-authority'
import { logAction } from './moderation-log'
import { type LoginAccount, loginAccount } from './oauth'
import { readOperation, writeOperation } from './operation'
import { insertLocalAccount } from './setup'
import type { Db } from '../db/sql'
import { loginEmailMatchSql } from '../platform/login-email'
import type { ImportAuthority } from '../platform/store-admin'
import { LOCAL_USERNAME, MAX_ACCOUNT_INVITATIONS, storedInvitationEmail } from '../platform/stored-bounds'

// Account invitations (MD-1, AUTH-9): the Access admin lists who may make an account, an email Access asserts and the
// username its account takes (`kopje-admin invitation`); the first sign-in of that email through /oauth/authorize
// makes the account (createInvitedAccount) and removes the invitation in the same transaction. Nothing else makes an
// account but the setup's bootstrap: POST /api/v1/accounts stays closed, and who passes Access decides nothing alone.
//
// An email names an invitation or a local account by one rule, the sign-in's (login-email.ts loginEmailMatchSql: SQLite's
// lower(), ASCII case only), in SQL at every stage: the add's refusals, the unique index on the invitations, the
// consent page's read and the account's creation. Usernames are ASCII (LOCAL_USERNAME), where SQLite's lower() and
// JavaScript's agree, and are sought by the unique indexes on lower(username).

export type Invitation = { email: string; username: string; created_at: string }

type InvitationRow = Invitation & { rowid: number }

// Every invitation, oldest first: a scan of at most MAX_ACCOUNT_INVITATIONS rows (its cap trigger).
function invitations(db: Db): Invitation[] {
	return db.all<Invitation>('SELECT email, username, created_at FROM account_invitations ORDER BY created_at, rowid')
}

// The invitation of an email, by account_invitations_email (unique, so at most one).
function invitationOf(db: Db, email: string): InvitationRow | undefined {
	return db.first<InvitationRow>(
		`SELECT rowid, email, username, created_at FROM account_invitations INDEXED BY account_invitations_email
		WHERE ${loginEmailMatchSql('email')}`,
		email
	)
}

function usernameTaken(db: Db, username: string): boolean {
	return (
		db.first(
			'SELECT 1 AS found FROM accounts INDEXED BY accounts_local_username WHERE lower(username) = lower(?) AND domain IS NULL',
			username
		) !== undefined
	)
}

const ACCESS_ONLY = 'only an Access admin manages invitations'

// GET /admin/invitations (`kopje-admin invitation`): the invitations, oldest first. The route is Access-only (app/
// admin.ts); the list names emails, so it is never public.
export const listInvitations = readOperation<void, { invitations: Invitation[] }>((db) => ({
	invitations: invitations(db),
}))

export type AddInvitationResult =
	| { ok: true; invitation: Invitation }
	| {
			ok: false
			code:
				| 'wrong-authority'
				| 'invalid-email'
				| 'invalid-username'
				| 'email-taken'
				| 'username-taken'
				| 'too-many-invitations'
			message: string
	  }

// POST /admin/invitations (`kopje-admin invitation add <email> <username>`), Access only (AUTH-5): invites an email
// with the username its account will take. Refused when a local account or another invitation already has the email
// or the username, or when MAX_ACCOUNT_INVITATIONS are pending; each refusal is checked before the insert, by the
// rules its CHECKs, unique index and cap trigger apply, so the insert never fails on them. Logged in the moderation
// log with the Access identity.
export const addInvitation = writeOperation<
	{ authority: ImportAuthority; email: string; username: string; now: number },
	AddInvitationResult
>((db, { authority, email: rawEmail, username, now }) => {
	const refused = accessAdminRefusal(db, authority, ACCESS_ONLY)
	if (refused !== null || authority.kind !== 'access') {
		return { ok: false, code: 'wrong-authority', message: refused ?? ACCESS_ONLY }
	}
	const email = storedInvitationEmail(rawEmail)
	if (email === null) {
		return { ok: false, code: 'invalid-email', message: 'expected an email address' }
	}
	if (!LOCAL_USERNAME.test(username)) {
		return { ok: false, code: 'invalid-username', message: 'a username is 1 to 30 letters, digits or underscores' }
	}
	const pending = invitations(db)
	if (loginAccount(db, email).status !== 'no_account' || invitationOf(db, email) !== undefined) {
		return { ok: false, code: 'email-taken', message: 'a local account or an invitation already has this email' }
	}
	const lowered = username.toLowerCase()
	if (usernameTaken(db, username) || pending.some((row) => row.username.toLowerCase() === lowered)) {
		return { ok: false, code: 'username-taken', message: `a local account or an invitation already has @${username}` }
	}
	if (pending.length >= MAX_ACCOUNT_INVITATIONS) {
		return {
			ok: false,
			code: 'too-many-invitations',
			message: `at most ${MAX_ACCOUNT_INVITATIONS} invitations are kept; remove one first`,
		}
	}
	const invitation = { email, username, created_at: new Date(now).toISOString() }
	db.run(
		'INSERT INTO account_invitations (email, username, created_at) VALUES (?, ?, ?)',
		invitation.email,
		invitation.username,
		invitation.created_at
	)
	logAction(db, authority, 'create', { type: 'AccountInvitation', id: username }, { username, email }, now)
	return { ok: true, invitation }
})

export type RemoveInvitationResult =
	{ ok: true; removed: Invitation } | { ok: false; code: 'wrong-authority' | 'invitation-not-found'; message: string }

// POST /admin/invitations/remove (`kopje-admin invitation remove <email>`), Access only (AUTH-5): removes an email's
// invitation. It never touches an account: an invitation whose account exists is already gone. Logged with the
// Access identity.
export const removeInvitation = writeOperation<
	{ authority: ImportAuthority; email: string; now: number },
	RemoveInvitationResult
>((db, { authority, email, now }) => {
	const refused = accessAdminRefusal(db, authority, ACCESS_ONLY)
	if (refused !== null || authority.kind !== 'access') {
		return { ok: false, code: 'wrong-authority', message: refused ?? ACCESS_ONLY }
	}
	const row = invitationOf(db, email.trim())
	if (row === undefined) {
		return { ok: false, code: 'invitation-not-found', message: 'no invitation has this email' }
	}
	db.run('DELETE FROM account_invitations WHERE rowid = ?', row.rowid)
	const detail = { username: row.username, email: row.email }
	logAction(db, authority, 'destroy', { type: 'AccountInvitation', id: row.username }, detail, now)
	return { ok: true, removed: { email: row.email, username: row.username, created_at: row.created_at } }
})

export type SignInState = LoginAccount | { status: 'invited'; username: string }

// What an Access identity signs in to, read at once so no account made between two reads is missed: its local account
// by the login's match, else its invitation's username (invited), else no_account. Read by the consent page, which
// writes nothing (WEB-1), and by the approval before it makes a key for createInvitedAccount.
export const signInState = readOperation<{ email: string }, SignInState>((db, { email }) => {
	const login = loginAccount(db, email)
	if (login.status !== 'no_account') {
		return login
	}
	const invitation = invitationOf(db, email)
	return invitation === undefined ? login : { status: 'invited', username: invitation.username }
})

export type CreateInvitedResult = LoginAccount

// AUTH-9: the account of an Access identity's first sign-in, made in this one transaction from its invitation, which
// it removes. `email` is the identity Access asserted (the Worker verified it, security/access-jwt.ts); `key` its new
// key pair, wrapped. An identity that already has a local account by the login's match gets that account's state
// (a concurrent first sign-in made it), and no second one is made. Refused (no_account), with nothing written, when
// the identity has no invitation, when its username is now held by a local account (an import can bring one), or
// before setup. The account takes the invitation's email, copied in SQL (the stored spelling, which the identity's
// matches by loginEmailMatchSql), never the decoded value.
export const createInvitedAccount = writeOperation<
	{ email: string; key: { privkey: Uint8Array; salt: Uint8Array; pubkey: string }; now: number },
	CreateInvitedResult
>((db, { email, key, now }) => {
	const existing = loginAccount(db, email)
	if (existing.status !== 'no_account') {
		return existing
	}
	const invitation = invitationOf(db, email)
	const domain = instanceDomainOf(db)
	if (invitation === undefined || domain === null || usernameTaken(db, invitation.username)) {
		return { status: 'no_account' }
	}
	// The stored username is ASCII by its CHECK, so the value read back is its bytes exactly.
	const accountId = insertLocalAccount(db, { domain, username: invitation.username, email, key, now })
	db.run(
		'UPDATE local_accounts SET email = (SELECT email FROM account_invitations WHERE rowid = ?1) WHERE account_id = ?2',
		invitation.rowid,
		accountId
	)
	db.run('DELETE FROM account_invitations WHERE rowid = ?', invitation.rowid)
	return { status: 'ok', accountId, username: invitation.username }
})
