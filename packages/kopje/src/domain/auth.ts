import { mediaDeleteOperation, readOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'
import type { StoreOperation } from '../platform/store-kernel'
import { grants, type Scope } from '../security/scopes'

// Token validation for API requests (design §4: "token validation and the operation in the same RPC"). A protected
// operation takes the request's credential and checks it in the transaction that runs the operation, so a token
// revoked, or an account suspended, before the operation commits cannot act. The Worker's access middleware only
// reads the bearer token and declares the route's scope.

// The caller of an API request. accountId is null for an app token (client_credentials).
export type Viewer = {
	tokenHash: string
	scopes: string[]
	accountId: string | null
	client: { id: string; name: string; website: string | null }
}

export type UserViewer = Viewer & { accountId: string }

// What a request presents: the sha256 of its bearer token, the scope its route requires (null: any valid token,
// app tokens included), and the request time.
export type Credential = { tokenHash: string; scope: Scope | null; now: number }

// A route that requires a scope also requires a user.
export type UserCredential = Credential & { scope: Scope }

export type AuthFailure =
	| { status: 'unauthenticated' }
	| { status: 'suspended' }
	| { status: 'insufficient_scope' }
	| { status: 'user_required' }

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
		if (!grants(scopes, credential.scope)) {
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
		},
	}
}

type Declare = typeof readOperation

function guarded(declare: Declare) {
	return <I, O>(
		run: (db: Db, input: I, viewer: UserViewer) => O
	): StoreOperation<I & { credential: UserCredential }, Authorized<O>> =>
		declare<I & { credential: UserCredential }, Authorized<O>>((db, input) => {
			const auth = authorize(db, input.credential)
			if (auth.status !== 'ok') {
				return auth
			}
			// authorize() refuses a token without an account when a scope is required.
			return { status: 'ok', value: run(db, input, auth.viewer as UserViewer) }
		})
}

// Operations of a signed-in user, under the scope of the route.
export const userReadOperation = guarded(readOperation)
export const userWriteOperation = guarded(writeOperation)
export const userMediaDeleteOperation = guarded(mediaDeleteOperation)

// Checks a credential without doing anything else: lets the Worker answer an authentication failure before a
// request error it found on its own, as Mastodon does.
export const checkCredential = readOperation<Credential, Authorized<Viewer>>((db, credential) => {
	const auth = authorize(db, credential)
	return auth.status === 'ok' ? { status: 'ok', value: auth.viewer } : auth
})

// Operations of a route whose token is optional (Mastodon's authorize_if_got_token!): no credential reads as an
// anonymous viewer; a credential must be valid and cover the route's scope (if it declares one), and an app token (no
// user) is anonymous.
export function optionalUserReadOperation<I, O>(
	run: (db: Db, input: I, viewerId: string | null) => O
): StoreOperation<I & { credential: Credential | null }, Authorized<O>> {
	return readOperation<I & { credential: Credential | null }, Authorized<O>>((db, input) => {
		if (input.credential === null) {
			return { status: 'ok', value: run(db, input, null) }
		}
		const auth = authorize(db, input.credential)
		if (auth.status === 'user_required') {
			return { status: 'ok', value: run(db, input, null) }
		}
		if (auth.status !== 'ok') {
			return auth
		}
		return { status: 'ok', value: run(db, input, auth.viewer.accountId) }
	})
}
