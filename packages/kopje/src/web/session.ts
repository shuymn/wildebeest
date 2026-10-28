import { base64url } from "jose";

import { constantTimeEqual } from "../security/tokens";

// The web UI's browser-side session state and the checks every state change applies (WEB-1, WEB-4). The session
// itself is an access token of the web client (domain/web-session.ts); these are the cookies that carry it and the
// rules around them.
//
//   - Both cookies are __Host- (Secure, Path=/, no Domain), HttpOnly and SameSite=Lax; their values are random and
//     minted by the server only, never taken from a URL, so a session cannot be fixed from outside.
//   - The login cookie lives for the sign-in only: it holds the opaque id of the attempt, whose state, PKCE challenge,
//     return path and starting session the Store keeps.
//   - A form that changes state must come from this origin (Origin equal to the request's origin; missing, `null` and
//     foreign are refused) and carry the anti-forgery token derived from the session.

export const SESSION_COOKIE = "kopje_session";
export const LOGIN_COOKIE = "kopje_login";

// How long a sign-in may take, from /login to the callback (the code itself expires after 10 minutes).
export const LOGIN_LIFETIME_S = 10 * 60;

// WEB-1: the form was posted by a page of this origin.
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

const CSRF_CONTEXT = "kopje-web-csrf\u0000";

// WEB-4: the anti-forgery token of a session, sha256 under its own context. It is not the stored digest of the token
// (that is a plain sha256 in hex), so a leaked database gives no form tokens, and it changes with every login.
// /setup's forms use the same construction over the setup session's secret, under a context of their own.
export async function csrfToken(sessionToken: string, context = CSRF_CONTEXT): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(context + sessionToken));
  return base64url.encode(new Uint8Array(digest));
}

export async function csrfMatches(
  sessionToken: string,
  sent: string | undefined,
  context = CSRF_CONTEXT,
): Promise<boolean> {
  return sent !== undefined && constantTimeEqual(await csrfToken(sessionToken, context), sent);
}

export const SETUP_CSRF_CONTEXT = "kopje-setup-csrf\u0000";

// The setup session's cookie (__Host-, HttpOnly, SameSite=Strict): only an opaque id, whose SHA-256 names the session
// in the Store (domain/setup.ts). SETUP_TOKEN itself is never kept by the browser.
export const SETUP_COOKIE = "kopje_setup";

const MAX_RETURN_PATH = 512;
const DEFAULT_RETURN_PATH = "/settings";

// Percent-encoded slash, backslash, dot, control characters and percent itself: a browser or a later decoding step
// could turn them into a separator or another host.
const ENCODED_UNSAFE = /%(?:2f|5c|2e|25|[01][0-9a-f]|7f)/i;
// A "." or ".." segment: resolving it can turn a single leading slash into "//host".
const DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:[/?#]|$)/;

function isLocalPath(value: string): boolean {
  return (
    value.length <= MAX_RETURN_PATH &&
    /^\/(?![/\\])[^\\\s\p{Cc}]*$/u.test(value) &&
    !ENCODED_UNSAFE.test(value) &&
    !DOT_SEGMENT.test(value)
  );
}

// WEB-4: where to go after signing in. Only a path on this origin: it starts with exactly one '/', has no backslash,
// whitespace, control character, dot segment or encoded separator, and both it and what it resolves to stay on this
// origin as a path of the same form (so no normalization can make it "//host"). Anything else is the settings page.
export function returnPath(value: string | undefined | null): string {
  if (value === undefined || value === null || !isLocalPath(value)) {
    return DEFAULT_RETURN_PATH;
  }
  const base = "https://kopje.invalid";
  const url = new URL(value, base);
  const resolved = `${url.pathname}${url.search}`;
  return url.origin === base && isLocalPath(resolved) ? resolved : DEFAULT_RETURN_PATH;
}

// The login cookie holds only the opaque id of a sign-in attempt the Worker minted (32 random bytes, base64url); the
// Store keeps the attempt (domain/web-session.ts). Anything else in the cookie is no attempt.
const ATTEMPT_ID = /^[A-Za-z0-9_-]{16,128}$/;

export function attemptIdOf(value: string | undefined): string | null {
  return value !== undefined && ATTEMPT_ID.test(value) ? value : null;
}
