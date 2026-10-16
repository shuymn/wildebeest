import {
	ACCOUNT_COLUMNS,
	ACCOUNT_FROM,
	type Account,
	type AccountRow,
	type Page,
	type PageQuery,
	type Present,
	presentAccount,
} from './accounts'
import { accessAdminRefusal, normalizedEmail } from './admin-authority'
import { availableJoinedSql, availableLocalSql, deletingSql, notDeletingSql } from './audience'
import {
	ADMIN_PERMISSION,
	adminGuarded,
	adminReadOperation,
	adminWriteOperation,
	EVERYONE_ROLE,
	OWNER_ROLE,
	type Role,
} from './auth'
import { logAction } from './moderation-log'
import { writeOperation } from './operation'
import { reportExists, resolveReport } from './reports'
import { suspendLocal, unsuspendLocal } from './suspension'
import type { Db } from '../db/sql'
import type { ImportAuthority } from '../platform/store-admin'

// Accounts as the Mastodon admin API shows them to the OAuth admin (R37): their entity, the list and its filters, an
// account by id and the actions that change nothing; and the Access admin's repair of the OAuth admin's match.

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

export type UnsuspendResult =
	| { ok: true; username: string }
	| { ok: false; code: 'wrong-authority' | 'account-not-found' | 'not-suspended'; message: string }

// POST /admin/accounts/unsuspend (`kopje-admin account unsuspend`), Access only (AUTH-5): unsuspends a local account as
// the admin API does (domain/suspension.ts unsuspendLocal; its credential epoch stays). It is how the operator
// recovers a suspended OAuth admin, whom no OAuth admin can unsuspend. Logged in the moderation log with the Access
// identity, in the same transaction.
export const unsuspendAccount = writeOperation<
	{ authority: ImportAuthority; username: string; now: number },
	UnsuspendResult
>((db, { authority, username, now }) => {
	const refused = accessAdminRefusal(db, authority, 'only an Access admin unsuspends an account')
	if (refused !== null || authority.kind !== 'access') {
		return { ok: false, code: 'wrong-authority', message: refused ?? 'only an Access admin unsuspends an account' }
	}
	const name = username.replace(/^@/, '')
	const account = db.first<{ id: string; username: string }>(
		'SELECT a.id, a.username FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE lower(a.username) = lower(?) AND a.domain IS NULL',
		name
	)
	if (account === undefined) {
		return { ok: false, code: 'account-not-found', message: `no local account @${name}` }
	}
	if (!unsuspendLocal(db, account.id, now)) {
		return { ok: false, code: 'not-suspended', message: `@${account.username} is not suspended` }
	}
	logAction(db, authority, 'unsuspend', { type: 'Account', id: account.id }, { username: account.username }, now)
	return { ok: true, username: account.username }
})

// ---- The admin's accounts (Api::V1::Admin::AccountsController and Api::V2::Admin::AccountsController, app/controllers/
// api/v{1,2}/admin/accounts_controller.rb; AccountFilter, app/models/account_filter.rb; Api::V1::Admin::
// AccountActionsController and Admin::AccountAction). The routes need manage_users. adminAccountOperations builds them
// over any admin guard (adminReadOperation and adminWriteOperation outside tests).

export const ADMIN_ACCOUNTS_LIMIT = 100
export const MAX_ADMIN_ACCOUNTS_LIMIT = 200
// The most candidates a search reads (a username, display name or domain range); one more is read to see that there
// are more, which answers 'too_broad' rather than a page out of id order or an empty one.
export const ADMIN_ACCOUNT_CANDIDATES = 2_000

export type AdminAccountStatus = 'active' | 'pending' | 'disabled' | 'silenced' | 'suspended' | 'sensitized'

// AccountFilter's keys after the controller translated them (mastodon/admin.ts reads both versions' names into this):
// each is null when it was not sent (or sent blank, which AccountFilter skips). The values are as AccountFilter reads
// them: by_domain, display_name and email stripped, username stripped of spaces and a leading @, by_domain lowercased
// (Kopje stores domains so). roleIds holds Mastodon's role ids: '3' is the OAuth admin's (Owner), '-99' every other
// local account's (the everyone role); staff and permissions=staff read as ['3'], the one role that can manage reports.
export type AdminAccountFilter = {
	origin: 'local' | 'remote' | null
	status: AdminAccountStatus | null
	roleIds: readonly string[] | null
	username: string | null
	byDomain: string | null
	displayName: string | null
	email: string | null
	ip: string | null
	invitedBy: string | null
}

export type AdminAccountList =
	| ({ status: 'ok'; more: boolean } & Page<AdminAccount>)
	// More than ADMIN_ACCOUNT_CANDIDATES accounts in the searched range: 422, never an unordered or empty page.
	| { status: 'too_broad' }

// What a filter reads of an account. unavailable is R1's rule (availableSql): a suspended local account, or a remote
// one whose deletion has started; the admin entity shows both as suspended, and the filter agrees.
type Candidate = {
	id: string
	username: string
	domain: string | null
	display_name: string
	email: string | null
	unavailable: number
}

const CANDIDATE_COLUMNS = `a.id, a.username, a.domain, a.display_name, l.email,
	NOT ${availableJoinedSql('a', 'l')} AS unavailable`

// Lowercases ASCII letters only, as SQLite's lower() does, so a prefix compares alike in an index range and in memory.
// Other letters keep their case (an accepted difference from Mastodon's ILIKE).
function asciiLower(value: string): string {
	return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
}

// The least string above every string that starts with `prefix`, in SQLite's BINARY order (UTF-8 bytes, which is code
// point order): the prefix with its last code point incremented, null when every code point is the highest.
export function prefixEnd(prefix: string): string | null {
	const points = [...prefix].map((point) => point.codePointAt(0)!)
	while (points.length > 0) {
		const last = points.pop()!
		if (last < 0x10ffff) {
			points.push(last + 1 === 0xd800 ? 0xe000 : last + 1)
			return String.fromCodePoint(...points)
		}
	}
	return null
}

// The roles that match nothing in Kopje: every local account has one of '3' and '-99', and a remote account none.
function noRole(roleIds: readonly string[]): boolean {
	return !roleIds.includes(OWNER_ROLE.id) && !roleIds.includes(EVERYONE_ROLE.id)
}

// Whether no account can match, so the list answers [] without reading: no account is pending, disabled, silenced or
// sensitized, Kopje records no IPs and no invites, and every local account's role is Owner or everyone.
function matchesNothing(filter: AdminAccountFilter): boolean {
	return (
		(filter.status !== null && filter.status !== 'active' && filter.status !== 'suspended') ||
		filter.ip !== null ||
		filter.invitedBy !== null ||
		(filter.roleIds !== null && noRole(filter.roleIds))
	)
}

// `prefix` is already folded (ordered folds the filter's prefixes once per set).
const startsWith = (value: string, prefix: string) => asciiLower(value).startsWith(prefix)

// AccountFilter's scopes in memory, over an account the plan read, with the filter's prefixes folded (ordered).
function matches(filter: AdminAccountFilter, adminId: string, row: Candidate): boolean {
	const local = row.domain === null
	return (
		(filter.origin === null || (filter.origin === 'local') === local) &&
		(filter.status === null ||
			(filter.status === 'active' && row.unavailable === 0) ||
			(filter.status === 'suspended' && row.unavailable === 1)) &&
		(filter.roleIds === null ||
			(local && filter.roleIds.includes(row.id === adminId ? OWNER_ROLE.id : EVERYONE_ROLE.id))) &&
		(filter.username === null || startsWith(row.username, filter.username)) &&
		(filter.byDomain === null || row.domain === filter.byDomain) &&
		(filter.displayName === null || startsWith(row.display_name, filter.displayName)) &&
		(filter.email === null || (row.email !== null && startsWith(row.email, filter.email)))
	)
}

// A cursor as an 18-digit account id (ids are 18 digits, so their text order is their number order): an upper bound
// above every id is no bound, a lower one is the highest id.
function idBound(cursor: string | undefined, upper: boolean): string | null {
	if (cursor === undefined) {
		return null
	}
	if (BigInt(cursor) > 999_999_999_999_999_999n) {
		return upper ? null : '999999999999999999'
	}
	return cursor.padStart(18, '0').slice(-18)
}

type Bounds = { max: string | null; min: string | null; ascending: boolean }

function boundsOf(page: PageQuery): Bounds {
	return {
		max: idBound(page.maxId, true),
		min: idBound(page.minId ?? page.sinceId, false),
		ascending: page.minId !== undefined,
	}
}

const inBounds = (bounds: Bounds, id: string) =>
	(bounds.max === null || id < bounds.max) && (bounds.min === null || id > bounds.min)

// A complete set's matches inside the cursor, in the page's order.
function ordered(rows: readonly Candidate[], filter: AdminAccountFilter, adminId: string, bounds: Bounds): Candidate[] {
	const fold = (prefix: string | null) => (prefix === null ? null : asciiLower(prefix))
	const folded = {
		...filter,
		username: fold(filter.username),
		displayName: fold(filter.displayName),
		email: fold(filter.email),
	}
	return rows
		.filter((row) => inBounds(bounds, row.id) && matches(folded, adminId, row))
		.sort((a, b) => (a.id < b.id === bounds.ascending ? -1 : 1))
}

// The range of an id walk inside the cursor, for a query whose ?1 and ?2 are the bounds.
const ID_RANGE = 'a.id < coalesce(?1, char(58)) AND a.id > coalesce(?2, char(47))'

// The plan's matches inside the cursor, in the page's order: all of them, or at least limit + 1 when there are more;
// 'too_broad' when a search range holds more than ADMIN_ACCOUNT_CANDIDATES accounts. The first rule that applies
// drives the read (design §5); the other filters are applied to what it read.
function readMatches(
	db: Db,
	filter: AdminAccountFilter,
	adminId: string,
	bounds: Bounds,
	limit: number
): Candidate[] | 'too_broad' {
	if (filter.origin === 'local' || filter.email !== null || filter.roleIds !== null) {
		// The local accounts, an operator-sized set (a deployment assumption of about 10 accounts).
		return ordered(
			db.all<Candidate>(`SELECT ${CANDIDATE_COLUMNS} FROM local_accounts l JOIN accounts a ON a.id = l.account_id`),
			filter,
			adminId,
			bounds
		)
	}
	const search = searchRange(filter)
	if (search !== null) {
		const rows = db.all<Candidate>(
			`SELECT ${CANDIDATE_COLUMNS} FROM accounts a INDEXED BY ${search.index}
			LEFT JOIN local_accounts l ON l.account_id = a.id
			WHERE ${search.where} LIMIT ${ADMIN_ACCOUNT_CANDIDATES + 1}`,
			...search.values
		)
		return rows.length > ADMIN_ACCOUNT_CANDIDATES ? 'too_broad' : ordered(rows, filter, adminId, bounds)
	}
	const order = bounds.ascending ? 'ASC' : 'DESC'
	if (filter.status === 'suspended') {
		// The suspended local accounts (operator-sized) and the remote accounts whose deletion has started, as one range
		// of accounts_deleted in id order; merged by id.
		const local = db.all<Candidate>(
			`SELECT ${CANDIDATE_COLUMNS} FROM local_accounts l JOIN accounts a ON a.id = l.account_id
			WHERE NOT ${availableLocalSql('l')}`
		)
		const deleting = db.all<Candidate>(
			`SELECT ${CANDIDATE_COLUMNS} FROM accounts a INDEXED BY accounts_deleted
			LEFT JOIN local_accounts l ON l.account_id = a.id
			WHERE ${deletingSql('a')} AND ${ID_RANGE} ORDER BY a.id ${order} LIMIT ?3`,
			bounds.max,
			bounds.min,
			limit + 1
		)
		return ordered([...local, ...deleting], filter, adminId, bounds).slice(0, limit + 1)
	}
	// No search: the accounts by id, newest first. Active accounts walk accounts_available (migration
	// 0031_admin_accounts_available), which holds no account whose deletion has started, so the walk skips only the
	// suspended local accounts; others walk the primary key. The residual skips the local accounts (remote) and the
	// suspended local accounts (active), operator-sized sets.
	const active = filter.status === 'active'
	const residual = [
		filter.origin === 'remote' ? 'a.domain IS NOT NULL' : '1',
		active ? `${notDeletingSql('a')} AND ${availableLocalSql('l')}` : '1',
	].join(' AND ')
	return db.all<Candidate>(
		`SELECT ${CANDIDATE_COLUMNS} FROM accounts a INDEXED BY ${active ? 'accounts_available' : 'sqlite_autoindex_accounts_1'}
		LEFT JOIN local_accounts l ON l.account_id = a.id
		WHERE ${ID_RANGE} AND ${residual} ORDER BY a.id ${order} LIMIT ?3`,
		bounds.max,
		bounds.min,
		limit + 1
	)
}

// The index range a search reads, or null when the filter searches nothing: a username prefix (within a domain when
// by_domain is given), a display name prefix, or a domain. Each is a range of lowercased text from the prefix to its
// successor (prefixEnd), compared in BINARY order as the index stores it.
function searchRange(filter: AdminAccountFilter): { index: string; where: string; values: SqlStorageValue[] } | null {
	const prefix = (expression: string, value: string, at: number) => {
		const lower = asciiLower(value)
		const end = prefixEnd(lower)
		return {
			where: `${expression} >= ?${at}${end === null ? '' : ` AND ${expression} < ?${at + 1}`}`,
			values: end === null ? [lower] : [lower, end],
		}
	}
	if (filter.username !== null) {
		if (filter.byDomain !== null) {
			const range = prefix('lower(a.username)', filter.username, 2)
			return {
				index: 'accounts_domain_username',
				where: `a.domain = ?1 AND ${range.where}`,
				values: [filter.byDomain, ...range.values],
			}
		}
		return { index: 'accounts_username', ...prefix('lower(a.username)', filter.username, 1) }
	}
	if (filter.displayName !== null) {
		return { index: 'accounts_display_name', ...prefix('lower(a.display_name)', filter.displayName, 1) }
	}
	if (filter.byDomain !== null) {
		return { index: 'accounts_domain_username', where: 'a.domain = ?1', values: [filter.byDomain] }
	}
	return null
}

export type AdminAccountResult =
	| { status: 'ok'; account: AdminAccount }
	| { status: 'not_found' }
	// Mastodon's policy refusal for this account (403 "This action is not allowed").
	| { status: 'not_allowed' }

// The actions on an account that change nothing in Kopje (Api::V1::Admin::AccountsController): enable, unsilence and
// unsensitive log the action and return the account, as Mastodon does for an account not in that state (Kopje has no
// disabled, silenced or sensitized account); enable needs a local account (require_local_account!). approve and reject
// are refused (403) for every account: require_local_account! refuses a remote one, and the policy (UserPolicy#approve?,
// #reject?) an approved user, which every local account is.
export type AdminAccountAction = 'enable' | 'unsilence' | 'unsensitive' | 'approve' | 'reject'

type AdminDeclare = ReturnType<typeof adminGuarded>

// The admin's account operations over an admin guard (adminReadOperation and adminWriteOperation outside tests).
export function adminAccountOperations(read: AdminDeclare, write: AdminDeclare) {
	// GET /api/v1/admin/accounts and /api/v2/admin/accounts: newest first by id, paged by max_id, since_id and min_id
	// (Paginable#to_a_paginated_by_id). Each page is read through a plan whose range is in id order or from a set that is
	// operator-sized or capped (ADMIN_ACCOUNT_CANDIDATES), so a successful page is empty only at the true end, and
	// `more` says whether there is an older match (an ascending min_id page offers the next whenever it has accounts).
	const listAdminAccounts = read<{ filter: AdminAccountFilter; page: PageQuery; present: Present }, AdminAccountList>(
		ADMIN_PERMISSION.manageUsers,
		(db, { filter, page, present }, admin) => {
			if (matchesNothing(filter)) {
				return { status: 'ok', items: [], newest: null, oldest: null, more: false }
			}
			const bounds = boundsOf(page)
			const found = readMatches(db, filter, admin.accountId, bounds, page.limit)
			if (found === 'too_broad') {
				return { status: 'too_broad' }
			}
			const kept = found.slice(0, page.limit)
			const more = bounds.ascending
				? kept.length > 0
				: found.length > page.limit || (bounds.min !== null && kept.length > 0)
			if (bounds.ascending) {
				kept.reverse()
			}
			const ids = kept.map((row) => row.id)
			const accounts = presentAdminAccounts(db, ids, admin.accountId, present)
			return {
				status: 'ok',
				items: ids.map((id) => accounts.get(id)!),
				newest: ids[0] ?? null,
				oldest: ids.at(-1) ?? null,
				more,
			}
		}
	)

	// GET /api/v1/admin/accounts/:id (Account.find: 404 for an id that is no account's).
	const getAdminAccount = read<{ id: string; present: Present }, AdminAccountResult>(
		ADMIN_PERMISSION.manageUsers,
		(db, { id, present }, admin) => {
			const account = presentAdminAccounts(db, [id], admin.accountId, present).get(id)
			return account === undefined ? { status: 'not_found' } : { status: 'ok', account }
		}
	)

	// POST /api/v1/admin/accounts/:id/{enable,unsilence,unsensitive,approve,reject}.
	const actOnAdminAccount = write<{ id: string; action: AdminAccountAction; present: Present }, AdminAccountResult>(
		ADMIN_PERMISSION.manageUsers,
		(db, { id, action, present }, admin) => {
			const account = presentAdminAccounts(db, [id], admin.accountId, present).get(id)
			if (account === undefined) {
				return { status: 'not_found' }
			}
			if (action === 'approve' || action === 'reject' || (action === 'enable' && account.domain !== null)) {
				return { status: 'not_allowed' }
			}
			logAction(db, admin, action, { type: 'Account', id }, {}, admin.now)
			return { status: 'ok', account }
		}
	)

	// POST /api/v1/admin/accounts/:account_id/action (Admin::AccountAction#save!), in its order: the account (404), the
	// type (422), the policy (403: no action targets the OAuth admin's own account, as Mastodon's role.overrides? refuses
	// the Owner acting on the Owner), then the report named (404).
	//   - none resolves the report named, if any (process_reports!); nothing else.
	//   - suspend on a local account suspends it (domain/suspension.ts): its reports, frozen at the suspension, are
	//     resolved by the suspension job, as process_reports! resolves every unresolved report on the target.
	//   - suspend on a remote account answers 422: remote suspension is not served yet.
	//   - disable, sensitive and silence answer 422 as a type outside the list would, so the client sees a failed action
	//     rather than a silent no-op: Kopje has no disabling, sensitizing or silencing.
	//   - text and warning_preset_id are accepted and dropped: Kopje keeps no strikes and sends no warning, as Mastodon
	//     sends none to a remote target (warnable? is local only).
	const actOnAccount = write<{ id: string; type: string | null; reportId: string | null }, AccountActionResult>(
		ADMIN_PERMISSION.manageUsers,
		(db, { id, type, reportId }, admin) => {
			const account = db.first<{ id: string; domain: string | null }>(
				'SELECT id, domain FROM accounts WHERE id = ?',
				id
			)
			if (account === undefined) {
				return { status: 'not_found' }
			}
			if (type === null) {
				return { status: 'invalid', error: "Validation failed: Type can't be blank, Type is not included in the list" }
			}
			if (type !== 'none' && type !== 'suspend') {
				return { status: 'invalid', error: 'Validation failed: Type is not included in the list' }
			}
			if (account.id === admin.accountId) {
				return { status: 'not_allowed' }
			}
			if (type === 'suspend' && account.domain !== null) {
				return { status: 'invalid', error: REMOTE_SUSPENSION }
			}
			if (type === 'none') {
				// resolveReport writes nothing when the report is missing.
				return reportId === null || resolveReport(db, reportId, admin) ? { status: 'ok' } : { status: 'not_found' }
			}
			if (reportId !== null && !reportExists(db, reportId)) {
				return { status: 'not_found' }
			}
			const at = suspendLocal(db, account.id, admin.accountId, admin.now)
			logAction(db, admin, 'suspend', { type: 'Account', id: account.id }, { suspended_at: at }, admin.now)
			return { status: 'ok' }
		}
	)

	// POST /api/v1/admin/accounts/:id/unsuspend (AccountPolicy#unsuspend?: a local suspension only): a remote account,
	// or a local one that is not suspended, is refused (403). The OAuth admin is never suspended (it is no admin then).
	const unsuspendAdminAccount = write<{ id: string; present: Present }, AdminAccountResult>(
		ADMIN_PERMISSION.manageUsers,
		(db, { id, present }, admin) => {
			const found = db.first<{ domain: string | null }>('SELECT domain FROM accounts WHERE id = ?', id)
			if (found === undefined) {
				return { status: 'not_found' }
			}
			if (found.domain !== null || !unsuspendLocal(db, id, admin.now)) {
				return { status: 'not_allowed' }
			}
			logAction(db, admin, 'unsuspend', { type: 'Account', id }, {}, admin.now)
			return { status: 'ok', account: presentAdminAccounts(db, [id], admin.accountId, present).get(id)! }
		}
	)

	return { listAdminAccounts, getAdminAccount, actOnAdminAccount, actOnAccount, unsuspendAdminAccount }
}

// The answer to a suspend action on a remote account until remote suspension is served.
export const REMOTE_SUSPENSION = 'Remote accounts cannot be suspended yet'

export type AccountActionResult =
	| { status: 'ok' }
	| { status: 'not_found' }
	| { status: 'not_allowed' }
	// 422 with Mastodon's validation message.
	| { status: 'invalid'; error: string }

export const { listAdminAccounts, getAdminAccount, actOnAdminAccount, actOnAccount, unsuspendAdminAccount } =
	adminAccountOperations(adminReadOperation, adminWriteOperation)
