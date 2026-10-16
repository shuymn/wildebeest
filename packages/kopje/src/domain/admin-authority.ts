import { readOperation } from './operation'
import type { Db } from '../db/sql'
import { ACCESS_SETTINGS, accessRefusal, settingsFromRows, type SettingRow } from '../platform/access-settings'
import type { ImportAuthority } from '../platform/store-admin'

// The Access admin, checked against the saved configuration, as the Worker verified it, in the transaction of an admin
// operation that writes (the media rebuild, the key rewrap). IMPORT_TOKEN and import sessions are refused with
// `refusal`: these operations run through Access only. null when the admin may go on.
export function accessAdminRefusal(db: Db, authority: ImportAuthority, refusal: string): string | null {
	if (authority.kind !== 'access') {
		return refusal
	}
	const names = Object.values(ACCESS_SETTINGS)
	const rows = db.all<SettingRow>(
		`SELECT name, value FROM instance_settings WHERE name IN (${names.map(() => '?').join(',')})`,
		...names
	)
	return accessRefusal(settingsFromRows(rows), authority)
}

// Why there is, or is not, an OAuth admin:
//   ok        exactly one local account's email matches admin_email, and it is not suspended
//   unset     admin_email is missing or empty
//   none      no local account's email matches
//   suspended the one match is suspended
//   ambiguous two or more local accounts match (local_accounts.email is unique only case-sensitively)
export type OAuthAdminStatus = 'ok' | 'unset' | 'none' | 'suspended' | 'ambiguous'

export type OAuthAdmin = {
	status: OAuthAdminStatus
	// The matched account's username (ok, suspended); null otherwise, so nothing is picked when the match is ambiguous.
	username: string | null
	// The admin's account id, only when status is ok.
	accountId: string | null
}

// The OAuth admin (the Mastodon admin API's, and setup's after bootstrap): the single local account whose email equals
// admin_email after trimming and lowercasing both. It fails closed: unset, no match, a suspended match or more than
// one match gives no admin. It is read in the transaction of each operation that asks, so tokens follow the current
// match when admin_email or an account changes. Both sides are normalized here, not in SQL, whose trim() and lower()
// cover only spaces and ASCII, so every normalized match is counted. local_accounts is read whole; its size is the
// operator's (a deployment assumption of about 10 accounts).
export function oauthAdmin(db: Db): OAuthAdmin {
	const email = db.first<{ value: string }>(
		'SELECT value FROM instance_settings WHERE name = ?',
		ACCESS_SETTINGS.adminEmail
	)?.value
	if (email === undefined || email.trim() === '') {
		return { status: 'unset', username: null, accountId: null }
	}
	const wanted = normalizedEmail(email)
	const rows = db
		.all<{ account_id: string; email: string; username: string; suspended_at: string | null }>(
			'SELECT l.account_id, l.email, a.username, l.suspended_at FROM local_accounts l JOIN accounts a ON a.id = l.account_id'
		)
		.filter((candidate) => normalizedEmail(candidate.email) === wanted)
	const [row] = rows
	if (row === undefined) {
		return { status: 'none', username: null, accountId: null }
	}
	if (rows.length > 1) {
		return { status: 'ambiguous', username: null, accountId: null }
	}
	if (row.suspended_at !== null) {
		return { status: 'suspended', username: row.username, accountId: null }
	}
	return { status: 'ok', username: row.username, accountId: row.account_id }
}

// An email as the OAuth admin's match compares it: trimmed and lowercased (set-email compares the same way).
export function normalizedEmail(email: string): string {
	return email.trim().toLowerCase()
}

// The OAuth admin's account id, or null when there is none (see oauthAdmin).
export function adminAccountId(db: Db): string | null {
	return oauthAdmin(db).accountId
}

// The OAuth admin's state for GET /admin/health (Access only), so the operator sees why there is no admin.
export const oauthAdminStatus = readOperation<void, Omit<OAuthAdmin, 'accountId'>>((db) => {
	const { status, username } = oauthAdmin(db)
	return { status, username }
})
