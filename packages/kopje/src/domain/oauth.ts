import { readOperation, sessionOperation, writeOperation } from './operation'
import type { Db } from '../db/sql'
import { withinScopes } from '../security/scopes'
import { constantTimeEqual } from '../security/tokens'

// OAuth state (design §4, 認証): clients, authorization codes and access tokens. Codes and tokens are stored as the
// sha256 of their opaque value, which the Worker computes; the values never reach the Store. Login writes are
// session operations, so they still work while the Store is readonly.

export const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob'

export const CODE_LIFETIME_MS = 10 * 60 * 1000

export type Client = { id: string; name: string; website: string | null; redirectUris: string[]; scopes: string[] }

type ClientRow = {
	id: string
	secret: string
	name: string
	redirect_uris: string
	website: string | null
	scopes: string
}

function toClient(row: ClientRow): Client {
	return {
		id: row.id,
		name: row.name,
		website: row.website,
		redirectUris: row.redirect_uris.split('\n').filter((uri) => uri !== ''),
		scopes: row.scopes.split(' ').filter((scope) => scope !== ''),
	}
}

function clientRow(db: Db, clientId: string): ClientRow | undefined {
	return db.first<ClientRow>(
		'SELECT id, secret, name, redirect_uris, website, scopes FROM oauth_clients WHERE id = ?',
		clientId
	)
}

// A client authenticated by its secret, or undefined.
function authenticateClient(db: Db, clientId: string, secret: string): ClientRow | undefined {
	const row = clientRow(db, clientId)
	return row !== undefined && constantTimeEqual(row.secret, secret) ? row : undefined
}

export type RegisterAppInput = {
	clientId: string
	secret: string
	name: string
	redirectUris: string[]
	website: string | null
	scopes: string[]
	now: number
}

export const registerApp = sessionOperation<RegisterAppInput, Client>((db, input) => {
	db.run(
		'INSERT INTO oauth_clients (id, secret, name, redirect_uris, website, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		input.clientId,
		input.secret,
		input.name,
		input.redirectUris.join('\n'),
		input.website,
		input.scopes.join(' '),
		new Date(input.now).toISOString()
	)
	return toClient(clientRow(db, input.clientId)!)
})

// The caller of an API request. accountId is null for an app token (client_credentials).
export type Viewer = {
	tokenHash: string
	scopes: string[]
	accountId: string | null
	client: { id: string; name: string; website: string | null }
}

export type Authentication = { status: 'ok'; viewer: Viewer } | { status: 'invalid' } | { status: 'suspended' }

// Token validation: one indexed lookup by the token's sha256. A suspended account's tokens are refused even if one
// survived the suspension.
export const authenticate = readOperation<{ tokenHash: string; now: number }, Authentication>(
	(db, { tokenHash, now }) => {
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
			tokenHash
		)
		if (row === undefined || (row.expires_at !== null && row.expires_at <= new Date(now).toISOString())) {
			return { status: 'invalid' }
		}
		if (row.suspended_at !== null) {
			return { status: 'suspended' }
		}
		return {
			status: 'ok',
			viewer: {
				tokenHash,
				scopes: row.scopes.split(' '),
				accountId: row.account_id,
				client: { id: row.client_id, name: row.name, website: row.website },
			},
		}
	}
)

// instance_settings names written by /setup step 3.
export const ACCESS_TEAM_DOMAIN = 'access_team_domain'
export const ACCESS_AUD = 'access_aud'

// What /oauth/authorize needs before it can verify the Access assertion: the Access settings and the client.
export const authorizeContext = readOperation<
	{ clientId: string },
	{ access: { teamDomain: string; aud: string } | null; client: Client | null }
>((db, { clientId }) => {
	const settings = new Map(
		db
			.all<{
				name: string
				value: string
			}>('SELECT name, value FROM instance_settings WHERE name IN (?, ?)', ACCESS_TEAM_DOMAIN, ACCESS_AUD)
			.map((row) => [row.name, row.value])
	)
	const teamDomain = settings.get(ACCESS_TEAM_DOMAIN)
	const aud = settings.get(ACCESS_AUD)
	const client = clientRow(db, clientId)
	return {
		access: teamDomain === undefined || aud === undefined ? null : { teamDomain, aud },
		client: client === undefined ? null : toClient(client),
	}
})

export type LoginAccount =
	| { status: 'ok'; accountId: string; username: string }
	| { status: 'no_account' }
	| { status: 'suspended' }

function loginAccount(db: Db, email: string): LoginAccount {
	const row = db.first<{ account_id: string; username: string; suspended_at: string | null }>(
		`SELECT l.account_id, a.username, l.suspended_at
		FROM local_accounts l JOIN accounts a ON a.id = l.account_id
		WHERE lower(l.email) = lower(?)`,
		email
	)
	if (row === undefined) {
		return { status: 'no_account' }
	}
	return row.suspended_at === null
		? { status: 'ok', accountId: row.account_id, username: row.username }
		: { status: 'suspended' }
}

// The local account an Access identity logs in as.
export const accountForLogin = readOperation<{ email: string }, LoginAccount>((db, { email }) =>
	loginAccount(db, email)
)

export type AuthorizationRequest = {
	clientId: string
	redirectUri: string
	scopes: string[]
	codeChallenge: string | null
}

export type IssueCodeInput = AuthorizationRequest & { email: string; codeHash: string; now: number }

export type IssueCodeResult = { status: 'ok' } | { status: 'invalid_request' } | Exclude<LoginAccount, { status: 'ok' }>

// Issues an authorization code after consent. Everything the consent page showed is checked again here, in the
// transaction that writes the code: the client, its redirect URI, the scopes, and the account's state.
export const issueCode = sessionOperation<IssueCodeInput, IssueCodeResult>((db, input) => {
	const row = clientRow(db, input.clientId)
	const client = row === undefined ? undefined : toClient(row)
	if (
		client === undefined ||
		!client.redirectUris.includes(input.redirectUri) ||
		!withinScopes(input.scopes, client.scopes)
	) {
		return { status: 'invalid_request' }
	}
	const account = loginAccount(db, input.email)
	if (account.status !== 'ok') {
		return account
	}
	db.run(
		`INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, redirect_uri, code_challenge,
			expires_at, created_at)
		VALUES (?, 'code', ?, ?, ?, ?, ?, ?, ?)`,
		input.codeHash,
		input.clientId,
		account.accountId,
		input.scopes.join(' '),
		input.redirectUri,
		input.codeChallenge,
		new Date(input.now + CODE_LIFETIME_MS).toISOString(),
		new Date(input.now).toISOString()
	)
	return { status: 'ok' }
})

export type TokenResult =
	| { status: 'ok'; scopes: string[] }
	| { status: 'invalid_client' }
	| { status: 'invalid_grant' }
	| { status: 'invalid_scope' }

export type ExchangeCodeInput = {
	codeHash: string
	clientId: string
	clientSecret: string
	redirectUri: string
	// base64url(sha256(code_verifier)), computed by the Worker; null when the request has no verifier.
	verifierChallenge: string | null
	tokenHash: string
	now: number
}

// Exchanges a code for an access token. The code is consumed by DELETE ... RETURNING before anything else is
// checked, and a failed check is returned rather than thrown so the deletion commits: a code is usable once, even
// when the attempt fails.
export const exchangeCode = sessionOperation<ExchangeCodeInput, TokenResult>((db, input) => {
	if (authenticateClient(db, input.clientId, input.clientSecret) === undefined) {
		return { status: 'invalid_client' }
	}
	const code = db.first<{
		client_id: string
		account_id: string
		scopes: string
		redirect_uri: string
		code_challenge: string | null
		expires_at: string
	}>(
		`DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'code'
		RETURNING client_id, account_id, scopes, redirect_uri, code_challenge, expires_at`,
		input.codeHash
	)
	const nowIso = new Date(input.now).toISOString()
	if (
		code === undefined ||
		code.client_id !== input.clientId ||
		code.expires_at <= nowIso ||
		code.redirect_uri !== input.redirectUri ||
		// PKCE: a code bound to a challenge needs the matching verifier; a verifier for an unbound code is refused
		// too, so a code injected without PKCE cannot pass for one with it.
		(code.code_challenge === null) !== (input.verifierChallenge === null) ||
		(code.code_challenge !== null && !constantTimeEqual(code.code_challenge, input.verifierChallenge ?? ''))
	) {
		return { status: 'invalid_grant' }
	}
	const suspended = db.first<{ suspended_at: string | null }>(
		'SELECT suspended_at FROM local_accounts WHERE account_id = ?',
		code.account_id
	)
	if (suspended?.suspended_at !== null) {
		return { status: 'invalid_grant' }
	}
	insertAccessToken(db, input.tokenHash, input.clientId, code.account_id, code.scopes, nowIso)
	return { status: 'ok', scopes: code.scopes.split(' ') }
})

export type AppTokenInput = {
	clientId: string
	clientSecret: string
	scopes: string[]
	tokenHash: string
	now: number
}

// client_credentials: a token of the app itself, with no account.
export const issueAppToken = sessionOperation<AppTokenInput, TokenResult>((db, input) => {
	const row = authenticateClient(db, input.clientId, input.clientSecret)
	if (row === undefined) {
		return { status: 'invalid_client' }
	}
	if (!withinScopes(input.scopes, toClient(row).scopes)) {
		return { status: 'invalid_scope' }
	}
	insertAccessToken(
		db,
		input.tokenHash,
		input.clientId,
		null,
		input.scopes.join(' '),
		new Date(input.now).toISOString()
	)
	return { status: 'ok', scopes: input.scopes }
})

function insertAccessToken(
	db: Db,
	tokenHash: string,
	clientId: string,
	accountId: string | null,
	scopes: string,
	createdAt: string
): void {
	db.run(
		"INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, created_at) VALUES (?, 'access', ?, ?, ?, ?)",
		tokenHash,
		clientId,
		accountId,
		scopes,
		createdAt
	)
}

// RFC 7009: revoking an unknown token, or one of another client, succeeds without effect. Push subscriptions of the
// token go with it (FK cascade).
export const revokeToken = sessionOperation<
	{ tokenHash: string; clientId: string; clientSecret: string },
	{ status: 'ok' } | { status: 'invalid_client' }
>((db, input) => {
	if (authenticateClient(db, input.clientId, input.clientSecret) === undefined) {
		return { status: 'invalid_client' }
	}
	db.run(
		"DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ? AND kind = 'access'",
		input.tokenHash,
		input.clientId
	)
	return { status: 'ok' }
})

// Suspends a local account: records suspended_at once and deletes its access tokens and unused codes (with their
// push subscriptions). Token validation and authorize refuse the account from then on. The owner console calls it
// in a later stage.
export const suspendAccount = writeOperation<{ accountId: string; now: number }, { suspended: boolean }>(
	(db, { accountId, now }) => {
		if (db.first('SELECT 1 AS found FROM local_accounts WHERE account_id = ?', accountId) === undefined) {
			return { suspended: false }
		}
		db.run(
			'UPDATE local_accounts SET suspended_at = COALESCE(suspended_at, ?) WHERE account_id = ?',
			new Date(now).toISOString(),
			accountId
		)
		db.run('DELETE FROM oauth_tokens WHERE account_id = ?', accountId)
		return { suspended: true }
	}
)
