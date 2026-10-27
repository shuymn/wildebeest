import { instanceDomainOf } from './actors'
import { accessAdminRefusal, normalizedEmail } from './admin-authority'
import { logAction } from './moderation-log'
import { type LoginAccount, loginAccount } from './oauth'
import { readOperation, writeOperation } from './operation'
import { insertLocalAccount } from './setup'
import type { Db } from '../db/sql'
import type { ImportAuthority } from '../platform/store-admin'
import { LOCAL_USERNAME, MAX_ACCOUNT_INVITATIONS, storedInvitationEmail } from '../platform/stored-bounds'

// Account invitations (MD-1, AUTH-9): the Access admin lists who may make an account, an email Access asserts and the
// username its account takes (`kopje-admin invitation`); the first sign-in of that email through /oauth/authorize
// makes the account (createInvitedAccount) and removes the invitation in the same transaction. Nothing else makes an
// account but the setup's bootstrap: POST /api/v1/accounts stays closed, and who passes Access decides nothing alone.
//
// Emails are compared as normalizedEmail compares them (trimmed, lowercased), in JavaScript, over the invitations
// (at most MAX_ACCOUNT_INVITATIONS) and the local accounts (operator-sized, as the OAuth admin's match reads them), so
// every stage that admits, refuses or matches an email uses the one function. Usernames are ASCII (LOCAL_USERNAME),
// where SQLite's lower() and JavaScript's agree, and are sought by the unique indexes on lower(username).

export type Invitation = { email: string; username: string; created_at: string }

type InvitationRow = Invitation & { rowid: number }

// Every invitation, oldest first: a scan of at most MAX_ACCOUNT_INVITATIONS rows (its cap trigger).
function invitations(db: Db): InvitationRow[] {
	return db.all<InvitationRow>(
		'SELECT rowid, email, username, created_at FROM account_invitations ORDER BY created_at, rowid'
	)
}

function invitationsOf(db: Db, email: string): InvitationRow[] {
	const wanted = normalizedEmail(email)
	return invitations(db).filter((row) => normalizedEmail(row.email) === wanted)
}

function emailTaken(db: Db, email: string): boolean {
	const wanted = normalizedEmail(email)
	return db
		.all<{ email: string }>('SELECT email FROM local_accounts')
		.some((row) => normalizedEmail(row.email) === wanted)
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

function refusal(db: Db, authority: ImportAuthority): string | null {
	const refused = accessAdminRefusal(db, authority, ACCESS_ONLY)
	return refused ?? (authority.kind === 'access' ? null : ACCESS_ONLY)
}

// GET /admin/invitations (`kopje-admin invitation`): the invitations, oldest first. The route is Access-only (app/
// admin.ts); the list names emails, so it is never public.
export const listInvitations = readOperation<void, { invitations: Invitation[] }>((db) => ({
	invitations: invitations(db).map(({ email, username, created_at }) => ({ email, username, created_at })),
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
	const refused = refusal(db, authority)
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
	if (emailTaken(db, email) || pending.some((row) => normalizedEmail(row.email) === normalizedEmail(email))) {
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
	{ ok: true; removed: Invitation[] } | { ok: false; code: 'wrong-authority' | 'invitation-not-found'; message: string }

// POST /admin/invitations/remove (`kopje-admin invitation remove <email>`), Access only (AUTH-5): removes the
// invitations of an email (one, unless an import brought two that differ beyond ASCII case). It never touches an
// account: an invitation whose account exists is already gone. Logged with the Access identity.
export const removeInvitation = writeOperation<
	{ authority: ImportAuthority; email: string; now: number },
	RemoveInvitationResult
>((db, { authority, email, now }) => {
	const refused = refusal(db, authority)
	if (refused !== null || authority.kind !== 'access') {
		return { ok: false, code: 'wrong-authority', message: refused ?? ACCESS_ONLY }
	}
	const rows = invitationsOf(db, email)
	if (rows.length === 0) {
		return { ok: false, code: 'invitation-not-found', message: 'no invitation has this email' }
	}
	for (const row of rows) {
		db.run('DELETE FROM account_invitations WHERE rowid = ?', row.rowid)
		const detail = { username: row.username, email: row.email }
		logAction(db, authority, 'destroy', { type: 'AccountInvitation', id: row.username }, detail, now)
	}
	return { ok: true, removed: rows.map(({ email, username, created_at }) => ({ email, username, created_at })) }
})

// The username an Access identity's invitation gives, or null when it has none or its email matches more than one
// (only an import can store two). Read by the consent page, which writes nothing (WEB-1), and before a key is made
// for createInvitedAccount.
export const invitedUsername = readOperation<{ email: string }, string | null>((db, { email }) => {
	const rows = invitationsOf(db, email)
	return rows.length === 1 ? rows[0]!.username : null
})

export type CreateInvitedResult = LoginAccount

// AUTH-9: the account of an Access identity's first sign-in, made in this one transaction from its invitation, which
// it removes. `email` is the identity Access asserted (the Worker verified it, security/access-jwt.ts); `key` its new
// key pair, wrapped. An identity that already has a local account by the login's match gets that account's state
// (a concurrent first sign-in made it), and no second one is made. Refused (no_account), with nothing written, when
// the identity has no single invitation, when a local account's email matches it as normalizedEmail compares but not
// as the login's lower() does, when its username is now held by a local account (an import can bring one), or before
// setup.
export const createInvitedAccount = writeOperation<
	{ email: string; key: { privkey: Uint8Array; salt: Uint8Array; pubkey: string }; now: number },
	CreateInvitedResult
>((db, { email, key, now }) => {
	const existing = loginAccount(db, email)
	if (existing.status !== 'no_account') {
		return existing
	}
	const rows = invitationsOf(db, email)
	const invitation = rows.length === 1 ? rows[0]! : undefined
	const domain = instanceDomainOf(db)
	if (invitation === undefined || domain === null || emailTaken(db, email) || usernameTaken(db, invitation.username)) {
		return { status: 'no_account' }
	}
	// The stored username is ASCII by its CHECK, so the value read back is its bytes exactly.
	const accountId = insertLocalAccount(db, { domain, username: invitation.username, email: email.trim(), key, now })
	db.run('DELETE FROM account_invitations WHERE rowid = ?', invitation.rowid)
	return { status: 'ok', accountId, username: invitation.username }
})
