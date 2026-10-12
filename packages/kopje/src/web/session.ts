import { base64url } from 'jose'

import { constantTimeEqual } from '../security/tokens'

// The web UI's browser-side session state and the checks every state change applies (WEB-1, WEB-4). The session
// itself is an access token of the web client (domain/web-session.ts); these are the cookies that carry it and the
// rules around them.
//
//   - Both cookies are __Host- (Secure, Path=/, no Domain), HttpOnly and SameSite=Lax; their values are random and
//     minted by the server only, never taken from a URL, so a session cannot be fixed from outside.
//   - The login cookie lives for the sign-in only: it holds the OAuth state, the PKCE verifier and the local path to
//     return to.
//   - A form that changes state must come from this origin (Origin equal to the request's origin; missing, `null` and
//     foreign are refused) and carry the anti-forgery token derived from the session.

export const SESSION_COOKIE = 'kopje_session'
export const LOGIN_COOKIE = 'kopje_login'

// How long a sign-in may take, from /login to the callback (the code itself expires after 10 minutes).
export const LOGIN_LIFETIME_S = 10 * 60

// WEB-1: the form was posted by a page of this origin.
export function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('origin')
	return origin !== null && origin === new URL(request.url).origin
}

const CSRF_CONTEXT = 'kopje-web-csrf\u0000'

// WEB-4: the anti-forgery token of a session, sha256 under its own context. It is not the stored digest of the token
// (that is a plain sha256 in hex), so a leaked database gives no form tokens, and it changes with every login.
export async function csrfToken(sessionToken: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CSRF_CONTEXT + sessionToken))
	return base64url.encode(new Uint8Array(digest))
}

export async function csrfMatches(sessionToken: string, sent: string | undefined): Promise<boolean> {
	return sent !== undefined && constantTimeEqual(await csrfToken(sessionToken), sent)
}

const MAX_RETURN_PATH = 512
const DEFAULT_RETURN_PATH = '/settings'

// WEB-4: where to go after signing in. Only a path on this origin: it starts with one '/', has no backslash, control
// character or whitespace (browsers read '/\host' and tabs inside '//host' as another host), and resolves to this
// origin. Anything else is the settings page.
export function returnPath(value: string | undefined | null): string {
	if (
		value === undefined ||
		value === null ||
		value.length > MAX_RETURN_PATH ||
		!/^\/(?![/\\])[^\\\s\p{Cc}]*$/u.test(value)
	) {
		return DEFAULT_RETURN_PATH
	}
	const base = 'https://kopje.invalid'
	const url = new URL(value, base)
	return url.origin === base ? `${url.pathname}${url.search}` : DEFAULT_RETURN_PATH
}

export type LoginState = { state: string; verifier: string; returnTo: string }

// The login cookie's value. state and verifier are base64url (no '.'), so the path comes last and may contain dots.
export function encodeLogin(login: LoginState): string {
	return `${login.state}.${login.verifier}.${login.returnTo}`
}

export function decodeLogin(value: string | undefined): LoginState | null {
	if (value === undefined) {
		return null
	}
	const [state, verifier, ...rest] = value.split('.')
	if (state === undefined || state === '' || verifier === undefined || verifier === '' || rest.length === 0) {
		return null
	}
	return { state, verifier, returnTo: returnPath(rest.join('.')) }
}

export function stateMatches(login: LoginState, sent: string | undefined): boolean {
	return sent !== undefined && constantTimeEqual(login.state, sent)
}

// An ActivityPub client asks for the object, a browser for the page (content negotiation on /@user and /@user/:id).
export function wantsActivityPub(accept: string | undefined): boolean {
	return accept !== undefined && /application\/(activity\+json|ld\+json)/i.test(accept)
}
