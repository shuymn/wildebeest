import type { Db } from "../db/sql";

// The web UI's sign-in state (web-session.ts) and its sweep, which the OAuth cron runs (oauth.ts sweepOAuth).
//
// Sign-in attempts and browser families, in kopje_state (outside the dumped tables: they are short-lived). Values are
// JSON with an `expiresAt`; expired entries are pruned as attempts are added and by the cron (sweepWebState).
//
//   web_login:<sha256(attempt id)>  one sign-in attempt: the OAuth state, the PKCE challenge, the local path to
//                                   return to, /authorize_interaction's target (interactionTarget), the digest of
//                                   the session the browser held when it started (taken from its session cookie, so
//                                   only a session it holds), and the expiry. The
//                                   browser's login cookie holds only the opaque attempt id the Worker minted; the
//                                   callback takes everything else from this row, and consumes it atomically, so a
//                                   second callback of the same attempt starts nothing. Attempts are keyed by the
//                                   browser's own id and expire after LOGIN_ATTEMPT_MS: there is no shared slot or
//                                   counter an anonymous party could fill (/login is rate limited per client IP).
//   web_family:<family>             one browser's sessions of one account: the live one (`current`), its account
//                                   (`accountId`) and whether the browser signed out (`ended`). A new session of the
//                                   same account replaces `current`; one of another account ends the family and
//                                   starts its own, so a retired session of the first account can never sign the
//                                   second out. Sign-out ends the family, so a callback of a sign-in the browser
//                                   started before signing out installs nothing.
//   web_session:<token hash>        the family a session belongs to, kept for its lifetime even after it is replaced,
//                                   so signing out with a replaced session still ends the family's newer one.
export const LOGIN = "web_login:";
export const FAMILY = "web_family:";
export const MEMBER = "web_session:";

// Removes expired entries of one kind, at most `limit`.
export function sweepPrefix(db: Db, prefix: string, now: number, limit: number): number {
  return db.all(
    `DELETE FROM kopje_state WHERE name IN (SELECT name FROM kopje_state
			WHERE substr(name, 1, ?1) = ?2 AND json_extract(value, '$.expiresAt') <= ?3 LIMIT ?4) RETURNING name`,
    prefix.length,
    prefix,
    now,
    limit,
  ).length;
}

// The cron: expired attempts, families and session memberships.
export function sweepWebState(db: Db, now: number, limit: number): number {
  return [LOGIN, FAMILY, MEMBER].reduce((total, prefix) => total + sweepPrefix(db, prefix, now, limit), 0);
}
