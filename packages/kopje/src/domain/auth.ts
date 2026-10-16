import { adminAccountId } from './admin-authority'
import type { ViewerContext } from './audience'
import { mediaDeleteOperation, readOperation, sessionOperation, writeOperation } from './operation'
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

// One indexed lookup by the token's sha256. A suspended account's tokens are refused even if one survived the
// suspension.
export function authorize(db: Db, credential: Credential): AuthFailure | { status: 'ok'; viewer: Viewer } {
	const row = db.first<{
		scopes: string
		account_id: string | null
		expires_at: string | null
		client_id: string
		name: string
		website: string | null
		suspended_at: string | null
	}>(
		`SELECT t.scopes, t.account_id, t.expires_at, c.id AS client_id, c.name, c.website, l.suspended_at
		FROM oauth_tokens t
		JOIN oauth_clients c ON c.id = t.client_id
		LEFT JOIN local_accounts l ON l.account_id = t.account_id
		WHERE t.token_hash = ? AND t.kind = 'access'`,
		credential.tokenHash
	)
	if (row === undefined || (row.expires_at !== null && row.expires_at <= new Date(credential.now).toISOString())) {
		return { status: 'unauthenticated' }
	}
	if (row.suspended_at !== null) {
		return { status: 'suspended' }
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

// The only place a ViewerContext is made: the viewer a credential names (or none), judged at its request time.
function contextOf<A extends string | null>(accountId: A, now: number): ViewerContext & { readonly accountId: A } {
	return { accountId, now: new Date(now).toISOString() }
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

// Checks a credential without doing anything else: lets the Worker answer an authentication failure before a
// request error it found on its own, as Mastodon does.
export const checkCredential = readOperation<Credential, Authorized<Viewer>>((db, credential) => {
	const auth = authorize(db, credential)
	return auth.status === 'ok' ? { status: 'ok', value: auth.viewer } : auth
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
// once the whole group is served; until then its routes refuse the admin as they refuse everyone.
export const ADMIN_PERMISSIONS = 0

// The OAuth admin acting through an admin route: its account, the client it acts through, and the request time.
export type Admin = { accountId: string; clientId: string; now: number }

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
				value: run(db, input, { accountId: viewer.accountId, clientId: viewer.client.id, now: viewer.now }),
			}
		})
}

export const adminReadOperation = adminGuarded(readOperation, ADMIN_PERMISSIONS)
export const adminWriteOperation = adminGuarded(writeOperation, ADMIN_PERMISSIONS)
