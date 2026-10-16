import { ACCOUNT_COLUMNS, ACCOUNT_FROM, type Account, type AccountRow, type Present, presentAccount } from './accounts'
import { accessAdminRefusal, normalizedEmail } from './admin-authority'
import { EVERYONE_ROLE, OWNER_ROLE, type Role } from './auth'
import { logAction } from './moderation-log'
import { writeOperation } from './operation'
import type { Db } from '../db/sql'
import type { ImportAuthority } from '../platform/store-admin'

// Accounts as the Mastodon admin API shows them to the OAuth admin (R37), and the Access admin's repair of the OAuth
// admin's match.

// REST::Admin::AccountSerializer (app/serializers/rest/admin/account_serializer.rb:3-87), in its order. Kopje has no
// sign-ups, approvals, disabling, silencing, sensitizing, invites or recorded IPs:
//   - a local account (a User in Mastodon): its email; confirmed and approved; not disabled, silenced or sensitized;
//     locale null (Kopje stores none); its role (Owner for the OAuth admin, the default role for every other);
//   - a remote account (no User): email, confirmed, disabled, approved, locale and role null, which is what
//     Account's delegation to a missing user gives (app/models/account.rb:173-191, allow_nil);
//   - both: ip null and ips [], invite_request null; created_by_application_id and invited_by_account_id absent (their
//     conditions never hold); suspended when the account is unavailable (R1), as the nested account shows it.
export type AdminAccount = {
	id: string
	username: string
	domain: string | null
	created_at: string
	email: string | null
	ip: null
	confirmed: boolean | null
	suspended: boolean
	silenced: boolean
	sensitized: boolean
	disabled: boolean | null
	approved: boolean | null
	locale: null
	invite_request: null
	ips: never[]
	account: Account
	role: Role | null
}

// The admin entities of `ids`, read in one query; an id with no account is left out. `adminId` is the OAuth admin the
// calling admin operation has just checked (adminGuarded), whose account shows the admin role.
export function presentAdminAccounts(
	db: Db,
	ids: readonly string[],
	adminId: string,
	present: Present
): Map<string, AdminAccount> {
	const rows = db.all<AccountRow & { email: string | null }>(
		`SELECT ${ACCOUNT_COLUMNS}, l.email FROM ${ACCOUNT_FROM} WHERE a.id IN (SELECT value FROM json_each(?1))`,
		JSON.stringify([...new Set(ids)])
	)
	return new Map(
		rows.map((row) => {
			const account = presentAccount(row, present)
			const local = row.domain === null
			return [
				row.id,
				{
					id: row.id,
					username: row.username,
					domain: row.domain,
					created_at: row.created_at,
					email: local ? row.email : null,
					ip: null,
					confirmed: local ? true : null,
					suspended: account.suspended === true,
					silenced: false,
					sensitized: false,
					disabled: local ? false : null,
					approved: local ? true : null,
					locale: null,
					invite_request: null,
					ips: [],
					account,
					role: local ? (row.id === adminId ? OWNER_ROLE : EVERYONE_ROLE) : null,
				},
			]
		})
	)
}

// The longest email set-email takes (RFC 5321's path limit).
export const MAX_EMAIL_LENGTH = 254

export type SetEmailResult =
	| { ok: true; username: string; email: string }
	| { ok: false; code: 'wrong-authority' | 'account-not-found' | 'invalid-email' | 'email-taken'; message: string }

// POST /admin/accounts/email (`kopje-admin account set-email`), Access only (AUTH-5): sets a local account's email,
// trimmed, which signs it in through Access and makes it the OAuth admin when it alone matches admin_email (VIS-29).
// It is how the operator repairs an admin match that is missing or ambiguous. An email that another local account's
// matches after normalization (as the OAuth admin's match compares them) is refused, so the repair never makes a
// match ambiguous. Logged in the moderation log with the Access identity, in the same transaction.
export const setAccountEmail = writeOperation<
	{ authority: ImportAuthority; username: string; email: string; now: number },
	SetEmailResult
>((db, { authority, username, email, now }) => {
	const refused = accessAdminRefusal(db, authority, 'only an Access admin sets an account email')
	if (refused !== null || authority.kind !== 'access') {
		return { ok: false, code: 'wrong-authority', message: refused ?? 'only an Access admin sets an account email' }
	}
	const account = db.first<{ id: string; username: string }>(
		'SELECT a.id, a.username FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.username) = lower(?) AND a.domain IS NULL',
		username.replace(/^@/, '')
	)
	if (account === undefined) {
		return { ok: false, code: 'account-not-found', message: `no local account @${username.replace(/^@/, '')}` }
	}
	const value = email.trim()
	if (value === '' || value.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/u.test(value)) {
		return { ok: false, code: 'invalid-email', message: 'expected an email address' }
	}
	// local_accounts is operator-sized (a deployment assumption of about 10 accounts), as the admin match reads it.
	const taken = db
		.all<{ account_id: string; email: string }>(
			'SELECT account_id, email FROM local_accounts WHERE account_id != ?',
			account.id
		)
		.some((other) => normalizedEmail(other.email) === normalizedEmail(value))
	if (taken) {
		return { ok: false, code: 'email-taken', message: 'another local account has this email' }
	}
	db.run('UPDATE local_accounts SET email = ? WHERE account_id = ?', value, account.id)
	logAction(db, authority, 'change_email', { type: 'Account', id: account.id }, { username: account.username }, now)
	return { ok: true, username: account.username, email: value }
})
