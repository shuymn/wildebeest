import { base64url } from 'jose'

// The VAPID application server key that clients subscribe Web Push with: the uncompressed P-256 point
// (0x04 || x || y) of the VAPID_JWK secret, base64url without padding. Returns null for anything that is not an EC
// P-256 JWK with 32-byte coordinates.
export function vapidPublicKey(jwkText: string): string | null {
	let jwk: unknown
	try {
		jwk = JSON.parse(jwkText)
	} catch {
		return null
	}
	if (typeof jwk !== 'object' || jwk === null) {
		return null
	}
	const { kty, crv, x, y } = jwk as Record<string, unknown>
	if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string') {
		return null
	}
	const xBytes = fromBase64Url(x)
	const yBytes = fromBase64Url(y)
	if (xBytes?.length !== 32 || yBytes?.length !== 32) {
		return null
	}
	const point = new Uint8Array(65)
	point[0] = 0x04
	point.set(xBytes, 1)
	point.set(yBytes, 33)
	return base64url.encode(point)
}

function fromBase64Url(text: string): Uint8Array | null {
	try {
		return base64url.decode(text)
	} catch {
		return null
	}
}
