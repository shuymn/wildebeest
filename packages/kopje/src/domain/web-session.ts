import { type CredentialAccount, credentialAccount, type Present } from './accounts'
import { authorize, type AuthFailure, type Authorized, type UserCredential, type UserViewer } from './auth'
import { consumeCode, insertAccessToken, webClientId, WEB_CLIENT_SETTING } from './oauth'
import { readOperation, sessionOperation } from './operation'
import type { Db } from '../db/sql'
import type { StoreOperation } from '../platform/store-kernel'
import { constantTimeEqual } from '../security/tokens'

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

// Sign-in attempts and browser families, in kopje_state (outside the dumped tables: they are short-lived). Values are
// JSON with an `expiresAt` the cron sweeps by (sweepWebState).
//
//   web_login:<sha256(state)>   one sign-in attempt: the PKCE challenge, the browser's family, its expiry. The
//                                callback consumes it atomically, so a second callback of the same attempt (two
//                                consent submissions, a replay) starts nothing.
//   web_family:<family>         one browser's sessions: the live one (`current`) and whether the browser signed out
//                                (`ended`). A new session replaces `current`; sign-out ends the family, so a callback
//                                of an attempt the browser started before signing out installs nothing.
//   web_session:<token hash>    the family a session belongs to, kept for its lifetime even after it is replaced, so
//                                signing out with a replaced session still ends the family's newer one.
const LOGIN = 'web_login:'
const FAMILY = 'web_family:'
const MEMBER = 'web_session:'

// How long a sign-in may take, and how many may be in progress at once (RES-6: /login is anonymous).
export const LOGIN_ATTEMPT_MS = 10 * 60 * 1000
export const MAX_LOGIN_ATTEMPTS = 1000

type Attempt = { challenge: string; family: string; previous: string | null; expiresAt: number }
type Family = { current: string | null; ended: boolean; expiresAt: number }

function readState<T>(db: Db, name: string): T | null {
	const row = db.first<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', name)
	return row === undefined ? null : (JSON.parse(row.value) as T)
}

function writeState(db: Db, name: string, value: unknown): void {
	db.run('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', name, JSON.stringify(value))
}

function takeState<T>(db: Db, name: string): T | null {
	const row = db.first<{ value: string }>('DELETE FROM kopje_state WHERE name = ? RETURNING value', name)
	return row === undefined ? null : (JSON.parse(row.value) as T)
}

function familyOf(db: Db, tokenHash: string): string | null {
	return readState<{ family: string }>(db, `${MEMBER}${tokenHash}`)?.family ?? null
}

function endSession(db: Db, clientId: string, tokenHash: string): void {
	db.run("DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ? AND kind = 'access'", tokenHash, clientId)
}

// The web client's id, created on first use. Its redirect URI follows the fixed domain the caller derives it from.
function ensureWebClient(
	db: Db,
	input: { clientId: string; secret: string; redirectUri: string; now: number }
): string {
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
}

export type BeginLoginInput = {
	// For the web client, if it does not exist yet.
	clientId: string
	secret: string
	redirectUri: string
	stateHash: string
	challenge: string
	// The browser's current session, if it sent one, and a family id for a browser that has none (or signed out).
	previousTokenHash: string | null
	family: string
	now: number
}

// /login: records the attempt and answers the web client's id, or busy when too many sign-ins are in progress.
export const beginWebLogin = sessionOperation<BeginLoginInput, { status: 'ok'; clientId: string } | { status: 'busy' }>(
	(db, input) => {
		const pending = () =>
			db.first<{ n: number }>('SELECT COUNT(*) AS n FROM kopje_state WHERE substr(name, 1, ?) = ?', LOGIN.length, LOGIN)
				?.n ?? 0
		if (pending() >= MAX_LOGIN_ATTEMPTS) {
			sweepPrefix(db, LOGIN, input.now, MAX_LOGIN_ATTEMPTS)
			if (pending() >= MAX_LOGIN_ATTEMPTS) {
				return { status: 'busy' }
			}
		}
		const clientId = ensureWebClient(db, input)
		const previousFamily = input.previousTokenHash === null ? null : familyOf(db, input.previousTokenHash)
		const live = previousFamily === null ? null : readState<Family>(db, `${FAMILY}${previousFamily}`)
		const attempt: Attempt = {
			challenge: input.challenge,
			family: live !== null && !live.ended ? (previousFamily ?? input.family) : input.family,
			previous: input.previousTokenHash,
			expiresAt: input.now + LOGIN_ATTEMPT_MS,
		}
		writeState(db, `${LOGIN}${input.stateHash}`, attempt)
		return { status: 'ok', clientId }
	}
)

export type StartSessionInput = {
	stateHash: string
	codeHash: string
	redirectUri: string
	verifierChallenge: string
	tokenHash: string
	now: number
}

// The callback: consumes the attempt and the code of the web client (both once, even on failure) and starts a
// session. The code must be bound to the attempt's PKCE challenge, so a code obtained for another browser's sign-in, or
// injected without its login cookie, starts nothing (session fixation and login CSRF). The new session replaces the
// family's live one, so overlapping sign-ins of one browser leave one session; a family that signed out meanwhile gets
// none.
export const startWebSession = sessionOperation<StartSessionInput, { status: 'ok' } | { status: 'invalid_grant' }>(
	(db, input) => {
		const clientId = webClientId(db)
		const attempt = takeState<Attempt>(db, `${LOGIN}${input.stateHash}`)
		const grant = clientId === null ? null : consumeCode(db, { ...input, clientId })
		if (
			clientId === null ||
			grant === null ||
			attempt === null ||
			attempt.expiresAt <= input.now ||
			!constantTimeEqual(attempt.challenge, input.verifierChallenge)
		) {
			return { status: 'invalid_grant' }
		}
		const familyName = `${FAMILY}${attempt.family}`
		const family = readState<Family>(db, familyName)
		if (family?.ended === true) {
			return { status: 'invalid_grant' }
		}
		for (const replaced of [family?.current ?? null, attempt.previous]) {
			if (replaced !== null) {
				endSession(db, clientId, replaced)
			}
		}
		const expiresAt = input.now + SESSION_LIFETIME_MS
		insertAccessToken(
			db,
			input.tokenHash,
			clientId,
			grant.accountId,
			grant.scopes,
			new Date(input.now).toISOString(),
			new Date(expiresAt).toISOString()
		)
		writeState(db, familyName, { current: input.tokenHash, ended: false, expiresAt } satisfies Family)
		writeState(db, `${MEMBER}${input.tokenHash}`, { family: attempt.family, expiresAt })
		return { status: 'ok' }
	}
)

// Sign-out: ends the browser's family, its live session (which may be newer than the one presented) and the presented
// one, so the cookie, if replayed, authenticates nothing and a sign-in still in flight installs nothing. Ending an
// unknown session succeeds without effect.
export const endWebSession = sessionOperation<{ tokenHash: string; now: number }, void>((db, { tokenHash, now }) => {
	const clientId = webClientId(db)
	if (clientId === null) {
		return
	}
	endSession(db, clientId, tokenHash)
	const familyId = familyOf(db, tokenHash)
	if (familyId === null) {
		return
	}
	const familyName = `${FAMILY}${familyId}`
	const family = readState<Family>(db, familyName)
	const current = family?.current ?? null
	if (current !== null) {
		endSession(db, clientId, current)
	}
	// Kept until the attempts it could fence have expired.
	writeState(db, familyName, { current: null, ended: true, expiresAt: now + LOGIN_ATTEMPT_MS } satisfies Family)
})

// Removes expired entries of one kind, at most `limit`.
function sweepPrefix(db: Db, prefix: string, now: number, limit: number): number {
	return db.all(
		`DELETE FROM kopje_state WHERE name IN (SELECT name FROM kopje_state
			WHERE substr(name, 1, ?1) = ?2 AND json_extract(value, '$.expiresAt') <= ?3 LIMIT ?4) RETURNING name`,
		prefix.length,
		prefix,
		now,
		limit
	).length
}

// The cron: expired attempts, families and session memberships.
export function sweepWebState(db: Db, now: number, limit: number): number {
	return [LOGIN, FAMILY, MEMBER].reduce((total, prefix) => total + sweepPrefix(db, prefix, now, limit), 0)
}

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
