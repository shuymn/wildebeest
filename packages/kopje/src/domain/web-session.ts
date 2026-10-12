import { type CredentialAccount, credentialAccount, type Present } from './accounts'
import { authorize, type AuthFailure, type Authorized, type UserCredential, type UserViewer } from './auth'
import { consumeCode, insertAccessToken, webClientId, WEB_CLIENT_SETTING } from './oauth'
import { readOperation, sessionOperation } from './operation'
import type { Db } from '../db/sql'
import type { StoreOperation } from '../platform/store-kernel'

// Web sessions (AUTH, WEB-4). The web UI is an ordinary OAuth client of the instance (design: "the built-in UI is a
// normal OAuth client"): Access verifies the person at /oauth/authorize, the consent page issues a PKCE-bound code to
// the web client's callback, and the callback exchanges it here for an access token of the web client, which the
// browser keeps as an opaque HttpOnly cookie. So a session is a row of oauth_tokens: stored as its SHA-256 only
// (AUTH-7), checked in the transaction of every operation it authorizes (AUTH-1), refused once the account is
// suspended, ended by logout, by expiry (SESSION_LIFETIME_MS, fixed from login) and by "sign out other sessions", and
// listed with the user's authorizations.
//
// The web client has no usable secret: its callback runs in this Worker and exchanges the code with the Store directly,
// and the code is bound to the PKCE challenge whose verifier only the browser's login cookie holds. Its client id is
// recorded in instance_settings (WEB_CLIENT_SETTING).

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

// What the web client may do: read and edit the profile, and upload its images. Nothing else of the API.
export const WEB_SCOPES = ['read:accounts', 'write:accounts', 'write:media']

export type EnsureWebClientInput = { clientId: string; secret: string; redirectUri: string; now: number }

// The web client's id, created on first use. Its redirect URI follows the fixed domain the caller derives it from.
export const ensureWebClient = sessionOperation<EnsureWebClientInput, string>((db, input) => {
	const existing = webClientId(db)
	if (existing !== null && db.first('SELECT 1 AS found FROM oauth_clients WHERE id = ?', existing) !== undefined) {
		db.run(
			'UPDATE oauth_clients SET redirect_uris = ?, scopes = ? WHERE id = ?',
			input.redirectUri,
			WEB_SCOPES.join(' '),
			existing
		)
		return existing
	}
	db.run(
		`INSERT INTO oauth_clients (id, secret, name, redirect_uris, website, scopes, created_at)
		VALUES (?, ?, 'Kopje', ?, NULL, ?, ?)`,
		input.clientId,
		input.secret,
		input.redirectUri,
		WEB_SCOPES.join(' '),
		new Date(input.now).toISOString()
	)
	db.run('INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)', WEB_CLIENT_SETTING, input.clientId)
	return input.clientId
})

export type StartSessionInput = {
	codeHash: string
	redirectUri: string
	verifierChallenge: string
	tokenHash: string
	// The session this browser already had, if any: it ends with the new login, so a login never keeps two.
	previousTokenHash: string | null
	now: number
}

// The callback: consumes the code of the web client (once, even on failure) and starts a session. The code must be
// PKCE-bound and match the verifier from the login cookie, so a code obtained for another browser's login, or one
// injected without the cookie, starts nothing (session fixation and login CSRF).
export const startWebSession = sessionOperation<StartSessionInput, { status: 'ok' } | { status: 'invalid_grant' }>(
	(db, input) => {
		const clientId = webClientId(db)
		if (clientId === null) {
			return { status: 'invalid_grant' }
		}
		const grant = consumeCode(db, { ...input, clientId })
		if (grant === null) {
			return { status: 'invalid_grant' }
		}
		if (input.previousTokenHash !== null) {
			endSession(db, clientId, input.previousTokenHash)
		}
		insertAccessToken(
			db,
			input.tokenHash,
			clientId,
			grant.accountId,
			grant.scopes,
			new Date(input.now).toISOString(),
			new Date(input.now + SESSION_LIFETIME_MS).toISOString()
		)
		return { status: 'ok' }
	}
)

function endSession(db: Db, clientId: string, tokenHash: string): void {
	db.run("DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ? AND kind = 'access'", tokenHash, clientId)
}

// Logout: the session's token is deleted, so the cookie, if replayed, authenticates nothing. Ending an unknown
// session succeeds without effect.
export const endWebSession = sessionOperation<{ tokenHash: string }, void>((db, { tokenHash }) => {
	const clientId = webClientId(db)
	if (clientId !== null) {
		endSession(db, clientId, tokenHash)
	}
})

// Operations of the web UI only: the credential must be a live session of the web client, so an API token (even one
// with the same scopes) cannot list or revoke the user's authorizations.
function webOperation<I, O>(
	declare: typeof readOperation,
	run: (db: Db, input: I & { credential: UserCredential }, viewer: UserViewer, clientId: string) => O
): StoreOperation<I & { credential: UserCredential }, Authorized<O>> {
	return declare<I & { credential: UserCredential }, Authorized<O>>((db, input) => {
		const auth = authorize(db, input.credential)
		if (auth.status !== 'ok') {
			return auth
		}
		const clientId = webClientId(db)
		if (clientId === null || auth.viewer.client.id !== clientId || auth.viewer.accountId === null) {
			return { status: 'unauthenticated' } satisfies AuthFailure
		}
		return { status: 'ok', value: run(db, input, auth.viewer as UserViewer, clientId) }
	})
}

export type Authorization = {
	clientId: string
	name: string
	website: string | null
	scopes: string[]
	authorizedAt: string
}

export type Authorizations = { apps: Authorization[]; otherSessions: number }

// The apps the user has authorized (live tokens and pending codes, per app), as Mastodon's "Authorized apps" lists
// them, and how many other web sessions the user has.
function authorizationsOf(
	db: Db,
	accountId: string,
	webClient: string,
	tokenHash: string,
	now: number
): Authorizations {
	const nowIso = new Date(now).toISOString()
	const rows = db.all<{ id: string; name: string; website: string | null; scopes: string; authorized_at: string }>(
		`SELECT c.id, c.name, c.website, group_concat(t.scopes, ' ') AS scopes, min(t.created_at) AS authorized_at
		FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
		WHERE t.account_id = ?1 AND t.client_id <> ?2 AND (t.expires_at IS NULL OR t.expires_at > ?3)
		GROUP BY c.id ORDER BY authorized_at, c.id`,
		accountId,
		webClient,
		nowIso
	)
	const others = db.first<{ n: number }>(
		`SELECT COUNT(*) AS n FROM oauth_tokens WHERE account_id = ? AND client_id = ? AND kind = 'access'
			AND token_hash <> ? AND (expires_at IS NULL OR expires_at > ?)`,
		accountId,
		webClient,
		tokenHash,
		nowIso
	)
	return {
		apps: rows.map((row) => ({
			clientId: row.id,
			name: row.name,
			website: row.website,
			scopes: [...new Set(row.scopes.split(' ').filter((scope) => scope !== ''))].sort(),
			authorizedAt: row.authorized_at,
		})),
		otherSessions: others?.n ?? 0,
	}
}

export type SettingsData = { account: CredentialAccount; authorizations: Authorizations }

// Everything the settings page shows, in one read: the profile as the owner edits it, and the authorizations.
export const settingsView = webOperation<{ now: number; present: Present }, SettingsData | null>(
	readOperation,
	(db, { credential, now, present }, { accountId }, webClient) => {
		const account = credentialAccount(db, accountId, present)
		return account === null
			? null
			: { account, authorizations: authorizationsOf(db, accountId, webClient, credential.tokenHash, now) }
	}
)

// Revokes every token and code the user gave one app (AUTH-6: only the viewer's own). The web client is not an app
// here; its sessions end by logout or revokeOtherSessions.
export const revokeAuthorization = webOperation<{ clientId: string }, number>(
	sessionOperation,
	(db, { clientId }, { accountId }, webClient) =>
		clientId === webClient
			? 0
			: db.all(
					'DELETE FROM oauth_tokens WHERE account_id = ? AND client_id = ? RETURNING token_hash',
					accountId,
					clientId
				).length
)

// Ends every web session of the user but the current one.
export const revokeOtherSessions = webOperation<object, number>(
	sessionOperation,
	(db, { credential }, { accountId }, webClient) =>
		db.all(
			`DELETE FROM oauth_tokens WHERE account_id = ? AND client_id = ? AND token_hash <> ? RETURNING token_hash`,
			accountId,
			webClient,
			credential.tokenHash
		).length
)
