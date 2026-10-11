// Opaque OAuth values (client ids and secrets, codes, access tokens) and their digests. Only digests of codes and
// access tokens are stored; the values themselves leave the server once and are never logged.

export type TokenGenerator = () => string

// 32 random bytes as base64url (43 characters).
export const randomToken: TokenGenerator = () => base64Url(crypto.getRandomValues(new Uint8Array(32)))

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// The PKCE S256 transform: base64url(sha256(verifier)) without padding (RFC 7636 §4.2).
export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	return base64Url(new Uint8Array(digest))
}

// RFC 7636: a verifier is 43-128 unreserved characters; an S256 challenge is 43 base64url characters.
export const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
export const PKCE_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/

// Compares two strings without returning early on the first difference.
export function constantTimeEqual(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a)
	const right = new TextEncoder().encode(b)
	let difference = left.length ^ right.length
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		difference |= (left[i] ?? 0) ^ (right[i] ?? 0)
	}
	return difference === 0
}

export function base64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
