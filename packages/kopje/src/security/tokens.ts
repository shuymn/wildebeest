import { createHash } from 'node:crypto'

import { base64url } from 'jose'

// Opaque OAuth values (client ids and secrets, codes, access tokens) and their digests. Only digests of codes and
// access tokens are stored; the values themselves leave the server once and are never logged.

export type TokenGenerator = () => string

// 32 random bytes as base64url (43 characters).
export const randomToken: TokenGenerator = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)))

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// The PKCE S256 transform: base64url(sha256(verifier)) without padding (RFC 7636 §4.2).
export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	return base64url.encode(new Uint8Array(digest))
}

// RFC 7636: a verifier is 43-128 unreserved characters; an S256 challenge is 43 base64url characters.
export const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
export const PKCE_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/

// Compares two strings in time that depends on neither their contents nor their lengths: both are reduced to
// fixed-size SHA-256 digests (node:crypto), which the runtime's timingSafeEqual compares.
export function constantTimeEqual(a: string, b: string): boolean {
	const left = createHash('sha256').update(a, 'utf8').digest()
	const right = createHash('sha256').update(b, 'utf8').digest()
	return crypto.subtle.timingSafeEqual(left, right)
}
