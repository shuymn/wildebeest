import { CREDENTIAL_EPOCH_SQL } from './auth'
import { readOperation, sessionOperation, writeOperation } from './operation'
import { sweepWebState } from './web-session'
import { ACCOUNTS_ID_INDEX } from '../db/indexes'
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

// RES-6, the storage budget of anonymous app registration. A never-authorized app is one no user has a token or a code
// for (app tokens from client_credentials do not count). At most MAX_PENDING_APPS are kept: when the budget is full,
// unused apps (no token of any kind) older than UNUSED_APP_TTL_MS go first, as Mastodon's ApplicationsVacuum removes
// them, then the oldest never-authorized apps older than EVICTION_GRACE_MS (so a client in the middle of its first
// login keeps its registration), app tokens and all: anyone can get an app token without a user, so app tokens cannot
// protect an app, or the budget could be filled for good. An app a user authorized (a user token or code) is never
// counted or removed. If nothing can go, the registration is refused (429). The cron removes unused apps after
// UNUSED_APP_TTL_MS as well (sweepOAuth). The web UI's own client is never counted or removed.
export const MAX_PENDING_APPS = 500
export const UNUSED_APP_TTL_MS = 24 * 60 * 60 * 1000
export const EVICTION_GRACE_MS = 60 * 60 * 1000

// instance_settings name of the web UI's own OAuth client (domain/web-session.ts).
export const WEB_CLIENT_SETTING = 'web_client_id'

export function webClientId(db: Db): string | null {
	return (
		db.first<{ value: string }>('SELECT value FROM instance_settings WHERE name = ?', WEB_CLIENT_SETTING)?.value ?? null
	)
}

// Clients no user has authorized, oldest first; `extra` narrows them further.
function pendingAppsSql(extra = ''): string {
	return `FROM oauth_clients c
		WHERE c.id IS NOT (SELECT value FROM instance_settings WHERE name = '${WEB_CLIENT_SETTING}')
			AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.id AND t.account_id IS NOT NULL)
			${extra}`
}

const UNUSED = 'AND NOT EXISTS (SELECT 1 FROM oauth_tokens u WHERE u.client_id = c.id)'

function deleteClients(db: Db, where: string, ...params: SqlStorageValue[]): number {
	return db.all(`DELETE FROM oauth_clients WHERE id IN (SELECT c.id ${where}) RETURNING id`, ...params).length
}

function pendingApps(db: Db): number {
	return db.first<{ n: number }>(`SELECT COUNT(*) AS n ${pendingAppsSql()}`)?.n ?? 0
}

export type Registered = { status: 'ok'; client: Client } | { status: 'over_budget' }

export const registerApp = sessionOperation<RegisterAppInput, Registered>((db, input) => {
	if (pendingApps(db) >= MAX_PENDING_APPS) {
		deleteClients(db, pendingAppsSql(`${UNUSED} AND c.created_at < ?`), iso(input.now - UNUSED_APP_TTL_MS))
	}
	const excess = pendingApps(db) - MAX_PENDING_APPS + 1
	if (excess > 0) {
		deleteClients(
			db,
			`${pendingAppsSql('AND c.created_at < ?1')} ORDER BY c.created_at, c.id LIMIT ?2`,
			iso(input.now - EVICTION_GRACE_MS),
			excess
		)
		if (pendingApps(db) >= MAX_PENDING_APPS) {
			return { status: 'over_budget' }
		}
	}
	db.run(
		'INSERT INTO oauth_clients (id, secret, name, redirect_uris, website, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		input.clientId,
		input.secret,
		input.name,
		input.redirectUris.join('\n'),
		input.website,
		input.scopes.join(' '),
		iso(input.now)
	)
	return { status: 'ok', client: toClient(clientRow(db, input.clientId)!) }
})

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

// At most this many rows of each kind are removed per cron run.
export const OAUTH_SWEEP_BATCH = 500

// The cron (jobs/scheduled.ts): unused apps older than UNUSED_APP_TTL_MS, codes and access tokens (web sessions) past
// their expiry, and expired sign-in attempts and browser families (domain/web-session.ts). Bounded per run.
export const sweepOAuth = writeOperation<{ now: number }, { apps: number; tokens: number; webState: number }>(
	(db, { now }) => {
		const apps = deleteClients(
			db,
			`${pendingAppsSql(`${UNUSED} AND c.created_at < ?1`)} LIMIT ?2`,
			iso(now - UNUSED_APP_TTL_MS),
			OAUTH_SWEEP_BATCH
		)
		const tokens = db.all(
			`DELETE FROM oauth_tokens WHERE token_hash IN (SELECT token_hash FROM oauth_tokens
			WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?) RETURNING token_hash`,
			iso(now),
			OAUTH_SWEEP_BATCH
		).length
		return { apps, tokens, webState: sweepWebState(db, now, OAUTH_SWEEP_BATCH) }
	}
)

// instance_settings names written by /setup step 3.
export const ACCESS_TEAM_DOMAIN = 'access_team_domain'
export const ACCESS_AUD = 'access_aud'

// What /oauth/authorize needs before it can verify the Access assertion: the Access settings and the client.
export const authorizeContext = readOperation<
	{ clientId: string },
	{ access: { teamDomain: string; aud: string } | null; client: Client | null; firstParty: boolean }
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
		// The web UI's own login (domain/web-session.ts): the consent page reads as signing in.
		firstParty: client !== undefined && client.id === webClientId(db),
	}
})

export type LoginAccount =
	{ status: 'ok'; accountId: string; username: string } | { status: 'no_account' } | { status: 'suspended' }

// The local accounts (no index serves lower(email)), each account then sought by id, never a scan of the remote ones
// (RES-7).
function loginAccount(db: Db, email: string): LoginAccount {
	const row = db.first<{ account_id: string; username: string; suspended_at: string | null }>(
		`SELECT l.account_id, a.username, l.suspended_at
		FROM local_accounts l CROSS JOIN accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = l.account_id
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
			expires_at, created_at, epoch)
		VALUES (?, 'code', ?, ?, ?, ?, ?, ?, ?, ${CREDENTIAL_EPOCH_SQL})`,
		input.codeHash,
		input.clientId,
		account.accountId,
		input.scopes.join(' '),
		input.redirectUri,
		input.codeChallenge,
		new Date(input.now + CODE_LIFETIME_MS).toISOString(),
		new Date(input.now).toISOString(),
		account.accountId
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
	const code = consumeCode(db, input)
	if (code === null) {
		return { status: 'invalid_grant' }
	}
	insertAccessToken(db, input.tokenHash, input.clientId, code.accountId, code.scopes, iso(input.now), null)
	return { status: 'ok', scopes: code.scopes.split(' ') }
})

export type CodeInput = Pick<ExchangeCodeInput, 'codeHash' | 'clientId' | 'redirectUri' | 'verifierChallenge' | 'now'>

// Consumes a code: deleted by DELETE ... RETURNING before anything is checked, so it is gone even when a check fails
// (the caller returns its failure rather than throwing, so the deletion commits). The code's grant, or null when the
// code is unknown, expired, of another client or redirect URI, fails PKCE, or its account is suspended.
export function consumeCode(db: Db, input: CodeInput): { accountId: string; scopes: string } | null {
	const code = db.first<{
		client_id: string
		account_id: string
		scopes: string
		redirect_uri: string
		code_challenge: string | null
		expires_at: string
		epoch: number
	}>(
		`DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'code'
		RETURNING client_id, account_id, scopes, redirect_uri, code_challenge, expires_at, epoch`,
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
		return null
	}
	// A code of a suspended account, or one of an earlier credential epoch (currentCredentialSql), grants nothing.
	const account = db.first<{ suspended_at: string | null; credential_epoch: number }>(
		'SELECT suspended_at, credential_epoch FROM local_accounts WHERE account_id = ?',
		code.account_id
	)
	return account?.suspended_at === null && account.credential_epoch === code.epoch
		? { accountId: code.account_id, scopes: code.scopes }
		: null
}

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
	insertAccessToken(db, input.tokenHash, input.clientId, null, input.scopes.join(' '), iso(input.now), null)
	return { status: 'ok', scopes: input.scopes }
})

export function insertAccessToken(
	db: Db,
	tokenHash: string,
	clientId: string,
	accountId: string | null,
	scopes: string,
	createdAt: string,
	expiresAt: string | null
): void {
	db.run(
		`INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, expires_at, created_at, epoch)
		VALUES (?, 'access', ?, ?, ?, ?, ?, ${CREDENTIAL_EPOCH_SQL})`,
		tokenHash,
		clientId,
		accountId,
		scopes,
		expiresAt,
		createdAt,
		accountId
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
