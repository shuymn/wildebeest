import { adminAccountId, adminAccountIdOnce } from './admin-authority'
import type { ViewerContext } from './audience'
import { mediaDeleteOperation, readOperation, sessionOperation, writeOperation } from './operation'
import { LOCAL_ACCOUNTS_ID_INDEX, OAUTH_CLIENTS_ID_INDEX } from '../db/indexes'
import type { Db } from '../db/sql'
import type { StoreOperation } from '../platform/store-kernel'
import { grantsAny, type RequiredScope } from '../security/scopes'

// Token validation for API requests (design §4: "token validation and the operation in the same RPC"). A protected
// operation takes the request's credential and checks it in the transaction that runs the operation, so a token
// revoked, or an account suspended, before the operation commits cannot act. The Worker's access middleware only
// reads the bearer token and declares the route's scope.

// The caller of an API request. accountId is null for an app token (client_credentials). now is the request time
// (the credential's), which time-bound state such as a mute's expiry is judged at.
export type Viewer = {
	tokenHash: string
	scopes: string[]
	accountId: string | null
	client: { id: string; name: string; website: string | null }
	now: number
}

export type UserViewer = Viewer & { accountId: string }

// What a request presents: the sha256 of its bearer token, the scope its route requires (any one of them if several;
// null: any valid token, app tokens included), and the request time.
export type Credential = { tokenHash: string; scope: RequiredScope | null; now: number }

// A route that requires a scope also requires a user.
export type UserCredential = Credential & { scope: RequiredScope }

export type AuthFailure =
	| { status: 'unauthenticated' }
	| { status: 'suspended' }
	| { status: 'insufficient_scope' }
	| { status: 'user_required' }
	// An admin operation's refusal (adminReadOperation): the caller is not the OAuth admin, or Kopje does not grant the
	// route's permission. Mastodon's 403 "This action is not allowed".
	| { status: 'forbidden' }

export type Authorized<O> = AuthFailure | { status: 'ok'; value: O }

// The credential epoch (migration 0034_admin_suspension): whether the credential `t` (an oauth_tokens row: an access
// token, a code or a web session) was issued in its account's current epoch, local_accounts.credential_epoch, read by
// key. Every insert stamps the account's epoch (CREDENTIAL_EPOCH_SQL) and a suspension increments it, in their
// transactions, so every credential issued before a suspension is refused from its commit on, also after an
// unsuspension (which keeps the epoch), with no clock involved, while the tokens job deletes them in rounds
// (domain/suspension.ts). An app token has no account and no epoch.
export function currentCredentialSql(t: string): string {
	return `NOT EXISTS (SELECT 1 FROM main.local_accounts fl WHERE fl.account_id = ${t}.account_id
		AND fl.credential_epoch <> ${t}.epoch)`
}

// The epoch a credential of the account bound to `?` is stamped with when it is inserted: its current one, 0 for an
// app token.
export const CREDENTIAL_EPOCH_SQL =
	'coalesce((SELECT credential_epoch FROM main.local_accounts WHERE account_id = ?), 0)'

// One indexed lookup by the token's sha256, then its client and account by key, the join order pinned so stale
// statistics cannot pick a scan of either (RES-7; test/activity.test.ts). A suspended account's tokens are refused even
// if one survived the suspension, and a token of an earlier epoch is refused as invalid (currentCredentialSql).
export function authorize(db: Db, credential: Credential): AuthFailure | { status: 'ok'; viewer: Viewer } {
	const row = db.first<{
		scopes: string
		account_id: string | null
		expires_at: string | null
		client_id: string
		name: string
		website: string | null
		suspended_at: string | null
		stale: number
	}>(
		`SELECT t.scopes, t.account_id, t.expires_at, c.id AS client_id, c.name, c.website, l.suspended_at,
			coalesce(t.epoch <> l.credential_epoch, 0) AS stale
		FROM oauth_tokens t
		CROSS JOIN oauth_clients c INDEXED BY ${OAUTH_CLIENTS_ID_INDEX} ON c.id = t.client_id
		LEFT JOIN local_accounts l INDEXED BY ${LOCAL_ACCOUNTS_ID_INDEX} ON l.account_id = t.account_id
		WHERE t.token_hash = ? AND t.kind = 'access'`,
		credential.tokenHash
	)
	if (row === undefined || (row.expires_at !== null && row.expires_at <= new Date(credential.now).toISOString())) {
		return { status: 'unauthenticated' }
	}
	if (row.suspended_at !== null) {
		return { status: 'suspended' }
	}
	if (row.stale === 1) {
		return { status: 'unauthenticated' }
	}
	const scopes = row.scopes.split(' ')
	if (credential.scope !== null) {
		if (!grantsAny(scopes, credential.scope)) {
			return { status: 'insufficient_scope' }
		}
		if (row.account_id === null) {
			return { status: 'user_required' }
		}
	}
	return {
		status: 'ok',
		viewer: {
			tokenHash: credential.tokenHash,
			scopes,
			accountId: row.account_id,
			client: { id: row.client_id, name: row.name, website: row.website },
			now: credential.now,
		},
	}
}

// The viewer context of a signed-in user.
export type UserContext = ViewerContext & { readonly accountId: string }

// The only place a ViewerContext is made: the viewer a credential names (or none), judged at its request time, or
// another account seen by the OAuth admin (viewerOf).
function contextOf<A extends string | null>(accountId: A, now: number): ViewerContext & { readonly accountId: A } {
	return { accountId, now: new Date(now).toISOString() }
}

// The tokens of one account's streaming sockets (domain/streaming.ts), checked in the transaction that makes a message
// (R33, VIS-26): the scopes of each token still valid and still the account's, and the account's context when any is.
export function authorizeStream(
	db: Db,
	accountId: string,
	tokenHashes: readonly string[],
	now: number
): { scopes: Map<string, string[]>; context: UserContext | null } {
	const scopes = new Map<string, string[]>()
	for (const tokenHash of tokenHashes) {
		const auth = authorize(db, { tokenHash, scope: null, now })
		if (auth.status === 'ok' && auth.viewer.accountId === accountId) {
			scopes.set(tokenHash, auth.viewer.scopes)
		}
	}
	return { scopes, context: scopes.size === 0 ? null : contextOf(accountId, now) }
}

type Declare = typeof readOperation

function guarded(declare: Declare) {
	return <I, O>(
		run: (db: Db, input: I, viewer: UserViewer, context: UserContext) => O
	): StoreOperation<I & { credential: UserCredential }, Authorized<O>> =>
		declare<I & { credential: UserCredential }, Authorized<O>>((db, input) => {
			const auth = authorize(db, input.credential)
			if (auth.status !== 'ok') {
				return auth
			}
			// authorize() refuses a token without an account when a scope is required.
			const viewer = auth.viewer as UserViewer
			return { status: 'ok', value: run(db, input, viewer, contextOf(viewer.accountId, viewer.now)) }
		})
}

// Operations of a signed-in user, under the scope of the route.
export const userReadOperation = guarded(readOperation)
export const userWriteOperation = guarded(writeOperation)
// Web Push registration: still served while the Store is readonly, as sign-ins are.
export const userSessionOperation = guarded(sessionOperation)
export const userMediaDeleteOperation = guarded(mediaDeleteOperation)

// Operations of a route that declares no scope but serves only a user (Mastodon's require_user! without
// doorkeeper_authorize!): any valid token of a user, whatever its scopes; an app token answers user_required.
export function tokenUserReadOperation<I, O>(
	run: (db: Db, input: I, viewer: UserViewer, context: UserContext) => O
): StoreOperation<I & { credential: Credential }, Authorized<O>> {
	return readOperation<I & { credential: Credential }, Authorized<O>>((db, input) => {
		const auth = authorize(db, input.credential)
		if (auth.status !== 'ok') {
			return auth
		}
		if (auth.viewer.accountId === null) {
			return { status: 'user_required' }
		}
		const viewer = auth.viewer as UserViewer
		return { status: 'ok', value: run(db, input, viewer, contextOf(viewer.accountId, viewer.now)) }
	})
}

// Checks a credential without doing anything else: lets the Worker answer an authentication failure before a
// request error it found on its own, as Mastodon does.
export const checkCredential = readOperation<Credential, Authorized<Viewer>>((db, credential) => {
	const auth = authorize(db, credential)
	return auth.status === 'ok' ? { status: 'ok', value: auth.viewer } : auth
})

// RES-6: records the UTC day of a user's authenticated API or web request (local_accounts.active_on, migration
// 0059_contact_and_activity), as Mastodon's UserTrackingConcern records a sign-in, for the instance's
// usage.users.active_month (instance.ts). A session operation, admitted while the Store is readonly. The day only
// moves forward and an equal or later stamp writes nothing, so an account's row is written at most once per UTC day
// whichever token or isolate asks, and a delayed request of an earlier day never moves it back. An invalid, expired
// or stale token, a suspended account and an app token write nothing. Both seeks are by key (the token, then the
// account). No stream turn follows it (StreamHub#written skips it).
export const noteActivity = sessionOperation<{ tokenHash: string; now: number }, void>((db, { tokenHash, now }) => {
	const auth = authorize(db, { tokenHash, scope: null, now })
	if (auth.status !== 'ok' || auth.viewer.accountId === null) {
		return
	}
	db.run(
		'UPDATE local_accounts SET active_on = ?1 WHERE account_id = ?2 AND (active_on IS NULL OR active_on < ?1)',
		new Date(now).toISOString().slice(0, 10),
		auth.viewer.accountId
	)
})

// Operations of a route whose token is optional (Mastodon's authorize_if_got_token!): no credential reads as an
// anonymous viewer; a credential must be valid and cover the route's scope (if it declares one), and an app token (no
// user) is anonymous. The context's time is the credential's request time, or the request time the input carries
// when there is no credential.
export function optionalUserReadOperation<I, O>(
	run: (db: Db, input: I, context: ViewerContext) => O
): StoreOperation<I & { credential: Credential | null; now: number }, Authorized<O>> {
	return readOperation<I & { credential: Credential | null; now: number }, Authorized<O>>((db, input) => {
		if (input.credential === null) {
			return { status: 'ok', value: run(db, input, contextOf(null, input.now)) }
		}
		const { now } = input.credential
		const auth = authorize(db, input.credential)
		if (auth.status === 'user_required') {
			return { status: 'ok', value: run(db, input, contextOf(null, now)) }
		}
		if (auth.status !== 'ok') {
			return auth
		}
		return { status: 'ok', value: run(db, input, contextOf(auth.viewer.accountId, now)) }
	})
}

// Mastodon's permission bits (app/models/user_role.rb) of the admin API's route groups.
export const ADMIN_PERMISSION = {
	viewDashboard: 8,
	manageReports: 16,
	manageFederation: 32,
	manageBlocks: 128,
	manageTaxonomies: 256,
	manageUsers: 1024,
	deleteUserData: 524288,
} as const

export type AdminPermission = (typeof ADMIN_PERMISSION)[keyof typeof ADMIN_PERMISSION]

// The permissions of the OAuth admin's role: the bits of the route groups Kopje serves. A group's bit is set only
// once the whole group is served; until then its routes refuse the admin as they refuse everyone. Served: reports
// (manage_reports), accounts (manage_users, with local and remote suspension), domain blocks and allows
// (manage_federation) and the dashboard's metrics (view_dashboard, domain/admin-measures.ts): 1080.
export const ADMIN_PERMISSIONS: number =
	ADMIN_PERMISSION.manageReports |
	ADMIN_PERMISSION.manageUsers |
	ADMIN_PERMISSION.manageFederation |
	ADMIN_PERMISSION.viewDashboard

// A role as Mastodon's REST::RoleSerializer presents it (permissions is a string).
export type Role = { id: string; name: string; permissions: string; color: string; highlighted: boolean }

// The OAuth admin's role: Mastodon's Owner (id 3 on a default install, db/seeds/03_roles.rb), with exactly the
// permissions Kopje serves. Not `administrator` (bit 1), which implies every permission (UserRole#can?).
export const OWNER_ROLE: Role = {
	id: '3',
	name: 'Owner',
	permissions: String(ADMIN_PERMISSIONS),
	color: '',
	highlighted: true,
}

// Every other local account's role: Mastodon's default (everyone) role, id -99.
export const EVERYONE_ROLE: Role = { id: '-99', name: '', permissions: '0', color: '', highlighted: false }

// The role a local account's credential account presents: Owner for the OAuth admin, read in the transaction that
// presents it through the operation's one lookup (adminAccountIdOnce, which its `roles` shares), and the everyone role
// for every other one.
export function localRole(db: Db, accountId: string): Role {
	return accountId === adminAccountIdOnce(db) ? OWNER_ROLE : EVERYONE_ROLE
}

// The OAuth admin acting through an admin route: its account, the client it acts through, the request time, and the
// admin as a viewer at that time.
export type Admin = { accountId: string; clientId: string; now: number; context: UserContext }

// R32's capture (streaming.ts streamDelete): an account listening on a list stream as a viewer at the time of the
// delete, for its lists' reads positioned at the deleted status.
export function listenerContext(accountId: string, now: number): UserContext {
	return contextOf(accountId, now)
}

// R37: another account as a viewer at the admin's request time, for what the admin is shown only while that account
// may still see it (the statuses a report names, as its reporter sees them: domain/reports.ts).
export function viewerOf(admin: Admin, accountId: string): UserContext {
	return contextOf(accountId, admin.now)
}

// Operations of the Mastodon admin API (R37, VIS-29). The route's token is optional (Mastodon's
// authorize_if_got_token!): a token sent must be valid and cover the route's admin scope, and then, in the same
// transaction, the caller must be the OAuth admin (adminAccountId, read here, so tokens follow the current match) and
// `granted` must hold the route's permission. Anyone else, an anonymous caller and an app token included, is refused
// with `forbidden`, as Mastodon's policies refuse a role without the permission. `granted` is ADMIN_PERMISSIONS
// outside tests.
export function adminGuarded(declare: Declare, granted: number) {
	return <I, O>(
		permission: AdminPermission,
		run: (db: Db, input: I, admin: Admin) => O
	): StoreOperation<I & { credential: UserCredential | null }, Authorized<O>> =>
		declare<I & { credential: UserCredential | null }, Authorized<O>>((db, input) => {
			if (input.credential === null) {
				return { status: 'forbidden' }
			}
			const auth = authorize(db, input.credential)
			if (auth.status === 'user_required') {
				return { status: 'forbidden' }
			}
			if (auth.status !== 'ok') {
				return auth
			}
			const { viewer } = auth
			if (viewer.accountId === null || viewer.accountId !== adminAccountId(db) || (granted & permission) === 0) {
				return { status: 'forbidden' }
			}
			return {
				status: 'ok',
				value: run(db, input, {
					accountId: viewer.accountId,
					clientId: viewer.client.id,
					now: viewer.now,
					context: contextOf(viewer.accountId, viewer.now),
				}),
			}
		})
}

export const adminReadOperation = adminGuarded(readOperation, ADMIN_PERMISSIONS)
export const adminWriteOperation = adminGuarded(writeOperation, ADMIN_PERMISSIONS)
