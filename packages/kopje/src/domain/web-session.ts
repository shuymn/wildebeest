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

// Sign-in attempts and browser families, in kopje_state (outside the dumped tables: they are short-lived). Values are
// JSON with an `expiresAt` the cron sweeps by (sweepWebState). /login writes nothing here: an anonymous visitor
// cannot add state, hold a slot, or touch another browser's family (RES-6). Each entry is written only by a callback
// that presented a valid code (a person Access admitted, who approved the sign-in) or by a signed-in browser's
// sign-out.
//
//   web_login_used:<sha256(state)>  a sign-in attempt that has completed: a second callback with the same state (two
//                                   consent submissions, a replay) starts nothing.
//   web_family:<family>             one browser's sessions: the live one (`current`) and whether the browser signed
//                                   out (`ended`). A new session replaces `current`; sign-out ends the family, so a
//                                   callback of a sign-in the browser started before signing out installs nothing.
//   web_session:<token hash>        the family a session belongs to, kept for its lifetime even after it is replaced,
//                                   so signing out with a replaced session still ends the family's newer one.
//
// The browser's own state lives in its login cookie (web/session.ts): the OAuth state, the PKCE verifier, and the
// digest of the session it had when it started signing in.
const USED = 'web_login_used:'
const FAMILY = 'web_family:'
const MEMBER = 'web_session:'

// How long a sign-in may take (the login cookie's and the code's lifetime).
export const LOGIN_ATTEMPT_MS = 10 * 60 * 1000

type Family = { current: string | null; ended: boolean; expiresAt: number }

function readState<T>(db: Db, name: string): T | null {
	const row = db.first<{ value: string }>('SELECT value FROM kopje_state WHERE name = ?', name)
	return row === undefined ? null : (JSON.parse(row.value) as T)
}

function writeState(db: Db, name: string, value: unknown): void {
	db.run('INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)', name, JSON.stringify(value))
}

function familyOf(db: Db, tokenHash: string): string | null {
	return readState<{ family: string }>(db, `${MEMBER}${tokenHash}`)?.family ?? null
}

function endSession(db: Db, clientId: string, tokenHash: string): void {
	db.run("DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ? AND kind = 'access'", tokenHash, clientId)
}

export type WebClientInput = { clientId: string; secret: string; redirectUri: string; now: number }

// /login: the web client's id, created on first use. Its redirect URI follows the fixed domain the caller derives it
// from; the row is written only when it is missing or differs.
export const ensureWebClient = sessionOperation<WebClientInput, string>((db, input) => {
	const existing = webClientId(db)
	const row =
		existing === null
			? undefined
			: db.first<{ redirect_uris: string; scopes: string }>(
					'SELECT redirect_uris, scopes FROM oauth_clients WHERE id = ?',
					existing
				)
	if (existing !== null && row !== undefined) {
		if (row.redirect_uris !== input.redirectUri || row.scopes !== WEB_SCOPES.join(' ')) {
			db.run(
				'UPDATE oauth_clients SET redirect_uris = ?, scopes = ? WHERE id = ?',
				input.redirectUri,
				WEB_SCOPES.join(' '),
				existing
			)
		}
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
	stateHash: string
	codeHash: string
	redirectUri: string
	verifierChallenge: string
	tokenHash: string
	// The session the browser had when it started signing in (from its login cookie), and the one it presents now.
	startedWith: string | null
	presented: string | null
	// A family id for a browser that has none.
	family: string
	now: number
}

// The callback: consumes the code of the web client (once, even on failure) and starts a session. The code must be
// bound to the PKCE challenge of the login cookie's verifier, so a code obtained for another browser's sign-in, or one
// injected without that cookie, starts nothing (session fixation and login CSRF); a state that already completed
// starts nothing either. The new session replaces the family's live one and every session the browser presented, so
// overlapping sign-ins of one browser leave one session; a family that signed out after the sign-in started gets none.
// Every session replaced is deleted here, so it cannot authorize again, by cookie or as a bearer token.
export const startWebSession = sessionOperation<StartSessionInput, { status: 'ok' } | { status: 'invalid_grant' }>(
	(db, input) => {
		const clientId = webClientId(db)
		const grant = clientId === null ? null : consumeCode(db, { ...input, clientId })
		const usedName = `${USED}${input.stateHash}`
		if (clientId === null || grant === null || readState(db, usedName) !== null) {
			return { status: 'invalid_grant' }
		}
		writeState(db, usedName, { expiresAt: input.now + LOGIN_ATTEMPT_MS })
		const startedFamily = input.startedWith === null ? null : familyOf(db, input.startedWith)
		const started = startedFamily === null ? null : readState<Family>(db, `${FAMILY}${startedFamily}`)
		if (started?.ended === true) {
			return { status: 'invalid_grant' }
		}
		const presentedFamily = input.presented === null ? null : familyOf(db, input.presented)
		const presented = presentedFamily === null ? null : readState<Family>(db, `${FAMILY}${presentedFamily}`)
		const familyId = started !== null ? startedFamily : presented !== null && !presented.ended ? presentedFamily : null
		const family = familyId ?? input.family
		const current = (familyId === null ? null : readState<Family>(db, `${FAMILY}${familyId}`))?.current ?? null
		for (const replaced of [current, input.startedWith, input.presented]) {
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
		writeState(db, `${FAMILY}${family}`, { current: input.tokenHash, ended: false, expiresAt } satisfies Family)
		writeState(db, `${MEMBER}${input.tokenHash}`, { family, expiresAt })
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

// The cron: expired completed-attempt marks, families and session memberships.
export function sweepWebState(db: Db, now: number, limit: number): number {
	return [USED, FAMILY, MEMBER].reduce((total, prefix) => total + sweepPrefix(db, prefix, now, limit), 0)
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
