import { base64url } from 'jose'

import type { ClientKeys, PushEncoding } from '../src/security/web-push'

// Web Push fixtures: the instance's VAPID key, a subscribing client with its own keys, and the client's side of the
// decryption (what a browser or a push relay does), so tests read what was sent.

// A fixed P-256 key (the one test/instance.test.ts uses); only its public half appears in responses.
const jwk = {
	kty: 'EC',
	crv: 'P-256',
	x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
	y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
	d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
}

export const VAPID = {
	jwk,
	env: JSON.stringify(jwk),
	publicKey: 'BH_Nzidw9sRdQYPL7m_bS3tYBzM1e-nvE7rPbjx70VRFx_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
}

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const

export type Client = { keys: ClientKeys; privateKey: CryptoKey; p256dh: string; auth: string }

export async function newClient(): Promise<Client> {
	const pair = (await crypto.subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair
	const p256dh = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
	const auth = crypto.getRandomValues(new Uint8Array(16))
	return {
		keys: { p256dh, auth },
		privateKey: pair.privateKey,
		p256dh: base64url.encode(p256dh),
		auth: base64url.encode(auth),
	}
}

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
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'HKDF', hash: 'SHA-256', salt: concat(salt), info: concat(info) },
			key,
			length * 8
		)
	)
}

// The user agent's side: the plaintext of a push, given the sender's key and the salt (read from the body for
// aes128gcm, from the Crypto-Key and Encryption headers for aesgcm).
export async function decryptPush(
	client: Client,
	encoding: PushEncoding,
	push: { body: Uint8Array; salt?: Uint8Array; senderPublicKey?: Uint8Array }
): Promise<Uint8Array> {
	let { body, salt, senderPublicKey } = push
	if (encoding === 'aes128gcm') {
		const idLength = body[20] ?? 0
		salt = body.slice(0, 16)
		senderPublicKey = body.slice(21, 21 + idLength)
		body = body.slice(21 + idLength)
	}
	if (salt === undefined || senderPublicKey === undefined) {
		throw new Error('salt and sender key needed')
	}
	const sender = await crypto.subtle.importKey('raw', concat(senderPublicKey), P256, false, [])
	const ecdh = { name: 'ECDH', public: sender } as unknown as SubtleCryptoDeriveKeyAlgorithm
	const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, client.privateKey, 256))
	const { p256dh, auth } = client.keys
	let cek: Uint8Array
	let nonce: Uint8Array
	if (encoding === 'aes128gcm') {
		const ikm = await hkdf(auth, secret, concat(text('WebPush: info\0'), p256dh, senderPublicKey), 32)
		cek = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16)
		nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12)
	} else {
		const ikm = await hkdf(auth, secret, text('Content-Encoding: auth\0'), 32)
		const context = concat(text('P-256\0'), Uint8Array.of(0, 65), p256dh, Uint8Array.of(0, 65), senderPublicKey)
		cek = await hkdf(salt, ikm, concat(text('Content-Encoding: aesgcm\0'), context), 16)
		nonce = await hkdf(salt, ikm, concat(text('Content-Encoding: nonce\0'), context), 12)
	}
	const key = await crypto.subtle.importKey('raw', concat(cek), 'AES-GCM', false, ['decrypt'])
	const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: concat(nonce) }, key, concat(body)))
	if (encoding === 'aes128gcm') {
		// The last record ends with the 0x02 delimiter, then padding zeros.
		const end = padded.lastIndexOf(0x02)
		return padded.slice(0, end)
	}
	const padding = ((padded[0] ?? 0) << 8) | (padded[1] ?? 0)
	return padded.slice(2 + padding)
}

// A push as a push service receives it: the body decrypted with the encoding's headers.
export async function readPush(client: Client, request: Request): Promise<Record<string, unknown>> {
	const encoding = request.headers.get('content-encoding') as PushEncoding
	const body = new Uint8Array(await request.clone().arrayBuffer())
	const param = (header: string, name: string) => {
		const match = new RegExp(`(?:^|[;,\\s])${name}=([A-Za-z0-9_-]+)`).exec(request.headers.get(header) ?? '')
		return match?.[1] === undefined ? undefined : base64url.decode(match[1])
	}
	const plaintext = await decryptPush(client, encoding, {
		body,
		salt: param('encryption', 'salt'),
		senderPublicKey: param('crypto-key', 'dh'),
	})
	return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>
}
