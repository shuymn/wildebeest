import { base64url, importJWK, SignJWT } from 'jose'

// Web Push cryptography with WebCrypto only: message encryption in both encodings Mastodon clients subscribe with, and
// VAPID (RFC 8292). No maintained library runs on Workers and covers both encodings: the WebCrypto ones implement
// aes128gcm only, and web-push (Node) needs node:crypto ECDH and its own HTTP stack.
//   - aes128gcm (`standard` true): RFC 8291 over RFC 8188, one record, a 0x02 delimiter and no padding.
//   - aesgcm (Mastodon's default, which most clients still send): draft-ietf-webpush-encryption-04 over
//     draft-ietf-httpbis-encryption-encoding-03, one record with a two-octet zero padding length, the salt and the
//     sender's key carried in the Encryption and Crypto-Key headers.
// test/web-push-crypto.test.ts pins both to the published examples (RFC 8291 Appendix A, draft-04 Appendix A).

export type PushEncoding = 'aes128gcm' | 'aesgcm'

// The client's keys from its subscription: its P-256 public key (uncompressed point) and its 16-octet auth secret.
export type ClientKeys = { p256dh: Uint8Array; auth: Uint8Array }

// The sender's ephemeral ECDH key pair and the salt; fresh for every message (tests pass fixed ones).
export type EncryptSeed = { senderKeys: CryptoKeyPair; salt: Uint8Array }

export type EncryptedPush = { body: Uint8Array; salt: Uint8Array; senderPublicKey: Uint8Array }

const RECORD_SIZE = 4096
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const
// Push services must accept 4096 octets of body (RFC 8030 §7.2). aes128gcm adds the most: an 86-octet header, the
// delimiter and the 16-octet tag.
export const MAX_PUSH_PLAINTEXT = RECORD_SIZE - 86 - 1 - 16
export const AUTH_SECRET_LENGTH = 16

const text = (value: string) => new TextEncoder().encode(value)

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}
	return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', concat(ikm), 'HKDF', false, ['deriveBits'])
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: concat(salt), info: concat(info) },
		key,
		length * 8
	)
	return new Uint8Array(bits)
}

async function aesGcm(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	const cek = await crypto.subtle.importKey('raw', concat(key), 'AES-GCM', false, ['encrypt'])
	return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: concat(nonce) }, cek, concat(plaintext)))
}

// The client's public key as an ECDH key, or null unless it is an uncompressed point on P-256.
export async function importClientKey(p256dh: Uint8Array): Promise<CryptoKey | null> {
	if (p256dh.length !== 65 || p256dh[0] !== 0x04) {
		return null
	}
	try {
		return await crypto.subtle.importKey('raw', concat(p256dh), P256, false, [])
	} catch {
		return null
	}
}

export async function encryptPush(
	plaintext: Uint8Array,
	keys: ClientKeys,
	encoding: PushEncoding,
	seed?: EncryptSeed
): Promise<EncryptedPush> {
	if (plaintext.length > MAX_PUSH_PLAINTEXT) {
		throw new Error('push payload too large')
	}
	const clientKey = await importClientKey(keys.p256dh)
	if (clientKey === null || keys.auth.length !== AUTH_SECRET_LENGTH) {
		throw new Error('invalid client keys')
	}
	const sender = seed?.senderKeys ?? ((await crypto.subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair)
	const salt = seed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
	const senderPublicKey = new Uint8Array((await crypto.subtle.exportKey('raw', sender.publicKey)) as ArrayBuffer)
	// WebCrypto names the peer key `public`; the Workers types spell it `$public`.
	const ecdh = { name: 'ECDH', public: clientKey } as unknown as SubtleCryptoDeriveKeyAlgorithm
	const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, sender.privateKey, 256))
	if (encoding === 'aes128gcm') {
		const ikm = await hkdf(keys.auth, secret, concat(text('WebPush: info\0'), keys.p256dh, senderPublicKey), 32)
		const cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16)
		const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12)
		const recordSize = new Uint8Array(4)
		new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE)
		const header = concat(salt, recordSize, Uint8Array.of(senderPublicKey.length), senderPublicKey)
		const record = await aesGcm(cek, nonce, concat(plaintext, Uint8Array.of(0x02)))
		return { body: concat(header, record), salt, senderPublicKey }
	}
	const ikm = await hkdf(keys.auth, secret, text('Content-Encoding: auth\0'), 32)
	const context = concat(text('P-256\0'), Uint8Array.of(0, 65), keys.p256dh, Uint8Array.of(0, 65), senderPublicKey)
	const cek = await hkdf(salt, ikm, concat(text('Content-Encoding: aesgcm\0'), context), 16)
	const nonce = await hkdf(salt, ikm, concat(text('Content-Encoding: nonce\0'), context), 12)
	const body = await aesGcm(cek, nonce, concat(Uint8Array.of(0, 0), plaintext))
	return { body, salt, senderPublicKey }
}

// The headers a push carries for its encoding and VAPID: RFC 8292's `vapid` scheme for aes128gcm; for aesgcm the
// draft's `WebPush` scheme with the key in Crypto-Key next to the sender's dh, as Mastodon's legacy path sends it.
export function pushHeaders(
	encoding: PushEncoding,
	encrypted: EncryptedPush,
	vapid: { token: string; publicKey: string }
): Record<string, string> {
	if (encoding === 'aes128gcm') {
		return { 'content-encoding': 'aes128gcm', authorization: `vapid t=${vapid.token}, k=${vapid.publicKey}` }
	}
	return {
		'content-encoding': 'aesgcm',
		encryption: `salt=${base64url.encode(encrypted.salt)}`,
		'crypto-key': `dh=${base64url.encode(encrypted.senderPublicKey)};p256ecdsa=${vapid.publicKey}`,
		authorization: `WebPush ${vapid.token}`,
	}
}

// RFC 8292 allows at most 24 hours.
export const VAPID_TOKEN_SECONDS = 12 * 60 * 60

// The VAPID JWT for one push service: aud its origin, sub the instance's https URL.
export async function vapidToken(jwk: JsonWebKey, audience: string, subject: string, now: number): Promise<string> {
	const key = await importJWK({ ...jwk, alg: 'ES256' }, 'ES256')
	return new SignJWT({ aud: audience, sub: subject })
		.setProtectedHeader({ typ: 'JWT', alg: 'ES256' })
		.setExpirationTime(Math.floor(now / 1000) + VAPID_TOKEN_SECONDS)
		.sign(key)
}

// The access token a subscription was made with, for the payload's access_token (Mastodon sends it so a client can
// fetch the notification). The Store keeps it only sealed (AUTH-7): AES-GCM under a key derived from VAPID_JWK's
// private scalar, which the Store never holds, bound to the token's digest so a sealed value moved to another row does
// not open.
async function tokenKey(jwk: JsonWebKey): Promise<CryptoKey> {
	const scalar = base64url.decode(jwk.d ?? '')
	const raw = await hkdf(new Uint8Array(0), scalar, text('Kopje Web Push token\0'), 16)
	return crypto.subtle.importKey('raw', concat(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function sealPushToken(jwk: JsonWebKey, tokenHash: string, token: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const sealed = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: text(tokenHash) },
		await tokenKey(jwk),
		text(token)
	)
	return base64url.encode(concat(iv, new Uint8Array(sealed)))
}

// The token, or null when the value does not open with this key and digest.
export async function openPushToken(jwk: JsonWebKey, tokenHash: string, sealed: string): Promise<string | null> {
	try {
		const bytes = base64url.decode(sealed)
		const opened = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: text(tokenHash) },
			await tokenKey(jwk),
			bytes.slice(12)
		)
		return new TextDecoder().decode(opened)
	} catch {
		return null
	}
}
