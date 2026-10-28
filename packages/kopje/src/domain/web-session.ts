import type { Db } from "../db/sql";
import { parseAddress } from "../platform/domain-name";
import { httpUrl } from "../platform/http-url";
import type { StoreOperation } from "../platform/store-kernel";
import { constantTimeEqual } from "../security/tokens";
import { type CredentialAccount, credentialAccount, type Present } from "./accounts";
import {
  authorize,
  type AuthFailure,
  type Authorized,
  currentCredentialSql,
  type UserCredential,
  type UserViewer,
} from "./auth";
import { consumeCode, insertAccessToken, webClientId, WEB_CLIENT_SETTING } from "./oauth";
import { readOperation, sessionOperation } from "./operation";
import { FAMILY, LOGIN, MEMBER, sweepPrefix } from "./web-state";

// Web sessions (AUTH, WEB-4). The web UI is an ordinary OAuth client of the instance: Access verifies the person at
// /oauth/authorize, the consent page issues a PKCE-bound code to the web client's callback, and the callback exchanges
// it here for an access token of the web client, which the browser keeps as an opaque HttpOnly cookie. So a session
// is a row of oauth_tokens: stored as its SHA-256 only (AUTH-7), checked in the transaction of every operation it
// authorizes (AUTH-1), refused once the account is suspended, ended by logout, by expiry (SESSION_LIFETIME_MS, fixed
// from login) and by "sign out other sessions", and listed with the user's authorizations.
//
// The web client has no usable secret: its callback runs in this Worker and exchanges the code with the Store directly,
// and the code is bound to the PKCE challenge whose verifier only the browser's login cookie holds. Its client id is
// recorded in instance_settings (WEB_CLIENT_SETTING).

export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

// What the web client may do: read and edit the profile, upload its images, and follow from /authorize_interaction.
// Nothing else of the API. A session holds the scopes it was issued with, so one issued before a scope was added here
// is refused where that scope is required and signs in again (AUTH-8).
export const WEB_SCOPES = ["read:accounts", "write:accounts", "write:media", "write:follows"];

// The path /authorize_interaction's sign-in returns to: the interaction target travels in the attempt, never in the
// return path, so returnPath's check stays as it is (WEB-4).
export const INTERACTION_PATH = "/authorize_interaction";

// The bound of an interaction target, in UTF-8 bytes.
export const INTERACTION_TARGET_BYTES = 2048;

// An interaction target (the uri of /authorize_interaction): an http(s) URL or an address that parseAddress
// accepts, at most INTERACTION_TARGET_BYTES UTF-8 bytes, with no control character or whitespace; null otherwise. The
// value is kept as given: it is only ever shown escaped, sent percent-encoded, or given to the resolver, which applies
// its own rules (NET-1).
export function interactionTarget(value: string | null | undefined): string | null {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    new TextEncoder().encode(value).length > INTERACTION_TARGET_BYTES ||
    /[\s\p{Cc}]/u.test(value)
  ) {
    return null;
  }
  return (/^https?:\/\//i.test(value) && httpUrl(value) !== null) || parseAddress(value) !== null ? value : null;
}

// How long a sign-in may take (the login cookie's and the code's lifetime).
export const LOGIN_ATTEMPT_MS = 10 * 60 * 1000;

// Expired attempts pruned per new attempt.
const PRUNE_PER_LOGIN = 20;

// family: the browser's family when it started, resolved then, so a later expiry of the session's membership cannot
// lose the sign-out fence (an ended family's record outlives every attempt that names it, see endFamily).
type Attempt = {
  state: string;
  challenge: string;
  returnTo: string;
  // Absent in attempts recorded before the field existed.
  interaction?: string | null;
  startedWith: string | null;
  family: string | null;
  expiresAt: number;
};
// accountId: absent in records written before it was kept; such a family has no known owner and is never reused.
type Family = { current: string | null; ended: boolean; expiresAt: number; accountId?: string };

function readState<T>(db: Db, name: string): T | null {
  const row = db.first<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", name);
  return row === undefined ? null : (JSON.parse(row.value) as T);
}

function writeState(db: Db, name: string, value: unknown): void {
  db.run("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", name, JSON.stringify(value));
}

function familyOf(db: Db, tokenHash: string): string | null {
  return readState<{ family: string }>(db, `${MEMBER}${tokenHash}`)?.family ?? null;
}

function endSession(db: Db, clientId: string, tokenHash: string): void {
  db.run("DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ? AND kind = 'access'", tokenHash, clientId);
}

export type WebClientInput = { clientId: string; secret: string; redirectUri: string; now: number };

// The web client's id, created on first use. Its redirect URI follows the fixed domain the caller derives it from; the
// row is written only when it is missing or differs.
function ensureWebClient(db: Db, input: WebClientInput): string {
  const existing = webClientId(db);
  const row =
    existing === null
      ? undefined
      : db.first<{ redirect_uris: string; scopes: string }>(
          "SELECT redirect_uris, scopes FROM oauth_clients WHERE id = ?",
          existing,
        );
  if (existing !== null && row !== undefined) {
    if (row.redirect_uris !== input.redirectUri || row.scopes !== WEB_SCOPES.join(" ")) {
      db.run(
        "UPDATE oauth_clients SET redirect_uris = ?, scopes = ? WHERE id = ?",
        input.redirectUri,
        WEB_SCOPES.join(" "),
        existing,
      );
    }
    return existing;
  }
  db.run(
    `INSERT INTO oauth_clients (id, secret, name, redirect_uris, website, scopes, created_at)
		VALUES (?, ?, 'Kopje', ?, NULL, ?, ?)`,
    input.clientId,
    input.secret,
    input.redirectUri,
    WEB_SCOPES.join(" "),
    new Date(input.now).toISOString(),
  );
  db.run("INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)", WEB_CLIENT_SETTING, input.clientId);
  return input.clientId;
}

export type BeginLoginInput = WebClientInput & {
  attemptHash: string;
  state: string;
  challenge: string;
  returnTo: string;
  // The target of /authorize_interaction to come back to, kept only with that return path and only as
  // interactionTarget accepts it.
  interaction: string | null;
  // The digest of the session cookie the request carried, if any.
  startedWith: string | null;
};

// /login: records the attempt and answers the web client's id.
export const beginWebLogin = sessionOperation<BeginLoginInput, string>((db, input) => {
  sweepPrefix(db, LOGIN, input.now, PRUNE_PER_LOGIN);
  const clientId = ensureWebClient(db, input);
  writeState(db, `${LOGIN}${input.attemptHash}`, {
    state: input.state,
    challenge: input.challenge,
    returnTo: input.returnTo,
    interaction: input.returnTo === INTERACTION_PATH ? interactionTarget(input.interaction) : null,
    startedWith: input.startedWith,
    family: input.startedWith === null ? null : familyOf(db, input.startedWith),
    expiresAt: input.now + LOGIN_ATTEMPT_MS,
  } satisfies Attempt);
  return clientId;
});

export type StartSessionInput = {
  attemptHash: string;
  state: string;
  // null when the person cancelled at the consent page (the attempt is consumed, nothing starts).
  codeHash: string | null;
  redirectUri: string;
  tokenHash: string;
  // The digest of the session cookie the callback request carried, if any.
  presented: string | null;
  // A family id for a browser that has none.
  family: string;
  now: number;
};

export type SessionStarted =
  | { status: "ok"; returnTo: string; interaction: string | null }
  | { status: "state_mismatch" }
  | { status: "cancelled"; returnTo: string; interaction: string | null }
  | { status: "invalid_grant" };

// The callback. The attempt is found by the login cookie's id; a state that is not the attempt's leaves it untouched
// (a stale callback of an older tab does not cancel the newer sign-in). Otherwise the attempt is consumed, and the code
// of the web client too (both once, even on failure); the code must be bound to the attempt's PKCE challenge, so a
// code obtained for another sign-in, or injected without its login cookie, starts nothing (session fixation, login
// CSRF). The new session replaces the family's live one and every session the browser held, so overlapping sign-ins of
// one browser leave one session; a family that signed out after the sign-in started gets none. Every session replaced
// is deleted here, so it cannot authorize again, by cookie or as a bearer token.
export const startWebSession = sessionOperation<StartSessionInput, SessionStarted>((db, input) => {
  const attemptName = `${LOGIN}${input.attemptHash}`;
  const attempt = readState<Attempt>(db, attemptName);
  if (attempt === null || attempt.expiresAt <= input.now) {
    return { status: "invalid_grant" };
  }
  if (!constantTimeEqual(attempt.state, input.state)) {
    return { status: "state_mismatch" };
  }
  db.run("DELETE FROM kopje_state WHERE name = ?", attemptName);
  const clientId = webClientId(db);
  if (input.codeHash === null) {
    return { status: "cancelled", returnTo: attempt.returnTo, interaction: attempt.interaction ?? null };
  }
  const grant =
    clientId === null
      ? null
      : consumeCode(db, { ...input, codeHash: input.codeHash, clientId, verifierChallenge: attempt.challenge });
  if (clientId === null || grant === null) {
    return { status: "invalid_grant" };
  }
  const startedFamily = attempt.family;
  const started = startedFamily === null ? null : readState<Family>(db, `${FAMILY}${startedFamily}`);
  if (started?.ended === true) {
    return { status: "invalid_grant" };
  }
  const presentedFamily = input.presented === null ? null : familyOf(db, input.presented);
  const presented = presentedFamily === null ? null : readState<Family>(db, `${FAMILY}${presentedFamily}`);
  const previous = started ?? (presented !== null && !presented.ended ? presented : null);
  const previousId = started !== null ? startedFamily : previous !== null ? presentedFamily : null;
  // The family is kept only when it records the same account. One that records another account, or none (written
  // before owners were recorded, and possibly shared by several accounts' sessions), ends here with its live session,
  // and the new session starts a family of its own.
  const familyId = previousId !== null && previous?.accountId === grant.accountId ? previousId : null;
  if (previousId !== null && familyId === null) {
    endFamily(db, clientId, previousId, input.now);
  }
  const family = familyId ?? input.family;
  const current = familyId === null ? null : (previous?.current ?? null);
  for (const replaced of [current, attempt.startedWith, input.presented]) {
    if (replaced !== null) {
      endSession(db, clientId, replaced);
    }
  }
  const expiresAt = input.now + SESSION_LIFETIME_MS;
  insertAccessToken(
    db,
    input.tokenHash,
    clientId,
    grant.accountId,
    grant.scopes,
    new Date(input.now).toISOString(),
    new Date(expiresAt).toISOString(),
  );
  writeState(db, `${FAMILY}${family}`, {
    current: input.tokenHash,
    ended: false,
    expiresAt,
    accountId: grant.accountId,
  } satisfies Family);
  writeState(db, `${MEMBER}${input.tokenHash}`, { family, expiresAt });
  return { status: "ok", returnTo: attempt.returnTo, interaction: attempt.interaction ?? null };
});

// Sign-out: ends the browser's family, its live session (which may be newer than the one presented) and the presented
// one, so the cookie, if replayed, authenticates nothing and a sign-in still in flight installs nothing. Ending an
// unknown session succeeds without effect.
export const endWebSession = sessionOperation<{ tokenHash: string; now: number }, void>((db, { tokenHash, now }) => {
  const clientId = webClientId(db);
  if (clientId === null) {
    return;
  }
  endSession(db, clientId, tokenHash);
  const familyId = familyOf(db, tokenHash);
  if (familyId === null) {
    return;
  }
  endFamily(db, clientId, familyId, now);
});

// Ends a family and its live session. The record is kept LOGIN_ATTEMPT_MS from now: every attempt that names the
// family was made before, so it expires no later.
function endFamily(db: Db, clientId: string, familyId: string, now: number): void {
  const familyName = `${FAMILY}${familyId}`;
  const current = readState<Family>(db, familyName)?.current ?? null;
  if (current !== null) {
    endSession(db, clientId, current);
  }
  writeState(db, familyName, { current: null, ended: true, expiresAt: now + LOGIN_ATTEMPT_MS } satisfies Family);
}

// Operations of the web UI only: the credential must be a live session of the web client, so an API token (even one
// with the same scopes) cannot list or revoke the user's authorizations.
function webOperation<I, O>(
  declare: typeof readOperation,
  run: (db: Db, input: I & { credential: UserCredential }, viewer: UserViewer, clientId: string) => O,
): StoreOperation<I & { credential: UserCredential }, Authorized<O>> {
  return declare<I & { credential: UserCredential }, Authorized<O>>((db, input) => {
    const auth = authorize(db, input.credential);
    if (auth.status !== "ok") {
      return auth;
    }
    const clientId = webClientId(db);
    if (clientId === null || auth.viewer.client.id !== clientId || auth.viewer.accountId === null) {
      return { status: "unauthenticated" } satisfies AuthFailure;
    }
    return { status: "ok", value: run(db, input, auth.viewer as UserViewer, clientId) };
  });
}

export type Authorization = {
  clientId: string;
  name: string;
  website: string | null;
  scopes: string[];
  authorizedAt: string;
};

export type Authorizations = { apps: Authorization[]; otherSessions: number };

// The apps the user has authorized (live tokens and pending codes of the current credential epoch, per app), as
// Mastodon's "Authorized apps" lists them, and how many other web sessions the user has.
function authorizationsOf(
  db: Db,
  accountId: string,
  webClient: string,
  tokenHash: string,
  now: number,
): Authorizations {
  const nowIso = new Date(now).toISOString();
  const rows = db.all<{ id: string; name: string; website: string | null; scopes: string; authorized_at: string }>(
    `SELECT c.id, c.name, c.website, group_concat(t.scopes, ' ') AS scopes, min(t.created_at) AS authorized_at
		FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
		WHERE t.account_id = ?1 AND t.client_id <> ?2 AND (t.expires_at IS NULL OR t.expires_at > ?3)
			AND ${currentCredentialSql("t")}
		GROUP BY c.id ORDER BY authorized_at, c.id`,
    accountId,
    webClient,
    nowIso,
  );
  const others = db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM oauth_tokens t WHERE account_id = ? AND client_id = ? AND kind = 'access'
			AND token_hash <> ? AND (expires_at IS NULL OR expires_at > ?) AND ${currentCredentialSql("t")}`,
    accountId,
    webClient,
    tokenHash,
    nowIso,
  );
  return {
    apps: rows.map((row) => ({
      clientId: row.id,
      name: row.name,
      website: row.website,
      scopes: [...new Set(row.scopes.split(" ").filter((scope) => scope !== ""))].sort(),
      authorizedAt: row.authorized_at,
    })),
    otherSessions: others?.n ?? 0,
  };
}

export type SettingsData = { account: CredentialAccount; authorizations: Authorizations };

// Everything the settings page shows, in one read: the profile as the owner edits it, and the authorizations.
export const settingsView = webOperation<{ now: number; present: Present }, SettingsData | null>(
  readOperation,
  (db, { credential, now, present }, { accountId }, webClient) => {
    const account = credentialAccount(db, accountId, present);
    return account === null
      ? null
      : { account, authorizations: authorizationsOf(db, accountId, webClient, credential.tokenHash, now) };
  },
);

// Revokes every token and code the user gave one app (AUTH-6: only the viewer's own). The web client is not an app
// here; its sessions end by logout or revokeOtherSessions.
export const revokeAuthorization = webOperation<{ clientId: string }, number>(
  sessionOperation,
  (db, { clientId }, { accountId }, webClient) =>
    clientId === webClient
      ? 0
      : db.all(
          "DELETE FROM oauth_tokens WHERE account_id = ? AND client_id = ? RETURNING token_hash",
          accountId,
          clientId,
        ).length,
);

// Ends every web session of the user but the current one.
// Ends every web session of the user but the current one, in one transaction: their families end too (so their
// browsers' sign-ins in flight install nothing), and the web client's unexchanged codes for the user are deleted (a
// sign-in of a browser with no session yet cannot be told apart). The caller's own family stays.
export const revokeOtherSessions = webOperation<{ now: number }, number>(
  sessionOperation,
  (db, { credential, now }, { accountId }, webClient) => {
    const revoked = db.all<{ token_hash: string }>(
      `DELETE FROM oauth_tokens WHERE account_id = ? AND client_id = ? AND token_hash <> ? AND kind = 'access'
			RETURNING token_hash`,
      accountId,
      webClient,
      credential.tokenHash,
    );
    const own = familyOf(db, credential.tokenHash);
    for (const family of new Set(revoked.map((row) => familyOf(db, row.token_hash)))) {
      if (family !== null && family !== own) {
        endFamily(db, webClient, family, now);
      }
    }
    db.run("DELETE FROM oauth_tokens WHERE account_id = ? AND client_id = ? AND kind = 'code'", accountId, webClient);
    return revoked.length;
  },
);
